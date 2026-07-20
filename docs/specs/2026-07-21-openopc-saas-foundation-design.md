# OpenOPC SaaS Foundation Design

- **Date:** 2026-07-21
- **Status:** Approved design; pending written-spec review before implementation planning
- **Scope:** Web SaaS, operations console, Electron native enhancement, module platform, and Kortix upgrade compatibility
- **Base:** Kortix remains the sole application base

## 1. Product Decision

OpenOPC is a complete Web-first SaaS product built on the existing Kortix
platform. The browser application is the primary product and remains fully
usable without the desktop application. The Electron application is an
optional native enhancement layer that loads the same Web application and
adds permissioned local-device capabilities.

The hosted product is multi-tenant. A separately configured single-tenant
self-hosted deployment remains supported for VPS, BaoTa, and Docker
environments. Both modes use the same Web, API, worker, SDK, and migration
artifacts.

Kortix core behavior is a release gate. Existing projects, sessions, agents,
skills, connectors, sandboxes, files, change requests, IAM, SSO/SCIM,
triggers, billing, marketplace, CLI, and desktop login flows remain available
and are not replaced by OpenOPC-specific implementations.

## 2. Goals

1. Expose a complete OpenOPC Web SaaS surface for individual users, teams,
   administrators, developers, and module consumers.
2. Keep Web operation independent of Electron. Remote projects, agents,
   sessions, models, sandboxes, files, modules, billing, and administration
   must work in a normal browser.
3. Add Desktop-only local workspace and automation capabilities without
   duplicating business pages or business logic.
4. Support a controlled local permission mode and an explicitly enabled full
   access mode.
5. Provide a developer center, module registry, review flow, installation,
   rollback, usage metering, and revenue settlement as additive platform
   capabilities.
6. Preserve Kortix upstream absorbability through stable internal contracts,
   feature flags, and focused compatibility gates.

## 3. Non-goals

- A wholesale rename of Kortix package names, database schema, migrations,
  public SDK exports, API headers, or manifest formats.
- A second independent business platform or a parallel data model.
- First-party video, voice, 3D, digital-human, or batch-remix product pages.
  Those capabilities are delivered as reviewed modules.
- Mobile delivery in this foundation phase.
- Silent cloud activation of Desktop full access.
- Running the full repository test suite as a release prerequisite for every
  incremental change.

## 4. Brand and Compatibility Boundary

### 4.1 Visible brand

The user-visible brand is **OpenOPC** in the Web UI, metadata, public docs,
emails, installer name, splash screen, application menu, and marketing
surfaces.

### 4.2 Internal compatibility

The following remain stable unless a separately approved breaking migration is
planned:

- `@kortix/*` workspace package names and existing SDK exports;
- `kortix` database schema, tables, migration history, and migration tooling;
- `KORTIX_*` environment variables and existing API headers;
- `kortix.yaml`, `.kortix` manifest paths, and schema IDs;
- the `KortixDesktop` user-agent token;
- the `kortix://` protocol and existing OAuth callbacks;
- existing `/v1` routes and Kortix API contracts;
- upstream repository and release identifiers.

New `OPENOPC_*` runtime settings may be added with precedence over legacy
settings and a `KORTIX_*` fallback. Public developer tooling may expose
`@openopc/sdk`, `@openopc/module-sdk`, and an `openopc` CLI facade that
delegates to the existing implementation.

During protocol migration, Desktop may register `openopc://` in addition to
`kortix://`; both callback formats must be accepted until old clients have
aged out. Desktop trusted-origin checks must be runtime-configurable and must
retain localhost and legacy Kortix origins for compatibility.

## 5. Product Surface

### 5.1 Web navigation

The existing Kortix project workbench remains the default product surface.
OpenOPC adds navigation entries and routes without moving or renaming core
routes:

```text
OpenOPC
├── Workbench
│   ├── Projects
│   ├── Sessions
│   ├── Multi-agent tasks
│   └── Review / Change Requests
├── Teams
├── Module Center
│   ├── Marketplace
│   ├── Installed modules
│   └── Industry / AI applications
├── Developer Center
├── Account
└── Admin (role-gated)
```

The existing `/projects`, project session, files, customize, review, account,
connector, and marketplace surfaces remain authoritative.

### 5.2 Operations console

The first implementation is an `/admin` surface in the same Next application,
protected by the existing platform-admin and IAM gates. A later
`admin.openopc.com` hostname may map to the same app and API without creating
another data layer.

Admin areas:

- operations overview;
- users, organizations, teams, and access requests;
- projects, agents, tasks, queues, and providers;
- subscriptions, usage, credits, refunds, and settlement batches;
- module review, publication, takedown, and rollback;
- security, audit, feature flags, and system settings.

### 5.3 Desktop surface

