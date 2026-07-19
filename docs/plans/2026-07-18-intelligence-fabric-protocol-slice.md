# Kortix Intelligence Fabric Protocol Slice Implementation Plan

**Goal:** Add a versioned, upgrade-safe Agent capability layer that lets a Kortix Agent discover and invoke the existing Studio `image.generate` path through governed MCP/A2A-compatible contracts, without adding future-media routes or replacing the current Studio Worker.

**Architecture:** Keep domain contracts in a side-effect-free workspace package. Build project-scoped capability and Agent Card services above the existing Studio route/service and IAM gateway. Expose the first task through a thin API wrapper, the existing MCP meta-tool face, and the shared SDK; all execution still enters the existing Studio estimate/create-job/recovery path.

**Tech Stack:** TypeScript, Zod, Bun tests, pnpm workspaces, Hono, `@hono/zod-openapi`, existing Kortix IAM/Executor/Registry/Sandbox/Studio packages, PostgreSQL/Drizzle only for the durable task envelope, and the existing dependency-free Prometheus telemetry seam. MCP revision `2025-11-25` and A2A `v1.0.1` are wire references; no provider-specific SDK is added.

## Global Constraints

- Do not use the `superpowers` skill family or its execution sub-skills; use the repository's existing agent/commit/review workflow.
- Preserve Kortix as the sole base and keep all new behavior extension-owned and additive.
- Do not modify the existing Studio Worker lease, recovery, billing, object-store, or provider credential contracts.
- Keep `STUDIO_ENABLED=false` in production values until the existing Studio deployment and acceptance gates pass.
- First-party video, voice, 3D, digital-human, and batch-remix finished-product pages are cancelled product scope. This plan must not add their routes, capability IDs, adapters, seed data, or navigation.
- This plan adds no Developer Center UI route.
- Never expose credentials, provider API keys, provider URLs, signed URLs, authorization headers, raw provider bodies, or high-cardinality tenant/job labels.
- Reuse existing IAM project/agent grants, Executor policy/approval, Registry lock/hash, and Daytona Sandbox boundaries; do not create a second permission or marketplace system.
- New wire payloads are strict Zod schemas with explicit version fields. Unknown future protocol versions fail closed with a typed error.
- Every implementation task starts with a failing focused test, ends with focused tests plus typecheck, and gets one isolated commit.
- Package commands use `pnpm` for workspace orchestration and `bun test` through package scripts. Historical unrelated Biome violations are not reformatted.

## Scope Split

This plan is the first independently testable release slice. The following are deliberately separate follow-on plans, each with its own acceptance gate:

- `2026-07-18-intelligence-workflow-evaluation-plan.md`: durable workflow graph, model routing, golden-set evaluation, and Temporal adapter.
- `2026-07-18-intelligence-provenance-plan.md`: C2PA-compatible manifests, signing/KMS, and asset lineage across media types.
- `2026-07-18-developer-module-trust-plan.md`: capability honesty scans, Cosign/Sigstore verification, SBOM, trust tiers, and marketplace consent UI.

The current plan must leave stable ports for those plans without pretending they are implemented. Multimedia finished-product pages are not a follow-on plan; they are cancelled product scope under `docs/specs/2026-07-20-multimedia-product-scope-cancellation.md`.

---

### Task 0: Close the Existing Studio Telemetry Injection Gate

**Files:**
- Modify: `apps/studio-worker/src/worker.ts`
- Modify: `apps/studio-worker/src/runtime.ts`
- Modify: `apps/studio-worker/src/metrics.ts`
- Modify: `apps/studio-worker/src/metrics.test.ts`
- Modify: `apps/studio-worker/src/runtime.test.ts`
- Modify: `apps/api/src/studio/default-routes.ts`
- Modify: `apps/api/src/studio/index.ts`
- Modify: `apps/api/src/studio/metrics.ts`
- Modify: `apps/api/src/studio/metrics.test.ts`
- Test: `apps/api/src/studio/default-routes.test.ts`

**Interfaces:**
- Consumes the existing `StudioTelemetry`, `StudioTelemetrySinks`, and `createInMemoryStudioTelemetrySink` definitions in `apps/studio-worker/src/metrics.ts` and `apps/api/src/studio/metrics.ts`.
- Produces an optional injected telemetry dependency on both runtime builders. Omitted telemetry is a no-op so existing callers remain source-compatible.

- [ ] **Step 1: Write the RED injection tests.**

