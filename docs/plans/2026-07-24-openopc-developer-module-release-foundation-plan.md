# OpenOPC Developer Module Release Foundation Implementation Plan

> **Execution mode:** inline, test-driven implementation in this task. No subagents and no Superpowers workflow.

**Goal:** Add an account-scoped, durable and immutable release-submission foundation for validated `registry:module` items without adding a second marketplace or claiming signing/publication support.

**Architecture:** `@kortix/registry` remains the canonical manifest contract and Git packages remain the canonical catalog. The API adds a small release service with memory and Drizzle repositories; Postgres stores publisher ownership and derived release metadata only. Release content is immutable, account reads fail closed, and new releases stop at `validated` with deterministic review requirements.

**Tech Stack:** TypeScript, Bun test, Hono/OpenAPI, Drizzle ORM, PostgreSQL, `@kortix/registry`, `@kortix/sdk`.

## Global Constraints

- Preserve Kortix upstream compatibility through isolated additive files and schema blocks.
- Keep visible product language OpenOPC/openopc; internal package and API names may remain Kortix.
- Do not create first-party video, voice, 3D, digital-human, or batch-remix pages or routes.
- Do not persist or echo submitted credential values.
- Do not implement or claim package signing, publication, sandbox execution, installation, rollback, metering, settlement, or production deployment in this slice.
- Do not modify or stage the two protected untracked documents dated `2026-07-21`.

---

### Task 1: Release domain and memory repository

**Files:**
- Create: `apps/api/src/developer/releases.ts`
- Test: `apps/api/src/developer/releases.test.ts`

**Interfaces:**
- Consumes: `validateRegistryItem(item)` and `readRegistryModuleManifest(item)` from `@kortix/registry`.
- Produces: `DeveloperModuleReleaseService`, `DeveloperModuleReleaseRepository`, `createMemoryDeveloperModuleReleaseRepository`, `canonicalDeveloperModuleManifestDigest`, and typed release/error contracts.

- [ ] **Step 1: Write a failing service test**

```ts
test('submits a valid module as immutable validated release metadata', async () => {
  const service = new DeveloperModuleReleaseService({
    repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
  });
  const result = await service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item });
  expect(result.release.status).toBe('validated');
  expect(result.release.manifest_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test apps/api/src/developer/releases.test.ts`

Expected: failure because the release service module does not exist.

- [ ] **Step 3: Implement the minimal domain service and memory repository**

```ts
export interface DeveloperModuleReleaseRepository {
  submit(input: DeveloperModuleReleaseInsert): Promise<{ release: DeveloperModuleRelease; created: boolean }>;
  list(accountId: string, limit: number): Promise<readonly DeveloperModuleRelease[]>;
  get(accountId: string, releaseId: string): Promise<DeveloperModuleRelease | null>;
}

export class DeveloperModuleReleaseService {
  submit(input: { accountId: string; actorUserId: string; item: unknown }): Promise<DeveloperModuleReleaseSubmission>;
  list(input: { accountId: string; limit?: number }): Promise<readonly DeveloperModuleRelease[]>;
  get(input: { accountId: string; releaseId: string }): Promise<DeveloperModuleRelease>;
}
```

The service must validate before persistence, bind `module.id` to the publisher namespace, hash canonical manifest JSON, derive bounded review requirements, reject publisher/version conflicts, and return clones from the memory repository.

- [ ] **Step 4: Add incremental RED/GREEN cases**

Cover invalid manifests, publisher namespace mismatch, publisher ownership conflict, same-version different-digest conflict, idempotent resubmission, cross-account get/list isolation, bounded list limits, no raw secret persistence, and mutation-proof returned objects.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `bun test apps/api/src/developer/releases.test.ts`

Expected: all release-domain tests pass.

### Task 2: Durable database contract