Electron loads the same Web routes. It adds a small native layer for:

- device connection and permission status;
- local workspace selection and file operations;
- local Git, CLI, and terminal actions;
- browser and desktop-app automation;
- clipboard, screenshots, and notifications;
- native downloads and opening local files;
- window controls, zoom, external navigation, OAuth deep links, and updates.

It does not duplicate project, team, billing, module, or admin pages.

## 6. Capability Matrix

| Capability | Web | Desktop |
| --- | --- | --- |
| Projects, sessions, agents, teams | Full | Full |
| Remote models, LLM Gateway, sandboxes | Full | Full |
| Cloud files and assets | Full | Full |
| Marketplace, Developer Center, Admin | Full | Full |
| Billing, usage, and settlements | Full | Full |
| Local folder access | Browser-limited | Native, permissioned |
| Local Git / CLI / terminal | No direct host access | Native, permissioned |
| Browser / desktop automation | Browser-limited | Native, permissioned |
| Clipboard, screenshots, notifications | Browser-limited | Native |
| Full access mode | Not applicable | Device opt-in only |

The Web requests a capability snapshot at runtime. It hides unavailable local
controls, offers a pairing flow when appropriate, and never blocks remote
workflows because Desktop is offline.

## 7. Runtime Architecture

```text
Browser user --------------------┐
                                 v
                         OpenOPC Web (Next.js)
                                 |
Desktop (same Web URL) ----------+
                                 |
                         Kortix API (Hono)
                 /----------------+----------------\
                v                 v                 v
          PostgreSQL/Supabase   Worker/queue      LLM Gateway
                |                 |                 |
          object storage     provider adapters   sandboxes
```

The current monolithic API remains the service boundary. OpenOPC additions are
new modules and routes in that service, not a replacement API. New surfaces
should use additive namespaces such as `/v1/modules/*`, `/v1/developer/*`,
`/v1/settlements/*`, and existing `/v1/admin/*` gates.

The existing extension seams are preferred:

- `packages/api-contract` for typed route contracts;
- `packages/registry` and manifest schema for module metadata;
- `packages/studio-runtime` and `packages/studio-adapters` for asynchronous
  capability execution, provider adapters, idempotency, storage, and usage;
- `apps/api/src/studio` and `apps/studio-worker` for server/worker execution;
- `apps/web/src/features/studio` for client surfaces;
- `@kortix/sdk` as the canonical client, with an additive OpenOPC facade.

The existing `apps/whitelabel-demo` BFF pattern may inform policy and stream
proxy design, but its in-memory demo users and process-local rate limiter are
not production SaaS infrastructure.

## 8. Deployment Modes

### 8.1 Hosted multi-tenant SaaS

- `account_id` is the tenant boundary for users, teams, projects, agents,
  modules, tasks, assets, usage, and billing;
- shared API and workers enforce account/project/IAM checks on every request;
- object storage uses tenant/project prefixes and signed URLs;
- modules run in scoped sandboxes and cannot cross tenant boundaries;
- Web, API, worker, storage, and queue scale independently.

### 8.2 Self-hosted single tenant

- one deployment owns its database, Supabase, storage, secrets, and worker;
- the same images and migrations are used as hosted deployments;
- domain, OAuth, mail, model, storage, and provider settings are runtime
  configuration;
- BaoTa/Nginx may terminate HTTPS and reverse proxy Web and API;
- a same-origin `/v1` proxy is preferred to reduce CORS, Cookie, SSE, and
  WebSocket failure modes;
- Desktop's Frontend URL setting can point at any approved OpenOPC deployment.

## 9. Desktop Security Model

### 9.1 Controlled mode

The default mode uses device- and capability-scoped grants:

- local directories are explicit allowlists;
- Git, CLI, browser automation, clipboard, screenshot, and notification
  capabilities are separate grants;
- high-risk actions use existing approval semantics;
- every action carries a device, account, project, session, and correlation
  context into the audit trail.

### 9.2 Full access mode

Full access is an explicit device-side opt-in. It requires reauthentication,
shows a persistent state indicator, is time- or session-bound by default, and
can be paused or revoked immediately. Organization administrators can disable
it. Cloud requests cannot silently enable it.

The cloud authorizes a signed, short-lived command; Desktop rechecks the
capability locally before execution. Native modules never receive unrestricted
host access by default.

## 10. Module Platform

### 10.1 Module classes

- industry modules: agents, workflows, forms, data definitions, and pages;
- AI applications: model capability, parameter forms, async tasks, and result
  components;
- automation modules: triggers, connectors, agents, and approval policies;
- desktop enhancements: declared native capabilities and device policies;
- project templates: initial project, agent, skill, permission, and data
  configuration.

### 10.2 Trust levels