Add tests that pass an in-memory sink into `buildStudioWorkerRuntime` and the retained API runtime, then assert exact emissions for provider submit, storage operation, readiness, unknown outcome, recovery decision, queue age, and reservation age. Add a test that a disabled runtime never constructs a sink or store.

```ts
const sink = createInMemoryStudioTelemetrySink();
const runtime = await buildStudioWorkerRuntime(env, {
  telemetry: createStudioTelemetry(sink),
});
expect(sink.emissions).toContainEqual(expect.objectContaining({
  name: 'studio_storage_readiness',
  labels: { role: 'worker' },
}));
```

- [ ] **Step 2: Run the RED tests.**

Run:

```powershell
pnpm --filter @kortix/studio-worker test src/runtime.test.ts src/metrics.test.ts
pnpm --filter kortix-api exec bun test src/studio/default-routes.test.ts src/studio/metrics.test.ts
```

Expected: the new tests fail because runtime factories do not accept or forward telemetry.

- [ ] **Step 3: Implement the smallest injection seam.**

Add `telemetry?: StudioTelemetry` to the worker/API runtime options and thread the object only into provider, storage, maintenance, and recovery wrappers. Keep the existing metric names and low-cardinality label unions unchanged. Do not add an exporter or scrape endpoint in this task.

- [ ] **Step 4: Run the GREEN gates.**

Run:

```powershell
pnpm --filter @kortix/studio-adapters test
pnpm --filter @kortix/studio-adapters typecheck
pnpm --filter @kortix/studio-worker test
pnpm --filter @kortix/studio-worker typecheck
pnpm --filter kortix-api exec bun test src/studio/default-routes.test.ts src/studio/metrics.test.ts src/__tests__/e2e-studio-production-api.test.ts
pnpm --filter kortix-api typecheck
git diff --check
```

Expected: all focused/package gates pass and no telemetry label contains account, project, job, object key, URL, model, credential, or error text.

- [ ] **Step 5: Commit.**

```powershell
git add apps/studio-worker/src/worker.ts apps/studio-worker/src/runtime.ts apps/studio-worker/src/metrics.ts apps/studio-worker/src/metrics.test.ts apps/studio-worker/src/runtime.test.ts apps/api/src/studio/default-routes.ts apps/api/src/studio/index.ts apps/api/src/studio/metrics.ts apps/api/src/studio/metrics.test.ts apps/api/src/studio/default-routes.test.ts
git commit -m "feat: inject studio telemetry sinks"
```

---

### Task 1: Create the Side-Effect-Free Intelligence Contract Package

**Files:**
- Create: `packages/intelligence-contracts/package.json`
- Create: `packages/intelligence-contracts/tsconfig.json`
- Create: `packages/intelligence-contracts/src/index.ts`
- Create: `packages/intelligence-contracts/src/schemas.ts`
- Create: `packages/intelligence-contracts/src/schemas.test.ts`
- Create: `packages/intelligence-contracts/src/compatibility.ts`
- Create: `packages/intelligence-contracts/src/compatibility.test.ts`
- Modify: `apps/api/package.json`
- Modify: `packages/api-contract/package.json`
- Modify: `packages/sdk/package.json`
- Modify: `apps/cli/package.json` (add workspace dependencies on `@kortix/intelligence-contracts` and `@kortix/api-contract`)

**Interfaces:**
- Produces `CapabilityDescriptorSchema`, `AgentCardSchema`, `TaskEnvelopeSchema`, `TaskEventSchema`, `ProtocolVersionSchema`, and `assertSupportedProtocolVersion`.
- The package imports only `zod`; it must not import `apps/*`, database clients, provider adapters, filesystem APIs, or browser globals.
- `@kortix/api-contract`, `kortix-api`, `@kortix/sdk`, and `@kortix/cli` consume this package through workspace dependencies. Studio-specific request schemas remain in `@kortix/api-contract` because they compose `StudioJobInputSchema`.

- [ ] **Step 1: Write RED schema tests.**

Cover valid image capability, valid project Agent Card, valid task envelope, malformed UUID/project identifiers, unknown modality, missing card hash, invalid trust tier, unsupported protocol version, and extra keys rejected by strict schemas.

