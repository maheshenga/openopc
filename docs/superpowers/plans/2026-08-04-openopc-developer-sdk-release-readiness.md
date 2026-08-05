# OpenOPC Developer SDK Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@openopc/developer-sdk` a self-contained, documented npm package that browser modules can initialize without implementing the OpenOPC `postMessage` protocol, while completing the related `@kortix/sdk` developer-application facade and release gates.

**Architecture:** The developer package owns its stable public service/payment contracts and browser capability-token adapter. `@kortix/api-contract` remains a development-only source-of-truth comparison, and the Web host keeps only its host-side bridge while re-exporting the module-side adapter for compatibility. npm publication uses the repository's existing staged-manifest and GitHub Actions OIDC path.

**Tech Stack:** TypeScript 5, Bun test runner, pnpm workspaces, Node ESM, GitHub Actions, npm Trusted Publishing/OIDC.

## Global Constraints

- Work only in `E:\code\agentk\suna-studio-platform` on `design/desktop-release-deferred`.
- Preserve every pre-existing dirty and untracked file; merge edits in overlapping SDK/Web files without replacing user work.
- Do not stage, commit, push, merge, deploy, rebuild Desktop, or invoke live NewAPI/payment operations.
- Do not change package versions by hand; `scripts/stage-npm-publish.mjs` supplies the release version.
- Keep provider and merchant credentials out of all module APIs, examples, tests, errors, and artifacts.
- Every production behavior change requires an observed failing test before implementation.

---

### Task 1: Self-contained public contracts

**Files:**
- Create: `packages/openopc-developer-sdk/src/contracts.ts`
- Create: `packages/openopc-developer-sdk/src/contracts.test.ts`
- Modify: `packages/openopc-developer-sdk/src/client.ts`
- Modify: `packages/openopc-developer-sdk/src/index.ts`
- Modify: `packages/openopc-developer-sdk/package.json`

**Interfaces:**
- Produces `OpenOpcServiceName`, `OpenOpcServiceOperation`, payment request/result/view types, `ModuleServiceErrorCode`, and internal parse predicates used by `client.ts`.
- Keeps `@kortix/api-contract` only in `devDependencies` for development-time compatibility assertions.

- [x] Add a test which imports the public types locally, validates representative good/bad values, and recursively checks the built runtime/declaration import graph contains no `@kortix/api-contract` reference.
- [x] Run `pnpm.cmd --filter @openopc/developer-sdk test` and confirm RED because local contracts do not exist and the runtime still imports the private package.
- [x] Implement the exact `ai | payment` operations, bounded service error codes, CNY order/refund shapes, UUID/date/URL/idempotency validation, and move `client.ts` to those local validators.
- [x] Run focused package tests and typecheck; confirm GREEN without weakening existing protocol checks.

### Task 2: Browser capability-token adapter

