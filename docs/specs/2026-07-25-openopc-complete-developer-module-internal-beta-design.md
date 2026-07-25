# OpenOPC Complete Developer and Module Internal-Beta Design

**Status:** Approved design

**Approved:** 2026-07-25

**Target:** Complete invited internal beta on Web and Windows Desktop

## 1. Goal

Deliver a complete Developer Center and module system for an invited internal beta while preserving Kortix as the upgradeable base. The beta must cover developer onboarding, module creation, immutable upload, automatic verification, human review, signing, Dev/Beta/Stable publication, project installation, permission consent, declarative/WASI/OCI execution, usage metering, sandbox purchases, refunds, revenue sharing, settlement statements, updates, revocation, and rollback.

The beta is complete only when these flows run against real staging dependencies and pass the named acceptance gates in this document. Passing pure domain adapters or keeping the runtime disabled is not completion evidence.

## 2. Approved Product Decisions

| Decision | Approved boundary |
| --- | --- |
| Module execution | Declarative plus WASI Component Model plus OCI containers |
| Module UI | Platform-rendered Schema UI plus sandboxed cross-origin iframe |
| Developer access | Invitation only; platform verification required before Publisher creation or upload |
| Pricing | Free, one-time purchase, subscription, and metered usage |
| Internal-beta money | Real pricing, accounting, refunds, sharing, disputes, and settlement statements through a sandbox ledger; no real charge or payout |
| Revenue sharing | Versioned platform policy with defaults and Publisher/module overrides; every transaction binds its policy version |
| Permissions | Install-time project-admin consent plus runtime confirmation for high-risk actions |
| Release management | Immutable Dev, Beta, and Stable channels with canary update, pause, revoke, and exact rollback |
| Full deployment | Baota/Compose control plane plus independent Linux Runner nodes |
| Single-node deployment | Declarative and WASI only; OCI execution requires an independent Runner |
| Mobile | Deferred; Web and Windows Desktop are the beta clients |

## 3. Completion Boundary

The complete internal beta includes:

- invited developer verification and Publisher lifecycle;
- a developer CLI/SDK and Web workbench for build, validate, upload, release, findings, usage, and statements;
- declarative and Agent modules using existing Kortix capabilities;
- Schema UI rendered by the OpenOPC host;
- cross-origin sandboxed Web applications using a versioned Module Bridge;
- WASI components executed by Wasmtime;
- OCI workloads executed only on independent rootless containerd plus gVisor Runner nodes;
- real MinIO/S3 staging storage, real scanners, real PostgreSQL claims, and real sandbox dry-runs;
- sandbox commercial flows with balanced ledgers and developer statements;
- visible Web and packaged Windows Desktop acceptance;
- an upstream-compatibility rehearsal against the retained Kortix boundary.

The complete internal beta does not include:

- public developer registration;
- real card, wallet, bank, tax, invoice, or payout movement;
- production KMS keys or production activation;
- arbitrary third-party JavaScript loaded into the OpenOPC Web or API process;
- third-party `desktop-native` execution;
- Android or iOS acceptance;
- the cancelled first-party image, video, voice, 3D, digital-human, or batch-remix product pages.

Existing first-party Kortix desktop behavior remains available and is not reimplemented by the module system.

## 4. Architecture Decision

Use a dual-plane extension architecture.

### 4.1 Control plane

The control plane remains on the existing Kortix/OpenOPC Web, API, SDK, IAM, Billing, Registry, Marketplace, PostgreSQL, and object-storage boundaries. It owns authority and durable state:

- account, team, project, role, and platform-admin authority;
- developer invitation and verification;
- Publisher ownership;
- Registry Module Schema v2 and artifact identity;
- review, signing, publication, installation, update, rollback, and revocation;
- permission consent and runtime capability grants;
- pricing, usage acceptance, sandbox ledger, revenue sharing, disputes, and statements;
- audit events, OpenTelemetry trace context, feature readiness, and kill switches.

Web and Desktop use `@kortix/sdk`. They do not call Runner, object-store, scanner, provider, payment, or payout endpoints directly.

### 4.2 Execution plane

The execution plane is private and replaceable. It contains:

- `apps/developer-trust-worker` with concrete artifact, database-claim, scanner, sandbox-control, and attestation adapters;
- a new `apps/module-runner` process for WASI and OCI work claims;
- a capability broker for short-lived Secret, egress, model, desktop, and paid-call grants;
- an egress proxy that enforces DNS pinning, public destinations, declared origins, methods, redirects, and byte ceilings;
- an evidence sink for sanitized events, resource usage, outputs, and terminal results;
- a new `apps/module-ledger-worker` for idempotent usage aggregation and sandbox settlement.

Runner nodes receive no ordinary Kortix user token, project token, database credential, billing credential, or unrestricted object-store credential. They receive only signed, leased work envelopes and bounded capabilities.

### 4.3 Communication

Control-to-execution communication uses strict shared contracts:

1. API authorizes account, project, installation, exact release, and requested capability.
2. API creates an estimate and, when required, a human confirmation.
3. API persists a work item and signed lease envelope.
4. Runner claims work through its dedicated database/API identity.
5. Runner revalidates release digest, policy digest, capability grant, lease generation, and deadline.
6. Runner executes in the selected runtime and submits bounded evidence.
7. Control plane atomically fences the terminal result and appends usage intents to an outbox.
8. Ledger worker posts balanced entries idempotently.

Unknown outcomes never trigger an automatic paid retry.

## 5. Reuse of Existing Kortix and OpenOPC Foundations

| Existing foundation | Required use |
| --- | --- |
| `@kortix/registry` | Canonical module catalog and strict Module Schema v2 |
| `DeveloperArtifactStore` | Artifact upload, staging, digest recomputation, and canonical bytes |
| Developer trust tables and services | Artifacts, releases, verification runs/findings, attestations, review, and signing |
| `DeveloperModuleTrustGate` | Sole authority for approval and signing readiness |
| `DeveloperModuleDistributionService` | Publication, revocation, install, update, rollback, and signature verification |
| `projectModuleInstallations` and events | Exact project installation history and revision fencing |
| Kortix IAM | Account, project, role, capability, and platform-admin authority |
| Kortix Marketplace adapter | Published-module discovery; no second catalog |
| Kortix task/workflow/Agent runtime | Declarative and Agent execution |
| Kortix Billing and usage boundaries | Account and credit authority; module commerce is an additive adapter |
| `@kortix/sdk` | Only product client for Web and Desktop |

The design must not replace existing task/workflow state machines, session rows, IAM decisions, Marketplace catalogs, Billing identities, or SDK transport.

## 6. Module Contract

### 6.1 Registry Module Schema v2 remains canonical

The current strict Module Schema v2 and current execution modes remain valid:

- `declarative`;
- `agent`;
- `sandboxed-web`;
- `server-adapter`;
- `desktop-native`.

The complete internal beta maps them as follows:

| Registry execution mode | Internal-beta runtime |
| --- | --- |
| `declarative` | Existing Kortix SDK/API, task, workflow, Connector, and tool capabilities |
| `agent` | Existing Kortix Agent project runtime |
| `sandboxed-web` | Cross-origin sandboxed iframe plus Module Bridge |
| `server-adapter` | Strict runtime descriptor selecting WASI or OCI |
| `desktop-native` | Visible but third-party execution disabled for this beta |

No Schema v1 compatibility path is added.

### 6.2 Runtime descriptor

For `server-adapter`, `module.execution.entry` points to `openopc.runtime.json` inside the immutable artifact. The descriptor is covered by the artifact digest, reject-unknown-fields validation, review, SBOM, signature, install pin, and runtime verification.

The descriptor uses `descriptorVersion: 1`, independently of Registry Module Schema v2, and has exactly one runtime kind:

- `wasi-component`: component path, WIT world, exported operation, memory/fuel/time limits, and imported capability IDs;
- `oci-image`: immutable `sha256:` image digest, command/arguments, read-only input/output mounts, CPU/memory/PID/time limits, and required execution profile.

Tags, floating versions, host paths, privileged flags, host namespaces, device mounts, Docker/containerd sockets, and arbitrary environment inheritance are invalid.

### 6.3 Module UI contract

Schema UI supports platform-owned page, panel, form, result, table, chart, task, workflow, and asset components. The module contributes data and a signed component tree, not executable UI code. Component props, events, bindings, and SDK actions are strict and versioned.

Complex Web UI uses `sandboxed-web` on a separate module origin. Its iframe:

- has no same-origin access to OpenOPC cookies, storage, DOM, authentication, or service workers;
- uses a strict sandbox attribute and CSP;
- communicates only through a versioned `MessageChannel` handshake;
- binds account, project, installation, release digest, origin, nonce, expiry, and allowed command set;
- has bounded message size, frequency, navigation, download, clipboard, media, and popup behavior;
- never receives a Kortix bearer token, signed object URL, raw Secret, or unrestricted capability token.

The parent resolves typed bridge commands through `@kortix/sdk` and API IAM.

## 7. Developer and Publisher Lifecycle

1. A platform administrator invites a developer account.
2. The account joins or creates an approved organization/team.
3. Platform staff records verification state and bounded organization metadata.
4. Only a verified organization can claim a globally unique Publisher slug.
5. Publisher roles distinguish owner, developer, release manager, finance viewer, and support viewer.
6. Suspension immediately blocks uploads, submissions, promotions, and new execution without deleting historical evidence.
7. Every invitation, verification, role, Publisher, suspension, and reinstatement transition writes an immutable audit event.

Unverified users may browse public modules but cannot create a Publisher, upload, submit, or publish.

## 8. Release and Trust Lifecycle

The lifecycle is:

`draft -> uploaded -> validated -> verifying -> review_pending -> approved -> signed -> published -> revoked`

Verification can end in `passed`, `failed`, `inconclusive`, or `cancelled`. A terminal failed or inconclusive attempt does not become passing through manual input. Retry creates a new immutable attempt with a new policy snapshot.

Before approval or signing, code-bearing modules require current automatic evidence for:

- archive and path safety;
- complete artifact digest recomputation;
- Gitleaks secret scan;
- Syft CycloneDX SBOM;
- OSV dependency vulnerability scan;
- Semgrep source analysis;
- license policy;
- WASI component or OCI image identity;
- sandbox dry-run;
- capability and egress policy;
- DSSE/in-toto provenance binding artifact, policy, scanners, sandbox profile, and SBOM.

Internal-beta signing uses separate non-production Ed25519 release and attestation keys with distinct key IDs. Keys live outside the repository in the staging secret manager, are mounted read-only only into the signing boundary, and have tested rotation and revocation. This proves the signing interface and lifecycle without claiming production KMS acceptance.

Human reviewers see sanitized findings, permission diffs, pricing, Publisher history, runtime profile, policy identity, compatibility, and prior attempts. Approval uses revision fencing and segregation of duties.

Dev, Beta, and Stable channel promotion changes only a channel pointer to an exact signed release. It never changes artifact bytes or evidence.

## 9. Installation, Consent, and Capability Security

### 9.1 Install consent

A project administrator sees and accepts:

- exact module version and release digest;
- license and pricing plan;
- requested actions, Secrets, Connectors, tools, writes, network origins, and desktop abilities;
- runtime kind and resource ceilings;
- iframe/browser capabilities;
- compatibility and automatic-update policy.

The accepted permission snapshot is immutable for that installation revision. An update that adds permissions, broadens an origin, changes runtime kind, increases a resource/cost ceiling, adds a paid meter, or expands iframe capabilities requires new consent.

### 9.2 Runtime confirmation

Runtime confirmation is mandatory for:

- use of a Secret;
- a new external origin;
- desktop control;
- camera, microphone, clipboard, download, or popup mediation;
- irreversible writes;
- sensitive project data;
- a paid operation over the project threshold.

### 9.3 Capability tokens

Every capability token binds:

- account and project;
- installation and immutable release digest;
- actor and approved action;
- audience and runtime kind;
- nonce and expiry;
- call, byte, CPU, time, and cost ceiling;
- lease ID and generation where execution is asynchronous.

The broker stores only the token hash. Tokens are short-lived, audience-specific, non-forwardable, and revoked on terminal execution, installation suspension, release revocation, permission change, or kill-switch generation change.

## 10. Runtime Isolation

### 10.1 Declarative and Agent modules

These use existing Kortix capabilities and IAM. They do not receive direct provider URLs or credentials. Network and model calls remain behind existing adapters and the LLM Gateway.

### 10.2 WASI

Wasmtime runs Component Model modules with:

- no ambient filesystem, sockets, process spawning, clocks, randomness, or environment;
- only declared WIT imports supplied by the capability broker;
- explicit fuel, epoch deadline, memory, table, output, and concurrency limits;
- read-only immutable input and bounded output;
- brokered HTTP instead of raw sockets;
- cancellation and deterministic terminal evidence.

Single-node Baota/Compose can run WASI in a dedicated unprivileged worker process because the runtime exposes no OCI or host-control socket.

### 10.3 OCI

OCI runs only on registered independent Linux Runner nodes using rootless containerd and gVisor. Each invocation uses:

- a read-only root filesystem;
- non-root UID/GID;
- all Linux capabilities dropped;
- no-new-privileges;
- private PID, mount, IPC, user, and network namespaces;
- no host devices, paths, sockets, metadata endpoint, or private-network route;
- tmpfs scratch and bounded read-only input/output mounts;
- seccomp, AppArmor or equivalent host policy;
- CPU, memory, PID, file, byte, wall-time, and output limits;
- egress through the validation/runtime proxy only.

Runner registration binds node identity, supported profiles, attestation, software version, and drain state. The control plane never schedules OCI work to the single-node profile.

## 11. Pricing, Metering, and Sandbox Revenue Sharing

### 11.1 Pricing models

One module can publish versioned plans containing:

- free access;
- one-time project purchase;
- recurring project or seat subscription;
- metered units such as invocation, token, second, task, byte, or provider-defined resource unit.

Every estimate and charge binds the exact plan and price version. Floating prices are invalid.

### 11.2 Ledger

The ledger uses integer minor/micro units and double-entry postings. It records:

- customer sandbox debit and platform sandbox credit;
- provider/runtime cost allocation;
- developer gross revenue;
- platform fee;
- developer net revenue;
- refund and dispute reversals;
- settlement-period transfer to a sandbox payable balance.

Entries are append-only and balance per currency. Corrections use compensating entries. Execution, usage, and ledger idempotency keys are distinct and immutable.

### 11.3 Revenue policy

A versioned policy selects the split in this order:

1. module-specific override;
2. Publisher/tier override;
3. platform default.

Each order, subscription period, and metered usage batch stores the selected policy version. Later policy changes never rewrite prior economics.

### 11.4 Internal-beta adapter

The internal beta mounts sandbox purchase and payout adapters. It exercises the production data model and state transitions but cannot move real money. Sandbox balances and entries use an explicit environment namespace and can never be read as production credit or payable balances. Production payment, tax, invoice, and payout adapters are not configured.

## 12. Data Ownership

Existing tables remain authoritative for developers, artifacts, releases, verification, review, distribution, installation, accounts, IAM, audit, credits, and general usage.

Additive module-runtime entities are:

- runtime descriptors derived from immutable artifacts;
- Runner registrations and supported profiles;
- execution runs, leases, heartbeats, events, outputs, and terminal evidence;
- install consent revisions and runtime capability grants/uses;
- pricing plans and immutable price snapshots;
- module purchases and subscriptions;
- accepted usage intents and balanced ledger entries;
- revenue split policies and selected policy snapshots;
- settlement periods, statements, refunds, and disputes;
- transactional outbox records for execution-to-ledger delivery.

Every tenant-owned row carries account ID and, when applicable, project ID. Reads and writes qualify by tenant at the repository boundary. Existence is not disclosed across tenants. Evidence, price snapshots, split snapshots, terminal executions, ledger entries, settlement statements, and audit rows are immutable.

## 13. Failure and Recovery

| Failure point | Required behavior |
| --- | --- |
| Before dispatch | Reject or retry with the same idempotency key; create no usage charge |
| Lease or generation mismatch | Stop execution and capability use; stale worker cannot finalize |
| Runtime timeout or cancellation | Revoke grants, persist bounded terminal evidence, charge only policy-approved completed units |
| Unknown external outcome | Do not auto-retry as paid success; reconcile, then explicitly retry or refund |
| Ledger unavailable | Persist outbox; retry idempotently without changing execution result |
| Scanner unavailable or identity mismatch | Mark inconclusive; block approval and signing |
| Release revoked | Block new work; retain installation, execution, usage, and ledger history |
| Permission expansion | Pause update until a project administrator grants a new consent revision |
| Runner compromise | Drain node, advance kill-switch generation, revoke grants, quarantine affected evidence |

## 14. Operations and Readiness

Feature flags remain independent and default false:

- trust verification;
- module UI bridge;
- WASI execution;
- OCI execution;
- sandbox commerce.

Readiness reports each concrete dependency separately: object storage, PostgreSQL claims, policy, every scanner, attestation signer, sandbox control, Wasmtime, containerd/gVisor Runner capacity, capability broker, egress proxy, outbox, and ledger worker.

Health is not readiness. A process can be alive while unavailable for new module work. API submission, promotion, install, and execution fail closed according to their required components without disabling existing Kortix project, session, Agent, Marketplace, or declarative reads.

Required operational controls include:

- queue age, claim, heartbeat, stale lease, retry, and cancellation metrics;
- Runner capacity, version, attestation, drain, quarantine, and kill switch;
- scanner identity and policy drift alerts;
- artifact retention and orphan-cleanup reporting;
- execution resource, denial, timeout, and unknown-outcome metrics;
- usage/outbox lag and ledger imbalance alerts;
- audit-safe tracing with no prompt, credential, signed URL, raw source, or provider-body leakage;
- database and object-store backup plus restore rehearsal;
- rollback procedures that preserve schema-v2 signatures and immutable financial evidence.

Baota only manages the public Web/API reverse proxy and control-plane Compose stack. Runner, scanner, MinIO, PostgreSQL, capability broker, and egress-proxy ports are never public.

## 15. Internal-Beta Acceptance Gates

The internal beta remains disabled until all gates have fresh staging evidence.

| Gate | Required evidence |
| --- | --- |
| G1 Migration | Fresh PostgreSQL apply, idempotent second apply, upgrade/reset guard, backup and restore rehearsal |
| G2 Artifact storage | Real private MinIO/S3 upload, digest recomputation, retention, orphan cleanup, and cross-tenant denial |
| G3 Trust pipeline | Real pinned Gitleaks, Syft, OSV, Semgrep, license policy, SBOM, and signed provenance |
| G4 Malicious fixtures | Secret, traversal, decompression bomb, vulnerability, invalid integrity/signature, stale policy, and scanner crash fail closed |
| G5 WASI | Real component execution, import denial, resource limits, cancellation, egress mediation, and deterministic evidence |
| G6 OCI | Independent Runner, rootless containerd plus gVisor, host/socket/namespace denial, escape probes, and network policy |
| G7 UI/capability attacks | iframe origin/CSP/message fuzzing, token replay, permission escalation, Secret and signed-URL disclosure checks |
| G8 Tenant/authority | Opaque cross-account failures and visible Publisher, admin, project-admin, and end-user authority cases |
| G9 Sandbox commerce | Free, purchase, subscription, metering, refund, dispute, split, and settlement scenarios balance exactly |
| G10 Release lifecycle | Dev/Beta/Stable promotion, canary, re-consent, update, revoke, and exact rollback |
| G11 Web/Desktop | Named workflows pass visibly at desktop/mobile Web widths and packaged Windows Electron with no console errors or blank canvases |
| G12 Upstream compatibility | Clean upstream rebase rehearsal, protected-file diff audit, Kortix core smoke, SDK/API contracts, and disabled-state preservation |

The enablement ledger must distinguish focused, package, integration, browser, deployment, and production evidence. A focused pass is not a substitute for a real dependency or visible workflow.

## 16. Upstream Compatibility

Compatibility with Kortix upgrades is a design constraint, not a later cleanup task:

- all client access goes through `@kortix/sdk`;
- extension-owned services depend on ports and strict contracts rather than importing Web or API internals;
- Registry Schema v2 remains canonical; WASI/OCI selection is inside the digested runtime descriptor;
- existing Kortix execution modes, routes, events, IAM, Billing, Marketplace, and project/session schemas are not replaced;
- database changes are additive and tenant-qualified;
- new runtime paths are independently gated and disabled by default;
- UI contributions use Schema UI or the Module Bridge rather than patching host routes with third-party code;
- an upstream-rebase rehearsal and core-flow smoke are mandatory release gates;
- OpenOPC branding and extension presentation do not rename internal upstream package identities unnecessarily.

## 17. Design Self-Review Criteria

The implementation plan must map every approved decision and G1-G12 gate to exact files, interfaces, tests, commands, and commits. It must preserve the two deployment profiles, keep production money and public registration disabled, and avoid any claim that mocked adapters prove real sandbox or production readiness.
