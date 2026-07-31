# OpenOPC Restricted Public-Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real public beta that is ready only for `openopc-restricted-public-beta-v1`: Web and Windows Desktop, open user registration, manually approved developers, personal/team multi-Agent work, copywriting, image generation, basic video generation, and reviewed WASI modules on a BaoTa control node plus private WASI execution node.

**Architecture:** This plan is an additive release-profile overlay. It preserves the complete public-beta registries and the approved Sigstore trust chain, introduces a protected exact restricted profile and restricted lane registry, binds that profile through evidence, manifests, certification, runtime feature policy, deployment, and approval, and fails closed when any deferred capability is reachable. Existing product foundations are accepted through real HTTP/browser/package tests; the missing text/video Studio slice is implemented through the existing typed Studio and Intelligence pipeline rather than through restored standalone multimedia products.

**Tech Stack:** TypeScript, Bun 1.3.14, pnpm 8.11.0, Next.js, React, Hono OpenAPI, Zod, Drizzle/PostgreSQL, Electron, Rust, Wasmtime, GitHub Actions OIDC, Cosign 3.1.2, Sigstore Bundle 0.3, RFC 8785, DSSE/SLSA, CycloneDX, BaoTa/Nginx, Docker Compose, OpenTelemetry, PostgreSQL PITR, S3-compatible object storage.

## Global Constraints

- Work in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`; the planning baseline is `6e8a567b9`.
- The approved scope contract is `docs/specs/2026-07-30-openopc-restricted-public-beta-design.md`.
- The release identity is exactly `openopc-restricted-public-beta-v1`; readiness output is exactly `ready_for: openopc-restricted-public-beta-v1` and never implies complete public-beta readiness.
- The release artifacts are exactly `web`, `admin`, `api`, `studio-worker`, `developer-trust-worker`, `wasi-runner`, and `desktop`.
- Required Gates are exactly `G1-G5`, `G8`, `G10-G12`, `B1-B5`, and `B7-B10`.
- Deferred Gates are exactly `G6`, `G7`, `G9`, and `B6`; they are recorded as `deferred_by_profile`, never as passed evidence.
- OCI Runner, Module App/iframe UI, sandbox commerce, real payment writes, native mobile, professional 3D, digital human, batch remix, real-time voice, and arbitrary remote artifact URLs remain disabled and unreachable.
- Preserve `PUBLIC_BETA_ARTIFACT_NAMES`, `PUBLIC_BETA_ARTIFACT_ROLE_POLICIES`, `PUBLIC_BETA_LANES`, and `PUBLIC_BETA_LANES_BY_GATE` as the complete-profile registries. Do not produce the restricted contract by filtering those registries at runtime.
- Preserve existing Kortix projects, sessions, Agents, multi-Agent collaboration, connectors, skills, files, IAM, SDK transport, CLI behavior, Desktop login, internal identifiers, and upstream compatibility.
- Do not restore standalone `/studio/video`, `/studio/voice`, `/studio/3d`, `/studio/digital-human`, or `/studio/batch-remix` product routes. Text, image, and basic video live in one Studio content workbench.
- Provider origins, model mappings, credentials, and feature policy are server-owned. Browser/API callers cannot submit an endpoint, provider credential, or raw artifact URL.
- Free credits use the current credit ledger and have no cash value. Payment, subscription, checkout, payout, refund, dispute, invoice, and settlement writes are unavailable for this profile.
- Do not use `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Preserve all pre-existing dirty and untracked files. In particular, do not discard the archive/safe-file work or `docs/specs/2026-07-30-openopc-restricted-public-beta-design.md`.
- Do not edit protected files listed in `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/progress.md` unless a later approved task explicitly owns one.
- Use `pnpm.cmd` in PowerShell, invoke `bun` directly, and use `cargo +1.97.1` for Runner work.
- Every implementation task uses auditable RED -> minimal GREEN -> focused regression -> independent review. Keep the first real failure output in the task report.
- Every commit command below is a proposed review boundary. Do not stage, commit, push, dispatch a release workflow, deploy, or open registration without renewed explicit authorization.
- A focused fixture pass is not release evidence. Readiness requires real same-commit staging, browser, package, dependency, restore, telemetry, signing, approval, and deployment evidence.
- Any open Critical or Important finding in an enabled or release-security boundary keeps the candidate `not_ready`.

---

## Current State and Blocking Order

The Sigstore certification plan at `docs/plans/2026-07-29-openopc-public-beta-sigstore-certification-implementation.md` is already in progress:

- Parent Task 1 is complete and independently reviewed.
- Parent Task 2 implementation is green (`55 pass / 0 fail`) but still needs persisted independent review closure.
- Parent Task 3 has a valid RED: the archive can transiently publish through a replaced staging root. This blocks all profile/workflow dispatch work.
- Parent Tasks 4-18 remain required for the restricted profile, with the exact seven-artifact and eighteen-Gate overrides in this plan.
- Parent Tasks 19-20 may follow the beta, except that one real online protected signing/verification sequence and a minimal operator runbook remain launch requirements.
- Parent Task 21 is narrowed to the restricted Gates, restricted topology, and one real online protected sequence.

Dependency order:

1. Task 1 closes the open candidate-file and archive security work.
2. Tasks 2-4 establish one protected profile, restricted lanes, runtime policy, and disabled-state contract.
3. Tasks 5-6 complete the profile-bound certification and protected workflows.
4. Tasks 7-10 close the enabled product surfaces and prove deferred surfaces unreachable.
5. Task 11 builds and verifies the restricted BaoTa/WASI deployment and operations boundary.
6. Task 12 runs the exact live sequence and opens registration gradually.

No task after Task 1 may dispatch a release workflow. Tasks 2-10 may be implemented locally after Task 1 is reviewed; Task 11 deployment and Task 12 live execution require all preceding review gates.

## File Map

### Release contract and trust chain

- `scripts/release/public-beta-release-profile.ts`: protected exact restricted profile, strict parser, and RFC 8785 digest.
- `scripts/release/public-beta-release-profile.test.ts`: profile identity, mutation, ordering, and digest tests.
- `tests/public-beta/restricted-release-profile.v1.schema.json`: machine-readable exact profile schema.
- `scripts/release/public-beta-restricted-lanes.ts`: explicit eighteen-lane registry and dependency overrides.
- `scripts/release/public-beta-restricted-lanes.test.ts`: exact Gate, service, artifact, dependency, and cycle tests.
- `scripts/release/public-beta-evidence-v2.ts`: profile-bound evidence validation while retaining the existing outcome enum.
- `scripts/release/public-beta-disabled-state.ts`: signed deferred-capability assessment parser and digest.
- `scripts/release/public-beta-artifacts.ts`: Artifact Manifest v2 with profile-bound exact artifact policy.
- `scripts/release/public-beta-release-manifest.ts`: Release Manifest v2, three digest layers, profile and disabled-assessment binding, readiness, and CLI.
- `scripts/release/public-beta-github-actions.ts`: authenticated source/certifier run metadata.
- `scripts/release/public-beta-source-candidate.ts`: restricted source descriptor and provisional evidence index.
- `scripts/release/public-beta-provenance.ts`: profile-bound artifact and release-root provenance.
- `scripts/release/public-beta-sigstore-policy.ts`, `public-beta-sigstore-bundle.ts`, `public-beta-cosign.ts`, and `public-beta-certified-provenance.ts`: retained Sigstore trust implementation.
- `scripts/release/public-beta-certifier.ts`: deterministic restricted certified-candidate assembly.
- `scripts/release/public-beta-approval.ts`: non-self protected approval bound to profile and candidate root.
- `.github/workflows/openopc-public-beta-gates.yml`: unprivileged eighteen-lane restricted source producer.
- `.github/workflows/openopc-public-beta-certify.yml`: protected profile-owning certifier.
- `.github/workflows/openopc-public-beta-approval.yml`: protected non-self approval and revalidation.

### Runtime policy and disabled state

- `packages/api-contract/src/release-profile.ts`: public runtime-profile status and stable unavailable error schema.
- `apps/api/src/release-profile/runtime.ts`: server-owned profile loading and capability decisions.
- `apps/api/src/release-profile/routes.ts`: read-only profile status and readiness surface.
- `apps/api/src/billing/routes/payments.ts` and `subscriptions.ts`: fail-closed commercial write boundary.
- `apps/api/src/developer/runtime-descriptors.ts`, `releases.ts`, `distribution.ts`, and `installations.ts`: WASI-only release-profile enforcement.
- `apps/web/src/features/billing/*`: no checkout/upgrade commands in restricted mode; free-credit visibility remains.
- `apps/web/src/features/developer-center/*` and `project-modules/*`: reviewed WASI-only user surfaces.
- `scripts/release/public-beta-disabled-state-audit.ts`: protected runtime/config/artifact/IAM/route/UI audit command.

