# OpenOPC Public-Beta Sigstore Certification Design

- **Date:** 2026-07-29
- **Status:** Approved design; implementation and live acceptance pending
- **Approved:** 2026-07-29
- **Target:** Cryptographically certified public-beta release candidates
- **Scope:** Public-beta Gates, certification, approval, and release validation
- **Base compatibility:** Additive OpenOPC release tooling; Kortix core remains unchanged

## 1. Decision

OpenOPC public-beta release candidates use GitHub Actions keyless Sigstore
signing. A protected certification workflow on the default `main` branch is the
only public-beta workload allowed to obtain an OIDC token for candidate
certification. It signs canonical DSSE pre-authentication-encoding bytes, retains
standard Sigstore Bundle v0.3 verification material, and produces an overall
release-root provenance record. Other existing Kortix workflows keep their
separate identities and cannot satisfy this public-beta policy.

The staging Gates workflow is a producer, not a trust root. It builds artifacts,
runs Gates, and emits raw evidence without signing authority. A candidate is not
eligible for human approval until the protected certifier has independently
authenticated the source run and candidate archive, recomputed all relevant
digests, and produced a certified bundle.

This design deliberately does not reuse `deploy-dev.yml` as the public-beta
producer. That workflow signs only a subset of the existing Kortix development
surface and remains independently upgradeable with the upstream base.

This document defines the target contract. Its approval does not assert that the
current repository, GitHub configuration, or deployment already satisfies it.

## 2. Goals

1. Authenticate every canonical public-beta artifact, its CycloneDX SBOM, its
   SLSA v1 provenance, and the complete release candidate.
2. Prove that signing authority came from a protected OpenOPC workflow rather
   than from candidate-controlled staging code or a fork.
3. Verify Fulcio certificate chains, GitHub OIDC identity, SCT evidence, Rekor
   inclusion evidence, and checkpoint trust without requiring a live Rekor query.
4. Bind source run, certifier run, commit, artifact archive, evidence ledger,
   artifact set, rollback target, policy versions, and regional evidence without
   circular digests.
5. Preserve the CLI's fail-closed `ready` / `not_ready` contract and stable exit
   codes.
6. Keep the implementation isolated in public-beta release tooling, workflows,
   fixtures, schemas, and runbooks so Kortix upgrades remain absorbable.
7. Provide deterministic unit, mutation, adapter, CLI, workflow-contract, and
   live staging evidence before public-beta activation.

## 3. Non-goals

- Replacing the separate enterprise KMS, Cosign public-key, or TUF release path.
- Replacing Developer Center module signatures or internal module trust evidence.
- Using the staging Gates workflow, a candidate manifest, or an evidence ledger
  as a platform trust root.
- Introducing a long-lived public-beta private key.
- Making an online Rekor lookup the only evidence of transparency-log inclusion.
- Retrofitting `deploy-dev.yml` to build or attest all eleven public-beta roles.
- Executing candidate-provided scripts, binaries, package hooks, or workflow code
  in the privileged certifier or approval context.
- Claiming public-beta readiness from fixture-only or focused unit-test evidence.

## 4. Threat Model

The design assumes an attacker may control the staging branch, a fork, candidate
workflow code, candidate files, JSON values, archive entry names, evidence paths,
artifact order, and any trust metadata stored inside the candidate. The attacker
may replay an old run, duplicate records, swap two valid files, exploit path
traversal or reparse points, race path reads, submit malformed encodings, cause a
tool timeout, or provide a syntactically valid Sigstore bundle issued to another
repository or workflow.

The design also assumes that a candidate artifact can be hidden or omitted.
Signatures prove integrity and identity, not completeness. Completeness remains a
strict manifest, ledger, and Gate invariant; missing evidence fails closed.

The trusted computing base is limited to:

1. GitHub's authenticated run and artifact metadata APIs.
2. The protected default branch and environment configuration.
3. The protected certifier and approval workflow revisions selected by their
   authenticated runs.
