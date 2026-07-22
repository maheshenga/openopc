# Automation Browser Approval Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a default-disabled, automatically redispatched Browser approval-resume loop that issues lease-bound one-time credentials and atomically consumes the approval while starting exactly one external-effect Step.

**Architecture:** Keep the existing coordinator/poller as the only scheduler. A PostgreSQL Resume Attempt store selects `approved + pending` Browser candidates, issues a credential after a fresh lease claim, and atomically performs `Approval approved -> consumed`, `Step pending -> running`, and `Job dispatched -> running`; a versioned signed dispatch envelope carries the raw credential only to a capable Worker, which calls an authenticated internal consume endpoint immediately before the external effect.

**Tech Stack:** TypeScript, Bun tests/runtime, Zod contracts, Drizzle ORM, PostgreSQL row locks and conditional updates, Hono internal routes, authenticated mTLS-attested Worker HTTP, signed WebSocket dispatch, Playwright Worker adapters, Biome.

## Global Constraints

- The approved design is `docs/specs/2026-07-23-automation-browser-approval-resume-design.md` at commit `6e3844a0b`.
- Keep all production behavior default-disabled.
- Do not modify or wire `apps/automation-control/src/main.ts` or the Browser Worker production entrypoint in this plan.
- Do not create a second scheduler or poll loop; Browser resume must compose with the existing `startAutomationDispatchPolling()` path.
- Preserve the ordinary `automation.v1` dispatch envelope and all existing Desktop behavior.
- Use a distinct `browser.approval-resume.v1` envelope capability; an old or disabled Worker must reject it before queueing work.
- The raw Resume Token may exist only in the issuer return value, the signed dispatch envelope, and the authenticated consume request. Never persist or log it.
- Persist only the bound token hash. Bind it to account, project, Approval, Job, Step, Action Hash, Lease ID/owner, kill-switch generation, Attempt, resume cursor, and expiry.
- Resume Attempt expiry is the earliest of the approved Approval expiry, current lease expiry, and Job deadline.
- `consumeAndStart()` must atomically perform `Approval approved -> consumed`, `Step pending -> running`, `Job dispatched -> running`, Attempt `issued -> consumed`, and insert the internal `job_started` audit event.
- Because `consumeAndStart()` starts the approved Step, the Worker must not emit a second `step_started` event for that Step.
- A consumed/running Step is never automatically replayed. Unknown dispatch results remain fenced until lease expiry.
- Never expose the new `approval-resume.v1` Token through public approval routes. Preserve the existing one-time `approval.v1` response and do not modify the Web, desktop, mobile, SDK, or public `/v1/automation/*` response shape.
- Run every focused RED/GREEN test and typecheck listed below, then run the full repository test suite with `pnpm.cmd test`. Full unit/integration coverage still does not constitute Browser E2E or production deployment proof.
- Do not modify or commit these protected, pre-existing untracked files:
  - `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`
  - `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`

## File Map

### Shared contracts

- Modify `packages/intelligence-contracts/src/automation.ts`: versioned Resume capability, dispatch-envelope union, consume request/response schemas, receipt capability declaration, and internal path constant.
- Modify `packages/intelligence-contracts/src/automation.test.ts`: strict parsing, binding, redaction, old-envelope compatibility, and disabled-capability cases.

### Database

- Modify `packages/db/src/schema/kortix.ts`: Resume Attempt enum, table, constraints, indexes, and relations.
- Modify `packages/db/src/index.ts`: export the new enum/table/relations.
- Modify `packages/db/src/automation-schema.test.ts`: schema and migration assertions.
- Create `packages/db/migrations/20260723120000000_automation_browser_approval_resume.sql`: idempotent enum/table/index migration.

### Automation Control

- Create `apps/automation-control/src/dispatch/browser-approval-resume-store.ts`: candidate selection, credential issue, bound hashing, expiry, and atomic consume/start transaction.
- Create `apps/automation-control/src/dispatch/browser-approval-resume-store.postgres.test.ts`: transaction, concurrency, rollback, negative binding, and idempotency tests.
- Create `apps/automation-control/src/dispatch/worker-http-auth.ts`: shared bounded-body and mTLS-attestation verification used by Worker-originated internal HTTP routes.
- Modify `apps/automation-control/src/dispatch/heartbeat-route.ts` and `.test.ts`: delegate unchanged heartbeat authentication to the shared helper.
- Create `apps/automation-control/src/dispatch/browser-approval-resume-route.ts` and `.test.ts`: authenticated `consume-and-start` HTTP adapter.
- Modify `apps/automation-control/src/dispatch/browser-dispatcher.ts` and `dispatch.test.ts`: construct and validate the Resume envelope and capability receipt.
- Modify `apps/automation-control/src/dispatch/browser-worker-connection.ts` and `.test.ts`: transport the envelope union without changing ordinary dispatch.
- Create `apps/automation-control/src/dispatch/browser-approval-resume-coordinator.ts` and `.test.ts`: fresh lease claim, Attempt issue, dispatch, and lease-fencing decisions.
- Create `apps/automation-control/src/dispatch/browser-approval-resume-runtime.ts` and `.test.ts`: default-disabled testable composition factory without production entrypoint wiring.
- Modify `apps/automation-control/src/dispatch/poller.ts` and `.test.ts`: compose Desktop and Browser `runOnce()` work behind one poll tick.
- Modify `apps/automation-control/src/config.ts`: add the default-false Control feature gate.
- Modify `apps/automation-control/src/server.test.ts` and `dispatch/runtime.test.ts`: keep typed config fixtures and existing disabled/Desktop behavior compatible with the added gate.

### Browser Worker

- Modify `apps/automation-browser-worker/src/config.ts`: default-false Resume capability declaration.
- Modify `apps/automation-browser-worker/src/dispatch-source.ts` and `.test.ts`: reject Resume envelopes unless enabled and advertise capability in the signed receipt.
- Create `apps/automation-browser-worker/src/approval-resume-client.ts` and `.test.ts`: authenticated mTLS consume client with bounded responses and no automatic replay.
- Create `apps/automation-browser-worker/src/approval-resume.ts` and `.test.ts`: bind one dispatch credential to exactly one Action Runner Step.
- Modify `apps/automation-browser-worker/src/action-runner.ts` and `.test.ts`: accept the richer consumed binding and skip duplicate `step_started` emission.
- Modify `apps/automation-browser-worker/src/worker.ts` and `.test.ts`: thread the Resume consumer through the isolated execution factory without changing the fail-closed production entrypoint.

---

### Task 1: Versioned shared Resume contracts

**Files:**
- Modify: `packages/intelligence-contracts/src/automation.ts:4-7, 688-774`
- Modify: `packages/intelligence-contracts/src/automation.test.ts:158-241`

**Interfaces:**
- Produces `AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH`.
- Produces literal capability `browser.approval-resume.v1`.
- Produces `AutomationBrowserApprovalResumeDispatchEnvelope` as the second member of the existing Browser envelope union.
- Produces `AutomationBrowserApprovalConsumeRequest` and `AutomationBrowserApprovalConsumeAccepted`.
- Existing standard Browser envelopes and receipts without a capability list remain valid.

- [ ] **Step 1: Add RED contract tests**

Extend the dispatch-contract test with the exact Resume fixture:

```ts
const resumeEnvelope = automation.AutomationBrowserDispatchEnvelopeSchema.parse({
  ...envelope,
  dispatch_kind: 'browser.approval-resume.v1',
  approval_resume: {
    approval_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    attempt_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    step_id: request.steps[0]?.step_id,
    action_hash: request.steps[0]?.action_hash,
    token: `approval-resume.v1.${'A'.repeat(43)}`,
    expires_at: '2099-01-01T00:00:00.000Z',
  },
});

expect(resumeEnvelope.dispatch_kind).toBe('browser.approval-resume.v1');
expect(automation.AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH).toBe(
  '/internal/automation/browser/approvals/consume',
);
expect(
  automation.AutomationBrowserDispatchEnvelopeSchema.safeParse({
    ...resumeEnvelope,
    approval_resume: {
      ...resumeEnvelope.approval_resume,
      action_hash: `sha256:${'0'.repeat(64)}`,
    },
  }).success,
).toBeFalse();
expect(JSON.stringify(resumeEnvelope)).toContain('approval-resume.v1.');
```

Add consume request/response coverage:

```ts
const consume = automation.AutomationBrowserApprovalConsumeRequestSchema.parse({
  protocol_version: 'automation.v1',
  proof: controlProof,
  consume: {
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    job_id: JOB_ID,
    approval_id: resumeEnvelope.approval_resume.approval_id,
    attempt_id: resumeEnvelope.approval_resume.attempt_id,
    step_id: resumeEnvelope.approval_resume.step_id,
    action_hash: resumeEnvelope.approval_resume.action_hash,
    lease_id: LEASE_ID,
    lease_owner: lease.owner,
    kill_switch_generation: lease.kill_switch_generation,
    resume_after_sequence: envelope.resume_after_sequence,
    token: resumeEnvelope.approval_resume.token,
    requested_at: '2026-07-23T00:00:02.000Z',
  },
});
expect(consume.consume.token).toStartWith('approval-resume.v1.');

expect(
  automation.AutomationBrowserApprovalConsumeAcceptedSchema.parse({
    protocol_version: 'automation.v1',
    consumed: true,
    idempotent: false,
    approval_id: consume.consume.approval_id,
    attempt_id: consume.consume.attempt_id,
    job_id: JOB_ID,
    step_id: consume.consume.step_id,
    started_at: '2026-07-23T00:00:02.000Z',
  }),
).not.toHaveProperty('token');
```

- [ ] **Step 2: Run the contract RED**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts -t "Browser Worker dispatch"
```

Expected: FAIL because the path, capability, Resume envelope member, and consume schemas do not exist.

- [ ] **Step 3: Add the versioned schemas**

Add these constants and schemas, reusing the existing common Browser envelope refinement for both union members:

```ts
export const AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH =
  '/internal/automation/browser/approvals/consume' as const;

export const AutomationBrowserCapabilitySchema = z.enum(['browser.approval-resume.v1']);
export type AutomationBrowserCapability = z.infer<typeof AutomationBrowserCapabilitySchema>;

export const AutomationBrowserApprovalResumeBindingSchema = z
  .object({
    approval_id: UuidSchema,
    attempt_id: UuidSchema,
    step_id: UuidSchema,
    action_hash: Sha256HashSchema,
    token: z.string().regex(/^approval-resume\.v1\.[A-Za-z0-9_-]{43}$/),
    expires_at: DateTimeSchema,
  })
  .strict();

const AutomationBrowserDispatchCommonShape = {
  protocol_version: AutomationProtocolVersionSchema,
  request: AutomationJobRequestSchema,
  lease: AutomationLeaseSchema,
  policy_version: z.string().trim().min(1).max(128),
  resume_after_sequence: z.number().int().nonnegative().max(AUTOMATION_MAX_STEPS),
  dispatched_at: DateTimeSchema,
} as const;

export const AutomationBrowserStandardDispatchEnvelopeSchema = z
  .object(AutomationBrowserDispatchCommonShape)
  .strict()
  .superRefine(validateBrowserDispatchEnvelope);

