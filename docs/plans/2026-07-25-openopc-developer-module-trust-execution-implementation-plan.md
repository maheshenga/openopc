# OpenOPC Developer Module Trust Execution Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, with `test-driven-development` for every behavior change and `verification-before-completion` before every completion claim. Do not use `using-superpowers` or subagent execution for this plan.

**Goal:** Replace manifest-only Developer Center releases with immutable schema-v2 artifacts, automatic trust verification, isolated validation, and artifact-bound schema-2 signatures while preserving existing Kortix application behavior.

**Architecture:** The existing API remains the authenticated control plane and gains additive artifact, verification, and trust-gate ports. A new `apps/developer-trust-worker` process claims durable verification runs, invokes pinned scanner adapters and a narrow sandbox control adapter, and atomically persists sanitized findings plus DSSE/in-toto evidence. Registry, SDK, Web, Marketplace, project installation, and distribution continue through their existing surfaces; no parallel catalog or operations application is introduced.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle/PostgreSQL, S3-compatible object storage, OCI-compatible content-addressed envelopes, CycloneDX 1.6, Syft, Gitleaks, OSV-Scanner, Semgrep, DSSE/in-toto, Ed25519, React/Next.js, TanStack Query, Docker Compose.

**Approved design:** `docs/specs/2026-07-25-openopc-developer-module-trust-execution-design.md`

## Global Constraints

- Replace Registry module schema 1 with `schemaVersion: 2`; do not add a schema-1 reader, conversion helper, feature flag, or downgrade path.
- Accept and verify only module signature payload `schema: 2`; do not preserve the current schema-1 payload.
- Bind every new release to one account-scoped immutable artifact digest that covers the normalized Registry Item, every blob digest, paths, entries, dependencies, and deterministic lock graph.
- `source_scan` and `sandbox_test` are system evidence. Publisher or administrator requests may contain human evidence only.
- Keep untrusted bytes out of the Web, API, database, and worker control process; scanner and module execution happens through bounded process/sandbox adapters.
- Give validation containers only a short-lived verification capability for synthetic fixtures; never provide project, sandbox, Connector, Secret, billing, provider, or desktop credentials.
- Fail closed on unavailable, crashed, timed-out, cancelled, stale, inconclusive, or digest-mismatched verification.
- Keep the trust worker and code-bearing submission disabled by default until all acceptance gates have recorded evidence.
- Preserve existing Kortix project, session, Agent, sandbox, IAM, billing, Marketplace, installation, update, rollback, revocation, and declarative-read behavior.
- Keep Git-native Registry canonical and the existing Developer Center as the sole publisher/admin surface.
- Do not reintroduce first-party image, video, voice, 3D, digital-human, or batch-remix product pages.
- Arbitrary production module execution, metering, settlement, production KMS, production deployment, and production acceptance are outside this plan and must remain unclaimed.
- Hosted and self-hosted deployments use the same artifact, policy, evidence, and sandbox-port contracts.
- Do not edit or stage `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md` or `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`.

## File and Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Registry contract | `packages/registry/src/schema.ts`, `module-manifest.ts`, `module-artifact.ts`, `module-artifact.test.ts`, `index.ts` | Schema v2, verification profile validation, canonical envelope and digest vectors |
| Persistence | `packages/db/migrations/20260725120000000_developer_module_trust.sql`, `packages/db/src/schema/kortix.ts`, `packages/db/src/developer-module-trust-schema.test.ts` | Artifact/upload/run/finding/attestation/capability tables, release binding, grants and immutability |
| Artifact control plane | `apps/api/src/developer/artifacts.ts`, `artifacts.drizzle.ts`, `artifacts.s3.ts`, matching tests, `releases.ts`, `releases.drizzle.ts`, `app.ts`, `index.ts` | Account-scoped upload/finalize/cancel, declarative artifact creation and release binding |
| Verification domain | `apps/api/src/developer/verification.ts`, `verification.drizzle.ts`, matching tests, `trust-gate.ts`, `trust-gate.test.ts` | Run state machine, leases, retry/cancel, safe read models, current-evidence decision |
| Distribution | `apps/api/src/developer/module-signing.ts`, `distribution.ts`, `installations.ts` and tests | Schema-2 signing, publish/install/update/rollback verification and revocation |
| Worker | `apps/developer-trust-worker/**` | Policy, scanners, SBOM, DSSE/in-toto, sandbox, capability broker, egress and readiness |
| Review | `apps/api/src/developer/reviews.ts`, `reviews.drizzle.ts`, admin routes and tests | Human-only request evidence plus server-owned automatic trust gate |
| SDK | `packages/sdk/src/core/rest/projects-client/developer-modules.ts`, `developer-modules.test.ts`, SDK exports | Typed artifact, release, trust timeline and retry APIs |
| Web | `apps/web/src/features/developer-center/**`, `apps/web/scripts/e2e/developer-center-review-smoke.ts` | Publisher upload/progress/findings and admin immutable evidence/blocked actions |
| Operations | `scripts/compose/docker-compose.yml`, `apps/developer-trust-worker/Dockerfile`, `docs/operations/developer-module-trust-runbook.md`, `docs/operations/developer-module-trust-progress.md` | Disabled-by-default deployment, readiness, evidence ledger and rollback |

---

### Task 1: Registry schema v2 and canonical artifact envelope

**Files:**
- Modify: `packages/registry/src/schema.ts`
- Modify: `packages/registry/src/module-manifest.ts`
- Modify: `packages/registry/src/module-manifest.test.ts`
- Create: `packages/registry/src/module-artifact.ts`
- Create: `packages/registry/src/module-artifact.test.ts`
- Modify: `packages/registry/src/index.ts`

**Interfaces:**
- Produces: `RegistryModuleVerificationProfile`, `RegistryModuleArtifactDescriptor`, `RegistryModuleArtifactEnvelope`, `ResolvedRegistryModuleFile`, `canonicalRegistryModuleArtifactDescriptor()`, and `registryModuleArtifactDigest()`.
- Consumers: Tasks 3, 4, 6, and 9 import these types and canonical functions; none may implement a second canonicalizer.

- [ ] **Step 1: Write failing schema-v2 and digest-vector tests**

Add test vectors that prove schema 1 is rejected, every non-declarative mode requires its exact profile, and changing any byte/path/entry/dependency/lock value changes the digest:

```ts
test('accepts schema v2 and rejects schema v1 without fallback', () => {
  expect(validateRegistryModuleManifest(v2Manifest('agent', 'agent-project')).valid).toBe(true);
  expect(validateRegistryModuleManifest({ ...v2Manifest('agent', 'agent-project'), schemaVersion: 1 }).issues)
    .toContainEqual(expect.objectContaining({ path: 'schemaVersion', severity: 'error' }));
});

test.each([
  ['agent', 'agent-project'],
  ['sandboxed-web', 'sandboxed-web'],
  ['server-adapter', 'server-conformance'],
  ['desktop-native', 'desktop-package'],
] as const)('%s requires verification profile %s', (mode, profile) => {
  expect(validateRegistryModuleManifest(v2Manifest(mode, profile)).valid).toBe(true);
  expect(validateRegistryModuleManifest(v2Manifest(mode, 'declarative')).valid).toBe(false);
});

test('artifact digest commits to all installable inputs', () => {
  const base = artifactFixture();
  const digest = registryModuleArtifactDigest(base);
  for (const changed of artifactMutations(base)) {
    expect(registryModuleArtifactDigest(changed)).not.toBe(digest);
  }
});
```

- [ ] **Step 2: Run the focused Registry tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter @kortix/registry exec bun test src/module-manifest.test.ts src/module-artifact.test.ts
```

Expected: FAIL because schema 1 is still accepted and `module-artifact.ts` does not exist.

- [ ] **Step 3: Replace the manifest contract and add the canonical artifact types**

Use these exported types and constants exactly:

```ts
export const REGISTRY_MODULE_SCHEMA_VERSION = 2 as const;