### Enabled product surfaces

- Existing registration, developer application, Admin, team, Desktop, and module files named in the 2026-07-28 child plans remain the owning implementation.
- `packages/api-contract/src/studio/index.ts`: `text.generate`, `image.generate`, and `video.generate` wire contract.
- `packages/intelligence-contracts/src/schemas.ts` and `packages/intelligence-orchestration/src/*`: three Studio capability IDs through the existing task protocol.
- `packages/studio-runtime/src/provider.ts`: modality-aware provider, result, pricing, and trusted-cost types.
- `packages/studio-adapters/src/media/text.ts`, `image.ts`, and `video.ts`: bounded output validation.
- `packages/studio-adapters/src/providers/openai-compatible/*`: approved text/image adapter.
- `packages/studio-adapters/src/providers/platform-video/*`: server-configured async basic-video adapter with fixed-origin policy.
- `apps/studio-worker/src/*`: leased execution, result staging, retry/cancel/reconcile, and metrics for all three modalities.
- `packages/db/migrations/20260730120000000_restricted_beta_studio_capabilities.sql`: additive Studio/Intelligence capability and asset-kind constraints.
- `packages/sdk/src/core/rest/projects-client/intelligence-studio.ts`: SDK source of truth for content workbench operations.
- `apps/web/src/features/studio/content-studio-page.tsx`: unified text/image/video workbench.
- `apps/web/scripts/e2e/restricted-public-beta-smoke.ts`: real desktop/mobile Web and Electron request/DOM/package acceptance.

### Deployment and operations

- `deploy/openopc-public-beta/control-node/*`: BaoTa Compose, strict Nginx render, secret-file validation, and control-node verification.
- `deploy/openopc-public-beta/execution-node/*`: WASI Runner plus controlled egress only.
- `deploy/openopc-public-beta/observability/*`: restricted-service OTel, dashboards, alerts, and verifier.
- `deploy/openopc-public-beta/backup/*`: isolated PostgreSQL/object backup and restore proof.
- `deploy/openopc-public-beta/deploy.ts`: resumable profile-bound deployment.
- `deploy/openopc-public-beta/verify-two-node.ts`: B10 exposure, identity, artifact, and private-service verification.
- `docs/runbooks/openopc-restricted-public-beta.md`: exact preflight, rollout, freeze, expansion, and rollback procedure.

---

### Task 1: Close Same-Descriptor and Raw-Archive Security Reviews

**Files:**
- Modify: `scripts/release/public-beta-archive.ts`
- Modify: `scripts/release/public-beta-archive.test.ts`
- Modify: `scripts/release/public-beta-archive-directory-race.test.ts`
- Modify only if a failing ownership test requires it: `scripts/release/public-beta-archive-fd-ownership.test.ts`
- Modify only if a failing limit test requires it: `scripts/release/public-beta-archive-fd-limit.test.ts`
- Review without weakening: `scripts/release/public-beta-safe-files.ts`
- Update: `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/task-2-report.md`
- Create: `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/task-2-review-report.md`
- Create: `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/task-3-report.md`
- Create: `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/task-3-review-report.md`
- Modify: `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/progress.md`

**Interfaces:**
- Retains: `authenticateAndExtractPublicBetaArchive(input): Promise<PublicBetaArchiveExtraction | false>`.
- Invariant: archive hashing, central-directory parsing, yauzl reads, streamed extraction, and final snapshot all use one authenticated descriptor lifetime.
- Invariant: output descriptors are created at their final paths inside the owned staging directory before provider streams begin; extraction writes through retained descriptors and never performs a per-file rename through a re-resolved staging path.
- Invariant: cleanup removes only an identity-bound file/directory created by this invocation; an unprovable replacement is left untouched and the operation fails closed.

- [ ] **Step 1: Reproduce and retain the current RED**

Run:

```powershell
bun test scripts/release/public-beta-archive-directory-race.test.ts --test-name-pattern "does not publish a payload through a staging root replaced at the file target boundary"
```

Expected current result:

```text
0 pass
1 fail
outsidePayloadObserved
Expected: false
Received: true
```

- [ ] **Step 2: Strengthen the mutation at the retained-descriptor boundary**

Change the test harness so the attacker swaps the staging directory after every target file has been created but before the first stream writes. Keep these assertions:

```ts
expect(attackObserved).toBe(true);
expect(result).toBe(false);
expect(outsidePayloadObserved).toBe(false);
expect(readFileSync(outsideSentinel, 'utf8')).toBe('keep');
```

Also assert any bytes written through retained descriptors exist only under the displaced directory identity and are removed only when that exact identity can be rebound safely.

- [ ] **Step 3: Implement prepare-all-targets, then stream-to-retained-FDs**

Replace the sibling `.payload-*` plus per-file publish rename with a preparation phase:

```ts
interface PreparedOutput {
  descriptor: number | null;
  relativePath: string;
  path: string;
  initial: FileSnapshot;
}

function prepareOutputFiles(
  files: readonly InspectedFile[],
  stagingPath: string,
  stagingIdentity: DirectoryIdentity,
): PreparedOutput[] | false;
```

Create parent directories, create each final target with `O_CREAT | O_EXCL` (and `O_NOFOLLOW` where supported), retain every descriptor, then revalidate staging identity and every descriptor/path snapshot before opening the first ZIP entry stream. `extractFile` receives only the retained descriptor and never opens or renames the target path.

- [ ] **Step 4: Close yauzl and cleanup lifetime paths**

Use one explicit owner bit for the archive descriptor and one awaited `closeZipFile()` path. Close all prepared output descriptors in `finally`, even when CRC, size, stream, snapshot, or directory identity validation fails. Quarantine cleanup remains identity-bound; never use a check followed by recursive deletion of the original path.

- [ ] **Step 5: Run focused GREEN and resource probes**

```powershell
bun test scripts/release/public-beta-archive-directory-race.test.ts
bun test scripts/release/public-beta-archive-fd-ownership.test.ts
bun test scripts/release/public-beta-archive-fd-limit.test.ts
bun test scripts/release/public-beta-archive.test.ts
```

Expected: all tests pass; descriptor-count probes return to baseline; no payload appears outside the owned staging identity.

- [ ] **Step 6: Run the full public-beta regression**

```powershell
bun test scripts/release/public-beta-canonical-json.test.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-safe-files-open-guard.test.ts scripts/release/public-beta-archive.test.ts scripts/release/public-beta-archive-directory-race.test.ts scripts/release/public-beta-archive-fd-ownership.test.ts scripts/release/public-beta-archive-fd-limit.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-evidence-v2.test.ts scripts/release/public-beta-lanes.test.ts scripts/release/public-beta-program.test.ts scripts/release/public-beta-release-manifest.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-archive.ts scripts/release/public-beta-archive.test.ts scripts/release/public-beta-archive-directory-race.test.ts scripts/release/public-beta-archive-fd-ownership.test.ts scripts/release/public-beta-archive-fd-limit.test.ts scripts/release/public-beta-safe-files.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-release-manifest.ts
git diff --check
```

- [ ] **Step 7: Persist independent security closure**

The reviewer must inspect the exact no-index diff and explicitly cover transient outside-write, symlink/junction/reparse mutation, output descriptor ownership, yauzl closure, CRC/size/ZIP64 bounds, cleanup replacement, and same-descriptor file reads. Update the SDD ledger only after zero Critical/Important findings remain.

- [ ] **Step 8: Proposed commit boundary**

```powershell
git add scripts/release/public-beta-archive.ts scripts/release/public-beta-archive.test.ts scripts/release/public-beta-archive-directory-race.test.ts scripts/release/public-beta-archive-fd-ownership.test.ts scripts/release/public-beta-archive-fd-limit.test.ts scripts/release/public-beta-safe-files.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-safe-files-open-guard.test.ts scripts/release/public-beta-release-manifest.ts .superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation
git commit -m "fix(release): close candidate archive races"
```

Do not run this commit without explicit authorization; stage only files actually changed by this task.

---

### Task 2: Define the Protected Restricted Release Profile

**Files:**
- Create: `scripts/release/public-beta-release-profile.ts`
- Create: `scripts/release/public-beta-release-profile.test.ts`
- Create: `tests/public-beta/restricted-release-profile.v1.schema.json`

**Interfaces:**
- Produces: `OpenOpcRestrictedPublicBetaProfileV1`.
- Produces: `OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE`.
- Produces: `OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST`.
- Produces: `parseOpenOpcRestrictedPublicBetaProfile(value)` and `computeOpenOpcRestrictedPublicBetaProfileDigest(profile)`.
- Does not modify or derive from the complete artifact/lane registries at runtime.

