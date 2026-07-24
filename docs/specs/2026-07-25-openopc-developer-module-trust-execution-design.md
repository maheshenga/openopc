# OpenOPC Developer Module Trust Execution Design

- **Date:** 2026-07-25
- **Status:** Approved direction; pending written-spec review before implementation planning
- **Target branch:** `studio-platform`
- **Base:** Kortix remains the sole application base
- **Scope:** Content-addressed module artifacts, automated source scanning,
  isolated validation execution, scoped verification tokens, SBOM and immutable
  trust evidence

## 1. Product Decision

The next Developer Center stage is a mandatory publication trust pipeline.
Code-bearing modules must be bound to one immutable artifact, scanned by an
independent worker, exercised in an isolated validation sandbox, and supported
by immutable machine evidence before an administrator can approve or sign the
release.

OpenOPC has not been deployed. The existing manifest-only signature contract
is therefore replaced rather than preserved. The implementation uses one
trust-aware signature payload and does not include a legacy decoder, dual
signature path, downgrade path, or compatibility mode for the current local
signature schema.

This stage validates untrusted packages before publication. It does not yet
turn installed modules into a general production code-execution runtime.

## 2. Goals

1. Bind every release to the complete bytes that may later be installed or
   executed, not only to its module manifest.
2. Run deterministic built-in validation, source scanning, dependency and
   secret scanning, SBOM generation, and bounded sandbox tests outside the
   trusted Web and API processes.
3. Replace manual `source_scan` and `sandbox_test` assertions with automatic
   evidence tied to the exact artifact digest and policy version.
4. Fail closed when a scanner, sandbox, dependency, policy, or evidence store
   is unavailable or returns an inconclusive result.
5. Preserve the existing human review, platform-admin, signing, publication,
   revocation, Marketplace projection, installation, and rollback boundaries.
6. Reuse Kortix IAM, audit, object storage, worker, and sandbox abstractions
   through additive ports and thin mounts so future Kortix upgrades remain
   practical.
7. Support hosted multi-tenant and self-hosted deployments with the same
   contracts and migration artifacts.

## 3. Non-goals

- General production execution of arbitrary third-party packages.
- Giving a verification container access to tenant projects, real Secrets,
  provider credentials, Connectors, billing mutations, or desktop APIs.
- Revenue metering, developer settlement, disputes, or payouts.
- Production KMS key creation or public transparency-log publication.
- Treating an imported CI result as sufficient to bypass platform validation.
- Reintroducing cancelled first-party video, voice, 3D, digital-human, or
  batch-remix product pages.
- Replacing the Git-native Registry as the canonical catalog.

## 4. Current Gap

The current release record stores a validated `RegistryModuleManifest` and a
digest of that manifest. The current distribution gate intentionally permits
only declarative modules with no files, dependencies, executable UI, or entry
point. The detached signature is consequently unable to prove which source
files, dependency declarations, or executable bytes were reviewed.

The review model already declares `source_scan` and `sandbox_test`, but the
current implementation accepts manual `passed` evidence for every requirement.
That is sufficient for the completed manual declarative path, but it is not a
safe authority for code-bearing modules.

Opening non-declarative distribution before artifact binding and automatic
evidence would create a substitution gap: reviewed metadata could differ from
installed bytes. This design closes that gap first.

## 5. Trust Invariants

1. One module version maps to one artifact digest for its entire lifetime.
2. The artifact digest covers the normalized Registry Item descriptor and
   every resolved file byte.
3. A file path, target path, dependency, entry point, or source reference not
   included in the artifact cannot appear during validation or installation.
4. Automated evidence is valid only for the exact artifact digest, verification
   policy version, scanner-set digest, and sandbox profile version.
5. A failed, timed-out, cancelled, crashed, or unavailable check is never
   converted to `passed`.
6. Human reviewers cannot supply or edit automatic scan evidence.
7. A signature is created only after required automatic evidence and human
   evidence are both current and passing.
8. Published artifacts remain immutable. Fixes require a new semantic version.
9. Revocation blocks new installation and update while preserving immutable
   history and forensic evidence.
10. No untrusted module byte executes in the Web process, API process, trust
    control process, or database process.

## 6. Architecture

