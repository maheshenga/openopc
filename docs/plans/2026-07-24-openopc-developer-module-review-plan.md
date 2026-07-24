# OpenOPC Developer Module Review Implementation Plan

> **Execution mode:** inline, test-driven implementation in this task. No subagents and no Superpowers workflow.

**Goal:** Add a durable, account-scoped developer module review lifecycle with publisher review requests, platform-admin decisions, complete manual evidence attestations, immutable history, and stale-decision fencing.

**Architecture:** `developer_module_releases` remains the current release projection and Git-native Registry packages remain canonical. A dedicated review service owns the transition graph; a separate append-only event table records every committed transition. Publisher operations use account IAM, platform decisions use the existing platform-admin boundary, and the project Review Center is not modified.

**Tech Stack:** TypeScript, Bun test, Hono/OpenAPI, Drizzle ORM, PostgreSQL 16, existing Kortix IAM/admin/audit middleware, and `@kortix/sdk`.

**Design source:** `docs/specs/2026-07-24-openopc-developer-module-review-design.md`

## Global Constraints

- Preserve Kortix upstream compatibility through isolated additive files and one small Admin route-registration seam.
- Keep `@kortix/*`, the `kortix` database schema, existing routes, environment names, protocols, and project Review Center contracts stable.
- Keep OpenOPC as the user-visible product name.
- Do not create first-party video, voice, 3D, digital-human, or batch-remix pages, routes, capability seeds, or navigation.
- Do not implement or claim automated scanning, sandbox execution, signing, publishing, installation, rollback, metering, settlement, browser acceptance, or production rollout.
- Evidence is a bounded manual attestation snapshot. Never store raw source, logs, URLs, headers, provider payloads, credentials, or signing material.
- Preserve the two protected untracked `2026-07-21` documents exactly; never stage them.
- Use red-green-refactor for every product-code task. Record both the initial failing assertion and the final passing command.

---

## Task 1: Review domain, validation, and memory repository

**Files:**

- Modify: `apps/api/src/developer/releases.ts`
- Modify: `apps/api/src/developer/releases.test.ts`
- Create: `apps/api/src/developer/reviews.ts`
- Create: `apps/api/src/developer/reviews.test.ts`

**Interfaces:**

- Extend `DeveloperModuleRelease` with `review_revision`.
- Produce `DeveloperModuleReviewEvidence`, `DeveloperModuleReviewEvent`, `DeveloperModuleReviewAction`, `DeveloperModuleReviewActorKind`, `DeveloperModuleReviewRepository`, `DeveloperModuleReviewService`, and `createMemoryDeveloperModuleReviewRepository`.
- Produce stable `DeveloperModuleReviewError` codes without accepting arbitrary error text.

- [ ] **Step 1: Add the release-revision RED case**

Update the release-domain test so a newly submitted release must contain:

```ts
expect(result.release).toMatchObject({
  status: 'validated',
  review_revision: 0,
});
```

Run:

```powershell
bun test apps/api/src/developer/releases.test.ts
```

Expected RED: the release contract and memory repository do not expose `review_revision`.

- [ ] **Step 2: Add the review state-machine RED cases**

Create focused tests for:

- `validated -> review_pending` as publisher sequence/revision `1`;
- `changes_requested -> review_pending` only with a non-empty response;
- `review_pending -> changes_requested` only as platform admin with reason;
- `review_pending -> approved` only with exactly one manual `passed` attestation for every declared requirement;
- `approved -> revoked` only as platform admin with emergency reason;
- rejection of every other transition, including all `signed`, `published`, and `deprecated` transitions;
- stale `expected_status` or `expected_revision` returning `DEVELOPER_REVIEW_CONFLICT`;
- platform-admin approval denied when the reviewer belongs to the publisher account;
- strict evidence keys, requirement deduplication, timestamp bounds, digest format, byte/count limits, and manual-only method;
- supported credential-bearing patterns and control characters rejected from reason/summary fields;
- errors never echo submitted reason/evidence values;
- returned release/event/evidence objects are mutation-safe clones;
- per-release event sequences are immutable and monotonic.

