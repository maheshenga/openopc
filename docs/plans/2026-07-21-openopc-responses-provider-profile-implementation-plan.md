# OpenOPC Responses Provider Profile Implementation Plan

> **For agentic workers:** Execute this plan task-by-task on the existing `studio-platform` branch. Do not use superpowers skills. Track progress with the checkbox (`- [ ]`) items and stop at each focused verification gate.

**Goal:** Add a strict, backward-compatible provider capability profile so the existing Kortix LLM Gateway can reject incompatible upstream candidates before provider I/O and record bounded routing decisions without exposing a public `/v1/responses` API.

**Architecture:** Keep the current Chat Completions entrypoint, `ModelRoutePlan`, IAM, billing, budget, retry, circuit breaker, and transport registry unchanged. Add a pure capability-profile module inside `@kortix/llm-gateway`, pass low-sensitivity request requirements through the existing internal route contract, qualify resolved descriptors locally, and annotate only the already-tested `openai-codex` Responses descriptor.

**Tech Stack:** TypeScript, Bun tests, existing `@kortix/llm-gateway`, existing API control-plane resolver, Biome, pnpm workspace filters.

## Global Constraints

- Do not use the `superpowers` skill family.
- Do not run repository-wide or full test suites.
- Keep `POST /v1/llm/chat/completions` and the existing Chat response contract unchanged.
- Do not add public `POST /v1/responses`, Responses persistence, background task lifecycle, Computer Use, Web Search, or Code Interpreter.
- Do not add a database table, scheduler, event bus, Web route, Desktop route, SDK raw fetch, or provider credential surface.
- `UpstreamDescriptor.capabilities` must be additive and optional; a missing profile remains legacy-compatible.
- Only a capability explicitly declared `false` may exclude a valid legacy candidate.
- Malformed explicit profiles fail closed as `PROFILE_INVALID`; they never expose profile values in errors or traces.
- Trace metadata may contain model IDs, fixed capability names, booleans, transport names, and fixed reason codes only.
- Prompts, inputs, outputs, tool arguments, provider URLs, headers, credentials, tokens, cookies, signed URLs, raw provider bodies, and reasoning content must never enter capability routing metadata.
- First-party video, voice, 3D, digital-human, and batch-remix pages remain cancelled scope.

---

### Task 1: Add the strict capability profile and request-requirement contract

**Files:**

- Create: `packages/llm-gateway/src/domain/capabilities.ts`
- Create: `packages/llm-gateway/src/routing/capability-profile.ts`
- Create: `packages/llm-gateway/src/routing/capability-profile.test.ts`
- Modify: `packages/llm-gateway/src/domain/descriptor.ts`
- Modify: `packages/llm-gateway/src/domain/routing.ts`
- Modify: `packages/llm-gateway/src/domain/index.ts`
- Modify: `packages/llm-gateway/src/routing/index.ts`
- Modify: `packages/llm-gateway/src/index.ts`

**Interfaces:**

- Produces `UpstreamCapabilityProfile`, `GatewayCapabilityRequirements`, `GatewayCapabilityName`, and `CapabilityExclusionReason`.
- Produces `capabilityRequirementsFromChat(body)`, `evaluateUpstreamCapabilities(descriptor, requirements)`, and `requiredCapabilityNames(requirements)`.
- `ModelRouteInput.requires` consumes `GatewayCapabilityRequirements`; `imageInput` remains required while new fields remain optional for rolling-deploy compatibility.

- [ ] **Step 1: Write the failing profile tests.**

Create `packages/llm-gateway/src/routing/capability-profile.test.ts` with these cases:

```ts
import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import {
  capabilityRequirementsFromChat,
  evaluateUpstreamCapabilities,
  requiredCapabilityNames,
} from './capability-profile';

const descriptor = (capabilities?: unknown): UpstreamDescriptor =>
  ({
    provider: 'test',
    kind: 'openai-responses',
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'private-test-key',
    billingMode: 'none',
    markup: 0,
    ...(capabilities === undefined ? {} : { capabilities }),
  }) as UpstreamDescriptor;

describe('provider capability profiles', () => {
  test('extracts only approved Chat request requirements', () => {
    const requirements = capabilityRequirementsFromChat({
      stream: true,
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      reasoning_effort: 'medium',
      metadata: { background: true, stateContinuation: true },
    });

    expect(requirements).toEqual({
      imageInput: true,
      streaming: true,
      functionTools: true,
      reasoning: true,
      stateContinuation: false,
      background: false,
    });
    expect(requiredCapabilityNames(requirements)).toEqual([
      'streaming',
      'image_input',
      'function_tools',
      'reasoning',
    ]);
  });

  test('keeps a missing profile legacy-compatible', () => {
    expect(evaluateUpstreamCapabilities(descriptor(), {
      imageInput: true,
      functionTools: true,
    })).toEqual({ eligible: true, profile: null });
  });

  test('excludes only explicitly unsupported capabilities', () => {
    expect(evaluateUpstreamCapabilities(descriptor({
      transport: 'responses',
      imageInput: true,
      functionTools: false,
    }), {
      imageInput: true,
      functionTools: true,
    })).toEqual({
      eligible: false,
      reason: 'CAPABILITY_UNSUPPORTED',
      capabilities: ['function_tools'],
    });
  });

  test('rejects a mismatched transport and unknown profile fields', () => {
    expect(evaluateUpstreamCapabilities(descriptor({
      transport: 'chat-completions',
    }), { imageInput: false })).toEqual({
      eligible: false,
      reason: 'PROFILE_INVALID',
      capabilities: [],
    });
    expect(evaluateUpstreamCapabilities(descriptor({
      transport: 'responses',
      provider_url: 'https://private.invalid',
    }), { imageInput: false })).toEqual({
      eligible: false,
      reason: 'PROFILE_INVALID',
      capabilities: [],
    });
  });
});
```

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter @kortix/llm-gateway exec bun test src/routing/capability-profile.test.ts
```

Expected: FAIL because `capability-profile.ts` and the exported types/functions do not exist.

- [ ] **Step 3: Add the domain types.**

Create `packages/llm-gateway/src/domain/capabilities.ts`:

```ts
export type UpstreamCapabilityTransport = 'chat-completions' | 'responses';

export type GatewayCapabilityName =
  | 'streaming'
  | 'image_input'
  | 'function_tools'
  | 'reasoning'
  | 'state_continuation'
  | 'background';

export type CapabilityExclusionReason = 'CAPABILITY_UNSUPPORTED' | 'PROFILE_INVALID';

export interface UpstreamCapabilityProfile {
  transport: UpstreamCapabilityTransport;
  streaming?: boolean;
  imageInput?: boolean;
  functionTools?: boolean;
  reasoning?: boolean;
  stateContinuation?: boolean;
  background?: boolean;
}

export interface GatewayCapabilityRequirements {
  imageInput: boolean;
  streaming?: boolean;
  functionTools?: boolean;
  reasoning?: boolean;
  stateContinuation?: boolean;
  background?: boolean;
}
```

Add to `UpstreamDescriptor` in `packages/llm-gateway/src/domain/descriptor.ts`:

```ts
import type { UpstreamCapabilityProfile } from './capabilities';

export interface UpstreamDescriptor {
  provider: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  billingMode: BillingMode;
  markup: number;
  appName?: string;
  appReferer?: string;
  resolvedModel?: string;
  headers?: Record<string, string>;
  omitAuthorization?: boolean;
  pricing?: UpstreamPricing;
  bodyExtras?: Record<string, unknown>;
  capabilities?: UpstreamCapabilityProfile;
}
```

Change `ModelRouteInput.requires` in `packages/llm-gateway/src/domain/routing.ts`:

```ts
import type { GatewayCapabilityRequirements } from './capabilities';

export interface ModelRouteInput {
  requestedModel: string;
  requires: GatewayCapabilityRequirements;
}
```

Export the types through `packages/llm-gateway/src/domain/index.ts`:

```ts
export type {
  CapabilityExclusionReason,
  GatewayCapabilityName,
  GatewayCapabilityRequirements,
  UpstreamCapabilityProfile,
  UpstreamCapabilityTransport,
} from './capabilities';
```

Add the same five names to the existing `export type { ... } from './domain';`
block in `packages/llm-gateway/src/index.ts`:

```ts
export type {
  AuthedPrincipal,
  AuthorizeResult,
  BillingMode,
  CapabilityExclusionReason,
  GatewayConfig,
  GatewayCapabilityName,
  GatewayCapabilityRequirements,
  GatewayHooks,
  GatewayLogger,
  GatewayTrace,
  ModelCatalog,
  ModelFallbackCondition,
  ModelFallbackPolicy,
  ModelFallbackPolicyMatch,
  ModelInfo,
  ModelRouteInput,
  ModelRoutePlan,
  ProviderKind,
  TokenCounts,
  UpstreamCapabilityProfile,
  UpstreamCapabilityTransport,
  UpstreamDescriptor,
  UsageEvent,
} from './domain';
```

- [ ] **Step 4: Implement the pure requirement and eligibility functions.**

Create `packages/llm-gateway/src/routing/capability-profile.ts`. Use a fixed key allowlist, derive the required transport from `descriptor.kind`, return `profile: null` for a missing profile, and never return rejected field values:

```ts
import type {
  CapabilityExclusionReason,
  GatewayCapabilityName,
  GatewayCapabilityRequirements,
  ProviderKind,
  UpstreamCapabilityProfile,
  UpstreamCapabilityTransport,
  UpstreamDescriptor,
} from '../domain';