```ts
export interface OpenOpcRestrictedPublicBetaProfileV1 {
  schemaVersion: 1;
  id: 'openopc-restricted-public-beta-v1';
  artifacts: readonly [
    'web', 'admin', 'api', 'studio-worker',
    'developer-trust-worker', 'wasi-runner', 'desktop',
  ];
  requiredGates: readonly [
    'G1', 'G2', 'G3', 'G4', 'G5', 'G8', 'G10', 'G11', 'G12',
    'B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B9', 'B10',
  ];
  deferredGates: readonly ['G6', 'G7', 'G9', 'B6'];
}
```

- [ ] **Step 1: Write strict profile RED tests**

Test exact order and membership, deep immutability, exact keys, canonical digest stability, schema agreement, and rejection of missing, duplicate, reordered, renamed, extra, or complete-profile artifacts/Gates.

```ts
test('owns one immutable seven-artifact restricted profile', () => {
  const profile = parseOpenOpcRestrictedPublicBetaProfile(
    structuredClone(OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE),
  );
  expect(profile.artifacts).toEqual([
    'web', 'admin', 'api', 'studio-worker',
    'developer-trust-worker', 'wasi-runner', 'desktop',
  ]);
  expect(computeOpenOpcRestrictedPublicBetaProfileDigest(profile)).toBe(
    OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
  );
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-profile.test.ts`

Expected: FAIL because the protected profile module does not exist.

- [ ] **Step 3: Implement one literal profile and RFC 8785 digest**

Use `canonicalPublicBetaJson()` and `computeCanonicalPublicBetaDigest()`. Parse with exact keys and exact tuple equality; do not sort, filter, accept aliases, or accept a candidate-supplied profile body. Recursively freeze the exported profile.

- [ ] **Step 4: Run GREEN and mutation tests**

```powershell
bun test scripts/release/public-beta-release-profile.test.ts scripts/release/public-beta-canonical-json.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-release-profile.ts scripts/release/public-beta-release-profile.test.ts
```

- [ ] **Step 5: Independent contract review**

Review the literal against design sections 9 and 10. Confirm the digest is recomputed from strict canonical JSON, excluded artifacts cannot appear, deferred Gates cannot be reclassified, and no complete registry changed.

- [ ] **Step 6: Proposed commit boundary**

```powershell
git add scripts/release/public-beta-release-profile.ts scripts/release/public-beta-release-profile.test.ts tests/public-beta/restricted-release-profile.v1.schema.json
git commit -m "feat(release): define restricted public beta profile"
```

---

### Task 3: Add the Explicit Restricted Lane and Evidence Contract

**Files:**
- Create: `scripts/release/public-beta-restricted-lanes.ts`
- Create: `scripts/release/public-beta-restricted-lanes.test.ts`
- Modify: `scripts/release/public-beta-evidence-v2.ts`
- Modify: `scripts/release/public-beta-evidence-v2.test.ts`
- Modify: `tests/public-beta/evidence.v2.schema.json`
- Modify: `tests/public-beta/evidence.v2.fixture.json`

**Interfaces:**
- Produces: `OPENOPC_RESTRICTED_PUBLIC_BETA_LANES` and `OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE`.
- Produces: `validateOpenOpcRestrictedPublicBetaLanes()`.
- Extends `PublicBetaEvidenceLedgerV2` with required `releaseProfileId` and `releaseProfileDigest` fields.
- Extends `ValidatePublicBetaEvidenceOptions` with `profile` and `lanes`; protected callers pass the authoritative profile and restricted registry.
- Retains `PublicBetaEvidenceRecordV2['outcome'] = 'passed' | 'failed' | 'blocked'` unchanged.

Exact restricted dependencies:

```ts
const dependencies = {
  G1: [], G2: [], G3: ['G2'], G4: ['G3'], G5: ['G3'],
  G8: ['B1', 'B3'], G10: ['G5', 'G8'],
  G11: ['B1', 'B2', 'B3'], G12: ['B9'],
  B1: [], B2: ['B1'], B3: ['B1'],
  B4: ['G3', 'G4', 'G5', 'G8', 'G10'],
  B5: ['G5'], B7: ['G1', 'G2'], B8: ['B5'],
  B9: ['G11'], B10: ['B7', 'B8', 'G12'],
} as const;
```

- [ ] **Step 1: Write exact restricted-registry RED tests**

Assert eighteen entries, exact lane names, exact dependencies above, no deferred Gate, no `module-host`, `oci-runner`, `module-ledger-worker`, or `automation-browser-worker` artifact/service requirement. Assert `B5.requiredServices` is exactly `['wasi-runner', 'egress-proxy']`; assert B8 covers only deployed services.

- [ ] **Step 2: Write profile-bound evidence RED tests**

Assert wrong/missing profile ID or digest, a deferred Gate record, a missing required Gate, complete-registry lane metadata, and an artifact-set digest for eleven artifacts all fail with owning `PUBLIC_BETA_EVIDENCE_*` reasons. Assert no `skipped` or `not_applicable` outcome parses.

- [ ] **Step 3: Run RED**

```powershell
bun test scripts/release/public-beta-restricted-lanes.test.ts scripts/release/public-beta-evidence-v2.test.ts
```

Expected: FAIL because the restricted registry and profile-bound ledger fields are absent.

- [ ] **Step 4: Implement the explicit registry**

Write eighteen literal lane definitions. A shared validation helper may validate metadata, but creation must not call `PUBLIC_BETA_LANES.filter()`, map over the complete registry, or inherit deferred dependencies at runtime.

- [ ] **Step 5: Make evidence validation profile-aware**

Validate ledger profile identity/digest before records. Use the passed restricted `lanes` for gate membership, canonical lane name, freshness, and dependency checks. Require a passed, fresh record for each required Gate and reject any record whose Gate is not in the profile. Keep B7's seven-day restore plus 24-hour smoke companion rule and B10's 24-hour freshness.

- [ ] **Step 6: Run GREEN and complete-registry non-regression**

```powershell
bun test scripts/release/public-beta-restricted-lanes.test.ts scripts/release/public-beta-lanes.test.ts scripts/release/public-beta-evidence-v2.test.ts scripts/release/public-beta-program.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-restricted-lanes.ts scripts/release/public-beta-restricted-lanes.test.ts scripts/release/public-beta-evidence-v2.ts scripts/release/public-beta-evidence-v2.test.ts
```

- [ ] **Step 7: Independent dependency review**

Review every restricted lane against design section 10.3. Confirm no caller derives restricted dependencies by deletion, deferred Gate records are rejected, and complete-profile registry tests remain unchanged and green.

- [ ] **Step 8: Proposed commit boundary**

```powershell
git add scripts/release/public-beta-restricted-lanes.ts scripts/release/public-beta-restricted-lanes.test.ts scripts/release/public-beta-evidence-v2.ts scripts/release/public-beta-evidence-v2.test.ts tests/public-beta/evidence.v2.schema.json tests/public-beta/evidence.v2.fixture.json
git commit -m "feat(release): bind evidence to restricted gates"
```

---

### Task 4: Enforce Server-Owned Runtime Policy and Disabled-State Evidence

**Files:**
- Create: `packages/api-contract/src/release-profile.ts`
- Modify: `packages/api-contract/src/index.ts`
- Create: `apps/api/src/release-profile/runtime.ts`
- Create: `apps/api/src/release-profile/runtime.test.ts`
- Create: `apps/api/src/release-profile/routes.ts`
- Create: `apps/api/src/release-profile/routes.test.ts`
- Modify: `apps/api/src/billing/routes/payments.ts`
- Modify: `apps/api/src/billing/routes/subscriptions.ts`
- Modify: `apps/api/src/developer/runtime-descriptors.ts`
- Modify: `apps/api/src/developer/releases.ts`
- Modify: `apps/api/src/developer/distribution.ts`
- Modify: `apps/api/src/developer/installations.ts`
- Modify: affected tests beside those files
- Modify: `apps/web/src/features/billing/upgrade-button.tsx`, `global-upgrade-modal.tsx`, `team-plan-checkout.tsx`, and their tests
- Create: `scripts/release/public-beta-disabled-state.ts`
- Create: `scripts/release/public-beta-disabled-state.test.ts`
- Create: `scripts/release/public-beta-disabled-state-audit.ts`
- Create: `scripts/release/public-beta-disabled-state-audit.test.ts`
- Create: `tests/public-beta/disabled-state-assessment.v1.schema.json`

**Interfaces:**

