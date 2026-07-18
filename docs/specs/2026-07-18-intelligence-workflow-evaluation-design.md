# Kortix Intelligence Workflow and Evaluation Design

**Status:** Approved for a disabled, project-scoped implementation slice

**Date:** 2026-07-18

**Branch:** `studio-platform`

**Parent architecture:** `docs/specs/2026-07-18-intelligence-fabric-design.md`

**Consumes:** The completed `intelligence.v1` capability, Agent Card, task, event, MCP, A2A, SDK, IAM, Studio job, storage, billing, and telemetry slices.

## 1. Outcome

Phase 2 adds durable multi-Agent orchestration and explainable model evaluation without replacing Kortix projects, sessions, Agents, IAM, billing, Review Center, Studio jobs, or the Studio worker.

The first executable workflow remains image-only. A workflow may coordinate planner, executor, reviewer, and human-approval roles, but every image leaf still enters the existing project-scoped `IntelligenceTaskService` and creates at most one existing Studio job. The workflow layer never calls a Provider, resolves a credential, settles billing, or reads a private object directly.

The delivery provides:

- a versioned `WorkflowPort` with a PostgreSQL adapter and an in-memory conformance adapter;
- a durable acyclic workflow graph, monotonic public events, optimistic graph versions, leases, and idempotent commands;
- planner, executor, and reviewer role bindings to installed project Agents;
- deterministic model routing that records policy/evaluation versions and reason codes;
- versioned golden-set evaluation snapshots that contain aggregates and references, not raw prompts or assets;
- a Review Center projection for human approvals;
- stable SDK, MCP meta-tool, and project-scoped A2A faces;
- OpenTelemetry-compatible traces and low-cardinality metrics through existing injected sinks;
- a future Temporal adapter boundary that cannot own Studio or billing transactions.

## 2. Hard boundaries

- `STUDIO_ENABLED` remains false in production values until the existing deployment and acceptance gates pass.
- Add `INTELLIGENCE_WORKFLOWS_ENABLED`, default false. A disabled runtime must not create a database pool, object-store client, scheduler, telemetry exporter, or model client.
- Do not add video, voice, audio, 3D, digital-human, batch-remix, C2PA signing, Developer Center publication, revenue sharing, or arbitrary module execution.
- Do not add a global `/.well-known` route. Agent Cards and workflow APIs remain project-scoped.
- Do not change the current Studio worker lease, recovery, provider, storage, reservation, settlement, or unknown-outcome ownership.
- Do not make Temporal, LangGraph, an OpenAI Agents SDK, or another agent framework the source of truth for Kortix tasks, approvals, IAM, billing, or assets.
- Do not persist credentials, authorization headers, signed URLs, Provider URLs, raw Provider bodies, or decrypted Secret values in workflow state, events, traces, logs, or evaluation records.
- Do not copy a raw prompt into workflow tables. Persist only hashes and opaque private payload references; the existing leaf task/Studio path remains the execution record.
- All public payloads use strict, versioned Zod schemas. Unknown versions and unknown keys fail closed.

## 3. Existing seams to reuse

### 3.1 Intelligence task and event bridge

`IntelligenceTaskService` already provides:

- project/account fencing;
- actor, Agent, token, and session attribution;
- parent task linkage;
- project-scoped idempotency and request hashes;
- one Intelligence task to one Studio job ownership;
- monotonic public task events and opaque cursors;
- redaction of storage and Provider details.

Workflow executor nodes call this service. They do not insert `intelligence_tasks` or `studio_jobs` directly.

### 3.2 Studio runtime

The existing Studio API and worker retain ownership of:

- provider/model validation and immutable pricing;
- storage readiness and private object handling;
- job claim leases and retry policy;
- provider submission, polling, recovery, cancellation, and result staging;
- credit reservation, settlement, release, and platform-loss handling.

Workflow state follows task events and never tries to reproduce these state machines.

### 3.3 IAM and Agent grants

Phase 2 reuses existing leaves:

- `project.studio.jobs.read` for workflow/run/event reads;
- `project.studio.jobs.run` for start, append, dependency, resume, and executor scheduling;
- `project.studio.jobs.cancel` for cancellation;
- `project.studio.providers.use` for candidate discovery and route planning;
- `project.review.submit` for approval projection;
- `project.review.act` for a human decision.

Each leaf still passes through the existing agent-grant fold. The first slice adds no new IAM action namespace.

### 3.4 Review Center

Workflow approval records are the durable source of truth. They are projected into the existing Review Center as native `decision` or `batch` items with namespaced metadata. A Review Center verdict is translated back into one idempotent workflow decision. Review Center rows are never joined into scheduler claim queries and an inbox failure cannot corrupt workflow state.

### 3.5 Model gateway and project routing policies

Text-model planning calls reuse the existing LLM gateway, project routing policy, candidate catalog, and fallback engine. Image leaf routing reuses Studio provider definitions, project provider configuration, immutable pricing, and capability discovery. Phase 2 adds a normalized deterministic scoring layer above these sources instead of creating a second model gateway.

## 4. Selected architecture

### 4.1 PostgreSQL state machine first

The initial adapter stores workflow state in additive Kortix tables and performs every graph mutation in a transaction. This matches the existing operational model, keeps project/account fencing close to current data, and supports deterministic local/CI tests.

Temporal remains an optional future adapter behind the same `WorkflowPort` and conformance suite. A Temporal workflow may coordinate commands and timers, but all leaf execution must call Kortix APIs. Temporal may not write Studio jobs, reservations, assets, or provider handles directly.

### 4.2 Framework-neutral Agent roles

Planner, executor, and reviewer are role bindings, not framework objects. The default adapter invokes an installed Kortix Agent through existing session/executor boundaries. A future LangGraph, OpenAI Agents, or other adapter may implement `PlannerPort` or `ReviewerPort`, but it receives only a bounded context and returns a strict proposal/verdict. The deterministic workflow service performs final validation.

### 4.3 Deterministic policy before model judgment

An LLM may propose goals, nodes, dependencies, or candidate models. It cannot authorize itself, select an unavailable Provider, increase a budget, bypass an approval, or commit a route decision. All hard filters and the final route score are pure deterministic code.

## 5. Package and ownership boundaries

### 5.1 `@kortix/intelligence-contracts`

Extend the existing side-effect-free package with strict wire schemas for:

- workflow protocol version;
- run, node, dependency, approval, and event envelopes;
- planner proposals and reviewer verdicts;
- route candidates, decisions, reason codes, policy versions, and evaluation versions.

The package continues to import only Zod. It does not import applications, databases, model clients, object stores, filesystem APIs, or browser globals.

### 5.2 `@kortix/intelligence-orchestration`

Create a private workspace package containing:

- `WorkflowPort` and server-side adapter contracts;
- pure run/node state transitions;
- DAG limits, cycle detection, deterministic ready-node ordering, and route scoring;
- error and retry classifications;
- adapter conformance helpers;
- in-memory workflow, payload, and evaluation fixtures.

It may import `@kortix/intelligence-contracts` and pure standard-library helpers. It cannot import Hono, Drizzle, application modules, provider SDKs, process environment, network clients, or production telemetry exporters.

### 5.3 `@kortix/db`

Own additive schema definitions and migrations for workflow runs, nodes, dependencies, approvals, events, route decisions, evaluation suites, and immutable evaluation snapshots. Tables are private to `service_role`; no browser/client role receives direct access.

### 5.4 `apps/api`

Own:

- project-scoped routes and IAM checks;
- the PostgreSQL `WorkflowPort` adapter;
- private workflow payload sealing over the configured `StudioObjectStore`;
- the scheduler loop and task-event reconciliation;
- Agent/session, Review Center, Intelligence task, routing-source, and telemetry adapters;
- runtime enablement and shutdown.

The API never performs provider I/O and never exposes a payload object key.

### 5.5 `@kortix/api-contract`, SDK, and CLI

`@kortix/api-contract` composes public request/response schemas. The SDK exposes the same project-scoped workflow methods to web, mobile, Electron, and developers. The CLI adds a small stable MCP meta-tool face; it does not generate a tool for every workflow node, Agent, Provider, or model.

