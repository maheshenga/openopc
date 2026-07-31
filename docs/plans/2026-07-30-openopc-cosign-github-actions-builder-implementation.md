# OpenOPC Cosign GitHub Actions Builder Implementation Plan

> Repository identity correction: execute
> `docs/plans/2026-07-31-openopc-canonical-repository-identity-migration.md`
> before any remote builder step. The canonical production repository is
> `maheshenga/openopc`; all `openopc/platform` identity literals below are
> superseded and must not authorize a live run.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, attest, admit, and consume OpenOPC-owned Cosign v3.1.2 Linux and Windows binaries under an exact protected GitHub Actions identity so restricted public-beta certification can resume without trusting the upstream Google release identity.

**Architecture:** A protected `openopc/platform` workflow builds two deterministic `CGO_ENABLED=0` subjects twice from the exact upstream Cosign source, compares their bytes, emits SLSA Provenance v1 GitHub artifact attestations, smoke-tests both platforms, and promotes only the compared subjects. Protected TypeScript loaders authenticate the builder run, manifest, bundles, binary digests, and candidate-policy cross-binding; a platform-specific launcher prevents binary replacement between digest authorization and execution.

**Tech Stack:** TypeScript, Bun 1.3.14, pnpm 8.11.0, GitHub Actions OIDC and Artifact Attestations, `actions/attest` v4.2.1, SLSA Provenance v1, Cosign v3.1.2, Go 1.26.0, Docker/OCI build container by digest, PowerShell 7, RFC 8785, SHA-256, JSON Schema 2020-12.

## Global Constraints

- Work only in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`; planning HEAD is `6e8a567b915d567a75131d2f6cdc53c1f3fe53f8`.
- Implement the approved design in `docs/specs/2026-07-30-openopc-cosign-github-actions-builder-design.md`.
- Canonical production identity is `openopc/platform`; the current local `kortix-ai/suna` remote is not an accepted builder identity.
- Toolchain ID is exactly `openopc-cosign-v3.1.2.1`; release tag is exactly `openopc-cosign-v3.1.2.1`.
- Upstream source is exactly tag object `dc80df70da727f4abdd843640594025584a270ae`, commit `193d2153431f8bb0d945a4c1ee721872f73add67`, tree `6647db468973d11edb5e737293fcf4b05c69a84a`, and Go `1.26.0`.
- Build only `linux/amd64` and `windows/amd64` with `CGO_ENABLED=0`, `GOTOOLCHAIN=local`, `GOFLAGS=-mod=readonly`, `-trimpath`, empty build ID, deterministic version fields, and commit-derived `SOURCE_DATE_EPOCH`.
- The build container must be pinned by a real digest matching `^sha256:[0-9a-f]{64}$`. A mutable image tag is metadata only and never authorizes a build.
- Baseline Action pins verified on 2026-07-30 are: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`, `actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d`, and `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`. Re-resolve tags before implementation and stop for review if any tag points elsewhere; never silently update a pin.
- Admission uses exactly GitHub CLI 2.95.0. A different verifier version requires explicit compatibility review before its output can admit trust assets.
- The builder and attestation predicate accept no caller-controlled repository, ref, URL, version, command, image, runner, subject name, or output path.
- Preserve the separate candidate certificate identity `.github/workflows/openopc-public-beta-certify.yml@refs/heads/main` and the non-self approval identity.
- Retain the parent policy's direct `cosignVersion` and `cosignBinaryDigests`; add an exact toolchain ID, manifest path, and manifest digest, and require both digest sources to agree.
- Preserve complete eleven-artifact registries; the restricted certified path remains the protected literal seven-artifact profile.
- Do not execute candidate code, package hooks, workflows, binaries, or arbitrary commands in a protected builder, certifier, or approval context.
- Unit and workflow-contract tests must not invoke Docker or the network. The real protected builder run is a separately authorized online acceptance gate.
- Use `pnpm.cmd` in PowerShell and invoke `bun` directly.
- Every source task records a real RED, minimal GREEN, focused regression, `git diff --check`, and independent no-index review. Do not weaken tests or convert required failures to warnings.
- Preserve all existing dirty and untracked work. Do not reset, checkout, restore, stash, clean, or overwrite unrelated files.
- Do not edit protected files named by `.superpowers/sdd/2026-07-29-openopc-public-beta-sigstore-certification-implementation/progress.md`.
- Every staging/commit command below is only a proposed review boundary. Do not stage, commit, push, dispatch, publish a release, deploy, or open registration without renewed exact authorization.
- No numbered SLSA level may be claimed until an independent review evaluates the implemented builder and real provenance against that level.
- Any unavailable registry, canonical repository, protected environment, GitHub attestation service, or required verifier blocks the task. There is no Google-identity, Winget, checksum-only, or unsigned-manifest fallback.

---

## File Map

- `scripts/release/public-beta-github-actions.ts`: pure authentication of source, tool-builder, and certifier GitHub runs and unique artifacts.
- `scripts/release/public-beta-github-actions.test.ts`: fork, event, ref, SHA, attempt, expiry, artifact ambiguity, and builder/certifier identity mutations.
- `scripts/release/public-beta-cosign-toolchain.ts`: closed manifest/lock parsers, canonical digests, platform selection, builder identity derivation, and retained-bundle path policy.
- `scripts/release/public-beta-cosign-toolchain.test.ts`: manifest, source pin, action pin, platform mapping, canonical digest, and candidate-ownership tests.
- `scripts/release/public-beta-cosign-builder.ts`: deterministic command-plan generation, build-result parsing, replay comparison, SLSA predicate generation, and fixed CLI modes.
- `scripts/release/public-beta-cosign-builder.test.ts`: command and predicate vectors; all process execution is mocked.
- `scripts/release/public-beta-cosign-toolchain-admission.ts`: authenticated run download, `gh attestation verify` adapter, predicate enforcement, and exclusive trust-output publication.
- `scripts/release/public-beta-cosign-toolchain-admission.test.ts`: exact verifier arguments, malformed output, wrong source, wrong subject, duplicate bundle, and atomic-output tests.
- `scripts/release/public-beta-cosign.ts`: protected binary selection, acquisition, digest authorization, bounded process adapter, timeout, and redaction.
- `scripts/release/public-beta-cosign.test.ts`: Linux descriptor execution, runner mutation, output bounds, and toolchain cross-binding.
- `scripts/release/public-beta-cosign-windows-launcher.ps1`: Windows non-share-write/delete file handle, digest check, argument-safe process launch, and bounded output.
- `scripts/release/public-beta-cosign-windows-launcher.test.ts`: Windows replacement-race and argument-vector tests; skipped only on non-Windows hosts.
- `scripts/release/public-beta-sigstore-policy.ts`: candidate signing policy plus direct/toolchain digest cross-binding and trusted-root ownership.
- `scripts/release/public-beta-sigstore-policy.test.ts`: protected identity, root, rotation, toolchain, and candidate override tests.
- `scripts/release/public-beta-workflow-contract.test.ts`: parsed workflow graph, triggers, job permissions, immutable pins, fixed inputs, attestation, smoke, and promotion constraints.
- `.github/workflows/openopc-cosign-builder.yml`: protected build, replay, compare, attest, smoke, and environment-gated promotion.
- `scripts/release/public-beta-trust/cosign-builder-lock.v1.json`: exact source, Go, build-image, and Action pins admitted before workflow execution.
- `scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/toolchain.json`: real toolchain manifest emitted only after the protected run passes.
- `scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/linux-amd64.jsonl`: retained Linux GitHub attestation bundle.
- `scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/windows-amd64.jsonl`: retained Windows GitHub attestation bundle.
- `scripts/release/public-beta-trust/trusted-root.v1.json`: public-good trusted-root snapshot materialized by the admitted OpenOPC Cosign binary.
- `tests/public-beta/cosign-builder-lock.v1.schema.json`: closed builder-lock schema.
- `tests/public-beta/cosign-toolchain.v1.schema.json`: closed toolchain-manifest schema.
- `tests/public-beta/cosign-slsa-predicate.v1.schema.json`: required SLSA predicate fields and exact OpenOPC build type.
- `tests/public-beta/cosign-builder-lock.v1.fixture.json`: deterministic non-production parser fixture.
- `tests/public-beta/cosign-toolchain.v1.fixture.json`: deterministic non-production manifest fixture.
- `tests/public-beta/cosign-slsa-predicate.v1.fixture.json`: deterministic predicate vector.
- `tests/public-beta/sigstore-policy.schema.json`: candidate policy schema with retained direct digests and toolchain reference.
- `package.json`: fixed builder/admission CLI entries only; no new package dependency unless a RED proves the standard runtime insufficient.
- `docs/plans/2026-07-29-openopc-public-beta-sigstore-certification-implementation.md`: replace only the superseded official-binary bootstrap and certifier-install wording.
- `docs/plans/2026-07-30-openopc-restricted-public-beta-implementation.md`: insert this bootstrap before restricted Task 5 and preserve the remaining certification order.
- `.superpowers/sdd/2026-07-30-openopc-restricted-public-beta-implementation/task-5-report.md`: append the approved amendment and new evidence without erasing the original blocker.
- `.superpowers/sdd/2026-07-30-openopc-restricted-public-beta-implementation/progress.md`: record task status and exact remaining external gates.

