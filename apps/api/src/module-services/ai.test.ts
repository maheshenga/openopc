import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';
import type { AuthedPrincipal } from '@kortix/llm-gateway';

import { type ModuleAiDependencies, type ModuleAiGateway, createModuleAiRoutes } from './ai';
import { createModuleServicesApp } from './app';
import { ModuleServiceCapabilityError } from './capability-grants';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const AUTHORIZATION = 'Bearer v4.public.module-capability';

const PRINCIPAL: AuthedPrincipal = {
  userId: GRANT_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  sessionId: `module:${INSTALLATION_ID}`,
  keyId: `module:${GRANT_ID}`,
  tier: 'pro',
  freeModelsOnly: false,
};

const MANAGED_MODEL = {
  id: 'allowlisted-model',
  name: 'Allowlisted Model',
  upstreamModelId: 'vendor/model-v3',
  transport: 'new-api',
  pricingRef: 'vendor/model-v3',
  tier: 'balanced',
  vision: false,
  limit: { context: 128_000, output: 16_000 },
} as const;

type AiOperation = 'models.read' | 'text.generate' | 'text.stream';

function claims(operations: AiOperation[]): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '00000000-0000-4000-8000-000000000001',
    iat: '2026-08-01T00:00:00.000Z',
    exp: '2026-08-01T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.weather-station',
    moduleVersion: '1.2.3',
    consentId: CONSENT_ID,
    grantId: GRANT_ID,
    service: 'ai',
    operations,
  };
}

