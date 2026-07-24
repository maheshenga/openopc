# OpenOPC Developer Center Web Review UI Design

**Date:** 2026-07-24

**Status:** Approved for implementation planning

**Scope:** Web publisher and platform-admin interfaces for the existing governed developer-module review lifecycle

## 1. Context

The Developer Center backend already provides:

- strict Registry Module validation;
- immutable, account-scoped developer-module releases;
- publisher review requests and resubmissions;
- platform-admin request-changes, approval, and emergency-revocation decisions;
- manual evidence requirements;
- immutable review history;
- status plus `review_revision` compare-and-swap fencing;
- account IAM and platform-admin authorization boundaries.

The next slice makes that lifecycle usable from the Web application. It does not create a second catalog, review engine, or authorization model. Git-native `@kortix/registry` data remains canonical, and the existing API remains the sole business-rules boundary.

OpenOPC is the visible product brand on the new surfaces. Existing `@kortix/*` package names, schemas, protocols, routes, and database objects remain unchanged to preserve compatibility with future Kortix upgrades.

## 2. Goals

1. Let an authorized publisher validate and submit one Registry Module version from the Web application.
2. Let the publisher inspect recent releases, review requirements, current state, and immutable history.
3. Let an authorized publisher request review or resubmit after changes are requested.
4. Let a platform administrator work a status-filtered global review queue.
5. Let a platform administrator record complete manual evidence and make a request-changes, approval, or emergency-revocation decision.
6. Preserve account isolation, platform-admin isolation, revision fencing, stable errors, and immutable history through the UI.
7. Keep the Web addition isolated and additive so upstream Kortix updates remain easy to merge.

## 3. Non-goals

This slice does not add:

- automated source scanning or sandbox execution;
- package signing, publication, installation, or rollback;
- usage metering, revenue sharing, or settlement;
- server-side full-text search or a new search index;
- a new marketplace or database catalog;
- public SDK access to platform-admin operations;
- changes to the existing Kortix Review Center;
- first-party video, voice, 3D, digital-human, or batch-remix product pages;
- Android or iOS Developer Center surfaces;
- global rebranding or internal package renaming.

## 4. Chosen Interaction Model

The selected information architecture is **list plus independent detail page**.

This model is preferred over a detail drawer or a three-column review shell because it provides:

- stable, shareable detail URLs;
- natural browser refresh, back, and forward behavior;
- enough space for structured manifests, evidence, and long histories;
- a clean path for later automated scan results;
- less intrusion into the existing Web and Admin shells.

Publisher and administrator pages share presentational primitives but never share privileged data hooks or mutations.

## 5. Page and Navigation Architecture

### 5.1 Publisher surfaces

| Web route | Responsibility |
| --- | --- |
| `/developer/modules` | Recent account-scoped releases, loaded-result search, status filtering, and the submit entry point |
| `/developer/modules/submit` | Upload or paste a Registry Item, validate it, inspect its summary, and submit it |
| `/developer/modules/[releaseId]` | Release summary, requirements, immutable history, and legal publisher actions |

The primary application navigation gains one additive **Developer Center** item. The page resolves the active account through the existing account context and does not accept an untrusted account identifier as authoritative state.

### 5.2 Platform-admin surfaces

| Web route | Responsibility |
| --- | --- |
| `/admin/developer-reviews` | Global, status-filtered, cursor-paginated review queue |
| `/admin/developer-reviews/[releaseId]` | Release detail, structured manifest, evidence form, decision actions, and immutable history |

The Admin sidebar gains one additive **Module Reviews** item. The existing Admin layout remains the page-entry guard. The existing API Admin middleware remains the final authorization boundary.

### 5.3 Source organization

New feature code is concentrated under:

```text
apps/web/src/features/developer-center/
  api/
  components/
  hooks/
  publisher/
  admin/
  types/
  utils/
```

Next.js route files stay thin and compose feature-level page components. Existing navigation files receive only the minimum additive entries. No existing Review Center module is modified or repurposed.