export const AutomationBrowserApprovalResumeDispatchEnvelopeSchema = z
  .object({
    ...AutomationBrowserDispatchCommonShape,
    dispatch_kind: z.literal('browser.approval-resume.v1'),
    approval_resume: AutomationBrowserApprovalResumeBindingSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateBrowserDispatchEnvelope(value, context);
    const step = value.request.steps.find(
      (candidate) => candidate.step_id === value.approval_resume.step_id,
    );
    if (
      step === undefined ||
      step.action_hash !== value.approval_resume.action_hash ||
      step.sequence <= value.resume_after_sequence ||
      Date.parse(value.approval_resume.expires_at) > Date.parse(value.lease.expires_at)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval_resume'],
        message: 'browser approval resume binding is inconsistent',
      });
    }
  });

export const AutomationBrowserDispatchEnvelopeSchema = z.union([
  AutomationBrowserStandardDispatchEnvelopeSchema,
  AutomationBrowserApprovalResumeDispatchEnvelopeSchema,
]);
```

Move the body of the current envelope `.superRefine()` into:

```ts
function validateBrowserDispatchEnvelope(
  envelope: z.infer<z.ZodObject<typeof AutomationBrowserDispatchCommonShape>>,
  context: z.RefinementCtx,
): void {
  if (
    envelope.request.execution_domain !== 'browser' ||
    envelope.request.browser_policy === null ||
    envelope.lease.execution_domain !== 'browser' ||
    envelope.lease.project_id !== envelope.request.project_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lease'],
      message: 'browser dispatch authority is inconsistent',
    });
  }
  const dispatchedAt = Date.parse(envelope.dispatched_at);
  if (
    Date.parse(envelope.lease.issued_at) > dispatchedAt ||
    Date.parse(envelope.lease.expires_at) <= dispatchedAt ||
    Date.parse(envelope.request.deadline_at) <= dispatchedAt
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dispatched_at'],
      message: 'browser dispatch is outside its authority window',
    });
  }
  if (
    envelope.resume_after_sequence !== 0 &&
    !envelope.request.steps.some(
      (step) => step.sequence === envelope.resume_after_sequence,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resume_after_sequence'],
      message: 'browser dispatch resume cursor is invalid',
    });
  }
}
```

Replace the current inline `.superRefine()` with this helper and call it from both union members; do not leave the old inline copy in place.

Add capability declaration to receipts without breaking old signed receipt bodies:

```ts
capabilities: z.array(AutomationBrowserCapabilitySchema).max(16).optional(),
```

Add strict consume schemas:

```ts
export const AutomationBrowserApprovalConsumeInputSchema = z
  .object({
    account_id: UuidSchema,
    project_id: UuidSchema,
    job_id: UuidSchema,
    approval_id: UuidSchema,
    attempt_id: UuidSchema,
    step_id: UuidSchema,
    action_hash: Sha256HashSchema,
    lease_id: UuidSchema,
    lease_owner: IdentifierSchema,
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resume_after_sequence: z.number().int().nonnegative().max(AUTOMATION_MAX_STEPS),
    token: z.string().regex(/^approval-resume\.v1\.[A-Za-z0-9_-]{43}$/),
    requested_at: DateTimeSchema,
  })
  .strict();

export const AutomationBrowserApprovalConsumeRequestSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    proof: AutomationWorkerServiceProofSchema,
    consume: AutomationBrowserApprovalConsumeInputSchema,
  })
  .strict();

export const AutomationBrowserApprovalConsumeAcceptedSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    consumed: z.literal(true),
    idempotent: z.boolean(),
    approval_id: UuidSchema,
    attempt_id: UuidSchema,
    job_id: UuidSchema,
    step_id: UuidSchema,
    started_at: DateTimeSchema,
  })
  .strict();
```

Export inferred types for every new public schema.

- [ ] **Step 4: Run GREEN, typecheck, and commit**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts
pnpm.cmd --filter @kortix/intelligence-contracts typecheck
git add -- packages/intelligence-contracts/src/automation.ts packages/intelligence-contracts/src/automation.test.ts
git commit -m "feat: define browser approval resume contracts"
```

Expected: the focused contract test file and package typecheck pass; existing ordinary envelope fixtures still parse unchanged.

---

### Task 2: Durable Resume Attempt schema and migration

**Files:**
- Modify: `packages/db/src/schema/kortix.ts:5429-5992`
- Modify: `packages/db/src/index.ts:214-237`
- Modify: `packages/db/src/automation-schema.test.ts:64-268`
- Create: `packages/db/migrations/20260723120000000_automation_browser_approval_resume.sql`

**Interfaces:**
- Produces `automationApprovalResumeAttemptStatusEnum`.
- Produces `automationApprovalResumeAttempts` and relations.
- Enforces at most one `issued` Attempt per Approval.
- Keeps all raw tokens out of the schema.

- [ ] **Step 1: Add schema RED assertions**

Import the new exports and add:

```ts
expect(automationApprovalResumeAttemptStatusEnum.enumValues).toEqual([
  'issued',
  'consumed',
  'expired',
  'rejected',
]);

expect(getTableConfig(automationApprovalResumeAttempts).name).toBe(
  'automation_approval_resume_attempts',
);
expect(columnNames(automationApprovalResumeAttempts)).toEqual(
  expect.arrayContaining([
    'attempt_id',
    'account_id',
    'project_id',
    'approval_id',
    'job_id',
    'step_id',
    'lease_id',
    'lease_owner',
    'kill_switch_generation',
    'resume_after_sequence',
    'action_hash',
    'token_hash',
    'status',
    'issued_at',
    'expires_at',
    'consumed_at',
  ]),
);
expect(indexNames(automationApprovalResumeAttempts)).toEqual(
  expect.arrayContaining([
    'idx_automation_approval_resume_attempts_active_approval',
    'idx_automation_approval_resume_attempts_job_status',
    'idx_automation_approval_resume_attempts_expiry',
  ]),
);
expect(checkConstraintNames(automationApprovalResumeAttempts)).toEqual(
  expect.arrayContaining([
    'automation_approval_resume_attempts_binding_check',
    'automation_approval_resume_attempts_lifecycle_check',
  ]),
);
```

Extend the migration test to read `20260723120000000_automation_browser_approval_resume.sql` and assert that it contains the table, lifecycle check, Approval FK, Job FK, composite Job/Step FK, and the partial active-Attempt index.

- [ ] **Step 2: Run the schema RED**

```powershell
pnpm.cmd --filter @kortix/db exec bun test src/automation-schema.test.ts
```

Expected: FAIL because the enum, table, exports, and migration do not exist.

- [ ] **Step 3: Define the Drizzle schema**

Add:

```ts
export const automationApprovalResumeAttemptStatusEnum = kortixSchema.enum(
  'automation_approval_resume_attempt_status',
  ['issued', 'consumed', 'expired', 'rejected'],
);

export const automationApprovalResumeAttempts = kortixSchema.table(
  'automation_approval_resume_attempts',
  {
    attemptId: uuid('attempt_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    approvalId: uuid('approval_id')
      .notNull()
      .references(() => automationApprovals.approvalId, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => automationJobs.jobId, { onDelete: 'cascade' }),
    stepId: uuid('step_id').notNull(),
    leaseId: uuid('lease_id').notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }).notNull(),
    killSwitchGeneration: bigint('kill_switch_generation', { mode: 'number' }).notNull(),
    resumeAfterSequence: integer('resume_after_sequence').notNull(),
    actionHash: varchar('action_hash', { length: 71 }).notNull(),
    tokenHash: varchar('token_hash', { length: 71 }).notNull(),
    status: automationApprovalResumeAttemptStatusEnum('status').default('issued').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.jobId, table.stepId],
      foreignColumns: [automationJobSteps.jobId, automationJobSteps.stepId],
      name: 'automation_approval_resume_attempts_job_step_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_automation_approval_resume_attempts_active_approval')
      .on(table.approvalId)
      .where(sql`${table.status} = 'issued'`),
    index('idx_automation_approval_resume_attempts_job_status').on(
      table.jobId,
      table.status,
      table.issuedAt,
    ),
    index('idx_automation_approval_resume_attempts_expiry')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'issued'`),
    check(
      'automation_approval_resume_attempts_binding_check',
      sql`${table.killSwitchGeneration} >= 0
        AND ${table.resumeAfterSequence} >= 0
        AND ${table.actionHash} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.tokenHash} ~ '^sha256:[0-9a-f]{64}$'
        AND length(BTRIM(${table.leaseOwner})) BETWEEN 1 AND 128
        AND ${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      'automation_approval_resume_attempts_lifecycle_check',
      sql`(${table.status} = 'consumed' AND ${table.consumedAt} IS NOT NULL)
        OR (${table.status} <> 'consumed' AND ${table.consumedAt} IS NULL)`,
    ),
  ],
);
```

Add relations from Attempt to Approval, Job, and Step, and export all three new schema symbols from `packages/db/src/index.ts`.

- [ ] **Step 4: Add the idempotent SQL migration**

Create the migration with the same enum values, columns, foreign keys, checks, and indexes. Use the repository's `duplicate_object` guard pattern for the enum and constraints:

```sql
DO $automation$
BEGIN
  CREATE TYPE kortix.automation_approval_resume_attempt_status AS ENUM
    ('issued', 'consumed', 'expired', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

CREATE TABLE IF NOT EXISTS kortix.automation_approval_resume_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  approval_id uuid NOT NULL REFERENCES kortix.automation_approvals(approval_id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES kortix.automation_jobs(job_id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  lease_owner varchar(128) NOT NULL,
  kill_switch_generation bigint NOT NULL,
  resume_after_sequence integer NOT NULL,
  action_hash varchar(71) NOT NULL,
  token_hash varchar(71) NOT NULL,
  status kortix.automation_approval_resume_attempt_status NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT automation_approval_resume_attempts_job_step_fk
    FOREIGN KEY (job_id, step_id)
    REFERENCES kortix.automation_job_steps(job_id, step_id)
    ON DELETE CASCADE,
  CONSTRAINT automation_approval_resume_attempts_binding_check CHECK (
    kill_switch_generation >= 0
    AND resume_after_sequence >= 0
    AND action_hash ~ '^sha256:[0-9a-f]{64}$'
    AND token_hash ~ '^sha256:[0-9a-f]{64}$'
    AND length(BTRIM(lease_owner)) BETWEEN 1 AND 128
    AND expires_at > issued_at
  ),
  CONSTRAINT automation_approval_resume_attempts_lifecycle_check CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_approval_resume_attempts_active_approval
  ON kortix.automation_approval_resume_attempts(approval_id)
  WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS idx_automation_approval_resume_attempts_job_status
  ON kortix.automation_approval_resume_attempts(job_id, status, issued_at);
CREATE INDEX IF NOT EXISTS idx_automation_approval_resume_attempts_expiry
  ON kortix.automation_approval_resume_attempts(expires_at)
  WHERE status = 'issued';
```

- [ ] **Step 5: Run focused DB checks and commit**

```powershell
pnpm.cmd --filter @kortix/db exec bun test src/automation-schema.test.ts scripts/lint-migrations.test.ts
pnpm.cmd --filter @kortix/db typecheck
git add -- packages/db/src/schema/kortix.ts packages/db/src/index.ts packages/db/src/automation-schema.test.ts packages/db/migrations/20260723120000000_automation_browser_approval_resume.sql
git commit -m "feat: persist browser approval resume attempts"
```

Expected: schema and migration-lint tests pass; no live migration is executed.

---

### Task 3: Candidate selection and lease-bound Attempt issuance

**Files:**
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-store.ts`
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-store.postgres.test.ts`

**Interfaces:**
- Produces `BrowserApprovalResumeCandidate`.
- Produces `IssuedBrowserApprovalResume` containing the only in-memory copy of the raw Token.
- Produces `BrowserApprovalResumeStore.listCandidates()`, `.issue()`, and the `.consumeAndStart()` signature that Task 4 completes.
- The store does not depend on public routes, the Desktop coordinator, or Worker transport.

- [ ] **Step 1: Define the failing candidate and issuance tests**

Use fixed UUIDs and a transaction-aware fake with these observable operations:

```ts
type FakeState = {
  selections: unknown[][];
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
  transactions: number;
  commits: number;
  rollbacks: number;
  rowLocks: number;
};

type FakeDatabaseOptions = {
  selections: unknown[][];
  failInsert?: boolean;
};
```

The fake must support exactly the chains used by the store:

```ts
select().from().innerJoin().where().orderBy().limit()
select().from().where().orderBy().for('update')
select().from().where().limit().for('update')
update(table).set(values).where().returning(selection)
insert(table).values(values).returning(selection)
transaction(callback)
```

Add these RED cases:

```ts
test('lists only approved pending Browser resume candidates in sequence order', async () => {
  const candidates = await store.listCandidates({ now: NOW, limit: 4 });
  expect(candidates).toEqual([
    expect.objectContaining({
      approvalId: APPROVAL_ID,
      stepId: STEP_ID,
      actionHash: ACTION_HASH,
      resumeAfterSequence: 2,
      approvalExpiresAt: APPROVAL_EXPIRES_AT,
    }),
  ]);
});

test('issues one lease-bound credential and persists only its hash', async () => {
  const issued = await store.issue({ candidate, lease: LEASE, now: NOW });
  expect(issued).toEqual(
    expect.objectContaining({
      attemptId: ATTEMPT_ID,
      approvalId: APPROVAL_ID,
      token: `approval-resume.v1.${'A'.repeat(43)}`,
      expiresAt: LEASE.expires_at,
    }),
  );
  expect(JSON.stringify(state.inserts)).not.toContain(issued?.token);
  expect(state.inserts.at(-1)?.values).toEqual(
    expect.objectContaining({
      attemptId: ATTEMPT_ID,
      leaseId: LEASE.lease_id,
      leaseOwner: LEASE.owner,
      status: 'issued',
      tokenHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }),
  );
});

test('refuses issuance when approval, step, lease, generation, cursor, or expiry changed', async () => {
  for (const changed of invalidLockedSnapshots) {
    const invalidStore = createPostgresBrowserApprovalResumeStore(
      fakeDatabase({ selections: changed.selections }),
      OPTIONS,
    );
    expect(await invalidStore.issue({ candidate, lease: LEASE, now: NOW })).toBeNull();
  }
});
```

The invalid matrix must contain one case each for Approval not `approved`, target Step not `pending`, mismatched `approvalId`, mismatched Action Hash, stale lease owner/ID, changed generation, previous Step not `succeeded`, later Step not `pending`, approval expiry, lease expiry, and Job deadline expiry.

- [ ] **Step 2: Run issuance RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-store.postgres.test.ts -t "issues|candidates|issuance"
```

Expected: FAIL because the store module and exports do not exist.

- [ ] **Step 3: Add the store types and Token codec**

Define these exact public types:

```ts
export type BrowserApprovalResumeCandidate = Readonly<{
  job: AutomationJob;
  approvalId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  resumeAfterSequence: number;
  approvalExpiresAt: string;
}>;

export type IssuedBrowserApprovalResume = Readonly<{
  attemptId: string;
  approvalId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  token: string;
  expiresAt: string;
  resumeAfterSequence: number;
}>;

export type BrowserApprovalResumeConsumeResult =
  | Readonly<{ accepted: true; idempotent: boolean; startedAt: string }>
  | Readonly<{
      accepted: false;
      reason:
        | 'credential_invalid'
        | 'stale_lease'
        | 'dispatch_mismatch'
        | 'approval_terminal'
        | 'conflict';
    }>;

export interface BrowserApprovalResumeStore {
  listCandidates(input: { now: Date; limit: number }): Promise<readonly BrowserApprovalResumeCandidate[]>;
  issue(input: {
    candidate: BrowserApprovalResumeCandidate;
    lease: AutomationLease;
    now: Date;
  }): Promise<IssuedBrowserApprovalResume | null>;
  consumeAndStart(input: AutomationBrowserApprovalConsumeInput & {
    workerId: string;
    now: Date;
  }): Promise<BrowserApprovalResumeConsumeResult>;
}
```

Use a dedicated Token prefix and a peppered, bound hash:

```ts
function issueRawResumeToken(random: (size: number) => Buffer): string {
  return `approval-resume.v1.${random(32).toString('base64url')}`;
}

type BrowserApprovalResumeTokenBinding = Readonly<{
  token: string;
  accountId: string;
  projectId: string;
  approvalId: string;
  jobId: string;
  stepId: string;
  actionHash: string;
  leaseId: string;
  leaseOwner: string;
  killSwitchGeneration: number;
  attemptId: string;
  resumeAfterSequence: number;
  expiresAt: string;
}>;

function boundResumeTokenHash(
  input: BrowserApprovalResumeTokenBinding,
  tokenPepper: string,
): `sha256:${string}` {
  const digest = createHmac('sha256', tokenPepper)
    .update(
      [
        input.token,
        input.accountId,
        input.projectId,
        input.approvalId,
        input.jobId,
        input.stepId,
        input.actionHash,
        input.leaseId,
        input.leaseOwner,
        input.killSwitchGeneration,
        input.attemptId,
        input.resumeAfterSequence,
        input.expiresAt,
      ].join('\0'),
    )
    .digest('hex');
  return `sha256:${digest}`;
}
```

The factory options are:

```ts
export type PostgresBrowserApprovalResumeStoreOptions = Readonly<{
  tokenPepper: string;
  newAttemptId?: () => string;
  randomBytes?: (size: number) => Buffer;
  observe?: (event: BrowserApprovalResumeObservation) => void;
}>;
```

Reject a `tokenPepper` shorter than 32 characters during construction.

- [ ] **Step 4: Implement candidate selection**

`listCandidates()` must use a bounded query (`1 <= limit <= 100`) joining Job, Approval, and target Step, with all of these SQL predicates:

```ts
and(
  eq(automationJobs.executionDomain, 'browser'),
  eq(automationJobs.status, 'dispatched'),
  isNull(automationJobs.cancelRequestedAt),
  gt(automationJobs.deadlineAt, sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`),
  eq(automationApprovals.status, 'approved'),
  gt(automationApprovals.expiresAt, sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`),
  eq(automationJobSteps.status, 'pending'),
  eq(automationJobSteps.approvalId, automationApprovals.approvalId),
  eq(automationJobSteps.actionHash, automationApprovals.actionHash),
)
```

For each bounded row, read that Job's Steps ordered by `sequence`. Keep the row only when all earlier Steps are `succeeded` and all later Steps are `pending`; set `resumeAfterSequence` to the last earlier sequence or `0`. Parse the stored request and returned object through `AutomationJobSchema` before returning it.

- [ ] **Step 5: Implement transactional issuance**

Use the fixed lock order `Job -> Approval -> all Job Steps -> active Attempt`. Inside one transaction:

1. Lock the Job by account/project/job and verify Browser, `dispatched`, current deadline, no cancellation, exact lease owner, generation, and DB lease expiry.
2. Verify `lease_id` is the UUID suffix of `lease.owner`, and the passed signed Lease matches the candidate.
3. Lock the Approval and require `approved`, exact Job/Step/Action Hash, and current expiry.
4. Lock all Steps ordered by sequence; re-prove target `pending`, previous `succeeded`, later `pending`, and exact cursor.
5. Mark only expired `issued` Attempts for this Approval as `expired`.
6. If a current `issued` Attempt remains, return `null` without generating another raw Token.
7. Compute `expiresAt = min(approval.expiresAt, lease.expires_at, job.deadlineAt)` and require it to be after both `clock_timestamp()` and `input.now`.
8. Generate the raw Token, compute the bound hash from the exact values below (including `expiresAt`), insert one `issued` Attempt, and return the raw credential only after insert success.

Persist exactly this shape:

```ts
const tokenHash = boundResumeTokenHash(
  {
    token,
    accountId: candidate.job.account_id,
    projectId: candidate.job.request.project_id,
    approvalId: candidate.approvalId,
    jobId: candidate.job.job_id,
    stepId: candidate.stepId,
    actionHash: candidate.actionHash,
    leaseId: lease.lease_id,
    leaseOwner: lease.owner,
    killSwitchGeneration: lease.kill_switch_generation,
    attemptId,
    resumeAfterSequence: candidate.resumeAfterSequence,
    expiresAt,
  },
  options.tokenPepper,
);

await tx.insert(automationApprovalResumeAttempts).values({
  attemptId,
  accountId: candidate.job.account_id,
  projectId: candidate.job.request.project_id,
  approvalId: candidate.approvalId,
  jobId: candidate.job.job_id,
  stepId: candidate.stepId,
  leaseId: lease.lease_id,
  leaseOwner: lease.owner,
  killSwitchGeneration: lease.kill_switch_generation,
  resumeAfterSequence: candidate.resumeAfterSequence,
  actionHash: candidate.actionHash,
  tokenHash,
  status: 'issued',
  issuedAt: input.now.toISOString(),
  expiresAt,
});
```

Return the issued value and a list of committed observations from the transaction. After commit, call a `safeObserve()` helper that catches sink exceptions. Emit `browser_resume_expired` for every prior Attempt expired by step 5, then `browser_resume_attempt_issued` for the new Attempt; include `traceId: candidate.job.request.traceparent?.split('-')[1] ?? null` and never include the Token or hash.

- [ ] **Step 6: Run issuance GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-store.postgres.test.ts -t "issues|candidates|issuance"
pnpm.cmd --filter @kortix/automation-control typecheck
git add -- apps/automation-control/src/dispatch/browser-approval-resume-store.ts apps/automation-control/src/dispatch/browser-approval-resume-store.postgres.test.ts
git commit -m "feat: issue lease-bound browser resume attempts"
```

Expected: candidate and issuance cases pass; persisted fake state contains no raw Token.

---

### Task 4: Atomic consume-and-start settlement

**Files:**
- Modify: `apps/automation-control/src/dispatch/browser-approval-resume-store.ts`
- Modify: `apps/automation-control/src/dispatch/browser-approval-resume-store.postgres.test.ts`

**Interfaces:**
- Completes `BrowserApprovalResumeStore.consumeAndStart()`.
- Returns idempotent success only for the same already-consumed Attempt and exact binding.
- Starts the Job and Step internally; the Worker must skip its normal `step_started` event in Task 8.

- [ ] **Step 1: Add the success, idempotency, and rollback RED tests**

Add:

```ts
test('atomically consumes an Attempt and starts its Job and Step', async () => {
  const result = await store.consumeAndStart({ ...CONSUME_INPUT, workerId: WORKER_ID, now: NOW });
  expect(result).toEqual({ accepted: true, idempotent: false, startedAt: NOW.toISOString() });
  expect(state.commits).toBe(1);
  expect(state.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ values: expect.objectContaining({ status: 'consumed' }) }),
      expect.objectContaining({ values: expect.objectContaining({ status: 'running' }) }),
    ]),
  );
  expect(state.inserts.at(-1)?.values).toEqual(
    expect.objectContaining({
      type: 'job_started',
      status: 'running',
      workerId: null,
      workerLeaseId: null,
      workerOrdinal: null,
    }),
  );
});

test('returns idempotent success for the same consumed Attempt only', async () => {
  const result = await consumedStore.consumeAndStart({
    ...CONSUME_INPUT,
    workerId: WORKER_ID,
    now: LATER,
  });
  expect(result).toEqual({ accepted: true, idempotent: true, startedAt: NOW.toISOString() });
  expect(consumedState.updates).toHaveLength(0);
  expect(consumedState.inserts).toHaveLength(0);
});

test('rolls back Approval, Step, Job, Attempt, and event on every write failure', async () => {
  for (const failTarget of ['attempt', 'approval', 'step', 'job', 'event'] as const) {
    const failing = transactionalFake({ failTarget });
    await expect(
      createPostgresBrowserApprovalResumeStore(failing.db, OPTIONS).consumeAndStart({
        ...CONSUME_INPUT,
        workerId: WORKER_ID,
        now: NOW,
      }),
    ).rejects.toThrow();
    expect(failing.state.commits).toBe(0);
    expect(failing.state.rollbacks).toBe(1);
    expect(failing.state.committedUpdates).toHaveLength(0);
    expect(failing.state.committedInserts).toHaveLength(0);
  }
});
```

Add one table-driven rejection for every `BrowserApprovalResumeConsumeResult.reason`, plus cross-account, cross-project, wrong lease owner, old generation, wrong cursor, wrong Action Hash, expired Attempt, rejected Approval, and already-running Step from another Attempt. Worker identity/proof mismatches belong in Task 5's authenticated route tests; the lease owner is the Control-issued fencing owner, not the Worker service ID.

- [ ] **Step 2: Run consume RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-store.postgres.test.ts -t "consumes|idempotent|rolls back|rejects"
```

Expected: FAIL because `consumeAndStart()` is not implemented.

- [ ] **Step 3: Implement constant-time credential verification**

Parse the input with `AutomationBrowserApprovalConsumeInputSchema`. The authenticated route supplies `workerId`, but do not derive the lease owner from it: Browser leases are claimed by the Control coordinator. Define the constant-time comparison before opening the transaction:

```ts
const hashesEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};
```

Never return a different HTTP-visible message for a missing Attempt versus a bad Token; both map to `credential_invalid`.

- [ ] **Step 4: Implement the single settlement transaction**

Use the same fixed lock order as issuance: `Job -> Approval -> all Job Steps -> Attempt`. Select and lock the four row groups by identity/tenant without filtering out `running`, `consumed`, or terminal states yet; the second same-Attempt transaction must be able to inspect the state committed by the first. After locking the Attempt, calculate the candidate hash from the raw Token plus the **persisted** Attempt binding, not the request binding:

```ts
const candidateHash = boundResumeTokenHash(
  {
    token: parsed.token,
    accountId: attempt.accountId,
    projectId: attempt.projectId,
    approvalId: attempt.approvalId,
    jobId: attempt.jobId,
    stepId: attempt.stepId,
    actionHash: attempt.actionHash,
    leaseId: attempt.leaseId,
    leaseOwner: attempt.leaseOwner,
    killSwitchGeneration: attempt.killSwitchGeneration,
    attemptId: attempt.attemptId,
    resumeAfterSequence: attempt.resumeAfterSequence,
    expiresAt: attempt.expiresAt,
  },
  options.tokenPepper,
);
if (!hashesEqual(attempt.tokenHash, candidateHash)) {
  return { accepted: false, reason: 'credential_invalid' };
}
```

Only after this proof of Token possession classify requester-field mismatches as `stale_lease` or `dispatch_mismatch`; cross-account/project lookup misses and bad Tokens both remain `credential_invalid`. Check Task 4 Step 5's exact idempotent state first. If it matches, return read-only idempotent success. Otherwise, the first-consume path requires all of these before any writes:

- Job must match account/project/job, be `dispatched`, have the exact current owner/generation, a current lease, no cancellation, and a current deadline.
- Approval must match Job/Step/Action Hash and be `approved`.
- Target Step must be `pending`, reference the Approval, and have the exact Action Hash.
- Earlier Steps must be `succeeded`; later Steps must be `pending`; computed cursor must match.
- Attempt must match every binding field, be `issued`, be unexpired, and have the constant-time matching Token hash.

For a valid Token with a permanent `dispatch_mismatch`, `approval_terminal`, or competing-Attempt `conflict`, conditionally change the current `issued` Attempt to `rejected` and emit `browser_resume_rejected` only after commit. For an expired Attempt, conditionally change it to `expired` and emit `browser_resume_expired`. A bad Token never mutates the Attempt; a stale but not-yet-expired lease remains fenced until expiry.

Apply conditional updates in this order and throw a private conflict error if any `.returning()` yields no row:

```ts
await tx
  .update(automationApprovalResumeAttempts)
  .set({ status: 'consumed', consumedAt: startedAt })
  .where(
    and(
      eq(automationApprovalResumeAttempts.attemptId, parsed.attempt_id),
      eq(automationApprovalResumeAttempts.status, 'issued'),
      gt(automationApprovalResumeAttempts.expiresAt, sql`clock_timestamp()`),
    ),
  )
  .returning({ attemptId: automationApprovalResumeAttempts.attemptId });