---

### Task 1: Authenticate the Protected Tool-Builder Run

**Files:**
- Create: `scripts/release/public-beta-github-actions.ts`
- Create: `scripts/release/public-beta-github-actions.test.ts`

**Interfaces:**
- Consumes: GitHub run/artifact JSON through `PublicBetaGitHubActionsClient`; protected expected repository, commit, control SHA, run ID, and validation time.
- Produces: `authenticatePublicBetaSourceRun()`, `authenticatePublicBetaToolBuilderRun()`, `authenticatePublicBetaCertifierRun()`, and immutable authenticated coordinates used by Tasks 5 and the parent certification work.

- [ ] **Step 1: Capture the exact pre-edit boundary**

Run:

```powershell
git status --short
git diff --no-index -- NUL scripts/release/public-beta-github-actions.ts
```

Expected: the status matches the preserved dirty-work ledger; the no-index command reports that the new source does not exist.

- [ ] **Step 2: Write the builder identity RED**

Add tests that exercise exact protected builder claims:

```ts
test('authenticates one completed protected tool-builder run and artifact', async () => {
  const result = await authenticatePublicBetaToolBuilderRun(
    builderInput({
      repository: { full_name: 'openopc/platform', id: 711 },
      path: '.github/workflows/openopc-cosign-builder.yml',
      name: 'OpenOPC Cosign Builder',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
    }),
  );
  expect(result).toMatchObject({
    repository: 'openopc/platform',
    workflow: '.github/workflows/openopc-cosign-builder.yml',
    workflowRef: 'refs/heads/main',
    controlSha: 'a'.repeat(40),
    event: 'workflow_dispatch',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
  });
});

test.each([
  ['fork', { repository: { full_name: 'fork/platform', id: 711 } }],
  ['workflow', { path: '.github/workflows/other.yml' }],
  ['event', { event: 'pull_request_target' }],
  ['branch', { head_branch: 'staging' }],
  ['sha', { head_sha: 'c'.repeat(40) }],
  ['attempt', { run_attempt: 0 }],
  ['conclusion', { conclusion: 'failure' }],
])('rejects tool-builder mutation %s', async (_name, mutation) => {
  expect(await authenticatePublicBetaToolBuilderRun(builderInput(mutation))).toBe(false);
});
```

Retain the parent source/certifier vectors and add zero/two canonical artifact cases for exact artifact name `openopc-cosign-toolchain-v3.1.2.1`.

- [ ] **Step 3: Run the scoped RED**

Run:

```powershell
bun test scripts/release/public-beta-github-actions.test.ts
```

Expected: FAIL because the module and builder authenticator do not exist.

- [ ] **Step 4: Implement closed run and artifact authentication**

Define the client, three authenticated results, and functions exactly. The source
and certifier fields remain the parent Task 4 contract; the builder is additive:

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

export interface PublicBetaAuthenticatedToolBuilderRun {
  repository: 'openopc/platform';
  workflow: '.github/workflows/openopc-cosign-builder.yml';
  workflowRef: 'refs/heads/main';
  controlSha: string;
  runId: string;
  runAttempt: number;
  event: 'workflow_dispatch';
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

export async function authenticatePublicBetaSourceRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: string;
  expectedCommit: string;
  runId: string;
  now: Date;
}): Promise<Readonly<PublicBetaAuthenticatedSourceRun> | false>;

export async function authenticatePublicBetaToolBuilderRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: 'openopc/platform';
  expectedControlSha: string;
  runId: string;
  now: Date;
}): Promise<Readonly<PublicBetaAuthenticatedToolBuilderRun> | false>;

export async function authenticatePublicBetaCertifierRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: string;
  expectedCommit: string;
  expectedControlSha: string;
  runId: string;
  now: Date;
}): Promise<Readonly<PublicBetaAuthenticatedCertifierRun> | false>;
```

Accept only exact repository/path/name/event/main/ref/control SHA, completed success, positive run attempt, ordered timestamps, positive bounded artifact size, canonical digest, matching repository/run/head metadata, and exactly one unexpired canonical artifact. Snapshot every untrusted getter before validation and return frozen plain data.

- [ ] **Step 5: Run GREEN and the archive regression**

Run:

```powershell
bun test scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-archive.test.ts scripts/release/public-beta-safe-files.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-github-actions.ts scripts/release/public-beta-github-actions.test.ts
git diff --check -- scripts/release/public-beta-github-actions.ts scripts/release/public-beta-github-actions.test.ts
```

Expected: all tests and checks pass; no candidate JSON participates in run authentication.

- [ ] **Step 6: Independent Task 1 review**

Review the exact no-index diff for repository case handling, path/name/event distinction, run-attempt replay, artifact ambiguity/expiry, getter exceptions, integer bounds, and immutable outputs. Zero open Critical or Important findings are required.

- [ ] **Step 7: Proposed Task 1 commit boundary**

Do not run without renewed authorization:

```powershell
git add scripts/release/public-beta-github-actions.ts scripts/release/public-beta-github-actions.test.ts
git commit -m "feat(release): authenticate cosign builder runs"
```

---

### Task 2: Define the Builder Lock, Toolchain Manifest, and SLSA Predicate Contracts

**Files:**
- Create: `scripts/release/public-beta-cosign-toolchain.ts`
- Create: `scripts/release/public-beta-cosign-toolchain.test.ts`
- Create: `tests/public-beta/cosign-builder-lock.v1.schema.json`
- Create: `tests/public-beta/cosign-toolchain.v1.schema.json`
- Create: `tests/public-beta/cosign-slsa-predicate.v1.schema.json`
- Create: `tests/public-beta/cosign-builder-lock.v1.fixture.json`
- Create: `tests/public-beta/cosign-toolchain.v1.fixture.json`
- Create: `tests/public-beta/cosign-slsa-predicate.v1.fixture.json`

**Interfaces:**
- Consumes: RFC 8785 helpers from `public-beta-canonical-json.ts` and exact source/identity constants from the approved design.
- Produces: closed lock/manifest parsers, canonical digests, exact platform selection, and predicate validation used by Tasks 3-7.

- [ ] **Step 1: Write exact source and platform-mapping RED tests**

```ts
test('pins the exact upstream source and derives the builder identity', () => {
  const lock = parsePublicBetaCosignBuilderLock(builderLockFixture());
  expect(lock).not.toBe(false);
  expect(lock!.upstream).toEqual({
    repository: 'sigstore/cosign',
    tag: 'v3.1.2',
    tagObjectSha: 'dc80df70da727f4abdd843640594025584a270ae',
    commitSha: '193d2153431f8bb0d945a4c1ee721872f73add67',
    treeSha: '6647db468973d11edb5e737293fcf4b05c69a84a',
    goVersion: '1.26.0',
  });
  expect(canonicalPublicBetaCosignBuilderIdentity()).toBe(
    'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main',
  );
});