User-visible copy uses an isolated `developerCenter` namespace in the existing localization system. New page components do not add a second translation mechanism.

## 6. Publisher Experience

### 6.1 Release list

The publisher list contains:

- page title and concise lifecycle explanation;
- a primary **Submit new version** action for callers with `account.write`;
- text search over the currently loaded rows;
- status chips over the currently loaded rows;
- a table with module name, module ID, version, status, revision, and updated time;
- loading, empty, permission-denied, and recoverable-error states.

The existing publisher list API returns at most 100 releases and has no cursor. This slice requests the latest 100 and labels the surface **Recent releases**. It must not display an all-time total or imply that client-side search covers releases that were not loaded. Publisher pagination and server-side search are deferred explicitly.

Selecting a row navigates to the independent release detail URL.

### 6.2 Submit flow

Submission uses three explicit stages:

1. **Input:** upload a JSON file or paste JSON text.
2. **Validate:** parse locally, then call the existing module validation API. Validation issues are shown by path and severity.
3. **Confirm:** display publisher, module ID, version, execution mode, permissions, and review requirements before persistence.

The upload remains in page memory. It is not written to a query string, LocalStorage, browser logs, or analytics events. Upload and pasted JSON input are both limited to 1 MiB of UTF-8 data before parsing. This is a browser-safety bound for a manifest document, not a new package-upload contract; the API remains authoritative for request validation.

A validation error never advances to confirmation. A successful validation does not persist anything. Persistence begins only when the user confirms submission through the existing release submission API.

### 6.3 Publisher detail

The detail page shows:

- identity and status summary;
- manifest digest and immutable version metadata;
- structured, read-only manifest sections;
- declared review requirements;
- chronological review history;
- the one legal publisher action for the current state, if any.

Legal publisher actions are:

| Current status | UI action |
| --- | --- |
| `validated` | Request review |
| `changes_requested` | Resubmit for review with an optional bounded explanation |
| all other statuses | Read-only |

The UI derives the action from server state but does not replace API transition validation.

## 7. Platform-admin Experience

### 7.1 Review queue

The Admin queue contains:

- status tabs backed by the existing required `status` query;
- cursor pagination using `next_cursor`;
- loaded-page text filtering for fast local narrowing;
- module, publisher, account, version, updated time, revision, and deterministic requirement indicators;
- loading, empty, permission-revoked, malformed-cursor, and recoverable-error states.

The UI does not invent an AI risk score. Any visible complexity indicator is derived only from declared requirements such as sandbox testing, permission review, and desktop security review.

### 7.2 Review detail

The Admin detail page contains:

- release identity and lifecycle summary;
- structured, read-only manifest and permissions;
- one evidence editor for each declared review requirement;
- decision controls;
- immutable review history.

Approval evidence follows the backend contract exactly:

- one evidence entry for every declared requirement;
- `outcome` fixed to `passed`;
- `method` fixed to `manual`;
- a required bounded summary;
- an observed timestamp defaulted to the current time and editable by the reviewer;
- optional tool, tool version, and SHA-256 evidence digest.

If a requirement did not pass, the administrator uses **Request changes** instead of creating failed approval evidence.

### 7.3 Admin decisions

| Decision | UI requirement |
| --- | --- |
| Request changes | Required bounded reason; approval evidence is not submitted |
| Approve | Exactly one complete manual passed evidence entry per declared requirement |
| Revoke | Destructive confirmation plus required bounded reason |

The approval button remains disabled until all client-visible evidence requirements are complete. The API still performs the authoritative completeness, self-approval, membership, transition, secret-pattern, and revision checks.

Emergency revocation uses an explicit confirmation dialog that names the module and version. A generic confirmation toast is insufficient for this destructive action.

## 8. Shared Presentation Components

The feature may share only privilege-neutral components, including:

- `DeveloperModuleStatusBadge`;
- `DeveloperModuleIdentity`;
- `DeveloperModuleManifestView`;
- `DeveloperModuleRequirements`;
- `DeveloperModuleReviewTimeline`;
- loading, empty, and error-state primitives;
- stable error-code-to-copy mapping.

