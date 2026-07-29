# OpenOPC Public-Beta and BaoTa Deployment Design

- **Date:** 2026-07-28
- **Status:** Approved specification
- **Approved:** 2026-07-28
- **Target:** Complete public beta on Web and Windows Desktop
- **Base:** Kortix remains the upgradeable application base
- **Deployment:** BaoTa control node plus private execution node

## 1. Product Decision

OpenOPC is a Web-first multi-tenant SaaS product built as an additive product
layer on Kortix. The browser application is the complete primary product and
must remain usable when no Desktop process is running. The Windows Desktop
application loads the same business product and adds only explicit,
permissioned local-device capabilities.

The public beta includes the complete Developer Center and module system. It is
not complete if module upload, trust, review, publication, installation, UI,
execution, lifecycle, usage, sandbox commerce, and developer statements exist
only as schemas, disabled adapters, or local fixtures.

The public beta uses a two-node deployment:

1. A BaoTa control node hosts the public Web, independent Admin frontend, API,
   reverse proxy, and control-plane workers.
2. A private Linux execution node hosts the WASI Runner, independent OCI
   Runner, trust worker sandbox adapter, egress proxy, and execution support
   workers.

PostgreSQL, object storage, queues, Runner control endpoints, containerd, and
gVisor are not exposed to the public Internet.

This document is the target contract. Its approval does not assert that the
current repository or deployment already satisfies the contract.

## 2. Goals

1. Ship a complete OpenOPC Web SaaS for individuals, teams, developers, module
   consumers, and platform operators.
2. Preserve Kortix projects, sessions, Agents, multi-Agent collaboration,
   connectors, skills, files, sandboxes, automations, IAM, billing identities,
   SDK transport, CLI behavior, and Desktop login flows.
3. Deliver a complete public-beta Developer Center and module lifecycle.
4. Support `task`, `tool`, `workflow`, and `ui` module capabilities.
5. Support platform-rendered Schema UI and isolated Module App iframe UI.
6. Execute declarative, WASI Component Model, and OCI module workloads through
   separate authority and isolation boundaries.
7. Support free, purchase, subscription, metered usage, refunds, disputes,
   revenue sharing, and settlement statements through a sandbox ledger without
   real charge or payout.
8. Make Web, Admin, API, workers, and execution services independently
   deployable and observable.
9. Keep future Kortix upgrades absorbable through additive applications,
   packages, adapters, feature flags, and compatibility gates.
10. Establish reproducible public-beta evidence instead of relying on focused
    green tests or self-declared readiness reports.

## 3. Non-goals

- Android and iOS application acceptance. Responsive mobile Web remains in
  scope; native mobile clients are deferred.
- Real card, wallet, bank, tax, invoice, withdrawal, or payout movement.
- First-party finished-product pages for video, voice, professional 3D,
  digital-human, or batch-remix production.
- Replacing Kortix with a parallel business platform or duplicating its core
  task, session, IAM, marketplace, billing, or transport state machines.
- Wholesale renaming of `@kortix/*`, the `kortix` database schema, migration
  history, existing API contracts, protocol identifiers, or upstream release
  metadata.
- Loading arbitrary third-party JavaScript into the OpenOPC Web or API process.
- Allowing third-party modules to obtain unrestricted Desktop-native execution.
- Treating the full monorepo test suite as the required gate for every small
  change. Public-beta readiness uses fixed, risk-based lanes and real staging
  dependencies.

The cancelled multimedia products may be delivered as reviewed developer
modules using generic platform capabilities. They do not become privileged
first-party Studio pages or receive built-in provider ownership.

## 4. Existing Foundation and Public-Beta Gap

The repository already contains substantial OpenOPC SaaS, Developer Center,
module trust, publication, installation, runtime control-plane, and WASI Runner
foundations. Those foundations remain authoritative unless this public-beta
design explicitly expands them.

The public beta still requires end-to-end completion and evidence for these
surfaces:

- isolated Module App iframe hosting and the versioned host bridge;
- a usable module CLI and complete public developer workflow;
- pause, resume, reauthorization, rollback, and revoke lifecycle behavior;
- the independent module sandbox ledger and `module-ledger-worker`;
- real OCI execution on an independent rootless containerd plus gVisor Runner;
- an independently built and deployed Admin frontend;
- complete user-visible OpenOPC branding, including Desktop packaging;
- fail-closed registration and account-protection controls;
- reproducible `G1-G12` and public-beta gate evidence;
- staging deployment, production approval, backup restore, and disaster
  recovery evidence.