await tx
  .update(automationApprovals)
  .set({ status: 'consumed' })
  .where(
    and(
      eq(automationApprovals.approvalId, parsed.approval_id),
      eq(automationApprovals.status, 'approved'),
      eq(automationApprovals.actionHash, parsed.action_hash),
    ),
  )
  .returning({ approvalId: automationApprovals.approvalId });

await tx
  .update(automationJobSteps)
  .set({ status: 'running', startedAt })
  .where(
    and(
      eq(automationJobSteps.jobId, parsed.job_id),
      eq(automationJobSteps.stepId, parsed.step_id),
      eq(automationJobSteps.status, 'pending'),
      eq(automationJobSteps.approvalId, parsed.approval_id),
      eq(automationJobSteps.actionHash, parsed.action_hash),
    ),
  )
  .returning({ stepId: automationJobSteps.stepId });

await tx
  .update(automationJobs)
  .set({ status: 'running', updatedAt: startedAt })
  .where(
    and(
      eq(automationJobs.accountId, parsed.account_id),
      eq(automationJobs.projectId, parsed.project_id),
      eq(automationJobs.jobId, parsed.job_id),
      eq(automationJobs.status, 'dispatched'),
      eq(automationJobs.leaseOwner, parsed.lease_owner),
      eq(automationJobs.killSwitchGeneration, parsed.kill_switch_generation),
      gt(automationJobs.leaseExpiresAt, sql`clock_timestamp()`),
    ),
  )
  .returning({ jobId: automationJobs.jobId });
```

Require every `.returning()` result to contain exactly one row. Throw inside the transaction on the first empty result so all preceding updates roll back.

Use `resolveAutomationEventStatus()` and `materializeAutomationEvent()` to insert one internal `job_started` event with:

```ts
event: {
  protocol_version: 'automation.v1',
  type: 'job_started',
  status: 'running',
  payload: {
    execution_domain: 'browser',
    approval_id: parsed.approval_id,
    attempt_id: parsed.attempt_id,
    step_id: parsed.step_id,
    resume_after_sequence: parsed.resume_after_sequence,
  },
  trace_id: null,
},
transition: { type: 'started' },
```

The event has null Worker receipt columns because Control commits it before the external effect.

- [ ] **Step 5: Add exact same-Attempt idempotency**

When the locked Attempt is already `consumed`, return idempotent success only when all of these are true:

```ts
approval.status === 'consumed' &&
step.status === 'running' &&
job.status === 'running' &&
attempt.consumedAt !== null &&
attempt.tokenHash === candidateHash &&
attempt.accountId === parsed.account_id &&
attempt.projectId === parsed.project_id &&
attempt.approvalId === parsed.approval_id &&
attempt.jobId === parsed.job_id &&
attempt.stepId === parsed.step_id &&
attempt.actionHash === parsed.action_hash &&
attempt.leaseId === parsed.lease_id &&
attempt.leaseOwner === parsed.lease_owner &&
attempt.killSwitchGeneration === parsed.kill_switch_generation &&
attempt.resumeAfterSequence === parsed.resume_after_sequence &&
approval.jobId === parsed.job_id &&
approval.stepId === parsed.step_id &&
step.jobId === parsed.job_id &&
step.stepId === parsed.step_id &&
job.accountId === parsed.account_id &&
job.projectId === parsed.project_id
```

Do not insert another event or update timestamps. After the read-only transaction succeeds, emit `browser_resume_duplicate` through `safeObserve()`. Every other terminal/started combination is `conflict` or `approval_terminal`.

- [ ] **Step 6: Add redacted observations**

Define:

```ts
export type BrowserApprovalResumeObservation = Readonly<{
  type:
    | 'browser_resume_attempt_issued'
    | 'browser_resume_dispatched'
    | 'browser_resume_consumed'
    | 'browser_resume_rejected'
    | 'browser_resume_expired'
    | 'browser_resume_duplicate';
  jobId: string;
  stepId: string;
  approvalId: string;
  attemptId: string;
  traceId: string | null;
  reason?: Extract<BrowserApprovalResumeConsumeResult, { accepted: false }>['reason'];
  occurredAt: string;
}>;
```

Call `observe` only after commit/known rejection and always through a sink-exception guard. Emit `browser_resume_consumed` after a first successful settlement, `browser_resume_rejected` after the committed rejection transition, `browser_resume_expired` after the committed expiry transition, and `browser_resume_duplicate` after verified idempotent success. Tests must assert `JSON.stringify(observation)` contains neither the raw Token nor `tokenHash`.
The observation sink derives success rate, consume latency, expiry/rejection/duplicate counts, and Worker-unavailable duration from issued/dispatched/terminal timestamps. This phase exposes the typed hook but does not mount a production metrics exporter.

- [ ] **Step 7: Run settlement GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-store.postgres.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
git add -- apps/automation-control/src/dispatch/browser-approval-resume-store.ts apps/automation-control/src/dispatch/browser-approval-resume-store.postgres.test.ts
git commit -m "feat: atomically consume browser resume approvals"
```

Expected: success, idempotency, negative matrix, redaction, and rollback tests pass.

---

### Task 5: Worker-authenticated consume-and-start route

**Files:**
- Create: `apps/automation-control/src/dispatch/worker-http-auth.ts`
- Modify: `apps/automation-control/src/dispatch/heartbeat-route.ts`
- Modify: `apps/automation-control/src/dispatch/heartbeat-route.test.ts`
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-route.ts`
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-route.test.ts`

**Interfaces:**
- Produces `authenticateWorkerHttpRequest()` for body-bound TLS attestation shared by heartbeat and approval consumption.
- Preserves `createWorkerTlsAttestationHeaders()` as an export from `heartbeat-route.ts` for existing callers.
- Produces an unmounted Hono route at `AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH`.
- Maps stable internal rejection reasons to existing public `AutomationError` codes without revealing Token validity.

- [ ] **Step 1: Add heartbeat refactor regression and new route RED tests**

Keep all existing heartbeat tests. Add one assertion that the original header helper remains importable after extraction:

```ts
expect(
  createWorkerTlsAttestationHeaders({
    secret: TLS_SECRET,
    timestamp: NOW,
    method: 'POST',
    path: AUTOMATION_BROWSER_HEARTBEAT_PATH,
    body,
    certificate: WORKER_CERTIFICATE,
  }),
).toHaveProperty('x-automation-worker-tls-attestation');
```

In the new route test, create a request with the shared contract and body-bound attestation:

```ts
const consume = AutomationBrowserApprovalConsumeInputSchema.parse(CONSUME_INPUT);
const proof = authenticator.sign({
  serviceId: WORKER_ID,
  certificateFingerprint256: WORKER_FINGERPRINT,
  timestamp: NOW,
  nonce: 41,
  body: consume,
});
const body = JSON.stringify({ protocol_version: 'automation.v1', proof, consume });
const headers = createWorkerTlsAttestationHeaders({
  secret: TLS_SECRET,
  timestamp: NOW,
  method: 'POST',
  path: AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  body,
  certificate: WORKER_CERTIFICATE,
});
const response = await route.fetch(
  new Request(`https://control.internal${AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  }),
);
expect(response.status).toBe(200);
expect(await response.json()).toEqual(
  expect.objectContaining({ consumed: true, attempt_id: ATTEMPT_ID, idempotent: false }),
);
```

Add RED cases for altered body after attestation, wrong certificate, wrong proof service ID, replayed proof nonce, oversized body, timed-out body, stale lease result, generic credential rejection, dependency throw, and response redaction. The response body must never contain the raw Token, token hash, or the string `credential_invalid`.

- [ ] **Step 2: Run route RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-route.test.ts src/dispatch/heartbeat-route.test.ts
```

Expected: FAIL because the shared helper and Resume route do not exist.

- [ ] **Step 3: Extract the shared HTTP authentication helper**

Move, without semantic changes, the heartbeat route's header names, TLS-attestation canonicalization, timing-safe signature comparison, bounded streaming body reader, and certificate validation into `worker-http-auth.ts`.

Expose this exact result type:

```ts
export type AuthenticatedWorkerHttpRequest =
  | Readonly<{
      accepted: true;
      peer: VerifiedWorkerPeer;
      body: Uint8Array;
    }>
  | Readonly<{
      accepted: false;
      reason: 'unauthorized' | 'too_large' | 'timed_out' | 'unavailable';
    }>;

export async function authenticateWorkerHttpRequest(input: {
  request: Request;
  expectedPath: string;
  tlsAttestationSecret: string;
  authenticator: Pick<WorkerServiceAuthenticator, 'bindTlsPeer'>;
  now: Date;
  maxSkewMs: number;
  maxBodyBytes: number;
  bodyReadTimeoutMs: number;
}): Promise<AuthenticatedWorkerHttpRequest>;
```

The helper must bind the attestation to `request.method`, the exact pathname plus search string, and the raw bounded body. It returns a `VerifiedWorkerPeer` only after `bindTlsPeer()` succeeds. It does not parse JSON or verify the body proof.

Refactor `createBrowserWorkerHeartbeatRoute()` to call this helper and preserve its current status/error mapping. Re-export `createWorkerTlsAttestationHeaders` from `heartbeat-route.ts`:

```ts
export { createWorkerTlsAttestationHeaders } from './worker-http-auth';
```

- [ ] **Step 4: Implement the consume route**

Define dependencies:

```ts
export type BrowserApprovalResumeRouteDependencies = Readonly<{
  tlsAttestationSecret: string;
  authenticator: Pick<WorkerServiceAuthenticator, 'bindTlsPeer' | 'verify'>;
  store: Pick<BrowserApprovalResumeStore, 'consumeAndStart'>;
  now?: () => Date;
  maxSkewMs?: number;
  maxBodyBytes?: number;
  bodyReadTimeoutMs?: number;
}>;
```

The route sequence is fixed:

```ts
const authenticated = await authenticateWorkerHttpRequest({
  request: context.req.raw,
  expectedPath: AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  tlsAttestationSecret: dependencies.tlsAttestationSecret,
  authenticator: dependencies.authenticator,
  now: checkedAt,
  maxSkewMs,
  maxBodyBytes,
  bodyReadTimeoutMs,
});
if (!authenticated.accepted) return mapAuthenticationFailure(authenticated.reason);

const parsed = AutomationBrowserApprovalConsumeRequestSchema.safeParse(
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(authenticated.body)),
);
if (!parsed.success || parsed.data.proof.service_id !== authenticated.peer.serviceId) {
  return unauthorized();
}
await dependencies.authenticator.verify({
  peer: authenticated.peer,
  expectedRole: 'browser-worker',
  proof: parsed.data.proof,
  body: parsed.data.consume,
});
const result = await dependencies.store.consumeAndStart({
  ...parsed.data.consume,
  workerId: authenticated.peer.serviceId,
  now: checkedAt,
});
```

Map results exactly:

| Store result | HTTP | `AutomationError.code` | Retryable |
| --- | ---: | --- | --- |
| accepted | 200 | n/a | n/a |
| `stale_lease` | 409 | `AUTOMATION_LEASE_EXPIRED` | false |
| all other rejection reasons | 409 | `AUTOMATION_CONFLICT` | false |
| nonce replay | 409 | `AUTOMATION_CONFLICT` | false |
| invalid certificate/proof | 401 | `AUTOMATION_UNAUTHORIZED` | false |
| dependency/configuration failure | 503 | `AUTOMATION_UNAVAILABLE` | true |

Build success only through `AutomationBrowserApprovalConsumeAcceptedSchema`; build failures only through `AutomationErrorSchema` with generic messages.

- [ ] **Step 5: Run route GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-route.test.ts src/dispatch/heartbeat-route.test.ts src/dispatch/worker-auth-nonce.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
git add -- apps/automation-control/src/dispatch/worker-http-auth.ts apps/automation-control/src/dispatch/heartbeat-route.ts apps/automation-control/src/dispatch/heartbeat-route.test.ts apps/automation-control/src/dispatch/browser-approval-resume-route.ts apps/automation-control/src/dispatch/browser-approval-resume-route.test.ts
git commit -m "feat: authenticate browser approval consumption"
```

Expected: both internal routes pass their authentication, bounded-body, replay, and redaction suites.

---

### Task 6: Browser Worker approval-consume client

**Files:**
- Create: `apps/automation-browser-worker/src/approval-resume-client.ts`
- Create: `apps/automation-browser-worker/src/approval-resume-client.test.ts`

**Interfaces:**
- Produces `BrowserApprovalResumeClient.consume()`.
- Requires a caller-supplied global `nextNonce`; it must be shared with heartbeat in the future production composition.
- Sends exactly one request per call and never retries automatically.

- [ ] **Step 1: Add client RED tests**

Define a fake transport that captures URL, headers, body, and call count. Add:

```ts
test('sends one signed mTLS consume request and returns the bound receipt', async () => {
  const result = await client.consume(CONSUME_INPUT);
  expect(result).toEqual({
    consumed: true,
    idempotent: false,
    approvalId: APPROVAL_ID,
    attemptId: ATTEMPT_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    startedAt: NOW.toISOString(),
  });
  expect(transport.calls).toHaveLength(1);
  expect(transport.calls[0]?.url).toBe(
    `https://control.internal${AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH}`,
  );
  expect(JSON.parse(String(transport.calls[0]?.init.body))).toEqual(
    expect.objectContaining({
      protocol_version: 'automation.v1',
      proof: expect.objectContaining({ service_id: WORKER_ID, nonce: 101 }),
      consume: CONSUME_INPUT,
    }),
  );
});

test('does not retry transport or unknown-result failures', async () => {
  await expect(client.consume(CONSUME_INPUT)).rejects.toMatchObject({ reason: 'transport' });
  expect(transport.calls).toHaveLength(1);
});
```

Add cases for non-monotonic nonce, caller abort, request timeout, response over 64 KiB, malformed JSON, mismatched IDs, `AUTOMATION_LEASE_EXPIRED`, `AUTOMATION_CONFLICT`, and `AUTOMATION_UNAVAILABLE`.

- [ ] **Step 2: Run client RED**

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/approval-resume-client.test.ts
```

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement the client contract and proof**

Define:

```ts
export type BrowserApprovalResumeTransport = (
  input: string | URL,
  init: BunFetchRequestInit,
) => Promise<Response>;

export type BrowserApprovalResumeClient = Readonly<{
  consume(input: AutomationBrowserApprovalConsumeInput): Promise<Readonly<{
    consumed: true;
    idempotent: boolean;
    approvalId: string;
    attemptId: string;
    jobId: string;
    stepId: string;
    startedAt: string;
  }>>;
}>;

export class BrowserApprovalResumeClientError extends Error {
  override readonly name = 'BrowserApprovalResumeClientError';
  constructor(
    readonly reason: 'configuration' | 'transport' | 'protocol' | 'rejected',
    message: string,
    readonly response?: Readonly<{ status: number; code: string; retryable: boolean }>,
  ) {
    super(message);
  }
}
```

Factory input:

```ts
export function createBrowserApprovalResumeClient(input: {
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  requestTimeoutMs: number;
  transport: BrowserApprovalResumeTransport;
  nextNonce: () => number;
  now?: () => Date;
}): BrowserApprovalResumeClient;
```

Require `controlUrl` to be an HTTPS origin with no credentials, path, query, or fragment; require `serviceId` to match `^[A-Za-z][A-Za-z0-9._:-]{0,127}$`; require a 1-256 character fingerprint without CR/LF, a 32-4096 character secret, and an integer timeout from 1-30000 ms. Resolve `AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH` against that origin. Sign `consume` with `canonicalAutomationWorkerProof()` and the caller-supplied nonce:

```ts
const timestamp = now().toISOString();
const nonce = input.nextNonce();
if (!Number.isSafeInteger(nonce) || nonce < 1 || nonce <= lastNonce) {
  throw new BrowserApprovalResumeClientError('configuration', 'Resume nonce is invalid');
}
lastNonce = nonce;
const bodySha256 = createHash('sha256')
  .update(canonicalAutomationRequestJson(consume))
  .digest('hex');
const proof = {
  service_id: input.serviceId,
  timestamp,
  nonce,
  signature: `hmac-sha256:${createHmac('sha256', input.sharedSecret)
    .update(
      canonicalAutomationWorkerProof({
        timestamp,
        serviceId: input.serviceId,
        certificateFingerprint256: input.certificateFingerprint256,
        nonce,
        bodySha256,
      }),
    )
    .digest('hex')}`,
};
```

Parse success through `AutomationBrowserApprovalConsumeAcceptedSchema`, verify all returned IDs, and parse failures through `AutomationErrorSchema`. Do not retry inside `consume()`.

- [ ] **Step 4: Add the mTLS transport factory**

Use the existing Worker certificate paths but keep creation explicit and testable:

```ts
export function createBrowserApprovalResumeMtlsTransport(input: {
  controlUrl: string;
  mtlsCertificatePath: string;
  mtlsPrivateKeyPath: string;
  mtlsCaPath: string;
  baseFetch?: (input: string | URL, init: BunFetchRequestInit) => Promise<Response>;
}): BrowserApprovalResumeTransport {
  const endpoint = new URL(input.controlUrl);
  const fetcher = input.baseFetch ?? fetch;
  const tls = {
    cert: Bun.file(input.mtlsCertificatePath),
    key: Bun.file(input.mtlsPrivateKeyPath),
    ca: Bun.file(input.mtlsCaPath),
    rejectUnauthorized: true,
    serverName: endpoint.hostname,
  };
  return (url, init) => fetcher(url, { ...init, tls });
}
```