4. The checksum-pinned Cosign executable.
5. The repository-pinned Sigstore trusted-root snapshot and its expected digest.
6. The release validator code checked out from the authenticated protected
   control revision.

## 5. Workflow Architecture

### 5.1 Staging Gates producer

`.github/workflows/openopc-public-beta-gates.yml` runs against the candidate
commit on the `staging` branch. It performs builds, scans, real Gate checks, and
evidence capture. It has no `id-token: write` permission and no release signing
credentials.

The source run emits one bounded `openopc-public-beta-source-candidate` archive
containing:

- all eleven content-addressed artifact references or local bundles;
- CycloneDX SBOMs;
- raw Gate evidence and a source evidence index;
- a provisional Evidence Ledger v2 containing source-owned Gate records but no
  authoritative passed G3 certification record;
- a source candidate descriptor containing the intended candidate identity,
  rollback target, policy versions, regional evidence, and artifact/SBOM
  locators.

This provisional material is not accepted by the readiness CLI and cannot be
submitted for human approval. Only the certifier can create the final manifest,
authoritative G3 record, and certification object required by readiness.

The source workflow must not call the certifier through a candidate-controlled
script. It merely completes and exposes immutable run and artifact metadata.

### 5.2 Protected certifier

`.github/workflows/openopc-public-beta-certify.yml` is defined on the default
branch and triggered by `workflow_run` only after the named Gates workflow
completes. It rejects runs that do not match the canonical repository, workflow
path and name, `workflow_dispatch` source event, `staging` head branch, full
candidate commit, completed state, successful conclusion, and positive run
attempt.

The certifier has two job-level permission boundaries:

1. `authenticate` has only `contents: read` and `actions: read`. It authenticates
   the source run and unique source archive.
2. `certify` receives the authenticated immutable coordinates. It has
   `id-token: write` in addition to read permissions and is the only job allowed
   to invoke keyless signing.

The certifier checks out its own authenticated protected workflow SHA. It never
checks out or executes the candidate commit. Candidate files are parsed only as
untrusted data by the protected validator.

The source archive is downloaded as raw ZIP bytes through the GitHub API. Before
extraction, its byte length and SHA-256 are checked against authenticated GitHub
artifact metadata. Warning-only output from an extraction action is not accepted
as archive authentication. Extraction enforces entry count, expanded-size,
compression-ratio, path, file-type, duplicate-name, case-collision, symlink,
junction, and reparse-point limits.

The certifier recomputes artifact, SBOM, evidence, and manifest digests. It emits
per-artifact DSSE statements and Sigstore Bundle sidecars, creates the
authoritative passed G3 record owned by the certifier run, finalizes the Artifact
Manifest v2 and Evidence Ledger v2, creates Release Manifest v2 and release-root
provenance, and uploads one bounded
`openopc-public-beta-certified-candidate` archive. The G3 record binds the source
run and source evidence index, but its workflow owner and timestamps are the
certifier that performed final verification and signing.

### 5.3 Protected approval

`.github/workflows/openopc-public-beta-approval.yml` accepts an exact
`certifier_run_id` and `expected_commit`. Its validation job authenticates the
certifier run, its protected control SHA, its unique certified archive, and the
source run recorded by certification. It downloads and verifies raw archive
bytes before extraction, then invokes the release CLI from the authenticated
protected control revision.

Before environment approval, the CLI must return exit code `2` with exactly
`PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`. Any second reason blocks entry into the
production approval job.

The approval job uses the protected `production` environment, required reviewers,
prevent-self-review, protected deployment branches, and disabled administrator
bypass. It reauthenticates the same source run, certifier run, and certified
archive, resolves the actual non-dispatching reviewer from environment review
history, writes the approval object, and reruns the validator. Only exit code `0`
with `status: ready` permits retention of the approved release evidence.

## 6. Platform-Owned Trust Policy

The trust policy is constructed by protected control code. Candidate content may
record its identifier and digest for observability, but cannot choose or expand
the policy.

