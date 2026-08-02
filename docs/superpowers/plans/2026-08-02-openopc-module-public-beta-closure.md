# OpenOPC Module Public-Beta Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a platform administrator review their own Publisher releases and let ordinary project users open active reviewed `sandboxed-web` modules in OpenOPC Web and Windows Desktop through an immutable platform URL and the existing AI/payment service bridge.

**Architecture:** Add one fail-closed module-app host configuration, one server-authoritative launch resolver, and one default release-origin path beside the existing optional custom-domain path. The public SDK owns the launch transport; Web consumes the descriptor, mounts the isolated iframe, and wires the existing bridge to the exact origin/window; Desktop remains a strict shell around the same Web route.

**Tech Stack:** TypeScript, Bun test, Hono/OpenAPI, Drizzle/PostgreSQL, `@kortix/registry`, `@kortix/sdk`, Next.js 15/React 19, TanStack Query, Electron, Cloudflare Worker JavaScript, GitHub Actions.

**Approved design:** `docs/superpowers/specs/2026-08-02-openopc-module-public-beta-closure-design.md`

## Global Constraints

- Preserve automated trust validation, manifest/capability checks, signing, publication transitions, audit history, revocation behavior, and project/account isolation.
- A platform administrator may review, sign, publish, or revoke a release even when they created it or belong to its Publisher. A Publisher member without platform-administrator authority remains denied.
- The only launch profile in this slice is schema-v3 `sandboxed-web`; other module types remain valid but return `PROJECT_MODULE_NOT_LAUNCHABLE`.
- The platform URL is always `https://r-<canonical-release-uuid>.<OPENOPC_MODULE_APP_BASE_DOMAIN>/`; clients never construct it and custom domains never replace it.
- `OPENOPC_MODULE_APP_BASE_DOMAIN` is a hostname only. Reject schemes, ports, paths, queries, fragments, credentials, wildcards, trailing dots, uppercase/non-canonical input, IP literals, empty labels, and one-label names.
- Custom domains remain optional aliases. Platform launch and platform static hosting must work when Cloudflare Custom Hostnames configuration is absent.
- Iframes use exactly `sandbox="allow-scripts allow-forms allow-same-origin"` and the descriptor URL. Do not grant top navigation, popups, downloads, provider credentials, or host DOM access.
- Every bridge listener binds the exact descriptor origin and exact iframe `contentWindow`, requests one declared operation per token, re-resolves current installation identity, and is removed on iframe/release/route/component change.
- Modules never receive NewAPI, Z-Pay, Alipay, WeChat, signing, Cloudflare, or internal-service credentials. AI and payment access remains server-enforced through existing OpenOPC capability APIs.
- No database migration, reviewer account, fixed module category, second module runtime, second AI/payment gateway, or structured bridge-error protocol is added.
- No Docker integration test is required. Do not weaken, skip, ignore, delete, or globally extend tests to obtain green.
- Focused runs must record actual pass/fail counts. A test must be observed RED before implementation and GREEN afterward.
- SDK changes are additive: do not rename/remove exports, edit `packages/sdk/package.json` version, or accept public-surface snapshot removals. Read `packages/sdk/AGENTS.md` and `packages/sdk/PROGRESS.md`, claim the SDK task, and run typecheck, full tests, and `smoke:install`.
- Web work follows `.claude/skills/kortix-design-system/SKILL.md`, existing project-module primitives, semantic tokens, `Loading`, `Button`, `Badge`, and lucide icons. Do not introduce decorative cards or nested cards.
- Preserve the protected untracked file `docs/superpowers/plans/2026-08-01-openopc-developer-sdk-newapi-zpay.md`: do not read, modify, stage, delete, clean, or include it in any command.
- Stage only the explicit paths listed in each task. Never run `git add .` or `git add -A`.
- Stop before deployment, live DNS/certificate changes, secrets, live provider/payment calls, Desktop signing/build distribution, package publication, Git push, PR creation, merge, or release.

## File Structure

### New Files

- `apps/api/src/module-domains/platform-host-config.ts`: canonical module base-domain parsing, immutable release URL generation, and module-host readiness.
- `apps/api/src/module-domains/platform-host-config.test.ts`: canonical/invalid host configuration and readiness coverage.
- `apps/api/src/module-domains/launch.ts`: launch candidate contract, bounded errors, validation, stale-state fence, and descriptor generation.
- `apps/api/src/module-domains/launch.test.ts`: launch service behavior without a database.
- `apps/api/src/module-domains/launch.drizzle.ts`: account/project/installation-scoped launch candidate and current-state queries.
- `apps/api/src/module-domains/launch.drizzle.test.ts`: Drizzle query mapping and isolation tests.
- `apps/api/src/module-domains/static-release-reader.ts`: shared bounded artifact/digest/package/entry/content-type reader.
- `apps/api/src/module-domains/static-release-reader.test.ts`: shared static-reader corruption, path, size, and manifest tests.
- `apps/api/src/module-domains/host.drizzle.test.ts`: binding-free platform-release query mapping, trust-state, and isolation tests.
- `apps/web/src/features/project-modules/project-module-host.ts`: production bridge adapter from launch descriptor plus signed manifest to the existing `ModuleServiceBridge`.
- `apps/web/src/features/project-modules/project-module-host.test.ts`: one-operation issuance, current-state recheck, exact source/origin, and cleanup coverage.
- `apps/web/src/features/project-modules/project-module-host-page.tsx`: launch loading/unavailable/ready UI and iframe lifecycle.
- `apps/web/src/features/project-modules/project-module-host-page.test.tsx`: host view, iframe sandbox, version, unavailable, and reload rendering tests.
- `apps/web/src/app/(app)/projects/[id]/modules/[installationId]/page.tsx`: production project route for one installation.

### Modified Files

- Review policy: `apps/api/src/developer/publishers.ts`, `publishers.test.ts`, `reviews.ts`, `reviews.test.ts`, `distribution.ts`, `distribution.test.ts`, and constructor fixtures that instantiate either service.
- API configuration/composition: `apps/api/src/config.ts`, `apps/api/src/index.ts`, `apps/api/src/developer/index.ts`.
- Project route: `apps/api/src/projects/routes/developer-modules.ts`, `developer-modules.registration.ts`, `apps/api/src/projects/developer-modules-routes.test.ts`, `tests/spec/routes.generated.json`.
- Static hosting: `apps/api/src/module-domains/host.ts`, `host.test.ts`, `host.drizzle.ts`.
- Edge routing: `infra/cloudflare/workers/module-custom-hostnames/worker.mjs`, `worker.test.mjs`, `wrangler.toml`, `README.md`.
- SDK: `packages/sdk/src/core/rest/projects-client/project-modules.ts`, `project-modules.test.ts`, `packages/sdk/src/core/client/kortix.ts`, `kortix.test.ts`, both public-surface snapshots, `packages/sdk/README.md`, `packages/sdk/PROGRESS.md`.
- Web list/query: `apps/web/src/features/project-modules/client.ts`, `query.ts`, `query.test.ts`, `project-modules-page.tsx`, `project-modules-page.test.tsx`, `module-service-bridge.test.ts`.
- Desktop: `apps/desktop-electron/src/app-policy.js`, `app-policy.test.js`, `main.js`, `main-startup.test.js`, `apps/desktop-electron/package.json`, `README.md`, `.github/workflows/desktop.yml`, `deploy-prod.yml`, `ci.yml`.

---

### Task 1: Remove the Independent-Reviewer Gate Without Weakening Platform Authorization

**Files:**
- Modify: `apps/api/src/developer/publishers.ts`
- Modify: `apps/api/src/developer/publishers.test.ts`
- Modify: `apps/api/src/developer/reviews.ts`
- Modify: `apps/api/src/developer/reviews.test.ts`
- Modify: `apps/api/src/developer/distribution.ts`
- Modify: `apps/api/src/developer/distribution.test.ts`
- Modify: `apps/api/src/developer/installations.test.ts`
- Modify: `apps/api/src/developer/index.test.ts`
- Modify: `apps/api/src/admin/developer-reviews.test.ts`
- Modify: `apps/api/src/admin/developer-distribution.test.ts`

