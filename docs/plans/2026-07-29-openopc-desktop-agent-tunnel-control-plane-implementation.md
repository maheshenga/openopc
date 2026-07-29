# OpenOPC Desktop Agent Tunnel Control Plane Implementation Plan

> For agentic workers: this project explicitly disables superpowers. Do not invoke superpowers skills or create commits. Execute the checked tasks with the repository's normal review and verification workflow.

**Goal:** Connect OpenOPC Desktop's local capabilities to the existing Agent Tunnel control plane while preserving Web independence and Kortix upgrade compatibility.

**Architecture:** Add an OpenOPC-owned adapter package that builds a self-contained Agent sidecar from the public `agent-tunnel` entry point. Electron main owns pairing, secure credentials, sidecar lifecycle, and native confirmation; the sidecar owns the existing TunnelAgent and wraps capability handlers with a local consent veto. Web adds a typed status/pairing panel and does not replace the existing Tunnel management UI.

**Tech Stack:** TypeScript/Bun, Node-compatible CJS sidecar, Electron 39, Electron `safeStorage`, Windows Credential Manager/keychain adapters, existing Hono/Drizzle Tunnel API, React, Bun tests, focused Electron/Web smoke tests, and electron-builder.

## Global Constraints

- Work in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`.
- Preserve all existing dirty user work; never run `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Do not modify `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`, `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`, or `tests/module-beta/evidence.json`.
- Do not commit or push during this implementation sequence.
- Use `pnpm.cmd` for pnpm commands and invoke `bun` directly; do not run the full monorepo test suite.
- `tunnel_connections`, `tunnel_permissions`, `tunnel_permission_requests`, `tunnel_audit_logs`, and `tunnel_device_auth_requests` remain the only cloud authority for Desktop execution.
- Every filesystem, shell, and desktop operation must continue through `executeTunnelRpc` and the existing `TunnelAgent`/`PermissionGuard` path.
- Do not modify the Agent Tunnel handshake, signature, nonce, kill-switch, DB schema, or existing Tunnel HTTP response contracts unless an additive test proves a public adapter contract is impossible without it.
- Keep `kortix://`, `KortixDesktop`, `com.kortix.desktop`, `__TAURI__`, `@kortix/*`, existing user-data migration, and existing `/v1` contracts unchanged; only visible product copy remains OpenOPC.
- The browser must remain fully usable without an Electron process, bridge, daemon, or Desktop secret.
- The packaged sidecar must not depend on a system Bun or Node installation; credentials must never appear in argv, environment variables, renderer state, logs, or URLs.
- Local consent is a fail-closed veto over a valid Tunnel permission, never a second permission authority and never a way to broaden scope.
- Keep the existing local-grant code as migration compatibility until the real Tunnel path is proven; do not claim it protects production execution.

---

### Task 1: Define the adapter and sidecar control protocol

**Files:**
- Create: `packages/openopc-desktop-agent/package.json`
- Create: `packages/openopc-desktop-agent/tsconfig.json`
- Create: `packages/openopc-desktop-agent/src/types.ts`
- Create: `packages/openopc-desktop-agent/src/framed-control.ts`
- Create: `packages/openopc-desktop-agent/src/framed-control.test.ts`

**Interfaces:**
- Consumes: public exports from the workspace package alias `agent-tunnel` only.
- Produces: stable types used by the Electron supervisor and sidecar tasks.

```ts
export type DesktopRuntimeState =
  | 'remote_only'
  | 'pairing_pending'
  | 'starting'
  | 'online'
  | 'ready'
  | 'stopped'
  | 'reauth_required'
  | 'error';

export interface DesktopTunnelProfile {
  apiOrigin: string;
  tunnelId: string;
  setupToken: string;
  userId: string;
  deviceId: string;
}

export interface DesktopRuntimeStatus {
  state: DesktopRuntimeState;
  tunnelId: string | null;
  userId: string | null;
  online: boolean;
  ready: boolean;
  reason: string | null;
  pendingPairing: { code: string; verificationUrl: string; expiresAt: string } | null;
}

export interface DesktopTunnelRuntime {
  start(profile: DesktopTunnelProfile): Promise<void>;
  stop(reason?: string): Promise<void>;
  status(): DesktopRuntimeStatus;
  onStatus(listener: (status: DesktopRuntimeStatus) => void): () => void;
}
```

