# OpenOPC Developer Application and Publisher Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the platform owner discover and decide developer applications, then let an approved developer create and select an account-scoped Publisher for module package submission.

**Architecture:** Extend the existing developer-application service and repositories with an Admin read model, then expose independent Admin list/detail pages using the existing permission and revision-fence boundaries. Reuse the existing `@kortix/sdk` developer-access and Publisher functions in Web; add no second client, no new SDK export, and no database migration.

**Tech Stack:** TypeScript, Bun test, Hono OpenAPI, Drizzle ORM/PostgreSQL, Next.js App Router, React, TanStack Query, Radix Select, lucide-react, `@kortix/sdk`.

## Global Constraints

- Work in the existing linked worktree `E:\code\agentk\suna-studio-platform` on the current branch.
- Never read, modify, stage, delete, or commit `docs/superpowers/plans/2026-08-01-openopc-developer-sdk-newapi-zpay.md`.
- Stage only the exact paths named by each task; never use `git add .` or `git add -A`.
- Use strict TDD: add the focused test, run it and preserve the RED failure, then implement the smallest GREEN change.
- Preserve `developer.application.review`, AAL2 for mutations, revision fencing, stable errors, and immutable audit history.
- Platform-owner self-review is allowed; do not add an independent-reviewer or different-user check.
- Admin application review and module release review remain separate workflows and separate pages.
- Web must call the backend only through existing `@kortix/sdk` functions.
- One active owner Publisher is auto-selected; multiple active owner Publishers require explicit selection; account changes reset selection.
- The public-beta UI exposes Publisher creation and selection for the current owner only. Do not add invitation or member-management UI.
- Do not add deployment, custom-domain, AI, payment, Desktop packaging, or release workflow changes.
- Before visual edits in Admin or Web, read `.claude/skills/kortix-design-system/SKILL.md` and reuse existing UI primitives.
- Do not suppress the known Web `fetch` test-stub type errors in `apps/web/src/lib/api-client.test.ts`; report them separately if the full Web typecheck still reaches that baseline.

## File Map

### API domain and persistence

- Modify `apps/api/src/developer/applications.ts`: Admin read-model types, cursor codec, service methods, and in-memory repository methods.
- Modify `apps/api/src/developer/applications.test.ts`: service, pagination, detail, and self-review tests.
- Modify `apps/api/src/developer/applications.drizzle.ts`: joined Admin list/detail queries.
- Modify `apps/api/src/developer/applications.drizzle.test.ts`: query projection, cursor, ordering, and exact-detail tests.
- Modify `apps/api/src/developer/app.ts`: export the existing organization schema for Admin response reuse.
- Modify `apps/api/src/admin/developer-applications.ts`: list/detail routes and target-aware authorization.
- Modify `apps/api/src/admin/developer-applications.test.ts`: read authorization, response, conflict, and audit tests.

### Independent Admin UI

- Create `apps/admin/src/features/developer-center/applications/client.ts`: stable Admin application transport contract.
- Create `apps/admin/src/features/developer-center/applications/client.test.ts`: exact route, body, reason-header, and stable-error tests.
- Create `apps/admin/src/features/developer-center/applications/query.ts`: account-safe query keys and decision mutations.
- Create `apps/admin/src/features/developer-center/applications/query.test.ts`: query-key, mutation-body, and conflict-refresh tests.
- Create `apps/admin/src/features/developer-center/applications/application-queue-page.tsx`: application queue and pagination UI.
- Create `apps/admin/src/features/developer-center/applications/application-detail-page.tsx`: detail, timeline, and decision UI.
- Create `apps/admin/src/features/developer-center/applications/application-pages.test.tsx`: queue/detail render and action-gating tests.
- Create `apps/admin/src/app/developer-applications/page.tsx`: queue route.
- Create `apps/admin/src/app/developer-applications/[applicationId]/page.tsx`: detail route.
- Modify `apps/admin/src/app/_components/admin-sidebar.tsx`: distinct Developer Applications navigation item.
- Modify `apps/admin/translations/en.json`: navigation label.
- Modify `apps/admin/src/lib/admin-surface.ts`: exact and dynamic Developer Applications route ownership.
- Modify `apps/admin/src/app/admin-surface.test.tsx`: independent route and path-authorization coverage.

### Web Publisher onboarding and submission

- Create `apps/web/src/features/developer-center/publisher/access.ts`: pure selectable-Publisher and account-reset logic.
- Create `apps/web/src/features/developer-center/publisher/access.test.ts`: deterministic selection tests.
- Create `apps/web/src/features/developer-center/publisher/access-query.ts`: existing SDK access/create query hooks.
- Create `apps/web/src/features/developer-center/publisher/access-query.test.ts`: exact SDK delegation and cache invalidation tests.
- Create `apps/web/src/features/developer-center/publisher/publisher-select.tsx`: shared Publisher option control.
- Create `apps/web/src/features/developer-center/publisher/onboarding-panel.tsx`: approved-application Publisher create/select UI.
- Create `apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx`: loading, create, one/multiple selection, and permission tests.
- Modify `apps/web/src/features/developer-center/model.ts`: stable Publisher-creation error codes.
- Modify `apps/web/src/features/developer-center/model.test.ts`: Publisher-creation error extraction tests.
- Modify `apps/web/src/features/developer-center/application/developer-application-page.tsx`: approved-content slot and onboarding integration.
- Modify `apps/web/src/features/developer-center/application/developer-application-page.test.tsx`: approved onboarding render contract.
- Modify `apps/web/src/features/developer-center/publisher/submit-page.tsx`: replace free-form Publisher ID with access-backed selection.
- Modify `apps/web/src/features/developer-center/publisher/submit-page.test.tsx`: selector, empty state, and disabled-action tests.

No `packages/sdk` source or public-surface snapshot changes are expected.

---

### Task 1: Add the Application Admin Read Model and Memory Repository

**Files:**
- Modify: `apps/api/src/developer/applications.ts:15-102,193-315,321-546`
- Modify: `apps/api/src/developer/applications.test.ts:1-265`

**Interfaces:**
- Produces: `DeveloperApplicationAdminListItem`
- Produces: `DeveloperApplicationAdminPage`
- Produces: `DeveloperApplicationAdminDetail`
- Produces: `DeveloperApplicationService.adminList(input)`
- Produces: `DeveloperApplicationService.adminGet({ applicationId })`
- Extends: `DeveloperApplicationRepository.adminList(input)` and `adminGet(applicationId)`

- [ ] **Step 1: Add failing service tests for list, cursor, detail, and self-review**

Add `type DeveloperApplication` to the existing import from `./applications`,
then add this exact helper to seed two organizations and two applications:

```ts
function adminReadHarness() {
  const olderOrganization: DeveloperOrganization = {
    ...invitedOrganization(),
    name: 'Older Studio',
    updated_at: '2026-08-03T07:00:00.000Z',
  };
  const newerOrganization: DeveloperOrganization = {
    ...invitedOrganization(),
    organization_id: '20000000-0000-4000-a000-000000000002',
    account_id: OTHER_ACCOUNT_ID,
    name: 'Newest Studio',
    updated_at: '2026-08-03T08:00:00.000Z',
  };
  const application = (
    applicationId: string,
    accountId: string,
    organizationId: string,
    updatedAt: string,
  ): DeveloperApplication => ({
    application_id: applicationId,
    account_id: accountId,
    organization_id: organizationId,
    state: 'submitted',
    revision: 0,
    policy_versions: POLICIES,
    submitted_at: updatedAt,
    decided_at: null,
    suspended_at: null,
    decision_reason: null,
    created_by: APPLICANT_ID,
    updated_by: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  });
  const repository = createMemoryDeveloperApplicationRepository({
    organizations: [olderOrganization, newerOrganization],
    applications: [
      application(
        '40000000-0000-4000-a000-000000000001',
        ACCOUNT_ID,
        olderOrganization.organization_id,
        '2026-08-03T07:00:00.000Z',
      ),
      application(
        '40000000-0000-4000-a000-000000000002',
        OTHER_ACCOUNT_ID,
        newerOrganization.organization_id,
        '2026-08-03T08:00:00.000Z',
      ),
    ],
  });
  return {
    repository,
    service: new DeveloperApplicationService({
      repository,
      currentPolicyVersions: POLICIES,
      now: () => NOW,
    }),
  };
}
```

Then add these assertions to `applications.test.ts`:

```ts
test('lists the submitted Admin queue with an opaque deterministic cursor', async () => {
  const { service } = adminReadHarness();

  const first = await service.adminList({ state: 'submitted', limit: 1 });
  expect(first.applications).toHaveLength(1);
  expect(first.applications[0]).toEqual({
    application: expect.objectContaining({ state: 'submitted' }),
    organization: expect.objectContaining({ name: 'Newest Studio' }),
  });
  expect(first.next_cursor).toBeString();

  const second = await service.adminList({
    state: 'submitted',
    limit: 1,
    cursor: first.next_cursor,
  });
  expect(second.applications[0]?.organization.name).toBe('Older Studio');
  expect(second.next_cursor).toBeNull();
});

test('assembles one Admin detail with policy acceptance and audit history', async () => {
  const { service } = harness({ organizations: [invitedOrganization()] });
  const submitted = await service.submit({
    actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
    organizationName: 'Acme Studio',
    policyVersions: POLICIES,
  });

  await expect(
    service.adminGet({ applicationId: submitted.application.application_id }),
  ).resolves.toEqual({
    application: submitted.application,
    organization: expect.objectContaining({ name: 'Acme Studio' }),
    policy_acceptances: expect.arrayContaining([
      expect.objectContaining({ policy: 'acceptable_use' }),
      expect.objectContaining({ policy: 'module_rules' }),
    ]),
    history: [expect.objectContaining({ action: 'developer_application.submitted' })],
  });
});

test('allows the submitting platform administrator to approve their own application', async () => {
  const { service } = harness();
  const { application } = await service.submit({
    actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
    organizationName: 'Owner Studio',
    policyVersions: POLICIES,
  });

  await expect(
    service.decide({
      actorUserId: APPLICANT_ID,
      applicationId: application.application_id,
      decision: 'approve',
      expectedRevision: 0,
      reason: 'Platform owner verified the application',
    }),
  ).resolves.toMatchObject({ state: 'approved', revision: 1 });
});
```

Add malformed-cursor and missing-detail expectations:

```ts
await expect(service.adminList({ cursor: 'not-a-valid-cursor' })).rejects.toMatchObject({
  code: 'DEVELOPER_APPLICATION_INPUT_INVALID',
  status: 400,
});
await expect(
  service.adminGet({ applicationId: '90000000-0000-4000-a000-999999999999' }),
).rejects.toMatchObject({ code: 'DEVELOPER_APPLICATION_NOT_FOUND', status: 404 });
```

- [ ] **Step 2: Run the focused service tests and capture RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/applications.test.ts
```

Expected: FAIL because `adminList`, `adminGet`, and the repository Admin methods do not exist.

- [ ] **Step 3: Add exact read-model and repository interfaces**

Add to `applications.ts`:

```ts
export interface DeveloperApplicationAdminListItem {
  application: DeveloperApplication;
  organization: DeveloperOrganization;
}

export interface DeveloperApplicationAdminPage {
  applications: DeveloperApplicationAdminListItem[];
  next_cursor: string | null;
}

export interface DeveloperApplicationAdminDetail extends DeveloperApplicationAdminListItem {
  policy_acceptances: DeveloperApplicationPolicyAcceptance[];
  history: DeveloperApplicationAuditEvent[];
}

export interface DeveloperApplicationAdminCursor {
  updatedAt: string;
  applicationId: string;
}

export interface DeveloperApplicationAdminRepositoryPage {
  applications: DeveloperApplicationAdminListItem[];
  hasMore: boolean;
}
```

Extend `DeveloperApplicationRepository` with:

```ts
adminList(input: {
  state: DeveloperApplicationState;
  limit: number;
  cursor: DeveloperApplicationAdminCursor | null;
}): Promise<DeveloperApplicationAdminRepositoryPage>;
adminGet(applicationId: string): Promise<DeveloperApplicationAdminListItem | null>;
```

- [ ] **Step 4: Implement one strict cursor codec in the service module**

Use a service-owned codec so both repositories receive a parsed cursor:

```ts
function encodeAdminCursor(value: DeveloperApplicationAdminCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeAdminCursor(value: string | null | undefined): DeveloperApplicationAdminCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'applicationId,updatedAt' ||
      typeof (parsed as { updatedAt?: unknown }).updatedAt !== 'string' ||
      !Number.isFinite(Date.parse((parsed as { updatedAt: string }).updatedAt)) ||
      new Date((parsed as { updatedAt: string }).updatedAt).toISOString() !==
        (parsed as { updatedAt: string }).updatedAt ||
      typeof (parsed as { applicationId?: unknown }).applicationId !== 'string' ||
      !UUID_RE.test((parsed as { applicationId: string }).applicationId)
    ) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    return parsed as DeveloperApplicationAdminCursor;
  } catch (error) {
    if (error instanceof DeveloperApplicationError) throw error;
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
}
```

- [ ] **Step 5: Implement service list/detail methods**

Add to `DeveloperApplicationService`:

```ts
async adminList(
  input: { state?: DeveloperApplicationState; limit?: number; cursor?: string | null } = {},
): Promise<DeveloperApplicationAdminPage> {
  const state = input.state ?? 'submitted';
  if (!DEVELOPER_APPLICATION_STATES.includes(state)) {
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  try {
    const page = await this.input.repository.adminList({
      state,
      limit,
      cursor: decodeAdminCursor(input.cursor),
    });
    const last = page.applications.at(-1)?.application;
    return {
      applications: clone(page.applications),
      next_cursor:
        page.hasMore && last
          ? encodeAdminCursor({ updatedAt: last.updated_at, applicationId: last.application_id })
          : null,
    };
  } catch (error) {
    if (error instanceof DeveloperApplicationError) throw error;
    fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
  }
}

async adminGet(input: { applicationId: string }): Promise<DeveloperApplicationAdminDetail> {
  if (!validIdentity(input.applicationId)) {
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
  try {
    const item = await this.input.repository.adminGet(input.applicationId);
    if (!item) fail('DEVELOPER_APPLICATION_NOT_FOUND', 404);
    const [policyAcceptances, history] = await Promise.all([
      this.input.repository.listPolicyAcceptances(
        item.application.account_id,
        item.application.created_by,
      ),
      this.input.repository.getAuditHistory(item.application.application_id),
    ]);
    return {
      ...clone(item),
      policy_acceptances: clone([...policyAcceptances]),
      history: clone([...history]),
    };
  } catch (error) {
    if (error instanceof DeveloperApplicationError) throw error;
    fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
  }
}
```

- [ ] **Step 6: Implement in-memory ordering, filtering, and exact lookup**

Add repository methods that join by `organization_id`, sort by descending
`updated_at` and `application_id`, apply the parsed cursor, request `limit + 1`
semantics in memory, and return `hasMore`:

```ts
async adminList({ state, limit, cursor }) {
  const ordered = [...applications.values()]
    .filter((application) => application.state === state)
    .sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        right.application_id.localeCompare(left.application_id),
    )
    .filter(
      (application) =>
        !cursor ||
        application.updated_at < cursor.updatedAt ||
        (application.updated_at === cursor.updatedAt &&
          application.application_id < cursor.applicationId),
    );
  const page = ordered.slice(0, limit);
  return {
    applications: page.map((application) => {
      const organization = organizations.get(application.organization_id);
      if (!organization || organization.account_id !== application.account_id) {
        throw new Error('DEVELOPER_APPLICATION_ORGANIZATION_INCONSISTENT');
      }
      return {
        application: clone(application),
        organization: clone(organization),
      };
    }),
    hasMore: ordered.length > limit,
  };
},
async adminGet(applicationId) {
  const application = applications.get(applicationId);
  if (!application) return null;
  const organization = organizations.get(application.organization_id);
  if (!organization || organization.account_id !== application.account_id) return null;
  return { application: clone(application), organization: clone(organization) };
},
```

Fail closed if an application references a missing or foreign organization; do
not emit a partial Admin item.

- [ ] **Step 7: Re-run the service tests and verify GREEN**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/applications.test.ts
```

Expected: all tests pass, including malformed cursor, exact detail, and self-review.

- [ ] **Step 8: Commit the domain slice**

```powershell
git add -- apps/api/src/developer/applications.ts apps/api/src/developer/applications.test.ts
git diff --cached --check
git commit -m "feat(api): add developer application admin read model"
```

---

### Task 2: Add Drizzle Admin List and Detail Queries

**Files:**
- Modify: `apps/api/src/developer/applications.drizzle.ts:1-505`
- Modify: `apps/api/src/developer/applications.drizzle.test.ts:1-94`

**Interfaces:**
- Consumes: `DeveloperApplicationRepository.adminList`
- Consumes: `DeveloperApplicationRepository.adminGet`
- Produces: Drizzle-backed joined `DeveloperApplicationAdminListItem` values

- [ ] **Step 1: Add a failing joined-query test**

Extend `applications.drizzle.test.ts` with a nested projection and a query-shaped
fake database:

```ts
const organizationRow = {
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  name: 'Acme Studio',
  verificationState: 'pending' as const,
  verificationMetadata: {},
  verificationRevision: 0,
  verificationChangedBy: null,
  verificationChangedAt: null,
  createdBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

test('lists joined Admin applications with limit-plus-one pagination', async () => {
  const limits: number[] = [];
  const rows = [
    { application: applicationRow, organization: organizationRow },
    {
      application: {
        ...applicationRow,
        applicationId: '40000000-0000-4000-a000-000000000002',
      },
      organization: organizationRow,
    },
  ];
  const database = adminListDatabase(rows, limits);
  const repository = createDrizzleDeveloperApplicationRepository(database);

  await expect(
    repository.adminList({ state: 'submitted', limit: 1, cursor: null }),
  ).resolves.toEqual({
    applications: [
      {
        application: serializeDeveloperApplication(applicationRow),
        organization: expect.objectContaining({ name: 'Acme Studio' }),
      },
    ],
    hasMore: true,
  });
  expect(limits).toEqual([2]);
});
```

Implement the fake as an exact Drizzle chain used by the production method:

```ts
function adminListDatabase(rows: unknown[], limits: number[]): Database {
  return {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where() {
                  return {
                    orderBy() {
                      return {
                        async limit(value: number) {
                          limits.push(value);
                          return rows;
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}
```

Add an `adminGet` test returning the exact serialized pair:

```ts
test('reads one exact joined Admin application', async () => {
  const database = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where() {
                  return {
                    async limit() {
                      return [{ application: applicationRow, organization: organizationRow }];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  const repository = createDrizzleDeveloperApplicationRepository(database);

  await expect(repository.adminGet(APPLICATION_ID)).resolves.toEqual({
    application: serializeDeveloperApplication(applicationRow),
    organization: expect.objectContaining({
      organization_id: ORGANIZATION_ID,
      account_id: ACCOUNT_ID,
      name: 'Acme Studio',
    }),
  });
});
```

Repeat with `limit()` returning `[]` and assert `repository.adminGet(APPLICATION_ID)`
resolves to `null`.

- [ ] **Step 2: Run the Drizzle test and capture RED**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/applications.drizzle.test.ts
```

Expected: FAIL because the Drizzle repository does not implement `adminList` or `adminGet`.

- [ ] **Step 3: Implement the joined list query**

Import `desc`, `lt`, and `or` from `drizzle-orm`, then add:

```ts
async adminList({ state, limit, cursor }) {
  const cursorCondition = cursor
    ? or(
        lt(developerApplications.updatedAt, cursor.updatedAt),
        and(
          eq(developerApplications.updatedAt, cursor.updatedAt),
          lt(developerApplications.applicationId, cursor.applicationId),
        ),
      )
    : undefined;
  const rows = await database
    .select({
      application: developerApplications,
      organization: developerOrganizations,
    })
    .from(developerApplications)
    .innerJoin(
      developerOrganizations,
      and(
        eq(developerOrganizations.organizationId, developerApplications.organizationId),
        eq(developerOrganizations.accountId, developerApplications.accountId),
      ),
    )
    .where(and(eq(developerApplications.state, state), cursorCondition))
    .orderBy(desc(developerApplications.updatedAt), desc(developerApplications.applicationId))
    .limit(limit + 1);
  return {
    applications: rows.slice(0, limit).map((row) => ({
      application: serializeDeveloperApplication(row.application),
      organization: serializeDeveloperOrganization(row.organization),
    })),
    hasMore: rows.length > limit,
  };
},
```

- [ ] **Step 4: Implement the exact joined detail query**

```ts
async adminGet(applicationId) {
  const [row] = await database
    .select({
      application: developerApplications,
      organization: developerOrganizations,
    })
    .from(developerApplications)
    .innerJoin(
      developerOrganizations,
      and(
        eq(developerOrganizations.organizationId, developerApplications.organizationId),
        eq(developerOrganizations.accountId, developerApplications.accountId),
      ),
    )
    .where(eq(developerApplications.applicationId, applicationId))
    .limit(1);
  return row
    ? {
        application: serializeDeveloperApplication(row.application),
        organization: serializeDeveloperOrganization(row.organization),
      }
    : null;
},
```

- [ ] **Step 5: Run focused Drizzle and service tests**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/applications.drizzle.test.ts src/developer/applications.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit the persistence slice**

```powershell
git add -- apps/api/src/developer/applications.drizzle.ts apps/api/src/developer/applications.drizzle.test.ts
git diff --cached --check
git commit -m "feat(api): query developer application review queue"
```

---

### Task 3: Expose Admin Application List and Detail Routes

**Files:**
- Modify: `apps/api/src/developer/app.ts:223-259`
- Modify: `apps/api/src/admin/developer-applications.ts:1-138`
- Modify: `apps/api/src/admin/developer-applications.test.ts:1-165`

**Interfaces:**
- Consumes: `DeveloperApplicationService.adminList`
- Consumes: `DeveloperApplicationService.adminGet`
- Produces: `GET /v1/admin/developer/applications`
- Produces: `GET /v1/admin/developer/applications/{applicationId}`
- Preserves: existing decision and suspension routes

- [ ] **Step 1: Add failing route tests for list and detail reads**

Extend the route harness so the submitting user can also be the Admin actor and
so an injected `AdminDecisionAuthorizer` records requirements. Add:

```ts
test('lists applications with review permission and no AAL2 requirement', async () => {
  const { app } = await harness('aal1');
  const response = await app.request('/developer/applications?state=submitted&limit=25');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    applications: [
      expect.objectContaining({
        application: expect.objectContaining({ state: 'submitted' }),
        organization: expect.objectContaining({ name: 'Acme Studio' }),
      }),
    ],
    next_cursor: null,
  });
});