**Interfaces:**
- Preserve: `DeveloperPublisherService.requirePermission(publisherId, actor, 'platform_review'): Promise<DeveloperPublisherAuthority>`.
- Change: `DeveloperModuleReviewService` requires `permissions: DeveloperPublisherPermissionPort`; approval/revocation always calls `requirePermission(..., { platformAdmin: true }, 'platform_review')`.
- Change: `DeveloperModuleDistributionService` requires the same permission port for sign/publish/revoke transitions.
- Preserve: review transition audit fields `actor_user_id`, Publisher/release identity, action/verdict, reason, evidence, and timestamp.

- [ ] **Step 1: Replace the Publisher permission expectation with a failing self-review policy test**

```ts
test('allows a platform administrator to review their own Publisher and denies a non-admin member', async () => {
  const { service } = harness();

  await expect(
    service.requirePermission(
      'acme',
      actor(OWNER_ID, { platformAdmin: true }),
      'platform_review',
    ),
  ).resolves.toMatchObject({
    member: expect.objectContaining({ user_id: OWNER_ID, role: 'owner' }),
  });

  await expect(
    service.requirePermission('acme', actor(OWNER_ID), 'platform_review'),
  ).rejects.toMatchObject({
    code: 'DEVELOPER_PUBLISHER_FORBIDDEN',
    status: 403,
  });
});
```

- [ ] **Step 2: Run the one Publisher test and observe RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/publishers.test.ts -t "allows a platform administrator"
```

Expected: `1 fail`; the platform-admin Publisher owner is rejected with `DEVELOPER_SEGREGATION_OF_DUTIES_REQUIRED`.

- [ ] **Step 3: Make `platform_review` depend only on verified/suspended state plus platform-admin authority**

```ts
if (permission === 'platform_review') {
  if (!actor.platformAdmin) fail('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
  return authority;
}
```

Do not change the verified-organization or suspended-Publisher checks immediately above this block.

- [ ] **Step 4: Re-run the Publisher test and observe GREEN**

Run the Step 2 command again.

Expected: `1 pass, 0 fail`.

- [ ] **Step 5: Add mandatory-port RED tests and member self-review regression tests**

Add a reusable permissive test port:

```ts
const platformPermissions: DeveloperPublisherPermissionPort = {
  async requirePermission(_publisherId, actor, permission) {
    if (permission === 'platform_review' && actor.platformAdmin) {
      return {} as DeveloperPublisherAuthority;
    }
    throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
  },
};
```

Add assertions that:

```ts
const approved = await service.decide({
  releaseId: RELEASE_ID,
  actorUserId: CREATOR_ID,
  decision: 'approve',
  expectedStatus: 'review_pending',
  expectedRevision: 1,
  evidence: completeEvidence(),
});

expect(approved.release.status).toBe('approved');
expect(approved.event).toMatchObject({
  actor_user_id: CREATOR_ID,
  action: 'approve',
});
expect(approved.event.evidence).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ method: 'manual', outcome: 'passed' }),
    expect.objectContaining({ method: 'automatic', outcome: 'passed' }),
  ]),
);
```

For distribution, use a Publisher-member platform administrator to sign then publish, and assert the signed release still contains the Ed25519 signature metadata before it reaches `published`.

Add one constructor invariant test for each service:

```ts
expect(
  () =>
    new DeveloperModuleReviewService({
      repository,
      permissions: undefined as never,
    }),
).toThrow('DEVELOPER_PUBLISHER_PERMISSION_PORT_REQUIRED');
```

Use the equivalent assertion for `DeveloperModuleDistributionService`. These are the RED tests for deleting the optional fallback; the Publisher-member behavior is a regression test that should already be GREEN after Step 3.

- [ ] **Step 6: Observe mandatory-port RED and self-review regression GREEN**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/reviews.test.ts -t "Publisher-member platform administrator"
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/distribution.test.ts -t "Publisher-member platform administrator"
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/reviews.test.ts -t "requires the publisher permission port"
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/distribution.test.ts -t "requires the publisher permission port"
```

Expected: both Publisher-member regression tests pass after Step 3; both constructor-invariant tests fail because the current services still accept an absent permission port.

- [ ] **Step 7: Require the permission port and delete both membership fallbacks**

Review service constructor:

```ts
constructor(
  private readonly input: {
    repository: DeveloperModuleReviewRepository;
    distributionRepository?: Pick<DeveloperModuleDistributionRepository, 'history'>;
    trustGate?: Pick<DeveloperModuleTrustGate, 'evaluate'>;
    permissions: DeveloperPublisherPermissionPort;
    now?: () => Date;
  },
) {
  if (!input.permissions) {
    throw new Error('DEVELOPER_PUBLISHER_PERMISSION_PORT_REQUIRED');
  }
  this.now = input.now ?? (() => new Date());
}
```

Approval authorization:

```ts
await this.input.permissions.requirePermission(
  release.publisher_id,
  {
    accountId: release.account_id,
    userId: input.actorUserId,
    platformAdmin: true,
  },
  'platform_review',
);
```

Give the distribution constructor the same required property and runtime invariant. Distribution authorization uses the same permission call. Remove the branches that call `isPublisherAccountMember` or compare `release.created_by` solely to reject the acting administrator. Update every test/service construction path with an explicit denying or permitting permission stub, including every distribution fixture in `installations.test.ts`. Production already supplies `developerPublisherService`.

- [ ] **Step 8: Prove trust, signing, audit, and ordinary-member denial remain intact**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/publishers.test.ts src/developer/reviews.test.ts src/developer/distribution.test.ts src/developer/installations.test.ts src/developer/release-lifecycle.test.ts src/admin/developer-reviews.test.ts src/admin/developer-distribution.test.ts
```

Expected: all listed files pass; record the actual tests/files/assertions count. Confirm tests still cover incomplete automatic evidence, missing signer, invalid signature, non-admin authorization, suspended Publisher, review history, and release lifecycle ordering.

- [ ] **Step 9: Commit only the review-policy files**

```powershell
git add apps/api/src/developer/publishers.ts apps/api/src/developer/publishers.test.ts apps/api/src/developer/reviews.ts apps/api/src/developer/reviews.test.ts apps/api/src/developer/distribution.ts apps/api/src/developer/distribution.test.ts apps/api/src/developer/installations.test.ts apps/api/src/developer/index.test.ts apps/api/src/admin/developer-reviews.test.ts apps/api/src/admin/developer-distribution.test.ts
git commit -m "fix(api): allow platform owner module self-review"
```

---

### Task 2: Add Canonical Module-App Host Configuration and Readiness

**Files:**
- Create: `apps/api/src/module-domains/platform-host-config.ts`
- Create: `apps/api/src/module-domains/platform-host-config.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface ModuleAppHostConfiguration {
  readonly baseDomain: string;
  descriptorForRelease(releaseId: string): {
    url: string;
    origin: string;
  };
}

export function parseModuleAppHostConfiguration(
  value: string | undefined,
): ModuleAppHostConfiguration | null;

export function moduleAppHostReadiness(input: {
  renderingEnabled: boolean;
  configuration: ModuleAppHostConfiguration | null;
  internalServiceKey: string;
}): {
  ready: boolean;
  code: 'PROJECT_MODULE_HOST_UNAVAILABLE' | null;
};

export function combineModuleAppHostReadiness<
  T extends { ready: boolean },
>(
  profile: T,
  host: ReturnType<typeof moduleAppHostReadiness>,
): T & {
  ready: boolean;
  module_app_host_ready: boolean;
};
```

- Configuration key: `config.OPENOPC_MODULE_APP_BASE_DOMAIN`.
- Consumers: Tasks 3, 4, 5, and `/readyz`.

- [ ] **Step 1: Write the failing canonical-domain and release-origin tests**

```ts
test('builds one canonical immutable HTTPS origin per release', () => {
  const config = parseModuleAppHostConfiguration('modules.openopc.example');
  expect(config?.descriptorForRelease(RELEASE_ID)).toEqual({
    url: `https://r-${RELEASE_ID}.modules.openopc.example/`,
    origin: `https://r-${RELEASE_ID}.modules.openopc.example`,
  });
});