- [ ] **Step 1: Write failing frame and state-contract tests**

Test that the frame decoder rejects invalid JSON, oversized frames, truncated
frames, unknown message kinds, and duplicate bootstrap messages. Test that
status objects never include `setupToken` or `deviceSecret`, and that a status
transition cannot move from `stopped` to `ready` without an authenticated
`online` event.

- [ ] **Step 2: Run RED**

Run: `cd packages/openopc-desktop-agent; bun test src/framed-control.test.ts`

Expected: FAIL because the package and frame functions do not exist.

- [ ] **Step 3: Implement the minimal protocol**

Implement length-bounded newline-delimited JSON frames with a maximum frame
size of 64 KiB, explicit message discriminants, and a state reducer. Expose
only status-safe projections. Keep bootstrap and control-channel secrets in
non-serializable internal fields.

- [ ] **Step 4: Run GREEN**

Run: `cd packages/openopc-desktop-agent; bun test src/framed-control.test.ts`

Expected: all protocol tests pass and no secret field appears in serialized
status or event frames.

- [ ] **Step 5: Review boundary**

Confirm the package has no import from `packages/agent-tunnel/src/*` and no
dependency on Electron, Web, or API internals. Do not stage or commit files.

### Task 2: Implement local consent storage and capability wrappers

**Files:**
- Create: `packages/openopc-desktop-agent/src/consent-store.ts`
- Create: `packages/openopc-desktop-agent/src/consent-store.test.ts`
- Create: `packages/openopc-desktop-agent/src/consent-guard.ts`
- Create: `packages/openopc-desktop-agent/src/consent-guard.test.ts`
- Create: `packages/openopc-desktop-agent/src/capabilities.ts`

**Interfaces:**
- Consumes: `Capability`, `RpcHandler`, `CapabilityRegistry`, existing
  `createFilesystemCapability`, `createShellCapability`,
  `createDesktopCapability`, and `LocalPermission` from public package exports.
- Produces: a registry whose handlers can deny locally but cannot broaden the
  server permission.

```ts
export interface NativeConfirmationRequest {
  tunnelId: string;
  permissionId: string;
  capability: string;
  scopeDigest: string;
  expiresAt: string | null;
}

export interface NativeConfirmationPort {
  confirm(request: NativeConfirmationRequest): Promise<boolean>;
}

export interface DesktopConsentStore {
  grant(input: NativeConfirmationRequest & { userId: string; deviceId: string }): void;
  revoke(permissionId: string, reason: string): void;
  clear(reason: string): void;
  authorize(input: {
    tunnelId: string;
    permission: LocalPermission | undefined;
    userId: string;
    deviceId: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<void>;
}
```

- [ ] **Step 1: Write failing consent tests**

Cover exact `tunnelId`, `permissionId`, capability, user, device, scope digest,
expiry, revocation, one-use nonce, replay, and maximum one-hour full-access
consent. Add a test where the underlying handler increments a counter and prove
the counter stays at zero when consent is absent or mismatched.

- [ ] **Step 2: Run RED**

Run: `cd packages/openopc-desktop-agent; bun test src/consent-store.test.ts src/consent-guard.test.ts`

Expected: FAIL because consent storage, one-use permits, and wrappers are not
implemented.

- [ ] **Step 3: Implement fail-closed consent**

Hash the canonical server permission (stable key ordering) into `scopeDigest`.
Persist only encrypted consent metadata and append-only redacted audit events.
Mint a short-lived one-use local permit after native confirmation; consume it
before invoking the wrapped handler. Reject missing, expired, revoked, wrong
user/device/tunnel, changed scope, invalid capability, and replayed permits.

Build a wrapper by copying a `Capability`'s method map and replacing each
handler with:

```ts
async function guarded(params: Record<string, unknown>) {
  const permission = params.__permission as LocalPermission | undefined;
  await consentStore.authorize({ tunnelId, permission, userId, deviceId, method, params });
  return underlying(params);
}
```

The wrapper must preserve the original `__permission` object and never remove
or rewrite server fences.

- [ ] **Step 4: Run GREEN**

Run: `cd packages/openopc-desktop-agent; bun test src/consent-store.test.ts src/consent-guard.test.ts`

Expected: all consent and wrapper tests pass, including the zero-handler-call
denials.

- [ ] **Step 5: Review capability mapping**

Verify the UI-only names map explicitly to existing capabilities:
`filesystem -> filesystem`, `local_execution -> shell`, and
`desktop_automation -> desktop`. `full_access` expands to the three existing
capabilities and is never sent as a new Tunnel capability.

### Task 3: Build the Agent sidecar runtime

**Files:**
- Create: `packages/openopc-desktop-agent/src/sidecar-entry.ts`
- Create: `packages/openopc-desktop-agent/src/sidecar-entry.test.ts`
- Create: `packages/openopc-desktop-agent/src/runtime.ts`
- Modify: `packages/openopc-desktop-agent/package.json`
- Modify: `packages/openopc-desktop-agent/tsconfig.json`

**Interfaces:**
- Consumes: Task 1 framed control protocol, Task 2 consent wrapper, and public
  Agent Tunnel factories.
- Produces: a single sidecar process that accepts one bootstrap, runs one
  `TunnelAgent`, and emits sanitized lifecycle/permission events.

- [ ] **Step 1: Write failing sidecar lifecycle tests**

Use a fake WebSocket and fake control port to assert bootstrap is accepted once,
bad bootstrap authentication stops the process, `start` is idempotent, `stop`
disconnects the Agent and clears consent, and a malformed control frame never
starts a handler. Assert that a `tunnel.permissions.sync`, revoke, disconnect,
and kill-switch event updates the runtime state and consent store.

- [ ] **Step 2: Run RED**

Run: `cd packages/openopc-desktop-agent; bun test src/sidecar-entry.test.ts`

Expected: FAIL because the sidecar entry and runtime are absent.

- [ ] **Step 3: Implement the sidecar**

Construct an isolated `TunnelConfig` from the bootstrap profile, register the
existing filesystem/shell/desktop capabilities through the consent wrappers,
and instantiate the existing `TunnelAgent` without changing its source. Keep
the token in memory only. Forward only sanitized status and native-confirmation
requests over the authenticated framed channel. Stop on parent-pipe EOF,
malformed frames, token rotation, or kill switch.

Add the build command:

```json
"build:sidecar": "bun build src/sidecar-entry.ts --target=node --format=cjs --outfile=dist/openopc-agent-sidecar.cjs"
```

The package must expose no CLI that accepts a token in argv.

- [ ] **Step 4: Run GREEN and inspect the artifact**

Run:

```powershell
cd packages/openopc-desktop-agent
bun run build:sidecar
bun test src/sidecar-entry.test.ts
Select-String -Path dist/openopc-agent-sidecar.cjs -Pattern 'TUNNEL_TOKEN|setupToken|process.argv'
```

Expected: the build and tests pass; the artifact has no token-in-argv path and
contains no unresolved `.ts` source import.

### Task 4: Add secure profile, pairing, and sidecar supervision to Electron

**Files:**
- Create: `apps/desktop-electron/src/tunnel-profile-store.js`
- Create: `apps/desktop-electron/src/tunnel-profile-store.test.js`
- Create: `apps/desktop-electron/src/tunnel-pairing.js`
- Create: `apps/desktop-electron/src/tunnel-pairing.test.js`
- Create: `apps/desktop-electron/src/tunnel-runtime-supervisor.js`
- Create: `apps/desktop-electron/src/tunnel-runtime-supervisor.test.js`
- Modify: `apps/desktop-electron/package.json`
- Modify: `apps/desktop-electron/electron-builder.yml`