export type RegistryModuleVerificationProfile =
  | 'declarative'
  | 'agent-project'
  | 'sandboxed-web'
  | 'server-conformance'
  | 'desktop-package';

export const DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE =
  'application/vnd.openopc.developer-module.v2+json' as const;

export interface ResolvedRegistryModuleFile {
  path: string;
  target: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface RegistryModuleArtifactBlobDescriptor {
  path: string;
  target: string;
  mediaType: string;
  size: number;
  digest: `sha256:${string}`;
}

export interface RegistryModuleArtifactDescriptor {
  artifactFormatVersion: 2;
  mediaType: typeof DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE;
  item: RegistryItem;
  module: {
    id: string;
    version: string;
    publisherId: string;
    category: string;
    executionMode: RegistryModuleExecutionMode;
  };
  blobs: RegistryModuleArtifactBlobDescriptor[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  registryDependencies: Record<string, string>;
  lockGraph: RegistryModuleLockGraph | null;
  lockDigest: `sha256:${string}` | null;
  entries: Record<string, string>;
  uiEntries: Record<string, string>;
  source: RegistryModuleSourceProvenance | null;
}

export interface RegistryModuleArtifactEnvelope {
  descriptor: RegistryModuleArtifactDescriptor;
  descriptorDigest: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
}
```

The validator must normalize separators to `/`; sort object keys and blob descriptors by `(path,target)`; reject absolute paths, `..`, empty segments, `:`, Windows device names, duplicate or case-fold-colliding paths, symlink/hardlink metadata, undeclared blobs, unsupported lock nodes, floating dependency ranges, and profile/mode mismatches. Declarative modules may omit `verification`; if supplied it must be `{ profile: 'declarative' }`. All other modes require `verification.profile` and the exact mode/profile mapping above.

- [ ] **Step 4: Implement one canonical byte function and one digest function**

```ts
export function canonicalRegistryModuleArtifactDescriptor(
  descriptor: RegistryModuleArtifactDescriptor,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(normalizeArtifactDescriptor(descriptor)));
}

export function registryModuleArtifactDigest(
  envelope: Pick<RegistryModuleArtifactEnvelope, 'descriptor'>,
): `sha256:${string}` {
  return sha256Digest(canonicalRegistryModuleArtifactDescriptor(envelope.descriptor));
}
```

`canonicalJson`, `normalizeArtifactDescriptor`, and `sha256Digest` remain private to `module-artifact.ts`. The descriptor contains every blob digest, so the artifact digest commits to every file byte without concatenating unbounded files in memory.

- [ ] **Step 5: Run Registry tests and typecheck**

Run:

```powershell
pnpm.cmd --filter @kortix/registry test
pnpm.cmd --filter @kortix/registry typecheck
git diff --check
```

Expected: all Registry tests pass, typecheck exits 0, and diff check has no output.

- [ ] **Step 6: Commit the Registry contract**

```powershell
git add packages/registry/src/schema.ts packages/registry/src/module-manifest.ts packages/registry/src/module-manifest.test.ts packages/registry/src/module-artifact.ts packages/registry/src/module-artifact.test.ts packages/registry/src/index.ts
git diff --cached --check
git commit -m "feat(registry): replace module contract with schema v2 artifacts"
```

---

### Task 2: Artifact persistence, release binding, and migration safety

**Files:**
- Create: `packages/db/migrations/20260725120000000_developer_module_trust.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/src/developer-module-trust-schema.test.ts`

**Interfaces:**
- Produces: Drizzle exports `developerModuleArtifactUploads`, `developerModuleArtifacts`, `developerModuleVerificationRuns`, `developerModuleVerificationFindings`, `developerModuleTrustAttestations`, and `developerModuleVerificationCapabilities`.
- Consumers: Task 3 repositories consume upload/artifact tables; Tasks 5-8 consume verification tables and account-qualified keys.

- [ ] **Step 1: Write failing migration/schema tests**

Assert the migration contains the reset preflight, all composite tenant keys, immutable terminal evidence, leases, conditional release trust constraint, grants, and no schema-1 preservation statement:

```ts
test('developer trust migration fails clearly for existing signed or published rows', () => {
  expect(sql).toContain('OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED');
  expect(sql).toContain("status IN ('signed', 'published')");
});

test('all trust children use account-qualified foreign keys', () => {
  for (const constraint of [
    'developer_module_artifacts_artifact_account_unique',
    'developer_module_verification_runs_release_account_fk',
    'developer_module_verification_findings_run_account_fk',
    'developer_module_trust_attestations_run_account_fk',
    'developer_module_verification_capabilities_run_account_fk',
  ]) expect(sql).toContain(constraint);
});
```

- [ ] **Step 2: Run the DB test and confirm RED**

Run:

```powershell
pnpm.cmd --filter @kortix/db exec bun test src/developer-module-trust-schema.test.ts
```

Expected: FAIL because the migration and Drizzle exports do not exist.

- [ ] **Step 3: Add the migration preflight and persistence model**

The migration must begin with this exact fail-closed preflight:

```sql
DO $developer_trust$
BEGIN
  IF EXISTS (
    SELECT 1 FROM kortix.developer_module_releases
    WHERE status IN ('signed', 'published')
       OR signature_payload_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED: schema-1 signed or published developer releases are unsupported; reset the development database before applying this migration';
  END IF;
END
$developer_trust$;
```

Create the following tables with UUID primary keys, `account_id uuid NOT NULL`, timestamps, regex checks for every digest (`^sha256:[0-9a-f]{64}$`), bounded JSON checks, and the listed uniqueness fences:

```sql
CREATE TYPE kortix.developer_artifact_upload_state AS ENUM
  ('created', 'uploaded', 'finalized', 'cancelled', 'expired');
CREATE TYPE kortix.developer_verification_state AS ENUM
  ('queued', 'running', 'passed', 'failed', 'inconclusive', 'cancelled');
CREATE TYPE kortix.developer_finding_severity AS ENUM
  ('info', 'low', 'medium', 'high', 'critical');

CREATE TABLE kortix.developer_module_artifact_uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  publisher_id varchar(63) NOT NULL,
  state kortix.developer_artifact_upload_state NOT NULL DEFAULT 'created',
  expected_digest varchar(71) NOT NULL CHECK (expected_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_size bigint NOT NULL CHECK (expected_size BETWEEN 1 AND 536870912),
  staging_storage_key text NOT NULL CHECK (octet_length(staging_storage_key) BETWEEN 1 AND 2048),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, account_id),
  FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id) ON DELETE RESTRICT
);

