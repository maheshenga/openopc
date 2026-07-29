# OpenOPC Public-Beta Sigstore Certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce cryptographically certified OpenOPC public-beta candidates whose eleven artifacts, SBOMs, per-artifact SLSA provenance, release root, GitHub runs, human approval, and final release manifest are independently verifiable and fail closed.

**Architecture:** The staging Gates workflow remains an unprivileged evidence producer. A protected default-branch certifier authenticates the source run and raw GitHub artifact, validates candidate content as untrusted data, signs DSSE PAE bytes with keyless Cosign, creates the authoritative G3 record, and emits the only candidate accepted by the protected approval workflow. Release validation uses platform-owned trust policy, same-descriptor file reads, offline Sigstore Bundle v0.3 verification, and three non-circular digest layers.

**Tech Stack:** TypeScript, Bun 1.3.14, pnpm 8.11.0, GitHub Actions OIDC, Cosign v3.1.2, Sigstore Bundle v0.3, Fulcio, Rekor, RFC 8785 JSON Canonicalization Scheme, DSSE PAE, SLSA Provenance v1, CycloneDX, SHA-256, `yauzl` 2.10.0, JSON Schema 2020-12.

## Global Constraints

- Implement the approved design in `docs/specs/2026-07-29-openopc-public-beta-sigstore-certification-design.md`.
- Artifact Manifest and Release Manifest move directly to schema v2. There is no v1 compatibility path because the project is not live.
- Evidence Ledger remains schema v2. The source ledger cannot contain an authoritative passed G3 record; only the certifier may add it.
- Canonical JSON means RFC 8785 JCS over I-JSON values. Reject non-finite numbers, lone UTF-16 surrogates, `undefined`, `bigint`, functions, symbols, sparse arrays, non-plain objects, and cyclic values.
- Canonical environment is `openopc-public-beta-staging`; protected approval environment is `production`.
- Cosign is exactly `v3.1.2`; Bun in workflows is exactly `1.3.14`; every action is pinned by a 40-character commit SHA.
- The trusted-root bytes, trusted-root SHA-256, Linux Cosign SHA-256, and Windows Cosign SHA-256 are repository-pinned platform inputs. Candidate JSON may not provide or select them.
- The CLI keeps one-line JSON stdout and exit codes `0` ready, `2` well-formed not-ready, `64` usage, and `65` invalid input. Stderr contains stable reason codes only.
- Stable certification reason families are `PUBLIC_BETA_SIGSTORE_POLICY_INVALID`, `PUBLIC_BETA_SIGSTORE_TOOL_UNAVAILABLE`, `PUBLIC_BETA_SIGSTORE_BUNDLE_MISSING`, `PUBLIC_BETA_SIGSTORE_BUNDLE_AMBIGUOUS`, `PUBLIC_BETA_SIGSTORE_BUNDLE_INVALID`, `PUBLIC_BETA_SIGSTORE_IDENTITY_UNVERIFIED`, `PUBLIC_BETA_PROVENANCE_UNVERIFIED`, `PUBLIC_BETA_RELEASE_PROVENANCE_UNVERIFIED`, `PUBLIC_BETA_CERTIFICATION_UNVERIFIED`, and `PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`.
- A verification callback succeeds only when its synchronous return value is literal boolean `true`. Promise, object, truthy scalar, exception, timeout, signal, nonzero exit, malformed output, or cleanup failure is rejection.
- Candidate paths, archive entries, certificates, trust roots, command lines, and raw Cosign output never appear in user-visible errors.
- The source workflow has no `id-token: write`. Only the certifier `certify` job has `id-token: write`. Approval has no signing authority.
- Protected certifier and approval jobs never execute candidate scripts, package hooks, binaries, workflows, or local actions.
- `.github/workflows/deploy-dev.yml`, `.github/workflows/ci.yml`, and existing Kortix deployment state machines remain unchanged.
- Do not modify `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`, `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`, or `tests/module-beta/evidence.json`.
- Do not run `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`. Preserve all existing dirty work and stage explicit files only.
- Use `pnpm.cmd` on Windows and invoke `bun` directly. Do not use `using-superpowers`.
- Do not commit or push until the user renews authorization for the exact task boundary.
- Focused tests and synthetic adapters do not establish public-beta readiness. Readiness requires Task 21 live evidence plus closure of all broader Gate reasons.

## Locked Numerical Limits

The following values are platform constants, never candidate inputs:

```ts
export const PUBLIC_BETA_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 10 * 1024 * 1024 * 1024,
  maxEntries: 4_096,
  maxExpandedBytes: 20 * 1024 * 1024 * 1024,
  maxEntryBytes: 10 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxPathBytes: 1_024,
  maxPathSegments: 32,
});
```

An empty file is permitted only where the owning schema explicitly permits it. JSON, DSSE, Bundle, manifest, ledger, and evidence-index files must be between 1 byte and their module-specific upper bound.

## File Map

- `scripts/release/public-beta-canonical-json.ts`: one RFC 8785 encoder and SHA-256 helper for every public-beta digest.
- `scripts/release/public-beta-safe-files.ts`: same-descriptor bounded byte/UTF-8/JSON reads beneath a verified candidate root.
- `scripts/release/public-beta-archive.ts`: raw ZIP authentication and constrained streaming extraction.
- `scripts/release/public-beta-github-actions.ts`: source/certifier run and artifact metadata authentication through an injectable GitHub client.
- `scripts/release/public-beta-sigstore-policy.ts`: platform-owned policy construction, validation, rotation, and digest.
- `scripts/release/public-beta-trust/`: pinned Cosign metadata and Sigstore trusted-root snapshot.
- `scripts/release/public-beta-source-candidate.ts`: source descriptor, source evidence index, and provisional-ledger rules.
- `scripts/release/public-beta-artifacts.ts`: Artifact Manifest v2, eleven-role completeness, artifact-set digest, SBOM checks.
- `scripts/release/public-beta-provenance.ts`: DSSE PAE and exact artifact SLSA v1 semantics.
- `scripts/release/public-beta-sigstore-bundle.ts`: Bundle v0.3 parsing and PAE/signature/SPKI cross-binding.
- `scripts/release/public-beta-cosign.ts`: synchronous, checksum-pinned Cosign signer and verifier process adapters.
- `scripts/release/public-beta-certified-provenance.ts`: same-G3 DSSE/Bundle/SBOM lookup and verification.
- `scripts/release/public-beta-release-root.ts`: release-root SLSA statement construction and verification.
- `scripts/release/public-beta-release-manifest.ts`: Release Manifest v2 parsing, three digests, readiness, and CLI.
- `scripts/release/public-beta-certifier.ts`: deterministic certified-candidate assembly and certifier CLI.
- `scripts/release/public-beta-approval.ts`: approval v2 creation and approval CLI.
- `scripts/release/public-beta-workflow-contract.test.ts`: static Gates, Certifier, and Approval workflow security contract.
- `.github/workflows/openopc-public-beta-gates.yml`: unprivileged 22-lane source producer.
- `.github/workflows/openopc-public-beta-certify.yml`: protected source authentication and keyless certification.
- `.github/workflows/openopc-public-beta-approval.yml`: protected certified-candidate validation and non-self human approval.
- `.github/workflows/openopc-public-beta-trust-test.yml`: additive offline Sigstore verification without changing upstream CI.
- `tests/public-beta/*.schema.json` and fixtures: deterministic schema, mutation, CLI, and live-acceptance contracts.
- `tests/public-beta/sigstore/offline/`: public non-secret real Bundle v0.3, PAE, DSSE, trusted-root, and fixture manifest.
- `docs/runbooks/openopc-public-beta-release.md`: end-to-end operator flow and remaining non-certification blockers.
- `docs/runbooks/openopc-public-beta-sigstore.md`: tool/root rotation, Rekor outage, fixture refresh, and rollback.

---

### Task 1: Establish One RFC 8785 Canonical JSON and Digest Primitive

**Files:**
- Create: `scripts/release/public-beta-canonical-json.ts`
- Create: `scripts/release/public-beta-canonical-json.test.ts`
- Modify: `scripts/release/public-beta-artifacts.ts`
- Modify: `scripts/release/public-beta-release-manifest.ts`

**Interfaces:**

```ts
export type PublicBetaSha256Digest = `sha256:${string}`;
export type PublicBetaJson = null | boolean | number | string | PublicBetaJson[] | {
  [key: string]: PublicBetaJson;
};

export function canonicalPublicBetaJson(value: unknown): string;
export function encodeCanonicalPublicBetaJson(value: unknown): Uint8Array;
export function computePublicBetaSha256(value: string | Uint8Array): PublicBetaSha256Digest;
export function computeCanonicalPublicBetaDigest(value: unknown): PublicBetaSha256Digest;
```

- [ ] **Step 1: Write the failing RFC 8785 vectors and invalid-value tests**

```ts
import { expect, test } from 'bun:test';
import {
  canonicalPublicBetaJson,
  computeCanonicalPublicBetaDigest,
} from './public-beta-canonical-json';

test('uses RFC 8785 ordering and number serialization', () => {
  expect(canonicalPublicBetaJson({ literals: [null, true, false], numbers: [1e30, 4.5, 0.002] }))
    .toBe('{"literals":[null,true,false],"numbers":[1e+30,4.5,0.002]}');
  expect(canonicalPublicBetaJson({ '\u20ac': 'Euro', '\r': 'CR', '1': 'one' }))
    .toBe('{"\\r":"CR","1":"one","\u20ac":"Euro"}');
});

test.each([NaN, Infinity, -Infinity, 1n, undefined, new Date(0), [, 1]])(
  'rejects non-I-JSON value %p',
  (value) => expect(() => canonicalPublicBetaJson(value)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID'),
);

test('produces a lowercase sha256 digest over canonical UTF-8 bytes', () => {
  expect(computeCanonicalPublicBetaDigest({ b: 2, a: 1 }))
    .toBe('sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-canonical-json.test.ts`

Expected: FAIL because the canonical module does not exist.

- [ ] **Step 3: Implement strict JCS and replace duplicate canonicalizers**

Implement recursive I-JSON validation before encoding. Sort object keys by UTF-16 code units, use ECMAScript JSON number serialization, reject lone surrogates, and detect cycles with a `Set<object>`. Replace the private canonical JSON/digest functions in the artifact and release modules with these exports; do not change their wire contracts yet.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-canonical-json.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-release-manifest.test.ts
```

Expected: all selected tests pass and the existing digest fixtures retain their intended values or are updated only where RFC 8785 requires it.

- [ ] **Step 5: Independent review boundary**

Reviewer checks RFC 8785 vectors, Unicode rejection, cycle handling, and confirms there is exactly one public-beta canonicalizer.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-canonical-json.ts scripts/release/public-beta-canonical-json.test.ts scripts/release/public-beta-artifacts.ts scripts/release/public-beta-release-manifest.ts
git commit -m "refactor(release): centralize canonical public beta digests"
```

