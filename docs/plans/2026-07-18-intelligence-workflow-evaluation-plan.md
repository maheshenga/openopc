# Kortix Intelligence Workflow and Evaluation Implementation Plan

**Goal:** Add a disabled-by-default, project-scoped durable workflow layer that coordinates planner, executor, reviewer, approval, image-task, deterministic routing, and offline evaluation through existing Kortix boundaries without enabling production Studio or future-media execution.

**Architecture:** Extend the side-effect-free Intelligence contracts, add a pure `@kortix/intelligence-orchestration` package, persist workflow state through an additive PostgreSQL adapter, and keep all leaf execution in the existing `IntelligenceTaskService`/Studio job path. Reuse Kortix IAM, Agent grants, Review Center, LLM gateway policy, Studio provider/pricing/storage, billing, SDK, MCP, A2A, and telemetry seams. Add Temporal only as an optional conformance-tested adapter after the PostgreSQL implementation is complete.

**Tech Stack:** TypeScript, Zod, Bun tests, pnpm workspaces, Hono, Drizzle/PostgreSQL, existing Studio object-store and telemetry ports, MCP `2025-11-25`, A2A `v1.0.1`, OpenTelemetry Semantic Conventions `v1.43.0`, and an optional pinned Temporal TypeScript adapter. No Agent framework or provider SDK is a core dependency.

**Design:** `docs/specs/2026-07-18-intelligence-workflow-evaluation-design.md`

## Global Constraints

- Do not use the `superpowers` skill family or its execution sub-skills.
- Preserve Kortix as the base. Keep new behavior extension-owned, additive, and disabled by default.
- Keep `STUDIO_ENABLED=false` in production values and add `INTELLIGENCE_WORKFLOWS_ENABLED=false` by default.
- First-party video, voice, audio, 3D, digital-human, and batch-remix finished-product pages are cancelled product scope. Do not add their executable routes, capability IDs, adapters, seed data, or navigation.
- Do not add provenance signing, Developer Center publication, revenue sharing, or arbitrary module code in this plan.
- Do not add a global `/.well-known` route or a second Agent/IAM/approval/billing/marketplace system.
- Do not modify Studio worker lease, provider, storage, recovery, reservation, settlement, or unknown-outcome ownership.
- Workflow executor leaves call `IntelligenceTaskService`; no workflow module inserts an Intelligence task or Studio job directly.
- Workflow tables store hashes and opaque private payload references, never raw prompts, credentials, authorization headers, signed URLs, Provider URLs, raw Provider bodies, or decrypted Secrets.
- Public events, responses, Review Center projections, logs, traces, and metrics are redaction-safe and bounded.
- All wire schemas are strict and versioned. Unknown versions and unknown keys fail closed.
- Every task starts with one focused failing test, ends with focused tests plus typecheck, receives a full diff/security review, and is committed independently.
- Do not install Temporal, LangGraph, OpenAI Agents, or another external orchestration dependency until its dedicated task verifies the official release, lockfile, license, and conformance boundary.
- Historical unrelated lint/platform failures are recorded, not reformatted or hidden.

## Fixed Initial Limits

- 128 nodes per run.
- 256 dependencies per run.
- graph depth 16.
- fan-out 16.
- one active node lease.
- one linked Intelligence task per capability node.
- one primary route and at most one fallback.
- image capability `studio.image.generate@1.0.0` only.
- bounded event pages, planner proposals, review summaries, and payload objects.

---

## Task 1: Add Workflow Wire Contracts and Pure Orchestration Package

**Files:**
- Modify: `packages/intelligence-contracts/src/schemas.ts`
- Modify: `packages/intelligence-contracts/src/schemas.test.ts`
- Modify: `packages/intelligence-contracts/src/compatibility.ts`
- Modify: `packages/intelligence-contracts/src/compatibility.test.ts`
- Modify: `packages/intelligence-contracts/src/index.ts`
- Create: `packages/intelligence-orchestration/package.json`
- Create: `packages/intelligence-orchestration/tsconfig.json`
- Create: `packages/intelligence-orchestration/tsconfig.build.json`
- Create: `packages/intelligence-orchestration/src/index.ts`
- Create: `packages/intelligence-orchestration/src/contracts.ts`
- Create: `packages/intelligence-orchestration/src/state.ts`
- Create: `packages/intelligence-orchestration/src/graph.ts`
- Create: `packages/intelligence-orchestration/src/conformance.ts`
- Create focused tests beside each module
- Modify workspace consumers and `pnpm-lock.yaml` only as required

