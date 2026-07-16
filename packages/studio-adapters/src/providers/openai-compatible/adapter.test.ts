import { afterEach, describe, expect, test } from 'bun:test';
import { type Server, createServer } from 'node:net';
import type { StudioJobInput } from '@kortix/api-contract';
import type { StudioResolvedCredential } from '@kortix/studio-runtime';
import { Headers } from 'undici/index.js';
import type { SafeStudioFetchInput } from '../../network/safe-fetch';
import { safeStudioFetch } from '../../network/safe-fetch';
import { createOpenAiCompatibleImageAdapter } from './adapter';
import type { OpenAiCompatibleModelConfig } from './config';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const rawServers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const server of rawServers.splice(0)) {
    server.close();
    server.unref();
  }
});

const model: OpenAiCompatibleModelConfig = {
  model: 'image-model-v1',
  pricing_catalog_id: 'pricing-image-v1',
  dialect_profile_id: 'openai-images-v1-generic',
  supports_reference_images: false,
  allowed_advanced_fields: ['style'],
  size_map: {
    '1:1': '1024x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
  },
};
const credential: StudioResolvedCredential = {
  source: 'secret',
  value: 'test-only-provider-key',
  version_token: 'credential-version-1',
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function input(overrides: Partial<StudioJobInput['image']> = {}): StudioJobInput {
  return {
    capability: 'image.generate',
    image: {
      prompt: 'A precision studio photograph',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
      ...overrides,
    },
  };
}

function context() {
  return { correlationId: 'correlation-1', submissionKey: 'submission-1' };
}

function localPolicyFetch(
  optionOverrides: Partial<SafeStudioFetchInput['options']> = {},
): typeof safeStudioFetch {
  return (request) =>
    safeStudioFetch({
      ...request,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      allowInsecureLocalEndpoints: true,
      options: { ...request.options, ...optionOverrides },
    });
}

async function interruptedHttpServer(status: number): Promise<number> {
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.write(
        `HTTP/1.1 ${status} Interrupted\r\nContent-Type: text/plain\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx`,
        () => socket.destroy(),
      );
    });
  });
  rawServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected raw HTTP server address');
  return address.port;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe('OpenAI-compatible image adapter', () => {
  test('snapshots model configuration when the invocation adapter is created', async () => {
    const mutableModel = structuredClone(model) as OpenAiCompatibleModelConfig;
    let requestBody: Record<string, unknown> = {};
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model: mutableModel,
      credential,
      fetch: async (request) => {
        requestBody = JSON.parse(String(request.init?.body));
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    (mutableModel as { model: string }).model = 'mutated-after-factory';
    mutableModel.size_map['1:1'] = '9999x9999';

    await adapter.submit(context(), input());

    expect(requestBody.model).toBe('image-model-v1');
    expect(requestBody.size).toBe('1024x1024');
  });

  test('submits the contract-normalized prompt instead of the caller object', async () => {
    let requestBody: Record<string, unknown> = {};
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async (request) => {
        requestBody = JSON.parse(String(request.init?.body));
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await adapter.submit(context(), input({ prompt: '  A normalized prompt  ' }));

    expect(requestBody.prompt).toBe('A normalized prompt');
  });

  test('submits once with bounded safe-fetch policy and returns a synchronous completed result', async () => {
    const calls: SafeStudioFetchInput[] = [];
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async (request) => {
        calls.push(request);
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const submission = await adapter.submit(context(), input());

    expect(submission.kind).toBe('completed');
    if (submission.kind !== 'completed') throw new Error('expected completed submission');
    expect(submission.provider).toBe('openai-compatible');
    expect(submission.submission_key).toBe('submission-1');
    expect(submission.result.assets).toHaveLength(1);
    const asset = submission.result.assets[0];
    if (!asset) throw new Error('expected image asset');
    expect(await readAll(await asset.openBody())).toEqual(png);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: new URL('https://provider.example.test/v1/images/generations'),
      options: {
        redirectPolicy: 'error',
        maxRedirects: 0,
        connectTimeoutMs: 10_000,
        totalTimeoutMs: 120_000,
        maxResponseBytes: 128 * 1024 * 1024,
        authorizationOrigin: 'https://provider.example.test',
      },
      allowInsecureLocalEndpoints: false,
    });
    expect(calls[0]?.allowPrivateOrigins.size).toBe(0);
    expect(adapter).not.toHaveProperty('reconcile');
  });

  test('fetches signed URL outputs without forwarding provider headers and refetches on openBody', async () => {
    const calls: SafeStudioFetchInput[] = [];
    const expires = Math.floor(Date.now() / 1_000) + 60;
    const signedUrl = `https://assets.example.test/output.png?expires=${expires}&signature=opaque`;
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async (request) => {
        calls.push(request);
        if (request.url.origin === 'https://provider.example.test') {
          return new Response(JSON.stringify({ data: [{ url: signedUrl }] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(png.slice(), { headers: { 'content-type': 'image/png' } });
      },
    });

    const submission = await adapter.submit(context(), input());
    if (submission.kind !== 'completed') throw new Error('expected completed submission');
    expect(calls).toHaveLength(2);
    const asset = submission.result.assets[0];
    if (!asset) throw new Error('expected image asset');
    await readAll(await asset.openBody());
    expect(calls).toHaveLength(3);
    for (const outputCall of calls.slice(1)) {
      const headers = new Headers(outputCall?.init?.headers);
      expect(outputCall?.options).toMatchObject({
        redirectPolicy: 'output-get',
        maxRedirects: 3,
        maxResponseBytes: 32 * 1024 * 1024,
      });
      expect(outputCall?.init?.method).toBe('GET');
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('x-submission-key')).toBe(false);
    }
    expect(JSON.stringify(submission)).not.toContain('signature=opaque');
    expect(JSON.stringify(submission)).not.toContain(credential.value);
  });

  test.each([400, 401, 403])('classifies an explicit %d rejection as terminal', async (status) => {
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async () =>
        new Response(`credential=${credential.value}&url=https://secret.example/query`, { status }),
    });

    let error: unknown;
    try {
      await adapter.submit(context(), input());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      classification: 'terminal',
      message: 'STUDIO_PROVIDER_REJECTED',
    });
    expect(String(error)).not.toContain(credential.value);
    expect(String(error)).not.toContain('secret.example');
  });

  test.each([
    [403, 'terminal', 'STUDIO_PROVIDER_REJECTED'],
    [200, 'terminal', 'STUDIO_ASSET_TOO_LARGE'],
    [503, 'unknown_outcome', 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN'],
  ] as const)(
    'preserves status %d when safe transport rejects an oversized response',
    async (status, classification, message) => {
      let hits = 0;
      const provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => {
          hits += 1;
          return new Response(new Uint8Array(32), { status });
        },
      });
      servers.push(provider);
      const adapter = createOpenAiCompatibleImageAdapter({
        baseUrl: new URL(`http://provider.test:${provider.port}/v1`),
        model,
        credential,
        fetch: localPolicyFetch({ maxResponseBytes: 16 }),
      });

      await expect(adapter.submit(context(), input())).rejects.toMatchObject({
        classification,
        message,
      });
      expect(hits).toBe(1);
    },
  );

  test('uses an observed 403 even when its response body is interrupted', async () => {
    const port = await interruptedHttpServer(403);
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL(`http://provider.test:${port}/v1`),
      model,
      credential,
      fetch: localPolicyFetch({ totalTimeoutMs: 500 }),
    });

    await expect(adapter.submit(context(), input())).rejects.toMatchObject({
      classification: 'terminal',
      message: 'STUDIO_PROVIDER_REJECTED',
    });
  });

  test('distinguishes a DNS timeout before dispatch from a timeout after dispatch', async () => {
    const beforeDispatch = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('http://provider.test:9000/v1'),
      model,
      credential,
      fetch: (request) =>
        safeStudioFetch({
          ...request,
          resolve: async () => {
            await Bun.sleep(100);
            return [{ address: '127.0.0.1', family: 4 }];
          },
          allowInsecureLocalEndpoints: true,
          options: { ...request.options, totalTimeoutMs: 20 },
        }),
    });
    await expect(beforeDispatch.submit(context(), input())).rejects.toMatchObject({
      classification: 'retryable',
      message: 'STUDIO_PROVIDER_UNAVAILABLE',
    });

    let hits = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        hits += 1;
        await Bun.sleep(100);
        return new Response('late');
      },
    });
    servers.push(provider);
    const afterDispatch = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL(`http://provider.test:${provider.port}/v1`),
      model,
      credential,
      fetch: localPolicyFetch({ totalTimeoutMs: 20 }),
    });
    await expect(afterDispatch.submit(context(), input())).rejects.toMatchObject({
      classification: 'unknown_outcome',
      message: 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
    });
    expect(hits).toBe(1);
  });

  test.each([301, 302, 303, 307, 308, 408, 409, 425, 429, 500, 503])(
    'classifies submit status %d as unknown without a replay',
    async (status) => {
      let calls = 0;
      const adapter = createOpenAiCompatibleImageAdapter({
        baseUrl: new URL('https://provider.example.test/v1'),
        model,
        credential,
        fetch: async () => {
          calls += 1;
          return new Response('private upstream body', { status });
        },
      });

      await expect(adapter.submit(context(), input())).rejects.toMatchObject({
        classification: 'unknown_outcome',
        message: 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
      });
      expect(calls).toBe(1);
    },
  );

  test('maps a safe-fetch timeout after invocation to a redacted unknown outcome', async () => {
    const privateUrl = 'https://provider.example.test/v1?signed=must-not-leak';
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async () => {
        throw new Error(`${privateUrl} Authorization=Bearer ${credential.value}`);
      },
    });

    let error: unknown;
    try {
      await adapter.submit(context(), input());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      classification: 'unknown_outcome',
      message: 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
    });
    expect(String(error)).not.toContain(credential.value);
    expect(String(error)).not.toContain('signed=must-not-leak');
  });

  test('rejects invalid input before provider I/O', async () => {
    let calls = 0;
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async () => {
        calls += 1;
        return new Response('unused');
      },
    });

    await expect(
      adapter.submit(context(), input({ advanced: { unknown: 'private-value' } })),
    ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_VALIDATION_ERROR' });
    expect(calls).toBe(0);
  });

  test('does not follow a submit redirect or disclose the prompt to its target', async () => {
    let targetHits = 0;
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        targetHits += 1;
        return new Response('must-not-run');
      },
    });
    servers.push(target);
    const targetUrl = `http://target.test:${target.port}/stolen`;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(null, { status: 307, headers: { location: targetUrl } }),
    });
    servers.push(provider);
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL(`http://provider.test:${provider.port}/v1`),
      model,
      credential,
      fetch: (request) =>
        safeStudioFetch({
          ...request,
          resolve: async () => [{ address: '127.0.0.1', family: 4 }],
          allowInsecureLocalEndpoints: true,
        }),
    });

    await expect(adapter.submit(context(), input())).rejects.toMatchObject({
      classification: 'unknown_outcome',
    });
    expect(targetHits).toBe(0);
  });

  test('cancel is a network-free no-op and async-only methods fail without I/O', async () => {
    let calls = 0;
    const adapter = createOpenAiCompatibleImageAdapter({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      fetch: async () => {
        calls += 1;
        return new Response('unused');
      },
    });
    const handle = {
      provider: 'openai-compatible',
      id: 'not-used',
      submission_key: 'submission-1',
    };

    await expect(adapter.cancel(context(), handle)).resolves.toBeUndefined();
    await expect(adapter.poll(context(), handle)).rejects.toMatchObject({
      classification: 'terminal',
    });
    await expect(adapter.fetchResult(context(), handle)).rejects.toMatchObject({
      classification: 'terminal',
    });
    expect(calls).toBe(0);
  });
});