test.each([
  '',
  'MODULES.openopc.example',
  'modules.openopc.example.',
  '*.modules.openopc.example',
  'https://modules.openopc.example',
  'modules.openopc.example:443',
  'modules.openopc.example/path',
  'user@modules.openopc.example',
  '127.0.0.1',
  'localhost',
  'modules..openopc.example',
  `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(22)}.example`,
])('rejects a non-canonical module base domain: %s', (value) => {
  expect(parseModuleAppHostConfiguration(value)).toBeNull();
});
```

Also assert uppercase/malformed release UUIDs are rejected and two release IDs produce distinct origins.

- [ ] **Step 2: Run the new config test and observe RED**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/module-domains/platform-host-config.test.ts
```

Expected: module-not-found failure because the parser does not exist.

- [ ] **Step 3: Implement strict parsing and URL construction**

Use a DNS-label regex, a canonical lowercase input check, at least two labels, and a maximum base-domain length of 214 characters. The 214-character ceiling leaves room for the 38-character `r-<uuid>` label plus its dot within the 253-character DNS hostname limit. `descriptorForRelease` must validate a canonical UUID and return the exact URL/origin pair without account, project, credentials, query, or fragment.

```ts
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
```

- [ ] **Step 4: Add and test readiness semantics**

```ts
expect(
  moduleAppHostReadiness({
    renderingEnabled: false,
    configuration: null,
    internalServiceKey: '',
  }),
).toEqual({ ready: true, code: null });

expect(
  moduleAppHostReadiness({
    renderingEnabled: true,
    configuration: null,
    internalServiceKey: 'x'.repeat(32),
  }),
).toEqual({ ready: false, code: 'PROJECT_MODULE_HOST_UNAVAILABLE' });
```

Rendering-enabled readiness also fails when the internal key is shorter than 16 characters.

Test the pure combination separately: a ready release profile plus an unavailable module host produces `ready: false` and `module_app_host_ready: false`; a not-ready release profile remains not ready even when the host is ready; two ready inputs preserve all release-profile identity fields and produce both booleans as `true`.

- [ ] **Step 5: Wire config and `/readyz`**

Add `OPENOPC_MODULE_APP_BASE_DOMAIN: optStr` to `envSchema` and the exported `config` object. In `/readyz`, pass `releaseProfileReadiness(runtime)` and `moduleAppHostReadiness(...)` through `combineModuleAppHostReadiness`; return 200 only when the combined `ready` value is true, otherwise 503. The response includes the bounded `module_app_host_ready` boolean and preserves the existing release-profile identity fields.

```ts
const host = moduleAppHostReadiness({
  renderingEnabled: runtime.allows('module.app.render'),
  configuration: parseModuleAppHostConfiguration(
    config.OPENOPC_MODULE_APP_BASE_DOMAIN,
  ),
  internalServiceKey: config.INTERNAL_SERVICE_KEY,
});
const readiness = combineModuleAppHostReadiness(
  releaseProfileReadiness(runtime),
  host,
);
return c.json(readiness, readiness.ready ? 200 : 503);
```

Do not print the base domain or internal key in the failure response.

- [ ] **Step 6: Run focused tests and API typecheck**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/module-domains/platform-host-config.test.ts src/release-profile/routes.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all focused tests pass and typecheck exits 0; record actual counts.

- [ ] **Step 7: Commit exact configuration paths**

```powershell
git add apps/api/src/module-domains/platform-host-config.ts apps/api/src/module-domains/platform-host-config.test.ts apps/api/src/config.ts apps/api/src/index.ts
git commit -m "feat(api): configure immutable module app origins"
```

---

### Task 3: Resolve a Server-Authoritative Launch Descriptor

**Files:**
- Create: `apps/api/src/module-domains/launch.ts`
- Create: `apps/api/src/module-domains/launch.test.ts`
- Create: `apps/api/src/module-domains/launch.drizzle.ts`
- Create: `apps/api/src/module-domains/launch.drizzle.test.ts`

**Interfaces:**

```ts
export interface ProjectModuleLaunchDescriptor {
  installation_id: string;
  release_id: string;
  install_revision: number;
  module_id: string;
  module_version: string;
  execution_mode: 'sandboxed-web';
  url: string;
  origin: string;
}

export interface ProjectModuleLaunchCandidate {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  installationStatus: 'active' | 'blocked';
  activeReleaseId: string;
  activeVersion: string;
  moduleId: string;
  releaseId: string;
  releaseStatus: string;
  releaseModuleId: string;
  releaseModuleVersion: string;
  manifest: RegistryModuleManifest | null;
  signatureAlgorithm: string | null;
  signatureKeyId: string | null;
  signature: string | null;
  signaturePayloadDigest: string | null;
  signedAt: string | null;
  publishedAt: string | null;
  revokedAt: string | null;
  artifactId: string | null;
  storageKey: string | null;
  artifactDigest: string | null;
  artifactSize: number | null;
}

export interface ProjectModuleLaunchRepository {
  loadCandidate(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<ProjectModuleLaunchCandidate | null>;
  isCurrent(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    releaseId: string;
    installRevision: number;
  }): Promise<boolean>;
}
```

Error codes:

```ts
export type ProjectModuleLaunchErrorCode =
  | 'PROJECT_MODULE_NOT_FOUND'
  | 'PROJECT_MODULE_INACTIVE'
  | 'PROJECT_MODULE_NOT_LAUNCHABLE'
  | 'PROJECT_MODULE_LAUNCH_STALE'
  | 'PROJECT_MODULE_HOST_UNAVAILABLE';
```

- [ ] **Step 1: Write the happy-path descriptor test**

Construct an active, published, signed schema-v3 `sandboxed-web` candidate whose manifest id/version match the installation and whose artifact/signature fields are complete.

```ts
await expect(
  service.resolve({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
  }),
).resolves.toEqual({
  installation_id: INSTALLATION_ID,
  release_id: RELEASE_ID,
  install_revision: 7,
  module_id: 'developer.example.app',
  module_version: '1.0.0',
  execution_mode: 'sandboxed-web',
  url: `https://r-${RELEASE_ID}.modules.openopc.example/`,
  origin: `https://r-${RELEASE_ID}.modules.openopc.example`,
});
```

Assert the serialized descriptor contains neither `ACCOUNT_ID` nor `PROJECT_ID`, `token`, `credential`, query, or fragment.

- [ ] **Step 2: Run the happy-path test and observe RED**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/module-domains/launch.test.ts -t "server-authoritative"
```

Expected: module-not-found failure because the launch service does not exist.

- [ ] **Step 3: Implement the minimal launch service and memory repository**

`ProjectModuleLaunchService.resolve` must:

1. Load only by account, project, and installation.
2. Return 404 when no candidate is visible.
3. Return `PROJECT_MODULE_INACTIVE` for blocked, revoked, deprecated, or unpublished state.
4. Return `PROJECT_MODULE_LAUNCH_STALE` for release/module/version/revision identity mismatch.
5. Return `PROJECT_MODULE_NOT_LAUNCHABLE` for non-v3, non-Web, missing entry, incomplete artifact, or incomplete signature metadata.
6. Return `PROJECT_MODULE_HOST_UNAVAILABLE` when configuration is null.
7. Call `repository.isCurrent` after all validation and URL construction; return stale if the final fence fails.

- [ ] **Step 4: Add one RED/GREEN test at a time for every bounded failure**

Cover:

```ts
[
  ['missing or cross-project installation', 404, 'PROJECT_MODULE_NOT_FOUND'],
  ['blocked installation', 409, 'PROJECT_MODULE_INACTIVE'],
  ['revoked release', 409, 'PROJECT_MODULE_INACTIVE'],
  ['deprecated release', 409, 'PROJECT_MODULE_INACTIVE'],
  ['declarative profile', 409, 'PROJECT_MODULE_NOT_LAUNCHABLE'],
  ['schema-v2 manifest', 409, 'PROJECT_MODULE_NOT_LAUNCHABLE'],
  ['missing artifact metadata', 409, 'PROJECT_MODULE_NOT_LAUNCHABLE'],
  ['missing signature metadata', 409, 'PROJECT_MODULE_NOT_LAUNCHABLE'],
  ['release identity mismatch', 409, 'PROJECT_MODULE_LAUNCH_STALE'],
  ['revision changes at final fence', 409, 'PROJECT_MODULE_LAUNCH_STALE'],
  ['missing host config', 503, 'PROJECT_MODULE_HOST_UNAVAILABLE'],
]
```

