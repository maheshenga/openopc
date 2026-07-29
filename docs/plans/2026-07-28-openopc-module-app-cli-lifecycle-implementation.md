# OpenOPC Module App, CLI, and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the public developer workflow from typed module creation through isolated UI, installation, consent, update, pause, reauthorization, rollback, revocation, reporting, and uninstall.

**Architecture:** Registry Module Schema v2 remains canonical. A public module SDK and `openopc` CLI delegate to existing `@kortix/*` implementations; Schema UI is host-rendered, while complex Module Apps run on immutable digest-specific origins and send strictly typed commands through a versioned `MessageChannel`. The existing installation service, Drizzle repository, SDK, and immutable event log expand rather than being replaced.

**Tech Stack:** TypeScript, Hono, Zod, JSON Schema 2020-12, React, Next.js, MessageChannel, Web Crypto/Ed25519, Bun test, Drizzle/PostgreSQL, existing `@kortix/registry` and `@kortix/sdk`.

## Global Constraints

- Preserve current uncommitted Task 8 results; begin overlapping runtime work only after a user-authorized checkpoint commit.
- Module capabilities are exactly `task`, `tool`, `workflow`, and `ui`.
- Schema UI is the default. Module Apps require an approved UI profile and a release-digest-specific origin.
- Never load third-party JavaScript into the OpenOPC Web or API process.
- The iframe receives no OpenOPC cookie, storage, DOM access, bearer token, raw secret, unrestricted capability token, or reusable storage URL.
- The default iframe sandbox omits `allow-same-origin`; every exception still gets a dedicated release origin without platform cookies.
- Parent commands execute through canonical SDK/API IAM; bridge messages do not become authority.
- Published releases are immutable. Corrections use a new version, channel movement, revocation, or exact rollback.
- Updates require consent when permission, origin, runtime, resource/cost ceiling, paid meter, or iframe capability expands.
- Lifecycle events are immutable, revision-fenced, idempotent, and tenant-scoped.
- Declarative/Agent modules use existing Kortix task, workflow, Connector, tool, model gateway, quota, moderation, confirmation, and audit paths.
- Keep `kortix` CLI/bin behavior and add an `openopc` facade; do not rename internal packages wholesale.
- No abandoned pre-release Module App v1 decoder is required.
- Do not edit protected files, use destructive Git commands, or run the full monorepo suite.
- Proposed commits require renewed user authorization.

---

## File Map

- `packages/registry/src/module-manifest.ts`: Schema v2 capability declarations and signed UI manifest.
- `packages/module-sdk/*`: public `@openopc/module-sdk` facade over canonical contracts.
- `packages/module-bridge/*`: exact bridge protocol, sequence, payload, and command validation.
- `apps/api/src/module-app/*`: one-time session authority and command execution.
- `apps/module-host/*`: cookie-free immutable Module App asset host.
- `apps/web/src/features/module-app/*`: iframe parent, Schema UI renderer, and error/status UI.
- `apps/cli/src/commands/modules.ts`: machine-usable module lifecycle command group.
- `apps/api/src/developer/installations*`: expanded lifecycle service/repository.
- `apps/api/src/projects/routes/developer-modules.ts`: project lifecycle routes.
- `packages/sdk/src/core/rest/projects-client/project-modules.ts`: canonical lifecycle client.
- `apps/web/src/features/project-modules/*`: project administrator lifecycle UI.
- `packages/db/migrations/20260728110000000_project_module_complete_lifecycle.sql`: status, canary, consent, revoke, uninstall, and emergency-stop persistence.

### Task 1: Extend Registry Module Schema v2 and publish the module SDK facade

**Files:**
- Modify: `packages/registry/src/module-manifest.ts`
- Modify: `packages/registry/src/module-manifest.test.ts`
- Modify: `packages/registry/src/capabilities.ts`
- Modify: `packages/registry/src/capabilities.test.ts`
- Modify: `packages/registry/src/index.ts`
- Create: `packages/module-sdk/package.json`
- Create: `packages/module-sdk/tsconfig.json`
- Create: `packages/module-sdk/src/index.ts`
- Create: `packages/module-sdk/src/index.test.ts`

