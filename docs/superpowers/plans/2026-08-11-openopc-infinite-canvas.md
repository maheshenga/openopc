# OpenOPC Infinite Canvas Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Convert tigerowo/infinite-canvas into a provider-neutral OpenOPC sandboxed web module, with platform-owned module settings and no module-held provider credentials.

**Architecture:** A static React module owns canvas interaction and local IndexedDB recovery. All privileged operations cross the existing browser bootstrap and operation-scoped capability-token bridge into typed platform services. Platform APIs own settings, synchronized documents, provider selection, quotas, and media execution.

**Tech Stack:** TypeScript, React 19, Vite, Bun tests, Zod, Hono, Drizzle/PostgreSQL, IndexedDB, OpenOPC Developer SDK, Playwright/browser QA.

> **Execution record (2026-08-13, integration):** all 38 steps verified complete.
> Deviations from plan naming: Task 5 admin route lives in
> `apps/api/src/module-services/settings.ts` (`ModuleSettingsService` +
> `createModuleSettingsProjectRoutes`, registered in
> `developer-modules.registration.ts`) with the UI in
> `apps/web/src/features/project-modules/module-settings-sheet.tsx` (plan said
> `settings-admin.ts` / `module-settings-panel.tsx`); Task 6 directory is
> `apps/openopc-infinite-canvas` built with `scripts/build.ts` (Bun.build, no
> vite.config.ts); Task 7 manifest is embedded in `registry-item.json`
> (`module` field, no separate openopc.manifest.json); Task 8 browser QA ran
> through the Playwright fixture + manual Chromium instead of a committed
> `tests/browser/infinite-canvas.spec.ts` (boundaries recorded in
> VERIFICATION.md). DB migration re-stamped to
> `20260813120000000_openopc_module_data_settings.sql` to avoid the timestamp
> collision with the keyset-pagination migration merged in #14.
>
> **Execution record (2026-08-14, shipped):** merged to `main` as `e111bfbdc6`
> via PR #15 (CI fully green). The three shared SDK/host files were merged with
> the #14 hardening behavior as the base (token cache, coalescing, invalidate,
> structured rate-limit errors preserved; covered by the merged tests), and
> response-size bounds are now per-service (images/chat 1 MB, module documents
> 3 MB). The first-party embedded-browser smoke passed in real Chromium 149 on
> the merged main (bootstrap/token bridge, stream abort, CORS preflight, cookie
> omission, attacker rejection, CSP). Deploy Dev for the merged main succeeded;
> the `dev-latest` prerelease tag points at `b4449232c2`. External
> boundaries unchanged: real PostgreSQL migration application and real
> provider/worker capability issuance remain recorded in VERIFICATION.md.

## Global Constraints

- Work only in `E:\code\agentk\suna-openopc-infinite-canvas-dev` on `feature/openopc-infinite-canvas-dev`.
- Baseline is `origin/main` at `3391f32a298d93c15e7336550aa5ae5a2c7bdd7a`.
- Do not read or modify `E:\code\agentk\suna-openopc-module-dev`.
- Do not commit, push, deploy, publish, or read/output credentials without explicit authorization.
- The module may not choose providers, provider base URLs, API keys, auth headers, or direct network fallbacks.
- Preserve upstream license, attribution, notices, and modification provenance.
- The final module must render without horizontal overflow at desktop and 390px mobile widths.
- Every async module service path accepts `AbortSignal`; every listener, subscription, timer, and object URL has deterministic cleanup.

---

### Task 1: Public module service contracts

**Files:**
- Modify: `packages/api-contract/src/module-services.ts`
- Create: `packages/api-contract/src/openopc-module-data.ts`
- Create: `packages/api-contract/src/openopc-module-settings.ts`
- Modify: `packages/api-contract/src/index.ts`
- Modify: `packages/api-contract/src/module-services.test.ts`
- Create: `packages/api-contract/src/openopc-module-data.test.ts`
- Create: `packages/api-contract/src/openopc-module-settings.test.ts`
- Modify: `packages/openopc-developer-sdk/src/contracts.ts`
- Create: `packages/openopc-developer-sdk/src/data-contracts.ts`
- Create: `packages/openopc-developer-sdk/src/settings-contracts.ts`
- Modify: `packages/openopc-developer-sdk/src/index.ts`
- Modify: `packages/openopc-developer-sdk/src/contracts.test.ts`

**Interfaces:**
- Add services `data` and `settings`.
- Add data operations `documents.list`, `documents.read`, `documents.write`, `documents.delete`, `assets.create`, `assets.read`, and `assets.delete`.
- Add settings operation `settings.read`; no module settings write operation exists.
- Produce strict schemas for versioned JSON documents, bounded asset metadata, and effective non-secret settings.