No item in this list is considered complete merely because a contract, feature
flag, fake adapter, fixture, or disabled implementation exists.

## 5. Deployment Architecture

### 5.1 Public control node

The BaoTa control node exposes only HTTPS through Nginx:

```text
Internet
   |
   v
BaoTa / Nginx :443
   |-- app.openopc.example   -> OpenOPC Web
   |-- admin.openopc.example -> OpenOPC Admin
   |-- api.openopc.example   -> OpenOPC API and realtime transport
   `-- <release-digest>.modules.openopc.example -> isolated Module App origin
```

The control node runs independently deployable artifacts for:

- OpenOPC Web;
- OpenOPC Admin;
- API and realtime transport;
- control-plane jobs and transactional outbox delivery;
- module review and publication orchestration;
- the module ledger worker and statement generation;
- audit, notification, and non-execution background work.

The Web and Admin frontend builds do not require the Desktop application.

### 5.2 Private services

PostgreSQL, Redis or the selected queue transport, and private object storage
bind only to private interfaces or a container network. They are reachable
from explicitly authorized services, not from the public Internet.

Object storage uses private buckets. Browser access is mediated through
short-lived, audience-bound delivery rather than permanent public URLs.

### 5.3 Private execution node

The execution node is reachable only through a private network such as
WireGuard, Tailscale, or an equivalent operator-managed private route. It runs:

- the module Runner claim and dispatch process;
- Wasmtime-based WASI execution;
- rootless containerd plus gVisor OCI execution;
- the trust worker's isolated validation adapter;
- the controlled egress proxy;
- capability broker adapters that do not expose platform credentials;
- execution evidence delivery back to the control plane.

Runner registration binds a node identity, software version, supported runtime
profiles, capacity, attestation state, and drain state. Control-plane services
never schedule OCI work to a node that does not report the independent OCI
profile.

### 5.4 Network rules

- Nginx is the only public ingress.
- OpenOPC authentication cookies are host-only and never use a parent-domain
  cookie that would be sent to `*.modules.openopc.example`.
- The Module App wildcard host serves no OpenOPC authentication cookie and
  maps each immutable release digest to a distinct origin.
- PostgreSQL, object storage administration, queue administration, containerd,
  gVisor, Docker sockets, Runner claim endpoints, and trust-worker endpoints
  have no public listener.
- Execution egress is denied by default and flows through a policy proxy.
- Private network routes exclude cloud metadata endpoints, control-node
  management interfaces, and unrelated private subnets.
- Security does not rely on `Host` headers. Host rejection reduces exposed
  surface; IAM, capability tokens, and runtime policy remain authoritative.

## 6. Product Surfaces and UX

### 6.1 Approved layout

OpenOPC uses the approved **Workspace-first three-column workbench**:

1. A compact primary rail selects Home, workspaces, Agents, tasks, modules,
   Developer Center, and account surfaces.
2. A contextual rail shows the active team or workspace, recent tasks, and
   relevant navigation for the selected product area.
3. The main work area keeps task, Agent, approval, execution, and output context
   together.

The top search surface searches tasks, Agents, modules, projects, and files.
Search is a productivity feature, not a replacement for predictable
navigation.

The visual language is a restrained Material 3 and Google Workspace-inspired
system implemented through the repository's existing Tailwind tokens,
Radix/shadcn-style primitives, and Lucide icons. It uses neutral surfaces,
small radii, restrained shadows, semantic status colors, and stable responsive
constraints. It avoids marketing-style heroes, decorative gradients, nested
cards, and modal-heavy workflows.

### 6.2 Complete Web surface

The Web application supports the complete remote product:

- account registration, sign-in, team and workspace management;
- Kortix project, session, Agent, multi-Agent, task, connector, skill, file,
  sandbox, automation, approval, and output workflows;
- module marketplace, install, permission consent, update, pause, resume,
  reauthorize, rollback, and uninstall or revoke response;
- Developer Center creation, validation, upload, findings, review, release,
  usage, sandbox commerce, disputes, and statements;
- remote model access and provider policy through the existing gateway and
  adapters;
- account usage, subscription, quotas, audit, and support surfaces.

Local-only actions are capability-aware. Their absence never blocks remote
Web workflows.

### 6.3 Independent Admin surface

Admin is an independent build and deployable artifact, targeting a dedicated
admin hostname. It may share typed packages, design tokens, IAM clients, and
domain components with Web, but it does not import or route through Web pages.

The Web hostname returns `404` for `/admin`, Admin chunks, and Admin-only
assets. The Admin hostname does not serve consumer routes. Admin APIs live
under an explicit administrative route namespace and require:

- an authenticated administrator identity;
- the exact server-side permission for each operation;
- tenant or platform scope qualification;
- step-up authentication for sensitive operations;
- immutable audit records for reads or writes that cross tenant boundaries.

Network restrictions such as VPN, ZTNA, or an operator IP allowlist are an
additional deployment control and never replace application authorization.

### 6.4 Desktop enhancement surface

OpenOPC Desktop presents the same product and adds:

- user-selected local workspace and filesystem access;
- local application connectors and OS integration;
- Desktop automation with visible approval and audit;
- a paired local execution node;
- native download, protocol, notification, and OAuth callback handling;
- local secret storage through Windows Credential Manager or the equivalent OS
  keychain;
- an explicitly enabled full-access mode.

Full-access mode is never silently enabled from the cloud. It requires a local
user action, a bounded grant, visible state, a short-lived signed command,
local revalidation, and an audit record. The cloud cannot broaden a local grant
without another local approval.

## 7. Brand and Kortix Upgrade Boundary

### 7.1 User-visible brand

The user-visible product name is **OpenOPC** in:

- Web and Admin titles, metadata, navigation, and public routes;
- emails, public documentation, support and onboarding copy;
- Desktop window titles, menus, splash screen, installer, shortcuts, update
  metadata, and execution-node display name;
- Developer Center, SDK facade, CLI facade, and Marketplace copy.

The Desktop execution-node display name is not "Edge Agent". It uses a clear
OpenOPC Desktop or local execution-node label.

### 7.2 Stable internal compatibility

The following remain stable unless a separate breaking-migration design is
approved:

- `@kortix/*` workspace package names and existing SDK exports;
- the `kortix` database schema, tables, migrations, and migration tooling;
- `KORTIX_*` environment variables and existing API headers;
- `kortix.yaml`, `.kortix` paths, and existing manifest schema IDs;
- the `KortixDesktop` user-agent compatibility token;
- the `kortix://` protocol and existing OAuth callbacks;
- existing Kortix `/v1` routes and transport contracts;
- upstream repository and release identifiers.

New `OPENOPC_*` settings take precedence and fall back to the corresponding
legacy setting. Public tooling may expose `@openopc/sdk`,
`@openopc/module-sdk`, and an `openopc` CLI facade while delegating to stable
internal implementations.

Because OpenOPC has not launched, newly introduced OpenOPC or module contracts
do not need compatibility decoders for abandoned pre-release v1 shapes. This
does not authorize breaking Kortix's existing `/v1` API contracts.

### 7.3 Additive implementation rule

New work prefers:

- independent applications and workers;
- additive packages and typed ports;
- extension registries and route registration;
- provider and runtime adapters;
- product-brand configuration;
- default-off feature flags until acceptance evidence exists.

Core Kortix files are modified only when no stable extension boundary can
support the behavior. Each such modification requires a focused compatibility
test and inclusion in the protected-file diff audit.

## 8. Identity, Teams, and Developer Admission

### 8.1 User registration

Public-beta users may self-register. Registration requires:

- verified email ownership;
- Turnstile or the configured equivalent challenge;
- rate limits across IP, device, email, account, and action dimensions;
- consistent password and magic-link policy;
- fail-closed behavior when verification, challenge, or token validation is
  unavailable;
- bounded session creation and refresh-token rotation;
- acceptance of versioned Terms, Privacy Notice, and Acceptable Use Policy;
- an authenticated data-export and account-deletion request path;
- a visible security, abuse, and module-reporting path.

Error responses do not disclose whether an unrelated account or tenant exists.

### 8.2 Teams and authority

Teams use existing Kortix account, organization, workspace, project, IAM,
SSO/SCIM, and billing identities. OpenOPC adds no parallel tenant model.

User, project administrator, team administrator, developer, Publisher owner,
release manager, finance viewer, support viewer, reviewer, and platform
administrator permissions remain distinct. A platform administrator crossing
tenant boundaries must provide a reason and produces an immutable audit entry.

### 8.3 Developer admission

Public-beta developers enter through either:

1. self-service application; or
2. administrator invitation.

Both paths lead to the same verification record, review state, suspension
behavior, and Publisher role model. Applying does not grant upload or release
authority. Only an approved developer organization may create a Publisher,
upload executable artifacts, or submit a release.

This expands the earlier invitation-only internal-beta policy. It does not
weaken verification or publication review.

## 9. Developer Center and Module System

### 9.1 Module capability contract

Registry Module Schema v2 remains canonical. Modules may declare one or more
of these product capabilities:

- `task`: a typed task entry and lifecycle integrated with existing task state;
- `tool`: a typed capability invocable by authorized Agents or workflows;
- `workflow`: a reusable multi-step workflow definition;
- `ui`: Schema UI and, when approved, an isolated Module App.

Runtime selection remains inside a digested runtime descriptor. It does not
fork the registry, Marketplace, or installation model.

### 9.2 Developer tooling

The public beta includes:

- `@openopc/module-sdk` as a public facade over stable typed contracts;
- an `openopc` CLI for login, project initialization, schema validation, local
  checks, packaging, upload, verification status, release submission, channel
  promotion, installation testing, and statement retrieval;
- a Web Developer Center for the same lifecycle, findings, audit, usage,
  disputes, and statements;
- deterministic local fixtures that supplement but never replace real staging
  acceptance.

The CLI returns structured machine-readable output and stable exit codes so it
can be used by developers, CI, and coding Agents.

### 9.3 Artifact and trust lifecycle

The lifecycle is:

```text
create -> validate -> package -> upload -> digest -> scan -> sandbox verify
       -> human review -> platform sign -> publish -> install -> execute
```

Each release binds an immutable artifact digest, manifest digest, runtime
descriptor digest, SBOM digest, trust attestation digest, policy digest,
signature, channel, price snapshot, and permission set.

Trust verification uses pinned adapters for secret scanning, dependency and
vulnerability analysis, static analysis, license policy, CycloneDX SBOM
generation, bounded sandbox tests, and DSSE/in-toto provenance. Scanner error,
timeout, stale policy, missing evidence, or signature mismatch fails closed.

Published versions cannot be overwritten. Corrections use a new version,
channel movement, revocation, or exact rollback.

### 9.4 Module UI

Schema UI is the default. The module supplies a signed, versioned component
tree and data; the OpenOPC host owns rendering, accessibility inherited from
the host primitives, IAM, navigation, actions, and error display.

Complex Module Apps run on a release-digest-specific origin in a cross-origin
iframe. Two Publishers or immutable releases never share a mutable Web origin.
The iframe:

- cannot access OpenOPC cookies, storage, DOM, authentication, or service
  workers;
- uses strict `sandbox` and CSP policy; the default profile omits
  `allow-same-origin`, and any approved profile that requires it still receives
  a dedicated release origin with no platform cookies;
- cannot register a service worker or create parent-domain state;
- communicates through a versioned `MessageChannel` handshake;
- binds account, project, installation, release digest, origin, nonce, expiry,
  and allowed command set;
- has bounded message, navigation, download, clipboard, media, popup, and
  network behavior;
- never receives a Kortix bearer token, raw secret, unrestricted capability
  token, or reusable object-storage URL.

The parent resolves typed commands through the canonical SDK and API IAM.

### 9.5 Install and lifecycle

Project administrators install a release and approve a complete permission,
origin, resource, cost, network, data, model, and UI capability snapshot.

The public beta supports:

- install and uninstall;
- pause and resume;
- update and canary update;
- reauthorization when permissions or cost expand;
- exact rollback to a retained immutable release;
- Publisher or platform revocation;
- emergency execution stop without deletion of history.

An update requires new consent when it adds a permission, broadens an origin,
changes runtime kind, raises a resource or cost ceiling, adds a paid meter, or
expands iframe capabilities.

## 10. Runtime Control and Isolation

### 10.1 Control-plane ownership

The API and database own execution authority, durable execution state, lease
generation, deadlines, capability grants, terminal evidence, outbox delivery,
accepted usage, and audit records. Runners never self-authorize work or mutate
terminal rows outside the server-owned protocol.

Claims, heartbeats, finalization, and retries are generation-aware. Terminal
execution, evidence, and accepted usage are immutable. Duplicate delivery is
absorbed through separate execution, usage, and ledger idempotency keys.

### 10.2 Declarative and Agent modules

Declarative modules use existing Kortix SDK, API, IAM, task, workflow,
Connector, tool, and model-gateway capabilities. They receive no provider URL
or credential and do not bypass normal quota, moderation, confirmation, or
audit rules.

### 10.3 WASI

Wasmtime executes Component Model modules with:

- no ambient filesystem, socket, process, environment, clock, or randomness;
- only declared WIT imports supplied by the capability broker;
- explicit fuel, epoch deadline, memory, table, output, concurrency, and cost
  limits;
- immutable bounded input and output;
- brokered HTTP instead of raw sockets;
- cancellation and deterministic terminal evidence.

WASI runs in a dedicated unprivileged Runner process. It does not receive a
container-control or host-control socket.

### 10.4 OCI

OCI runs only on the independent Linux Runner with rootless containerd and
gVisor. Each invocation uses:

- a read-only root filesystem and non-root UID/GID;
- all Linux capabilities dropped and `no-new-privileges`;
- private PID, mount, IPC, user, and network namespaces;
- no host device, path, socket, metadata endpoint, or unrelated private route;
- bounded tmpfs scratch and read-only input/output mounts;
- seccomp and AppArmor or an equivalent host policy;
- CPU, memory, PID, file, byte, wall-time, output, concurrency, and cost limits;
- egress only through the runtime proxy.

Production OCI execution is not provided by Docker Compose on the BaoTa
control node.

## 11. Sandbox Commercial Ledger

User subscription and quota accounting remains separate from module commerce.
The module sandbox ledger models realistic commercial behavior without moving
real money.

It supports:

- free access;
- one-time purchases;
- subscriptions;
- metered usage;
- refunds and compensating entries;
- disputes and dispute resolution;
- versioned platform and Publisher revenue splits;
- developer settlement statements.

The ledger uses integer minor or micro units and double-entry postings. Entries
are append-only and balance per currency. Corrections use compensating entries.
Every transaction binds its price, split, policy, release, installation,
account, project, execution, usage, and idempotency snapshots.

`module-ledger-worker` accepts durable usage through the transactional outbox.
It cannot infer billable usage from mutable UI state or Runner self-reporting.
No public-beta screen may present sandbox balances as withdrawable funds.

## 12. Secrets, Security, and Audit

### 12.1 Secrets

- Cloud provider credentials use KMS envelope encryption in hosted
  environments.
- Self-hosted deployments use a documented secret provider with the same
  typed secret boundary; plaintext database storage is prohibited.
- Desktop credentials use the OS keychain and are not silently synchronized to
  Web.
- Logs, traces, errors, findings, and audit payloads redact API keys, bearer
  tokens, cookies, credentials, signed URLs, and detected prompt secrets.
- Runners receive bounded capabilities or one-time references, never platform
  master credentials.

### 12.2 Administrative and sensitive actions

Administrators require MFA or Passkey. Module signing, revocation, settlement
adjustment, cross-tenant support access, full-access Desktop grants, and secret
changes require step-up authentication and immutable audit.

Audit records include actor, authority, tenant or platform scope, reason,
request correlation, target, decision, and before/after digests when
applicable. Audit records do not store secret values.

### 12.3 Supply-chain security

Module releases use content-addressed artifacts, CycloneDX SBOM, DSSE/in-toto
provenance, platform signature, immutable versioning, retained evidence, and a
revocation path. Platform deployment artifacts use equivalent provenance and
commit binding for public-beta releases.

## 13. Reliability and Observability

OpenTelemetry is the common telemetry contract across Web, Admin, API, outbox,
workers, trust pipeline, ledger, and Runners. Each user task and module
execution carries a correlation ID through every asynchronous hop without
exposing another tenant's identifiers.

Metrics and traces cover:

- API availability and latency;
- authentication and abuse-control decisions;
- task queue depth and oldest age;
- claim, lease, heartbeat, retry, cancellation, and terminalization latency;
- WASI and OCI capacity, saturation, resource limits, and isolation failures;
- trust scanner latency, failures, findings, and policy age;
- external model latency, provider error class, token or unit usage, and cost;
- outbox lag, usage acceptance lag, ledger imbalance, and statement generation;
- object-storage failures and signed-delivery failures.

The failure model uses durable queues, transactional outbox, generation-aware
leases, bounded exponential backoff, dead-letter handling, circuit breakers,
and idempotent finalization. Provider fallback is policy-driven and only occurs
between semantically compatible profiles; it never silently changes a model's
data policy, cost ceiling, or capability class.

Execution-node loss leaves work queued or expires its lease for controlled
retry. It does not lose accepted usage, duplicate a terminal settlement, or
make the control plane unavailable. Control-node loss prevents new authority
decisions; Runners fail closed when their current grant expires.

## 14. Backup, Restore, and Disaster Recovery

The public-beta target is:

- **RPO:** no more than 15 minutes;
- **RTO:** no more than 4 hours.

PostgreSQL uses daily full backups plus continuous WAL archiving and
point-in-time recovery. Object storage uses versioning, retention, and an
independently protected backup or replication target. Configuration, signing
metadata, deployment manifests, and secret-provider recovery procedures are
versioned without storing plaintext secrets in the repository.

Public beta remains disabled until an isolated environment restores:

1. PostgreSQL to a selected point in time;
2. referenced module and user artifacts;
3. release, trust, installation, execution, ledger, and audit consistency;
4. a functioning Web/API/worker/Runner staging deployment.

A backup file, scheduled job, or Velero plan without a successful measured
restore does not satisfy the gate.

## 15. Deployment and Release Operations

### 15.1 Independent artifacts

The release produces versioned artifacts for Web, Admin, API, each worker, the
WASI/OCI Runner, and Desktop. Web and Admin can be deployed without building or
starting Desktop.

Local Compose remains a development and staging helper. It is not treated as
proof of the production two-node topology or OCI isolation.

### 15.2 Schema and rollout safety

Migration lint, apply, idempotent second apply, rollback or reset guards, and
the real PostgreSQL integration lane are mandatory. Deployment automation must
not disable schema consistency checks.

Rollout order is compatible with expand-and-contract migrations:

1. backup and preflight;
2. backward-compatible migrations;
3. API and workers;
4. Web and Admin;
5. Runners;
6. feature enablement after health and evidence checks.

Each artifact is bound to the same release commit and retains a documented
rollback target.

### 15.3 Production approval

The GitHub `production` environment or the selected equivalent requires an
authorized human approver. The approver sees the commit, artifact digests,
staging evidence, migration result, backup state, rollback target, and open
risk exceptions.

### 15.4 Public policy and regional prerequisites

Before public registration opens, the operator publishes versioned Terms,
Privacy Notice, Acceptable Use Policy, module publishing rules, data retention
and deletion rules, security contact, and abuse-reporting process. User and
developer acceptance records bind the exact policy versions.

The operator also completes the domain, filing, privacy, content-governance,
and incident-notification requirements that apply to the actual deployment
region. For a mainland-China public deployment this includes the applicable
ICP and related service approvals. These approvals are external release
evidence; a code or staging pass cannot substitute for them.

## 16. Acceptance Evidence Contract

### 16.1 Evidence rules

Every gate binds:

- a fixed CI workflow and lane name;
- the exact source commit and artifact digests;
- the staging environment identity and URL where applicable;
- start and completion timestamps;
- a maximum evidence age;
- raw machine-generated output and retained artifacts;
- a final pass, fail, or blocked result.

The canonical staging environment ID is `openopc-public-beta-staging`. Unless a
gate states otherwise, evidence expires 72 hours after completion and must bind
the exact release-candidate commit. `B10` exposure, TLS, realtime, and health
evidence expires after 24 hours. The expensive `B7` isolated restore may be up
to seven days old only when it uses the same schema and artifact set; a fresh
24-hour post-restore consistency smoke remains required. Production approval
is created only after every current gate is valid.

Evidence is invalid when it is `not-run`, belongs to another commit, uses an
unapproved environment, is stale, omits the required lane, or only asserts a
fixture's self-created object. Re-running until a flaky test happens to pass
does not erase prior failures; the failure and the stability fix remain part of
the evidence.

The evidence validator rejects a public-beta manifest unless every required
gate is present and fresh.

### 16.2 Existing `G1-G12`

| Gate | Canonical lane | Required evidence |
| --- | --- | --- |
| G1 Migration | `public-beta-g1-migration` | Fresh PostgreSQL apply, idempotent second apply, upgrade/reset guard, backup, and restore rehearsal |
| G2 Artifact storage | `public-beta-g2-artifact-storage` | Real private MinIO/S3 upload, digest recomputation, retention, orphan cleanup, and cross-tenant denial |
| G3 Trust pipeline | `public-beta-g3-trust-pipeline` | Real pinned secret, SBOM, vulnerability, static-analysis, license, and signed-provenance adapters |
| G4 Malicious fixtures | `public-beta-g4-malicious-fixtures` | Secret, traversal, decompression bomb, vulnerability, invalid integrity/signature, stale policy, and scanner-crash fail-closed cases |
| G5 WASI | `public-beta-g5-wasi` | Real component execution, import denial, resource limits, cancellation, egress mediation, and deterministic evidence |
| G6 OCI | `public-beta-g6-oci` | Independent Runner, rootless containerd plus gVisor, host/socket/namespace denial, escape probes, and network policy |
| G7 UI/capability attacks | `public-beta-g7-ui-capability` | Iframe origin/CSP/message fuzzing, token replay, permission escalation, secret, and signed-URL disclosure checks |
| G8 Tenant/authority | `public-beta-g8-tenant-authority` | Opaque cross-account failures and visible Publisher, admin, project-admin, developer, and end-user authority cases |
| G9 Sandbox commerce | `public-beta-g9-sandbox-commerce` | Free, purchase, subscription, metering, refund, dispute, split, and settlement scenarios balance exactly |
| G10 Release lifecycle | `public-beta-g10-release-lifecycle` | Dev/Beta/Stable promotion, canary, re-consent, pause, resume, update, revoke, and exact rollback |
| G11 Web/Desktop | `public-beta-g11-web-desktop` | Named workflows pass visibly at desktop and mobile Web widths and packaged Windows Desktop with no console errors or blank canvases |
| G12 Upstream compatibility | `public-beta-g12-upstream-compatibility` | Upstream update rehearsal, protected-file diff audit, Kortix core smoke, SDK/API contracts, and disabled-state preservation |

### 16.3 Public-beta `B1-B10`

| Gate | Canonical lane | Required evidence |
| --- | --- | --- |
| B1 Registration and abuse control | `public-beta-b1-registration` | Verified email, Turnstile, rate limits, password and magic-link parity, enumeration resistance, dependency-failure fail-closed behavior, policy-version consent, and export/deletion request paths |
| B2 Web independence | `public-beta-b2-web-independence` | Complete named remote workflows with no Desktop process, bridge, local daemon, or Desktop-only secret available |
| B3 Admin isolation | `public-beta-b3-admin-isolation` | Independent build and hostname, Web-host route rejection, administrative IAM, step-up authentication, cross-tenant audit, and deployment smoke |
| B4 Complete module workflow | `public-beta-b4-module-workflow` | Apply/invite, policy acceptance, verify, create, CLI/SDK validate, upload, scan, review, sign, publish, install, consent, update, pause, resume, reauthorize, rollback, revoke, report, and uninstall |
| B5 Production runtime isolation | `public-beta-b5-runtime-isolation` | Real WASI and independent OCI executions with authority, lease, capability, resource, egress, cancellation, and escape-denial evidence |
| B6 Sandbox ledger | `public-beta-b6-sandbox-ledger` | Durable usage acceptance, worker idempotency, balanced postings, refunds, disputes, versioned splits, statements, and no real-money representation |
| B7 Backup and recovery | `public-beta-b7-backup-recovery` | Isolated PITR and object restore meeting the stated RPO/RTO with consistency verification |
| B8 Telemetry and incident response | `public-beta-b8-telemetry-incident` | End-to-end OpenTelemetry correlation, SLO dashboards, actionable alerts, dead-letter recovery, and one staged failure drill |
| B9 Brand and upstream boundary | `public-beta-b9-brand-upstream` | OpenOPC visible-brand audit, retained internal compatibility IDs, protected-file diff, and upstream-update rehearsal |
| B10 Two-node deployment | `public-beta-b10-two-node-deployment` | BaoTa control node plus private execution node, public exposure scan, TLS/realtime smoke, private dependency checks, regional prerequisite record, and artifact/commit consistency |

Focused, package, integration, browser, deployment, and production evidence are
separate categories. A focused unit-test pass does not replace the lane that
uses a real dependency or visible packaged workflow.

## 17. Delivery Sequence

The implementation plan will split this design into independently reviewable
stages. The required dependency order is:

1. evidence contract, deployment preflight, and compatibility inventory;
2. public registration hardening and independent Admin artifact;
3. OpenOPC visible-brand completion and Workspace-first navigation;
4. Module Bridge, isolated Module App host, SDK, and CLI;
5. complete module lifecycle and reauthorization behavior;
6. sandbox ledger schema, outbox binding, worker, and statements;
7. production WASI evidence and independent OCI Runner;
8. two-node staging deployment, telemetry, backup restore, and failure drills;
9. `G1-G12` plus `B1-B10` evidence closure;
10. human public-beta release approval.

Default-off runtime and commercial flags remain disabled until their complete
stage and corresponding gates pass. This sequence may be parallelized only
where authority, schema, and evidence dependencies do not overlap.

## 18. Public-Beta Acceptance Criteria

OpenOPC is ready for public beta only when all of these statements are true:

- Web is complete and works without Desktop.
- Admin is an independent deployable surface with authoritative IAM and audit.
- Windows Desktop retains Kortix behavior, displays OpenOPC branding, and adds
  only locally authorized capabilities.
- Existing Kortix core workflows remain functional when OpenOPC additions are
  disabled.
- Public registration and developer application fail closed and resist basic
  abuse and enumeration.
- Developer Center and module CLI/SDK provide a complete usable lifecycle.
- Schema UI and cross-origin Module Apps work through the bounded bridge.
- WASI executes in production policy and OCI executes only on the independent
  rootless containerd plus gVisor Runner.
- Module lifecycle, permission re-consent, revocation, and exact rollback are
  visible and durable.
- Sandbox commerce balances exactly and cannot be confused with real money.
- Secrets, capability tokens, signed delivery, audit, and tenant boundaries
  pass the named attack cases.
- OpenTelemetry traces the named workflows across asynchronous boundaries.
- A real isolated restore meets `RPO <= 15 minutes` and `RTO <= 4 hours`.
- Every `G1-G12` and `B1-B10` gate has fresh, commit-bound staging evidence.
- The approved release uses consistent artifacts and a documented rollback
  target.
- An authorized human approves the public-beta release.

Until every criterion passes, status remains **not ready for public beta**.

## 19. Deferred Work

The following require separate post-beta decisions and plans:

- Android and iOS native acceptance;
- real payment acquiring, tax, invoicing, payout, and withdrawal;
- third-party Desktop-native module execution;
- a larger multi-region control plane;
- production certification claims beyond the verified deployment evidence;
- reintroduction of any cancelled first-party multimedia product page.

## 20. Decision Reconciliation

This public-beta design reconciles earlier approved designs as follows:

- Kortix remains the sole upgradeable base.
- Web-first SaaS and Desktop enhancement boundaries remain unchanged.
- The independent Admin build and hostname supersede the earlier first-step
  design that mounted `/admin` inside the Web Next application; the existing
  Admin API and data authority remain shared rather than duplicated.
- The complete developer/module internal-beta contract becomes a required
  subset of public beta.
- Developer admission expands from invitation-only to self-service application
  plus invitation, while verification and publication review remain required.
- Sandbox commerce remains complete but non-monetary.
- Android and iOS remain deferred.
- The multimedia first-party page cancellation remains in force.
- OpenOPC pre-release module contracts do not carry abandoned v1 compatibility,
  while existing Kortix `/v1` contracts remain protected.
