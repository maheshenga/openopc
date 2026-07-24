# OpenOPC Developer Module Distribution Implementation Plan

> **Execution mode:** inline, test-driven implementation in the current `studio-platform` worktree. Do not use Superpowers or create another worktree. Every task ends with a focused commit and review checkpoint.

**Goal:** Complete the signed declarative-module lifecycle from approved release through publication, Marketplace discovery, project installation, exact-version update, rollback, and emergency revocation.

**Architecture:** Keep the existing `@kortix/registry`, Developer Center review service, Marketplace catalog, project IAM, and `@kortix/sdk` as authoritative boundaries. Add server-side signing/distribution ports, immutable Drizzle state, a declarative activation service, an additive Marketplace catalog source, and Web controls; do not restore the removed deterministic file installer or execute module code.

**Tech Stack:** TypeScript, Bun test, Node crypto Ed25519, Hono/OpenAPI, Drizzle ORM, PostgreSQL, React/Next.js, TanStack Query, `@kortix/registry`, `@kortix/sdk`.

## Global Constraints

- Only `registry:module` items with `execution.mode === 'declarative'`, no executable entry, no files, no package/registry dependencies, and no UI entry are distributable.
- Keep `@kortix/*`, the `kortix` database schema, existing `/v1` routes, the existing Marketplace `install-session`, and the project Review Center unchanged.
- `OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED` gates new behavior; an absent/false flag preserves the Kortix baseline.
- A private signing key never appears in an API request, response, audit payload, PostgreSQL row, or log.
- Production signing is injected through `ModuleSigningPort`; self-hosted secure configuration may create the default Ed25519 port, while hosted deployments may replace it with KMS/HSM without changing domain code.
- Exact release IDs are required for install/update/rollback. Do not implement floating automatic upgrades.
- A project has at most one active installation row per module; updates and rollback only move the pointer and append history.
- Revoked releases cannot be installed, updated to, or used as rollback targets. Existing installation history remains immutable and reads report the active pointer as blocked.
- Do not add first-party video, voice, 3D, digital-human, or batch-remix pages.
- Do not modify or stage the two protected untracked documents dated `2026-07-21`.

---

### Task 1: Declarative Eligibility and Ed25519 Signing Contract

**Files:**
- Create: `apps/api/src/developer/module-signing.ts`
- Test: `apps/api/src/developer/module-signing.test.ts`
- Modify: `apps/api/src/developer/releases.ts`

**Interfaces:**
- Consumes: `RegistryModuleManifest`, `readRegistryModuleManifest`, `validateRegistryItem`, and `canonicalDeveloperModuleManifestDigest`.
- Produces: `ModuleSigningPort`, `DeveloperModuleSignaturePayload`, `DeveloperModuleSignature`, `buildDeveloperModuleSignaturePayload`, `canonicalDeveloperModuleSignaturePayload`, `isDistributableDeclarativeModule`, and `createEd25519ModuleSigningPort`.

- [ ] **Step 1: Write failing eligibility and signature tests**

```ts
test('accepts only manifest-only declarative modules', () => {
  expect(isDistributableDeclarativeModule(moduleItem())).toEqual({ ok: true });
  expect(isDistributableDeclarativeModule(moduleItem({ files: [{ path: 'run.ts', type: 'registry:file' }] }))).toEqual({
    ok: false,
    code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE',
  });
});

test('signs and verifies the canonical immutable release payload', async () => {
  const port = createEd25519ModuleSigningPort({ keyId: 'openopc-test-2026', privateKey, publicKey });
  const bytes = canonicalDeveloperModuleSignaturePayload(payload);
  const signature = await port.sign(bytes);
  expect(await port.verify(bytes, signature)).toBe(true);
  expect(await port.verify(canonicalDeveloperModuleSignaturePayload({ ...payload, module_version: '1.0.1' }), signature)).toBe(false);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `bun test apps/api/src/developer/module-signing.test.ts`

Expected: FAIL because `module-signing.ts` does not exist.

- [ ] **Step 3: Implement the exact signing types and canonical payload**

```ts
export interface DeveloperModuleSignaturePayload {
  schema: 1;
  module_id: string;
  module_version: string;
  publisher_id: string;
  manifest_digest: `sha256:${string}`;
}

export interface ModuleSigningPort {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<`base64url:${string}`>;
  verify(payload: Uint8Array, signature: `base64url:${string}`): Promise<boolean>;
}

export interface DeveloperModuleSignature {
  algorithm: 'ed25519';
  key_id: string;
  signature: `base64url:${string}`;
  payload_digest: `sha256:${string}`;
  signed_at: string;
}
```

Use Node `crypto.sign(null, payload, privateKey)` and `crypto.verify`. Reject malformed key IDs, malformed base64url signatures, non-Ed25519 keys, and signatures longer than the bounded wire shape. Keep canonical JSON stable and expose no key material.

- [ ] **Step 4: Implement strict declarative eligibility**

The predicate must first validate/read the module and then reject any non-empty `files`, `dependencies`, `devDependencies`, `registryDependencies`, `envVars`, `inputs`, `execution.entry`, `ui[].entry`, or `permissions.desktop`. Descriptive fields such as title, description, categories, docs, capabilities, and declarative permission names remain allowed.

- [ ] **Step 5: Add negative tests for tampering and secret safety**

Cover malformed manifests, non-declarative modes, inline file content, dependency arrays, executable UI entries, desktop permission declarations, bad signature prefixes, unknown key IDs, public-key mismatch, and clone safety. Assert serialized values never contain the private PEM.

- [ ] **Step 6: Run focused tests and TypeScript**

```powershell
bun test apps/api/src/developer/module-signing.test.ts apps/api/src/developer/releases.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the signing contract**

