# Kortix Studio Phase 1 Implementation Plan

**Status:** In progress; Tasks 1-8 complete, Task 9 amended 2026-07-16

**Date:** 2026-07-15

**Branch:** `studio-platform`

**Architecture sources:** `docs/specs/2026-07-15-kortix-studio-platform-design.md` and `docs/specs/2026-07-16-studio-production-provider-storage-design.md`

**Goal:** Ship the first usable Studio slice: shared Studio foundations, OpenAI-compatible `image.generate`, durable jobs/assets/billing/events, SDK bindings, Image Studio, mobile monitoring, Electron compatibility, Agent tools, deployment manifests, and black-box verification.

**Scope:** This plan implements Image Studio. First-party Video Studio, Voice Studio, 3D Studio, Alibaba digital human, and Alibaba batch remix are cancelled product scope. Developer Center, revenue sharing, arbitrary developer modules, and workflow DAG execution remain separate work.

**Execution rule:** Track this plan in `docs/specs` and execute it through normal repo tasks, tests, commits, and review gates. Do not move this work into any external planning workflow or alternate docs tree.

## Global Constraints

- Keep Kortix upgrade-friendly: prefer additive packages and thin integration points.
- Keep API routes project-scoped under `/v1/projects/:projectId/studio/*`.
- Reserve provider callbacks under `/v1/webhooks/studio/:provider`, but do not mount the route until a later callback-based provider requires it.
- Keep app consumers on the SDK: web, mobile, Electron, and Agent tools must not call Studio API routes through host-local raw `fetch`.
- Add SDK surface at `kortix.project(projectId).studio` and `@kortix/sdk/react`; do not create a new SDK subpath.
- Public job states are exactly `queued`, `running`, `succeeded`, `failed`, and `cancelled`.
- Phase 1 exposes only executable `image.generate`.
- No disabled tabs, seed rows, route links, or capability descriptors for the cancelled video, voice, 3D, digital-human, or batch-remix products. Developer Center and DAG workflows remain separate work.
- Use a separate `apps/studio-worker` process; API pods never claim Studio jobs.
- Use Postgres row leases and a Studio-owned parameterized `studio-maintenance` lease, not the API module-global `background-workers` leader singleton.
- Provider attempts commit a stable submission key before external I/O. Unknown submission outcomes reconcile or enter explicit unknown recovery; they are never blindly retried.
- Limit retries to three attempts with bounded jitter and `Retry-After` support.
- Reuse Kortix IAM, Secrets, Connectors, billing credits, audit patterns, projects, teams, Agent grants, SDK conventions, web shell, Expo app, and Electron wrapper.
- Use a private streaming object-store abstraction with an S3-compatible production driver, MinIO conformance, a gated Alibaba Cloud OSS compatibility smoke, and API/worker readiness probes.
- Preserve raw credential secrecy: provider keys never leave server-side resolution and are never stored in jobs, logs, clients, Agent payloads, or developer artifacts.

## File Map

Create:

- `packages/api-contract/src/studio/index.ts` - public Studio Zod contracts and fixtures.
- `packages/api-contract/src/studio/fixtures.ts` - stable contract fixtures for SDK/API tests.
- `packages/studio-runtime/package.json` - runtime package declaration.
- `packages/studio-runtime/src/index.ts` - exported runtime types and helpers.
- `packages/studio-runtime/src/state-machine.ts` - public job state transitions.
- `packages/studio-runtime/src/idempotency.ts` - canonical request hashing and idempotency checks.
- `packages/studio-runtime/src/provider.ts` - provider adapter interfaces, retry classification, and conformance helpers.
- `packages/studio-runtime/src/object-store.ts` - streaming object-store port and readiness contract.
- `packages/studio-runtime/src/leases.ts` - parameterized Postgres lease helper for Studio maintenance.
- `packages/studio-runtime/src/fake-provider.ts` - deterministic image provider for tests.
- `packages/studio-adapters/**` - concrete OpenAI-compatible and S3-compatible drivers, provider definitions, safe fetch, pricing parser, and runtime configuration.
- `apps/api/src/studio/index.ts` - project route app factory.
- `apps/api/src/studio/contracts.ts` - request parsing and contract glue.
- `apps/api/src/studio/repositories/*.ts` - repositories for jobs, attempts, events, assets, uploads, providers, and billing reservations.
- `apps/api/src/studio/services/*.ts` - service methods shared by routes and Agent tools.
- `apps/api/src/studio/providers/*.ts` - provider configuration, definition registry, and immutable pricing-catalog services.
- `apps/api/src/studio/storage/*.ts` - API upload/finalize/download services using the shared object-store driver.
- `apps/api/src/studio/credentials.ts` - server-only Studio credential resolver facade over existing Secret and Connector rules.
- `apps/api/src/studio/tools/*.ts` - governed Agent/MCP tool handlers.
- `apps/studio-worker/package.json` - worker workspace package.
- `apps/studio-worker/src/index.ts` - worker entrypoint.
- `apps/studio-worker/src/worker.ts` - claim, execute, reconcile, retry, cancel, and settle loop.
- `apps/studio-worker/src/maintenance.ts` - upload expiry, event compaction, reservation reconciliation, and lease ownership.
- `packages/sdk/src/core/rest/projects-client/studio/*.ts` - Studio REST transport and project facade.
- `packages/sdk/src/react/studio/*.ts` - React Query hooks and event helpers.
- `apps/web/src/features/studio/**` - Studio shell, Image Studio, Assets page, provider setup, and shared components.
- `apps/web/src/app/(app)/projects/[id]/studio/page.tsx` - redirect to Image Studio.
- `apps/web/src/app/(app)/projects/[id]/studio/image/page.tsx` - Image Studio route.
- `apps/web/src/app/(app)/projects/[id]/studio/assets/page.tsx` - Studio assets route.
- `apps/mobile/app/projects/[id]/studio.tsx` - mobile Studio job/asset route.
- `tests/src/flows/studio.flow.ts` - black-box Studio API flow.
- `tests/e2e/specs/studio-image.spec.ts` - browser Image Studio flow.
- `tests/migration/studio-reservations.test.ts` - migration and billing regression tests.