**Produces:**
- `intelligence.workflow.v1` schemas for run, node, dependency, approval, event, planner proposal, and reviewer verdict.
- `WorkflowPort`, `WorkflowPayloadStore`, `WorkflowRouteSource`, `WorkflowEvaluationSource`, and adapter-conformance types.
- Pure state transitions, graph limits, cycle detection, topological ordering, canonical hashes, stable errors, and in-memory fixtures.

- [ ] **Step 1: Write RED contract tests.**

Cover strict valid envelopes, unknown versions/keys, malformed IDs/hashes/cursors, unsupported capability/media, illegal status transitions, cycle/self-edge detection, depth/fan-out limits, deterministic ordering, and terminal monotonicity.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/intelligence-orchestration test
```

Expected: workflow exports/package are missing.

- [ ] **Step 3: Implement the smallest pure contracts and rules.**

No Hono, Drizzle, filesystem, network, process environment, provider SDK, or application import is allowed. Use fixed limits and stable reason/error codes from the design.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/intelligence-contracts typecheck
pnpm --filter @kortix/intelligence-orchestration test
pnpm --filter @kortix/intelligence-orchestration typecheck
pnpm --filter @kortix/api-contract typecheck
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/cli typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: add intelligence workflow contracts`

---

## Task 2: Add the Durable Workflow Schema

**Files:**
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/schema/kortix.test.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/migrations/20260718150000000_intelligence_workflows.sql`
- Modify migration integrity tests/fixtures as required

**Tables:**
- `intelligence_workflow_runs`
- `intelligence_workflow_nodes`
- `intelligence_workflow_dependencies`
- `intelligence_workflow_approvals`
- `intelligence_workflow_events`
- `intelligence_workflow_payloads`

- [ ] **Step 1: Write RED schema and migration tests.**

Assert project/account foreign keys, actor attribution, project idempotency, run/node status checks, graph version, node key uniqueness, same-run dependency identity, task attachment uniqueness, leases, event sequence uniqueness, payload hash/ref metadata, service-role-only grants, and image-only capability checks.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter @kortix/db exec bun test src/schema/kortix.test.ts
pnpm --filter @kortix/db migrate:lint
```

- [ ] **Step 3: Implement expand-first Drizzle schema and SQL.**

Do not alter existing task/job tables. Use database timestamps for leases and indexes for project listing, ready-node claims, parent/dependency traversal, approval lookup, and event cursor reads.

- [ ] **Step 4: Run GREEN and a real migration gate.**

```powershell
pnpm --filter @kortix/db test
pnpm --filter @kortix/db typecheck
pnpm --filter @kortix/db migrate:lint
pnpm --filter @kortix/tests test tests/migration
git diff --check
```

Real PostgreSQL evidence must prove the migration applies and rolls forward without rewriting existing Intelligence/Studio rows.

- [ ] **Step 5: Commit.**

`feat: add durable intelligence workflow schema`

---

## Task 3: Implement the PostgreSQL WorkflowPort Adapter

**Files:**
- Create: `apps/api/src/intelligence/workflows/postgres-store.ts`
- Create: `apps/api/src/intelligence/workflows/postgres-store.test.ts`
- Create: `apps/api/src/intelligence/workflows/postgres.integration.test.ts`
- Create: `apps/api/src/intelligence/workflows/memory-store.ts`
- Create: `apps/api/src/intelligence/workflows/store-conformance.test.ts`

**Produces:** A project-fenced `WorkflowPort` adapter using transactions, optimistic graph versions, recursive cycle checks, `FOR UPDATE SKIP LOCKED`, bounded leases, conditional task attachment, and monotonic events.

- [ ] **Step 1: Write RED adapter conformance tests.**