1. Declarative Manifest/JSON Schema modules using standard components;
2. sandboxed Web modules communicating through a versioned host bridge;
3. signed and manually reviewed native modules with explicit device grants.

Third-party modules cannot access the platform database, other tenants,
platform secrets, host process APIs, or ungranted local directories.

### 10.3 Lifecycle

```text
create -> validate -> sandbox preview -> scan -> review -> sign -> publish
       -> install -> meter -> update / rollback / takedown
```

Every release stores its Manifest, permissions, dependency and domain list,
SBOM, build provenance, signature, review decision, and compatibility range.

AI modules use OpenAI-compatible providers, MCP, A2A, and the existing
Intelligence capability contract. Modalities such as image, video, audio, 3D,
and avatar remain asynchronous capability modules and write durable outputs to
Assets.

### 10.4 Revenue ledger

Each billable invocation produces an append-only usage record. Settlement
derives from collected payment minus model/infrastructure cost, platform fee,
tax, refund, and risk adjustments. The platform collects payment and settles
developers in batches; modules cannot independently charge end users.

## 11. Data Flow and Failure Behavior

### 11.1 Remote task

1. Web submits a typed request.
2. API authenticates and checks account, project, IAM, module, and budget.
3. API creates an idempotent task and usage estimate.
4. Worker invokes the provider/module/sandbox.
5. Results and provenance are stored in Assets.
6. SSE or polling updates Web.
7. Audit and settlement records are committed.

### 11.2 Local task

1. Web asks API to target a paired device.
2. API verifies device, account, project, capability, and policy.
3. A short-lived signed command is sent through the device channel.
4. Desktop rechecks local grants and obtains user confirmation when required.
5. Desktop executes locally and returns a bounded, sanitized result.
6. Web/API records audit and stores only user-selected outputs.

Failure rules:

- Desktop offline disables only local capabilities;
- provider timeouts preserve task state and idempotency keys;
- unknown provider outcomes are not charged twice;
- storage outages retain durable task state for recovery;
- settlement failures are replayable;
- permission changes take effect on the next call, without stale grant reuse.

Logs contain correlation IDs, task IDs, account/project IDs, status, and
sanitized error codes. They never contain provider credentials, signed URLs,
request secrets, or raw private provider bodies.

## 12. Compatibility and Verification Gates

Full-suite execution is not required for every change. Focused gates are
required in proportion to risk:

1. existing Web/API/SDK/database migration checks;
2. projects, sessions, agents, files, connectors, Review, and IAM flows;
3. Web-only operation with no Desktop process;
4. Desktop bridge, trusted-origin, native download, and OAuth callback tests;
5. controlled/full access, revoke, approval, and audit tests;
6. module Manifest, sandbox, permission, signature, and rollback tests;
7. tenant isolation, admin authorization, usage, and settlement tests;
8. build and health checks for Web, API, worker, and Desktop packages.

When a new OpenOPC flag is disabled, the Kortix baseline must behave as it did
before the change. Upstream synchronization must review core touchpoints,
route manifests, SDK exports, migrations, and desktop origin/protocol policy.

## 13. Delivery Phases

### Phase 0: Brand and compatibility foundation

Introduce the OpenOPC brand/runtime configuration, preserve Kortix aliases,
make CORS and trusted origins environment-driven, add dual protocol support,
and document hosted/self-hosted deployment variables.

### Phase 1: SaaS and operations foundation

Harden account/tenant boundaries, add OpenOPC subscription/usage surfaces,
extend `/admin`, and add operational audit/feature-flag views without changing
Kortix core routes.

### Phase 2: Desktop local capabilities

Add device pairing, local workspace/Git/CLI, browser automation, clipboard,
screenshots, notifications, controlled grants, and device-side full access.

### Phase 3: Developer Center and module platform

Add SDK/CLI facade, module Manifest, preview, sandbox, review, publication,
installation, rollback, metering, and settlement.

### Phase 4: Industry and AI modules

Deliver recruitment, local-information, content, image, video, audio, 3D,
avatar, and other capabilities as reviewed modules. Do not add first-party
media pages to the core navigation.

## 14. Acceptance Criteria

The foundation is accepted only when:

- OpenOPC is the visible product brand;
- Kortix core Web/API/SDK/database/CLI behavior remains functional;
- Web works fully without Desktop;
- Desktop loads the same Web product and adds only authorized local features;
- controlled and full-access modes have explicit, auditable behavior;
- hosted multi-tenant and self-hosted single-tenant modes share artifacts;
- `/admin` supports role-gated operations without a second data layer;
- modules are versioned, permissioned, sandboxed, reviewable, and rollbackable;
- usage and developer settlement records are durable and replayable;
- focused verification gates pass without requiring the full test suite.