test('enforces key-to-name platform mapping', () => {
  const manifest = toolchainFixture();
  manifest.artifacts.linuxAmd64.name = 'cosign-windows-amd64.exe';
  manifest.artifacts.windowsAmd64.name = 'cosign-linux-amd64';
  expect(parsePublicBetaCosignToolchain(manifest)).toBe(false);
});
```

Add table cases for unknown keys, prototypes, symbols, getters, wrong source values, mutable Action tags, non-64-hex image digests, non-40-hex Action commits, zero digests, unsafe bundle paths, wrong release tag, duplicate subject digest, size `0`, size above `268435456`, and non-decimal asset IDs.

- [ ] **Step 2: Run the contract RED**

Run:

```powershell
bun test scripts/release/public-beta-cosign-toolchain.test.ts
```

Expected: FAIL because the contracts and fixtures do not exist.

- [ ] **Step 3: Implement exact closed interfaces**

Define the shared structures and public functions in this task so downstream
tasks do not invent parallel shapes:

```ts
export type PublicBetaCosignPlatform = 'linuxAmd64' | 'windowsAmd64';

export interface PublicBetaCosignBuilderLockV1 {
  schemaVersion: 1;
  toolchainId: 'openopc-cosign-v3.1.2.1';
  upstream: {
    repository: 'sigstore/cosign';
    tag: 'v3.1.2';
    tagObjectSha: 'dc80df70da727f4abdd843640594025584a270ae';
    commitSha: '193d2153431f8bb0d945a4c1ee721872f73add67';
    treeSha: '6647db468973d11edb5e737293fcf4b05c69a84a';
    goVersion: '1.26.0';
  };
  buildImage: {
    reference: 'golang:1.26.0-bookworm';
    digest: PublicBetaSha256Digest;
  };
  actions: {
    checkout: '3d3c42e5aac5ba805825da76410c181273ba90b1';
    uploadArtifact: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
    downloadArtifact: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
    attest: '508db95dd578ae2727ebd6217d5ba78e4fbda05d';
    setupBun: '0c5077e51419868618aeaa5fe8019c62421857d6';
  };
  targets: readonly ['linuxAmd64', 'windowsAmd64'];
}

export interface PublicBetaCosignToolSubjectV1 {
  name: 'cosign-linux-amd64' | 'cosign-windows-amd64.exe';
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  releaseTag: 'openopc-cosign-v3.1.2.1';
  releaseAssetId: string;
  bundlePath: string;
  bundleDigest: PublicBetaSha256Digest;
  predicateType: 'https://slsa.dev/provenance/v1';
}

export interface PublicBetaCosignToolchainV1 {
  schemaVersion: 1;
  toolchainId: 'openopc-cosign-v3.1.2.1';
  upstream: PublicBetaCosignBuilderLockV1['upstream'];
  builder: {
    oidcIssuer: 'https://token.actions.githubusercontent.com';
    repository: 'openopc/platform';
    workflowPath: '.github/workflows/openopc-cosign-builder.yml';
    workflowRef: 'refs/heads/main';
    workflowSha: string;
    certificateIdentity:
      'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main';
    trigger: 'workflow_dispatch';
    buildContainerDigest: PublicBetaSha256Digest;
    buildContractDigest: PublicBetaSha256Digest;
    goModuleGraphDigest: PublicBetaSha256Digest;
  };
  artifacts: {
    linuxAmd64: PublicBetaCosignToolSubjectV1;
    windowsAmd64: PublicBetaCosignToolSubjectV1;
  };
}

export interface PublicBetaCosignPredicateExpectation {
  workflowSha: string;
  platform: PublicBetaCosignPlatform;
  subjectName: PublicBetaCosignToolSubjectV1['name'];
  subjectDigest: PublicBetaSha256Digest;
  subjectSizeBytes: number;
  buildContainerDigest: PublicBetaSha256Digest;
  buildContractDigest: PublicBetaSha256Digest;
  goModuleGraphDigest: PublicBetaSha256Digest;
  replayDigest: PublicBetaSha256Digest;
}

export interface PublicBetaCosignSlsaPredicateV1 {
  buildDefinition: {
    buildType: 'https://openopc.dev/buildtypes/cosign/v1';
    externalParameters: Readonly<Record<string, PublicBetaJson>>;
    internalParameters: Readonly<Record<string, never>>;
    resolvedDependencies: readonly Readonly<{
      uri: string;
      digest: Readonly<Record<string, string>>;
    }>[];
  };
  runDetails: {
    builder: { id: ReturnType<typeof canonicalPublicBetaCosignBuilderIdentity> };
    metadata: { invocationId: string; startedOn: string; finishedOn: string };
  };
}

export function parsePublicBetaCosignBuilderLock(
  value: unknown,
): Readonly<PublicBetaCosignBuilderLockV1> | false;

export function parsePublicBetaCosignToolchain(
  value: unknown,
): Readonly<PublicBetaCosignToolchainV1> | false;

export function computePublicBetaCosignToolchainDigest(
  value: unknown,
): PublicBetaSha256Digest | false;

export function selectPublicBetaCosignToolSubject(
  toolchain: Readonly<PublicBetaCosignToolchainV1>,
  platform: PublicBetaCosignPlatform,
): Readonly<PublicBetaCosignToolSubjectV1>;

export function canonicalPublicBetaCosignBuilderIdentity():
  'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main';

export function parsePublicBetaCosignSlsaPredicate(
  value: unknown,
  expected: Readonly<PublicBetaCosignPredicateExpectation>,
): Readonly<PublicBetaCosignSlsaPredicateV1> | false;
```

Manual runtime parsing and JSON schemas must agree on exact keys, literals, formats, bounds, array order, bundle suffix, platform name, source pins, Action pins, and build type `https://openopc.dev/buildtypes/cosign/v1`. Canonical digest functions operate only on the parsed frozen value.

- [ ] **Step 4: Add deterministic schema/fixture agreement tests**

```ts
test('agrees with closed schemas and deterministic fixture digests', async () => {
  const manifest = await Bun.file('tests/public-beta/cosign-toolchain.v1.fixture.json').json();
  const parsed = parsePublicBetaCosignToolchain(manifest);
  expect(parsed).not.toBe(false);
  expect(computePublicBetaCosignToolchainDigest(parsed)).toBe(
    computeCanonicalPublicBetaDigest(parsed),
  );
  const schema = await Bun.file('tests/public-beta/cosign-toolchain.v1.schema.json').json();
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.toolchainId.const).toBe('openopc-cosign-v3.1.2.1');
});
```

Fixtures use deterministic nonzero synthetic digests and are accepted only when explicitly loaded from the test path; no fixture is copied into `scripts/release/public-beta-trust/`.

- [ ] **Step 5: Run GREEN and canonical JSON regression**

```powershell
bun test scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-canonical-json.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-cosign-toolchain.ts scripts/release/public-beta-cosign-toolchain.test.ts tests/public-beta/cosign-builder-lock.v1.schema.json tests/public-beta/cosign-toolchain.v1.schema.json tests/public-beta/cosign-slsa-predicate.v1.schema.json tests/public-beta/cosign-builder-lock.v1.fixture.json tests/public-beta/cosign-toolchain.v1.fixture.json tests/public-beta/cosign-slsa-predicate.v1.fixture.json
git diff --check -- scripts/release/public-beta-cosign-toolchain.ts scripts/release/public-beta-cosign-toolchain.test.ts tests/public-beta
```

Expected: PASS with one canonical digest per parsed structure and no accessor/prototype escape.

- [ ] **Step 6: Independent Task 2 review**

Review source constants, exact key closure, cross-field mapping, integer bounds, JCS input shape, path policy, digest domains, and the distinction between test fixtures and production trust assets.

- [ ] **Step 7: Proposed Task 2 commit boundary**

Do not run without renewed authorization:

```powershell
git add scripts/release/public-beta-cosign-toolchain.ts scripts/release/public-beta-cosign-toolchain.test.ts tests/public-beta/cosign-builder-lock.v1.schema.json tests/public-beta/cosign-toolchain.v1.schema.json tests/public-beta/cosign-slsa-predicate.v1.schema.json tests/public-beta/cosign-builder-lock.v1.fixture.json tests/public-beta/cosign-toolchain.v1.fixture.json tests/public-beta/cosign-slsa-predicate.v1.fixture.json
git commit -m "feat(release): define cosign toolchain contracts"
```

---

### Task 3: Implement the Deterministic Build Plan and Predicate Generator

**Files:**
- Create: `scripts/release/public-beta-cosign-builder.ts`
- Create: `scripts/release/public-beta-cosign-builder.test.ts`
- Create after real digest resolution: `scripts/release/public-beta-trust/cosign-builder-lock.v1.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PublicBetaCosignBuilderLockV1`, fixed source checkout, fixed output root, authenticated workflow metadata, and a bounded process runner.
- Produces: fixed Docker command plans, primary/replay result descriptors, exact comparison, SLSA predicates, and `public-beta:cosign:build` / `public-beta:cosign:predicate` CLIs.

- [ ] **Step 1: Resolve the immutable build image through two read-only channels**

Run on a host that can reach Docker Hub:

```powershell
$image = 'golang:1.26.0-bookworm'
$inspect = @(docker buildx imagetools inspect $image)
$digestLines = @($inspect | Select-String -Pattern '^Digest:\s+(sha256:[0-9a-f]{64})$')
if ($digestLines.Count -ne 1) { throw 'OPENOPC_COSIGN_BUILD_IMAGE_DIGEST_AMBIGUOUS' }
$digestFromBuildx = [regex]::Match($digestLines[0].Line, 'sha256:[0-9a-f]{64}').Value
if ($digestFromBuildx -cnotmatch '^sha256:[0-9a-f]{64}$') {
  throw 'OPENOPC_COSIGN_BUILD_IMAGE_DIGEST_INVALID'
}
$registryToken = (Invoke-RestMethod -Uri 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/golang:pull').token
$headers = @{
  Authorization = "Bearer $registryToken"
  Accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
}
$response = Invoke-WebRequest -Method Head -Uri 'https://registry-1.docker.io/v2/library/golang/manifests/1.26.0-bookworm' -Headers $headers
$digestFromRegistry = [string]$response.Headers['Docker-Content-Digest']
if ($digestFromRegistry -cne $digestFromBuildx) {
  throw 'OPENOPC_COSIGN_BUILD_IMAGE_DIGEST_DISAGREEMENT'
}
$digestFromBuildx
```

Expected: both channels return one identical digest. If either channel is unavailable or values differ, record the environment blocker and stop; do not create the production lock. Use `apply_patch` to write the returned literal digest into the closed lock document together with the Global Constraints' exact source and Action pins.

- [ ] **Step 2: Re-resolve and freeze Action pins**

For each `actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`, `actions/attest`, and `oven-sh/setup-bun` baseline, resolve the named release tag through the GitHub API and require its peeled commit to equal the Global Constraints value. Any mismatch requires design/plan review before changing the lock or workflow.

- [ ] **Step 3: Write command-plan and replay RED tests**

```ts
test('build phase is immutable and network-disabled', () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput('linuxAmd64'));
  expect(plan.fetch.args).toContain('golang:1.26.0-bookworm@sha256:' + 'a'.repeat(64));
  expect(plan.build.args).toContain('--network');
  expect(plan.build.args).toContain('none');
  expect(plan.build.args.join(' ')).toContain('CGO_ENABLED=0');
  expect(plan.build.args.join(' ')).toContain('GOOS=linux');
  expect(plan.build.args.join(' ')).toContain('GOARCH=amd64');
  expect(plan.build.args.join(' ')).toContain('-trimpath');
  expect(plan.build.args.join(' ')).toContain('-buildid=');
});

test('rejects a replay digest mismatch', () => {
  expect(
    comparePublicBetaCosignBuilds(primaryBuild(), {
      ...replayBuild(),
      digest: `sha256:${'f'.repeat(64)}`,
    }),
  ).toBe(false);
});
```

Add Windows target, dirty source, changed `go.mod`/`go.sum`, unexpected output, excessive size, failed process, timeout, stderr redaction, and commit-derived build date tests.

- [ ] **Step 4: Run the builder RED**

```powershell
bun test scripts/release/public-beta-cosign-builder.test.ts
```

Expected: FAIL because the builder module and package scripts do not exist.

- [ ] **Step 5: Implement fixed command generation and bounded result parsing**

Use no shell-concatenated candidate strings:

```ts
export interface PublicBetaBuilderCommand {
  executable: 'git' | 'docker';
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PublicBetaCosignBuildInput {
  lock: Readonly<PublicBetaCosignBuilderLockV1>;
  platform: PublicBetaCosignPlatform;
  sourceRoot: string;
  moduleCacheRoot: string;
  outputRoot: string;
}

export interface PublicBetaCosignBuildPlan {
  verifySource: readonly PublicBetaBuilderCommand[];
  fetch: PublicBetaBuilderCommand;
  build: PublicBetaBuilderCommand;
  inspect: PublicBetaBuilderCommand;
}

export interface PublicBetaCosignBuildResultV1 {
  platform: PublicBetaCosignPlatform;
  name: PublicBetaCosignToolSubjectV1['name'];
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  buildContractDigest: PublicBetaSha256Digest;
  goModuleGraphDigest: PublicBetaSha256Digest;
  startedAt: string;
  finishedAt: string;
}

export interface PublicBetaCosignComparedBuildV1 extends PublicBetaCosignBuildResultV1 {
  primaryDigest: PublicBetaSha256Digest;
  replayDigest: PublicBetaSha256Digest;
}

export function createPublicBetaCosignBuildPlan(
  input: Readonly<PublicBetaCosignBuildInput>,
): Readonly<PublicBetaCosignBuildPlan>;

export function comparePublicBetaCosignBuilds(
  primary: Readonly<PublicBetaCosignBuildResultV1>,
  replay: Readonly<PublicBetaCosignBuildResultV1>,
): Readonly<PublicBetaCosignComparedBuildV1> | false;
```

The fetch container may populate a dedicated module-cache directory after `go mod verify`. The build container uses the same image digest, read-only source and module cache, a distinct output directory, and `--network none`. It invokes `go build` with fixed argument-array elements and rejects extra files.

- [ ] **Step 6: Write the predicate RED and implementation**

```ts
test('binds upstream source, control revision, build contract, and replay bytes', () => {
  const predicate = createPublicBetaCosignSlsaPredicate(predicateInput());
  expect(predicate.buildDefinition.buildType).toBe(
    'https://openopc.dev/buildtypes/cosign/v1',
  );
  expect(predicate.buildDefinition.resolvedDependencies).toContainEqual({
    uri: 'git+https://github.com/sigstore/cosign@refs/tags/v3.1.2',
    digest: {
      sha1: '193d2153431f8bb0d945a4c1ee721872f73add67',
      gitTree: '6647db468973d11edb5e737293fcf4b05c69a84a',
    },
  });
  expect(predicate.runDetails.builder.id).toBe(canonicalPublicBetaCosignBuilderIdentity());
  expect(predicate.buildDefinition.externalParameters.replayDigest).toBe(
    predicateInput().subject.digest,
  );
});
```

Implement `createPublicBetaCosignSlsaPredicate()` with only parsed/frozen inputs, exact RFC 3339 timestamps, canonical dependency order, protected workflow metadata, module graph digest, image digest, build contract digest, and the compared subject. Validate the generated predicate through `parsePublicBetaCosignSlsaPredicate()` before writing it.

The generator signature is fixed:

```ts
export function createPublicBetaCosignSlsaPredicate(input: Readonly<{
  lock: PublicBetaCosignBuilderLockV1;
  workflowSha: string;
  invocationId: string;
  compared: PublicBetaCosignComparedBuildV1;
}>): Readonly<PublicBetaCosignSlsaPredicateV1> | false;
```