## 6. Domain model

### 6.1 Workflow run

A run contains:

- `runId`, `accountId`, and `projectId`;
- `protocolVersion = intelligence.workflow.v1`;
- actor/token/session/Agent attribution;
- project-scoped `idempotencyKey` and `requestHash`;
- `status`;
- monotonic `graphVersion`;
- `policySnapshotHash` and optional `evaluationVersion`;
- node/edge limits and a maximum approved credit ceiling;
- deadline, created, updated, and terminal timestamps.

Run statuses are:

`draft -> running -> waiting_approval -> running -> succeeded | failed | cancelled`

`draft` may also move directly to `cancelled`. Terminal runs never return to a non-terminal state.

### 6.2 Workflow node

A node contains:

- server UUID and client-stable `nodeKey`;
- role: `planner | executor | reviewer | system`;
- kind: `agent | capability | approval`;
- installed `agentName` and deterministic Agent Card hash when applicable;
- capability/version when applicable;
- opaque `inputRef`, canonical `inputHash`, and public-safe summary;
- policy/evaluation snapshots used for this node;
- optional linked Intelligence `taskId`;
- lease owner/expiry and attempt count;
- status, deadline, and timestamps.

Node statuses are:

`pending -> ready -> running -> waiting_approval -> running -> succeeded | failed | skipped | cancelled`

Only `ready` nodes may be claimed. A linked task is immutable once assigned.

### 6.3 Dependency

Dependencies are unique directed edges inside one run. The first version supports `on_success` and `on_completion`. Adding an edge:

- locks the run;
- requires the caller's expected graph version;
- verifies both nodes belong to the same project/run;
- rejects self-edges and cycles using a recursive query or the shared pure validator;
- increments graph version and emits one event.

### 6.4 Approval

An approval belongs to one run/node and includes a risk level, requested action summary, policy reason code, current status, review item reference, acting user, decision, feedback hash, and timestamps. Raw hidden reasoning and model chain-of-thought are never stored or requested.

### 6.5 Events

Workflow events are append-only and monotonically sequenced per run. Public payloads contain only IDs, statuses, bounded progress, stable reason/error codes, graph versions, route reason codes, evaluation versions, and asset IDs. Private object references, prompts, Provider diagnostics, credentials, and billing reservation identifiers are excluded.

## 7. `WorkflowPort`

The server-side port exposes:

- `startRun`
- `appendNode`
- `addDependency`
- `sealGraph`
- `claimReadyNode`
- `heartbeatNode`
- `attachTask`
- `completeNode`
- `failNode`
- `pauseForApproval`
- `resolveApproval`
- `resumeRun`
- `cancelRun`
- `getRun`
- `readEvents`

The parent architecture's original methods remain present; the additional claim, lease, seal, and terminal methods make crash recovery explicit. Every adapter must pass the same conformance suite.

`startRun`, `appendNode`, and approval resolution are idempotent. An idempotency replay with a different canonical hash returns a stable conflict. Read methods return `null` for a foreign project to preserve opaque 404 behavior.

## 8. Graph limits and scheduling

Initial hard limits:

- 128 nodes per run;
- 256 dependencies per run;
- depth 16;
- fan-out 16;
- one active lease per node;
- one linked Intelligence task per capability node;
- at most one model fallback;
- bounded public event pages and payload sizes.

The scheduler orders ready nodes by topological layer, then `nodeKey`, then UUID. It never uses randomness. Claims use `FOR UPDATE SKIP LOCKED` and a bounded lease. Before every external side effect, the worker revalidates the lease, project authorization, Agent trust/card hash, workflow status, node input hash, selected route, budget ceiling, and Studio capability readiness.

On crash, an expired lease makes the node claimable again. If a leaf task was already attached, replay reads that task and never creates another Studio job.

## 9. Planner, executor, and reviewer

### 9.1 Planner

`PlannerPort.plan` receives a bounded context containing project-safe capability descriptors, installed Agent names/card hashes, asset IDs, budget/deadline limits, and public evaluation summaries. It returns a strict graph proposal.

