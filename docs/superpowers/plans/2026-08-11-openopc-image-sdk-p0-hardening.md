# OpenOPC Image SDK P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenOPC Image Studio module safe for sustained browser polling and lossless PostgreSQL pagination while keeping strict v1 response contracts compatible.

**Architecture:** Keep short-lived capability grants as execution/audit evidence, but make user-facing module job access installation-scoped and actor-scoped through the original grant identity. Cache browser capability tokens in memory per service operation, coalesce refreshes, and expose a structured host rate-limit error. Replace timestamp-only/sentinel cursors with opaque `(created_at,id)` keysets, filter module jobs before pagination, and resolve job outputs through `studio_job_assets` rather than scanning assets by source metadata.

**Tech Stack:** TypeScript, Bun tests, Zod wire contracts, Hono module routes, Drizzle ORM, PostgreSQL migrations, pnpm workspaces.

## Global Constraints

- Work only in `E:/code/agentk/suna-image-sdk-hardening`; do not read or modify `E:/code/agentk/suna-openopc-module-dev`.
- Do not add provider credentials, object-storage URLs, or arbitrary provider metadata to module responses.
- Preserve existing strict v1 job/asset response objects; add a strict jobs page endpoint and additive transport error shape only.
- Capability-token cache is memory-only, scoped to one adapter/iframe and one `service:operation`; no persistence or cross-install sharing.
- A 401/403 may invalidate and retry exactly once; caller `AbortSignal` and request deadline remain authoritative.
- Do not commit, push, deploy, merge, or publish in this task.

---

### Task 1: Browser Token Lifecycle and Host Rate Limits

**Files:**
- Modify: `packages/openopc-developer-sdk/src/browser-capability-token.ts`
- Modify: `packages/openopc-developer-sdk/src/errors.ts`
- Modify: `packages/openopc-developer-sdk/src/client.ts`
- Modify: `apps/web/src/features/project-modules/module-service-bridge.ts`
- Test: `packages/openopc-developer-sdk/src/browser-capability-token.test.ts`
- Test: `packages/openopc-developer-sdk/src/client.test.ts`
- Test: `apps/web/src/features/project-modules/module-service-bridge.test.ts`

**Interfaces:**
- The browser getter remains callable as `getCapabilityToken({ service, operation }, { signal? })` and gains an optional `invalidate(input)` method used by the client after an auth rejection.
- The host error response is `{ type: 'openopc.module-service.token.error', requestId, error: { code: 'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED', retryAfterMs } }`; success response keys remain unchanged.
- `OpenOpcModuleRequestError` may carry only the stable code and bounded `retryAfterMs`; no provider response text is reflected.

- [x] **Step 1: Write failing tests** for a 40-call sustained polling sequence, concurrent refresh coalescing, expiry-minus-30-second refresh, structured host rate-limit response, and one 401/403 retry with a fresh authorization header.
- [x] **Step 2: Run the focused tests and confirm they fail** because each call currently posts a token request, rate-limit responses are silent, and `send` never retries authentication.
- [x] **Step 3: Implement the minimum lifecycle changes:** cache `{ token, expiresAt }` by operation, keep one in-flight acquisition per key, wrap shared acquisition in per-caller abort handling, invalidate only the affected key, return structured rate-limit errors with `retryAfterMs`, and retry one unauthorized fetch after invalidation.
- [x] **Step 4: Re-run focused tests and the existing SDK/bridge suites.** Confirm aborts do not cancel unrelated coalesced callers and a second unauthorized response is surfaced through the existing redacted error parser.

### Task 2: Lossless Composite Keyset Pagination