```ts
test('accepts the first image capability descriptor', () => {
  expect(CapabilityDescriptorSchema.parse({
    id: 'studio.image.generate', version: '1.0.0', modality: 'image',
    operation: 'generate', input_schema: { type: 'object' },
    output_schema: { type: 'array' }, execution: 'async', risk: 'write',
    provenance_required: true,
  }).id).toBe('studio.image.generate');
});

test('rejects an unknown protocol revision', () => {
  expect(() => assertSupportedProtocolVersion('9.0')).toThrow('unsupported');
});
```

- [ ] **Step 2: Run the RED tests.**

Run `pnpm --filter @kortix/intelligence-contracts test`. Expected: module/schema exports are missing.

- [ ] **Step 3: Implement the contracts.**

Use strict snake_case wire fields matching the existing API contract convention. Keep domain helpers in camelCase only after parsing. Define the first supported contract revision as `intelligence.v1`; accepting an unknown revision must throw a typed `UnsupportedIntelligenceProtocolError` without echoing payload data.

- [ ] **Step 4: Wire package dependencies and run GREEN gates.**

Run:

```powershell
pnpm install --lockfile-only
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/intelligence-contracts typecheck
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/cli typecheck
```

Expected: the new package and all consumers typecheck without changing existing public SDK exports.

- [ ] **Step 5: Commit.**

```powershell
git add packages/intelligence-contracts apps/api/package.json packages/api-contract/package.json packages/sdk/package.json apps/cli/package.json pnpm-lock.yaml
git commit -m "feat: add intelligence protocol contracts"
```

---

### Task 2: Parse Registry Capabilities and Build Project Agent Cards

**Files:**
- Create: `packages/registry/src/capabilities.ts`
- Create: `packages/registry/src/capabilities.test.ts`
- Modify: `packages/registry/src/index.ts`
- Create: `apps/api/src/intelligence/capability-registry.ts`
- Create: `apps/api/src/intelligence/capability-registry.test.ts`
- Create: `apps/api/src/intelligence/agent-cards.ts`
- Create: `apps/api/src/intelligence/agent-cards.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- `readRegistryCapabilities(item: RegistryItem): RegistryCapabilityDeclaration | null` reads only `item.meta.capabilities` and returns a validated, normalized object.
- `createProjectCapabilityRegistry(deps).list(projectId, actor)` returns `Promise<CapabilityDescriptor[]>` using existing Studio capability/provider services.
- `buildProjectAgentCard(input): AgentCard` creates a deterministic card hash from canonical non-secret fields.

- [ ] **Step 1: Write RED parser and card tests.**

Test that capability metadata accepts `secrets`, `connectors`, `network`, `tools`, `writes`, and `required_runtime`; rejects non-array values and empty capability names; ignores unrelated `meta`; and never includes an env value or URL credential in the normalized output. Test card hash stability across object-key order and hash changes when a capability version changes.

```ts
const card = buildProjectAgentCard({
  projectId: PROJECT_ID,
  agentId: 'content-planner',
  displayName: 'Content Planner',
  capabilities: [imageCapability],
  trustTier: 'project',
});
expect(card.card_hash).toMatch(/^[a-f0-9]{64}$/);
```

- [ ] **Step 2: Run the RED tests.**

Run `pnpm --filter @kortix/registry test src/capabilities.test.ts && pnpm --filter kortix-api exec bun test src/intelligence/capability-registry.test.ts src/intelligence/agent-cards.test.ts`. Expected: the new exports and builders are absent.

- [ ] **Step 3: Implement capability normalization.**

Keep `RegistryItem.meta` backward-compatible. Do not add a required top-level manifest key. Use a strict parser for the optional `meta.capabilities` object and return `null` when it is absent. Build the Studio descriptor from the already validated `studioPhase1Capabilities` and provider definitions rather than duplicating model lists.

- [ ] **Step 4: Implement deterministic Agent Card generation.**

Canonicalize sorted capability IDs, protocol names, trust tier, limits, and version; hash the canonical UTF-8 JSON with SHA-256; never hash or serialize secrets, base URLs, signed URLs, or raw prompts. The card is descriptive only and carries no token.

- [ ] **Step 5: Run GREEN gates.**

Run:

```powershell
pnpm --filter @kortix/registry test
pnpm --filter @kortix/registry typecheck
pnpm --filter kortix-api exec bun test src/intelligence/capability-registry.test.ts src/intelligence/agent-cards.test.ts
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 6: Commit.**

```powershell
git add packages/registry/src/capabilities.ts packages/registry/src/capabilities.test.ts packages/registry/src/index.ts apps/api/src/intelligence apps/api/package.json
git commit -m "feat: build governed intelligence capability cards"
```