**Interfaces:**

- Produces canonical `ModuleBridgeCommandName` from `@kortix/registry`; later bridge/API/Web code imports or reexports this type and does not redeclare it.

```ts
export type ModuleProductCapability = 'task'|'tool'|'workflow'|'ui';
export type ModuleBridgeCommandName =
  | 'task.create' | 'tool.invoke' | 'workflow.start' | 'navigation.open'
  | 'file.select' | 'download.request' | 'clipboard.write' | 'module.report';
export interface ModuleUiDeclarationV2 {
  schema: { treeDigest: `sha256:${string}` } | null;
  app: null | {
    entry: string; assetDigest: `sha256:${string}`; bridgeVersion: 1;
    profile: 'isolated-default'|'isolated-media';
    commands: ModuleBridgeCommandName[];
  };
}
```

- [ ] **Step 1: Write failing schema/facade tests**

Assert sorted unique capabilities, `ui` requiring Schema UI or Module App, digest-only assets, path traversal rejection, unknown bridge version/profile/command rejection, runtime descriptor remaining separate and digested, and facade exports matching canonical objects by identity rather than copied definitions.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd packages/registry; bun test src/module-manifest.test.ts src/capabilities.test.ts
cd ../module-sdk; bun test
```

Expected: registry tests fail on new shapes and the module SDK package is absent.

- [ ] **Step 3: Implement strict v2 fields and facade exports**

Add exact-key parsing and normalized sorted arrays. `@openopc/module-sdk` reexports selected types/parsers from `@kortix/registry`, `@openopc/module-runtime-contracts`, and `@kortix/sdk`; it contains no HTTP client or validator copy. Package scripts are `"test": "bun test"`, `"typecheck": "tsc --noEmit"`, and `"build": "tsc -p tsconfig.json"`.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd packages/registry; bun test src/module-manifest.test.ts src/capabilities.test.ts
cd ../module-sdk; bun test; pnpm.cmd typecheck
```

Expected: all tests pass and the facade typechecks.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/registry packages/module-sdk pnpm-lock.yaml
git commit -m "feat(modules): expose v2 capabilities and public sdk facade"
```

### Task 2: Define the strict MessageChannel bridge

**Files:**
- Create: `packages/module-bridge/package.json`
- Create: `packages/module-bridge/tsconfig.json`
- Create: `packages/module-bridge/src/protocol.ts`
- Create: `packages/module-bridge/src/host.ts`
- Create: `packages/module-bridge/src/client.ts`
- Create: `packages/module-bridge/src/protocol.test.ts`
- Create: `packages/module-bridge/src/host.test.ts`

**Interfaces:**

```ts
import type { ModuleBridgeCommandName } from '@kortix/registry';
export type { ModuleBridgeCommandName } from '@kortix/registry';

export interface ModuleBridgeReadyV1 {
  type: 'openopc.module.ready'; protocolVersion: 1; releaseDigest: `sha256:${string}`; nonce: string;
}
export interface ModuleBridgeRequestV1 {
  type: 'openopc.module.request'; protocolVersion: 1; sessionId: string;
  sequence: number; requestId: string; command: ModuleBridgeCommandName; payload: unknown;
}
export interface ModuleBridgeResponseV1 {
  type: 'openopc.module.response'; protocolVersion: 1; sessionId: string;
  sequence: number; requestId: string; outcome: 'approved'|'denied'|'failed'; result?: unknown;
}
```

- [ ] **Step 1: Write failing protocol and fuzz tests**

Reject unknown/excess keys, payloads over 64 KiB, non-integer or repeated/out-of-order sequence, reused request IDs, wrong session, wrong release digest, wrong source window, wildcard target origin, commands outside the installation snapshot, more than 32 in-flight commands, and messages after expiry/close. Include 10,000 generated malformed JSON-compatible values.

- [ ] **Step 2: Run RED**

Run: `cd packages/module-bridge; bun test`

Expected: package-not-found failure.

- [ ] **Step 3: Implement validators and host/client state machines**

Use package name `@openopc/module-bridge` with `test` and `typecheck` scripts. The iframe emits `ready` to its exact parent origin. The parent verifies `event.source`, `event.origin`, release digest, and nonce, transfers one `MessagePort`, and keeps the API session token only in parent memory. All later traffic uses the port. Each request is parsed before the host calls its injected `execute(command)` port; close the channel on any protocol violation.

- [ ] **Step 4: Run GREEN**

Run: `cd packages/module-bridge; bun test; pnpm.cmd typecheck`

Expected: PASS for protocol, state, replay, and fuzz cases.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/module-bridge pnpm-lock.yaml
git commit -m "feat(module-ui): add bounded message channel bridge"
```

