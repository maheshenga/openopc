# OpenOPC Milestone A Implementation Plan

**Goal:** Add a Web-first Capability Catalog and an additive AG-UI event stream over the existing Kortix Intelligence task/workflow contracts, so users can discover capabilities and see recoverable multi-Agent execution in real time without replacing any Kortix runtime.

**Architecture:** Keep `@kortix/sdk`, `CapabilityDescriptor`, `TaskEvent`, `WorkflowEvent`, `WorkflowPort`, IAM, and PostgreSQL as the sources of truth. Add a read-only `CapabilityCatalogPort` that composes existing project-scoped registries, then expose it through a project route and SDK hooks. Add a one-way AG-UI projector and a project-scoped SSE bridge that replays the existing durable event cursors; AG-UI is not stored in the database and does not enter the workflow state machine.

**Tech Stack:** TypeScript, Zod, Bun tests, Hono, existing `@kortix/sdk`, existing project IAM, SSE, OpenTelemetry trace context, and the AG-UI wire event names. No new Agent framework, scheduler, database, or provider SDK is added in this milestone.

**Design references:**

- `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`
- `docs/specs/2026-07-21-openopc-saas-foundation-design.md`
- `docs/plans/2026-07-18-intelligence-fabric-protocol-slice.md`

## Global Constraints

- Do not use the `superpowers` skill family or its execution sub-skills.
- Preserve Kortix as the base. Keep all behavior additive, extension-owned, and disabled by default where a new runtime path is introduced.
- `@kortix/sdk` remains the only product client. Web and Desktop must not call provider URLs or ad-hoc Intelligence routes directly.
- Do not modify `TaskEventSchema`, `WorkflowEventSchema`, database event rows, `WorkflowPort`, or the existing OpenCode `/global/event` stream to contain AG-UI names.
- First-party video, voice, 3D, digital-human, and batch-remix pages/capabilities remain cancelled product scope.
- Existing `GET .../intelligence/capabilities?include=execution_targets`, task routes, workflow routes, MCP meta-tools, A2A adapter, billing, IAM, and redaction behavior remain backward compatible.
- Catalog search returns only bounded, non-sensitive summaries and opaque references. Full input schemas are returned only by an authorized describe call.
- AG-UI output may contain stage summaries, tool/task identifiers, approval state, progress, asset IDs, and stable error codes; it must not contain prompts, payload refs, credentials, provider URLs, signed URLs, raw provider bodies, or chain-of-thought.
- AG-UI stream uses numeric durable event sequences for `id` and `Last-Event-ID`; REST cursor polling remains the authoritative fallback.
- No new dependency is required at runtime for AG-UI. The adapter must use the published AG-UI event names and remain structurally compatible with the current official core package.
- Every behavior change starts with focused RED tests, ends with focused tests and typecheck, and records any blocked full-suite/build gate honestly. Do not run the full repository suite.

---

### Task 1: Add the project-scoped Capability Catalog contract

**Files:**

- Create: `packages/intelligence-contracts/src/capability-catalog.ts`
- Modify: `packages/intelligence-contracts/src/index.ts`
- Modify: `packages/intelligence-contracts/src/schemas.test.ts`
- Create: `apps/api/src/intelligence/capability-catalog.ts`
- Create: `apps/api/src/intelligence/capability-catalog.test.ts`

**Interfaces:**

```ts
export interface CapabilityCatalogRef {
  readonly kind: 'capability' | 'tool' | 'module';
  readonly id: string;
  readonly version: string;
}

export interface CapabilityCatalogItem {
  readonly ref: CapabilityCatalogRef;
  readonly title: string;
  readonly summary: string;
  readonly risk: 'read' | 'write' | 'destructive';
  readonly availability: 'available' | 'requires_setup' | 'unavailable';
  readonly capability_id: string | null;
  readonly executable: boolean;
  readonly source: 'studio' | 'executor' | 'mcp' | 'module';
}

export interface CapabilityCatalogPort {
  search(input: {
    projectId: string;
    query: string;
    limit: number;
    cursor: number | null;
  }): Promise<{ items: CapabilityCatalogItem[]; next_cursor: number | null }>;
  describe(input: {
    projectId: string;
    ref: CapabilityCatalogRef;
  }): Promise<unknown | null>;
}
```

- [x] **Step 1: Write RED contract and port tests.**

  Assert strict parsing, bounded query/limit/cursor, stable reference format, no URLs/secrets in summaries, deterministic ordering, empty results, and tenant/project isolation. Assert that a malformed source entry is skipped rather than making the whole catalog fail.