```ts
export type RestrictedRuntimeCapability =
  | 'studio.text.generate' | 'studio.image.generate' | 'studio.video.generate'
  | 'module.wasi.execute' | 'module.oci.execute' | 'module.app.render'
  | 'commerce.purchase' | 'commerce.settlement'
  | 'native.mobile' | 'studio.3d' | 'studio.digital-human'
  | 'studio.batch-remix' | 'voice.realtime' | 'artifact.remote-url';

export const RELEASE_PROFILE_UNAVAILABLE =
  'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE' as const;

export interface DisabledStateAssessmentV1 {
  schemaVersion: 1;
  releaseProfileId: 'openopc-restricted-public-beta-v1';
  releaseProfileDigest: `sha256:${string}`;
  commit: string;
  controlSha: string;
  records: DisabledCapabilityRecordV1[];
  assessmentDigest: `sha256:${string}`;
}
```

Each disabled record includes exact artifact absence, deployed-service absence, server flag false, API/CLI rejection observations, IAM capability absence, legacy/direct-route rejection, and UI advertisement false.

- [ ] **Step 1: Write runtime-policy RED tests**

Assert missing/malformed profile configuration produces a non-ready runtime with all optional capabilities disabled. Assert the exact approved ID and digest enable only text/image/video and reviewed WASI. Assert caller parameters cannot enable OCI, Module App, commerce, remote URLs, mobile, 3D, digital human, batch remix, or real-time voice.

- [ ] **Step 2: Write direct-request and commercial RED tests**

Exercise service functions and real Hono routes. OCI descriptors, remote artifact URLs, payment/subscription writes, and legacy direct routes return the stable unavailable code without calling repositories, Stripe, object fetch, Runner dispatch, or signing. Free-credit read/use paths remain available.

- [ ] **Step 3: Run RED**

```powershell
pnpm.cmd --filter @kortix/api-contract test
pnpm.cmd --filter kortix-api exec bun test src/release-profile src/developer/runtime-descriptors.test.ts src/developer/releases.test.ts src/developer/distribution.test.ts src/developer/installations.test.ts src/billing
bun test scripts/release/public-beta-disabled-state.test.ts scripts/release/public-beta-disabled-state-audit.test.ts
```

- [ ] **Step 4: Implement fail-closed runtime loading**

`loadRuntimeReleaseProfile()` consumes only deployment environment values for ID and digest, compares them with the compiled protected profile identity, and exposes immutable decisions. A mismatch keeps `/readyz` non-ready. Route guards accept a `RestrictedRuntimeCapability`, never a user-supplied feature name.

- [ ] **Step 5: Guard existing disabled operations without deleting them**

Retain complete-profile code for future work, but guard every entry before side effects. Do not alter credit reads, free-tier grants, meeting TTS, or generic sandbox preview behavior unless the disabled audit proves they expose a deferred public-beta product. Remove only restricted-profile navigation/advertising, not underlying future code.

- [ ] **Step 6: Implement protected disabled-state assessment**

The audit consumes the protected profile, exact artifact manifest, deployment inventory, runtime profile endpoint, IAM export, route/CLI probe results, and rendered UI route inventory. It rejects self-reported booleans without raw evidence artifacts and computes `assessmentDigest` with the shared canonical primitive.

- [ ] **Step 7: Run GREEN and no-side-effect probes**

```powershell
pnpm.cmd --filter @kortix/api-contract test
pnpm.cmd --filter @kortix/api-contract typecheck
pnpm.cmd --filter kortix-api exec bun test src/release-profile src/developer src/billing
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/billing
bun test scripts/release/public-beta-disabled-state.test.ts scripts/release/public-beta-disabled-state-audit.test.ts
```

- [ ] **Step 8: Independent policy review**

Review API ordering to prove guards run before side effects, verify absence of arbitrary endpoint/URL fallback, verify payment writes remain unreachable while free credits work, and inspect UI/SDK/CLI legacy paths.

- [ ] **Step 9: Proposed commit boundary**

```powershell
git add packages/api-contract/src apps/api/src/release-profile apps/api/src/billing/routes apps/api/src/developer apps/web/src/features/billing scripts/release/public-beta-disabled-state* tests/public-beta/disabled-state-assessment.v1.schema.json
git commit -m "feat(beta): enforce restricted runtime policy"
```

---

### Task 5: Bind Profile, Seven Artifacts, and Disabled Assessment into Certification

**Files:**
- Modify/Create the files owned by parent Sigstore Tasks 4-15: `scripts/release/public-beta-github-actions.ts`, `public-beta-sigstore-policy.ts`, `public-beta-source-candidate.ts`, `public-beta-artifacts.ts`, `public-beta-provenance.ts`, `public-beta-sigstore-bundle.ts`, `public-beta-cosign.ts`, `public-beta-certified-provenance.ts`, `public-beta-release-root.ts`, `public-beta-release-manifest.ts`, `public-beta-certifier.ts`, and their focused tests.
- Modify/Create matching `tests/public-beta/*.schema.json` and deterministic fixtures.
- Do not execute parent Tasks 19-20 in this task.

**Interfaces:**
- Artifact Manifest v2 binds `releaseProfileId`, `releaseProfileDigest`, `artifactSetDigest`, seven exact entries, and `manifestDigest`.
- Release Manifest v2 binds profile, artifact manifest, Evidence v2, disabled assessment, policy, regional evidence, rollback, source/certifier run identities, candidate root, and approval.
- Candidate-controlled JSON may carry only the expected profile ID/digest; the certifier loads the profile body from its authenticated protected control SHA.
- `evaluatePublicBetaReadiness()` returns `ready_for` only for the bound restricted profile.

- [ ] **Step 1: Execute parent Tasks 4-6 RED/GREEN exactly**

Implement authenticated GitHub run metadata, pinned Sigstore policy/trust assets, and the source descriptor/provisional G3 contract using the commands and limits in the parent plan. Add profile ID/digest to the source descriptor and reject source/certifier control-SHA equality assumptions that are not authenticated.

- [ ] **Step 2: Write the seven-artifact Artifact Manifest v2 RED**

Test exact completeness and locator policy. Missing, duplicate, extra, renamed, eleven-artifact, wrong media type, tag-only OCI locator, wrong bundle suffix, wrong profile digest, or candidate-defined profile body must fail.

```ts
expect(parsed.artifacts.map(({ name }) => name)).toEqual([
  'web', 'admin', 'api', 'studio-worker',
  'developer-trust-worker', 'wasi-runner', 'desktop',
]);
```

- [ ] **Step 3: Implement parent Tasks 7-14 with profile bindings**

Retain the parent's Artifact Manifest v2, Release Manifest v2, DSSE PAE, exact SLSA semantics, Bundle 0.3 cross-binding, checksum-pinned Cosign adapters, authoritative G3, release-root provenance, and deterministic assembly. Replace every eleven-role iteration in the certified path with the authoritative profile's seven-role tuple. Include `releaseProfileDigest` in every relevant SLSA external parameter and in the release-root subject graph.

- [ ] **Step 4: Bind disabled assessment and three digest layers**

Release Manifest v2 contains:

```ts
releaseProfileId: 'openopc-restricted-public-beta-v1';
releaseProfileDigest: `sha256:${string}`;
disabledStateAssessmentPath: string;
disabledStateAssessmentDigest: `sha256:${string}`;
artifactSetDigest: `sha256:${string}`;
evidenceDigest: `sha256:${string}`;
candidateRootDigest: `sha256:${string}`;
```

The approval binding digest is computed with `approval: null`; candidate-root provenance binds the final artifact/evidence/disabled-assessment descriptors without a digest cycle.

- [ ] **Step 5: Implement parent Task 15 readiness branches**

Drive the CLI through real verification callbacks. Add explicit reasons for profile mismatch, deferred Gate evidence, missing disabled assessment, disabled capability reachable, wrong seven-artifact set, and complete-profile claim. Before approval, the only permitted remaining reason is `PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`.

- [ ] **Step 6: Run the certification core GREEN gate**

Run every focused command from parent Tasks 4-15, then:

```powershell
bun test scripts/release/public-beta-release-profile.test.ts scripts/release/public-beta-restricted-lanes.test.ts scripts/release/public-beta-evidence-v2.test.ts scripts/release/public-beta-disabled-state.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-source-candidate.test.ts scripts/release/public-beta-provenance.test.ts scripts/release/public-beta-sigstore-bundle.test.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-certified-provenance.test.ts scripts/release/public-beta-release-root.test.ts scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-certifier.test.ts
```

- [ ] **Step 7: Independent certification review**

Review authentication order, control SHA ownership, raw archive boundary, profile ownership, seven-role completeness, digest graph, DSSE PAE bytes, Bundle identity, same-G3 binding, and disabled assessment. No workflow work starts with an open finding.