Modify:

- `pnpm-workspace.yaml` - include `packages/studio-runtime` and `apps/studio-worker`.
- `packages/api-contract/src/index.ts` - export Studio contracts.
- `packages/db/src/schema/kortix.ts` - add Studio tables and indexes.
- `packages/db/migrations/*` - add Studio migration and bounded `atomic_use_credits` body replacement.
- `apps/api/src/index.ts` - mount Studio account pricing and project routes.
- `apps/api/src/projects/index.ts` - mount project-scoped Studio subrouter.
- `apps/api/src/middleware/request-deadline.ts` - exempt Studio SSE and bounded long-poll routes.
- `apps/api/src/iam/actions.ts` - add Studio actions.
- `apps/api/src/iam/role-perms.ts` - grant Studio actions to existing roles.
- `apps/api/src/iam/engine-v2.ts` - verify resource dispatch for Studio actions.
- `apps/api/src/iam/agent-scope.ts` - enforce Studio action and Secret/Connector grant checks for Agent jobs.
- `apps/api/src/repositories/account-tokens.ts` - expose uncached lifecycle validation for worker use.
- `apps/api/src/billing/services/credits.ts` - reservation-aware credit operations.
- `apps/api/src/billing/services/account-state.ts` - additive `reserved` and `available` fields.
- `packages/sdk/src/core/rest/projects-client/index.ts` - attach `studio`.
- `packages/sdk/src/core/rest/projects-client/billing.ts` - expose additive account-state fields.
- `packages/sdk/src/react/index.ts` - export Studio React bindings through existing React export.
- `apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx` - add Image Studio and Assets navigation.
- `apps/web/src/features/workspace/project-layout/project-shell.tsx` - ensure Studio routes inherit project shell.
- `apps/desktop-electron/**` - verification only unless shell download behavior needs a narrow fix.
- `apps/api/Dockerfile` - include worker entrypoint dependencies in the API image.
- `scripts/compose/docker-compose.yml` - add Studio worker service.
- `apps/cli/src/self-host/assets/kortix-compose.yml` - add self-host Studio worker and storage readiness env.
- `infra/k8s/charts/kortix-api/**` - add Studio worker Deployment using the shared image and a distinct command.
- `infra/k8s/envs/dev/values.yaml`, `staging/values.yaml`, `prod/values.yaml`, `preview/values.yaml` - add worker and Studio env values.
- `tests/spec/routes.generated.json` - regenerate after route mount.
- `tests/spec/end-to-end.md` - add Studio Phase 1 flow coverage.
- `packages/sdk/PROGRESS.md` - add and close a Studio SDK claim during SDK work.

## Task 1: Baseline, Feature Gate, and SDK Claim

**Files:**
- Create: none
- Modify: `packages/sdk/PROGRESS.md`
- Read: root `AGENTS.md`, `packages/sdk/AGENTS.md` when present, `docs/specs/2026-07-15-kortix-studio-platform-design.md`

**Produces:** Confirmed branch baseline, active implementation checklist, SDK claim entry.

- [ ] Confirm the worktree is isolated and clean.

  Run:

  ```powershell
  git status --short --branch
  git rev-parse --show-toplevel
  ```

  Expected: branch is `studio-platform`; no unexpected modified files.

- [ ] Record the Studio SDK claim before touching SDK code.

  Modify `packages/sdk/PROGRESS.md` with a dated entry:

  ```markdown
  ## 2026-07-15 Studio Phase 1 SDK Claim

  - Owner: Codex
  - Scope: Add `kortix.project(projectId).studio` plus `@kortix/sdk/react` Studio hooks.
  - Public surface: additive only; no new SDK subpath.
  - Required gates: typecheck, test, public-surface snapshot, smoke install.
  - Status: active
  ```

- [ ] Add a temporary feature-flag decision to implementation notes.

  Use `STUDIO_ENABLED=false` as the default in deployment values until the API, worker, SDK, and web gates pass. The code paths may exist behind the flag; navigation must remain hidden while disabled.

- [ ] Commit the baseline claim.

  ```powershell
  git add packages/sdk/PROGRESS.md
  git commit -m "docs: claim studio sdk phase 1 work"
  ```

## Task 2: Shared Studio Contracts

**Files:**
- Create: `packages/api-contract/src/studio/index.ts`
- Create: `packages/api-contract/src/studio/fixtures.ts`
- Create: `packages/api-contract/src/studio/index.test.ts`
- Modify: `packages/api-contract/src/index.ts`

