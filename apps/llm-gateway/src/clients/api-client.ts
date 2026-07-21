import { gatewayRequestContext, withRetry } from '@kortix/llm-gateway';
import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayRequestContext,
  GatewayTrace,
  ModelCatalog,
  ModelRouteInput,
  ModelRoutePlan,
  UpstreamDescriptor,
  UsageEvent,
} from '@kortix/llm-gateway';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class ApiUnavailableError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
  ) {
    super(`kortix api ${path} unavailable${status ? ` (${status})` : ''}`);
    this.name = 'ApiUnavailableError';
  }
}

export interface ApiPingResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export interface ApiClient {
  authenticate: (token: string, context?: GatewayRequestContext) => Promise<AuthedPrincipal | null>;
  authorize: (token: string, context?: GatewayRequestContext) => Promise<AuthorizeResult>;
  resolveRoute: (
    principal: AuthedPrincipal,
    input: ModelRouteInput,
    context?: GatewayRequestContext,
  ) => Promise<ModelRoutePlan | null>;
  resolveUpstream: (
    principal: AuthedPrincipal,
    model: string,
    context?: GatewayRequestContext,
  ) => Promise<UpstreamDescriptor[]>;
  assertBillingActive: (accountId: string, context?: GatewayRequestContext) => Promise<void>;
  assertBudget: (principal: AuthedPrincipal, context?: GatewayRequestContext) => Promise<void>;
  recordUsage: (event: UsageEvent, context?: GatewayRequestContext) => Promise<void>;
  recordTrace: (trace: GatewayTrace, context?: GatewayRequestContext) => Promise<void>;
  listModels: (principal: AuthedPrincipal) => Promise<ModelCatalog>;
  ping: () => Promise<ApiPingResult>;
}

function internalContextHeaders(context?: GatewayRequestContext): Record<string, string> {
  if (!context) return {};
  const normalized = gatewayRequestContext(context.requestId, context);
  const requestId = /^req_[A-Za-z0-9_-]{1,96}$/.test(context.requestId)
    ? context.requestId
    : undefined;
  return {
    ...(normalized.traceparent ? { traceparent: normalized.traceparent } : {}),
    ...(normalized.tracestate ? { tracestate: normalized.tracestate } : {}),
    ...(requestId ? { 'x-request-id': requestId } : {}),
  };
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const post = async <T>(
    path: string,
    payload: unknown,
    context?: GatewayRequestContext,
  ): Promise<T> => {
    const contextHeaders = internalContextHeaders(context);
    return withRetry(
      async (signal) => {
        let response: Response;
        try {
          response = await fetchImpl(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${opts.token}`,
              ...contextHeaders,
            },
            body: JSON.stringify(payload),
            signal,
          });
        } catch {
          throw new ApiUnavailableError(path);
        }
        if (!response.ok) {
          throw new ApiUnavailableError(path, response.status);
        }
        return (await response.json()) as T;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        timeoutMs,
        isRetryable: (err) => err instanceof ApiUnavailableError,
      },
    );
  };

  return {
    authenticate: async (token, context) => {
      const result = await post<{ principal: AuthedPrincipal | null }>(
        '/internal/gateway/authenticate',
        { token },
        context,
      );
      return result.principal ?? null;
    },
    authorize: async (token, context) => {
      return post<AuthorizeResult>('/internal/gateway/authorize', { token }, context);
    },
    resolveRoute: async (principal, input, context) => {
      const result = await post<{ route: ModelRoutePlan | null }>(
        '/internal/gateway/resolve-route',
        { principal, input },
        context,
      );
      return result.route ?? null;
    },
    resolveUpstream: async (principal, model, context) => {
      const result = await post<{ candidates: UpstreamDescriptor[] }>(
        '/internal/gateway/resolve-upstream',
        {
          principal,
          model,
        },
        context,
      );
      return result.candidates ?? [];
    },
    assertBillingActive: async (accountId, context) => {
      const result = await post<{ active: boolean; message?: string }>(
        '/internal/gateway/billing',
        { accountId },
        context,
      );
      if (!result.active) {
        throw new Error(result.message ?? 'subscription required');
      }
    },
    assertBudget: async (principal, context) => {
      const result = await post<{ exceeded: boolean; message?: string }>(
        '/internal/gateway/budget-check',
        {
          principal,
        },
        context,
      );
      if (result.exceeded) {
        throw new Error(result.message ?? 'Budget exceeded');
      }
    },

    recordUsage: async (event, context) => {
      await post<{ ok: boolean }>('/internal/gateway/usage', { event }, context);
    },
    recordTrace: async (trace, context) => {
      await post<{ ok: boolean }>('/internal/gateway/trace', { trace }, context);
    },
    listModels: async (principal) => {
      const result = await post<{ models: ModelCatalog }>('/internal/gateway/models', {
        principal,
      });
      return result.models ?? {};
    },
    ping: async () => {
      const started = Date.now();
      try {
        const res = await fetchImpl(`${baseUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3_000),
        });
        return { ok: res.ok, latencyMs: Date.now() - started, status: res.status };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