test('reads exact detail through a target-account authorization reason', async () => {
  const { app, application } = await harness('aal1');
  const response = await app.request(
    `/developer/applications/${application.application_id}`,
    { headers: { 'x-openopc-admin-reason': 'Reviewing developer application' } },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(
    expect.objectContaining({
      application: expect.objectContaining({ application_id: application.application_id }),
      organization: expect.objectContaining({ account_id: ACCOUNT_ID }),
      policy_acceptances: expect.any(Array),
      history: expect.any(Array),
    }),
  );
});
```

Add missing permission, missing detail reason, malformed cursor, and unknown ID
assertions with exact `403`, `400`, `400`, and `404` statuses.

- [ ] **Step 2: Add a failing same-user route approval assertion**

Set `context.userId` to `APPLICANT_ID` with the review permission and current
AAL2, then assert the existing decision route returns `200` and the audit event
records `actor_user_id: APPLICANT_ID`.

- [ ] **Step 3: Run route tests and capture RED**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/admin/developer-applications.test.ts
```

Expected: FAIL because the GET routes and read-model schemas do not exist.

- [ ] **Step 4: Export the existing organization schema and add Admin schemas**

Change `DeveloperOrganizationSchema` in `developer/app.ts` to an exported const.
In `admin/developer-applications.ts`, compose strict response schemas from
`DeveloperApplicationSchema` and `DeveloperOrganizationSchema`:

```ts
const AdminApplicationListItemSchema = z.object({
  application: DeveloperApplicationSchema,
  organization: DeveloperOrganizationSchema,
});

const AdminApplicationPageSchema = z.object({
  applications: z.array(AdminApplicationListItemSchema),
  next_cursor: z.string().nullable(),
});

const PolicyAcceptanceSchema = z.object({
  account_id: z.string().uuid(),
  user_id: z.string().uuid(),
  policy: z.enum(['acceptable_use', 'module_rules']),
  version: z.string(),
  source: z.literal('developer_application'),
  accepted_at: z.string(),
});

const ApplicationAuditEventSchema = z.object({
  action: z.enum([
    'developer_application.submitted',
    'developer_application.approved',
    'developer_application.rejected',
    'developer_application.suspended',
  ]),
  account_id: z.string().uuid(),
  application_id: z.string().uuid(),
  actor_user_id: z.string().uuid(),
  from_state: z
    .object({ state: z.enum(DEVELOPER_APPLICATION_STATES), revision: z.number().int() })
    .nullable(),
  to_state: z.object({ state: z.enum(DEVELOPER_APPLICATION_STATES), revision: z.number().int() }),
  metadata: z.record(z.unknown()),
  created_at: z.string(),
});
```

- [ ] **Step 5: Add target-aware authorization helpers and GET routes**

Extend route dependencies:

```ts
export interface AdminDeveloperApplicationRouteDependencies {
  applicationService: Pick<
    DeveloperApplicationService,
    'adminList' | 'adminGet' | 'decide' | 'suspend'
  >;
  authorizeAdminDecision?: AdminDecisionAuthorizer;
}
```

Use one read requirement and the existing mutation requirement:

```ts
const APPLICATION_READ_REQUIREMENT = {
  permission: DEVELOPER_APPLICATION_REVIEW_PERMISSION,
  stepUp: false,
  crossTenantAudit: true,
} as const;
```

For the list, call the authorizer with `crossTenantAudit: false` before
`applicationService.adminList`. For detail, authorize platform scope first,
resolve the detail, then call `authorizeAdminTarget(context, detail.application.account_id,
APPLICATION_READ_REQUIREMENT, authorize)` before returning it.

- [ ] **Step 6: Preserve mutation AAL2 and same-user approval**

Refactor `authorizeReview` to use the injected authorizer but do not compare the
actor to `application.created_by`. Preserve current stable mapping:

```ts
const code = error.message.includes('Step-up')
  ? 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED'
  : 'DEVELOPER_APPLICATION_FORBIDDEN';
```

- [ ] **Step 7: Run API route and broader application tests**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/admin/developer-applications.test.ts src/developer/applications.test.ts src/developer/applications.drizzle.test.ts src/developer/applications.routes.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Expected: tests and API typecheck pass.

- [ ] **Step 8: Commit the HTTP slice**

```powershell
git add -- apps/api/src/developer/app.ts apps/api/src/admin/developer-applications.ts apps/api/src/admin/developer-applications.test.ts
git diff --cached --check
git commit -m "feat(api): expose developer application review queue"
```

---

### Task 4: Add the Admin Application Client and Query Layer

**Files:**
- Create: `apps/admin/src/features/developer-center/applications/client.ts`
- Create: `apps/admin/src/features/developer-center/applications/client.test.ts`
- Create: `apps/admin/src/features/developer-center/applications/query.ts`
- Create: `apps/admin/src/features/developer-center/applications/query.test.ts`

**Interfaces:**
- Produces: `listAdminDeveloperApplications(input)`
- Produces: `getAdminDeveloperApplication(applicationId)`
- Produces: `decideAdminDeveloperApplication(applicationId, body)`
- Produces: `suspendAdminDeveloperApplication(applicationId, body)`
- Produces: `useAdminDeveloperApplicationQueue`, `useAdminDeveloperApplicationDetail`, and mutation hooks

- [ ] **Step 1: Write failing exact-transport tests**

Mock `backendApi` using the existing Admin client-test pattern and assert:

```ts
const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';

await listAdminDeveloperApplications({ state: 'submitted', limit: 25, cursor: 'next page/+==' });
expect(get).toHaveBeenCalledWith(
  '/admin/developer/applications?state=submitted&limit=25&cursor=next+page%2F%2B%3D%3D',
);

await getAdminDeveloperApplication(APPLICATION_ID);
expect(get).toHaveBeenCalledWith(`/admin/developer/applications/${APPLICATION_ID}`, {
  adminReason: `Reviewing developer application ${APPLICATION_ID}`,
});

await decideAdminDeveloperApplication(APPLICATION_ID, {
  decision: 'approve',
  expected_revision: 0,
  reason: 'Organization verified',
});
expect(post).toHaveBeenCalledWith(
  `/admin/developer/applications/${APPLICATION_ID}/decision`,
  { decision: 'approve', expected_revision: 0, reason: 'Organization verified' },
  { adminReason: 'Organization verified' },
);
```

Also assert arbitrary response text becomes `DEVELOPER_APPLICATION_REQUEST_FAILED`
and a nested stable code such as `DEVELOPER_APPLICATION_CONFLICT` is retained.

- [ ] **Step 2: Write failing query-key, body, and conflict-refresh tests**

Create `query.test.ts` and mock the client functions. Assert exact isolation and
revision fencing:

```ts
const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';
const APPLICATION = {
  application_id: APPLICATION_ID,
  state: 'submitted' as const,
  revision: 0,
};

expect(adminDeveloperApplicationQueueQuery('submitted', null).queryKey).toEqual([
  'admin-developer-applications',
  'list',
  'submitted',
  'first',
]);
expect(adminDeveloperApplicationQueueQuery('submitted', 'cursor').queryKey).toEqual([
  'admin-developer-applications',
  'list',
  'submitted',
  'cursor',
]);

await submitAdminDeveloperApplicationDecision({
  application: APPLICATION,
  decision: 'approve',
  reason: 'Organization verified',
});
expect(decideAdminDeveloperApplication).toHaveBeenCalledWith(APPLICATION_ID, {
  decision: 'approve',
  expected_revision: APPLICATION.revision,
  reason: 'Organization verified',
});
```

Export a plain conflict refresh helper and test it without mounting React:

```ts
const removeQueries = mock(() => undefined);
const refetchQueries = mock(async () => undefined);
await refreshAdminDeveloperApplicationAfterConflict(
  { removeQueries, refetchQueries },
  APPLICATION_ID,
);
expect(removeQueries).toHaveBeenCalledWith({
  queryKey: adminDeveloperApplicationKeys.detail(APPLICATION_ID),
});
expect(refetchQueries).toHaveBeenCalledWith({
  queryKey: adminDeveloperApplicationKeys.detail(APPLICATION_ID),
});
```

- [ ] **Step 3: Run the client and query tests and capture RED**

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/client.test.ts src/features/developer-center/applications/query.test.ts
```

Expected: FAIL because the new client module is absent.

- [ ] **Step 4: Implement stable client types and functions**

Define local Admin-only types for policy acceptance and audit history while
importing `DeveloperApplication` and `DeveloperOrganization` from `@kortix/sdk`.
Expose these exact read shapes:

```ts
export interface AdminDeveloperApplicationPolicyAcceptance {
  account_id: string;
  user_id: string;
  policy: 'acceptable_use' | 'module_rules';
  version: string;
  source: 'developer_application';
  accepted_at: string;
}

export interface AdminDeveloperApplicationAuditEvent {
  action:
    | 'developer_application.submitted'
    | 'developer_application.approved'
    | 'developer_application.rejected'
    | 'developer_application.suspended';
  account_id: string;
  application_id: string;
  actor_user_id: string;
  from_state: { state: DeveloperApplicationState; revision: number } | null;
  to_state: { state: DeveloperApplicationState; revision: number };
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AdminDeveloperApplicationListItem {
  application: DeveloperApplication;
  organization: DeveloperOrganization;
}

export interface AdminDeveloperApplicationPage {
  applications: AdminDeveloperApplicationListItem[];
  next_cursor: string | null;
}

export interface AdminDeveloperApplicationDetail extends AdminDeveloperApplicationListItem {
  policy_acceptances: AdminDeveloperApplicationPolicyAcceptance[];
  history: AdminDeveloperApplicationAuditEvent[];
}
```

Use a stable-code set containing only:

```ts
type AdminDeveloperApplicationErrorCode =
  | 'DEVELOPER_APPLICATION_INPUT_INVALID'
  | 'DEVELOPER_APPLICATION_NOT_FOUND'
  | 'DEVELOPER_APPLICATION_FORBIDDEN'
  | 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED'
  | 'DEVELOPER_APPLICATION_CONFLICT'
  | 'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE'
  | 'DEVELOPER_APPLICATION_REQUEST_FAILED';
```

Implement `unwrapAdmin` using the same visited-object stable extraction as the
existing module-review client. Do not preserve `cause` or arbitrary messages.

- [ ] **Step 5: Implement account-safe query keys and mutations**

In `query.ts`:

```ts
export const adminDeveloperApplicationKeys = {
  all: ['admin-developer-applications'] as const,
  list: (state: DeveloperApplicationState, cursor: string | null) =>
    ['admin-developer-applications', 'list', state, cursor ?? 'first'] as const,
  detail: (applicationId: string) =>
    ['admin-developer-applications', 'detail', applicationId] as const,
};
```

Define exact mutation inputs:

```ts
export interface AdminDeveloperApplicationDecisionInput {
  application: Pick<DeveloperApplication, 'application_id' | 'state' | 'revision'>;
  decision: 'approve' | 'reject';
  reason: string;
}

export interface AdminDeveloperApplicationSuspensionInput {
  application: Pick<DeveloperApplication, 'application_id' | 'state' | 'revision'>;
  reason: string;
}

export async function refreshAdminDeveloperApplicationAfterConflict(
  queryClient: Pick<QueryClient, 'removeQueries' | 'refetchQueries'>,
  applicationId: string,
): Promise<void> {
  queryClient.removeQueries({
    queryKey: adminDeveloperApplicationKeys.detail(applicationId),
  });
  await queryClient.refetchQueries({
    queryKey: adminDeveloperApplicationKeys.detail(applicationId),
  });
}
```

Decision success invalidates the detail and every list prefix. Conflict removes
and refetches only the exact detail; it does not retry the mutation:

```ts
onError: async (error, input) => {
  if (adminDeveloperApplicationErrorCode(error) !== 'DEVELOPER_APPLICATION_CONFLICT') return;
  await refreshAdminDeveloperApplicationAfterConflict(
    queryClient,
    input.application.application_id,
  );
},
```

- [ ] **Step 6: Run client/query tests and Admin typecheck**

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/client.test.ts src/features/developer-center/applications/query.test.ts
pnpm.cmd --filter @kortix/admin typecheck
```

Expected: test and typecheck pass.

- [ ] **Step 7: Commit the Admin data layer**

```powershell
git add -- apps/admin/src/features/developer-center/applications/client.ts apps/admin/src/features/developer-center/applications/client.test.ts apps/admin/src/features/developer-center/applications/query.ts apps/admin/src/features/developer-center/applications/query.test.ts
git diff --cached --check
git commit -m "feat(admin): add developer application data client"
```

---

### Task 5: Build the Admin Application Queue and Navigation

**Files:**
- Create: `apps/admin/src/features/developer-center/applications/application-queue-page.tsx`
- Create: `apps/admin/src/features/developer-center/applications/application-pages.test.tsx`
- Create: `apps/admin/src/app/developer-applications/page.tsx`
- Modify: `apps/admin/src/app/_components/admin-sidebar.tsx:7-65`
- Modify: `apps/admin/translations/en.json:10-16`
- Modify: `apps/admin/src/lib/admin-surface.ts:1-17`
- Modify: `apps/admin/src/app/admin-surface.test.tsx:15-80`

**Interfaces:**
- Consumes: `useAdminDeveloperApplicationQueue`
- Produces: `AdminDeveloperApplicationQueueView`
- Produces: `AdminDeveloperApplicationQueuePage`
- Produces: `/developer-applications`

- [ ] **Step 1: Read the Kortix design-system skill**

Read `.claude/skills/kortix-design-system/SKILL.md` completely before changing
Admin JSX or Tailwind classes. Reuse `SectionContainer`, `SectionHeader`,
`Button`, `Input`, `Table`, and `Badge`.

- [ ] **Step 2: Add failing queue render tests**

Create `application-pages.test.tsx` with a submitted item and assert:

```tsx
const ITEM: AdminDeveloperApplicationListItem = {
  application: {
    application_id: '10000000-0000-4000-a000-000000000001',
    account_id: '20000000-0000-4000-a000-000000000002',
    organization_id: '30000000-0000-4000-a000-000000000003',
    state: 'submitted',
    revision: 0,
    policy_versions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
    submitted_at: '2026-08-03T08:00:00.000Z',
    decided_at: null,
    suspended_at: null,
    decision_reason: null,
    created_by: '40000000-0000-4000-a000-000000000004',
    updated_by: null,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
  organization: {
    organization_id: '30000000-0000-4000-a000-000000000003',
    account_id: '20000000-0000-4000-a000-000000000002',
    name: 'Acme Studio',
    verification_state: 'pending',
    verification_metadata: {},
    verification_revision: 0,
    verification_changed_by: null,
    verification_changed_at: null,
    created_by: '40000000-0000-4000-a000-000000000004',
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
};

const html = renderToStaticMarkup(
  <AdminDeveloperApplicationQueueView
    state="ready"
    applicationState="submitted"
    applications={[ITEM]}
    search="Acme"
    nextCursor="cursor"
    errorCode={null}
    onSearchChange={noop}
    onStateChange={noop}
    onNextPage={noop}
    onResetCursor={noop}
    onOpenApplication={noop}
  />,
);

expect(html).toContain('Developer applications');
expect(html).toContain('Acme Studio');
expect(html).toContain('Submitted');
expect(html).toContain('Revision 0');
expect(html).toContain('Next page');
```

Add an error render with `DEVELOPER_APPLICATION_INPUT_INVALID` and assert it
contains `Reset to first page` but not the raw code. Add an empty render and a
loaded-page search that hides a non-matching organization.

- [ ] **Step 3: Extend route-ownership tests and capture RED**

Add both new route files to `ADMIN_ROUTE_FILES` and assert:

```ts
expect(isAdminRequestPath('/developer-applications')).toBeTrue();
expect(
  isAdminRequestPath('/developer-applications/10000000-0000-4000-a000-000000000001'),
).toBeTrue();
```

Run:

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/application-pages.test.tsx src/app/admin-surface.test.tsx
```

Expected: FAIL because the queue component and routes do not exist.

- [ ] **Step 4: Implement the queue view and page**

First add `/developer-applications` to `EXACT_OPERATOR_PATHS` in
`apps/admin/src/lib/admin-surface.ts`. Preserve the existing Module Review
matcher and add the independent dynamic application-detail matcher:

```ts
if (/^\/developer-applications\/[0-9a-f-]+$/i.test(pathname)) return true;
```

Use these exact states and filters:

```ts
export type AdminApplicationQueueState = 'loading' | 'error' | 'empty' | 'ready';
const APPLICATION_STATES: readonly DeveloperApplicationState[] = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'suspended',
];
```

Search only the loaded page over organization name, account ID, and application
ID. Reset `cursor` to `null` whenever the status changes. Navigate with:

```ts
router.push(`/developer-applications/${encodeURIComponent(applicationId)}`);
```

Render columns for Organization, State, Revision, Submitted, Updated, and Open.
Keep status buttons and pagination dimensions stable.

- [ ] **Step 5: Add the route and sidebar entry**

Route:

```tsx
import { AdminDeveloperApplicationQueuePage } from '@/features/developer-center/applications/application-queue-page';

export default function Page() {
  return <AdminDeveloperApplicationQueuePage />;
}
```

Add translation key `developerCenter.admin.applications` with value
`Developer applications`, and add a `ClipboardList` lucide sidebar item before
Module Reviews.

- [ ] **Step 6: Run queue, surface, and sidebar tests**

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/application-pages.test.tsx src/app/admin-surface.test.tsx src/app/admin-sidebar-brand.test.tsx
pnpm.cmd --filter @kortix/admin typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 7: Commit the queue slice**

```powershell
git add -- apps/admin/src/features/developer-center/applications/application-queue-page.tsx apps/admin/src/features/developer-center/applications/application-pages.test.tsx apps/admin/src/app/developer-applications/page.tsx apps/admin/src/app/_components/admin-sidebar.tsx apps/admin/translations/en.json apps/admin/src/lib/admin-surface.ts apps/admin/src/app/admin-surface.test.tsx
git diff --cached --check
git commit -m "feat(admin): show developer application queue"
```

---

### Task 6: Build the Admin Application Detail and Decision UI

**Files:**
- Create: `apps/admin/src/features/developer-center/applications/application-detail-page.tsx`
- Modify: `apps/admin/src/features/developer-center/applications/application-pages.test.tsx`
- Create: `apps/admin/src/app/developer-applications/[applicationId]/page.tsx`

**Interfaces:**
- Consumes: `useAdminDeveloperApplicationDetail`
- Consumes: decision and suspension mutation hooks
- Produces: `AdminDeveloperApplicationDetailView`
- Produces: `AdminDeveloperApplicationDetailPage`
- Produces: `/developer-applications/{applicationId}`

- [ ] **Step 1: Add failing action-gating and conflict tests**

Add render tests for submitted, approved, and conflict states:

```tsx
const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-a000-000000000002';
const ORGANIZATION_ID = '30000000-0000-4000-a000-000000000003';
const APPLICANT_ID = '40000000-0000-4000-a000-000000000004';
const noop = () => undefined;

const DETAIL: AdminDeveloperApplicationDetail = {
  application: {
    application_id: APPLICATION_ID,
    account_id: ACCOUNT_ID,
    organization_id: ORGANIZATION_ID,
    state: 'submitted',
    revision: 0,
    policy_versions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
    submitted_at: '2026-08-03T08:00:00.000Z',
    decided_at: null,
    suspended_at: null,
    decision_reason: null,
    created_by: APPLICANT_ID,
    updated_by: null,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
  organization: {
    organization_id: ORGANIZATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Acme Studio',
    verification_state: 'pending',
    verification_metadata: {},
    verification_revision: 0,
    verification_changed_by: null,
    verification_changed_at: null,
    created_by: APPLICANT_ID,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
  policy_acceptances: [],
  history: [],
};
const BASE_PROPS = {
  state: 'ready' as const,
  detail: DETAIL,
  reason: 'Organization verified',
  pending: false,
  conflict: false,
  errorCode: null,
  onReasonChange: noop,
  onDecision: noop,
  onSuspend: noop,
  onReload: noop,
};

const submitted = renderToStaticMarkup(
  <AdminDeveloperApplicationDetailView
    {...BASE_PROPS}
  />,
);
expect(submitted).toContain('Approve application');
expect(submitted).toContain('Reject application');
expect(submitted).not.toContain('Suspend application');

const approved = renderToStaticMarkup(
  <AdminDeveloperApplicationDetailView
    {...BASE_PROPS}
    detail={{ ...DETAIL, application: { ...DETAIL.application, state: 'approved' } }}
  />,
);
expect(approved).toContain('Suspend application');
expect(approved).not.toContain('Approve application');
```

Render an empty reason and assert all mutation buttons are disabled. Render a
conflict and assert `Reload latest application` exists while `Retry decision`
does not.

- [ ] **Step 2: Run the detail render test and capture RED**

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/application-pages.test.tsx -t "application detail"
```

Expected: FAIL because the detail component is absent.

- [ ] **Step 3: Implement the pure detail view**

Render an unframed `max-w-6xl` Admin surface with:

- back link to `/developer-applications`;
- organization name, account ID, application ID, state, and revision;
- organization verification state and revision;
- policy acceptance table;
- ordered audit timeline showing action, actor, timestamp, and bounded reason;
- one `Textarea` with `maxLength={4_000}`;
- approve/reject buttons for `submitted` and `under_review`;
- suspend button only for `approved`.

Use this reason gate:

```ts
const normalizedReason = reason.trim();
const reasonValid = normalizedReason.length >= 1 && normalizedReason.length <= 4_000;
const controlsDisabled = pending || conflict || !reasonValid;
```

- [ ] **Step 4: Implement the connected detail page**

Call mutations with the exact current revision:

```ts
decision.mutate({
  application: detail.application,
  decision: 'approve',
  reason: reason.trim(),
});

suspension.mutate({
  application: detail.application,
  reason: reason.trim(),
});
```

Derive conflict only from `DEVELOPER_APPLICATION_CONFLICT`. Reload removes the
exact detail query and refetches it; it does not call `mutate` again.

- [ ] **Step 5: Add the dynamic route**

```tsx
import { AdminDeveloperApplicationDetailPage } from '@/features/developer-center/applications/application-detail-page';

export default async function Page({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const { applicationId } = await params;
  return <AdminDeveloperApplicationDetailPage applicationId={applicationId} />;
}
```

- [ ] **Step 6: Run all Admin developer-application tests and typecheck**

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/client.test.ts src/features/developer-center/applications/application-pages.test.tsx src/app/admin-surface.test.tsx
pnpm.cmd --filter @kortix/admin typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 7: Commit the detail slice**

```powershell
git add -- apps/admin/src/features/developer-center/applications/application-detail-page.tsx apps/admin/src/features/developer-center/applications/application-pages.test.tsx "apps/admin/src/app/developer-applications/[applicationId]/page.tsx"
git diff --cached --check
git commit -m "feat(admin): decide developer applications"
```

---

### Task 7: Add Account-Scoped Publisher Access and Selection Logic

**Files:**
- Create: `apps/web/src/features/developer-center/publisher/access.ts`
- Create: `apps/web/src/features/developer-center/publisher/access.test.ts`
- Create: `apps/web/src/features/developer-center/publisher/access-query.ts`
- Create: `apps/web/src/features/developer-center/publisher/access-query.test.ts`
- Create: `apps/web/src/features/developer-center/publisher/publisher-select.tsx`

**Interfaces:**
- Produces: `selectableDeveloperPublishers(access)`
- Produces: `reconcilePublisherSelection(current, accountId, access)`
- Produces: `useDeveloperPublisherAccess(accountId, enabled)`
- Produces: `useCreateDeveloperPublisher()`
- Produces: `DeveloperPublisherSelect`

- [ ] **Step 1: Add failing pure selection tests**

Create `access.test.ts`:

```ts
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';
const USER_ID = '30000000-0000-4000-a000-000000000003';

function publisherEntry(
  publisherId: string,
  status: DeveloperPublisher['status'],
  role: DeveloperPublisherMember['role'] | null,
): DeveloperAccess['publishers'][number] {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: ACCOUNT_ID,
      organization_id: ORGANIZATION_ID,
      slug: publisherId,
      display_name: `${publisherId} Studio`,
      status,
      authority_revision: 0,
      suspended_reason: null,
      suspended_by: null,
      suspended_at: null,
      created_by: USER_ID,
      created_at: '2026-08-03T08:00:00.000Z',
      updated_at: '2026-08-03T08:00:00.000Z',
    },
    membership: role
      ? {
          member_id: `${publisherId}-member`,
          account_id: ACCOUNT_ID,
          publisher_id: publisherId,
          user_id: USER_ID,
          role,
          revision: 0,
          created_by: USER_ID,
          created_at: '2026-08-03T08:00:00.000Z',
          updated_by: null,
          updated_at: '2026-08-03T08:00:00.000Z',
        }
      : null,
  };
}

function access(publishers: DeveloperAccess['publishers']): DeveloperAccess {
  return {
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    organization: null,
    invitations: [],
    publishers,
  };
}

const activeOwner = publisherEntry('acme', 'active', 'owner');
const secondOwner = publisherEntry('second', 'active', 'owner');
const suspendedOwner = publisherEntry('suspended', 'suspended', 'owner');
const noMembership = publisherEntry('foreign', 'active', null);
const uploadOnlyDeveloper = publisherEntry('upload-only', 'active', 'developer');
const releaseManager = publisherEntry('release-manager', 'active', 'release_manager');

test('selects one active membership and requires a choice for multiple Publishers', () => {
  expect(selectableDeveloperPublishers(access([activeOwner]))).toEqual([activeOwner]);
  expect(
    reconcilePublisherSelection(
      { accountId: ACCOUNT_ID, publisherId: '' },
      ACCOUNT_ID,
      access([activeOwner]),
    ),
  ).toEqual({ accountId: ACCOUNT_ID, publisherId: 'acme' });

  expect(
    reconcilePublisherSelection(
      { accountId: ACCOUNT_ID, publisherId: '' },
      ACCOUNT_ID,
      access([activeOwner, secondOwner]),
    ),
  ).toEqual({ accountId: ACCOUNT_ID, publisherId: '' });
});

test('drops suspended, membership-free, and previous-account selections', () => {
  expect(
    selectableDeveloperPublishers(
      access([suspendedOwner, noMembership, uploadOnlyDeveloper, releaseManager]),
    ),
  ).toEqual([]);
  expect(
    reconcilePublisherSelection(
      { accountId: 'old-account', publisherId: 'old-publisher' },
      ACCOUNT_ID,
      access([activeOwner]),
    ),
  ).toEqual({ accountId: ACCOUNT_ID, publisherId: 'acme' });
});
```

- [ ] **Step 2: Add failing SDK-delegation tests**

Mock `getDeveloperAccess` and `createDeveloperPublisher`, then assert:

```ts
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';

await developerPublisherAccessQuery(ACCOUNT_ID).queryFn();
expect(getDeveloperAccess).toHaveBeenCalledWith({ accountId: ACCOUNT_ID });

await createPublisher({
  accountId: ACCOUNT_ID,
  organizationId: ORGANIZATION_ID,
  slug: 'acme',
  displayName: 'Acme Studio',
});
expect(createDeveloperPublisher).toHaveBeenCalledWith({
  accountId: ACCOUNT_ID,
  organizationId: ORGANIZATION_ID,
  slug: 'acme',
  displayName: 'Acme Studio',
});
```

- [ ] **Step 3: Run both new tests and capture RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/access-query.test.ts
```

Expected: FAIL because the access modules do not exist.

- [ ] **Step 4: Implement pure selectable-Publisher logic**

In `access.ts`:

```ts
export type SelectableDeveloperPublisher = DeveloperAccess['publishers'][number] & {
  membership: DeveloperPublisherMember;
};

export interface DeveloperPublisherSelection {
  accountId: string | null;
  publisherId: string;
}

export function selectableDeveloperPublishers(
  access: DeveloperAccess | null | undefined,
): SelectableDeveloperPublisher[] {
  return (access?.publishers ?? []).filter(
    (entry): entry is SelectableDeveloperPublisher =>
      entry.publisher.status === 'active' &&
      entry.membership?.role === 'owner',
  );
}

export function reconcilePublisherSelection(
  current: DeveloperPublisherSelection,
  accountId: string | null,
  access: DeveloperAccess | null | undefined,
): DeveloperPublisherSelection {
  const options = selectableDeveloperPublishers(access);
  const currentIsValid =
    current.accountId === accountId &&
    options.some((entry) => entry.publisher.publisher_id === current.publisherId);
  if (currentIsValid) return current;
  return {
    accountId,
    publisherId: options.length === 1 ? options[0]!.publisher.publisher_id : '',
  };
}
```

- [ ] **Step 5: Implement access query and create mutation**

Use `skipToken` when no account is selected. The creation mutation must
invalidate only the exact account access key:

```ts
export const developerPublisherAccessKeys = {
  all: ['developer-publisher-access'] as const,
  account: (accountId: string) => ['developer-publisher-access', accountId] as const,
};

export function developerPublisherAccessQuery(accountId: string) {
  return {
    queryKey: developerPublisherAccessKeys.account(accountId),
    queryFn: () => getDeveloperAccess({ accountId }),
    staleTime: 15_000,
  };
}
```

Export a plain `createPublisher` function for transport testing and a
`useCreateDeveloperPublisher` mutation hook for UI use.

- [ ] **Step 6: Implement the shared Publisher Select**

Use the existing Radix-backed Select primitives. The component accepts:

```ts
interface DeveloperPublisherSelectProps {
  id: string;
  publishers: readonly SelectableDeveloperPublisher[];
  value: string;
  disabled?: boolean;
  onValueChange: (publisherId: string) => void;
}
```

Render `display_name` as the primary label and `publisher_id` as the option
description. Do not add a free-form fallback.

- [ ] **Step 7: Run the new Web tests**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/access-query.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit the access slice**

```powershell
git add -- apps/web/src/features/developer-center/publisher/access.ts apps/web/src/features/developer-center/publisher/access.test.ts apps/web/src/features/developer-center/publisher/access-query.ts apps/web/src/features/developer-center/publisher/access-query.test.ts apps/web/src/features/developer-center/publisher/publisher-select.tsx
git diff --cached --check
git commit -m "feat(web): add Publisher access selection"
```

---

### Task 8: Add Publisher Onboarding to the Approved Application Page

**Files:**
- Create: `apps/web/src/features/developer-center/publisher/onboarding-panel.tsx`
- Create: `apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx`
- Modify: `apps/web/src/features/developer-center/model.ts:1-58,264-277`
- Modify: `apps/web/src/features/developer-center/model.test.ts`
- Modify: `apps/web/src/features/developer-center/application/developer-application-page.tsx:21-415`
- Modify: `apps/web/src/features/developer-center/application/developer-application-page.test.tsx:28-182`

**Interfaces:**
- Consumes: `useDeveloperPublisherAccess`
- Consumes: `useCreateDeveloperPublisher`
- Consumes: `DeveloperPublisherSelect`
- Produces: `DeveloperPublisherOnboardingView`
- Produces: `DeveloperPublisherOnboardingPanel`
- Extends: `DeveloperApplicationViewProps.approvedContent?: ReactNode`

- [ ] **Step 1: Add failing onboarding view tests**

Create `onboarding-panel.test.tsx` and cover no Publisher, one Publisher, multiple
Publishers, read-only, loading, and error states:

```tsx
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';
const USER_ID = '30000000-0000-4000-a000-000000000003';
const noop = () => undefined;

function publisherOption(
  publisherId: string,
  displayName: string,
): SelectableDeveloperPublisher {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: ACCOUNT_ID,
      organization_id: ORGANIZATION_ID,
      slug: publisherId,
      display_name: displayName,
      status: 'active',
      authority_revision: 0,
      suspended_reason: null,
      suspended_by: null,
      suspended_at: null,
      created_by: USER_ID,
      created_at: '2026-08-03T08:00:00.000Z',
      updated_at: '2026-08-03T08:00:00.000Z',
    },
    membership: {
      member_id: `${publisherId}-member`,
      account_id: ACCOUNT_ID,
      publisher_id: publisherId,
      user_id: USER_ID,
      role: 'owner',
      revision: 0,
      created_by: USER_ID,
      created_at: '2026-08-03T08:00:00.000Z',
      updated_by: null,
      updated_at: '2026-08-03T08:00:00.000Z',
    },
  };
}

const ORGANIZATION: DeveloperOrganization = {
  organization_id: ORGANIZATION_ID,
  account_id: ACCOUNT_ID,
  name: 'Acme Studio',
  verification_state: 'verified',
  verification_metadata: {},
  verification_revision: 1,
  verification_changed_by: USER_ID,
  verification_changed_at: '2026-08-03T08:05:00.000Z',
  created_by: USER_ID,
  created_at: '2026-08-03T08:00:00.000Z',
  updated_at: '2026-08-03T08:05:00.000Z',
};
const PUBLISHER_A = publisherOption('acme', 'Acme Studio');
const PUBLISHER_B = publisherOption('second', 'Second Studio');
const BASE = {
  state: 'ready' as const,
  organization: ORGANIZATION,
  publishers: [PUBLISHER_A] as readonly SelectableDeveloperPublisher[],
  selectedPublisherId: 'acme',
  createOpen: false,
  slug: '',
  displayName: '',
  canWrite: true,
  pending: false,
  errorCode: null,
  onSlugChange: noop,
  onDisplayNameChange: noop,
  onPublisherChange: noop,
  onCreateOpenChange: noop,
  onCreate: noop,
};

const createHtml = renderToStaticMarkup(
  <DeveloperPublisherOnboardingView
    state="ready"
    organization={ORGANIZATION}
    publishers={[]}
    selectedPublisherId=""
    slug="acme"
    displayName="Acme Studio"
    canWrite
    pending={false}
    errorCode={null}
    onSlugChange={noop}
    onDisplayNameChange={noop}
    onPublisherChange={noop}
    onCreate={noop}
  />,
);
expect(createHtml).toContain('Create Publisher');
expect(createHtml).toContain('Acme Studio');

const multipleHtml = renderToStaticMarkup(
  <DeveloperPublisherOnboardingView {...BASE} publishers={[PUBLISHER_A, PUBLISHER_B]} />,
);
expect(multipleHtml).toContain('Choose a Publisher');
expect(multipleHtml).toContain('Create another Publisher');
expect(multipleHtml).not.toContain('Publisher ID');

const additionalCreateHtml = renderToStaticMarkup(
  <DeveloperPublisherOnboardingView
    {...BASE}
    publishers={[PUBLISHER_A, PUBLISHER_B]}
    createOpen
  />,
);
expect(additionalCreateHtml).toContain('Publisher slug');
expect(additionalCreateHtml).toContain('Display name');
```

Add a stable-code assertion to `model.test.ts`:

```ts
for (const code of [
  'DEVELOPER_INPUT_INVALID',
  'DEVELOPER_ORGANIZATION_NOT_FOUND',
  'DEVELOPER_PUBLISHER_FORBIDDEN',
  'DEVELOPER_VERIFICATION_REQUIRED',
  'DEVELOPER_APPLICATION_APPROVAL_REQUIRED',
  'DEVELOPER_AUTHORITY_CONFLICT',
] as const) {
  expect(developerCenterErrorCode({ body: { error: code } })).toBe(code);
}
```

- [ ] **Step 2: Add a failing approved-content slot test**

Extend `developer-application-page.test.tsx`:

```tsx
const approved = renderToStaticMarkup(
  <View
    state="current"
    application={{ ...APPLICATION, state: 'approved', revision: 1 }}
    currentPolicyVersions={POLICIES}
    organizationName=""
    acceptedPolicies={{ moduleRules: false, acceptableUse: false }}
    canWrite
    pending={false}
    errorCode={null}
    onOrganizationNameChange={noop}
    onPolicyAcceptedChange={noop}
    onSubmit={noop}
    approvedContent={<div>Publisher onboarding ready</div>}
  />,
);
expect(approved).toContain('Publisher onboarding ready');
```

- [ ] **Step 3: Run focused tests and capture RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/model.test.ts src/features/developer-center/publisher/onboarding-panel.test.tsx src/features/developer-center/application/developer-application-page.test.tsx
```

Expected: FAIL because the onboarding component and approved-content prop are absent.

- [ ] **Step 4: Extend the stable Web error vocabulary**

Add the six Publisher-creation codes from Step 1 to `DeveloperCenterErrorCode`
and `KNOWN_DEVELOPER_CENTER_ERROR_CODES`. Keep arbitrary provider text mapped to
`DEVELOPER_REQUEST_FAILED`.

- [ ] **Step 5: Implement the pure onboarding view**

Use an un-nested section below the approved status. When `publishers.length ===
0`, render slug and display-name inputs plus a Create Publisher button. When
publishers exist, render `DeveloperPublisherSelect`, a link to
`/developer/modules`, and a `Plus` icon command labelled Create another
Publisher. That command toggles the same bounded creation form through
`createOpen` and `onCreateOpenChange`.

The create button is enabled only when:

```ts
const canCreate =
  canWrite &&
  !pending &&
  Boolean(organization) &&
  Boolean(slug.trim()) &&
  Boolean(displayName.trim());
```

Do not expose organization ID as an editable control.

- [ ] **Step 6: Implement the connected onboarding panel**

Maintain account-scoped selection state with `reconcilePublisherSelection`.
After successful creation, use the returned `publisher.publisher_id` as the
selection and invalidate the exact access query. Call:

```ts
createMutation.mutate({
  accountId,
  organizationId: access.organization.organization_id,
  slug: slug.trim(),
  displayName: displayName.trim(),
});
```

If access has no organization despite an approved application, fail closed with
the bounded application/developer-access error presentation.

- [ ] **Step 7: Add the approved-content slot and connect it**

Extend the pure view prop with `approvedContent?: ReactNode`, render it only for
`application.state === 'approved'`, and pass this from `DeveloperApplicationPage`:

```tsx
approvedContent={
  selectedAccountId && currentQuery.data?.application?.state === 'approved' ? (
    <DeveloperPublisherOnboardingPanel
      accountId={selectedAccountId}
      canWrite={writePermission.allowed}
    />
  ) : null
}
```

- [ ] **Step 8: Run model, onboarding, and application tests**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/model.test.ts src/features/developer-center/publisher/onboarding-panel.test.tsx src/features/developer-center/application/developer-application-page.test.tsx
```

Expected: all tests pass.

- [ ] **Step 9: Commit the onboarding slice**

```powershell
git add -- apps/web/src/features/developer-center/model.ts apps/web/src/features/developer-center/model.test.ts apps/web/src/features/developer-center/publisher/onboarding-panel.tsx apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx apps/web/src/features/developer-center/application/developer-application-page.tsx apps/web/src/features/developer-center/application/developer-application-page.test.tsx
git diff --cached --check
git commit -m "feat(web): create Publishers after approval"
```

---

### Task 9: Replace Package Publisher ID Input with the Publisher Select

**Files:**
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.tsx:85-193,210-233,435-569`
- Modify: `apps/web/src/features/developer-center/publisher/submit-page.test.tsx:18-220`

**Interfaces:**
- Consumes: `useDeveloperPublisherAccess`
- Consumes: `selectableDeveloperPublishers`
- Consumes: `reconcilePublisherSelection`
- Consumes: `DeveloperPublisherSelect`
- Preserves: `packageController.start(file, { accountId, publisherId })`

- [ ] **Step 1: Add failing package-selector tests**

Replace the old `Publisher ID` expectation with:

```tsx
function publisherOption(
  publisherId: string,
  displayName: string,
): SelectableDeveloperPublisher {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: 'account-1',
      organization_id: 'organization-1',
      slug: publisherId,
      display_name: displayName,
      status: 'active',
      authority_revision: 0,
      suspended_reason: null,
      suspended_by: null,
      suspended_at: null,
      created_by: 'user-1',
      created_at: '2026-08-03T08:00:00.000Z',
      updated_at: '2026-08-03T08:00:00.000Z',
    },
    membership: {
      member_id: `${publisherId}-member`,
      account_id: 'account-1',
      publisher_id: publisherId,
      user_id: 'user-1',
      role: 'owner',
      revision: 0,
      created_by: 'user-1',
      created_at: '2026-08-03T08:00:00.000Z',
      updated_by: null,
      updated_at: '2026-08-03T08:00:00.000Z',
    },
  };
}
const PUBLISHER_A = publisherOption('acme', 'Acme Studio');
const PUBLISHER_B = publisherOption('second', 'Second Studio');

const html = renderToStaticMarkup(
  <DeveloperModuleSubmitView
    mode="package"
    stage="input"
    text=""
    item={null}
    issues={[]}
    inputErrorCode={null}
    canWrite
    pending={false}
    packageFileName="module.openopc"
    packagePublishers={[PUBLISHER_A, PUBLISHER_B]}
    packagePublisherId="acme"
    packageState={{
      stage: 'idle',
      fileName: null,
      fileSize: null,
      progress: 0,
      digest: null,
      uploadId: null,
      artifact: null,
      submission: null,
    }}
    errorCode={null}
    onModeChange={noop}
    onTextChange={noop}
    onValidate={noop}
    onConfirm={noop}
    onPackagePublisherIdChange={noop}
    onPackageFile={noop}
    onStartPackage={noop}
    onCancelPackage={noop}
  />,
);
expect(html).toContain('Publisher');
expect(html).toContain('Acme Studio');
expect(html).not.toContain('placeholder="acme"');
expect(html).not.toContain('Publisher ID');
```

Add a no-Publisher case that contains a link to `/developer/apply`, contains no
free-form input, and disables Upload package. Keep the active-upload test and
assert the Select is disabled while cancelling remains available.

- [ ] **Step 2: Run the submit-page test and capture RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/submit-page.test.tsx -t "Publisher"
```

Expected: FAIL because the view still renders a text input and has no Publisher options prop.

- [ ] **Step 3: Replace the package input in the pure view**

Extend `DeveloperModuleSubmitViewProps` with:

```ts
packagePublishers?: readonly SelectableDeveloperPublisher[];
packageAccessLoading?: boolean;
```

Pass those into `DeveloperModulePackageUploadView`. Render Loading while access
is loading, the shared Select when options exist, and an apply link when no
options exist. Keep the existing upload button gate:

```ts
disabled={!fileName || !publisherId || packagePublishers.length === 0}
```

- [ ] **Step 4: Connect the page to developer access**

Load access for `selectedAccountId`, derive selectable Publishers, and reconcile
selection whenever account or access changes:

```ts
const accessQuery = useDeveloperPublisherAccess(selectedAccountId);
const packagePublishers = selectableDeveloperPublishers(accessQuery.data);
const [packageSelection, setPackageSelection] = useState<DeveloperPublisherSelection>({
  accountId: selectedAccountId,
  publisherId: '',
});
const activePackageSelection = reconcilePublisherSelection(
  packageSelection,
  selectedAccountId,
  accessQuery.data,
);
```

When rendering, use `activePackageSelection.publisherId`. In the change handler,
store `{ accountId: selectedAccountId, publisherId }`. In `submitPackage`, pass
that exact selected ID to the existing controller and do not trim or accept an
unlisted string.

- [ ] **Step 5: Run submit, access, and artifact-controller tests**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/publisher/submit-page.test.tsx src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/access-query.test.ts src/features/developer-center/publisher/artifact-upload-controller.test.ts
```

Expected: all tests pass and no test expects a free-form Publisher ID.

- [ ] **Step 6: Run changed-file formatting and Web typecheck**

```powershell
pnpm.cmd exec biome check apps/web/src/features/developer-center/publisher/access.ts apps/web/src/features/developer-center/publisher/access-query.ts apps/web/src/features/developer-center/publisher/publisher-select.tsx apps/web/src/features/developer-center/publisher/onboarding-panel.tsx apps/web/src/features/developer-center/publisher/submit-page.tsx apps/web/src/features/developer-center/application/developer-application-page.tsx
pnpm.cmd --filter Kortix-Computer-Frontend typecheck
```

Expected: Biome passes. If typecheck reports only the known
`apps/web/src/lib/api-client.test.ts:53,87,91` fetch-stub errors, preserve the
output and verify no changed file appears; do not suppress the baseline.

- [ ] **Step 7: Commit the submission slice**

```powershell
git add -- apps/web/src/features/developer-center/publisher/submit-page.tsx apps/web/src/features/developer-center/publisher/submit-page.test.tsx
git diff --cached --check
git commit -m "feat(web): select Publisher for module upload"
```

---

## Final Verification Gate

- [ ] **Step 1: Run focused API tests and typecheck**

```powershell
pnpm.cmd --filter kortix-api exec bun test --isolate src/developer/applications.test.ts src/developer/applications.drizzle.test.ts src/developer/applications.routes.test.ts src/admin/developer-applications.test.ts
pnpm.cmd --filter kortix-api typecheck
```

Record the exact test count and exit codes.

- [ ] **Step 2: Run focused Admin tests and package gates**

```powershell
pnpm.cmd --filter @kortix/admin exec bun test src/features/developer-center/applications/client.test.ts src/features/developer-center/applications/query.test.ts src/features/developer-center/applications/application-pages.test.tsx src/app/admin-surface.test.tsx src/app/admin-sidebar-brand.test.tsx
pnpm.cmd --filter @kortix/admin typecheck
pnpm.cmd --filter @kortix/admin build
```

Record the exact test count and build output.

- [ ] **Step 3: Run focused Web and SDK regression tests**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test --isolate src/features/developer-center/model.test.ts src/features/developer-center/application/developer-application-page.test.tsx src/features/developer-center/publisher/access.test.ts src/features/developer-center/publisher/access-query.test.ts src/features/developer-center/publisher/onboarding-panel.test.tsx src/features/developer-center/publisher/submit-page.test.tsx src/features/developer-center/publisher/artifact-upload-controller.test.ts
pnpm.cmd --filter @kortix/sdk exec bun test --isolate src/core/rest/projects-client/developer-modules.test.ts src/core/client/kortix.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend typecheck
```

Record the exact tests and the known Web typecheck baseline separately.

- [ ] **Step 4: Exercise the live local API contract**

Start or reuse the local stack after checking ports. Create one confirmed local
user, obtain a Supabase JWT, submit an application through
`POST /v1/developer/applications`, and use an Admin AAL2 session to call:

```text
GET  /v1/admin/developer/applications?state=submitted&limit=50
GET  /v1/admin/developer/applications/{applicationId}
POST /v1/admin/developer/applications/{applicationId}/decision
```

Assert exact status codes and fields. Repeat the decision with the stale revision
and assert `409 {"error":"DEVELOPER_APPLICATION_CONFLICT"}`. Read the applicant
state back and assert `state: "approved"` and `revision: 1`.

- [ ] **Step 5: Exercise the real Admin and Web UI locally**

Use Chromium/Playwright against the running local Admin and Web applications:

1. Open `/developer-applications`, select Submitted, and verify the submitted row.
2. Open the detail, enter a reason, approve, and observe the network decision body.
3. Sign in as the same user in Web, open `/developer/apply`, and verify approved state.
4. Create a Publisher, verify the exact SDK-backed request, and observe it selected.
5. Open `/developer/modules/submit`, choose Package upload, and verify no free-form
   Publisher ID exists.
6. Select a package and assert the upload request carries the selected Publisher ID.

Capture DOM assertions, network payloads, and desktop/mobile-width screenshots.
Do not deploy or bind a real domain in this task.

- [ ] **Step 6: Run repository integrity checks**

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate -12
git diff --name-status 894029f78..HEAD
```

Expected: only the paths listed in this plan are committed; the protected
`2026-08-01-openopc-developer-sdk-newapi-zpay.md` remains exactly one untracked
file; no secrets, installers, deployment state, or unrelated files appear.

- [ ] **Step 7: Report honest completion status**

Report:

1. exact commits and changed surfaces;
2. RED and GREEN evidence with test counts;
3. API/Admin/Web/SDK typecheck and build results;
4. live local HTTP and browser evidence;
5. the known Web typecheck baseline, if still present;
6. deployment, custom domains, AI/payment live checks, and public-beta release as
   still outside this work package.