```text
Publisher Web/SDK
  -> Developer Artifact API
  -> DeveloperArtifactStore (S3/MinIO adapter)
  -> developer_module_artifacts + immutable release binding
  -> developer_module_verification_runs
  -> apps/developer-trust-worker
       -> deterministic artifact validator
       -> source/secret/dependency scanners
       -> CycloneDX SBOM generator
       -> DeveloperModuleSandboxPort
       -> DSSE/in-toto attestation builder
  -> immutable findings and trust attestation
  -> existing admin review gate
  -> trust-aware module signer
  -> existing publication/Marketplace/project installation flow
```

The API owns authenticated submission, account isolation, release binding,
review decisions, and read models. The trust worker owns artifact retrieval,
scanner execution, sandbox execution, and evidence finalization. The Web app
only displays server-authoritative state and never computes trust decisions.

The trust worker is a new additive application. It does not modify Kortix's
general session runtime or place third-party code in an API pod.

## 7. Artifact Contract

### 7.1 Artifact envelope

The final artifact is an OCI-compatible, content-addressed envelope with media
type `application/vnd.openopc.developer-module.v2+json`. Its canonical
descriptor contains:

- the complete normalized `RegistryItem`;
- module identity, version, publisher, category, and execution mode;
- every resolved file path, target, media type, byte length, and SHA-256 digest;
- exact dependency, development dependency, and Registry dependency lists plus
  a resolved lock graph and lock digest for code-bearing modules;
- entry-point and UI-entry mappings;
- source URI, immutable source revision, and Registry item address when the
  artifact originated from a Git-native registry;
- the artifact format version.

File bytes are stored as content-addressed blobs. The envelope digest commits
to the descriptor and all blob digests. Path separators are normalized to `/`.
Duplicate paths, case-folding collisions, absolute paths, traversal, device
names, alternate data streams, symlinks, hardlinks, sparse-file tricks, and
undeclared blobs are rejected before persistence.

### 7.2 Submission modes

Declarative modules can still be submitted from resolved JSON. The server
synthesizes an artifact containing the normalized Registry Item and no blobs.

Code-bearing modules use a bounded upload/finalize flow. The server issues an
upload target, validates declared size and checksum on finalization, resolves
the artifact envelope, and only then creates the release. A release API accepts
an `artifact_id`, never an unbound executable entry.

Git-native Registry remains canonical. The artifact stores an immutable,
reviewable snapshot used for validation and installation; it is not a second
editable catalog.

### 7.3 Limits

The policy defines maximum archive bytes, expanded bytes, file count, per-file
bytes, path length, dependency count, JSON depth, and compression ratio. Limits
are checked while streaming. Validation never expands an unbounded archive in
memory or onto a shared host path.

### 7.4 Module schema and verification profiles

The Registry module manifest moves directly to `schemaVersion: 2`; schema 1 is
removed rather than dual-read. Version 2 adds a required `verification.profile`
for every non-declarative execution mode. Publishers do not supply an arbitrary
host shell command. The platform maps each profile to a versioned harness:

- `declarative`: canonical schema and policy validation; no executable sandbox
  requirement when the artifact contains no executable bytes;
- `agent-project`: install into a synthetic project, validate the resulting
  manifest/layout, load declared Agent/skill/tool entries, and exercise only
  synthetic capability fixtures;
- `sandboxed-web`: build with a pinned toolchain, launch behind the validation
  proxy, and verify CSP, iframe bridge, declared UI entries, and bounded health
  probes;
- `server-conformance`: launch the declared adapter entry through a standard
  RPC harness and verify input/output schemas, capability denial, cancellation,
  timeout, and clean shutdown;
- `desktop-package`: perform package/static/permission checks in the server
  sandbox and require the separate desktop security review; this profile does
  not claim full native-platform execution acceptance.

Each profile and harness has an immutable version recorded in the verification
policy. Optional module-owned tests use a standard harness entry and structured
arguments; they cannot replace the platform conformance checks.

Code-bearing artifacts must include a supported deterministic lock graph.
Floating or unresolved dependency ranges fail validation. A trusted resolver
may populate a content-addressed dependency cache before sandbox creation, but
untrusted install scripts run only inside the sandbox and the control worker
never executes package lifecycle scripts. Dependency fetching, when enabled,
uses pinned registries and policy-controlled checksums rather than module
declared arbitrary origins.

