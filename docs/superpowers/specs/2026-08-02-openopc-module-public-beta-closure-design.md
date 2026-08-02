# OpenOPC Module Public-Beta Closure Design

**Date:** 2026-08-02

**Status:** Approved design; written-spec review pending; implementation not started

**Supersedes:** Only the conflicting review and launch-readiness details in
`2026-08-01-openopc-web-desktop-developer-modules-design.md`

## Goal

Close the smallest remaining product gaps that prevent an ordinary user from
opening a reviewed developer module in OpenOPC Web or Windows Desktop.

The result must let the platform owner review their own Publisher releases,
let users open active `sandboxed-web` installations without first binding a
custom domain, and connect those modules to the existing platform-owned AI and
payment capability APIs through the existing service bridge.

This design does not create fixed business module categories. Developers may
build any product that fits an approved execution profile and the published
SDK contract.

## Current gaps

The existing implementation already includes Publisher membership, release
review, signing, publication, installation, update, rollback, revocation,
service consent, capability issuance, NewAPI and Z-Pay gateways, custom-domain
bindings, and a tested browser service bridge. Four product gaps remain:

1. `platform_review` rejects a platform administrator whenever that person is
   also a member of the Publisher being reviewed.
2. The installed-module table has no launch action or production module-host
   screen.
3. The browser service bridge has no production caller.
4. Static Web-module rendering depends on an active custom-domain binding, so
   a module has no platform URL when the user chooses not to bind a domain.

## Chosen approach

Use one operator-controlled wildcard module domain and a unique immutable
origin for every published release:

```text
https://r-<release-id>.<module-base-domain>/
```

For example, a release could be served from
`https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example/`.
One wildcard DNS record and certificate cover all release origins. A module
does not require its own server, container, certificate, or custom domain.
The API reads the hostname-only suffix from
`OPENOPC_MODULE_APP_BASE_DOMAIN`; values containing a scheme, port, path,
query, fragment, wildcard label, credentials, or non-canonical hostname are
invalid. The example value is `modules.openopc.example`, not a URL.

This approach is selected over a shared path such as
`https://app.example/modules/<release-id>/` because modules on a shared origin
could access each other's origin-scoped browser state. It is selected over a
dedicated deployment per module because that would add unnecessary public-beta
infrastructure and operational work.

## Authorization and platform-owner self-review

The `platform_review` authorization rule changes as follows:

- the actor must still be a platform administrator;
- the Publisher organization must still be verified;
- the Publisher must not be suspended;
- the actor may also be an owner, administrator, developer, finance member, or
  support member of that Publisher;
- no independent-reviewer or separation-of-duties membership rule remains.

Only the membership-based denial is removed. Automated validation, artifact
trust checks, manifest and capability checks, signing, publication state
transitions, and audit records remain mandatory. The existing review record
must continue to identify the acting user, Publisher, release, verdict,
timestamp, and reason so the platform owner's self-review is visible in the
audit history. No new reviewer account, reviewer assignment, or database role
is introduced.

This change does not let an ordinary developer self-publish. A Publisher
member who is not a platform administrator still cannot perform
`platform_review`.

Every review-service construction path must apply the same policy. Any legacy
fallback that rejects the release creator or Publisher member solely because
they are the reviewer is removed; a fallback may remain only if it establishes
platform-administrator authority before the decision. No hidden
separation-of-duties check may reintroduce the independent-reviewer gate.

## Platform launch contract

Add an authenticated project route under the existing developer-module project
API:

```text
GET /projects/{projectId}/modules/{installationId}/launch
```

The route requires project-read authorization and resolves the installation
inside the caller's account and project. It returns a launch descriptor only
when all of the following are true:

- the installation is active;
- the installation's active release and install revision still match;
- the release is signed and published, and is not revoked or deprecated;
- the manifest is valid schema v3 with execution mode `sandboxed-web`;
- the artifact, entry path, and signature metadata are complete;
- the active release profile enables `module.app.render`;
- the configured module base domain is a valid HTTPS hostname.

The response is server-authoritative and has this shape:

```json
{
  "installation_id": "20000000-0000-4000-8000-000000000002",
  "release_id": "40000000-0000-4000-a000-000000000004",
  "install_revision": 7,
  "module_id": "developer.example.app",
  "module_version": "1.0.0",
  "execution_mode": "sandboxed-web",
  "url": "https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example/",
  "origin": "https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example"
}
```

The URL contains no account identifier, project identifier, credential,
capability token, query string, or fragment. Clients do not construct the URL
themselves.

