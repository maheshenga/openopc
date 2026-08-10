# OpenOPC Developer Package-Upload Capability Design

**Date:** 2026-08-04

**Status:** Approved design and written spec; implementation not started

## Goal

Keep the Web and Windows Desktop developer submission experience truthful while
code-bearing module trust infrastructure remains disabled. Developers must be
able to use the working declarative JSON submission path without seeing a
package-upload control that the API will reject with
`DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED`.

When the existing trust worker and code-module switch are later ready, the same
deployed client must discover that state from the API and expose package upload
without a separate frontend environment flag.

## Existing Boundary

The current implementation already has the required authority and client data
flow:

- `DeveloperModuleArtifactService` blocks package upload unless
  `DEVELOPER_CODE_MODULES_ENABLED` is true and the configured trust readiness
  probe succeeds.
- `POST /developer/modules/artifact-uploads` remains the authoritative mutation
  and returns `503 DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED` while unavailable.
- `GET /developer/access` is already loaded by the module submission page to
  obtain account-scoped Publisher access.
- `DeveloperAccess` is already exposed by the SDK and consumed by Web.
- Windows Desktop reuses the same OpenOPC Web developer routes and page rather
  than maintaining a second submission UI.
- Declarative artifacts do not require the code-module trust worker and remain
  available through `POST /developer/modules/artifacts/declarative`.

The trust runbook remains authoritative: both trust feature switches stay off
until the worker has concrete production adapters and fresh acceptance
evidence. This design reports that state; it does not relax or bypass it.

## Chosen Contract

Extend the authenticated, account-scoped developer-access response:

```json
{
  "account_id": "11000000-0000-4000-a000-000000000001",
  "user_id": "21000000-0000-4000-a000-000000000001",
  "organization": null,
  "invitations": [],
  "publishers": [],
  "capabilities": {
    "package_upload": false
  }
}
```

`capabilities.package_upload` is a required boolean in responses produced by
the updated API. It is true only when both conditions used by package-upload
mutation enforcement are currently satisfied:

1. code-module submission is enabled; and
2. trust infrastructure readiness succeeds.

The API exposes no feature-flag values, readiness URL, component status,
provider error, or other infrastructure detail. A disabled switch, a negative
readiness result, or an exception while checking readiness all produce
`package_upload: false`.

For rolling compatibility, the Web consumer treats a missing field as false.
Older clients ignore the added response field, while a newer client connected
to an older API remains fail-closed.

## Server Design

`DeveloperModuleArtifactService` gains one public capability-read method. The
method and the existing package-upload assertion share one internal predicate,
so read and mutation paths cannot develop separate interpretations of
readiness.

The predicate behaves as follows:

- when the code-module switch is off, return false without calling the
  readiness dependency;
- when the switch is on, return true only for an explicit ready result;
- convert readiness exceptions into false;
- retain the existing `503 DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED` mutation
  error whenever the predicate is false.

The `/developer/access` handler obtains Publisher access through the existing
Publisher service and obtains the package capability through the artifact
service. It returns the existing access fields plus the capability object.
Trust unavailability alone does not turn this read into a `503`; the route
returns `200` with `package_upload: false`. Existing authentication, selected
account resolution, and `account.read` authorization remain unchanged.

The package-upload POST and finalize routes continue to run their own
server-side check. A capability response is advisory UI state, never an
authorization token or a guarantee that readiness cannot change between the
read and a later mutation.

## SDK Design

Extend `DeveloperAccess` with:

```ts
capabilities: {
  package_upload: boolean;
};
```

`getDeveloperAccess` keeps its current function signature and endpoint. No new
SDK request, cache key, or developer client is introduced. Existing typed
fixtures are updated to include the capability object.

## Web and Desktop Behavior

The shared module submission view always renders `Declarative JSON`. It renders
the `Package upload` tab only when the current selected account's access
response explicitly contains `capabilities.package_upload === true`.

The UI follows these fail-closed rules:

- while developer access is loading, do not render the package tab;
- when access loading fails, do not render the package tab;
- when the response belongs to another selected account, do not render the
  package tab;
- when the capability object or field is missing, do not render the package
  tab;
- when the capability changes from true to false while the page is open,
  return the view to declarative mode and clear idle package-only file and
  Publisher selection;
- when a package request is already in flight, let that request settle under
  the server's normal gate while keeping the package UI hidden;
- never auto-submit, retry, cancel, or mutate an upload because capability
  state changed.

Package Publisher selection and upload controls retain their existing behavior
when the capability is true. Declarative validation and submission do not wait
for developer-access loading and remain usable when that query fails.

Windows Desktop receives this behavior through the shared Web route. This slice
does not add Desktop-specific controls or require rebuilding the Desktop
package.

## Error and Race Behavior

The access response intentionally collapses all trust-unavailable conditions to
one false boolean. Detailed operational diagnosis stays in internal readiness
and logs.

Readiness may degrade after the client receives true. In that race, the upload
mutation remains authoritative and returns the existing stable `503` error.
The UI may show its existing bounded error and will hide the package entry when
the access state is next refreshed. The client does not weaken, cache around,
or retry past the server gate.

Publisher access failures retain their existing status and error handling. The
new capability field does not grant Publisher membership, account write
permission, artifact authority, or release-publication authority.

## Testing Strategy

Implementation follows one-behavior-at-a-time RED, GREEN, and REFACTOR cycles.
Required focused coverage is:

1. Artifact-service tests prove false when code modules are disabled without
   probing readiness, false for negative or throwing readiness, and true only
   for enabled plus ready.
2. Existing upload tests prove the mutation still returns the same stable `503`
   when the shared predicate is false.
3. Developer route tests prove `/access` returns the required capability field,
   preserves account authorization, and returns `200` with false when trust is
   unavailable.
4. SDK tests prove `getDeveloperAccess` retains its request contract and exposes
   the typed capability response.
5. View tests prove declarative submission is always present and package upload
   is absent for false or missing capability and present only for true.
6. Connected-page tests cover loading, access failure, account mismatch,
   account switch, true-to-false reconciliation, and continued declarative
   operation.
7. Focused API, SDK, and Web suites and their package type checks run after the
   behavior tests are green. Actual pass and failure counts are recorded.

No Docker, live trust worker, deployment, Desktop package, DNS, AI-provider, or
payment-provider test is required for this slice. Those unrun checks remain
explicitly unverified.

## Acceptance Criteria

This slice is accepted locally when all of the following are evidenced on the
same worktree state:

1. Disabled code modules produce `package_upload: false` from developer access.
2. A negative or failed readiness probe produces false without breaking the
   access response.
3. Enabled code modules with an explicitly ready probe produce true.
4. Package-upload mutations remain blocked whenever the capability predicate
   is false.
5. Web and Desktop's shared submission page shows only Declarative JSON in the
   current fail-closed environment.
6. Declarative validation and release submission continue to work without a
   successful capability query.
7. A simulated true capability reveals the existing Publisher selector and
   package-upload flow without a frontend environment change.

## Explicit Non-Goals

- enabling either developer trust feature switch;
- implementing or deploying trust-worker production adapters;
- changing object storage, verification, signing, review, or publication;
- adding a second capability endpoint or frontend environment flag;
- changing declarative artifact behavior;
- changing Admin, AI, payment, custom-domain, Marketplace, or module-runtime
  behavior;
- rebuilding, signing, or publishing Windows Desktop;
- deployment, Git commit, push, pull request, merge, or public-beta readiness
  claims.