function fixture(input?: {
  operations?: AiOperation[];
  rejection?: ModuleServiceCapabilityError;
  newApiConfigured?: boolean;
  stream?: boolean;
}) {
  const operations = input?.operations ?? ['models.read', 'text.generate', 'text.stream'];
  const calls = {
    capabilityOperations: [] as AiOperation[],
    principals: [] as AuthedPrincipal[],
    chats: [] as Array<{ rawBody: string; traceparent?: string; tracestate?: string }>,
    listCount: 0,
  };
  const gateway: ModuleAiGateway = {
    async listModelsForPrincipal(principal) {
      calls.principals.push(principal);
      calls.listCount += 1;
      return new Response(
        JSON.stringify({
          models: {
            'allowlisted-model': {
              name: 'Allowlisted Model',
              reasoning: true,
              attachment: false,
              limit: { context: 128_000, output: 16_000 },
            },
            'anthropic/not-allowlisted': { name: 'Private BYOK Model' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    async chatCompletionsForPrincipal(principal, request) {
      calls.principals.push(principal);
      calls.chats.push(request);
      if (input?.stream) {
        return new Response(
          'data: {"id":"chunk-1","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'completion-1',
          object: 'chat.completion',
          model: 'vendor/model-v3',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  };
  const dependencies: ModuleAiDependencies = {
    async requireCapability(authorization, operation) {
      expect(authorization).toBe(AUTHORIZATION);
      calls.capabilityOperations.push(operation);
      if (input?.rejection) throw input.rejection;
      if (!operations.includes(operation)) {
        throw new ModuleServiceCapabilityError('MODULE_SERVICE_OPERATION_DENIED', 403);
      }
      return claims(operations);
    },
    async principalForClaims(received) {
      expect(received).toEqual(claims(operations));
      return PRINCIPAL;
    },
    gateway: () => gateway,
    managedModels: [MANAGED_MODEL],
    newApiConfigured: () => input?.newApiConfigured ?? true,
  } as ModuleAiDependencies;
  return { app: createModuleAiRoutes(dependencies), calls, dependencies };
}

function chatBody(stream?: boolean) {
  return JSON.stringify({
    model: 'allowlisted-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...(stream === undefined ? {} : { stream }),
  });
}

describe('module AI service facade', () => {
  test('mounts the AI facade under the module-services application', async () => {
    const { dependencies } = fixture({ operations: ['models.read'] });
    const app = createModuleServicesApp(dependencies);
    const response = await app.request('/ai/models', {
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ id: 'allowlisted-model' }],
    });
  });

  test('lists only the managed allowlist for a models.read capability', async () => {
    const { app, calls } = fixture({ operations: ['models.read'] });
    const response = await app.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          id: 'allowlisted-model',
          object: 'model',
          owned_by: 'openopc',
          name: 'Allowlisted Model',
          reasoning: true,
          attachment: false,
          limit: { context: 128_000, output: 16_000 },
        },
      ],
    });
    expect(calls.capabilityOperations).toEqual(['models.read']);
    expect(calls.principals).toEqual([PRINCIPAL]);
    expect(calls.listCount).toBe(1);
  });

  test('does not let a models.read-only capability generate text', async () => {
    const { app, calls } = fixture({ operations: ['models.read'] });
    const response = await app.request('/chat/completions', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
      body: chatBody(false),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_OPERATION_DENIED' });
    expect(calls.capabilityOperations).toEqual(['text.generate']);
    expect(calls.chats).toHaveLength(0);
  });

  test('rejects provider selection fields before capability or gateway work', async () => {
    const { app, calls } = fixture({ operations: ['text.generate'] });

    for (const providerField of [
      { provider: 'new-api' },
      { base_url: 'https://new-api.example.com/v1' },
      { api_key: 'developer-supplied-key' },
      { headers: { authorization: 'Bearer developer-supplied-key' } },
    ]) {
      const response = await app.request('/chat/completions', {
        method: 'POST',
        headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'allowlisted-model',
          messages: [{ role: 'user', content: 'hello' }],
          ...providerField,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_INPUT_INVALID' });
    }
    expect(calls.capabilityOperations).toHaveLength(0);
    expect(calls.principals).toHaveLength(0);
    expect(calls.chats).toHaveLength(0);
  });

  test('forwards a non-stream request through the principal-aware gateway', async () => {
    const { app, calls } = fixture({ operations: ['text.generate'] });
    const response = await app.request('/chat/completions', {
      method: 'POST',
      headers: {
        authorization: AUTHORIZATION,
        'content-type': 'application/json',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
      body: chatBody(false),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'completion-1' });
    expect(calls.capabilityOperations).toEqual(['text.generate']);
    expect(calls.principals).toEqual([PRINCIPAL]);
    expect(calls.chats).toEqual([
      {
        rawBody: chatBody(false),
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: undefined,
      },
    ]);
  });

  test('forwards streaming responses only for a text.stream capability', async () => {
    const { app, calls } = fixture({ operations: ['text.stream'], stream: true });
    const response = await app.request('/chat/completions', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
      body: chatBody(true),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('data: [DONE]');
    expect(calls.capabilityOperations).toEqual(['text.stream']);
    expect(calls.chats).toHaveLength(1);
  });

  test('rejects expired, cross-project, and revoked capabilities before gateway work', async () => {
    for (const [code, status] of [
      ['MODULE_SERVICE_CAPABILITY_EXPIRED', 401],
      ['MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH', 403],
      ['MODULE_SERVICE_CAPABILITY_REVOKED', 403],
    ] as const) {
      const { app, calls } = fixture({
        rejection: new ModuleServiceCapabilityError(code, status),
      });
      const response = await app.request('/chat/completions', {
        method: 'POST',
        headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
        body: chatBody(false),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
      expect(calls.principals).toHaveLength(0);
      expect(calls.chats).toHaveLength(0);
      expect(calls.listCount).toBe(0);
    }
  });

  test('returns a bounded provider error without gateway fallback when NewAPI is unconfigured', async () => {
    const { app, calls } = fixture({
      operations: ['text.generate'],
      newApiConfigured: false,
    });
    const response = await app.request('/chat/completions', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
      body: chatBody(false),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'MODULE_AI_PROVIDER_UNAVAILABLE' });
    expect(calls.capabilityOperations).toEqual(['text.generate']);
    expect(calls.principals).toHaveLength(0);
    expect(calls.chats).toHaveLength(0);
  });
});