### Task 2: Make Candidate File Reads Same-Descriptor and Fail Closed

**Files:**
- Create: `scripts/release/public-beta-safe-files.ts`
- Create: `scripts/release/public-beta-safe-files.test.ts`
- Modify: `scripts/release/public-beta-release-manifest.ts`

**Interfaces:**

```ts
export interface PublicBetaFileReference {
  root: string;
  path: string;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  maxBytes: number;
}

export interface PublicBetaVerifiedBytes {
  bytes: Uint8Array;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
}

export function readPublicBetaVerifiedBytes(
  reference: Readonly<PublicBetaFileReference>,
): PublicBetaVerifiedBytes | false;
export function readPublicBetaVerifiedJson(
  reference: Readonly<PublicBetaFileReference>,
): { file: PublicBetaVerifiedBytes; value: unknown } | false;
```

- [ ] **Step 1: Write failing same-file, encoding, and path attack tests**

```ts
test('rejects size, digest, UTF-8, JSON, symlink, junction, and replacement attacks', () => {
  const reference = materializeVerifiedFile('{"ok":true}');
  expect(readPublicBetaVerifiedJson(reference)?.value).toEqual({ ok: true });
  expect(readPublicBetaVerifiedJson({ ...reference, sizeBytes: reference.sizeBytes + 1 })).toBe(false);
  expect(readPublicBetaVerifiedJson({ ...reference, digest: `sha256:${'0'.repeat(64)}` })).toBe(false);
  expect(readAttackFixture('invalid-utf8')).toBe(false);
  expect(readAttackFixture('malformed-json')).toBe(false);
  expect(readAttackFixture('symlink')).toBe(false);
  expect(readAttackFixture('junction')).toBe(false);
  expect(readAttackFixture('same-path-replacement')).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-safe-files.test.ts`

Expected: FAIL because same-descriptor helpers do not exist.

- [ ] **Step 3: Implement bounded descriptor reads**

Validate repository-style relative paths, maximum 32 segments, maximum 1024 UTF-8 path bytes, lexical containment, and realpath equality for every existing component. Reject any component whose `lstat` is a symbolic link or whose real path differs from its lexical path. Open once with read-only and no-follow flags where supported; use that descriptor for `fstat`, bounded reads, length, SHA-256, fatal UTF-8, and JSON. Close in `finally`; close failure returns `false`. Replace `readEvidenceJsonAt`, `verifyArtifactAt`, and manifest/evidence top-level rereads with this module.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-release-manifest.test.ts
```

Expected: PASS, including attack cases; public verifier functions return `false` rather than throwing on malformed runtime data.

- [ ] **Step 5: Independent review boundary**

Reviewer traces every file read to one descriptor and verifies that no post-validation reopen remains on the readiness path.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-safe-files.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-release-manifest.ts
git commit -m "fix(release): verify candidate files on one descriptor"
```

### Task 3: Authenticate and Constrain Raw ZIP Archives

**Files:**
- Create: `scripts/release/public-beta-archive.ts`
- Create: `scripts/release/public-beta-archive.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
export interface PublicBetaArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxCompressionRatio: number;
  maxPathBytes: number;
  maxPathSegments: number;
}

export interface PublicBetaAuthenticatedArchive {
  path: string;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
}

export function authenticatePublicBetaArchiveFile(input: {
  archivePath: string;
  expectedDigest: PublicBetaSha256Digest;
  expectedSizeBytes: number;
  limits?: Readonly<PublicBetaArchiveLimits>;
}): PublicBetaAuthenticatedArchive | false;

export async function extractPublicBetaArchive(input: {
  archive: PublicBetaAuthenticatedArchive;
  destination: string;
  limits?: Readonly<PublicBetaArchiveLimits>;
}): Promise<readonly string[] | false>;
```

- [ ] **Step 1: Write hostile archive tests before adding the parser**

```ts
test.each([
  'absolute-path', 'dot-dot', 'backslash', 'drive-prefix', 'ads', 'duplicate-name',
  'case-collision', 'symlink', 'device', 'entry-count', 'expanded-size', 'entry-size',
  'compression-ratio', 'truncated-central-directory',
])('rejects hostile ZIP fixture %s', async (name) => {
  const fixture = archiveFixture(name);
  const authenticated = authenticatePublicBetaArchiveFile(fixture);
  expect(authenticated).not.toBe(false);
  expect(await extractPublicBetaArchive({ archive: authenticated!, destination: freshDirectory() }))
    .toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-archive.test.ts`

Expected: FAIL because the archive module and direct `yauzl` dependency are absent.

- [ ] **Step 3: Implement streaming ZIP inspection and extraction**

Add exact root dev dependencies `yauzl@2.10.0` and `@types/yauzl@2.10.3`. Stream the raw archive through one descriptor to authenticate size and SHA-256 before parsing; do not materialize a multi-gigabyte archive in a `Uint8Array`. Pass that descriptor to `yauzl.fromFd` for lazy entry iteration, reject encrypted entries and non-file/non-directory Unix modes, validate names before creating anything, accumulate declared and streamed sizes, enforce the locked limits, and write regular files with exclusive create beneath a newly created private destination. On any error remove only the destination created by this call and return `false`.

- [ ] **Step 4: Run GREEN**

```powershell
pnpm.cmd install --lockfile-only
bun test scripts/release/public-beta-archive.test.ts
```

Expected: PASS for one bounded valid ZIP and every hostile mutation; `pnpm-lock.yaml` records only the explicit ZIP parser additions needed by this task.

- [ ] **Step 5: Independent review boundary**

Reviewer checks central-directory metadata, streamed-byte enforcement, Zip64 bounds, cleanup containment, and confirms extraction never occurs before archive digest verification.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add package.json pnpm-lock.yaml scripts/release/public-beta-archive.ts scripts/release/public-beta-archive.test.ts
git commit -m "feat(release): authenticate public beta archives"
```

### Task 4: Authenticate GitHub Source and Certifier Runs

**Files:**
- Create: `scripts/release/public-beta-github-actions.ts`
- Create: `scripts/release/public-beta-github-actions.test.ts`

**Interfaces:**

```ts
export interface PublicBetaGitHubActionsClient {
  getWorkflowRun(runId: string): Promise<unknown>;
  listWorkflowRunArtifacts(runId: string): Promise<readonly unknown[]>;
  downloadArtifactArchive(artifactId: string, destinationPath: string): Promise<void>;
  getRepositoryFile(path: string, ref: string): Promise<Uint8Array>;
}

export interface PublicBetaAuthenticatedSourceRun {
  repository: string;
  workflow: '.github/workflows/openopc-public-beta-gates.yml';
  runId: string;
  runAttempt: number;
  headSha: string;
  artifactId: string;
  artifactDigest: PublicBetaSha256Digest;
  artifactSizeBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface PublicBetaAuthenticatedCertifierRun {
  repository: string;
  workflow: '.github/workflows/openopc-public-beta-certify.yml';
  workflowRef: 'refs/heads/main';
  controlSha: string;
  runId: string;
  runAttempt: number;
  event: 'workflow_run';
  artifactId: string;
  artifactDigest: PublicBetaSha256Digest;
  artifactSizeBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface PublicBetaCertifierRunClaimsV1 {
  repository: string;
  workflow: '.github/workflows/openopc-public-beta-certify.yml';
  workflowRef: 'refs/heads/main';
  controlSha: string;
  runId: string;
  runAttempt: number;
  event: 'workflow_run';
  startedAt: string;
  finishedAt: string;
}

export async function authenticatePublicBetaSourceRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: string;
  expectedCommit: string;
  runId: string;
  now: Date;
}): Promise<PublicBetaAuthenticatedSourceRun | false>;

export async function authenticatePublicBetaCertifierRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: string;
  expectedCommit: string;
  expectedControlSha: string;
  runId: string;
  now: Date;
}): Promise<PublicBetaAuthenticatedCertifierRun | false>;
```

- [ ] **Step 1: Write table-driven replay and ambiguity tests**

```ts
test.each([
  ['fork', { repository: { full_name: 'fork/platform' } }],
  ['workflow', { path: '.github/workflows/other.yml' }],
  ['event', { event: 'pull_request_target' }],
  ['branch', { head_branch: 'main' }],
  ['sha', { head_sha: 'b'.repeat(40) }],
  ['attempt', { run_attempt: 0 }],
  ['conclusion', { conclusion: 'failure' }],
])('rejects source run mutation %s', async (_name, mutation) => {
  expect(await authenticatePublicBetaSourceRun(sourceInput(mutation))).toBe(false);
});