- [ ] **Step 7: Add fixed CLI entries and run GREEN**

Add only:

```json
"public-beta:cosign:build": "bun scripts/release/public-beta-cosign-builder.ts build",
"public-beta:cosign:predicate": "bun scripts/release/public-beta-cosign-builder.ts predicate"
```

Run:

```powershell
bun test scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-cosign-toolchain.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-trust/cosign-builder-lock.v1.json package.json
git diff --check -- scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-trust/cosign-builder-lock.v1.json package.json
```

Expected: unit tests remain offline and never invoke Docker; command snapshots show the exact digest and no mutable build input.

- [ ] **Step 8: Independent Task 3 review**

Review Docker argument separation, fetch/build network boundary, mount modes, source cleanliness, Go flags, reproducibility inputs, output enumeration, predicate trust fields, process bounds, and secret/error redaction.

- [ ] **Step 9: Proposed Task 3 commit boundary**

Do not run without renewed authorization:

```powershell
git add scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-trust/cosign-builder-lock.v1.json package.json
git commit -m "feat(release): add deterministic cosign builder"
```

---

### Task 4: Add the Protected Build, Attestation, Smoke, and Promotion Workflow

**Files:**
- Create: `.github/workflows/openopc-cosign-builder.yml`
- Create: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: `scripts/release/public-beta-cosign-builder.ts`
- Modify: `scripts/release/public-beta-cosign-builder.test.ts`

**Interfaces:**
- Consumes: the protected builder lock and fixed builder/predicate CLIs from Task 3.
- Produces: one workflow with jobs `primary`, `replay`, `compare_attest`, `linux_smoke`, `windows_smoke`, and `promote`; final artifact name `openopc-cosign-toolchain-v3.1.2.1`.

- [ ] **Step 1: Write the workflow security-contract RED**

```ts
test('uses a no-input protected manual trigger and exact job graph', async () => {
  const { source, workflow } = await parseWorkflow('.github/workflows/openopc-cosign-builder.yml');
  expect(workflow.on).toEqual({ workflow_dispatch: null });
  expect(Object.keys(workflow.jobs)).toEqual([
    'primary',
    'replay',
    'compare_attest',
    'linux_smoke',
    'windows_smoke',
    'promote',
  ]);
  expect(source).toContain("github.repository == 'openopc/platform'");
  expect(source).toContain("github.ref == 'refs/heads/main'");
  expect(source).not.toContain('pull_request_target');
});

test('isolates attestation and promotion permissions', async () => {
  const { workflow } = await parseWorkflow('.github/workflows/openopc-cosign-builder.yml');
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.primary.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.replay.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.compare_attest.permissions).toEqual({
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
  });
  expect(workflow.jobs.promote.permissions).toEqual({ actions: 'read', contents: 'write' });
  expect(workflow.jobs.promote.environment).toBe('toolchain-release');
});
```

Add tests for exact Action SHAs, `overwrite: false`, `if-no-files-found: error`, `digest-mismatch: error`, no secrets in build/smoke jobs, both replay comparisons, two `actions/attest` calls with predicate type `https://slsa.dev/provenance/v1`, both bundle outputs, platform-native smoke, no `continue-on-error`, and no release `--clobber`.

- [ ] **Step 2: Run the workflow RED**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts --test-name-pattern "cosign builder"
```

Expected: FAIL because the workflow and parser test file do not exist.

- [ ] **Step 3: Implement the protected workflow skeleton with immutable pins**

The workflow begins exactly with:

```yaml
name: OpenOPC Cosign Builder

on:
  workflow_dispatch:

permissions: {}

env:
  TOOLCHAIN_ID: openopc-cosign-v3.1.2.1
  UPSTREAM_COMMIT: 193d2153431f8bb0d945a4c1ee721872f73add67
  UPSTREAM_TREE: 6647db468973d11edb5e737293fcf4b05c69a84a
  UPSTREAM_TAG_OBJECT: dc80df70da727f4abdd843640594025584a270ae
```

Every job includes the repository/main/workflow-SHA guard. `primary` and `replay` check out protected control source at `${{ github.workflow_sha }}` and upstream source at the full commit with `persist-credentials: false`, provision Bun 1.3.14 with `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`, then invoke the fixed builder CLI into disjoint directories. Both upload exact output directories with `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, `if-no-files-found: error`, `overwrite: false`, and bounded retention.

- [ ] **Step 4: Implement compare and GitHub SLSA attestation**

`compare_attest` downloads primary/replay by exact artifact IDs with `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`, compares both subjects through the protected CLI, writes validated predicates, and calls:

```yaml
- name: Attest Linux Cosign subject
  id: attest-linux
  uses: actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d
  with:
    subject-path: _cosign-compared/cosign-linux-amd64
    predicate-type: https://slsa.dev/provenance/v1
    predicate-path: _cosign-compared/cosign-linux-amd64.predicate.json
    show-summary: false

- name: Attest Windows Cosign subject
  id: attest-windows
  uses: actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d
  with:
    subject-path: _cosign-compared/cosign-windows-amd64.exe
    predicate-type: https://slsa.dev/provenance/v1
    predicate-path: _cosign-compared/cosign-windows-amd64.predicate.json
    show-summary: false
```

Copy each action's `bundle-path` into the exact retained bundle name, build the canonical manifest from actual outputs, reparse it, and upload one final workflow artifact. Do not trust the upload action's archive digest as the binary digest.

- [ ] **Step 5: Implement platform smoke and protected promotion**

Linux smoke runs the compared Linux binary from the protected job after digest verification. Windows smoke downloads the exact final artifact on a Windows runner, checks its manifest/digest, executes `cosign version`, and performs the fixed local sign/verify fixture without remote signing.

`promote` requires both smoke jobs and `toolchain-release`. It redownloads the exact final artifact, reruns manifest/binary/bundle validation, fails if release tag `openopc-cosign-v3.1.2.1` already exists, creates the release, and uploads only the four approved assets plus the manifest. It never uses `--clobber` and never rebuilds or rewrites bytes.

- [ ] **Step 6: Run workflow GREEN and focused regressions**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-cosign-toolchain.test.ts
pnpm.cmd exec biome check --formatter-enabled=false .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
git diff --check -- .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
```

Expected: static contracts pass without dispatching the workflow or invoking Docker locally.

- [ ] **Step 7: Independent Task 4 review**

Review trigger/input closure, repository/ref/SHA guards, checkout refs, all Action pins, permissions, job outputs, artifact IDs, replay equality, attestation subject/predicate bytes, bundle capture, Windows/Linux smoke, environment approval, and no-overwrite promotion.

- [ ] **Step 8: Proposed Task 4 commit boundary**

Do not run without renewed authorization:

```powershell
git add .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
git commit -m "ci(release): add protected cosign builder"
```

---

### Task 5: Run and Admit the Real Protected Toolchain

**Files:**
- Create: `scripts/release/public-beta-cosign-toolchain-admission.ts`
- Create: `scripts/release/public-beta-cosign-toolchain-admission.test.ts`
- Create only from accepted real output: `scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/toolchain.json`
- Create only from accepted real output: `scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/linux-amd64.jsonl`
- Create only from accepted real output: `scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/windows-amd64.jsonl`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PublicBetaAuthenticatedToolBuilderRun`, a raw downloaded final workflow artifact, exact real subjects/bundles, the protected builder lock, GitHub CLI 2.95.0, and protected expected values.
- Produces: `admitPublicBetaCosignToolchain()` plus real protected manifest/bundle files; no binary is written to Git.

- [ ] **Step 1: Write exact verifier-argument and predicate RED tests**

