# OpenOPC Restricted Public-Beta Design

- **Date:** 2026-07-30
- **Status:** Approved design, implementation not complete
- **Release profile:** `openopc-restricted-public-beta-v1`
- **Target:** Web and Windows Desktop public beta with reviewed WASI modules
- **Base:** Kortix remains the upgradeable application base
- **Deployment:** BaoTa control node plus private WASI execution node

## 1. Decision

OpenOPC will launch a restricted public beta instead of waiting for every
capability in the complete public-beta specification. The restricted release
is a real public beta: ordinary users may register without an invitation, while
developers must apply and pass platform review before they can publish a WASI
module.

The release includes the Web workbench, Windows Desktop, individual and team
spaces, multi-Agent task collaboration, shared assets, review, copywriting,
image generation, and basic video generation. It supports platform-owned and
manually reviewed third-party WASI modules.

The release excludes OCI execution, arbitrary Module App iframes, sandbox
commerce, real payments, native mobile applications, professional 3D,
Alibaba Cloud digital humans, batch remixing, and real-time voice conversation.
Excluded capabilities must be absent or fail closed. Hiding a UI entry is not a
sufficient disablement boundary.

Readiness for this profile is reported only as:

```text
ready_for: openopc-restricted-public-beta-v1
```

It must never be presented as readiness for the complete OpenOPC public-beta
contract.

## 2. Relationship to Existing Specifications

This document is an additive launch-scope overlay for:

- `docs/specs/2026-07-28-openopc-public-beta-baota-design.md`
- `docs/specs/2026-07-29-openopc-public-beta-sigstore-certification-design.md`

The 2026-07-28 specification remains the complete product target. This document
overrides only its first public launch artifact set, enabled capabilities, Gate
applicability, and acceptance result. Identity, tenant isolation, Admin
authority, audit, secret handling, backup, restore, release integrity, human
approval, and Kortix compatibility requirements remain mandatory.

The 2026-07-29 Sigstore design remains the release trust model. The restricted
profile may defer its full offline fixture and mature rotation exercises, but
it does not weaken raw archive authentication, candidate provenance, protected
certification, or non-self approval.

Existing implementation progress and review evidence remain valid. This design
does not reset completed work and does not authorize bypassing an open security
finding.

## 3. Goals

1. Launch a useful content workbench for individual creators and enterprise
   content teams.
2. Keep Web complete when Windows Desktop is not installed or running.
3. Support shared team work, multi-Agent tasks, assets, roles, and review.
4. Provide copywriting, image generation, and basic video generation through
   platform-approved model providers.
5. Open ordinary user registration with fail-closed abuse controls.
6. Admit developers through application and manual review.
7. Publish only platform-owned or manually reviewed WASI modules.
8. Deploy a public control node and a private WASI execution node.
9. Produce cryptographically authenticated, commit-bound release evidence.
10. Make every deferred capability demonstrably unreachable.

## 4. Non-Goals

- Native Android or iOS applications.
- OCI, containerd, gVisor, or arbitrary Linux container execution.
- Arbitrary cross-origin Module App iframe applications.
- Real payment, tax, invoice, refund, dispute, withdrawal, payout, or revenue
  sharing.
- The sandbox commercial ledger and `module-ledger-worker`.
- Arbitrary remote artifact URLs or candidate-selected provider endpoints.
- Professional 3D, digital human, batch remix, or real-time voice products.
- Unreviewed developer publication or developer self-signing.
- A claim that the full OpenOPC public-beta specification is complete.

## 5. Product Scope

### 5.1 Web and Desktop

The Web application is the complete primary product. It supports personal and
team spaces, Agent sessions, multi-Agent task collaboration, shared assets,
review, approved modules, account management, and developer application.

Windows Desktop loads the same product and adds only explicitly authorized
local-device capabilities. Desktop credentials remain outside the renderer.
Closing Desktop must not prevent normal Web use.

Responsive mobile Web remains supported. Native mobile acceptance is deferred.

### 5.2 Content workbench

The restricted beta includes three platform content capabilities:

1. Copywriting and structured text generation.
2. Image generation.
3. Basic video generation.

All three use the existing model gateway and platform-approved provider
configuration. A user may select an approved provider or model, but may not
submit an arbitrary endpoint to a worker. Provider secrets remain server-side.

Generation records include tenant, project, task, model identity, duration,
usage, status, and bounded error classification. They do not include provider
keys or other reusable credentials.

### 5.3 Teams and multi-Agent work

Personal and team spaces use the same task model. Team spaces add membership,
role, shared asset, review, and usage visibility. Every project, task, asset,
and module installation remains tenant-bound.

No team role implicitly grants developer publication or platform Admin
authority.

## 6. Registration, Developer Admission, and Credits

### 6.1 User registration

