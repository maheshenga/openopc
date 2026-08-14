import { describe, expect, test } from 'bun:test';

import {
  type CreateDeveloperPaymentOrderInput,
  type CreateDeveloperPaymentOrderResult,
  type CreateDeveloperPaymentRefundInput,
  type DeveloperPaymentOrderView,
  type DeveloperPaymentRefundView,
  type OpenOpcAiClient,
  type OpenOpcChatChunk,
  type OpenOpcChatCompletion,
  type OpenOpcChatCompletionRequest,
  type OpenOpcChatMessage,
  type OpenOpcModel,
  OpenOpcModuleProtocolError,
  OpenOpcModuleServiceError,
  type OpenOpcPaymentClient,
  createOpenOpcModuleClient,
} from './index';

describe('OpenOPC developer SDK transport', () => {
  test('exports payment input and output types from the public SDK entrypoint', () => {
    const orderInput: CreateDeveloperPaymentOrderInput = {
      amount_minor: 567,
      currency: 'CNY',
      product_name: 'OpenOPC module purchase',
    };
    const orderResult: CreateDeveloperPaymentOrderResult = {
      order_id: '90000000-0000-4000-8000-000000000001',
      status: 'checkout_issued',
      expires_at: '2026-08-01T00:15:00.000Z',
      checkout: {
        kind: 'redirect',
        url: 'https://payments.example.com/checkout/one',
        mobile_url: null,
      },
    };
    const order: DeveloperPaymentOrderView = {
      order_id: orderResult.order_id,
      ...orderInput,
      status: 'paid',
      expires_at: orderResult.expires_at,
      paid_at: '2026-08-01T00:02:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:02:00.000Z',
    };
    const refundInput: CreateDeveloperPaymentRefundInput = { amount_minor: 567 };
    const refund: DeveloperPaymentRefundView = {
      refund_id: 'a0000000-0000-4000-8000-000000000001',
      order_id: order.order_id,
      amount_minor: refundInput.amount_minor,
      status: 'refunded',
      requested_at: '2026-08-01T00:03:00.000Z',
      resolved_at: '2026-08-01T00:04:00.000Z',
    };

    expect(refund.status).toBe('refunded');
  });

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
    expect(() =>
      createOpenOpcModuleClient({
        baseUrl: 'https://platform.example.com',
        getCapabilityToken: async () => 'v4.public.module-token',
        context: {
          projectId: 'not-a-uuid',
          installationId: '30000000-0000-4000-8000-000000000003',
          releaseId: '40000000-0000-4000-8000-000000000004',
          installRevision: 1,
        },
      }),
    ).toThrow(OpenOpcModuleProtocolError);
  });

  test('normalizes a request timeout and aborts the platform fetch', async () => {
    let fetchSignal: AbortSignal | undefined;
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      timeoutMs: 5,
      getCapabilityToken: async () => 'v4.public.module-token',
      fetch: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response('{}', { status: 200 });
      },
    });

    await expect(
      client.request({
        service: 'ai',
        operation: 'models.read',
        method: 'GET',
        path: '/v1/module-services/ai/models',
      }),
    ).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_TIMEOUT',
    });
    expect(fetchSignal?.aborted).toBe(true);
  });

  test('propagates caller cancellation through capability acquisition', async () => {
    const controller = new AbortController();
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      timeoutMs: 100,
      getCapabilityToken: async (_input, { signal } = {}) => {
        await new Promise<never>((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('fallback')), 40);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
        return 'v4.public.module-token';
      },
      fetch: async () => new Response('{}'),
    });

    const pending = client.request({
      service: 'ai',
      operation: 'models.read',
      method: 'GET',
      path: '/v1/module-services/ai/models',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_ABORTED',
    });
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

  test('invalidates and retries exactly once after an unauthorized response', async () => {
    for (const status of [401, 403]) {
      const tokens = ['v4.public.stale-token', 'v4.public.fresh-token'];
      let tokenCalls = 0;
      const invalidations: unknown[] = [];
      const getCapabilityToken = Object.assign(
        async () => tokens[tokenCalls++] ?? 'v4.public.unexpected-token',
        {
          invalidate(input: unknown) {
            invalidations.push(input);
          },
        },
      );
      const requests: Array<{ authorization: string | null }> = [];
      let fetchCalls = 0;
      const client = createOpenOpcModuleClient({
        baseUrl: 'https://platform.example.com',
        getCapabilityToken,
        fetch: async (_input, init) => {
          requests.push({ authorization: new Headers(init?.headers).get('authorization') });
          fetchCalls += 1;
          return fetchCalls === 1
            ? new Response('{}', { status })
            : new Response('{}', { status: 200 });
        },
      });

      await expect(
        client.request({
          service: 'ai',
          operation: 'models.read',
          method: 'GET',
          path: '/v1/module-services/ai/models',
        }),
      ).resolves.toEqual({});
      expect(tokenCalls).toBe(2);
      expect(requests).toEqual([
        { authorization: 'Bearer v4.public.stale-token' },
        { authorization: 'Bearer v4.public.fresh-token' },
      ]);
      expect(invalidations).toEqual([{ service: 'ai', operation: 'models.read' }]);
    }
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
        name: 'OpenOpcModuleRequestError',
        code: 'OPENOPC_MODULE_REQUEST_FAILED',
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

  test('exposes provider-neutral payment create, read, and refund methods', async () => {
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
        if (String(input).endsWith('/orders') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              order_id: '90000000-0000-4000-8000-000000000001',
              status: 'checkout_issued',
              expires_at: '2026-08-01T00:15:00.000Z',
              checkout: {
                kind: 'redirect',
                url: 'https://payments.example.com/checkout/one',
                mobile_url: null,
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        if (String(input).endsWith('/refunds')) {
          return new Response(
            JSON.stringify({
              refund_id: 'a0000000-0000-4000-8000-000000000001',
              order_id: '90000000-0000-4000-8000-000000000001',
              amount_minor: 567,
              status: 'refunded',
              requested_at: '2026-08-01T00:03:00.000Z',
              resolved_at: '2026-08-01T00:04:00.000Z',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            order_id: '90000000-0000-4000-8000-000000000001',
            amount_minor: 567,
            currency: 'CNY',
            product_name: 'OpenOPC module purchase',
            status: 'paid',
            expires_at: '2026-08-01T00:15:00.000Z',
            paid_at: '2026-08-01T00:02:00.000Z',
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-01T00:02:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const payments: OpenOpcPaymentClient = client.payments;

    const created = await payments.orders.create(
      { amount_minor: 567, currency: 'CNY', product_name: 'OpenOPC module purchase' },
      'checkout-00000001',
    );
    await payments.orders.get(created.order_id);
    await payments.refunds.create(created.order_id, { amount_minor: 567 }, 'refund-000000001');

    expect(capabilities).toEqual([
      { service: 'payment', operation: 'orders.create' },
      { service: 'payment', operation: 'orders.read' },
      { service: 'payment', operation: 'refunds.create' },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      'https://platform.example.com/v1/module-services/payments/orders',
      'https://platform.example.com/v1/module-services/payments/orders/90000000-0000-4000-8000-000000000001',
      'https://platform.example.com/v1/module-services/payments/orders/90000000-0000-4000-8000-000000000001/refunds',
    ]);
    expect(new Headers(requests[0]?.init?.headers).get('idempotency-key')).toBe(
      'checkout-00000001',
    );
    expect(new Headers(requests[2]?.init?.headers).get('idempotency-key')).toBe('refund-000000001');
    expect(requests.every((request) => !String(request.init?.body).includes('merchant_key'))).toBe(
      true,
    );
    expect('close' in payments.orders).toBe(false);
  });

  test('rejects payment provider configuration before minting a capability', async () => {
    let capabilityCalls = 0;
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        capabilityCalls += 1;
        return 'v4.public.module-token';
      },
      async fetch() {
        return new Response('{}');
      },
    });

    await expect(
      client.payments.orders.create(
        {
          amount_minor: 1,
          currency: 'CNY',
          product_name: 'x',
          provider: 'zpay',
        } as never,
        'checkout-00000002',
      ),
    ).rejects.toBeInstanceOf(OpenOpcModuleProtocolError);
    expect(capabilityCalls).toBe(0);
  });
});