```powershell
git add -- apps/api/src/developer/module-signing.ts apps/api/src/developer/module-signing.test.ts apps/api/src/developer/releases.ts
git commit -m "feat(api): add developer module signing contract"
```

---

### Task 2: Distribution and Project Installation Database Contract

**Files:**
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/types.ts`
- Create: `packages/db/src/developer-module-distribution-schema.test.ts`
- Create: `packages/db/migrations/20260724180000000_developer_module_distribution.sql`

**Interfaces:**
- Produces: `developerModuleDistributionActionEnum`, `developerModuleReleaseDistributionEvents`, `projectModuleInstallationStatusEnum`, `projectModuleInstallationActionEnum`, `projectModuleInstallations`, `projectModuleInstallationEvents`, relations, and inferred row types.

- [ ] **Step 1: Write failing schema and migration tests**

```ts
expect(getTableConfig(developerModuleReleases).columns.map((column) => column.name)).toContain('signature_key_id');
expect(getTableConfig(projectModuleInstallations).uniqueConstraints.map((item) => item.name)).toContain(
  'project_module_installations_project_module_unique',
);
expect(migration).toContain('developer_module_release_distribution_events_append_only');
expect(migration).toContain('project_module_installation_events_append_only');
```

- [ ] **Step 2: Run the DB test and confirm RED**

Run: `bun test packages/db/src/developer-module-distribution-schema.test.ts`

Expected: FAIL because the exports, columns, tables, and migration are missing.

- [ ] **Step 3: Add release signature columns and consistency checks**

Add nullable `signatureAlgorithm`, `signatureKeyId`, `signature`, `signaturePayloadDigest`, `signedAt`, `publishedAt`, and `revokedAt` fields to `developerModuleReleases`. Add checks requiring the four signature fields and `signed_at` to be all-null or all-present, `ed25519` plus `base64url:` formats, `published_at` for published/revoked rows, and `revoked_at` only for revoked rows.

- [ ] **Step 4: Add immutable distribution events**

```ts
export const developerModuleDistributionActionEnum = kortixSchema.enum(
  'developer_module_distribution_action',
  ['sign', 'publish', 'revoke'],
);
```

Create `developer_module_release_distribution_events` with release/account composite FK, positive sequence, unique `(release_id, sequence)`, platform-admin actor, bounded reason, and exact transition checks for approved-to-signed, signed-to-published, and signed/published-to-revoked. Add an append-only trigger.

- [ ] **Step 5: Add project installation state and events**

Create one `project_module_installations` row per `(project_id, module_id)` with the project/account composite FK, active release/account composite FK, version consistency checks, non-negative `install_revision`, and `active|blocked` status. Create append-only installation events with `install|update|rollback`, from/to release IDs, positive sequence, actor, and unique `(installation_id, sequence)`.

- [ ] **Step 6: Preserve immutable release content**

Extend the existing `developer_module_releases_content_immutable` trigger so all signature metadata is mutable only through lifecycle transitions while manifest, digest, publisher, module/version, requirements, creator, and creation time remain immutable. Do not rewrite either prior migration.

- [ ] **Step 7: Run DB gates**

```powershell
bun test packages/db/src/developer-module-distribution-schema.test.ts packages/db/src/developer-module-release-schema.test.ts packages/db/src/developer-module-review-schema.test.ts
pnpm.cmd --filter @kortix/db migrate:lint
pnpm.cmd --filter @kortix/db typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the database contract**

```powershell
git add -- packages/db/src/schema/kortix.ts packages/db/src/index.ts packages/db/src/types.ts packages/db/src/developer-module-distribution-schema.test.ts packages/db/migrations/20260724180000000_developer_module_distribution.sql
git commit -m "feat(db): add developer module distribution state"
```

---

### Task 3: Distribution Domain Service and Memory Repository

**Files:**
- Create: `apps/api/src/developer/distribution.ts`
- Test: `apps/api/src/developer/distribution.test.ts`
- Modify: `apps/api/src/developer/releases.ts`
- Modify: `apps/api/src/developer/reviews.ts`

**Interfaces:**
- Consumes: Task 1 signing contract and the existing release/review status/revision types.
- Produces: `DeveloperModuleDistributionService`, `DeveloperModuleDistributionRepository`, `DeveloperModuleDistributionEvent`, `DeveloperModuleDistributionTransition`, `DeveloperModuleDistributionError`, and `createMemoryDeveloperModuleDistributionRepository`.

- [ ] **Step 1: Write failing state-machine tests**