The effective policy contains:

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
  trustedRootDigest: `sha256:${string}`;
  cosignVersion: 'v3.1.2';
  cosignBinaryDigests: {
    linuxAmd64: `sha256:${string}`;
    windowsAmd64: `sha256:${string}`;
  };
}
```

`repository` and `workflowSha` are derived from the authenticated certifier run,
not from candidate JSON. `certificateIdentity` is the exact URI for the canonical
repository, certifier workflow path, and `refs/heads/main`; it is never a regular
expression. The policy also requires exact GitHub certificate extension claims
for repository, workflow ref, workflow SHA, and event. Both platform binary
digests are part of the same policy; each workflow selects only the entry for its
authenticated runner platform.

The trusted-root snapshot contains the accepted Fulcio, certificate transparency
log, and Rekor trust material. Its path is resolved under a protected repository
directory and its digest is fixed by protected policy. A candidate-provided root,
Rekor URL, certificate, public key, checkpoint root, or log ID is never trusted.

Root rotation is an explicit protected policy revision with a new policy ID and
trusted-root snapshot digest. Protected control code may retain the prior policy
for candidates certified before a fixed cutoff, but a candidate cannot select
which version applies. Rotation tests must prove cutoff enforcement and that
unknown or retired policy/root combinations fail closed.

## 7. Artifact Manifest v2

Because the project is not yet live, the implementation replaces the unpublished
v1 parser rather than maintaining a dual compatibility path.

```ts
export interface PublicBetaArtifactManifestEntryV2 {
  name: PublicBetaArtifactName;
  digest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  provenanceDigest: `sha256:${string}`;
  provenanceBundleDigest: `sha256:${string}`;
  mediaType: string;
}