**Files:**
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/types.ts`
- Create: `packages/db/src/developer-module-release-schema.test.ts`
- Create: `packages/db/migrations/20260724120000000_developer_module_releases.sql`

**Interfaces:**
- Produces: `developerModuleReleaseStatusEnum`, `developerPublishers`, `developerModuleReleases`, relations, and inferred row types.

- [ ] **Step 1: Write failing schema and migration tests**

```ts
expect(developerModuleReleaseStatusEnum.enumValues).toEqual([
  'validated', 'review_pending', 'changes_requested', 'approved',
  'signed', 'published', 'revoked', 'deprecated',
]);
expect(getTableConfig(developerModuleReleases).schema).toBe('kortix');
expect(migration).toContain('developer_module_releases_content_immutable');
```

- [ ] **Step 2: Run the DB test and confirm RED**

Run: `bun test packages/db/src/developer-module-release-schema.test.ts`

Expected: missing exports/tables/migration.

- [ ] **Step 3: Add isolated additive schema objects**

`developer_publishers` owns the globally unique publisher slug and account binding. `developer_module_releases` stores account, publisher, module id/version, normalized manifest JSON, `sha256:` digest, review requirements, lifecycle status, creator and timestamps. Add unique module-version constraints, account/list indexes, JSON/hash/namespace checks, service-role-only grants, and a trigger preventing release-content updates while allowing future lifecycle-state changes.

- [ ] **Step 4: Run schema, migration-lint and type checks**

Run:

```powershell
bun test packages/db/src/developer-module-release-schema.test.ts
pnpm.cmd --filter @kortix/db migrate:lint
pnpm.cmd --filter @kortix/db typecheck
```

Expected: exit 0 for each command.

### Task 3: Drizzle repository and authenticated API

**Files:**
- Create: `apps/api/src/developer/releases.drizzle.ts`
- Test: `apps/api/src/developer/releases.drizzle.test.ts`
- Modify: `apps/api/src/developer/app.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/developer/index.test.ts`

**Interfaces:**
- Consumes: Task 1 repository contract and Task 2 tables.
- Produces: `createDrizzleDeveloperModuleReleaseRepository(db)` and routes:
  - `POST /v1/developer/modules/releases`
  - `GET /v1/developer/modules/releases`
  - `GET /v1/developer/modules/releases/:releaseId`

- [ ] **Step 1: Write failing Drizzle idempotency/isolation tests**

Verify atomic publisher claim, same-version idempotency, conflicting digest rejection, account predicates on all reads, and safe serialization.

- [ ] **Step 2: Run the focused repository test and confirm RED**

Run: `bun test apps/api/src/developer/releases.drizzle.test.ts`

- [ ] **Step 3: Implement the transactional repository**

Use `INSERT ... ON CONFLICT DO NOTHING`, scoped follow-up reads, and one transaction for publisher claim plus release insertion. Never update manifest content.

- [ ] **Step 4: Write failing API cases**

Cover authentication, account resolver invocation, successful create/list/get, 400 invalid module, 404 cross-account/missing release, 409 ownership/version conflict, and absence of secret values in error bodies.

- [ ] **Step 5: Implement route wiring and default dependencies**

The default app uses `supabaseAuth`, the context-bound account id when supplied by PAT/service-account auth, membership resolution for Supabase users, the Drizzle repository, and the release service. Set `context.accountId` before returning so the existing audit middleware records the account-scoped mutation.

- [ ] **Step 6: Run focused API tests and typecheck**

Run:

```powershell
bun test apps/api/src/developer/index.test.ts apps/api/src/developer/releases.test.ts apps/api/src/developer/releases.drizzle.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: exit 0.

### Task 4: SDK, route coverage, and progress ledger

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
- Produces: `kortix.developer.modules.releases.submit`, `.list`, and `.get`.

- [ ] **Step 1: Write failing SDK transport/facade tests**

```ts
await kortix.developer.modules.releases.submit(item, { accountId: ACCOUNT_ID });
await kortix.developer.modules.releases.list({ accountId: ACCOUNT_ID, limit: 20 });
await kortix.developer.modules.releases.get(RELEASE_ID, { accountId: ACCOUNT_ID });
```

- [ ] **Step 2: Run the SDK test and confirm RED**

Run: `bun test packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`

- [ ] **Step 3: Implement SDK methods and refresh snapshots**

Keep `validate(item)` unchanged. Submit sends `{ account_id, item }`; list/get use `account_id` query parameters and typed responses.

- [ ] **Step 4: Declare new routes in ke2e coverage**

The public-only flow must at minimum prove all three endpoints reject anonymous access. Update the generated route manifest using the repository's route-generation command if available; otherwise make the exact additive entries and run route parity.

- [ ] **Step 5: Update the progress ledger honestly**

Record durable validated releases, publisher ownership and SDK access as implemented. Keep review transitions, scan/sandbox workers, signing, publishing, install/rollback, metering, settlement, browser acceptance and production deployment open.

### Task 5: Verification and commit

**Files:** all files above; exclude the two protected untracked documents.

- [ ] **Step 1: Run package suites and static gates**

```powershell
pnpm.cmd --filter @kortix/registry test
pnpm.cmd --filter @kortix/db test
pnpm.cmd --filter kortix-api test
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/registry typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd test:routes
```

- [ ] **Step 2: Run formatting/diff checks on touched files**

Run Biome on touched TypeScript/JSON files and `git diff --check`.

- [ ] **Step 3: Verify protected-file and worktree boundaries**

Confirm the two `2026-07-21` documents remain untracked and unstaged; inspect `git diff --stat` and `git status --short`.

- [ ] **Step 4: Commit the completed phase**

```powershell
git add <only files created or modified by this phase>
git commit -m "feat: add durable developer module releases"
```

- [ ] **Step 5: Report exact evidence and remaining boundaries**

Do not claim browser, live database, signing, publication, execution, installation, billing, settlement, or production acceptance unless separately exercised.
