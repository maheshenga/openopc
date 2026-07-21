import { describe, expect, test } from 'bun:test';

import type { GatewayRequestContext } from '@kortix/llm-gateway';
import { ApiUnavailableError, type FetchLike, createApiClient } from './api-client';

const principal = { userId: 'u1', accountId: 'a1' };

function client(fetchImpl: FetchLike) {
  return createApiClient({ baseUrl: 'https://api.test', token: 'secret', fetchImpl });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient', () => {
  test('authenticate returns the principal', async () => {
    const result = await client(async () => jsonResponse({ principal })).authenticate('tok');
    expect(result).toEqual(principal);
  });

  test('authenticate returns null for an invalid token', async () => {
    const result = await client(async () => jsonResponse({ principal: null })).authenticate('tok');
    expect(result).toBeNull();
  });

  test('sends the internal bearer token', async () => {
    let seenAuth: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenAuth = (init.headers as Record<string, string>).authorization;
      return jsonResponse({ principal });
    };
    await client(fetchImpl).authenticate('tok');
    expect(seenAuth).toBe('Bearer secret');
  });

  test('forwards W3C trace headers only to the internal API request', async () => {
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
    const tracestate = 'vendor=value';
    let seenHeaders: Record<string, string> = {};
    const c = client(async (_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse({ ok: true, principal });
    });
    const context: GatewayRequestContext = {
      requestId: 'req_1',
      traceparent,
      tracestate,
    };

    await c.authorize('tok', context);

    expect(seenHeaders.traceparent).toBe(traceparent);
    expect(seenHeaders.tracestate).toBe(tracestate);
    expect(seenHeaders['x-request-id']).toBe('req_1');
  });

  test('drops manually constructed unsafe internal context headers', async () => {
    let seenHeaders: Record<string, string> = {};
    const c = client(async (_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse({ ok: true, principal });
    });

    await c.authorize('tok', {
      requestId: 'req_1\r\nx-private: secret',
      traceparent: 'private trace value',
      tracestate: 'vendor=value\r\nx-private: secret',
    });

    expect(seenHeaders.traceparent).toBeUndefined();
    expect(seenHeaders.tracestate).toBeUndefined();
    expect(seenHeaders['x-request-id']).toBeUndefined();
  });

  test('resolveUpstream returns candidates', async () => {
    const candidates = [{ provider: 'openrouter' }, { provider: 'anthropic' }];
    const result = await client(async () => jsonResponse({ candidates })).resolveUpstream(
      principal,
      'm',
    );
    expect(result).toHaveLength(2);
  });

  test('resolveRoute obtains the model plan from the API control plane', async () => {
    let seenPath = '';
    let seenBody: Record<string, unknown> = {};
    const c = client(async (url, init) => {
      seenPath = new URL(url).pathname;
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        route: {
          policyId: 'platform-default',
          primaryModel: 'codex/gpt-5.6-sol',
          fallbackModels: ['glm-5.2'],
          fallbackOn: 'any-error',
        },
      });
    });

    const requires = {
      imageInput: false,
      streaming: true,
      functionTools: true,
      reasoning: false,
      stateContinuation: false,
      background: false,
    };
    const route = await c.resolveRoute(principal, { requestedModel: 'auto', requires });

    expect(seenPath).toBe('/internal/gateway/resolve-route');
    expect(seenBody).toEqual({
      principal,
      input: { requestedModel: 'auto', requires },
    });
    expect(route).toMatchObject({
      policyId: 'platform-default',
      primaryModel: 'codex/gpt-5.6-sol',
      fallbackModels: ['glm-5.2'],
    });
  });

  test('assertBillingActive throws when inactive', async () => {
    const c = client(async () => jsonResponse({ active: false, message: 'no subscription' }));
    await expect(c.assertBillingActive('a1')).rejects.toThrow('no subscription');
  });

  test('assertBillingActive resolves when active', async () => {
    const c = client(async () => jsonResponse({ active: true }));
    await expect(c.assertBillingActive('a1')).resolves.toBeUndefined();
  });

  test('retries a 503 then succeeds', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return calls < 2 ? jsonResponse({}, 503) : jsonResponse({ principal });
    });
    expect(await c.authenticate('tok')).toEqual(principal);
    expect(calls).toBe(2);
  });

  test('throws ApiUnavailableError after exhausting retries', async () => {
    const c = client(async () => jsonResponse({}, 500));
    await expect(c.authenticate('tok')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  test('authorize returns the combined gate result (ok)', async () => {
    let seenPath: string | undefined;
    const c = client(async (url) => {
      seenPath = new URL(url).pathname;
      return jsonResponse({ ok: true, principal });
    });
    const result = await c.authorize('tok');
    expect(seenPath).toBe('/internal/gateway/authorize');
    expect(result).toEqual({ ok: true, principal });
  });

  test('authorize surfaces a typed denial', async () => {
    const c = client(async () =>
      jsonResponse({ ok: false, status: 402, errorCode: 'budget_exceeded', message: 'exhausted' }),
    );
    const result = await c.authorize('tok');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(402);
      expect(result.errorCode).toBe('budget_exceeded');
    }
  });
});
