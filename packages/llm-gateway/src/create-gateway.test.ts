import { describe, expect, test } from 'bun:test';

import { createGateway } from './create-gateway';
import type { AuthedPrincipal, GatewayHooks } from './domain';

const PRINCIPAL: AuthedPrincipal = {
  userId: '60000000-0000-4000-8000-000000000001',
  accountId: '10000000-0000-4000-a000-000000000001',
  projectId: '20000000-0000-4000-a000-000000000001',
  sessionId: 'module:30000000-0000-4000-a000-000000000001',
  keyId: 'module:60000000-0000-4000-8000-000000000001',
  freeModelsOnly: false,
};

describe('principal-aware gateway entry point', () => {
  test('runs a validated principal through the normal chat pipeline without token authentication', async () => {
    let authenticateCalls = 0;
    let billingCalls = 0;
    let budgetCalls = 0;
    const logs: unknown[] = [];
    const hooks: GatewayHooks = {
      async authenticate() {
        authenticateCalls += 1;
        return null;
      },
      async assertBillingActive(accountId) {
        expect(accountId).toBe(PRINCIPAL.accountId);
        billingCalls += 1;
      },
      async assertBudget(principal) {
        expect(principal).toEqual(PRINCIPAL);
        budgetCalls += 1;
      },
      async resolveUpstream(principal, model) {
        expect(principal).toEqual(PRINCIPAL);
        expect(model).toBe('allowlisted-model');
        return [
          {
            provider: 'new-api',
            kind: 'openai-compat',
            baseUrl: 'https://new-api.example.com/private-gateway/v1',
            apiKey: 'server-only-key',
            billingMode: 'credits',
            markup: 0,
            resolvedModel: 'vendor/model-v3',
          },
        ];
      },
      async recordUsage() {},
      async listModels() {
        return { 'allowlisted-model': { name: 'Allowlisted Model' } };
      },
    };
    const gateway = createGateway(
      hooks,
      {},
      {
        logger: {
          info: (...args) => logs.push(args),
          warn: (...args) => logs.push(args),
          error: (...args) => logs.push(args),
          debug: (...args) => logs.push(args),
        },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              id: 'completion-1',
              object: 'chat.completion',
              model: 'vendor/model-v3',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    );
    const internal = gateway as typeof gateway & {
      chatCompletionsForPrincipal?: (
        principal: AuthedPrincipal,
        request: { rawBody: string },
      ) => Promise<Response>;
    };

    expect(typeof internal.chatCompletionsForPrincipal).toBe('function');
    if (!internal.chatCompletionsForPrincipal) return;

    const response = await internal.chatCompletionsForPrincipal(PRINCIPAL, {
      rawBody: JSON.stringify({
        model: 'allowlisted-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'completion-1',
      model: 'vendor/model-v3',
    });
    expect(authenticateCalls).toBe(0);
    expect(billingCalls).toBe(1);
    expect(budgetCalls).toBe(1);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain('https://new-api.example.com');
    expect(serializedLogs).not.toContain('private-gateway');
    expect(serializedLogs).not.toContain('server-only-key');
  });

  test('lists models for the same validated principal without token authentication', async () => {
    let authenticateCalls = 0;
    const gateway = createGateway({
      async authenticate() {
        authenticateCalls += 1;
        return null;
      },
      async assertBillingActive() {},
      async resolveUpstream() {
        return [];
      },
      async recordUsage() {},
      async listModels(principal) {
        expect(principal).toEqual(PRINCIPAL);
        return { 'allowlisted-model': { name: 'Allowlisted Model' } };
      },
    });
    const internal = gateway as typeof gateway & {
      listModelsForPrincipal?: (principal: AuthedPrincipal) => Promise<Response>;
    };

    expect(typeof internal.listModelsForPrincipal).toBe('function');
    if (!internal.listModelsForPrincipal) return;

    const response = await internal.listModelsForPrincipal(PRINCIPAL);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: { 'allowlisted-model': { name: 'Allowlisted Model' } },
    });
    expect(authenticateCalls).toBe(0);
  });
});