---

### Task 3: Add Project-Scoped Intelligence API Routes

**Files:**
- Create: `packages/api-contract/src/intelligence.ts`
- Modify: `packages/api-contract/src/index.ts`
- Create: `apps/api/src/intelligence/project-routes.ts`
- Create: `apps/api/src/intelligence/project-routes.test.ts`
- Modify: `apps/api/src/studio/default-routes.ts`
- Modify: `apps/api/src/projects/index.ts`
- Modify: `apps/api/src/projects/routes/studio.ts`
- Modify: `apps/api/src/projects/lib/app.ts` only if a shared OpenAPI schema export is required

**Interfaces:**
- `GET /v1/projects/:projectId/intelligence/capabilities` returns `{ protocol_version, items, next_cursor }`.
- `GET /v1/projects/:projectId/intelligence/agent-card` returns one `AgentCard` with no credential material.
- `POST /v1/projects/:projectId/intelligence/tasks` accepts `IntelligenceCreateTaskRequest` and delegates to a supplied `StudioTaskExecutor`; this task wires and tests the route seam with a fake executor. The default production route returns 503 until Task 6 installs the durable executor.
- `GET /v1/projects/:projectId/intelligence/tasks/:taskId/events` returns durable cursor events; implementation initially maps one Studio job to one task. Before Task 6 installs the task service, the production route returns the same typed 503 executor-unavailable response and performs no read.

The request and service signatures are fixed here and reused by Tasks 4-7:

```ts
type IntelligenceCreateTaskRequest = {
  protocol_version: 'intelligence.v1';
  capability_id: 'studio.image.generate';
  agent_card_hash: string;
  provider_config_id: string;
  model: string;
  input: StudioJobInput;
  idempotency_key: string;
  parent_task_id?: string | null;
  deadline_at?: string | null;
};

interface StudioTaskExecutor {
  create(input: {
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    actorType: 'user' | 'agent' | 'system';
    actingTokenId: string | null;
    agentName: string | null;
    sessionId: string | null;
    request: IntelligenceCreateTaskRequest;
  }): Promise<{ taskId: string; jobId: string; created: boolean }>;
}
```

- [ ] **Step 1: Write RED route tests.**

Use the existing Hono test harness and injected route dependencies. Cover: project not found, missing `PROJECT_STUDIO_PROVIDERS_USE`, disabled/unready Studio returns no executable capability, local agent grant allowed, external card without trust denied, malformed protocol version returns 400, duplicate idempotency returns the original task, cross-project task read returns 404, and response bodies contain no secret/provider URL/signed URL.

- [ ] **Step 2: Run the RED route tests.**

Run `pnpm --filter kortix-api exec bun test src/intelligence/project-routes.test.ts`. Expected: route module and contract exports are missing.

- [ ] **Step 3: Add strict wire schemas.**

Define `IntelligenceCapabilitiesResponseSchema`, `IntelligenceAgentCardResponseSchema`, `IntelligenceCreateTaskRequestSchema`, `IntelligenceTaskResponseSchema`, and `IntelligenceTaskEventsResponseSchema` in `packages/api-contract/src/intelligence.ts`. Keep task input as a reference to the existing `StudioJobInputSchema`; do not fork image input validation.

- [ ] **Step 4: Implement the route factory.**

Create `createIntelligenceProjectRoutes(deps)` with the same `loadProjectForUser` and `assertProjectCapability` dependency shape as Studio. Mount it beside, not inside, the existing Studio route factory so the current route URLs and lifecycle ownership remain unchanged. The route derives `actor_type`, `agent_name`, `session_id`, and `acting_token_id` from the request context before calling the injected `StudioTaskExecutor`. With no executor, the production route returns `{ code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE' }` and performs no reservation or job insert.

- [ ] **Step 5: Add route registration and run GREEN gates.**

Import the new route module in `apps/api/src/projects/index.ts` in the existing registration order after `routes/studio`. Run:

```powershell
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter kortix-api exec bun test src/intelligence/project-routes.test.ts src/studio/default-routes.test.ts src/__tests__/e2e-studio-production-api.test.ts
pnpm --filter kortix-api typecheck
```

Expected: old Studio route tests remain green and the new endpoints enforce the same project/account fences.

- [ ] **Step 6: Commit.**