```ts
test('signs approved declarative release and publishes only after verification', async () => {
  const signed = await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  expect(signed.release.status).toBe('signed');
  expect(signed.event.action).toBe('sign');
  const published = await service.publish({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'signed',
    expectedRevision: 3,
  });
  expect(published.release.status).toBe('published');
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `bun test apps/api/src/developer/distribution.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Define the repository and errors**

```ts
export interface DeveloperModuleDistributionRepository {
  getAdmin(releaseId: string): Promise<DeveloperModuleRelease | null>;
  isPublisherAccountMember(accountId: string, userId: string): Promise<boolean>;
  sign(command: DeveloperModuleSignCommand): Promise<DeveloperModuleDistributionTransition>;
  transition(command: DeveloperModuleDistributionTransitionCommand): Promise<DeveloperModuleDistributionTransition>;
  listPublished(input: { query?: string; limit: number; offset: number }): Promise<DeveloperModulePublishedPage>;
  getPublished(releaseId: string): Promise<DeveloperModuleRelease | null>;
  history(accountId: string, releaseId: string): Promise<readonly DeveloperModuleDistributionEvent[]>;
}
```

Define the neighboring command/result types in the same module so every repository implementation shares one contract:

```ts
export interface DeveloperModuleSignCommand {
  releaseId: string;
  actorUserId: string;
  expectedStatus: 'approved';
  expectedRevision: number;
  signature: DeveloperModuleSignature;
}

export interface DeveloperModuleDistributionTransitionCommand {
  releaseId: string;
  actorUserId: string;
  action: 'publish' | 'revoke';
  expectedStatus: 'signed' | 'published';
  expectedRevision: number;
  reason: string | null;
}

export interface DeveloperModuleDistributionEvent {
  distribution_event_id: string;
  release_id: string;
  account_id: string;
  sequence: number;
  action: 'sign' | 'publish' | 'revoke';
  from_status: DeveloperModuleReleaseStatus;
  to_status: DeveloperModuleReleaseStatus;
  actor_user_id: string;
  actor_kind: 'platform_admin';
  reason: string | null;
  created_at: string;
}

export interface DeveloperModuleDistributionTransition {
  release: DeveloperModuleRelease;
  event: DeveloperModuleDistributionEvent;
}

export interface DeveloperModulePublishedPage {
  releases: readonly DeveloperModuleRelease[];
  total: number;
}
```

Errors must include `DEVELOPER_MODULE_SIGNER_UNAVAILABLE` (503), `DEVELOPER_MODULE_SIGNATURE_INVALID`, `DEVELOPER_MODULE_NOT_DISTRIBUTABLE`, `DEVELOPER_MODULE_NOT_PUBLISHED`, `DEVELOPER_MODULE_REVOKED`, `DEVELOPER_DISTRIBUTION_SELF_ACTION_DENIED`, `DEVELOPER_DISTRIBUTION_CONFLICT`, and `DEVELOPER_RELEASE_NOT_FOUND`.

- [ ] **Step 4: Implement sign, publish, and emergency revoke**

`sign` reads and fences approved revision, denies publisher-account members, checks declarative eligibility, builds/signs bytes, then atomically writes signature plus `approved -> signed`. `publish` verifies the stored signature and current manifest digest before `signed -> published`. `revoke` accepts signed/published releases, requires a bounded credential-safe reason, and transitions permanently to revoked. Approved revocation remains supported by the existing review service.

- [ ] **Step 5: Extend release serialization safely**

Add nullable signature/published/revoked fields to `DeveloperModuleRelease` and ensure new validated rows initialize them to null. Update every clone/fixture/serializer compile site. Expose the public detached signature and key ID; never expose signer configuration.

- [ ] **Step 6: Add conflict, retry, and key-rotation tests**

Cover stale status/revision, signer failure leaving approved state untouched, transaction conflict discarding the signature, same successful command idempotency, changed target conflict, invalid persisted signature, disabled/unknown verification key, self-action denial, signed/published revoke, and combined chronological history.

- [ ] **Step 7: Run focused API domain tests**