The planner does not receive credentials, Provider URLs, signed URLs, raw previous Provider bodies, unrestricted project files, or billing internals. Proposals exceeding limits or referencing unauthorized Agents/capabilities are rejected before persistence.

### 9.2 Executor

An executor Agent may resolve a node's private input reference and propose a leaf task request. The service re-parses the request, re-runs discovery/trust/IAM/routing checks, and calls `IntelligenceTaskService`. The executor cannot insert tasks/jobs or choose an undiscovered target.

### 9.3 Reviewer

`ReviewerPort.review` returns `approve | reject | changes_requested` plus bounded public reason codes and an optional private feedback reference. It cannot settle a human-required approval. A reviewer Agent cannot approve its own executor output when separation-of-duty policy is enabled.

### 9.4 Human approval

High-risk or policy-required nodes create a Review Center projection. Only a user with `project.review.act` may resolve it. Approval resumes exactly the paused node/run; rejection produces a stable terminal or replanning transition according to the immutable workflow policy snapshot.

## 10. Private workflow payloads

Raw node inputs are sealed behind `WorkflowPayloadStore`, initially adapted over the configured private `StudioObjectStore`.

The database stores an opaque reference, SHA-256 hash, byte length, content type, and retention state. Public responses never expose the reference. The object is written before the database command; a failed transaction leaves a bounded orphan that maintenance removes. Deletion is conditional and idempotent.

Payload reads occur only after project, run, node, lease, Agent, and hash validation. Payload contents are parsed with the strict current contract before use. Unknown versions fail closed.

## 11. Deterministic model routing

### 11.1 Candidate normalization

Candidate sources are normalized into:

- capability and schema version;
- Provider configuration and model IDs;
- region/data-residency class;
- safety/risk class;
- immutable price estimate;
- availability and latency aggregates;
- evaluation snapshot/version;
- project policy eligibility.

Provider URLs and credentials are never candidate fields.

### 11.2 Hard filters

Apply in order:

1. IAM and Agent grant.
2. Project allow/deny policy.
3. capability/schema compatibility.
4. data-region and safety policy.
5. input/output constraints.
6. storage/provider readiness.
7. remaining workflow budget and deadline.
8. minimum evaluation thresholds.

No scoring occurs until all hard filters pass.

### 11.3 Scoring

Use fixed-point integers and a versioned policy:

`quality + availability - latency - cost - risk_penalty`

Weights and normalization bounds belong to an immutable policy snapshot. Ties resolve by Provider definition ID, Provider configuration ID, then model ID. The router selects one primary and at most one fallback. It records candidate IDs, fixed-point component scores, policy/evaluation versions, and stable reason codes without recording prompts or Provider diagnostics.

## 12. Golden-set evaluation

An evaluation suite contains a version, capability/schema version, dataset manifest hash, private dataset reference, scorer versions, thresholds, and lifecycle status. Published suite versions are immutable.

Evaluation runs are isolated from production workflow runs and have explicit budgets. Initial scorers cover:

- schema and contract validity;
- output MIME/dimension/integrity checks;
- content-safety policy result;
- deterministic latency, availability, failure, retry, and cost aggregates;
- human review aggregates for image quality.

Audio, video, and 3D scorer schemas may be reserved in documentation but are not executable or registered in Phase 2.

A model evaluation snapshot stores aggregate values, sample counts, confidence metadata, scorer versions, and the suite version. Production route decisions reference only a published snapshot version. They do not run an online judge on the user's prompt.

## 13. Public protocol faces

### 13.1 REST and SDK

Project-scoped routes expose start/read/cancel/events and approval decisions. Internal graph mutation routes are available only to trusted project Agents and still pass IAM, card-hash, graph-version, and schema checks.

The SDK mirrors strict wire types for web, mobile, Electron, and developer clients. Event polling uses the existing opaque monotonic cursor convention; SSE may be added only through the existing bounded event-stream helper.

### 13.2 MCP