### Task 3: Issue audience-bound Module App sessions and execute commands server-side

**Files:**
- Create: `apps/api/src/module-app/sessions.ts`
- Create: `apps/api/src/module-app/sessions.test.ts`
- Create: `apps/api/src/module-app/sessions.drizzle.ts`
- Create: `apps/api/src/module-app/commands.ts`
- Create: `apps/api/src/module-app/commands.test.ts`
- Create: `apps/api/src/module-app/app.ts`
- Modify: `apps/api/src/index.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-app.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-app.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`

**Interfaces:**

```ts
export interface ModuleAppSessionV1 {
  sessionId: string; origin: string; iframeUrl: string; releaseDigest: `sha256:${string}`;
  nonce: string; expiresAt: string; allowedCommands: ModuleBridgeCommandName[];
}
export interface ExecuteModuleAppCommandInput {
  sessionId: string; sequence: number; requestId: string;
  command: ModuleBridgeCommandName; payload: unknown;
}
```

- [ ] **Step 1: Write failing authority tests**

Assert session creation binds account/project/installation/release/origin/nonce/expiry/allowed commands; only active installation and retained immutable release can create a session; command execution rechecks IAM, consent revision, release status, and session sequence; token replay, cross-origin, cross-project, paused/revoked/uninstalled, expanded command, and expired sessions fail opaque and audit the decision.

- [ ] **Step 2: Run RED**

Run: `cd apps/api; bun test src/module-app/sessions.test.ts src/module-app/commands.test.ts`

Expected: FAIL because the module-app authority is absent.

- [ ] **Step 3: Implement short-lived server authority**

Routes:

```text
POST /v1/projects/:projectId/modules/:moduleId/app-session
POST /v1/projects/:projectId/modules/:moduleId/app-commands
```

Session lifetime is two minutes; command lifetime cannot outlive it. Use a server-signed audience `openopc-module-app-host`, one-time session JTI, installation revision, consent digest, exact origin `https://<release-digest>.modules.<base>`, and maximum 256 commands. Map typed commands to existing task/tool/workflow/navigation/file/download/report services; no generic URL fetch or arbitrary SDK method name is accepted.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd apps/api; bun test src/module-app/sessions.test.ts src/module-app/commands.test.ts
cd ../../packages/sdk; bun test src/core/rest/projects-client/module-app.test.ts
```

Expected: PASS with opaque cross-tenant behavior and replay denial.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/module-app apps/api/src/index.ts packages/sdk/src/core/rest/projects-client
git commit -m "feat(module-ui): add server-owned app sessions"
```

### Task 4: Build the cookie-free immutable Module App host

**Files:**
- Create: `apps/module-host/package.json`
- Create: `apps/module-host/tsconfig.json`
- Create: `apps/module-host/Dockerfile`
- Create: `apps/module-host/src/config.ts`
- Create: `apps/module-host/src/host-routing.ts`
- Create: `apps/module-host/src/host-routing.test.ts`
- Create: `apps/module-host/src/storage.ts`
- Create: `apps/module-host/src/app.ts`
- Create: `apps/module-host/src/app.test.ts`
- Create: `apps/module-host/src/main.ts`

**Interfaces:**
- `parseModuleOriginHost(host, suffix): { releaseDigest: sha256 }` accepts only the canonical DNS encoding of one SHA-256 digest.
- `ModuleAssetStore.read(releaseDigest, normalizedPath): Promise<{ bytes; contentType; contentDigest }>`.

- [ ] **Step 1: Write failing host, header, and asset tests**