## 8. Verification Lifecycle

Verification runs use these states:

```text
queued -> running -> passed
                  -> failed
                  -> inconclusive
                  -> cancelled
```

`passed`, `failed`, `inconclusive`, and `cancelled` are terminal. A retry creates
a new run and never edits the old run. The active run is selected by artifact
digest, policy version, and monotonically increasing attempt number.

Release submission queues validation automatically. Publishers can request
human review while validation runs, allowing review and scanning to overlap.
The review page displays `verification_pending`, but approval and signing fail
closed until the latest required run passes.

The worker claims jobs with a database lease and `SKIP LOCKED`. Heartbeats,
lease expiry, bounded retry, attempt identity, and idempotent finalization use
the repository's existing durable-worker patterns. A lost worker can be
reclaimed only before a terminal evidence record exists.

## 9. Verification Policy and Scanners

The policy is a versioned immutable document. A policy digest records scanner
images, rule packs, severity thresholds, sandbox profile, timeout limits, and
network policy. Updating policy does not mutate earlier evidence. A release
must be reverified before signing when its required policy changes.

The initial scanner set includes:

1. A built-in deterministic artifact and manifest validator.
2. Secret detection through a pinned Gitleaks adapter plus platform-specific
   credential patterns.
3. CycloneDX 1.6 SBOM generation through a pinned Syft adapter.
4. Known-vulnerability analysis through a pinned OSV-Scanner adapter using a
   recorded advisory database snapshot.
5. Static policy analysis through pinned Semgrep rules for supported source
   languages.
6. License and dependency-declaration policy checks.
7. Optional verification of supplied Sigstore bundles and in-toto statements.

Scanner executables or images are pinned by digest. Scanner versions, database
snapshot identifiers, rule-pack digests, start/end timestamps, exit status, and
sanitized finding fingerprints are evidence inputs. Network-dependent database
updates happen outside the untrusted validation container and never silently
change a running policy version.

Critical and high findings fail the default policy. Medium findings require an
explicit policy disposition before a future policy can allow them. The first
implementation does not offer an administrator `ignore` button that mutates a
completed run.

## 10. Isolated Sandbox Validation

### 10.1 Sandbox port

`DeveloperModuleSandboxPort` accepts only a content-addressed artifact,
verification profile, synthetic input fixtures, and a short-lived verification
capability. It returns bounded stdout/stderr digests, resource usage, declared
capability attempts, network attempts, test results, and a terminal reason.

The production hosted adapter uses a dedicated hardened runtime, preferring
gVisor or Kata isolation when available. The self-hosted adapter uses a
hardened OCI container profile. Local Docker is a development adapter and is
not presented as equivalent to the hosted isolation profile.

The worker never exposes the host Docker socket to the validation container.
Runtime creation occurs through a narrow control adapter.

### 10.2 Default sandbox profile

- non-root UID/GID with no privilege escalation;
- read-only root filesystem and read-only artifact mount;
- isolated ephemeral `tmpfs` scratch space;
- all Linux capabilities dropped;
- seccomp and AppArmor/SELinux profile where supported;
- bounded CPU, memory, PIDs, file descriptors, output bytes, and wall time;
- no host mounts, host IPC, host PID namespace, or host network;
- no cloud metadata route, private address route, or local service route;
- no Secrets, Connector credentials, provider keys, user tokens, or project
  repository credentials;
- deterministic clock/randomness controls where the execution mode supports
  them.

### 10.3 Network policy

Network is denied by default. A policy can allow declared HTTPS origins only
through an egress proxy. The proxy performs DNS resolution itself, rejects
private, loopback, link-local, multicast, metadata, and rebinding destinations,
pins the resolved address for the request, strips credentials, enforces method
and byte limits, and records only sanitized origin-level evidence.

An origin declared by a module is a request for review, not automatic access.
The verification policy must also permit it.

## 11. Scoped Verification Tokens

Validation containers do not receive ordinary project CLI or sandbox tokens.
They receive a separate short-lived verification capability whose audience is
the validation capability broker, not the general `/v1` API.

The capability binds:

- release ID and artifact digest;
- verification run ID and sandbox instance ID;
- allowed synthetic actions derived from declared module permissions;
- issued-at, expiry, nonce, and policy version;
- maximum call count and payload bytes.

The broker serves synthetic fixtures and records attempted actions. It cannot
read tenant data or mutate a real project. Undeclared actions fail and become
evidence. The token is stored only as a hash/server-side session record and is
revoked when the run terminates.

Production module runtime tokens are a later stage. They will additionally bind
project, installation, actor, resource grants, and real capability policy; this
design does not pretend the verification token is that runtime.

## 12. Automatic and Human Evidence

`source_scan` and `sandbox_test` become automatic requirements. Their evidence
is created only by the trust worker. `manifest_review`, `permission_review`,
`desktop_security_review`, and `human_review` remain human decisions when
required by the manifest.

Approval requires:

- one current passing automatic attestation for every automatic requirement;
- no unresolved policy-blocking findings;
- complete human evidence for every human requirement;
- reviewer independence and existing compare-and-swap revision checks.

The trust attestation is an in-toto Statement wrapped in DSSE. Its subject is
the artifact digest. Its predicate records policy/scanner/sandbox digests,
SBOM digest, result, run ID, timestamps, and evidence digests. Raw source,
credentials, raw scanner output, and unbounded logs are not included.

## 13. Signing Contract

The current signature payload is replaced by one trust-aware schema:

```json
{
  "schema": 2,
  "module_id": "publisher.module",
  "module_version": "1.2.3",
  "publisher_id": "publisher",
  "artifact_digest": "sha256:...",
  "manifest_digest": "sha256:...",
  "sbom_digest": "sha256:...",
  "trust_attestation_digest": "sha256:...",
  "verification_policy_digest": "sha256:..."
}
```

Only schema 2 is accepted. The current schema-1 payload implementation is
removed. There is no dual verification or fallback.

Because the product is not deployed, development databases containing current
signed or published rows are unsupported. The migration preflight fails with
an explicit reset-required error if such rows exist. CI and supported local
acceptance start from an empty database. The migration does not silently retain
or reinterpret an old signature as trusted.

`ModuleSigningPort` remains the signing adapter boundary. Development may use a
configured Ed25519 key. Production KMS integration remains a separately
reviewed adapter and release gate.

## 14. Persistence

Additive tables and columns are owned by the Developer Center extension:

### 14.1 `developer_module_artifacts`

Stores account, publisher, artifact digest, envelope digest, storage key,
media type, size, normalized item snapshot, source provenance, creator, and
timestamps. `(account_id, artifact_digest)` is unique. Blob storage may dedupe
identical content internally, but APIs and database conflicts never reveal
whether another account already uploaded the same digest.

### 14.2 `developer_module_verification_runs`

Stores release, artifact, policy and scanner-set digests, attempt, state,
lease owner/expiry, heartbeat, terminal reason, SBOM digest, attestation digest,
resource summary, and timestamps. A uniqueness fence prevents two active runs
for the same release and policy.

### 14.3 `developer_module_verification_findings`

Stores run, stable finding fingerprint, scanner, rule, severity, sanitized
path/location, safe summary, disposition, and timestamps. It never stores raw
credentials or an unbounded source excerpt.

### 14.4 `developer_module_trust_attestations`

Stores the immutable DSSE envelope, subject artifact digest, predicate type,
policy digest, result, SBOM digest, issuer identity, and creation time. Terminal
run finalization and attestation insertion occur in one transaction.

### 14.5 Release binding

`developer_module_releases` gains required artifact, SBOM, trust attestation,
and verification policy fields before signing. Existing manifest fields remain
available as indexed read data, but the artifact is authoritative for bytes.

All tenant-owned tables include account-qualified foreign keys, RLS/PostgREST
policies consistent with existing Developer Center tables, and immutable audit
events for submission, queue, claim, completion, retry, approval, signing,
publication, and revocation.

## 15. API and SDK Surface

Publisher APIs:

- create/finalize/cancel a bounded artifact upload;
- submit a release from a finalized artifact;
- read artifact metadata, verification state, sanitized findings, SBOM
  metadata, and trust history;
- request a verification retry when policy permits it.

Platform-admin APIs:

- read the complete verification timeline and safe evidence;
- request a retry or cancel a non-terminal run;
- review human requirements;
- sign only after the trust gate passes.