Run the same cases against memory and PostgreSQL adapters: idempotent run/node creation, mismatched replay conflict, opaque cross-project reads, concurrent edge insertion, cycle rejection, deterministic ready order, lease expiry/reclaim, one task attachment, terminal monotonicity, and cursor pagination.

- [ ] **Step 2: Prove real concurrency RED.**

Two database connections must race run creation, graph mutation, ready-node claim, and task attachment. The test must fail before the adapter exists and must not use an in-process mutex as evidence.

- [ ] **Step 3: Implement minimal transactional SQL/Drizzle operations.**

Every structural mutation locks the run and compares `expectedGraphVersion`. Foreign projects return null/not-found without revealing ownership.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows/store-conformance.test.ts src/intelligence/workflows/postgres-store.test.ts
$env:RUN_INTEGRATION_TESTS = '1'
pnpm --filter kortix-api exec bun test src/intelligence/workflows/postgres.integration.test.ts
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: add project-scoped workflow store`

---

## Task 4: Add Private Payload Sealing and Workflow Service

**Files:**
- Create: `apps/api/src/intelligence/workflows/payload-store.ts`
- Create: `apps/api/src/intelligence/workflows/payload-store.test.ts`
- Create: `apps/api/src/intelligence/workflows/service.ts`
- Create: `apps/api/src/intelligence/workflows/service.test.ts`
- Modify: `packages/intelligence-orchestration/src/conformance.ts`
- Reuse existing Studio object-store test fixtures

**Produces:** Application service methods corresponding to the full `WorkflowPort`, plus a private payload adapter over `StudioObjectStore`.

- [ ] **Step 1: Write RED service tests one behavior at a time.**

Cover start/append/dependency/seal, canonical hashes, payload write-before-transaction cleanup, project/Agent fences before payload read, public event redaction, resume/cancel, deadline, immutable task link, and no side effect after terminal state.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows/payload-store.test.ts src/intelligence/workflows/service.test.ts
```

- [ ] **Step 3: Implement the minimum service.**

Public DTOs never expose payload refs. Payload reads verify project/run/node/lease/hash before parsing the strict current schema. Maintenance removes bounded unreferenced objects without changing workflow history.

- [ ] **Step 4: Run GREEN plus storage regressions.**

```powershell
pnpm --filter @kortix/studio-runtime test
pnpm --filter @kortix/studio-adapters test
pnpm --filter kortix-api exec bun test src/intelligence/workflows src/studio/storage.test.ts
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: add intelligence workflow service`

---

## Task 5: Expose Disabled Project-Scoped Workflow Routes

**Files:**
- Modify: `packages/api-contract/src/intelligence.ts`
- Modify: `packages/api-contract/src/intelligence.test.ts`
- Create: `apps/api/src/intelligence/workflows/project-routes.ts`
- Create: `apps/api/src/intelligence/workflows/project-routes.test.ts`
- Create: `apps/api/src/intelligence/workflows/runtime.ts`
- Create: `apps/api/src/intelligence/workflows/runtime.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: the existing Intelligence route registration seam

**Routes:** Project-scoped start, get, cancel, event cursor, and trusted Agent graph commands. No global discovery route.

- [ ] **Step 1: Write RED contract/runtime/route tests.**

Prove default-disabled no construction, strict inputs, existing IAM leaves, agent-grant enforcement, card-hash trust, opaque 404, idempotent replay, graph-version conflict, bounded bodies, and stable redacted errors.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter @kortix/api-contract test src/intelligence.test.ts
pnpm --filter kortix-api exec bun test src/intelligence/workflows/project-routes.test.ts src/intelligence/workflows/runtime.test.ts
```

- [ ] **Step 3: Implement thin routes and runtime DI.**

Routes parse/authenticate/authorize and delegate. They do not contain graph SQL, model calls, payload reads, or scheduler loops.

- [ ] **Step 4: Run GREEN and existing Intelligence regressions.**

```powershell
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter kortix-api exec bun test src/intelligence
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: expose governed workflow routes`

---

## Task 6: Add Scheduler Leasing and the Existing Image-Task Leaf Bridge