const PROFILE_KEYS = new Set([
  'transport',
  'streaming',
  'imageInput',
  'functionTools',
  'reasoning',
  'stateContinuation',
  'background',
]);

const BOOLEAN_KEYS = [
  'streaming',
  'imageInput',
  'functionTools',
  'reasoning',
  'stateContinuation',
  'background',
] as const;

const REQUIREMENT_MAP = [
  ['streaming', 'streaming'],
  ['imageInput', 'image_input'],
  ['functionTools', 'function_tools'],
  ['reasoning', 'reasoning'],
  ['stateContinuation', 'state_continuation'],
  ['background', 'background'],
] as const;

export type CapabilityEvaluation =
  | { eligible: true; profile: UpstreamCapabilityProfile | null }
  | {
      eligible: false;
      reason: CapabilityExclusionReason;
      capabilities: GatewayCapabilityName[];
    };

function transportForKind(kind: ProviderKind): UpstreamCapabilityTransport {
  return kind === 'openai-responses' ? 'responses' : 'chat-completions';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedProfile(descriptor: UpstreamDescriptor): UpstreamCapabilityProfile | null | false {
  const raw = descriptor.capabilities;
  if (raw === undefined) return null;
  if (!isObject(raw)) return false;
  if (Object.keys(raw).some((key) => !PROFILE_KEYS.has(key))) return false;
  if (raw.transport !== transportForKind(descriptor.kind)) return false;
  if (BOOLEAN_KEYS.some((key) => key in raw && typeof raw[key] !== 'boolean')) return false;
  return raw as unknown as UpstreamCapabilityProfile;
}

function hasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!isObject(message) || !Array.isArray(message.content)) return false;
    return message.content.some((part) =>
      isObject(part) && ['image_url', 'input_image', 'image'].includes(String(part.type)),
    );
  });
}

export function capabilityRequirementsFromChat(
  body: Record<string, unknown>,
): GatewayCapabilityRequirements {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    imageInput: hasImage(body),
    streaming: body.stream === true,
    functionTools: tools.some((tool) => isObject(tool) && tool.type === 'function'),
    reasoning:
      isObject(body.reasoning) ||
      typeof body.reasoning_effort === 'string' ||
      isObject(body.thinking),
    stateContinuation: false,
    background: false,
  };
}

export function requiredCapabilityNames(
  requirements: GatewayCapabilityRequirements,
): GatewayCapabilityName[] {
  return REQUIREMENT_MAP.flatMap(([field, name]) => requirements[field] ? [name] : []);
}

export function evaluateUpstreamCapabilities(
  descriptor: UpstreamDescriptor,
  requirements: GatewayCapabilityRequirements,
): CapabilityEvaluation {
  const profile = normalizedProfile(descriptor);
  if (profile === false) {
    return { eligible: false, reason: 'PROFILE_INVALID', capabilities: [] };
  }
  if (profile === null) return { eligible: true, profile: null };
  const capabilities = REQUIREMENT_MAP.flatMap(([field, name]) =>
    requirements[field] && profile[field] === false ? [name] : [],
  );
  return capabilities.length > 0
    ? { eligible: false, reason: 'CAPABILITY_UNSUPPORTED', capabilities }
    : { eligible: true, profile };
}
```

Export the three functions and `CapabilityEvaluation` from `packages/llm-gateway/src/routing/index.ts` and `packages/llm-gateway/src/index.ts`.

```ts
// packages/llm-gateway/src/routing/index.ts
export {
  capabilityRequirementsFromChat,
  evaluateUpstreamCapabilities,
  requiredCapabilityNames,
} from './capability-profile';
export type { CapabilityEvaluation } from './capability-profile';

