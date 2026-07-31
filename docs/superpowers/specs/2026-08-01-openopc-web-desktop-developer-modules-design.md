# OpenOPC Web/Desktop Developer-Module Extension Design

**Date:** 2026-08-01
**Status:** Proposed; implementation has not started

## Goal

Extend the existing Developer Center and module lifecycle so the Web product
and Windows Desktop can host multiple reviewed module categories without
rebuilding the developer platform or allowing arbitrary code into the host
process.

The public-beta product is the Web application plus Windows Desktop. Ordinary
users must be able to use the core product and install approved modules.
Developers must be able to apply, submit, monitor review, publish approved
versions, and maintain their modules.

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
  adapter.

The existing release state machine remains:

```text
draft -> uploaded -> validated -> review_pending -> approved -> signed -> published
                                                        |                  |
                                                        +-> changes_requested
                                                                           +-> revoked/deprecated
```

No new parallel developer account, review, signing, or installation system is
introduced.

## Module categories and runtime profiles

“Any module” means any supported business category, not unrestricted execution
in the Web or Desktop host process. Each release declares one validated
runtime profile:

1. **Declarative** — the existing manifest-only path for capability bundles,
   forms, and simple AI/industry-model definitions.
2. **Web sandbox** — H5 pages, forms, and H5 games run from an immutable
   reviewed bundle in an isolated origin/webview. They communicate with the
   host only through the capability bridge.
3. **Service connector** — AI applications, industry models, and developer
   commerce backends run behind a server adapter. The module never supplies a
   host secret or an arbitrary provider endpoint.
4. **Server runtime** — reviewed WASI (and any already-supported runtime
   profile) runs through the existing module-runtime policy, with resource,
   tenant, egress, cancellation, and audit controls.

The profile determines the required automatic and human review requirements;
the publisher cannot change a release profile after approval without a new
review revision.

## Manifest, permissions, and domains

Each module release declares, in the existing manifest contract or its versioned
extension:

- module category and runtime profile;
- entry points and immutable artifact digest;
- requested platform permissions (account basics, project, files, AI, model,
  notifications, and desktop capabilities);
- external domains and connector purposes;
- whether the module requires a desktop-specific security review;
- data retention and callback metadata needed by the host.

Installation shows the requested permissions. A user or team administrator
must approve them before first use, and can revoke them later. Revocation
blocks new calls, records an audit event, and follows the existing runtime
drain/revocation behavior.

External network access is restricted to domains declared by the release and
accepted by review. A user may bind a personal or team-owned domain only after
DNS `TXT`/`CNAME` ownership verification and HTTPS validation. A binding is
scoped to the owning tenant and module release, is auditable, and never changes
the artifact permissions.

## Commerce boundary

A marketplace module is a developer-owned service. OpenOPC provides the module host,
review, permissions, installation, and domain binding; it does not become the
merchant of record, hold developer funds, or operate a platform-wide order,
refund, payout, or settlement ledger for that module. The module’s external
commerce domains remain subject to the same declaration, review, consent, and
revocation rules.

## Web and Windows Desktop integration

Web and Windows Desktop use the same module manifest, permission consent,
domain policy, release identity, and revocation checks. Desktop may expose
additional local capabilities only when explicitly declared and approved by
the existing `desktop_security_review` requirement. Desktop credentials remain
outside the rendered module surface. A Desktop failure or shutdown must not
make the Web product unavailable.

## Review and trust

The existing developer review pipeline is extended by profile-specific checks:

- manifest and dependency validation;
- source/artifact scan and sandbox test;
- permission and declared-domain review;
- desktop security review when applicable;
- platform human review before signing and publication.

Unreviewed or unsigned releases are never listed as installable. A publisher
cannot approve its own release. The GitHub code-review/environment policy is a
separate operational concern and is not changed by this product design.

## Public-beta acceptance

The Web/Desktop beta is accepted only when all of the following are evidenced
on the same candidate commit:

- ordinary user login and core Web workflow work without Desktop;
- the packaged Windows Desktop login and core workflow work;
- at least one reviewed module passes installation, permission consent,
  execution, revocation, and update/rollback in Web;
- the same module policy is enforced in Desktop;
- one representative Web-sandbox module and one service/runtime module pass
  their profile-specific review and smoke checks;
- a verified custom-domain binding works and is rejected when ownership or
  HTTPS validation fails;
- tenant isolation, audit records, bounded failures, and rollback evidence are
  present.

This acceptance result means readiness for the Web/Desktop restricted beta. It
does not claim that every possible third-party runtime or the full OpenOPC
product specification is complete.

## Explicit exclusions from this design

- direct execution of arbitrary module code in the host process;
- unrestricted Internet access or candidate-selected provider endpoints;
- unreviewed developer publication or self-signing;
- platform-operated commerce settlement;
- native mobile applications;
- changes to GitHub branch/environment protection, workflow dispatch,
  release publication, or deployment authorization.