**Files:**
- Create: `apps/api/src/intelligence/workflows/scheduler.ts`
- Create: `apps/api/src/intelligence/workflows/scheduler.test.ts`
- Create: `apps/api/src/intelligence/workflows/task-bridge.ts`
- Create: `apps/api/src/intelligence/workflows/task-bridge.test.ts`
- Modify: workflow runtime/shutdown tests
- Add a real PostgreSQL scheduler integration fixture

**Produces:** A bounded scheduler that claims ready nodes and delegates image leaves through `IntelligenceTaskService`.

- [ ] **Step 1: Write the crash/race RED matrix.**

Cover readiness before claim, authorization/card revalidation before payload/task side effects, lease loss before/after task creation, process restart, attached-task replay, terminal event reconciliation, cancellation, and graceful shutdown.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows/scheduler.test.ts src/intelligence/workflows/task-bridge.test.ts
```

- [ ] **Step 3: Implement the bounded scheduler and bridge.**

The bridge calls only the public service interface, uses workflow-derived idempotency/parent IDs, and accepts only discovered `studio.image.generate` targets. It never calls a Provider or billing function.

- [ ] **Step 4: Run GREEN with task/Studio gates.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows src/intelligence/task-service.test.ts src/studio/default-routes.test.ts
pnpm --filter @kortix/studio-worker test
pnpm --filter kortix-api typecheck
git diff --check
```

Assert one node, one Intelligence task, one Studio job, and at most one fake-provider submission under replay.

- [ ] **Step 5: Commit.**

`feat: execute workflow image leaves`

---

## Task 7: Project Workflow Approval into Review Center

**Files:**
- Create: `apps/api/src/intelligence/workflows/review-adapter.ts`
- Create: `apps/api/src/intelligence/workflows/review-adapter.test.ts`
- Modify: `apps/api/src/projects/review-adapters.ts`
- Modify: `apps/api/src/projects/review-items.ts`
- Modify focused route/SDK review tests as needed

**Produces:** Idempotent workflow approval projections and verdict reconciliation while the workflow approval table remains authoritative.

- [ ] **Step 1: Write RED approval tests.**

Cover one projection per approval, namespaced IDs/metadata, no raw prompt/payload ref, `project.review.submit` and `project.review.act`, human-only high-risk resolution, replay, conflicting verdict, foreign project, reviewer self-approval restriction, and inbox failure isolation.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows/review-adapter.test.ts src/projects/review-items.test.ts
```

- [ ] **Step 3: Implement the projection adapter and workflow decision callback.**

Do not change Review Center enums or make scheduler claims depend on the inbox read model.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows src/projects/review-items.test.ts src/__tests__/unit-review-adapters.test.ts
pnpm --filter @kortix/sdk test src/core/rest/projects-client/review.test.ts
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/sdk typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: bridge workflow approvals to review center`

---

## Task 8: Add Governed Planner, Executor, and Reviewer Agent Roles

**Files:**
- Create: `apps/api/src/intelligence/workflows/agents.ts`
- Create: `apps/api/src/intelligence/workflows/agents.test.ts`
- Create: `apps/api/src/intelligence/workflows/planner.ts`
- Create: `apps/api/src/intelligence/workflows/reviewer.ts`
- Create focused adapters around existing project Agent/session invocation seams
- Modify workflow runtime DI only

**Produces:** `PlannerPort`, executor input resolution, and `ReviewerPort` backed by installed Kortix Agents, with framework-neutral contracts.

- [ ] **Step 1: Write RED role tests.**