Run:

```powershell
bun test apps/api/src/developer/reviews.test.ts
```

Expected RED: the review module does not exist.

- [ ] **Step 3: Implement the minimum domain service**

Implement a strict transition table rather than scattered conditionals. The service methods are:

```ts
requestReview(input): Promise<DeveloperModuleReviewTransition>
decide(input): Promise<DeveloperModuleReviewTransition>
history(input): Promise<readonly DeveloperModuleReviewEvent[]>
adminList(input): Promise<DeveloperModuleAdminReviewPage>
adminGet(input): Promise<DeveloperModuleAdminReviewDetail>
```

The repository receives a normalized transition command containing account/release identity, expected status/revision, action, target status, actor identity/kind, safe reason, and cloned evidence. The service checks publisher/admin authority semantics before calling the repository, while the repository remains responsible for atomic compare-and-swap and event append.

The memory repository accepts seeded releases and publisher-account members, keeps its own immutable event copies, and implements the same conflict behavior expected from PostgreSQL.

- [ ] **Step 4: Run domain GREEN and refactor**

Run:

```powershell
bun test apps/api/src/developer/releases.test.ts apps/api/src/developer/reviews.test.ts
```

Expected: all release and review domain tests pass. Refactor only after green; keep validation helpers private unless the API/Drizzle layers require a type guard.

## Task 2: Add the durable schema and migration contract

**Files:**

- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/developer-module-release-schema.test.ts`
- Create: `packages/db/src/developer-module-review-schema.test.ts`
- Create: `packages/db/migrations/20260724150000000_developer_module_reviews.sql`
- Create: `packages/db/scripts/developer-module-review-migration.integration.test.ts`

**Interfaces:**

- Add `developer_module_review_action` and `developer_module_review_actor_kind` enums.
- Add `developer_module_releases.review_revision` and a unique `(release_id, account_id)` identity.
- Add `developer_module_release_review_events` and inferred row/insert types.

- [ ] **Step 1: Write schema and migration RED tests**

Assert:

- revision defaults to `0` and has a non-negative check;
- `(release_id, account_id)` is unique;
- queue index order begins `(status, updated_at, release_id)`;
- review events use a composite release/account foreign key with cascade on the existing release/account deletion lifecycle;
- `(release_id, sequence)` is unique and `sequence > 0`;
- transition/action/actor/reason/evidence checks exist;
- event rows are selectable/insertable by `service_role` but not updateable/deletable;
- release update grants include only `status`, `review_revision`, and `updated_at`;
- the existing content-immutability trigger still protects every release-content column.

Run:

```powershell
bun test packages/db/src/developer-module-release-schema.test.ts packages/db/src/developer-module-review-schema.test.ts
```

Expected RED: the new column, tables, exports, and migration are absent.

- [ ] **Step 2: Implement the additive Drizzle schema and SQL migration**

The event table contains release/account identity, sequence, action, from/to statuses, actor identity/kind, bounded reason, bounded evidence JSON, and database timestamp. Add relations from releases to events without changing existing publisher/account relations.

Make the migration idempotent where the repository convention requires it. Update `protect_developer_module_release_content()` only as necessary to allow review revision while continuing to reject changes to manifest, digest, requirements, version, publisher, account, creator, and creation timestamp.

- [ ] **Step 3: Write and run real PostgreSQL migration tests**

The disposable PostgreSQL 16 test must apply the release-foundation migration, then the review migration twice, and prove:

- the expected columns, types, indexes, FKs, and grants exist;
- invalid transitions, invalid sequences, oversized evidence, and duplicate sequence replay fail;
- direct content mutation and event update/delete through the API role fail;
- a legal status/revision update plus event insert succeeds transactionally;
- account/release cascade deletion still succeeds;
- two competing conditional updates from the same revision yield exactly one winner.

Run:

```powershell
bun test packages/db/scripts/developer-module-review-migration.integration.test.ts
pnpm.cmd --filter @kortix/db migrate:lint
pnpm.cmd --filter @kortix/db typecheck
```

Expected: exit `0`; Docker-backed tests may skip only when Docker is genuinely unavailable, and that skip must be reported.

## Task 3: Drizzle review repository and atomic compare-and-swap

**Files:**

- Create: `apps/api/src/developer/reviews.drizzle.ts`
- Create: `apps/api/src/developer/reviews.drizzle.test.ts`
- Modify: `apps/api/src/developer/releases.drizzle.ts`
- Modify: `apps/api/src/developer/releases.drizzle.test.ts`

**Interfaces:**

- Produce `createDrizzleDeveloperModuleReviewRepository(db)`.
- Update release serialization to include `review_revision`.

- [ ] **Step 1: Write Drizzle repository RED cases**

Cover:

- publisher get/history queries include both `account_id` and `release_id`;
- admin get/list may span accounts only through the separate admin methods;
- admin list uses a bounded limit and keyset `(updated_at, release_id)` cursor;
- membership lookup checks the reviewer against the release's publisher account;
- transition update predicates include account/release/status/revision;
- the resulting revision is used as the immutable event sequence;
- zero-row update maps to `404` only when a safe follow-up read cannot find the release, otherwise to `409`;
- update and event append run inside one transaction;
- evidence/reason are cloned and serialized without manifest/provider bodies.

Run:

```powershell
bun test apps/api/src/developer/releases.drizzle.test.ts apps/api/src/developer/reviews.drizzle.test.ts
```

Expected RED: the review repository is missing and release rows omit revision.

- [ ] **Step 2: Implement the repository transaction**

Use one conditional `UPDATE ... RETURNING` followed by one event `INSERT ... RETURNING` inside the same Drizzle transaction. Do not read then update without the compare-and-swap predicate. Do not automatically retry an unknown commit outcome.

Use explicit serializers for public snake-case contracts. Never return raw Drizzle rows or account-membership details.

- [ ] **Step 3: Run repository GREEN**

Run:

```powershell
bun test apps/api/src/developer/releases.drizzle.test.ts apps/api/src/developer/reviews.drizzle.test.ts
```

Expected: all repository tests pass and the SQL-condition parameter assertions contain every tenant/concurrency fence.

## Task 4: Harden publisher IAM and add publisher review routes

**Files:**

- Modify: `apps/api/src/developer/app.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/developer/index.test.ts`

**Interfaces:**

- Add an injected account-authorizer dependency to `createDeveloperApp`.
- Add:
  - `POST /v1/developer/modules/releases/{releaseId}/review-requests`
  - `GET /v1/developer/modules/releases/{releaseId}/review-history`

- [ ] **Step 1: Write IAM-hardening RED cases for existing routes**

Prove:

- release submit requires `ACCOUNT_ACTIONS.ACCOUNT_WRITE`;
- release list/get require `ACCOUNT_ACTIONS.ACCOUNT_READ`;
- validation remains authenticated but account-independent;
- an account member without write permission cannot submit or request review;
- a token-bound account mismatch remains `403`;
- a release in another account remains `404`;
- authorization is evaluated after the canonical account is resolved and before service mutation.

- [ ] **Step 2: Write publisher review-route RED cases**

Cover strict body/query schemas, current-status/revision requirements, resubmission reason, `201`/`200` response shapes, immutable history order, code-only `400/404/409` failures, and absence of submitted text in error bodies.

Run:

```powershell
bun test apps/api/src/developer/index.test.ts
```

Expected RED: account authorization and review routes are absent.

- [ ] **Step 3: Implement publisher route wiring**

Default wiring uses `supabaseAuth`, `resolveDeveloperAccountId`, `assertAuthorized`, existing `ACCOUNT_ACTIONS`, the release repository/service, and the new review repository/service. Thread the authenticated user and resolved account explicitly; do not trust an account from the request body after resolution.

Set `context.accountId` before successful mutation responses so the existing audit middleware attributes the request correctly.

- [ ] **Step 4: Run publisher API GREEN and typecheck**

Run:

```powershell
bun test apps/api/src/developer/index.test.ts apps/api/src/developer/releases.test.ts apps/api/src/developer/reviews.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: exit `0`.

