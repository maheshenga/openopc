# OpenOPC Web/Desktop Developer-Module Extension Design

**Date:** 2026-08-01
**Status:** Approved; implementation complete locally; deployment pending

**Release-scope note:** `openopc-restricted-public-beta-v1` remains immutable and
continues to exclude developer-application payments. The separately identified
`openopc-web-desktop-developer-beta-v2` profile enables reviewed Web/Desktop
module execution, the platform AI gateway, and buyer-side module payments while
keeping settlement, payouts, mobile-native capabilities, and all unlisted
capabilities disabled. Defining v2 is not a readiness claim: public beta remains
blocked until the same-candidate acceptance evidence in this document is complete.

## Goal

Extend the existing Developer Center and module lifecycle so the Web product
and Windows Desktop can host reviewed developer applications through generic
execution profiles and SDK capabilities. The platform does not define fixed
business module types or allow arbitrary code into the host process.

The public-beta product is the Web application plus Windows Desktop. Ordinary
users must be able to use the core product and install approved modules.
Developers must be able to apply, submit, monitor review, publish approved
versions, and maintain applications built with the supported SDK and runtime
profiles.

## Existing baseline to preserve

The following existing surfaces remain authoritative:

- `apps/api/src/developer/*`: applications, publishers, artifacts, releases,
  review transitions, signing, distribution, installations, and revocation;
- `apps/web/src/features/developer-center/*`: developer and administrator
  review experiences;
- `apps/web/src/features/project-modules/*`: project installation and module
  lifecycle UI;
- `packages/sdk/src/core/rest/projects-client/developer-modules.ts`: public
  API contracts;
- `apps/api/src/module-runtime/*`: capability and execution boundaries;
- `apps/api/src/marketplace/developer-modules.ts`: published-module catalog
  adapter;
- `apps/api/src/llm-gateway/*`: the existing platform-owned authentication,
  model policy, budget, usage, and audit control plane;
- `apps/api/src/billing/*`: existing Stripe-backed platform subscription and
  credit billing, which remains separate from developer-application payments.

The existing release state machine remains:

```text
draft -> uploaded -> validated -> review_pending -> approved -> signed -> published
                                                        |                  |
                                                        +-> changes_requested
                                                                           +-> revoked/deprecated
```

No new parallel developer account, review, signing, or installation system is
introduced.

## Generic modules, runtime profiles, and capabilities

A module is a developer application, not a platform-defined business type. AI
applications, industry models, H5 pages, executable forms, games, and commerce
experiences are illustrative products that developers may build; they are not
special categories, prebuilt models, or separate host implementations.

Descriptive labels may be included for catalog search, but they grant no
behavior and are never a security or routing decision. Each release instead
declares one validated execution profile:

1. **Declarative** — the existing manifest-only path for capability bundles.
2. **Web sandbox** — an immutable reviewed bundle runs in an isolated
   origin/webview and reaches host capabilities only through the bridge.
3. **Service connector** — a developer-owned service runs behind a reviewed
   server adapter and calls platform APIs with scoped authorization.
4. **Server runtime** — reviewed WASI, and any already-supported runtime,
   runs through the module-runtime policy with resource, tenant, egress,
   cancellation, and audit controls.

Runtime profiles control execution safety, not the product a developer may
make. A new product must reuse a compatible profile; a genuinely new execution
behavior requires a separately reviewed runtime profile, never a
category-specific bypass.

## SDK, manifest, permissions, and domains

OpenOPC provides an official TypeScript/JavaScript developer SDK plus a
versioned REST/OpenAPI contract for other languages. A versioned manifest
extension declares the immutable artifact, runtime profile, SDK API version,
entry points, optional descriptive labels, requested permissions, and scoped
platform services. The extension is a schema-v3 `openopc` namespace, rather
than a new shape for the existing `capabilities` field. That existing field is
already an array of developer-owned capability descriptors and remains
available unchanged for module-defined APIs.

The concrete v3 shape is:

```json
{
  "schemaVersion": 3,
  "id": "developer.example.app",
  "version": "1.0.0",
  "publisher": { "id": "developer-example" },
  "locales": ["zh-CN"],
  "compatibility": { "platform": ">=1.0.0", "registry": ">=3.0.0" },
  "execution": { "mode": "sandboxed-web", "entry": "dist/index.html" },
  "verification": { "profile": "sandboxed-web" },
  "openopc": {
    "sdkApiVersion": "v1",
    "catalog": { "labels": ["h5", "game"] },
    "services": {
      "ai": { "operations": ["models.read", "text.generate", "text.stream"] },
      "payment": { "operations": ["orders.create", "orders.read", "refunds.create"] }
    }
  }
}
```

Schema v2 parsing remains supported for already-published releases. Its fixed
`category` values remain legacy descriptive metadata only. Schema v3 does not
use a category for routing or authorization; `openopc.catalog.labels` are
searchable descriptions only. `openopc.services` is optional. An application
that needs AI must declare `services.ai` and use the OpenOPC AI API; an
application that needs payment must declare `services.payment` and use the
OpenOPC Payment API. Applications that need neither may declare neither. No
application may substitute a direct model-provider or payment-provider
integration for a declared platform service.

The SDK receives a short-lived capability token through the Web/Desktop bridge
or a server-side API exchange. The token is bound to tenant, project, module
release, installed version, and approved capability. It exposes neither model
provider credentials nor payment merchant credentials. Installation shows the
requested permissions; a user or team administrator must approve them before
first use and can revoke them later. Revocation blocks new calls, records an
audit event, and follows the existing runtime drain/revocation behavior.

External network access remains restricted to reviewed declared domains. The
platform AI and payment endpoints are capability APIs, not declared third-party
egress exceptions. A custom-domain binding is optional: a module remains usable
through the normal Web/Desktop host when no domain is configured. When a user
chooses to bind a personal or team-owned domain, the platform requires DNS
`TXT`/`CNAME` ownership verification and HTTPS validation. A binding is scoped
to the owning tenant, deployment environment, and module release, is auditable,
and never changes artifact permissions or capability grants.

Only reviewed `sandboxed-web` releases are exposed through the optional static
custom-domain host. WASI, service-connector, and desktop-native releases keep
their normal platform-mediated execution path and are not made publicly
addressable by a custom hostname.

## Platform AI connector

`QuantumNous/new-api` remains a separately deployed AI site maintained by the
platform owner and shared by this and other independent projects. It is not an
OpenOPC developer module, is not copied into this repository, and is not
installed inside a module runtime.

OpenOPC adds a platform-owned NewAPI connector to the existing LLM gateway.
The connector uses an operator-configured endpoint, API compatibility version,
and dedicated OpenOPC service credential to call the independent site. The
credential is not shared with another project and is rotated independently.
Only the connector may reach that site. The existing LLM gateway remains
authoritative for OpenOPC identity, tenant binding, approved model allowlists,
budgets, rate limits, usage, traces, and audit records.

The initial SDK contract provides a model catalog, text generation, and
streaming. Image, video, embeddings, and other supported `new-api` operations
are added as versioned AI capabilities, not as new business module types. A
connector failure returns a bounded, auditable platform error; a module may not
fall back to an arbitrary endpoint. The connector must be backward-compatible
with the configured `new-api` API version and must not make OpenOPC-specific
global changes to the shared site.

## Platform payment connector