```powershell
bun test apps/api/src/developer/module-signing.test.ts apps/api/src/developer/distribution.test.ts apps/api/src/developer/releases.test.ts apps/api/src/developer/reviews.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the distribution domain**

```powershell
git add -- apps/api/src/developer/distribution.ts apps/api/src/developer/distribution.test.ts apps/api/src/developer/releases.ts apps/api/src/developer/reviews.ts
git commit -m "feat(api): add developer module distribution lifecycle"
```

---

### Task 4: Drizzle Distribution Repository and Secure Signer Wiring

**Files:**
- Create: `apps/api/src/developer/distribution.drizzle.ts`
- Test: `apps/api/src/developer/distribution.drizzle.test.ts`
- Create: `apps/api/src/developer/module-signer-config.ts`
- Test: `apps/api/src/developer/module-signer-config.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/developer/index.ts`

**Interfaces:**
- Consumes: Tasks 1-3 contracts and Task 2 Drizzle tables.
- Produces: `createDrizzleDeveloperModuleDistributionRepository`, `createConfiguredModuleSigningPort`, and singleton `developerModuleDistributionService`.

- [ ] **Step 1: Write failing repository transaction tests**

Assert conditional `status + review_revision` updates, atomic signature/event writes, unique event sequence fencing, account-safe reads, keyset-stable published listing, and no partial publication when the event insert fails.

- [ ] **Step 2: Run repository tests and confirm RED**

Run: `bun test apps/api/src/developer/distribution.drizzle.test.ts`

Expected: FAIL because the Drizzle repository is missing.

- [ ] **Step 3: Implement transactional Drizzle operations**

Use one transaction per lifecycle mutation. `UPDATE ... WHERE release_id = ? AND status = ? AND review_revision = ? RETURNING` must happen with exactly one event insert. After zero updated rows, re-read by release id to classify 404 versus conflict. Do not retry an unknown transaction result.

- [ ] **Step 4: Write failing secure-config tests**

```ts
expect(createConfiguredModuleSigningPort({ enabled: false })).toBeNull();
expect(() => createConfiguredModuleSigningPort({
  enabled: true,
  keyId: '',
  privateKeyBase64: PRIVATE_KEY,
  publicKeyBase64: PUBLIC_KEY,
})).toThrow('DEVELOPER_MODULE_SIGNER_UNAVAILABLE');
```

- [ ] **Step 5: Add fail-closed configuration**

Read `OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED` with `KORTIX_DEVELOPER_MODULE_DISTRIBUTION_ENABLED` fallback, plus bounded key ID and base64-encoded PKCS8/SPKI Ed25519 keys. Decode in memory only. When enabled but incomplete/invalid, retain a service that returns signer-unavailable; do not crash unrelated Kortix API routes and do not log key strings.

- [ ] **Step 6: Run repository/config tests and typecheck**

```powershell
bun test apps/api/src/developer/distribution.drizzle.test.ts apps/api/src/developer/module-signer-config.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit persistence and signer wiring**

```powershell
git add -- apps/api/src/developer/distribution.drizzle.ts apps/api/src/developer/distribution.drizzle.test.ts apps/api/src/developer/module-signer-config.ts apps/api/src/developer/module-signer-config.test.ts apps/api/src/config.ts apps/api/src/developer/index.ts
git commit -m "feat(api): persist signed developer module releases"
```

---

### Task 5: Platform-Admin Sign, Publish, and Revocation Routes

**Files:**
- Create: `apps/api/src/admin/developer-distribution.ts`
- Test: `apps/api/src/admin/developer-distribution.test.ts`
- Modify: `apps/api/src/admin/developer-reviews.ts`
- Modify: `apps/api/src/admin/developer-reviews.test.ts`
- Modify: `apps/api/src/admin/index.ts`
- Modify: `apps/api/src/developer/index.test.ts`

**Interfaces:**
- Consumes: `DeveloperModuleDistributionService.sign`, `.publish`, and `.revoke` plus existing `supabaseAuth`, `requireAdmin`, and audit recorder.
- Produces: `registerAdminDeveloperDistributionRoutes` and authenticated endpoints at `/v1/admin/developer/modules/releases/:releaseId/sign` and `/publish`.

- [ ] **Step 1: Write failing route tests**

Cover anonymous 401, non-admin 403, publisher-account admin denial, successful sign/publish, stale 409, signer-unavailable 503, invalid-signature 409, audit metadata, and error responses that contain no submitted values or key material.

```ts
const response = await app.request(`/developer/modules/releases/${RELEASE_ID}/sign`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ expected_status: 'approved', expected_revision: 2 }),
});
expect(response.status).toBe(200);
expect((await response.json()).release.status).toBe('signed');
```

- [ ] **Step 2: Run route tests and confirm RED**

Run: `bun test apps/api/src/admin/developer-distribution.test.ts`

Expected: FAIL because the route module is missing.

- [ ] **Step 3: Implement strict OpenAPI routes**

Use a strict body schema with only `expected_status` and `expected_revision`; sign accepts only `approved`, publish only `signed`. The handler derives the actor from `context.get('userId')`, sets the release account on context after success, writes bounded audit events, and maps every typed domain error to its exact HTTP status.

- [ ] **Step 4: Extend the existing revoke decision without duplicating the route**

Keep `POST .../review-decisions` as the single revoke endpoint. Route `approved` revocation through `DeveloperModuleReviewService.decide`; route `signed|published` revocation through `DeveloperModuleDistributionService.revoke`. Preserve the old approved behavior and response shape, and never accept revoke from validated/review-pending/changes-requested.

- [ ] **Step 5: Mount the new routes behind the existing admin middleware**

```ts
registerAdminDeveloperDistributionRoutes(adminApp, {
  distributionService: developerModuleDistributionService,
  recordAuditEvent,
});
```

Do not add another authentication stack or public SDK method for admin operations.

- [ ] **Step 6: Run focused route and API tests**