```ts
test('verifies each subject with the exact GitHub identity and control SHA', async () => {
  const paths = admissionFixturePaths();
  const runner = recordingRunner(successfulGhVerification());
  const admitted = await admitPublicBetaCosignToolchain(admissionInput({ paths, runner }));
  expect(admitted).not.toBe(false);
  expect(runner.calls[0].args).toEqual([
    'attestation',
    'verify',
    paths.linuxSubjectPath,
    '--repo',
    'openopc/platform',
    '--bundle',
    paths.linuxBundlePath,
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--cert-identity',
    'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main',
    '--signer-workflow',
    'openopc/platform/.github/workflows/openopc-cosign-builder.yml',
    '--signer-digest',
    'a'.repeat(40),
    '--source-ref',
    'refs/heads/main',
    '--source-digest',
    'a'.repeat(40),
    '--format',
    'json',
  ]);
});

test.each([
  'issuer',
  'certificate-identity',
  'signer-digest',
  'source-digest',
  'predicate-type',
  'upstream-commit',
  'tree',
  'container',
  'subject',
  'replay-digest',
])('rejects verified-output mutation %s', async (mutation) => {
  expect(await admitPublicBetaCosignToolchain(admissionInput({ mutation }))).toBe(false);
});
```

Also cover non-JSON output, zero/two accepted attestations, stderr/exit failure, bundle path escape, bundle digest mismatch, binary truncation, manifest mismatch, output collision, partial write cleanup, and unknown `gh` verification fields.

- [ ] **Step 2: Run the admission RED**

```powershell
bun test scripts/release/public-beta-cosign-toolchain-admission.test.ts
```

Expected: FAIL because the admission module does not exist.

- [ ] **Step 3: Implement authenticated local admission with exclusive output**

Use these exact boundaries:

```ts
export interface PublicBetaAttestationCommandRunner {
  run(input: Readonly<{
    executable: 'gh';
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }>): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

export async function admitPublicBetaCosignToolchain(input: Readonly<{
  authenticatedRun: PublicBetaAuthenticatedToolBuilderRun;
  extractedRoot: string;
  outputRoot: string;
  expectedLock: PublicBetaCosignBuilderLockV1;
  runner: PublicBetaAttestationCommandRunner;
}>): Promise<Readonly<PublicBetaCosignToolchainV1> | false>;
```

Read manifest, binaries, and bundles through bounded same-descriptor helpers. Parse `gh --format json` as untrusted bounded JSON, require at least one exact cryptographically verified result per subject, then enforce the protected SLSA predicate with Task 2. Write a private sibling staging directory under `outputRoot`, use exclusive file creation, re-read every output, and atomically rename it to `cosign-v3.1.2-openopc.1` only when all validations pass. An existing target directory causes failure; cleanup never follows a replacement/reparse point.

- [ ] **Step 4: Add the fixed admission CLI and run unit GREEN**

Add only:

```json
"public-beta:cosign:admit": "bun scripts/release/public-beta-cosign-toolchain-admission.ts"
```

Run:

```powershell
bun test scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-safe-files.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-cosign-toolchain-admission.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts package.json
git diff --check -- scripts/release/public-beta-cosign-toolchain-admission.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts package.json
```

Expected: PASS using only mocked `gh` output and local deterministic fixtures; no production trust file exists yet.

- [ ] **Step 5: Stop for exact remote-operation authorization**

Before any push, environment change, dispatch, or release publication, report:

- branch and exact commit containing the reviewed builder workflow;
- expected canonical repository `openopc/platform`;
- required `main` protection and `toolchain-release` reviewers;
- exact workflow file, source pins, Action pins, build-image digest, and proposed release tag;
- confirmation that the run does not certify a product candidate, deploy, or open registration.

Do not infer authorization from approval of this plan. Continue only after the user explicitly authorizes the named commit/push/dispatch/release scope.

- [ ] **Step 6: Verify canonical GitHub controls before dispatch**

After authorization, require `(gh --version | Select-Object -First 1)` to match
`^gh version 2\.95\.0 ` exactly. Verify through read-only GitHub API calls that
the repository is exactly `openopc/platform`, `main` is protected, the workflow
SHA is the reviewed commit, the environment exists with required reviewers, and
the release tag does not exist. Any mismatch blocks the run.

- [ ] **Step 7: Dispatch and watch one exact protected run**

Run only after the preceding authorization and control checks:

```powershell
$controlSha = gh api repos/openopc/platform/commits/main --jq '.sha'
if ($controlSha -cnotmatch '^[0-9a-f]{40}$') { throw 'OPENOPC_CONTROL_SHA_INVALID' }
$beforeIds = @(
  gh run list --repo openopc/platform --workflow openopc-cosign-builder.yml --branch main --event workflow_dispatch --limit 20 --json databaseId |
    ConvertFrom-Json |
    ForEach-Object { [string]$_.databaseId }
)
$dispatchStarted = [DateTimeOffset]::UtcNow
gh workflow run openopc-cosign-builder.yml --repo openopc/platform --ref main
$newRuns = @()
for ($attempt = 0; $attempt -lt 12 -and $newRuns.Count -eq 0; $attempt += 1) {
  Start-Sleep -Seconds 5
  $runs = @(
    gh run list --repo openopc/platform --workflow openopc-cosign-builder.yml --branch main --event workflow_dispatch --limit 20 --json databaseId,headSha,createdAt,event,workflowName |
      ConvertFrom-Json
  )
  $newRuns = @(
    $runs | Where-Object {
      [string]$_.databaseId -notin $beforeIds -and
      $_.headSha -ceq $controlSha -and
      $_.event -ceq 'workflow_dispatch' -and
      $_.workflowName -ceq 'OpenOPC Cosign Builder' -and
      [DateTimeOffset]$_.createdAt -ge $dispatchStarted.AddSeconds(-5)
    }
  )
}
if ($newRuns.Count -ne 1) { throw 'OPENOPC_COSIGN_BUILDER_RUN_AMBIGUOUS' }
$runId = [string]$newRuns[0].databaseId
if ($runId -notmatch '^[1-9][0-9]{0,19}$') { throw 'OPENOPC_COSIGN_BUILDER_RUN_ID_INVALID' }
gh run watch $runId --repo openopc/platform --exit-status
```

Expected: all six jobs pass, environment approval is non-self under repository policy, and release tag `openopc-cosign-v3.1.2.1` contains the exact promoted assets. A failed or cancelled run remains evidence and is not rerun until its cause is reviewed.

- [ ] **Step 8: Download by authenticated run/artifact ID and admit**

Authenticate the run through Task 1, download the unique raw artifact by its authenticated artifact ID into a private temporary directory, authenticate/extract it through the existing archive boundary, and invoke:

```powershell
pnpm.cmd public-beta:cosign:admit -- --run-id $runId --repository openopc/platform --output-root scripts/release/public-beta-trust
```

Expected: the CLI exits `0`, writes exactly one manifest and two JSONL bundles, and never writes the Linux or Windows binary into Git. Re-run the two exact `gh attestation verify` commands independently against the promoted release bytes and retained bundles.

- [ ] **Step 9: Review real evidence before trust publication**

Two independent reviews compare authenticated run metadata, workflow/ref/SHA, repository/environment controls, primary/replay digests, source constants, container and Action pins, SLSA predicates, subjects, bundle digests, smoke output, release asset IDs, and admitted files. Zero open Critical or Important findings are required.

- [ ] **Step 10: Run production-asset GREEN**

```powershell
bun test scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-workflow-contract.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-trust/cosign-builder-lock.v1.json scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1
git diff --check -- scripts/release/public-beta-trust
```

Expected: all real files parse, cross-bind, and contain no zero/synthetic digest.

- [ ] **Step 11: Proposed Task 5 commit boundary**

Do not run without separate post-review authorization:

```powershell
git add scripts/release/public-beta-cosign-toolchain-admission.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1 package.json
git commit -m "feat(release): admit attested cosign toolchain"
```

---

### Task 6: Execute Only the Digest-Authorized Binary

**Files:**
- Create: `scripts/release/public-beta-cosign.ts`
- Create: `scripts/release/public-beta-cosign.test.ts`
- Create: `scripts/release/public-beta-cosign-windows-launcher.ps1`
- Create: `scripts/release/public-beta-cosign-windows-launcher.test.ts`

