# OpenOPC Developer Artifact Retention Worker Implementation Plan

**Goal:** Add a production, crash-recoverable cleanup worker for developer-module staging uploads and unreferenced staging objects, then make the staging harness verify that worker rather than deleting probes itself.

**Architecture:** The API leader runs one bounded retention tick. PostgreSQL stores acceptance/run leases, retry timestamps, an opaque S3 cursor, and per-upload cleanup markers; the upload rows remain the durable source of truth for expired, cancelled, and never-finalized staging data. The worker rechecks database references and object metadata before conditional deletion, so retries are idempotent and concurrent API replicas cannot delete a newly reused key. The acceptance controller only prepares probes, enqueues a run, polls its terminal record, and verifies database plus S3 state.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL, `StudioObjectStore` list/head/delete APIs, Bun tests, pnpm workspace scripts.

## Global Constraints

- Do not use Superpowers and do not modify the protected 2026-07-21 plan/spec files.
- Preserve Kortix upstream-compatible boundaries; additions should be isolated behind existing repository/store ports.
- Use TDD: each production behavior gets a failing test before implementation.
- On Windows use `pnpm.cmd`.
- Without real staging credentials, G2-G4 remain `not-run`; no evidence ledger record may be promoted locally.
- Never persist or forward a corrupted DSSE envelope as authoritative evidence.
- Cleanup must be bounded per tick, retryable after process/lease failure, tenant-scoped, and redact object bodies and credentials from logs.

---

### Task 1: Durable retention schema and typed repository contract

**Files:**
- Create: `packages/db/migrations/20260726150000000_developer_artifact_retention.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/developer-module-trust-schema.test.ts`
- Modify: `apps/api/src/developer/artifacts.ts`
- Modify: `apps/api/src/developer/artifacts.drizzle.ts`
- Test: `apps/api/src/developer/artifact-retention.repository.test.ts`

**Interfaces:**
- Add upload cleanup fields `staging_deleted_at`, `cleanup_attempts`, `cleanup_next_attempt_at`, and `cleanup_last_error`.
- Add `developer_artifact_retention_runs` with `run_id`, `state`, `attempts`, `available_at`, `lease_owner`, `lease_expires_at`, `cursor`, `last_error`, `created_at`, `updated_at`, and `finished_at`.
- Add repository methods `enqueueRetentionRun`, `claimRetentionRun`, `listCleanupCandidates`, `markUploadStagingDeleted`, `recordUploadCleanupFailure`, `completeRetentionRun`, and `failRetentionRun`.

- [ ] Write tests for idempotent enqueue, expired lease reclaim, `FOR UPDATE SKIP LOCKED` candidate bounds, marker updates, and tenant/run binding.
- [ ] Run the repository test and schema test to verify RED.
- [ ] Add the migration, Drizzle declarations, serializers, and exact repository queries with conditional state/lease predicates.
- [ ] Run the focused tests and DB typecheck to verify GREEN.

### Task 2: Object-store retention port and bounded cleanup algorithm

**Files:**
- Modify: `apps/api/src/developer/artifacts.ts`
- Modify: `apps/api/src/developer/artifacts.s3.ts`
- Create: `apps/api/src/developer/artifact-retention.ts`
- Create: `apps/api/src/developer/artifact-retention.test.ts`

**Interfaces:**
- Extend the retention store with `listStaging(prefix, cursor, limit)`, `headStaging`, and conditional `deleteStaging(storageKey, etag?)`.
- Export `createDeveloperArtifactRetentionWorker({ repository, store, ownerId, now, limits })` with `runOnce(): Promise<RetentionTickResult>`, `start()`, and `stop()`.

- [ ] Write failing tests for expired uploads, cancelled uploads, missing-object idempotency, stale DB reference recheck, orphan pagination/cursor persistence, exponential backoff, and lease loss.
- [ ] Run the focused retention tests and verify the expected RED failures.
- [ ] Implement bounded upload cleanup first, then orphan prefix scanning; treat `NOT_FOUND` as success, use `if_match` for deletes, and persist cursor/next-attempt before returning.
- [ ] Run retention unit tests, S3 adapter tests, and API typecheck.

### Task 3: API singleton lifecycle and internal enqueue boundary

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/shared/leader-election.ts`
- Create: `apps/api/src/developer/artifact-retention-runtime.ts`
- Test: `apps/api/src/developer/artifact-retention-runtime.test.ts`
- Modify: `apps/api/src/developer/app.ts`
- Test: `apps/api/src/developer/app.test.ts`

**Interfaces:**
- Add `startDeveloperArtifactRetentionWorker()` and `stopDeveloperArtifactRetentionWorker()` to the existing singleton lifecycle.
- Add an internal, staging-identity-protected `POST /module-beta/trust/retention-runs` enqueue route returning `{ runId, state: 'queued' }`; production timer remains authoritative.

- [ ] Write failing lifecycle tests proving API boot does not start the worker when storage is unavailable, start/stop are idempotent, and only the leader can enqueue/claim.
- [ ] Run focused lifecycle tests to verify RED.
- [ ] Wire the worker after existing singleton services without blocking API boot; use bounded recursive scheduling and catch every tick error.
- [ ] Run focused lifecycle tests and API typecheck.

### Task 4: Acceptance controller and harness real-worker flow

**Files:**
- Modify: `apps/module-beta-acceptance-controller/src/s3.ts`
- Modify: `apps/module-beta-acceptance-controller/src/controller.ts`
- Modify: `apps/module-beta-acceptance-controller/src/http.ts`
- Modify: `apps/module-beta-acceptance-controller/src/http.test.ts`
- Modify: `tests/module-beta/trust/run.ts`
- Modify: `tests/module-beta/trust/run.test.ts`

**Interfaces:**
- Replace `runCleanupProbes` with `prepareCleanupProbes`, `enqueueRetentionRun`, and `readRetentionRun`.
- Harness sequence is `prepare -> assert probes exist -> enqueue -> poll terminal -> assert marker/HEAD absence -> immutable-attempt snapshot`; controller never deletes a probe directly.

- [ ] Add a RED test showing a cleanup response cannot claim success when the worker has not run.
- [ ] Run the focused harness/controller test and verify RED.
- [ ] Implement strict request/run binding, bounded polling, opaque cursor handling, and exact `succeeded` assertions; keep the existing real cancelled-upload API path.
- [ ] Run all trust harness tests and controller tests.

### Task 5: Deployment, migration validation, and release gate evidence

**Files:**
- Modify: `deploy/openopc-modules/trust.compose.yml`
- Modify: `deploy/openopc-modules/trust.compose.test.ts`
- Modify: `apps/api/src/config.ts`
- Test: `apps/api/src/config.test.ts`
- Do not modify: `tests/module-beta/evidence.json` unless real staging credentials are supplied.

- [ ] Add disabled-by-default retention settings, bounded intervals, grace period, batch size, and private route identity wiring.
- [ ] Run Compose policy/config tests, all changed package tests/typechecks, `pnpm.cmd module-beta:evidence:validate`, `git diff --check`, and the full `pnpm.cmd test`.
- [ ] Confirm real container build/smoke status separately; a timeout is not a pass.
- [ ] Run `codegraph sync` and `codegraph status --json` after implementation.

