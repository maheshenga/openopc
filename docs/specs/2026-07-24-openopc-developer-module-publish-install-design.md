# OpenOPC Developer Module Publish, Install, Update, and Rollback Design

- **Date:** 2026-07-24
- **Status:** Design approved for the next implementation phase
- **Scope:** Signed publication of declarative developer modules and project-scoped installation, update, rollback, and revocation
- **Base:** The existing developer release/review lifecycle and Kortix Marketplace/Registry contracts

## 1. Decision

This phase completes the control-plane distribution loop for the first safe
module class:

```text
validated -> review_pending -> approved -> signed -> published
                                                    |
                                                    +-> install
                                                    +-> update
                                                    +-> rollback
                                                    +-> revoked (emergency)
```

Only a `registry:module` whose manifest uses `execution.mode: declarative` is
eligible for signing and publication. A declarative module is a signed,
versioned description of platform-owned capabilities and UI metadata; it is
not an executable package. The following remain review-only until a separate
sandbox/package design is approved:

- `execution.entry` or any non-declarative execution mode;
- file payloads, inline source, npm/dev dependencies, or registry dependencies;
- UI surface entries that point to executable code;
- desktop-native permissions or native modules;
- arbitrary network or credential-bearing package content.

This restriction is intentional. It makes the first distribution path useful
for capability bundles and declarative industry/AI modules without treating
unscanned code as trusted Kortix Web or Desktop code.

## 2. Goals

1. Give an approved release a verifiable detached signature without accepting
   or storing a private key in an API request.
2. Publish the signed release through the existing Marketplace/Registry
   catalog seam rather than creating a second marketplace.
3. Install one exact published release into a project under the existing
   project/account IAM boundary.
4. Support deterministic exact-version updates and rollback to a previously
   published, non-revoked release.
5. Make concurrent sign/publish/install/update/rollback requests fail closed
   with revision fences and idempotent retries.
6. Preserve a complete immutable audit/history trail and make emergency
   revocation prevent new installs, updates, and rollbacks.
7. Keep Kortix upgrades absorbable through additive adapters, migrations,
   feature flags, and unchanged existing Marketplace and Review Center
   contracts.

## 3. Non-goals

This phase does not:

- execute module code, JavaScript, native binaries, sandbox workers, or
  provider calls;
- add first-party video, voice, 3D, digital-human, or batch-remix pages;
- implement arbitrary package uploads, artifact extraction, remote registry
  mirroring, or a module runtime;
- implement revenue share, metering, settlement, paid entitlements, or
  billing changes;
- replace the existing project Review Center or Marketplace installer;
- adopt a full Sigstore/Cosign transparency-log platform;
- make a revoked release executable or silently remove already recorded
  project history.

## 4. Compatibility Boundary

Kortix remains the sole application base and source of truth for existing
projects, sessions, agents, IAM, Marketplace, Registry, Review Center, SDK,
database schema, and desktop protocol. The implementation is additive:

- retain `@kortix/*` package names, `kortix` schema, existing status values,
  `/v1` routes, and `KORTIX_*` fallbacks;
- add OpenOPC settings with `OPENOPC_*` precedence, including
  `OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED`, and leave distribution
  disabled when the flag is absent in a pure Kortix deployment;
- keep the existing Marketplace catalog and project install routes as the
  external compatibility surface; use a module adapter behind them or expose
  additive project-module routes without changing old request/response
  shapes;
- do not fork or rename the existing `DeveloperModuleReleaseService` or
  `DeveloperModuleReviewService`; add distribution ports beside them.

When distribution is disabled, existing validated/reviewed releases and all
pre-existing Marketplace behavior remain unchanged. Enabling the flag does
not grant any additional IAM permission.

## 5. Trust and Signature Model

### 5.1 Signed payload

The signature covers a canonical UTF-8 JSON payload, not an unstable database
row:

```ts
interface DeveloperModuleSignaturePayload {
  schema: 1;
  module_id: string;
  module_version: string;
  publisher_id: string;
  manifest_digest: `sha256:${string}`;
}
```

The payload is canonicalized with the existing sorted-key JSON routine. The
manifest digest is the SHA-256 digest of the validated canonical manifest.
Any change to identity, version, publisher, schema, or manifest produces a
different payload and requires a new release.

### 5.2 Replaceable signing port

The domain depends on a narrow port and never on a KMS SDK:

```ts
interface ModuleSigningPort {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<`base64url:${string}`>;
  verify(payload: Uint8Array, signature: `base64url:${string}`): Promise<boolean>;
}
```

Production configuration supplies an implementation backed by KMS/HSM or a
secure signer service. The private key is never accepted in JSON, logged,
returned by the API, or stored in PostgreSQL. Tests use an in-memory Ed25519
key pair. A missing signer or an unknown/disabled verification key returns a
typed unavailable/invalid-signature error; the server never creates a fake
signature to keep a workflow moving.

