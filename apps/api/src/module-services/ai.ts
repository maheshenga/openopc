import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';
import type { AuthedPrincipal } from '@kortix/llm-gateway';

import { createModuleServiceGatewayPrincipal } from '../llm-gateway/hooks';
import { type ManagedModel, RUNTIME_MANAGED_MODELS } from '../llm-gateway/models/managed-models';
import { newApiConnectorConfigured } from '../llm-gateway/new-api-connector';
import { getInProcessLlmGateway } from '../llm-gateway/wire';
import { makeOpenApiApp } from '../openapi';
import {
  ReleaseProfileUnavailableError,
  type RuntimeReleaseProfile,
  assertRuntimeCapability,
  loadRuntimeReleaseProfile,
} from '../release-profile/runtime';
import type { AppEnv } from '../types';
import { ModuleServiceCapabilityError } from './capability-grants';
import { requireModuleServiceOperation } from './service-auth';

type ModuleAiOperation = 'models.read' | 'text.generate' | 'text.stream';
const PROVIDER_SELECTION_KEYS = new Set([
  'provider',
  'baseUrl',
  'base_url',
  'apiKey',
  'api_key',
  'headers',
]);

export interface ModuleAiGateway {
  chatCompletionsForPrincipal(
    principal: AuthedPrincipal,
    request: {
      rawBody: string;
      traceparent?: string;
      tracestate?: string;
    },
  ): Promise<Response>;
  listModelsForPrincipal(principal: AuthedPrincipal): Promise<Response>;
}

export interface ModuleAiDependencies {
  runtime: RuntimeReleaseProfile;
  requireCapability(
    authorization: string | undefined,
    operation: ModuleAiOperation,
  ): Promise<ModuleServiceCapabilityClaimsV1>;
  principalForClaims(claims: ModuleServiceCapabilityClaimsV1): Promise<AuthedPrincipal>;
  gateway(): ModuleAiGateway | null;
  managedModels: readonly ManagedModel[];
  newApiConfigured(): boolean;
}

export interface ExecuteModuleServiceAiRequestInput {
  authorization: string | undefined;
  kind: 'models' | 'chat';
  rawBody?: string;
  traceparent?: string;
  tracestate?: string;
}

export function createRuntimeModuleAiDependencies(): ModuleAiDependencies {
  return {
    runtime: loadRuntimeReleaseProfile(),
    requireCapability: (authorization, operation) =>
      requireModuleServiceOperation(authorization, { service: 'ai', operation }),
    principalForClaims: createModuleServiceGatewayPrincipal,
    gateway: getInProcessLlmGateway,
    managedModels: RUNTIME_MANAGED_MODELS,
    newApiConfigured: newApiConnectorConfigured,
  };
}

export async function executeModuleServiceAiRequest(
  input: ExecuteModuleServiceAiRequestInput,
  dependencies: ModuleAiDependencies,
): Promise<Response> {
  try {
    assertRuntimeCapability('module.ai.gateway', dependencies.runtime);
    if (input.kind === 'models') {
      const claims = await dependencies.requireCapability(input.authorization, 'models.read');
      const gateway = dependencies.gateway();
      if (!gateway) return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
      const principal = await dependencies.principalForClaims(claims);
      const response = await gateway.listModelsForPrincipal(principal);
      if (!response.ok) return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
      }
      const models = modelCatalog(payload);
      if (!models) return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
      const data = dependencies.managedModels.flatMap((managed) => {
        const model = publicModel(managed.id, models[managed.id]);
        return model ? [model] : [];
      });
      return jsonResponse({ data });
    }

    const parsed = parseChatRequest(input.rawBody);
    if (!parsed) return moduleAiError('MODULE_SERVICE_INPUT_INVALID', 400);
    const operation: ModuleAiOperation = parsed.stream ? 'text.stream' : 'text.generate';
    const claims = await dependencies.requireCapability(input.authorization, operation);
    const managed = dependencies.managedModels.find((candidate) => candidate.id === parsed.model);
    if (!managed) return moduleAiError('MODULE_SERVICE_INPUT_INVALID', 400);
    if (managed.transport === 'new-api' && !dependencies.newApiConfigured()) {
      return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
    }
    const gateway = dependencies.gateway();
    if (!gateway) return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
    const principal = await dependencies.principalForClaims(claims);
    const response = await gateway.chatCompletionsForPrincipal(principal, {
      rawBody: input.rawBody ?? '',
      traceparent: input.traceparent,
      tracestate: input.tracestate,
    });
    if (response.ok) return response;
    return response.status >= 400 && response.status < 500
      ? moduleAiError('MODULE_SERVICE_INPUT_INVALID', 400)
      : moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
  } catch (error) {
    if (error instanceof ReleaseProfileUnavailableError) {
      return jsonResponse({ code: error.code, capability: error.capability }, error.status);
    }
    if (error instanceof ModuleServiceCapabilityError) {
      return moduleAiError(error.code, error.status);
    }
    return moduleAiError('MODULE_AI_PROVIDER_UNAVAILABLE', 503);
  }
}

export function createModuleAiRoutes(dependencies: ModuleAiDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  app.get('/models', (context) =>
    executeModuleServiceAiRequest(
      {
        authorization: context.req.header('authorization'),
        kind: 'models',
        traceparent: context.req.header('traceparent'),
        tracestate: context.req.header('tracestate'),
      },
      dependencies,
    ),
  );
  app.post('/chat/completions', async (context) =>
    executeModuleServiceAiRequest(
      {
        authorization: context.req.header('authorization'),
        kind: 'chat',
        rawBody: await context.req.text(),
        traceparent: context.req.header('traceparent'),
        tracestate: context.req.header('tracestate'),
      },
      dependencies,
    ),
  );
  return app;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function moduleAiError(
  code: ModuleServiceCapabilityError['code'],
  status: ModuleServiceCapabilityError['status'],
): Response {
  return jsonResponse({ error: code }, status);
}

function parseChatRequest(rawBody: string | undefined): { model: string; stream: boolean } | null {
  if (!rawBody) return null;
  try {
    const value = JSON.parse(rawBody) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    if (
      Object.keys(body).some((key) => PROVIDER_SELECTION_KEYS.has(key)) ||
      typeof body.model !== 'string' ||
      body.model.length === 0 ||
      !Array.isArray(body.messages) ||
      (body.stream !== undefined && typeof body.stream !== 'boolean')
    ) {
      return null;
    }
    return { model: body.model, stream: body.stream === true };
  } catch {
    return null;
  }
}

function modelCatalog(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const models = (value as Record<string, unknown>).models;
  return models && typeof models === 'object' && !Array.isArray(models)
    ? (models as Record<string, unknown>)
    : null;
}

function publicModel(id: string, value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.name !== 'string' || source.name.length === 0) return null;
  const model: Record<string, unknown> = {
    id,
    object: 'model',
    owned_by: 'openopc',
    name: source.name,
  };
  for (const field of ['reasoning', 'tool_call', 'attachment', 'temperature'] as const) {
    if (typeof source[field] === 'boolean') model[field] = source[field];
  }
  if (source.limit && typeof source.limit === 'object' && !Array.isArray(source.limit)) {
    const limit = source.limit as Record<string, unknown>;
    const context = limit.context;
    const output = limit.output;
    if (
      typeof context === 'number' &&
      Number.isSafeInteger(context) &&
      context > 0 &&
      typeof output === 'number' &&
      Number.isSafeInteger(output) &&
      output > 0
    ) {
      model.limit = { context, output };
    }
  }
  return model;
}
