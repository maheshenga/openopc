# OpenOPC Developer Package-Upload Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the unavailable code-package submission path in the shared Web/Desktop developer UI while preserving declarative JSON submission and automatically restoring package upload when the API's existing trust gate is ready.

**Architecture:** Add one fail-closed capability read to `DeveloperModuleArtifactService` and use that same predicate for mutation enforcement. Compose its boolean into the existing authenticated `/developer/access` response, expose it through the existing SDK type, and gate the existing shared submission view on an explicit true value without adding another request or frontend environment flag.

**Tech Stack:** TypeScript, Bun test, Hono OpenAPI, Zod, `@kortix/sdk`, React, TanStack Query, Next.js App Router, Windows Desktop's shared OpenOPC Web route.

## Global Constraints

- Work only in `E:\code\agentk\suna-studio-platform` on the current `design/desktop-release-deferred` branch.
- Preserve all pre-existing dirty work. Do not modify Admin files, `supabase/config.toml`, `packages/sdk/src/core/http/api-client.ts`, or `docs/superpowers/plans/2026-08-01-openopc-developer-sdk-newapi-zpay.md` as part of this plan.
- Do not stage, commit, push, merge, deploy, enable feature flags, rebuild Desktop, or publish artifacts.
- Use strict TDD for every behavior: add one focused test, run it and record the expected RED, then make the smallest GREEN change.
- `DEVELOPER_CODE_MODULES_ENABLED` and `DEVELOPER_TRUST_ENABLED` remain false in the current environment.
- `POST /developer/modules/artifact-uploads` and finalization remain server-authoritative and keep returning `503 DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED` whenever the shared predicate is false.
- `/developer/access` returns `200` with `capabilities.package_upload: false` for disabled, negative, or throwing trust readiness.
- The API response field is required; the Web consumer still treats a missing capability object or field as false for rolling compatibility.
- Declarative JSON validation and submission must not depend on developer-access loading or success.
- Add no second capability endpoint, frontend environment flag, readiness detail, infrastructure error text, or Desktop-specific submission UI.
- Capability changes must never auto-submit, retry, cancel, or otherwise mutate a package upload.
- Use `pnpm.cmd` on Windows and report actual pass/fail counts from fresh command output.

## File Map

### Shared server authority

- Modify `apps/api/src/developer/artifacts.ts`: expose `isPackageUploadAvailable()` and make the existing assertion call it.
- Modify `apps/api/src/developer/artifacts.test.ts`: prove disabled, negative, throwing, and ready predicate outcomes plus unchanged mutation blocking.
- Modify `apps/api/src/developer/app.ts`: add the response schema field, dependency method, and `/access` composition.
- Modify `apps/api/src/developer/index.test.ts`: prove true and false route responses while preserving account authorization and Publisher access.

### Public SDK contract

- Modify `packages/sdk/src/core/rest/projects-client/developer-modules.ts`: add required `DeveloperAccess.capabilities.package_upload`.
- Modify `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`: type-check and return the capability without changing the request URL or method.

### Shared Web/Desktop submission surface

- Modify `apps/web/src/features/developer-center/publisher/submit-page.tsx`: gate the package tab and package view, derive account-scoped availability, and reconcile a true-to-false transition without network mutation.
- Modify `apps/web/src/features/developer-center/publisher/submit-page.test.tsx`: cover default/missing false, explicit false, and explicit true rendering.
- Modify `apps/web/src/features/developer-center/publisher/submit-page.connected.test.tsx`: cover loading, error, account mismatch, missing capability, account switch, and true-to-false cleanup.
- Modify `apps/web/src/features/developer-center/publisher/access.test.ts`: add the required capability to typed fixtures.
- Modify `apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx`: add the required capability to the cached typed fixture.

No new production file, API route, cache key, database migration, Admin file, Desktop source file, or runtime dependency is introduced.

---

### Task 1: Centralize the Artifact-Service Capability Predicate

**Files:**
- Modify: `apps/api/src/developer/artifacts.test.ts:1,415-493`
- Modify: `apps/api/src/developer/artifacts.ts:423-453,513-520,594-600`

