# OpenOPC Web/Desktop Developer-Module Extension Design

**Date:** 2026-08-01
**Status:** Proposed; implementation has not started

**Release-scope note:** The current restricted public-beta profile excludes
real developer-application payments. This design is a proposed scope expansion;
payment remains disabled until the release profile is revised and the payment
acceptance evidence in this document is complete.

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
capabilities. The target shape is:

```json
{
  "module_id": "developer.example.app",
  "sdk_api_version": "v1",
  "capabilities": {
    "ai": ["models.read", "chat.stream"],
    "payment": ["orders.create", "orders.read"]
  }
}
```

Capabilities are optional. An application that needs AI must declare `ai` and
use the OpenOPC AI API; an application that needs payment must declare
`payment` and use the OpenOPC Payment API. Applications that need neither may
request neither. No application may substitute a direct model-provider or
payment-provider integration for a declared platform capability.

The SDK receives a short-lived capability token through the Web/Desktop bridge
or a server-side API exchange. The token is bound to tenant, project, module
release, installed version, and approved capability. It exposes neither model
provider credentials nor payment merchant credentials. Installation shows the
requested permissions; a user or team administrator must approve them before
first use and can revoke them later. Revocation blocks new calls, records an
audit event, and follows the existing runtime drain/revocation behavior.

External network access remains restricted to reviewed declared domains. The
platform AI and payment endpoints are capability APIs, not declared third-party
egress exceptions. A user may bind a personal or team-owned domain only after
DNS `TXT`/`CNAME` ownership verification and HTTPS validation. A binding is
scoped to the owning tenant and module release, is auditable, and never changes
artifact permissions or capability grants.

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
parameters, signed asynchronous callback processing, order lookup, order
closure, refund requests, and refund-result records. The connector alone holds
Z-Pay and downstream merchant credentials. Modules call only the OpenOPC
Payment API with a `payment` capability token; they cannot call Z-Pay, Alipay,
or WeChat directly.

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

The payment-expanded Web/Desktop beta is accepted only after its release profile
is revised and all of the following are evidenced on the same candidate commit:

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
  payment connector, including signed callback, query, closure, and refund
  result evidence;
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
- embedding, copying, or taking ownership of the independently operated
  `new-api` site;
- native mobile applications;
- changes to GitHub branch/environment protection, workflow dispatch,
  release publication, or deployment authorization.