Publisher and platform-admin query hooks, mutation hooks, forms, and action components remain separate. A publisher bundle must not import an Admin decision client.

The visual language follows the existing Google-style OpenOPC direction: restrained surfaces, clear hierarchy, compact tables, visible state, one primary action per page, and progressive disclosure for manifest detail.

## 9. Client Boundaries and Data Flow

### 9.1 Publisher client

Publisher pages use the existing public `@kortix/sdk` methods:

- `validateDeveloperModule`;
- `submitDeveloperModuleRelease`;
- `listDeveloperModuleReleases`;
- `getDeveloperModuleRelease`;
- `requestDeveloperModuleReview`;
- `getDeveloperModuleReviewHistory`.

The Web application does not duplicate publisher REST request construction.

Publisher query keys include the active `accountId`:

```text
developer-modules / account / {accountId} / list
developer-modules / account / {accountId} / detail / {releaseId}
developer-modules / account / {accountId} / history / {releaseId}
```

Changing accounts clears or isolates every account-scoped query before the new account renders.

### 9.2 Admin client

Admin operations are intentionally absent from the public SDK. The Web Admin feature follows existing Admin hooks and uses the internal `backendApi` client for routes mounted under the existing Admin API prefix:

- `GET /developer/modules/reviews`;
- `GET /developer/modules/releases/{releaseId}/review`;
- `POST /developer/modules/releases/{releaseId}/review-decisions`.

The host Admin prefix remains defined by the existing Admin router; the feature does not hard-code a second API origin.

Admin query keys are separate from publisher keys:

```text
admin-developer-reviews / list / {status} / {cursor}
admin-developer-reviews / detail / {releaseId}
```

### 9.3 Mutation semantics

Every publisher or Admin transition uses the `status` and `review_revision` returned by the most recent successful server read. The browser does not synthesize a revision.

On success:

- replace the matching detail with the returned release;
- append or refetch history from authoritative data;
- invalidate affected publisher lists or Admin queues.

The UI does not optimistically display a lifecycle transition before the API accepts it.

On `DEVELOPER_REVIEW_CONFLICT` or HTTP 409:

1. stop the mutation;
2. discard the stale decision payload;
3. refetch the detail and history;
4. show that another actor updated the release;
5. require the user to inspect and submit a new decision.

The browser never automatically replays a review decision.

## 10. Authorization, Privacy, and Trust Boundaries

- `account.read` governs publisher release reads.
- `account.write` governs release submission and review requests.
- UI capability checks control discoverability and disabled states only; API IAM remains authoritative.
- Platform-admin pages use the existing Admin layout and role-revocation behavior.
- Platform-admin API middleware remains authoritative even if a page URL is reached directly.
- Account IDs are part of publisher cache keys and requests but never substitute for server membership checks.
- Uploaded JSON, reasons, and evidence are excluded from URLs, persistent browser storage, analytics, and general logs.
- Error UI never echoes rejected manifest values or server internals.
- Admin operations are not exported from `@kortix/sdk` or attached to the public `kortix.developer` client.
- No client component receives database credentials, provider credentials, signing keys, or registry write credentials.

## 11. Error Handling

Known stable API codes map to localized, action-oriented messages. Examples include:

| Error code | UI behavior |
| --- | --- |
| `DEVELOPER_MODULE_INVALID` | Return to validation results and identify invalid paths without echoing secrets |
| `DEVELOPER_PUBLISHER_MISMATCH` | Explain that the module ID must use the declared publisher namespace |
| `DEVELOPER_PUBLISHER_CONFLICT` | Explain that the publisher ID belongs to another account |
| `DEVELOPER_MODULE_VERSION_CONFLICT` | Explain that this version already exists with different content |
| `DEVELOPER_RELEASE_NOT_FOUND` | Show a not-found state without revealing whether another account owns it |
| `DEVELOPER_REVIEW_REASON_REQUIRED` | Focus the reason field |
| `DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE` | Mark incomplete requirement editors |
| `DEVELOPER_REVIEW_SELF_APPROVAL_DENIED` | Explain the independent-review requirement |
| `DEVELOPER_REVIEW_TRANSITION_INVALID` | Refetch and show the current legal state |
| `DEVELOPER_REVIEW_CONFLICT` | Run the explicit conflict recovery flow |

