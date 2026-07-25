import { describe, expect, test } from 'bun:test';

describe('developer trust readiness client', () => {
  test('fails closed without contacting the worker when trust infrastructure is disabled', async () => {
    const module = await import('./trust-readiness').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    let calls = 0;
    const readiness = module.createDeveloperTrustReadinessClient({
      enabled: false,
      url: 'http://developer-trust-worker:8080/readyz',
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ enabled: true, ready: true }));
      },
    });

    await expect(readiness.isReady()).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  test('accepts only an explicit enabled and ready response from the internal worker', async () => {
    const module = await import('./trust-readiness').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const readiness = module.createDeveloperTrustReadinessClient({
      enabled: true,
      url: 'http://developer-trust-worker:8080/readyz',
      fetcher: async (url, init) => {
        calls.push({ url: String(url), redirect: init?.redirect });
        return new Response(JSON.stringify({ enabled: true, ready: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(readiness.isReady()).resolves.toBe(true);
    expect(calls).toEqual([
      { url: 'http://developer-trust-worker:8080/readyz', redirect: 'error' },
    ]);
  });

  test('rejects malformed, non-ready, failed, and credential-bearing readiness targets', async () => {
    const module = await import('./trust-readiness').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    const cases = [
      {
        url: 'http://developer-trust-worker:8080/readyz',
        response: new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      },
      {
        url: 'http://developer-trust-worker:8080/readyz',
        response: new Response(JSON.stringify({ enabled: true, ready: false }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      },
      {
        url: 'http://user:secret@developer-trust-worker:8080/readyz',
        response: new Response(JSON.stringify({ enabled: true, ready: true })),
      },
    ];

    for (const entry of cases) {
      const readiness = module.createDeveloperTrustReadinessClient({
        enabled: true,
        url: entry.url,
        fetcher: async () => entry.response.clone(),
      });
      await expect(readiness.isReady()).resolves.toBe(false);
    }
  });
});
