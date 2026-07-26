# OpenOPC Complete Developer and Module Internal-Beta Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, keep the checkboxes current, and stop at every commit/review checkpoint. This project does not use Superpowers for plan execution.

**Goal:** Deliver the approved invited internal beta of the OpenOPC Developer Center and module platform on Web and packaged Windows Desktop, including real declarative, WASI, OCI, trust, consent, sandbox-commerce, release, rollback, and evidence flows.

**Architecture:** Keep Kortix as the authoritative control plane and add independently gated OpenOPC extension services. TypeScript/Bun services own IAM-qualified state and signed work leases; a private Rust/Wasmtime Runner host executes WASI components, while OCI runs only on independent Linux nodes with rootless containerd and gVisor. All product clients use `@kortix/sdk`, and every cross-process boundary uses strict versioned JSON contracts.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle ORM, PostgreSQL, Next.js 15, React 19, TanStack Query, AJV 8, MinIO/S3, OpenTelemetry, Rust 1.97.1, Wasmtime 47.0.2 Component Model, WIT, rootless containerd, gVisor `runsc`, OCI digests, DSSE/in-toto, Playwright, Electron, Docker Compose.

## Global Constraints

- Preserve `@kortix/registry`, `@kortix/sdk`, Kortix IAM, Billing, Marketplace, project/session/task/workflow systems, and all existing first-party Desktop behavior.
- New behavior is additive, extension-owned, independently gated, disabled by default, and fails closed without disabling existing Kortix flows.
- Registry Module Schema v2 remains canonical; no Schema v1 compatibility path is added.
- `server-adapter.execution.entry` names a digested `openopc.runtime.json` with `descriptorVersion: 1` and exactly one of `wasi-component` or `oci-image`.
- No third-party JavaScript runs in the OpenOPC Web or API process; complex module UI runs only in a separate-origin sandboxed iframe.
- Web and packaged Windows Desktop are beta clients; Android/iOS and third-party `desktop-native` execution remain excluded.
- The cancelled first-party image, video, voice, 3D, digital-human, and batch-remix product pages remain absent.
- Internal-beta commerce uses real accounting state transitions in the `sandbox` environment namespace but never configures real payment, tax, invoice, payout, or production KMS adapters.
- Baota exposes only Web/API reverse-proxy ports. Runner, scanner, MinIO, PostgreSQL, capability broker, egress proxy, and container-control ports stay private.
- OCI execution requires an independent Linux Runner with rootless containerd plus gVisor; the single-node profile supports only declarative and WASI execution.
- Do not modify, stage, or commit `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md` or `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`.
- Do not authorize production activation. G1-G12 require fresh staging evidence before any beta flag changes from false.

## Milestones And Gates

| Milestone | Tasks | Reviewable outcome | Gates advanced |
| --- | --- | --- | --- |
| M1 Trust and developer foundation | 0-6 | Invited verified Publishers can submit immutable, descriptor-valid artifacts to a real fail-closed trust pipeline | G1-G4, G8, G12 |
| M2 Module execution | 7-13 | Consent-bound declarative/WASI/OCI work executes with fenced leases, mediated capabilities, bounded evidence, revoke, and rollback | G5-G6, G8, G10 |
| M3 UI and commerce | 14-20 | Schema UI, isolated iframe apps, all sandbox pricing models, ledger, statements, SDK/CLI, Developer and Admin workbenches work end-to-end | G7-G10 |
| M4 Deployment and acceptance | 21-25 | Full and single-node deployments, readiness, visible Web/Desktop acceptance, upstream rehearsal, and enablement ledger are reproducible | G1-G12 |

## File Ownership Map

- `packages/module-runtime-contracts/`: the only TypeScript source of cross-process JSON schemas, parsers, canonicalization, and golden fixtures.
- `packages/db/migrations/20260726*.sql`, `packages/db/src/schema/kortix.ts`, `packages/db/src/types.ts`: additive tenant-qualified durable state.
- `apps/api/src/developer/`: developer, Publisher, trust, pricing, and release authority that extends existing services.
- `apps/api/src/module-runtime/`: consent, execution, lease, Runner, capability, evidence, and private Runner protocol control plane.
- `apps/api/src/module-commerce/`: sandbox plan, order, subscription, usage, refund, dispute, split, and statement authority.
- `apps/developer-trust-worker/`: concrete S3/PostgreSQL/scanner/sandbox/attestation adapters; no unavailable adapter may report ready.
- `apps/module-runner/`: private Rust process for signed claims, Wasmtime Component Model hosting, and validated OCI dispatch.
- `apps/module-ledger-worker/`: idempotent outbox consumer and double-entry sandbox settlement worker.
- `apps/web/src/features/module-host/`: platform-owned Schema UI and cross-origin Module Bridge host.
- `apps/web/src/features/developer-center/` and `apps/web/src/features/project-modules/`: product workbenches using only `@kortix/sdk`.
- `apps/cli/src/commands/modules/`: developer build/validate/upload/release/status commands using SDK/public API only.
- `deploy/openopc-modules/`: full and single-node Compose profiles, Runner bootstrap, private-network policy, and Baota notes.
- `tests/module-beta/`: real-dependency G1-G12 fixtures, orchestration scripts, evidence manifests, and enablement ledger.

---

## Milestone 1: Trust And Developer Foundation

### Task 0: Deterministic beta target guard and baseline ledger

**Files:**
- Create: `scripts/release/module-beta-targets.ts`
- Create: `scripts/release/module-beta-targets.test.ts`
- Create: `tests/module-beta/evidence.schema.json`
- Create: `tests/module-beta/evidence.json`
- Modify: `.github/workflows/qa-release.yml`
- Modify: `package.json`

**Interfaces:**
- Produces: `normalizeBetaTarget(value: string): string` and `assertNonProductionBetaTargets(input): NormalizedBetaTargets`.
- Produces: evidence records `{ gate, lane, command, environment, dependencyIdentities, commit, startedAt, finishedAt, outcome, artifactPaths }` where `lane` is `focused | package | integration | browser | deployment | production`.

- [ ] **Step 1: Write the failing target-normalization tests**

```typescript
import { expect, test } from 'bun:test';
import { assertNonProductionBetaTargets, normalizeBetaTarget } from './module-beta-targets';

test('removes CRLF and one trailing slash from workflow inputs', () => {
  expect(normalizeBetaTarget('https://staging-api.openopc.local/v1/\r\n'))
    .toBe('https://staging-api.openopc.local/v1');
});

test('refuses production and loopback targets for staging evidence', () => {
  for (const value of ['https://api.openopc.com/v1', 'http://127.0.0.1:8008/v1']) {
    expect(() => assertNonProductionBetaTargets({ api: value, web: value, runner: value }))
      .toThrow('MODULE_BETA_TARGET_FORBIDDEN');
  }
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/module-beta-targets.test.ts`

Expected: FAIL with `Cannot find module './module-beta-targets'`.

- [ ] **Step 3: Implement and wire the guard**

```typescript
const FORBIDDEN = /(^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]))|(^https:\/\/(api\.)?openopc\.com)|prod(uction)?/i;

export function normalizeBetaTarget(value: string): string {
  return value.replace(/[\r\n\t ]+/g, '').replace(/\/$/, '');
}

export function assertNonProductionBetaTargets(input: Record<'api' | 'web' | 'runner', string>) {
  const normalized = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, normalizeBetaTarget(value)]),
  ) as typeof input;
  if (Object.values(normalized).some((value) => !value || FORBIDDEN.test(value))) {
    throw new Error('MODULE_BETA_TARGET_FORBIDDEN');
  }
  return normalized;
}
```

Replace the workflow's inline target trimming with `bun scripts/release/module-beta-targets.ts --github-env`, add `module-beta:evidence:validate` to root scripts, and seed `evidence.json` with all G1-G12 as `outcome: "not-run"`. Validation rejects unknown fields, missing lanes, duplicate evidence IDs, and any `passed` record without artifacts and dependency identities.

- [ ] **Step 4: Run GREEN and baseline acceptance**

Run: `bun test scripts/release/module-beta-targets.test.ts && bun scripts/release/module-beta-targets.ts --check-fixture tests/module-beta/evidence.json`

Expected: PASS; PowerShell-created CRLF inputs normalize identically to Linux LF inputs, and the initial ledger validates with no gate marked passed.

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/qa-release.yml scripts/release/module-beta-targets.ts scripts/release/module-beta-targets.test.ts tests/module-beta/evidence.schema.json tests/module-beta/evidence.json
git commit -m "test(modules): establish internal beta evidence gate"
```

### Task 1: Runtime descriptor and cross-language contract package

**Files:**
- Create: `packages/module-runtime-contracts/package.json`
- Create: `packages/module-runtime-contracts/tsconfig.json`
- Create: `packages/module-runtime-contracts/src/runtime-descriptor.ts`
- Create: `packages/module-runtime-contracts/src/work-envelope.ts`
- Create: `packages/module-runtime-contracts/src/canonical-json.ts`
- Create: `packages/module-runtime-contracts/src/index.ts`
- Create: `packages/module-runtime-contracts/schema/openopc.runtime.v1.schema.json`
- Create: `packages/module-runtime-contracts/schema/work-envelope.v1.schema.json`
- Create: `packages/module-runtime-contracts/fixtures/valid/wasi.json`
- Create: `packages/module-runtime-contracts/fixtures/valid/oci.json`
- Create: `packages/module-runtime-contracts/fixtures/invalid/oci-tag.json`
- Create: `packages/module-runtime-contracts/src/contracts.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `parseRuntimeDescriptor(value: unknown): RuntimeDescriptorV1`.
- Produces: `parseWorkEnvelope(value: unknown): WorkEnvelopeV1` and `canonicalDigest(value): Promise<\`sha256:${string}\`>`.
- `RuntimeDescriptorV1` is a discriminated union on `runtime.kind`; every schema has `additionalProperties: false`.

- [ ] **Step 1: Write failing strict-contract tests**

```typescript
test('accepts one runtime and rejects OCI tags or unknown fields', () => {
  expect(parseRuntimeDescriptor(wasiFixture).runtime.kind).toBe('wasi-component');
  expect(() => parseRuntimeDescriptor({ ...ociFixture, extra: true })).toThrow('RUNTIME_DESCRIPTOR_INVALID');
  expect(() => parseRuntimeDescriptor(ociTagFixture)).toThrow('OCI_IMAGE_DIGEST_REQUIRED');
});

test('canonical work envelope digest is key-order independent', async () => {
  expect(await canonicalDigest({ b: 2, a: 1 })).toBe(await canonicalDigest({ a: 1, b: 2 }));
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @openopc/module-runtime-contracts test`

Expected: FAIL because the workspace package and parsers do not exist.

- [ ] **Step 3: Implement the exact runtime types**

```typescript
export type RuntimeDescriptorV1 = {
  descriptorVersion: 1;
  runtime:
    | { kind: 'wasi-component'; component: string; world: string; operation: string; imports: string[]; limits: RuntimeLimits }
    | { kind: 'oci-image'; image: `sha256:${string}`; command: string[]; args: string[]; profile: string; limits: RuntimeLimits };
};

export interface WorkEnvelopeV1 {
  envelopeVersion: 1;
  executionId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseDigest: `sha256:${string}`;
  runtimeDescriptorDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  lease: { id: string; generation: number; deadline: string };
  grants: readonly { id: string; audience: string; tokenHash: `sha256:${string}` }[];
}
```