Authentication and authorization failures use the existing Web session and Admin-role handling. Unknown failures show a generic retry message and include the standard request identifier only when the existing response envelope or headers provide one. The client never invents an identifier.

## 12. Upstream Compatibility

The implementation must:

- add isolated route and feature files instead of rewriting existing large pages;
- keep navigation diffs additive and minimal;
- reuse the existing App Router, React Query, UI primitives, localization, SDK, and Admin client conventions;
- preserve public SDK method names and response contracts;
- avoid new database migrations and backend lifecycle rules in this slice;
- avoid global theme or shell refactors;
- avoid renaming Kortix internal identifiers;
- keep OpenOPC branding at the presentation layer.

No adapter, forked Review Center, or alternate marketplace is introduced.

## 13. Verification Strategy

### 13.1 Unit and component tests

Tests cover:

- status labels, legal publisher actions, requirement indicators, and error mapping;
- account-scoped and Admin query-key isolation;
- upload, parse, validation, confirmation, and submission stages;
- publisher loading, empty, error, no-write-permission, request-review, and resubmit states;
- Admin loading, empty, filtered queue, cursor pagination, and permission-revoked states;
- evidence completeness and exact request construction;
- request-changes reason validation;
- emergency-revocation confirmation;
- self-approval response handling;
- 409 conflict refresh with no automatic replay.

Request tests assert exact `account_id`, `expected_status`, `expected_revision`, `reason`, and evidence shapes.

### 13.2 Browser acceptance

Playwright uses deterministic intercepted HTTP responses to visibly verify:

- publisher navigation, recent list, submit stages, detail, history, request review, and resubmit;
- Admin navigation, status queue, cursor navigation, detail, evidence, request changes, approval, revocation, and conflict recovery;
- direct detail URLs, refresh, browser back/forward, and active-account switching;
- no Admin action exposure on publisher pages.

Mocked browser acceptance proves UI behavior and HTTP contracts only. It does not prove PostgreSQL transactions, real authentication, or deployment.

If local Supabase and PostgreSQL are available, a separate live black-box pass covers real authentication and persistence. If they remain unavailable, the exact environment blocker is reported and the result is not described as live database or production acceptance.

### 13.3 Repository gates

The implementation gate includes:

- focused Developer Center Web tests;
- the complete Web test package;
- Web TypeScript checking;
- scoped Biome checks;
- `git diff --check`;
- the root `pnpm test` command as a baseline comparison.

The known unchanged Windows/POSIX failures in `@kortix/sandbox-agent-server` may keep the root command non-green. They must be reported separately and must not be represented as a Developer Center failure or as a full repository pass.

## 14. Acceptance Criteria

The slice is complete when:

1. An authorized publisher can validate, submit, inspect, request review, and resubmit through Web routes.
2. A platform administrator can list, inspect, request changes, approve with complete manual evidence, and emergency-revoke through Admin Web routes.
3. Every detail page is deep-linkable and restores correctly on refresh.
4. Account changes do not display cached data from another account.
5. Admin capabilities remain absent from the public SDK and publisher bundle.
6. Concurrent revision conflicts refresh authoritative state and never replay decisions automatically.
7. Named loading, empty, permission, validation, lifecycle, and conflict states have automated coverage.
8. The complete Web package gates pass.
9. Browser results are labeled accurately as mocked-contract or live-black-box evidence.
10. Kortix Review Center, internal package names, protocols, database objects, and cancelled multimedia product pages remain unchanged.

## 15. Deferred Follow-up

After this slice, the next Developer Center choices remain:

1. automated source scanning and sandbox evidence;
2. signing and publication;
3. installation, rollback, and runtime governance;
4. metering and settlement;
5. publisher pagination and server-side search.

Those capabilities require separate designs and are not implicit in approval of this Web UI slice.
