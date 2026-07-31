import { describe, expect, test } from 'bun:test';

import {
  OpenOpcModuleProtocolError,
  OpenOpcModuleServiceError,
  createOpenOpcModuleClient,
} from './client';

describe('OpenOPC developer SDK transport', () => {
  test('rejects malformed JavaScript options with a stable protocol error', () => {
    expect(() => createOpenOpcModuleClient(undefined as never)).toThrow(OpenOpcModuleProtocolError);
    expect(() =>
      createOpenOpcModuleClient({
        baseUrl: 'https://platform.example.com',
        getCapabilityToken: null as never,
      }),
    ).toThrow(OpenOpcModuleProtocolError);
    expect(() =>
      createOpenOpcModuleClient({
        baseUrl: 'https://platform.example.com',
        getCapabilityToken: async () => 'v4.public.module-token',
        fetch: null as never,
      }),
    ).toThrow(OpenOpcModuleProtocolError);
  });

  test('requests a capability for the exact operation and sends only platform-owned headers', async () => {
    const capabilities: unknown[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken(input) {
        capabilities.push(input);
        return 'v4.public.module-token';
      },
      async fetch(input, init) {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(
      client.request<{ data: Array<{ id: string }> }>({
        service: 'ai',
        operation: 'models.read',
        method: 'GET',
        path: '/v1/module-services/ai/models',
      }),
    ).resolves.toEqual({ data: [{ id: 'model-1' }] });

    expect(capabilities).toEqual([{ service: 'ai', operation: 'models.read' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://platform.example.com/v1/module-services/ai/models');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer v4.public.module-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('x-api-key')).toBe(false);
    expect(requests[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  test('serializes JSON bodies without accepting arbitrary headers', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let tokenCalls = 0;
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        tokenCalls += 1;
        return 'v4.public.module-token';
      },
      async fetch(input, init) {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: 'result-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.request({
      service: 'ai',
      operation: 'text.generate',
      method: 'POST',
      path: '/v1/module-services/ai/chat/completions',
      body: { model: 'model-1', messages: [{ role: 'user', content: 'hello' }] },
    });
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(requests[0]?.init?.body).toBe(
      JSON.stringify({ model: 'model-1', messages: [{ role: 'user', content: 'hello' }] }),
    );

    await expect(
      client.request({
        service: 'ai',
        operation: 'models.read',
        method: 'GET',
        path: '/v1/module-services/ai/models',
        headers: { authorization: 'Bearer attacker-controlled' },
      } as never),
    ).rejects.toBeInstanceOf(OpenOpcModuleProtocolError);
    expect(tokenCalls).toBe(1);
  });

  test('rejects absolute, cross-service, traversal, and query-bearing paths before minting a token', async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        tokenCalls += 1;
        return 'v4.public.module-token';
      },
      async fetch() {
        fetchCalls += 1;
        return new Response('{}');
      },
    });
    const badPaths = [
      'https://new-api.example.com/v1/chat/completions',
      '/v1/module-services/payments/orders',
      '/v1/module-services/ai/../payments/orders',
      '/v1/module-services/ai/models?api_key=secret',
    ];

    for (const path of badPaths) {
      await expect(
        client.request({ service: 'ai', operation: 'models.read', method: 'GET', path }),
      ).rejects.toBeInstanceOf(OpenOpcModuleProtocolError);
    }
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('maps stable service errors without exposing provider configuration', async () => {
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      getCapabilityToken: async () => 'v4.public.module-token',
      fetch: async () =>
        new Response(JSON.stringify({ error: 'MODULE_SERVICE_CAPABILITY_EXPIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });

    try {
      await client.request({
        service: 'ai',
        operation: 'models.read',
        method: 'GET',
        path: '/v1/module-services/ai/models',
      });
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenOpcModuleServiceError);
      expect(error).toMatchObject({ code: 'MODULE_SERVICE_CAPABILITY_EXPIRED', status: 401 });
    }
  });

  test('redacts unknown error bodies instead of reflecting provider payloads', async () => {
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      getCapabilityToken: async () => 'v4.public.module-token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: 'provider_error',
            provider_url: 'https://new-api.example.com',
            api_key: 'secret-value',
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      client.request({
        service: 'ai',
        operation: 'models.read',
        method: 'GET',
        path: '/v1/module-services/ai/models',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'OpenOpcModuleProtocolError',
        message: 'OpenOPC module service returned an invalid error response',
      }),
    );
  });

  test('redacts response stream failures instead of exposing transport details', async () => {
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      getCapabilityToken: async () => 'v4.public.module-token',
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new Error('provider_url=https://new-api.example.com api_key=secret-value'),
              );
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    });

    await expect(
      client.request({
        service: 'ai',
        operation: 'models.read',
        method: 'GET',
        path: '/v1/module-services/ai/models',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'OpenOpcModuleProtocolError',
        message: 'OpenOPC module service response failed',
      }),
    );
  });
});
