# Remaining Work Acceleration Design

**Status:** Approved for implementation planning

**Date:** 2026-07-20

**Target branch:** `studio-platform`

## 1. Outcome

Complete the retained Kortix workbench scope faster without removing product capability, duplicating host systems, or making future Kortix upgrades materially harder.

The retained scope is:

- Image Studio, jobs, assets, and OpenAI-compatible image generation;
- governed multi-Agent workflows, approvals, evaluation, and model routing;
- web, mobile, and Electron clients;
- teams, IAM, Secrets, Connectors, billing, and audit reuse;
- Developer Center, module publishing, trust review, usage accounting, and revenue sharing;
- module trust, artifact provenance, and production operations.

First-party video, voice, 3D, digital-human, and batch-remix products remain cancelled under `docs/specs/2026-07-20-multimedia-product-scope-cancellation.md`. Their removal is not counted as an acceleration technique.

## 2. Current baseline

The repository already contains the expensive backend foundations:

- Studio contracts, durable schema, billing reservations, IAM checks, project API routes, worker ownership, provider recovery, S3-compatible storage, OpenAI-compatible image generation, telemetry, and required MinIO CI coverage;
- `intelligence.v1` capability discovery, task creation, event cursors, SDK bindings, MCP, and A2A mapping;
- governed workflow contracts, PostgreSQL persistence, approvals, Agent roles, image leaves, evaluation snapshots, deterministic routing, SDK/MCP/A2A surfaces, and an optional Temporal adapter;
- production feature flags that keep Studio and Intelligence workflows disabled until acceptance gates pass.

The main remaining gap is product composition. There is no first-party Web Image Studio or Assets surface, no Studio mobile route, no completed Electron flow, no Studio worker deployment, and no Developer Center runtime.

## 3. Selected acceleration approach

Use one contract freeze followed by independently reviewable vertical workstreams. Each workstream produces a usable result and integrates through existing Kortix boundaries.

The approach has four rules:

1. Reuse the current Intelligence and Studio backend services instead of designing a new orchestration or media backend.
2. Use `@kortix/sdk` as the only client package and `kortix.project(projectId).intelligence` as the canonical task/workflow entry point.
3. Add only thin projections for image assets, cancellation, and upload where the current Intelligence surface cannot yet express an existing Studio operation.
4. Keep every runtime extension disabled by default until its focused tests and shared acceptance gates pass.

This reduces elapsed time by allowing client, deployment, and module-platform work to proceed after the same contract freeze while preserving one source of truth for tasks, assets, permissions, billing, and events.

This umbrella design is not executed as one oversized implementation plan. Milestones 0-1, 2, 3, 4, and 5 each receive an independently reviewable plan and acceptance gate. The first implementation plan covers only Milestone 0 and Milestone 1: the contract/progress freeze and the usable Web Image Studio vertical slice.

## 4. Canonical contract decision

The existing Intelligence SDK supersedes the earlier unimplemented proposal for a second `kortix.project(projectId).studio` facade.

The canonical client surface is:

```text
kortix.project(projectId).intelligence.capabilities
kortix.project(projectId).intelligence.tasks
kortix.project(projectId).intelligence.workflows
@kortix/sdk/react useIntelligence* hooks
```

Image Studio uses these operations for discovery, submission, durable status, events, approvals, and workflow handoff. Missing asset upload/list/download/reuse and task cancellation operations are added as thin project-scoped Intelligence projections over the existing Studio services. They do not create new job, asset, billing, provider, or event tables.

All web, mobile, Electron, CLI, MCP, and A2A consumers use the same wire contracts. No client calls host-local Studio routes with ad hoc `fetch`.

## 5. Workstreams

### 5.1 Product workstream

Deliver the first complete user workflow:

```text
Image capability discovery
  -> prompt and image options
  -> optional reference upload
  -> cost estimate
  -> idempotent task submission
  -> durable task and Studio job progress
  -> generated asset grid
  -> preview, download, and reuse as reference
```

The Web Image Studio is an operational work surface rather than a marketing page. It includes permission, insufficient-credit, provider-unavailable, retryable failure, unknown-outcome, cancellation, empty, and reload-recovery states.

The Assets surface lists project-owned outputs and references, supports bounded filters, previews only validated media, and obtains downloads through short-lived signed URLs after IAM checks.

### 5.2 Production workstream

Package the existing API and Studio worker runtime for local compose and Kubernetes without moving worker ownership into API pods.

The workstream adds:

- a distinct Studio worker command and deployment using the existing API image dependency closure;
- private object-storage configuration and readiness checks;
- liveness, readiness, metrics, ServiceMonitor, and bounded alerts;
- audited billing-incident resolution through an internal API operation;
- required MinIO integration, protected live-provider smoke, and Alibaba Cloud OSS compatibility evidence.

Production values retain `STUDIO_ENABLED=false` and `INTELLIGENCE_WORKFLOWS_ENABLED=false` until full acceptance is recorded.

### 5.3 Client workstream

Expo mobile uses the same SDK with durable cursor polling. It supports prompt-only image task creation, job monitoring, suspension/resume, output preview, approval, and download. It does not reproduce a desktop editor.

Electron continues to wrap the web application. Its acceptance gate proves navigation, task creation, event updates, preview, and download through the same SDK path without Electron-only business logic.

### 5.4 Platform workstream

Developer Center reuses the existing Kortix project marketplace, IAM, Secrets, Connectors, sandbox, billing, audit, and review systems.