- [ ] **Step 8: Proposed commit boundary**

Stage only the parent Task 4-15 files actually created/modified plus restricted profile files. Proposed message:

```powershell
git commit -m "feat(release): certify restricted public beta candidates"
```

---

### Task 6: Add Restricted Gates, Protected Certifier, and Non-Self Approval

**Files:**
- Create: `.github/workflows/openopc-public-beta-gates.yml`
- Create: `.github/workflows/openopc-public-beta-certify.yml`
- Modify: `.github/workflows/openopc-public-beta-approval.yml`
- Create: `scripts/release/public-beta-workflow-contract.test.ts`
- Create/Modify: `scripts/release/public-beta-approval.ts` and test
- Modify: `docs/runbooks/openopc-public-beta-release.md`

**Interfaces:**
- Gates workflow input: exact candidate commit and protected profile ID; it has no signing or production environment permission.
- Certifier input: source run ID, expected commit, source artifact name/digest/size, and protected control SHA.
- Approval input: certified run ID, expected commit, candidate-root digest, profile ID/digest, and source actor.
- Approval requires `environment: production`, a different authorized reviewer, and post-approval revalidation of the same immutable candidate.

- [ ] **Step 1: Write static workflow RED tests**

Parse YAML and assert exactly eighteen Gate jobs with canonical restricted lane IDs; no G6/G7/G9/B6 job; read-only defaults; pinned actions; no `pull_request_target`; no candidate checkout executing before authentication; no signing permission in Gates; `id-token: write` only in Certifier; production environment only in Approval; artifact download by explicit run ID; and no self-approval.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-approval.test.ts`

Expected: FAIL because Gates/Certifier are absent and Approval still consumes the earlier manifest contract.

- [ ] **Step 3: Implement parent Task 16 as an eighteen-lane producer**

Every Gate job invokes a committed script, emits raw evidence plus a record, and uploads even on failed/blocked outcomes. The aggregation job validates profile ID/digest, exact lane set, artifact-set digest, no deferred record, and failure history. It emits a source candidate only; it never signs or marks ready.

- [ ] **Step 4: Implement parent Task 17 protected certifier**

Authenticate source run/artifact metadata before extraction or code execution. Check out the protected control SHA for validator/policy/profile code. Load the literal profile there, verify raw ZIP digest/size/structure, validate the source candidate as data, then sign per-artifact and release-root DSSE with keyless Cosign.

- [ ] **Step 5: Implement parent Task 18 approval**

Download only the certified artifact from the authenticated certifier run. Verify source actor differs from reviewer, create approval v2 from GitHub environment metadata, bind profile/candidate root, rerun all offline validation, and upload a small approval attestation. It does not mutate candidate content.

- [ ] **Step 6: Run GREEN and action-lint checks**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-approval.test.ts scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-certifier.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-approval.ts scripts/release/public-beta-approval.test.ts
```

Use the repository's existing workflow/YAML validation command if present; otherwise parse all three workflows in the contract test and reject duplicate YAML keys.

- [ ] **Step 7: Independent workflow security review**

Review permission scopes, checkout order, artifact confusion, run-attempt binding, workflow/repository/ref identity, OIDC subject policy, environment protection, non-self approval, and post-approval immutable revalidation.

- [ ] **Step 8: Proposed commit boundary**

```powershell
git add .github/workflows/openopc-public-beta-gates.yml .github/workflows/openopc-public-beta-certify.yml .github/workflows/openopc-public-beta-approval.yml scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-approval.ts scripts/release/public-beta-approval.test.ts docs/runbooks/openopc-public-beta-release.md
git commit -m "ci(release): protect restricted beta approval"
```

---

### Task 7: Close Registration, Team, Admin, Free-Credit, and Desktop Acceptance

**Files:**
- Modify only when RED proves a defect in the existing owners named by `docs/plans/2026-07-28-openopc-public-beta-foundation-surfaces-implementation.md`.
- Create: `tests/public-beta/restricted-foundation/run.ts`
- Create: `tests/public-beta/restricted-foundation/run.test.ts`
- Create: `apps/web/scripts/e2e/restricted-foundation-smoke.ts`
- Modify: `apps/web/package.json`
- Modify: `tests/spec/end-to-end.md`

**Interfaces:**
- Consumes existing server-authoritative public registration, developer application, Admin IAM/audit, personal/team project, Agent/session, Desktop, and credit-ledger APIs.
- Produces B1, B2, B3, G8 foundation portion, G11 foundation portion, and B9 evidence artifacts.
- No test helper may create executable resources or credits before registration completion.

- [ ] **Step 1: Write HTTP acceptance RED tests**

Cover email verification, Turnstile, IP/device/email/account/action limits, exact policy versions, enumeration resistance, verifier outage fail-closed, duplicate/replay, no pre-verification credit/resource, versioned free allowance, personal/team tenant isolation, membership/role boundaries, shared task/assets/review, and no role escalation to developer/Admin.

- [ ] **Step 2: Write Admin and developer-admission RED tests**

Use real routes to submit as organization owner/admin, reject member/non-member, approve with expected revision and `developer.application.review`, reject stale/self/unauthorized decisions, and inspect immutable audit. Approval permits artifact submission only; publication/signing remain separately reviewed.

- [ ] **Step 3: Write browser/Desktop RED smoke**

At `1440x1000` and `390x844`, register, complete policy, create personal/team spaces, run a multi-Agent task, share an asset, request review, and apply as developer. Run the Web sequence with Desktop absent. Run packaged Windows install/launch/login/update-boundary smoke separately and assert closing Desktop does not affect Web.

Add `test:e2e:restricted-foundation` to `apps/web/package.json` as `node --experimental-strip-types scripts/e2e/restricted-foundation-smoke.ts`.

- [ ] **Step 4: Run RED against local real services**

```powershell
bun test tests/public-beta/restricted-foundation/run.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:restricted-foundation
```

Expected: the orchestrators first fail on missing implementation or an honestly observed acceptance gap; never replace a failing dependency with a mock.

- [ ] **Step 5: Repair only proven gaps using child-plan ownership**

Use the exact files and tests from foundation Tasks 1-9. Do not broaden registration authority into the browser, do not make Admin hostname the authority source, and do not couple Web behavior to Desktop.

- [ ] **Step 6: Run GREEN and real staging lane commands**

Run the focused foundation plan commands, then execute the black-box runner against staging. Preserve raw HTTP/browser/package evidence and produce Gate records only through the evidence CLI.

- [ ] **Step 7: Independent boundary review**

Review registration side-effect ordering, account/tenant authority, team-role non-escalation, Admin step-up/audit, free-credit-only behavior, Web independence, Desktop credential isolation, and Kortix compatibility.

- [ ] **Step 8: Proposed commit boundary**

```powershell
git add tests/public-beta/restricted-foundation apps/web/scripts/e2e/restricted-foundation-smoke.ts apps/web/package.json tests/spec/end-to-end.md
git commit -m "test(beta): gate restricted foundation surfaces"
```

Add product files only when a RED-driven repair changed them.

---

### Task 8: Implement Text, Image, and Basic Video Through Studio

**Files:**
- Modify: `packages/api-contract/src/studio/index.ts`, `index.test.ts`, and `fixtures.ts`
- Modify: `packages/api-contract/src/intelligence.ts` and test
- Modify: `packages/intelligence-contracts/src/schemas.ts` and test
- Modify: `packages/intelligence-orchestration/src/contracts.ts`, `routing.ts`, fixtures, and tests
- Modify: `packages/studio-runtime/src/provider.ts` and test
- Create: `packages/studio-adapters/src/media/text.ts` and test
- Create: `packages/studio-adapters/src/media/video.ts` and test
- Modify: `packages/studio-adapters/src/providers/openai-compatible/*` and tests
- Create: `packages/studio-adapters/src/providers/platform-video/config.ts`, `definition.ts`, `request.ts`, `response.ts`, `adapter.ts`, and tests
- Modify: `apps/api/src/studio/*` and focused tests
- Modify: `apps/studio-worker/src/contracts.ts`, `provider-registry.ts`, `result-stager.ts`, `worker.ts`, and tests
- Create: `packages/db/migrations/20260730120000000_restricted_beta_studio_capabilities.sql`
- Modify: `packages/db/src/schema/kortix.ts` and Studio schema tests
- Modify: `packages/db/scripts/studio-worker-migration.integration.test.ts`

**Interfaces:**