## Task 5: Add the platform-admin review API

**Files:**

- Create: `apps/api/src/admin/developer-reviews.ts`
- Create: `apps/api/src/admin/developer-reviews.test.ts`
- Modify: `apps/api/src/admin/index.ts`

**Interfaces:**

- Register under the existing `adminApp`, after its global `supabaseAuth + requireAdmin` middleware:
  - `GET /v1/admin/developer/modules/reviews`
  - `GET /v1/admin/developer/modules/releases/{releaseId}/review`
  - `POST /v1/admin/developer/modules/releases/{releaseId}/review-decisions`

- [ ] **Step 1: Write admin-boundary RED cases**

Create an injected route-registration harness and prove:

- anonymous users receive `401` and non-admin users receive `403` through the canonical middleware;
- admin queue uses status/cursor/limit validation and does not accept publisher account filters as authorization;
- detail returns the release plus chronological immutable history;
- `request_changes`, `approve`, and `revoke` enforce their exact source states, revisions, reasons, and evidence rules;
- approval is `403` for any current member of the publisher account, including the creator;
- missing releases return `404`, stale decisions return `409`, and no submitted content appears in errors;
- a successful decision records a supplemental bounded account audit event after the durable transition;
- audit/webhook failure does not undo the already committed review transition.

Run:

```powershell
bun test apps/api/src/admin/developer-reviews.test.ts
```

Expected RED: the Admin developer-review routes are absent.

- [ ] **Step 2: Implement isolated Admin route registration**

Keep route bodies and schemas in `developer-reviews.ts`; add only an import and registration call to the existing large Admin app. Reuse the already constructed review service rather than creating a second repository instance with divergent configuration.

Audit actions use stable names such as `developer.module.review.approved`, resource type `developer_module_release`, real release/account IDs, before/after status and revision only, plus IP/user-agent. Do not include manifest, reasons, or evidence in the generic audit row.

- [ ] **Step 3: Run Admin API GREEN and API typecheck**

Run:

```powershell
bun test apps/api/src/admin/developer-reviews.test.ts apps/api/src/developer/index.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: exit `0`.

## Task 6: SDK, public surface, route coverage, and progress ledger

**Files:**

- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Modify: `packages/sdk/src/core/client/kortix.ts`
- Modify: `packages/sdk/src/public-surface.snapshot.json`
- Modify: `packages/sdk/src/public-type-surface.snapshot.json`
- Modify: `tests/spec/routes.generated.json`
- Modify: `tests/src/flows/new-routes-coverage.flow.ts`
- Modify: `docs/operations/studio-acceleration-progress.md`

**Interfaces:**

- Extend publisher SDK types with release revision, review evidence/events, request input, and history response.
- Add:

```ts
kortix.developer.modules.releases.requestReview(releaseId, input)
kortix.developer.modules.releases.reviewHistory(releaseId, options)
```

- [ ] **Step 1: Write SDK transport/facade RED cases**

Prove encoded release IDs, optional `account_id`, exact request bodies, typed history responses, facade wiring, and preservation of all existing validate/submit/list/get methods.

Run:

```powershell
bun test packages/sdk/src/core/rest/projects-client/developer-modules.test.ts
```

Expected RED: the methods and types do not exist.

- [ ] **Step 2: Implement SDK additions and deliberately refresh snapshots**

Run the focused test first, then regenerate only additive surface changes:

```powershell
$env:UPDATE_SURFACE_SNAPSHOT='1'; bun test packages/sdk/src/public-surface.test.ts; Remove-Item Env:UPDATE_SURFACE_SNAPSHOT
$env:UPDATE_TYPE_SURFACE_SNAPSHOT='1'; bun test packages/sdk/src/public-type-surface.test.ts; Remove-Item Env:UPDATE_TYPE_SURFACE_SNAPSHOT
```

Inspect the diffs and reject any removed or renamed export.

- [ ] **Step 3: Refresh and cover the authoritative route manifest**

Run:

```powershell
bun run apps/api/scripts/dump-routes.ts
pnpm.cmd --filter @kortix/tests coverage
```

Add all five routes to `new-routes-coverage.flow.ts`. The route-coverage flow must prove every endpoint rejects anonymous access; the focused Admin API test separately proves the authenticated non-admin `403` boundary. Do not mark a route covered by an unrelated health check.

- [ ] **Step 4: Update the progress ledger honestly**

Record manual review requests, platform-admin decisions, immutable history, revision conflicts, manual evidence, IAM hardening, API/SDK routes, and exact test evidence. Keep automated scan/sandbox, signing, publishing, Web UI, install/rollback, metering, settlement, browser acceptance, live production acceptance, and deployment open.

## Task 7: Full verification, compatibility audit, and phase commit

**Files:** all files above; explicitly exclude the two protected untracked documents.

- [ ] **Step 1: Run focused final gates**

```powershell
bun test apps/api/src/developer/releases.test.ts apps/api/src/developer/reviews.test.ts apps/api/src/developer/releases.drizzle.test.ts apps/api/src/developer/reviews.drizzle.test.ts apps/api/src/developer/index.test.ts apps/api/src/admin/developer-reviews.test.ts
bun test packages/db/src/developer-module-release-schema.test.ts packages/db/src/developer-module-review-schema.test.ts packages/db/scripts/developer-module-review-migration.integration.test.ts
bun test packages/sdk/src/core/rest/projects-client/developer-modules.test.ts packages/sdk/src/public-surface.test.ts packages/sdk/src/public-type-surface.test.ts
```

- [ ] **Step 2: Run package suites and static gates**

```powershell
pnpm.cmd --filter @kortix/db test
pnpm.cmd --filter kortix-api test
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/db migrate:lint
pnpm.cmd --filter @kortix/tests coverage
```

Run DB integration files sequentially if parallel disposable PostgreSQL containers contend for host resources. Keep the API test harness's known process-global mock contamination separate from focused failures; do not call a failing monolithic run green.

- [ ] **Step 3: Run the restored wider repository test command**

```powershell
pnpm.cmd test
```

Capture the exact pass/fail/skip result. Investigate every failure touching changed code. Classify unrelated pre-existing failures with direct isolated evidence; never replace the wider result with focused-green wording.

- [ ] **Step 4: Run formatting, diff, and protected-file checks**

Run Biome only over changed TypeScript/JSON files, then:

```powershell
git diff --check
git diff --stat
git status --short
git diff --name-only --cached
```

Confirm no project Review Center file changed and the two protected `2026-07-21` documents remain untracked and unstaged.

- [ ] **Step 5: Update CodeGraph and inspect blast radius**

```powershell
codegraph sync .
codegraph explore "Trace the developer module review request and platform-admin decision paths from REST routes through IAM, service, Drizzle transaction, event history, audit, and SDK. Identify any path that bypasses account/admin scope or revision fencing."
```

Resolve any discovered bypass before commit.

- [ ] **Step 6: Commit the completed implementation phase**

Stage only reviewed files for this phase and commit:

```powershell
git commit -m "feat: add governed developer module reviews"
```

- [ ] **Step 7: Report exact evidence and remaining boundaries**

Report the commit, focused/package/wider test results, Docker/PostgreSQL status, route coverage, protected-file status, and every deferred capability. Do not claim Web UI, browser, automated scanning, sandboxing, signing, publishing, installation, billing, settlement, or production acceptance.