The platform workstream is delivered in this dependency order:

1. versioned module manifest and module-owned capability namespace;
2. local validation and preview;
3. sandbox execution and scoped tokens;
4. SBOM plus Cosign/Sigstore verification;
5. human review, trust tier, publication, installation, and rollback;
6. usage accounting, append-only revenue events, settlement, and dispute records;
7. C2PA-compatible asset provenance and signing through a separately approved key-management boundary.

Developer modules cannot claim first-party Studio routes, built-in provider ownership, or privileged host execution.

## 6. Dependency and integration model

The only blocking dependency shared by every workstream is the contract freeze in section 4.

After that freeze:

- Product and production work can progress independently because both consume existing service ports.
- Mobile and Electron begin when the product-facing SDK methods and query keys are stable; they do not wait for production enablement.
- Developer Center manifest and trust contracts can progress without waiting for Image Studio UI, but publication and revenue settlement wait for sandbox, IAM, billing, and audit integration gates.
- Integration occurs through small commits with focused tests; no workstream rewrites host-core ownership.

When work is executed concurrently, each write-heavy stream uses an isolated worktree and an integration branch. Shared contract files are owned by the contract stream until the freeze commit lands. Parallel changes do not edit the same shared file without explicit sequencing.

## 7. Upstream compatibility

Acceleration must not trade away future Kortix upgrades.

- New backend behavior stays in `apps/studio-worker`, `apps/api/src/studio`, `apps/api/src/intelligence`, `packages/studio-*`, and `packages/intelligence-*`.
- SDK changes extend the existing project handle and React export graph without a new package or subpath.
- Web and mobile routes use existing project navigation, feature-flag, query, IAM, and design-system patterns.
- Deployment uses additive worker templates and values; it does not fork the API chart or image build.
- Developer Center extends the current marketplace and Review Center rather than adding a second marketplace or approval system.
- Database migrations are additive and expand-first. Disabled features must not require configuration, external clients, or background processes.

An upstream-sync gate must cover extension path filters, public SDK snapshots, route manifests, migration compatibility, and production-default flags.

## 8. Error and recovery behavior

- Client retries reuse the same idempotency key and never create a second provider submission.
- Event cursor expiry returns a current snapshot plus a new cursor.
- Provider ambiguity remains an explicit unknown outcome; it is never blindly retried.
- Storage readiness fails before worker claims or billing reservations.
- Permission and token revocation fail before provider, storage, or signed-URL access.
- Billing incident resolution accepts evidence and a bounded decision, never caller-supplied credit amounts.
- Module install and upgrade failures leave the last accepted version active and auditable.

## 9. Verification strategy

Every behavior change follows a focused RED-GREEN cycle. Each workstream has independent gates and also contributes to a shared acceptance suite.

The shared gates are:

- API, worker, SDK, web, mobile, and Electron type checks and focused tests;
- SDK runtime and type public-surface snapshots;
- route-manifest regeneration;
- authenticated black-box image generation with fake and protected live providers;
- MinIO object-store conformance and gated Alibaba Cloud OSS compatibility;
- browser screenshots and DOM/request assertions at desktop and mobile viewports;
- worker readiness, metrics, alert, unknown-outcome, and billing-incident fixtures;
- module manifest, sandbox isolation, signature, SBOM, trust-tier, installation, rollback, metering, and settlement tests;
- scans proving cancelled first-party multimedia routes and capability IDs remain absent;
- `git diff --check` and credential/signed-URL/raw-provider-body scans before every commit.

No feature is described as production-ready until its protected environment gates have recorded evidence.

## 10. Milestones

### Milestone 0: Contract and progress freeze

- replace stale checklist state with a commit-backed progress ledger;
- declare the existing Intelligence SDK canonical;
- enumerate the exact missing image asset and cancellation projections;
- freeze shared request, response, query-key, route, and error contracts.

### Milestone 1: Usable Web Image Studio

- complete the SDK projections;
- ship Image Studio and Assets pages;
- pass browser, API, permission, billing, reload, cancellation, and asset reuse gates.

### Milestone 2: Deployable and observable runtime

- ship compose and Kubernetes worker deployment;
- ship metrics, ServiceMonitor, alerts, and billing-incident operation;
- pass MinIO and protected provider/storage gates.

### Milestone 3: Mobile and Electron parity

- ship the Expo Studio route and durable polling;
- pass Electron and mobile acceptance without client-specific backend logic.

### Milestone 4: Developer Center core

- ship module authoring, validation, sandbox preview, review, signing, publishing, installation, and rollback.

### Milestone 5: Trust, revenue, and provenance

- ship usage accounting, append-only revenue events, settlement, disputes, SBOM/trust enforcement, and C2PA-compatible provenance.

## 11. Acceptance criteria

The acceleration design is successful when:

1. every retained product capability maps to one milestone and no retained capability is silently removed;
2. Image Studio completes a real project-scoped generation and asset reuse flow on web, mobile, and Electron;
3. API pods never claim Studio jobs and clients never bypass the SDK;
4. production remains disabled until deployment, observability, live provider, storage, and rollback gates pass;
5. Developer Center modules use existing Kortix IAM, sandbox, marketplace, review, billing, and audit ownership;
6. public SDK and route changes remain additive and upstream-sync checks pass;
7. cancelled first-party multimedia products remain absent from runtime, navigation, seed data, and roadmap commitments.