```powershell
bun test apps/api/src/admin/developer-distribution.test.ts apps/api/src/admin/developer-reviews.test.ts apps/api/src/developer/index.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit admin distribution routes**

```powershell
git add -- apps/api/src/admin/developer-distribution.ts apps/api/src/admin/developer-distribution.test.ts apps/api/src/admin/developer-reviews.ts apps/api/src/admin/developer-reviews.test.ts apps/api/src/admin/index.ts apps/api/src/developer/index.test.ts
git commit -m "feat(api): expose admin module distribution actions"
```

---

### Task 6: Project Installation Domain and Drizzle Repository

**Files:**
- Create: `apps/api/src/developer/installations.ts`
- Test: `apps/api/src/developer/installations.test.ts`
- Create: `apps/api/src/developer/installations.drizzle.ts`
- Test: `apps/api/src/developer/installations.drizzle.test.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/src/developer/index.ts`

**Interfaces:**
- Consumes: published-release lookup, Task 1 verifier, Task 2 installation tables, and direct dependency `semver@7.8.5` plus its TypeScript declaration package.
- Produces: `ProjectModuleInstallationService`, `ProjectModuleInstallationRepository`, `ProjectModuleInstallation`, `ProjectModuleInstallationEvent`, `createMemoryProjectModuleInstallationRepository`, `createDrizzleProjectModuleInstallationRepository`, and singleton `projectModuleInstallationService`.

- [ ] **Step 1: Write failing install/update/rollback tests**

```ts
const installed = await service.install({
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  actorUserId: USER_ID,
  releaseId: RELEASE_V1,
  expectedInstallRevision: 0,
  idempotencyKey: 'install-v1',
});
expect(installed.installation.active_release_id).toBe(RELEASE_V1);

const rolledBack = await service.rollback({
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  moduleId: MODULE_ID,
  actorUserId: USER_ID,
  releaseId: RELEASE_V1,
  expectedInstallRevision: 2,
  idempotencyKey: 'rollback-v1',
});
expect(rolledBack.event.action).toBe('rollback');
```

- [ ] **Step 2: Run domain tests and confirm RED**

Run: `bun test apps/api/src/developer/installations.test.ts`

Expected: FAIL because the installation service is missing.

- [ ] **Step 3: Implement the repository contract**

```ts
export interface ProjectModuleInstallationRepository {
  list(accountId: string, projectId: string): Promise<readonly ProjectModuleInstallation[]>;
  get(accountId: string, projectId: string, moduleId: string): Promise<ProjectModuleInstallation | null>;
  install(command: ProjectModuleInstallCommand): Promise<ProjectModuleInstallationTransition>;
  move(command: ProjectModuleMoveCommand): Promise<ProjectModuleInstallationTransition>;
  hasHistoricalTarget(installationId: string, releaseId: string): Promise<boolean>;
  findIdempotentResult(input: ProjectModuleIdempotencyLookup): Promise<ProjectModuleInstallationTransition | null>;
}
```

Use these exact command/result shapes for the service and route adapters:

```ts
export interface ProjectModuleInstallCommand {
  accountId: string;
  projectId: string;
  actorUserId: string;
  releaseId: string;
  expectedInstallRevision: 0;
  idempotencyKey?: string;
}

export interface ProjectModuleMoveCommand {
  accountId: string;
  projectId: string;
  moduleId: string;
  actorUserId: string;
  releaseId: string;
  action: 'update' | 'rollback';
  expectedInstallRevision: number;
  idempotencyKey?: string;
}

export interface ProjectModuleIdempotencyLookup {
  accountId: string;
  projectId: string;
  idempotencyKey: string;
  action: 'install' | 'update' | 'rollback';
  releaseId: string;
}

export interface ProjectModuleInstallationTransition {
  installation: ProjectModuleInstallation;
  event: ProjectModuleInstallationEvent;
}
```

- [ ] **Step 4: Implement compatibility and signature verification**

Before every install/update/rollback, load the exact release, require `published`, re-hash the manifest, verify the detached Ed25519 signature by key ID, and check `manifest.compatibility.platform` and optional `registry` range with `semver.satisfies`. Invalid ranges or unsatisfied versions fail closed as `DEVELOPER_MODULE_NOT_DISTRIBUTABLE`.

- [ ] **Step 5: Implement state and replay rules**

Initial install creates revision 1 and an install event. Update requires the same module ID and a different published release. Rollback additionally requires the target release in that installation's prior event history. A repeated idempotency key with identical coordinates returns the committed result; reuse with different coordinates returns `PROJECT_MODULE_INSTALL_CONFLICT`.

- [ ] **Step 6: Implement Drizzle transactions**

Use unique `(project_id,module_id)`, conditional `install_revision`, append-only event insertion, and exact account/project predicates. Revoked active releases serialize as `status: blocked` without deleting or rewriting history. Concurrent moves produce one success and one conflict.

- [ ] **Step 7: Add negative and concurrency tests**

Cover unpublished/signed/revoked/tampered releases, cross-account projects, module mismatch, stale revision, rollback target never installed, rollback target since revoked, duplicate initial install, idempotency reuse, concurrent updates, and mutation-proof memory returns.

- [ ] **Step 8: Run domain/repository tests and typecheck**

```powershell
bun test apps/api/src/developer/installations.test.ts apps/api/src/developer/installations.drizzle.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit project installation state**