OpenOPC adds a platform-owned payment connector that calls the [Z-Pay
aggregation interface](https://z-pay.cn/doc.html) using platform-controlled
merchant configuration for Alipay and WeChat payment channels. It is an
integration service, not a fixed commerce module type and not a credential
bundle supplied by a developer.

The public-beta payment capability supports idempotent order creation, payment
parameters, signed asynchronous callback processing, order lookup, local
expiry, refund requests, and refund-result records. The published Z-Pay
documentation exposes creation, lookup, refund, and callback APIs, but no
provider-side order-close API. Therefore OpenOPC must not expose or advertise
`orders.close` in this beta. An expired local order remains auditable; a later
valid provider callback is recorded as a late payment and routes to the refund
and support workflow instead of silently treating the checkout as cancelled.
The connector alone holds Z-Pay and downstream merchant credentials. Modules
call only the OpenOPC Payment API with a `payment` capability token; they
cannot call Z-Pay, Alipay, or WeChat directly.

Developer-application payments use a separate order, callback, audit, and
authorization boundary from the existing Stripe subscription, credit, and
auto-topup system. Public beta does not include developer split payments,
withdrawals, payouts, settlement statements, tax handling, or developer-owned
merchant credentials. Before enabling live funds, the platform operator must
complete the applicable merchant, legal, privacy, refund, and support
requirements; this is an operational launch gate, not an SDK bypass.

## Web and Windows Desktop integration

Web and Windows Desktop use the same manifest, SDK API version, permission
consent, capability token policy, domain policy, release identity, and
revocation checks. A Web-sandbox module receives host functions through the
capability bridge; a server module exchanges its scoped token with the platform
API. Neither surface can reach `new-api`, Z-Pay, Alipay, or WeChat directly.

Desktop may expose additional local capabilities only when explicitly declared
and approved by the existing `desktop_security_review` requirement. Desktop
credentials remain outside the rendered module surface. A Desktop failure or
shutdown must not make the Web product unavailable.

## Review and trust

The existing developer review pipeline is extended by profile- and
capability-specific checks:

- manifest, SDK API version, and dependency validation;
- source/artifact scan and sandbox test;
- permission, AI/payment capability, declared-domain, and callback review;
- validation that an artifact cannot bypass the official AI or payment APIs;
- desktop security review when applicable;
- platform human review before signing and publication.

Unreviewed or unsigned releases are never listed as installable. A publisher's
release requires platform authorization before signing and publication. The
GitHub code-review/environment policy is a separate operational concern and is
not changed by this product design.

## Public-beta acceptance

The `openopc-web-desktop-developer-beta-v2` Web/Desktop beta is accepted only
after all of the following are evidenced on the same candidate commit. The
machine-checkable evidence ledger records the profile id/digest, candidate
commit, timestamp, and a redacted artifact/reference digest for each flow. A
ledger containing provider credentials, `orders.close`, settlement/payout
claims, or direct browser/Desktop calls to NewAPI or Z-Pay is invalid.

- ordinary user login and core Web workflow work without Desktop;
- the packaged Windows Desktop login and core workflow work;
- at least one reviewed module passes installation, permission consent,
  execution, revocation, and update/rollback in Web;
- the same module policy is enforced in Desktop;
- one representative Web-sandbox module and one service/runtime module pass
  their profile-specific review and smoke checks;
- an SDK module lists approved models and completes a tenant-bound text and
  streaming AI call through the NewAPI connector, with budget and audit
  evidence;
- an SDK module completes a controlled Alipay or WeChat payment through the
  payment connector, including signed callback, duplicate callback, query,
  local-expiry/late-callback handling, and refund-result evidence;
- undeclared, expired, revoked, or cross-tenant AI/payment capability tokens
  are rejected;
- `new-api` and Z-Pay failures, duplicate callbacks, and module revocation have
  bounded, idempotent, auditable outcomes;
- a verified custom-domain binding works and is rejected when ownership or
  HTTPS validation fails;
- tenant isolation, audit records, bounded failures, and rollback evidence are
  present.

This acceptance result means readiness for the payment-expanded Web/Desktop
restricted beta. It does not claim that every possible third-party runtime or
the full OpenOPC product specification is complete.

## Explicit exclusions from this design

- direct execution of arbitrary module code in the host process;
- unrestricted Internet access, candidate-selected provider endpoints, or
  direct module access to `new-api`, Z-Pay, Alipay, or WeChat;
- unreviewed developer publication or self-signing;
- developer split payments, withdrawals, payouts, settlement, tax handling,
  or developer-owned merchant credentials;
- a provider-side order-close claim until Z-Pay publishes a supported close
  operation and it passes a separate payment acceptance cycle;
- embedding, copying, or taking ownership of the independently operated
  `new-api` site;
- native mobile applications;
- changes to GitHub branch/environment protection, workflow dispatch,
  release publication, or deployment authorization.