Test unknown host, parent-domain host, path traversal/double encoding, mutable aliases, digest mismatch, HTML/JS MIME confusion, range abuse, oversized assets, storage error, and cross-release lookup. Assert no `Set-Cookie`, no credentialed CORS, no Service-Worker-Allowed, and headers `Content-Security-Policy`, `Cross-Origin-Resource-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and no-store bootstrap HTML.

- [ ] **Step 2: Run RED**

Run: `pnpm.cmd --filter @openopc/module-host test`

Expected: package does not exist.

- [ ] **Step 3: Implement immutable host routing and strict CSP**

Use package name `@openopc/module-host` with `"test": "bun test"`, `"typecheck": "tsc --noEmit"`, and `"build": "tsc -p tsconfig.json"`. Serve only `/`, `/assets/<sha256>/<safe-name>`, and `/healthz`. Resolve each host to one retained signed release. Bootstrap HTML imports only the release's digested entry asset, disables forms/popups/frames/object/base, permits network only to declared proxy origins, and refuses to serve if stored bytes do not recompute to the manifest digest.

- [ ] **Step 4: Run GREEN**

Run: `pnpm.cmd --filter @openopc/module-host test; pnpm.cmd --filter @openopc/module-host typecheck; pnpm.cmd --filter @openopc/module-host build`

Expected: PASS and standalone image build input exists.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/module-host pnpm-lock.yaml
git commit -m "feat(module-ui): add immutable cross origin app host"
```

### Task 5: Render Schema UI and host the isolated iframe in Web

**Files:**
- Create: `apps/web/src/features/module-app/schema-ui.ts`
- Create: `apps/web/src/features/module-app/schema-ui.test.ts`
- Create: `apps/web/src/features/module-app/schema-ui-renderer.tsx`
- Create: `apps/web/src/features/module-app/schema-ui-renderer.test.tsx`
- Create: `apps/web/src/features/module-app/module-app-frame.tsx`
- Create: `apps/web/src/features/module-app/module-app-frame.test.tsx`
- Create: `apps/web/src/features/module-app/module-surface.tsx`

**Interfaces:**

```ts
export type SchemaUiNode =
  | { type:'text'; id:string; text:string }
  | { type:'field'; id:string; field:'text'|'number'|'select'|'date'; binding:string; options?:string[] }
  | { type:'action'; id:string; label:string; command:ModuleBridgeCommandName; input:unknown }
  | { type:'group'; id:string; children:SchemaUiNode[] };
```

- [ ] **Step 1: Write failing renderer and iframe tests**

Reject duplicate IDs, depth over 12, more than 500 nodes, text over 16 KiB, unknown binding/command, unsafe URL/HTML, and unbounded options. Assert iframe `src` matches returned origin, sandbox default contains only approved tokens and omits `allow-same-origin`, target origin is never `*`, bridge closes on route/unmount, loading/error/permission states are visible, and no module content reaches `dangerouslySetInnerHTML`.

- [ ] **Step 2: Run RED**

Run: `cd apps/web; bun test src/features/module-app`

Expected: FAIL because the feature is absent.

- [ ] **Step 3: Implement host-owned rendering and bridge connection**

Parse the signed tree before rendering host primitives. Module App frame obtains `ModuleAppSessionV1` through the SDK, validates the iframe URL against the exact returned origin, listens for one ready event, then delegates to `@openopc/module-bridge`. Every command shows confirmation when required by canonical API policy.

- [ ] **Step 4: Run GREEN**

Run: `cd apps/web; bun test src/features/module-app; pnpm.cmd typecheck`

Expected: PASS for Schema UI and iframe boundaries.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/web/src/features/module-app
git commit -m "feat(module-ui): render schema and isolated app surfaces"
```

### Task 6: Add the `openopc module` CLI facade and deterministic packaging

**Files:**
- Create: `apps/cli/bin/openopc`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/index.ts`
- Create: `apps/cli/src/commands/modules.ts`
- Create: `apps/cli/src/__tests__/modules.test.ts`
- Create: `apps/cli/src/__tests__/openopc-facade.test.ts`
- Modify: `apps/cli/bundle/_build.sh`
- Modify: `apps/cli/bundle/bundle-all.sh`