```powershell
git add packages/api-contract/src/intelligence.ts packages/api-contract/src/index.ts apps/api/src/intelligence apps/api/src/studio/default-routes.ts apps/api/src/projects/index.ts apps/api/src/projects/routes/studio.ts apps/api/src/projects/lib/app.ts
git commit -m "feat: expose governed intelligence project routes"
```

---

### Task 4: Expose Studio Through the Existing MCP Meta-Tool Face

**Files:**
- Create: `apps/cli/src/executor/intelligence.ts`
- Create: `apps/cli/src/executor/intelligence.test.ts`
- Modify: `apps/cli/src/executor/mcp.ts`
- Modify: `apps/cli/src/executor/gateway.ts` only if the existing auth context helper must be shared
- Create: `apps/cli/src/__tests__/executor-intelligence-mcp.test.ts`

**Interfaces:**
- `intelligenceProjectContext(projectOverride?)` returns the same `{ client, projectId }` shape as `executorProjectContext`.
- `listIntelligenceCapabilities()` calls the project-scoped API route and returns the contract response.
- `createIntelligenceTask(input)` calls the API task wrapper and returns a task ID; it never accepts raw credentials or arbitrary URLs.
- The MCP surface adds two stable meta-tools: `studio_capabilities` (read-only) and `studio_create_task` (write/approval-gated by the API). Existing `connectors`, `discover`, `describe`, and `call` behavior remains byte-compatible.

- [ ] **Step 1: Write RED CLI/API-client tests.**

Mock `clientFromAuth` and assert exact paths, bearer usage through the existing client, strict input forwarding, and redaction of an API error containing a provider URL. Test MCP `tools/list` includes the two names with `readOnlyHint` set correctly and `tools/call` maps malformed args to a structured error.

```ts
expect(requests[0]).toEqual({
  method: 'GET',
  path: `/projects/${PROJECT_ID}/intelligence/capabilities`,
});
```

- [ ] **Step 2: Run the RED tests.**

Run `pnpm --filter @kortix/cli test -- src/executor/intelligence.test.ts`. Expected: helper and meta-tool cases are not defined.

- [ ] **Step 3: Implement the thin project client.**

Reuse `executorProjectContext` and `ApiClient`; do not create a second token loader or HTTP implementation. Add the planned `@kortix/api-contract` workspace dependency to the CLI and validate the task body with `IntelligenceCreateTaskRequestSchema` before sending it. Use the existing project ID resolution order.

- [ ] **Step 4: Add the two MCP meta-tools.**

Keep the fixed meta-tool strategy: do not enumerate provider/model actions in `tools/list`. `studio_capabilities` returns descriptors. `studio_create_task` accepts exactly `capability_id`, `agent_card_hash`, `provider_config_id`, `model`, existing `StudioJobInput`, `idempotency_key`, optional `parent_task_id`, and optional `deadline_at`. The API remains responsible for estimate binding, IAM, approval, and billing.

- [ ] **Step 5: Run GREEN gates.**

```powershell
pnpm --filter @kortix/cli test
pnpm --filter @kortix/cli typecheck
pnpm --filter kortix-api exec bun test src/__tests__/e2e-executor-faces.test.ts src/intelligence/project-routes.test.ts
git diff --check
```

- [ ] **Step 6: Commit.**

```powershell
git add apps/cli/src/executor/intelligence.ts apps/cli/src/executor/intelligence.test.ts apps/cli/src/executor/mcp.ts apps/cli/src/__tests__/executor-intelligence-mcp.test.ts
git commit -m "feat: expose studio capabilities through mcp"
```

---

### Task 5: Add the Shared SDK Intelligence Surface

**Files:**
- Create: `packages/sdk/src/core/rest/projects-client/intelligence.ts`
- Create: `packages/sdk/src/core/rest/projects-client/intelligence.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/package.json`
- Create: `packages/sdk/src/react/use-intelligence.ts`
- Modify: `packages/sdk/src/react/index.ts`
- Create: `packages/sdk/src/react/use-intelligence.test.tsx`

**Interfaces:**
- `project(projectId).intelligence.capabilities.list()` returns typed capability descriptors.
- `project(projectId).intelligence.agentCard.get()` returns a typed `AgentCard`.
- `project(projectId).intelligence.tasks.create(input)` returns a typed task envelope.
- `project(projectId).intelligence.tasks.events(taskId, cursor?)` returns a durable cursor page.
- React hooks use the existing TanStack Query key/invalidation conventions and do not create a new SDK subpath.

- [ ] **Step 1: Write RED SDK tests.**