- [x] Write failing contract tests proving duplicate/unknown operations, credential-like setting keys, oversized JSON documents, invalid ETags, and cross-service operations are rejected.
- [x] Run `pnpm --filter @kortix/api-contract test -- module-services openopc-module-data openopc-module-settings` and confirm the new expectations fail.
- [x] Implement the shared schemas and mirror the public types from `@kortix/api-contract` into `@openopc/developer-sdk` without adding provider fields.
- [x] Run the focused contract and SDK tests and confirm they pass.
- [x] Run both package typechecks and record the output; do not commit.

### Task 2: Registry manifest settings and capability validation

**Files:**
- Modify: `packages/registry/src/schema.ts`
- Modify: `packages/registry/src/module-manifest.ts`
- Modify: `packages/registry/src/module-manifest.test.ts`
- Modify: `apps/api/src/developer/verification.ts`
- Modify: `apps/api/src/developer/verification.test.ts`

**Interfaces:**
- Add `openopc.settings` as a registry-validated, non-secret field declaration.
- Field kinds are `boolean`, `number`, `select`, `model-select`, `text`, and `textarea`.
- V3 manifests may declare `data` and `settings` service operations, but settings exposes only `settings.read`.

- [x] Add failing manifest tests for the Infinite Canvas declarations and for rejected `secret`, `apiKey`, provider URL, duplicate setting key, unknown operation, and undeclared operation cases.
- [x] Run `pnpm --filter @kortix/registry test -- module-manifest` and the developer verification test to observe failures.
- [x] Implement strict manifest types, parser validation, and verification policy.
- [x] Re-run the focused tests and registry typecheck; do not commit.

### Task 3: Persistent module documents and effective settings

**Files:**
- Create: `packages/db/migrations/20260811120000000_openopc_module_data_settings.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/src/openopc-module-data-settings-schema.test.ts`
- Create: `apps/api/src/module-services/data.ts`
- Create: `apps/api/src/module-services/data.drizzle.ts`
- Create: `apps/api/src/module-services/data.test.ts`
- Create: `apps/api/src/module-services/settings.ts`
- Create: `apps/api/src/module-services/settings.drizzle.ts`
- Create: `apps/api/src/module-services/settings.test.ts`
- Modify: `apps/api/src/module-services/app.ts`
- Modify: `apps/api/src/module-services/index.ts`

**Interfaces:**
- `ModuleDocumentRepository.list/read/write/delete` is scoped by account, project, installation, release, and document key.
- Writes require `expected_revision`; conflicts return `MODULE_SERVICE_CONFLICT` and never overwrite.
- `ModuleSettingsRepository.readEffective` merges platform defaults, installation values, and user preferences but returns only schema-declared non-secret fields.
- Module endpoints authenticate exclusively through `requireModuleServiceOperation`.

- [x] Write failing DB schema tests for tenant keys, foreign keys, JSON size checks, revisions, and absence of credential columns.
- [x] Write failing route tests for scope isolation, stale revisions, undeclared keys, unauthorized operations, and successful read/write/delete flows.
- [x] Implement the migration, Drizzle schema, repositories, and Hono routes.
- [x] Run focused DB/API tests, migration lint, and API typecheck; do not commit.

### Task 4: SDK clients and browser bridge support

**Files:**
- Modify: `packages/openopc-developer-sdk/src/client.ts`
- Modify: `packages/openopc-developer-sdk/src/client.test.ts`
- Modify: `packages/openopc-developer-sdk/src/browser-capability-token.ts`
- Modify: `apps/web/src/features/project-modules/client.ts`
- Modify: `apps/web/src/features/project-modules/module-service-bridge.ts`
- Modify: `apps/web/src/features/project-modules/module-service-bridge.test.ts`
- Modify: `apps/web/src/features/project-modules/project-module-host.ts`
- Modify: `apps/web/src/features/project-modules/project-module-host.test.ts`

**Interfaces:**
- Add `client.data.documents.*`, `client.data.assets.*`, and `client.settings.read({ signal })`.
- The host bridge permits only operations declared by the signed manifest and current installation revision.
- Token request cancellation removes listeners and timers and ignores late responses.

- [x] Write failing SDK tests for request URLs, schemas, `AbortSignal`, non-2xx errors, and object response bounds.
- [x] Write failing host tests for data/settings declaration parsing, rate limits, wrong origin/source, stale install revision, and cleanup.
- [x] Implement the SDK clients and extend the host operation allow-list.
- [x] Run SDK and project-module test suites plus typechecks; do not commit.

### Task 5: Platform-owned settings management UI

**Files:**
- Create: `apps/web/src/features/project-modules/module-settings-panel.tsx`
- Create: `apps/web/src/features/project-modules/module-settings-panel.test.tsx`
- Modify: `apps/web/src/features/project-modules/project-modules-page.tsx`
- Modify: `apps/web/src/features/project-modules/client.ts`
- Create: `apps/api/src/module-services/settings-admin.ts`
- Create: `apps/api/src/module-services/settings-admin.test.ts`
- Modify: `apps/api/src/module-services/app.ts`