// packages/llm-gateway/src/index.ts
export {
  capabilityRequirementsFromChat,
  evaluateUpstreamCapabilities,
  requiredCapabilityNames,
} from './routing';
export type { CapabilityEvaluation } from './routing';
```

- [ ] **Step 5: Run GREEN and typecheck.**

```powershell
pnpm.cmd --filter @kortix/llm-gateway exec bun test src/routing/capability-profile.test.ts
pnpm.cmd --filter @kortix/llm-gateway typecheck
pnpm.cmd exec biome check packages/llm-gateway/src/domain/capabilities.ts packages/llm-gateway/src/domain/descriptor.ts packages/llm-gateway/src/domain/routing.ts packages/llm-gateway/src/domain/index.ts packages/llm-gateway/src/routing/capability-profile.ts packages/llm-gateway/src/routing/capability-profile.test.ts packages/llm-gateway/src/routing/index.ts packages/llm-gateway/src/index.ts
git diff --check
```

Expected: focused test PASS, typecheck exits `0`, Biome exits `0`, and no whitespace errors.

- [ ] **Step 6: Commit Task 1.**

```powershell
git add packages/llm-gateway/src/domain/capabilities.ts packages/llm-gateway/src/domain/descriptor.ts packages/llm-gateway/src/domain/routing.ts packages/llm-gateway/src/domain/index.ts packages/llm-gateway/src/routing/capability-profile.ts packages/llm-gateway/src/routing/capability-profile.test.ts packages/llm-gateway/src/routing/index.ts packages/llm-gateway/src/index.ts
git commit -m "feat: add gateway provider capability profiles"
```

### Task 2: Qualify Gateway candidates and record bounded routing decisions

**Files:**

- Modify: `packages/llm-gateway/src/pipeline/handler.ts`
- Modify: `packages/llm-gateway/src/pipeline/handler.test.ts`
- Modify: `apps/llm-gateway/src/clients/api-client.test.ts`

**Interfaces:**

- Consumes Task 1 `capabilityRequirementsFromChat`, `evaluateUpstreamCapabilities`, `requiredCapabilityNames`, `GatewayCapabilityRequirements`, and `UpstreamCapabilityProfile`.
- Preserves `RoutedUpstreamCandidate`, `runFailover`, `ModelRoutePlan`, `GatewayTrace`, and all transport response contracts.
- Produces `gatewayRouting.requiredCapabilities`, `gatewayRouting.selectedProfile`, and `gatewayRouting.exclusions` metadata.

- [ ] **Step 1: Write failing handler tests.**

Add focused tests to `packages/llm-gateway/src/pipeline/handler.test.ts`:

```ts
test('skips an explicitly incompatible candidate before provider I/O', async () => {
  const incompatible: UpstreamDescriptor = {
    ...managed,
    provider: 'no-tools',
    baseUrl: 'https://no-tools.test/v1',
    capabilities: {
      transport: 'chat-completions',
      functionTools: false,
    },
  };
  const compatible: UpstreamDescriptor = {
    ...managed,
    provider: 'tools',
    baseUrl: 'https://tools.test/v1',
    capabilities: {
      transport: 'chat-completions',
      functionTools: true,
    },
  };
  const calls: string[] = [];
  const { hooks, traces } = makeHooks({
    resolveUpstream: async () => [incompatible, compatible],
  });
  const response = await createGateway(hooks, { retry: fastRetry }, {
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname);
      return okFetch({ choices: [{ message: { content: 'ok' } }] })(url);
    },
  }).chatCompletions({
    authorization: 'Bearer good',
    rawBody: JSON.stringify({
      model: 'x',
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    }),
  });

  expect(response.status).toBe(200);
  expect(calls).toEqual(['tools.test']);
  await flush();
  expect(traces[0].candidatesTried).toEqual(['tools']);
  expect(traces[0].metadata.gatewayRouting).toMatchObject({
    requiredCapabilities: ['function_tools'],
    selectedProfile: { transport: 'chat-completions', functionTools: true },
    exclusions: [{
      model: 'x',
      reason: 'CAPABILITY_UNSUPPORTED',
      capabilities: ['function_tools'],
    }],
  });
});