Use AJV 8 draft-2020-12 to validate the checked-in schemas. Enforce relative clean component paths, immutable lowercase OCI digests, non-empty command arrays, explicit numeric ceilings, unique sorted imports, RFC3339 deadlines, UUID IDs, and canonical UTF-8 JSON digests. Do not add execution fields to Registry Schema v2.

- [ ] **Step 4: Run GREEN and artifact binding acceptance**

Run: `pnpm --filter @openopc/module-runtime-contracts test && pnpm --filter @openopc/module-runtime-contracts typecheck && pnpm --filter @kortix/registry test`

Expected: PASS; changing any descriptor byte changes the artifact/work-envelope digest fixture while current Registry Schema v2 tests remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/module-runtime-contracts pnpm-lock.yaml
git commit -m "feat(modules): define strict runtime contracts"
```

### Task 2: Developer invitations, verification, Publishers, roles, and audit schema

**Files:**
- Create: `packages/db/migrations/20260726100000000_developer_publishers.sql`
- Create: `packages/db/src/developer-publisher-schema.test.ts`
- Create: `packages/db/scripts/developer-publisher-migration.integration.test.ts`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces: `developerInvitations`, `developerOrganizations`, `developerPublishers`, `developerPublisherMembers`, and `developerPublisherAuditEvents` Drizzle tables.
- Publisher roles: `owner | developer | release_manager | finance_viewer | support_viewer`.
- Verification states: `pending | verified | rejected | suspended`; invitation states: `pending | accepted | expired | revoked`.

- [ ] **Step 1: Write the failing schema invariants**

```typescript
test('publisher identity and audit history are globally fenced', () => {
  expect(developerPublishers.slug.uniqueName).toBeDefined();
  expect(developerPublisherMembers.publisherId).toBeDefined();
  expect(developerPublisherAuditEvents.eventId).toBeDefined();
});
```

Add migration assertions for case-folded unique slugs, one accepted invitation per token hash, owner-presence enforcement, tenant-qualified foreign keys, append-only audit triggers, and denial of UPDATE/DELETE on audit rows.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @kortix/db test -- developer-publisher-schema.test.ts`

Expected: FAIL because `developerPublishers` is not exported.

- [ ] **Step 3: Add the migration and Drizzle mappings**

Use UUID primary keys, `account_id` on every tenant-owned row, `citext`-equivalent `lower(slug)` uniqueness, explicit check constraints, and `created_by`/`created_at` on authority transitions. Store only invitation token hashes. Make organization verification metadata a bounded JSON object and record every transition as a new audit event.

- [ ] **Step 4: Run GREEN and migration acceptance**

Run: `pnpm --filter @kortix/db test && pnpm --filter @kortix/db typecheck && pnpm --filter @kortix/db migrate:lint`

Focused integration: `DATABASE_URL=$MODULE_BETA_TEST_DATABASE_URL bun packages/db/scripts/developer-publisher-migration.integration.test.ts`

Expected: PASS; a second account sees an opaque not-found result, duplicate case-insensitive slugs fail, and audit mutation is rejected by PostgreSQL.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/20260726100000000_developer_publishers.sql packages/db/src/developer-publisher-schema.test.ts packages/db/scripts/developer-publisher-migration.integration.test.ts packages/db/src/schema/kortix.ts packages/db/src/types.ts packages/db/src/index.ts
git commit -m "feat(developer): add invited publisher authority model"
```

### Task 3: Publisher lifecycle services, API, SDK, and authority fencing

**Files:**
- Create: `apps/api/src/developer/publishers.ts`
- Create: `apps/api/src/developer/publishers.drizzle.ts`
- Create: `apps/api/src/developer/publishers.test.ts`
- Create: `apps/api/src/developer/publishers.drizzle.test.ts`
- Create: `apps/api/src/admin/developer-publishers.ts`
- Create: `apps/api/src/admin/developer-publishers.test.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/developer/app.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`

**Interfaces:**
- Produces: `DeveloperPublisherService.invite`, `.acceptInvitation`, `.setVerification`, `.createPublisher`, `.setMemberRole`, `.suspend`, `.reinstate`, `.requirePermission`.
- Public SDK calls: `getDeveloperAccess()`, `acceptDeveloperInvitation(token)`, `createDeveloperPublisher(input)`, `listDeveloperPublishers()`, `updateDeveloperPublisherMember(...)`.
- Admin routes require platform-admin authority; upload/review services consume `requirePermission(publisherId, actor, 'upload' | 'release' | 'finance' | 'support')`.

- [ ] **Step 1: Write failing authority tests**

```typescript
test('unverified organization cannot create a Publisher or upload', async () => {
  await expect(service.createPublisher(unverifiedInput)).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_REQUIRED' });
  await expect(service.requirePermission(publisherId, actor, 'upload')).rejects.toMatchObject({ code: 'DEVELOPER_PUBLISHER_FORBIDDEN' });
});

test('suspension blocks new actions but keeps historical reads', async () => {
  await service.suspend(adminCommand);
  await expect(service.requirePermission(publisherId, actor, 'release')).rejects.toMatchObject({ code: 'DEVELOPER_PUBLISHER_SUSPENDED' });
  expect(await repository.getAuditHistory(accountId, publisherId)).not.toHaveLength(0);
});