Mock `backendApi`, assert the exact `/projects/:id/intelligence/*` paths, response unwrapping, cursor forwarding, and no accidental inclusion of signed URLs in error objects. Test React query invalidation after task creation.

- [ ] **Step 2: Run the RED tests.**

Run `pnpm --filter @kortix/sdk test -- src/core/rest/projects-client/intelligence.test.ts`. Expected: exports and hooks are absent.

- [ ] **Step 3: Implement REST methods and hooks.**

Use the existing `shared.ts` `unwrap` helper and `backendApi`; preserve the current public barrel shape. Hook keys must include `projectId` and `taskId`, and task creation invalidates capability/task queries without invalidating unrelated session data.

- [ ] **Step 4: Run GREEN gates.**

```powershell
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk build
pnpm --filter @kortix/sdk smoke:install
```

- [ ] **Step 5: Commit.**

```powershell
git add packages/sdk/src/core/rest/projects-client/intelligence.ts packages/sdk/src/core/rest/projects-client/intelligence.test.ts packages/sdk/src/core/rest/projects-client/index.ts packages/sdk/src/react/use-intelligence.ts packages/sdk/src/react/use-intelligence.test.tsx packages/sdk/src/react/index.ts packages/sdk/package.json
git commit -m "feat: add intelligence sdk surface"
```

---

### Task 6: Add the Durable One-Job Task Bridge and Event Cursor

**Files:**
- Create: `apps/api/src/intelligence/task-service.ts`
- Create: `apps/api/src/intelligence/task-service.test.ts`
- Create: `packages/db/migrations/20260718140000000_intelligence_task_bridge.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/schema/index.ts` if the schema barrel requires it
- Modify: `apps/api/src/intelligence/project-routes.ts`
- Modify: `apps/api/src/studio/default-routes.ts`
- Create: `packages/db/scripts/intelligence-task-migration.integration.test.ts`
- Modify: `packages/api-contract/src/intelligence.ts`

**Interfaces:**
- `StudioTaskExecutor.create(input): Promise<{ taskId: string; jobId: string; created: boolean }>` uses the exact input signature defined in Task 3.
- `IntelligenceTaskService.create(input)` owns a unique `(project_id, idempotency_key, request_hash)` record and delegates exactly once to the existing Studio job service.
- `IntelligenceTaskService.events(taskId, cursor)` maps Studio event rows to `TaskEvent` with a durable cursor and never fabricates progress after a missing row.

- [ ] **Step 1: Write RED service and migration tests.**

Use a fake Studio executor to prove first create inserts one task and calls the executor once; replay with the same hash returns the same IDs; replay with a different hash returns `INTELLIGENCE_IDEMPOTENCY_MISMATCH`; a cross-project lookup returns not found; cursor pages are monotonic; a provider secret or object key never appears in a task event.

- [ ] **Step 2: Run the RED tests.**