**Interfaces:**
- Consumes: Task 1 `DesktopRuntimeStatus`, Task 3 sidecar artifact, existing
  `fetchDesktopSessionUserId`, `safeStorage`, and API device-auth routes.
- Produces: `DesktopTunnelController` with `beginPairing`, `cancelPairing`,
  `startIfProfileMatches`, `stop`, `forgetCredentials`, and `status`.

- [ ] **Step 1: Write failing profile and pairing tests**

Test safe-storage round trips with a fake adapter, malformed profile rejection,
origin/user/device mismatch, no plaintext fallback, device-auth create/poll
success, deny, expiry, cancellation, and invalid secret. Ensure the secret is
never returned in a status object or written to a captured log.

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop-electron; node --test src/tunnel-profile-store.test.js src/tunnel-pairing.test.js src/tunnel-runtime-supervisor.test.js`

Expected: FAIL because the controller modules and sidecar supervision do not
exist.

- [ ] **Step 3: Implement secure profile and pairing**

Use the current configured origin to call `POST /v1/tunnel/device-auth`, keep
the returned `deviceSecret` in memory, expose only `{ code, verificationUrl,
expiresAt }`, and poll `GET /v1/tunnel/device-auth/:code/status` with an
`Authorization: Bearer` header from the main process. On approval, validate
the tunnel id/token shape, bind the profile to the current authenticated user
and origin, and encrypt it with `safeStorage`.

Implement a single-child supervisor using Electron's embedded Node runtime:

```js
spawn(process.execPath, [sidecarPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
```

Send the decrypted profile and a per-launch channel key only as a framed stdin
bootstrap. Never put credentials in `env`, argv, or child logs. Make start,
stop, crash, parent EOF, and unpair idempotent; clear runtime status and local
consents on every stop.

- [ ] **Step 4: Run GREEN**

Run the same three Node test files. Expected: all pass, including repeated
start/stop and child-crash cleanup.

- [ ] **Step 5: Package the sidecar**

Add the sidecar build to the Desktop `setup`, `pack`, and `build` paths. Include
only the built artifact in electron-builder's packaged files and assert the
Windows package launches with no system Bun/Node dependency.

Add this Desktop package script so all subsequent gates have a stable entry:

```json
"test": "node --test src/*.test.js"
```

### Task 5: Wire main/preload IPC without expanding the legacy bridge

**Files:**
- Modify: `apps/desktop-electron/src/main.js`
- Modify: `apps/desktop-electron/src/preload.js`
- Modify: `apps/desktop-electron/src/main-startup.test.js`
- Create: `apps/desktop-electron/src/tunnel-ipc.test.js`

**Interfaces:**
- Consumes: Task 4 `DesktopTunnelController`.
- Produces: the fixed `window.kortixDesktop.tunnel` bridge and status event.

- [ ] **Step 1: Write failing IPC tests**

Assert exact origin gating, authenticated-user re-resolution, fixed operation
allow-list, rejection of unknown operations and renderer-supplied profiles,
status redaction, and listener cleanup. Assert the existing `__TAURI__` and
window-control bridge behavior remains unchanged.

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop-electron; node --test src/tunnel-ipc.test.js src/main-startup.test.js`

Expected: the new IPC contract tests fail because the bridge is absent.

- [ ] **Step 3: Implement named IPC**

Register one `openopc:tunnel-runtime` handler with the exact operations
`getStatus`, `beginPairing`, `cancelPairing`, `confirmPermission`,
`revokeConsent`, `stop`, and `unpair`. Resolve the user in main before each
operation. Add a preload listener that forwards sanitized status events and
returns an unsubscribe function. Do not expose `ipcRenderer`, child stdin,
tokens, or local filesystem primitives.

Add a `before-quit` cleanup that stops the supervisor before Electron exits.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd apps/desktop-electron
node --test src/tunnel-ipc.test.js src/main-startup.test.js src/app-policy.test.js src/local-grants.test.js
```

Expected: all focused Desktop tests pass and the legacy local-grant tests stay
green.

### Task 6: Add the Web Desktop runtime panel

**Files:**
- Create: `apps/web/src/features/desktop/desktop-tunnel-runtime-model.ts`
- Create: `apps/web/src/features/desktop/desktop-tunnel-runtime-model.test.ts`
- Create: `apps/web/src/features/desktop/desktop-tunnel-runtime-panel.tsx`
- Create: `apps/web/src/features/desktop/desktop-tunnel-runtime-panel.test.tsx`
- Modify: `apps/web/src/features/workspace/customize/sections/view/computers-view.tsx`

**Interfaces:**
- Consumes: `window.kortixDesktop.tunnel` named bridge when available and the
  authenticated `user.id` from the existing provider.
- Produces: remote-only, pairing, online, ready, stopped, and reauth-required
  UI states without changing Tunnel query keys or API hooks.

- [ ] **Step 1: Write failing Web model and render-contract tests**

Test a pure `DesktopTunnelRuntimeModel` that accepts sanitized status events and
uses a generation token to reject old bridge/user continuations and unmounted
listeners. Separately use the existing static-rendering convention to assert
that no bridge renders a remote-only state and each explicit runtime state
renders the correct label/action. Assert no token or device secret appears in
the model snapshot or rendered markup. Actual mounted event delivery is owned
by the packaged smoke in Task 8 because the current Bun lane has no React DOM
test renderer.

- [ ] **Step 2: Run RED**

Run: `cd apps/web; bun test src/features/desktop/desktop-tunnel-runtime-model.test.ts src/features/desktop/desktop-tunnel-runtime-panel.test.tsx`

Expected: FAIL because the panel and bridge adapter do not exist.

- [ ] **Step 3: Implement the panel and single mount point**

Implement the pure model first, then define a local typed bridge interface,
detect the bridge defensively, subscribe to status events in an effect with
cleanup, and guard every async continuation with the committed user id and
bridge identity. Mount the panel once in `ComputersView` beside
`TunnelOverview`; keep `LocalAccessPanel` as a clearly legacy/migration view
until the real runtime gates pass.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd apps/web
bun test src/features/desktop/desktop-tunnel-runtime-model.test.ts src/features/desktop/desktop-tunnel-runtime-panel.test.tsx src/features/desktop/local-access-panel.test.tsx
```

Expected: both the new panel and the existing seven local-access contract tests
pass, including `7 pass / 0 fail` for the existing file.

### Task 7: Exercise the real paired execution path

**Files:**
- Create: `packages/openopc-desktop-agent/src/integration/desktop-tunnel.integration.test.ts`
- Create: `apps/desktop-electron/src/tunnel-runtime.integration.test.js`
- Create: `apps/api/src/__tests__/integration-desktop-agent-tunnel.test.ts`
- Modify only if a test proves a defect: `apps/api/src/__tests__/integration-computer-connector.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 and the existing API device-auth, permission, relay, and
  Computer connector contracts.
- Produces: evidence that a real local handler is reachable only through the
  complete cloud and local gates.

- [ ] **Step 1: Write the integration contract**

Cover this exact sequence: create device-auth, approve with a bounded
capability, poll and start the sidecar, observe `auth_ok` and permission sync,
call a permitted read, deny a missing permission and capture its request id,
approve cloud permission but deny native consent, confirm locally and execute,
revoke cloud permission, verify immediate local denial, rotate token, and
verify re-pair-required state. Include account/team ownership and cross-user
negative cases.

- [ ] **Step 2: Run the first focused RED lanes**

Run:

```powershell
cd packages/openopc-desktop-agent
bun test src/integration/desktop-tunnel.integration.test.ts
cd ../../apps/api
pnpm.cmd exec dotenvx run -- bun test src/__tests__/integration-desktop-agent-tunnel.test.ts src/__tests__/integration-computer-connector.test.ts
cd ../desktop-electron
node --test src/tunnel-runtime.integration.test.js
```

Expected: the newly added tests fail on the first missing adapter/sidecar
behavior while the existing Computer connector integration test remains an
unchanged baseline. Save the first failure; do not weaken assertions or
repeatedly retry until green.

- [ ] **Step 3: Implement only defects proven by RED**

Keep the execution path unchanged unless the failure identifies a concrete
adapter, pairing, or packaging defect. Do not add a parallel mock executor to
make the sequence pass.

- [ ] **Step 4: Run the focused GREEN lane**

Run:

```powershell
cd packages/openopc-desktop-agent
bun test src/integration/desktop-tunnel.integration.test.ts
cd ../../apps/api
pnpm.cmd exec dotenvx run -- bun test src/__tests__/integration-desktop-agent-tunnel.test.ts src/__tests__/integration-computer-connector.test.ts
cd ../../apps/desktop-electron
node --test src/tunnel-runtime.integration.test.js
```

Expected: every step proves the server permission and local consent gates, and
the output records the first failure if the environment cannot provide a real
API/WS dependency.

### Task 8: Add packaged Desktop and public-beta evidence gates

**Files:**
- Create: `apps/web/scripts/e2e/public-beta-desktop-agent-smoke.ts`
- Create: `apps/web/scripts/e2e/public-beta-desktop-agent-smoke.test.ts`
- Create: `docs/runbooks/openopc-desktop-agent.md`
- Modify: `apps/desktop-electron/package.json`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: packaged Desktop artifact, deployed Web/API, and the existing G11
  Web/Desktop smoke conventions.
- Produces: redacted JSONL evidence for Web independence, pairing, execution,
  revoke, and no-secret leakage.

- [ ] **Step 1: Write failing smoke-runner contract tests**

Require explicit Web base URL, API base URL, Desktop artifact path, commit,
environment, and evidence directory. Reject local-only URLs for staging, capture
console errors and blank-canvas detection, assert that Web works without a
Desktop bridge, and assert that the packaged sidecar is present.

- [ ] **Step 2: Run RED**

Run: `cd apps/web; bun test scripts/e2e/public-beta-desktop-agent-smoke.test.ts`

Expected: FAIL because the runner and package script are absent.

- [ ] **Step 3: Implement the smoke runner and runbook**

Use the existing browser smoke harness, never print credentials, and emit one
redacted JSONL event per assertion. Document BaoTa deployment variables,
sidecar artifact placement, pairing approval, rollback/unpair, and the exact
G11/G12 evidence ownership. Add `test:e2e:public-beta-desktop-agent` to the Web
package scripts.

- [ ] **Step 4: Run GREEN and focused gates**

Run:

```powershell
cd apps/web
bun test scripts/e2e/public-beta-desktop-agent-smoke.test.ts
pnpm.cmd --filter @kortix/desktop-electron test
pnpm.cmd --filter @kortix/desktop-electron pack
git diff --check
```

Expected: the contract and focused Desktop tests pass; packaged output contains
the sidecar and no unresolved source-TS import. Staging evidence remains
required before public-beta readiness is declared.

## Verification and handoff

After Task 8, run only the relevant focused lanes and preserve their complete
outputs:

```powershell
cd packages/openopc-desktop-agent; bun test
cd ../../apps/desktop-electron; node --test src/*.test.js
cd ../api; pnpm.cmd exec dotenvx run -- bun test src/__tests__/integration-desktop-agent-tunnel.test.ts src/__tests__/integration-computer-connector.test.ts
cd ../web; bun test src/features/desktop/desktop-tunnel-runtime-model.test.ts src/features/desktop/desktop-tunnel-runtime-panel.test.tsx src/features/desktop/local-access-panel.test.tsx
cd ../..; pnpm.cmd --filter @kortix/desktop-electron pack
git diff --check
git status --porcelain --untracked-files=all
```

Do not claim public-beta readiness from local unit tests alone. The release
decision still requires the existing public-beta manifest, G11 packaged
Web/Desktop evidence, G12 upgrade rehearsal, staging deployment, and explicit
human approval. Do not mark the global goal complete until those authoritative
artifacts exist and are verified.