test('a Publisher actor cannot approve or sign their own release', async () => {
  await expect(service.requirePermission(publisherId, publisherActor, 'platform_review'))
    .rejects.toMatchObject({ code: 'DEVELOPER_SEGREGATION_OF_DUTIES_REQUIRED' });
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- publishers.test.ts admin/developer-publishers.test.ts`

Expected: FAIL with missing `DeveloperPublisherService`.

- [ ] **Step 3: Implement services and mount routes**

Apply account and platform-admin checks before repository lookup, use revision fencing for every mutable authority record, hash invitation tokens with SHA-256, write audit events in the same transaction, and map cross-tenant access to the existing opaque 404 shape. Inject the permission port into existing artifact upload, release submission, promotion, and publication services. Enforce segregation of duties: Publisher members may prepare and submit releases, but only an unrelated platform reviewer may approve, sign, publish, revoke, or resolve policy exceptions.

- [ ] **Step 4: Run GREEN and role matrix acceptance**

Run: `pnpm --filter kortix-api test -- publishers developer-modules && pnpm --filter @kortix/sdk test -- developer-modules && pnpm --filter kortix-api typecheck && pnpm --filter @kortix/sdk typecheck`

Expected: PASS for owner/developer/release-manager/finance/support/platform-admin cases; unverified and suspended principals fail before storage or release mutations.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/developer apps/api/src/admin/developer-publishers.ts apps/api/src/admin/developer-publishers.test.ts apps/api/src/index.ts packages/sdk/src/core/rest/projects-client
git commit -m "feat(developer): enforce publisher lifecycle and roles"
```

### Task 4: Artifact-bound runtime descriptor extraction

**Files:**
- Create: `apps/api/src/developer/runtime-descriptors.ts`
- Create: `apps/api/src/developer/runtime-descriptors.test.ts`
- Create: `packages/db/migrations/20260726120000000_developer_release_lifecycle.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/developer-module-release-schema.test.ts`
- Modify: `apps/api/src/developer/artifacts.ts`
- Modify: `apps/api/src/developer/releases.ts`
- Modify: `apps/api/src/developer/trust-gate.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `extractRuntimeDescriptor({ manifest, artifactBytes }): Promise<RuntimeDescriptorEvidence | null>`.
- Produces: `{ descriptor, descriptorDigest, entryPath, runtimeKind }`; only `server-adapter` requires it.
- `DeveloperModuleTrustGate` consumes descriptor digest and runtime kind as signed trust inputs.
- Release state is exactly `draft | uploaded | validated | verifying | review_pending | changes_requested | approved | signed | published | revoked | deprecated`; failed, inconclusive, and cancelled are immutable verification-attempt outcomes, not passing release states.

- [ ] **Step 1: Write failing archive and descriptor tests**

```typescript
test('server-adapter entry must resolve to openopc.runtime.json inside canonical artifact', async () => {
  await expect(extractRuntimeDescriptor({ manifest: serverAdapterManifest('../openopc.runtime.json'), artifactBytes }))
    .rejects.toMatchObject({ code: 'DEVELOPER_RUNTIME_ENTRY_INVALID' });
});

test('descriptor digest is included in trust readiness', async () => {
  expect(await gate.evaluate(release)).toMatchObject({ descriptorDigest: 'sha256:expected' });
});

test('release cannot skip uploaded, validated, or verifying', async () => {
  await expect(releases.transition(draftRelease, 'review_pending'))
    .rejects.toMatchObject({ code: 'DEVELOPER_RELEASE_TRANSITION_INVALID' });
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- runtime-descriptors.test.ts trust-gate.test.ts`

Expected: FAIL because extraction is not part of the artifact/release flow.

- [ ] **Step 3: Implement bounded extraction**

Read the descriptor from canonical artifact bytes after traversal, symlink, file-count, expanded-size, and compression-ratio checks. Reject missing, duplicate, non-UTF-8, unknown-field, or non-canonical descriptors. Persist only the derived digest/kind/path on the release; artifact bytes remain authoritative. Add the complete release-state checks and transition audit while retaining `changes_requested` and `deprecated` as supported branches. Keep `declarative`, `agent`, and `sandboxed-web` behavior unchanged and reject third-party `desktop-native` execution at trust evaluation.

- [ ] **Step 4: Run GREEN and malicious fixture acceptance**

Run: `pnpm --filter kortix-api test -- artifacts runtime-descriptors releases trust-gate && pnpm --filter @kortix/registry test && pnpm --filter @kortix/db test -- developer-module-release-schema.test.ts && pnpm --filter @kortix/db migrate:lint && pnpm --filter kortix-api typecheck`

Expected: PASS; traversal, duplicate-entry, oversized-file, OCI-tag, host-path, and unknown-field fixtures fail closed before review. The canonical JSON artifact format never decompresses uploaded entries, so the size fixture must not be described as a decompression-bomb defense.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/developer packages/db/migrations/20260726120000000_developer_release_lifecycle.sql packages/db/src/schema/kortix.ts packages/db/src/types.ts packages/db/src/developer-module-release-schema.test.ts packages/sdk/src/core/rest/projects-client/developer-modules.ts packages/sdk/src/core/rest/projects-client/developer-modules.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(developer): bind runtime descriptors to release trust"
```

### Task 5: Concrete trust-worker dependencies and fail-closed readiness

**Files:**
- Create: `apps/developer-trust-worker/src/storage/s3-artifacts.ts`
- Create: `apps/developer-trust-worker/src/storage/s3-artifacts.integration.test.ts`
- Create: `apps/developer-trust-worker/src/claims/postgres-claims.ts`
- Create: `apps/developer-trust-worker/src/claims/postgres-claims.integration.test.ts`
- Create: `apps/developer-trust-worker/src/attestation/ed25519-file-signer.ts`
- Create: `apps/developer-trust-worker/src/attestation/ed25519-file-signer.test.ts`
- Create: `apps/api/src/developer/module-signer-keyring.ts`
- Create: `apps/api/src/developer/module-signer-keyring.test.ts`
- Modify: `apps/api/src/developer/module-signer-config.ts`
- Modify: `apps/api/src/developer/module-signing.ts`
- Create: `apps/developer-trust-worker/src/sandbox/wasmtime-dry-run.ts`
- Modify: `apps/developer-trust-worker/src/config.ts`
- Modify: `apps/developer-trust-worker/src/main.ts`
- Modify: `apps/developer-trust-worker/src/readiness.ts`
- Modify: `apps/developer-trust-worker/src/pipeline.ts`
- Modify: `apps/developer-trust-worker/package.json`
- Modify: `apps/developer-trust-worker/Dockerfile`
- Create: `deploy/openopc-modules/trust.compose.yml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces concrete `ArtifactReader`, `VerificationClaimRepository`, `AttestationSigner`, and `SandboxControl` ports already consumed by `pipeline.ts`.
- Produces `ModuleSignerKeyring.activeSigner()` and `.verifier(keyId)` with distinct non-production release and attestation key IDs, rotation, and revocation.
- Readiness components: `objectStorage`, `postgresClaims`, `policy`, `gitleaks`, `syft`, `osv`, `semgrep`, `licensePolicy`, `attestationSigner`, `sandboxControl`.

- [ ] **Step 1: Write failing concrete-adapter tests**

```typescript
test('enabled worker cannot become ready with unavailable adapters', async () => {
  const readiness = await buildReadiness(enabledConfigWithMissingSigner);
  expect(readiness.ready).toBe(false);
  expect(readiness.components.attestationSigner).toMatchObject({ ready: false, reason: 'not_configured' });
});

test('claim generation fences a stale worker', async () => {
  const first = await claims.claimNext('worker-a');
  const second = await claims.reclaimExpired(first!.runId, 'worker-b');
  await expect(claims.complete(first!)).rejects.toMatchObject({ code: 'STALE_VERIFICATION_LEASE' });
  expect(second!.generation).toBe(first!.generation + 1);
});

test('rotated release signatures remain verifiable until explicit key revocation', async () => {
  const oldSignature = await keyring.activeSigner().sign(payload);
  await keyring.rotate(nextKey);
  expect(await keyring.verifier(oldSignature.keyId)!.verify(payload, oldSignature)).toBe(true);
  await keyring.revoke(oldSignature.keyId);
  expect(keyring.verifier(oldSignature.keyId)).toBeUndefined();
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @openopc/developer-trust-worker test && pnpm --filter kortix-api test -- module-signer-keyring.test.ts module-signing.test.ts`

Expected: FAIL because `main.ts` still mounts intentional unavailable adapters.

- [ ] **Step 3: Implement real adapter wiring**

Use AWS SDK S3 calls against path-style or virtual-host endpoints, streaming digest recomputation, PostgreSQL `FOR UPDATE SKIP LOCKED` claims with generation/heartbeat fencing, argv-only pinned scanner processes, separate read-only Ed25519 release/attestation key mounting, and runtime-specific WASI or independent-Runner OCI dry-runs with no ambient network or filesystem. Read keyrings from the staging secret-manager mount, support active/verify/revoked IDs, and prove rotation without claiming production KMS. Configuration must require image/binary identity digests and exact scanner versions when `DEVELOPER_TRUST_ENABLED=true`.

- [ ] **Step 4: Run GREEN and real dependency acceptance**

Run: `pnpm --filter @openopc/developer-trust-worker test && pnpm --filter @openopc/developer-trust-worker typecheck && pnpm --filter kortix-api test -- module-signer-keyring.test.ts module-signing.test.ts`

Integration: `docker compose -f deploy/openopc-modules/trust.compose.yml up --build --abort-on-container-exit trust-acceptance`

Expected: PASS with private MinIO, PostgreSQL, pinned Gitleaks/Syft/OSV/Semgrep, license policy, dry-run, SBOM, and DSSE provenance; killing one scanner yields `inconclusive` and readiness false.

- [ ] **Step 5: Commit**

```bash
git add apps/developer-trust-worker apps/api/src/developer/module-signer-keyring.ts apps/api/src/developer/module-signer-keyring.test.ts apps/api/src/developer/module-signer-config.ts apps/api/src/developer/module-signing.ts deploy/openopc-modules/trust.compose.yml pnpm-lock.yaml
git commit -m "feat(developer): mount concrete trust pipeline adapters"
```

### Task 6: Trust pipeline staging acceptance and release enablement gate

**Files:**
- Create: `tests/module-beta/trust/run.ts`
- Create: `tests/module-beta/trust/run.test.ts`
- Create: `tests/module-beta/trust/fixtures.ts`
- Create: `tests/module-beta/trust/fixtures/clean-wasi/kortix.yaml`
- Create: `tests/module-beta/trust/fixtures/clean-wasi/openopc.runtime.json`
- Create: `tests/module-beta/trust/fixtures/clean-wasi/echo.component.wasm`
- Create: `tests/module-beta/trust/fixtures/vulnerable-lockfile/package-lock.json`
- Modify: `tests/module-beta/evidence.json`
- Modify: `.github/workflows/qa-release.yml`

**Interfaces:**
- Produces: signed `tests/module-beta/out/G2-artifacts.json`, `G3-trust.json`, and `G4-malicious.json` evidence summaries.
- Consumes only staging endpoints that passed Task 0 target guards.

- [ ] **Step 1: Write the failing staging harness contract**

```typescript
test('a trust gate record cannot pass without real dependency identities', () => {
  expect(() => validateEvidence({ gate: 'G3', lane: 'integration', outcome: 'passed', dependencyIdentities: [] }))
    .toThrow('EVIDENCE_DEPENDENCY_IDENTITY_REQUIRED');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/module-beta/trust/run.test.ts`

Expected: FAIL because the staging harness and signed evidence output do not exist.

- [ ] **Step 3: Implement the harness**

The harness uses `fixtures.ts` to deterministically generate secret-leak, traversal, oversized-file, invalid-signature, stale-policy, and scanner-crash artifacts in a temporary output directory; generated attack artifacts are never committed. The format is canonical JSON with base64 file bytes and performs no archive decompression. It uploads each fixture through the real API, waits for immutable verification attempts, checks the exact terminal state/finding code, verifies artifact and SBOM digests from MinIO, verifies DSSE signature/key IDs, tests cross-account denial, runs retention/orphan cleanup, and records scanner binary/image identities. It must refuse mocked URLs and never set `DEVELOPER_TRUST_ENABLED` itself.

- [ ] **Step 4: Run GREEN against staging**

Run: `MODULE_BETA_API_URL=$MODULE_BETA_API_URL MODULE_BETA_WEB_URL=$MODULE_BETA_WEB_URL MODULE_BETA_RUNNER_URL=$MODULE_BETA_RUNNER_URL bun tests/module-beta/trust/run.ts`

Expected: clean WASI reaches `passed`; each malicious fixture reaches `failed` or `inconclusive` with the approved reason; G2-G4 evidence files validate and no production lane is claimed.

- [ ] **Step 5: Commit**

```bash
git add tests/module-beta/trust tests/module-beta/evidence.json .github/workflows/qa-release.yml
git commit -m "test(developer): gate trust pipeline on real staging evidence"
```

---

## Milestone 2: Module Execution

### Task 7: Runtime, consent, lease, evidence, and outbox schema

**Files:**
- Create: `packages/db/migrations/20260726200000000_module_runtime_control_plane.sql`
- Create: `packages/db/src/module-runtime-schema.test.ts`
- Create: `packages/db/scripts/module-runtime-migration.integration.test.ts`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces tables for runtime descriptors, install-consent revisions, Runner registrations/profiles, executions, leases, heartbeats, capability grants/uses, execution events/outputs/evidence, kill-switch generations, and transactional outbox.
- Execution states: `pending | awaiting_confirmation | dispatchable | leased | running | succeeded | failed | cancelled | unknown`.
- Terminal transition is accepted only when `(lease_id, generation, runner_id)` matches the active lease.

- [ ] **Step 1: Write failing schema/fencing tests**

```typescript
test('terminal evidence and consent snapshots are immutable', () => {
  expect(moduleExecutionEvidence.executionId).toBeDefined();
  expect(projectModuleConsentRevisions.permissionDigest).toBeDefined();
});
```

Add integration cases proving one dispatchable execution has one live lease, stale generations cannot finalize, terminal rows cannot mutate, outbox insertion shares the terminal transaction, and tenant mismatches do not disclose row existence.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @kortix/db test -- module-runtime-schema.test.ts`

Expected: FAIL because runtime tables are not exported.

- [ ] **Step 3: Add the additive migration**

Use UUID IDs, integer generations, integer resource/cost ceilings, `timestamptz` deadlines, digest checks, partial unique indexes for live leases, append-only triggers for consent/evidence/events/outbox, and PostgreSQL functions `claim_module_execution`, `heartbeat_module_execution`, and `finalize_module_execution` with explicit account/project/lease predicates.

- [ ] **Step 4: Run GREEN and G1 migration acceptance**

Run: `pnpm --filter @kortix/db test && pnpm --filter @kortix/db typecheck && pnpm --filter @kortix/db migrate:lint`

Integration: `DATABASE_URL=$MODULE_BETA_TEST_DATABASE_URL bun packages/db/scripts/module-runtime-migration.integration.test.ts`

Expected: fresh apply, idempotent second runner invocation, backup/restore rehearsal, and stale-finalizer denial all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/20260726200000000_module_runtime_control_plane.sql packages/db/src/module-runtime-schema.test.ts packages/db/scripts/module-runtime-migration.integration.test.ts packages/db/src/schema/kortix.ts packages/db/src/types.ts packages/db/src/index.ts
git commit -m "feat(modules): add fenced runtime control-plane schema"
```

### Task 8: Execution repository, service, private Runner protocol, and SDK

**Files:**
- Create: `apps/api/src/module-runtime/executions.ts`
- Create: `apps/api/src/module-runtime/executions.drizzle.ts`
- Create: `apps/api/src/module-runtime/executions.test.ts`
- Create: `apps/api/src/module-runtime/runner-protocol.ts`
- Create: `apps/api/src/module-runtime/runner-protocol.test.ts`
- Create: `apps/api/src/module-runtime/app.ts`
- Create: `apps/api/src/module-runtime/index.ts`
- Modify: `apps/api/src/index.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-executions.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-executions.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- Produces: `ModuleExecutionService.estimate`, `.create`, `.confirm`, `.cancel`, `.get`, `.events`.
- Private Runner methods: `register`, `heartbeatNode`, `claim`, `heartbeatLease`, `appendEvidence`, `finalize`; authentication uses Runner identity, not user tokens. `claim` returns `RunnerClaimResponseV1 { signedEnvelope, capabilityTokens }`; each delivered token must hash to the corresponding signed `WorkEnvelopeV1.grants[].tokenHash`.
- SDK methods: `estimateProjectModuleExecution`, `createProjectModuleExecution`, `confirmProjectModuleExecution`, `cancelProjectModuleExecution`, `getProjectModuleExecution`, `listProjectModuleExecutionEvents`.

- [ ] **Step 1: Write failing state-machine and protocol tests**

```typescript
test('unknown paid outcome is terminal and never auto-retried', async () => {
  const result = await service.finalize(runnerCommand({ outcome: 'unknown' }));
  expect(result.execution.state).toBe('unknown');
  expect(await repository.findDispatchable(result.execution.executionId)).toBeNull();
});

test('Runner cannot claim an unsupported profile', async () => {
  await expect(protocol.claim(wasiOnlyRunner, ociExecution)).rejects.toMatchObject({ code: 'RUNNER_PROFILE_UNAVAILABLE' });
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- module-runtime && pnpm --filter @kortix/sdk test -- module-executions`

Expected: FAIL because execution service and SDK methods do not exist.

- [ ] **Step 3: Implement the protocol and state machine**

Authorize account/project/installation/exact signed release before estimating. Sign work envelopes with a staging execution key, bind W3C `traceparent`, capability digests, kill-switch generation, lease deadline, and idempotency key. Deliver actual short-lived capability tokens only inside the mTLS-protected claim response; the Runner verifies each token hash against the signed envelope before use. Authenticate Runners with mTLS identity plus signed registration token; hash refresh tokens at rest. Limit event/output sizes, sanitize fields before persistence, and create usage outbox intents atomically with accepted terminal evidence.

- [ ] **Step 4: Run GREEN and focused protocol acceptance**

Run: `pnpm --filter kortix-api test -- module-runtime && pnpm --filter @kortix/sdk test -- module-executions && pnpm --filter kortix-api typecheck && pnpm --filter @kortix/sdk typecheck`

Expected: PASS for replay, cancellation, timeout, stale lease, unsupported profile, revoked release, permission change, and unknown paid outcome cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/module-runtime apps/api/src/index.ts packages/sdk/src/core/rest/projects-client packages/sdk/src/index.ts
git commit -m "feat(modules): add leased execution control plane"
```

### Task 9: Capability broker and mandatory egress proxy

**Files:**
- Create: `apps/api/src/module-runtime/capabilities.ts`
- Create: `apps/api/src/module-runtime/capabilities.drizzle.ts`
- Create: `apps/api/src/module-runtime/capabilities.test.ts`
- Create: `apps/module-egress-proxy/package.json`
- Create: `apps/module-egress-proxy/src/policy.ts`
- Create: `apps/module-egress-proxy/src/proxy.ts`
- Create: `apps/module-egress-proxy/src/proxy.test.ts`
- Create: `apps/module-egress-proxy/src/main.ts`
- Create: `apps/module-egress-proxy/Dockerfile`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `CapabilityBroker.issue(input): Promise<{ token: string; grant: CapabilityGrant }>` and `.revokeByExecution(executionId)`; token claims include `cnf` bound to the target Runner certificate thumbprint.
- Capability audience values: `secret`, `egress`, `model`, `desktop`, `paid-call`; the database stores only `sha256:` token hashes.
- Egress proxy accepts `Authorization: Bearer <capability>` plus a bound request and returns a bounded response; it never exposes the upstream credential.

- [ ] **Step 1: Write failing security-property tests**

```typescript
test('grant binds tenant, release, action, audience, lease, cost, and kill-switch generation', async () => {
  const { grant } = await broker.issue(validIssueInput);
  expect(grant).toMatchObject({ accountId, projectId, installationId, releaseDigest, audience: 'egress', leaseGeneration: 3 });
  expect(grant.maxCalls).toBe(1);
});

test('proxy rejects private DNS answers, redirects, replay, and oversized bodies', async () => {
  for (const attack of [privateDns, redirectedOrigin, replayedNonce, oversizedBody]) {
    expect((await proxy.handle(attack)).status).toBe(403);
  }
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- capabilities.test.ts && pnpm --filter @openopc/module-egress-proxy test`

Expected: FAIL because broker and proxy packages do not exist.

- [ ] **Step 3: Implement broker and proxy**

Sign short-lived audience-specific PASETO v4.public tokens with distinct staging keys. Bind account, project, installation, release digest, actor, action, nonce, expiry, lease/generation, Runner mTLS certificate thumbprint, and call/byte/CPU/time/cost ceilings. The consuming service verifies the mTLS proof before accepting the token, making copied tokens non-forwardable. Resolve DNS before connection, reject loopback/link-local/RFC1918/ULA/metadata ranges, pin resolved IP for the request, revalidate every redirect, allow only declared HTTPS origins/methods, stream with byte ceilings, strip hop-by-hop/auth/cookie headers, and emit sanitized use records. Advance kill-switch generation to invalidate outstanding grants.

- [ ] **Step 4: Run GREEN and G7 attack acceptance**

Run: `pnpm --filter kortix-api test -- capabilities.test.ts && pnpm --filter @openopc/module-egress-proxy test && pnpm --filter @openopc/module-egress-proxy typecheck`

Expected: PASS for token replay, wrong audience, stale lease, revocation, DNS rebinding, redirect-to-private, header smuggling, oversized request/response, and provider-body redaction cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/module-runtime/capabilities* apps/module-egress-proxy pnpm-lock.yaml
git commit -m "feat(modules): broker bounded runtime capabilities"
```

### Task 10: Rust Runner shell and cross-language protocol gate

**Files:**
- Create: `apps/module-runner/Cargo.toml`
- Create: `apps/module-runner/Cargo.lock`
- Create: `apps/module-runner/rust-toolchain.toml`
- Create: `apps/module-runner/src/main.rs`
- Create: `apps/module-runner/src/config.rs`
- Create: `apps/module-runner/src/protocol.rs`
- Create: `apps/module-runner/src/client.rs`
- Create: `apps/module-runner/src/evidence.rs`
- Create: `apps/module-runner/tests/contracts.rs`
- Create: `apps/module-runner/Dockerfile`
- Create: `.github/workflows/module-runner.yml`

**Interfaces:**
- Consumes Task 1 JSON schemas and fixtures without generated TypeScript/Rust drift.
- Produces `RunnerClient.claim() -> Option<RunnerClaimResponse>`, `heartbeat`, `append_evidence`, and `finalize`; the client discards any claim whose capability token hashes differ from the signed envelope.
- Produces health `/healthz` and readiness `/readyz`; readiness includes protocol version, node registration, Wasmtime identity, OCI profile status, drain, and capacity.

- [ ] **Step 1: Add the failing cross-language fixture test**

```rust
#[test]
fn parses_every_typescript_golden_fixture_and_rejects_invalid_ones() {
    assert!(parse_fixture("../../packages/module-runtime-contracts/fixtures/valid/wasi.json").is_ok());
    assert!(parse_fixture("../../packages/module-runtime-contracts/fixtures/valid/oci.json").is_ok());
    assert!(parse_fixture("../../packages/module-runtime-contracts/fixtures/invalid/oci-tag.json").is_err());
}
```

- [ ] **Step 2: Bootstrap the explicit toolchain and run RED**

Install for development/CI: `rustup toolchain install 1.97.1 --profile minimal --component clippy,rustfmt`

Run: `cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml`

Expected: FAIL because the Runner crate and protocol parser do not exist. The repository's Bun/TypeScript toolchain remains unchanged.

- [ ] **Step 3: Implement the private Runner shell**

Pin Rust `1.97.1` and exact crate versions in `Cargo.lock`; use `serde` with `deny_unknown_fields`, `reqwest` with rustls, `ed25519-dalek` for envelope verification, `tracing`/OpenTelemetry for sanitized spans, and zeroizing secret buffers. Refuse startup when control-plane public key, node identity, mTLS files, supported profiles, or contract version is missing. Claim over the private API, verify signature/deadline/digests/generation locally, heartbeat while running, and finalize once.

- [ ] **Step 4: Run GREEN and protocol compatibility**

Run: `cargo +1.97.1 fmt --manifest-path apps/module-runner/Cargo.toml -- --check && cargo +1.97.1 clippy --manifest-path apps/module-runner/Cargo.toml --all-targets -- -D warnings && cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml && pnpm --filter @openopc/module-runtime-contracts test`

Expected: PASS; TypeScript and Rust accept/reject identical golden fixtures and canonical digests.

- [ ] **Step 5: Commit**

```bash
git add apps/module-runner .github/workflows/module-runner.yml
git commit -m "feat(modules): add signed private Runner protocol"
```

### Task 11: Wasmtime 47 Component Model host

**Files:**
- Create: `apps/module-runner/wit/openopc-module.wit`
- Create: `apps/module-runner/src/wasi.rs`
- Create: `apps/module-runner/src/wasi/capabilities.rs`
- Create: `apps/module-runner/src/wasi/limits.rs`
- Create: `apps/module-runner/tests/wasi_execution.rs`
- Create: `apps/module-runner/tests/fixtures/components/echo.component.wasm`
- Create: `apps/module-runner/tests/fixtures/components/undeclared-import.component.wasm`
- Modify: `apps/module-runner/Cargo.toml`
- Modify: `apps/module-runner/Cargo.lock`
- Modify: `apps/module-runner/src/main.rs`

**Interfaces:**
- Produces: `WasiExecutor::execute(&SignedWorkEnvelope, &RuntimeDescriptorV1) -> TerminalEvidence`.
- WIT imports expose only `openopc:module/input`, `output`, `http`, `secret-use`, `model`, `usage`, and `log`; raw WASI sockets/process/environment are absent.
- Wasmtime and `wasmtime-wasi` are pinned to `47.0.2`.

- [ ] **Step 1: Write failing host-isolation tests**

```rust
#[tokio::test]
async fn undeclared_import_and_limit_breaches_fail_deterministically() {
    assert_eq!(run("undeclared-import.component.wasm").await.code, "WASI_IMPORT_DENIED");
    assert_eq!(run_with_fuel("echo.component.wasm", 1).await.code, "WASI_FUEL_EXHAUSTED");
    assert_eq!(run_cancelled("echo.component.wasm").await.code, "EXECUTION_CANCELLED");
}
```

- [ ] **Step 2: Run RED**

Run: `cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml --test wasi_execution`

Expected: FAIL because `WasiExecutor` and WIT bindings are absent.

- [ ] **Step 3: Implement Wasmtime hosting**

Configure Component Model, async support, fuel consumption, epoch interruption, pooling allocator ceilings, memory/table limits, and cache identity. Instantiate no ambient filesystem, network, process, environment, clock, or randomness imports. Preopen one immutable input handle and one bounded output sink through WIT. Route HTTP/Secret/model calls to Task 9 using audience-specific capabilities, hash evidence payloads, and map traps/cancellation/timeouts to stable codes without module stack or source leakage.

- [ ] **Step 4: Run GREEN and G5 focused acceptance**

Run: `cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml --test wasi_execution && cargo +1.97.1 clippy --manifest-path apps/module-runner/Cargo.toml --all-targets -- -D warnings`

Expected: echo succeeds; undeclared import, raw socket, filesystem escape, memory/fuel/output limit, timeout, and cancellation fixtures produce deterministic bounded evidence; mediated HTTPS succeeds only for a consented origin.

- [ ] **Step 5: Commit**

```bash
git add apps/module-runner
git commit -m "feat(modules): execute components with bounded Wasmtime host"
```

### Task 12: Independent OCI Runner with rootless containerd and gVisor

**Files:**
- Create: `apps/module-runner/src/oci.rs`
- Create: `apps/module-runner/src/oci/containerd.rs`
- Create: `apps/module-runner/src/oci/profile.rs`
- Create: `apps/module-runner/tests/oci_execution.rs`
- Create: `deploy/openopc-modules/runner/containerd-rootless.toml`
- Create: `deploy/openopc-modules/runner/daemon.json`
- Create: `deploy/openopc-modules/runner/apparmor-openopc-module`
- Create: `deploy/openopc-modules/runner/install-runner.sh`
- Create: `deploy/openopc-modules/runner/verify-host.sh`
- Modify: `apps/module-runner/src/main.rs`

**Interfaces:**
- Produces: `OciExecutor::execute(&SignedWorkEnvelope, &RuntimeDescriptorV1) -> TerminalEvidence`.
- Execution profiles are exact registered records; only `runsc` is accepted for internal-beta OCI work.
- Containerd interaction uses a private rootless socket owned by the Runner user; the socket is never mounted into the workload.

- [ ] **Step 1: Write failing OCI policy tests**

```rust
#[test]
fn rejects_unsafe_oci_spec_before_containerd() {
    for descriptor in [tagged_image(), privileged(), host_mount(), host_network(), docker_socket()] {
        assert_eq!(validate_oci(&descriptor).unwrap_err().code(), "OCI_PROFILE_DENIED");
    }
}
```

- [ ] **Step 2: Run RED**

Run: `cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml --test oci_execution`

Expected: FAIL because OCI validation and executor are absent.

- [ ] **Step 3: Implement OCI dispatch and host policy**

Use argv-only containerd client calls with a unique namespace, digest-only image pulls, signature/policy verification before unpack, `runsc` runtime handler, read-only rootfs, non-root UID/GID, all capabilities dropped, no-new-privileges, private namespaces, seccomp/AppArmor, tmpfs scratch, bounded input/output mounts, cgroup v2 CPU/memory/PID ceilings, and proxy-only network. Delete task/container/snapshot/content leases after bounded evidence capture. A host that is rootful, lacks user namespaces/cgroup v2/runsc, or exposes a public socket reports not ready.

- [ ] **Step 4: Run GREEN on an independent Linux Runner**

Run: `sudo -u openopc-runner deploy/openopc-modules/runner/verify-host.sh && cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml --test oci_execution -- --ignored`

Expected: benign digest-pinned container succeeds; host path/socket/device/namespace/metadata/private-network probes fail; escape probe leaves no host artifact; Runner drain prevents new claims.

- [ ] **Step 5: Commit**

```bash
git add apps/module-runner deploy/openopc-modules/runner
git commit -m "feat(modules): isolate OCI work on gVisor Runners"
```

### Task 13: Install consent, runtime confirmation, channels, canary, revoke, and exact rollback

**Files:**
- Create: `packages/db/migrations/20260726210000000_developer_module_channels_consent.sql`
- Create: `packages/db/src/developer-module-channel-consent-schema.test.ts`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/types.ts`
- Create: `apps/api/src/module-runtime/consent.ts`
- Create: `apps/api/src/module-runtime/consent.drizzle.ts`
- Create: `apps/api/src/module-runtime/consent.test.ts`
- Create: `apps/api/src/developer/channels.ts`
- Create: `apps/api/src/developer/channels.drizzle.ts`
- Create: `apps/api/src/developer/channels.test.ts`
- Modify: `apps/api/src/developer/installations.ts`
- Modify: `apps/api/src/developer/installations.drizzle.ts`
- Modify: `apps/api/src/developer/distribution.ts`
- Modify: `apps/api/src/projects/routes/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/project-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/project-modules.test.ts`

**Interfaces:**
- Produces: `diffModulePermissions(oldSnapshot, newSnapshot): PermissionDiff` and `requiresNewConsent(diff): boolean`.
- Produces immutable channel pointers `(moduleId, channel, releaseId, revision)` for `dev | beta | stable`.
- Produces canary policies with percentage/project allowlist, pause state, and exact prior release for rollback.

- [ ] **Step 1: Write failing consent and lifecycle tests**

```typescript
test('permission expansion pauses update until a project admin consents', async () => {
  const result = await installations.update(expandedPermissionRelease);
  expect(result.installation.status).toBe('consent_required');
  expect(result.installation.active_release_id).toBe(previousReleaseId);
});

test('rollback uses an exact historical signed release', async () => {
  expect((await installations.rollback(rollbackCommand)).installation.active_release_id).toBe(previousReleaseId);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- consent channels installations distribution`

Expected: FAIL because consent revisions and channel pointers are not enforced.

- [ ] **Step 3: Implement permission snapshots and immutable pointers**

Snapshot exact release digest, plan/price, actions, Secrets, Connectors, tools, writes, origins/methods, runtime/profile/limits, iframe abilities, compatibility, and update policy. Require project-admin authority at install and re-consent. Require runtime confirmation for Secret, new origin, desktop, camera/microphone/clipboard/download/popup, irreversible/sensitive writes, and paid operations above threshold. Promote only signed releases by pointer CAS; revoke blocks new work immediately; rollback verifies historical signature and consent.

- [ ] **Step 4: Run GREEN and G10 acceptance**

Run: `pnpm --filter @kortix/db test -- developer-module-channel-consent-schema.test.ts && pnpm --filter @kortix/db migrate:lint && pnpm --filter kortix-api test -- consent channels installations distribution && pnpm --filter @kortix/sdk test -- project-modules && pnpm --filter kortix-api typecheck`

Expected: Dev/Beta/Stable promotion, canary selection, pause, re-consent, revoke, and exact rollback pass without changing artifact bytes or prior evidence.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/20260726210000000_developer_module_channels_consent.sql packages/db/src/developer-module-channel-consent-schema.test.ts packages/db/src/schema/kortix.ts packages/db/src/types.ts apps/api/src/module-runtime/consent* apps/api/src/developer apps/api/src/projects/routes/developer-modules.ts packages/sdk/src/core/rest/projects-client/project-modules*
git commit -m "feat(modules): enforce consented release lifecycle"
```

---

## Milestone 3: UI And Commerce

### Task 14: Strict Schema UI contract and host renderer

**Files:**
- Create: `packages/module-runtime-contracts/schema/schema-ui.v1.schema.json`
- Create: `packages/module-runtime-contracts/src/schema-ui.ts`
- Create: `packages/module-runtime-contracts/src/schema-ui.test.ts`
- Create: `apps/web/src/features/module-host/schema-ui/catalog.tsx`
- Create: `apps/web/src/features/module-host/schema-ui/renderer.tsx`
- Create: `apps/web/src/features/module-host/schema-ui/bindings.ts`
- Create: `apps/web/src/features/module-host/schema-ui/renderer.test.tsx`
- Modify: `apps/web/package.json`

**Interfaces:**
- Produces `SchemaUiTreeV1` with signed root digest and components `page | panel | form | result | table | chart | task | workflow | asset`.
- Produces `renderSchemaUi(tree, context)`; events resolve typed SDK actions, never arbitrary code, URLs, styles, HTML, or imports.

- [ ] **Step 1: Write failing catalog and injection tests**

```tsx
test('renders a signed form and rejects executable props', () => {
  expect(renderToText(validFormTree)).toContain('Run analysis');
  expect(() => parseSchemaUi({ ...validFormTree, onClick: 'javascript:alert(1)' })).toThrow('SCHEMA_UI_INVALID');
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @openopc/module-runtime-contracts test -- schema-ui && pnpm --filter Kortix-Computer-Frontend test -- renderer.test.tsx`

Expected: FAIL because Schema UI parser and host renderer are absent.

- [ ] **Step 3: Implement the platform-owned catalog**

Validate node count/depth/string/data limits before React rendering. Map fixed component names to existing Google-style OpenOPC controls, use stable responsive dimensions, allow theme tokens instead of raw CSS, sanitize chart/table data, and route actions through a fixed SDK action registry. Render invalid or revoked trees as a compact host-owned error state.

- [ ] **Step 4: Run GREEN and responsive acceptance**

Run: `pnpm --filter @openopc/module-runtime-contracts test && pnpm --filter Kortix-Computer-Frontend test -- module-host && pnpm --filter Kortix-Computer-Frontend build`

Expected: valid page/form/table/chart/task/workflow fixtures render at 1440x900 and 390x844 without overflow, script execution, layout shift, or direct network calls.

- [ ] **Step 5: Commit**

```bash
git add packages/module-runtime-contracts apps/web/src/features/module-host/schema-ui apps/web/package.json
git commit -m "feat(modules): render strict platform Schema UI"
```

### Task 15: Cross-origin sandboxed Module Bridge

**Files:**
- Create: `packages/module-runtime-contracts/schema/module-bridge.v1.schema.json`
- Create: `packages/module-runtime-contracts/src/module-bridge.ts`
- Create: `packages/module-runtime-contracts/src/module-bridge.test.ts`
- Create: `apps/web/src/features/module-host/bridge/host.ts`
- Create: `apps/web/src/features/module-host/bridge/frame.tsx`
- Create: `apps/web/src/features/module-host/bridge/commands.ts`
- Create: `apps/web/src/features/module-host/bridge/host.test.ts`
- Create: `apps/api/src/module-runtime/module-bridge.ts`
- Create: `apps/api/src/module-runtime/module-bridge.test.ts`
- Create: `tests/module-beta/ui/bridge-attacks.ts`
- Create: `apps/module-web-host/package.json`
- Create: `apps/module-web-host/src/assets.ts`
- Create: `apps/module-web-host/src/assets.test.ts`
- Create: `apps/module-web-host/src/main.ts`
- Create: `apps/module-web-host/Dockerfile`
- Modify: `apps/web/next.config.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Handshake: `openopc.module.bridge/hello` -> parent-created `MessageChannel` -> `ready`; it binds account/project/installation/release/origin/nonce/expiry/allowedCommands.
- Commands: `query`, `execute`, `request-confirmation`, `open-asset`, `download`, `clipboard`, `popup`; parent resolves every command with SDK/IAM.
- The separate-origin `module-web-host` serves only immutable, trust-passed, release-digest-bound static assets with host-owned CSP; it cannot access Web cookies, API credentials, Runner endpoints, or unrestricted object storage.

- [ ] **Step 1: Write failing origin, nonce, and fuzz tests**

```typescript
test('rejects window messaging, wrong origin, replayed nonce, and oversized payload', async () => {
  for (const event of [windowPostMessage, wrongOrigin, replayedNonce, payloadOver64KiB]) {
    await expect(host.accept(event)).rejects.toMatchObject({ code: 'MODULE_BRIDGE_DENIED' });
  }
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @openopc/module-runtime-contracts test -- module-bridge && pnpm --filter Kortix-Computer-Frontend test -- bridge && pnpm --filter kortix-api test -- module-bridge`

Expected: FAIL because bridge contracts and host are absent.

- [ ] **Step 3: Implement iframe isolation and mediation**

Use a configured separate module origin, exact origin allowlist, and sandbox attributes `allow-scripts allow-same-origin`; because the iframe is on a distinct origin, it cannot remove the parent-enforced sandbox or access OpenOPC cookies, storage, or DOM. Omit forms, top-navigation, popup, download, pointer-lock, presentation, and modals from the sandbox by default. Send no bearer, signed URL, or Secret in messages; enforce host CSP, `worker-src 'none'`, per-command schema validation, a 64 KiB message ceiling, token-bucket rate limit, monotonically increasing sequence, expiry, release-revocation checks, and explicit user mediation for download, clipboard, media, and popup. The static host retrieves only the exact release prefix through a private scoped storage port, verifies every path, digest, and content type, sets `default-src 'none'` plus explicit script/style/resource policy, and refuses mutable caching. Parent sends only opaque asset IDs and typed results.

- [ ] **Step 4: Run GREEN and G7 browser attack acceptance**

Run: `pnpm --filter @openopc/module-runtime-contracts test && pnpm --filter Kortix-Computer-Frontend test -- bridge && pnpm --filter kortix-api test -- module-bridge && pnpm --filter @openopc/module-web-host test && pnpm --filter @openopc/module-web-host typecheck && MODULE_BETA_WEB_URL=$MODULE_BETA_WEB_URL bun tests/module-beta/ui/bridge-attacks.ts`

Expected: valid same-release channel works; origin/CSP/message fuzz, replay, permission escalation, cookie/storage access, Secret/signed-URL disclosure, popup, and download attacks fail.

- [ ] **Step 5: Commit**

```bash
git add packages/module-runtime-contracts apps/web/src/features/module-host/bridge apps/api/src/module-runtime/module-bridge* apps/module-web-host apps/web/next.config.ts pnpm-lock.yaml
git commit -m "feat(modules): isolate cross-origin module applications"
```

### Task 16: Pricing, orders, subscriptions, usage, split, and ledger schema

**Files:**
- Create: `packages/db/migrations/20260726300000000_module_sandbox_commerce.sql`
- Create: `packages/db/src/module-commerce-schema.test.ts`
- Create: `packages/db/scripts/module-commerce-migration.integration.test.ts`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces versioned plans for `free | one_time | subscription | metered` and immutable `module_price_snapshots`.
- Produces sandbox orders, subscriptions, accepted usage, ledger accounts/transactions/entries, split policies/snapshots, refunds, disputes, settlement periods/statements, and commerce outbox.
- Monetary values are integer minor units; metered prices are integer micro-units. Every ledger transaction sums to zero per currency.

- [ ] **Step 1: Write failing accounting invariants**

```typescript
test('commerce rows bind immutable price and split snapshots', () => {
  expect(moduleOrders.priceSnapshotId).toBeDefined();
  expect(moduleOrders.revenueSplitSnapshotId).toBeDefined();
  expect(moduleLedgerEntries.amountMinor).toBeDefined();
});
```

Add integration assertions that unbalanced transactions, floating price references, cross-environment account references, duplicate idempotency keys, and UPDATE/DELETE on entries/snapshots/statements fail.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @kortix/db test -- module-commerce-schema.test.ts`

Expected: FAIL because commerce tables are not exported.

- [ ] **Step 3: Add append-only commerce migration**

Namespace all beta financial rows with `environment='sandbox'`, use separate execution/usage/ledger idempotency keys, enforce one active plan version interval, snapshot exact plan/currency/unit/price and split selection, implement deferred balance constraint triggers, and use compensating transactions for refund/dispute corrections. The split selector order is module override, Publisher/tier override, then platform default.

- [ ] **Step 4: Run GREEN and migration accounting acceptance**

Run: `pnpm --filter @kortix/db test && pnpm --filter @kortix/db typecheck && pnpm --filter @kortix/db migrate:lint`

Integration: `DATABASE_URL=$MODULE_BETA_TEST_DATABASE_URL bun packages/db/scripts/module-commerce-migration.integration.test.ts`

Expected: all balance/immutability/environment/idempotency constraints pass; production credit/payable tables cannot reference sandbox ledger rows.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/20260726300000000_module_sandbox_commerce.sql packages/db/src/module-commerce-schema.test.ts packages/db/scripts/module-commerce-migration.integration.test.ts packages/db/src/schema/kortix.ts packages/db/src/types.ts packages/db/src/index.ts
git commit -m "feat(modules): add sandbox commerce ledger schema"
```

### Task 17: Commerce domain services and idempotent ledger worker

**Files:**
- Create: `apps/api/src/module-commerce/plans.ts`
- Create: `apps/api/src/module-commerce/orders.ts`
- Create: `apps/api/src/module-commerce/subscriptions.ts`
- Create: `apps/api/src/module-commerce/usage.ts`
- Create: `apps/api/src/module-commerce/refunds.ts`
- Create: `apps/api/src/module-commerce/disputes.ts`
- Create: `apps/api/src/module-commerce/statements.ts`
- Create: `apps/api/src/module-commerce/revenue-policy.ts`
- Create: `apps/api/src/module-commerce/repositories.drizzle.ts`
- Create: `apps/api/src/module-commerce/commerce.test.ts`
- Create: `apps/module-ledger-worker/package.json`
- Create: `apps/module-ledger-worker/src/postings.ts`
- Create: `apps/module-ledger-worker/src/worker.ts`
- Create: `apps/module-ledger-worker/src/worker.test.ts`
- Create: `apps/module-ledger-worker/src/main.ts`
- Create: `apps/module-ledger-worker/Dockerfile`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `ModuleCommerceService.estimate`, `.purchase`, `.startSubscription`, `.cancelSubscription`, `.acceptUsage`, `.refund`, `.openDispute`, `.resolveDispute`, `.closeSettlementPeriod`, `.getStatement`.
- Produces `LedgerWorker.processOutbox(batchSize): Promise<ProcessSummary>` using `FOR UPDATE SKIP LOCKED` and immutable posting keys.

- [ ] **Step 1: Write failing scenario and duplicate-delivery tests**

```typescript
test('duplicate usage delivery posts one balanced transaction', async () => {
  await repository.enqueue(message);
  await worker.processOutbox(10);
  await worker.processOutbox(10);
  const entries = await repository.entriesFor(message.usageId);
  expect(sumByCurrency(entries)).toEqual({ CNY: 0 });
  expect(uniqueTransactionIds(entries)).toHaveLength(1);
});

test('policy change does not rewrite prior economics', async () => {
  const order = await service.purchase(oldPolicyInput);
  await service.publishRevenuePolicy(newPolicy);
  expect((await service.getOrder(order.id)).splitSnapshotId).toBe(order.splitSnapshotId);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- module-commerce && pnpm --filter @openopc/module-ledger-worker test`

Expected: FAIL because commerce services and worker are absent.

- [ ] **Step 3: Implement sandbox commerce transitions**

Post customer debit/platform credit, provider/runtime cost allocation, developer gross, platform fee, developer net, reversals, and period-close payable transfers as balanced transaction templates. Bind orders, subscription periods, and usage batches to exact price/split snapshots. Bill only policy-approved completed units; unknown outcomes enter reconciliation and cannot auto-retry. The worker commits posting and outbox acknowledgement atomically and exposes imbalance/outbox-lag readiness.

- [ ] **Step 4: Run GREEN and G9 scenario acceptance**

Run: `pnpm --filter kortix-api test -- module-commerce && pnpm --filter @openopc/module-ledger-worker test && pnpm --filter @openopc/module-ledger-worker typecheck`

Expected: free, purchase, subscription renewal/cancel, metering, refund, dispute, module/Publisher/default split, settlement, duplicate delivery, worker crash, and retry scenarios balance exactly.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/module-commerce apps/module-ledger-worker pnpm-lock.yaml
git commit -m "feat(modules): post idempotent sandbox commerce ledger"
```

### Task 18: Commerce, execution, and Publisher SDK/API surfaces

**Files:**
- Create: `apps/api/src/module-commerce/app.ts`
- Create: `apps/api/src/module-commerce/app.test.ts`
- Create: `apps/api/src/admin/module-commerce.ts`
- Create: `apps/api/src/admin/module-commerce.test.ts`
- Modify: `apps/api/src/index.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-commerce.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-commerce.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `apps/api/scripts/dump-routes.ts`

**Interfaces:**
- Project endpoints expose estimates, purchases, subscriptions, executions, confirmations, usage views, refunds/disputes.
- Publisher endpoints expose plan versions, usage, revenue, statements, support-visible disputes.
- Admin endpoints expose policy versions, sandbox ledger inspection, dispute resolution, settlement close, Runner drain/kill switch, and readiness.

- [ ] **Step 1: Write failing route and SDK transport tests**

```typescript
test('all product clients have SDK methods and no direct Runner route', () => {
  expect(routes).toContain('POST /v1/projects/:projectId/modules/:moduleId/executions');
  expect(routes.some((route) => route.includes('/runner/') && !route.startsWith('PRIVATE '))).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- module-commerce/app admin/module-commerce && pnpm --filter @kortix/sdk test -- module-commerce`

Expected: FAIL because commerce routes and SDK methods are not mounted.

- [ ] **Step 3: Mount strict account/project/role-qualified APIs**

Use existing Hono/auth/error patterns, require idempotency and expected-revision headers for mutations, return opaque cross-tenant failures, never serialize ledger credentials/capability tokens/Runner endpoints, and expose only sandbox environment records. Add exact OpenAPI schemas and route-dump coverage.

- [ ] **Step 4: Run GREEN and G8 authority acceptance**

Run: `pnpm --filter kortix-api test -- module-commerce module-runtime developer && pnpm --filter @kortix/sdk test -- module && pnpm --filter kortix-api typecheck && pnpm --filter @kortix/sdk typecheck && bun apps/api/scripts/dump-routes.ts tests/spec/routes.generated.json`

Expected: Publisher/admin/project-admin/end-user matrices pass, cross-account existence stays opaque, and Web/Desktop can reach every product action through SDK methods only.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/module-commerce apps/api/src/admin/module-commerce* apps/api/src/index.ts apps/api/scripts/dump-routes.ts packages/sdk/src tests/spec/routes.generated.json
git commit -m "feat(modules): expose complete module platform SDK"
```

### Task 19: Developer CLI for build, validate, upload, release, and status

**Files:**
- Create: `apps/cli/src/commands/modules/build.ts`
- Create: `apps/cli/src/commands/modules/validate.ts`
- Create: `apps/cli/src/commands/modules/upload.ts`
- Create: `apps/cli/src/commands/modules/release.ts`
- Create: `apps/cli/src/commands/modules/status.ts`
- Create: `apps/cli/src/commands/modules/modules.test.ts`
- Create: `apps/cli/src/openopc.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/package.json`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- Commands: `openopc modules build`, `validate`, `upload`, `release submit`, `release promote`, `status`, with `--json` deterministic output. The existing `kortix` executable remains available for upstream compatibility.
- Build produces canonical archive digest, manifest digest, descriptor digest, file count, expanded bytes, and a local validation report; upload uses the existing ticket/finalize SDK flow.

- [ ] **Step 1: Write failing CLI contract tests**

```typescript
test('validate emits stable machine-readable findings', async () => {
  const result = await runCli(['modules', 'validate', fixture, '--json']);
  expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, findings: [{ code: 'OCI_IMAGE_DIGEST_REQUIRED' }] });
  expect(result.exitCode).toBe(2);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @kortix/cli test -- modules.test.ts`

Expected: FAIL with unknown `modules` command.

- [ ] **Step 3: Implement CLI commands**

Reuse `@kortix/registry`, `@openopc/module-runtime-contracts`, and `@kortix/sdk`; do not duplicate validators or call storage directly. Use sorted canonical archive entries, refuse symlinks/traversal/oversize files, redact local paths/tokens, resume multipart upload by upload ID, and print review/trust/channel/usage/statement state without polling forever.

- [ ] **Step 4: Run GREEN and CLI-to-staging acceptance**

Run: `pnpm --filter @kortix/cli test -- modules && pnpm --filter @kortix/cli typecheck`

Staging: `openopc modules validate tests/module-beta/trust/fixtures/clean-wasi --json && openopc modules upload tests/module-beta/trust/fixtures/clean-wasi --publisher $MODULE_BETA_PUBLISHER --json`

Expected: local digest equals server recomputation, upload resumes idempotently, status shows immutable trust attempts, and no credentials appear in output.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/modules apps/cli/src/openopc.ts apps/cli/src/index.ts apps/cli/package.json packages/sdk/src/index.ts
git commit -m "feat(developer): add module lifecycle CLI"
```

### Task 20: Complete Developer, Admin, finance, and project Web workbenches

**Files:**
- Create: `apps/web/src/app/(app)/developer/access/page.tsx`
- Create: `apps/web/src/app/(app)/developer/publishers/page.tsx`
- Create: `apps/web/src/app/(app)/developer/finance/page.tsx`
- Create: `apps/web/src/app/admin/developer-publishers/page.tsx`
- Create: `apps/web/src/app/admin/module-runtime/page.tsx`
- Create: `apps/web/src/app/admin/module-commerce/page.tsx`
- Create: `apps/web/src/features/developer-center/access/access-page.tsx`
- Create: `apps/web/src/features/developer-center/publisher/workbench-page.tsx`
- Create: `apps/web/src/features/developer-center/finance/finance-page.tsx`
- Create: `apps/web/src/features/developer-center/admin/publisher-admin-page.tsx`
- Create: `apps/web/src/features/developer-center/admin/runtime-admin-page.tsx`
- Create: `apps/web/src/features/developer-center/admin/commerce-admin-page.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/release-detail-page.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.tsx`
- Modify: `apps/web/src/features/project-modules/project-modules-page.tsx`
- Modify: `apps/web/src/features/developer-center/navigation.test.ts`
- Create: `apps/web/src/features/developer-center/complete-workbench.test.tsx`

**Interfaces:**
- Developer workbench covers access/verification, Publisher team, build guidance, upload, findings, review, immutable channels, usage, plans, statements, refunds/disputes, and support.
- Project modules page covers discovery, exact consent, purchase/subscription, execute/confirm, event/result view, updates/re-consent/revoke/rollback.
- Admin covers invitations/verification/suspension, review/sign/publish, Runner/readiness/kill switch, policy/ledger/dispute/settlement.

- [ ] **Step 1: Write failing workflow visibility tests**

```tsx
test('role-specific workbench exposes complete actions without leaking forbidden ones', async () => {
  expect(renderWorkbench('release_manager')).toHaveTextContent('Promote release');
  expect(renderWorkbench('release_manager')).not.toHaveTextContent('Settlement statements');
  expect(renderWorkbench('finance_viewer')).toHaveTextContent('Settlement statements');
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter Kortix-Computer-Frontend test -- complete-workbench.test.tsx navigation.test.ts`

Expected: FAIL because access, finance, runtime, and commerce workbenches do not exist.

- [ ] **Step 3: Implement quiet Google-style operational layouts**

Use the existing shell and navigation, compact full-width work areas, 8px-or-less cards only for repeated records, tabs for views, icons for commands, segmented channel controls, toggles for flags, tables/timelines for evidence and money, and confirmation dialogs for risky actions. Do not add marketing copy, accessibility work, keyboard systems, or global search beyond existing search. Every query/mutation uses `@kortix/sdk` and renders disabled/unready reasons.

- [ ] **Step 4: Run GREEN and focused Web acceptance**

Run: `pnpm --filter Kortix-Computer-Frontend test -- developer-center project-modules module-host && pnpm --filter Kortix-Computer-Frontend build && pnpm --filter Kortix-Computer-Frontend test:e2e:developer-center`

Expected: invited developer, Publisher roles, admin review, project install/execute, finance statement, and revoke/rollback views complete at 1440x900 and 390x844 with no horizontal overflow, blank state, unknown request, or console error.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app apps/web/src/features/developer-center apps/web/src/features/project-modules
git commit -m "feat(developer): complete module platform workbenches"
```

---

## Milestone 4: Deployment And Acceptance

### Task 21: Full and single-node Compose deployment profiles

**Files:**
- Create: `deploy/openopc-modules/compose.control-plane.yml`
- Create: `deploy/openopc-modules/compose.single-node.yml`
- Create: `deploy/openopc-modules/compose.runner.yml`
- Create: `deploy/openopc-modules/env.example`
- Create: `deploy/openopc-modules/validate-config.ts`
- Create: `deploy/openopc-modules/validate-config.test.ts`
- Create: `deploy/openopc-modules/README.md`
- Modify: `scripts/compose/docker-compose.yml`
- Modify: `apps/cli/src/self-host/assets/kortix-compose.yml`

**Interfaces:**
- Full profile: Web/API/control services plus private PostgreSQL/MinIO/scanners/broker/egress/ledger, with independent Runner registration.
- Single-node profile: declarative/WASI only; config validation rejects `MODULE_OCI_ENABLED=true` without independent Runner capacity.

- [ ] **Step 1: Write failing deployment-policy tests**

```typescript
test('single-node rejects OCI and no private service publishes a port', () => {
  expect(() => validateConfig({ profile: 'single-node', MODULE_OCI_ENABLED: 'true' })).toThrow('INDEPENDENT_RUNNER_REQUIRED');
  expect(publishedPrivatePorts(fullCompose)).toEqual([]);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test deploy/openopc-modules/validate-config.test.ts`

Expected: FAIL because deployment profiles and validator do not exist.

- [ ] **Step 3: Implement pinned private deployments**

Pin images by digest, use internal networks, read-only filesystems, tmpfs, dropped capabilities, no-new-privileges, health/readiness distinctions, secrets mounted read-only, and Baota-facing loopback Web/API ports only. Route the separate module hostname through Baota to `module-web-host` on the internal network without publishing its container port. Keep all module flags false in `env.example`. Never mount Docker/containerd sockets into Web, API, trust, ledger, proxy, module-web-host, or workload containers.

- [ ] **Step 4: Run GREEN and deployment smoke**

Run: `bun test deploy/openopc-modules/validate-config.test.ts && docker compose -f deploy/openopc-modules/compose.control-plane.yml config --quiet && docker compose -f deploy/openopc-modules/compose.single-node.yml config --quiet && docker compose -f deploy/openopc-modules/compose.runner.yml config --quiet`

Expected: both profiles validate; single-node readiness shows OCI unavailable by design; full profile sees registered independent Runner capacity; only Web/API reverse-proxy ports are published.

- [ ] **Step 5: Commit**

```bash
git add deploy/openopc-modules scripts/compose/docker-compose.yml apps/cli/src/self-host/assets/kortix-compose.yml
git commit -m "feat(deploy): add private module beta profiles"
```

### Task 22: Independent feature flags, readiness, metrics, and kill switches

**Files:**
- Create: `apps/api/src/module-runtime/readiness.ts`
- Create: `apps/api/src/module-runtime/readiness.test.ts`
- Create: `apps/api/src/module-runtime/metrics.ts`
- Create: `apps/module-ledger-worker/src/readiness.ts`
- Create: `apps/module-egress-proxy/src/readiness.ts`
- Modify: `apps/api/src/developer/trust-readiness.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `scripts/compose/docker-compose.yml`

**Interfaces:**
- Flags: `DEVELOPER_TRUST_ENABLED`, `MODULE_UI_BRIDGE_ENABLED`, `MODULE_WASI_ENABLED`, `MODULE_OCI_ENABLED`, `MODULE_SANDBOX_COMMERCE_ENABLED`; all default false.
- Readiness returns per-component `{ ready, identity, reason, checkedAt }` and never derives readiness from process health alone.

- [ ] **Step 1: Write failing readiness-isolation tests**

```typescript
test('one unavailable module dependency does not disable Kortix core', async () => {
  const view = await readiness.check({ wasmtime: down, coreApi: up });
  expect(view.features.wasi.ready).toBe(false);
  expect(view.core.ready).toBe(true);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kortix-api test -- readiness && pnpm --filter @openopc/module-ledger-worker test -- readiness && pnpm --filter @openopc/module-egress-proxy test -- readiness`

Expected: FAIL because aggregate module readiness does not exist.

- [ ] **Step 3: Implement readiness and telemetry**

Report storage, PostgreSQL claims, policy, each scanner, signer, sandbox, Wasmtime, OCI capacity, broker, egress, outbox, and ledger independently. Emit OpenTelemetry/Prometheus metrics for queue age, claims, heartbeat, stale lease, retries, cancellation, Runner capacity/version/drain/quarantine, scanner drift, orphan cleanup, resource denial/timeout/unknown, outbox lag, and imbalance. Redact prompts, credentials, signed URLs, raw source, and provider bodies at emission.

- [ ] **Step 4: Run GREEN and failure-injection acceptance**

Run: `pnpm --filter kortix-api test -- readiness metrics && pnpm --filter @openopc/module-ledger-worker test && pnpm --filter @openopc/module-egress-proxy test`

Expected: dependency failure disables only its required operation; kill-switch advance revokes grants and drains affected work; ordinary Kortix project/session/Agent/Marketplace/declarative reads stay healthy.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/module-runtime/readiness* apps/api/src/module-runtime/metrics.ts apps/api/src/developer apps/api/src/index.ts apps/module-ledger-worker/src/readiness.ts apps/module-egress-proxy/src/readiness.ts scripts/compose/docker-compose.yml
git commit -m "feat(modules): expose isolated readiness and operations"
```

### Task 23: Real G1-G10 staging acceptance suite

**Files:**
- Create: `tests/module-beta/run-gates.ts`
- Create: `tests/module-beta/run-gates.test.ts`
- Create: `tests/module-beta/gates/g1-migration.ts`
- Create: `tests/module-beta/gates/g2-artifacts.ts`
- Create: `tests/module-beta/gates/g3-trust.ts`
- Create: `tests/module-beta/gates/g4-malicious.ts`
- Create: `tests/module-beta/gates/g5-wasi.ts`
- Create: `tests/module-beta/gates/g6-oci.ts`
- Create: `tests/module-beta/gates/g7-ui-capability.ts`
- Create: `tests/module-beta/gates/g8-authority.ts`
- Create: `tests/module-beta/gates/g9-commerce.ts`
- Create: `tests/module-beta/gates/g10-release.ts`
- Modify: `tests/module-beta/evidence.json`
- Modify: `.github/workflows/qa-release.yml`

**Interfaces:**
- `run-gates.ts --gates G1,G2 --target staging` records immutable artifacts and updates evidence only after validation.
- Every gate names real dependency identities, exact commit, commands, timestamps, artifact digests, and cleanup results.

- [ ] **Step 1: Write failing orchestrator tests**

```typescript
test('focused or mocked results cannot satisfy a staging gate', () => {
  expect(() => promoteGate({ gate: 'G6', lane: 'focused', mocked: false })).toThrow('INTEGRATION_EVIDENCE_REQUIRED');
  expect(() => promoteGate({ gate: 'G6', lane: 'integration', mocked: true })).toThrow('MOCK_EVIDENCE_FORBIDDEN');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/module-beta/run-gates.test.ts`

Expected: FAIL because the gate orchestrator is absent.

- [ ] **Step 3: Implement gate orchestration and cleanup**

Drive only public SDK/API flows plus private test administration endpoints protected by staging identity. Include database backup/restore, MinIO retention/orphans, trust/malicious fixtures, Wasmtime imports/limits/cancel/egress, independent OCI escape/network probes, bridge/token attacks, tenant/role matrices, complete commerce scenarios, and release canary/re-consent/revoke/rollback. Record cleanup of accounts, projects, workloads, objects, and sandbox balances.

- [ ] **Step 4: Run GREEN on full staging profile**

Run: `bun tests/module-beta/run-gates.ts --gates G1,G2,G3,G4,G5,G6,G7,G8,G9,G10 --target staging`

Expected: G1-G10 have fresh integration/deployment evidence; OCI evidence identifies an independent Runner; no gate is satisfied by focused tests or mocks; no real money or production endpoint is touched.

- [ ] **Step 5: Commit**

```bash
git add tests/module-beta .github/workflows/qa-release.yml
git commit -m "test(modules): verify G1 through G10 on staging"
```

### Task 24: Visible Web and packaged Windows Desktop acceptance

**Files:**
- Create: `apps/web/scripts/e2e/module-beta-smoke.ts`
- Create: `apps/web/scripts/e2e/module-beta-pages.ts`
- Create: `apps/web/scripts/e2e/module-beta-pages.test.ts`
- Create: `apps/web/scripts/e2e/run-module-beta-smoke.mjs`
- Create: `apps/web/scripts/e2e/module-beta-electron-smoke.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/desktop-electron/package.json`
- Modify: `apps/desktop-electron/electron-builder.yml`
- Modify: `tests/module-beta/evidence.json`

**Interfaces:**
- Browser suite names invited developer, Publisher, admin, project install/execute, module UI, commerce, update/revoke/rollback workflows.
- Electron suite launches the packaged Windows artifact against staging and runs the same SDK-backed routes; it does not fake Desktop mode in a browser.

- [ ] **Step 1: Write failing workflow manifest tests**

```typescript
test('G11 requires every named workflow on Web desktop/mobile widths and packaged Electron', () => {
  expect(requiredRuns()).toEqual([
    'web-1440x900', 'web-390x844', 'windows-electron-publisher', 'windows-electron-project', 'windows-electron-admin',
  ]);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter Kortix-Computer-Frontend test -- module-beta-pages.test.ts`

Expected: FAIL because the G11 workflow manifest is absent.

- [ ] **Step 3: Implement visible Playwright and Electron checks**

Use real invited staging identities, capture screenshot/video/trace per workflow, assert visible status/evidence/statement values, fail on console/page/request errors, check canvas/image content where used, and assert no horizontal overflow or overlapping controls at both Web widths. Build `nsis` Windows package, launch it through the existing Electron smoke helper, and assert the Desktop display name is OpenOPC while internal upstream package IDs remain unchanged.

- [ ] **Step 4: Run GREEN and record G11**

Run Web: `MODULE_BETA_WEB_URL=$MODULE_BETA_WEB_URL pnpm --filter Kortix-Computer-Frontend test:e2e:module-beta`

Run Desktop on Windows: `pnpm --filter @kortix/desktop-electron build:win && MODULE_BETA_WEB_URL=$MODULE_BETA_WEB_URL pnpm --filter Kortix-Computer-Frontend test:e2e:module-beta:electron`

Expected: all named flows pass visibly with non-empty screenshots, no blank canvases, console errors, overlap, overflow, direct Runner calls, or lost Kortix Desktop behavior.

- [ ] **Step 5: Commit**

```bash
git add apps/web/scripts/e2e apps/web/package.json apps/desktop-electron/package.json apps/desktop-electron/electron-builder.yml tests/module-beta/evidence.json
git commit -m "test(modules): verify complete Web and Windows beta"
```

### Task 25: Upstream compatibility rehearsal and beta enablement decision

**Files:**
- Create: `scripts/release/module-beta-upstream-rehearsal.ts`
- Create: `scripts/release/module-beta-upstream-rehearsal.test.ts`
- Create: `tests/module-beta/gates/g12-upstream.ts`
- Create: `docs/runbooks/module-beta-enable-disable.md`
- Create: `docs/runbooks/module-beta-runner-compromise.md`
- Create: `docs/runbooks/module-beta-backup-restore.md`
- Modify: `tests/module-beta/evidence.json`
- Modify: `.github/workflows/qa-release.yml`

**Interfaces:**
- Rehearsal reports upstream base/head, conflict files, protected-core diff, SDK/API contract results, disabled-state results, and Core smoke artifacts.
- Enablement command returns `eligible: true` only when G1-G12 are fresh, staging-only, signed, and successful; it does not mutate flags.

- [ ] **Step 1: Write failing protected-boundary tests**

```typescript
test('enablement is denied for stale gates or protected Kortix rewrites', () => {
  expect(evaluateEnablement(staleEvidence).eligible).toBe(false);
  expect(evaluateEnablement({ ...freshEvidence, protectedCoreDiff: ['apps/api/src/sessions/state.ts'] }).eligible).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/module-beta-upstream-rehearsal.test.ts`

Expected: FAIL because compatibility rehearsal and enablement evaluator do not exist.

- [ ] **Step 3: Implement non-destructive rehearsal and runbooks**

Fetch the configured upstream ref, create a temporary rehearsal branch/worktree, rebase without touching the active worktree, run Registry/SDK/API/Kortix core project-session-Agent-Marketplace tests with all module flags false, audit extension-owned versus protected-core changes, then remove only the verified temporary worktree. Document enable, immediate disable, Runner drain/quarantine/kill-switch, grant revocation, evidence quarantine, database/object-store restore, ledger reconciliation, and rollback that preserves Schema v2 signatures and immutable financial records.

- [ ] **Step 4: Run G12 and the final evidence validator**

Run: `bun tests/module-beta/gates/g12-upstream.ts && pnpm test:packages && pnpm --filter kortix-api test && pnpm --filter Kortix-Computer-Frontend test && bun scripts/release/module-beta-targets.ts --check-fixture tests/module-beta/evidence.json`

Expected: clean upstream rehearsal or an explicit conflict report with no false pass; disabled-state core smoke passes; all G1-G12 evidence is fresh; evaluator reports eligibility without enabling production or staging flags.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/module-beta-upstream-rehearsal.ts scripts/release/module-beta-upstream-rehearsal.test.ts tests/module-beta/gates/g12-upstream.ts tests/module-beta/evidence.json docs/runbooks/module-beta-enable-disable.md docs/runbooks/module-beta-runner-compromise.md docs/runbooks/module-beta-backup-restore.md .github/workflows/qa-release.yml
git commit -m "test(modules): complete internal beta enablement evidence"
```

## Approved Design Traceability

| Approved design requirement | Implementing tasks | Primary verification |
| --- | --- | --- |
| Invitation-only developer verification, Publisher ownership/roles/suspension/audit | 2-3, 20 | Publisher migration integration, authority matrix, visible role workbenches |
| Strict Registry Schema v2 and digested `openopc.runtime.json`; no v1 path | 1, 4 | Registry regression plus strict descriptor/malicious fixtures |
| Full draft-to-revoked lifecycle, immutable automatic attempts, human review, segregation of duties | 3-6 | State-transition, keyring, trust, review, and G3/G4 tests |
| Separate staging release/attestation keys, rotation/revocation, no production KMS claim | 5-6 | Keyring unit tests and signed staging provenance identities |
| Declarative/Agent reuse; third-party `desktop-native` disabled | 4, 8, 13, 22 | Existing Kortix core tests and disabled-mode readiness |
| Schema UI with platform code only | 14 | Contract/catalog/injection/responsive renderer tests |
| Separate-origin iframe and versioned Module Bridge | 15 | CSP/origin/message/token attack suite and static-host tests |
| Install consent and high-risk runtime confirmation | 7, 9, 13, 20 | Permission diff, re-consent, confirmation, replay, and visible project flow |
| WASI Component Model with brokered WIT capabilities | 1, 8-11 | TypeScript/Rust golden contracts and G5 real execution |
| OCI only on independent rootless containerd plus gVisor Runner | 8, 10, 12, 21-23 | Host verification, escape probes, capacity/readiness, and G6 |
| Fenced leases, cancellation, bounded evidence, unknown paid outcome | 7-12 | PostgreSQL fencing, protocol state machine, failure injection, G5/G6 |
| Free, one-time, subscription, metered plans with immutable prices | 16-18, 20 | Commerce schema/domain/SDK/UI tests and G9 |
| Versioned split precedence, refunds, disputes, settlement statements | 16-18, 20 | Policy snapshot, balanced reversal, settlement, and finance-workbench tests |
| Sandbox accounting with no real charge or payout | 16-18, 21-23 | Environment isolation, adapter config validation, and G9 |
| Dev/Beta/Stable, canary, pause, update, re-consent, revoke, exact rollback | 13, 18, 20, 23 | Channel CAS and G10 end-to-end lifecycle |
| Per-dependency readiness, operations, kill switch, audit-safe telemetry | 5, 8-12, 17, 22 | Readiness isolation, redaction, drain/quarantine, imbalance/lag tests |
| Full and single-node deployment profiles | 21-22 | Compose config and live deployment smoke; single-node OCI denial |
| Web and packaged Windows Desktop; mobile deferred | 20, 24 | G11 visible Web widths and packaged Electron artifacts |
| Additive upstream-compatible Kortix boundary | Every task; final proof in 25 | G12 rebase rehearsal, protected diff audit, SDK/API/core smoke |
| Production activation and cancelled multimedia pages remain excluded | 0, 20-25 | Target/config guards, route audit, evidence evaluator, final checklist |

## Final Acceptance Checklist

- [ ] G1 records fresh apply, second apply, reset guard, backup, and restore against staging PostgreSQL.
- [ ] G2 records private MinIO/S3 digest, retention, orphan cleanup, and cross-tenant denial.
- [ ] G3 records real pinned scanners, CycloneDX SBOM, DSSE/in-toto provenance, and distinct staging key IDs.
- [ ] G4 records every malicious fixture failing closed, including scanner crash and stale policy.
- [ ] G5 records real Wasmtime 47.0.2 Component Model execution with denied ambient authority and deterministic limits/cancellation.
- [ ] G6 records independent rootless containerd/gVisor execution and host/socket/namespace/network escape denials.
- [ ] G7 records iframe/CSP/message/token/capability fuzzing with no Secret, bearer, signed URL, cookie, or provider-body leakage.
- [ ] G8 records opaque tenant denial and visible Publisher/admin/project-admin/end-user authority matrices.
- [ ] G9 records exact balanced free/purchase/subscription/meter/refund/dispute/split/settlement scenarios in `sandbox` only.
- [ ] G10 records immutable Dev/Beta/Stable pointers, canary, pause, re-consent, revoke, and exact rollback.
- [ ] G11 records named Web desktop/mobile-width and packaged Windows Electron workflows with visual artifacts and zero console errors.
- [ ] G12 records upstream rehearsal, protected-file audit, Kortix core smoke, SDK/API contract checks, and disabled-state preservation.
- [ ] The full profile and single-node profile both pass deployment validation; single-node OCI remains unavailable by design.
- [ ] Trust, Module Bridge, WASI, OCI, and sandbox-commerce flags remain false until an operator reviews the signed enablement ledger.
- [ ] No production payment/payout/KMS adapter, public developer registration, mobile acceptance, third-party `desktop-native`, or cancelled multimedia product page has been introduced.

## Execution Handoff

Execute one task at a time in the current branch or an explicitly approved isolated worktree. For each task: make the RED failure observable, implement only that task's interfaces, run its GREEN and focused acceptance commands, review the diff, then create the listed commit. Stop after Milestones 1, 2, and 3 for architecture/security review; stop after Task 25 for a human enablement decision. Do not enable a feature merely because focused or mocked tests pass.