The persisted attestation contains only `algorithm`, `key_id`, the detached
signature, the canonical payload digest, and `signed_at`. Publication verifies
the signature against the current immutable manifest before changing status.

### 5.3 Who may sign and publish

The first implementation exposes sign and publish as platform-admin actions.
The actor must be outside the publisher account, as with approval. The API
accepts only the release id and expected status/revision; signer selection and
key material are server-side configuration. Future automated publication can
use the same port and repository transaction without changing the wire model.

## 6. Lifecycle and State Rules

| From | To | Actor | Required checks |
| --- | --- | --- | --- |
| `approved` | `signed` | platform admin | distribution flag, expected revision, declarative eligibility, signer available, signature transaction |
| `signed` | `published` | platform admin | expected revision, stored signature verifies, compatibility contract still valid |
| `published` | `revoked` | platform admin | expected revision, bounded emergency reason |
| `published` | install | project member with project write | exact release id, signature/compatibility check, project IAM |
| `published` | update | project member with project write | exact target release id, expected installation revision, target not revoked |
| `published` | rollback target | project member with project write | target appears in installation history, target still published, expected installation revision |

`validated`, `review_pending`, and `changes_requested` continue to use the
existing Developer Center review service. `approved -> revoked` remains
available through the existing admin decision seam and is extended to signed
and published releases with the same revision fence. A revoked release never
returns to signed or published.

Every release lifecycle transition increments the existing release revision
and appends one immutable event. A stale expected status/revision returns
`409 DEVELOPER_REVIEW_CONFLICT` or the distribution-specific conflict code;
the client must refetch and must not replay the old command.

## 7. Data Model

### 7.1 Release signature metadata

Add nullable fields to `kortix.developer_module_releases`:

- `signature_algorithm` (`ed25519` when signed);
- `signature_key_id` (bounded non-secret identifier);
- `signature` (bounded base64url detached signature);
- `signature_payload_digest` (`sha256:` digest of canonical payload);
- `signed_at`, `published_at`, and `revoked_at` timestamps.

The manifest, manifest digest, module identity/version, publisher, review
requirements, creator, and creation timestamp remain immutable. A check
constraint requires all signature fields to be present together and requires
`published_at` only for `published` or `revoked` rows. Existing review rows
remain valid with all new fields null.

### 7.2 Immutable release lifecycle events

Create an additive
`developer_module_release_distribution_events` table. The existing review
event table and its action/actor enums remain unchanged. The new table uses:

```ts
type DeveloperModuleDistributionAction = 'sign' | 'publish' | 'revoke';
```

Each event stores release id, account id, sequence/revision, action, source
and target status, actor user id/kind, bounded reason, and timestamp. Event
rows are append-only and have a unique `(release_id, sequence)` constraint.
The publisher history endpoint returns the combined chronological view so a
publisher can see approval, signing, publication, and revocation without a
second timeline.

### 7.3 Project installation state

Add `kortix.project_module_installations`:

- `installation_id` UUID primary key;
- `project_id`, `account_id`, `module_id`, `active_release_id`;
- `active_version`, `install_revision`, `status` (`active` or `blocked`);
- `installed_by`, `created_at`, `updated_at`;
- unique `(project_id, module_id)` and foreign keys to the project/account
  boundary and the release identity.

Add append-only `kortix.project_module_installation_events`:

- event id, installation id, project/account ids;
- sequence, action (`install`, `update`, `rollback`);
- from-release id (nullable), to-release id, expected/resulting revision;
- actor user id and timestamp.

An installation row is the single active pointer; event rows preserve every
prior target. No version row or event is deleted during update or rollback.
Rollback selects only a release already present in the event history and
currently `published`; a revoked or merely signed release cannot be a target.

Revocation does not delete active installation history. Reads mark an active
pointer as `blocked` when its release is revoked, and capability/catalog
resolution excludes it from new execution. This avoids a destructive fan-out
while ensuring a revoked release cannot be newly installed, updated to, or
rolled back to.

## 8. Marketplace and Project Integration

The existing Marketplace remains the catalog and user-facing discovery
surface. A `DeveloperModuleMarketplaceAdapter` maps published declarative
release rows to the existing `registry:module` catalog shape, including the
release id and signature metadata needed for exact installation. It does not
copy private data or introduce a second catalog table.

Project installation uses the existing project/account loader and IAM checks.
The adapter handles only the declarative module branch; existing skill,
agent, command, tool, and project installs continue through their current
installer unchanged. The declarative branch records the module activation
pointer and lets the existing capability registry resolve the declared
platform-owned capability ids. It does not execute a package or write source
files.

Exact target release ids are required for install/update/rollback. A future
gallery may offer a convenient "latest" choice, but the API commits the
resolved release id and never performs an implicit floating upgrade.

