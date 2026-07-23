# OpenOPC Browser Approval Resume Production Activation Design

**Date:** 2026-07-23

**Status:** Approved for implementation planning

**Scope:** Production composition, activation gates, readiness, and lifecycle for Browser Approval Resume

**Default behavior:** Disabled and fail-closed

## 1. Context

The Browser Approval Resume foundation is implemented and covered by focused tests:

- lease-bound, one-time resume credentials;
- raw tokens that are never persisted;
- atomic approval consumption and Job/Step start;
- authenticated Worker consumption;
- versioned capability-gated dispatch;
- external-effect gating in the Worker;
- reuse of the existing coordinator poller;
- default-disabled runtime factories.

The remaining gap is production composition. The Control service currently composes its base
HTTP routes, database, Redis, desktop dispatch, and Browser heartbeat route. The Browser resume
route, dispatcher, connection, resume store, resume coordinator, and Worker execution loop are
not yet composed as one production lifecycle. The Browser Worker still starts its fail-closed
server when `worker.ts` is executed directly.

This phase closes that composition gap without enabling the feature by default and without
changing Kortix public API or core product behavior.

## 2. Goals

1. Compose the Control-side Browser Approval Resume components behind all existing feature gates.
2. Compose the Worker-side authenticated dispatch source, approval client, heartbeat client, and
   Browser execution loop behind the corresponding Worker gates.
3. Make liveness, readiness, connection state, and shutdown behavior explicit and testable.
4. Ensure incomplete configuration or missing production execution bindings fail closed.
5. Keep the existing poller as the only scheduler for desktop and Browser resume work.
6. Keep the default-disabled behavior byte-for-byte compatible at the public API boundary.
7. Minimize changes to existing Kortix-facing entrypoints so later upstream updates remain easy to
   merge.

## 3. Non-goals

- Enabling Browser Approval Resume in any deployed environment.
- Performing a production deployment or changing production secrets.
- Claiming real PostgreSQL multi-connection concurrency validation.
- Claiming real Browser end-to-end validation.
- Adding a second scheduler, queue, or sidecar process.
- Changing public approval, IAM, Agent, Workflow, Billing, Registry, or Orchestration contracts.
- Replaying a Step that has already entered `running` after an unknown external side effect.
- Reformatting historical CRLF or Biome debt in unrelated database files.

## 4. Approaches Considered

### 4.1 Thin entrypoints plus production composition modules (selected)

Create independently testable production composition modules for Control and Worker. Existing
entrypoints only load configuration, create the runtime, start it, and delegate shutdown.

This approach provides explicit ownership and test seams while keeping changes to upstream-facing
files small.

### 4.2 Inline composition in existing entrypoints

This uses fewer files but makes `main.ts` and `worker.ts` own configuration, networking,
authentication, polling, execution, readiness, and shutdown. It increases upgrade conflicts and
makes lifecycle tests harder.

### 4.3 Separate sidecar process

This avoids modifying the current entrypoints but adds a second deployment unit, port surface, and
lifecycle. It also risks creating a parallel runtime rather than extending the existing automation
service.

## 5. Architecture

### 5.1 Control production runtime

Add a Control production composition module that owns the complete service lifecycle. It composes:

- PostgreSQL and Redis clients;
- the automation repository and lease manager;
- public/internal automation routes;
- one shared Worker security context;
- Browser heartbeat and approval-consume routes;
- the PostgreSQL Browser Approval Resume store;
- the authenticated Browser Worker WSS connection;
- the Browser dispatcher;
- the Browser Approval Resume coordinator;
- the existing desktop coordinator;
- the existing composite poller;
- health/readiness probes and graceful shutdown.

The shared Worker security context separates two responsibilities:

- **remote verification:** trusted Worker identities, fingerprints, secrets, and Redis-backed replay
  protection;
- **local signing:** the Control service identity, certificate fingerprint, and dedicated
  Control-to-Worker secret.

The Control service must not add its own identity to the accepted remote Worker list merely to sign
outbound messages. Local signing identity and remote trust remain separate least-privilege
boundaries.

The existing `main.ts` becomes a thin bootstrap. It must not continue accumulating Browser-specific
composition details.