**Interfaces:**
- Produces: `DeveloperModuleArtifactService.isPackageUploadAvailable(): Promise<boolean>`
- Preserves: `createUpload(...)` and `finalizeUploadResult(...)` throw `DeveloperModuleArtifactError('DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED', 503)` when unavailable.
- Consumes: existing constructor fields `codeModulesEnabled` and `trustInfrastructureReady`.

- [x] **Step 1: Add a failing capability-read test**

Add this test beside the existing disabled/readiness tests in
`artifacts.test.ts`:

```ts
test('reports package upload availability from the fail-closed trust predicate', async () => {
  const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
  const store = createMemoryDeveloperArtifactStore().store;
  let disabledProbeCalls = 0;

  const disabled = new DeveloperModuleArtifactService({
    repository,
    store,
    codeModulesEnabled: false,
    trustInfrastructureReady: async () => {
      disabledProbeCalls += 1;
      return true;
    },
  });
  const notReady = new DeveloperModuleArtifactService({
    repository,
    store,
    codeModulesEnabled: true,
    trustInfrastructureReady: async () => false,
  });
  const throwing = new DeveloperModuleArtifactService({
    repository,
    store,
    codeModulesEnabled: true,
    trustInfrastructureReady: async () => {
      throw new Error('readiness dependency failed');
    },
  });
  const ready = new DeveloperModuleArtifactService({
    repository,
    store,
    codeModulesEnabled: true,
    trustInfrastructureReady: async () => true,
  });

  await expect(disabled.isPackageUploadAvailable()).resolves.toBe(false);
  expect(disabledProbeCalls).toBe(0);
  await expect(notReady.isPackageUploadAvailable()).resolves.toBe(false);
  await expect(throwing.isPackageUploadAvailable()).resolves.toBe(false);
  await expect(ready.isPackageUploadAvailable()).resolves.toBe(true);
});
```

- [x] **Step 2: Run the focused service test and capture RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/artifacts.test.ts
```

Expected RED: the new test fails because
`DeveloperModuleArtifactService.isPackageUploadAvailable` does not exist. The
existing upload tests must still execute; do not alter their assertions.

- [x] **Step 3: Implement the shared predicate and delegate the assertion**

Replace the current private assertion body with exactly one public read method
and one assertion that delegates to it:

```ts
async isPackageUploadAvailable(): Promise<boolean> {
  if (!this.codeModulesEnabled) return false;
  try {
    return (await this.trustInfrastructureReady()) === true;
  } catch {
    return false;
  }
}