Run only the new named case before implementing each branch, then re-run the whole file after every green.

- [ ] **Step 5: Write the failing Drizzle isolation and mapping tests**

Use the existing queued database-fixture style from `installations.drizzle.test.ts`. Assert:

- account/project/installation predicates are all present;
- the release join is against `installation.active_release_id`;
- release, manifest, artifact, and every signature field map into the candidate;
- `isCurrent` requires active installation, exact revision/release, and published non-revoked release;
- a cross-account/project row returns null/false.

- [ ] **Step 6: Implement the two Drizzle queries**

`loadCandidate` may left-join release/artifact so the service can distinguish missing metadata from an invisible installation. `isCurrent` is a separate strict existence query and is the final TOCTOU fence. Do not add a table or migration.

- [ ] **Step 7: Run service/repository tests and API typecheck**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/module-domains/launch.test.ts src/module-domains/launch.drizzle.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all tests pass; record actual counts.

- [ ] **Step 8: Commit only launch resolver files**

```powershell
git add apps/api/src/module-domains/launch.ts apps/api/src/module-domains/launch.test.ts apps/api/src/module-domains/launch.drizzle.ts apps/api/src/module-domains/launch.drizzle.test.ts
git commit -m "feat(api): resolve project module launch descriptors"
```

---

### Task 4: Expose the Authenticated Project Launch Route

**Files:**
- Modify: `apps/api/src/projects/routes/developer-modules.ts`
- Modify: `apps/api/src/projects/routes/developer-modules.registration.ts`
- Modify: `apps/api/src/projects/developer-modules-routes.test.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `tests/spec/routes.generated.json`

**Interfaces:**
- Route: `GET /projects/{projectId}/modules/{installationId}/launch`.
- Authorization: existing `loadProjectForUser(..., 'read')` plus `PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ`.
- Dependency additions:

```ts
launchService: Pick<ProjectModuleLaunchService, 'resolve'>;
runtime: RuntimeReleaseProfile;
```

- Response: exact `ProjectModuleLaunchDescriptor`.

- [ ] **Step 1: Add a failing route test for authorization, scope, and exact output**

```ts
const response = await app.request(
  `/${PROJECT_ID}/modules/${INSTALLATION_ID}/launch`,
);

expect(response.status).toBe(200);
expect(await response.json()).toEqual(LAUNCH_DESCRIPTOR);
expect(calls.loads).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
expect(calls.capabilities).toContainEqual({
  action: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
});
expect(calls.launches).toEqual([
  {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
  },
]);
```

- [ ] **Step 2: Run the route test and observe RED**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/projects/developer-modules-routes.test.ts -t "launch descriptor"
```

Expected: `404` because no launch route is registered.

- [ ] **Step 3: Add the OpenAPI schema and handler**

Use UUID validation for `installationId`. Call `rejectUnavailableCapability(context, 'module.app.render', dependencies.runtime)` after project authorization and before resolution. Map `ProjectModuleLaunchError` to `{ error: code }`; preserve 404 opacity and existing project authorization exceptions.

Declare responses for 200, 403, 404, 409, and 503.

- [ ] **Step 4: Add one route test for each stable error**

Test exact status/body pairs:

```ts
[
  [404, 'PROJECT_MODULE_NOT_FOUND'],
  [409, 'PROJECT_MODULE_INACTIVE'],
  [409, 'PROJECT_MODULE_NOT_LAUNCHABLE'],
  [409, 'PROJECT_MODULE_LAUNCH_STALE'],
  [503, 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE'],
  [503, 'PROJECT_MODULE_HOST_UNAVAILABLE'],
]
```

Also test malformed UUID and a project load returning null.

- [ ] **Step 5: Compose the production service**

In `apps/api/src/developer/index.ts`:

```ts
export const moduleAppHostConfiguration = parseModuleAppHostConfiguration(
  config.OPENOPC_MODULE_APP_BASE_DOMAIN,
);

export const projectModuleLaunchService = new ProjectModuleLaunchService({
  repository: createDrizzleProjectModuleLaunchRepository(db),
  hostConfiguration: moduleAppHostConfiguration,
});
```

Pass `projectModuleLaunchService` and the shared runtime profile from `developer-modules.registration.ts`.

- [ ] **Step 6: Regenerate the route manifest and prove it is stable**

```powershell
pnpm.cmd exec bun run apps/api/scripts/dump-routes.ts
$routeManifestMatches = @(rg -n --no-heading '"/v1/projects/:projectId/modules/:installationId/launch"' tests/spec/routes.generated.json)
if ($routeManifestMatches.Count -ne 1) {
  throw "Expected exactly one launch route, found $($routeManifestMatches.Count)"
}
$routeManifestFirstHash = (Get-FileHash -Algorithm SHA256 -LiteralPath 'tests/spec/routes.generated.json').Hash
pnpm.cmd exec bun run apps/api/scripts/dump-routes.ts
$routeManifestSecondHash = (Get-FileHash -Algorithm SHA256 -LiteralPath 'tests/spec/routes.generated.json').Hash
if ($routeManifestFirstHash -ne $routeManifestSecondHash) {
  throw 'Route manifest changed on the second generation'
}
```

Expected: both hashes are identical and the new GET route appears exactly once. Do not stage the generated result until Step 8.

- [ ] **Step 7: Run focused route/service tests**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/projects/developer-modules-routes.test.ts src/module-domains/launch.test.ts src/module-domains/launch.drizzle.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: all pass; record actual counts.

- [ ] **Step 8: Commit exact route/composition files**

```powershell
git add apps/api/src/projects/routes/developer-modules.ts apps/api/src/projects/routes/developer-modules.registration.ts apps/api/src/projects/developer-modules-routes.test.ts apps/api/src/developer/index.ts tests/spec/routes.generated.json
git commit -m "feat(api): expose project module launch route"
```

---

### Task 5: Share Static Artifact Validation and Add the Default Release Host

**Files:**
- Create: `apps/api/src/module-domains/static-release-reader.ts`
- Create: `apps/api/src/module-domains/static-release-reader.test.ts`
- Modify: `apps/api/src/module-domains/host.ts`
- Modify: `apps/api/src/module-domains/host.test.ts`
- Modify: `apps/api/src/module-domains/host.drizzle.ts`
- Create: `apps/api/src/module-domains/host.drizzle.test.ts`
- Modify: `apps/api/src/developer/index.ts`

**Interfaces:**

```ts
export interface StaticModuleRelease {
  releaseId: string;
  storageKey: string;
  artifactDigest: `sha256:${string}`;
  artifactSize: number;
  entryPath: string;
}

export class StaticModuleReleaseReader {
  constructor(input: {
    artifactStore: Pick<DeveloperArtifactStore, 'readCanonical'>;
  });
  read(release: StaticModuleRelease, path: string): Promise<{
    bytes: Uint8Array;
    contentType: string;
  } | null>;
}

export interface ModulePlatformHostRepository {
  loadPublishedSandboxedWebRelease(input: {
    releaseId: string;
  }): Promise<StaticModuleRelease | null>;
}

export function parseModuleFrameAncestors(
  values: readonly (string | undefined)[],
): readonly string[];
```

- Internal platform paths: `/module-host/platform/releases/:releaseId` and `/module-host/platform/releases/:releaseId/*`.
- Trusted identity header: `X-OpenOPC-Module-Release`.
- Existing custom-domain paths and `X-OpenOPC-Module-Domain-Binding` remain unchanged.
- `ModuleCustomDomainHostRouteDependencies` gains `platformHostService` and `frameAncestors`; both platform and custom-domain responses use the same validated frame policy.

