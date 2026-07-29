# OpenOPC Public-Beta Foundation Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver fail-closed public admission, a complete Web-first OpenOPC workbench, an independently deployable Admin application, and a bounded Windows Desktop enhancement while preserving Kortix behavior.

**Architecture:** The API remains the authority for registration, policy acceptance, account requests, developer admission, Admin IAM, step-up, and audit. `apps/admin` becomes its own Next.js artifact, while Web and Desktop consume shared typed brand/config packages and the existing Kortix SDK/API contracts. Desktop adds local grants only through its existing policy/preload boundary.

**Tech Stack:** Next.js, React, Tailwind, existing Radix/shadcn primitives, Hono OpenAPI, Zod, Drizzle/PostgreSQL, Supabase Auth, Cloudflare Turnstile-compatible verification, Electron, Bun test, Playwright smoke scripts.

## Global Constraints

- Work in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`.
- The browser product must work with no Desktop process, bridge, daemon, or Desktop secret.
- Admin must be an independent build and hostname; Web must return `404` for `/admin`, Admin chunks, and Admin-only assets.
- User-visible names become OpenOPC; retain `@kortix/*`, the `kortix` schema, `KORTIX_*` fallback, `KortixDesktop`, `kortix://`, OAuth callbacks, and existing `/v1` contracts.
- `OPENOPC_*` configuration takes precedence and falls back to the corresponding legacy setting.
- Registration challenge, verification, access-policy, and token dependency failures fail closed without disclosing account existence.
- Admin sensitive operations require exact server permission, scope, reason, step-up authentication, and immutable audit.
- Full-access Desktop mode requires local action, bounded grant, visible state, signed short-lived command, local revalidation, and audit; cloud state cannot broaden it.
- Use the approved Workspace-first three-column layout and restrained Material 3 / Google Workspace visual language.
- Do not add first-party multimedia product pages or native Android/iOS work.
- Do not modify the three protected files named in the program plan.
- Do not edit current dirty Task 8 runtime files.
- Do not run destructive Git commands or the full monorepo suite.
- Use `pnpm.cmd`; proposed commit commands require renewed user authorization.

---

## File Map

- `apps/api/src/access-control/public-registration.ts`: fail-closed registration decision service.
- `apps/api/src/access-control/public-registration.test.ts`: challenge, rate, dependency-failure, and enumeration tests.
- `apps/api/src/access-control/index.ts`: public registration preflight endpoint.
- `apps/web/src/app/(auth)/auth/actions.ts`: consume one authoritative preflight result; remove fail-open logic.
- `apps/web/src/app/(auth)/auth/actions.test.ts`: server-action regression tests.
- `packages/db/migrations/20260728100000000_public_beta_identity_requests.sql`: policy consent, export/delete, and developer application records.
- `packages/db/src/schema/kortix.ts`: typed identity-request tables.
- `apps/api/src/account-requests/*`: authenticated export/delete/report routes.
- `apps/api/src/developer/applications.*`: self-service and invited developer admission state.
- `apps/admin/*`: independent Next.js Admin build, routes, middleware, and tests.
- `packages/product-brand/*`: shared user-visible brand and compatibility configuration.
- `apps/web/src/features/layout/*`: three-column primary rail, contextual rail, work area, and global search integration.
- `apps/desktop-electron/*`: OpenOPC packaging/display and bounded local full-access grants.
- `apps/web/scripts/e2e/public-beta-foundation-smoke.ts`: visible Web/Admin/Desktop contract smoke.

### Task 1: Make public registration preflight authoritative and fail closed

**Files:**
- Create: `apps/api/src/access-control/public-registration.ts`
- Create: `apps/api/src/access-control/public-registration.test.ts`
- Create: `apps/api/src/access-control/public-registration.drizzle.ts`
- Modify: `apps/api/src/access-control/index.ts`
- Create: `packages/db/migrations/20260728090000000_public_registration_guards.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/src/public-registration-guards-schema.test.ts`
- Create: `packages/db/scripts/public-registration-guards.integration.test.ts`
- Create: `apps/web/src/app/(auth)/auth/actions.test.ts`
- Modify: `apps/web/src/app/(auth)/auth/actions.ts`
- Modify: `apps/web/src/app/(auth)/auth/page.tsx`

**Interfaces:**

```ts
export interface PublicRegistrationInput {
  email: string;
  challengeToken: string;
  deviceId: string;
  clientIp: string;
  action: 'signup' | 'magic-link';
  policyVersions: { terms: string; privacy: string; acceptableUse: string };
}

export type PublicRegistrationDecision =
  | { allowed: true; decisionToken: string; expiresAt: string }
  | { allowed: false; code: 'REGISTRATION_DENIED' | 'REGISTRATION_DEPENDENCY_UNAVAILABLE' | 'REGISTRATION_RATE_LIMITED' };
```

- [ ] **Step 1: Write failing API and server-action tests**

Cover valid challenge, missing token, invalid challenge action/hostname, Turnstile timeout, access-cache failure, IP/device/email/action rate exhaustion, malformed policy versions, decision-token replay, and existing/non-existing email parity. In the Web test, make `/access/registration/preflight` return 503 and assert `signUp()` does not call `signInWithOtp`.

```ts
test('fails closed when registration authority is unavailable', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
  const result = await signUp(null, validSignupForm());
  expect(result).toEqual({ message: 'Registration is temporarily unavailable. Please try again.' });
  expect(signInWithOtp).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/access-control/public-registration.test.ts
cd ../web; bun test "src/app/(auth)/auth/actions.test.ts"
cd ../../packages/db; bun test src/public-registration-guards-schema.test.ts scripts/public-registration-guards.integration.test.ts
```

Expected: FAIL because the preflight service and fail-closed action do not exist.

- [ ] **Step 3: Implement a one-time signed decision token**

Create `public_registration_decisions` and `public_registration_rate_buckets` in the `kortix` schema. The Drizzle adapter atomically consumes fixed windows for IP, device digest, email digest, account when known, and action, and stores only HMAC-derived dimension keys. It persists the decision JTI hash, bound digests/policies, expiry, and one-time consumption state; immutable identity fields cannot be updated. Create `createPublicRegistrationService(deps)` with injected `verifyChallenge`, durable `consumeRateLimit`, `canSignUp`, `now`, and HMAC key. Bind normalized email digest, device digest, action, exact policy versions, nonce, issue time, and five-minute expiry. Do not store raw challenge or device identifiers. Return the same public denial envelope for allowlist, unknown email, and existing-account branches.

Replace the current `try/catch` fail-open block in `signUp()` with one POST to `/access/registration/preflight`; pass the returned decision token to Supabase user metadata and reject every non-200 or malformed response. Keep `kortix://` callback behavior unchanged.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd apps/api; bun test src/access-control/public-registration.test.ts src/shared/rate-limit.test.ts
cd ../web; bun test "src/app/(auth)/auth/actions.test.ts"
cd ../../packages/db; bun test src/public-registration-guards-schema.test.ts scripts/public-registration-guards.integration.test.ts
pnpm.cmd migrate:lint
```

Expected: PASS; dependency failures never call OTP creation.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/access-control packages/db/migrations/20260728090000000_public_registration_guards.sql packages/db/src/schema/kortix.ts packages/db/src/public-registration-guards-schema.test.ts packages/db/scripts/public-registration-guards.integration.test.ts apps/web/src/app/'(auth)'/auth/actions.ts apps/web/src/app/'(auth)'/auth/actions.test.ts apps/web/src/app/'(auth)'/auth/page.tsx
git commit -m "feat(auth): enforce fail closed public registration"
```

### Task 2: Persist versioned policies and authenticated account requests

**Files:**
- Create: `packages/db/migrations/20260728100000000_public_beta_identity_requests.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/src/public-beta-identity-schema.test.ts`
- Create: `packages/db/scripts/public-beta-identity-migration.integration.test.ts`
- Create: `apps/api/src/account-requests/service.ts`
- Create: `apps/api/src/account-requests/service.test.ts`
- Create: `apps/api/src/account-requests/app.ts`
- Modify: `apps/api/src/access-control/public-registration.ts`
- Modify: `apps/api/src/access-control/public-registration.test.ts`
- Modify: `apps/api/src/access-control/index.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/web/src/app/(auth)/auth/callback/route.ts`
- Create: `apps/web/src/app/(auth)/auth/callback/route.test.ts`
- Modify: `apps/web/src/app/(auth)/auth/mobile/callback/route.ts`
- Create: `packages/sdk/src/core/rest/projects-client/account-requests.ts`
- Create: `packages/sdk/src/core/rest/projects-client/account-requests.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`

**Interfaces:**

```ts
export type AccountRequestKind = 'data_export' | 'account_deletion' | 'security_report' | 'module_report';
export interface CreateAccountRequestInput {
  kind: AccountRequestKind;
  reason?: string;
  moduleInstallationId?: string;
  idempotencyKey: string;
}
export interface PolicyAcceptance {
  accountId: string; userId: string; policy: 'terms'|'privacy'|'acceptable_use'|'module_rules';
  version: string; acceptedAt: string; source: 'registration'|'developer_application'|'settings';
}
```

- [ ] **Step 1: Write failing schema and service tests**

Assert append-only policy acceptance, unique `(account,user,policy,version)`, one-time completion of the signed registration decision after verified authentication, Web/mobile callback parity, immutable request creator/kind, idempotent creation, authenticated ownership, opaque cross-account 404, deletion cooling-off state, export expiry, and audit events without raw report secrets.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd packages/db; bun test src/public-beta-identity-schema.test.ts scripts/public-beta-identity-migration.integration.test.ts
cd ../../apps/api; bun test src/account-requests/service.test.ts
```

Expected: FAIL because the migration and service are absent.

- [ ] **Step 3: Implement append-only records and `/v1/account/requests`**

Add `policy_acceptances`, `account_requests`, and `developer_applications` under the existing `kortix` schema with account-prefixed composite foreign keys, RLS/service-role grants matching neighboring tables, immutable event/history triggers, normalized status constraints, and non-secret audit metadata. `developer_applications` stores a revision-fenced current projection and references the same developer organization verification record used by invitation admission. Add authenticated `POST /v1/access/registration/complete`; it verifies the one-time decision token from Task 1, binds the now-verified user/account, and writes the exact Terms/Privacy/AUP versions atomically. Both browser and mobile/Desktop callback routes call it before completing onboarding and fail closed if the acceptance cannot be stored. Account-request routes are `POST /v1/account/requests`, `GET /v1/account/requests`, and `POST /v1/account/requests/:requestId/cancel`; cancellation is allowed only before processing.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd packages/db; bun test src/public-beta-identity-schema.test.ts scripts/public-beta-identity-migration.integration.test.ts
cd ../../apps/api; bun test src/account-requests/service.test.ts
cd ../../packages/sdk; bun test src/core/rest/projects-client/account-requests.test.ts
pnpm.cmd migrate:lint
```

Expected: PASS and migration lint exits `0`.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/db apps/api/src/account-requests apps/api/src/access-control apps/api/src/index.ts apps/web/src/app/'(auth)'/auth/callback apps/web/src/app/'(auth)'/auth/mobile/callback packages/sdk/src/core/rest/projects-client
git commit -m "feat(account): add policy and privacy request records"
```

### Task 3: Add self-service developer admission without bypassing verification

**Files:**
- Create: `apps/api/src/developer/applications.ts`
- Create: `apps/api/src/developer/applications.test.ts`
- Create: `apps/api/src/developer/applications.drizzle.ts`
- Modify: `apps/api/src/developer/app.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/developer-modules.test.ts`
- Create: `apps/web/src/features/developer-center/application/developer-application-page.tsx`
- Create: `apps/web/src/features/developer-center/application/developer-application-page.test.tsx`
- Create: `apps/web/src/app/(app)/developer/apply/page.tsx`

**Interfaces:**

```ts
export type DeveloperApplicationState = 'draft'|'submitted'|'under_review'|'approved'|'rejected'|'suspended';
export interface DeveloperApplication {
  application_id: string; account_id: string; organization_id: string;
  state: DeveloperApplicationState; revision: number; submitted_at: string|null;
  policy_versions: { moduleRules: string; acceptableUse: string };
}
```

- [ ] **Step 1: Write failing authority tests**

Assert that self-service and invited applicants converge on the same organization verification record; submitting does not grant upload/release; only `approved` plus verified organization permits Publisher creation; rejection and suspension are revision-fenced and audited; unrelated accounts receive opaque 404.

- [ ] **Step 2: Run RED**

Run: `cd apps/api; bun test src/developer/applications.test.ts`

Expected: FAIL because the application state machine is absent.

- [ ] **Step 3: Implement the service, repository, routes, SDK, and page**

Add `POST /v1/developer/applications`, `GET /v1/developer/applications/current`, `POST /v1/admin/developer/applications/:id/decision`, and `POST /v1/admin/developer/applications/:id/suspend`. The Admin decision input is `{ decision: 'approve'|'reject', expected_revision: number, reason: string }`; require exact permission and step-up. Reuse `DeveloperOrganization.verification_state` as the authority instead of creating a parallel developer tenant.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
cd apps/api; bun test src/developer/applications.test.ts src/developer/publishers.test.ts
cd ../web; bun test src/features/developer-center/application/developer-application-page.test.tsx
cd ../../packages/sdk; bun test src/core/rest/projects-client/developer-modules.test.ts
```

Expected: PASS; an application alone cannot upload or release.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/developer apps/web/src/features/developer-center/application apps/web/src/app/'(app)'/developer/apply packages/sdk/src/core/rest/projects-client/developer-modules*
git commit -m "feat(developer): add verified self service admission"
```

### Task 4: Create the independent Admin application

**Files:**
- Create: `apps/admin/package.json`
- Create: `apps/admin/tsconfig.json`
- Create: `apps/admin/next.config.ts`
- Create: `apps/admin/src/app/layout.tsx`
- Create: `apps/admin/src/app/page.tsx`
- Create: `apps/admin/src/middleware.ts`
- Create: `apps/admin/src/lib/api-client.ts`
- Create: `apps/admin/src/lib/admin-session.ts`
- Create: `apps/admin/src/app/admin-surface.test.tsx`
- Move during implementation: `apps/web/src/app/admin/**` to `apps/admin/src/app/**`
- Move during implementation: `apps/web/src/components/admin/**` to `apps/admin/src/components/admin/**`
- Move during implementation: `apps/web/src/hooks/admin/**` to `apps/admin/src/hooks/admin/**`
- Move only Admin review UI: `apps/web/src/features/developer-center/admin/**` to `apps/admin/src/features/developer-center/**`

**Interfaces:**
- `AdminSession = { userId: string; permissions: string[]; stepUpExpiresAt: string|null }`.
- Admin API base comes from `OPENOPC_ADMIN_API_URL`, falling back to `KORTIX_API_URL`.
- The application serves operator routes at `/`; it does not mount a consumer `/admin` subtree.

- [ ] **Step 1: Write failing independent-build tests**

Assert the Admin package has its own `next build`, contains all current Admin routes, imports no `apps/web/src/app` page, refuses consumer `/projects` and `/developer` routes, and forwards only host-only Admin session cookies.

- [ ] **Step 2: Run RED**

Run: `pnpm.cmd --filter @kortix/admin test`

Expected: filter/package failure because `apps/admin` does not exist.

- [ ] **Step 3: Create the app and relocate Admin-only code**

Use internal package name `@kortix/admin` and user-facing metadata `OpenOPC Admin`. Its scripts are `"test": "bun test"`, `"typecheck": "tsc --noEmit"`, `"build": "next build"`, and `"start": "next start"`. Preserve typed API calls and shared design tokens through workspace dependencies. Remove Web-relative aliases from relocated files. Do not duplicate Admin pages in Web.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/admin test
pnpm.cmd --filter @kortix/admin typecheck
pnpm.cmd --filter @kortix/admin build
```

Expected: all commands exit `0` and produce a standalone Admin build without Web output.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/admin apps/web/src/app/admin apps/web/src/components/admin apps/web/src/hooks/admin apps/web/src/features/developer-center/admin pnpm-lock.yaml
git commit -m "feat(admin): split independent operator application"
```

### Task 5: Enforce Admin host isolation, step-up, and cross-tenant audit

**Files:**
- Create: `apps/admin/src/middleware.test.ts`
- Modify: `apps/admin/src/middleware.ts`
- Create: `apps/api/src/admin/admin-authorization.ts`
- Create: `apps/api/src/admin/admin-authorization.test.ts`
- Modify: relevant handlers under `apps/api/src/admin/*`
- Create: `apps/web/src/middleware.admin-isolation.test.ts`
- Modify: `apps/web/src/middleware.ts`
- Modify: deployment Nginx templates in the evidence plan, not in this task.

**Interfaces:**

```ts
export interface AdminDecisionContext {
  actorUserId: string; permission: string; scope: { kind: 'platform' } | { kind: 'account'; accountId: string };
  reason?: string; stepUpAt?: string;
}
export async function authorizeAdminDecision(c: Context, requirement: {
  permission: string; stepUp: boolean; crossTenantAudit: boolean;
}): Promise<AdminDecisionContext>;
```

- [ ] **Step 1: Write failing isolation and authority tests**

Test Web 404 for `/admin`, `/_next/static/chunks/admin-*`, and Admin-only asset prefixes; Admin 404 for consumer routes; missing exact permission; expired step-up; cross-tenant access without reason; successful cross-tenant read creating immutable audit with target and decision but no secret values.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/admin/admin-authorization.test.ts
cd ../web; bun test src/middleware.admin-isolation.test.ts
cd ../admin; bun test src/middleware.test.ts
```

Expected: FAIL because the shared authority helper and explicit host rejection are absent.

- [ ] **Step 3: Implement fail-closed middleware and authorization**

Web must return `new NextResponse(null, { status: 404 })` before authentication work for every Admin prefix. Admin must reject hosts not in `OPENOPC_ADMIN_ALLOWED_HOSTS`, then require authenticated Admin session. `authorizeAdminDecision()` must call existing IAM and audit ports and return opaque 404 for out-of-scope tenant targets.

- [ ] **Step 4: Run GREEN**

Run the three RED commands again.

Expected: PASS with explicit 404, 401/403, step-up, and audit assertions.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/admin/src/middleware* apps/api/src/admin apps/web/src/middleware*
git commit -m "feat(admin): enforce isolated authority boundary"
```

### Task 6: Centralize OpenOPC visible branding with legacy compatibility

**Files:**
- Create: `packages/product-brand/package.json`
- Create: `packages/product-brand/src/index.ts`
- Create: `packages/product-brand/src/index.test.ts`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/admin/src/app/layout.tsx`
- Modify: visible email/onboarding/support copy found by the brand audit.
- Modify: `apps/desktop-electron/electron-builder.yml`
- Modify: `apps/desktop-electron/package.json`
- Modify: `apps/desktop-electron/src/main.js`
- Modify: `apps/desktop-electron/assets/splash.html`
- Modify: `apps/desktop-electron/src/app-policy.test.js`

**Interfaces:**

```ts
export const PRODUCT_BRAND = {
  displayName: 'OpenOPC', desktopName: 'OpenOPC Desktop', localNodeName: 'OpenOPC Local Execution',
} as const;
export function openOpcEnv(name: string, legacyName: string, env = process.env): string | undefined;
```

- [ ] **Step 1: Write failing brand/compatibility tests**

Assert visible metadata and packaging use OpenOPC; `productName` is `OpenOPC`; installers and shortcuts include OpenOPC; no visible `Edge Agent`; `OPENOPC_*` wins; legacy fallback works; `appId`, `KortixDesktop`, `kortix://`, OAuth callback handling, internal package names, and `/v1` are unchanged.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd packages/product-brand; bun test
cd ../../apps/desktop-electron; node --test src/app-policy.test.js src/window-chrome.test.js src/update-channel.test.js
```

Expected: FAIL because the package is absent and Desktop still displays Kortix.

- [ ] **Step 3: Apply the visible-brand facade**

Set `productName: OpenOPC`, product descriptions, title/menu/splash/update display, and local node label. Keep `appId: com.kortix.desktop`, protocol name/scheme, user agent, and callbacks for compatibility. Use the shared brand package in Web/Admin metadata; do not mass-rename source identifiers.

- [ ] **Step 4: Run GREEN and a literal compatibility audit**

Run:

```powershell
cd packages/product-brand; bun test
cd ../../apps/desktop-electron; node --test src/app-policy.test.js src/window-chrome.test.js src/update-channel.test.js
rg -n "Edge Agent|productName: Kortix|<title>Kortix" apps/web apps/admin apps/desktop-electron
rg -n "KortixDesktop|kortix://|com\.kortix\.desktop" apps/web apps/desktop-electron
```

Expected: tests pass; first audit has no user-visible matches; second audit proves all compatibility identifiers remain.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/product-brand apps/web apps/admin apps/desktop-electron pnpm-lock.yaml
git commit -m "feat(brand): present OpenOPC without breaking Kortix contracts"
```

### Task 7: Implement the Workspace-first three-column Web workbench

**Files:**
- Create: `apps/web/src/features/layout/primary-rail.tsx`
- Create: `apps/web/src/features/layout/contextual-rail.tsx`
- Create: `apps/web/src/features/layout/workbench-shell.tsx`
- Create: `apps/web/src/features/layout/workbench-shell.test.tsx`
- Create: `apps/web/src/features/search/openopc-search.tsx`
- Create: `apps/web/src/features/search/openopc-search.test.tsx`
- Modify: `apps/web/package.json`
- Modify: authenticated layouts under `apps/web/src/app/(app)/**/layout.tsx`
- Reuse: `apps/web/src/features/workspace/project-sidebar/*`
- Reuse: `apps/web/src/components/ui/page-search-bar.tsx`

**Interfaces:**
- `PrimaryDestination = 'home'|'workspaces'|'agents'|'tasks'|'modules'|'developer'|'account'`.
- `OpenOpcSearchResult = { kind: 'task'|'agent'|'module'|'project'|'file'; id: string; title: string; href: string }`.

- [ ] **Step 1: Write failing shell and search tests**

Assert exactly one primary rail, zero/one contextual rail depending on destination, one main landmark, persistent task/Agent/execution context, predictable navigation, remote-only behavior, and search grouping across the five required kinds. At mobile Web width, assert primary navigation becomes a compact drawer without removing remote actions.

- [ ] **Step 2: Run RED**

Run: `cd apps/web; bun test src/features/layout/workbench-shell.test.tsx src/features/search/openopc-search.test.tsx`

Expected: FAIL because the shell and unified search are absent.

- [ ] **Step 3: Implement the restrained shared shell**

Use existing Tailwind tokens, Lucide icons, stable neutral surfaces, small radii, and restrained shadows. Keep existing project/session state components as contextual content. Add `"typecheck": "tsc --noEmit"` to the Web package scripts so every later focused plan uses one stable command. Do not add gradients, marketing heroes, nested card grids, or modal-only primary workflows.

- [ ] **Step 4: Run GREEN**

Run the RED command, then `pnpm.cmd --filter Kortix-Computer-Frontend build`.

Expected: tests and Web build pass.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/web/src/features/layout apps/web/src/features/search apps/web/src/app/'(app)' apps/web/package.json
git commit -m "feat(web): add workspace first OpenOPC workbench"
```

### Task 8: Enforce bounded Desktop local full-access grants

**Files:**
- Modify: `apps/desktop-electron/src/app-policy.js`
- Modify: `apps/desktop-electron/src/app-policy.test.js`
- Create: `apps/desktop-electron/src/local-grants.js`
- Create: `apps/desktop-electron/src/local-grants.test.js`
- Modify: `apps/desktop-electron/src/main.js`
- Modify: `apps/desktop-electron/src/preload.js`
- Create: `apps/web/src/features/desktop/local-access-panel.tsx`
- Create: `apps/web/src/features/desktop/local-access-panel.test.tsx`

**Interfaces:**

```ts
export type LocalGrantCapability = 'filesystem'|'app_connector'|'desktop_automation'|'local_execution'|'full_access';
export interface LocalGrant {
  grantId: string; capability: LocalGrantCapability; roots: string[]; issuedAt: string; expiresAt: string;
  commandDigest: `sha256:${string}`; approvedLocally: true;
}
```

- [ ] **Step 1: Write failing local-authority tests**

Assert cloud messages cannot create/expand grants; full access requires an Electron-native confirmation; expired, replayed, wrong-device, wrong-user, broadened-root, invalid-signature, and background-only commands fail closed; visible state and append-only local audit exist; Web remains functional when IPC is absent.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/desktop-electron; node --test src/app-policy.test.js src/local-grants.test.js
cd ../web; bun test src/features/desktop/local-access-panel.test.tsx
```

Expected: FAIL because bounded grant storage/verification is absent.

- [ ] **Step 3: Implement local grant validation and OS keychain storage**

Verify signed commands against the paired device public key, bind user/device/nonce/capability/roots/expiry, cap expiry at one hour for `full_access`, consume nonces before execution, and store secrets through Windows Credential Manager/keychain adapters. Expose only `requestLocalGrant`, `listLocalGrants`, and `revokeLocalGrant` through preload; never expose arbitrary IPC or filesystem primitives.

- [ ] **Step 4: Run GREEN**

Run the RED commands again.

Expected: PASS and the Web component shows a remote-only state without an exception when Desktop IPC is missing.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/desktop-electron apps/web/src/features/desktop
git commit -m "feat(desktop): add locally approved bounded grants"
```

### Task 9: Close B1, B2, B3, G11, and B9 foundation workflows

**Files:**
- Create: `apps/web/scripts/e2e/public-beta-foundation-smoke.ts`
- Create: `apps/web/scripts/e2e/public-beta-foundation-smoke.test.ts`
- Modify: `apps/web/package.json`
- Evidence records are produced only by the evidence plan tooling.

**Interfaces:**
- Named modes: `registration`, `web-independence`, `admin-isolation`, `responsive-web`, `packaged-desktop`, `brand-compatibility`.
- Output: one JSONL event per assertion plus screenshots/traces; secrets and raw email tokens are redacted.

- [ ] **Step 1: Write failing smoke-runner contract tests**

Assert each mode requires an explicit base URL, commit, and environment; rejects localhost for staging; captures console errors and blank-canvas detection; rejects Desktop bridge globals in `web-independence`; and emits artifact digests.

- [ ] **Step 2: Run RED**

Run: `cd apps/web; bun test scripts/e2e/public-beta-foundation-smoke.test.ts`

Expected: FAIL because the runner is absent.

- [ ] **Step 3: Implement the named smoke modes**

Add package script `test:e2e:public-beta-foundation`. Reuse the existing developer-center smoke conventions, but require real staging dependencies for evidence mode. Registration uses a controlled email inbox adapter; Admin uses its own hostname; packaged Desktop launches the built installer/app and asserts preserved `kortix://` login plus OpenOPC display.

- [ ] **Step 4: Run focused local contract gates**

Run:

```powershell
cd apps/web; bun test scripts/e2e/public-beta-foundation-smoke.test.ts src/features/layout/workbench-shell.test.tsx
pnpm.cmd --filter @kortix/admin build
pnpm.cmd --filter Kortix-Computer-Frontend build
pnpm.cmd --filter @kortix/desktop-electron test
git diff --check
```

Expected: all local contract gates pass. Real B1/B2/B3/G11/B9 staging lanes remain required before readiness.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/web/scripts/e2e apps/web/package.json
git commit -m "test(beta): add foundation surface acceptance runner"
```

## Foundation Completion Gate

- Registration is fail closed under every dependency failure and stores exact policy versions.
- Export, deletion, abuse, security, and module-reporting paths are authenticated and tenant-safe.
- Self-service and invitation lead to the same verified developer authority.
- Admin builds/deploys independently and Web 404s every Admin surface.
- Web completes remote workflows without Desktop.
- Desktop packaging displays OpenOPC while compatibility IDs and callbacks stay intact.
- Full-access grants cannot be remotely broadened.
- B1, B2, B3, G11, and B9 have real staging/packaged evidence from their canonical lanes.