Prove installed/enabled Agent lookup, exact card-hash binding, role separation, bounded context, strict proposal/verdict parsing, capability/IAM validation after model output, no chain-of-thought requirement, no direct graph/task write, timeout/cancel propagation, and redacted stable errors.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows/agents.test.ts src/intelligence/workflows/planner.test.ts src/intelligence/workflows/reviewer.test.ts
```

- [ ] **Step 3: Implement adapters over existing Kortix Agent/session boundaries.**

No LangGraph/OpenAI Agents dependency is added. Model output is an untrusted proposal that the deterministic workflow service validates.

- [ ] **Step 4: Run GREEN plus Agent/session regressions.**

```powershell
pnpm --filter kortix-api exec bun test src/intelligence/workflows src/__tests__/unit-agent-config-v2.test.ts src/__tests__/e2e-project-session-contract.test.ts
pnpm --filter @kortix/sdk test
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: add governed workflow agent roles`

---

## Task 9: Add Versioned Golden-Set Evaluation Records

**Files:**
- Extend Intelligence contracts with suite/run/snapshot schemas
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/schema/kortix.test.ts`
- Create: `packages/db/migrations/20260718160000000_intelligence_evaluations.sql`
- Create: `apps/api/src/intelligence/evaluation/repository.ts`
- Create: `apps/api/src/intelligence/evaluation/scorers.ts`
- Create focused unit/integration tests

**Tables:**
- `intelligence_evaluation_suites`
- `intelligence_evaluation_runs`
- `intelligence_model_evaluation_snapshots`

- [ ] **Step 1: Write RED schema/scorer tests.**

Cover immutable published suite versions, dataset/scorer hashes, private refs, bounded samples, fixed-point aggregates, minimum sample/confidence metadata, explicit budget, image-only executable scorers, and rejection of raw prompt/asset/provider fields.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/db exec bun test src/schema/kortix.test.ts
pnpm --filter kortix-api exec bun test src/intelligence/evaluation
```

- [ ] **Step 3: Implement deterministic first scorers and repository.**

Initial scorers are schema/integrity/safety outcome plus latency, availability, failure, retry, cost, and human-review aggregates. No online LLM judge runs on production prompts.

- [ ] **Step 4: Run GREEN and real PostgreSQL migration tests.**

```powershell
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/db test
pnpm --filter @kortix/db typecheck
pnpm --filter kortix-api exec bun test src/intelligence/evaluation
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: add intelligence evaluation snapshots`

---

## Task 10: Add Explainable Deterministic Model Routing

**Files:**
- Create: `packages/intelligence-orchestration/src/routing.ts`
- Create: `packages/intelligence-orchestration/src/routing.test.ts`
- Create: `apps/api/src/intelligence/routing/candidate-source.ts`
- Create: `apps/api/src/intelligence/routing/candidate-source.test.ts`
- Create: `apps/api/src/intelligence/routing/decision-store.ts`
- Add route decision schema/table only if not included by the workflow migration
- Modify workflow service DI

**Produces:** Hard-filter-first candidate selection with fixed-point scores, immutable policy/evaluation snapshots, stable reason codes, and at most one fallback.

- [ ] **Step 1: Write RED routing matrices.**

Cover IAM/Agent policy, region, schema, safety, input/output, readiness, budget/deadline, evaluation thresholds, fixed-point score components, deterministic ties, one fallback, empty candidates, stale snapshot, and refusal of an LLM-forced unauthorized target.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter @kortix/intelligence-orchestration test src/routing.test.ts
pnpm --filter kortix-api exec bun test src/intelligence/routing
```

- [ ] **Step 3: Implement pure router and adapters.**

Text planning candidates consume the existing LLM gateway/project routing sources. Image candidates consume Studio capability/provider/pricing sources. Do not create a parallel Provider catalog.

- [ ] **Step 4: Run GREEN plus routing/Studio regressions.**

```powershell
pnpm --filter @kortix/intelligence-orchestration test
pnpm --filter @kortix/intelligence-orchestration typecheck
pnpm --filter kortix-api exec bun test src/intelligence/routing src/llm-gateway/routing src/studio
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: route intelligence models deterministically`

---

## Task 11: Add Shared SDK, MCP Meta-Tools, and A2A Workflow Mapping

**Files:**
- Extend `packages/sdk/src/core/rest/projects-client/intelligence.ts`
- Extend `packages/sdk/src/react/intelligence.ts`
- Modify SDK public exports/snapshots/progress
- Modify: `apps/cli/src/executor/mcp.ts`
- Add focused CLI client/MCP tests
- Create: `apps/api/src/intelligence/workflows/a2a.ts`
- Add A2A route/adapter tests

**Produces:** One shared workflow wire contract for web/mobile/Electron, stable MCP meta-tools, and project-scoped A2A context/task mapping.