test('returns capability_unavailable without provider I/O when every valid profile is incompatible', async () => {
  let calls = 0;
  const { hooks, traces } = makeHooks({
    resolveUpstream: async () => [{
      ...managed,
      capabilities: { transport: 'chat-completions', imageInput: false },
    }],
  });
  const response = await createGateway(hooks, { retry: fastRetry }, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not dispatch');
    },
  }).chatCompletions({
    authorization: 'Bearer good',
    rawBody: JSON.stringify({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    }),
  });

  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe('capability_unavailable');
  expect(calls).toBe(0);
  await flush();
  expect(traces[0].errorCode).toBe('capability_unavailable');
});

test('returns routing_unavailable without leaking a malformed profile', async () => {
  const privateUrl = 'https://private-provider.invalid';
  let calls = 0;
  const { hooks, traces } = makeHooks({
    resolveUpstream: async () => [{
      ...managed,
      capabilities: {
        transport: 'chat-completions',
        provider_url: privateUrl,
      } as never,
    }],
  });
  const response = await createGateway(hooks, { retry: fastRetry }, {
    fetchImpl: async () => {
      calls += 1;
      return okFetch({ choices: [{ message: { content: 'must not dispatch' } }] })('https://unused.invalid');
    },
  }).chatCompletions({
    authorization: 'Bearer good',
    rawBody: '{"model":"x"}',
  });

  expect(response.status).toBe(502);
  expect((await response.json()).code).toBe('routing_unavailable');
  expect(calls).toBe(0);
  await flush();
  expect(JSON.stringify(traces)).not.toContain(privateUrl);
});

test('passes all bounded requirements to the control plane and ignores metadata escalation', async () => {
  let seen: unknown;
  const { hooks } = makeHooks({
    resolveRoute: async (_principal, input) => {
      seen = input.requires;
      return null;
    },
  });
  await createGateway(hooks, { retry: fastRetry }, {
    fetchImpl: okFetch({ choices: [{ message: { content: 'ok' } }] }),
  }).chatCompletions({
    authorization: 'Bearer good',
    rawBody: JSON.stringify({
      model: 'x',
      stream: false,
      metadata: { background: true, stateContinuation: true },
    }),
  });
  expect(seen).toEqual({
    imageInput: false,
    streaming: false,
    functionTools: false,
    reasoning: false,
    stateContinuation: false,
    background: false,
  });
});
```

Update the `resolveRoute` request in `apps/llm-gateway/src/clients/api-client.test.ts` to use and assert the complete bounded requirement object:

```ts
const requires = {
  imageInput: false,
  streaming: true,
  functionTools: true,
  reasoning: false,
  stateContinuation: false,
  background: false,
};
const route = await c.resolveRoute(principal, { requestedModel: 'auto', requires });
expect(seenBody).toEqual({ principal, input: { requestedModel: 'auto', requires } });
```

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter @kortix/llm-gateway exec bun test src/pipeline/handler.test.ts
pnpm.cmd --filter @kortix/llm-gateway-server exec bun test src/clients/api-client.test.ts
```

Expected: handler tests FAIL because candidates are not qualified and trace metadata is absent. The API client test documents the additive internal request shape.

- [ ] **Step 3: Integrate request requirements and candidate qualification.**

In `packages/llm-gateway/src/pipeline/handler.ts`:

1. Import Task 1 helpers and delete the local `requestHasImage()` helper.
2. Immediately after parsing `body`, compute one immutable `requirements` value.
3. Pass `requirements` unchanged to `hooks.resolveRoute`.
4. Track resolved candidates separately from eligible candidates.
5. Store only fixed exclusion fields.

Add `GatewayCapabilityName` to the existing type import from `../domain`, then add this routing import:

```ts
import {
  capabilityRequirementsFromChat,
  evaluateUpstreamCapabilities,
  requiredCapabilityNames,
} from '../routing';
```

The candidate qualification block must follow this structure:

```ts
const requirements = capabilityRequirementsFromChat(body);

route = await hooks.resolveRoute?.(principal, {
  requestedModel,
  requires: requirements,
}) ?? null;

const candidates: RoutedUpstreamCandidate[] = [];
const capabilityExclusions: Array<{
  model: string;
  reason: 'CAPABILITY_UNSUPPORTED' | 'PROFILE_INVALID';
  capabilities: GatewayCapabilityName[];
}> = [];
let resolvedCandidateCount = 0;

for (const routeModel of routeModels) {
  try {
    const resolved = await hooks.resolveUpstream(principal, routeModel);
    resolvedCandidateCount += resolved.length;
    for (const descriptor of resolved) {
      const decision = evaluateUpstreamCapabilities(descriptor, requirements);
      if (decision.eligible) {
        candidates.push({ descriptor, routeModel });
      } else {
        capabilityExclusions.push({
          model: routeModel,
          reason: decision.reason,
          capabilities: decision.capabilities,
        });
      }
    }
  } catch (error) {
    logger.warn(`[llm-gateway] model resolution failed for ${routeModel} ${requestId}:`, error);
    step('model_resolution_failed', { routeModel, error: errorMessage(error) });
  }
}
```