- [ ] **Step 1: Move existing reader behavior behind a failing shared-reader test**

Copy the existing valid package fixture, then assert:

```ts
await expect(reader.read(RELEASE, '/')).resolves.toMatchObject({
  contentType: 'text/html; charset=utf-8',
});
await expect(reader.read(RELEASE, '/dist/app.js')).resolves.toMatchObject({
  contentType: 'text/javascript; charset=utf-8',
});
```

Add individual tests for oversized metadata, digest mismatch, corrupt package, non-Web manifest, entry mismatch, encoded traversal, backslashes, missing file, and canonical read length mismatch.

- [ ] **Step 2: Run the shared-reader test and observe RED**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/module-domains/static-release-reader.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Extract the existing logic without changing custom-domain behavior**

Move bounded reads, digest verification, package parsing, entry/path validation, file selection, and content-type lookup to `StaticModuleReleaseReader`. Keep the 64 MiB bound. Make `ModuleCustomDomainStaticHostService` load binding-specific metadata and delegate to the reader.

- [ ] **Step 4: Add failing default-host route tests**

Test:

```ts
const response = await app.request(
  `/module-host/platform/releases/${RELEASE_ID}/`,
  {
    headers: {
      'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
      'X-OpenOPC-Module-Release': RELEASE_ID,
    },
  },
);

expect(response.status).toBe(200);
expect(await response.text()).toContain('<title>Weather</title>');
expect(response.headers.get('x-content-type-options')).toBe('nosniff');
expect(response.headers.get('referrer-policy')).toBe('no-referrer');
expect(response.headers.get('content-security-policy')).toContain(
  "frame-ancestors https://app.openopc.example",
);
```

Add RED cases for missing/short internal key, forged release header, cross-release header/path mismatch, revoked/unpublished/deprecated release, disabled profile, corrupt/missing artifact, and unavailable service. Static failures expose only `Unauthorized`, capability-unavailable, or `Not Found`.

- [ ] **Step 5: Implement the platform host service and routes**

The route order is:

1. Constant-time internal key validation.
2. `module.app.render` profile gate.
3. Canonical path UUID plus exact release-header equality.
4. Repository load.
5. Shared static reader.
6. Security headers and opaque response.

Generate `frame-ancestors` only from `config.FRONTEND_URL`, parsed as an exact HTTPS origin or loopback HTTP origin during local development. Reject credentials, query, fragment, any pathname other than `/`, and non-loopback HTTP; deduplicate origins; use `frame-ancestors 'none'` when no origin survives. Pass this list into the host router so both custom-domain and platform responses use the same CSP. Keep `connect-src 'self'` so direct provider calls stay blocked.

- [ ] **Step 6: Add the binding-free Drizzle query**

The platform query starts at `developer_module_releases`, joins the artifact, and requires:

- exact release id;
- status `published` and `revoked_at IS NULL`;
- schema-v3 `sandboxed-web` manifest with an entry;
- Ed25519 algorithm, key id, signature, payload digest, signed/published timestamps;
- non-null artifact id, storage key, digest, and positive size.

Do not join `module_custom_domain_bindings` or require a project installation. The current database/deployment is the environment boundary.

- [ ] **Step 7: Decouple service construction from optional custom-domain operator config**

Always create the shared reader and platform host repository/service. Create the custom-domain binding service only when its Cloudflare operator config is valid. Pass both services into the host router; absence of custom-domain configuration must not disable the platform route.

- [ ] **Step 8: Run all static-host tests**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/module-domains/static-release-reader.test.ts src/module-domains/host.test.ts src/module-domains/host.drizzle.test.ts src/module-domains/bindings.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: the new platform cases and all existing custom-domain cases pass; record actual counts.

- [ ] **Step 9: Commit exact static-host files**

```powershell
git add apps/api/src/module-domains/static-release-reader.ts apps/api/src/module-domains/static-release-reader.test.ts apps/api/src/module-domains/host.ts apps/api/src/module-domains/host.test.ts apps/api/src/module-domains/host.drizzle.ts apps/api/src/module-domains/host.drizzle.test.ts apps/api/src/developer/index.ts
git commit -m "feat(api): host immutable module release origins"
```

---

### Task 6: Route Wildcard Release Origins at the Edge

**Files:**
- Modify: `infra/cloudflare/workers/module-custom-hostnames/worker.mjs`
- Modify: `infra/cloudflare/workers/module-custom-hostnames/worker.test.mjs`
- Modify: `infra/cloudflare/workers/module-custom-hostnames/wrangler.toml`
- Modify: `infra/cloudflare/workers/module-custom-hostnames/README.md`

**Interfaces:**
- Worker variables: `OPENOPC_MODULE_APP_BASE_DOMAIN`, `OPENOPC_MODULE_HOST_ORIGIN`.
- Worker secret: `INTERNAL_SERVICE_KEY`.
- Platform hostname: `r-<canonical-release-uuid>.<base-domain>`.
- Platform upstream: `/v1/module-host/platform/releases/<release-id><asset-path>`.
- Trusted header: `X-OpenOPC-Module-Release: <release-id>`.
- Existing custom-hostname resolver path remains available with its existing variables.

- [ ] **Step 1: Add a failing direct-release routing test**

```js
const platformEnv = {
  OPENOPC_MODULE_APP_BASE_DOMAIN: 'modules.openopc.example',
  OPENOPC_MODULE_HOST_ORIGIN: 'https://module-origin.openopc.example',
  INTERNAL_SERVICE_KEY: 'internal-test-key',
};

const response = await worker.fetch(
  new Request(
    `https://r-${RELEASE_ID}.modules.openopc.example/assets/app.js`,
    {
      headers: {
        Authorization: 'Bearer forged',
        'X-OpenOPC-Module-Release': OTHER_RELEASE_ID,
        'X-Kortix-Internal-Key': 'forged',
      },
    },
  ),
  platformEnv,
);

assert.equal(requests.length, 1);
assert.equal(
  requests[0].url,
  `https://module-origin.openopc.example/v1/module-host/platform/releases/${RELEASE_ID}/assets/app.js`,
);
assert.equal(requests[0].headers.get('X-OpenOPC-Module-Release'), RELEASE_ID);
assert.equal(requests[0].headers.get('authorization'), null);
```

- [ ] **Step 2: Run the Worker test and observe RED**

```powershell
node --test infra/cloudflare/workers/module-custom-hostnames/worker.test.mjs
```

Expected: the new test fails because the Worker tries the custom-domain resolver.

- [ ] **Step 3: Split platform and optional custom-hostname configuration**

Implement:

```js
function platformReleaseId(hostname, baseDomain) {
  if (!canonicalBaseDomain(baseDomain)) return null;
  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  if (!label.startsWith('r-')) return null;
  const releaseId = label.slice(2);
  return UUID_RE.test(releaseId) && releaseId === releaseId.toLowerCase()
    ? releaseId
    : null;
}
```

For a platform hostname, do not call `/v1/internal/module-domains/resolve` and do not require Cloudflare Custom Hostnames account, suffix, binding, or API-token configuration. Require only the generic fixed upstream origin, base domain, and internal key.

For any other hostname, preserve the existing active-binding resolver path and its stricter custom-hostname configuration.

- [ ] **Step 4: Add fail-closed platform-host tests**

Cover uppercase/noncanonical UUID, extra labels, a sibling/attacker suffix, base-domain apex, scheme/port/wildcard configuration, forged credential headers, POST body preservation, upstream failure, and HTTPS redirect behavior.

Assert the Worker strips both trusted module identity headers before setting the one appropriate to the chosen path.

- [ ] **Step 5: Update source-controlled operator documentation only**

Document the new generic origin and base-domain variables, the required wildcard route shape, and the later staging verification steps. Explicitly state that this commit does not create DNS records, certificates, Worker secrets, routes, or a deployment.

- [ ] **Step 6: Run Worker tests**

```powershell
node --test infra/cloudflare/workers/module-custom-hostnames/worker.test.mjs
```

Expected: all Worker tests pass; record actual counts.

- [ ] **Step 7: Commit exact Worker paths**

```powershell
git add infra/cloudflare/workers/module-custom-hostnames/worker.mjs infra/cloudflare/workers/module-custom-hostnames/worker.test.mjs infra/cloudflare/workers/module-custom-hostnames/wrangler.toml infra/cloudflare/workers/module-custom-hostnames/README.md
git commit -m "feat(edge): route immutable module release origins"
```

---

### Task 7: Add the SDK-First Launch API

**Files:**
- Modify: `packages/sdk/PROGRESS.md`
- Modify: `packages/sdk/src/core/rest/projects-client/project-modules.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/project-modules.test.ts`
- Modify: `packages/sdk/src/core/client/kortix.ts`
- Modify: `packages/sdk/src/core/client/kortix.test.ts`
- Modify: `packages/sdk/src/public-surface.snapshot.json`
- Modify: `packages/sdk/src/public-type-surface.snapshot.json`
- Modify: `packages/sdk/README.md`

**Interfaces:**

```ts
export interface ProjectModuleLaunchDescriptor {
  installation_id: string;
  release_id: string;
  install_revision: number;
  module_id: string;
  module_version: string;
  execution_mode: 'sandboxed-web';
  url: string;
  origin: string;
}