## 9. REST and SDK Surface

### 9.1 Platform-admin distribution routes

```text
POST /v1/admin/developer/modules/releases/:releaseId/sign
POST /v1/admin/developer/modules/releases/:releaseId/publish
```

Bodies contain only `expected_status` and `expected_revision`. Revoke uses
the existing admin review-decision route with the extended status graph.

### 9.2 Project module routes

```text
GET  /v1/projects/:projectId/modules
POST /v1/projects/:projectId/modules/install
POST /v1/projects/:projectId/modules/:moduleId/update
POST /v1/projects/:projectId/modules/:moduleId/rollback
```

Install/update/rollback bodies contain an exact `release_id` and the current
`expected_install_revision`; the server derives `account_id` from the project
and honors an optional idempotency key. Repeating the same successful command
returns the existing resulting state. A same-revision command with a
different target returns `409 PROJECT_MODULE_INSTALL_CONFLICT`.

The canonical SDK adds project-scoped `modules.list`, `modules.install`,
`modules.update`, and `modules.rollback` methods. Admin sign/publish calls stay
in the private Admin client and are not added to the ordinary publisher SDK.

### 9.3 Stable errors

At minimum:

- `DEVELOPER_MODULE_SIGNER_UNAVAILABLE` (`503`);
- `DEVELOPER_MODULE_SIGNATURE_INVALID` (`409`);
- `DEVELOPER_MODULE_NOT_DISTRIBUTABLE` (`409`);
- `DEVELOPER_MODULE_NOT_PUBLISHED` (`409`);
- `DEVELOPER_MODULE_REVOKED` (`409`);
- `PROJECT_MODULE_INSTALL_CONFLICT` (`409`);
- `PROJECT_MODULE_ROLLBACK_TARGET_INVALID` (`409`);
- `PROJECT_MODULE_NOT_FOUND` (`404`).

Error responses contain codes and bounded public identifiers only. They never
echo private keys, signatures beyond the public detached value, credentials,
provider payloads, submitted source, or free-form reasons.

## 10. Failure and Recovery Rules

- Signing occurs before the fenced transaction; if the release changed while
  the signer was working, the signature is discarded and the caller receives
  a conflict. The command is never retried automatically.
- Publication re-verifies the stored signature and current manifest digest in
  the same transaction as the status update.
- Installation/update/rollback use a conditional update on
  `install_revision`; zero rows are classified as not-found or conflict by a
  safe follow-up read.
- Unknown transaction outcomes are reported as retryable only when the
  idempotency key can safely recover the committed result. No operation
  replays a stale expected revision.
- A failed or unavailable signer leaves the release exactly `approved`.
- A failed publication leaves the release exactly `signed`; it never creates
  a partially visible catalog entry.
- A failed install/update/rollback leaves the active pointer and history
  unchanged.

## 11. Verification Requirements

The implementation plan must use red-green-refactor and cover:

1. canonical signature payloads, Ed25519 verification, signer-unavailable,
   manifest tampering, declarative eligibility, and key rotation;
2. lifecycle transition tables, approval-to-sign fencing, publish replay,
   revocation, immutable event history, and no private-key persistence;
3. migration checks for signature consistency, append-only triggers, unique
   project/module pointers, composite tenant foreign keys, and rollback
   history;
4. transactional repository tests for stale revisions, duplicate/idempotent
   commands, cross-account access, revoked targets, and concurrent updates;
5. API tests for platform-admin, publisher, project IAM, feature-flag, and
   error-boundary behavior;
6. Marketplace adapter tests proving existing catalog/install behavior is
   unchanged and declarative modules resolve by exact release id;
7. SDK transport and public-surface tests for project module methods;
8. focused package tests, TypeScript, formatting, migration lint/integration,
   route parity, `git diff --check`, and protected-file verification.

No claim of executable module runtime, arbitrary package safety, revenue
settlement, or production deployment is allowed without separate direct
evidence.

## 12. Rejected Alternatives

### Store private keys in the API or database

Rejected because a database compromise would become a marketplace signing
compromise. The signing port keeps key custody outside the application.

### Sign only a release id

Rejected because an id alone does not bind the manifest, publisher, or version.
The canonical payload binds all immutable identity and content fields.

### Create a second module marketplace

Rejected because it would duplicate catalog discovery, permissions, and
upstream integration. Published modules are an additive source/adapter in the
existing Marketplace.

### Install arbitrary files in the first phase

Rejected because the current review slice has no automated scan, sandbox, or
artifact provenance path. Declarative-only installation is the smallest useful
closed loop that does not silently trust executable code.

### Delete or silently replace project history on rollback

Rejected because rollback is an auditable pointer change. Historical releases
and events remain available, while revoked targets are blocked.