```powershell
git add -- apps/api/src/developer/installations.ts apps/api/src/developer/installations.test.ts apps/api/src/developer/installations.drizzle.ts apps/api/src/developer/installations.drizzle.test.ts apps/api/package.json pnpm-lock.yaml apps/api/src/developer/index.ts
git commit -m "feat(api): add project module installation state"
```

---

### Task 7: Project Routes and Existing Marketplace Catalog Adapter

**Files:**
- Create: `apps/api/src/projects/routes/developer-modules.ts`
- Test: `apps/api/src/projects/developer-modules-routes.test.ts`
- Modify: `apps/api/src/projects/index.ts`
- Create: `apps/api/src/marketplace/developer-modules.ts`
- Test: `apps/api/src/marketplace/developer-modules.test.ts`
- Modify: `apps/api/src/marketplace/index.ts`
- Modify: `apps/api/src/marketplace/catalog.ts`
- Modify: `apps/api/src/marketplace/catalog.test.ts`

**Interfaces:**
- Consumes: Task 6 installation service, `loadProjectForUser`, `assertProjectCapability`, `PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ/WRITE`, and the existing Marketplace list/detail wire shape.
- Produces: `GET /v1/projects/:projectId/modules`, install/update/rollback mutations, and `DeveloperModuleMarketplaceAdapter` merged into `/v1/marketplace/items` and detail.

- [ ] **Step 1: Write failing project-route tests**

Cover read versus write IAM, token-bound project/account mismatch, list, initial install, exact update, rollback, idempotency header, stale 409, revoked target, and unknown release. Assert the server derives account ID from the loaded project and ignores any account-like field in JSON.

- [ ] **Step 2: Run project-route tests and confirm RED**

Run: `bun test apps/api/src/projects/developer-modules-routes.test.ts`

Expected: FAIL because the routes are missing.

- [ ] **Step 3: Implement project-scoped OpenAPI routes**

```text
GET  /{projectId}/modules
POST /{projectId}/modules/install
POST /{projectId}/modules/{moduleId}/update
POST /{projectId}/modules/{moduleId}/rollback
```

Use strict UUID/release/revision bodies, a bounded `Idempotency-Key` header, and the existing project loader. GET requires customize read; mutations require customize write. Import the route module after `r10` without changing prior route order.

- [ ] **Step 4: Write failing Marketplace adapter tests**

Assert only published, signed, declarative releases appear; revoked and non-declarative rows never appear; search/type/source filters and offsets remain deterministic; detail includes release id, version, publisher, capabilities, permissions, and public signature metadata; file-preview returns 404 because declarative modules have no files.

- [ ] **Step 5: Implement the additive catalog source**

`DeveloperModuleMarketplaceAdapter` returns existing Marketplace item/detail wire objects with stable ID `openopc-module:${releaseId}` and `type: registry:module`. Merge it at the API aggregation layer after the existing Git catalog is loaded, sort the combined filtered list by stable ID, then apply the existing 1..200 limit and offset. Do not change the current `install-session` handler or prompt builder.

- [ ] **Step 6: Preserve Marketplace baseline tests**

Add source-contract tests showing registry skills/projects still render and install through their current paths when the distribution flag is off or the module source is empty.

- [ ] **Step 7: Run project/Marketplace tests and typecheck**

```powershell
bun test apps/api/src/projects/developer-modules-routes.test.ts apps/api/src/marketplace/developer-modules.test.ts apps/api/src/marketplace/catalog.test.ts apps/api/src/__tests__/unit-marketplace.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit routes and catalog integration**

```powershell
git add -- apps/api/src/projects/routes/developer-modules.ts apps/api/src/projects/developer-modules-routes.test.ts apps/api/src/projects/index.ts apps/api/src/marketplace/developer-modules.ts apps/api/src/marketplace/developer-modules.test.ts apps/api/src/marketplace/index.ts apps/api/src/marketplace/catalog.ts apps/api/src/marketplace/catalog.test.ts
git commit -m "feat(api): expose published modules to projects"
```

---

### Task 8: SDK Contracts, Facade, and Route Parity

**Files:**
- Create: `packages/sdk/src/core/rest/projects-client/project-modules.ts`
- Test: `packages/sdk/src/core/rest/projects-client/project-modules.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/src/core/client/kortix.ts`
- Modify: `packages/sdk/src/core/client/kortix.test.ts`
- Modify: `packages/sdk/src/public-surface.snapshot.json`
- Modify: `packages/sdk/src/public-type-surface.snapshot.json`
- Modify: `tests/spec/routes.generated.json`
- Modify: `tests/src/flows/new-routes-coverage.flow.ts`

**Interfaces:**
- Produces: `kortix.project(projectId).modules.{list,install,update,rollback}` and the extended signature metadata in `DeveloperModuleRelease`.

- [ ] **Step 1: Write failing transport tests**

```ts
await listProjectModules('P1');
await installProjectModule('P1', { release_id: RELEASE_ID, expected_install_revision: 0 }, { idempotencyKey: 'op-1' });
await updateProjectModule('P1', MODULE_ID, { release_id: RELEASE_V2, expected_install_revision: 1 }, { idempotencyKey: 'op-2' });
await rollbackProjectModule('P1', MODULE_ID, { release_id: RELEASE_V1, expected_install_revision: 2 }, { idempotencyKey: 'op-3' });
```

Assert encoded project/module path segments, exact JSON keys, and `Idempotency-Key` forwarding.

- [ ] **Step 2: Run SDK tests and confirm RED**

```powershell
bun test packages/sdk/src/core/rest/projects-client/project-modules.test.ts packages/sdk/src/core/client/kortix.test.ts
```

Expected: FAIL because the client/facade methods are missing.

- [ ] **Step 3: Implement typed wire contracts and facade binding**

Define installation/event/transition/error-safe response types mirroring the API. Keep admin sign/publish calls out of the public SDK. Extend release types only with nullable public signature fields.

- [ ] **Step 4: Refresh public snapshots**

Use the repository snapshot update command, inspect the diff, and confirm it contains only the planned project-module symbols and release metadata.

- [ ] **Step 5: Regenerate route manifest and anonymous coverage**

Run the route dump command used by `apps/api/scripts/dump-routes.ts`. Add every new admin/project route to the route flow; prove anonymous project/admin mutations reject access and public Marketplace list remains readable.

- [ ] **Step 6: Run SDK and route gates**

```powershell
bun test packages/sdk/src/core/rest/projects-client/project-modules.test.ts packages/sdk/src/core/rest/projects-client/developer-modules.test.ts packages/sdk/src/core/client/kortix.test.ts
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd test:routes
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit SDK and route parity**

