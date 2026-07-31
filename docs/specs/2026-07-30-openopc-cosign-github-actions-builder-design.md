# OpenOPC Cosign GitHub Actions Builder Design

> Repository identity correction: the production identity in this document is
> superseded by
> `docs/specs/2026-07-31-openopc-canonical-repository-identity-migration-design.md`.
> Use `maheshenga/openopc`; do not use `openopc/platform` for any live trust
> decision.

- **Date:** 2026-07-30
- **Status:** Approved design; implementation and live acceptance pending
- **Toolchain ID:** `openopc-cosign-v3.1.2.1`
- **Canonical builder repository:** `openopc/platform`
- **Scope:** Cosign tool bootstrap for restricted public-beta certification
- **Base compatibility:** Additive release tooling; candidate certification identity is unchanged

## 1. Decision

OpenOPC will not bootstrap its public-beta certifier with the upstream Cosign
v3.1.2 release binaries. Those exact release bytes have official checksums and
Sigstore Bundle v0.3 signatures, but they do not have GitHub SLSA artifact
attestations under `sigstore/cosign`. Their release certificates use a Google
issuer and service-account identity, which cannot satisfy the approved GitHub
Actions identity policy.

Instead, a protected OpenOPC GitHub Actions workflow will build the required
Linux and Windows Cosign binaries from the exact upstream v3.1.2 source commit.
It will issue GitHub artifact attestations with SLSA Provenance v1 predicates for
the exact output bytes. The resulting binaries are OpenOPC toolchain artifacts,
not official upstream release binaries, and are named and governed accordingly.

This decision changes only the Cosign executable bootstrap path. Candidate
signing continues to use the separate protected
`.github/workflows/openopc-public-beta-certify.yml` identity, and candidate
verification continues to require the existing platform-owned Sigstore policy,
Fulcio/Rekor evidence, Bundle v0.3 cross-binding, and exact release digests.

## 2. Verified Upstream Source

The builder pins these exact upstream values:

| Field | Required value |
| --- | --- |
| Repository | `sigstore/cosign` |
| Tag | `v3.1.2` |
| Annotated tag object | `dc80df70da727f4abdd843640594025584a270ae` |
| Commit | `193d2153431f8bb0d945a4c1ee721872f73add67` |
| Git tree | `6647db468973d11edb5e737293fcf4b05c69a84a` |
| Go directive | `1.26.0` |

The tag signature was reported as valid by the GitHub API on 2026-07-30. That
observation is supporting evidence only. The full commit and tree identifiers
are the authoritative source selection. The workflow fails if the tag no longer
resolves through the pinned tag object to the pinned commit.

## 3. Goals

1. Give the Cosign bootstrap binaries an exact, truthful GitHub Actions
   certificate identity owned by OpenOPC.
2. Bind each binary to the protected builder revision, exact upstream source,
   deterministic build contract, dependency graph, and output digest.
3. Prevent candidate content, dispatch input, a mutable tag, or an arbitrary URL
   from selecting any toolchain trust value.
4. Require byte-identical replay builds before a binary can be promoted.
5. Preserve offline, digest-pinned certification after the one required online
   builder and attestation sequence.
6. Keep toolchain provenance separate from candidate provenance so neither
   identity can satisfy the other's policy.
7. Fail closed without falling back to the upstream Google identity, Winget,
   checksum-only verification, or locally fabricated provenance.

## 4. Non-Goals

- Claiming that OpenOPC-built binaries are official Sigstore release binaries.
- Reproducing the byte digests of the official Cosign v3.1.2 release assets.
- Trusting the local repository's current `kortix-ai/suna` remote as the
  production builder identity.
- Replacing candidate DSSE, Sigstore Bundle, release-root, G3, approval, or
  readiness contracts.
- Allowing the tool builder to certify a public-beta candidate.
- Adding PIV, PKCS#11, KMS, or other hardware-key features that the protected
  keyless public-beta certifier does not use.
- Claiming a numbered SLSA build level before the implemented workflow and real
  provenance have been independently evaluated against that level.
- Treating a focused fixture or checksum comparison as live release evidence.

## 5. Identity and Trust Boundaries

Three identities remain independent:

1. **Tool builder:**
   `https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main`
2. **Candidate certifier:**
   `https://github.com/openopc/platform/.github/workflows/openopc-public-beta-certify.yml@refs/heads/main`
3. **Production approval:** the protected approval workflow and non-self
   environment reviewer already required by the certification design.

The tool builder certificate issuer is exactly
`https://token.actions.githubusercontent.com`. A valid candidate-certifier
certificate cannot authorize a tool binary, and a valid tool-builder certificate
cannot authorize candidate provenance. Repository, workflow path, workflow ref,
workflow SHA, source commit, event, subject name, and subject digest are exact
matches rather than regular expressions.