Non-Web profiles remain valid developer modules but do not receive a fake Web
launch URL. Declarative modules continue to contribute their declared
capabilities, and service/WASI/OCI profiles continue through their existing
runtime APIs. Calling the launch route for such a profile returns a bounded
`PROJECT_MODULE_NOT_LAUNCHABLE` conflict.

## Default immutable module host

The existing custom-domain static host already performs bounded artifact
reads, digest verification, package parsing, entry validation, content-type
selection, and security headers. The implementation will extract or reuse that
shared static-release reader rather than create a second artifact parser.

The default host adds an internal route that resolves a release without a
custom-domain binding. Its repository query must return a release only when it
is still signed, published, non-revoked, schema-v3 `sandboxed-web`, and valid
for the active deployment environment. Static assets are immutable per release
identity. Revocation immediately makes subsequent host reads return not found.

The edge proxy accepts only a hostname matching
`r-<canonical-release-uuid>.<module-base-domain>`, rewrites it to the internal
release-host route, sets `X-OpenOPC-Module-Release` to the UUID parsed from the
trusted hostname, and adds the existing internal service authentication. The
API never trusts a public caller to supply the internal key or resolved release
identity. The internal route compares the release header with its release path
parameter before loading any metadata or artifact.

Every response keeps the existing no-sniff, no-referrer, content security, and
bounded-content rules. The frame policy permits only configured OpenOPC Web
origins to embed a module. Direct model-provider and payment-provider network
calls remain blocked; modules obtain those services only through the host
bridge.

When `module.app.render` is enabled, an invalid or missing HTTPS module base
domain or internal host key is a readiness failure. When rendering is disabled
by the release profile, launch and static-host routes return the existing
capability-unavailable response instead of partially enabling the feature.

## Web module-host experience

The existing project modules feature becomes reachable from the production
project UI rather than only from a debug surface. It keeps installation,
consent, update, rollback, revocation status, and history in one place.

An active `sandboxed-web` installation receives an **Open module** action. The
action navigates to a production project route for the installation and loads
the server-issued launch descriptor. The module-host screen contains:

- a back action to the installed-module list;
- the module name and exact active version;
- a loading state while the launch descriptor is resolved;
- a full-height iframe for the immutable release URL;
- a clear unavailable state for revoked, stale, unsupported, or disabled
  installations;
- a reload action that re-resolves the descriptor rather than blindly reusing
  an old URL.

The iframe uses the exact descriptor URL and a restrictive sandbox. It allows
scripts, forms, and same-origin behavior only because every release receives a
dedicated platform origin. It does not grant top-level navigation, unrestricted
popups, provider credentials, or host DOM access.

Update, rollback, or revocation invalidates the current descriptor. The host
screen tears down the old iframe and bridge, re-resolves current installation
state, and mounts a new release origin only when the installation remains
launchable.

## Production service-bridge wiring

The module-host screen attaches the existing `ModuleServiceBridge` to the
iframe after the iframe window and launch descriptor are available. The bridge
is configured with:

- the exact descriptor origin;
- the exact iframe `contentWindow` as the only accepted message source;
- project, installation, release, and install-revision values from the
  server-issued descriptor;
- AI and payment operations parsed from the signed schema-v3 manifest;
- the existing project-module service-capability endpoint as the token issuer;
- a current-state resolver that rechecks the active installation identity;
- the existing per-installation request limit and short token lifetime.

Each accepted module request asks the backend for exactly one declared
operation. The backend remains authoritative for current consent, account and
project scope, release identity, install revision, service, operation, expiry,
revocation, and audit recording. The browser never receives NewAPI, Z-Pay,
Alipay, WeChat, signing, or internal service credentials.

The listener is removed whenever the iframe, release, installation, route, or
component changes. Messages from another origin, another window, malformed
payloads, undeclared operations, stale installations, revoked consent, or
requests above the limit fail closed and do not mint a token.

The current bridge protocol remains unchanged in this closure slice. A denied
token request produces the SDK's existing bounded timeout/failure behavior;
adding a versioned structured bridge-error response is deferred so this work
does not introduce an unreviewed protocol change.

## Optional custom domains

Custom-domain bindings remain optional. The platform launch descriptor always
uses the platform-controlled release origin, even when a custom-domain binding
exists, so service-bridge isolation and behavior are deterministic.

Existing verified custom domains continue to serve reviewed static
`sandboxed-web` content as aliases. Creating, verifying, disabling, or omitting
a custom-domain binding does not change installation state, release trust,
service consent, or platform launch availability. This closure does not add a
requirement for a custom domain and does not change the existing direct
custom-domain rendering contract.

