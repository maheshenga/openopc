# OpenOPC Developer Module Review Design

- **Date:** 2026-07-24
- **Status:** Architecture direction approved; written specification pending review
- **Scope:** Account-scoped review requests, platform-admin decisions, immutable decision history, and typed API/SDK seams
- **Base:** The durable developer module release foundation in commit `78ebf4f06`

## 1. Decision

Developer module review is a dedicated account-scoped lifecycle layered on
`developer_module_releases`. It does not store records in the project-scoped
`review_items` table and does not require a synthetic project.

The publisher and reviewer are deliberately separate principals:

- a publisher account may submit a validated release for review and respond to
  requested changes;
- only an authenticated OpenOPC platform administrator may approve, request
  changes, or revoke approval;
- a platform administrator may not approve a release owned by an account of
  which they are a current member, including a release they created.

Every state change appends an immutable decision event in the same transaction
as the release status update. A revision fence makes concurrent or stale
decisions fail with `409` instead of silently overwriting one another.

The existing project Review Center remains unchanged. Future Web pages may
reuse its visual components through an adapter, but its database table, routes,
project IAM actions, and SDK types remain authoritative only for project work.

## 2. Why the Project Review Center Is Not the Storage Model

`review_items.project_id` is non-null and its relations, indexes, routes, SDK,
and permissions all require a real project. A developer module release instead
belongs to an account and a global publisher namespace. Binding a release to an
arbitrary project would create false ownership, make platform review depend on
project membership, and complicate later marketplace operations.

Generalizing the whole Review Center to account and project scopes would touch
an established Kortix surface and create a much larger upstream merge and
regression area. A small additive Developer Center subsystem preserves the
correct domain boundary and Kortix upgrade compatibility.

## 3. Goals

1. Allow an authorized publisher account to request review for an immutable,
   validated module release.
2. Allow a platform administrator to request changes, approve, or urgently
   revoke an approval without allowing publisher self-approval.
3. Preserve a complete immutable history containing actor, reason, transition,
   evidence snapshot, revision, and timestamp.
4. Reject stale decisions deterministically through optimistic concurrency.
5. Keep publisher reads tenant-scoped and platform-review reads behind the
   existing `requireAdmin` boundary.
6. Expose stable typed domain, REST, and SDK contracts without creating a
   second catalog or changing Kortix project Review Center contracts.
7. Represent manual evidence honestly so no API or UI claims an automated
   source scan or sandbox run occurred.

## 4. Non-goals

This slice does not:

- execute source scanning, sandbox testing, permission analysis, or desktop
  security testing;
- sign, publish, install, roll back, meter, or settle module releases;
- copy packages, source code, scan logs, provider bodies, credentials, or
  signing keys into PostgreSQL;
- add first-party video, voice, 3D, digital-human, or batch-remix pages;
- generalize `review_items` to an account scope;
- add the production Developer Center or Admin review Web pages;
- claim marketplace readiness, browser acceptance, live production approval,
  or deployment readiness.

## 5. Lifecycle

The first lifecycle slice permits only these transitions:

```text
validated ---------> review_pending
                         |       \
                         |        +------> approved -----> revoked
                         v
                 changes_requested
                         |
                         +-------------> review_pending
```

Transition authority and requirements:

| From | To | Actor | Requirements |
| --- | --- | --- | --- |
| `validated` | `review_pending` | publisher principal with `account.write` | current revision and optional submission note |
| `changes_requested` | `review_pending` | publisher principal with `account.write` | current revision and a bounded response explaining what changed |
| `review_pending` | `changes_requested` | platform admin | current revision and non-empty reason |
| `review_pending` | `approved` | platform admin outside the publisher account | current revision and one explicit manual pass attestation for every declared review requirement |
| `approved` | `revoked` | platform admin | current revision and non-empty emergency reason |

`signed`, `published`, and `deprecated` remain reserved. This service must not
transition to or from them.

Because the release manifest and module version are immutable, any manifest or
package-content change requires a new semantic version and a new release. The
`changes_requested -> review_pending` path is only for responses that do not
alter the persisted release, such as documentation, external evidence, or an
explanation requested by the reviewer. The API and future UI must state this
constraint explicitly.

## 6. Evidence Contract

Every release currently requires at least `manifest_review`, `source_scan`, and
`human_review`; some releases also require sandbox, permission, or desktop
security review. Approval must not imply those checks ran automatically.

For this slice, approval accepts a strict evidence snapshot:

```ts
interface DeveloperModuleReviewEvidence {
  requirement: DeveloperModuleReviewRequirement;
  outcome: 'passed';
  method: 'manual';
  summary: string;
  observed_at: string;
  tool?: string;
  tool_version?: string;
  evidence_digest?: `sha256:${string}`;
}
```

Rules:

- exactly one entry is required for every value in
  `release.review_requirements` and no undeclared requirement is accepted;
- entries are strictly validated, deduplicated, bounded in count and byte size,
  and stored with the approval event;
- `summary` describes the redacted conclusion, not raw logs; free-form text is
  length/control-character constrained and rejected when it matches supported
  credential-bearing patterns;
- `observed_at` must be a valid non-future timestamp at or after release
  creation, while `tool` and `tool_version` accept only bounded identifiers;
- `evidence_digest` may bind an external artifact without storing that artifact;
- URLs, headers, tokens, provider payloads, source archives, and log bodies are
  rejected from the evidence shape;
- the only accepted method in this slice is `manual` and all responses/UI labels
  must display it as a manual attestation.

Future scan and sandbox workers may add `automated` evidence through a separate,
reviewed ingestion path. Merely defining the future type does not enable that
path now.

## 7. Data Model

### 7.1 Release revision

Add `review_revision integer not null default 0` to
`developer_module_releases`, with a non-negative check. Add a unique constraint
on `(release_id, account_id)` so child records can enforce tenant identity with
a composite foreign key.

The manifest, digest, module identity, version, publisher, requirements,
creator, and creation timestamp remain immutable. Only `status`,
`review_revision`, and `updated_at` may change through the review repository.

### 7.2 Immutable transition events

Add `developer_module_release_review_events`:

| Column | Contract |
| --- | --- |
| `review_event_id` | UUID primary key |
| `release_id`, `account_id` | non-null composite FK to the owning release, delete restricted |
| `sequence` | positive integer, unique per release and equal to resulting release revision |
| `action` | `submit`, `resubmit`, `request_changes`, `approve`, or `revoke` |
| `from_status`, `to_status` | release status enum, constrained to the allowed transition graph |
| `actor_user_id` | authenticated user UUID |
| `actor_kind` | `publisher` or `platform_admin` |
| `reason` | bounded text; required where the lifecycle table requires it |
| `evidence` | strict bounded JSON array; normally empty except for approval |
| `created_at` | database timestamp, immutable |

Indexes support publisher history by `(account_id, release_id, sequence)`. Add
a parent-table queue index beginning with `(status, updated_at, release_id)` for
bounded global admin review scans. Database triggers reject event updates and
reject updates to immutable release content. Event rows cascade only as part of
the existing account/release deletion lifecycle; the API repository exposes no
direct event-delete operation.

### 7.3 Transaction and concurrency fence

Each command receives `expected_status` and `expected_revision`. One database
transaction:

1. conditionally updates the account/release row only when both expectations
   match;
2. increments `review_revision` and returns the resulting revision;
3. inserts exactly one transition event using that revision as `sequence`;
4. commits both changes together.

Zero updated rows are re-read safely to distinguish `404` from a stale or
invalid transition `409`. A unique `(release_id, sequence)` constraint is the
final replay fence. No transition is retried automatically after an unknown
transaction outcome.

## 8. Authorization and Trust Boundaries

### 8.1 Publisher routes

Publisher routes remain under `/v1/developer` and resolve the account through
the existing scoped-account boundary.

- list/get/history require `ACCOUNT_ACTIONS.ACCOUNT_READ`;
- release submission and review request/resubmission require
  `ACCOUNT_ACTIONS.ACCOUNT_WRITE`;
- a mismatched token-bound account remains `403`;
- a release outside the resolved account returns `404`;
- plain account membership alone is not sufficient for mutations.

This slice also hardens the existing release endpoints with these IAM checks;
the current authentication-only behavior is not retained.

### 8.2 Platform-review routes

Reviewer routes are an isolated sub-app mounted under `/v1/admin/developer` and
use the existing `supabaseAuth + requireAdmin` middleware. A publisher's account
role never grants these operations. Platform-admin reads may span accounts, but
every decision derives and records the release's real `account_id`.

Approval is denied when the actor is a current member of the release's
publisher account, even if that actor is also a platform administrator. This
strictly includes the release creator. Requesting changes and revocation remain
platform-admin actions and cannot be called through publisher routes.

### 8.3 Audit

The immutable review event is the authoritative decision record. After commit,
the existing account audit pipeline receives a supplemental event such as
`developer.module.review.approved`, with the release as the resource and only
bounded status/revision metadata. General audit delivery remains best-effort;
failure to deliver a webhook does not roll back the already durable decision.