```powershell
git add -- packages/sdk/src/core/rest/projects-client/project-modules.ts packages/sdk/src/core/rest/projects-client/project-modules.test.ts packages/sdk/src/core/rest/projects-client/developer-modules.ts packages/sdk/src/core/rest/projects-client/developer-modules.test.ts packages/sdk/src/core/rest/projects-client/index.ts packages/sdk/src/core/client/kortix.ts packages/sdk/src/core/client/kortix.test.ts packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json tests/spec/routes.generated.json tests/src/flows/new-routes-coverage.flow.ts
git commit -m "feat(sdk): add project module distribution APIs"
```

---

### Task 9: Web Distribution and Installed-Modules Workbench

**Files:**
- Modify: `apps/web/src/features/developer-center/admin/client.ts`
- Modify: `apps/web/src/features/developer-center/admin/query.ts`
- Modify: `apps/web/src/features/developer-center/admin/review-detail-page.tsx`
- Modify: `apps/web/src/features/developer-center/admin/admin-pages.test.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/release-detail-page.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/publisher-pages.test.tsx`
- Create: `apps/web/src/features/project-modules/client.ts`
- Create: `apps/web/src/features/project-modules/query.ts`
- Create: `apps/web/src/features/project-modules/project-modules-page.tsx`
- Create: `apps/web/src/features/project-modules/project-modules-page.test.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/modules/page.tsx`
- Create: `apps/web/src/features/workspace/project-sidebar/footer/project-modules-nav.tsx`
- Modify: `apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx`
- Modify: `apps/web/translations/en.json`
- Modify: `apps/web/translations/zh.json`
- Modify: `apps/web/translations/de.json`
- Modify: `apps/web/translations/es.json`
- Modify: `apps/web/translations/fr.json`
- Modify: `apps/web/translations/it.json`
- Modify: `apps/web/translations/ja.json`
- Modify: `apps/web/translations/pt.json`

**Interfaces:**
- Consumes: admin private client, Task 8 SDK/project routes, existing status badge/timeline, project sidebar patterns, and current Google-style component primitives.
- Produces: sign/publish controls, publisher-visible signature state, `/projects/:id/modules`, and discoverable Installed Modules navigation.

- [ ] **Step 1: Write failing Admin/Publisher tests**

Assert approved releases show Sign only, signed releases show Publish only, published releases show public signature/key/date, revoked releases disable actions, mutations use current status/revision, and 409 refreshes without replay.

- [ ] **Step 2: Implement Admin/Publisher distribution states**

Add private `signDeveloperModuleRelease` and `publishDeveloperModuleRelease` calls. Reuse current detail invalidation/conflict behavior. Do not place admin methods in `@kortix/sdk`. Extend the shared timeline to render distribution events as distinct immutable entries.

- [ ] **Step 3: Write failing Installed Modules page tests**

Cover empty/loading/error, exact install confirmation, available update target selection, rollback target selection limited to history, revision-conflict refresh, revoked/blocked state, and no controls when project customize-write capability is absent.

- [ ] **Step 4: Implement the project modules workbench**

Use a compact table/list surface with module name/version/status, signature verification status, update availability, and a history drawer. Use `Select` for exact target versions, `AlertDialog` for rollback, icon buttons where conventional, and no nested cards. Keep all remote workflows usable in the browser and unchanged in Electron.

- [ ] **Step 5: Add route, sidebar entry, and translations**

The thin route passes `id` to `ProjectModulesPage`. Add an Installed Modules sidebar entry near project customization/Marketplace. Add the same key shape to all eight locales; English fallback is allowed outside `zh`, but every key must be a non-empty string.