Ordinary users may register without an invitation. Every entry point uses the
same server-side policy:

- email verification;
- Turnstile verification;
- IP, device, email, and account rate limits;
- exact Terms and Privacy version acceptance;
- enumeration-resistant responses;
- fail-closed behavior when a required verifier is unavailable.

No executable resource or free credit is created before email verification and
registration policy completion.

### 6.2 Developer admission

A developer may apply only as an authorized owner or administrator of the
target organization. Application and review use revision guards and immutable
audit events. Approval grants the ability to submit an artifact for review; it
does not grant self-review, self-signing, or unrestricted publication.

### 6.3 Free credits

The restricted beta uses the existing user credit ledger for versioned free
allowances. Credits have no cash value. The platform does not create orders,
receivables, developer income, withdrawals, or settlement statements.

## 7. Reviewed WASI Module Boundary

The supported lifecycle is:

```text
upload -> digest lock -> SBOM and scans -> manual review -> platform
certification -> publish -> install -> pause/resume -> revoke -> exact rollback
```

Only immutable, content-addressed WASI artifacts are accepted. A module cannot
replace a published version in place.

WASI starts with no network, host filesystem, environment, provider secret, or
Desktop-native access. Declared capabilities are checked at review, install,
and execution time. A permission expansion requires project administrator
re-consent.

Required outbound access passes through the controlled egress proxy and is
bound to tenant, project, module version, capability, destination, HTTP method,
and byte limits. A module never receives platform provider credentials.

The restricted beta does not expose arbitrary Module App iframes. Module user
interaction is limited to existing platform-rendered surfaces required by the
reviewed WASI workflow.

## 8. Deployment Architecture

### 8.1 Public control node

The BaoTa control node exposes only HTTPS through Nginx. Web, Admin, and API
have separate hostnames and independently identifiable artifacts. Admin uses
authoritative Admin sessions, exact permissions, step-up, and cross-tenant
audit. Hostname isolation is defense in depth, not the authority source.

### 8.2 Private services

PostgreSQL, private object storage, queues, Studio Worker, Developer Trust
Worker, model-provider access, and internal control APIs are not exposed to the
public Internet.

### 8.3 Private execution node

The private execution node runs the WASI Runner and controlled egress proxy.
It does not install OCI Runner, containerd, or gVisor for this profile. Runner
control endpoints are private and authenticated.

### 8.4 Network boundary

The public network exposes only ports 80 and 443. Databases, object storage,
queues, Runner endpoints, and worker control ports remain private. Public
exposure scans and private-dependency scans are required release evidence.

## 9. Fixed Release Artifact Set

The protected control plane owns the profile. Candidate content may reference
the profile identifier and digest but may not define or reduce its artifact
set.

The protected profile has this exact logical contract:

```ts
interface OpenOpcRestrictedPublicBetaProfileV1 {
  schemaVersion: 1;
  id: 'openopc-restricted-public-beta-v1';
  artifacts: readonly [
    'web',
    'admin',
    'api',
    'studio-worker',
    'developer-trust-worker',
    'wasi-runner',
    'desktop',
  ];
  requiredGates: readonly [
    'G1', 'G2', 'G3', 'G4', 'G5', 'G8', 'G10', 'G11', 'G12',
    'B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B9', 'B10',
  ];
  deferredGates: readonly ['G6', 'G7', 'G9', 'B6'];
}
```

The profile digest is the SHA-256 digest of its strict RFC 8785 canonical JSON.
The release manifest binds `releaseProfileId` and `releaseProfileDigest`. The
protected certifier loads the authoritative profile from its protected control
SHA, recomputes the digest, and rejects any candidate-provided difference.

The exact restricted artifact set is:

1. `web`
2. `admin`
3. `api`
4. `studio-worker`
5. `developer-trust-worker`
6. `wasi-runner`
7. `desktop`

Every artifact has an exact digest, SBOM digest, provenance digest, media type,
and locator policy. The release is invalid if an artifact is missing,
duplicated, renamed, or replaced with a locator kind outside its role policy.

The restricted artifact set excludes:

- `module-host`
- `automation-browser-worker`
- `module-ledger-worker`
- `oci-runner`

An excluded artifact appearing in a restricted candidate is a release failure,
not an optional extra.

## 10. Gate Profile

### 10.1 Required Gates

The restricted profile requires current, real, commit-bound evidence for:

- `G1`: migration apply, idempotency, guards, and restore compatibility;
- `G2`: private artifact storage, digest, retention, cleanup, and tenant denial;
- `G3`: secret, SBOM, vulnerability, static, license, and provenance checks;
- `G4`: malicious fixture and scanner fail-closed behavior;
- `G5`: WASI execution, imports, resources, cancellation, egress, and determinism;
- `G8`: tenant authority, cross-tenant denial, and audit;
- `G10`: reviewed WASI install, pause, resume, revoke, consent diff, and rollback;
- `G11`: responsive Web, Desktop package, Desktop smoke, and console evidence;
- `G12`: upstream compatibility, protected-file audit, core smoke, and disabled
  state audit;
