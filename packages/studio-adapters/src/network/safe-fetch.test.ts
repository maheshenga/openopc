import { afterEach, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { safeStudioFetch } from './safe-fetch';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  servers.push(server);
  return server;
}

function localUrl(server: ReturnType<typeof Bun.serve>, hostname: string, path = '/') {
  return new URL(`http://${hostname}:${server.port}${path}`);
}

const localResolve = async () => [{ address: '127.0.0.1', family: 4 as const }];

function requestInput(
  url: URL,
  overrides: Partial<Parameters<typeof safeStudioFetch>[0]> = {},
): Parameters<typeof safeStudioFetch>[0] {
  return {
    url,
    resolve: localResolve,
    allowPrivateOrigins: new Set(),
    allowInsecureLocalEndpoints: true,
    options: {
      redirectPolicy: 'error',
      maxRedirects: 0,
      connectTimeoutMs: 1_000,
      totalTimeoutMs: 2_000,
      maxResponseBytes: 1_024,
    },
    ...overrides,
  };
}

describe('safeStudioFetch', () => {
  test('uses DNS-pinned addresses and preserves a signed output query without logging it', async () => {
    let receivedUrl = '';
    const server = serve((request) => {
      receivedUrl = request.url;
      return new Response('image-bytes', { headers: { 'content-type': 'image/png' } });
    });
    const url = localUrl(server, 'output.test', '/asset.png?signature=must-stay-opaque');

    const response = await safeStudioFetch(
      requestInput(url, {
        options: {
          redirectPolicy: 'output-get',
          maxRedirects: 3,
          connectTimeoutMs: 1_000,
          totalTimeoutMs: 2_000,
          maxResponseBytes: 1_024,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('image-bytes');
    expect(new URL(receivedUrl).searchParams.get('signature')).toBe('must-stay-opaque');
  });

  test('revalidates every output redirect and strips all request headers at the next origin', async () => {
    let secondHeaders: Record<string, string> = {};
    let secondMethod = '';
    let secondBody = '';
    const second = serve(async (request) => {
      secondHeaders = Object.fromEntries(request.headers.entries());
      secondMethod = request.method;
      secondBody = await request.text();
      return new Response('redirected');
    });
    const secondUrl = localUrl(second, 'second.test', '/final');
    const first = serve(
      () => new Response(null, { status: 302, headers: { location: secondUrl.href } }),
    );

    const response = await safeStudioFetch(
      requestInput(localUrl(first, 'first.test', '/start'), {
        init: { method: 'GET', headers: { accept: 'image/png', 'x-prompt': 'never-forward' } },
        options: {
          redirectPolicy: 'output-get',
          maxRedirects: 3,
          connectTimeoutMs: 1_000,
          totalTimeoutMs: 2_000,
          maxResponseBytes: 1_024,
        },
      }),
    );

    expect(await response.text()).toBe('redirected');
    expect(secondMethod).toBe('GET');
    expect(secondBody).toBe('');
    expect(secondHeaders.authorization).toBeUndefined();
    expect(secondHeaders.cookie).toBeUndefined();
    expect(secondHeaders['x-prompt']).toBeUndefined();
  });

  test('returns a submit redirect without forwarding method, body, prompt, or credentials', async () => {
    let secondHits = 0;
    const second = serve(() => {
      secondHits += 1;
      return new Response('must-not-be-called');
    });
    const secondUrl = localUrl(second, 'submit-target.test', '/stolen');
    const first = serve(async (request) => {
      expect(request.method).toBe('POST');
      expect(await request.text()).toBe('private prompt');
      return new Response(null, { status: 307, headers: { location: secondUrl.href } });
    });
    const firstUrl = localUrl(first, 'provider.test', '/v1/images');

    const response = await safeStudioFetch(
      requestInput(firstUrl, {
        init: {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-only-secret',
            cookie: 'session=test-only',
            'content-type': 'text/plain',
            'x-prompt': 'private prompt',
          },
          body: 'private prompt',
        },
        options: {
          redirectPolicy: 'error',
          maxRedirects: 0,
          connectTimeoutMs: 1_000,
          totalTimeoutMs: 2_000,
          maxResponseBytes: 1_024,
          authorizationOrigin: firstUrl.origin,
        },
      }),
    );

    expect(response.status).toBe(307);
    expect(secondHits).toBe(0);
  });

  test('rejects output redirect mode for non-GET, body, authorization, or cookies', async () => {
    const server = serve(() => new Response('unused'));
    const url = localUrl(server, 'output.test');
    const invalidInits: Array<NonNullable<Parameters<typeof safeStudioFetch>[0]['init']>> = [
      { method: 'POST' },
      { method: 'GET', body: 'payload' },
      { method: 'GET', headers: { authorization: 'Bearer secret' } },
      { method: 'GET', headers: { cookie: 'session=secret' } },
    ];

    for (const init of invalidInits) {
      await expect(
        safeStudioFetch(
          requestInput(url, {
            init,
            options: {
              redirectPolicy: 'output-get',
              maxRedirects: 3,
              connectTimeoutMs: 1_000,
              totalTimeoutMs: 2_000,
              maxResponseBytes: 1_024,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
    }
  });

  test('rejects a redirect whose newly resolved address is blocked', async () => {
    let blockedHits = 0;
    const blocked = serve(() => {
      blockedHits += 1;
      return new Response('must-not-be-called');
    });
    const blockedUrl = localUrl(blocked, 'blocked.test', '/metadata');
    const first = serve(
      () => new Response(null, { status: 302, headers: { location: blockedUrl.href } }),
    );

    await expect(
      safeStudioFetch(
        requestInput(localUrl(first, 'first.test'), {
          resolve: async (hostname) =>
            hostname === 'blocked.test'
              ? [{ address: '169.254.169.254', family: 4 }]
              : [{ address: '127.0.0.1', family: 4 }],
          options: {
            redirectPolicy: 'output-get',
            maxRedirects: 3,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 2_000,
            maxResponseBytes: 1_024,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
    expect(blockedHits).toBe(0);
  });

  test('enforces redirect, decoded byte, and total timeout ceilings', async () => {
    const looping = serve(
      (request) => new Response(null, { status: 302, headers: { location: request.url } }),
    );
    await expect(
      safeStudioFetch(
        requestInput(localUrl(looping, 'loop.test'), {
          options: {
            redirectPolicy: 'output-get',
            maxRedirects: 1,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 2_000,
            maxResponseBytes: 1_024,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'STUDIO_REDIRECT_LIMIT',
      dispatchState: 'may-have-dispatched',
      responseStatus: 302,
    });

    const oversized = serve(() => new Response(new Uint8Array(32)));
    await expect(
      safeStudioFetch(
        requestInput(localUrl(oversized, 'large.test'), {
          options: {
            redirectPolicy: 'error',
            maxRedirects: 0,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 2_000,
            maxResponseBytes: 16,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'STUDIO_RESPONSE_TOO_LARGE',
      dispatchState: 'may-have-dispatched',
      responseStatus: 200,
    });

    const slow = serve(async () => {
      await Bun.sleep(100);
      return new Response('late');
    });
    await expect(
      safeStudioFetch(
        requestInput(localUrl(slow, 'slow.test'), {
          options: {
            redirectPolicy: 'error',
            maxRedirects: 0,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 20,
            maxResponseBytes: 1_024,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'STUDIO_NETWORK_TIMEOUT',
      dispatchState: 'may-have-dispatched',
      responseStatus: undefined,
    });
  });

  test('applies the total timeout while DNS resolution is still pending', async () => {
    const startedAt = performance.now();
    await expect(
      safeStudioFetch(
        requestInput(new URL('http://resolver.test:9000/output'), {
          resolve: async () => {
            await Bun.sleep(250);
            return [{ address: '127.0.0.1', family: 4 }];
          },
          options: {
            redirectPolicy: 'output-get',
            maxRedirects: 3,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 20,
            maxResponseBytes: 1_024,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'STUDIO_NETWORK_TIMEOUT',
      dispatchState: 'not-dispatched',
      responseStatus: undefined,
    });
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  test('counts decoded compressed and chunked response bytes while streaming', async () => {
    const compressed = serve(
      () =>
        new Response(gzipSync(Buffer.alloc(1_024, 65)), {
          headers: { 'content-encoding': 'gzip' },
        }),
    );
    await expect(
      safeStudioFetch(
        requestInput(localUrl(compressed, 'compressed.test'), {
          options: {
            redirectPolicy: 'error',
            maxRedirects: 0,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 2_000,
            maxResponseBytes: 64,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'STUDIO_RESPONSE_TOO_LARGE' });

    const chunked = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              controller.enqueue(new Uint8Array(10));
              controller.close();
            },
          }),
        ),
    );
    await expect(
      safeStudioFetch(
        requestInput(localUrl(chunked, 'chunked.test'), {
          options: {
            redirectPolicy: 'error',
            maxRedirects: 0,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 2_000,
            maxResponseBytes: 16,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'STUDIO_RESPONSE_TOO_LARGE' });
  });

  test('binds authorization to one exact origin', async () => {
    const server = serve(() => new Response('unused'));
    const url = localUrl(server, 'provider.test');
    await expect(
      safeStudioFetch(
        requestInput(url, {
          init: { headers: { authorization: 'Bearer secret' } },
          options: {
            redirectPolicy: 'error',
            maxRedirects: 0,
            connectTimeoutMs: 1_000,
            totalTimeoutMs: 2_000,
            maxResponseBytes: 1_024,
            authorizationOrigin: 'http://different.test',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
  });
});