private async assertCodeModuleSubmissionEnabled(): Promise<void> {
  if (await this.isPackageUploadAvailable()) return;
  throw new DeveloperModuleArtifactError('DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED', 503);
}
```

Do not cache readiness. Upload creation and finalization must evaluate the
predicate at mutation time.

- [x] **Step 4: Run the artifact-service suite and verify GREEN**

Run the same command from Step 2. Expected: every test in
`artifacts.test.ts` passes, including the existing disabled-upload,
disabled-finalization, and trust-worker-readiness cases.

- [x] **Step 5: Check only the Task 1 diff**

Run:

```powershell
git diff --check -- apps/api/src/developer/artifacts.ts apps/api/src/developer/artifacts.test.ts
git diff -- apps/api/src/developer/artifacts.ts apps/api/src/developer/artifacts.test.ts
```

Expected: only the public predicate, delegated assertion, and focused test are
present. Do not stage or commit them.

---

### Task 2: Add the Server-Authoritative Developer-Access Field

**Files:**
- Modify: `apps/api/src/developer/index.test.ts:96-147,910-1006`
- Modify: `apps/api/src/developer/app.ts:323-334,437-464,673-697`

**Interfaces:**
- Consumes: `DeveloperModuleArtifactService.isPackageUploadAvailable(): Promise<boolean>` from Task 1.
- Produces: `GET /developer/access` response field `capabilities: { package_upload: boolean }`.
- Preserves: existing authentication, selected-account resolution, `account.read` authorization, organization, invitations, Publishers, and memberships.

- [x] **Step 1: Add failing route expectations for true and false**

In the existing `developer Publisher API` test, extend the `/access` assertion:

```ts
expect(await access.json()).toEqual(
  expect.objectContaining({
    account_id: ACCOUNT_ID,
    capabilities: { package_upload: true },
    publishers: [
      expect.objectContaining({
        publisher: expect.objectContaining({ publisher_id: 'acme-labs' }),
        membership: expect.objectContaining({ role: 'owner' }),
      }),
    ],
  }),
);
```

Add a separate route test using a real disabled artifact service:

```ts
test('returns package upload false without failing developer access when trust is unavailable', async () => {
  const artifactService = new DeveloperModuleArtifactService({
    repository: createMemoryDeveloperModuleArtifactRepository(),
    store: createMemoryDeveloperArtifactStore().store,
    codeModulesEnabled: true,
    trustInfrastructureReady: async () => {
      throw new Error('trust worker unavailable');
    },
  });
  const actions: string[] = [];
  const response = await authenticatedApp({
    artifactService,
    authorizeAccount: async (_context, _accountId, action) => {
      actions.push(action);
    },
  }).request(`/access?account_id=${ACCOUNT_ID}`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(
    expect.objectContaining({
      account_id: ACCOUNT_ID,
      capabilities: { package_upload: false },
    }),
  );
  expect(actions).toEqual([ACCOUNT_ACTIONS.ACCOUNT_READ]);
});
```

- [x] **Step 2: Run the route test and capture RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/index.test.ts
```

Expected RED: `/access` lacks `capabilities`, and the dependency type does not
yet include `isPackageUploadAvailable`.

- [x] **Step 3: Extend the OpenAPI schema and dependency contract**

Add the capability object to `DeveloperAccessSchema`:

```ts
const DeveloperAccessSchema = z.object({
  account_id: z.string().uuid(),
  user_id: z.string().uuid(),
  organization: DeveloperOrganizationSchema.nullable(),
  invitations: z.array(DeveloperInvitationSchema),
  publishers: z.array(
    z.object({
      publisher: DeveloperPublisherSchema,
      membership: DeveloperPublisherMemberSchema.nullable(),
    }),
  ),
  capabilities: z.object({
    package_upload: z.boolean(),
  }),
});
```

Add `'isPackageUploadAvailable'` to the existing `artifactService` `Pick` in
`DeveloperAppDependencies`.

- [x] **Step 4: Compose access and capability without turning false into an error**

After existing account authorization, replace the single Publisher-service
call with:

```ts
const [access, packageUploadAvailable] = await Promise.all([
  dependencies.publisherService.getDeveloperAccess({
    accountId,
    userId: context.get('userId'),
    email: context.get('userEmail'),
  }),
  dependencies.artifactService.isPackageUploadAvailable(),
]);
return context.json(
  {
    ...access,
    capabilities: { package_upload: packageUploadAvailable },
  },
  200,
);
```

Do not add `503` to this read route solely for trust unavailability, and do not
return a readiness reason.

- [x] **Step 5: Run both focused API suites and verify GREEN**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/artifacts.test.ts src/developer/index.test.ts
```

Expected: all tests in both files pass; the false route response remains `200`.

- [x] **Step 6: Check only the Task 2 diff**

Run `git diff --check` and `git diff` for `apps/api/src/developer/app.ts` and
`apps/api/src/developer/index.test.ts`. Confirm that no new route, environment
read, or readiness detail was added. Do not stage or commit.

---

### Task 3: Extend the Existing SDK Access Contract

**Files:**
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts:1-44,109-157`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts:383-392,454-462`

**Interfaces:**
- Produces: required `DeveloperAccess.capabilities.package_upload: boolean`.
- Preserves: `getDeveloperAccess(options?)` signature and
  `GET /developer/access?account_id=...` transport.

- [x] **Step 1: Make the SDK test response controllable**

Add a response variable without changing the existing request recorder:

```ts
let calls: Array<{ url: string; method: string; body: unknown }> = [];
let responseBody: unknown;

beforeEach(() => {
  calls = [];
  responseBody = { valid: true, issues: [] };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});
```

- [x] **Step 2: Add a compile-contract assertion and capture RED**

Import `type DeveloperAccess`, then add:

```ts
test('developer access exposes the server-authoritative package upload capability', async () => {
  responseBody = {
    account_id: 'acc-1',
    user_id: 'user-1',
    organization: null,
    invitations: [],
    publishers: [],
    capabilities: { package_upload: false },
  };

  const access: DeveloperAccess = await getDeveloperAccess({ accountId: 'acc-1' });

  expect(access.capabilities.package_upload).toBe(false);
  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/access?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
  ]);
});
```

Run:

```powershell
pnpm.cmd --filter @kortix/sdk typecheck
```

Expected RED: TypeScript reports that `capabilities` does not exist on
`DeveloperAccess`. This task's RED is a compile-contract failure because the
SDK performs no runtime response transformation.

- [x] **Step 3: Add the required SDK field**

Extend only the interface:

```ts
export interface DeveloperAccess {
  account_id: string;
  user_id: string;
  organization: DeveloperOrganization | null;
  invitations: DeveloperInvitation[];
  publishers: Array<{
    publisher: DeveloperPublisher;
    membership: DeveloperPublisherMember | null;
  }>;
  capabilities: {
    package_upload: boolean;
  };
}
```

Do not change `getDeveloperAccess`, add runtime defaults, or create another SDK
function.

- [x] **Step 4: Run focused SDK test and typecheck for GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/core/rest/projects-client/developer-modules.test.ts
pnpm.cmd --filter @kortix/sdk typecheck
```

