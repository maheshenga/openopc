# Browser Worker Authenticated Source Implementation Plan

**Goal:** Connect the existing Automation Control `BrowserWorkerConnection` boundary to the
Browser Worker `AuthenticatedRequestSource` boundary through a bounded, mutually authenticated
WebSocket transport without claiming the browser execution runtime is production-ready.

**Architecture:** Automation Control opens a `wss://` connection with pinned CA, client
certificate, private key, and server name. A trusted Worker-side TLS proxy attests the Control
certificate during upgrade; every dispatch and receipt also carries a body-bound HMAC proof.
The Worker accepts only one queued or active request and aborts connection-owned work on close.

**Tech Stack:** TypeScript, Bun WebSocket client/server, Zod, existing Automation Protocol
contracts and service-proof canonicalization.

## Global Constraints

- Keep all new runtime flags disabled by default.
- Do not add a second scheduler, Redis job queue, database poller, or public route.
- Never give a Worker the Control-side TLS-proxy attestation secret.
- Limit every WebSocket message and backpressure buffer to 64 KiB by default.
- Do not enable complete execution readiness before durable step/final-state handling exists.
- Do not run the full repository test suite.
- Do not modify or commit the two protected OpenOPC Milestone A/frontier AI documents.

### Task 1: Share the dispatch wire contract

**Files:**

- Modify: `packages/intelligence-contracts/src/automation.ts`
- Modify: `packages/intelligence-contracts/src/automation.test.ts`
- Modify: `apps/automation-control/src/dispatch/browser-dispatcher.ts`

- [ ] Add a failing contract test for strict dispatch envelope, request, receipt, and accepted
      message schemas plus the internal WebSocket path.
- [ ] Run the focused contract test and confirm it fails because the exports do not exist.
- [ ] Add the path and schemas to the shared contract, then replace Control-private duplicates.
- [ ] Re-run the focused contract and Browser Dispatcher tests.

### Task 2: Implement the Worker authenticated source

**Files:**

- Create: `apps/automation-browser-worker/src/dispatch-source.ts`
- Create: `apps/automation-browser-worker/src/dispatch-source.test.ts`
- Modify: `apps/automation-browser-worker/src/config.ts`

- [ ] Add failing tests for disabled-by-default configuration, upgrade attestation, message proof,
      replay rejection, strict 64 KiB framing, single active request, signed receipt, and abort on
      connection close.
- [ ] Run the focused Worker test and confirm the missing source/config behavior fails.
- [ ] Implement the minimal source and configuration needed by the tests.
- [ ] Re-run the focused Worker tests and typecheck.

### Task 3: Implement the Control WebSocket connection adapter

**Files:**

- Create: `apps/automation-control/src/dispatch/browser-worker-connection.ts`
- Create: `apps/automation-control/src/dispatch/browser-worker-connection.test.ts`
- Modify: `apps/automation-control/src/config.ts`

- [ ] Add failing tests for `wss://`-only configuration, Bun mTLS options, one in-flight dispatch,
      exact schema parsing, signed receipt verification, timeout, close/unknown-result handling,
      and absence of spoofable Worker-proxy attestation headers.
- [ ] Run the focused Control test and confirm it fails for the missing adapter.
- [ ] Implement the minimal adapter and default-off configuration.
- [ ] Re-run Browser Dispatcher/connection/config tests and Control typecheck.

### Task 4: Verify and record the bounded slice

- [ ] Run package-scoped tests for intelligence contracts, Browser Worker, and Automation Control.
- [ ] Run the three package typechecks, scoped Biome, and `git diff --check`.
- [ ] Commit source/tests separately from the progress ledger update.
- [ ] Record that authenticated transport is implemented while full Worker main composition,
      durable step/approval handling, real proxy certificates, and end-to-end deployment remain
      open.
