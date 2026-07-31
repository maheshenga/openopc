import { describe, expect, test } from 'bun:test';

import {
  type OpenOpcAiClient,
  type OpenOpcChatChunk,
  type OpenOpcChatCompletion,
  type OpenOpcChatCompletionRequest,
  type OpenOpcChatMessage,
  type OpenOpcModel,
  OpenOpcModuleProtocolError,
  OpenOpcModuleServiceError,
  createOpenOpcModuleClient,
} from './index';

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

  test('exposes provider-neutral AI model and non-stream chat methods', async () => {
    const capabilities: unknown[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const model = {
      id: 'allowlisted-model',
      object: 'model',
      owned_by: 'openopc',
    } satisfies OpenOpcModel;
    const completion = {
      id: 'completion-1',
      object: 'chat.completion',
      model: 'allowlisted-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
    } satisfies OpenOpcChatCompletion;
    const message = { role: 'user', content: 'hello' } satisfies OpenOpcChatMessage;
    const chatRequest = {
      model: 'allowlisted-model',
      messages: [message],
    } satisfies OpenOpcChatCompletionRequest & { stream?: false };
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken(input) {
        capabilities.push(input);
        return 'v4.public.module-token';
      },
      async fetch(input, init) {
        requests.push({ url: String(input), init });
        if (String(input).endsWith('/ai/models')) {
          return new Response(JSON.stringify({ data: [model] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(completion), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const ai: OpenOpcAiClient = client.ai;

    await expect(ai.models.list()).resolves.toEqual({
      data: [model],
    });
    const chatCompletion: OpenOpcChatCompletion = await ai.chat.create(chatRequest);
    expect(chatCompletion).toMatchObject({ id: 'completion-1' });

    expect(capabilities).toEqual([
      { service: 'ai', operation: 'models.read' },
      { service: 'ai', operation: 'text.generate' },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      'https://platform.example.com/v1/module-services/ai/models',
      'https://platform.example.com/v1/module-services/ai/chat/completions',
    ]);
    expect(requests[1]?.init?.body).toBe(
      JSON.stringify({
        model: 'allowlisted-model',
        messages: [message],
      }),
    );
  });

  test('returns text.stream as an AsyncIterable of parsed SSE chunks', async () => {
    const capabilities: unknown[] = [];
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken(input) {
        capabilities.push(input);
        return 'v4.public.module-token';
      },
      async fetch() {
        return new Response(
          'data: {"id":"chunk-1","choices":[{"delta":{"content":"hel"}}]}\n\n' +
            'data: {"id":"chunk-2","choices":[{"delta":{"content":"lo"}}]}\n\n' +
            'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const ai = client.ai;

    const stream = await ai.chat.create({
      model: 'allowlisted-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const chunks: OpenOpcChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual([
      { id: 'chunk-1', choices: [{ delta: { content: 'hel' } }] },
      { id: 'chunk-2', choices: [{ delta: { content: 'lo' } }] },
    ]);
    expect(capabilities).toEqual([{ service: 'ai', operation: 'text.stream' }]);
  });

  test('parses CRLF-framed SSE events split across response chunks', async () => {
    const encoder = new TextEncoder();
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        return 'v4.public.module-token';
      },
      async fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"id":"chunk-1","choices":[{"delta":{"content":"ok"}}]}\r\n'),
              );
              controller.enqueue(encoder.encode('\r\ndata: [DONE]\r\n\r\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    const stream = await client.ai.chat.create({
      model: 'allowlisted-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual([{ id: 'chunk-1', choices: [{ delta: { content: 'ok' } }] }]);
  });

  test('rejects provider-shaped SSE frames without reflecting their details', async () => {
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        return 'v4.public.module-token';
      },
      async fetch() {
        return new Response(
          'data: {"error":"provider failed","provider_url":"https://new-api.example.com","api_key":"secret-value"}\n\n' +
            'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const stream = await client.ai.chat.create({
      model: 'allowlisted-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });

    const consume = async () => {
      for await (const _chunk of stream) {
        // Consume the stream so validation happens inside the async iterator.
      }
    };
    await expect(consume()).rejects.toEqual(
      expect.objectContaining({
        name: 'OpenOpcModuleProtocolError',
        message: 'OpenOPC module service returned an invalid stream',
      }),
    );
  });

  test('rejects provider selection fields before minting an AI capability', async () => {
    let capabilityCalls = 0;
    let fetchCalls = 0;
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        capabilityCalls += 1;
        return 'v4.public.module-token';
      },
      async fetch() {
        fetchCalls += 1;
        return new Response('{}');
      },
    });
    const ai = client.ai;

    for (const providerField of [
      { provider: 'new-api' },
      { base_url: 'https://new-api.example.com/v1' },
      { api_key: 'developer-supplied-key' },
      { headers: { authorization: 'Bearer developer-supplied-key' } },
    ]) {
      await expect(
        ai.chat.create({
          model: 'allowlisted-model',
          messages: [{ role: 'user', content: 'hello' }],
          ...providerField,
        }),
      ).rejects.toBeInstanceOf(OpenOpcModuleProtocolError);
    }
    expect(capabilityCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