export async function getProjectModuleLaunch(
  projectId: string,
  installationId: string,
): Promise<ProjectModuleLaunchDescriptor>;
```

Facade:

```ts
kortix.project(projectId).modules.launch(installationId)
```

- [ ] **Step 1: Read and claim the SDK work before editing implementation**

Re-read `packages/sdk/AGENTS.md` and the current tail of `packages/sdk/PROGRESS.md`. Append an `IN PROGRESS` session-log entry that names this plan and the exact additive launch surface. Commit only the tracker:

```powershell
git add packages/sdk/PROGRESS.md
git commit -m "chore(sdk): claim module launch client"
```

- [ ] **Step 2: Add a failing transport test**

```ts
test('project module launch encodes the installation and returns the server descriptor', async () => {
  await getProjectModuleLaunch('project/with space', 'installation/with space');

  expect(calls.at(-1)).toMatchObject({
    url:
      'http://test.local/projects/project%2Fwith%20space/modules/' +
      'installation%2Fwith%20space/launch',
    method: 'GET',
  });
});
```

Update the fetch fixture to return a complete descriptor for this request.

- [ ] **Step 3: Run the SDK transport test and observe RED**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/core/rest/projects-client/project-modules.test.ts -t "project module launch"
```

Expected: missing-export/type failure for `getProjectModuleLaunch`.

- [ ] **Step 4: Implement the additive REST function and stable errors**

Use `backendApi.get`, `unwrap`, `projectPath`, and encoded installation id. Add the launch error codes to `ProjectModuleErrorCode` without removing or renaming existing members:

```ts
| 'PROJECT_MODULE_INACTIVE'
| 'PROJECT_MODULE_NOT_LAUNCHABLE'
| 'PROJECT_MODULE_LAUNCH_STALE'
| 'PROJECT_MODULE_HOST_UNAVAILABLE'
| 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE'
```

- [ ] **Step 5: Add and test the facade binding**

```ts
test('project(id).modules binds the launch descriptor endpoint', async () => {
  await kortix.project('PID123').modules.launch('INSTALL1');
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/PID123/modules/INSTALL1/launch',
    method: 'GET',
  });
});
```

Wire it as:

```ts
launch: (installationId: string) =>
  P.getProjectModuleLaunch(projectId, installationId),
```

- [ ] **Step 6: Deliberately regenerate and review additive public snapshots**

```powershell
$env:UPDATE_SURFACE_SNAPSHOT = '1'
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/public-surface.test.ts
Remove-Item Env:UPDATE_SURFACE_SNAPSHOT
$env:UPDATE_TYPE_SURFACE_SNAPSHOT = '1'
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/public-type-surface.test.ts
Remove-Item Env:UPDATE_TYPE_SURFACE_SNAPSHOT
git diff -- packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json
```

Expected: runtime snapshot adds only `getProjectModuleLaunch`; type snapshot adds only the function and `ProjectModuleLaunchDescriptor`. Any removal or unrelated addition is a hard stop.

- [ ] **Step 7: Document the public method**

Add the `.modules` namespace and a short example to `packages/sdk/README.md`:

```ts
const launch = await kortix
  .project(projectId)
  .modules.launch(installationId);

iframe.src = launch.url;
```

State that the server-issued URL must be used verbatim and that module service credentials are never returned.

- [ ] **Step 8: Run focused and mandatory SDK gates**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/core/rest/projects-client/project-modules.test.ts src/core/client/kortix.test.ts src/public-surface.test.ts src/public-type-surface.test.ts
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk run smoke:install
```

Expected: all pass. Record exact tests, files, assertions, snapshot additions/removals, and smoke-install output.

- [ ] **Step 9: Commit SDK implementation and update the tracker**

First commit the implementation:

```powershell
git add packages/sdk/src/core/rest/projects-client/project-modules.ts packages/sdk/src/core/rest/projects-client/project-modules.test.ts packages/sdk/src/core/client/kortix.ts packages/sdk/src/core/client/kortix.test.ts packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json packages/sdk/README.md
git commit -m "feat(sdk): expose project module launch"
```

Then obtain the actual short SHA with `git rev-parse --short HEAD`, append a completion entry with the real gate counts and `Shippable to production: YES` only if all mandatory SDK gates passed, and commit only the tracker:

```powershell
git add packages/sdk/PROGRESS.md
git commit -m "docs(sdk): record module launch completion"
```

---

### Task 8: Add the Web Open Action, Host Screen, and Production Bridge Wiring

**Files:**
- Create: `apps/web/src/features/project-modules/project-module-host.ts`
- Create: `apps/web/src/features/project-modules/project-module-host.test.ts`
- Create: `apps/web/src/features/project-modules/project-module-host-page.tsx`
- Create: `apps/web/src/features/project-modules/project-module-host-page.test.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/modules/[installationId]/page.tsx`
- Modify: `apps/web/src/features/project-modules/client.ts`
- Modify: `apps/web/src/features/project-modules/query.ts`
- Modify: `apps/web/src/features/project-modules/query.test.ts`
- Modify: `apps/web/src/features/project-modules/project-modules-page.tsx`
- Modify: `apps/web/src/features/project-modules/project-modules-page.test.tsx`
- Modify: `apps/web/src/features/project-modules/module-service-bridge.test.ts`

**Interfaces:**

```ts
export function getProjectModuleLaunchDescriptor(
  projectId: string,
  installationId: string,
): Promise<ProjectModuleLaunchDescriptor>;

export function getPublishedProjectModuleRelease(
  releaseId: string,
): Promise<PublishedProjectModuleRelease>;

export function attachProjectModuleHostBridge(input: {
  eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  moduleSource: Window;
  projectId: string;
  descriptor: ProjectModuleLaunchDescriptor;
  manifest: unknown;
  issueCapability: typeof issueProjectModuleServiceCapability;
  resolveLaunch: () => Promise<ProjectModuleLaunchDescriptor>;
}): () => void;
```

Query key:

```ts
projectModuleKeys.launch(projectId, installationId)
projectModuleKeys.release(releaseId)
```

- [ ] **Step 1: Add a failing installed-list Open action test**

Extend `ProjectModulesViewProps` with `projectId`. Render an active schema-v3 `sandboxed-web` release and assert:

```ts
expect(html).toContain(
  `/projects/${PROJECT_ID}/modules/${INSTALLATION.installation_id}`,
);
expect(html).toContain('Open module');
```

Also assert declarative, blocked, and missing-manifest rows do not render the action.

- [ ] **Step 2: Run the Open-action test and observe RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/project-modules/project-modules-page.test.tsx -t "Open module"
```

Expected: no launch link exists.

- [ ] **Step 3: Add the Open action using existing primitives**

Use `Button asChild`, `Link`, and a lucide launch icon. Derive Web launchability from the signed catalog manifest:

```ts
export function isSandboxedWebModuleManifest(manifest: unknown): boolean {
  return (
    isRecord(manifest) &&
    manifest.schemaVersion === 3 &&
    isRecord(manifest.execution) &&
    manifest.execution.mode === 'sandboxed-web' &&
    typeof manifest.execution.entry === 'string'
  );
}
```