- `B1`: registration and abuse controls;
- `B2`: Web independence from Desktop;
- `B3`: Admin build, route isolation, IAM, audit, and deployment smoke;
- `B4`: developer application and reviewed WASI module workflow;
- `B5`: WASI-only runtime authority, limits, egress, cancellation, and escape
  denial;
- `B7`: PostgreSQL PITR, object restore, RPO/RTO, consistency, and smoke;
- `B8`: minimum correlation, alerts, dead-letter recovery, and failure drill for
  deployed services;
- `B9`: visible brand and Kortix compatibility audit;
- `B10`: control-node plus WASI-node topology, exposure, TLS, private service,
  regional, and artifact-commit checks.

### 10.2 Deferred Gates

The following complete-profile Gates are not required for this profile:

- `G6`: OCI execution and isolation;
- `G7`: arbitrary Module App/iframe UI capability;
- `G9`: sandbox commerce;
- `B6`: sandbox ledger, refund, dispute, split, and statements.

They are recorded as `deferred_by_profile` in the signed release-profile
assessment, never as a passed evidence record. The Evidence v2 outcome enum is
not widened with a generic skip or not-applicable value. Their absence does not
make the complete profile ready.

### 10.3 Restricted dependency overrides

The complete-profile lane registry remains unchanged. A separate protected
restricted-profile registry supplies these exact dependency and service
overrides:

- `G10` depends on `G5` and `G8`; it verifies the reviewed WASI lifecycle and
  does not require `G7` or `module-host`.
- `B4` depends on `G3`, `G4`, `G5`, `G8`, and restricted `G10`; it verifies
  application, trust review, publication, installation, revocation, and
  rollback without Module App or the complete CLI.
- `B5` depends only on `G5`; its required runtime services are `wasi-runner`
  and `egress-proxy`, never `oci-runner`.
- `B8` depends on restricted `B5`; its required telemetry covers only the
  deployed API, workers, WASI Runner, control node, and execution node. It does
  not depend on `B6` or `module-ledger-worker`.

All other required Gate dependencies are inherited unchanged. The restricted
registry has an exact contract test. No caller may derive dependencies by
filtering the complete registry at runtime.

### 10.4 Disabled-state evidence

The restricted release must prove that every deferred capability is disabled:

- the service or binary is not deployed;
- its artifact is absent from the manifest;
- the server-owned feature flag is disabled;
- API and CLI entry points reject access with a stable unavailable result;
- IAM does not issue the capability;
- legacy routes and direct requests cannot restore it;
- the user interface does not advertise it as available.

The disabled-state audit is produced from protected control code and is bound
to the candidate commit and profile digest.

## 11. Release Trust and Approval

The restricted profile retains the approved Sigstore architecture:

1. An unprivileged staging Gates workflow produces the source candidate.
2. A protected `main` certifier authenticates the source run and raw archive.
3. The certifier verifies the exact profile, artifact set, evidence, and
   disabled-state record.
4. The certifier creates per-artifact DSSE/SLSA provenance, Sigstore Bundles,
   and release-root provenance.
5. The Approval workflow accepts only the certified candidate.
6. A different authorized reviewer approves the protected production
   environment.
7. The same immutable candidate is revalidated after approval.

Raw archive size, digest, structure, extraction, and cleanup must be fail
closed. An open Critical or Important archive finding blocks all later release
work.

The first restricted beta requires one real online protected signing and
verification sequence. The full retained network-blocked Sigstore fixture and
mature trusted-root overlap exercise may follow after launch.

## 12. Failure Contract

Every security, identity, provider, scanner, storage, Runner, backup, release,
or evidence dependency fails closed. The platform must not silently fall back
to an unreviewed module, arbitrary provider endpoint, local execution, insecure
signature mode, or synthetic evidence.

Feature configuration is server-owned. Missing, malformed, or mismatched
profile configuration disables the affected operation and blocks release.

User-facing failures are stable and do not expose credentials, absolute paths,
certificate bodies, provider responses, or cross-tenant object existence.

## 13. Verification Strategy

### 13.1 Unit and contract tests

Tests cover exact profile identity, artifact names, manifest keys, feature
flags, role policies, Gate applicability, disabled-state rules, canonical
digests, and reason codes.

### 13.2 Security and mutation tests

Tests cover archive traversal and filesystem races, symlink/junction/reparse
points, duplicate artifacts, stale or mixed commits, signature mutations,
tenant and Admin boundaries, capability expansion, scanner failure, provider
endpoint injection, and direct requests to disabled features.