Before the existing `model_unavailable` branch, add these branches:

```ts
if (
  resolvedCandidateCount > 0 &&
  candidates.length === 0 &&
  capabilityExclusions.every((item) => item.reason === 'PROFILE_INVALID')
) {
  emit({
    ...id,
    requestedModel,
    resolvedModel: routedModel,
    status: 502,
    ok: false,
    errorCode: 'routing_unavailable',
    request: capture(body),
    metadata: routingMetadata(null),
  });
  return gatewayErrorResponse(502, {
    message: 'Model routing policy is unavailable',
    code: 'routing_unavailable',
    provider: '',
    requestedModel,
    resolvedModel: routedModel,
    requestId,
    suggestion: 'Retry the request. If the error continues, check the gateway control plane.',
  });
}

if (resolvedCandidateCount > 0 && candidates.length === 0) {
  emit({
    ...id,
    requestedModel,
    resolvedModel: routedModel,
    status: 400,
    ok: false,
    errorCode: 'capability_unavailable',
    request: capture(body),
    metadata: routingMetadata(null),
  });
  return gatewayErrorResponse(400, {
    message: 'No configured upstream supports the requested capabilities',
    code: 'capability_unavailable',
    provider: '',
    requestedModel,
    resolvedModel: routedModel,
    requestId,
    suggestion: 'Choose a compatible model or remove the unsupported request capability.',
  });
}
```

- [ ] **Step 4: Extend routing metadata without changing legacy traces.**

Change `routingMetadata` so it adds capability fields only when at least one requirement is true, an exclusion exists, or the selected descriptor has an explicit valid profile. Keep the existing exact `{ policy, models, selected }` shape for unprofiled legacy fallback traffic.

```ts
const routingMetadata = (
  selected: string | null,
  selectedDescriptor?: UpstreamDescriptor,
): Record<string, unknown> => {
  const requiredCapabilities = requiredCapabilityNames(requirements);
  const selectedDecision = selectedDescriptor
    ? evaluateUpstreamCapabilities(selectedDescriptor, requirements)
    : null;
  const selectedProfile = selectedDecision?.eligible ? selectedDecision.profile : null;
  const hasCapabilityData =
    requiredCapabilities.length > 0 || capabilityExclusions.length > 0 || selectedProfile !== null;
  if (routeModels.length === 1 && !hasCapabilityData) return metadata;
  return {
    ...metadata,
    gatewayRouting: {
      ...(routeModels.length > 1
        ? {
            policy: route?.policyId || 'control-plane',
            models: routeModels,
            selected,
          }
        : {}),
      ...(requiredCapabilities.length > 0 ? { requiredCapabilities } : {}),
      ...(selectedProfile ? { selectedProfile } : {}),
      ...(capabilityExclusions.length > 0 ? { exclusions: capabilityExclusions } : {}),
    },
  };
};
```

Construct final success trace metadata with `routingMetadata(selectedRouteModel, finalDescriptor)`. Error branches use `routingMetadata(null)`.

- [ ] **Step 5: Run GREEN and compatibility gates.**

```powershell
pnpm.cmd --filter @kortix/llm-gateway exec bun test src/routing/capability-profile.test.ts src/pipeline/handler.test.ts
pnpm.cmd --filter @kortix/llm-gateway typecheck
pnpm.cmd --filter @kortix/llm-gateway-server exec bun test src/clients/api-client.test.ts
pnpm.cmd --filter @kortix/llm-gateway-server typecheck
pnpm.cmd --filter kortix-api exec bun test src/llm-gateway/routing/resolve-route.test.ts
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd exec biome check packages/llm-gateway/src/pipeline/handler.ts packages/llm-gateway/src/pipeline/handler.test.ts apps/llm-gateway/src/clients/api-client.test.ts
git diff --check
```

Expected: all focused tests PASS; the old fallback trace assertion remains unchanged; all typechecks and Biome exit `0`.

- [ ] **Step 6: Commit Task 2.**