- [x] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/schemas.test.ts
pnpm.cmd --filter kortix-api exec bun test src/intelligence/capability-catalog.test.ts
```

Expected: the catalog schemas, port, and adapter exports are absent.

- [x] **Step 3: Implement the minimal adapter.**

  Compose `createProjectCapabilityRegistry` and the existing normalized Executor/MCP discovery source. Keep the existing image capability descriptor and execution-target route unchanged. Search is case-insensitive token matching over title/summary/id, sorted by source priority then stable reference, with a hard maximum of 50 items. `describe` revalidates project/IAM scope and returns the complete schema only for an exact reference.

- [x] **Step 4: Run GREEN.**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/schemas.test.ts
pnpm.cmd --filter @kortix/intelligence-contracts typecheck
pnpm.cmd --filter kortix-api exec bun test src/intelligence/capability-catalog.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

- [x] **Step 5: Commit.**

```powershell
git add packages/intelligence-contracts/src/capability-catalog.ts packages/intelligence-contracts/src/index.ts packages/intelligence-contracts/src/schemas.test.ts apps/api/src/intelligence/capability-catalog.ts apps/api/src/intelligence/capability-catalog.test.ts
git commit -m "feat: add project capability catalog contract"
```

### Task 2: Expose the Catalog through API and SDK

**Files:**

- Modify: `packages/api-contract/src/intelligence.ts`
- Modify: `packages/api-contract/src/intelligence.test.ts`
- Modify: `apps/api/src/intelligence/project-routes.ts`
- Modify: `apps/api/src/intelligence/project-routes.test.ts`
- Modify: `apps/api/src/projects/routes/intelligence.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/intelligence.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/intelligence.test.ts`
- Modify: `packages/sdk/src/react/use-intelligence.ts`
- Modify: `packages/sdk/src/react/use-intelligence.test.tsx`

**Interfaces:**

- `GET /v1/projects/:projectId/intelligence/catalog?query=&cursor=&limit=` returns `{ protocol_version, items, next_cursor }`.
- `GET /v1/projects/:projectId/intelligence/catalog/describe?kind=&id=&version=` returns one strict catalog description.
- `searchIntelligenceCatalog(projectId, input)` and `describeIntelligenceCatalog(projectId, ref)` are additive REST client functions.
- `useIntelligenceCatalog(projectId, query, options)` uses a project/query/cursor key and never invalidates session/runtime caches.

- [ ] **Step 1: Write RED route and SDK tests.**

  Test exact paths and query encoding, default limit, malformed cursor/limit returning a stable 400, project IAM denial, opaque 404 for foreign references, deterministic `next_cursor`, legacy capabilities response unchanged, and React Query key isolation.

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter @kortix/api-contract exec bun test src/intelligence.test.ts
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence.test.ts src/react/use-intelligence.test.tsx
pnpm.cmd --filter kortix-api exec bun test src/intelligence/project-routes.test.ts
```

- [ ] **Step 3: Implement thin route/client/hook layers.**

  Routes perform only parse/auth/authorization and delegate to `CapabilityCatalogPort`. The SDK uses the existing `backendApi` and strict Zod parsers. The hook exposes loading/error/empty states to Web and Desktop without adding a new SDK subpath.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm.cmd --filter @kortix/api-contract exec bun test src/intelligence.test.ts
pnpm.cmd --filter @kortix/api-contract typecheck
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence.test.ts src/react/use-intelligence.test.tsx
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter kortix-api exec bun test src/intelligence/project-routes.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

```powershell
git add packages/api-contract/src/intelligence.ts packages/api-contract/src/intelligence.test.ts apps/api/src/intelligence/project-routes.ts apps/api/src/intelligence/project-routes.test.ts apps/api/src/projects/routes/intelligence.ts packages/sdk/src/core/rest/projects-client/intelligence.ts packages/sdk/src/core/rest/projects-client/intelligence.test.ts packages/sdk/src/react/use-intelligence.ts packages/sdk/src/react/use-intelligence.test.tsx
git commit -m "feat: expose intelligence capability catalog"
```

### Task 3: Add a pure AG-UI projection for task and workflow events

**Files:**

- Create: `packages/intelligence-contracts/src/ag-ui.ts`
- Create: `packages/intelligence-contracts/src/ag-ui.test.ts`
- Create: `apps/api/src/intelligence/ag-ui/projector.ts`
- Create: `apps/api/src/intelligence/ag-ui/projector.test.ts`
- Modify: `packages/intelligence-contracts/src/index.ts`

**Interfaces:**

```ts
export type OpenOpcAgUiEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string; input?: unknown }
  | { type: 'STEP_STARTED'; stepName: string }
  | { type: 'STEP_FINISHED'; stepName: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string }
  | { type: 'TOOL_CALL_RESULT'; toolCallId: string; content: string }
  | { type: 'STATE_SNAPSHOT'; snapshot: Record<string, unknown> }
  | { type: 'RUN_FINISHED'; result?: unknown }
  | { type: 'RUN_ERROR'; message: string; code?: string };

export function projectWorkflowEvent(event: WorkflowEvent): OpenOpcAgUiEvent[];
export function projectTaskEvent(event: TaskEvent): OpenOpcAgUiEvent[];
```