## 9. REST Surface

### Publisher-facing

```text
POST /v1/developer/modules/releases/:releaseId/review-requests
GET  /v1/developer/modules/releases/:releaseId/review-history
```

Request review body:

```json
{
  "account_id": "optional scoped account UUID",
  "expected_status": "validated",
  "expected_revision": 0,
  "reason": "Ready for platform review"
}
```

The same endpoint accepts `expected_status: "changes_requested"` for a bounded
response/resubmission. The response contains the updated release and appended
event.

### Platform-admin-facing

```text
GET  /v1/admin/developer/modules/reviews?status=review_pending&cursor=&limit=
GET  /v1/admin/developer/modules/releases/:releaseId/review
POST /v1/admin/developer/modules/releases/:releaseId/review-decisions
```

The decision body contains `decision`, `expected_status`, `expected_revision`,
`reason`, and, for approval, the strict manual `evidence` snapshot. Admin list
uses bounded keyset pagination; it never relies on publisher-supplied account
filters for authorization.

Stable public errors include:

- `DEVELOPER_RELEASE_NOT_FOUND` (`404`);
- `DEVELOPER_REVIEW_TRANSITION_INVALID` (`409`);
- `DEVELOPER_REVIEW_CONFLICT` (`409`);
- `DEVELOPER_REVIEW_REASON_REQUIRED` (`400`);
- `DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE` (`400`);
- `DEVELOPER_REVIEW_SELF_APPROVAL_DENIED` (`403`).

Error bodies contain codes only and never echo reasons, evidence, manifests, or
submitted values. Stored reasons use the same bounded text and supported
credential-pattern rejection as evidence summaries.

## 10. SDK and Web Integration Seam

The canonical SDK extends the existing facade without changing project review:

```ts
kortix.developer.modules.releases.requestReview(releaseId, input)
kortix.developer.modules.releases.reviewHistory(releaseId, options)
```

Platform-admin calls remain in the Admin console's authenticated internal API
client rather than being exposed as ordinary publisher SDK methods.

A later Web slice adds:

- Developer Center release status/history and request-review actions;
- Admin module review queue and decision detail;
- a view adapter that reuses Review Center row, badge, detail, and empty-state
  components without importing project review hooks or `ApiReviewItem` types.

The same Web routes render in a browser or Electron. No desktop-specific review
business logic is introduced.

## 11. Implementation Shape

Keep the change additive and isolated:

- domain state machine and memory repository extensions in `apps/api/src/developer`;
- a dedicated Drizzle review repository and tests;
- one additive schema block and migration in `packages/db`;
- a small publisher route extension in the existing Developer app;
- a new Admin developer-review sub-app with one mount seam;
- additive SDK methods and snapshots;
- route coverage and progress-ledger updates.

Do not modify project Review Center storage, project review routes, its SDK
client, or its Web hooks. Internal `@kortix/*`, `kortix` schema, environment,
protocol, and route compatibility names remain unchanged; OpenOPC remains the
visible product brand.

## 12. Verification Requirements

The implementation plan must use red-green-refactor and include:

1. domain transition-table, evidence, reason, self-approval, clone-safety, and
   stale-revision tests;
2. schema, migration, append-only trigger, composite-FK, and revision checks;
3. Drizzle transactional atomicity, replay, concurrent-decision, tenant, and
   publisher-account/reviewer separation tests;
4. publisher authentication/IAM/account-isolation API tests;
5. platform-admin/non-admin/self-approval API tests;
6. SDK transport/facade and public-surface snapshots;
7. generated route parity and anonymous-boundary coverage;
8. focused package suites, typechecks, formatting, migration lint, and
   PostgreSQL migration integration;
9. the restored wider test commands, with pre-existing unrelated failures
   classified separately rather than reported as this slice passing;
10. protected-file, diff, and worktree verification before commit.

No browser, production, automated-scan, sandbox, signing, publication,
installation, metering, settlement, or deployment claim is allowed without its
own direct evidence.

## 13. Rejected Alternatives

### Bind releases to a project

Rejected because it invents false project ownership and makes platform module
governance depend on project IAM and lifecycle.

### Generalize Review Center to account/project scope now

Rejected because it changes a mature Kortix core surface, expands migration and
SDK compatibility risk, and is unnecessary for the release lifecycle.

### Let publisher account admins approve

Rejected because it collapses uploader and marketplace reviewer into the same
trust domain and permits self-approval.

### Approve without evidence attestations

Rejected because all current releases require source scan and human review;
setting `approved` without an explicit, honestly labelled evidence snapshot
would overstate what the platform verified.
