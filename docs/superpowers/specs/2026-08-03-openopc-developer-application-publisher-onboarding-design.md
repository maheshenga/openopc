# OpenOPC Developer Application and Publisher Onboarding Design

**Date:** 2026-08-03

**Status:** Approved design; written-spec review pending; implementation not started

## Goal

Complete the smallest developer-onboarding flow required for the OpenOPC Web
and Windows Desktop public beta:

1. A platform administrator can discover and inspect developer applications.
2. The platform owner can approve, reject, or suspend an application, including
   an application submitted by the same user.
3. An approved developer can create and select a Publisher without manually
   copying a Publisher ID.
4. Module package submission uses an account-scoped Publisher selection.

This work completes admission and Publisher onboarding. It does not add a new
developer identity system, a second review pipeline, or a fixed set of module
product categories.

## Existing Baseline

The implementation must extend the existing boundaries:

- `apps/api/src/developer/applications.ts` owns developer-application state,
  revision fencing, policy acceptance, organization verification, and audit
  events.
- `apps/api/src/admin/developer-applications.ts` already exposes revision-fenced
  approve, reject, and suspend mutations protected by
  `developer.application.review` and AAL2 step-up authorization.
- `apps/api/src/developer/publishers.ts` already enforces verified organization
  and approved application requirements before Publisher creation.
- `apps/api/src/developer/app.ts` already exposes developer access, Publisher
  create, and Publisher list routes.
- `packages/sdk/src/core/rest/projects-client/developer-modules.ts` already
  exports `getDeveloperAccess`, `createDeveloperPublisher`, and
  `listDeveloperPublishers`.
- `apps/admin/src/features/developer-center/*` provides the established Admin
  queue, detail, stable-error, query-cache, and conflict-recovery patterns.
- `apps/web/src/features/developer-center/application/developer-application-page.tsx`
  already renders the applicant-facing state machine.
- `apps/web/src/features/developer-center/publisher/submit-page.tsx` currently
  asks the developer to type a Publisher ID for package submission.

The existing database tables already contain the required application,
organization, policy-acceptance, and audit data. No schema migration is expected
for this work.

## Chosen Approach

Add an independent developer-application review surface and reuse the existing
Publisher service and SDK for onboarding.

The application review lifecycle remains separate from module release review.
The two workflows have different subjects, state machines, permissions, and
operator decisions, so they must not share one queue or one domain service.

Admin code must use the application service and repository instead of querying
Drizzle tables directly. Web code must use `@kortix/sdk` rather than adding raw
HTTP calls or a second developer client.

## Admin Application Read Model

Extend the developer-application repository and service with bounded Admin read
operations. The public shapes are:

```ts
interface DeveloperApplicationAdminListItem {
  application: DeveloperApplication;
  organization: DeveloperOrganization;
}

interface DeveloperApplicationAdminPage {
  applications: DeveloperApplicationAdminListItem[];
  next_cursor: string | null;
}

interface DeveloperApplicationAdminDetail {
  application: DeveloperApplication;
  organization: DeveloperOrganization;
  policy_acceptances: DeveloperApplicationPolicyAcceptance[];
  history: DeveloperApplicationAuditEvent[];
}
```

The repository supplies an Admin list and an exact Admin lookup. The service
normalizes list bounds, translates missing records into the existing stable
error vocabulary, and assembles policy acceptance and immutable history for the
detail response.

The in-memory and Drizzle repositories must implement identical ordering and
cursor semantics:

- filter by one `DeveloperApplicationState`;
- default state `submitted`;
- default limit `50`, bounded to `1..100`;
- descending order by `updated_at`, then `application_id`;
- opaque base64url cursor containing only the last `updated_at` and
  `application_id`;
- malformed, unknown, or structurally invalid cursors fail with
  `DEVELOPER_APPLICATION_INPUT_INVALID`.

## Admin HTTP Contract

Add these routes inside the existing Admin application:

```text
GET /admin/developer/applications
GET /admin/developer/applications/{applicationId}
```

The list accepts `state`, `limit`, and `cursor`. The detail returns the exact
application, organization, policy acceptances, and audit history. The existing
mutation routes remain authoritative:

```text
POST /admin/developer/applications/{applicationId}/decision
POST /admin/developer/applications/{applicationId}/suspend
```

Read requests require the exact `developer.application.review` permission but
do not require AAL2. Detail reads resolve the target account before applying the
cross-tenant Admin audit boundary. Decision and suspension requests continue to
require AAL2 and `expected_revision`.

Approve, reject, and suspend all require a non-empty bounded reason. An approval
may leave `decision_reason` empty on the current application record, but its
reason remains mandatory and durable in the audit event.

The platform administrator may be the application's `created_by` user. No
independent-reviewer, different-user, or separation-of-duties check is added.
The action remains restricted to a platform administrator with the exact
permission and current AAL2 step-up session.

## Admin User Interface

Add independent Admin routes:

```text
/developer-applications
/developer-applications/{applicationId}
```

Add a distinct Developer Applications item to the Admin sidebar. Do not merge it
with the existing Module Reviews item.

The queue follows the current module-review page conventions:

- status controls for submitted, under-review, approved, rejected, and
  suspended applications;
- loaded-page search over organization name, account ID, and application ID;
- organization, state, revision, submitted date, and updated date columns;
- loading, empty, malformed-cursor, forbidden, and dependency-error states;
- opaque next-page navigation with a reset-to-first-page recovery action.