### 5.2 Worker production runtime

Add a Worker production composition module that owns:

- strict Worker configuration loading;
- the authenticated WSS dispatch source and server;
- the configured heartbeat client;
- the configured Approval Resume consumption client;
- production Browser execution bindings;
- the Browser Worker loop;
- readiness state and graceful shutdown.

The production runtime must map a verified dispatch envelope into the existing
`runBrowserWorker` input without replacing validation callbacks with constant values or test-only
adapters. The binding factory must supply every required authority, evidence, audit, action-event,
approval, profile, and runtime-isolation dependency. If a real binding cannot be constructed, the
Worker fails startup and must not accept dispatch.

Production execution bindings use these concrete sources:

- the verified dispatch source supplies immutable envelope provenance and static request/lease
  binding;
- a versioned, Worker-authenticated internal Control authority-check route validates the current
  lease, kill-switch generation, action hash, resume cursor, and full-access grant before each
  action boundary;
- the existing approval-consume route performs the atomic external-effect gate;
- the existing authenticated heartbeat channel carries audit, action, progress, and terminal
  events;
- the existing S3-compatible Studio object-store adapter stores Browser evidence under a private,
  tenant/project/job-bound prefix and returns an opaque object reference rather than a signed URL;
- the existing Browser profile store/broker boundary is used only for requests that explicitly
  require a persistent profile; the Worker rejects such a request when no broker is configured;
- runtime-isolation attestation is produced locally by the Worker container/runtime boundary and
  cannot be asserted by Control configuration.

The authority-check route is internal-only. It uses the same mTLS attestation, Worker identity,
body-signing, replay protection, body-size, and timeout controls as heartbeat and approval consume.
It does not expose raw credentials or create a new public API.

Add a thin Worker `main.ts` for the production bootstrap. Keep `worker.ts` as the testable execution
library. Direct execution of the legacy `worker.ts` continues to start the existing fail-closed
server so development and upgrade behavior does not silently become permissive.

### 5.3 Entrypoint and packaging changes

The intended change surface is limited to:

- new Control and Worker production composition modules and focused tests;
- a small delegation change in the Control entrypoint;
- a new thin Worker entrypoint;
- the Worker start command and Docker command pointing at that entrypoint;
- scoped configuration, readiness, and lifecycle tests.

No public route or core Kortix application entrypoint is renamed. The product-facing name remains
OpenOPC while package compatibility remains unchanged.

## 6. Activation and Configuration

### 6.1 Control gate chain

Browser Approval Resume may be composed only when all of these are true:

```text
AUTOMATION_CONTROL_ENABLED=true
AUTOMATION_BROWSER_HEARTBEAT_ENABLED=true
AUTOMATION_BROWSER_DISPATCH_ENABLED=true
AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED=true
```

The following values are additionally required only when their dependent feature is enabled:

- trusted Browser Worker identities and certificate fingerprints;
- Worker TLS attestation secret;
- WSS Worker URL and Control mTLS certificate paths;
- `AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256` for signed dispatch proofs;
- `AUTOMATION_CONTROL_WORKER_SHARED_SECRET` as the dedicated Control-to-Worker signing secret;
- `AUTOMATION_APPROVAL_RESUME_TOKEN_PEPPER` with at least 32 bytes;
- the existing private S3-compatible Studio object-store configuration for Browser evidence.

The runtime must not reuse `AUTOMATION_CONTROL_SHARED_SECRET`, storage credentials, or another
public/internal API secret as the Worker dispatch signing secret.

### 6.2 Worker gate chain

The Worker may advertise and accept `browser.approval-resume.v1` only when all of these are true:

```text
AUTOMATION_BROWSER_HEARTBEAT_ENABLED=true
AUTOMATION_BROWSER_DISPATCH_ENABLED=true
AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED=true
```

An existing non-resume `automation.v1` Browser dispatch may remain enabled while
`AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED=false`; this phase does not change that protocol's
semantics.

The Worker also requires its existing service identity, Control identity, certificate fingerprints,
dedicated shared secrets, trusted TLS-attestation configuration, mTLS client files for calls back to
Control, and bounded transport limits.

### 6.3 Disabled and invalid states