The protected control revision owns the expected toolchain ID, manifest path,
manifest digest, builder identity, release tag, asset identifiers, and retained
attestation bundle paths. Candidate archives may contain none of these values as
authoritative inputs.

## 6. Deterministic Build Contract

The protected workflow builds only `./cmd/cosign` for `linux/amd64` and
`windows/amd64`. Both builds use:

- Go `1.26.0` with `GOTOOLCHAIN=local`;
- `CGO_ENABLED=0`;
- `GOFLAGS=-mod=readonly`;
- a clean checkout of commit
  `193d2153431f8bb0d945a4c1ee721872f73add67`;
- `go mod verify` before compilation;
- `-trimpath` and an empty Go build ID;
- `gitVersion=v3.1.2`, the exact commit, and `gitTreeState=clean`;
- `SOURCE_DATE_EPOCH` and `buildDate` derived from the pinned commit timestamp;
- an immutable build-container image selected by full image digest;
- a canonical Go module graph whose SHA-256 is recorded in provenance.

The build-container digest and every GitHub Action revision are constants in the
protected workflow and are recorded in the build contract. A mutable container
tag or partial Action revision is invalid even when the resulting bytes happen
to match a previously accepted digest.

Two isolated jobs build both targets from fresh workspaces using the same
contract. A comparison job accepts a target only when the primary and replay
SHA-256 values and sizes are identical. The primary Windows binary is then
executed by a Windows smoke job after its digest is checked. The smoke contract
requires the exact version and commit from `cosign version` plus a known
sign/verify fixture using only the public-good test boundary.

## 7. Workflow Architecture

### 7.1 Trigger and permissions

`.github/workflows/openopc-cosign-builder.yml` is available only from
`refs/heads/main` through `workflow_dispatch`. It has no caller-controlled
version, repository, ref, URL, build command, runner, container, or output name.
The workflow rejects any repository other than `openopc/platform` and verifies
that its authenticated workflow revision belongs to protected `main`.

Permissions are job-scoped:

- source and replay build jobs: `contents: read`;
- the primary attestation job: `contents: read`, `id-token: write`, and
  `attestations: write`;
- smoke jobs: `contents: read` only;
- promotion job: `actions: read` and `contents: write` only after the protected
  `toolchain-release` environment approves the exact compared outputs.

No build or smoke job receives repository secrets. The promotion job cannot
change bytes; it may publish only the previously compared and attested subjects.

### 7.2 Source acquisition

The workflow checks out `sigstore/cosign` by the full commit SHA with persisted
credentials disabled. It verifies the commit, tree, tag object, tag-to-commit
mapping, clean worktree, `go.mod` Go directive, and `go.sum` before dependency
download or compilation. A moved tag, changed tree, dirty module files, or
module-verification failure stops all downstream jobs.

### 7.3 Provenance generation

Protected code constructs a canonical SLSA Provenance v1 predicate for each
subject. The predicate contains at least:

- the OpenOPC builder repository, workflow path, ref, and control SHA;
- the upstream Cosign repository, tag object, commit, and tree as resolved
  dependencies;
- the exact Go version, module-graph digest, build-container digest, target, and
  normalized build arguments as external parameters;
- the primary and replay build digests;
- the exact promoted subject name, size, and SHA-256 digest.

The official GitHub attestation action, pinned by full commit SHA, signs the
predicate using the workflow's GitHub OIDC identity and publishes the artifact
attestation. A separate unsigned JSON file cannot substitute for a missing
`https://slsa.dev/provenance/v1` predicate.

This is a protected, self-hosted build definition. It does not claim a numbered
SLSA level merely because the predicate type is SLSA Provenance v1.

### 7.4 Promotion and retention

After comparison, attestation, Linux smoke, Windows smoke, and environment
approval, the promotion job publishes these exact assets under the dedicated
platform release tag `openopc-cosign-v3.1.2.1`:

- `cosign-linux-amd64`;
- `cosign-windows-amd64.exe`;
- one GitHub artifact-attestation bundle for each binary;
- one canonical toolchain manifest.

The release process has no overwrite path. The protected manifest still treats
the subject digest, size, release asset ID, and bundle digest as authoritative;
deletion or replacement therefore causes an availability failure rather than
silent substitution. The small attestation bundles and final manifest are also
retained under `scripts/release/public-beta-trust/` for offline validation. The
large binaries are not committed to Git.

## 8. Toolchain Manifest Contract

The implementation introduces a toolchain contract separate from candidate
Sigstore policy:

```ts
export interface PublicBetaCosignToolchainV1 {
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
  builder: {
    oidcIssuer: 'https://token.actions.githubusercontent.com';
    repository: 'openopc/platform';
    workflowPath: '.github/workflows/openopc-cosign-builder.yml';
    workflowRef: 'refs/heads/main';
    workflowSha: string;
    certificateIdentity: string;
    trigger: 'workflow_dispatch';
    buildContainerDigest: `sha256:${string}`;
    buildContractDigest: `sha256:${string}`;
    goModuleGraphDigest: `sha256:${string}`;
  };
  artifacts: {
    linuxAmd64: PublicBetaCosignToolSubjectV1;
    windowsAmd64: PublicBetaCosignToolSubjectV1;
  };
}

export interface PublicBetaCosignToolSubjectV1 {
  name: 'cosign-linux-amd64' | 'cosign-windows-amd64.exe';
  digest: `sha256:${string}`;
  sizeBytes: number;
  releaseTag: 'openopc-cosign-v3.1.2.1';
  releaseAssetId: string;
  bundlePath: string;
  bundleDigest: `sha256:${string}`;
  predicateType: 'https://slsa.dev/provenance/v1';
}
```

The parser enforces the key-to-name mapping: `linuxAmd64.name` is exactly
`cosign-linux-amd64`, and `windowsAmd64.name` is exactly
`cosign-windows-amd64.exe`. The union type alone is not treated as sufficient
cross-field validation.

Component ownership is intentionally narrow:

- `scripts/release/public-beta-cosign-toolchain.ts` parses, canonicalizes, and
  authenticates the platform-owned manifest and retained bundles;
- `scripts/release/public-beta-cosign.ts` performs bounded binary acquisition,
  same-descriptor digest authorization, offline bundle revalidation, and process
  invocation;
- `scripts/release/public-beta-sigstore-policy.ts` binds the admitted toolchain
  to the otherwise unchanged candidate-signing policy;
- `.github/workflows/openopc-cosign-builder.yml` owns source selection, build,
  replay comparison, attestation, smoke, and protected promotion.

Candidate parsing, candidate provenance, and readiness evaluation do not acquire
or select tools directly. They depend only on the authenticated adapter exposed
by `public-beta-cosign.ts`.

`workflowSha`, Action pins, container digest, output digests, sizes, asset IDs,
and bundle digests are generated only by the real protected builder sequence and
then admitted through a reviewed protected-control change. The schema requires
concrete values; placeholder or all-zero digests are invalid.

The existing candidate trust policy retains its exact `cosignVersion` and
`cosignBinaryDigests` fields and adds an exact `toolchainId`, protected manifest
path, and canonical manifest digest. The policy loader requires its direct
binary digests to equal the corresponding manifest subject digests. It also
retains the candidate certifier issuer, identity, workflow, ref, SHA, trigger,
and trusted-root policy unchanged.

## 9. Admission and Certifier Consumption

Toolchain admission is a one-time protected control operation:

1. Authenticate the builder run and its repository, event, ref, workflow SHA,
   successful conclusion, and run attempt through GitHub run metadata.
2. Download the unique manifest, subjects, and bundles using authenticated asset
   coordinates rather than a candidate-provided URL.
3. Verify bounded file size and SHA-256 from one retained descriptor lifetime.
4. Require at least one exact GitHub attestation match for each subject with the
   accepted issuer, certificate identity, workflow claims, SLSA predicate type,
   upstream source material, build contract, subject name, and subject digest.
5. Compare primary and replay build digests and validate Linux and Windows smoke
   results.
6. Persist only the reviewed manifest and offline bundles in protected control
   source; retain the binaries as release assets.

At certification runtime, protected code loads the manifest only from the
authenticated control SHA. It constructs the release-asset API coordinate from
the fixed repository, release tag, and asset ID, enforces a bounded download,
and computes the binary digest from the same descriptor that will be executed.
Digest equality is the execution authorization boundary. The retained
attestation is then revalidated offline before the binary performs candidate
signing or verification.

No candidate field can change the platform, executable path, download location,
manifest, identity, trust root, attestation bundle, or expected digest.

## 10. Failure Semantics

The builder, admission loader, and certifier fail closed for:

- wrong repository, issuer, identity, workflow, ref, SHA, event, or run attempt;
- tag, commit, tree, Go version, module graph, container, or build-contract
  mismatch;
- missing, duplicate, renamed, oversized, truncated, or extra platform subject;
- primary/replay digest disagreement;
- wrong subject name, digest, size, predicate type, or resolved dependency;
- malformed, missing, online-only, or digest-mismatched attestation bundle;
- release asset deletion, replacement, ID mismatch, or download truncation;
- Windows or Linux smoke failure;
- unknown fields, non-canonical encodings, placeholder digests, or candidate
  ownership of any toolchain trust field;