Render the action for read-capable users; opening a module is not a write mutation.

- [ ] **Step 4: Add the SDK-backed launch client and query**

`client.ts` delegates launch transport to `getProjectModuleLaunch` and exact signed-manifest lookup to `getMarketplaceCatalogItem` from `@kortix/sdk`; do not add raw `fetch`. Resolve the detail with catalog id `openopc-module:${releaseId}`, parse it with `asPublishedRelease`, and fail closed unless its `release_id` equals the requested release.

```ts
export const projectModuleLaunchQuery = (
  projectId: string,
  installationId: string,
) => ({
  queryKey: projectModuleKeys.launch(projectId, installationId),
  queryFn: () => getProjectModuleLaunchDescriptor(projectId, installationId),
  staleTime: 0,
  retry: false,
  refetchOnWindowFocus: true,
  refetchInterval: 15_000,
});

export const projectModuleReleaseQuery = (releaseId: string) => ({
  queryKey: projectModuleKeys.release(releaseId),
  queryFn: () => getPublishedProjectModuleRelease(releaseId),
  staleTime: 0,
  retry: false,
});
```

Extend `projectModuleErrorCode` with the five launch/capability codes.

In `query.test.ts`, prove launch uses the SDK launch function and exact release lookup requests `openopc-module:${RELEASE_ID}` rather than scanning `listPublishedProjectModuleReleases`. Also prove a missing or mismatched detail fails closed.

- [ ] **Step 5: Write the failing bridge-adapter integration test**

Use a fake event target and iframe window. Dispatch one valid request and assert:

```ts
expect(issueCalls).toEqual([
  {
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    input: {
      service: 'ai',
      operations: ['models.read'],
    },
  },
]);
expect(resolveCalls).toBe(1);
expect(postedTargetOrigin).toBe(DESCRIPTOR.origin);
```

Then call cleanup, dispatch again, and assert no second issue call. Add cases for catalog manifest mismatch, undeclared operation, changed release/revision, foreign origin, a different window, capability issuance rejected because consent is absent, and capability issuance rejected after consent revocation. Both consent failures must post no token response and must not retry issuance.

- [ ] **Step 6: Implement the bridge adapter**

Convert `moduleServiceDeclarations(manifest)` into the bridge's `declaredServices` map. `issueToken` must send exactly `[input.operation]` and map `expires_at` to `expiresAt`. `resolveCurrentState` calls `resolveLaunch` and returns only project/installation/release/revision identity. Delegate all message validation/rate limits to `attachModuleServiceBridge`.

- [ ] **Step 7: Write the failing host-view tests**

Using `renderToStaticMarkup`, cover:

- loading state with `Loading`;
- ready state with module id/name and exact version;
- iframe `src`, `sandbox`, `referrerPolicy="no-referrer"`, and a stable title;
- no `allow-top-navigation`, `allow-popups`, or `allow-downloads`;
- unavailable copy for every bounded launch code;
- back link to `/projects/{projectId}/modules`;
- visible reload action.

- [ ] **Step 8: Implement the host page and lifecycle**

The route component passes `id` and `installationId` to `ProjectModuleHostPage`.

The client page:

1. Resolves the launch descriptor, then fetches the exact `openopc-module:${descriptor.release_id}` published detail; it never searches the paginated release list for host metadata.
2. Fails bridge declarations closed unless release id/module id/version match the descriptor.
3. Keys the iframe by `${release_id}:${install_revision}`.
4. Captures `iframe.contentWindow` only from the mounted iframe.
5. Attaches the bridge in an effect and returns cleanup.
6. Clears the iframe window and bridge whenever the descriptor/query/route changes.
7. Polls/rechecks so update, rollback, or revocation unmounts the old iframe.
8. Reload re-fetches the descriptor and release metadata rather than reusing the URL.

Use an unframed, full-height project surface; do not put the iframe inside a decorative card.

- [ ] **Step 9: Extend existing bridge regression coverage**

In `module-service-bridge.test.ts`, retain/prove exact origin and exact source checks, one-operation requests, 30-per-minute default, stale update/rollback rejection, failed current-state resolver, consent-denied/revoked issuance rejection, invalid token lifetime, and cleanup. Do not add a structured error response.

- [ ] **Step 10: Run focused Web tests**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/project-modules/project-modules-page.test.tsx src/features/project-modules/query.test.ts src/features/project-modules/module-service-bridge.test.ts src/features/project-modules/project-module-host.test.ts src/features/project-modules/project-module-host-page.test.tsx
```

Expected: all pass; record actual counts.

- [ ] **Step 11: Run Web type/lint checks for changed files**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend typecheck
pnpm.cmd exec biome check apps/web/src/features/project-modules/client.ts apps/web/src/features/project-modules/query.ts apps/web/src/features/project-modules/project-modules-page.tsx apps/web/src/features/project-modules/project-module-host.ts apps/web/src/features/project-modules/project-module-host-page.tsx "apps/web/src/app/(app)/projects/[id]/modules/[installationId]/page.tsx"
```

Expected: no changed-file TypeScript or Biome errors. If the known repository-wide React type mismatch appears, preserve the full output and prove none references a changed file; do not suppress it.

- [ ] **Step 12: Commit exact Web paths**

```powershell
git add apps/web/src/features/project-modules/project-module-host.ts apps/web/src/features/project-modules/project-module-host.test.ts apps/web/src/features/project-modules/project-module-host-page.tsx apps/web/src/features/project-modules/project-module-host-page.test.tsx "apps/web/src/app/(app)/projects/[id]/modules/[installationId]/page.tsx" apps/web/src/features/project-modules/client.ts apps/web/src/features/project-modules/query.ts apps/web/src/features/project-modules/query.test.ts apps/web/src/features/project-modules/project-modules-page.tsx apps/web/src/features/project-modules/project-modules-page.test.tsx apps/web/src/features/project-modules/module-service-bridge.test.ts
git commit -m "feat(web): open installed developer modules"
```

---

### Task 9: Make Packaged Desktop Builds Require an Explicit OpenOPC Web URL

**Files:**
- Modify: `apps/desktop-electron/src/app-policy.js`
- Modify: `apps/desktop-electron/src/app-policy.test.js`
- Modify: `apps/desktop-electron/src/main.js`
- Modify: `apps/desktop-electron/src/main-startup.test.js`
- Modify: `apps/desktop-electron/package.json`
- Modify: `apps/desktop-electron/README.md`
- Modify: `.github/workflows/desktop.yml`
- Modify: `.github/workflows/deploy-prod.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```js
function normalizeOpenOpcDesktopUrl(value, options = {}) {}

function resolveOpenOpcDesktopDefault(input) {
  // input: { env, metadata, isPackaged }
  // packaged: requires metadata.openopcDefaultUrl as HTTPS /projects URL
  // development: permits explicit OpenOPC env or loopback HTTP
}
```

- Package metadata key: `openopcDefaultUrl`.
- Release workflow variable: `OPENOPC_WEB_URL`.
- CI-only non-routable URL: `https://web.openopc.invalid/projects`.

- [ ] **Step 1: Add failing URL-policy tests**

```js
expect(
  normalizeOpenOpcDesktopUrl('https://app.openopc.example/projects'),
).toBe('https://app.openopc.example/projects');

for (const invalid of [
  'https://kortix.com/projects',
  'https://dev.kortix.com/projects',
  'http://app.openopc.example/projects',
  'https://user:secret@app.openopc.example/projects',
  'https://app.openopc.example/',
  'https://app.openopc.example/projects/other',
  'https://app.openopc.example/projects?token=x',
]) {
  expect(normalizeOpenOpcDesktopUrl(invalid)).toBeNull();
}
```

Test that packaged resolution throws when `openopcDefaultUrl` is missing/invalid and ignores `kortixDefaultUrl`, `KORTIX_DESKTOP_DEFAULT_URL`, and `KORTIX_DESKTOP_URL`. Test that unpackaged development explicitly permits `http://localhost:3000/projects`.