The detail page shows:

- application and organization identity;
- application state and revision;
- organization verification state and revision;
- accepted policy names, versions, users, and timestamps;
- immutable application audit history;
- a required reason field;
- approve and reject actions for submitted or under-review applications;
- suspend action only for an approved application.

After a `409` conflict the page removes the stale detail, fetches the latest
revision, and asks the administrator to make a new decision. It never replays a
previous mutation automatically.

## Web Publisher Onboarding

When the current application is approved, the application page loads
`getDeveloperAccess({ accountId })`. This one account-scoped response is the
source of truth for the verified organization, existing Publishers, and the
current user's Publisher membership.

If no selectable Publisher exists, show a Publisher creation form with:

- Publisher slug;
- display name;
- the approved organization ID supplied from developer access, not editable by
  the user.

Creation calls the existing `createDeveloperPublisher` SDK function. The server
remains authoritative for slug normalization, global uniqueness, organization
verification, approved application state, and account authorization. A
successful mutation refreshes developer access and selects the new Publisher.

If Publishers exist, show an option menu rather than free-form text, plus a
bounded Create another Publisher command that opens the same creation form. A
Publisher is selectable only when it is active and the developer-access response
contains an `owner` membership for the current user. The server's Publisher
permission check remains authoritative for every release mutation.

One selectable Publisher is chosen automatically. With multiple selectable
Publishers, the developer must make an explicit choice. Publisher selection is
scoped to the selected account and resets when the account changes. This design
does not add a durable cross-account preference.

The public-beta UI supports the current user as the Publisher owner. It does not
add invitation, member-role, finance, support, or team-management controls.
Existing backend capabilities remain intact but are not exposed by this slice.

## Module Submission Integration

Replace the package-upload Publisher ID input with the same account-scoped
Publisher option menu. The selected Publisher ID is passed unchanged into the
existing artifact and release submission flow.

The control is disabled while an upload is active. Submission remains disabled
until a package and one valid Publisher are selected. If no selectable
Publisher exists, the page directs the developer to complete the approved
application and Publisher creation flow instead of accepting arbitrary text.

The server continues to reject artifact, manifest, account, or Publisher
mismatches. The UI selection is an ergonomic improvement, not a replacement for
server authorization.

## Error Handling

Only stable platform error codes may cross the Admin and Web client boundaries.
Arbitrary provider, database, or exception text is discarded.

Required outcomes include:

- invalid input or cursor: `400`;
- missing application or organization: `404`;
- missing permission or stale AAL2 step-up: `403`;
- stale revision or invalid state transition: `409`;
- application dependency failure: `503`;
- Publisher slug conflict or application/verification requirement: the existing
  stable Publisher error code and status.

The UI presents bounded user-facing messages and an explicit reload or retry
action. It never exposes raw identifiers as an error message and never retries a
decision mutation automatically.

## Testing Strategy

Implementation uses strict test-first development. Each behavior begins with a
focused failing test and a confirmed RED result before production changes.

API coverage must include:

- service normalization and exact detail assembly;
- in-memory pagination, filtering, deterministic cursor ordering, and malformed
  cursor rejection;
- Drizzle list/detail queries with account-safe organization joins;
- read permission behavior without AAL2;
- decision and suspension behavior with AAL2;
- platform-owner self-approval;
- required reasons, revision conflicts, missing records, and stable errors;
- audit history and policy-acceptance detail output.

Admin coverage must include:

- exact list, detail, decision, and suspension transport contracts;
- stable error extraction without raw-message leakage;
- query-key isolation by state and cursor;
- queue loading, empty, search, pagination, and reset states;
- detail action gating and conflict reload behavior;
- sidebar and route availability.

Web coverage must include:

- approved application access loading;
- no-Publisher creation form;
- successful creation refresh and selection;
- one-Publisher automatic selection;
- multiple-Publisher explicit selection;
- inactive or membership-free Publisher exclusion;
- account-switch selection reset;
- package submission using the selected Publisher and no free-form Publisher ID.

Run focused API, Admin, Web, and SDK regression tests plus the relevant package
type checks. The known pre-existing Web `fetch` test-stub type errors remain a
separate work package unless a changed file causes or depends on them. Do not
suppress, ignore, or weaken those errors; record the full type-check result and
prove whether changed files are implicated.

## Acceptance Flow

The work is accepted locally when all of the following pass on one candidate
commit:

1. A developer submits an application for the selected account.
2. The application appears in the Admin submitted queue.
3. The platform owner opens the detail and approves it with a reason and the
   current revision.
4. The applicant sees the approved state without manual data repair.
5. The applicant creates a Publisher for the verified organization.
6. The Publisher appears in the account-scoped selection.
7. Module package submission sends the selected Publisher ID.
8. A stale Admin decision is rejected and the latest revision is reloaded.
9. Missing permission and missing AAL2 block the appropriate read or mutation
   operation.
10. Audit records identify the acting administrator, reason, timestamp, and
    state transition, including platform-owner self-review.

## Explicit Exclusions

- deployment, DNS, custom-domain validation, or production smoke tests;
- developer invitations and Publisher member management;
- independent reviewer assignment or reviewer separation of duties;
- new AI, payment, marketplace, or module-runtime behavior;
- database schema changes unless implementation proves an existing-table
  contract is insufficient;
- changes to Desktop packaging or release workflows;
- Git push, pull request, merge, or public-beta readiness claims.