Expected: the focused test and both SDK TypeScript configurations pass.

- [x] **Step 5: Inspect the exact SDK diff**

Run `git diff --check` and `git diff` for the two Task 3 files. Confirm the
unrelated existing `packages/sdk/src/core/http/api-client.ts` change is neither
modified nor staged.

---

### Task 4: Gate the Pure Shared Submission View

**Files:**
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.test.tsx:54-305`
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.tsx:59-86,271-364`

**Interfaces:**
- Produces: optional view prop `packageUploadAvailable?: boolean`, defaulting to false.
- Preserves: `Declarative JSON` tab and declarative form for every capability state.
- Enforces: `mode="package"` cannot render package controls unless availability is explicitly true.

- [x] **Step 1: Change the default test to fail closed and add explicit true/false tests**

Change the first view test's final assertion to:

```ts
expect(html).toContain('Declarative JSON');
expect(html).not.toContain('Package upload');
```

Add:

```ts
test('renders package submission only for an explicit true capability', () => {
  const enabled = renderToStaticMarkup(
    <DeveloperModuleSubmitView
      packageUploadAvailable
      mode="package"
      stage="input"
      text=""
      item={null}
      issues={[]}
      inputErrorCode={null}
      canWrite
      pending={false}
      errorCode={null}
      onTextChange={noop}
      onValidate={noop}
      onConfirm={noop}
    />,
  );
  const disabled = renderToStaticMarkup(
    <DeveloperModuleSubmitView
      packageUploadAvailable={false}
      mode="package"
      stage="input"
      text=""
      item={null}
      issues={[]}
      inputErrorCode={null}
      canWrite
      pending={false}
      errorCode={null}
      onTextChange={noop}
      onValidate={noop}
      onConfirm={noop}
    />,
  );

  expect(enabled).toContain('Package upload');
  expect(enabled).toContain('aria-label="Package upload"');
  expect(disabled).not.toContain('Package upload');
  expect(disabled).not.toContain('aria-label="Package upload"');
  expect(disabled).toContain('Module manifest input');
});
```

Add `packageUploadAvailable` to every existing test that intentionally renders
`mode="package"` or package progress. Do not weaken those Publisher, cancel,
digest, or error assertions.

- [x] **Step 2: Run the pure view test and capture RED**

Run:

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/submit-page.test.tsx
```

Expected RED: the current view still renders `Package upload` by default and
still renders the package section for `mode="package"` with false.

- [x] **Step 3: Add the prop and derive an effective mode**

Add the prop to `DeveloperModuleSubmitViewProps`, default it to false in the
component parameters, and derive:

```ts
const effectiveMode: DeveloperModuleSubmitMode =
  packageUploadAvailable && mode === 'package' ? 'package' : 'declarative';