Worker operations use private database claims or authenticated internal routes
and are never part of the public SDK. Public SDK additions extend
`kortix.developer.modules` and the existing project facade; no parallel client
package or second marketplace client is introduced.

Errors use stable codes and do not echo artifact bytes, scanner output, tokens,
storage locations, signed URLs, or dependency credentials.

## 16. Web Experience

The existing Developer Center remains the only authoring and review surface.

Publisher submission adds:

- declarative JSON submission or package upload;
- deterministic artifact summary and digest confirmation;
- verification progress and retry state;
- findings grouped by severity and requirement;
- SBOM summary and downloadable safe report metadata;
- explicit separation between automatic checks and human review.

Admin review adds:

- artifact, source provenance, policy, scanner, sandbox, and SBOM summaries;
- immutable verification attempts;
- disabled approval/sign actions with the exact unmet condition;
- no control that can convert failed automatic evidence into passed evidence.

The surface follows the existing Google-style OpenOPC layout and responsive
patterns. No separate operations application is created.

## 17. Failure and Recovery

- Upload checksum or size mismatch: reject finalization and remove staging data.
- Invalid archive or path: fail before a release is created.
- Artifact store unavailable: return a stable service-unavailable code and do
  not create a release with missing bytes.
- Scanner unavailable/crashed: mark the run `inconclusive`; never pass.
- Policy or scanner digest mismatch: stop the run and require a new attempt.
- Sandbox timeout/resource limit: mark failed with a bounded terminal reason.
- Worker lease loss: the stale worker cannot finalize after its fence expires.
- Duplicate claim/finalize: return the original terminal result idempotently.
- Evidence transaction failure: no terminal pass is visible.
- Policy changes after a pass: the prior attestation remains immutable but is
  no longer current for approval/signing.
- Revocation during a run: cancel or ignore the run result for distribution;
  retain forensic evidence.
- Object deletion failure: retain the database reference and retry cleanup;
  never reuse the digest for different bytes.

## 18. Deployment and Operations

`developer-trust-worker` is disabled by default. Enabling code-bearing module
submission requires:

- configured S3-compatible artifact storage;
- pinned scanner images/binaries and policy bundle;
- a configured sandbox control adapter;
- worker database access with only claim/evidence permissions;
- validation egress proxy configuration when network tests are enabled.

Hosted and self-hosted modes use the same image and policy schema. Self-hosted
deployments can run MinIO and the hardened OCI adapter. BaoTa deployments use
the existing Docker Compose/reverse-proxy pattern and do not place scanner or
sandbox ports on the public network.

Readiness reports artifact storage, policy availability, scanner availability,
sandbox adapter readiness, and database claim health separately. A disabled
trust worker does not affect existing Kortix or declarative module reads.

## 19. Observability and Audit

Metrics include queue age, claim latency, scan duration by scanner, sandbox
startup/runtime, result counts, finding severity, timeout/resource-limit count,
lease recovery, policy staleness, artifact bytes, and cleanup backlog.

Logs contain correlation, release, artifact, run, scanner, policy, and terminal
reason identifiers only. Raw source, artifact content, stdout/stderr bodies,
tokens, Secrets, signed URLs, and unredacted scanner output are forbidden.

Audit events record actor, account, release, artifact digest, action, policy,
result, and timestamp. Publisher and project access remains tenant-scoped;
platform-wide evidence access remains behind existing admin middleware.

## 20. Verification Strategy

### 20.1 Contracts

- Canonical artifact and signature vectors across API, worker, SDK, and tests.
- Digest changes for every descriptor, file byte, path, dependency, entry, and
  policy change.
- No schema-1 signature acceptance or fallback.
- CycloneDX, DSSE, and in-toto schema validation.

### 20.2 Persistence and tenancy

- Fresh migration, idempotent rerun, reset, constraints, grants, RLS, and
  account-qualified foreign keys.
- Cross-account artifact, run, finding, SBOM, and attestation identifiers return
  no existence information.
- Concurrent claim, lease expiry, stale finalizer, duplicate retry, and atomic
  terminal evidence tests against PostgreSQL.

### 20.3 Scanner and artifact safety