**Consumes:** Global Phase 1 public states and `image.generate` scope.

**Produces:** Versioned wire contracts used by API, worker, SDK, web, mobile, and Agent tools.

- [ ] Write failing contract tests for job states, image job creation, events, uploads, assets, errors, estimates, and provider configs.

  Assert these exact public states:

  ```ts
  ['queued', 'running', 'succeeded', 'failed', 'cancelled']
  ```

  Assert capability fixture includes `image.generate` and no other Studio capability.

- [ ] Implement Zod contracts for:

  - `StudioCapabilityDescriptor`
  - `StudioImageGenerateInput`
  - `StudioEstimateRequest`
  - `StudioEstimateResponse`
  - `StudioCreateJobRequest`
  - `StudioJob`
  - `StudioJobEvent`
  - `StudioAsset`
  - `StudioUpload`
  - `StudioProviderConfig`
  - `StudioErrorCode`
  - paginated list responses

- [ ] Export the contracts from `packages/api-contract/src/index.ts`.

- [ ] Run:

  ```powershell
  pnpm --filter @kortix/api-contract test
  pnpm --filter @kortix/api-contract typecheck
  ```

  Expected: tests and typecheck pass.

- [ ] Commit:

  ```powershell
  git add packages/api-contract
  git commit -m "feat: add studio api contracts"
  ```

## Task 3: Studio Runtime Package

**Files:**
- Create: `packages/studio-runtime/package.json`
- Create: `packages/studio-runtime/src/index.ts`
- Create: `packages/studio-runtime/src/state-machine.ts`
- Create: `packages/studio-runtime/src/idempotency.ts`
- Create: `packages/studio-runtime/src/provider.ts`
- Create: `packages/studio-runtime/src/object-store.ts`
- Create: `packages/studio-runtime/src/leases.ts`
- Create: `packages/studio-runtime/src/fake-provider.ts`
- Create: `packages/studio-runtime/src/*.test.ts`
- Modify: `pnpm-workspace.yaml`

**Consumes:** Task 2 contracts.

**Produces:** Shared state machine, idempotency, provider adapter contract, fake provider, object-store port, and parameterized lease helper.

- [ ] Add package workspace entry and tests first.

  Tests must cover allowed state transitions, rejected direct terminal changes, canonical request hash stability, idempotency mismatch detection, retry classification, `Retry-After` parsing, max-three-attempt policy, fake provider success/failure modes, streaming object-store conformance, and `studio-maintenance` lease naming.

- [ ] Implement `assertStudioTransition(from, to)` so routes and worker cannot update public status outside the state machine.

- [ ] Implement `canonicalStudioRequestHash(input)` using stable JSON ordering and contract-normalized input.

- [ ] Implement the initial fake-provider `StudioProviderAdapter` contract. Task 9 deliberately evolves it with shared typed errors, synchronous submission results, replayable-within-attempt asset sources, and the production object-store port before external provider I/O is enabled.

- [ ] Implement retry classes:

  - `retryable`
  - `terminal`
  - `rate_limited`
  - `unknown_outcome`

- [ ] Implement deterministic fake provider modes controlled by request input:

  - success with one or more small PNG fixtures
  - retryable failure
  - terminal rejection
  - unknown submission outcome
  - delayed polling

- [ ] Run:

  ```powershell
  pnpm --filter @kortix/studio-runtime test
  pnpm --filter @kortix/studio-runtime typecheck
  ```

- [ ] Commit:

  ```powershell
  git add pnpm-workspace.yaml packages/studio-runtime
  git commit -m "feat: add studio runtime package"
  ```

## Task 4: Durable Database Schema and Migration

