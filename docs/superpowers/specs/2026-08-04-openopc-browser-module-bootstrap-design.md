# OpenOPC Browser Module Bootstrap Design

**Date:** 2026-08-04

**Status:** Approved; implementation plan written; implementation not started

## Goal

Let a reviewed sandboxed Web module initialize the official OpenOPC developer
SDK without asking the module developer to discover or hard-code a platform
origin.

The resulting client must work through the same OpenOPC Web host in a browser
and in Windows Desktop, and must preserve the existing rule that AI and payment
calls go only through platform-owned module-service gateways.

## Approved public-beta boundary

This slice supports full AI and payment SDK behavior only while a module is
embedded in the authenticated OpenOPC Web module host. Windows Desktop reuses
that Web host and the same protocol.

An optional custom domain remains a static alias for reviewed module content.
Opening that domain directly does not create a platform login session, issue a
capability token, or enable AI or payment calls.

This slice does not add an independent custom-domain authentication or
authorization system.

## Existing behavior to preserve

- The launch API returns the immutable module URL and module origin, but no
  platform API origin, credential, token, query string, or fragment.
- The Web host loads that URL in a sandboxed iframe with a no-referrer policy.
- The token bridge accepts requests only from the exact descriptor origin and
  exact iframe contentWindow.
- Capability issuance rechecks the project, installation, release, install
  revision, declared operation, consent, revocation, expiry, and rate limit.
- Capability tokens expose neither NewAPI nor payment-provider credentials.
- The public developer SDK keeps its existing manual client constructor and
  browser capability-token adapter for backward compatibility.
- The Web application proxies same-origin /v1 requests to the API.
- Windows Desktop loads the configured OpenOPC Web origin and limits module
  service traffic to that origin under /v1/module-services.

## Chosen approach

Add a one-shot, versioned postMessage bootstrap between the reviewed module
iframe and its OpenOPC Web parent.

The module sends a secret-free discovery request before it knows the parent
origin. The host validates the module window and module origin against the
server-issued launch descriptor, then sends a response only to that module
origin. The SDK derives the platform origin from the accepted response event's
origin; the response payload does not carry a selectable URL.

The SDK then composes the existing browser capability-token adapter and module
client. All AI and payment requests continue to use the existing capability
token and platform HTTP contracts.

## Alternatives considered

### Signed launch context in a URL fragment

A signed fragment could carry the platform origin and launch identity without
sending it to the static host. It would expand the launch descriptor, signing,
expiry, parsing, and compatibility contracts. It also creates URL lifecycle and
redaction work that is unnecessary when the parent window already owns the
trusted launch state.

### Same-origin gateway at every module hostname

The hostname Worker could proxy a reserved module-service path to the platform.
This would reduce browser CORS work, but it would add edge routing, request-body
and streaming proxy behavior, failure handling, and operational configuration.
It would still need a parent channel for capability-token issuance.

### Fixed or developer-supplied platform origin

A fixed origin would break environment isolation, self-hosted deployments, and
Desktop instances configured for a different approved Web origin. A
developer-supplied origin would recreate the current trust gap and permit
accidental routing outside the active platform host.

## Bootstrap wire protocol

The initial protocol version is v1.

The module request is:

    {
      "type": "openopc.module.bootstrap.request",
      "requestId": "canonical UUID",
      "sdkApiVersion": "v1"
    }

The host response is:

    {
      "type": "openopc.module.bootstrap.response",
      "requestId": "the same canonical UUID",
      "sdkApiVersion": "v1"
    }

Both messages have an exact-key contract. Unknown fields, missing fields,
non-canonical request IDs, and unsupported versions are rejected.

The module posts the request to window.parent with targetOrigin set to the
wildcard because it does not know the parent origin yet. This is the only
wildcard send in the protocol. The request contains no credential, user,
account, project, installation, release, consent, or payment data.

The host sends the response to the exact module origin from the accepted
request. It never uses a wildcard response target.

## Module-side trust checks

The SDK installs its response listener before sending the request. It accepts a
response only when all of these conditions hold:

- event.source is the exact parent window supplied to the helper;
- event.data matches the exact v1 response schema;
- requestId matches the outstanding bootstrap request;
- event.origin is a canonical HTTPS origin;
- the helper is running in a child frame rather than as a top-level document.

The accepted event.origin is the platform origin. No query parameter, fragment,
module storage value, arbitrary message field, or developer option can replace
it in the one-call browser helper.

Messages that do not identify the outstanding request are ignored. A response
that identifies the request but violates the trusted response contract produces
a protocol error.