**Interfaces:**
- Commands: `openopc module init|validate|pack|upload|verify|submit|promote|install-test`.
- Common flags: `--json`, `--account`, `--project`, `--idempotency-key`.
- Stable exits: `0=success`, `2=remote/domain rejection`, `64=usage`, `65=invalid local data`, `69=dependency unavailable`, `70=unexpected internal failure`.

- [ ] **Step 1: Write failing facade/command tests**

Assert `kortix` still dispatches existing commands; `openopc` uses OpenOPC help/banner; JSON mode emits exactly one object and no ANSI; `init` creates deterministic v2 files; `validate` reuses registry parser; `pack` sorts paths, normalizes timestamps/modes, rejects symlink/traversal/device/oversize, and produces the same digest twice; remote commands call SDK methods and map typed errors to stable exits.

- [ ] **Step 2: Run RED**

Run: `cd apps/cli; bun test src/__tests__/modules.test.ts src/__tests__/openopc-facade.test.ts`

Expected: FAIL because the facade and command group are absent.

- [ ] **Step 3: Implement the command router and package pipeline**

Add `openopc` as a second bin without removing `kortix`. Add `@kortix/sdk`, `@kortix/registry`, and `@openopc/module-sdk` workspace dependencies. `pack` emits a canonical tar archive plus `{ artifactDigest, manifestDigest, runtimeDescriptorDigest }`; never embed credentials or host-specific absolute paths.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd apps/cli; bun test src/__tests__/modules.test.ts src/__tests__/openopc-facade.test.ts src/__tests__/cli-blackbox.test.ts
pnpm.cmd typecheck
pnpm.cmd bundle
```

Expected: PASS; both bins launch and existing CLI black-box tests remain green.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/cli pnpm-lock.yaml
git commit -m "feat(cli): add OpenOPC module workflow facade"
```

### Task 7: Expand durable installation lifecycle schema and service

**Files:**
- Create: `packages/db/migrations/20260728110000000_project_module_complete_lifecycle.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/developer-module-distribution-schema.test.ts`
- Create: `packages/db/scripts/project-module-lifecycle-migration.integration.test.ts`
- Modify: `apps/api/src/developer/installations.ts`
- Modify: `apps/api/src/developer/installations.test.ts`
- Modify: `apps/api/src/developer/installations.drizzle.ts`
- Modify: `apps/api/src/developer/installations.drizzle.test.ts`

**Interfaces:**

```ts
export type ProjectModuleInstallationStatus =
  | 'active'|'paused'|'reauthorization_required'|'blocked'|'revoked'|'uninstalled';
export type ProjectModuleInstallationAction =
  | 'install'|'update'|'canary_update'|'pause'|'resume'|'reauthorize'
  | 'rollback'|'revoke'|'uninstall'|'emergency_stop';
```

Extend installation with `pending_release_id`, `canary_percent`, `consent_revision`, `consent_digest`, `execution_stopped_at`, and `uninstalled_at`. Extend events so `to_release_id` may be null only for pause/resume/revoke/uninstall/emergency-stop, and add `from_status`, `to_status`, `reason`, `consent_revision`, and `snapshot_digest`.

- [ ] **Step 1: Write failing state-machine and PostgreSQL tests**

Cover every legal/illegal transition, revision conflict, idempotent replay and mismatched replay, cross-account opacity, pause/resume without release movement, canary percentage 1-100, exact historical rollback, revoke and emergency stop, uninstall retaining history, immutable events/consents, and concurrent transition serialization.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/developer/installations.test.ts src/developer/installations.drizzle.test.ts
cd ../../packages/db; bun test scripts/project-module-lifecycle-migration.integration.test.ts
```

Expected: FAIL on unsupported statuses/actions and missing migration.

- [ ] **Step 3: Implement one transition command and append-only event path**

```ts
export interface ProjectModuleLifecycleCommand {
  accountId:string; projectId:string; moduleId:string; actorUserId:string;
  action:ProjectModuleInstallationAction; expectedInstallRevision:number;
  releaseId?:string; canaryPercent?:number; consentRevision?:number;
  reason?:string; idempotencyKey:string;
}
```

Use a single repository transaction that locks the installation, validates action-specific input, inserts the immutable event, updates the projection, and returns both. Current status must combine durable operator state with release distribution/revocation; it must not mutate event history during reads.

- [ ] **Step 4: Run GREEN**

Run the RED commands, then `pnpm.cmd migrate:lint` and `pnpm.cmd --filter @kortix/db typecheck`.

Expected: all pass; second migration apply is idempotent in the integration test.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/db apps/api/src/developer/installations*
git commit -m "feat(modules): add complete durable install lifecycle"
```