Validate that all three paths are absolute before returning the transport.

- [ ] **Step 5: Run client GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/approval-resume-client.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
git add -- apps/automation-browser-worker/src/approval-resume-client.ts apps/automation-browser-worker/src/approval-resume-client.test.ts
git commit -m "feat: consume browser resume approvals from workers"
```

Expected: client protocol, timeout, error, no-retry, and mTLS configuration tests pass.

---

### Task 7: Capability-gated Resume dispatch transport

**Files:**
- Modify: `apps/automation-control/src/config.ts:61-314`
- Modify: `apps/automation-control/src/server.test.ts:7-153`
- Modify: `apps/automation-control/src/dispatch/runtime.test.ts:26-50`
- Modify: `apps/automation-control/src/dispatch/browser-dispatcher.ts`
- Modify: `apps/automation-control/src/dispatch/dispatch.test.ts`
- Modify: `apps/automation-control/src/dispatch/browser-worker-connection.ts`
- Modify: `apps/automation-control/src/dispatch/browser-worker-connection.test.ts`
- Modify: `apps/automation-browser-worker/src/config.ts:37-224`
- Modify: `apps/automation-browser-worker/src/dispatch-source.ts`
- Modify: `apps/automation-browser-worker/src/dispatch-source.test.ts`

**Interfaces:**
- Adds default-false `browserApprovalResumeEnabled` to Control configuration and `approvalResumeEnabled` to the enabled Worker dispatch configuration.
- Adds `dispatchResume()` alongside the unchanged `dispatch()` method.
- A disabled Worker rejects the Resume variant before creating `pending` work.
- A Resume dispatch succeeds only when the signed receipt declares `browser.approval-resume.v1`.

- [ ] **Step 1: Add default-off and dependency RED tests**

For Control configuration, assert:

```ts
expect(loadAutomationControlConfig({}).browserApprovalResumeEnabled).toBeFalse();
expect(() =>
  loadAutomationControlConfig({
    ...enabledEnvironment,
    AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
    AUTOMATION_BROWSER_DISPATCH_ENABLED: 'false',
  }),
).toThrow('approval resume requires Browser Worker dispatch');
```

Add `browserApprovalResumeEnabled: false` to the explicit `AutomationControlConfig` fixtures in `server.test.ts` and `dispatch/runtime.test.ts`. Keep their current assertions unchanged so adding the feature gate cannot alter disabled health or Desktop runtime behavior.

For Worker configuration, assert:

```ts
expect(loadBrowserWorkerDispatchConfig({})).toEqual({ enabled: false });
expect(() =>
  loadBrowserWorkerDispatchConfig({
    AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
    AUTOMATION_BROWSER_DISPATCH_ENABLED: 'false',
  }),
).toThrow('approval resume requires dispatch');
```

When dispatch and resume are both enabled, expect `approvalResumeEnabled: true` in the enabled Worker config.

- [ ] **Step 2: Add Dispatcher and source RED tests**

Add a `dispatchResume()` success test:

```ts
const receipt = await dispatcher.dispatchResume({
  job: APPROVED_BROWSER_JOB,
  lease: BROWSER_LEASE,
  connection,
  resumeAfterSequence: 2,
  approval: ISSUED_RESUME,
});
expect(receipt.capabilities).toContain('browser.approval-resume.v1');
expect(sentEnvelope).toEqual(
  expect.objectContaining({
    dispatch_kind: 'browser.approval-resume.v1',
    resume_after_sequence: 2,
    approval_resume: expect.objectContaining({
      approval_id: APPROVAL_ID,
      attempt_id: ATTEMPT_ID,
      token: RESUME_TOKEN,
    }),
  }),
);
```

Add failures for mismatched Approval/Job/Step/Action Hash, credential expiry after lease expiry, missing receipt capability, and stale lease after dispatch.

In Worker source tests, send the same signed Resume request to two runtimes:

```ts
await expect(disabledSession.receive(resumeMessage)).rejects.toThrow(
  'Browser approval resume capability is disabled',
);
expect(disabledRuntime.source.next(signal)).resolves.toBeNull();

const accepted = await enabledSession.receive(resumeMessage);
expect(accepted.receipt.capabilities).toContain('browser.approval-resume.v1');
expect((await enabledRuntime.source.next(signal))?.request.envelope).toEqual(resumeEnvelope);
```

- [ ] **Step 3: Run dispatch RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/dispatch.test.ts src/dispatch/browser-worker-connection.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/dispatch-source.test.ts
```

Expected: FAIL because flags, `dispatchResume()`, source gating, and capability receipts do not exist.

- [ ] **Step 4: Add default-false feature gates**

In Control's Zod environment schema add:

```ts
AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: z.enum(['true', 'false']).default('false'),
```

Require it to imply both `AUTOMATION_CONTROL_ENABLED=true` and `AUTOMATION_BROWSER_DISPATCH_ENABLED=true`, then expose:

```ts
browserApprovalResumeEnabled:
  parsed.AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED === 'true',
```

In `BrowserWorkerDispatchConfig`, add `approvalResumeEnabled: boolean` to only the enabled member. Parse `AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED` as `true|false`, require dispatch and heartbeat when true, and default it to false.

Do not reference either new flag from either production entrypoint.

- [ ] **Step 5: Add `dispatchResume()` without changing ordinary dispatch**

Refactor only the common send/receipt work into a private `dispatchEnvelope()` helper. Keep the existing public `dispatch(raw)` signature and output unchanged.

Add:

```ts
dispatchResume(raw: {
  job: AutomationJob;
  lease: AutomationLease;
  connection: BrowserWorkerConnection;
  resumeAfterSequence: number;
  approval: IssuedBrowserApprovalResume;
}): Promise<BrowserDispatchReceipt>;
```

Build the Resume variant only after validating:

```ts
raw.approval.jobId === raw.job.job_id &&
raw.approval.approvalId.length > 0 &&
raw.approval.stepId === targetStep.step_id &&
raw.approval.actionHash === targetStep.action_hash &&
raw.approval.resumeAfterSequence === raw.resumeAfterSequence &&
Date.parse(raw.approval.expiresAt) <= Date.parse(raw.lease.expires_at)
```

Construct:

```ts
const envelope = AutomationBrowserApprovalResumeDispatchEnvelopeSchema.parse({
  protocol_version: 'automation.v1',
  dispatch_kind: 'browser.approval-resume.v1',
  request: job.request,
  lease,
  policy_version: job.policy_version,
  resume_after_sequence: raw.resumeAfterSequence,
  dispatched_at: dispatchedAt.toISOString(),
  approval_resume: {
    approval_id: raw.approval.approvalId,
    attempt_id: raw.approval.attemptId,
    step_id: raw.approval.stepId,
    action_hash: raw.approval.actionHash,
    token: raw.approval.token,
    expires_at: raw.approval.expiresAt,
  },
});
```

After authenticating the receipt proof, require:

```ts
receipt.capabilities?.includes('browser.approval-resume.v1') === true
```

The existing `BrowserWorkerConnection.send()` transports the shared envelope union. Its request parsing remains strict; update tests to prove an unrelated extra field is still rejected.

- [ ] **Step 6: Gate Resume work in the Worker source**

After parsing and authenticating the dispatch request but before updating `lastControlNonce` or creating `pending` work:

```ts
const isResume = 'dispatch_kind' in envelope;
if (isResume && !config.approvalResumeEnabled) {
  throw new BrowserWorkerDispatchSourceError(
    'Browser approval resume capability is disabled',
  );
}
```

Include capabilities only when enabled:

```ts
capabilities: config.approvalResumeEnabled
  ? ['browser.approval-resume.v1']
  : undefined,
```

Sign the exact receipt object including the optional capability field.

- [ ] **Step 7: Run dispatch GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/server.test.ts src/dispatch/dispatch.test.ts src/dispatch/browser-worker-connection.test.ts src/dispatch/runtime.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/dispatch-source.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
git add -- apps/automation-control/src/config.ts apps/automation-control/src/server.test.ts apps/automation-control/src/dispatch/runtime.test.ts apps/automation-control/src/dispatch/browser-dispatcher.ts apps/automation-control/src/dispatch/dispatch.test.ts apps/automation-control/src/dispatch/browser-worker-connection.ts apps/automation-control/src/dispatch/browser-worker-connection.test.ts apps/automation-browser-worker/src/config.ts apps/automation-browser-worker/src/dispatch-source.ts apps/automation-browser-worker/src/dispatch-source.test.ts
git commit -m "feat: dispatch versioned browser approval resumes"
```

Expected: old dispatch tests remain green; Resume requires both configuration and a signed capability receipt.

---

### Task 8: Worker external-effect approval gate

**Files:**
- Create: `apps/automation-browser-worker/src/approval-resume.ts`
- Create: `apps/automation-browser-worker/src/approval-resume.test.ts`
- Modify: `apps/automation-browser-worker/src/action-runner.ts:44-88, 188-260`
- Modify: `apps/automation-browser-worker/src/action-runner.test.ts`
- Modify: `apps/automation-browser-worker/src/worker.ts:80-108, 475-511`
- Modify: `apps/automation-browser-worker/src/worker.test.ts`

**Interfaces:**
- Produces `ConsumedApprovalBinding` with `stepStartedAtomically: true`.
- Produces `createDispatchApprovalConsumer()` for one Resume work item.
- Preserves the old `ApprovalBinding` request shape for non-Resume callers.
- Suppresses exactly one duplicate `step_started` event and no others.

- [ ] **Step 1: Add Action Runner RED coverage**

Add the richer return fixture:

```ts
const consumed: ConsumedApprovalBinding = {
  actionHash: APPROVED_STEP.action_hash,
  jobId: LEASE.job_id,
  projectId: LEASE.project_id,
  stepId: APPROVED_STEP.step_id,
  approvalId: APPROVAL_ID,
  attemptId: ATTEMPT_ID,
  leaseId: LEASE.lease_id,
  killSwitchGeneration: LEASE.kill_switch_generation,
  resumeAfterSequence: 2,
  stepStartedAtomically: true,
};
```

Assert the external effect runs once and no duplicate start event is emitted:

```ts
expect(page.click).toHaveBeenCalledTimes(1);
expect(events.map((event) => event.type)).toEqual(['step_completed']);
expect(emitted.map((event) => event.type)).toEqual(['step_completed']);
```

Keep a separate non-Resume test where `stepStartedAtomically` is absent/false and the existing `['step_started', 'step_completed']` sequence remains unchanged. At the Action Runner boundary, add failures for empty Approval/Attempt IDs and wrong lease, generation, cursor, Step, or Action Hash; `page.click` must remain at zero. A wrong Approval/Attempt returned by Control is rejected in the `createDispatchApprovalConsumer()` tests because that adapter has the signed envelope's exact expected IDs.

- [ ] **Step 2: Add approval-consumer RED coverage**

Create a Resume work item and fake client, then assert:

```ts
const consumeApproval = createDispatchApprovalConsumer({
  workItem: RESUME_WORK_ITEM,
  client,
  now: () => NOW,
});
expect(await consumeApproval(BASE_APPROVAL_BINDING)).toEqual(
  expect.objectContaining({
    ...BASE_APPROVAL_BINDING,
    approvalId: APPROVAL_ID,
    attemptId: ATTEMPT_ID,
    leaseId: LEASE.lease_id,
    stepStartedAtomically: true,
  }),
);
expect(client.inputs).toEqual([
  expect.objectContaining({
    account_id: REQUEST.tenant_id,
    project_id: REQUEST.project_id,
    token: RESUME_TOKEN,
    requested_at: NOW.toISOString(),
  }),
]);
```

For a standard envelope or mismatched base binding, return `null` without calling the client.

- [ ] **Step 3: Run Worker gate RED**

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/approval-resume.test.ts src/action-runner.test.ts src/worker.test.ts
```