```

Keep the existing tab list and Declarative JSON button. Render the Package
upload button only inside:

```tsx
{packageUploadAvailable ? (
  <button
    type="button"
    role="tab"
    aria-selected={effectiveMode === 'package'}
    className="h-7 rounded-md px-3 text-sm font-medium aria-selected:bg-background aria-selected:shadow-sm"
    onClick={() => onModeChange('package')}
  >
    Package upload
  </button>
) : null}
```

Use `effectiveMode` for both tab selection and the package/declarative content
branch. Do not add explanatory copy or a disabled package button.

- [x] **Step 4: Run the pure view test and verify GREEN**

Run the same command from Step 2. Expected: every existing view test passes,
the missing/default state hides package upload, and explicit true preserves the
complete existing package UI.

- [x] **Step 5: Check the Task 4 diff**

Run `git diff --check` and inspect only `submit-page.tsx` and
`submit-page.test.tsx`. Confirm there is no visual restyling, new user-facing
instruction text, or declarative behavior change.

---

### Task 5: Connect Account-Scoped Capability State and Reconcile Transitions

**Files:**
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.connected.test.tsx:1-148`
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.tsx:504-680`
- Modify: `apps/web/src/features/developer-center/publisher/access.test.ts:52-60`
- Modify: `apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx:197-205`

**Interfaces:**
- Consumes: `DeveloperAccess.capabilities.package_upload` from Task 3.
- Passes: `packageUploadAvailable` into `DeveloperModuleSubmitView` from Task 4.
- Preserves: existing account-scoped Publisher reconciliation and 15-second access cache.

- [x] **Step 1: Update typed fixtures without changing their test behavior**

Add the required field to `DeveloperAccess` literals in `access.test.ts` and
`onboarding-panel.test.tsx`:

```ts
capabilities: { package_upload: true },
```

The selection and cache assertions stay unchanged.

- [x] **Step 2: Make connected query state controllable and add capability data**

In `submit-page.connected.test.tsx`, import `beforeEach`, add query-state
variables, and reset them before every test:

```ts
let selectedAccountId = 'account-a';
let publisherAccess: unknown;
let publisherAccessError = false;
let publisherAccessLoading = false;

beforeEach(() => {
  selectedAccountId = 'account-a';
  publisherAccess = undefined;
  publisherAccessError = false;
  publisherAccessLoading = false;
});
```

Return those values from the existing access-query mock. Replace the access
helper with a complete rolling-compatible fixture:

```ts
function access(
  accountId: string,
  publisherIds: string[],
  packageUpload: boolean | undefined = true,
) {
  return {
    account_id: accountId,
    user_id: 'user-1',
    organization: null,
    invitations: [],
    publishers: publisherIds.map((publisherId) => publisher(publisherId, accountId)),
    ...(packageUpload === undefined
      ? {}
      : { capabilities: { package_upload: packageUpload } }),
  };
}
```

- [x] **Step 3: Add connected fail-closed and transition tests**

Add one test that rerenders the page for these states and asserts the Package
upload button is absent in each: initial loading, query error with stale true
data, selected-account mismatch, missing capability, and explicit false. Then
set a matching explicit true response and assert the button appears.

Add a second test that:

1. renders matching true access with Publishers `a1` and `a2`;
2. opens Package upload and selects `a2`;
3. rerenders with explicit false and asserts the package button and package
   section are absent while declarative input is present;
4. rerenders with explicit true, reopens Package upload, and asserts the
   Publisher selection is empty.

Use the existing `installDom`, `render`, and DOM event pattern. The core
assertions are:

```ts
const packageTab = () =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Package upload',
  );

expect(packageTab()).toBeUndefined();
expect(document.querySelector('[aria-label="Module manifest input"]')).not.toBeNull();

publisherAccess = access('account-a', ['a1', 'a2'], true);
await render();
expect(packageTab()).toBeDefined();
```

Do not mock or expect a cancel, retry, upload, or submit call during a
capability transition.

- [x] **Step 4: Run connected and typed-fixture tests and capture RED**

Run:

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/submit-page.connected.test.tsx src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/onboarding-panel.test.tsx
```

Expected RED: the connected page does not yet pass an explicit availability
prop, so matching true access does not reveal the package tab after Task 4.

- [x] **Step 5: Derive availability from the current account and query state**

Immediately after `accountAccess`, add:

```ts
const packageUploadAvailable =
  !accessQuery.isLoading &&
  !accessQuery.isError &&
  accountAccess?.capabilities?.package_upload === true;
```

The optional property access is intentional for rolling compatibility even
though the updated SDK type makes the field required.

- [x] **Step 6: Reconcile true-to-false without network mutation**

Add an idle-state predicate and effect:

```ts
const packageRequestIdle = packageState.stage === 'idle';

useEffect(() => {
  if (packageUploadAvailable) return;
  setMode('declarative');
  if (!packageRequestIdle) return;

  setPackageFile(null);
  setPackageSelection({ accountId: selectedAccountId, publisherId: '' });
}, [
  packageRequestIdle,
  packageUploadAvailable,
  selectedAccountId,
]);
```

Pass `packageUploadAvailable={packageUploadAvailable}` to the view. Do not call
`packageController.reset`, `cancel`, `start`, or any query mutation from this
effect. An active or settled non-idle controller state remains hidden and is
handled by the existing package flow if capability later returns.

- [x] **Step 7: Run all shared submission tests and verify GREEN**

Run:

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/submit-page.test.tsx src/features/developer-center/publisher/submit-page.connected.test.tsx src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/access-query.test.ts src/features/developer-center/publisher/onboarding-panel.test.tsx src/features/developer-center/publisher/artifact-upload-controller.test.ts src/features/developer-center/publisher/submit-controller.test.ts
```

Expected: all listed tests pass. Record the exact test and failure counts.

- [x] **Step 8: Inspect the Task 5 diff**

Confirm the transition effect performs only local React state updates,
the current-account match remains required, and no package code path is
reachable from false, missing, loading, error, or mismatched access state.

---

### Task 6: Run Fresh Cross-Layer Verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Verifies: service predicate -> `/developer/access` -> SDK type -> shared Web/Desktop page.
- Preserves: current no-commit, no-push, no-deploy boundary.

- [x] **Step 1: Run focused API verification**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/artifacts.test.ts src/developer/index.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Record exact tests passed, failed, and skipped. A focused pass is not a claim
about Docker, live trust worker, or the full API repository.

- [x] **Step 2: Run full SDK regression and typecheck**

```powershell
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk typecheck
```

Record exact counts. Do not modify the pre-existing Fetch typing fix in
`packages/sdk/src/core/http/api-client.ts` during this task.

- [x] **Step 3: Run focused Web regression and typecheck**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/submit-page.test.tsx src/features/developer-center/publisher/submit-page.connected.test.tsx src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/access-query.test.ts src/features/developer-center/publisher/onboarding-panel.test.tsx src/features/developer-center/publisher/artifact-upload-controller.test.ts src/features/developer-center/publisher/submit-controller.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend typecheck
```

Record exact counts and any diagnostics. Do not suppress, skip, or reclassify a
failure.

- [x] **Step 4: Verify the current local fail-closed experience**

With the existing local API and authenticated Web session, open
`http://localhost:3000/developer/modules/submit` at one desktop and one mobile
viewport. Verify:

- `Declarative JSON` is visible and usable;
- `Package upload` is absent;
- no loading flash exposes package controls;
- there is no horizontal overflow, overlap, or clipped control;
- the browser console has no new error from capability handling.

This is a shared Web/Desktop route check, not a rebuilt Desktop-package claim.

- [x] **Step 5: Run final diff and boundary checks**

```powershell
git diff --check
git status --short --branch
git diff -- apps/api/src/developer/artifacts.ts apps/api/src/developer/artifacts.test.ts apps/api/src/developer/app.ts apps/api/src/developer/index.test.ts packages/sdk/src/core/rest/projects-client/developer-modules.ts packages/sdk/src/core/rest/projects-client/developer-modules.test.ts apps/web/src/features/developer-center/publisher/submit-page.tsx apps/web/src/features/developer-center/publisher/submit-page.test.tsx apps/web/src/features/developer-center/publisher/submit-page.connected.test.tsx apps/web/src/features/developer-center/publisher/access.test.ts apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx
```

Confirm unrelated dirty files are unchanged, no secret or environment value is
present, and no file is staged. Report focused verification separately from
unverified live trust worker, deployment, Desktop rebuild/signing, DNS, AI, and
payment checks.