Run:

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/task-service.test.ts
pnpm --filter @kortix/db exec bun test scripts/intelligence-task-migration.integration.test.ts
```

Expected: the service, table, and repository methods are absent.

- [ ] **Step 3: Add the additive migration.**

Create `intelligence_tasks` with account/project ownership, `task_id`, optional `job_id`, actor fields, capability/version, request hash, idempotency key, status, card hash, created/updated timestamps, and a unique project/idempotency index. Create `intelligence_task_events` with task ownership, monotonic sequence, public event type/payload, and a unique `(task_id, sequence)` index. Do not alter historical Studio migrations.

- [ ] **Step 4: Implement the service and repository.**

Insert the task and call the existing Studio service in one transaction boundary that can safely replay. Store only redacted public task metadata. Map existing Studio events (`queued`, `progress`, `asset-created`, terminal states, billing settlement) to versioned TaskEvent types; preserve the original Studio cursor as an internal reference, not as a public secret. Wire this production executor into `buildStudioApiRuntime` so Task 3's 503 path is replaced only after the database-backed service is ready.

- [ ] **Step 5: Run GREEN database/API gates.**

```powershell
pnpm --filter @kortix/db test
pnpm --filter @kortix/db typecheck
pnpm --filter @kortix/db exec bun test scripts/intelligence-task-migration.integration.test.ts
pnpm --filter kortix-api exec bun test src/intelligence/task-service.test.ts src/intelligence/project-routes.test.ts
pnpm --filter kortix-api typecheck
```

Expected: real PostgreSQL migration coverage passes with zero cross-project reads and exactly one Studio job for an idempotent create.

- [ ] **Step 6: Commit.**

```powershell
git add apps/api/src/intelligence apps/api/src/studio/default-routes.ts packages/db/migrations/20260718140000000_intelligence_task_bridge.sql packages/db/src/schema/kortix.ts packages/db/src/schema/index.ts packages/db/scripts/intelligence-task-migration.integration.test.ts packages/api-contract/src/intelligence.ts
git commit -m "feat: add durable intelligence task bridge"
```

---

### Task 7: Add the Minimal A2A-Compatible Card and Task Adapter

**Files:**
- Create: `apps/api/src/intelligence/a2a.ts`
- Create: `apps/api/src/intelligence/a2a.test.ts`
- Modify: `apps/api/src/intelligence/project-routes.ts`
- Modify: `apps/api/src/intelligence/project-routes.test.ts`
- Modify: `packages/api-contract/src/intelligence.ts`

**Interfaces:**
- `serializeAgentCard(card): Response` returns an A2A-compatible JSON card with `application/a2a+json` and no credentials.
- `parseA2ATaskRequest(body): { request: IntelligenceCreateTaskRequest; senderCardHash: string }` accepts only supported `intelligence.v1` task fields and rejects unknown capabilities.
- `createA2ATaskAdapter(service)` maps a validated A2A task to `IntelligenceTaskService.create` and maps events back to the public A2A task state.
- `AgentTrustSource.isTrusted({ projectId, cardHash }): Promise<boolean>` is injected; the default implementation trusts only the request's local project Agent grant and otherwise returns false.

- [ ] **Step 1: Write RED protocol tests.**

Test content type, card hash stability, malformed task rejection, unsupported capability rejection, replay protection, expired deadline, missing project trust, and redacted error mapping. Include an A2A `application/a2a+json` request fixture based on the verified `v1.0.1` HTTP binding.

- [ ] **Step 2: Run the RED tests.**

Run `pnpm --filter kortix-api exec bun test src/intelligence/a2a.test.ts src/intelligence/project-routes.test.ts`. Expected: adapter exports and routes are absent.

- [ ] **Step 3: Implement the adapter.**

Keep the project-scoped API route behind existing combined auth. Permit the local project Agent grant and ask the injected `AgentTrustSource` for every external `card_hash`; the default source rejects it. Do not add an unauthenticated global `/.well-known` route in this slice.

- [ ] **Step 4: Run GREEN protocol gates.**

```powershell
pnpm --filter @kortix/api-contract test
pnpm --filter kortix-api exec bun test src/intelligence/a2a.test.ts src/intelligence/project-routes.test.ts
pnpm --filter kortix-api typecheck
```

- [ ] **Step 5: Commit.**

```powershell
git add apps/api/src/intelligence/a2a.ts apps/api/src/intelligence/a2a.test.ts apps/api/src/intelligence/project-routes.ts apps/api/src/intelligence/project-routes.test.ts packages/api-contract/src/intelligence.ts
git commit -m "feat: add project-scoped a2a task adapter"
```

---

### Task 8: Add Contract, MCP, A2A, IAM, and Regression Acceptance Gates

**Files:**
- Create: `apps/api/src/__tests__/e2e-intelligence-protocol.test.ts`
- Create: `apps/cli/src/__tests__/e2e-intelligence-mcp.test.ts`
- Modify: `tests/spec/end-to-end.md`
- Modify: `scripts/ci-local.sh`
- Modify: `.github/workflows/package-tests.yml`
- Modify: `.github/workflows/ci.yml` only where the existing package dependency closure requires the new package
- Create: `docs/operations/intelligence-fabric.md`

**Interfaces:**
- Produces a recorded local acceptance flow from capability discovery through one image task, event cursor replay, asset ID return, and terminal settlement.
- Does not enable production Studio and preserves the permanent exclusion of first-party video, voice, 3D, digital-human, and batch-remix products.

- [ ] **Step 1: Write the end-to-end RED fixtures.**

Drive a fake provider task through API, MCP stdio, and A2A adapter faces. Assert one task row, one Studio job row, one provider submission, monotonic events, replayed idempotency, cross-tenant denial, revoked-agent denial before provider I/O, and redaction scan across every response/error.

- [ ] **Step 2: Run the RED fixtures.**

Run `pnpm --filter kortix-api exec bun test src/__tests__/e2e-intelligence-protocol.test.ts` and `pnpm --filter @kortix/cli test -- src/__tests__/e2e-intelligence-mcp.test.ts`. Expected: fixtures fail until all prior adapters are wired.

- [ ] **Step 3: Implement CI discovery and operations documentation.**

Add the new package and intelligence test paths to the existing dependency closures. Document the exact environment prerequisites, the disabled production boundary, the redaction invariants, the local fake-provider flow, and the commands below. Do not add secrets or signed URLs to the document.

- [ ] **Step 4: Run the complete protocol-slice gate.**

```powershell
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/intelligence-contracts typecheck
pnpm --filter @kortix/registry test
pnpm --filter @kortix/registry typecheck
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter @kortix/db test
pnpm --filter @kortix/db typecheck
pnpm --filter kortix-api exec bun test src/intelligence src/studio/default-routes.test.ts src/__tests__/e2e-intelligence-protocol.test.ts src/__tests__/e2e-studio-production-api.test.ts
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/cli test
pnpm --filter @kortix/cli typecheck
git diff --check
```

Expected: all listed gates pass; the production-disable boundary remains true and the future-media search has no executable routes or capability descriptors.

Run the explicit future-media boundary scan:

```powershell
rg "video.generate|voice.dialogue|voice.synthesize|voice.transcribe|model3d.generate|model3d.process|avatar.render|video.batch_mix|digital-human|batch-remix" apps packages tests -g "!**/node_modules/**"
```

Expected: matches are limited to specifications, tests asserting absence, or explicit non-goal comments; no route, seed row, navigation item, or executable capability is present.

- [ ] **Step 5: Commit the acceptance gate.**

```powershell
git add apps/api/src/__tests__/e2e-intelligence-protocol.test.ts apps/cli/src/__tests__/e2e-intelligence-mcp.test.ts tests/spec/end-to-end.md scripts/ci-local.sh .github/workflows/package-tests.yml .github/workflows/ci.yml docs/operations/intelligence-fabric.md
git commit -m "test: gate intelligence protocol slice"
```

---

## Spec Coverage Matrix

| Design requirement | This plan | Evidence task or follow-on plan |
|---|---|---|
| Existing Studio telemetry reaches injected sinks | Included | Task 0 |
| Versioned capability, Agent Card, task, and event contracts | Included | Task 1 |
| Registry capability metadata and deterministic cards | Included | Task 2 |
| Project-scoped IAM-gated discovery and task routes | Included | Task 3 |
| Stable MCP discovery/call face | Included | Task 4 |
| Shared Web/mobile/Electron SDK surface | Included | Task 5 |
| Durable one-Studio-job task bridge and cursor | Included | Task 6 |
| A2A-compatible card and task mapping | Included | Task 7 |
| Protocol, IAM, redaction, and production-disable acceptance | Included | Task 8 |
| Multi-node workflow graph and deterministic model evaluation/routing | Deliberately separate | `2026-07-18-intelligence-workflow-evaluation-plan.md` |
| C2PA-compatible signing and cross-media provenance | Deliberately separate | `2026-07-18-intelligence-provenance-plan.md` |
| Cosign/SBOM/trust-tier marketplace enforcement | Deliberately separate | `2026-07-18-developer-module-trust-plan.md` |
| Video, voice, 3D, digital human, batch remix, and finished pages | Cancelled product scope | `docs/specs/2026-07-20-multimedia-product-scope-cancellation.md` |

## Plan-Level Completion Checklist

- [ ] Task 0 telemetry injection is green and independently reviewed.
- [ ] Contract package is versioned, strict, side-effect-free, and consumed by API/SDK/CLI.
- [ ] Registry capability declarations and deterministic Agent Cards are redaction-safe.
- [ ] Project-scoped API routes reuse existing IAM and Studio service paths.
- [ ] MCP exposes only stable meta-tools; no provider catalog explosion occurs.
- [ ] SDK, CLI, and A2A adapters share the same task/event wire contract.
- [ ] Real PostgreSQL proves idempotency, project fencing, and one-job ownership.
- [ ] Protocol-slice E2E passes through API, MCP, and A2A faces.
- [ ] Follow-on plans are required before workflow evaluation, C2PA signing, or marketplace trust work begins. First-party multimedia production work remains cancelled.

## Review Gates

After every task, read the full diff, run the task-specific commands, run `git diff --check`, scan staged files for credentials/signed URLs/raw Provider bodies, and perform an independent review before starting the next task. A build pass is not a substitute for typecheck, contract, database, or protocol acceptance.