export interface PublicBetaArtifactManifestV2 {
  schemaVersion: 2;
  commit: string;
  artifacts: PublicBetaArtifactManifestEntryV2[];
  manifestDigest: `sha256:${string}`;
}
```

The manifest contains exactly the eleven canonical roles. Artifact, SBOM, DSSE,
and bundle digests are unique in their respective columns. Entries are sorted by
the canonical role order before digest computation. Every OCI locator is digest
pinned to the role's fixed repository; every local bundle uses the role's fixed
media type and suffix.

`provenanceDigest` identifies the canonical DSSE envelope. The corresponding
`provenanceBundleDigest` identifies the standard
`application/vnd.dev.sigstore.bundle.v0.3+json` sidecar. Both must occur exactly
once in the same passed G3 evidence record and must be listed as raw evidence.

## 8. Per-Artifact Provenance

Each artifact has one canonical SLSA provenance v1 statement. It binds:

- artifact role, digest, and media type;
- candidate commit and canonical source repository;
- CycloneDX SBOM digest;
- authenticated source run ID, attempt, timestamps, workflow, and archive digest;
- protected certifier builder identity, run ID, attempt, control SHA, and
  timestamps;
- the source evidence index digest.

The statement is encoded as the DSSE payload. The certifier reconstructs the
standard DSSE pre-authentication encoding (PAE), then uses keyless Cosign blob
signing over those exact PAE bytes. The Sigstore Bundle uses `messageSignature`
content whose message digest equals `sha256(PAE)`. The resulting signature bytes
are copied into the one-signature DSSE envelope.

The DSSE `keyid` is the lowercase SHA-256 fingerprint of the Fulcio leaf
certificate SPKI, prefixed with `sha256:`. Verification recomputes that value from
the bundle certificate and requires an exact match.

Verification succeeds only when all of these are true:

1. The ledger locates one DSSE and one bundle for the artifact.
2. Both files pass same-file-descriptor type, size, digest, UTF-8, and JSON checks.
3. Bundle message digest equals `sha256(PAE)`.
4. Bundle signature bytes equal the DSSE signature bytes.
5. DSSE key ID equals the verified certificate SPKI fingerprint.
6. Cosign validates signature, Fulcio chain, issuer, exact identity, GitHub
   claims, SCT, Rekor signed entry timestamp, inclusion proof, checkpoint, and
   trusted log identity using the pinned root.
7. The TypeScript semantic verifier validates every SLSA field against trusted
   source, certifier, artifact, SBOM, commit, and evidence coordinates.

No field read from the ledger can relax the expected repository, certifier
workflow, ref, SHA, event, issuer, or trust root.

## 9. Release Manifest v2 and Digest Model

Release Manifest v2 adds `certification` and strengthens approval binding:

```ts
export interface PublicBetaReleaseCertificationV1 {
  schemaVersion: 1;
  sourceRun: {
    repository: string;
    workflow: string;
    runId: string;
    runAttempt: number;
    headSha: string;
    artifactId: string;
    artifactDigest: `sha256:${string}`;
  };
  certifierRun: {
    repository: string;
    workflow: string;
    workflowRef: 'refs/heads/main';
    controlSha: string;
    runId: string;
    runAttempt: number;
    event: 'workflow_run';
  };
  trustPolicyId: 'openopc-public-beta-sigstore-v1';
  trustPolicyDigest: `sha256:${string}`;
  releaseRoot: {
    statementPath: string;
    statementDigest: `sha256:${string}`;
    bundlePath: string;
    bundleDigest: `sha256:${string}`;
  };
}
```

The release manifest has three digest layers:

1. `candidateContentDigest` is canonical JSON over the release core: candidate
   identity, commit, environment, eleven release artifacts, Artifact Manifest
   path and digest, Evidence Ledger path and digest, rollback target, policy
   versions, and regional evidence. It excludes `certification` and `approval`.
2. `certificationDigest` is canonical JSON over the complete certification
   object. It binds source and certifier runs, effective trust policy, and
   release-root locators and digests.
3. The final manifest digest is canonical JSON over the release core,
   certification, and approval. It is computed after approval and is not a field
   inside its own digest input.

The approval object binds both `candidateContentDigest` and
`certificationDigest`, plus production environment, reviewer, and timestamp.
Changing any artifact, ledger entry, rollback target, policy, regional record,
certificate policy, source run, certifier run, or release-root file invalidates
approval.

## 10. Release-Root Provenance

After final Artifact Manifest and Evidence Ledger bytes exist, the certifier
computes `candidateContentDigest` and creates one release-root SLSA v1 statement.
Its subject is the canonical OpenOPC public-beta candidate and its subject digest
is `candidateContentDigest`.

The release-root statement also binds:

- candidate ID, environment, and commit;
- Artifact Manifest digest;
- Evidence Ledger digest and evidence schema digest;
- the ordered eleven-role artifact set digest;
- rollback commit and rollback manifest digest;
- canonical policy-versions digest;
- canonical regional-evidence digest;
- authenticated source and certifier run coordinates.

It is signed through the same keyless PAE and Sigstore Bundle process. Release-root
files live in the certification section and are excluded from
`candidateContentDigest`; this avoids a circular digest while
`certificationDigest` still binds them into approval and the final manifest.

The release CLI cannot return `ready` unless both per-artifact verification and
release-root verification succeed.

## 11. Cosign Verification Adapter

The first implementation uses the official Cosign `v3.1.2` CLI rather than
reimplementing X.509, SCT, Rekor, and checkpoint validation in application code.
The business verifier depends on a narrow adapter so a later official
`sigstore-js` implementation can replace the process boundary without changing
release semantics.

```ts
export interface PublicBetaSigstoreVerifier {
  verify(input: {
    pae: Uint8Array;
    bundleBytes: Uint8Array;
    policy: Readonly<PublicBetaSigstoreTrustPolicyV1>;
  }): boolean;
}
```

The adapter:

- validates the configured absolute executable and trusted-root paths;
- verifies binary version and SHA-256 before accepting the first request;
- creates a private temporary directory outside the candidate root;
- writes the already-validated PAE and bundle bytes, never candidate paths;
- invokes `cosign verify-blob` with an argument array, `shell: false`, an
  allowlisted environment, a fixed working directory, a bounded timeout, and
  bounded captured output;
- passes exact issuer, identity, repository, workflow ref, workflow SHA, event,
  bundle, and trusted-root arguments;
- treats missing tooling, digest mismatch, timeout, signal, nonzero status,
  malformed output, or cleanup failure as verification failure;
- never uses an insecure-ignore flag or identity regular expression.

The adapter returns literal boolean `true` only after complete success. Any other
value, exception, Promise, object, or partial result is rejected by the synchronous
business boundary.

## 12. File and Archive Safety

All candidate-relative paths must be normalized repository-style paths with a
bounded segment count and length. Absolute paths, drive prefixes, UNC paths,
backslashes, dot segments, control characters, alternate data streams, and case
collisions are rejected.

Files are opened once. `fstat`, bounded read, byte length, SHA-256, fatal UTF-8
decode, and JSON parse operate on the same descriptor. Symlinks, junctions,
reparse points, devices, sockets, and non-regular files are rejected at every
path component. The descriptor is closed in all paths.

Cosign never reopens the candidate file. It receives protected temporary copies
of the exact bytes that already passed same-descriptor verification. Temporary
directories are unique, private, bounded, and removed in a `finally` path.

## 13. Failure Contract

Public verification functions either return a typed result or literal `false`.
Unexpected parsing, filesystem, process, certificate, or policy failures do not
escape as unhandled exceptions from readiness evaluation.

Representative stable reason families are:

- `PUBLIC_BETA_SIGSTORE_POLICY_INVALID`
- `PUBLIC_BETA_SIGSTORE_TOOL_UNAVAILABLE`
- `PUBLIC_BETA_SIGSTORE_BUNDLE_MISSING`
- `PUBLIC_BETA_SIGSTORE_BUNDLE_AMBIGUOUS`
- `PUBLIC_BETA_SIGSTORE_BUNDLE_INVALID`
- `PUBLIC_BETA_SIGSTORE_IDENTITY_UNVERIFIED`
- `PUBLIC_BETA_PROVENANCE_UNVERIFIED`
- `PUBLIC_BETA_RELEASE_PROVENANCE_UNVERIFIED`
- `PUBLIC_BETA_CERTIFICATION_UNVERIFIED`
- `PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`

The CLI preserves one-line JSON stdout and exit codes `0` for ready, `2` for
well-formed not-ready, `64` for usage, and `65` for invalid input. Stderr contains
only stable reason codes, never absolute paths, certificates, bundle content,
tool command lines, or raw Cosign output.

## 14. Test Strategy

### 14.1 Contract and digest tests

Tests cover schema v2 exact keys, canonical ordering, all eleven roles, unique
artifact/SBOM/DSSE/bundle digests, candidate-content digest exclusions,
certification digest, final digest, approval binding, and circularity prevention.

### 14.2 Mutation and adversarial tests

Table-driven mutations cover:

- wrong issuer, identity, repository, workflow path, ref, SHA, or event;
- a valid bundle from a fork or another branch;
- unknown, changed, or candidate-provided trusted root;
- missing or changed certificate chain, SCT, signed entry timestamp, inclusion
  proof, checkpoint, or log identity;
- changed PAE, DSSE payload, DSSE signature, bundle message digest, bundle
  signature, key ID, SBOM digest, artifact digest, commit, or source evidence;
- duplicate DSSE or bundle matches and cross-artifact swaps;
- source/certifier run, attempt, timestamps, artifact ID, archive digest, or
  control SHA mismatch;
- release-root, rollback, policy-version, regional-evidence, or approval replay;
- malformed UTF-8/JSON, oversized arrays/files, path traversal, symlink,
  junction, reparse point, and same-path replacement attempts.

Every mutation must remain `not_ready` with the owning reason.

### 14.3 Adapter tests

The process runner is injectable. Tests cover the exact command and argument
array, `shell: false`, allowlisted environment, timeout, output limits, binary
digest/version preflight, private temporary files, and cleanup. Missing binary,
wrong binary digest, timeout, signal, nonzero exit, malformed output, and cleanup
failure all return false.

### 14.4 Real offline Sigstore fixture

The repository retains a small public, non-secret Sigstore Bundle v0.3 produced
by the canonical protected workflow, its DSSE/PAE bytes, and the matching trusted
root snapshot. A checksum-pinned real Cosign binary verifies it with outbound
network disabled. Mutating every trust and signature binding makes the same test
fail. This proves that unit adapters are not substituting for real PKI and Rekor
verification.

### 14.5 CLI integration

A complete temporary candidate contains all eleven artifacts, SBOMs, provenance
files, Gate records, release root, and authenticated run fixtures. The real CLI
must execute through artifact transport, SBOM, Sigstore, release-root, and
approval branches. Before approval its only reason is
`PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`; after a correctly bound approval it
returns `ready`. Separate cases prove each signature and release-root failure
appears at the CLI boundary.

### 14.6 Workflow contracts and live staging

Static workflow tests require SHA-pinned actions, pinned Bun and Cosign versions,
platform binary digests, job-scoped permissions, no insecure flags, exact
workflow names and events, raw ZIP digest verification, protected checkout SHA,
and no candidate-code execution.

Public-beta acceptance additionally requires a real GitHub sequence:

1. successful staging Gates run;
2. automatically triggered protected certifier run;
3. retained authenticated source and certified archive digests;
4. pre-approval validation with exactly one human-approval reason;
5. protected non-self approval;
6. post-approval `ready` validation;
7. retained DSSE, Sigstore, release-root, review, and workflow evidence.

Focused green tests or a synthetic signing callback do not satisfy this live
acceptance requirement.

## 15. Operations and Rotation

The runbook records how to update Cosign, refresh the Sigstore trusted-root
snapshot, verify release checksums from an independent channel, rotate policy
IDs, retain an overlap root, and roll back a bad policy revision. Tool and root
updates require protected review and the complete offline fixture plus CLI suite.

Rekor unavailability blocks new certification because new signatures must be
uploaded. Verification of an existing complete bundle remains offline-capable;
an online Rekor lookup is an additive consistency signal and cannot be the sole
source of trust or availability.

Certificates, bundles, ledgers, manifests, archive metadata, and approval records
are retained according to the public-beta evidence policy. Signing produces no
long-lived private key material in the repository, runner workspace, artifact,
or log.

## 16. Upstream Compatibility Boundary

Implementation is limited to:

- new public-beta Gates and certifier workflows;
- narrow updates to the existing public-beta approval workflow;
- public-beta artifact, release-manifest, Sigstore adapter, schema, and test
  modules under `scripts/release` and `tests/public-beta`;
- pinned trust/tool policy data under a dedicated public-beta release directory;
- public-beta release and trust runbooks.

It does not modify Kortix projects, sessions, agents, connectors, IAM, billing,
module runtime, SDK transport, Desktop login, or existing deployment workflow
state machines. `deploy-dev.yml` remains untouched by this design. New behavior
is invoked only by the public-beta release path, minimizing conflicts during
future Kortix upgrades.

## 17. Public-Beta Acceptance Criteria

This design is complete only when current evidence proves all of the following:

1. The canonical Gates, certifier, and approval workflows exist and pass their
   static contract tests.
2. Exactly eleven artifact entries bind independent artifact, SBOM, DSSE, and
   Sigstore Bundle digests to one commit.
3. Platform-owned policy rejects a valid signature from a fork, wrong workflow,
   wrong ref, wrong control SHA, or wrong event.
4. Real Cosign validates the retained bundle offline with the pinned trusted
   root, and all trust mutations fail.
5. Release-root provenance binds ledger, artifact set, rollback, policies, and
   regional evidence without a digest cycle.
6. A complete CLI integration reaches the real success and failure branches.
7. A real GitHub staging-to-certifier-to-protected-approval sequence produces a
   final `ready` result and retained immutable evidence.
8. No insecure verification flag, candidate-controlled trust root, signing
   secret, unverified archive extraction, or candidate-code execution exists in
   a privileged workflow.
9. The broader public-beta readiness audit has no remaining Gate reason. This
   certification slice is necessary but is not by itself sufficient to declare
   the entire OpenOPC public beta ready for launch.