With `https://app.openopc.example/projects` configured, also prove authenticated deep links such as `/projects/P1/modules/I1` stay in the Desktop window while both legacy Kortix project origins and sibling/attacker OpenOPC origins are sent to the system browser. Privileged IPC must remain limited to the exact configured origin.

- [ ] **Step 2: Run Desktop policy tests and observe RED**

```powershell
pnpm.cmd --filter @kortix/desktop-electron exec bun test ./src/app-policy.test.js ./src/main-startup.test.js
```

Expected: new functions are missing and legacy fallback expectations fail.

- [ ] **Step 3: Implement fail-closed URL normalization**

Requirements:

- input is a trimmed string;
- no credentials, query, or fragment;
- exact `/projects` pathname;
- HTTPS for packaged/default/override URLs;
- loopback HTTP only when `allowLoopback: true`;
- reject the legacy `kortix.com` and `dev.kortix.com` hosts;
- return a canonical URL without silently changing an invalid input.
- treat only the exact normalized configured origin as the production app origin; do not retain a hard-coded Kortix production-origin fallback in `shouldLoadInApp`.

- [ ] **Step 4: Remove packaged legacy fallbacks from `main.js`**

`bakedDefaultUrl` reads only `metadata.openopcDefaultUrl`. `appBaseUrl` reads only OpenOPC-named env keys during unpackaged development; packaged startup requires the normalized baked metadata value. A packaged app with no valid explicit URL fails before creating/loading the main window.

Remove the Kortix production/dev presets from the Frontend URL menu. Keep reset-to-configured-default, explicit custom HTTPS OpenOPC URL, and loopback local development only when `app.isPackaged === false`.

Validate persisted overrides on read; ignore an invalid old override rather than loading it.

Pass the resolved configured URL to every top-level navigation and privileged-sender check. Preserve preview handling, but remove `kortix.com`/`*.kortix.com` as implicit in-app production hosts; an OpenOPC-configured package may keep product routes in-app only when their origin exactly matches the configured origin.

- [ ] **Step 5: Make workflows distinguish release URLs from CI test URLs**

In `desktop.yml` and `deploy-prod.yml`:

```yaml
env:
  DESKTOP_URL: ${{ vars.OPENOPC_WEB_URL }}
```

Add a shell validation step that requires HTTPS, forbids `.invalid`, and requires the exact `/projects` path before Electron Builder. Bake:

```yaml
--config.extraMetadata.openopcDefaultUrl="$DESKTOP_URL"
```

In `ci.yml`, bake only:

```yaml
--config.extraMetadata.openopcDefaultUrl="https://web.openopc.invalid/projects"
```

The `.invalid` value proves packaging configuration without claiming a reachable public site. Do not build, sign, publish, or distribute an installer in this task.

- [ ] **Step 6: Remove stale package scripts/docs that select Kortix Web**

Keep `dev` on explicit local OpenOPC development. Replace or remove `dev:dev-env` and `dev:prod-env` so no script silently targets `dev.kortix.com` or `kortix.com`. Document `OPENOPC_DESKTOP_URL` for local runs and `OPENOPC_WEB_URL` for release workflows.

- [ ] **Step 7: Add source-policy assertions**

`app-policy.test.js` already reads workflow files. Assert against production source/config files rather than the test fixture itself:

- release workflows use `openopcDefaultUrl` and `vars.OPENOPC_WEB_URL`;
- CI contains the one `.invalid` URL;
- `main.js`, `app-policy.js`, `package.json`, `README.md`, and the three workflows contain no legacy Kortix project origin, `kortixDefaultUrl`, or `KORTIX_DESKTOP_URL` production fallback;
- configured-origin navigation accepts `/projects/{projectId}/modules/{installationId}` only on the exact configured origin and rejects legacy/sibling origins.

- [ ] **Step 8: Run Desktop tests**

```powershell
pnpm.cmd --filter @kortix/desktop-electron test
```

Expected: all Node and Bun Desktop tests pass; record actual counts. Do not invoke `setup`, Electron Builder, code signing, or installer publication.

- [ ] **Step 9: Commit exact Desktop/workflow paths**

```powershell
git add apps/desktop-electron/src/app-policy.js apps/desktop-electron/src/app-policy.test.js apps/desktop-electron/src/main.js apps/desktop-electron/src/main-startup.test.js apps/desktop-electron/package.json apps/desktop-electron/README.md .github/workflows/desktop.yml .github/workflows/deploy-prod.yml .github/workflows/ci.yml
git commit -m "fix(desktop): require explicit OpenOPC web target"
```

---

## Final Verification Gate

- [ ] **Step 1: Re-run all focused closure tests and record actual counts**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/publishers.test.ts src/developer/reviews.test.ts src/developer/distribution.test.ts src/developer/installations.test.ts src/developer/release-lifecycle.test.ts src/projects/developer-modules-routes.test.ts src/module-domains/platform-host-config.test.ts src/module-domains/launch.test.ts src/module-domains/launch.drizzle.test.ts src/module-domains/static-release-reader.test.ts src/module-domains/host.test.ts src/module-domains/host.drizzle.test.ts src/module-domains/bindings.test.ts
node --test infra/cloudflare/workers/module-custom-hostnames/worker.test.mjs
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/core/rest/projects-client/project-modules.test.ts src/core/client/kortix.test.ts src/public-surface.test.ts src/public-type-surface.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/project-modules/project-modules-page.test.tsx src/features/project-modules/query.test.ts src/features/project-modules/module-service-bridge.test.ts src/features/project-modules/project-module-host.test.ts src/features/project-modules/project-module-host-page.test.tsx
pnpm.cmd --filter @kortix/desktop-electron test
```

- [ ] **Step 2: Run broader package gates**

```powershell
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter kortix-api test
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk run smoke:install
pnpm.cmd --filter Kortix-Computer-Frontend typecheck
pnpm.cmd --filter Kortix-Computer-Frontend test
```

Do not treat a zero-test run as green. Preserve exact output for any pre-existing failure and prove whether changed files are implicated.

- [ ] **Step 3: Run static contract/security checks**

```powershell
rg -n --no-heading "allow-top-navigation|allow-popups|allow-downloads" apps/web/src/features/project-modules/project-module-host-page.tsx
rg -n --no-heading "https://kortix.com/projects|https://dev.kortix.com/projects|kortixDefaultUrl|KORTIX_DESKTOP_URL" apps/desktop-electron/src/main.js apps/desktop-electron/src/app-policy.js apps/desktop-electron/package.json apps/desktop-electron/README.md .github/workflows/desktop.yml .github/workflows/deploy-prod.yml .github/workflows/ci.yml
rg -n --no-heading "new-api|z-pay|alipay|wechat|merchant|provider.*key" apps/web/src/features/project-modules/project-module-host.ts apps/web/src/features/project-modules/project-module-host-page.tsx packages/sdk/src/core/rest/projects-client/project-modules.ts
git diff --check
```

Expected: the first three searches produce no matches and `git diff --check` exits 0.

- [ ] **Step 4: Inspect the complete branch diff and protected-file boundary**

```powershell
git diff --stat 36a3152bf30fa129965fe2958a440f3b6301691e..HEAD
git diff --name-status 36a3152bf30fa129965fe2958a440f3b6301691e..HEAD
git status --short --branch
```

Expected: the protected `2026-08-01` plan remains exactly one untracked file and never appears in a commit. No secrets, generated installers, signing artifacts, deployment state, or unrelated files appear.

- [ ] **Step 5: Report honest readiness**

Code can be marked complete only when all focused tests and relevant package gates are green. Report these as still unverified and pending separate authorization:

- wildcard DNS record and certificate;
- Worker/API deployment and real immutable release-origin routing;
- secret/configuration installation;
- one reviewed real `sandboxed-web` module without a custom domain;
- live NewAPI model/list/text/stream calls through the platform gateway;
- controlled Z-Pay flow;
- Desktop rebuild, signing, publication, installation, and public Web URL load;
- Git push, PR, merge, and release.

Do not claim the public beta is ready until those post-deployment checks pass on the same candidate commit.