```ts
export const STUDIO_CAPABILITIES = [
  'text.generate', 'image.generate', 'video.generate',
] as const;

export type StudioJobInput =
  | { capability: 'text.generate'; text: {
      prompt: string; format: 'plain' | 'markdown'; max_output_tokens: number;
    } }
  | { capability: 'image.generate'; image: StudioImageGenerateInput }
  | { capability: 'video.generate'; video: {
      prompt: string; duration_seconds: 5 | 10;
      aspect_ratio: '16:9' | '9:16' | '1:1';
      quality: 'standard'; reference_asset_ids: string[];
    } };

export type StudioAssetKind = 'text' | 'image' | 'video';
export type StudioPricingUnit = '1k_output_tokens' | 'image' | 'second';
```

Basic video output is MP4/H.264, at most 1920x1080, at most 12 seconds after tolerance, and at most 100 MiB. Text output is valid UTF-8, at most 256 KiB, with a declared `text/plain` or `text/markdown` MIME type. Existing image limits remain unchanged.

- [ ] **Step 1: Write contract and database RED tests**

Assert the discriminated inputs above, per-modality asset kinds, estimate units, stable error codes, task/asset round-trip, additive migration constraints, old image rows remaining valid, tenant/project binding, and rejection of video/3D/voice/avatar/batch fields outside the exact basic-video input.

- [ ] **Step 2: Run contract RED**

```powershell
pnpm.cmd --filter @kortix/api-contract test
pnpm.cmd --filter @kortix/intelligence-contracts test
pnpm.cmd --filter @kortix/intelligence-orchestration test
pnpm.cmd --filter @kortix/studio-runtime test
pnpm.cmd --filter @kortix/db migrate:lint
```

Expected: current image-only literals reject text/video.

- [ ] **Step 3: Implement modality-aware provider and pricing types**

Replace image-only `StudioPricingSnapshot.unit`, `StudioProviderAsset.kind`, and trusted-cost evidence with discriminated modality types. Preserve idempotency, retry classification, unknown-outcome behavior, estimate binding, credit reservation, and terminal state semantics.

- [ ] **Step 4: Implement approved-provider adapters**

Extend the existing OpenAI-compatible definition for text and image. Add `platform-video-v1` as an async adapter whose origin and route template come only from server provider configuration validated against `OPENOPC_STUDIO_APPROVED_PROVIDER_ORIGINS`. The job request contains semantic input only; it never carries an origin, path template, token, or output URL. Poll/cancel/result requests retain SSRF, DNS re-resolution, redirect, response-size, and credential-origin guards.

- [ ] **Step 5: Validate outputs before staging**

Use strict UTF-8 decode for text and `mp4box@2.4.1` for bounded MP4 container/track metadata; add that exact dependency to `packages/studio-adapters/package.json` and `pnpm-lock.yaml`. Reject MIME mismatch, active markup masquerading as output, malformed/fragment-bomb MP4, unsupported codec, duration/dimension/size overflow, and any provider result URL outside the controlled safe-fetch policy.

- [ ] **Step 6: Extend API, Worker, and real PostgreSQL paths**

Discovery, estimate, create, lease, provider dispatch, poll/cancel/reconcile, result staging, credit finalization, job events, assets, metrics, and error classification must work for all three capabilities. Generation records retain tenant, project, task, model, duration, usage, status, and bounded error code; never provider keys, raw provider bodies, or reusable URLs.

- [ ] **Step 7: Run GREEN and integration tests**

```powershell
pnpm.cmd --filter @kortix/api-contract test
pnpm.cmd --filter @kortix/api-contract typecheck
pnpm.cmd --filter @kortix/intelligence-contracts test
pnpm.cmd --filter @kortix/intelligence-orchestration test
pnpm.cmd --filter @kortix/studio-runtime test
pnpm.cmd --filter @kortix/studio-runtime typecheck
pnpm.cmd --filter @kortix/studio-adapters test
pnpm.cmd --filter @kortix/studio-adapters typecheck
pnpm.cmd --filter @kortix/studio-worker test
pnpm.cmd --filter @kortix/studio-worker typecheck
pnpm.cmd --filter kortix-api exec bun test src/studio src/intelligence
pnpm.cmd --filter @kortix/db migrate:lint
pnpm.cmd --filter @kortix/db typecheck
bun test packages/db/scripts/studio-worker-migration.integration.test.ts
```

- [ ] **Step 8: Run one live-provider staging smoke per modality**

Use platform-owned provider configurations and secrets. Assert request identity, accepted model, terminal result, asset metadata, credits, logs, and no arbitrary endpoint field. A provider outage remains a failed Gate, not fake success.

- [ ] **Step 9: Independent content-security review**

Review provider-origin ownership, SSRF/redirect/DNS paths, output parser limits, credit reservation/finalization, unknown outcomes, cancellation, data retention, tenant binding, and log redaction.

- [ ] **Step 10: Proposed commit boundary**

```powershell
git add packages/api-contract packages/intelligence-contracts packages/intelligence-orchestration packages/studio-runtime packages/studio-adapters apps/api/src/studio apps/api/src/intelligence apps/studio-worker packages/db/migrations/20260730120000000_restricted_beta_studio_capabilities.sql packages/db/src/schema/kortix.ts packages/db/scripts/studio-worker-migration.integration.test.ts pnpm-lock.yaml
git commit -m "feat(studio): add restricted beta content capabilities"
```

---

### Task 9: Build the Unified Content Workbench and Browser/SDK Acceptance

**Files:**
- Read before SDK work: `packages/sdk/PROGRESS.md` and `packages/sdk/AGENTS.md`
- Modify: `packages/sdk/src/core/rest/projects-client/intelligence-studio.ts` and test
- Modify synchronized SDK exports/snapshots required by SDK instructions
- Create: `apps/web/src/features/studio/content-studio-page.tsx`
- Create: `apps/web/src/features/studio/content-studio-page.test.tsx`
- Create: `apps/web/src/features/studio/text-generation-form.tsx`
- Create: `apps/web/src/features/studio/video-generation-form.tsx`
- Create: `apps/web/src/features/studio/content-task-results.tsx`
- Modify: existing `apps/web/src/features/studio/*` shared state/assets files and tests
- Create: `apps/web/src/app/(app)/projects/[id]/studio/content/page.tsx`
- Modify: `apps/web/src/app/(app)/projects/[id]/studio/image/page.tsx` to render/redirect compatibly to content mode
- Modify: Studio sidebar navigation and all locale files
- Create: `apps/web/scripts/e2e/restricted-content-studio-smoke.ts`
- Modify: `apps/web/package.json` and `tests/spec/end-to-end.md`

**Interfaces:**
- SDK exposes estimate/create/list/events/cancel/assets operations for all three typed inputs through `kortix.project(projectId).intelligence`; no host-local fetch is added.
- `/projects/:id/studio/content` is the single content workbench route.
- A segmented mode control selects Text, Image, or Video. There is no standalone `/studio/video` route.

- [ ] **Step 1: Write SDK RED tests**

Assert exact URL, auth, input serialization, estimate approval, idempotency, event cursor, cancel, asset type, and response parsing for text/image/video. Run the required SDK public-surface and bundle gates after implementation.

- [ ] **Step 2: Write pure Web RED tests**

Cover discovery/loading/unavailable, mode selection, per-mode validation, estimate invalidation, credit/permission errors, idempotent submit, queued/running/unknown/failed/cancelled/succeeded, reload recovery, text copy/download, image preview/reuse, MP4 playback/download/reuse-reference, assets filtering, and disabled navigation.

- [ ] **Step 3: Implement one dense, responsive workbench**

Use existing Studio primitives and a stable desktop grid; stack on mobile. Use a segmented control for modes, bounded inputs, provider/model menus, aspect-ratio controls, duration selection, estimate display, one Generate command, and fixed-dimension result regions. Reuse existing image behavior. Render text safely without raw HTML and use the existing video renderer for validated MP4 assets.

- [ ] **Step 4: Preserve estimate and endpoint authority**

Store only task IDs/cursors in route or client state. Never persist estimate tokens, signed URLs, provider bodies, provider origins, or credentials. A form change invalidates its estimate. A stale estimate requires a new user command; no automatic resubmit at a changed price.

- [ ] **Step 5: Add real browser and Electron acceptance**

Run desktop `1440x1000`, mobile `390x844`, and packaged Electron. Assert visible output plus outgoing request payload for copywriting, image, and basic video; team-shared asset visibility/review; no horizontal overlap; no console error; and no route/command advertising deferred products. Save screenshots as CI artifacts, not source files.

Add these scripts to `apps/web/package.json`:

```json
"test:e2e:restricted-content-studio": "node --experimental-strip-types scripts/e2e/restricted-content-studio-smoke.ts",
"test:e2e:restricted-content-studio:electron": "node --experimental-strip-types scripts/e2e/restricted-content-studio-smoke.ts --electron"
```