**Files:**
- Create: `apps/api/src/studio/repositories/keyset-cursor.ts`
- Test: `apps/api/src/studio/repositories/keyset-cursor.test.ts`
- Modify: `apps/api/src/studio/repositories/drizzle.ts`
- Modify: `apps/api/src/studio/repositories/memory.ts`
- Modify: `apps/api/src/studio/types.ts`
- Create: `packages/db/migrations/20260811120000000_openopc_image_keyset_pagination.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Test: `apps/api/src/studio/management.postgres.test.ts` or the existing PostgreSQL studio integration fixture

**Interfaces:**
- New cursors encode versioned `{ created_at, id }` values as opaque base64url strings; repositories accept the new form and legacy timestamp cursors during rollout.
- `listJobs` and `listAssets` order by `created_at DESC, id DESC` and use the last returned row for `next_cursor`; `listEvents` returns the last returned numeric event cursor.
- Add `listJobAssets(projectId, jobId, role, limit, cursor)` to `StudioRepository` for authoritative output paging.

- [x] **Step 1: Write failing pure cursor tests** for round-trip encoding, malformed rejection, and a legacy timestamp cursor.
- [x] **Step 2: Write a failing PostgreSQL integration test** inserting equal-timestamp jobs/assets and 101 events, then assert page concatenation contains every row exactly once and the event sentinel is not skipped.
- [x] **Step 3: Run RED tests** and record the current sentinel loss/duplicate-timestamp omission.
- [x] **Step 4: Implement the cursor codec, Drizzle tuple predicates, last-returned cursor generation, memory-repository parity, and migration/schema indexes for `(project_id, created_at DESC, job_id/asset_id DESC)` and output relations.
- [x] **Step 5: Run the pure, memory, and real PostgreSQL tests;** reject malformed new cursors at the repository boundary without exposing SQL/provider details.

### Task 3: Module Job Listing and Stable Permission Semantics

**Files:**
- Modify: `packages/api-contract/src/openopc-ai.ts`
- Test: `packages/api-contract/src/openopc-ai.test.ts`
- Modify: `packages/openopc-developer-sdk/src/ai-contracts.ts`
- Modify: `packages/openopc-developer-sdk/src/client.ts`
- Test: `packages/openopc-developer-sdk/src/image-client.test.ts`
- Modify: `apps/api/src/module-services/images.ts`
- Modify: `apps/api/src/module-services/images-runtime.ts`
- Modify: `apps/api/src/module-services/images-studio.ts`
- Test: `apps/api/src/module-services/images.test.ts`
- Test: `apps/api/src/module-services/images-studio.test.ts`
- Modify: `apps/api/src/studio/repositories/drizzle.ts`
- Modify: `apps/api/src/studio/repositories/memory.ts`
- Modify: `tests/src/coverage/allowlist.ts`
- Regenerate: `tests/spec/routes.generated.json`

**Interfaces:**
- Add strict `OpenOpcImageJobPageSchema` and `GET /v1/module-services/ai/images/jobs?cursor=&limit=`; `POST /jobs` and `OpenOpcImageJobSchema` do not change.
- Add SDK `ai.images.jobs.list(input?, requestOptions?)` with existing `AbortSignal` semantics.
- Repository filtering is performed in SQL before `LIMIT`: project/account, `actor_type='module'`, current `actor_user_id`, `capability='image.generate'`, and original grant `installation_id`.
- Reads remain installation/actor-scoped across short-lived grant refreshes. Project assets are readable by all authorized project module actors; mutations stay creator/install scoped. Non-owner reads redact prompt and user metadata.

- [x] **Step 1: Add failing contract, route, SDK, and backend tests** for pre-page filters, empty-page avoidance, same-installation grant refresh, foreign-installation denial, and project-shared asset reads with redaction.
- [x] **Step 2: Run RED tests** and capture missing route/method plus current grant-ID-only ownership behavior.
- [x] **Step 3: Implement the strict page schema and route, repository filter object, SQL `EXISTS` installation predicate, SDK method, and stable job/asset access helpers.** Split readable assets from mutable direct-asset checks.
- [x] **Step 4: Run focused API/contract/SDK tests, including the sustained polling bridge integration.** Verify no post-page filtering remains in the production path.

### Task 4: Authoritative Job Outputs

**Files:**
- Modify: `apps/api/src/studio/repositories/drizzle.ts`
- Modify: `apps/api/src/studio/repositories/memory.ts`
- Modify: `apps/api/src/module-services/images-studio.ts`
- Modify: `apps/api/src/module-services/images-runtime.ts`
- Test: `apps/api/src/module-services/images-studio.test.ts`
- Test: PostgreSQL studio integration fixture

**Interfaces:**
- `jobs.outputs(jobId)` remains the existing endpoint and response shape, but its repository query uses `studio_job_assets.role='output'` with a paginated relation cursor.
- `assets.list({ source_job_id })` remains available for compatibility and server-side filtering; no provider/object-store metadata is added.

- [x] **Step 1: Add a failing test** where an output relation exists but `source_job_id` metadata is absent or points elsewhere; `jobs.outputs` must return only the relation row.
- [x] **Step 2: Run RED and verify the current implementation incorrectly delegates to `listAssets` source filtering.**
- [x] **Step 3: Implement `listJobAssets` and switch the backend output method, preserving authorization and pagination limits.**
- [x] **Step 4: Run memory and PostgreSQL relation tests plus the existing image SDK/API suites.**

### Task 5: Verification and Handoff

**Files:**
- Verify all changed files above; no unrelated cleanup.

- [x] Run `bun test packages/openopc-developer-sdk/src`, `bun test packages/api-contract/src`, the focused API module/studio tests under the repository test environment, and PostgreSQL integration with Docker when available.
- [x] Run typechecks for `@openopc/developer-sdk`, `@kortix/api-contract`, `kortix-api`, and the touched web module-host package; run SDK build.
- [x] Run route-manifest/coverage contract tests and `git diff --check`.
- [x] Use the verification matrix to label type/contract/local PostgreSQL evidence separately from unverified production provider, worker, GIF, and deployment behavior.
- [x] Leave the branch uncommitted and report exact paths, test output, and remaining risks.

### Task 6: Module Job and Asset Status/Time Filters

**Files:**
- Modify: `packages/api-contract/src/openopc-ai.ts`
- Test: `packages/api-contract/src/openopc-ai.test.ts`
- Modify: `packages/openopc-developer-sdk/src/ai-contracts.ts`
- Modify: `packages/openopc-developer-sdk/src/client.ts`
- Modify: `packages/openopc-developer-sdk/src/index.ts`
- Test: `packages/openopc-developer-sdk/src/image-client.test.ts`
- Modify: `apps/api/src/module-services/images.ts`
- Modify: `apps/api/src/module-services/images-studio.ts`
- Test: `apps/api/src/module-services/images.test.ts`
- Test: `apps/api/src/module-services/images-studio.test.ts`
- Modify: `apps/api/src/studio/types.ts`
- Modify: `apps/api/src/studio/repositories/memory.ts`
- Modify: `apps/api/src/studio/repositories/drizzle.ts`
- Test: `apps/api/src/studio/management.postgres.test.ts`

**Interfaces:**
- Preserve `cursor`, `limit`, `source`, and `source_job_id` exactly as existing callers use them.
- Add optional `status`, `created_after`, and `created_before` to jobs; add the date bounds to assets.
- Date ranges are strict ISO-8601 and use an inclusive lower bound with an exclusive upper bound. Reversed or malformed ranges fail at the contract/route boundary.
- Apply every filter in the repository query before the composite cursor predicate and `LIMIT`; pagination response envelopes and AbortSignal behavior remain unchanged.

- [x] Add mirrored strict API/SDK schemas, client query serialization, route parsing, and repository filter types.
- [x] Add memory and real PostgreSQL coverage for status filtering, date boundaries, and pre-limit pagination.
- [x] Run contract, SDK, route, Studio backend, PostgreSQL, typecheck, build, and full API default-suite verification.