## Windows Desktop behavior

Windows Desktop reuses the same public OpenOPC Web routes, launch descriptor,
iframe host, bridge, permissions, and module release identity. No second module
runtime or Desktop-specific module catalog is introduced.

The Desktop package must eventually be rebuilt with the public OpenOPC Web URL
after that URL is deployed and verified. Building, signing, publishing, or
distributing the package is a separate operational authorization boundary and
is not part of this code-change slice.

## Error behavior

The launch route uses bounded, stable errors:

- `404` for an installation not visible in the caller's project scope;
- `409 PROJECT_MODULE_INACTIVE` for a blocked or revoked installation;
- `409 PROJECT_MODULE_NOT_LAUNCHABLE` for a non-Web execution profile;
- `409 PROJECT_MODULE_LAUNCH_STALE` when release or revision state changes
  during resolution;
- `503 OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE` when the deployment
  profile disables module rendering;
- `503 PROJECT_MODULE_HOST_UNAVAILABLE` when required host configuration is
  absent or invalid.

Static-host failures remain opaque: unauthorized internal requests return
unauthorized, and invalid, unpublished, revoked, mismatched, oversized,
corrupt, or missing artifacts return not found without release metadata.

The Web host displays user-facing explanations and a safe retry action. It
does not expose internal keys, provider errors, artifact storage keys, or raw
backend payloads.

## Testing strategy

Implementation follows strict one-test-at-a-time RED, GREEN, and REFACTOR
cycles. No Docker integration test is required for this slice.

Required focused coverage:

1. Publisher permission tests prove that a platform administrator may review a
   Publisher they belong to, while a non-administrator member remains denied.
2. Review and release-lifecycle tests prove self-review still runs automated
   trust gates, records the acting user and verdict, and cannot bypass signing.
3. Launch-domain tests prove canonical HTTPS origins, unique release origins,
   invalid configuration rejection, and absence of credentials or tenant IDs.
4. Launch route tests cover account/project isolation, active state, signed and
   published state, Web-profile enforcement, revoked state, stale revision,
   and disabled release profiles.
5. Static-host tests cover default release serving, digest and entry checks,
   revocation, cross-release mismatch, internal authentication, security
   headers, and continued custom-domain behavior.
6. Web component tests cover production navigation, the Open action, loading,
   successful iframe mounting, unavailable states, and reload.
7. Bridge integration tests prove exact origin/window binding, one-operation
   token requests, signed-manifest declarations, cleanup, consent denial,
   rate limiting, update/rollback staleness, and revocation.
8. Desktop configuration tests prove the shell consumes the configured OpenOPC
   Web URL rather than the old Kortix development URL; package rebuilding is
   verified only in the later release operation.

Focused checks must report actual passing and failing test counts. Broader
package type checks and relevant Web/API test suites run after the focused
tests are green. Skipped deployment, live DNS, provider, payment, Desktop
signing, or package-distribution checks are reported as unverified rather than
treated as passing.

## Rollout and readiness

This implementation needs no new reviewer user and no database migration. It
does require one wildcard DNS record and certificate, edge host routing, an
`OPENOPC_MODULE_APP_BASE_DOMAIN` setting backed by HTTPS, and the existing
internal host key before module rendering can be enabled in a deployed beta
environment.

Code completion does not itself make the public beta ready. After deployment,
the operator must verify on the same candidate commit:

- Web login and normal project access;
- self-review, signing, publication, installation, and Open module;
- one real reviewed `sandboxed-web` module through the platform URL without a
  custom domain;
- update, rollback, consent revocation, and release revocation;
- AI model listing and text/stream operations through the platform NewAPI
  connector;
- a controlled Z-Pay flow before live payment capability is enabled;
- Windows Desktop rebuilt against and loading the verified public Web URL.

Deployment, live DNS changes, secret configuration, live payment, Desktop
signing, package publication, Git push, and branch merge each remain separate
authorization boundaries.

## Explicit non-goals

- fixed module categories such as store, H5, game, form, or industry model;
- a second AI gateway, payment gateway, reviewer system, or module catalog;
- direct module access to NewAPI, Z-Pay, Alipay, or WeChat credentials;
- ordinary-developer self-publication or unsigned publication;
- one server, container, certificate, or domain per module;
- structured bridge error protocol changes;
- settlement, payouts, withdrawals, tax handling, or developer merchant keys;
- native mobile applications;
- deployment, Desktop signing, package publication, push, or merge.