**Files:**
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/migrations/<timestamp>_studio_phase1.sql`
- Create: `tests/migration/studio-reservations.test.ts`

**Consumes:** Task 2 contracts and Task 3 state machine.

**Produces:** Durable tables for jobs, attempts, events, assets, uploads, providers, reservations, and usage.

- [ ] Write migration tests for table creation, required indexes, foreign keys, idempotency uniqueness, public status values, provider handle lookup, upload expiry lookup, event cursor ordering, and cross-project lookup keys.

- [ ] Add Drizzle schema blocks with `studio_` table names:

  - `studio_provider_configs`
  - `studio_jobs`
  - `studio_job_attempts`
  - `studio_job_events`
  - `studio_assets`
  - `studio_job_assets`
  - `studio_asset_uploads`
  - `studio_credit_reservations`
  - `studio_usage_events`

- [ ] Add SQL migration with indexes for:

  - account and project time ordering
  - claimable queued/running rows
  - provider handle lookup
  - upload expiry
  - durable event cursor reads
  - unique `(account_id, idempotency_key)`
  - unique settlement and release keys
  - unique provider submission key

- [ ] Run:

  ```powershell
  pnpm --filter @kortix/db test
  pnpm test tests/migration/studio-reservations.test.ts
  ```

- [ ] Commit:

  ```powershell
  git add packages/db tests/migration/studio-reservations.test.ts
  git commit -m "feat: add studio durable schema"
  ```

## Task 5: Billing Reservations and Account State

**Files:**
- Modify: `packages/db/migrations/<timestamp>_studio_phase1.sql`
- Modify: latest `atomic_use_credits` replacement migration body
- Modify: `apps/api/src/billing/services/credits.ts`
- Modify: `apps/api/src/billing/services/account-state.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/billing.ts`
- Test: API billing unit tests and `tests/migration/studio-reservations.test.ts`

**Consumes:** Task 4 reservation tables.

**Produces:** Reservation-aware wallet behavior without changing existing RPC signatures.

- [ ] Write failing tests proving that an active Studio reservation reduces spendable balance for existing credit consumers.

- [ ] Write regression tests proving accounts with no Studio reservation keep current LLM, compute, auto-top-up, expiry, and ledger behavior.

- [ ] Add `public.atomic_create_studio_job`, `public.atomic_settle_studio_job`, and `public.atomic_release_studio_job`.

- [ ] Replace only the body of `public.atomic_use_credits`; keep the signature unchanged.

- [ ] Add additive `reserved` and `available` fields to account-state service and SDK billing type.

- [ ] Run:

  ```powershell
  pnpm --filter kortix-api test
  pnpm --filter @kortix/sdk test
  pnpm test tests/migration/studio-reservations.test.ts
  ```

- [ ] Commit:

  ```powershell
  git add packages/db apps/api/src/billing packages/sdk/src/core/rest/projects-client/billing.ts tests/migration/studio-reservations.test.ts
  git commit -m "feat: reserve credits for studio jobs"
  ```

## Task 6: IAM, Agent Grants, and Token Lifecycle

**Files:**
- Modify: `apps/api/src/iam/actions.ts`
- Modify: `apps/api/src/iam/role-perms.ts`
- Modify: `apps/api/src/iam/engine-v2.ts`
- Modify: `apps/api/src/iam/agent-scope.ts`
- Modify: `apps/api/src/repositories/account-tokens.ts`
- Test: IAM and Agent-scope tests near those modules

**Consumes:** Phase 1 permission model.

**Produces:** Separated provider-use/provider-manage authority and worker-safe uncached lifecycle validation.

- [ ] Add tests for these actions:

  - `project.studio.jobs.read`
  - `project.studio.jobs.run`
  - `project.studio.jobs.cancel`
  - `project.studio.assets.read`
  - `project.studio.assets.write`
  - `project.studio.providers.use`
  - `project.studio.providers.manage`

- [ ] Grant project members job/asset read, job run, and provider use.

- [ ] Grant editors cancel and asset write.

- [ ] Grant managers provider management.

- [ ] Add tests for Agent-created jobs requiring:

  - Studio actions in `agentGrant.kortixCli`
  - Secret identifier in `agentGrant.env`
  - Connector slug in `agentGrant.connectors`

- [ ] Expose a server-only uncached `acting_token_id` lifecycle check that validates active status, `revoked_at IS NULL`, non-expired token, and project binding before worker submission.

- [ ] Run:

  ```powershell
  pnpm --filter kortix-api test
  ```

- [ ] Commit:

  ```powershell
  git add apps/api/src/iam apps/api/src/repositories/account-tokens.ts
  git commit -m "feat: add studio iam and agent grant checks"
  ```

## Task 7: API Routes, Repositories, and Fake Provider Flow

**Files:**
- Create: `apps/api/src/studio/index.ts`
- Create: `apps/api/src/studio/contracts.ts`
- Create: `apps/api/src/studio/repositories/jobs.ts`
- Create: `apps/api/src/studio/repositories/events.ts`
- Create: `apps/api/src/studio/repositories/assets.ts`
- Create: `apps/api/src/studio/repositories/uploads.ts`
- Create: `apps/api/src/studio/repositories/providers.ts`
- Create: `apps/api/src/studio/services/jobs.ts`
- Create: `apps/api/src/studio/services/events.ts`
- Create: `apps/api/src/studio/services/assets.ts`
- Create: `apps/api/src/studio/services/uploads.ts`
- Create: `apps/api/src/studio/services/providers.ts`
- Create: `apps/api/src/studio/providers/fake.ts`
- Modify: `apps/api/src/projects/index.ts`
- Modify: `apps/api/src/index.ts`
- Test: route tests and `tests/src/flows/studio.flow.ts`

**Consumes:** Tasks 2 through 6.

**Produces:** Project-scoped Studio API using deterministic fake provider and no external spend.

- [ ] Write black-box flow tests for:

  - estimate
  - create job
  - idempotent create
  - idempotency mismatch returns 409
  - list jobs
  - read job
  - cancel queued job
  - list events by cursor
  - upload presign/finalize/expiry
  - list assets
  - signed asset download
  - cross-project isolation

- [ ] Mount routes:

  - `GET /v1/projects/:projectId/studio/capabilities`
  - `GET /v1/projects/:projectId/studio/providers`
  - `POST /v1/projects/:projectId/studio/estimates`
  - `POST /v1/projects/:projectId/studio/jobs`
  - `GET /v1/projects/:projectId/studio/jobs`
  - `GET /v1/projects/:projectId/studio/jobs/:jobId`
  - `POST /v1/projects/:projectId/studio/jobs/:jobId/cancel`
  - `GET /v1/projects/:projectId/studio/jobs/:jobId/events`
  - `POST /v1/projects/:projectId/studio/uploads`
  - `POST /v1/projects/:projectId/studio/uploads/:uploadId/finalize`
  - `GET /v1/projects/:projectId/studio/assets`
  - `GET /v1/projects/:projectId/studio/assets/:assetId`
  - `POST /v1/projects/:projectId/studio/assets/:assetId/download-url`

- [ ] Ensure `/capabilities` returns only `image.generate`.

- [ ] Enforce project isolation before repository reads disclose existence.

- [ ] Run:

  ```powershell
  pnpm --filter kortix-api test
  pnpm test tests/src/flows/studio.flow.ts
  bun run apps/api/scripts/dump-routes.ts
  ```

- [ ] Commit:

  ```powershell
  git add apps/api/src/studio apps/api/src/projects/index.ts apps/api/src/index.ts tests/src/flows/studio.flow.ts tests/spec/routes.generated.json
  git commit -m "feat: add studio project api"
  ```

## Task 8: Worker Claim, Execute, Retry, Cancel, and Reconcile

**Files:**
- Create: `apps/studio-worker/package.json`
- Create: `apps/studio-worker/src/index.ts`
- Create: `apps/studio-worker/src/worker.ts`
- Create: `apps/studio-worker/src/maintenance.ts`
- Create: `apps/studio-worker/src/*.test.ts`
- Modify: `pnpm-workspace.yaml`

**Consumes:** Tasks 3, 4, 5, 6, and 7.

**Produces:** Independent worker process with row leases and fake provider execution.

- [ ] Write failing tests for:

  - concurrent workers claim each job once
  - claim lease expiry allows recovery
  - API process cannot claim jobs
  - submission key commits before provider I/O
  - unknown outcome calls `reconcile`
  - retry budget stops after three attempts
  - cancellation before submission releases reservation
  - cancellation after submission calls adapter cancel when supported
  - terminal success creates assets, settles billing, and emits events
  - token or Agent-grant revocation before submission cancels safely

- [ ] Implement the worker loop around `FOR UPDATE SKIP LOCKED`.

- [ ] Implement execution phases:

  - lifecycle and IAM revalidation
  - provider config and credential binding validation
  - attempt creation
  - provider submit
  - synchronous completion staging or asynchronous poll
  - result fetch for durable asynchronous handles
  - object-store copy
  - asset creation
  - billing settlement
  - durable terminal event

- [ ] Implement `studio-maintenance` lease for upload cleanup, progress compaction, and reservation reconciliation.

- [ ] Run:

  ```powershell
  pnpm --filter @kortix/studio-worker test
  pnpm --filter @kortix/studio-worker typecheck
  ```

- [ ] Commit:

  ```powershell
  git add apps/studio-worker pnpm-workspace.yaml
  git commit -m "feat: add studio worker"
  ```

## Task 9: Storage Driver and OpenAI-Compatible Image Adapter

**Design:** `docs/specs/2026-07-16-studio-production-provider-storage-design.md`

**Execution plan:** `docs/specs/2026-07-16-studio-production-provider-storage-implementation-plan.md`

**Consumes:** Task 3's initial runtime ports, Task 7's project API, Task 8's worker and authorization fences, and the existing billing reservation functions.

**Produces:** Project-scoped OpenAI-compatible image execution, shared API/worker private object storage, trusted immutable pricing, safe synchronous/asynchronous recovery, and production assembly that remains disabled until Tasks 14 and 15 pass.

- [ ] Execute the dedicated Task 9 plan task-by-task with TDD and a review checkpoint after every commit.
- [ ] Do not implement the stale Supabase-only driver or an unused Phase 1 webhook.
- [ ] Do not enable production Studio until MinIO conformance, gated provider smoke, Alibaba Cloud OSS compatibility, deployment, and full acceptance gates pass.

## Task 10: SDK Facade, React Hooks, SSE, and Polling

**Files:**
- Create: `packages/sdk/src/core/rest/projects-client/studio/index.ts`
- Create: `packages/sdk/src/core/rest/projects-client/studio/events.ts`
- Create: `packages/sdk/src/core/rest/projects-client/studio/types.ts`
- Create: `packages/sdk/src/react/studio/index.ts`
- Create: SDK tests and public-surface snapshots
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/src/react/index.ts`
- Modify: `packages/sdk/PROGRESS.md`

**Consumes:** Tasks 2 and 7.

**Produces:** Public SDK surface for web, mobile, Electron, and Agent tools.

- [ ] Write failing SDK tests for:

  - `kortix.project(projectId).studio.capabilities.list()`
  - estimates
  - create/list/read/cancel jobs
  - event cursor polling
  - SSE with `Accept: text/event-stream`
  - `Last-Event-ID` reconnect
  - durable event IDs as cursors
  - 15-second heartbeat handling
  - SDK 30-second timeout exemption for SSE and bounded long poll
  - uploads, assets, and signed downloads
  - React hooks invalidation

- [ ] Implement `kortix.project(projectId).studio`.

- [ ] Implement `@kortix/sdk/react` Studio hooks without a new SDK subpath.

- [ ] Mark the SDK claim in `packages/sdk/PROGRESS.md` as complete only after all SDK gates pass.

- [ ] Run:

  ```powershell
  pnpm --filter @kortix/sdk typecheck
  pnpm --filter @kortix/sdk test
  pnpm --filter @kortix/sdk build
  pnpm --filter @kortix/sdk smoke:install
  ```

- [ ] Commit:

  ```powershell
  git add packages/sdk
  git commit -m "feat: add studio sdk facade"
  ```

## Task 11: Web Image Studio and Assets

**Files:**
- Create: `apps/web/src/features/studio/image/image-studio.tsx`
- Create: `apps/web/src/features/studio/image/image-job-history.tsx`
- Create: `apps/web/src/features/studio/image/image-output-grid.tsx`
- Create: `apps/web/src/features/studio/assets/studio-assets-page.tsx`
- Create: `apps/web/src/features/studio/providers/provider-setup.tsx`
- Create: `apps/web/src/features/studio/shared/*.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/studio/page.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/studio/image/page.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/studio/assets/page.tsx`
- Modify: `apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx`
- Modify: `apps/web/src/features/workspace/project-layout/project-shell.tsx`
- Test: `tests/e2e/specs/studio-image.spec.ts`

**Consumes:** Task 10 SDK.

**Produces:** Finished Image Studio and Assets pages in the existing Kortix project shell.

- [ ] Write browser E2E tests for prompt input, reference upload, provider/model selection, estimate, idempotent submit, live progress, output grid, selection, output-as-reference, download, cancellation, reload recovery, insufficient credits, permission denial, and responsive desktop/mobile viewport screenshots.

- [ ] Build the Image Studio as an operational work surface:

  - prompt editor
  - reference image upload and finalized assets
  - provider/model selector
  - aspect ratio
  - quality
  - output count from one to eight
  - advanced settings supported by the selected provider
  - estimate panel
  - submit/cancel/retry controls
  - live job status
  - output grid
  - job history
  - asset handoff

- [ ] Build Assets page with filters, preview, signed download, source job link, and reuse-as-reference.

- [ ] Add sidebar links only for Image Studio and Assets while `STUDIO_ENABLED=true`.

- [ ] Do not add disabled links or route navigation for video, voice, 3D, digital human, batch remix, or Developer Center.

- [ ] Run:

  ```powershell
  pnpm --filter Kortix-Computer-Frontend test
  pnpm exec playwright test tests/e2e/specs/studio-image.spec.ts
  ```

- [ ] Commit:

  ```powershell
  git add apps/web tests/e2e/specs/studio-image.spec.ts
  git commit -m "feat: add image studio web experience"
  ```

## Task 12: Agent Tools

**Files:**
- Create: `apps/api/src/studio/tools/index.ts`
- Create: `apps/api/src/studio/tools/create-job.ts`
- Create: `apps/api/src/studio/tools/get-job.ts`
- Create: `apps/api/src/studio/tools/wait-job.ts`
- Create: `apps/api/src/studio/tools/list-assets.ts`
- Create: `apps/api/src/studio/tools/get-asset.ts`
- Modify: existing Kortix MCP/tool catalog registration file after locating the current registry
- Test: Agent/MCP tool tests

**Consumes:** Tasks 6, 7, and 10.

**Produces:** Governed Studio tools discoverable by existing Agent/MCP flow without OpenCode core changes.

- [ ] Locate the current Kortix tool catalog registration with the graph or `rg "MCP|tool catalog|kortixCli" apps packages`.

- [ ] Write tests for:

  - `studio.create_job`
  - `studio.get_job`
  - `studio.wait_job`
  - `studio.list_assets`
  - `studio.get_asset`
  - bounded 25-second wait
  - durable cursor return
  - revoked token denial before provider submission
  - Secret and Connector grant denial

- [ ] Implement tools by calling the same Studio service methods used by project routes.

- [ ] Return asset IDs and short-lived signed URLs only after IAM checks.

- [ ] Run:

  ```powershell
  pnpm --filter kortix-api test
  ```

- [ ] Commit:

  ```powershell
  git add apps/api/src/studio/tools
  git add <located-tool-catalog-file>
  git commit -m "feat: expose studio agent tools"
  ```

## Task 13: Mobile and Electron Compatibility

**Files:**
- Create: `apps/mobile/app/projects/[id]/studio.tsx`
- Modify: mobile project navigation file after locating current project action list
- Test: mobile tests near existing Expo test setup
- Verify: `apps/desktop-electron`

**Consumes:** Task 10 SDK and Task 11 product behavior.

**Produces:** Mobile monitoring/creation and Electron validation through the shared web app.

- [ ] Add mobile tests for listing jobs, creating a prompt-only image job when provider is enabled, polling events by durable cursor, resuming after app suspension, cursor-expiry snapshot recovery, previewing outputs, and downloading an asset.

- [ ] Implement mobile route using the SDK. Use cursor polling, not a host-local networking implementation.

- [ ] Verify Electron opens `/projects/:id/studio/image`, starts a job through the web SDK flow, displays outputs, and downloads an asset.

- [ ] Run:

  ```powershell
  pnpm --filter ./apps/mobile test
  pnpm --filter Kortix-Computer-Frontend test
  ```

- [ ] Commit:

  ```powershell
  git add apps/mobile
  git commit -m "feat: add studio mobile route"
  ```

## Task 14: Deployment, Operations, and Observability

**Files:**
- Modify: `apps/api/Dockerfile`
- Modify: `scripts/compose/docker-compose.yml`
- Modify: `apps/cli/src/self-host/assets/kortix-compose.yml`
- Modify: `infra/k8s/charts/kortix-api/**`
- Modify: `infra/k8s/envs/dev/values.yaml`
- Modify: `infra/k8s/envs/staging/values.yaml`
- Modify: `infra/k8s/envs/prod/values.yaml`
- Modify: `infra/k8s/envs/preview/values.yaml`
- Modify: `apps/api/src/lib/metrics.ts`
- Modify: `apps/api/src/studio/metrics.ts`
- Create: `apps/api/src/studio/billing-incidents.ts`
- Create: `apps/api/src/studio/billing-incidents.test.ts`
- Modify: `apps/api/src/studio/account-routes.ts`
- Modify: `packages/api-contract/src/studio/index.ts`
- Create: `apps/api/src/studio/observability-config.test.ts`
- Create: `apps/studio-worker/src/observability-server.ts`
- Create: `apps/studio-worker/src/observability-server.test.ts`
- Create: `infra/k8s/charts/kortix-api/templates/studio-worker-service.yaml`
- Create: `infra/k8s/charts/kortix-api/templates/studio-worker-servicemonitor.yaml`
- Modify: `infra/k8s/observability/kortix-alerts.yaml`

**Consumes:** Tasks 8 and 9.

**Produces:** Studio worker deploys independently while sharing the image pipeline.

- [ ] Add Studio worker command to the existing API image, but run it as a distinct process/deployment.

- [ ] Add local compose worker and MinIO services with `STUDIO_ENABLED`, shared storage config, adapter enablement, database access, a private bucket, and readiness-probe lifecycle cleanup.

- [ ] Add self-host readiness gate so storage-disabled deployments fail Studio startup clearly while the rest of Kortix can run when Studio is disabled.

- [ ] Add Kubernetes Studio worker Deployment using the shared image and a distinct command.

- [ ] Connect Task 9's API and worker instrumentation to production counter/gauge/histogram sinks. The API sink registers with the existing `/metrics` registry. The independent worker exposes liveness, readiness, and `/metrics` on a dedicated internal-only port; liveness does not call providers or storage.

- [ ] Add a worker Service and ServiceMonitor selecting only the Studio worker. Render and verify both API and worker scrape targets in Helm. No metric label may contain account/project/job IDs, object keys, URLs, models, credentials, signed queries, or error messages.

- [ ] Add recording/alert rules for unknown outcomes, reservation age over 24 hours, critical age over seven days, 30-day billing-incident transfer, storage readiness failure, estimate violation, platform loss, queue age, and orphan staging objects. Every alert has severity, bounded `for`, and the Studio provider/storage runbook URL.

- [ ] Implement the internal, non-SDK `POST /v1/accounts/:accountId/studio/billing-incidents/:incidentId/resolve` operation gated by `billing.write`. It accepts an idempotency key, reason, evidence reference, and `confirm_not_created | record_platform_liability`; the server validates evidence and calculates provider credits. It never accepts raw credits/actor IDs, never automatically re-debits the user after the 30-day hold ended, and never relies on manual SQL. Add idempotency, actor attribution, conflicting evidence, and cross-account tests.

- [ ] Add `observability-config.test.ts` to parse rendered/checked YAML, assert every required series has a scrape consumer or alert/recording rule, and assert the incident operation exists before any production value can set `STUDIO_ENABLED=true`.

- [ ] Run:

  ```powershell
  docker compose -f scripts/compose/docker-compose.yml config
  tests/infra/scripts/helm-validate.sh
  pnpm --filter @kortix/api-contract test
  pnpm --filter @kortix/api-contract typecheck
  pnpm --filter kortix-api exec bun test src/studio/metrics.test.ts src/studio/billing-incidents.test.ts src/studio/observability-config.test.ts
  pnpm --filter kortix-api typecheck
  pnpm --filter @kortix/studio-worker test src/metrics.test.ts src/observability-server.test.ts
  pnpm --filter @kortix/studio-worker typecheck
  ```

- [ ] Commit:

  ```powershell
  git add apps/api/Dockerfile apps/api/src/lib/metrics.ts apps/api/src/studio apps/studio-worker/src packages/api-contract/src/studio scripts/compose/docker-compose.yml apps/cli/src/self-host/assets/kortix-compose.yml infra/k8s
  git commit -m "feat: deploy studio worker"
  ```

## Task 15: Full Acceptance Gate

**Files:**
- Modify: `tests/spec/routes.generated.json`
- Modify: `tests/spec/end-to-end.md`
- Modify: docs near existing user/admin docs after locating current docs conventions

**Consumes:** All previous tasks.

**Produces:** Verified Phase 1 release candidate.

- [ ] Run route manifest regeneration and confirm Studio routes are present.

  ```powershell
  bun run apps/api/scripts/dump-routes.ts
  git diff -- tests/spec/routes.generated.json
  ```

- [ ] Run package gates:

  ```powershell
  pnpm --filter @kortix/api-contract test
  pnpm --filter @kortix/db test
  pnpm --filter @kortix/studio-runtime test
  pnpm --filter @kortix/studio-runtime typecheck
  pnpm --filter @kortix/studio-adapters test
  pnpm --filter @kortix/studio-adapters typecheck
  pnpm --filter @kortix/studio-worker test
  pnpm --filter @kortix/studio-worker typecheck
  pnpm --filter kortix-api test
  pnpm --filter @kortix/sdk test
  pnpm --filter @kortix/sdk build
  pnpm --filter @kortix/sdk smoke:install
  pnpm --filter Kortix-Computer-Frontend test
  pnpm --filter ./apps/mobile test
  git diff --check
  ```

- [ ] Run the required MinIO object-store conformance and API/worker integration job. A missing Docker/MinIO dependency is a failed gate, not a skipped pass.

- [ ] Run black-box API flow against a real local API.

  ```powershell
  pnpm test tests/src/flows/studio.flow.ts
  ```

- [ ] Run browser flow against local web and API.

  ```powershell
  pnpm exec playwright test tests/e2e/specs/studio-image.spec.ts
  ```

- [ ] Run one bounded live-provider image request only when `STUDIO_LIVE_PROVIDER_TESTS=true` and a low-spend OpenAI-compatible provider config is present.

  Expected proof:

  - one job row
  - one provider submission
  - output object copied into private Studio storage
  - one asset row
  - one final billing settlement
  - output visible in Image Studio
  - asset download succeeds

- [ ] Run the gated Alibaba Cloud OSS storage smoke against the intended endpoint. If S3 compatibility fails, Task 9 is not production-complete until a native OSS driver passes the same conformance suite.

- [ ] Scrape a real local API and independent worker `/metrics` endpoint after driving fake success, unknown outcome, storage-readiness failure, estimate violation, and platform-loss fixtures. Assert all required Task 9 series appear, labels contain no tenant/secret/URL data, and the worker scrape remains available when the provider is unreachable.

- [ ] Run the observability configuration tests and render Helm with monitoring enabled. Verify the API and worker ServiceMonitors select live endpoints and every unknown/reservation/readiness/estimate/platform-loss alert expression references an emitted series. Trigger the 24-hour and seven-day fixture rules; verify the 30-day fixture ends the user hold, opens one billing incident, and the audited incident operation resolves it without a late user debit.

- [ ] Confirm Phase 1 has no executable future-media surface.

  Run:

  ```powershell
  rg "video.generate|voice.dialogue|voice.synthesize|voice.transcribe|model3d.generate|model3d.process|avatar.render|video.batch_mix|digital-human|batch-remix|Developer Center" apps packages tests -g "!**/node_modules/**"
  ```

  Expected: no production routes, seed rows, UI navigation, or capability descriptors for those identifiers outside architecture docs or explicit non-goal comments.

- [ ] Update `tests/spec/end-to-end.md` with the accepted Studio Phase 1 flow and exact verification commands.

- [ ] Commit:

  ```powershell
  git add tests/spec/routes.generated.json tests/spec/end-to-end.md docs
  git commit -m "test: verify studio phase 1 acceptance"
  ```

## Dependency Order

1. Baseline and SDK claim
2. Contracts
3. Runtime package
4. Database schema
5. Billing reservations
6. IAM and Agent grants
7. API routes with fake provider
8. Worker with fake provider
9. Storage and OpenAI-compatible adapter
10. SDK and React hooks
11. Web Image Studio and Assets
12. Agent tools
13. Mobile and Electron compatibility
14. Deployment and observability
15. Full acceptance gate

The fake provider path must pass before live-provider work starts. This protects correctness, cost, and idempotency before real media requests spend money.

## Explicit Non-Goals for Phase 1

- No Video Studio route, capability, provider adapter, timeline, scene model, or UI link.
- No Voice Studio route, capability, dialogue model, synthesis adapter, transcription adapter, or UI link.
- No 3D Studio route, capability, Three.js editor, mesh pipeline, or UI link.
- No Alibaba digital-human adapter, route, callback semantics, avatar scene model, or UI link.
- No Alibaba batch-remix adapter, batch-row job model, report generation, or UI link.
- No Developer Center, marketplace publishing, module sandboxing, revenue ledger, or payout flow.
- No general workflow DAG, dependency-edge execution, or approval-gate orchestration.
- No new OpenCode core behavior.
- No raw provider credentials in database rows, logs, SDK responses, Agent messages, or client state.

## Review Checklist

- [ ] Every new production file is under an extension-owned path or a documented thin integration point.
- [ ] `image.generate` is the only Phase 1 advertised capability.
- [ ] Public job states are limited to `queued`, `running`, `succeeded`, `failed`, and `cancelled`.
- [ ] API pods do not claim Studio jobs.
- [ ] Worker performs uncached token lifecycle validation before provider submission.
- [ ] Agent jobs enforce Studio actions plus Secret or Connector grants.
- [ ] Billing reservations protect spendable balance for all wallet consumers.
- [ ] SDK public surface is additive and exposed through the existing project facade and React export.
- [ ] Web and Electron use SDK SSE; mobile uses SDK cursor polling.
- [ ] Object storage streams media and self-host readiness is explicit.
- [ ] Unknown provider submission outcomes reconcile or surface explicit recovery.
- [ ] Route manifest, contract tests, SDK gates, browser tests, mobile tests, infrastructure validation, and live-provider gated smoke are documented.