- All new feature flags default to `false`.
- Disabled mode opens no Browser dispatch connection, creates no Resume Attempt, and performs no
  Browser side effect.
- A partially enabled gate chain is a configuration error, not a degraded execution mode.
- Missing secrets, invalid certificate paths, invalid URLs, incomplete production bindings, or an
  unavailable required object-store configuration fail startup before accepting work when Browser
  Approval Resume is enabled.
- Secrets are never given placeholder defaults.

## 7. Runtime Data Flow

```text
Control startup
  -> validate gates and secrets
  -> initialize PostgreSQL, Redis, security context, routes, connection
  -> compose desktop + Browser resume runners into the existing poller

Worker startup
  -> validate gates and execution bindings
  -> start authenticated WSS source and Worker loop
  -> establish the trusted Control session

Poller
  -> list approved + pending Browser candidates
  -> claim a fresh lease
  -> issue a short-lived, bound Resume Attempt in PostgreSQL
  -> send a signed browser.approval-resume.v1 envelope

Worker
  -> verify TLS attestation, Control identity, proof, lease window, and envelope binding
  -> return a signed receipt with browser.approval-resume.v1 capability
  -> call the authenticated authority-check route at each action boundary
  -> call consume-and-start before any external effect

Control transaction
  -> verify the credential and current lease
  -> Approval: approved -> consumed
  -> Step: pending -> running
  -> append the unique start event

Worker
  -> execute Browser actions
  -> emit authenticated heartbeat and result events
```

The raw Resume token exists only in Control memory while constructing the signed envelope, in the
encrypted transport, and in Worker memory while consuming it. It never enters public routes,
browser UI, URLs, logs, metrics, audit payloads, or persistent storage.

## 8. Readiness and Health

### 8.1 Control

`/health` is a liveness endpoint. When the service is enabled it reports process/dependency health;
it does not claim that Browser dispatch is ready.

`/ready` returns `200` only when the enabled capabilities can accept work. With Browser Approval
Resume enabled, readiness requires:

- PostgreSQL available;
- Redis available;
- the Resume store, dispatcher, coordinator, and consume route composed;
- the authenticated WSS transport connected and usable;
- the poller running and not shutting down.

Worker capability is still verified on each signed dispatch receipt. A local configuration value
cannot substitute for the remote capability assertion.

### 8.2 Worker

Worker `/health` reports liveness without exposing credentials or certificate material.

Worker `/ready` returns `200` only when:

- every production execution binding is initialized;
- the Worker loop is running;
- the dispatch source is accepting work;
- an authenticated Control session is connected;
- shutdown has not begun.

Listening on a port alone is not readiness.

### 8.3 State transitions

- A WSS disconnect immediately changes both sides to not ready for Browser resume dispatch.
- The Worker aborts requests that have not crossed the external-effect gate.
- The Control connection manager uses bounded backoff to establish a fresh connection.
- A connection with an unknown dispatch result is discarded rather than reused.
- Readiness probes contain only stable state labels and dependency status, never secrets.

## 9. Failure Semantics

| Failure | Required result |
| --- | --- |
| Dispatch fails before send | Release the lease; no Browser effect |
| Result unknown after send | Discard connection; do not replay within the same lease |
| Consume returns conflict | Treat as terminal/competing attempt; do not execute |
| Consume returns unavailable | Do not execute; retry only under a fresh valid lease |
| WSS or authentication failure | Mark not ready and stop accepting Browser resume work |
| Heartbeat failure | Abort the active Worker execution and close its resources |
| PostgreSQL or Redis unavailable | Control readiness is 503; no accepted resume work |
| Worker execution binding missing at startup | Startup failure; no dispatch acceptance |
| Authority or evidence dependency becomes unavailable | Worker readiness 503 and current action aborts before its effect |
| Step already running | Never automatically replay |

Shutdown is idempotent. The order is:

1. stop scheduling new polls;
2. drain or abort the active poll within a bounded deadline;
3. close the Control-to-Worker connection;
4. abort the Worker loop and dispatch source;
5. stop HTTP/WSS servers;
6. close Redis and database resources.

A failure while closing one resource must not prevent attempts to close the remaining resources.