CREATE TABLE kortix.developer_module_artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  publisher_id varchar(63) NOT NULL,
  artifact_digest varchar(71) NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  envelope_digest varchar(71) NOT NULL CHECK (envelope_digest ~ '^sha256:[0-9a-f]{64}$'),
  storage_key text NOT NULL CHECK (octet_length(storage_key) BETWEEN 1 AND 2048),
  media_type varchar(128) NOT NULL CHECK (media_type = 'application/vnd.openopc.developer-module.v2+json'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 536870912),
  item_snapshot jsonb NOT NULL CHECK (jsonb_typeof(item_snapshot) = 'object' AND pg_column_size(item_snapshot) <= 1048576),
  source_provenance jsonb CHECK (source_provenance IS NULL OR jsonb_typeof(source_provenance) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_artifacts_artifact_account_unique UNIQUE (artifact_id, account_id),
  CONSTRAINT developer_module_artifacts_account_digest_unique UNIQUE (account_id, artifact_digest),
  FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id) ON DELETE RESTRICT
);
```

The same migration creates verification runs, findings, attestations, and capabilities with these fences: `(run_id, account_id)`, `(release_id, policy_digest, attempt)`, one partial unique active run for states `queued`/`running`, `(run_id, fingerprint)`, `(run_id, attestation_digest)`, and `(capability_id, run_id, account_id)`. Capabilities store `token_hash`, never plaintext, plus audience, nonce hash, call/byte limits, expiry, revocation, and usage counters. Add append-only triggers for artifacts, findings, terminal runs, and attestations; allow only lease/heartbeat changes while a run is active.

- [ ] **Step 4: Bind releases without preserving schema-1 trust**

Add nullable columns so unsigned local rows can remain visible but can never pass the new gate:

```sql
ALTER TABLE kortix.developer_module_releases
  ADD COLUMN artifact_id uuid,
  ADD COLUMN artifact_digest varchar(71),
  ADD COLUMN sbom_digest varchar(71),
  ADD COLUMN trust_attestation_digest varchar(71),
  ADD COLUMN verification_policy_digest varchar(71),
  ADD CONSTRAINT developer_module_releases_artifact_account_fk
    FOREIGN KEY (artifact_id, account_id)
    REFERENCES kortix.developer_module_artifacts(artifact_id, account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT developer_module_releases_trust_before_distribution_check CHECK (
    status NOT IN ('signed', 'published') OR (
      artifact_id IS NOT NULL
      AND artifact_digest ~ '^sha256:[0-9a-f]{64}$'
      AND sbom_digest ~ '^sha256:[0-9a-f]{64}$'
      AND trust_attestation_digest ~ '^sha256:[0-9a-f]{64}$'
      AND verification_policy_digest ~ '^sha256:[0-9a-f]{64}$'
    )
  );
```

Extend `kortix.protect_developer_module_release_content()` so artifact identity cannot change after insert. Revoke all new tables from `PUBLIC`, `anon`, and `authenticated`; grant the API service role only its required read/insert/update columns. Create a distinct `developer_trust_worker` database role with claim/heartbeat/finalize permissions only; it must have no account, project, Secret, Connector, billing, or session table grants.

- [ ] **Step 5: Mirror every SQL constraint in Drizzle and run migration gates**

Run:

```powershell
pnpm.cmd --filter @kortix/db test
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter @kortix/db migrate:lint
pnpm.cmd --filter @kortix/db migrate:status
git diff --check
```

Expected: DB tests/typecheck/lint pass. Migration status lists `20260725120000000_developer_module_trust.sql` as pending before application and applied after the controlled migration acceptance run in Task 10.

- [ ] **Step 6: Commit the persistence contract**

```powershell
git add packages/db/migrations/20260725120000000_developer_module_trust.sql packages/db/src/schema/kortix.ts packages/db/src/developer-module-trust-schema.test.ts
git diff --cached --check
git commit -m "feat(db): add immutable developer module trust records"
```

---

### Task 3: Account-scoped artifact upload, finalization, and release submission

**Files:**
- Create: `apps/api/src/developer/artifacts.ts`
- Create: `apps/api/src/developer/artifacts.test.ts`
- Create: `apps/api/src/developer/artifacts.drizzle.ts`
- Create: `apps/api/src/developer/artifacts.drizzle.test.ts`
- Create: `apps/api/src/developer/artifacts.s3.ts`
- Create: `apps/api/src/developer/artifacts.s3.test.ts`
- Modify: `apps/api/src/developer/releases.ts`
- Modify: `apps/api/src/developer/releases.test.ts`
- Modify: `apps/api/src/developer/releases.drizzle.ts`
- Modify: `apps/api/src/developer/releases.drizzle.test.ts`
- Modify: `apps/api/src/developer/app.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/developer/index.test.ts`

**Interfaces:**
- Consumes: Task 1 artifact canonicalizer and Task 2 artifact/upload tables.
- Produces: `DeveloperArtifactStore`, `DeveloperModuleArtifactService`, finalized `DeveloperModuleArtifact`, and release submission `{ artifact_id }`.

- [ ] **Step 1: Write failing service and route tests**

Cover declarative synthesis, upload create/finalize/cancel, checksum/size/path failure cleanup, expiry, account substitution, idempotent finalize, unavailable store, and raw executable item rejection:

```ts
test('submits a release only from a finalized artifact in the same account', async () => {
  const artifact = await service.finalizeUpload(finalizeInput());
  await expect(releases.submit({ accountId: ACCOUNT_A, artifactId: artifact.artifact_id, actorUserId: USER }))
    .resolves.toMatchObject({ created: true, release: { artifact_digest: artifact.artifact_digest } });
  await expect(releases.submit({ accountId: ACCOUNT_B, artifactId: artifact.artifact_id, actorUserId: USER }))
    .rejects.toMatchObject({ code: 'DEVELOPER_ARTIFACT_NOT_FOUND' });
});

test('never creates a release when finalization checksum fails', async () => {
  store.head.mockResolvedValue({ size: 10, digest: `sha256:${'f'.repeat(64)}` });
  await expect(service.finalizeUpload(finalizeInput())).rejects.toMatchObject({
    code: 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH',
  });
  expect(repository.insertArtifact).not.toHaveBeenCalled();
  expect(store.deleteStaging).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run focused API tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/artifacts.test.ts src/developer/artifacts.drizzle.test.ts src/developer/artifacts.s3.test.ts src/developer/releases.test.ts src/developer/index.test.ts
```

Expected: FAIL because artifact ports/routes and `artifact_id` release submission do not exist.

- [ ] **Step 3: Implement the narrow storage and service contracts**

```ts
export interface DeveloperArtifactStore {
  createUpload(input: {
    accountId: string;
    uploadId: string;
    expectedSize: number;
    expectedDigest: `sha256:${string}`;
    expiresAt: Date;
  }): Promise<{ storageKey: string; uploadUrl: string; headers: Record<string, string> }>;
  headStaging(storageKey: string): Promise<{ size: number; digest: `sha256:${string}` }>;
  readStaging(storageKey: string, limits: ArtifactReadLimits): AsyncIterable<Uint8Array>;
  commit(input: { stagingKey: string; accountId: string; artifactDigest: string }): Promise<string>;
  deleteStaging(storageKey: string): Promise<void>;
}

export interface CreateDeveloperArtifactUploadInput {
  accountId: string;
  publisherId: string;
  expectedSize: number;
  expectedDigest: `sha256:${string}`;
  actorUserId: string;
}
```

The S3 adapter must use a private bucket, an opaque account-scoped key, a five-minute signed PUT, fixed content length and SHA-256 metadata, no public ACL, and server-side encryption. Responses never expose the storage key, bucket, cross-account dedupe, or internal endpoint.

- [ ] **Step 4: Replace raw-item release submission with artifact binding**

Expose these publisher routes through the existing Developer Center middleware:

```text
POST   /developer/modules/artifacts/declarative
POST   /developer/modules/artifact-uploads
POST   /developer/modules/artifact-uploads/:uploadId/finalize
DELETE /developer/modules/artifact-uploads/:uploadId
GET    /developer/modules/artifacts/:artifactId
POST   /developer/modules/releases                 body: { account_id?, artifact_id }
```

`releases.submit()` loads the finalized artifact with `(account_id, artifact_id)`, revalidates its schema-v2 item snapshot, verifies publisher membership/namespace/version, inserts immutable release/read-model fields, and queues one verification run in the same database transaction. A body containing `item` must return `DEVELOPER_RELEASE_ARTIFACT_REQUIRED` with HTTP 400.

- [ ] **Step 5: Run API artifact tests, route coverage, and typecheck**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/artifacts.test.ts src/developer/artifacts.drizzle.test.ts src/developer/artifacts.s3.test.ts src/developer/releases.test.ts src/developer/releases.drizzle.test.ts src/developer/index.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

Expected: focused tests pass; typecheck exits 0; account-substitution tests return the same 404 code as a missing artifact.

- [ ] **Step 6: Commit the artifact control plane**

```powershell
git add apps/api/src/developer/artifacts.ts apps/api/src/developer/artifacts.test.ts apps/api/src/developer/artifacts.drizzle.ts apps/api/src/developer/artifacts.drizzle.test.ts apps/api/src/developer/artifacts.s3.ts apps/api/src/developer/artifacts.s3.test.ts apps/api/src/developer/releases.ts apps/api/src/developer/releases.test.ts apps/api/src/developer/releases.drizzle.ts apps/api/src/developer/releases.drizzle.test.ts apps/api/src/developer/app.ts apps/api/src/developer/index.ts apps/api/src/developer/index.test.ts
git diff --cached --check
git commit -m "feat(api): bind developer releases to finalized artifacts"
```

---

### Task 4: Replace module signatures with artifact-bound schema 2

**Files:**
- Modify: `apps/api/src/developer/module-signing.ts`
- Modify: `apps/api/src/developer/module-signing.test.ts`
- Modify: `apps/api/src/developer/distribution.ts`
- Modify: `apps/api/src/developer/distribution.test.ts`
- Modify: `apps/api/src/developer/distribution.drizzle.ts`
- Modify: `apps/api/src/developer/distribution.drizzle.test.ts`
- Modify: `apps/api/src/developer/installations.ts`
- Modify: `apps/api/src/developer/installations.test.ts`

**Interfaces:**
- Consumes: release artifact/trust digests from Tasks 2-3.
- Produces: `DeveloperModuleSignaturePayloadV2`, `canonicalDeveloperModuleSignaturePayloadV2()`, and one verification path used by publish/install/update/rollback.

- [ ] **Step 1: Write failing signature and tamper tests**

```ts
test('schema-2 signature changes for every trust-bound digest', () => {
  const base = signaturePayloadV2();
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(base);
  for (const key of ['artifact_digest', 'manifest_digest', 'sbom_digest', 'trust_attestation_digest', 'verification_policy_digest'] as const) {
    expect(canonicalDeveloperModuleSignaturePayloadV2({ ...base, [key]: `sha256:${'e'.repeat(64)}` })).not.toEqual(bytes);
  }
});

test('has no schema-1 decoder or fallback', async () => {
  await expect(service.publish(releaseWithSchema1Signature())).rejects.toMatchObject({
    code: 'DEVELOPER_MODULE_SIGNATURE_INVALID',
  });
});
```

- [ ] **Step 2: Run focused distribution tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/module-signing.test.ts src/developer/distribution.test.ts src/developer/installations.test.ts
```

Expected: FAIL because the current payload is schema 1 and omits trust digests.

- [ ] **Step 3: Replace the payload implementation**

```ts
export interface DeveloperModuleSignaturePayloadV2 {
  schema: 2;
  module_id: string;
  module_version: string;
  publisher_id: string;
  artifact_digest: `sha256:${string}`;
  manifest_digest: `sha256:${string}`;
  sbom_digest: `sha256:${string}`;
  trust_attestation_digest: `sha256:${string}`;
  verification_policy_digest: `sha256:${string}`;
}

export function canonicalDeveloperModuleSignaturePayloadV2(
  payload: DeveloperModuleSignaturePayloadV2,
): Uint8Array {
  assertExactSignatureV2(payload);
  return new TextEncoder().encode(JSON.stringify(payload));
}
```

Delete the schema-1 type/function and the manifest-only declarative reconstruction. `assertExactSignatureV2` rejects missing/extra fields, any schema other than numeric `2`, and malformed SHA-256 digests.

- [ ] **Step 4: Use one distribution verifier for every downstream operation**

Create `verifyDeveloperModuleReleaseTrustSignature(release, verifier)` and call it from publish, install, update, and rollback. It must re-hash the current manifest, compare all five persisted digests, verify the Ed25519 bytes, and reject revoked/non-published releases. This task removes the old `isDistributableDeclarativeModule()` limitation but does not execute installed code.

- [ ] **Step 5: Run distribution/install regression tests**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/module-signing.test.ts src/developer/distribution.test.ts src/developer/distribution.drizzle.test.ts src/developer/installations.test.ts src/developer/installations.drizzle.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

Expected: schema-2 tests pass; tampering any bound digest blocks publication and installation; existing revocation and rollback assertions still pass.

- [ ] **Step 6: Commit schema-2 distribution**

```powershell
git add apps/api/src/developer/module-signing.ts apps/api/src/developer/module-signing.test.ts apps/api/src/developer/distribution.ts apps/api/src/developer/distribution.test.ts apps/api/src/developer/distribution.drizzle.ts apps/api/src/developer/distribution.drizzle.test.ts apps/api/src/developer/installations.ts apps/api/src/developer/installations.test.ts
git diff --cached --check
git commit -m "feat(api): replace module signatures with trust schema 2"
```

---

### Task 5: Verification lifecycle, leases, findings, attestations, and read APIs

**Files:**
- Create: `apps/api/src/developer/verification.ts`
- Create: `apps/api/src/developer/verification.test.ts`
- Create: `apps/api/src/developer/verification.drizzle.ts`
- Create: `apps/api/src/developer/verification.drizzle.test.ts`
- Create: `apps/api/src/developer/trust-gate.ts`
- Create: `apps/api/src/developer/trust-gate.test.ts`
- Modify: `apps/api/src/developer/app.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/admin/developer-reviews.ts`
- Modify: `apps/api/src/admin/developer-reviews.test.ts`

**Interfaces:**
- Produces: `DeveloperModuleVerificationRepository`, `DeveloperModuleVerificationService`, `DeveloperModuleTrustGate`, `DeveloperModuleTrustView`, and worker claim/finalize records.
- Consumers: Tasks 6-8 use the repository and trust gate; Task 9 consumes only the safe public/admin views.

- [ ] **Step 1: Write failing lifecycle and tenancy tests**

Cover valid transitions, attempts, active uniqueness, `SKIP LOCKED`, heartbeat, expired-lease reclaim, stale fencing, terminal idempotency, atomic attestation finalization, policy staleness, retry/cancel authorization, safe findings, and identifier substitution:

```ts
test('a stale worker cannot finalize after its lease fence expires', async () => {
  const first = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
  clock.advance(31_000);
  const second = await repository.claim({ workerId: 'worker-b', leaseMs: 30_000 });
  await expect(repository.finalize({ ...passedResult(first), leaseToken: first.leaseToken }))
    .rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_LEASE_LOST' });
  await expect(repository.finalize({ ...passedResult(second), leaseToken: second.leaseToken }))
    .resolves.toMatchObject({ state: 'passed' });
});

test('cross-account trust identifiers reveal no existence', async () => {
  await expect(service.getTrustView({ accountId: ACCOUNT_B, releaseId: RELEASE_A }))
    .rejects.toMatchObject({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 });
});
```

- [ ] **Step 2: Run verification tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/verification.test.ts src/developer/verification.drizzle.test.ts src/developer/trust-gate.test.ts
```

Expected: FAIL because the verification domain does not exist.

- [ ] **Step 3: Implement the exact state and repository contracts**

```ts
export type DeveloperModuleVerificationState =
  | 'queued' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'cancelled';

export interface DeveloperModuleVerificationClaim {
  runId: string;
  releaseId: string;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface DeveloperModuleVerificationRepository {
  enqueue(input: EnqueueVerificationInput): Promise<DeveloperModuleVerificationRun>;
  claim(input: { workerId: string; leaseMs: number }): Promise<DeveloperModuleVerificationClaim | null>;
  heartbeat(input: { runId: string; workerId: string; leaseToken: string; leaseMs: number }): Promise<void>;
  finalize(input: FinalizeVerificationInput): Promise<DeveloperModuleVerificationRun>;
  retry(input: RetryVerificationInput): Promise<DeveloperModuleVerificationRun>;
  cancel(input: CancelVerificationInput): Promise<DeveloperModuleVerificationRun>;
  getPublisherView(accountId: string, releaseId: string): Promise<DeveloperModuleTrustView | null>;
  getAdminView(releaseId: string): Promise<DeveloperModuleTrustView | null>;
}
```

The Drizzle claim uses `FOR UPDATE SKIP LOCKED`; lease tokens are random 256-bit values stored only as hashes. Finalization locks the run, verifies owner/token/expiry/policy/artifact/scanner digests, inserts bounded findings and one immutable attestation, sets terminal state/digests, and revokes capabilities in one transaction. Replaying the identical finalization returns the original terminal row; differing replay returns `DEVELOPER_VERIFICATION_ALREADY_FINALIZED`.

- [ ] **Step 4: Implement safe publisher/admin APIs and trust gate**

Publisher routes:

```text
GET  /developer/modules/releases/:releaseId/trust
POST /developer/modules/releases/:releaseId/verification-retries
```

Admin routes:

```text
GET  /admin/api/developer/modules/releases/:releaseId/trust
POST /admin/api/developer/modules/releases/:releaseId/verification-retries
POST /admin/api/developer/modules/releases/:releaseId/verification-cancellations
```

`DeveloperModuleTrustView` exposes artifact/provenance metadata, attempt timeline, scanner identities, sanitized findings, SBOM metadata and attestation digest; it excludes storage keys, signed URLs, raw source, raw logs, tokens, scanner command lines, and credentials. `DeveloperModuleTrustGate.evaluate(release)` returns `{ ok: true, evidence }` only when the latest required attempt is `passed`, all digests match the release/current immutable policy, the attestation subject matches the artifact, and no high/critical blocking finding exists. Every other state returns a stable unmet condition.

- [ ] **Step 5: Run verification, route, and type gates**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/verification.test.ts src/developer/verification.drizzle.test.ts src/developer/trust-gate.test.ts src/admin/developer-reviews.test.ts src/developer/index.test.ts
pnpm.cmd --filter kortix-api typecheck
git diff --check
```

Expected: lifecycle/lease/atomicity/tenant tests pass and route tests prove publisher/admin boundary separation.

- [ ] **Step 6: Commit the verification control plane**

```powershell
git add apps/api/src/developer/verification.ts apps/api/src/developer/verification.test.ts apps/api/src/developer/verification.drizzle.ts apps/api/src/developer/verification.drizzle.test.ts apps/api/src/developer/trust-gate.ts apps/api/src/developer/trust-gate.test.ts apps/api/src/developer/app.ts apps/api/src/developer/index.ts apps/api/src/admin/developer-reviews.ts apps/api/src/admin/developer-reviews.test.ts
git diff --cached --check
git commit -m "feat(api): add developer verification lifecycle and trust views"
```

---

### Task 6: Dedicated trust worker, scanners, SBOM, and DSSE/in-toto evidence

**Files:**
- Create: `apps/developer-trust-worker/package.json`
- Create: `apps/developer-trust-worker/tsconfig.json`
- Create: `apps/developer-trust-worker/src/config.ts`
- Create: `apps/developer-trust-worker/src/policy.ts`
- Create: `apps/developer-trust-worker/src/policy.test.ts`
- Create: `apps/developer-trust-worker/src/scanners/types.ts`
- Create: `apps/developer-trust-worker/src/scanners/process-adapter.ts`
- Create: `apps/developer-trust-worker/src/scanners/process-adapter.test.ts`
- Create: `apps/developer-trust-worker/src/scanners/gitleaks.ts`
- Create: `apps/developer-trust-worker/src/scanners/syft.ts`
- Create: `apps/developer-trust-worker/src/scanners/osv.ts`
- Create: `apps/developer-trust-worker/src/scanners/semgrep.ts`
- Create: `apps/developer-trust-worker/src/scanners/license-policy.ts`
- Create: `apps/developer-trust-worker/src/scanners/scanners.test.ts`
- Create: `apps/developer-trust-worker/src/attestation.ts`
- Create: `apps/developer-trust-worker/src/attestation.test.ts`
- Create: `apps/developer-trust-worker/src/pipeline.ts`
- Create: `apps/developer-trust-worker/src/pipeline.test.ts`
- Create: `apps/developer-trust-worker/src/index.ts`
- Create: `apps/developer-trust-worker/src/index.test.ts`

**Interfaces:**
- Consumes: Task 1 artifact canonicalization and Task 5 claim/finalize contract.
- Produces: `DeveloperTrustPolicyV1`, scanner adapters, deterministic CycloneDX 1.6 output, DSSE/in-toto attestation, and `DeveloperTrustPipeline.run()`.

- [ ] **Step 1: Write failing clean/failure/redaction fixtures**

Tests must cover clean and vulnerable lock graphs, secret fixtures, scanner crash, malformed output, timeout, policy mismatch, deterministic SBOM/attestation vectors, optional Sigstore bundle validation, and log/error redaction:

```ts
test('clean fixture creates deterministic CycloneDX and DSSE evidence', async () => {
  const first = await pipeline.run(cleanClaim());
  const second = await pipeline.run(cleanClaim());
  expect(first.state).toBe('passed');
  expect(first.sbomDigest).toBe(second.sbomDigest);
  expect(first.attestationDigest).toBe(second.attestationDigest);
  expect(first.attestation.payloadType).toBe('application/vnd.in-toto+json');
});

test.each(['secret', 'vulnerability', 'scanner-crash', 'malformed-output'] as const)(
  '%s cannot produce a passing attestation',
  async (fixture) => expect(await pipeline.run(claimFor(fixture))).not.toMatchObject({ state: 'passed' }),
);
```

- [ ] **Step 2: Run worker tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter @openopc/developer-trust-worker test
```

Expected: FAIL because the workspace application does not exist.

- [ ] **Step 3: Define immutable policy and scanner adapters**

```ts
export interface DeveloperTrustPolicyV1 {
  schema: 1;
  policyId: string;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  scanners: ReadonlyArray<{
    name: 'gitleaks' | 'syft' | 'osv-scanner' | 'semgrep' | 'license-policy';
    executable: string;
    imageDigest: `sha256:${string}`;
    version: string;
    ruleDigest: `sha256:${string}`;
    timeoutMs: number;
    maxOutputBytes: number;
  }>;
  advisorySnapshot: string;
  sandboxProfiles: Readonly<Record<RegistryModuleVerificationProfile, SandboxProfilePolicy>>;
  blockingSeverities: readonly ['critical', 'high'];
}

export interface DeveloperScannerAdapter {
  readonly name: string;
  verifyIdentity(policy: DeveloperTrustPolicyV1): Promise<void>;
  scan(input: ScannerInput, signal: AbortSignal): Promise<ScannerResult>;
}
```

`process-adapter.ts` spawns a configured pinned executable with an argument array, an empty allow-listed environment, closed stdin, bounded stdout/stderr, timeout/cancellation, and a temporary per-run workspace. It never uses a shell. Any missing executable, identity mismatch, non-zero undocumented exit, timeout, truncated/malformed result, or unavailable advisory snapshot returns `inconclusive`, not `passed`.

- [ ] **Step 4: Generate deterministic trust evidence and run the pipeline**

Syft output is normalized to CycloneDX JSON with `bomFormat: 'CycloneDX'`, `specVersion: '1.6'`, stable component ordering, no wall-clock serial/timestamp fields, and PURLs/hashes from the lock graph. Build this in-toto predicate and wrap it in DSSE:

```ts
export interface OpenOpcDeveloperTrustPredicateV1 {
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  runId: string;
  attempt: number;
  result: 'passed' | 'failed' | 'inconclusive' | 'cancelled';
  evidenceDigests: readonly `sha256:${string}`[];
  startedAt: string;
  finishedAt: string;
}
```

The in-toto subject name is `${moduleId}@${moduleVersion}` and digest is the artifact SHA-256 hex. DSSE PAE bytes are `DSSEv1 <payloadTypeLength> <payloadType> <payloadLength> <payload>`. Sign with the configured worker evidence issuer key; store raw bounded scanner output only in ephemeral workspace, never in the attestation, database, logs, or API error.

- [ ] **Step 5: Run worker tests and typecheck**

Run:

```powershell
pnpm.cmd --filter @openopc/developer-trust-worker test
pnpm.cmd --filter @openopc/developer-trust-worker typecheck
git diff --check
```

Expected: all fake-adapter tests pass deterministically; scanner crash/unavailability is inconclusive; secret/vulnerability fixtures fail; no fixture secret appears in captured logs/errors.

- [ ] **Step 6: Commit the trust worker pipeline**

```powershell
git add apps/developer-trust-worker/package.json apps/developer-trust-worker/tsconfig.json apps/developer-trust-worker/src pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(worker): add automated developer module trust pipeline"
```

---

### Task 7: Hardened sandbox, verification capability broker, and egress policy

**Files:**
- Create: `apps/developer-trust-worker/src/sandbox/types.ts`
- Create: `apps/developer-trust-worker/src/sandbox/oci-control.ts`
- Create: `apps/developer-trust-worker/src/sandbox/oci-control.test.ts`
- Create: `apps/developer-trust-worker/src/sandbox/profile.ts`
- Create: `apps/developer-trust-worker/src/sandbox/profile.test.ts`
- Create: `apps/developer-trust-worker/src/capabilities/broker.ts`
- Create: `apps/developer-trust-worker/src/capabilities/broker.test.ts`
- Create: `apps/developer-trust-worker/src/network/egress-policy.ts`
- Create: `apps/developer-trust-worker/src/network/egress-policy.test.ts`
- Create: `apps/developer-trust-worker/src/network/proxy.ts`
- Create: `apps/developer-trust-worker/src/network/proxy.test.ts`
- Modify: `apps/developer-trust-worker/src/pipeline.ts`
- Modify: `apps/developer-trust-worker/src/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 2 capability rows, Task 5 run fence, and Task 6 policy/pipeline.
- Produces: `DeveloperModuleSandboxPort`, `VerificationCapabilityBroker`, `DeveloperModuleEgressPolicy`, and OCI control adapter.

- [ ] **Step 1: Write failing isolation and denial tests**

Cover no network by default, HTTPS allow intersection, DNS rebinding, redirect re-checks, metadata/private/loopback/link-local/multicast denial, method/byte limits, token audience/expiry/nonce/call/byte limits, undeclared action evidence, no ordinary token fields, CPU/memory/PID/file/output/wall limits, and stale-sandbox finalization:

```ts
test.each([
  'http://169.254.169.254/latest/meta-data',
  'https://127.0.0.1',
  'https://10.0.0.8',
  'https://[::1]',
] as const)('denies protected destination %s', async (url) => {
  await expect(policy.authorize({ url, method: 'GET', declaredOrigins: [], policyOrigins: [] }))
    .rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_EGRESS_DENIED' });
});

test('sandbox input cannot carry a general API or project token', () => {
  expect(Object.keys(sandboxInputFixture())).toEqual([
    'artifactDigest', 'artifactMount', 'profile', 'fixtures', 'verificationCapability', 'limits', 'networkPolicy',
  ]);
});
```

- [ ] **Step 2: Run sandbox tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter @openopc/developer-trust-worker exec bun test src/sandbox src/capabilities src/network src/pipeline.test.ts
```

Expected: FAIL because sandbox, capability, and proxy contracts do not exist.

- [ ] **Step 3: Implement the sandbox port and immutable default profile**

```ts
export interface DeveloperModuleSandboxPort {
  run(input: {
    artifactDigest: `sha256:${string}`;
    artifactMount: ReadonlyArtifactMount;
    profile: RegistryModuleVerificationProfile;
    fixtures: readonly SyntheticCapabilityFixture[];
    verificationCapability: string;
    limits: SandboxResourceLimits;
    networkPolicy: DeveloperModuleNetworkPolicy;
  }, signal: AbortSignal): Promise<DeveloperModuleSandboxResult>;
}
```

The OCI control request must specify non-root UID/GID, read-only root/artifact mount, isolated tmpfs, dropped capabilities, `no-new-privileges`, seccomp, no host mounts/IPC/PID/network, bounded CPU/memory/PIDs/file descriptors/output/time, and no injected environment except verification broker URL/token and deterministic harness variables. `oci-control.ts` talks to a narrow authenticated control endpoint; it must reject `unix:///var/run/docker.sock` and never mount the host Docker socket.

- [ ] **Step 4: Implement verification-only capabilities and controlled egress**

Capabilities bind `{ releaseId, artifactDigest, runId, sandboxInstanceId, allowedSyntheticActions, issuedAt, expiresAt, nonce, policyDigest, maxCalls, maxPayloadBytes }`. Store only SHA-256 hashes of token and nonce. Broker authorization atomically checks and increments counters, returns synthetic fixtures only, records denied attempts, and revokes on terminal run.

The egress proxy resolves DNS itself for every request and redirect, rejects protected IP ranges after resolution, pins the approved IP for that request, uses TLS hostname verification, strips `Authorization`, `Cookie`, proxy headers and URL credentials, permits only policy-approved methods/origins, limits request/response bytes, and records sanitized `{ origin, method, outcome }` evidence.

- [ ] **Step 5: Run isolation contract tests**

Run:

```powershell
pnpm.cmd --filter @openopc/developer-trust-worker test
pnpm.cmd --filter @openopc/developer-trust-worker typecheck
git diff --check
```

Expected: all denial/resource/capability tests pass; no project/session/Secret/Connector/provider token appears in sandbox input or captured control request.

- [ ] **Step 6: Commit sandbox isolation**

```powershell
git add apps/developer-trust-worker/src/sandbox apps/developer-trust-worker/src/capabilities apps/developer-trust-worker/src/network apps/developer-trust-worker/src/pipeline.ts apps/developer-trust-worker/src/pipeline.test.ts
git diff --cached --check
git commit -m "feat(worker): isolate module verification capabilities and egress"
```

---

### Task 8: Make automatic trust evidence unforgeable in review and signing

**Files:**
- Modify: `apps/api/src/developer/reviews.ts`
- Modify: `apps/api/src/developer/reviews.test.ts`
- Modify: `apps/api/src/developer/reviews.drizzle.ts`
- Modify: `apps/api/src/developer/reviews.drizzle.test.ts`
- Modify: `apps/api/src/admin/developer-reviews.ts`
- Modify: `apps/api/src/admin/developer-reviews.test.ts`
- Modify: `apps/api/src/developer/distribution.ts`
- Modify: `apps/api/src/developer/distribution.test.ts`
- Modify: `packages/db/migrations/20260725120000000_developer_module_trust.sql`
- Modify: `packages/db/src/schema/kortix.ts`

**Interfaces:**
- Consumes: Task 5 `DeveloperModuleTrustGate`.
- Produces: public `DeveloperModuleHumanReviewEvidence`, internal `DeveloperModuleAutomaticEvidence`, and approval/sign gates that cannot be bypassed by request JSON.

- [ ] **Step 1: Write failing evidence-forgery and stale-policy tests**

```ts
test.each(['source_scan', 'sandbox_test'] as const)(
  'manual %s evidence is rejected',
  async (requirement) => {
    await expect(service.decide({ ...approvalInput(), evidence: [manualEvidence(requirement)] }))
      .rejects.toMatchObject({ code: 'DEVELOPER_REVIEW_AUTOMATIC_EVIDENCE_FORBIDDEN', status: 400 });
  },
);

test.each(['queued', 'running', 'failed', 'inconclusive', 'cancelled', 'stale-policy'] as const)(
  '%s verification blocks approval and signing',
  async (state) => {
    trustGate.set(state);
    await expect(reviewService.decide(approvalInput())).rejects.toMatchObject({ code: 'DEVELOPER_TRUST_GATE_UNMET' });
    await expect(distributionService.sign(signInput())).rejects.toMatchObject({ code: 'DEVELOPER_TRUST_GATE_UNMET' });
  },
);
```

- [ ] **Step 2: Run review/distribution tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/reviews.test.ts src/developer/reviews.drizzle.test.ts src/admin/developer-reviews.test.ts src/developer/distribution.test.ts
```

Expected: FAIL because all current evidence is manual and automatic requirements are forgeable.

- [ ] **Step 3: Split human request evidence from system evidence**

```ts
export type DeveloperModuleAutomaticRequirement = 'source_scan' | 'sandbox_test';
export type DeveloperModuleHumanRequirement =
  | 'manifest_review' | 'permission_review' | 'desktop_security_review' | 'human_review';

export interface DeveloperModuleHumanReviewEvidence {
  requirement: DeveloperModuleHumanRequirement;
  outcome: 'passed';
  method: 'manual';
  summary: string;
  observed_at: string;
}

export interface DeveloperModuleAutomaticEvidence {
  requirement: DeveloperModuleAutomaticRequirement;
  outcome: 'passed';
  method: 'system_attestation';
  run_id: string;
  evidence_digest: `sha256:${string}`;
  policy_digest: `sha256:${string}`;
}
```

The admin route parses only `DeveloperModuleHumanReviewEvidence`; unknown keys, `method: 'system_attestation'`, and automatic requirement names return 400. The service obtains automatic evidence directly from `DeveloperModuleTrustGate`, merges it into the immutable approval event inside the fenced transaction, and never accepts it as a method argument.

- [ ] **Step 4: Enforce the same trust gate at approval and signing**

Approval requires all manifest-derived human requirements exactly once plus current automatic evidence. Signing re-evaluates the gate after approval and before calling `ModuleSigningPort`, so policy changes or revocation between the two operations fail closed. Preserve reviewer independence and expected-status/revision compare-and-swap behavior.

- [ ] **Step 5: Run review, distribution, DB, and type gates**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/developer/reviews.test.ts src/developer/reviews.drizzle.test.ts src/admin/developer-reviews.test.ts src/developer/distribution.test.ts
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/db test
git diff --check
```

Expected: manual automatic evidence is rejected; exact current system evidence permits one revision-fenced approval/signature; stale/mismatched evidence blocks both.

- [ ] **Step 6: Commit the trust-aware review gate**

```powershell
git add apps/api/src/developer/reviews.ts apps/api/src/developer/reviews.test.ts apps/api/src/developer/reviews.drizzle.ts apps/api/src/developer/reviews.drizzle.test.ts apps/api/src/admin/developer-reviews.ts apps/api/src/admin/developer-reviews.test.ts apps/api/src/developer/distribution.ts apps/api/src/developer/distribution.test.ts packages/db/migrations/20260725120000000_developer_module_trust.sql packages/db/src/schema/kortix.ts
git diff --cached --check
git commit -m "feat(developer): require system trust evidence for approval"
```

---

### Task 9: SDK and Google-style Publisher/Admin trust experience

**Files:**
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Modify: `apps/web/src/features/developer-center/model.ts`
- Modify: `apps/web/src/features/developer-center/model.test.ts`
- Modify: `apps/web/src/features/developer-center/publisher/query.ts`
- Modify: `apps/web/src/features/developer-center/publisher/query.test.ts`
- Create: `apps/web/src/features/developer-center/publisher/artifact-upload-controller.ts`
- Create: `apps/web/src/features/developer-center/publisher/artifact-upload-controller.test.ts`
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.test.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/release-detail-page.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/publisher-pages.test.tsx`
- Modify: `apps/web/src/features/developer-center/admin/client.ts`
- Modify: `apps/web/src/features/developer-center/admin/client.test.ts`
- Modify: `apps/web/src/features/developer-center/admin/query.ts`
- Modify: `apps/web/src/features/developer-center/admin/review-detail-page.tsx`
- Modify: `apps/web/src/features/developer-center/admin/admin-pages.test.tsx`
- Create: `apps/web/src/features/developer-center/shared/trust-summary.tsx`
- Modify: `apps/web/src/features/developer-center/shared/shared-components.test.tsx`

**Interfaces:**
- Consumes: Task 3 artifact APIs and Task 5 safe trust views.
- Produces: typed SDK methods and one responsive Developer Center flow; no direct storage or worker access.

- [ ] **Step 1: Write failing SDK/controller/component tests**

Cover declarative submission, package upload/finalize/cancel, progress polling, retry, findings grouping, SBOM metadata, immutable attempts, blocked approval/sign reason, stale revision recovery, and mobile/desktop states:

```ts
test('SDK release submission sends artifact_id and never raw item bytes', async () => {
  await submitDeveloperModuleRelease({ artifactId: ARTIFACT_ID, accountId: ACCOUNT_ID });
  expect(post).toHaveBeenCalledWith('/developer/modules/releases', {
    account_id: ACCOUNT_ID,
    artifact_id: ARTIFACT_ID,
  });
});

test('admin detail disables approval with the server trust reason', () => {
  render(<AdminDeveloperReviewDetailPage fixture={runningTrustFixture()} />);
  expect(screen.getByRole('button', { name: 'Approve release' })).toBeDisabled();
  expect(screen.getByText('Sandbox verification is still running')).toBeVisible();
});
```

- [ ] **Step 2: Run SDK/Web tests and confirm RED**

Run:

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/core/rest/projects-client/developer-modules.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/developer-center
```

Expected: FAIL because artifact/trust APIs and trust components are missing.

- [ ] **Step 3: Add the typed SDK surface**

Add methods with these request shapes:

```ts
createDeclarativeDeveloperModuleArtifact(item, options?)
createDeveloperModuleArtifactUpload({ publisherId, expectedSize, expectedDigest, accountId? })
finalizeDeveloperModuleArtifactUpload(uploadId, { accountId? })
cancelDeveloperModuleArtifactUpload(uploadId, { accountId? })
getDeveloperModuleArtifact(artifactId, { accountId? })
submitDeveloperModuleRelease({ artifactId, accountId? })
getDeveloperModuleTrust(releaseId, { accountId? })
retryDeveloperModuleVerification(releaseId, { accountId? })
```

`DeveloperModuleRelease` gains artifact/trust digests. `DeveloperModuleReviewEvidence` becomes a discriminated human/system union for responses, but review-decision request types accept only human evidence. Export through the existing project facade; do not create another client package.

- [ ] **Step 4: Build the Publisher and Admin experience in existing pages**

Publisher submission offers two tabs: declarative JSON and package upload. It shows local hashing/upload/finalize progress, then the server-authoritative artifact digest. Release detail polls queued/running state, groups sanitized findings by severity/requirement, shows policy/scanner/sandbox/SBOM summaries, immutable attempts, retry eligibility, and the separation between automatic and human review.

Admin detail uses the same `TrustSummary`, adds provenance and attempt evidence, and disables approval/sign with the exact server unmet condition. It has no control that changes an automatic result. Follow existing rounded cards, neutral Google-style hierarchy, responsive one-column mobile/two-column desktop layout, concise primary actions, skeletons, empty states, error recovery, and search behavior; no shortcut or accessibility expansion is required.

- [ ] **Step 5: Run SDK/Web tests, typechecks, and i18n audit**

Run:

```powershell
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter Kortix-Computer-Frontend test
pnpm.cmd --filter Kortix-Computer-Frontend exec tsc --noEmit
pnpm.cmd --filter Kortix-Computer-Frontend i18n:audit
git diff --check
```

Expected: all SDK/Web tests and typechecks pass; hardcoded-copy audit does not regress; no storage key, upload signature, raw finding, or worker endpoint appears in rendered JSON.

- [ ] **Step 6: Commit the Developer Center trust UI**

```powershell
git add packages/sdk/src/core/rest/projects-client/developer-modules.ts packages/sdk/src/core/rest/projects-client/developer-modules.test.ts apps/web/src/features/developer-center
git diff --cached --check
git commit -m "feat(web): add developer artifact and trust review experience"
```

---

### Task 10: Deployment readiness, browser acceptance, wider gates, and evidence ledger

**Files:**
- Create: `apps/developer-trust-worker/Dockerfile`
- Modify: `scripts/compose/docker-compose.yml`
- Create: `docs/operations/developer-module-trust-runbook.md`
- Create: `docs/operations/developer-module-trust-progress.md`
- Modify: `apps/web/scripts/e2e/developer-center-review-smoke.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: disabled-by-default deployment, component readiness, browser evidence, migration evidence, CodeGraph sync, and an honest enablement decision.

- [ ] **Step 1: Write failing readiness and browser acceptance checks**

Worker readiness returns component-level state:

```ts
export interface DeveloperTrustReadiness {
  enabled: boolean;
  ready: boolean;
  artifactStore: 'ready' | 'unavailable' | 'disabled';
  policy: 'ready' | 'invalid' | 'disabled';
  scanners: Record<string, 'ready' | 'unavailable' | 'identity_mismatch' | 'disabled'>;
  sandbox: 'ready' | 'unavailable' | 'disabled';
  databaseClaims: 'ready' | 'unavailable' | 'disabled';
}
```

Extend the browser fixture to visibly assert package upload/finalize, queued/running/passed progress, grouped findings, approval disabled for running/failed/stale evidence, passing approval/sign, 409 revision recovery, account substitution 404, immutable attempts, and 390px/1440px layouts.

- [ ] **Step 2: Run readiness/browser checks and confirm RED**

Run:

```powershell
pnpm.cmd --filter @openopc/developer-trust-worker test
pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:developer-center
```

Expected: FAIL because deployment readiness and the expanded browser fixture are incomplete. If local browser secrets or command policy prevent startup, record the exact blocker and do not convert the result to passing evidence.

- [ ] **Step 3: Add disabled-by-default deployment and runbook**

The worker Dockerfile uses a non-root runtime, read-only filesystem-compatible paths, pinned scanner image/binary identities from the immutable policy, and no Docker socket. Compose adds `developer-trust-worker` behind profile `developer-trust`, with no public ports, internal artifact/DB/sandbox-control networks, healthcheck, resource limits, and `DEVELOPER_TRUST_ENABLED=false` by default. Code-bearing API submission also requires `DEVELOPER_CODE_MODULES_ENABLED=true` and a ready worker; otherwise return `DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED` without affecting existing module reads.

The runbook documents S3/MinIO, policy/scanner digests, sandbox control, worker role, egress proxy, readiness interpretation, queue drain, retry/cancel, artifact cleanup, key rotation boundaries, BaoTa Compose/reverse-proxy placement, rollback, and the explicit prohibition on exposing scanner/sandbox ports.

- [ ] **Step 4: Run fresh migration acceptance**

Against the repository test PostgreSQL instance, record all four results in `docs/operations/developer-module-trust-progress.md`:

```powershell
pnpm.cmd --filter @kortix/db migrate
pnpm.cmd --filter @kortix/db migrate
pnpm.cmd --filter @kortix/db migrate:status
pnpm.cmd --filter @kortix/db test
```

Expected: fresh apply exits 0, second apply is idempotent, status shows all migrations applied, and DB tests pass. Separately seed one schema-1 signed row in a disposable database and prove migration fails with `OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED`; reset that disposable database afterward.

- [ ] **Step 5: Run focused and wider regression gates**

Run and record command, UTC timestamp, commit, exit code, pass count, and exact blocker/failure in the progress ledger:

```powershell
pnpm.cmd --filter @kortix/registry test
pnpm.cmd --filter @kortix/db test
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter kortix-api test
pnpm.cmd --filter Kortix-Computer-Frontend test
pnpm.cmd --filter @openopc/developer-trust-worker test
pnpm.cmd --filter @kortix/registry typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter Kortix-Computer-Frontend exec tsc --noEmit
pnpm.cmd --filter @openopc/developer-trust-worker typecheck
pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:developer-center
pnpm.cmd test
```

Expected for enablement: all feature-focused/package/type/migration/browser gates exit 0. Run the root suite even if the known Windows/API baseline remains non-green; record it as non-green with exact failing tests and keep both trust feature flags off. Do not describe package-green or build-green results as full E2E/release proof.

- [ ] **Step 6: Prove security, route, compatibility, and repository hygiene**

Run:

```powershell
git diff --check
pnpm.cmd lint:biome
pnpm.cmd format:check
pnpm.cmd --filter Kortix-Computer-Frontend i18n:audit
codegraph status --json
codegraph sync
git status --short
```

Also run repository route/public-surface checks used by `apps/api/src/developer/index.test.ts`, scan captured logs/errors/fixtures for seeded credentials and raw source, and visibly exercise existing Kortix project/session/IAM/Marketplace install/update/rollback/revocation flows. Expected: no credential/raw-source leakage, no new public worker route, CodeGraph has zero pending changes after sync, and only the two protected untracked files remain outside the implementation commits.

- [ ] **Step 7: Self-review all design acceptance criteria and record enablement**

In the progress ledger, map acceptance criteria 1-12 to concrete test names/commands/artifacts. Set:

```text
enablement: disabled
reason: acceptance evidence incomplete
```

until every required focused, migration, browser, security, and compatibility gate has fresh passing evidence. If they all pass, change only the reason to `acceptance evidence complete; operator may enable in a separately authorized deployment`. This plan does not authorize production deployment.

- [ ] **Step 8: Commit operational evidence**

```powershell
git add apps/developer-trust-worker/Dockerfile scripts/compose/docker-compose.yml apps/web/scripts/e2e/developer-center-review-smoke.ts apps/web/package.json docs/operations/developer-module-trust-runbook.md docs/operations/developer-module-trust-progress.md .codegraph
git diff --cached --check
git commit -m "test(developer): record trust pipeline acceptance evidence"
```

## Plan Self-Review Record

### Specification coverage

| Design requirement | Implemented by |
|---|---|
| Schema v2 only, complete artifact digest, archive/path/lock safety | Tasks 1 and 3 |
| Account-scoped artifact storage and immutable release binding | Tasks 2 and 3 |
| Signature schema 2 only and downstream verification | Task 4 |
| Durable runs, leases, retries, findings, atomic attestations | Task 5 |
| Gitleaks, Syft/CycloneDX 1.6, OSV, Semgrep, license policy, optional Sigstore | Task 6 |
| Hardened sandbox, synthetic capability and egress proxy | Task 7 |
| Automatic evidence cannot be manually forged | Task 8 |
| Publisher/admin SDK and Web trust experience | Task 9 |
| Hosted/self-hosted readiness, migration, browser and wider gates | Task 10 |
| Preserve Kortix and keep production execution/settlement/KMS unclaimed | Global constraints and Task 10 |

### Type consistency

- `artifactDigest`, `policyDigest`, `scannerSetDigest`, `sbomDigest`, and `attestationDigest` are always canonical `sha256:<64 lowercase hex>` values internally; REST/DB snake-case names map at repository boundaries only.
- `source_scan` and `sandbox_test` are the only automatic review requirements; all other current review requirements remain human.
- `DeveloperModuleTrustGate` is the single approval/sign authority; UI labels and client state never make trust decisions.
- `DeveloperArtifactStore` handles bytes; repository ports handle metadata; neither leaks storage identity across account boundaries.
- Signature payload schema 2 is shared by sign, publish, install, update, and rollback verification.

### Placeholder scan

The plan contains no `TBD`, `TODO`, compatibility shim, unbounded “add tests” instruction, or unspecified production secret/digest. Runtime scanner digests and keys are required configuration validated by readiness, not values embedded in source control.

### Completion boundary

Completion of this plan proves pre-publication artifact trust and validation only. It does not prove arbitrary third-party production execution, revenue settlement, production KMS, a production deployment, or production acceptance.