**Interfaces:**
- Project managers can edit declared installation settings through platform-authenticated project APIs.
- The generated form supports bounded field types, model options from the platform catalog, validation messages, reset-to-default, and optimistic revision checks.
- No module iframe receives a settings write capability.

- [x] Read `.claude/skills/kortix-design-system/SKILL.md` before editing visual files.
- [x] Write failing API authorization/revision tests and component interaction tests.
- [x] Implement the admin route and generated settings form using existing UI primitives.
- [x] Run focused API tests, component tests, ESLint for changed web files, and targeted TypeScript diagnostics; do not commit.

### Task 6: Infinite Canvas static module application

**Files:**
- Create: `apps/infinite-canvas-module/package.json`
- Create: `apps/infinite-canvas-module/vite.config.ts`
- Create: `apps/infinite-canvas-module/tsconfig.json`
- Create: `apps/infinite-canvas-module/index.html`
- Create: `apps/infinite-canvas-module/src/**`
- Create: `apps/infinite-canvas-module/public/**`
- Create: `apps/infinite-canvas-module/tests/**`

**Interfaces:**
- `OpenOpcGateway` is the only privileged transport and wraps SDK calls with cancellation and normalized errors.
- `DocumentRepository` combines IndexedDB recovery with versioned platform synchronization.
- `CanvasWorkspace`, `NodeRuntime`, and `WorkflowRuntime` remain UI/application components with no provider or credential awareness.
- Static output is `apps/infinite-canvas-module/dist/index.html` plus relative assets and requires no server-side runtime.

- [x] Import the pinned upstream source at commit `6d0bed4eb1ad9f1ec4fe0ec635b267bcb3bc901b` into this worktree and record provenance.
- [x] Inventory upstream canvas, node, history, import/export, asset, assistant, and settings behaviors; create a parity test matrix with no omitted feature rows.
- [x] Write failing tests for document persistence, node serialization, workflow cancellation, capability-disabled states, import/export, and cleanup.
- [x] Port the frontend into a Vite static application, replacing Next/Go/provider calls with `OpenOpcGateway` and platform repositories.
- [x] Implement responsive toolbars, drawers, inspectors, touch interactions, and stable canvas dimensions for 390px mobile.
- [x] Run module unit tests, typecheck, format check, and production build; do not commit.

### Task 7: Manifest, packaging, and third-party notices

**Files:**
- Create: `apps/infinite-canvas-module/openopc.manifest.json`
- Create: `apps/infinite-canvas-module/registry-item.json`
- Create: `apps/infinite-canvas-module/LICENSE`
- Create: `apps/infinite-canvas-module/THIRD_PARTY_NOTICES.md`
- Create: `apps/infinite-canvas-module/UPSTREAM.md`
- Create: `apps/infinite-canvas-module/scripts/validate-artifact.ts`

**Interfaces:**
- Manifest ID is `openopc.infinite-canvas`, schema version 3, mode/profile `sandboxed-web`, entry `dist/index.html`.
- `capabilities[]` describes the canvas page and import/export workflow.
- `openopc.services.*.operations[]` contains only operations used by the module.
- Artifact validation rejects absolute/remote entries, credentials, undeclared requests, path traversal, and files over platform limits.

- [x] Write failing manifest/artifact tests for capability declarations and prohibited fields.
- [x] Add the manifest, registry item, upstream commit record, license, notices, and artifact validator.
- [x] Build the static artifact and run registry/developer artifact validators.
- [x] Confirm the artifact is below the platform size ceiling or document the exact required host-limit change; do not commit.

### Task 8: Integrated verification and browser QA

**Files:**
- Modify only files required to fix defects discovered by verification.
- Create: `apps/infinite-canvas-module/tests/browser/infinite-canvas.spec.ts`
- Create: `apps/infinite-canvas-module/VERIFICATION.md`

**Interfaces:**
- Browser coverage proves launch, canvas editing, save/reload, import/export, settings application, capability denial, cancellation, and local fallback.
- Evidence distinguishes contract/type passes from real provider, worker, database, and production verification.

- [x] Run all focused unit tests for API contract, SDK, registry, API module services, web host, and module.
- [x] Run typechecks, format checks, production builds, manifest validation, and artifact size checks.
- [x] Start the local module/host services on unused ports and drive the real UI in Chromium.
- [x] Assert desktop and 390px layouts, no horizontal overflow, no console errors, and stable major interactions.
- [x] Exercise `AbortSignal`, stream cleanup, Blob URL revocation, offline storage, stale revision recovery, and capability error degradation.
- [x] Write exact commands/results and unverified external integrations to `VERIFICATION.md`.
- [x] Inspect `git status --short`, report all changed/untracked files, and stop without commit, push, deploy, or publish.