**Interfaces:**
- Consumes: authenticated toolchain manifest, protected tool root, exact platform, fixed Cosign argument arrays, timeout/output limits, and a platform process adapter.
- Produces: `runPublicBetaCosign()` returning bounded output or `false`, with no path re-resolution window that permits replacement.

- [ ] **Step 1: Write Linux descriptor and generic adapter RED tests**

```ts
test('authorizes the Linux digest and executes the retained descriptor path', async () => {
  const runner = recordingVerifiedRunner({ exitCode: 0, stdout: 'ok', stderr: '' });
  const result = await runPublicBetaCosign(cosignInput({ platform: 'linuxAmd64', runner }));
  expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
  expect(runner.calls[0].executablePath).toMatch(/^\/proc\/self\/fd\/[3-9][0-9]*$/);
  expect(runner.calls[0].inheritedDescriptor).toBeGreaterThanOrEqual(3);
});

test.each(['wrong-digest', 'wrong-size', 'replaced-path', 'timeout', 'stdout-limit', 'stderr-limit'])
  ('fails closed for %s', async (mutation) => {
    expect(await runPublicBetaCosign(cosignInput({ mutation }))).toBe(false);
  });
```

The runner is mocked for unit tests. Add tests proving arguments are arrays, the environment is allowlisted, input paths come only from the protected manifest, and errors redact tokens/URLs.

- [ ] **Step 2: Write the Windows locked-handle RED**

On Windows, race a replacement attempt after hashing but before process start:

```ts
test.skipIf(process.platform !== 'win32')(
  'holds a non-share-write/delete handle until the verified process exits',
  async () => {
    const attempt = await runWindowsLauncherRaceFixture();
    expect(attempt.digestMatched).toBe(true);
    expect(attempt.replacementSucceededBeforeExit).toBe(false);
    expect(attempt.exitCode).toBe(0);
  },
);
```

Also verify arguments containing spaces, quotes, and shell metacharacters arrive as exact `ProcessStartInfo.ArgumentList` elements rather than a joined command line.

- [ ] **Step 3: Run the process-boundary RED**

```powershell
bun test scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.test.ts
```

Expected: FAIL because the adapter and launcher do not exist.

- [ ] **Step 4: Implement protected selection, acquisition, and Linux execution**

Define:

```ts
export interface PublicBetaCosignRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PublicBetaVerifiedProcessRunner {
  run(input: Readonly<{
    platform: PublicBetaCosignPlatform;
    executablePath: string;
    inheritedDescriptor?: number;
    windowsLauncherPath?: string;
    args: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
    environment: Readonly<Record<string, string>>;
  }>): Promise<Readonly<PublicBetaCosignRunResult> | false>;
}

export interface PublicBetaCosignAssetClient {
  downloadReleaseAsset(input: Readonly<{
    repository: 'openopc/platform';
    releaseTag: 'openopc-cosign-v3.1.2.1';
    assetId: string;
    destinationPath: string;
    maxBytes: number;
  }>): Promise<boolean>;
}

export async function runPublicBetaCosign(input: Readonly<{
  controlRoot: string;
  toolRoot: string;
  manifestPath: string;
  manifestDigest: PublicBetaSha256Digest;
  policyBinaryDigest: PublicBetaSha256Digest;
  platform: PublicBetaCosignPlatform;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  assetClient: PublicBetaCosignAssetClient;
  runner: PublicBetaVerifiedProcessRunner;
}>): Promise<Readonly<PublicBetaCosignRunResult> | false>;
```

Load the manifest from `controlRoot`, require its digest and selected subject to equal the policy's direct binary digest, acquire the release asset by fixed repository/tag/asset ID into a private owned root, and verify size/digest from a retained descriptor. On Linux, pass that descriptor as child fd 3 or higher and construct the executable path as `` `/proc/self/fd/${childFd}` `` while the descriptor remains open. Close it only after child completion and bounded output collection.

- [ ] **Step 5: Implement the Windows locked-handle launcher**

The protected PowerShell script opens the tool with no write/delete sharing, hashes the still-open stream, builds an argument-safe process, and retains the stream until exit:

```powershell
$stream = [IO.File]::Open(
  $ToolPath,
  [IO.FileMode]::Open,
  [IO.FileAccess]::Read,
  [IO.FileShare]::Read
)
try {
  $stream.Position = 0
  $actual = 'sha256:' + [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($stream)
  ).ToLowerInvariant()
  if ($actual -cne $ExpectedDigest) { throw 'PUBLIC_BETA_COSIGN_DIGEST_MISMATCH' }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $ToolPath
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $false
  $start.RedirectStandardError = $false
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'PUBLIC_BETA_COSIGN_START_FAILED' }
  if (-not $process.WaitForExit($TimeoutMs)) {
    $process.Kill($true)
    throw 'PUBLIC_BETA_COSIGN_TIMEOUT'
  }
  exit $process.ExitCode
} finally {
  $stream.Dispose()
}
```

The child inherits the launcher's stdout/stderr handles. The TypeScript parent streams and byte-bounds those inherited handles without accumulating unbounded strings; on timeout or output overflow it terminates the complete PowerShell/Cosign process tree. The final script enforces canonical digest, a positive timeout, an exact JSON argument-array file under the protected invocation root, child termination on its own timeout, and cleanup without following reparse points.

- [ ] **Step 6: Run GREEN and adversarial races**

```powershell
bun test scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.test.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-safe-files-open-guard.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-cosign.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.test.ts
git diff --check -- scripts/release/public-beta-cosign.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.ps1 scripts/release/public-beta-cosign-windows-launcher.test.ts
```

Expected: all tests pass; Windows replacement cannot succeed while the verified child is active, and Linux executes only the inherited descriptor.

- [ ] **Step 7: Independent Task 6 review**

Review download origin, directory ownership, same-file digest/execution binding, Linux fd mapping, Windows share flags, process argument injection, environment inheritance, output/timeout bounds, child termination, cleanup replacement, and redaction.

- [ ] **Step 8: Proposed Task 6 commit boundary**

Do not run without renewed authorization:

```powershell
git add scripts/release/public-beta-cosign.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.ps1 scripts/release/public-beta-cosign-windows-launcher.test.ts
git commit -m "feat(release): execute verified cosign tools"
```

---

### Task 7: Cross-Bind the Toolchain into Candidate Sigstore Policy

**Files:**
- Create: `scripts/release/public-beta-sigstore-policy.ts`
- Create: `scripts/release/public-beta-sigstore-policy.test.ts`
- Create from admitted tool output: `scripts/release/public-beta-trust/trusted-root.v1.json`
- Create: `tests/public-beta/sigstore-policy.schema.json`

**Interfaces:**
- Consumes: authenticated protected control root/repository/workflow SHA, admitted toolchain manifest/digest, direct platform digests, trusted-root snapshot, and validation time.
- Produces: `PublicBetaSigstoreTrustPolicyV1`, policy digest, selected admitted Cosign adapter, and unchanged candidate certificate identity.

- [ ] **Step 1: Write direct/toolchain cross-binding RED tests**

```ts
test('binds direct binary digests to the admitted toolchain subjects', () => {
  const policy = loadPublicBetaSigstoreTrustPolicy(policyInput());
  expect(policy).not.toBe(false);
  expect(policy!.cosignVersion).toBe('v3.1.2');
  expect(policy!.cosignToolchainId).toBe('openopc-cosign-v3.1.2.1');
  expect(policy!.cosignBinaryDigests).toEqual({
    linuxAmd64: policyInput().toolchain.artifacts.linuxAmd64.digest,
    windowsAmd64: policyInput().toolchain.artifacts.windowsAmd64.digest,
  });
  expect(policy!.certificateIdentity).toBe(
    'https://github.com/openopc/platform/.github/workflows/openopc-public-beta-certify.yml@refs/heads/main',
  );
});

test.each(['toolchain-id', 'manifest-digest', 'linux-digest', 'windows-digest'])
  ('rejects policy/toolchain mismatch %s', (mutation) => {
    expect(loadPublicBetaSigstoreTrustPolicy(policyInput({ mutation }))).toBe(false);
  });
```