- [ ] **Step 6: Run focused Web gates**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/developer-center src/features/project-modules src/features/workspace/project-sidebar
pnpm.cmd --filter Kortix-Computer-Frontend exec tsc --noEmit
pnpm.cmd --filter Kortix-Computer-Frontend i18n:audit
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the Web workbench**

```powershell
git add -- apps/web/src/features/developer-center apps/web/src/features/project-modules 'apps/web/src/app/(app)/projects/[id]/modules/page.tsx' apps/web/src/features/workspace/project-sidebar/footer/project-modules-nav.tsx apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx apps/web/translations
git commit -m "feat(web): add module distribution workbench"
```

---

### Task 10: Browser Acceptance, Full Gates, and Progress Ledger

**Files:**
- Modify: `apps/web/src/app/(system)/debug/developer-center/page.tsx`
- Modify: `apps/web/scripts/e2e/developer-center-review-smoke.ts`
- Modify: `apps/web/package.json`
- Modify: `docs/operations/studio-acceleration-progress.md`

**Interfaces:**
- Produces: deterministic browser evidence for sign/publish/install/update/rollback/revoke and an honest final progress record.

- [ ] **Step 1: Extend the debug harness without duplicating production pages**

Import the production Admin, Publisher, and Project Modules components. Add intercepted fixtures for approved, signed, published, installed-v1, updated-v2, rolled-back-v1, and revoked states. Reject every unrecognized Developer Center/project-module request.

- [ ] **Step 2: Add named browser assertions**

The smoke must visibly prove:

1. approved release signs once and becomes signed;
2. signed release publishes once and appears in Marketplace module results;
3. published release installs into a project by exact release id;
4. update moves v1 to v2 and increments installation revision;
5. rollback offers only historical published versions and moves v2 to v1;
6. stale 409 refetches without replaying the mutation;
7. emergency revoke blocks new install/update/rollback and marks an active pointer blocked;
8. browser back/forward and direct detail URLs preserve state;
9. desktop and mobile-width screenshots are nonblank, overflow-free, and free of overlapping controls;
10. no Video, Voice, 3D, Digital Human, or Batch Remix product page text appears.

- [ ] **Step 3: Run focused and complete package suites**

```powershell
pnpm.cmd --filter @kortix/db test
pnpm.cmd --filter kortix-api test
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter Kortix-Computer-Frontend test
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter Kortix-Computer-Frontend exec tsc --noEmit
pnpm.cmd test:routes
```

Expected: every command exits 0. Record fresh counts rather than reusing earlier results.

- [ ] **Step 4: Run migration integration and deterministic browser smoke**

Run the repository PostgreSQL migration integration command after confirming local database readiness. Start Web on an unused port, run the extended Developer Center smoke, stop the complete child process tree, and verify the port is closed. Keep mocked-contract browser evidence separate from live database evidence.

- [ ] **Step 5: Run repository-wide baseline**

Run `pnpm.cmd test`. If unchanged platform-specific failures remain, record exact counts and first failure; do not convert a focused pass into a repository-wide claim.

- [ ] **Step 6: Run formatting and diff gates**

```powershell
pnpm.cmd exec biome check apps/api/src/developer apps/api/src/admin/developer-distribution.ts apps/api/src/projects/routes/developer-modules.ts apps/api/src/marketplace/developer-modules.ts packages/sdk/src/core/rest/projects-client/project-modules.ts apps/web/src/features/developer-center apps/web/src/features/project-modules
git diff --check
git status --short
```

Expected: formatting and diff checks exit 0; only the two protected pre-existing documents remain untracked.

- [ ] **Step 7: Update the progress ledger precisely**

Record signing/publication/project activation/update/rollback/revocation as implemented only when Tasks 1-10 evidence passes. Keep arbitrary package execution, automated scanning/sandboxing, metering, settlement, production KMS integration, and production deployment open unless separately proven.

- [ ] **Step 8: Commit acceptance evidence**

```powershell
git add -- 'apps/web/src/app/(system)/debug/developer-center/page.tsx' apps/web/scripts/e2e/developer-center-review-smoke.ts apps/web/package.json docs/operations/studio-acceleration-progress.md
git commit -m "test: cover module distribution lifecycle"
```

## Plan Self-review Checklist

- [x] Every design goal maps to at least one implementation task.
- [x] The plan reflects the current repository: `marketplace/install-session` remains agent-driven and no removed deterministic file installer is restored.
- [x] Signing, publication, revocation, installation, update, and rollback each have explicit state, API, UI, and test coverage.
- [x] Private key custody is outside API requests, responses, logs, audit rows, and PostgreSQL.
- [x] Release revision and installation revision fences cover concurrent mutations and replay.
- [x] Marketplace remains one catalog with an additive published-module source.
- [x] Project/account IAM and existing Admin middleware remain authoritative.
- [x] SDK method names and wire fields are consistent across Tasks 6-9.
- [x] Full package and repository-wide test attempts are included without overstating their evidence.
- [x] Cancelled multimedia pages and the protected `2026-07-21` files remain outside every task.