- network, GitHub API, attestation service, or verifier failure.

There is no warning-only success state. A failed toolchain check prevents Cosign
execution and keeps the public-beta candidate `not_ready`. The implementation
may expose stable diagnostic reason codes, but it must not expose URLs carrying
credentials, OIDC tokens, certificates with unnecessary personal data, or raw
provider responses.

## 11. Testing and Evidence

Implementation follows auditable RED -> minimal GREEN -> focused regression ->
independent review.

### 11.1 Deterministic unit and mutation tests

Tests cover schema closure, canonical digest computation, exact source constants,
identity derivation, build-contract parsing, primary/replay equality, artifact
completeness, bundle cross-binding, bounded same-descriptor reads, and stable
failure results. Mutation tests independently change issuer, repository,
workflow, ref, SHA, event, source commit, tree, Go version, module graph,
container digest, build arguments, subject, size, digest, bundle, release asset,
and platform completeness.

Fixtures with the upstream Google issuer, official release binary digests,
ordinary checksum files, or candidate-selected manifest bodies must fail.

### 11.2 Workflow contract tests

Static workflow tests require:

- only the approved manual trigger and protected-main guard;
- no caller-selected source or build parameters;
- full SHA pins for every Action and full digest pin for the build container;
- minimal job permissions and no secrets in build/smoke jobs;
- two clean builds per target and exact digest comparison;
- SLSA v1 predicates containing the pinned upstream source;
- separate Linux and Windows execution smoke;
- promotion only after protected environment approval;
- no execution of candidate content and no fallback download channel.

### 11.3 Real online acceptance

Before Task 5 can become GREEN, an explicitly authorized protected run must
produce the two real subjects and attestations. Independent verification must
confirm the authenticated run, exact provenance claims, replay equality, smoke
results, release assets, retained bundles, and final manifest. A fixture-only
pass cannot replace this sequence.

The online run does not open registration, certify a product candidate, deploy,
or approve production. Those remain later, separately authorized operations.

## 12. Plan Integration and Ordering

The approved public-beta plans are amended as follows after this written design
is reviewed:

1. Add a bounded toolchain-bootstrap task before the current restricted
   certification Task 5 implementation.
2. Replace the parent Sigstore Task 5 instruction to verify official Cosign
   release binaries with the protected builder, replay, attestation, promotion,
   and admission sequence defined here.
3. Add the separate toolchain manifest loader and tests to restricted Task 5.
4. Permit only this builder workflow to precede the certification-core review;
   candidate Gates, Certifier, and Approval workflows remain in their existing
   later task and may not start early.
5. Preserve the complete eleven-artifact registries while the restricted
   certified path continues to use the protected literal seven-artifact profile.
6. Keep the one real online candidate signing/verification sequence as a launch
   requirement and the mature offline rotation matrix as post-beta work.

The prior Task 5 report remains historically accurate: official upstream GitHub
attestations were unavailable and implementation correctly stopped. A new report
records this explicit design amendment and the later RED/GREEN evidence rather
than rewriting the blocker as if it never occurred.

## 13. Acceptance Criteria

This design is satisfied only when all of the following are true:

1. The canonical OpenOPC repository and protected environment exist with the
   expected branch and reviewer controls.
2. The workflow builds only the pinned source and exact two platform subjects.
3. Primary and replay builds are byte-identical for each subject.
4. GitHub artifact attestations contain SLSA v1 predicates with the exact
   builder identity, upstream source, build contract, and subject digests.
5. Linux and Windows smoke checks pass on the compared bytes.
6. The promoted release assets, retained bundles, and protected manifest
   cross-bind by digest and authenticated asset ID.
7. The loader rejects every defined identity, source, build, artifact, bundle,
   and ownership mutation.
8. The candidate certifier continues to accept only its own protected GitHub
   Actions identity and the same candidate/profile digest graph.
9. No fallback trust channel or numbered SLSA claim is introduced.
10. Independent review reports zero open Critical or Important findings.

Until the real builder run, admission, tests, and review pass, Task 5 remains
blocked and the restricted public beta remains `not_ready`.

## 14. Repository and Operational Boundary

This design authorizes documentation and later scoped implementation planning.
It does not authorize Git staging, commit, push, workflow dispatch, release
publication, deployment, registration changes, or production approval. Existing
dirty and untracked work, archive/safe-file security boundaries, and protected
files remain preserved. Every external operation requires its own explicit
authorization at the point it is performed.