### Task 8: Enforce consent-diff reauthorization, revocation, and exact rollback

**Files:**
- Create: `apps/api/src/developer/installation-consent.ts`
- Create: `apps/api/src/developer/installation-consent.test.ts`
- Modify: `apps/api/src/projects/routes/developer-modules.ts`
- Modify: `apps/api/src/projects/developer-modules-routes.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/project-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/project-modules.test.ts`

**Interfaces:**

```ts
export interface ModuleConsentSnapshotV2 {
  releaseDigest:`sha256:${string}`; permissions:string[]; origins:string[]; runtimeKind:'declarative'|'wasi-component'|'oci-image';
  resources:{ cpuMillis:number; memoryMiB:number; wallTimeMs:number }; cost:{ ceilingMicrounits:number; meters:string[] };
  dataClasses:string[]; modelProfiles:string[]; ui:{ profile:string|null; commands:string[] };
}
export function compareConsent(previous: ModuleConsentSnapshotV2, next: ModuleConsentSnapshotV2): {
  requiresReauthorization:boolean; expansions:string[];
};
```

- [ ] **Step 1: Write failing consent and route tests**

Assert additions/broadened origins/runtime-kind changes/higher ceilings/new paid meters/iframe expansion require reauthorization; reductions do not. Assert update stores pending release and blocks execution until exact consent revision is accepted; revoke stops new claims and expires live grants; rollback resolves only a retained event target; uninstall removes active authority but retains events, usage, ledger links, and audit.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/developer/installation-consent.test.ts src/projects/developer-modules-routes.test.ts
cd ../../packages/sdk; bun test src/core/rest/projects-client/project-modules.test.ts
```

Expected: FAIL because consent diff and new routes are absent.

- [ ] **Step 3: Implement explicit lifecycle routes**

Add:

```text
POST /v1/projects/:projectId/modules/:moduleId/pause
POST /v1/projects/:projectId/modules/:moduleId/resume
POST /v1/projects/:projectId/modules/:moduleId/reauthorize
POST /v1/projects/:projectId/modules/:moduleId/canary
POST /v1/projects/:projectId/modules/:moduleId/revoke
DELETE /v1/projects/:projectId/modules/:moduleId
POST /v1/projects/:projectId/modules/:moduleId/emergency-stop
```

Every mutation requires expected revision and `Idempotency-Key`; reauthorize also requires exact pending release and consent digest. Publisher revocation enters through the distribution service and fans out to installation blocking without deleting history.

- [ ] **Step 4: Run GREEN**

Run the RED commands again.

Expected: PASS for service, route, SDK, re-consent, revoke, and uninstall contracts.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/developer/installation-consent* apps/api/src/projects/routes/developer-modules* packages/sdk/src/core/rest/projects-client/project-modules*
git commit -m "feat(modules): enforce consent and lifecycle authority"
```

### Task 9: Complete Project Modules and Developer Center workflows

**Files:**
- Modify: `apps/web/src/features/project-modules/project-modules-page.tsx`
- Modify: `apps/web/src/features/project-modules/project-modules-page.test.tsx`
- Modify: `apps/web/src/features/project-modules/client.ts`
- Modify: `apps/web/src/features/project-modules/query.ts`
- Create: `apps/web/src/features/project-modules/module-consent-dialog.tsx`
- Create: `apps/web/src/features/project-modules/module-history-panel.tsx`
- Modify: `apps/web/src/features/developer-center/publisher/release-detail-page.tsx`
- Modify: `apps/cli/src/commands/modules.ts`
- Modify: `apps/cli/src/__tests__/modules.test.ts`