- [ ] **Step 6: Run GREEN**

```powershell
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk build:bundles
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio
pnpm.cmd --filter Kortix-Computer-Frontend i18n:audit
pnpm.cmd --filter Kortix-Computer-Frontend build
pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:restricted-content-studio
pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:restricted-content-studio:electron
```

- [ ] **Step 7: Run route absence and pixel checks**

```powershell
rg -n --glob '!**/*.test.*' --glob '!**/*.spec.*' -e '/studio/video' -e '/studio/voice' -e '/studio/3d' -e '/studio/digital-human' -e '/studio/batch-remix' apps packages
```

Expected: no runtime route or navigation match. Browser smoke rejects blank screenshots, overlap, horizontal scroll, clipped controls, or missing generated content.

- [ ] **Step 8: Independent SDK/UI review**

Review public API compatibility, one-client rule, no raw host fetch, signed URL/token handling, accessibility, responsive layout, request authority, and no cancelled-product resurrection.

- [ ] **Step 9: Proposed commit boundary**

```powershell
git add packages/sdk apps/web/src/features/studio apps/web/src/app/'(app)'/projects/'[id]'/studio apps/web/src/features/workspace/project-sidebar apps/web/translations apps/web/scripts/e2e/restricted-content-studio-smoke.ts apps/web/package.json tests/spec/end-to-end.md
git commit -m "feat(web): add restricted content workbench"
```

---

### Task 10: Close Developer Admission and Reviewed WASI Lifecycle Acceptance

**Files:**
- Modify only when RED proves a defect in existing developer/review/module-runtime owners.
- Create: `tests/public-beta/restricted-wasi-lifecycle/run.ts`
- Create: `tests/public-beta/restricted-wasi-lifecycle/run.test.ts`
- Create: `apps/web/scripts/e2e/restricted-wasi-lifecycle-smoke.ts`
- Modify: `apps/web/package.json`
- Modify: `tests/spec/end-to-end.md`
- Modify: `deploy/openopc-modules/trust.compose.yml` only if the restricted topology test proves an incompatible service.

**Interfaces:**
- Lifecycle: upload -> digest lock -> SBOM/scans -> manual review -> platform certification -> publish -> install -> execute -> pause/resume -> revoke -> exact rollback.
- Accepted runtime kind is exactly `wasi-component`; published artifact storage is private, immutable, and content-addressed.
- WASI default capabilities contain no network, host filesystem, environment, provider secret, Desktop-native access, or remote artifact URL.

- [ ] **Step 1: Write real PostgreSQL/API RED acceptance**

Create two tenants plus Admin/reviewer identities. Assert organization owner/admin developer application, manual approval with revision guard, immutable audit, artifact digest lock, scan failure closure, reviewer non-self authority, platform signature, install consent, capability expansion re-consent, cross-tenant denial, pause/resume/revoke, execution denial after revoke, and exact rollback.

- [ ] **Step 2: Add negative profile probes**

Submit OCI descriptors, tag-only images, remote artifact URLs, Module App metadata, unreviewed artifacts, self-signed publication, capability escalation, direct Runner requests, and stale/replayed grants. Assert stable rejection before storage fetch, signing, install, or dispatch side effects.

- [ ] **Step 3: Add real Runner/egress RED acceptance**

Use the actual WASI Runner policy and controlled egress. Cover import denial, memory/fuel/wall/output limits, cancellation, deterministic case, scoped allowed egress, DNS rebinding/redirect/private-IP denial, credential absence, lease expiry, evidence finalization, and escape fixtures.

- [ ] **Step 4: Run RED**

```powershell
bun test tests/public-beta/restricted-wasi-lifecycle/run.test.ts
pnpm.cmd --filter kortix-api exec bun test src/developer src/module-runtime
cargo +1.97.1 test --manifest-path apps/module-runner/Cargo.toml
```

- [ ] **Step 5: Repair only proven gaps**

Use the existing developer application, review, trust, distribution, installation, module-runtime, Runner, and egress contracts. Do not add Module App hosting, OCI dispatch, arbitrary URLs, or developer-controlled signing.

- [ ] **Step 6: Add browser acceptance**

Apply as developer, wait for a separate Admin decision, upload a WASI module, observe review/trust status, publish, install into a team project, consent, run, pause/resume, revoke, and roll back. Assert ordinary members cannot review/publish and the UI never exposes OCI or Module App choices.

Add `test:e2e:restricted-wasi-lifecycle` to `apps/web/package.json` as `node --experimental-strip-types scripts/e2e/restricted-wasi-lifecycle-smoke.ts`.

- [ ] **Step 7: Run GREEN and retained child gates**

