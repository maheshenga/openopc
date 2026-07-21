import type { ModelCatalog } from './catalog';
import type { UpstreamDescriptor } from './descriptor';
import type { AuthedPrincipal } from './principal';
import type { GatewayRequestContext } from './request-context';
import type { ModelRouteInput, ModelRoutePlan } from './routing';
import type { GatewayTrace } from './trace';
import type { UsageEvent } from './usage';

// Outcome of the combined pre-dispatch gate (auth + billing + budget). On a
// denial, `principal` is present when the token authenticated but a later gate
// failed (so the trace stays attributed).
export type AuthorizeResult =
  | { ok: true; principal: AuthedPrincipal }
  | {
      ok: false;
      status: 401 | 402;
      errorCode: string;
      message?: string;
      principal?: AuthedPrincipal;
    };

export interface GatewayHooks {
  authenticate: (
    token: string,
    context?: GatewayRequestContext,
  ) => Promise<AuthedPrincipal | null>;
  // Optional combined gate: token → authenticated + billing-active + within
  // budget, in ONE call. When provided, the chat-completions handler uses it
  // instead of authenticate + assertBillingActive + assertBudget — the standalone
  // gateway sets this to fold three sequential cross-process RPCs into one. The
  // in-process mount omits it (its three direct calls are free) and keeps using
  // the granular hooks below. listModels still uses authenticate directly.
  authorize?: (token: string, context?: GatewayRequestContext) => Promise<AuthorizeResult>;
  // The host/control plane owns model names, catalog state, defaults, and
  // fallback policy. The gateway sends only opaque model ids + request traits
  // and executes the returned finite route generically.
  resolveRoute?: (
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
  assertBudget?: (principal: AuthedPrincipal, context?: GatewayRequestContext) => Promise<void>;
  recordUsage: (event: UsageEvent, context?: GatewayRequestContext) => Promise<void>;
  recordTrace?: (trace: GatewayTrace, context?: GatewayRequestContext) => Promise<void>;
  listModels?: (principal: AuthedPrincipal) => Promise<ModelCatalog>;
}