Add stable meta-tools such as `workflow_capabilities`, `workflow_start`, and `workflow_status`. Do not emit tools per Agent, node, model, or Provider. `workflow_start` accepts a strict bounded request; it never accepts raw credentials, URLs, environment variables, or arbitrary code.

### 13.3 A2A

A2A remains project-scoped. The workflow run is the context, child tasks retain parent task IDs, and terminal workflow states map to stable A2A states. External Agents cannot write the graph without project trust and normal IAM.

## 14. Transactions and recovery

- Run creation, graph mutation, state transition, and event append are atomic database transactions.
- Every mutation locks the run and compares `expectedGraphVersion` when structural state can change.
- Scheduler claims use bounded leases and database time for fencing.
- A task attachment is conditional on an empty `task_id`; replay with the same task is accepted and a different task conflicts.
- Terminal node/run transitions are monotonic.
- Cancellation stops future claims and delegates cancellation of an attached leaf to the existing task/Studio path.
- Approval decisions and Review Center projection reconciliation are idempotent.
- Payload-object and Review Center cleanup are maintenance projections; they cannot rewrite authoritative workflow history.

## 15. Observability

Reuse injected telemetry sinks. Add low-cardinality counters/histograms/gauges for run starts, node transitions, scheduler lag, lease expiry, approval wait, route reason, evaluation suite status, and adapter errors.

Trace workflow/run/node IDs through W3C trace context, but do not use them as metric labels. Map to OpenTelemetry GenAI semantic conventions where stable; keep Kortix-specific workflow attributes under `kortix.intelligence.*`. Never export prompts, responses, object references, tenant IDs, Provider URLs, credentials, or arbitrary error text.

## 16. Upgrade compatibility

- New packages and routes are additive and extension-owned.
- Existing Kortix project/session/Agent manifests remain valid without workflow fields.
- Existing Studio, MCP, A2A, and SDK methods keep their current wire contracts.
- Database migrations are expand-first and do not rewrite existing task/job rows.
- Runtime builders use optional dependency injection and disabled no-op defaults.
- Temporal and Agent-framework adapters pass conformance suites instead of changing core state.
- Protocol and policy versions are explicit; unknown versions fail closed.
- CI path filters include the new packages so upstream changes cannot silently bypass gates.

## 17. Rollout

1. Land pure contracts/state rules and conformance tests.
2. Land additive tables and a PostgreSQL adapter with real concurrency evidence.
3. Land disabled API routes, SDK, Review Center projection, and scheduler.
4. Land the existing Intelligence-task leaf bridge and image-only acceptance fixture.
5. Land deterministic routing and offline evaluation snapshots.
6. Land MCP/A2A faces and complete redaction/compatibility gates.
7. Keep production workflows disabled until deployment, migration, object-store, scheduler, and protected smoke gates pass.

## 18. Acceptance criteria

- Existing Studio, Intelligence, MCP, A2A, SDK, IAM, Review Center, LLM gateway, billing, and database suites remain green.
- Concurrent graph mutations cannot create duplicate nodes, duplicate task attachments, cycles, or non-monotonic events.
- A workflow with planner, executor, reviewer, and human approval survives process restart and lease expiry.
- One capability node creates one Intelligence task and one Studio job under replay.
- Foreign projects receive opaque 404 responses.
- Revoked Agents are denied before payload reads, task creation, Review Center writes, or model/provider I/O.
- Route decisions are reproducible from policy and evaluation snapshots and select at most one fallback.
- Public events, logs, metrics, traces, and review projections pass redaction scans.
- No future-media capability, global Agent Card, arbitrary module execution, or production enablement appears in the diff.

## 19. Technology baseline

The parent architecture records MCP `2025-11-25`, A2A `v1.0.1`, OpenTelemetry Semantic Conventions `v1.43.0`, and Temporal TypeScript `v1.20.3` as the 2026-07-18 reference baseline. These are compatibility references, not mandatory core dependencies. Before adding any external adapter, CI must verify the selected release, lockfile, license, protocol fixtures, and conformance results. An upstream release never changes a persisted Kortix workflow contract implicitly.