```powershell
git add packages/llm-gateway/src/pipeline/handler.ts packages/llm-gateway/src/pipeline/handler.test.ts apps/llm-gateway/src/clients/api-client.test.ts
git commit -m "feat: route gateway requests by provider capabilities"
```

### Task 3: Declare verified Codex Responses capabilities and record the phase

**Files:**

- Create: `apps/api/src/llm-gateway/resolution/descriptors.test.ts`
- Modify: `apps/api/src/llm-gateway/resolution/descriptors.ts`
- Modify: `packages/llm-gateway/src/transports/openai-responses/request.test.ts`
- Modify: `docs/operations/intelligence-fabric.md`
- Modify: `docs/operations/studio-acceleration-progress.md`

**Interfaces:**

- Consumes Task 1 `UpstreamCapabilityProfile` through `UpstreamDescriptor.capabilities`.
- Declares only capabilities supported end-to-end by the existing `chatToResponses` request builder.
- Keeps `stateContinuation: false` and `background: false` until public lifecycle and persistence plans are separately approved.

- [ ] **Step 1: Write the failing descriptor and transport evidence tests.**

Create `apps/api/src/llm-gateway/resolution/descriptors.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { codexDescriptor } from './descriptors';

describe('gateway upstream capability descriptors', () => {
  test('declares only the verified Codex Responses capabilities', () => {
    const descriptor = codexDescriptor(
      { access: 'private-access-token', accountId: 'account-1' },
      'codex/gpt-5.6-sol',
    );
    expect(descriptor.kind).toBe('openai-responses');
    expect(descriptor.capabilities).toEqual({
      transport: 'responses',
      streaming: true,
      imageInput: true,
      functionTools: true,
      reasoning: true,
      stateContinuation: false,
      background: false,
    });
    expect(JSON.stringify(descriptor.capabilities)).not.toContain('private-access-token');
    expect(JSON.stringify(descriptor.capabilities)).not.toMatch(/url|header|token|credential/i);
  });
});
```

Extend `packages/llm-gateway/src/transports/openai-responses/request.test.ts` with one bounded mapping test:

```ts
test('maps function tools and explicit reasoning without enabling persistence', () => {
  const payload = chatToResponses({
    model: 'codex/gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Use the tool' }],
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Lookup a value',
        parameters: { type: 'object', properties: {} },
      },
    }],
    reasoning_effort: 'medium',
  }, descriptor) as AnyJson;

  expect(payload.tools).toEqual([{
    type: 'function',
    name: 'lookup',
    description: 'Lookup a value',
    parameters: { type: 'object', properties: {} },
  }]);
  expect(payload.reasoning).toEqual({ effort: 'medium' });
  expect(payload.store).toBe(false);
  expect(payload.background).toBeUndefined();
  expect(payload.previous_response_id).toBeUndefined();
});
```

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter kortix-api exec bun test src/llm-gateway/resolution/descriptors.test.ts
pnpm.cmd --filter @kortix/llm-gateway exec bun test src/transports/openai-responses/request.test.ts
```

Expected: descriptor test FAIL because `codexDescriptor()` does not yet declare `capabilities`. The transport evidence test must pass before capabilities are declared `true`; fix only a real request-mapping defect if it fails.

- [ ] **Step 3: Add the Codex effective profile.**

In `apps/api/src/llm-gateway/resolution/descriptors.ts`, extend only `codexDescriptor()`:

```ts
return {
  provider: 'openai-codex',
  kind: 'openai-responses',
  baseUrl: CHATGPT_CODEX_BASE_URL,
  apiKey: credential.access,
  billingMode: 'none',
  markup: 0,
  resolvedModel: model.replace(/^codex\//, ''),
  headers,
  capabilities: {
    transport: 'responses',
    streaming: true,
    imageInput: true,
    functionTools: true,
    reasoning: true,
    stateContinuation: false,
    background: false,
  },
};
```

Do not add inferred profiles to OpenRouter, Anthropic, Bedrock, BYOK, or custom descriptors in this task.

- [ ] **Step 4: Update operations evidence.**

Add a `Responses provider profile` section to `docs/operations/intelligence-fabric.md` recording:

```markdown
## Responses provider profile

The public product surface remains Chat Completions. The Gateway may use its
existing Responses transport only when an internal upstream descriptor selects
it. Provider profiles are additive, omit all credentials and connection data,
and filter only capabilities explicitly declared unsupported.

The current Codex profile records streaming, image input, function tools, and
reasoning as supported by the existing request adapter. State continuation and
background jobs remain disabled. This is not a public `/v1/responses`,
Computer Use, background execution, or production-readiness claim.
```

Add this paragraph to `docs/operations/studio-acceleration-progress.md` after the OpenOPC Milestone A production-boundary text:

```markdown
The Responses provider-profile slice adds bounded capability-aware routing to
the existing LLM Gateway. Default clients continue to use Chat Completions;
native `/v1/responses`, state continuation, background jobs, and Computer Use
remain separate later plans. This slice adds no provider credentials, database
state, Web route, Desktop route, or production-readiness claim.
```

- [ ] **Step 5: Run the complete focused phase gate.**

```powershell
pnpm.cmd --filter @kortix/llm-gateway exec bun test src/routing/capability-profile.test.ts src/pipeline/handler.test.ts src/transports/openai-responses/request.test.ts src/transports/openai-responses/response.test.ts
pnpm.cmd --filter @kortix/llm-gateway typecheck
pnpm.cmd --filter @kortix/llm-gateway-server exec bun test src/clients/api-client.test.ts
pnpm.cmd --filter @kortix/llm-gateway-server typecheck
pnpm.cmd --filter kortix-api exec bun test src/llm-gateway/resolution/descriptors.test.ts src/llm-gateway/routing/resolve-route.test.ts
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd exec biome check packages/llm-gateway/src/domain/capabilities.ts packages/llm-gateway/src/domain/descriptor.ts packages/llm-gateway/src/domain/routing.ts packages/llm-gateway/src/domain/index.ts packages/llm-gateway/src/routing/capability-profile.ts packages/llm-gateway/src/routing/capability-profile.test.ts packages/llm-gateway/src/routing/index.ts packages/llm-gateway/src/pipeline/handler.ts packages/llm-gateway/src/pipeline/handler.test.ts packages/llm-gateway/src/transports/openai-responses/request.test.ts packages/llm-gateway/src/index.ts apps/llm-gateway/src/clients/api-client.test.ts apps/api/src/llm-gateway/resolution/descriptors.ts apps/api/src/llm-gateway/resolution/descriptors.test.ts
git diff --check
```

Expected: all focused tests PASS; package, server, and API typechecks exit `0`; Biome and whitespace checks exit `0`. Do not run full repository, Web, SDK, database, Studio, Electron, or mobile suites.

- [ ] **Step 6: Review the final boundary.**

Run these scans and inspect every match:

```powershell
rg -n "POST /v1/responses|app\.post\(.+responses|background:\s*true|stateContinuation:\s*true|computer[_ -]?use" packages/llm-gateway/src apps/api/src/llm-gateway/resolution apps/llm-gateway/src/clients docs/operations/intelligence-fabric.md docs/operations/studio-acceleration-progress.md -g "*.ts" -g "*.md"
rg -n "apiKey|authorization|provider_url|baseUrl|headers|signed_url|prompt|reasoning" packages/llm-gateway/src/routing/capability-profile.ts apps/api/src/llm-gateway/resolution/descriptors.test.ts
```

Expected: no new public Responses route; `background` and `stateContinuation` are not enabled; security-word matches are confined to negative tests, existing descriptor fields, or explicit redaction documentation.

- [ ] **Step 7: Commit Task 3.**

```powershell
git add apps/api/src/llm-gateway/resolution/descriptors.ts apps/api/src/llm-gateway/resolution/descriptors.test.ts packages/llm-gateway/src/transports/openai-responses/request.test.ts docs/operations/intelligence-fabric.md docs/operations/studio-acceleration-progress.md
git commit -m "feat: declare verified Responses provider capabilities"
```

## Final Acceptance Checklist

- [ ] Missing `UpstreamDescriptor.capabilities` preserves existing traffic.
- [ ] `false` excludes a requested capability; `undefined` remains legacy-compatible.
- [ ] Malformed explicit profiles fail closed and never expose their values.
- [ ] Capability exclusions happen before provider I/O and do not enter `candidatesTried`.
- [ ] Control-plane requests receive only bounded boolean capability requirements.
- [ ] Client metadata cannot enable background, state continuation, or native tools.
- [ ] Legacy fallback trace shape remains unchanged when no capability data exists.
- [ ] Codex declares only capabilities proven by request-adapter tests.
- [ ] No public Responses API, persistence, Computer Use, database, Web, Desktop, or SDK surface is added.
- [ ] Focused tests, three typechecks, Biome, boundary scans, and `git diff --check` pass.
- [ ] No full repository suite is run or claimed.