Retain parent rotation and candidate-override cases. Add Google issuer, builder identity used as certifier identity, mutable root path, wrong root digest, symlink/reparse root, retired policy window, and candidate-selected manifest cases.

- [ ] **Step 2: Run the policy RED**

```powershell
bun test scripts/release/public-beta-sigstore-policy.test.ts
```

Expected: FAIL because the policy and root asset do not exist.

- [ ] **Step 3: Materialize the public-good root using the admitted binary**

After Task 5 admission, invoke the digest-authorized Task 6 adapter with the exact Cosign v3.1.2 command:

```text
trusted-root create --with-default-services --out trusted-root.v1.json
```

Write into a private temporary directory, validate the protobuf JSON structure and service material, compute SHA-256 from the retained descriptor, acquire a second snapshot through an independent admitted invocation, and require byte equality. If public-good root rotation occurs between acquisitions, stop for explicit rotation review rather than selecting one automatically. Add only the reviewed bytes to `scripts/release/public-beta-trust/trusted-root.v1.json`.

- [ ] **Step 4: Implement the additive policy contract**

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
  trustedRootPath: 'scripts/release/public-beta-trust/trusted-root.v1.json';
  trustedRootDigest: PublicBetaSha256Digest;
  cosignVersion: 'v3.1.2';
  cosignToolchainId: 'openopc-cosign-v3.1.2.1';
  cosignToolchainManifestPath:
    'scripts/release/public-beta-trust/cosign-v3.1.2-openopc.1/toolchain.json';
  cosignToolchainManifestDigest: PublicBetaSha256Digest;
  cosignBinaryDigests: {
    linuxAmd64: PublicBetaSha256Digest;
    windowsAmd64: PublicBetaSha256Digest;
  };
}
```

Construct repository/workflow SHA from authenticated protected context. Derive both certificate identities internally. Resolve every trust path under `controlRoot`, read through safe-file helpers, parse closed structures, compute canonical digests, and require direct digests to equal manifest subjects before returning a frozen policy.

- [ ] **Step 5: Run policy GREEN and tool regressions**

```powershell
bun test scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-safe-files.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-sigstore-policy.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-trust/trusted-root.v1.json tests/public-beta/sigstore-policy.schema.json
git diff --check -- scripts/release/public-beta-sigstore-policy.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-trust/trusted-root.v1.json tests/public-beta/sigstore-policy.schema.json
```

Expected: PASS with real nonzero root/tool digests and no network use during unit tests.

- [ ] **Step 6: Independent Task 7 review**

Review candidate-versus-builder identity separation, control-SHA ownership, path containment, root bytes/digest, rotation window, toolchain/direct digest agreement, platform selection, and absence of Google/Winget/checksum fallbacks.

- [ ] **Step 7: Proposed Task 7 commit boundary**

Do not run without renewed authorization:

```powershell
git add scripts/release/public-beta-sigstore-policy.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-trust/trusted-root.v1.json tests/public-beta/sigstore-policy.schema.json
git commit -m "feat(release): bind sigstore policy to toolchain"
```

---

### Task 8: Amend the Parent Plans and Resume Restricted Certification

**Files:**
- Modify: `docs/plans/2026-07-29-openopc-public-beta-sigstore-certification-implementation.md:446-535`
- Modify: `docs/plans/2026-07-29-openopc-public-beta-sigstore-certification-implementation.md:1525-1588`
- Modify: `docs/plans/2026-07-30-openopc-restricted-public-beta-implementation.md:484-550`
- Modify: `.superpowers/sdd/2026-07-30-openopc-restricted-public-beta-implementation/task-5-report.md`
- Modify: `.superpowers/sdd/2026-07-30-openopc-restricted-public-beta-implementation/progress.md`

**Interfaces:**
- Consumes: reviewed source changes and real Task 5 toolchain evidence.
- Produces: one non-contradictory parent-plan amendment and an honest handoff back to restricted certification Task 5 Step 1.

- [ ] **Step 1: Write the exact plan amendment**

Replace only the impossible upstream-binary sentence with the implemented OpenOPC builder sequence. Preserve parent Task 5's candidate trust-policy interface and root requirements, adding the manifest cross-binding fields from Task 7. In parent Task 17, replace “installs verified Cosign v3.1.2” with “acquires and executes the digest-authorized `openopc-cosign-v3.1.2.1` subject through `public-beta-cosign.ts`.”

In the restricted plan, make this plan a completed prerequisite only when Tasks 1-7 and real online acceptance are evidenced. Keep profile ID `openopc-restricted-public-beta-v1`, seven exact certified artifacts, eighteen required Gates, disabled-state assessment, and parent Tasks 6-15 unchanged.

- [ ] **Step 2: Preserve and supersede the historical blocker honestly**

Append to `task-5-report.md`:

- the approved design and plan paths;
- original official asset hashes and `404` evidence as historical facts;
- explicit decision not to use Google identity, Winget, or re-attestation;
- real builder run ID/attempt/control SHA, release tag, subject/bundle/manifest/root digests, and review outcome;
- RED/GREEN commands and exact pass counts;
- confirmation that candidate certification has not yet been claimed complete.

Update the progress ledger from `BLOCKED` to `in progress` only after the real toolchain gate is complete. Task 5 remains incomplete until the existing certification core, seven-artifact binding, disabled assessment, readiness branches, focused suite, and independent certification review pass.

- [ ] **Step 3: Run the complete toolchain source gate**

```powershell
bun test scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.test.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-canonical-json.test.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-safe-files-open-guard.test.ts
pnpm.cmd exec biome check --formatter-enabled=false .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-github-actions.ts scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-cosign-toolchain.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-cosign-toolchain-admission.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.test.ts scripts/release/public-beta-sigstore-policy.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-trust tests/public-beta package.json
git diff --check
```

Expected: all focused tests and formatting checks pass. Record real counts; do not turn a scoped gate into a full certification or release-readiness claim.

- [ ] **Step 4: Run the final independent no-index review**

The reviewer covers:

- exact source/tag/tree and build-image/Action pins;
- deterministic/replay build and source-module boundary;
- GitHub issuer, certificate identity, signer/source digests, predicate, subject, and bundle;
- promotion permissions, environment approval, release overwrite behavior, and asset IDs;
- manifest/schema/canonical digest and platform mapping;
- binary acquisition and Linux/Windows replacement resistance;
- root provenance and candidate-policy cross-binding;
- candidate/build/approval identity separation;
- historical report accuracy and absence of readiness overclaim.

Zero open Critical or Important findings are required before the original restricted Task 5 resumes.

- [ ] **Step 5: Capture the exact handoff boundary**

Record current branch/HEAD, `git status --short`, changed-file allowlist, real toolchain/run/digest evidence, test commands/results, review result, and the next unchecked item: restricted Task 5 Step 1 after the toolchain prerequisite. Explicitly retain the no-Docker-local-test boundary and require its owning task to run a real RED before changing certification code.

- [ ] **Step 6: Proposed documentation commit boundary**

Do not run without renewed authorization:

```powershell
git add docs/plans/2026-07-29-openopc-public-beta-sigstore-certification-implementation.md docs/plans/2026-07-30-openopc-restricted-public-beta-implementation.md .superpowers/sdd/2026-07-30-openopc-restricted-public-beta-implementation/task-5-report.md .superpowers/sdd/2026-07-30-openopc-restricted-public-beta-implementation/progress.md
git commit -m "docs(release): adopt attested cosign builder"
```

Do not stage this implementation plan, the approved design, or any other existing untracked file unless the user separately includes it in the authorized commit scope.

---

## Completion Boundary

This plan is complete only when Tasks 1-8 have auditable evidence, the real protected builder run and release have passed, the admitted manifests/bundles/root are review-clean, and the parent plans/ledger accurately hand control back to restricted certification Task 5. Completion of this plan does not certify a public-beta candidate, approve production, deploy, open registration, or change overall status from `not_ready`.