- [ ] **Step 1: Write RED SDK/CLI/A2A tests.**

Cover start/read/cancel/events/approval, query invalidation, opaque cursors, MCP revision negotiation, stable meta-tool list, strict arguments, idempotent replay, Agent trust, A2A parent/context IDs, terminal mapping, and redaction.

- [ ] **Step 2: Run RED.**

```powershell
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/cli test src/__tests__/executor-intelligence-mcp.test.ts
pnpm --filter kortix-api exec bun test src/intelligence/workflows/a2a.test.ts
```

- [ ] **Step 3: Implement thin clients/adapters.**

Do not add tools per Agent/node/model/Provider, do not add global discovery, and do not duplicate the workflow service.

- [ ] **Step 4: Run GREEN.**

```powershell
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/cli test
pnpm --filter @kortix/cli typecheck
pnpm --filter kortix-api exec bun test src/intelligence
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: expose intelligence workflows to agents`

---

## Task 12: Add the Optional Temporal Adapter

**Precondition:** Official release, license, Node/Bun compatibility, lockfile, and local test-server availability are reverified at execution time. If verification fails, stop this task without changing the core runtime.

**Files:**
- Create: `packages/intelligence-temporal-adapter/package.json`
- Create: `packages/intelligence-temporal-adapter/src/index.ts`
- Create: `packages/intelligence-temporal-adapter/src/workflow.ts`
- Create: `packages/intelligence-temporal-adapter/src/activities.ts`
- Create conformance and test-server integration tests
- Modify workflow runtime DI behind a separate disabled adapter selection

**Produces:** A Temporal coordinator that calls project-scoped Kortix workflow commands/activities and passes the shared conformance suite. It owns no Studio, billing, asset, credential, or Provider table.

- [ ] **Step 1: Record the verified dependency decision.**

Pin the exact release and license. Document why it is compatible with the current MCP/A2A/OTel baseline and how it is removed without changing persisted Kortix contracts.

- [ ] **Step 2: Write RED adapter conformance tests.**

Cover deterministic workflow code, retry/timeouts, cancellation, signals for approval, activity idempotency, project fencing, replay, and task attachment. Ban network/database/provider calls from deterministic workflow code.

- [ ] **Step 3: Implement the minimal adapter.**

Activities call Kortix service ports. No activity writes Studio/billing tables directly. The PostgreSQL adapter remains the default and production selection remains disabled.

- [ ] **Step 4: Run GREEN with a pinned local Temporal test server.**

```powershell
pnpm --filter @kortix/intelligence-temporal-adapter test
pnpm --filter @kortix/intelligence-temporal-adapter typecheck
pnpm --filter @kortix/intelligence-orchestration test
pnpm --filter kortix-api typecheck
git diff --check
```

- [ ] **Step 5: Commit.**

`feat: add optional temporal workflow adapter`

---

## Task 13: Add Phase 2 Acceptance, Telemetry, CI, and Operations Gates