test('rejects zero or two current artifacts with the canonical name', async () => {
  expect(await authenticatePublicBetaSourceRun(sourceInput({}, []))).toBe(false);
  expect(await authenticatePublicBetaSourceRun(sourceInput({}, [sourceArtifact(), sourceArtifact()])))
    .toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-github-actions.test.ts`

Expected: FAIL because run authentication is still embedded in YAML.

- [ ] **Step 3: Implement pure run/artifact authentication and raw download**

Require exact repository, path, workflow name, event, branch/ref, full commit/control SHA, completed/success, positive attempt, ordered timestamps, non-expired unique artifact name, positive size, canonical SHA-256 digest, run ID, repository ID, and head SHA. Source artifact name is `openopc-public-beta-source-candidate`; certified artifact name is `openopc-public-beta-certified-candidate`. Stream the raw ZIP through the client into a private temporary file outside candidate root, pass that file to Task 3, and remove it in `finally` after extraction.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-archive.test.ts`

Expected: PASS with exact source/certifier distinction and no trust values read from candidate JSON.

- [ ] **Step 5: Independent review boundary**

Reviewer compares every accepted field to GitHub API data or protected caller context and confirms case normalization is limited to repository-name comparison.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-github-actions.ts scripts/release/public-beta-github-actions.test.ts
git commit -m "feat(release): authenticate public beta GitHub runs"
```

### Task 5: Pin Platform Sigstore Policy and Trust Assets

**Files:**
- Create: `scripts/release/public-beta-sigstore-policy.ts`
- Create: `scripts/release/public-beta-sigstore-policy.test.ts`
- Create: `scripts/release/public-beta-trust/cosign-v3.1.2.json`
- Create: `scripts/release/public-beta-trust/trusted-root.v1.json`
- Create: `tests/public-beta/sigstore-policy.schema.json`

**Interfaces:**

```ts
export interface PublicBetaSigstoreTrustPolicyV1 {
  schemaVersion: 1;
  policyId: 'openopc-public-beta-sigstore-v1';
  oidcIssuer: 'https://token.actions.githubusercontent.com';
  repository: string;
  certificateIdentity: string;
  workflowPath: '.github/workflows/openopc-public-beta-certify.yml';
  workflowRef: 'refs/heads/main';
  workflowSha: string;
  workflowTrigger: 'workflow_run';
  trustedRootPath: string;
  trustedRootDigest: PublicBetaSha256Digest;
  cosignVersion: 'v3.1.2';
  cosignBinaryDigests: {
    linuxAmd64: PublicBetaSha256Digest;
    windowsAmd64: PublicBetaSha256Digest;
  };
}

export function loadPublicBetaSigstoreTrustPolicy(input: {
  controlRoot: string;
  repository: string;
  workflowSha: string;
  now: Date;
}): Readonly<PublicBetaSigstoreTrustPolicyV1> | false;
export function computePublicBetaSigstoreTrustPolicyDigest(
  policy: Readonly<PublicBetaSigstoreTrustPolicyV1>,
): PublicBetaSha256Digest;
```

- [ ] **Step 1: Write failing platform-ownership and rotation tests**

```ts
test('derives the exact certificate identity from protected inputs', () => {
  const policy = loadPublicBetaSigstoreTrustPolicy(policyInput());
  expect(policy).not.toBe(false);
  expect(policy!.certificateIdentity).toBe(
    'https://github.com/openopc/platform/.github/workflows/openopc-public-beta-certify.yml@refs/heads/main',
  );
});

test.each(['candidate-root.json', 'https://rekor.attacker.invalid', 'refs/heads/staging', 'pull_request'])
  ('rejects candidate-selected trust value %s', (value) => {
    expect(loadPolicyWithCandidateOverride(value)).toBe(false);
  });
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-sigstore-policy.test.ts`

Expected: FAIL because policy and trust assets do not exist.

- [ ] **Step 3: Acquire and pin real tool/root bytes, then implement the loader**

Use `gh release download v3.1.2 --repo sigstore/cosign` to obtain `cosign-linux-amd64`, `cosign-windows-amd64.exe`, and the release checksum material in a temporary directory outside the repository. Verify both binaries with GitHub artifact attestations from `sigstore/cosign`, then independently compare their SHA-256 values to the signed upstream checksum material. Use the verified Cosign TUF client to materialize the public-good Sigstore `trusted_root.json`; retain those exact bytes as `trusted-root.v1.json` and record its independently computed SHA-256. `cosign-v3.1.2.json` has exact keys `schemaVersion`, `version`, `linuxAmd64`, `windowsAmd64`, and `trustedRootDigest`; every digest must match the checked-in bytes or the loader returns `false`.

Construct `repository` and `workflowSha` only from protected authenticated context. Construct `certificateIdentity` as the exact GitHub workflow URI. Resolve the root under `controlRoot`, read it with Task 2, and reject unknown policy IDs, missing files, digest mismatch, retired policy windows, or candidate-provided paths.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-sigstore-policy.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-sigstore-policy.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-trust/cosign-v3.1.2.json scripts/release/public-beta-trust/trusted-root.v1.json tests/public-beta/sigstore-policy.schema.json
```

Expected: PASS only with nonzero real 64-hex digests and matching root bytes. Network is not used by the unit test.

- [ ] **Step 5: Independent review boundary**

Two reviewers compare tool digests through independent official channels and review the root snapshot provenance. Test-only `openopc/platform` identities must not appear in production policy assets.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-sigstore-policy.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-trust tests/public-beta/sigstore-policy.schema.json
git commit -m "feat(release): pin public beta Sigstore policy"
```

### Task 6: Define the Source Descriptor and Provisional G3 Contract

**Files:**
- Create: `scripts/release/public-beta-source-candidate.ts`
- Create: `scripts/release/public-beta-source-candidate.test.ts`
- Create: `tests/public-beta/source-candidate.schema.json`
- Create: `tests/public-beta/source-candidate.fixture.json`
- Modify: `scripts/release/public-beta-evidence-v2.ts`
- Modify: `scripts/release/public-beta-evidence-v2.test.ts`

**Interfaces:**

```ts
export interface PublicBetaSourceEvidenceIndexV1 {
  schemaVersion: 1;
  candidateCommit: string;
  controlSha: string;
  artifacts: Array<{ path: string; digest: PublicBetaSha256Digest; sizeBytes: number; mediaType: string }>;
  indexDigest: PublicBetaSha256Digest;
}

export interface PublicBetaSourceCandidateDescriptorV1 {
  schemaVersion: 1;
  candidateId: string;
  commit: string;
  environment: 'openopc-public-beta-staging';
  sourceEvidenceIndexPath: string;
  sourceEvidenceIndexDigest: PublicBetaSha256Digest;
  provisionalEvidencePath: string;
  provisionalEvidenceDigest: PublicBetaSha256Digest;
  artifactManifestSeedPath: string;
  rollbackTarget: { commit: string; manifestDigest: PublicBetaSha256Digest };
  policyVersions: { terms: string; privacy: string; acceptableUse: string; moduleRules: string };
  regionalEvidence: Array<{ id: string; status: 'satisfied' | 'not_applicable'; artifactDigest: PublicBetaSha256Digest }>;
}

export function validatePublicBetaProvisionalEvidenceLedgerV2(
  value: unknown,
  options: { expectedCommit: string; now: Date; verifyArtifact(path: string, digest: string, size: number): boolean },
): PublicBetaEvidenceLedgerV2;
```

- [ ] **Step 1: Write failing provisional-ledger tests**

```ts
test('requires a retained blocked G3 pending-certification record', () => {
  const ledger = provisionalLedger();
  expect(validatePublicBetaProvisionalEvidenceLedgerV2(ledger, provisionalOptions()).records)
    .toContainEqual(expect.objectContaining({ gate: 'G3', outcome: 'blocked' }));
});

test('source producer cannot claim authoritative passed G3', () => {
  const ledger = provisionalLedger();
  ledger.records.find((record) => record.gate === 'G3')!.outcome = 'passed';
  expect(() => validatePublicBetaProvisionalEvidenceLedgerV2(ledger, provisionalOptions()))
    .toThrow('PUBLIC_BETA_PROVISIONAL_G3_INVALID');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-source-candidate.test.ts scripts/release/public-beta-evidence-v2.test.ts`

Expected: FAIL because the source descriptor and provisional validator are absent.

- [ ] **Step 3: Implement exact source wire contracts**

The provisional ledger keeps Evidence Ledger schema v2. It contains exactly one G3 record with outcome `blocked`, command `openopc-public-beta-certification-pending`, and a retained evidence artifact explaining the pending certification. It has no passed G3. The certifier later appends a higher-attempt passed G3 that resolves the blocked record; the ordinary readiness validator remains strict and unchanged. Source index and descriptor use exact-key parsers and Task 1 digests.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-source-candidate.test.ts scripts/release/public-beta-evidence-v2.test.ts
```

Expected: PASS; the standard readiness validator still rejects the provisional ledger.

- [ ] **Step 5: Independent review boundary**

Reviewer verifies there is no code path by which the source producer creates, upgrades, or aliases a passed G3 record.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-source-candidate.ts scripts/release/public-beta-source-candidate.test.ts scripts/release/public-beta-evidence-v2.ts scripts/release/public-beta-evidence-v2.test.ts tests/public-beta/source-candidate.schema.json tests/public-beta/source-candidate.fixture.json
git commit -m "feat(release): define provisional public beta candidates"
```

### Task 7: Replace Artifact Manifest v1 with v2

**Files:**
- Modify: `scripts/release/public-beta-artifacts.ts`
- Modify: `scripts/release/public-beta-artifacts.test.ts`
- Modify: `scripts/release/public-beta-release-manifest.ts`
- Modify: `scripts/release/public-beta-release-manifest.test.ts`
- Modify: `tests/public-beta/release-artifacts.schema.json`
- Modify: `tests/public-beta/release-artifacts.fixture.json`

**Interfaces:**

```ts
export const PUBLIC_BETA_SIGSTORE_BUNDLE_MEDIA_TYPE =
  'application/vnd.dev.sigstore.bundle.v0.3+json';

export interface PublicBetaArtifactManifestEntryV2 {
  name: PublicBetaArtifactName;
  digest: PublicBetaSha256Digest;
  sbomDigest: PublicBetaSha256Digest;
  provenanceDigest: PublicBetaSha256Digest;
  provenanceBundleDigest: PublicBetaSha256Digest;
  mediaType: string;
}

export interface PublicBetaArtifactManifestV2 {
  schemaVersion: 2;
  commit: string;
  artifacts: PublicBetaArtifactManifestEntryV2[];
  manifestDigest: PublicBetaSha256Digest;
}

export function computePublicBetaArtifactSetDigest(
  artifacts: readonly Pick<PublicBetaArtifactManifestEntryV2, 'name' | 'digest' | 'mediaType'>[],
): PublicBetaSha256Digest;
```

- [ ] **Step 1: Write failing v2 exact-key and four-column uniqueness tests**

```ts
test('requires unique artifact SBOM DSSE and Bundle digests for all eleven roles', () => {
  const value = artifactManifestV2();
  expect(parsePublicBetaArtifactManifest(value).schemaVersion).toBe(2);
  for (const key of ['digest', 'sbomDigest', 'provenanceDigest', 'provenanceBundleDigest'] as const) {
    const mutated = structuredClone(value);
    mutated.artifacts[1][key] = mutated.artifacts[0][key];
    expect(() => parsePublicBetaArtifactManifest(mutated)).toThrow();
  }
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-artifacts.test.ts`

Expected: FAIL because the parser still accepts schema v1 and lacks Bundle digests.

- [ ] **Step 3: Implement only v2**

Rename exported v1 interfaces to v2 and update all imports in the release module. Add `provenanceBundleDigest`, require canonical role ordering before digest computation, reject duplicate values independently in all four digest columns, retain fixed locator/media policy, and compute `artifactSetDigest` only from ordered role, artifact digest, and media type. Do not retain aliases or a dual parser.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-release-manifest.test.ts
```

Expected: PASS; both v1 schema and v1 fixture now fail parsing.

- [ ] **Step 5: Independent review boundary**

Reviewer verifies all eleven roles, fixed order, fixed repositories/suffixes, Bundle media type, and distinct artifact-set versus manifest digest semantics.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-artifacts.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-release-manifest.ts scripts/release/public-beta-release-manifest.test.ts tests/public-beta/release-artifacts.schema.json tests/public-beta/release-artifacts.fixture.json
git commit -m "feat(release): require artifact manifest v2"
```

### Task 8: Replace Release Manifest v1 with v2 and Three Digest Layers

**Files:**
- Modify: `scripts/release/public-beta-release-manifest.ts`
- Modify: `scripts/release/public-beta-release-manifest.test.ts`
- Modify: `tests/public-beta/release-candidate.schema.json`
- Modify: `tests/public-beta/release-candidate.fixture.json`

**Interfaces:**

```ts
export interface PublicBetaReleaseCertificationV1 {
  schemaVersion: 1;
  sourceRun: {
    repository: string;
    workflow: '.github/workflows/openopc-public-beta-gates.yml';
    runId: string;
    runAttempt: number;
    headSha: string;
    artifactId: string;
    artifactDigest: PublicBetaSha256Digest;
  };
  certifierRun: {
    repository: string;
    workflow: '.github/workflows/openopc-public-beta-certify.yml';
    workflowRef: 'refs/heads/main';
    controlSha: string;
    runId: string;
    runAttempt: number;
    event: 'workflow_run';
  };
  trustPolicyId: 'openopc-public-beta-sigstore-v1';
  trustPolicyDigest: PublicBetaSha256Digest;
  releaseRoot: {
    statementPath: string;
    statementDigest: PublicBetaSha256Digest;
    bundlePath: string;
    bundleDigest: PublicBetaSha256Digest;
  };
}

export interface PublicBetaReleaseApprovalV2 {
  environment: 'production';
  actor: string;
  approvedAt: string;
  candidateContentDigest: PublicBetaSha256Digest;
  certificationDigest: PublicBetaSha256Digest;
}

export interface PublicBetaReleaseManifestV2 {
  schemaVersion: 2;
  candidateId: string;
  commit: string;
  environment: 'openopc-public-beta-staging';
  artifacts: Array<{ name: PublicBetaArtifactName; digest: PublicBetaSha256Digest; imageOrPath: string }>;
  artifactManifestPath: string;
  artifactManifestDigest: PublicBetaSha256Digest;
  evidencePath: string;
  evidenceDigest: PublicBetaSha256Digest;
  rollbackTarget: { commit: string; manifestDigest: PublicBetaSha256Digest };
  policyVersions: { terms: string; privacy: string; acceptableUse: string; moduleRules: string };
  regionalEvidence: Array<{ id: string; status: 'satisfied' | 'not_applicable'; artifactDigest: PublicBetaSha256Digest }>;
  candidateContentDigest: PublicBetaSha256Digest;
  certification: PublicBetaReleaseCertificationV1;
  certificationDigest: PublicBetaSha256Digest;
  approval: PublicBetaReleaseApprovalV2 | null;
  manifestDigest: PublicBetaSha256Digest;
}

export function computePublicBetaCandidateContentDigest(
  manifest: PublicBetaReleaseManifestV2,
): PublicBetaSha256Digest;
export function computePublicBetaCertificationDigest(
  certification: PublicBetaReleaseCertificationV1,
): PublicBetaSha256Digest;
export function computePublicBetaFinalManifestDigest(
  manifest: PublicBetaReleaseManifestV2,
): PublicBetaSha256Digest;
```

- [ ] **Step 1: Write failing exact-schema, exclusion, and replay tests**

```ts
test('separates candidate certification and final manifest digests', () => {
  const manifest = releaseManifestV2();
  const candidate = computePublicBetaCandidateContentDigest(manifest);
  const certification = computePublicBetaCertificationDigest(manifest.certification);
  const final = computePublicBetaFinalManifestDigest(manifest);

  const changedApproval = structuredClone(manifest);
  changedApproval.approval!.actor = 'different-reviewer';
  expect(computePublicBetaCandidateContentDigest(changedApproval)).toBe(candidate);
  expect(computePublicBetaCertificationDigest(changedApproval.certification)).toBe(certification);
  expect(computePublicBetaFinalManifestDigest(changedApproval)).not.toBe(final);

  const changedRoot = structuredClone(manifest);
  changedRoot.certification.releaseRoot.bundleDigest = `sha256:${'f'.repeat(64)}`;
  expect(computePublicBetaCandidateContentDigest(changedRoot)).toBe(candidate);
  expect(computePublicBetaCertificationDigest(changedRoot.certification)).not.toBe(certification);
});

test('rejects approval replay across candidate or certification digests', () => {
  const manifest = releaseManifestV2();
  manifest.approval!.candidateContentDigest = `sha256:${'1'.repeat(64)}`;
  expect(() => parsePublicBetaReleaseManifest(manifest))
    .toThrow('PUBLIC_BETA_APPROVAL_DIGEST_MISMATCH');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-manifest.test.ts --test-name-pattern "digest|approval|schema v2"`

Expected: FAIL because Release Manifest remains v1.

- [ ] **Step 3: Implement exact v2 parsing and digest inputs**

`candidateContentDigest` hashes only the release core from `schemaVersion` through `regionalEvidence`; it excludes itself, `certification`, `certificationDigest`, `approval`, and `manifestDigest`. `certificationDigest` hashes the complete certification object. `manifestDigest` hashes release core, stored candidate digest, certification, stored certification digest, and approval; it excludes only itself. Approval binds the stored candidate and certification digests. Remove v1 types, the old approval `manifestDigest`, and the old function that hashed a manifest with approval forced to null.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-artifacts.test.ts
```

Expected: PASS; every one-field mutation changes the owning digest and no digest includes itself.

- [ ] **Step 5: Independent review boundary**

Reviewer writes the three canonical input objects side by side and checks every field appears exactly in the intended layer.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-release-manifest.ts scripts/release/public-beta-release-manifest.test.ts tests/public-beta/release-candidate.schema.json tests/public-beta/release-candidate.fixture.json
git commit -m "feat(release): require release manifest v2"
```

### Task 9: Encode DSSE PAE and Exact Per-Artifact SLSA Semantics

**Files:**
- Create: `scripts/release/public-beta-provenance.ts`
- Create: `scripts/release/public-beta-provenance.test.ts`
- Modify: `scripts/release/public-beta-artifacts.ts`
- Modify: `scripts/release/public-beta-artifacts.test.ts`

**Interfaces:**

```ts
export interface PublicBetaRunClaimsV1 {
  source: PublicBetaAuthenticatedSourceRun & { sourceEvidenceIndexDigest: PublicBetaSha256Digest };
  certifier: PublicBetaCertifierRunClaimsV1;
}

export interface PublicBetaArtifactProvenanceExpectationsV1 {
  artifact: Readonly<PublicBetaArtifactManifestEntryV2>;
  repository: string;
  commit: string;
  runClaims: Readonly<PublicBetaRunClaimsV1>;
}

export interface PublicBetaDsseEnvelope {
  payloadType: 'application/vnd.in-toto+json';
  payload: string;
  signatures: [{ keyid: string; sig: string }];
}

export function encodePublicBetaDssePae(payloadType: string, payload: Uint8Array): Uint8Array;
export function buildPublicBetaArtifactProvenanceStatement(
  input: PublicBetaArtifactProvenanceExpectationsV1,
): Record<string, unknown>;
export function parsePublicBetaDsseEnvelope(value: unknown): PublicBetaDsseEnvelope;
export function verifyPublicBetaArtifactProvenanceStatement(
  envelope: Readonly<PublicBetaDsseEnvelope>,
  expected: Readonly<PublicBetaArtifactProvenanceExpectationsV1>,
): { statement: Record<string, unknown>; pae: Uint8Array } | false;
```

- [ ] **Step 1: Write failing field-by-field SLSA mutations**

```ts
test.each([
  'artifactName', 'artifactDigest', 'artifactMediaType', 'sbomDigest', 'commit', 'repository',
  'sourceRunId', 'sourceRunAttempt', 'sourceStartedAt', 'sourceFinishedAt', 'sourceArchiveDigest',
  'sourceEvidenceIndexDigest', 'certifierRunId', 'certifierRunAttempt', 'certifierControlSha',
  'certifierStartedAt', 'certifierFinishedAt',
])('rejects mutated provenance binding %s', (field) => {
  const fixture = artifactProvenanceFixture();
  mutateSignedField(fixture.envelope, field);
  expect(verifyPublicBetaArtifactProvenanceStatement(fixture.envelope, fixture.expected)).toBe(false);
});

test('emits the DSSE v1 PAE byte sequence', () => {
  expect(new TextDecoder().decode(encodePublicBetaDssePae('text/plain', new TextEncoder().encode('abc'))))
    .toBe('DSSEv1 10 text/plain 3 abc');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-provenance.test.ts`

Expected: FAIL because the existing verifier binds only a subset of source and builder fields.

- [ ] **Step 3: Implement canonical payload and semantic verification**

Move PAE, DSSE parsing, and SLSA semantics out of `public-beta-artifacts.ts`. The payload is canonical RFC 8785 JSON and the envelope has exactly one signature. Bind the role, artifact digest/media type, SBOM digest, candidate commit/repository, authenticated source run ID/attempt/times/archive digest, source evidence index digest, certifier builder URI/run ID/attempt/control SHA/times, and exact SLSA v1/build-type identifiers. This module does not claim cryptographic verification.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-provenance.test.ts scripts/release/public-beta-artifacts.test.ts
```

Expected: PASS; changing any signed semantic field returns `false`.

- [ ] **Step 5: Independent review boundary**

Reviewer compares the SLSA statement to authenticated Task 4 types and verifies no expected repository, workflow, run, ref, SHA, or event comes from the ledger.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-provenance.ts scripts/release/public-beta-provenance.test.ts scripts/release/public-beta-artifacts.ts scripts/release/public-beta-artifacts.test.ts
git commit -m "feat(release): bind public beta SLSA provenance"
```

### Task 10: Cross-Bind Sigstore Bundle v0.3 to DSSE

**Files:**
- Create: `scripts/release/public-beta-sigstore-bundle.ts`
- Create: `scripts/release/public-beta-sigstore-bundle.test.ts`

**Interfaces:**

```ts
export interface PublicBetaSigstoreBundleBinding {
  bundleBytes: Uint8Array;
  certificateKeyId: `sha256:${string}`;
  signatureBytes: Uint8Array;
  paeDigest: PublicBetaSha256Digest;
}

export function parsePublicBetaSigstoreBundleV03(bytes: Uint8Array): unknown | false;
export function computePublicBetaCertificateKeyId(rawCertificate: Uint8Array): `sha256:${string}` | false;
export function bindPublicBetaDsseBundle(input: {
  envelope: Readonly<PublicBetaDsseEnvelope>;
  pae: Uint8Array;
  bundleBytes: Uint8Array;
}): PublicBetaSigstoreBundleBinding | false;
```

- [ ] **Step 1: Write failing PAE, signature, and SPKI swap tests**

```ts
test.each(['messageDigest', 'bundleSignature', 'dsseSignature', 'dsseKeyId', 'leafCertificate'])
  ('rejects DSSE Bundle cross-binding mutation %s', (field) => {
    const fixture = bundleBindingFixture();
    mutateBundleFixture(fixture, field);
    expect(bindPublicBetaDsseBundle(fixture)).toBe(false);
  });

test('rejects Promise-like and non-v0.3 structures before Cosign', () => {
  expect(parsePublicBetaSigstoreBundleV03(new TextEncoder().encode('{}'))).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-sigstore-bundle.test.ts`

Expected: FAIL because Bundle parsing and cross-binding do not exist.

- [ ] **Step 3: Implement structural binding without reimplementing PKI**

Fatal-decode and parse Bundle v0.3 with bounded exact structures. Require `messageSignature.messageDigest` to be SHA2-256 of PAE, Bundle signature bytes to equal DSSE signature bytes, and DSSE `keyid` to equal `sha256:` plus the lowercase SHA-256 of the Fulcio leaf certificate SPKI DER exported through `X509Certificate.publicKey`. Return the original verified bytes for Cosign. Do not treat parse success, a certificate, or a tlog entry as signature verification.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-sigstore-bundle.test.ts`

Expected: PASS for a structurally valid public fixture and every cross-swap rejection.

- [ ] **Step 5: Independent review boundary**

Reviewer confirms raw certificate versus SPKI hashing is correct and that certificate-chain, SCT, Rekor proof, checkpoint, and log identity remain delegated to Cosign.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-sigstore-bundle.ts scripts/release/public-beta-sigstore-bundle.test.ts
git commit -m "feat(release): bind DSSE to Sigstore bundles"
```

### Task 11: Implement Checksum-Pinned Synchronous Cosign Adapters

**Files:**
- Create: `scripts/release/public-beta-cosign.ts`
- Create: `scripts/release/public-beta-cosign.test.ts`

**Interfaces:**

```ts
export interface PublicBetaSigstoreVerifier {
  verify(input: {
    pae: Uint8Array;
    bundleBytes: Uint8Array;
    policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  }): boolean;
}

export interface PublicBetaSigstoreSigner {
  sign(input: {
    pae: Uint8Array;
    policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  }): { bundleBytes: Uint8Array } | false;
}

export interface PublicBetaProcessRunner {
  run(input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxOutputBytes: number;
  }): { status: number | null; signal: string | null; stdout: Uint8Array; stderr: Uint8Array };
}

export function createPublicBetaCosignVerifier(options: {
  executablePath: string;
  controlRoot: string;
  platform: 'linuxAmd64' | 'windowsAmd64';
  runner?: PublicBetaProcessRunner;
}): PublicBetaSigstoreVerifier | false;
export function createPublicBetaCosignSigner(options: {
  executablePath: string;
  controlRoot: string;
  platform: 'linuxAmd64' | 'windowsAmd64';
  runner?: PublicBetaProcessRunner;
}): PublicBetaSigstoreSigner | false;
```

- [ ] **Step 1: Write exact process and fail-closed tests**

```ts
test('invokes verify-blob without a shell and with exact identity claims', () => {
  const runner = recordingRunner({ status: 0, stdout: 'Verified OK\n', stderr: '' });
  const verifier = createVerifierFixture(runner);
  expect(verifier.verify(sigstoreInput())).toBe(true);
  expect(runner.calls[0].args).toEqual([
    'verify-blob', '--offline', '--bundle', runner.calls[0].args[3],
    '--trusted-root', runner.calls[0].args[5],
    '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--certificate-identity', canonicalCertificateIdentity(),
    '--certificate-github-workflow-repository', 'openopc/platform',
    '--certificate-github-workflow-ref', 'refs/heads/main',
    '--certificate-github-workflow-sha', 'c'.repeat(40),
    '--certificate-github-workflow-trigger', 'workflow_run',
    runner.calls[0].args.at(-1)!,
  ]);
});

test.each(['missing', 'digest', 'version', 'timeout', 'signal', 'nonzero', 'output', 'cleanup'])
  ('returns false for Cosign failure %s', (mode) => expect(runCosignFailure(mode)).toBe(false));

test('rejects async and truthy verifier results at the business boundary', () => {
  expect(acceptLiteralVerification(true)).toBe(true);
  expect(acceptLiteralVerification(Promise.resolve(true))).toBe(false);
  expect(acceptLiteralVerification({ ok: true })).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-cosign.test.ts`

Expected: FAIL because there is no real Sigstore adapter.

- [ ] **Step 3: Implement preflight, private temp files, and exact commands**

Before the first request, require absolute executable/root paths, same-descriptor executable digest, exact `cosign version` output for v3.1.2, and matching platform digest. Copy those verified executable bytes into a private adapter directory, re-hash the copy, and execute only that protected copy so the hash-to-exec boundary cannot be swapped. Cache success only for the copied executable identity and policy asset digest. For each call create a mode-0700 temporary directory outside candidate root, write the already-validated PAE and Bundle bytes, and invoke with an argument array through `spawnSync`, `shell: false`, fixed cwd, 60-second timeout, 1 MiB combined output cap, and an allowlist containing only platform essentials plus GitHub OIDC variables for signing. Verification requires exact `Verified OK` output. Signing uses the argument array `['sign-blob', '--yes', '--bundle', bundlePath, paePath]` and reads the resulting Bundle with Task 2. Recursive cleanup in `finally` is part of success.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-cosign.test.ts`

Expected: PASS with exact argument arrays and all process/environment/temp-file rejection paths.

- [ ] **Step 5: Independent review boundary**

Reviewer checks there is no shell string, insecure flag, identity regex, candidate path, candidate environment, online Rekor dependency during verify, or log of raw tool output.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-cosign.ts scripts/release/public-beta-cosign.test.ts
git commit -m "feat(release): add pinned Cosign adapters"
```

### Task 12: Verify One DSSE and Bundle Pair in One Authoritative G3 Record

**Files:**
- Create: `scripts/release/public-beta-certified-provenance.ts`
- Create: `scripts/release/public-beta-certified-provenance.test.ts`
- Modify: `scripts/release/public-beta-release-manifest.ts`
- Modify: `scripts/release/public-beta-release-manifest.test.ts`

**Interfaces:**

```ts
export interface VerifyPublicBetaArtifactProvenanceFromLedgerOptions {
  candidateRoot: string;
  ledger: Readonly<PublicBetaEvidenceLedgerV2>;
  artifact: Readonly<PublicBetaArtifactManifestEntryV2>;
  certification: Readonly<PublicBetaReleaseCertificationV1>;
  runClaims: Readonly<PublicBetaRunClaimsV1>;
  policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  verifier: PublicBetaSigstoreVerifier;
}

export function verifyPublicBetaArtifactSbomFromLedger(options: {
  candidateRoot: string;
  ledger: Readonly<PublicBetaEvidenceLedgerV2>;
  artifact: Readonly<PublicBetaArtifactManifestEntryV2>;
}): boolean;
export function verifyPublicBetaArtifactProvenanceFromLedger(
  options: VerifyPublicBetaArtifactProvenanceFromLedgerOptions,
): boolean;
```

- [ ] **Step 1: Write exhaustive negative lookup and runtime-shape tests**

```ts
test.each([
  'missing-dsse', 'duplicate-dsse', 'missing-bundle', 'duplicate-bundle', 'different-g3-record',
  'not-raw-evidence', 'source-owned-g3', 'wrong-run-id', 'wrong-run-attempt', 'wrong-time',
  'wrong-size', 'wrong-digest', 'invalid-utf8', 'malformed-json', 'symlink', 'adapter-false',
  'adapter-throw', 'adapter-promise', 'cross-artifact-swap',
])('fails closed for certified provenance mutation %s', (mutation) => {
  expect(verifyPublicBetaArtifactProvenanceFromLedger(certifiedFixture(mutation))).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-certified-provenance.test.ts`

Expected: FAIL because the current wrapper locates only DSSE and lacks Bundle/G3/certifier binding.

- [ ] **Step 3: Implement strict same-record lookup and verification order**

Find exactly one passed G3 record owned by the certification certifier repository, workflow, run ID, and run attempt. Within that same record find exactly one DSSE digest and one Bundle digest for the artifact; both paths must occur in `rawEvidencePaths`. Read both with Task 2, parse/semantically verify with Task 9, cross-bind with Task 10, call Task 11, and accept only literal `true`. Guard every runtime dereference and return `false` on all failures.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-certified-provenance.test.ts scripts/release/public-beta-release-manifest.test.ts
```

Expected: PASS; removal of any single trust check makes a mutation test fail.

- [ ] **Step 5: Independent review boundary**

Reviewer verifies lookup uniqueness, same-record ownership, same-FD reads, exact callback semantics, and absence of bare output-parameter-style property dereferences that can throw.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-certified-provenance.ts scripts/release/public-beta-certified-provenance.test.ts scripts/release/public-beta-release-manifest.ts scripts/release/public-beta-release-manifest.test.ts
git commit -m "feat(release): verify certified artifact provenance"
```

### Task 13: Build and Verify Release-Root Provenance

**Files:**
- Create: `scripts/release/public-beta-release-root.ts`
- Create: `scripts/release/public-beta-release-root.test.ts`

**Interfaces:**

```ts
export interface PublicBetaReleaseRootClaimsV1 {
  candidateId: string;
  environment: 'openopc-public-beta-staging';
  commit: string;
  candidateContentDigest: PublicBetaSha256Digest;
  artifactManifestDigest: PublicBetaSha256Digest;
  evidenceDigest: PublicBetaSha256Digest;
  evidenceSchemaDigest: PublicBetaSha256Digest;
  artifactSetDigest: PublicBetaSha256Digest;
  rollbackDigest: PublicBetaSha256Digest;
  policyVersionsDigest: PublicBetaSha256Digest;
  regionalEvidenceDigest: PublicBetaSha256Digest;
  runClaims: PublicBetaRunClaimsV1;
}

export function buildPublicBetaReleaseRootProvenance(
  input: Readonly<PublicBetaReleaseRootClaimsV1>,
): Record<string, unknown>;
export function verifyPublicBetaReleaseRootProvenance(input: {
  candidateRoot: string;
  manifest: Readonly<PublicBetaReleaseManifestV2>;
  artifactManifest: Readonly<PublicBetaArtifactManifestV2>;
  ledger: Readonly<PublicBetaEvidenceLedgerV2>;
  policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  verifier: PublicBetaSigstoreVerifier;
}): PublicBetaReleaseRootClaimsV1 | false;
```

- [ ] **Step 1: Write non-circularity and replay mutation tests**

```ts
test.each([
  'candidate', 'commit', 'artifactManifest', 'ledger', 'evidenceSchema', 'artifactSet',
  'rollback', 'policyVersions', 'regionalEvidence', 'sourceRun', 'certifierRun', 'controlSha',
])('rejects release-root mutation %s', (field) => {
  expect(verifyPublicBetaReleaseRootProvenance(releaseRootFixture(field))).toBe(false);
});

test('keeps release-root files outside candidateContentDigest', () => {
  const manifest = releaseManifestV2();
  const digest = computePublicBetaCandidateContentDigest(manifest);
  manifest.certification.releaseRoot.bundleDigest = `sha256:${'e'.repeat(64)}`;
  expect(computePublicBetaCandidateContentDigest(manifest)).toBe(digest);
  expect(computePublicBetaCertificationDigest(manifest.certification)).not.toBe(
    releaseManifestV2().certificationDigest,
  );
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-root.test.ts`

Expected: FAIL because overall provenance is still a missing callback.

- [ ] **Step 3: Implement release-root DSSE semantics and verification**

The release-root subject is the canonical candidate ID with SHA-256 equal to `candidateContentDigest` without its `sha256:` prefix. Bind all fields in `PublicBetaReleaseRootClaimsV1`, including source/certifier times. Resolve only the statement and Bundle paths from certification, read them with Task 2, run Task 9 DSSE parsing, Task 10 cross-binding, Task 11 cryptographic verification, and semantic comparison. Return typed claims only after every check; these claims become the trusted timing expectations for Task 12.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-release-root.test.ts`

Expected: PASS, including all digest-cycle and replay mutations.

- [ ] **Step 5: Independent review boundary**

Reviewer manually draws the production order `artifact statements -> artifact manifest -> ledger -> candidate digest -> release root -> certification digest -> approval -> final digest` and confirms no back-edge.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add scripts/release/public-beta-release-root.ts scripts/release/public-beta-release-root.test.ts
git commit -m "feat(release): bind public beta release root"
```

### Task 14: Assemble Certified Candidates Deterministically

**Files:**
- Create: `scripts/release/public-beta-certifier.ts`
- Create: `scripts/release/public-beta-certifier.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface PublicBetaCertifierInputV1 {
  candidateRoot: string;
  outputRoot: string;
  descriptor: PublicBetaSourceCandidateDescriptorV1;
  sourceRun: PublicBetaAuthenticatedSourceRun;
  certifierRun: PublicBetaCertifierRunClaimsV1;
  policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  signer: PublicBetaSigstoreSigner;
  now: Date;
}

export interface PublicBetaCertifiedCandidateV1 {
  artifactManifest: PublicBetaArtifactManifestV2;
  evidenceLedger: PublicBetaEvidenceLedgerV2;
  releaseManifest: PublicBetaReleaseManifestV2;
  emittedPaths: readonly string[];
}

export function certifyPublicBetaCandidate(
  input: PublicBetaCertifierInputV1,
): PublicBetaCertifiedCandidateV1 | false;
export async function runPublicBetaCertifierCli(
  args: string[],
  io?: PublicBetaReleaseManifestCliIo,
): Promise<number>;
```

- [ ] **Step 1: Write failing production-order and partial-output tests**

```ts
test('creates eleven DSSE Bundle pairs authoritative G3 and a preapproval manifest', () => {
  const result = certifyPublicBetaCandidate(certifierFixture());
  expect(result).not.toBe(false);
  expect(result!.artifactManifest.artifacts).toHaveLength(11);
  expect(result!.evidenceLedger.records).toContainEqual(expect.objectContaining({
    gate: 'G3', outcome: 'passed', workflow: expect.objectContaining({ workflow: '.github/workflows/openopc-public-beta-certify.yml' }),
  }));
  expect(result!.releaseManifest.approval).toBeNull();
});

test.each(['artifact-4-sign', 'artifact-manifest-write', 'g3-write', 'release-root-sign', 'final-rename'])
  ('leaves no certified archive after failure at %s', (failure) => {
    expect(certifyPublicBetaCandidate(certifierFixture({ failure }))).toBe(false);
    expect(certifiedOutputExists()).toBe(false);
  });
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-certifier.test.ts`

Expected: FAIL because no producer builds certified material.

- [ ] **Step 3: Implement staged assembly and atomic publication**

Validate the source descriptor/index/provisional ledger first. In a private staging directory: sign eleven artifact PAE values; derive each DSSE signature and SPKI key ID from its verified Bundle; build Artifact Manifest v2; append the certifier-owned G3 pass resolving the retained blocked G3; finalize Evidence Ledger v2; build release core and candidate digest; sign release root; build certification/certification digest; and build the preapproval Release Manifest v2 with `approval: null` and its current final digest. Validate the entire output through production parsers before one atomic directory rename. On failure clean only this invocation's staging directory.

Add root script `"public-beta:certify": "bun scripts/release/public-beta-certifier.ts"`.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-certifier.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-release-root.test.ts
```

Expected: PASS with deterministic bytes for a fixed signer fixture and no partial certified output.

- [ ] **Step 5: Independent review boundary**

Reviewer checks assembly order, authoritative G3 ownership, signer result cross-binding, atomic output, and verifies candidate input is never executed.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add package.json scripts/release/public-beta-certifier.ts scripts/release/public-beta-certifier.test.ts
git commit -m "feat(release): assemble certified public beta candidates"
```

### Task 15: Drive the Readiness CLI Through Real Verification Branches

**Files:**
- Modify: `scripts/release/public-beta-release-manifest.ts`
- Modify: `scripts/release/public-beta-release-manifest.test.ts`
- Create: `scripts/release/public-beta-release-cli.integration.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface PublicBetaReleaseVerifierDependencies {
  policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  verifier: PublicBetaSigstoreVerifier;
  now: Date;
  expectedCommit: string;
  expectedRepository: string;
  verifyReleaseArtifact(
    artifact: Readonly<PublicBetaReleaseManifestV2['artifacts'][number]>,
  ): boolean | Promise<boolean>;
}

export function evaluatePublicBetaReadiness(
  manifest: unknown,
  evidence: PublicBetaEvidenceInput,
): PublicBetaReadinessResult;
export async function runPublicBetaReleaseManifestCli(
  args: string[],
  io?: PublicBetaReleaseManifestCliIo,
  trustedDependencies?: PublicBetaReleaseVerifierDependencies,
): Promise<number>;
```

- [ ] **Step 1: Write a complete temporary-candidate integration test**

```ts
test('reaches only human approval then reaches ready after bound approval', async () => {
  const candidate = await materializeCertifiedCandidate({ approval: null });
  const before = await runCliAgainst(candidate);
  expect(before.exitCode).toBe(2);
  expect(before.stdout).toBe('{"status":"not_ready","reasons":["PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED"]}\n');
  expect(before.stderr).toBe('PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED\n');

  await applyBoundApproval(candidate);
  const after = await runCliAgainst(candidate);
  expect(after.exitCode).toBe(0);
  expect(after.stdout).toBe('{"status":"ready","reasons":[]}\n');
  expect(after.stderr).toBe('');
});

test.each(['artifact', 'sbom', 'artifact-provenance', 'release-root', 'certification'])
  ('surfaces the owning reason for %s failure', async (failure) => {
    const result = await runCliAgainst(await materializeCertifiedCandidate({ failure }));
    expect(result.exitCode).toBe(2);
    expect(result.reasons).toEqual([owningReason(failure)]);
  });
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-cli.integration.test.ts`

Expected: FAIL because production CLI does not construct a policy/Cosign adapter or release-root verifier and cannot reach success.

- [ ] **Step 3: Refactor readiness orchestration without adding a bypass**

Verify in this order: Release Manifest v2 digests, Evidence Ledger v2, Artifact Manifest v2, release artifact transport, release-root signature/semantics, eleven SBOMs, eleven per-artifact provenance pairs using root claims, certification digest, and approval. Production `main` constructs dependencies from protected CLI arguments and Task 5/11. Dependency injection is available only through the exported in-process function and is not selectable through CLI flags, candidate files, or environment inherited from candidate execution. Preserve sorted unique stable reasons and exact exit/stdout/stderr behavior.

Add root scripts:

```json
{
  "public-beta:test": "bun test public-beta-",
  "public-beta:validate": "bun scripts/release/public-beta-release-manifest.ts"
}
```

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-release-cli.integration.test.ts scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-certified-provenance.test.ts scripts/release/public-beta-release-root.test.ts
pnpm.cmd public-beta:test
```

Expected: PASS; the integration test proves control flow but does not yet count as real PKI evidence.

- [ ] **Step 5: Independent review boundary**

Reviewer temporarily replaces each verifier with `() => true`, `async () => false`, object return, and throw; only literal synchronous true at the intended boundary may advance, and production CLI must expose no injection switch.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add package.json scripts/release/public-beta-release-manifest.ts scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-release-cli.integration.test.ts
git commit -m "feat(release): complete public beta readiness verification"
```

### Task 16: Create the Unprivileged Gates Producer Contract

**Files:**
- Create: `.github/workflows/openopc-public-beta-gates.yml`
- Create: `.github/workflows/openopc-public-beta-gate-runner.yml`
- Create: `scripts/release/public-beta-gate.ts`
- Create: `scripts/release/public-beta-gate.test.ts`
- Create: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface PublicBetaGateCommandProvider {
  run(input: {
    gate: PublicBetaGateId;
    commit: string;
    environment: 'openopc-public-beta-staging';
    outputRoot: string;
  }): Promise<{ outcome: 'passed' | 'failed' | 'blocked'; rawEvidencePaths: readonly string[] }>;
}

export async function runPublicBetaGateCli(args: string[]): Promise<number>;
```

Workflow name is exactly `OpenOPC Public Beta Gates`; dispatch ref is `staging`; output artifact is exactly `openopc-public-beta-source-candidate`. The 22 job IDs are the exact `workflowJobId` values from `PUBLIC_BETA_LANES`.

- [ ] **Step 1: Write failing workflow and dispatcher contract tests**

```ts
test('defines every canonical lane with no signing authority', async () => {
  const workflow = await parseWorkflow('.github/workflows/openopc-public-beta-gates.yml');
  expect(workflow.name).toBe('OpenOPC Public Beta Gates');
  expect(JSON.stringify(workflow)).not.toContain('id-token');
  for (const lane of PUBLIC_BETA_LANES) {
    expect(workflow.jobs[lane.workflowJobId]).toBeDefined();
  }
  expect(Object.keys(workflow.jobs).filter((id) => id.startsWith('public-beta-'))).toHaveLength(22);
});

test('missing owner implementation records blocked and never passed', async () => {
  const result = await runGateWithNoProvider('B7');
  expect(result).toEqual(expect.objectContaining({ outcome: 'blocked' }));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-gate.test.ts --test-name-pattern "Gates|owner implementation"`

Expected: FAIL because Gates, reusable runner, and gate dispatcher do not exist.

- [ ] **Step 3: Implement explicit 22-lane orchestration**

Define all 22 jobs explicitly; each calls the reusable runner with its exact gate, candidate commit, environment, dependencies, and required evidence list from `PUBLIC_BETA_LANES`. The runner checks out the exact staging SHA, installs with lockfile enforcement, and invokes `pnpm.cmd public-beta:gate --gate ${{ inputs.gate }} --commit ${{ inputs.candidate_commit }} --environment openopc-public-beta-staging --output artifacts/public-beta/${{ inputs.candidate_commit }}/${{ inputs.gate }}`. The dispatcher calls an owning provider registered by its approved implementation plan; absent or malformed provider output is `blocked`, never pass. Always retain stdout, stderr, JUnit/browser/SQL/node artifacts and failure records. Aggregate only after every lane completes, construct Task 6 files, and upload one bounded source archive.

The source archive records the exact workflow and reusable-runner blob digests. Task 17 compares those files at the candidate commit against the protected control SHA before certification; a changed source control surface is rejected.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-gate.test.ts scripts/release/public-beta-lanes.test.ts
```

Expected: static contract and dispatcher tests pass. A live run remains blocked until every owning Gate provider returns real evidence; no synthetic pass closes B7, G10, B10, or any other lane.

- [ ] **Step 5: Independent review boundary**

Reviewer verifies no signing permission/credential, skipped-success fallback, `continue-on-error` on required commands, unpinned action, arbitrary command input, or source invocation of the certifier.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add .github/workflows/openopc-public-beta-gates.yml .github/workflows/openopc-public-beta-gate-runner.yml scripts/release/public-beta-gate.ts scripts/release/public-beta-gate.test.ts scripts/release/public-beta-workflow-contract.test.ts package.json
git commit -m "ci(beta): add unprivileged public beta Gates"
```

### Task 17: Add the Protected Keyless Certifier Workflow

**Files:**
- Create: `.github/workflows/openopc-public-beta-certify.yml`
- Modify: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: `scripts/release/public-beta-github-actions.ts`
- Modify: `scripts/release/public-beta-github-actions.test.ts`

**Interfaces:**

Workflow trigger is only `workflow_run` for `OpenOPC Public Beta Gates` with type `completed`. Jobs are exactly `authenticate` and `certify`; output artifact is exactly `openopc-public-beta-certified-candidate`.

- [ ] **Step 1: Write failing certifier security-contract tests**

```ts
test('separates authenticate and signing permissions', async () => {
  const workflow = await parseWorkflow('.github/workflows/openopc-public-beta-certify.yml');
  expect(workflow.on.workflow_run.workflows).toEqual(['OpenOPC Public Beta Gates']);
  expect(workflow.on.workflow_run.types).toEqual(['completed']);
  expect(workflow.jobs.authenticate.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(workflow.jobs.certify.permissions['id-token']).toBe('write');
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id !== 'certify') expect(job.permissions?.['id-token']).not.toBe('write');
  }
});

test('never executes or checks out candidate content in a privileged job', async () => {
  const text = await Bun.file('.github/workflows/openopc-public-beta-certify.yml').text();
  expect(text).not.toContain('actions/download-artifact@');
  expect(text).not.toContain('npm run');
  expect(text).not.toContain('pnpm run');
  expect(text).not.toContain('pull_request_target');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-workflow-contract.test.ts --test-name-pattern "certifier"`

Expected: FAIL because the certifier workflow does not exist.

- [ ] **Step 3: Implement two-job authentication and certification**

`authenticate` checks its protected workflow ref/SHA, authenticates the source run, verifies canonical repository/name/path/event/staging branch/candidate SHA/status/conclusion/attempt, compares source workflow and reusable-runner bytes against the protected control SHA, downloads the unique raw source ZIP through Task 4, and authenticates/extracts it through Task 3. It emits only immutable run/artifact coordinates as job outputs.

`certify` repeats raw source ZIP download and authentication from those coordinates, checks out only `${{ github.workflow_sha }}`, installs verified Cosign v3.1.2, builds Task 5 policy from `${{ github.repository }}` and `${{ github.workflow_sha }}`, invokes `pnpm.cmd public-beta:certify`, validates the complete certified directory, creates a bounded archive, and uploads it. It never executes candidate content. Every `uses:` has a full SHA and no job uses warning-only digest output as evidence.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-github-actions.test.ts
```

Expected: PASS for static contracts and fork/workflow/ref/SHA/event/archive mutations.

- [ ] **Step 5: Independent review boundary**

Reviewer checks every trust value origin, both raw downloads, protected checkout SHA, job outputs, and confirms OIDC variables reach only the signer process in `certify`.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add .github/workflows/openopc-public-beta-certify.yml scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-github-actions.ts scripts/release/public-beta-github-actions.test.ts
git commit -m "ci(beta): add protected keyless certifier"
```

### Task 18: Make Approval Consume Only Certified Candidates

**Files:**
- Create: `scripts/release/public-beta-approval.ts`
- Create: `scripts/release/public-beta-approval.test.ts`
- Modify: `.github/workflows/openopc-public-beta-approval.yml`
- Modify: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export function applyPublicBetaApproval(input: {
  manifest: PublicBetaReleaseManifestV2;
  actor: string;
  approvedAt: string;
  dispatcher: string;
}): PublicBetaReleaseManifestV2 | false;
export async function runPublicBetaApprovalCli(
  args: string[],
  io?: PublicBetaReleaseManifestCliIo,
): Promise<number>;
```

Workflow inputs are exactly `certifier_run_id` and `expected_commit`.

- [ ] **Step 1: Write failing approval helper and workflow tests**

```ts
test('binds a non-self reviewer to candidate and certification digests', () => {
  const approved = applyPublicBetaApproval({
    manifest: preapprovalManifest(),
    actor: 'release-reviewer',
    dispatcher: 'release-dispatcher',
    approvedAt: '2026-07-29T12:00:00.000Z',
  });
  expect(approved?.approval).toEqual({
    environment: 'production',
    actor: 'release-reviewer',
    approvedAt: '2026-07-29T12:00:00.000Z',
    candidateContentDigest: approved!.candidateContentDigest,
    certificationDigest: approved!.certificationDigest,
  });
});

test.each(['same-actor', 'existing-approval', 'candidate-digest', 'certification-digest'])
  ('rejects approval mutation %s', (mutation) => expect(applyApprovalMutation(mutation)).toBe(false));
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-approval.test.ts scripts/release/public-beta-workflow-contract.test.ts --test-name-pattern "approval|certified candidate"`

Expected: FAIL because approval still accepts `candidate_run_id`, downloads the staging archive through an extraction action, and writes the v1 object.

- [ ] **Step 3: Implement certified-run validation before and after environment review**

The `validate` job authenticates the certifier run/control SHA/unique archive and its recorded source run, raw-downloads and verifies the certified ZIP, and runs the protected CLI. It advances only on exit `2` with the sole reason `PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`. The `approve` job uses `environment: production`, repeats all authentication and raw ZIP checks, queries GitHub deployment review history, rejects dispatcher/self/missing/duplicate reviewer identities, invokes `public-beta:approve`, and reruns validation. Only exit `0` uploads approved release evidence. Remove all `actions/download-artifact` use and YAML inline manifest mutation scripts.

Add root script `"public-beta:approve": "bun scripts/release/public-beta-approval.ts"`.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-approval.test.ts scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-release-cli.integration.test.ts
```

Expected: PASS; approval has no `id-token: write`, and old `candidate_run_id` is rejected by contract tests.

- [ ] **Step 5: Independent review boundary**

Reviewer checks environment protection remains required outside YAML: required reviewers, prevent self-review, protected `main`, disabled admin bypass, and actual review history rather than dispatcher identity.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add .github/workflows/openopc-public-beta-approval.yml scripts/release/public-beta-approval.ts scripts/release/public-beta-approval.test.ts scripts/release/public-beta-workflow-contract.test.ts package.json
git commit -m "ci(beta): approve only certified candidates"
```

### Task 19: Retain a Real Offline Sigstore and Complete CLI Fixture

**Files:**
- Create: `tests/public-beta/sigstore/offline/fixture-manifest.json`
- Create: `tests/public-beta/sigstore/offline/README.md`
- Create: `tests/public-beta/sigstore/offline/` certified public fixture files
- Create: `scripts/release/public-beta-sigstore-offline.test.ts`
- Modify: `scripts/release/public-beta-release-cli.integration.test.ts`
- Create: `.github/workflows/openopc-public-beta-trust-test.yml`

**Interfaces:**

```ts
export interface PublicBetaOfflineFixtureManifestV1 {
  schemaVersion: 1;
  repository: string;
  certifierWorkflowSha: string;
  sourceRunId: string;
  certifierRunId: string;
  generatedAt: string;
  trustedRootDigest: PublicBetaSha256Digest;
  files: Array<{ path: string; digest: PublicBetaSha256Digest; sizeBytes: number }>;
}
```

- [ ] **Step 1: Write the failing offline and trust-mutation test**

```ts
test('verifies the retained canonical fixture with outbound network disabled', () => {
  expect(runRealOfflineFixture()).toEqual({ status: 'ready', reasons: [] });
});

test.each(['issuer', 'identity', 'repository', 'workflow', 'ref', 'sha', 'event', 'root',
  'certificate', 'sct', 'set', 'inclusion-proof', 'checkpoint', 'log-id', 'pae', 'signature'])
  ('rejects real fixture trust mutation %s', (mutation) => {
    expect(runMutatedRealOfflineFixture(mutation).status).toBe('not_ready');
  });
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-sigstore-offline.test.ts`

Expected: FAIL because no protected run has produced the real public fixture.

- [ ] **Step 3: Bootstrap the fixture in two protected revisions**

First land Tasks 1-18 while readiness remains fail closed. Dispatch one genuine Gates run and its automatically triggered protected certifier on the canonical repository. Download the raw certified archive by artifact ID, verify its API digest/size, and copy the public non-secret PAE, eleven DSSE/Bundle pairs, release-root DSSE/Bundle, manifests, ledgers, root, and run metadata into the offline directory. Build `fixture-manifest.json` from actual bytes and record the exact canonical repository/control SHA/run IDs. Submit this fixture as a separate protected review; never hand-author signature bytes or substitute a synthetic callback.

The test invokes the real pinned Cosign binary with `--offline`. CI executes the test in a network namespace without outbound access and verifies every trust mutation fails. The complete CLI fixture is preapproved only inside the retained public fixture so the expected success result is `ready`.

- [ ] **Step 4: Run GREEN**

```powershell
bun test scripts/release/public-beta-sigstore-offline.test.ts scripts/release/public-beta-release-cli.integration.test.ts
pnpm.cmd public-beta:test
```

Expected: PASS with real Cosign and no network. Record the exact command/output in the review; a mocked verifier is not evidence for this task.

- [ ] **Step 5: Independent review boundary**

Reviewer matches fixture run IDs and artifact digests to GitHub API, checks no secret/private key exists, and runs at least one network-blocked verification independently.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add tests/public-beta/sigstore/offline scripts/release/public-beta-sigstore-offline.test.ts scripts/release/public-beta-release-cli.integration.test.ts .github/workflows/openopc-public-beta-trust-test.yml
git commit -m "test(release): retain offline Sigstore evidence"
```

### Task 20: Document Rotation, Rekor Outage, Retention, and Rollback

**Files:**
- Modify: `docs/runbooks/openopc-public-beta-release.md`
- Create: `docs/runbooks/openopc-public-beta-sigstore.md`
- Create: `scripts/release/public-beta-runbook-contract.test.ts`

**Interfaces:** No runtime interface. The contract test treats policy ID, trusted-root digest, Cosign version, archive names, workflow names, CLI reason codes, and rotation sequence as exact operational constants.

- [ ] **Step 1: Write a failing runbook contract**

```ts
test('documents only the certified run flow and offline trust rotation', async () => {
  const release = await Bun.file('docs/runbooks/openopc-public-beta-release.md').text();
  const sigstore = await Bun.file('docs/runbooks/openopc-public-beta-sigstore.md').text();
  expect(release).toContain('certifier_run_id');
  expect(release).not.toContain('candidate_run_id');
  expect(sigstore).toContain('openopc-public-beta-sigstore-v1');
  expect(sigstore).toContain('v3.1.2');
  expect(sigstore).toContain('offline');
  expect(sigstore).not.toContain('insecure-ignore');
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-runbook-contract.test.ts`

Expected: FAIL because the release runbook still describes direct staging approval and the Sigstore runbook is absent.

- [ ] **Step 3: Write exact operational procedures**

Document source/certifier/approval run authentication, raw ZIP verification, preapproval sole-reason check, non-self approval, retained evidence, Cosign upgrade with two independent checksum channels, trusted-root refresh through TUF, overlap policy with fixed cutoff, offline fixture regeneration, Rekor outage behavior, rollback to prior policy, and no manual waiver. Preserve current B7, G10, B10, DNS-rebinding, and broader Gate blockers until current live evidence closes them.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-runbook-contract.test.ts`

Expected: PASS with no stale staging-direct approval instructions.

- [ ] **Step 5: Independent review boundary**

Operations and security reviewers walk the procedure without repository context and verify it never instructs them to trust candidate roots, online-only Rekor, dispatcher identity, or warning-only archive validation.

- [ ] **Step 6: Commit boundary after renewed authorization**

```powershell
git add docs/runbooks/openopc-public-beta-release.md docs/runbooks/openopc-public-beta-sigstore.md scripts/release/public-beta-runbook-contract.test.ts
git commit -m "docs(release): operate public beta Sigstore trust"
```

### Task 21: Prove the Live GitHub Sequence and Broader Readiness Boundary

**Files:**
- Create: `scripts/release/public-beta-live-acceptance.ts`
- Create: `scripts/release/public-beta-live-acceptance.test.ts`
- Create: `tests/public-beta/live-acceptance.schema.json`
- Modify: `package.json`
- Produce, do not commit: `artifacts/public-beta/live-acceptance.json`

**Interfaces:**

```ts
export interface PublicBetaLiveAcceptanceRecordV1 {
  schemaVersion: 1;
  repository: string;
  candidateCommit: string;
  sourceRun: { id: string; attempt: number; artifactId: string; artifactDigest: PublicBetaSha256Digest };
  certifierRun: { id: string; attempt: number; controlSha: string; artifactId: string; artifactDigest: PublicBetaSha256Digest };
  approvalRun: { id: string; attempt: number; reviewer: string; approvedAt: string };
  preapproval: { exitCode: 2; reasons: ['PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED'] };
  postapproval: { exitCode: 0; status: 'ready' };
  environmentProtection: {
    requiredReviewers: true;
    preventSelfReview: true;
    protectedMainOnly: true;
    adminBypassDisabled: true;
  };
  retainedEvidenceDigests: PublicBetaSha256Digest[];
}

export function validatePublicBetaLiveAcceptance(value: unknown): PublicBetaLiveAcceptanceRecordV1;
export async function runPublicBetaLiveAcceptanceCli(args: string[]): Promise<number>;
```

- [ ] **Step 1: Write failing incomplete-sequence tests**

```ts
test.each(['source', 'certifier', 'preapproval', 'reviewer', 'postapproval', 'environment', 'evidence'])
  ('rejects incomplete live sequence %s', (missing) => {
    expect(() => validatePublicBetaLiveAcceptance(liveRecordWithout(missing))).toThrow();
  });

test('rejects fixture and synthetic run identities', () => {
  expect(() => validatePublicBetaLiveAcceptance({ ...liveRecord(), sourceRun: { id: 'fixture' } }))
    .toThrow();
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-live-acceptance.test.ts`

Expected: FAIL because no live acceptance contract exists.

- [ ] **Step 3: Implement API-backed acceptance validation**

Authenticate all three runs and artifacts through Task 4, verify source-to-certifier and certifier-to-approval references, query `production` environment protection and review history, verify pre/post CLI evidence and retained DSSE/Bundle/root/manifest digests, and reject self-review or missing controls. Add root script `"public-beta:live:validate": "bun scripts/release/public-beta-live-acceptance.ts"`.

- [ ] **Step 4: Run all local gates before dispatch**

```powershell
pnpm.cmd public-beta:test
pnpm.cmd migrate:lint
pnpm.cmd test
pnpm.cmd exec biome check --formatter-enabled=false scripts/release tests/public-beta package.json
git diff --check -- .github/workflows scripts/release tests/public-beta docs/runbooks package.json pnpm-lock.yaml
```

Expected: all commands pass. Any unrelated existing monorepo failure is recorded verbatim and resolved by its owner; it is not hidden by narrowing the readiness claim.

- [ ] **Step 5: Execute the real protected sequence**

```powershell
$repo = gh repo view --json nameWithOwner --jq .nameWithOwner
$candidate = git rev-parse staging
gh workflow run openopc-public-beta-gates.yml --repo $repo --ref staging -f candidate_commit=$candidate
gh run watch --repo $repo --exit-status
$sourceRun = gh run list --repo $repo --workflow openopc-public-beta-gates.yml --branch staging --limit 1 --json databaseId --jq '.[0].databaseId'
$certifierRun = gh run list --repo $repo --workflow openopc-public-beta-certify.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh workflow run openopc-public-beta-approval.yml --repo $repo --ref main -f certifier_run_id=$certifierRun -f expected_commit=$candidate
```

Allow the protected environment to pause for a different authorized reviewer. After completion, generate `artifacts/public-beta/live-acceptance.json` from GitHub API responses and retained CLI outputs, then run:

```powershell
pnpm.cmd public-beta:live:validate --record artifacts/public-beta/live-acceptance.json --repository $repo
```

Expected: the live validator exits `0`, and the source, certifier, approval, and retained artifact IDs/digests all refer to the same candidate.

- [ ] **Step 6: Complete the broader public-beta audit**

Rerun the existing public-beta evidence/program validators. Certification is necessary but does not close B7, G10, B10, DNS-rebinding transport, or any other Gate unless current real evidence proves it. Public-beta launch status changes only when the broader audit has no remaining reason.

- [ ] **Step 7: Independent review boundary**

Security reviews Sigstore identity and raw archives; operations reviews environment controls and evidence retention; Gate owners review all 22 real lane results. A single focused green or one successful run is insufficient.

- [ ] **Step 8: Commit boundary after renewed authorization**

```powershell
git add package.json scripts/release/public-beta-live-acceptance.ts scripts/release/public-beta-live-acceptance.test.ts tests/public-beta/live-acceptance.schema.json
git commit -m "test(release): validate live public beta certification"
```

Do not commit `artifacts/public-beta/live-acceptance.json`; retain it as the protected workflow artifact named by the runbook.

## Dependency Order

```text
T1 -> T2 -> T3 -> T4 -> T5
T1 -> T6
T1 -> T7 -> T8
T4 + T7 -> T9 -> T10
T2 + T5 + T10 -> T11
T6 + T7 + T9 + T10 + T11 -> T12
T5 + T8 + T9 + T10 + T11 -> T13
T6 + T7 + T8 + T11 + T13 -> T14 -> T15
T6 + existing Gate owners -> T16
T3 + T4 + T5 + T14 + T16 -> T17
T4 + T8 + T15 + T17 -> T18
T11 + T15 + T17 + T18 -> T19 -> T20 -> T21
```

T2, T6, and T7 can proceed in parallel after T1. T8 and T9 can proceed in parallel after their dependencies. No worker edits the same production file concurrently; `public-beta-release-manifest.ts`, workflow contract tests, and `package.json` are serialized integration boundaries.

## Design Coverage

| Design section | Owning tasks |
| --- | --- |
| 1 Decision | T14-T18 |
| 2 Goals | T1-T21 |
| 3 Non-goals | Global Constraints, T16-T20 |
| 4 Threat Model | T2-T5, T9-T13, T19 |
| 5 Workflow Architecture | T4, T6, T14, T16-T18 |
| 6 Platform-Owned Trust Policy | T5 |
| 7 Artifact Manifest v2 | T7 |
| 8 Per-Artifact Provenance | T9-T12 |
| 9 Release Manifest v2 and Digests | T8 |
| 10 Release-Root Provenance | T13 |
| 11 Cosign Adapter | T11 |
| 12 File and Archive Safety | T2-T4 |
| 13 Failure Contract | T12, T15, T18 |
| 14 Test Strategy | Per-task tests, T15, T19, T21 |
| 15 Operations and Rotation | T5, T20 |
| 16 Upstream Compatibility | Global Constraints, T16-T20 |
| 17 Acceptance Criteria | T19-T21 |

## Final Verification Gate

Before claiming this implementation complete, record fresh outputs for:

```powershell
pnpm.cmd public-beta:test
pnpm.cmd migrate:lint
pnpm.cmd test
pnpm.cmd exec biome check --formatter-enabled=false scripts/release tests/public-beta package.json
git diff --check -- .github/workflows scripts/release tests/public-beta docs/runbooks package.json pnpm-lock.yaml
git diff -- docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md tests/module-beta/evidence.json .github/workflows/deploy-dev.yml .github/workflows/ci.yml
git status --porcelain --untracked-files=all
```

The protected-file diff must be empty. The live Gate requires a real source run, automatically triggered certifier, sole preapproval reason, non-self production approval, final ready result, offline fixture verification, and no broader public-beta Gate reason.