Run all focused tests from the developer trust/execution plans plus the new black-box runner and:

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:restricted-wasi-lifecycle
```

Produce G3/G4/G5/G8/G10/B4/B5 evidence only from real dependencies.

- [ ] **Step 8: Independent trust review**

Review reviewer separation, revision/CAS guards, signature authority, immutable storage, consent diffs, tenant binding, grant expiry, egress policy, revocation race, rollback exactness, and deferred-runtime rejection.

- [ ] **Step 9: Proposed commit boundary**

```powershell
git add tests/public-beta/restricted-wasi-lifecycle apps/web/scripts/e2e/restricted-wasi-lifecycle-smoke.ts apps/web/package.json tests/spec/end-to-end.md
git commit -m "test(beta): gate reviewed WASI lifecycle"
```

Add owning product files only when a RED-driven repair changed them.

---

### Task 11: Package and Verify the Restricted BaoTa/WASI Deployment

**Files:**
- Create/modify: `deploy/openopc-public-beta/control-node/*`
- Create: `deploy/openopc-public-beta/execution-node/release-compose.yml`
- Create: `deploy/openopc-public-beta/execution-node/release.env.schema.json`
- Create: `deploy/openopc-public-beta/execution-node/verify-execution-node.ts`
- Create: `deploy/openopc-public-beta/execution-node/verify-execution-node.test.ts`
- Create/modify: `deploy/openopc-public-beta/observability/*`
- Create/modify: `deploy/openopc-public-beta/backup/*`
- Create: `deploy/openopc-public-beta/deploy.ts` and test
- Create: `deploy/openopc-public-beta/verify-two-node.ts` and test
- Modify: `.github/workflows/deploy-staging.yml` only after its existing safeguards remain intact
- Create/modify: BaoTa, backup/restore, incident, dead-letter, and secrets runbooks named by the evidence/operations plan

**Interfaces:**
- Control node public ports: exactly 80/443 through Nginx; all application containers bind private networks.
- Control services: Web, Admin, API, Studio Worker, Developer Trust Worker, private PostgreSQL/object storage/queue, and telemetry.
- Execution services: WASI Runner, controlled egress proxy, and telemetry agent. The `wasi-runner` logical release bundle contains the pinned Runner/egress components and configuration descriptors.
- Forbidden services/binaries: Module Host, Automation Browser Worker, Module Ledger Worker, OCI Runner, containerd, and runsc.

- [ ] **Step 1: Write topology and Nginx RED tests**

Assert separate Web/Admin/API hosts, TLS, API-only realtime upgrade, host-only cookies, route isolation, bounded requests/timeouts, security headers, digest-pinned seven artifacts, private dependencies, exact runtime profile ID/digest, and no forbidden service/listener/package.

- [ ] **Step 2: Write B7/B8/B10 RED tests**

Retain the parent evidence plan's backup/PITR/object restore, consistency, telemetry, alert, dead-letter, failure-drill, exposure, TLS, regional, rollback, and artifact-commit assertions. Narrow B8 services to deployed API/workers/WASI/control/execution and B10 topology to control plus WASI node.

- [ ] **Step 3: Run local RED**

```powershell
bun test deploy/openopc-public-beta/control-node deploy/openopc-public-beta/execution-node deploy/openopc-public-beta/observability deploy/openopc-public-beta/backup deploy/openopc-public-beta/deploy.test.ts deploy/openopc-public-beta/verify-two-node.test.ts
```

- [ ] **Step 4: Implement deterministic profile-bound deployment**

Follow order: backup/preflight -> compatible migrations -> API/workers -> Web/Admin -> WASI/egress -> disabled-state audit -> feature flags. Each phase writes a digested checkpoint, is idempotent, checks exact artifact/profile/commit identity, and records rollback target. Secrets are file/provider references only.

- [ ] **Step 5: Validate config and disposable local topology**

Render Nginx and run `nginx -t` in a uniquely named disposable container. Parse both Compose files, validate environment schemas, run secret-file tests, and prove zero matching container/network/volume residue. Do not run Docker tests if the current SDD ledger prohibits them; record the environment blocker rather than substituting fixture evidence.

- [ ] **Step 6: Run real staging deploy and restricted operations gates**

Deploy the same certified commit to BaoTa control and private WASI nodes. Run public exposure/private dependency scans, package/browser smoke, isolated restore, one bounded failure drill, telemetry/alert/dead-letter recovery, and rollback rehearsal. B7 and B10 freshness rules remain unchanged.

- [ ] **Step 7: Independent operations review**

Review ingress, cookies, Admin isolation, secret ownership, private routing, artifact digests, no OCI/containerd/runsc, backup target isolation, RPO/RTO, cleanup, alert coverage, rollback, and actual listener/process/package inventory.

- [ ] **Step 8: Proposed commit boundary**

```powershell
git add deploy/openopc-public-beta docs/runbooks .github/workflows/deploy-staging.yml
git commit -m "ops(beta): deploy restricted BaoTa and WASI topology"
```

Stage `.github/workflows/deploy-staging.yml` only if it changed.

---

### Task 12: Run Live Certification, Approval, and Gradual Public Opening

**Files:**
- Create: `docs/runbooks/openopc-restricted-public-beta.md`
- Modify: `docs/runbooks/openopc-public-beta-release.md`
- Modify: `tests/spec/end-to-end.md`
- Update SDD progress/reports for this plan; do not commit live evidence bundles or secrets.

**Interfaces:**
- Produces one immutable certified candidate and one approval attestation for the same commit/profile/candidate root.
- Produces real records for eighteen required Gates plus one signed disabled-state assessment.
- Produces one `ready` result only after a different authorized reviewer approves the production environment.

- [ ] **Step 1: Run final local source gates**

Run Tasks 1-11 focused suites, package typechecks/builds, migrations, Rust tests, workflow contract tests, `git diff --check`, protected-file audit, and secret scan. Any failure returns to its owning task.

- [ ] **Step 2: Run the restricted Gates workflow**

Dispatch `.github/workflows/openopc-public-beta-gates.yml` for the exact candidate commit/profile. Confirm exactly eighteen jobs, preserve failed/blocked artifacts, and validate the aggregate source bundle. Do not dispatch Certifier until every required Gate is passed and current.

- [ ] **Step 3: Run the protected Certifier online**

Dispatch with authenticated source run/artifact identity. Confirm real Fulcio/Rekor keyless signing, Bundle 0.3 verification, seven per-artifact provenance pairs, release-root provenance, profile digest, disabled assessment, and candidate-root digest. This satisfies the required first real online sequence; it does not satisfy deferred mature offline-fixture/rotation work.

- [ ] **Step 4: Validate the pre-approval result**

```powershell
$validationNow = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
pnpm.cmd public-beta:validate --profile openopc-restricted-public-beta-v1 --manifest artifacts/public-beta/release-manifest.v2.json --evidence artifacts/public-beta/evidence.v2.json --disabled-state artifacts/public-beta/disabled-state.v1.json --now $validationNow
```

Expected: exit `2`; the only reason is `PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`. Record `$validationNow` in the execution report.

- [ ] **Step 5: Obtain non-self protected approval and revalidate**

Dispatch Approval for the exact certified run. A different authorized reviewer acts through the `production` environment. After approval, offline revalidation exits `0` with:

```json
{"status":"ready","ready_for":"openopc-restricted-public-beta-v1","reasons":[]}
```

- [ ] **Step 6: Deploy the immutable candidate and run production smoke**

Verify deployed artifact digests and commit, Web without Desktop, Windows package, registration policy, personal/team multi-Agent flow, text/image/basic-video generation, developer application, reviewed WASI execution/revoke/rollback, Admin isolation, private services, telemetry, backup freshness, and disabled direct requests.

- [ ] **Step 7: Open registration gradually**

Use server-owned rollout values: 5% for the first 24 hours, 25% for the next 48 hours, then 100% only after a reviewed expansion decision. Freeze or roll back immediately for any Critical/Important finding, verifier outage, backup older than 24 hours, API 5xx above 1% for 15 minutes, Studio terminal failure above 5% for 15 minutes, queue age p95 above 120 seconds, WASI available capacity below 20% for 10 minutes, failed restore/rollback smoke, or approved daily credit budget exhaustion.

- [ ] **Step 8: Record rollback and close readiness honestly**

Record candidate/rollback manifest digests, profile digest, source/certifier/approval run URLs and IDs, approver identity, deployed SHA proof, smoke commands/results, and rollout percentage in the deployment system/runbook. Evidence remains retained CI/release artifacts under digest and is not committed to Git.

- [ ] **Step 9: Proposed documentation commit boundary**

```powershell
git add docs/runbooks/openopc-restricted-public-beta.md docs/runbooks/openopc-public-beta-release.md tests/spec/end-to-end.md .superpowers/sdd
git commit -m "docs(beta): record restricted public launch procedure"
```

Do not include live evidence, signed URLs, tokens, certificates, provider responses, or secrets.

---

## Parent-Plan Adaptation Matrix

| Parent plan task | Restricted-beta action |
| --- | --- |
| Sigstore 1 | Retain completed RFC 8785 implementation and review. |
| Sigstore 2 | Retain implementation; complete independent same-descriptor review in Task 1. |
| Sigstore 3 | Complete archive race/FD/cleanup closure in Task 1 before any workflow dispatch. |
| Sigstore 4-6 | Execute in Task 5; bind source metadata to profile ID/digest. |
| Sigstore 7 | Execute in Task 5 with seven exact artifacts, not eleven. |
| Sigstore 8-15 | Execute in Task 5 with profile, restricted evidence, and disabled-assessment bindings. |
| Sigstore 16 | Execute in Task 6 with exactly eighteen restricted Gate jobs. |
| Sigstore 17 | Execute in Task 6; protected control SHA owns the profile body. |
| Sigstore 18 | Execute in Task 6; approval is non-self and profile/candidate-root bound. |
| Sigstore 19 | Defer the retained network-blocked complete fixture; keep one real online sequence in Task 12. |
| Sigstore 20 | Defer mature overlap/rotation exercises; ship the minimal Rekor outage, rollback, and root-expiry procedure in Tasks 11-12. |
| Sigstore 21 | Replace complete-profile live sequence with Task 12 restricted sequence; do not claim full public-beta readiness. |
| Evidence/Ops 4 | Execute in Task 11 without Module Host or Ledger Worker. |
| Evidence/Ops 6-8 | Execute in Task 11 for deployed restricted services only. |
| Evidence/Ops 10-12 | Execute in Tasks 11-12 using the restricted topology and Gate registry. |
| Foundation 1-9 | Reuse implementation; close real restricted acceptance in Task 7. |
| Module App/CLI | Do not execute Module App work; reuse only tenant authority and WASI lifecycle portions through Task 10. |
| OCI Runner | Deferred; prove absence/unreachability in Tasks 4, 10, and 11. |
| Sandbox ledger | Deferred; preserve free-credit ledger only and prove commerce writes unavailable. |

## Completion Gate

The implementation is complete only when all statements are true:

- Parent Sigstore Tasks 2-3 have persisted clean independent reviews.
- The protected profile is exact, immutable, canonical, and digest-bound.
- Artifact Manifest v2 contains exactly seven artifacts and no excluded artifact.
- Evidence contains current real records for exactly eighteen required Gates and no deferred Gate pass.
- The signed disabled-state assessment proves every deferred capability absent and unreachable across artifact, deployment, feature flag, API/CLI, IAM, legacy route, and UI boundaries.
- Registration, abuse controls, policy acceptance, and free credits fail closed with no pre-verification side effects.
- Personal/team work, multi-Agent collaboration, shared assets/review, Admin isolation, Web independence, and Windows Desktop package smoke pass.
- Copywriting, image generation, and basic video generation pass through approved provider configurations with no arbitrary endpoint or secret exposure.
- Developer admission and reviewed WASI upload/review/certify/publish/install/execute/pause/resume/revoke/rollback pass against real PostgreSQL, object storage, Runner, and egress.
- BaoTa exposes only Nginx 80/443; private services and the WASI node remain private; OCI/containerd/runsc/Module Host/Ledger Worker are absent.
- Isolated restore meets `RPO <= 15 minutes` and `RTO <= 4 hours`, consistency and post-restore smoke pass, and rollback is rehearsed.
- A real protected GitHub sequence authenticates, signs, verifies, certifies, and receives non-self production approval for the same immutable candidate.
- The final validator returns only `ready_for: openopc-restricted-public-beta-v1`.
- No Critical or Important finding remains open for an enabled or release-security boundary.

Until every item passes with retained evidence, status remains **not ready for restricted public beta**.