**Interfaces:**
- UI actions map one-to-one to SDK methods; no direct `fetch` duplicates.
- CLI adds `pause|resume|reauthorize|rollback|revoke|report|uninstall` under `openopc module`.

- [ ] **Step 1: Write failing visible-workflow tests**

Assert status/revision/history, permission/origin/resource/cost/network/data/model/UI snapshots, expansion highlighting, canary state, exact rollback target, pause/resume, reauthorize, revoke response, report, emergency stop, and two-step uninstall. Assert finance/Publisher controls remain role-specific and unrelated tenant data never renders.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/web; bun test src/features/project-modules/project-modules-page.test.tsx
cd ../cli; bun test src/__tests__/modules.test.ts
```

Expected: FAIL because new actions and views are absent.

- [ ] **Step 3: Implement complete UI and CLI transitions**

Use the existing query layer and SDK. Every mutation displays its expected revision and idempotency result; conflict refetches and requires another explicit action. Uninstall confirmation states that history and sandbox statements are retained. Revoked modules show no execute control.

- [ ] **Step 4: Run GREEN**

Run the RED commands and `pnpm.cmd --filter Kortix-Computer-Frontend typecheck`.

Expected: PASS with all named lifecycle states visible.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/web/src/features/project-modules apps/web/src/features/developer-center/publisher/release-detail-page.tsx apps/cli/src/commands/modules.ts apps/cli/src/__tests__/modules.test.ts
git commit -m "feat(modules): complete lifecycle user workflows"
```

### Task 10: Close G7, G8, G10, and B4 with real workflow and attack lanes

**Files:**
- Create: `tests/public-beta/module-workflow/run.ts`
- Create: `tests/public-beta/module-workflow/run.test.ts`
- Create: `tests/public-beta/module-ui-attacks/run.ts`
- Create: `tests/public-beta/module-ui-attacks/run.test.ts`
- Modify: evidence workflow files only in the evidence plan.

**Interfaces:**
- Workflow runner covers apply/invite through uninstall.
- Attack runner covers origin/CSP/message fuzzing, replay, permission escalation, secret/signed-URL disclosure, service worker, popup/navigation/download, and cross-tenant authority.

- [ ] **Step 1: Write failing runner contract tests**

Require explicit staging URLs for Web, Admin, API, and wildcard module host; exact commit; real Publisher/end-user/project-admin accounts; retained browser trace; raw API log; and artifact digests. Reject localhost, mocked adapters, self-created assertion-only evidence, absent attack result, and unknown Gate IDs.

- [ ] **Step 2: Run RED**

Run: `bun test tests/public-beta/module-workflow/run.test.ts tests/public-beta/module-ui-attacks/run.test.ts`

Expected: FAIL because the runners are absent.

- [ ] **Step 3: Implement deterministic staging runners**

The workflow runner performs every B4 action and verifies immutable state through a second API read. The attack runner hosts malicious release fixtures on real digest origins and verifies denials from browser, API, audit, and CSP reports. Preserve every failure artifact; do not auto-retry a failed scenario.

- [ ] **Step 4: Run local contract tests**

Run:

```powershell
bun test tests/public-beta/module-workflow/run.test.ts tests/public-beta/module-ui-attacks/run.test.ts
pnpm.cmd --filter @openopc/module-host test
pnpm.cmd --filter @openopc/module-bridge test
pnpm.cmd --filter @kortix/cli test
git diff --check
```

Expected: local contracts pass. Real canonical G7/G8/G10/B4 staging evidence remains mandatory.

- [ ] **Step 5: Commit boundary**

```powershell
git add tests/public-beta/module-workflow tests/public-beta/module-ui-attacks
git commit -m "test(beta): add complete module and bridge acceptance"
```

## Module Completion Gate

- SDK and CLI cover create, validate, pack, upload, verification, submit, promote, install-test, and lifecycle operations with stable JSON/exits.
- Schema UI and isolated Module Apps work without exposing OpenOPC authority.
- Every install/update/canary/consent/pause/resume/rollback/revoke/emergency-stop/uninstall transition is durable and visible.
- Published versions are immutable and exact rollback resolves retained evidence.
- G7, G8, G10, and B4 pass in real staging for the candidate commit.