Expected: FAIL because the adapter and consumed-binding marker do not exist.

- [ ] **Step 4: Extend approval result semantics**

Keep the existing request binding and add:

```ts
export type ApprovalBinding = Readonly<{
  actionHash: string;
  jobId: string;
  projectId: string;
  stepId: string;
}>;

export type ConsumedApprovalBinding = ApprovalBinding &
  Readonly<{
    approvalId: string;
    attemptId: string;
    leaseId: string;
    killSwitchGeneration: number;
    resumeAfterSequence: number;
    stepStartedAtomically: true;
  }>;
```

Change `RunnerDependencies.consumeApproval` to return `ConsumedApprovalBinding | ApprovalBinding | null`. Extend `approvalMatches()` to verify all base fields. Treat `stepStartedAtomically` as trusted only after additionally verifying:

```ts
consumed.approvalId.length > 0 &&
consumed.attemptId.length > 0 &&
consumed.leaseId === lease.lease_id &&
consumed.killSwitchGeneration === lease.kill_switch_generation &&
consumed.resumeAfterSequence < currentStep.sequence
```

- [ ] **Step 5: Skip only the already-atomic Step start**

After the final lease/action/origin rechecks and before the action switch:

```ts
const stepStartedAtomically =
  requiresApproval &&
  consumedApproval !== null &&
  'stepStartedAtomically' in consumedApproval &&
  consumedApproval.stepStartedAtomically === true;

if (!stepStartedAtomically) {
  await pushEvent('step_started', { step_id: currentStep.step_id });
}
```

Do not make the PostgreSQL heartbeat sink accept duplicate `step_started` events.

- [ ] **Step 6: Implement the dispatch-bound consumer**

`createDispatchApprovalConsumer()` must accept only the Resume union member, compare the base binding before making any network call, and send:

```ts
await client.consume({
  account_id: envelope.request.tenant_id,
  project_id: envelope.request.project_id,
  job_id: envelope.lease.job_id,
  approval_id: resume.approval_id,
  attempt_id: resume.attempt_id,
  step_id: resume.step_id,
  action_hash: resume.action_hash,
  lease_id: envelope.lease.lease_id,
  lease_owner: envelope.lease.owner,
  kill_switch_generation: envelope.lease.kill_switch_generation,
  resume_after_sequence: envelope.resume_after_sequence,
  token: resume.token,
  requested_at: now().toISOString(),
});
```

Verify every ID in the accepted response before returning `ConsumedApprovalBinding`. Throw `BrowserApprovalResumeClientError('protocol', ...)` on mismatch.
Add one adapter test per mismatched response `approvalId`, `attemptId`, `jobId`, and `stepId`; each must throw before the Action Runner can receive a `stepStartedAtomically` marker.

Export `BrowserWorkerInput` from `worker.ts` so the later unmounted runtime factory can compose it. Thread the adapter as the existing `consumeApproval` dependency; do not start a server or change `startFailClosedWorkerServer()`.

- [ ] **Step 7: Run Worker gate GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/approval-resume.test.ts src/action-runner.test.ts src/worker.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
git add -- apps/automation-browser-worker/src/approval-resume.ts apps/automation-browser-worker/src/approval-resume.test.ts apps/automation-browser-worker/src/action-runner.ts apps/automation-browser-worker/src/action-runner.test.ts apps/automation-browser-worker/src/worker.ts apps/automation-browser-worker/src/worker.test.ts
git commit -m "feat: gate browser effects on atomic approval consumption"
```

Expected: Resume effects run once without a duplicate start event; ordinary Runner behavior remains unchanged.

---

### Task 9: Single-Poller Browser resume coordination

**Files:**
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-coordinator.ts`
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-coordinator.test.ts`
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-runtime.ts`
- Create: `apps/automation-control/src/dispatch/browser-approval-resume-runtime.test.ts`
- Modify: `apps/automation-control/src/dispatch/poller.ts`
- Modify: `apps/automation-control/src/dispatch/poller.test.ts`

**Interfaces:**
- Produces `BrowserApprovalResumeCoordinator.runOnce()` for bounded candidate claim, Attempt issue, and Resume dispatch.
- Produces `createBrowserApprovalResumeRuntime()`, which returns `null` unless the Control and Resume gates are both enabled.
- Produces `composeAutomationDispatchPollingRunner()` so Desktop and Browser work share one existing Poller tick.
- Does not mount a route, create a timer, or modify `apps/automation-control/src/main.ts`.

- [ ] **Step 1: Add coordinator RED tests for success and crash windows**

Use one stateful fake whose lease claim rejects a second claim until `lease.expires_at`, and whose store returns a different `attemptId` and Token for each fresh lease. Add these exact assertions:

```ts
test('claims a fresh Browser lease, issues one Attempt, and dispatches it', async () => {
  expect(await coordinator.runOnce()).toEqual({
    candidates: 1,
    claimed: 1,
    issued: 1,
    dispatched: 1,
    failed: 0,
    skipped: 0,
  });
  expect(leaseManager.claimInputs).toEqual([
    { jobId: JOB_ID, owner: CONTROL_ID, now: NOW, ttlMs: 30_000 },
  ]);
  expect(store.issueInputs).toEqual([{ candidate: CANDIDATE, lease: LEASE_1, now: NOW }]);
  expect(dispatcher.inputs).toEqual([
    {
      job: CANDIDATE.job,
      lease: LEASE_1,
      connection,
      resumeAfterSequence: CANDIDATE.resumeAfterSequence,
      approval: ATTEMPT_1,
    },
  ]);
  expect(leaseManager.releaseInputs).toHaveLength(0);
});

test('fences an unavailable or unknown dispatch until lease expiry', async () => {
  for (const reason of ['unavailable', 'unknown_result'] as const) {
    const harness = createHarness({ dispatchFailure: reason });
    expect((await harness.coordinator.runOnce()).failed).toBe(1);
    expect(harness.leaseManager.releaseInputs).toHaveLength(0);

    harness.setNow(new Date(LEASE_1.expires_at));
    expect((await harness.coordinator.runOnce()).issued).toBe(1);
    expect(harness.store.issueInputs.at(-1)?.lease.lease_id).toBe(LEASE_2.lease_id);
    expect(harness.dispatcher.inputs.at(-1)?.approval.attemptId).toBe(ATTEMPT_2.attemptId);
  }
});

test('never claims or replays a candidate whose target Step is running', async () => {
  const harness = createHarness({ candidates: [] });
  expect(await harness.coordinator.runOnce()).toEqual({
    candidates: 0,
    claimed: 0,
    issued: 0,
    dispatched: 0,
    failed: 0,
    skipped: 0,
  });
  expect(harness.leaseManager.claimInputs).toHaveLength(0);
  expect(harness.dispatcher.inputs).toHaveLength(0);
});
```

Also assert that an abort before claim does no work, an abort after claim but before issue releases that unused lease, an issuance rejection releases the lease, and any failure after a successful issue does not release it. No observation may contain either Attempt Token.

- [ ] **Step 2: Run coordinator RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-coordinator.test.ts
```

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Implement the bounded coordinator**

Define:

```ts
export type BrowserApprovalResumeCoordinatorStats = Readonly<{
  candidates: number;
  claimed: number;
  issued: number;
  dispatched: number;
  failed: number;
  skipped: number;
}>;

export type BrowserApprovalResumeCoordinator = Readonly<{
  runOnce(options?: { signal?: AbortSignal }): Promise<BrowserApprovalResumeCoordinatorStats>;
}>;

export function createBrowserApprovalResumeCoordinator(input: {
  store: Pick<BrowserApprovalResumeStore, 'listCandidates' | 'issue'>;
  leaseManager: Pick<LeaseManager, 'claim' | 'release'>;
  dispatcher: Readonly<{
    dispatchResume(raw: {
      job: AutomationJob;
      lease: AutomationLease;
      connection: BrowserWorkerConnection;
      resumeAfterSequence: number;
      approval: IssuedBrowserApprovalResume;
    }): Promise<AutomationBrowserDispatchReceipt>;
  }>;
  connection: BrowserWorkerConnection;
  owner: string;
  leaseMs: number;
  maxClaimsPerRun: number;
  now?: () => Date;
  observe?: (event: BrowserApprovalResumeObservation) => void;
}): BrowserApprovalResumeCoordinator;
```

Validate `owner`, `leaseMs`, and `maxClaimsPerRun` at construction. `runOnce()` must call `listCandidates({ now: now(), limit: maxClaimsPerRun })`, process no more than that limit, and use this lease/Attempt rule:

```ts
const claimedAt = now();
const lease = await input.leaseManager.claim(
  candidate.job.job_id,
  input.owner,
  claimedAt,
  input.leaseMs,
  null,
);
if (lease === null) {
  stats.skipped += 1;
  continue;
}
stats.claimed += 1;

if (options?.signal?.aborted) {
  await input.leaseManager.release(candidate.job.job_id, lease.owner, now());
  break;
}

let issued: IssuedBrowserApprovalResume | null;
try {
  issued = await input.store.issue({ candidate, lease, now: now() });
} catch {
  stats.failed += 1;
  await input.leaseManager.release(candidate.job.job_id, lease.owner, now()).catch(() => undefined);
  continue;
}
if (issued === null) {
  stats.skipped += 1;
  await input.leaseManager.release(candidate.job.job_id, lease.owner, now()).catch(() => undefined);
  continue;
}
stats.issued += 1;

try {
  await input.dispatcher.dispatchResume({
    job: candidate.job,
    lease,
    connection: input.connection,
    resumeAfterSequence: candidate.resumeAfterSequence,
    approval: issued,
  });
  stats.dispatched += 1;
  try {
    input.observe?.({
      type: 'browser_resume_dispatched',
      jobId: issued.jobId,
      stepId: issued.stepId,
      approvalId: issued.approvalId,
      attemptId: issued.attemptId,
      traceId: candidate.job.request.traceparent?.split('-')[1] ?? null,
      occurredAt: now().toISOString(),
    });
  } catch {
    // Diagnostics cannot change dispatch or lease-fencing behavior.
  }
} catch {
  stats.failed += 1;
}
```

After `issue()` succeeds, never call `release()`: a timeout, offline Worker, bad receipt, capability mismatch, or unknown result remains fenced by that lease and Attempt until expiry. Do not retain `issued.token` in stats, errors, observations, or coordinator state after the dispatch call returns.

- [ ] **Step 4: Add the default-disabled runtime factory RED/GREEN cycle**

In `browser-approval-resume-runtime.test.ts`, prove all three states:

```ts
expect(createBrowserApprovalResumeRuntime({ ...dependencies, config: disabledConfig })).toBeNull();
expect(
  createBrowserApprovalResumeRuntime({
    ...dependencies,
    config: { ...enabledConfig, browserApprovalResumeEnabled: false },
  }),
).toBeNull();
expect(
  createBrowserApprovalResumeRuntime({
    ...dependencies,
    config: { ...enabledConfig, browserApprovalResumeEnabled: true },
  }),
).not.toBeNull();
```

Run RED:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-runtime.test.ts
```