## 10. Observability and Secret Handling

Retain the structured Browser resume events:

- `browser_resume_attempt_issued`;
- `browser_resume_dispatched`;
- `browser_resume_consumed`;
- `browser_resume_rejected`;
- `browser_resume_expired`;
- `browser_resume_duplicate`.

Add bounded runtime events for started, ready, disconnected, not-ready, and shutdown transitions.
Events may contain stable error codes and these identifiers where applicable:

```text
jobId, stepId, approvalId, attemptId, workerId, serviceId, traceId
```

They must not contain:

```text
raw token, token hash, token pepper, shared secret, certificate body,
private key path contents, signature, signed URL, or authorization header
```

Telemetry failures never change credential or dispatch semantics.

## 11. Testing Strategy

Implementation follows TDD for each composition boundary.

### 11.1 Focused tests

Cover at least:

- all gate combinations and default-disabled behavior;
- strict missing/invalid secret and certificate configuration;
- separate local signing and remote verification identities;
- authenticated authority checks for lease, generation, action hash, cursor, and full access;
- private object-store evidence references without signed URLs in events;
- Control runtime construction and single-poller composition;
- Worker runtime construction without test-only bindings;
- readiness transitions for startup, connection, disconnect, and shutdown;
- unknown dispatch result connection disposal;
- Worker rejection before the external-effect gate;
- idempotent, bounded shutdown with partial close failures;
- structured logging and secret redaction;
- unchanged public API responses and disabled behavior.

Run package tests and typechecks for:

- `@kortix/intelligence-contracts`;
- `@kortix/db`;
- `@kortix/automation-control`;
- `@kortix/automation-browser-worker`.

Run Biome only on the files changed in this phase. Do not autoformat unrelated historical files.

### 11.2 Container smoke checks

Build the Control and Worker images. Verify:

- default-disabled startup remains fail-closed;
- invalid partial activation is rejected;
- health and readiness differ as designed;
- neither image logs configured secrets.

These checks are local container evidence, not deployment evidence.

### 11.3 Full repository regression

After focused checks pass, run the restored full repository test command:

```powershell
pnpm.cmd --reporter=append-only --workspace-concurrency=1 -r --if-present --no-bail test
```

Known Windows `@kortix/sandbox-agent-server` failures must be reported separately from new failures.
Any new failure introduced by this phase must be fixed before completion is claimed.

### 11.4 Deferred evidence

Real PostgreSQL multi-connection competition and real Browser end-to-end execution remain separate
follow-up stages. This phase must not describe mocks, focused tests, full repository tests, or image
builds as proof of either deferred result.

## 12. Acceptance Criteria

1. Default startup remains fail-closed and performs no Browser dispatch or resume work.
2. Full activation constructs one Control runtime and one Worker runtime with no test-only adapter.
3. The existing poller is the only scheduler and runs desktop and Browser resume runners in a
   deterministic sequence.
4. Control and Worker readiness follow the dependency and authenticated-connection rules above.
5. The Worker cannot execute an action before its current authority check succeeds, and it cannot
   execute an approved Browser action before atomic `consume-and-start` succeeds.
6. Disconnect, unknown-result, shutdown, and partial-failure paths do not replay an external effect.
7. Public approval API payloads and existing Kortix core behavior remain unchanged.
8. Focused tests, relevant typechecks, scoped Biome checks, image smoke checks, and the full repository
   regression are freshly executed and reported accurately.
9. Real PostgreSQL concurrency, real Browser E2E, and deployment remain explicitly unclaimed.

## 13. Implementation Order

1. Add failing configuration and production-runtime contract tests.
2. Separate local signing from remote Worker verification in the production security context.
3. Implement the Control production runtime and shared route/auth composition.
4. Add the authenticated internal authority-check route and PostgreSQL authority adapter.
5. Add managed WSS connection state and Control readiness.
6. Implement the private object-store evidence binding and optional persistent-profile binding.
7. Implement the Worker production runtime and production execution-binding factory.
8. Add Worker readiness, lifecycle, and shutdown behavior.
9. Convert entrypoints and container commands to thin bootstraps.
10. Run focused checks, container smoke checks, and the full repository regression.