- [ ] **Step 1: Write RED mapping tests.**

  Cover run/node start and finish, route selection as a step/tool summary, approval as a state snapshot, task progress, asset-created results containing only asset IDs, success, failure, cancellation, monotonic sequence handling, and rejection of prompt/payload/provider/secret fields. Do not map internal reasoning events.

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/ag-ui.test.ts
pnpm.cmd --filter kortix-api exec bun test src/intelligence/ag-ui/projector.test.ts
```

- [ ] **Step 3: Implement the one-way projector.**

  Use the current official AG-UI event names and structural fields, but keep the local union in the contracts package so an upstream AG-UI package update cannot silently change Kortix wire contracts. Every event is bounded and redaction-safe; a workflow event may emit multiple UI events in deterministic order.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/ag-ui.test.ts
pnpm.cmd --filter @kortix/intelligence-contracts typecheck
pnpm.cmd --filter kortix-api exec bun test src/intelligence/ag-ui/projector.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

```powershell
git add packages/intelligence-contracts/src/ag-ui.ts packages/intelligence-contracts/src/ag-ui.test.ts packages/intelligence-contracts/src/index.ts apps/api/src/intelligence/ag-ui/projector.ts apps/api/src/intelligence/ag-ui/projector.test.ts
git commit -m "feat: project intelligence events to ag-ui"
```

### Task 4: Add the feature-gated project AG-UI SSE stream

**Files:**

- Create: `apps/api/src/intelligence/ag-ui/stream.ts`
- Create: `apps/api/src/intelligence/ag-ui/stream.test.ts`
- Modify: `apps/api/src/intelligence/workflows/project-routes.ts`
- Modify: `apps/api/src/projects/routes/intelligence.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/__tests__/e2e-intelligence-workflow.test.ts`

**Interfaces:**

- `GET /v1/projects/:projectId/intelligence/ag-ui/workflows/:runId/stream?cursor=<sequence>`.
- Accept `Last-Event-ID` as a numeric sequence when the query cursor is absent.
- Emit `text/event-stream` frames with `id`, `event` equal to the AG-UI `type`, and JSON `data`.
- Send a bounded keepalive comment every 15 seconds, poll the existing `WorkflowPort.readEvents` at a fixed 500ms cadence, stop on disconnect, and close after a terminal event plus one final flush.
- When `INTELLIGENCE_AG_UI_ENABLED` is false, return the stable disabled response and leave existing REST/polling routes unchanged.

- [ ] **Step 1: Write RED stream tests.**

  Test feature-off behavior, project/run IAM fences, query-vs-header cursor precedence, replay from a sequence, event IDs, content type, keepalive, terminal close, malformed cursor, disconnect cleanup, bounded poll count, and no raw private values in frames.

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter kortix-api exec bun test src/intelligence/ag-ui/stream.test.ts
```

- [ ] **Step 3: Implement the stream adapter.**

  Reuse the existing workflow route dependency injection and `WorkflowPort.readEvents`; do not query tables directly and do not modify the scheduler. The stream owns only connection lifecycle, cursor replay, projector invocation, keepalive, and bounded polling. Use `AbortSignal` cleanup and a per-process connection cap.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm.cmd --filter kortix-api exec bun test src/intelligence/ag-ui/stream.test.ts src/intelligence/workflows/project-routes.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

```powershell
git add apps/api/src/intelligence/ag-ui/stream.ts apps/api/src/intelligence/ag-ui/stream.test.ts apps/api/src/intelligence/workflows/project-routes.ts apps/api/src/projects/routes/intelligence.ts apps/api/src/config.ts apps/api/src/__tests__/e2e-intelligence-workflow.test.ts
git commit -m "feat: add gated intelligence ag-ui stream"
```

### Task 5: Add the SDK AG-UI subscription and fallback hook

**Files:**

- Create: `packages/sdk/src/core/stream/intelligence-ag-ui.ts`
- Create: `packages/sdk/src/core/stream/intelligence-ag-ui.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/intelligence.ts`
- Modify: `packages/sdk/src/react/use-intelligence.ts`
- Modify: `packages/sdk/src/react/use-intelligence.test.tsx`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/react/index.ts`
- Modify: `packages/sdk/package.json` only if an additive export entry is required

**Interfaces:**

```ts
export interface IntelligenceAgUiSubscription {
  close(): void;
}