- Archive traversal, symlink, hardlink, device path, case collision, zip bomb,
  size/count, malformed JSON, undeclared blob, checksum, and secret fixtures.
- Pinned scanner/rule/database identity assertions.
- Vulnerable and clean dependency fixtures with deterministic SBOM digests.
- Redaction scans proving credentials and raw source do not enter logs/errors.

### 20.4 Sandbox isolation

- No network by default; declared and policy-approved HTTPS origin only.
- DNS rebinding, metadata, private, loopback, link-local, oversized response,
  method, and redirect denial.
- No host mounts, host namespace, privilege escalation, Secrets, Connectors,
  project tokens, or general API access.
- CPU, memory, PID, file, output, and wall-time termination.
- Undeclared capability attempts are denied and recorded.

### 20.5 Review and distribution

- Manual evidence cannot satisfy automatic requirements.
- Approval and signing fail for queued, running, failed, inconclusive, stale,
  or mismatched evidence.
- Exact passing evidence permits one revision-fenced approval and signature.
- Publication, installation, update, rollback, and revocation verify the
  artifact-bound signature and current revocation state.

### 20.6 Wider gates

- Registry, API, DB, SDK, Web, route-manifest, migration, and public-surface
  regressions.
- Existing Kortix project/session/sandbox/IAM/Marketplace flows remain intact.
- Browser acceptance covers upload, progress, findings, approval blocking,
  passing approval/signing, conflict recovery, and responsive layout.
- CodeGraph sync, `git diff --check`, and credential/raw-output scans before
  every implementation commit.

## 21. Acceptance Criteria

1. A declarative or code-bearing publisher submission resolves to one immutable
   artifact digest that covers every installable byte.
2. A code-bearing release cannot be approved, signed, or published without a
   current passing source scan and required sandbox test.
3. Manual API or UI input cannot forge automatic evidence.
4. A clean fixture produces a deterministic CycloneDX SBOM and DSSE/in-toto
   trust attestation tied to the artifact and policy digests.
5. A secret, vulnerable dependency, traversal archive, undeclared file,
   forbidden network request, undeclared capability attempt, resource escape,
   timeout, scanner crash, or stale worker prevents trust completion.
6. The validation sandbox receives no real tenant credential or ordinary
   Kortix project/sandbox token.
7. The trust-aware signature binds artifact, manifest, SBOM, attestation, and
   policy digests and has no schema-1 fallback.
8. Tenant substitution tests for every new identifier reveal no cross-account
   existence.
9. Published artifact history, evidence, installation history, and revocation
   remain immutable and auditable.
10. Hosted and self-hosted deployments use the same contracts; disabled trust
    infrastructure does not break existing Kortix functions.
11. Focused, package, migration, route, browser, and wider regression gates
    produce recorded evidence before the feature is enabled.
12. Arbitrary production module execution, metering, settlement, production
    KMS, deployment, and production acceptance remain explicitly unclaimed
    until their later stages pass.

## 22. Delivery Slices

1. Artifact envelope, storage port, complete digest binding, and trust-aware
   signature replacement.
2. Verification schema, repositories, leases, automatic-evidence review gate,
   API read models, and migration acceptance.
3. Trust worker, deterministic validator, Gitleaks, Syft/CycloneDX,
   OSV-Scanner, Semgrep, policy bundles, and DSSE/in-toto evidence.
4. Hardened sandbox adapter, validation capability broker, egress proxy, and
   isolation acceptance.
5. Publisher/admin Web experience, operational readiness, deployment artifacts,
   browser acceptance, wider regressions, and progress ledger.

Each slice is independently committed and defaults off until the complete trust
acceptance gate passes.

## 23. Decisions

- Use one content-addressed artifact authority; do not sign a manifest alone.
- Replace the existing signature schema; do not maintain v1 compatibility.
- Keep automatic evidence and human evidence separate.
- Use a dedicated trust worker and sandbox port; do not execute untrusted code
  in the API or reuse a broad project session token.
- Use CycloneDX 1.6, DSSE/in-toto, and optional Sigstore verification as mature
  interoperable trust formats.
- Keep external CI attestations additive rather than authoritative.
- Keep Registry Git-native and Marketplace unified.
- Preserve arbitrary production execution, revenue settlement, and production
  KMS as later separately reviewed stages.