## Host-side trust checks

The production host attaches bootstrap handling only after the launch
descriptor, published release, matching signed manifest, and iframe window are
available.

It accepts a bootstrap request only when all of these conditions hold:

- event.origin exactly equals the immutable descriptor origin;
- event.source exactly equals the mounted iframe contentWindow;
- the request matches the exact v1 request schema;
- the signed manifest still matches the descriptor module ID and version;
- the manifest declares OpenOPC SDK API version v1;
- the mounted descriptor identity still matches the project, installation,
  release, and install revision used to attach the bridge.

The bootstrap response itself grants no capability. Every later token request
continues to call the current-state resolver and the backend capability issuer,
so a stale, revoked, updated, or rolled-back installation cannot use a
successful earlier bootstrap to obtain a new token.

The bootstrap listener and capability-token listener share the same host
lifecycle and cleanup callback.

## Public SDK surface

Add an async convenience constructor named
createOpenOpcBrowserModuleClient. Its normal browser usage requires no platform
origin:

    const openopc = await createOpenOpcBrowserModuleClient();
    const models = await openopc.ai.models.list();

The helper:

1. discovers the trusted platform origin through bootstrap;
2. creates the existing browser capability-token adapter with that origin;
3. creates the existing module client with that same origin as its base URL;
4. returns the existing OpenOpcModuleClient interface.

Optional inputs provide only lifecycle and test seams: AbortSignal, bootstrap
timeout, request timeout, fetch implementation, event target, parent window,
and request-ID factory. They do not provide an origin override.

The existing createOpenOpcModuleClient and
createOpenOpcBrowserCapabilityTokenAdapter exports remain supported unchanged.
The README and browser example lead with the one-call helper and retain the
manual composition form as an advanced compatibility path.

## Error and cleanup contract

Invalid helper options, top-level use, malformed trusted responses, and
unsupported protocol versions produce a dedicated browser-bootstrap protocol
error.

Bootstrap abort, timeout, and postMessage transport failure reuse the existing
provider-neutral request lifecycle errors:

- OPENOPC_MODULE_REQUEST_ABORTED
- OPENOPC_MODULE_REQUEST_TIMEOUT
- OPENOPC_MODULE_REQUEST_FAILED

The default bootstrap timeout remains bounded independently from the longer AI
stream timeout. Settling for any reason removes the message listener, abort
listener, and timer exactly once.

Untrusted unrelated messages are ignored. The host does not return detailed
denial information to an origin or window that failed validation.

No platform origin, token, or launch identity is persisted by the helper. The
returned client holds only the in-memory origin and functions needed for the
current iframe lifetime.

## Browser network policy

The module makes service requests to the accepted parent origin under:

- /v1/module-services/ai/*
- /v1/module-services/payments/*

The existing Web /v1 proxy carries those requests to the API. The SDK continues
to use credentials: omit, a short-lived capability Authorization header, strict
redirect handling, and no referrer.

### Static-host CSP

The static module host keeps its existing default-src, base-uri, object-src,
form-action, script-src, style-src, frame-ancestors, no-sniff, and no-referrer
rules.

connect-src is expanded only with the same validated OpenOPC Web origins already
used by frame-ancestors. It does not allow NewAPI, Z-Pay, Alipay, WeChat, a
manifest-provided endpoint, a wildcard network origin, or an arbitrary custom
domain.

### Route-scoped CORS

Canonical module release origins receive CORS access only to
/v1/module-services and its descendants. The canonical origin must be HTTPS and
must exactly match:

    r-<canonical-lowercase-release-UUID>.<configured-module-base-domain>

The base domain comes from the same validated operator configuration used for
launch descriptors. The base-domain apex, extra labels, uppercase UUIDs,
sibling suffixes, custom-domain aliases, ports, credentials, and non-HTTPS
origins are rejected.

The module-service CORS policy permits only the methods and headers required by
the published SDK, including Authorization, Content-Type, and Idempotency-Key.
It does not enable credentialed browser requests. The existing global CORS
allowlist for normal Web clients is not expanded to module origins.

Capability-token verification remains the authorization boundary. CORS is a
browser transport boundary and never substitutes for token validation.

## Web and Desktop behavior

The Web module-host page attaches the combined bootstrap and capability bridge
to the exact mounted iframe. A descriptor identity change causes React to
replace the iframe and execute the old cleanup callback before a new bridge is
attached.

Windows Desktop requires no second bootstrap protocol. Its renderer is the same
OpenOPC Web application, so the parent message origin is the configured Web
origin. Existing Desktop navigation and module-service URL policy remains in
force.

The implementation must retain Desktop policy tests proving that module service
requests are limited to the configured origin and /v1/module-services path.
This slice does not rebuild, sign, package, publish, or deploy Desktop.

## Optional custom domains

A custom-domain alias continues to serve the reviewed static release. It is not
used in the platform launch descriptor and is not added to the module-service
CORS allowlist.

When the custom-domain page is opened directly, window.parent equals the page
itself and the one-call SDK helper fails fast with the browser-bootstrap
protocol error. Static functionality that does not use platform AI or payment
continues to work.

Enabling authenticated AI or payment from a directly opened custom domain
would require a separate platform login, launch-session, and authorization
design and is outside this public-beta slice.

## Test design

Implementation follows RED, GREEN, REFACTOR. Each behavior below receives a
failing test before implementation.

### Developer SDK

- accepts one exact bootstrap response and creates a working module client;
- derives both token-adapter host origin and HTTP base URL from event.origin;
- ignores wrong source, request ID, message type, and unrelated origin events;
- rejects a matching malformed response or unsupported version;
- fails fast in a top-level document;
- reports abort, timeout, and postMessage failure through stable lifecycle
  errors;
- removes every listener and timer on success and failure;
- preserves all existing manual client and token-adapter behavior;
- exposes the new constructor and error from the packed npm artifact.

### Web host

- responds only to the exact descriptor origin and iframe window;
- uses the exact request origin as response target;
- rejects malformed requests and manifest or descriptor mismatches;
- removes both bootstrap and token listeners on cleanup;
- completes a contract flow from SDK bootstrap through capability-token request
  to a module-service fetch;
- keeps stale installation, undeclared operation, revoked consent, and rate
  limit behavior fail-closed.

### API and static host

- CSP permits configured platform Web origins in both frame-ancestors and
  connect-src while retaining all other restrictions;
- route-scoped preflight and service requests accept only a canonical platform
  release origin;
- module origins receive no CORS access to unrelated API routes;
- custom domains, malformed release hostnames, attacker suffixes, ports, and
  non-HTTPS origins receive no module-service CORS grant;
- module-service CORS does not advertise credential support;
- existing ordinary Web CORS behavior remains unchanged.

### Desktop

- configured Web-origin module-service URLs remain accepted;
- another origin, another path, credentials in the URL, and non-loopback HTTP
  remain rejected;
- no Desktop-native credential or provider endpoint enters the renderer.

### Browser contract smoke

- a Playwright fixture serves the platform parent and reviewed module from two
  distinct HTTPS origins;
- the real iframe completes bootstrap, receives one scoped capability token,
  and performs one module-service model-list request;
- the browser proves the response source and origin, CSP connect-src behavior,
  CORS preflight, credentials omission, and listener cleanup;
- an attacker parent origin and a directly opened custom-domain fixture receive
  no bootstrap response or module-service access.

## Verification gates

The implementation is complete only after fresh passing evidence for:

- focused developer SDK, Web bridge, API CORS/static-host, and Desktop policy
  tests;
- developer SDK and affected package type checks;
- developer SDK build;
- packed install/import smoke;
- Web and API focused checks;
- the two-origin Playwright browser contract smoke;
- formatting or lint checks for every changed file;
- git diff --check;
- a final source scan confirming no provider credential or direct provider URL
  was added to module-facing code.

No live NewAPI request, live payment, DNS change, deployment, npm publication,
Desktop rebuild, commit, push, or merge is part of this implementation slice.

## Acceptance criteria

The slice is accepted when a reviewed sandboxed Web module can call the new
one-step browser helper inside the OpenOPC host, list approved models through
the existing module-service API, and receive the same behavior in the Web
browser and Desktop renderer contract.

The same artifact opened directly on an optional custom domain remains a static
page and receives no bootstrap response or capability token.

All spoofed origin, source, request, descriptor, route, and CORS cases fail
closed without expanding access to unrelated platform APIs or provider
credentials.

## Explicit non-goals

- authenticated AI or payment from a directly opened custom domain;
- a fixed global platform origin in module code;
- URL query or fragment bootstrap;
- a module-hostname edge proxy for service traffic;
- provider-selectable AI or payment endpoints;
- direct module access to NewAPI, Z-Pay, Alipay, or WeChat;
- structured capability-denial responses;
- a new module category, runtime profile, or installation model;
- live infrastructure changes, deployment, package publication, or Desktop
  release work.