**Files:**
- Create: `packages/openopc-developer-sdk/src/browser-capability-token.ts`
- Create: `packages/openopc-developer-sdk/src/browser-capability-token.test.ts`
- Modify: `packages/openopc-developer-sdk/src/index.ts`
- Modify: `apps/web/src/features/project-modules/module-service-bridge.ts`
- Modify: `apps/web/src/features/project-modules/module-service-bridge.test.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Produces `createOpenOpcBrowserCapabilityTokenAdapter(options): (input) => Promise<string>` plus public event/window/options types.
- Preserves `createSandboxModuleServiceTokenAdapter` as a deprecated compatibility alias in both the package and Web bridge module.

- [x] Write package tests for exact request shape, immutable HTTPS origin/source correlation, malformed response filtering, timeout cleanup, post failure cleanup, operation validation, and unique concurrent request correlation.
- [x] Run the focused adapter test and confirm RED because the package export is absent.
- [x] Move the module-side protocol into the SDK, implement the descriptive name plus compatibility alias, and make the Web bridge re-export those symbols instead of owning duplicate code.
- [x] Add `@openopc/developer-sdk: workspace:*` to Web dependencies and update the lockfile.
- [x] Run package and Web bridge tests; confirm GREEN and unchanged host-side behavior.

### Task 3: Package metadata, documentation, example, and installed-artifact smoke

**Files:**
- Create: `packages/openopc-developer-sdk/README.md`
- Create: `packages/openopc-developer-sdk/examples/browser-module.ts`
- Create: `packages/openopc-developer-sdk/examples/tsconfig.json`
- Create: `packages/openopc-developer-sdk/scripts/smoke-install.mjs`
- Modify: `packages/openopc-developer-sdk/package.json`
- Modify: `packages/openopc-developer-sdk/tsconfig.json`

**Interfaces:**
- Produces a public ESM package whose staged manifest resolves `dist/index.js` and `dist/index.d.ts` and whose documented browser initialization uses only public exports.

- [x] Add the example typecheck and smoke command to package scripts before the supporting files exist; run them and observe RED.
- [x] Add npm metadata, public `publishConfig`, README install/API/security documentation, and a browser module example that binds the SDK client to the adapter.
- [x] Implement a temporary-copy smoke script that builds, stages, packs, installs with npm, imports in Node ESM, constructs a client, verifies adapter exports, and asserts the installed manifest has no internal workspace dependency.
- [x] Run typecheck, build, staged dry-pack, and packed install/import smoke; confirm GREEN.

### Task 4: Developer application facade

**Files:**
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Modify: `packages/sdk/src/core/client/kortix.ts`

**Interfaces:**
- Produces `createKortix(config).developer.application.current(options?)` and `.submit(input)` using existing `getCurrentDeveloperApplication` and `submitDeveloperApplication` transports.

- [x] Add a facade test that calls both methods and asserts the existing exact GET/POST wire requests.
- [x] Run the focused test and confirm RED because `developer.application` is absent.
- [x] Add only the two facade bindings in `createKortix`; retain every existing developer method.
- [x] Run the focused developer SDK tests and typecheck; confirm GREEN.

### Task 5: Public type snapshot and CI/release gates

**Files:**
- Modify: `packages/sdk/src/public-type-surface.snapshot.json`
- Modify: `.github/workflows/package-tests.yml`
- Modify: `.github/workflows/deploy-prod.yml`

**Interfaces:**
- The SDK type snapshot records additive `FetchImpl` only.
- Pull requests build/dry-pack and smoke-install `@openopc/developer-sdk`.
- Production release publishes it through GitHub Actions OIDC; the first publication requires the existing restricted npm token bootstrap and later runs use npm Trusted Publishing.

- [x] Run the public type-surface test and preserve the RED output showing one additive `FetchImpl` entry and zero removals.
- [x] Regenerate the snapshot with `UPDATE_TYPE_SURFACE_SNAPSHOT=1`, inspect the diff, and rerun the test GREEN.
- [x] Add `openopc-developer-sdk` to the package dry-pack loop and add its installed-artifact smoke gate.
- [x] Add `@openopc/developer-sdk` to the npm release matrix with `REQUIRED_PUBLISH=1` and `NPM_OIDC_BOOTSTRAP_CHECK=1` only for that row.

### Task 6: Final verification and evidence ledger

**Files:**
- Modify: `packages/sdk/PROGRESS.md`

- [x] Run `pnpm.cmd --filter @openopc/developer-sdk test` and record exact pass/fail counts.
- [x] Run `pnpm.cmd --filter @openopc/developer-sdk typecheck`, `build`, staged `npm pack --dry-run`, and `smoke:install`.
- [x] Run the focused Web bridge suite and relevant Web typecheck/lint command.
- [x] Run focused `@kortix/sdk` developer tests, public runtime/type snapshot tests, `typecheck`, full `test`, and `smoke:install`.
- [x] Run `node scripts/stage-npm-publish.test.mjs`, syntax/structure checks for edited workflows/scripts, and `git diff --check`.
- [x] Append fresh RED/GREEN and final gate evidence to `packages/sdk/PROGRESS.md`, explicitly marking live NewAPI/payment publication/deployment verification as deferred.