### 13.3 Integration tests

Integration tests use real PostgreSQL for registration, tenancy, audit,
installation, revocation, rollback, and free-credit behavior. WASI tests use the
real Runner policy and controlled egress boundary.

### 13.4 Browser and package tests

Browser evidence covers registration, Web without Desktop, team work, content
generation, developer application, module review/install/revoke, and Admin host
isolation at desktop and responsive mobile-Web sizes. Windows package evidence
covers install, launch, login, update boundary, and Desktop smoke.

### 13.5 Staging and operations tests

Staging proves model-provider calls, artifact storage, WASI execution, backup,
isolated restore, alerts, dead-letter recovery, public exposure, private
dependency isolation, rollback, and the protected GitHub release sequence.

Focused green tests or fixture-only evidence do not establish readiness.

## 14. Delivery Sequence

### Phase 0: Close current security work

1. Formally close the same-descriptor file review.
2. Fix the current ZIP transient outside-write RED.
3. Close stream/descriptor lifetime and cleanup-race findings.
4. Run the full public-beta regression and independent security review.

No new release workflow is dispatched while these findings remain open.

### Phase 1: Encode the restricted profile

1. Add the protected profile contract and digest.
2. Bind release manifests, evidence, and workflows to it.
3. Encode the exact seven-artifact set.
4. Encode required, deferred, and disabled-state evidence.

### Phase 2: Close enabled product surfaces

1. Verify open registration, free credits, team work, and Admin isolation.
2. Verify copywriting, image generation, and basic video against approved
   providers.
3. Verify developer application and reviewed WASI lifecycle.
4. Verify every deferred capability is unreachable.

### Phase 3: Complete the protected release chain

1. Authenticate GitHub runs and raw archives.
2. Complete manifest, provenance, Bundle, Cosign, and release-root validation.
3. Run Gates, protected Certifier, and protected Approval.
4. Retain one real online live-acceptance record.

### Phase 4: Deploy and open gradually

1. Deploy the BaoTa control node and private WASI node.
2. Complete backup and isolated restore evidence.
3. Complete package, browser, exposure, telemetry, and rollback smoke.
4. Open registration to a small cohort.
5. Expand only while security, abuse, cost, queue, and recovery signals remain
   within the approved thresholds.

## 15. Restricted Public-Beta Acceptance Criteria

The candidate is ready only for `openopc-restricted-public-beta-v1` when all of
these statements are true:

- the current same-descriptor and archive security reviews are closed;
- all seven exact artifacts have matching digest, SBOM, and provenance;
- all required Gates have real, current, same-commit evidence;
- deferred Gates are not reported as passed;
- disabled-state evidence proves excluded capabilities are unreachable;
- public registration, abuse controls, and policy acceptance fail closed;
- Web works without Desktop and Admin is independently isolated;
- copywriting, image generation, and basic video work through approved
  providers;
- reviewed WASI upload, review, install, execution, revoke, and rollback work;
- no OCI, Module App, commerce, or arbitrary remote artifact path exists;
- backup and isolated restore meet the approved RPO/RTO contract;
- Windows package and responsive browser smoke pass;
- a protected real GitHub sequence authenticates the exact candidate;
- a different authorized reviewer approves the production environment;
- rollback target and prior feature flags are recorded and restorable;
- no Critical or Important finding remains open for an enabled boundary.

Failure of any criterion returns `not_ready` for this profile.

## 16. Post-Beta Work

The following require separate specifications or activation plans after the
restricted beta:

1. Arbitrary Module App iframe UI and complete module CLI experience.
2. OCI Runner, rootless containerd, gVisor, and full execution-node isolation.
3. Sandbox commercial ledger, followed by a separate real-money decision.
4. Full offline Sigstore fixture, trusted-root overlap rotation, and extended
   Rekor outage exercises.
5. Native Android and iOS applications.
6. Professional 3D, digital human, batch remix, and real-time voice products.
7. Real payment, tax, invoice, payout, withdrawal, and revenue sharing.

Each deferred capability must pass its original complete-profile Gates before
activation. Restricted-beta readiness is not grandfathered into those later
capabilities.

## 17. Implementation Planning Rule

The implementation plan for this design is an overlay, not a rewrite of the
existing public-beta and Sigstore plans. It must:

- preserve completed implementation and review evidence;
- resume the current archive work before starting profile work;
- identify exact tasks retained from the 21-task Sigstore plan;
- add profile and disabled-state tasks without weakening complete-profile
  contracts;
- move only genuinely deferred capability tasks to the post-beta backlog;
- keep protected files and pre-existing dirty work unchanged unless a task
  explicitly owns them;
- require renewed explicit authorization before any commit or push.