**Files:**
- Create API workflow acceptance fixture
- Create real MCP stdio workflow acceptance fixture
- Add PostgreSQL concurrency/restart fixture
- Add telemetry sink tests in API/workflow runtime
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/package-tests.yml`
- Modify: `scripts/ci-local.sh`
- Modify: `tests/spec/end-to-end.md`
- Create: `docs/operations/intelligence-workflows.md`

**Acceptance flow:** One planner proposal creates an image-only DAG, one executor leaf creates one task/job, one reviewer/human approval pauses/resumes it, events remain monotonic, route/evaluation versions are recorded, replay is idempotent, a foreign project gets 404, revocation blocks before side effects, and all public surfaces are redaction-scanned.

- [ ] **Step 1: Write RED end-to-end fixtures.**

Run real project routes, workflow service/store, Review Center projection, scheduler, Intelligence task bridge, fake Provider, SDK/MCP/A2A adapters, and injected telemetry. Do not require decrypted production secrets.

- [ ] **Step 2: Run RED and verify the failure is missing integration/gating.**

- [ ] **Step 3: Add telemetry and CI/operations wiring.**

Metrics use low-cardinality labels. Traces follow W3C context and approved OpenTelemetry GenAI attributes; prompts/responses/tenant IDs/object refs/URLs/errors are not exported. CI path closure includes orchestration/contracts/db/API/SDK/CLI and optional Temporal adapter paths.

- [ ] **Step 4: Run the complete Phase 2 gate.**

```powershell
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/intelligence-contracts typecheck
pnpm --filter @kortix/intelligence-orchestration test
pnpm --filter @kortix/intelligence-orchestration typecheck
pnpm --filter @kortix/db test
pnpm --filter @kortix/db typecheck
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter kortix-api exec bun test src/intelligence src/studio/default-routes.test.ts
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/cli test
pnpm --filter @kortix/cli typecheck
pnpm --filter @kortix/intelligence-temporal-adapter --if-present test
pnpm --filter @kortix/intelligence-temporal-adapter --if-present typecheck
git diff --check
```

Also run real PostgreSQL, object-store, workflow-restart, scheduler-concurrency, and optional Temporal test-server gates in CI. A local unavailable service may be reported as an explicit skip; required GitHub gates may not silently skip.

- [ ] **Step 5: Run boundary scans.**

Fail on executable future-media capabilities, global Agent Cards, direct workflow-to-Provider/billing writes, secrets/URLs/raw Provider bodies, unbounded graph/tool catalogs, or production enablement.

- [ ] **Step 6: Commit.**

`test: gate intelligence workflow slice`

---

## Spec Coverage Matrix

| Design requirement | Evidence task |
|---|---|
| Versioned workflow/role/event contracts | Task 1 |
| Pure state machine and adapter conformance | Task 1 |
| Additive durable graph/approval/event schema | Task 2 |
| Project fencing, concurrency, leases, cursors | Task 3 |
| Private payload refs and application service | Task 4 |
| Disabled project-scoped API and existing IAM leaves | Task 5 |
| One workflow node to one Intelligence task/Studio job | Task 6 |
| Human approval through Review Center projection | Task 7 |
| Planner/executor/reviewer Agent roles | Task 8 |
| Immutable golden-set evaluation snapshots | Task 9 |
| Explainable deterministic routing and one fallback | Task 10 |
| SDK, MCP, and A2A compatibility | Task 11 |
| Optional Temporal adapter without ownership drift | Task 12 |
| Telemetry, redaction, CI, restart, and E2E gates | Task 13 |

## Plan-Level Completion Checklist

- [ ] Core contracts and orchestration package are side-effect-free and versioned.
- [ ] Real PostgreSQL proves graph idempotency, cycle prevention, leasing, fencing, and monotonic events.
- [ ] Workflow payloads are private, hashed, bounded, and never exposed publicly.
- [ ] Every image leaf uses the existing Intelligence task and Studio job/billing path.
- [ ] Planner, executor, and reviewer outputs are untrusted strict proposals/verdicts.
- [ ] High-risk approval is human-resolved through existing IAM and Review Center.
- [ ] Model routes are deterministic, explainable, snapshot-bound, and choose at most one fallback.
- [ ] Golden-set evaluation is offline, versioned, aggregate-only, and image-only in executable code.
- [ ] SDK, MCP, and A2A expose one shared project-scoped contract.
- [ ] Optional Temporal passes conformance and owns no Studio/billing/provider state.
- [ ] Existing Kortix/Studio/Intelligence tests remain green and production flags remain false.
- [ ] No future-media, global discovery, Developer Center execution, arbitrary code, credential, signed URL, or raw Provider response is introduced.

## Review Gates

After every task:

1. Read the complete diff and compare it to the task file map.
2. Run focused RED/GREEN evidence, package typecheck, and `git diff --check`.
3. Scan staged files and captured responses/logs/traces for credentials, authorization headers, Provider URLs, signed URLs, object refs, raw Provider bodies, prompts, and high-cardinality labels.
4. Run the explicit future-media/global-route/production-enable boundary scan.
5. Confirm existing public contracts are additive and unknown versions fail closed.
6. Commit only the reviewed task files with the planned isolated message.

A build pass is not a substitute for typecheck, real PostgreSQL concurrency, object-store conformance, protocol acceptance, or restart evidence.