Implement only this unmounted factory:

```ts
export function createBrowserApprovalResumeRuntime(
  input: BrowserApprovalResumeRuntimeDependencies,
): BrowserApprovalResumeCoordinator | null {
  if (
    !input.config.enabled ||
    !input.config.browserApprovalResumeEnabled ||
    !input.config.browserDispatch.enabled
  ) {
    return null;
  }
  return createBrowserApprovalResumeCoordinator({
    store: input.store,
    leaseManager: input.leaseManager,
    dispatcher: input.dispatcher,
    connection: input.connection,
    owner: input.config.serviceId,
    leaseMs: input.config.leaseMs,
    maxClaimsPerRun: input.config.coordinatorBatchSize,
    now: input.now,
    observe: input.observe,
  });
}
```

Define the dependency contract explicitly:

```ts
export type BrowserApprovalResumeRuntimeDependencies = Readonly<{
  config: AutomationControlConfig;
  store: Pick<BrowserApprovalResumeStore, 'listCandidates' | 'issue'>;
  leaseManager: Pick<LeaseManager, 'claim' | 'release'>;
  dispatcher: Parameters<typeof createBrowserApprovalResumeCoordinator>[0]['dispatcher'];
  connection: BrowserWorkerConnection;
  now?: () => Date;
  observe?: (event: BrowserApprovalResumeObservation) => void;
}>;
```

Do not import this factory from `main.ts`.

- [ ] **Step 5: Add single-Poller composition RED tests**

Keep every existing Poller test unchanged. Add:

```ts
test('runs Desktop and Browser resume work within one poll tick', async () => {
  const order: string[] = [];
  const runner = composeAutomationDispatchPollingRunner({
    desktop: { async runOnce() { order.push('desktop'); } },
    browserApprovalResume: { async runOnce() { order.push('browser'); } },
  });
  if (runner === null) throw new Error('Expected composed runner');

  await runner.runOnce();
  expect(order).toEqual(['desktop', 'browser']);
});

test('does not starve Browser resume when Desktop fails', async () => {
  let browserRuns = 0;
  const runner = composeAutomationDispatchPollingRunner({
    desktop: { async runOnce() { throw new Error('private desktop failure'); } },
    browserApprovalResume: { async runOnce() { browserRuns += 1; } },
  });
  if (runner === null) throw new Error('Expected composed runner');

  await expect(runner.runOnce()).rejects.toMatchObject({ failedRunners: ['desktop'] });
  expect(browserRuns).toBe(1);
});
```

Also prove `null + null -> null`, one runner is returned without a second scheduler, the same `AbortSignal` reaches both runners, and an already-aborted signal prevents either call.

- [ ] **Step 6: Implement the composable Poller runner**

Export:

```ts
export type AutomationDispatchPollingRunner = Readonly<{
  runOnce(options?: { signal?: AbortSignal }): Promise<unknown>;
}>;

export class AutomationDispatchCompositeError extends Error {
  override readonly name = 'AutomationDispatchCompositeError';
  constructor(readonly failedRunners: readonly ('desktop' | 'browser_approval_resume')[]) {
    super('one or more automation dispatch runners failed');
  }
}

export function composeAutomationDispatchPollingRunner(input: {
  desktop: AutomationDispatchPollingRunner | null;
  browserApprovalResume: AutomationDispatchPollingRunner | null;
}): AutomationDispatchPollingRunner | null;
```

Build a fixed ordered list (`desktop`, then `browser_approval_resume`). In one `runOnce()`, call every runner unless the shared signal is aborted, collect only runner names on failure, and throw `AutomationDispatchCompositeError` after all eligible runners finish. Never attach the original error or message. Leave `startAutomationDispatchPolling()` and its existing `coordinator` argument and sanitized failure event unchanged.
Replace the private `type PollingCoordinator = Pick<AutomationDispatchCoordinator, 'runOnce'>` alias with `type PollingCoordinator = AutomationDispatchPollingRunner`; this lets the returned composite pass through the existing `coordinator` property without changing any caller shape.

- [ ] **Step 7: Run coordinator, runtime, and Poller GREEN; commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume-coordinator.test.ts src/dispatch/browser-approval-resume-runtime.test.ts src/dispatch/poller.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
git add -- apps/automation-control/src/dispatch/browser-approval-resume-coordinator.ts apps/automation-control/src/dispatch/browser-approval-resume-coordinator.test.ts apps/automation-control/src/dispatch/browser-approval-resume-runtime.ts apps/automation-control/src/dispatch/browser-approval-resume-runtime.test.ts apps/automation-control/src/dispatch/poller.ts apps/automation-control/src/dispatch/poller.test.ts
git commit -m "feat: coordinate browser approval resume attempts"
```

Expected: the focused tests pass; the existing Desktop-only Poller behavior is unchanged; no production entrypoint references the new runtime.

---

### Task 10: Focused acceptance, full regression, and Resume Token boundary

**Files:**
- Modify: `apps/automation-control/src/routes/routes.test.ts`
- Verify only: all files listed in Tasks 1-9

**Interfaces:**
- Preserves the current public Approval resolve response, including its existing `approval.v1` one-time credential.
- Proves the new `approval-resume.v1` credential remains confined to issuer memory, signed Worker dispatch, and the authenticated internal consume request.
- Records focused evidence plus a fresh full repository test run; it does not claim Browser E2E, production wiring, or deployment readiness.

- [ ] **Step 1: Add the public response regression test**

Extend `lists and resolves only approvals in the signed project scope` without changing the route:

```ts
const resolvedPayload = await resolved.json();
expect(resolvedPayload).toMatchObject({
  approval_id: APPROVAL_ID,
  status: 'approved',
  token: expect.stringMatching(/^approval\.v1\.[A-Za-z0-9_-]{43}$/),
});
expect(JSON.stringify(resolvedPayload)).not.toContain('approval-resume.v1.');
expect(resolvedPayload).not.toHaveProperty('approval_resume');
expect(JSON.stringify(listedPayload)).not.toContain('approval-resume.v1.');
```

This is an upstream-compatibility assertion: do not remove or rename the existing `token` field.

- [ ] **Step 2: Run the contract and schema acceptance slice**

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts
pnpm.cmd --filter @kortix/db exec bun test src/automation-schema.test.ts
pnpm.cmd --filter @kortix/intelligence-contracts typecheck
pnpm.cmd --filter @kortix/db typecheck
```

Expected: the Resume union, consume schemas, legacy `automation.v1` fixtures, Drizzle schema, and additive migration assertions pass.

- [ ] **Step 3: Run the Control acceptance slice**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/server.test.ts src/dispatch/runtime.test.ts src/dispatch/browser-approval-resume-store.postgres.test.ts src/dispatch/browser-approval-resume-route.test.ts src/dispatch/heartbeat-route.test.ts src/dispatch/worker-auth-nonce.test.ts src/dispatch/dispatch.test.ts src/dispatch/browser-worker-connection.test.ts src/dispatch/browser-approval-resume-coordinator.test.ts src/dispatch/browser-approval-resume-runtime.test.ts src/dispatch/poller.test.ts src/routes/routes.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: the transaction/concurrency matrix, HTTP authentication, capability receipt, offline/unknown-result fencing, lease-expiry retry, default-off runtime, single Poller composition, and public Resume Token regression pass.

- [ ] **Step 4: Run the Browser Worker acceptance slice**

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/approval-resume-client.test.ts src/dispatch-source.test.ts src/approval-resume.test.ts src/action-runner.test.ts src/worker.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: disabled capability rejects before queueing; consume has no automatic retry; no effect occurs before accepted consumption; the atomically started Step emits no duplicate `step_started`; ordinary work remains unchanged.

- [ ] **Step 5: Run exact formatting and repository-boundary checks**

```powershell
pnpm.cmd exec biome check packages/intelligence-contracts/src/automation.ts packages/intelligence-contracts/src/automation.test.ts packages/db/src/schema/kortix.ts packages/db/src/index.ts packages/db/src/automation-schema.test.ts apps/automation-control/src/config.ts apps/automation-control/src/server.test.ts apps/automation-control/src/dispatch/runtime.test.ts apps/automation-control/src/dispatch/browser-approval-resume-store.ts apps/automation-control/src/dispatch/browser-approval-resume-store.postgres.test.ts apps/automation-control/src/dispatch/worker-http-auth.ts apps/automation-control/src/dispatch/heartbeat-route.ts apps/automation-control/src/dispatch/heartbeat-route.test.ts apps/automation-control/src/dispatch/browser-approval-resume-route.ts apps/automation-control/src/dispatch/browser-approval-resume-route.test.ts apps/automation-control/src/dispatch/browser-dispatcher.ts apps/automation-control/src/dispatch/dispatch.test.ts apps/automation-control/src/dispatch/browser-worker-connection.ts apps/automation-control/src/dispatch/browser-worker-connection.test.ts apps/automation-control/src/dispatch/browser-approval-resume-coordinator.ts apps/automation-control/src/dispatch/browser-approval-resume-coordinator.test.ts apps/automation-control/src/dispatch/browser-approval-resume-runtime.ts apps/automation-control/src/dispatch/browser-approval-resume-runtime.test.ts apps/automation-control/src/dispatch/poller.ts apps/automation-control/src/dispatch/poller.test.ts apps/automation-control/src/routes/routes.test.ts apps/automation-browser-worker/src/config.ts apps/automation-browser-worker/src/dispatch-source.ts apps/automation-browser-worker/src/dispatch-source.test.ts apps/automation-browser-worker/src/approval-resume-client.ts apps/automation-browser-worker/src/approval-resume-client.test.ts apps/automation-browser-worker/src/approval-resume.ts apps/automation-browser-worker/src/approval-resume.test.ts apps/automation-browser-worker/src/action-runner.ts apps/automation-browser-worker/src/action-runner.test.ts apps/automation-browser-worker/src/worker.ts apps/automation-browser-worker/src/worker.test.ts
git diff --check
git status --short
```

Expected: Biome and whitespace checks pass. Before the final test commit, `git status --short` shows the modified `apps/automation-control/src/routes/routes.test.ts` plus the two protected pre-existing untracked documents. `apps/automation-control/src/main.ts` has no diff, and the startup body of `startFailClosedWorkerServer()` remains unchanged even though Task 8 modifies other declarations/composition helpers in `worker.ts`.

- [ ] **Step 6: Run the full repository test suite**

```powershell
pnpm.cmd test
```

Expected: every workspace package with a `test` script passes. Record any environment-skipped suites separately; do not describe them as executed coverage.

- [ ] **Step 7: Commit the acceptance regression**

```powershell
git add -- apps/automation-control/src/routes/routes.test.ts
git commit -m "test: verify browser resume approval boundaries"
```

The completion report must list the exact focused and full-suite commands that ran and state explicitly that real PostgreSQL concurrency, Browser E2E, production runtime wiring, deployment readiness, and environment enablement remain for the later activation stage.