export function subscribeIntelligenceAgUi(input: {
  projectId: string;
  runId: string;
  cursor?: number | null;
  onEvent(event: OpenOpcAgUiEvent): void;
  onError(error: Error): void;
  onClosed?(): void;
}): IntelligenceAgUiSubscription;
```

- [ ] **Step 1: Write RED SDK stream tests.**

  Use a fake `EventSource` or injected constructor to assert URL encoding, `Last-Event-ID` resume, event JSON parsing, invalid event rejection, reconnect backoff, explicit `close()`, and fallback callback behavior when the endpoint returns disabled/404. Assert that existing `openEventStream()` and `useSession()` are untouched.

- [ ] **Step 2: Run RED.**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test src/core/stream/intelligence-ag-ui.test.ts src/react/use-intelligence.test.tsx
```

- [ ] **Step 3: Implement the additive subscription.**

  Use the existing authenticated fetch/runtime URL helpers where available; keep the stream independent from the OpenCode sandbox SSE. On disabled/404, return a typed capability-unavailable error so the UI can fall back to `useIntelligenceWorkflowEvents` cursor polling.

- [ ] **Step 4: Run GREEN and public-surface gates.**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test src/core/stream/intelligence-ag-ui.test.ts src/react/use-intelligence.test.tsx
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk build:bundles
git diff --check
```

- [ ] **Step 5: Commit.**

```powershell
git add packages/sdk/src/core/stream/intelligence-ag-ui.ts packages/sdk/src/core/stream/intelligence-ag-ui.test.ts packages/sdk/src/core/rest/projects-client/intelligence.ts packages/sdk/src/react/use-intelligence.ts packages/sdk/src/react/use-intelligence.test.tsx packages/sdk/src/index.ts packages/sdk/src/react/index.ts packages/sdk/package.json
git commit -m "feat: add sdk intelligence ag-ui subscription"
```

### Task 6: Add focused protocol/UX acceptance and record the milestone

**Files:**

- Create: `apps/api/src/__tests__/e2e-intelligence-ag-ui.test.ts`
- Modify: `apps/cli/src/__tests__/e2e-intelligence-mcp.test.ts` only for catalog discovery assertions
- Modify: `docs/operations/intelligence-fabric.md`
- Modify: `docs/operations/studio-acceleration-progress.md`

- [ ] **Step 1: Write the focused acceptance fixture.**

  Drive one fake workflow from catalog search -> describe -> task/workflow creation -> AG-UI replay -> terminal event. Assert one project scope, stable event IDs, REST fallback, feature-off behavior, and redaction across every frame. Assert the existing MCP `tools/list` remains fixed meta-tools and does not expand to the whole catalog.

- [ ] **Step 2: Run the focused gate.**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/ag-ui.test.ts src/schemas.test.ts
pnpm.cmd --filter @kortix/api-contract exec bun test src/intelligence.test.ts
pnpm.cmd --filter kortix-api exec bun test src/intelligence/capability-catalog.test.ts src/intelligence/ag-ui src/intelligence/project-routes.test.ts src/__tests__/e2e-intelligence-ag-ui.test.ts
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence.test.ts src/core/stream/intelligence-ag-ui.test.ts src/react/use-intelligence.test.tsx
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 3: Update operations evidence.**

  Document the feature flag, SSE endpoint, event redaction rules, reconnect/fallback behavior, catalog query examples, and the exact focused commands. Do not mark production readiness or any cancelled multimedia capability complete.

- [ ] **Step 4: Commit the milestone record.**

```powershell
git add apps/api/src/__tests__/e2e-intelligence-ag-ui.test.ts apps/cli/src/__tests__/e2e-intelligence-mcp.test.ts docs/operations/intelligence-fabric.md docs/operations/studio-acceleration-progress.md
git commit -m "docs: record OpenOPC milestone A evidence"
```

## Scope Gaps Deliberately Deferred

- Native `/v1/responses` public API, background Responses jobs, computer-use tools, and provider-specific capability profiles remain a separate Gateway plan; the existing Chat-to-Responses adapter remains unchanged in this milestone.
- Gateway-to-API traceparent forwarding and full GenAI semantic attributes remain a separate focused Gateway plan.
- OCI/Cosign/SBOM module trust, Developer Center publication, revenue settlement, Temporal long-task adapter, LiveKit, Wan2.2, TRELLIS, and MemoryPort remain later milestones.
- No Web page is added for video, voice, 3D, digital human, or batch remix.

## Self-Review Checklist

- The existing `capabilities?include=execution_targets` route remains byte-compatible.
- Catalog search cannot execute a tool; execution still goes through the current task/Executor/IAM path.
- AG-UI is a projection, not a persistence format or orchestration engine.
- Numeric sequence cursors are used consistently across REST replay and SSE resume.
- Feature-off behavior preserves the current default-disabled workflow runtime.
- No raw prompt, secret, provider URL, signed URL, or reasoning text is present in public catalog/AG-UI data.
- All tasks have exact files and focused commands; no full-suite prerequisite is introduced.
