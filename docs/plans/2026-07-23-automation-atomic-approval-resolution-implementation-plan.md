# Automation Atomic Execution Approval Resolution Implementation Plan

> **For agentic workers:** Execute inline, task by task, with RED-GREEN-REFACTOR and one reviewable commit per task. Do not use superpowers or subagents. Track progress with checkbox (`- [ ]`) steps.

**Goal:** Atomically project a durable Browser execution approval decision onto Approval, Step, Job, and audit event state while keeping production behavior default-disabled.

**Architecture:** Extend only the PostgreSQL Approval Service behind an option that defaults to false. When enabled and a locked Step proves that the Approval came from a durable execution pause, resolve approve, reject, or synchronous expiry in the existing database transaction; ordinary approvals retain their current path.

**Tech Stack:** TypeScript, Bun tests, Drizzle ORM, PostgreSQL row locks and conditional updates, Zod automation contracts, Biome.

## Global Constraints

- Do not use superpowers or subagents.
- Do not run the full repository test suite.
- Do not modify `main.ts`, config, routes, SDK, shared Browser dispatch contracts, database schema, migrations, Browser dispatcher, dispatch coordinator, Browser Worker, Web, desktop, or mobile code.
- Keep durable execution approval resolution default-disabled and unconnected to production runtime.
- Preserve existing memory approval behavior and ordinary PostgreSQL approval behavior.
- Never persist or log the raw `approval.v1.*` token; only its generation-bound hash may reach the database.
- Reuse existing `approval_granted` and `cancelled` transitions; add a distinct no-lease `approval_expired` transition.
- Every mutation after the first successful conditional write must throw on conflict so PostgreSQL rolls back the transaction.
- Do not modify or commit:
  - `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`
  - `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`

## File Map

- Modify `apps/automation-control/src/state-machine.ts` and `.test.ts`: add the approval-expiry state transition.
- Modify `apps/automation-control/src/event-store.ts` and `.test.ts`: bind approval expiry to `job_expired` without a lease.
- Modify `apps/automation-control/src/approval-service.ts`: gate and implement the PostgreSQL durable resolution transaction.
- Create `apps/automation-control/src/approval-service.postgres.test.ts`: transaction-aware PostgreSQL service tests, negative matrix, and rollback coverage.

---

### Task 1: Approval-expiry state and event semantics

**Files:**
- Modify: `apps/automation-control/src/state-machine.ts`
- Modify: `apps/automation-control/src/state-machine.test.ts`
- Modify: `apps/automation-control/src/event-store.ts`
- Modify: `apps/automation-control/src/event-store.test.ts`

**Interfaces:**
- Produces transition `{ type: 'approval_expired' }`.
- Allows only `awaiting_approval -> expired`.
- Maps only to public `job_expired` and does not require a lease.

- [ ] **Step 1: Add the failing state-machine tests**

Add:

```ts
test('expires a job whose pending approval reaches its deadline', () => {
  expect(transitionAutomationJob('awaiting_approval', { type: 'approval_expired' })).toBe(
    'expired',
  );
});

test('rejects approval expiry outside awaiting approval', () => {
  for (const status of [
    'queued',
    'dispatched',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
    'retryable',
  ] as const) {
    expect(() => transitionAutomationJob(status, { type: 'approval_expired' })).toThrow(
      AutomationTransitionError,
    );
  }
});
```

- [ ] **Step 2: Run the state-machine RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts -t "approval expiry"
```

Expected: FAIL because `approval_expired` is not an `AutomationTransitionEvent` and has no transition branch.

- [ ] **Step 3: Implement the minimal state transition**

Add to the union and transition function:

```ts
| { type: 'approval_expired' }

if (current === 'awaiting_approval' && event.type === 'approval_expired') {
  return 'expired';
}
```

- [ ] **Step 4: Add event-store RED coverage**

Construct an `AppendAutomationEventInput` with:

```ts
const APPROVAL_EXPIRED_INPUT: AppendAutomationEventInput = {
  ...EVENT_INPUT,
  leaseOwner: null,
  event: {
    protocol_version: 'automation.v1',
    type: 'job_expired',
    status: 'expired',
    payload: { reason: 'approval_expired' },
    trace_id: null,
  },
  transition: { type: 'approval_expired' },
};
```

Assert:

```ts
expect(resolveAutomationEventStatus('awaiting_approval', APPROVAL_EXPIRED_INPUT)).toBe('expired');
expect(automationEventRequiresLease(APPROVAL_EXPIRED_INPUT)).toBeFalse();

expect(() =>
  resolveAutomationEventStatus('awaiting_approval', {
    ...APPROVAL_EXPIRED_INPUT,
    event: { ...APPROVAL_EXPIRED_INPUT.event, type: 'job_cancelled' },
  }),
).toThrow(AutomationEventTransitionMismatchError);
```

- [ ] **Step 5: Run the event-store RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/event-store.test.ts -t "approval expiry"
```

Expected: FAIL because `TRANSITION_EVENT_TYPES` has no approval-expiry mapping.

- [ ] **Step 6: Add the event mapping without adding a lease requirement**

Add:

```ts
approval_expired: ['job_expired'],
```

Do not add `approval_expired` to `automationEventRequiresLease()`.

- [ ] **Step 7: Run focused tests and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts src/event-store.test.ts
git add -- apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts
git commit -m "feat: define execution approval expiry transition"
```

Expected: both test files pass.

---

### Task 2: Default-disabled PostgreSQL resolution gate

**Files:**
- Modify: `apps/automation-control/src/approval-service.ts`
- Create: `apps/automation-control/src/approval-service.postgres.test.ts`

**Interfaces:**
- Produces exported `PostgresApprovalServiceOptions` with `durableExecutionResolutionEnabled?: boolean` and `newEventId?: () => string`.
- Keeps the returned value assignable to `ApprovalService`.
- Treats a Step with matching `approvalId` or `awaiting_approval` status as an execution-resolution signal.
- Keeps a signalled durable pause fail-closed until Task 3 composes its mutations.

- [ ] **Step 1: Create the transaction-aware PostgreSQL fake**

In the new test file import:

```ts
import { describe, expect, test } from 'bun:test';
import {
  type Database,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import {
  AutomationApprovalServiceError,
  createPostgresApprovalService,
} from './approval-service';
```

Use these observable targets and state:

```ts
type UpdateTarget = 'approval' | 'job' | 'step';
type InsertTarget = 'event';

type FakeState = {
  selections: unknown[][];
  updates: Array<Record<string, unknown>>;
  updateTargets: UpdateTarget[];
  inserts: Array<Record<string, unknown>>;
  insertTargets: InsertTarget[];
  transactions: number;
  commits: number;
  rollbacks: number;
  rowLocks: number;
};

type FakeDatabaseOptions = {
  updateReturning?: Partial<Record<UpdateTarget, unknown[]>>;
  failInsertTarget?: InsertTarget;
};
```

The fake must implement these exact Drizzle chains used by `resolve()`:

```ts
select().from().where().limit().for('update')
select().from().innerJoin().where().limit()
update(table).set(values).where().returning(selection)
insert(table).values(values)
transaction(callback)
```

Determine update targets by table identity. Stage updates and inserts inside the transaction and publish them to `FakeState` only after the callback returns. On callback failure, increment `rollbacks` and discard staged changes. `for('update')` increments `rowLocks`.

- [ ] **Step 2: Add ordinary-approval compatibility tests**

Use fixed UUIDs, `NOW = 2026-07-23T10:00:00.000Z`, an Approval expiry at 10:10, and generation `7`.

Test default-disabled resolution with selection order `approval -> job`; assert approve returns an `approval.v1.*` token, commits only one Approval update, performs no Step query, and inserts no event.

Test enabled ordinary resolution with selection order `approval -> job -> steps`, where the target Step is `pending` and `approvalId: null`; assert the result and committed writes match the legacy path exactly.

- [ ] **Step 3: Add the enabled durable-signal RED**

Use an enabled service and rows:

```ts
const job = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  actorUserId: USER_ID,
  status: 'awaiting_approval',
  leaseOwner: null,
  leaseExpiresAt: null,
  killSwitchGeneration: 7,
  deadlineAt: '2026-07-23T10:20:00.000Z',
};

const steps = [
  {
    stepId: STEP_ID,
    sequence: 20,
    status: 'awaiting_approval',
    actionHash: ACTION_HASH,
    approvalId: APPROVAL_ID,
  },
];
```

Assert the temporary gate rejects with `AUTOMATION_CONFLICT` and commits no update or insert. The test must first fail because the factory ignores the new option and executes the legacy approval update.

- [ ] **Step 4: Run the PostgreSQL service RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/approval-service.postgres.test.ts
```

Expected: the durable-signal test fails because the option and locked Step inspection do not exist.

- [ ] **Step 5: Add options and the fail-closed signal detector**

Add:

```ts
export type PostgresApprovalServiceOptions = {
  now?: () => Date;
  currentGeneration?: ApprovalGenerationReader;
  durableExecutionResolutionEnabled?: boolean;
  newEventId?: () => string;
};
```

Resolve defaults once in the factory:

```ts
const durableExecutionResolutionEnabled =
  options?.durableExecutionResolutionEnabled ?? false;
const newEventId = options?.newEventId ?? randomUUID;
```

When enabled, lock all Job steps after the Job row is read. Locate the target by `approval.stepId` and compute:

```ts
const executionPauseSignalled =
  target?.approvalId === approval.approvalId || target?.status === 'awaiting_approval';
```

If the signal is false, continue into the unchanged legacy logic. If true, temporarily throw:

```ts
throw new AutomationApprovalServiceError(
  'AUTOMATION_CONFLICT',
  'Durable execution approval resolution is not composed',
);
```

- [ ] **Step 6: Run tests and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/approval-service.test.ts src/approval-service.postgres.test.ts
git add -- apps/automation-control/src/approval-service.ts apps/automation-control/src/approval-service.postgres.test.ts
git commit -m "feat: gate atomic execution approval resolution"
```

Expected: memory, legacy PostgreSQL, and default-off behavior pass; signalled durable pauses remain fail-closed.

---

### Task 3: Atomic approve success path

**Files:**
- Modify: `apps/automation-control/src/approval-service.ts`
- Modify: `apps/automation-control/src/approval-service.postgres.test.ts`

**Interfaces:**
- Consumes the Task 2 locked durable-pause snapshot.
- Produces Approval `approved`, target Step `pending`, Job `dispatched`, one `job_dispatched` event, and the existing one-time token in one transaction.
- Persists the previous real Step sequence as `resume_after_sequence`.

- [ ] **Step 1: Add a RED valid approve test**

Use selection order:

```text
locked approval -> locked job -> locked all steps -> maximum job event sequence
```

Use Steps with sequences `10`, `40`, `90`:

```ts
[
  { stepId: PREVIOUS_STEP_ID, sequence: 10, status: 'succeeded', actionHash: PREVIOUS_HASH, approvalId: null },
  { stepId: STEP_ID, sequence: 40, status: 'awaiting_approval', actionHash: ACTION_HASH, approvalId: APPROVAL_ID },
  { stepId: NEXT_STEP_ID, sequence: 90, status: 'pending', actionHash: NEXT_HASH, approvalId: null },
]
```

Assert:

```ts
expect(result?.token).toMatch(/^approval\.v1\.[A-Za-z0-9_-]{43}$/);
expect(state.updateTargets).toEqual(['step', 'approval', 'job']);
expect(state.insertTargets).toEqual(['event']);
expect(state.updates[0]).toMatchObject({ status: 'pending' });
expect(state.updates[1]).toMatchObject({
  status: 'approved',
  actingUserId: USER_ID,
  resolvedAt: NOW.toISOString(),
});
expect(JSON.stringify(state.updates)).not.toContain(result?.token);
expect(state.updates[2]).toMatchObject({
  status: 'dispatched',
  terminalAt: null,
  leaseOwner: null,
  leaseExpiresAt: null,
});
expect(state.inserts[0]).toMatchObject({
  type: 'job_dispatched',
  status: 'dispatched',
  payload: {
    approval_id: APPROVAL_ID,
    step_id: STEP_ID,
    action_hash: ACTION_HASH,
    decision: 'approved',
    resume_after_sequence: 10,
    expires_at: APPROVAL_EXPIRES_AT,
  },
  workerId: null,
  workerLeaseId: null,
  workerOrdinal: null,
});
```

- [ ] **Step 2: Run the approve RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/approval-service.postgres.test.ts -t "atomically approves"
```

Expected: FAIL with the Task 2 fail-closed conflict.

- [ ] **Step 3: Add durable snapshot validation**

Extend the locked Job selection with status, lease pair, generation, and deadline. Sort Steps by sequence and require:

```ts
const targetIndex = orderedSteps.findIndex((step) => step.stepId === approval.stepId);
const target = orderedSteps[targetIndex];
const previousSteps = orderedSteps.slice(0, targetIndex);
const laterSteps = orderedSteps.slice(targetIndex + 1);

const validSnapshot =
  job.status === 'awaiting_approval' &&
  job.leaseOwner === null &&
  job.leaseExpiresAt === null &&
  target?.status === 'awaiting_approval' &&
  target.approvalId === approval.approvalId &&
  target.actionHash === approval.actionHash &&
  previousSteps.every((step) => step.status === 'succeeded') &&
  laterSteps.every((step) => step.status === 'pending');
```

Require account, project, actor, request hash, and Approval status `pending` through the existing `assertResolvable` checks. A signalled but invalid snapshot throws `AUTOMATION_CONFLICT`.

- [ ] **Step 4: Materialize the approve event before any write**

Read maximum event sequence under the already-held Job lock. Call `resolveAutomationEventStatus(job.status, input)` with transition `{ type: 'approval_granted' }`, then call `materializeAutomationEvent()` using:

```ts
{
  protocol_version: 'automation.v1',
  type: 'job_dispatched',
  status: 'dispatched',
  payload: {
    approval_id: approval.approvalId,
    step_id: target.stepId,
    action_hash: target.actionHash,
    decision: 'approved',
    resume_after_sequence: previousSteps.at(-1)?.sequence ?? 0,
    expires_at: approval.expiresAt,
  },
  trace_id: null,
}
```

Use `newEventId()` for the event ID. If schema materialization fails, no mutation has occurred.

- [ ] **Step 5: Implement conditional writes and rollback conflict mapping**

Perform writes in this order:

```text
target Step awaiting_approval -> pending
Approval pending -> approved with acting user, token hash, resolved time
Job awaiting_approval -> dispatched with null lease and null terminal time
insert job_dispatched event
```

Before issuing the token, call `currentGeneration()` and require it equals the locked Job generation. Bind the raw token hash using the existing `boundTokenHash()`.

Add an internal error:

```ts
class DurableExecutionApprovalConflictError extends Error {
  constructor() {
    super('Durable execution approval state changed during resolution');
    this.name = 'DurableExecutionApprovalConflictError';
  }
}
```

If any conditional update after the first Step write returns no row, throw this error. Catch it outside `db.transaction()` and map it to:

```ts
new AutomationApprovalServiceError('AUTOMATION_CONFLICT', 'Approval state changed')
```

Do not catch database insertion errors.

- [ ] **Step 6: Run the PostgreSQL approval tests and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/approval-service.postgres.test.ts
git add -- apps/automation-control/src/approval-service.ts apps/automation-control/src/approval-service.postgres.test.ts
git commit -m "feat: atomically approve execution pauses"
```

Expected: the valid approve path and all prior compatibility tests pass.

---

### Task 4: Reject and synchronous expiry settlement

**Files:**
- Modify: `apps/automation-control/src/approval-service.ts`
- Modify: `apps/automation-control/src/approval-service.postgres.test.ts`

**Interfaces:**
- Produces reject outcome: Approval `rejected`, unfinished Steps `cancelled`, Job `cancelled`, `job_cancelled` event, no token.
- Produces expiry outcome: Approval `expired`, unfinished Steps `cancelled`, Job `expired`, `job_expired` event, then `AUTOMATION_APPROVAL_EXPIRED` outside the transaction.
- Expiry wins over a submitted approve or reject decision when either deadline is reached.

- [ ] **Step 1: Add a RED reject test**

Use the valid durable snapshot and decision `reject`. Assert `resolve()` returns `null`, update targets are `['step', 'approval', 'job']`, the unfinished Step update sets `status: 'cancelled'`, Approval has `status: 'rejected'`, Job has `status: 'cancelled'` and `terminalAt: NOW`, and the event is:

```ts
{
  type: 'job_cancelled',
  status: 'cancelled',
  payload: {
    approval_id: APPROVAL_ID,
    step_id: STEP_ID,
    action_hash: ACTION_HASH,
    decision: 'rejected',
    resume_after_sequence: 10,
    expires_at: APPROVAL_EXPIRES_AT,
  },
}
```

Assert `currentGeneration()` is not called and no update/insert contains `approval.v1.`.

- [ ] **Step 2: Add RED Approval-deadline and Job-deadline expiry tests**

For each case submit decision `approve`, set one deadline equal to `NOW`, and assert:

```ts
await expect(service.resolve(input)).rejects.toMatchObject({
  code: 'AUTOMATION_APPROVAL_EXPIRED',
});
expect(state.commits).toBe(1);
expect(state.rollbacks).toBe(0);
expect(state.updateTargets).toEqual(['step', 'approval', 'job']);
expect(state.updates[1]).toMatchObject({
  status: 'expired',
  actingUserId: null,
  tokenHash: null,
  resolvedAt: NOW.toISOString(),
});
expect(state.updates[2]).toMatchObject({
  status: 'expired',
  terminalAt: NOW.toISOString(),
});
expect(state.inserts[0]).toMatchObject({ type: 'job_expired', status: 'expired' });
```

- [ ] **Step 3: Run the reject/expiry RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/approval-service.postgres.test.ts -t "rejects|expiry"
```

Expected: reject remains fail-closed and expiry is rolled back by the existing thrown error.

- [ ] **Step 4: Implement one effective outcome selector**

Split the existing validator so memory and legacy PostgreSQL paths retain the same deadline behavior:

```ts
function assertResolutionScopeAndState(
  record: StoredApprovalRecord,
  input: {
    accountId: string;
    projectId: string;
    actionHash: string;
    actorUserId: string;
  },
): void {
  if (record.accountId !== input.accountId || record.projectId !== input.projectId) {
    throw notFound();
  }
  if (record.actionHash !== input.actionHash) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_CONFLICT',
      'Approval action hash does not match',
    );
  }
  if (record.requestedByUserId !== input.actorUserId) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_FORBIDDEN',
      'Approval actor does not match the requesting user',
    );
  }
  if (record.status !== 'pending') {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_CONFLICT',
      'Approval is no longer pending',
    );
  }
}

function assertResolvable(
  record: StoredApprovalRecord,
  input: {
    accountId: string;
    projectId: string;
    actionHash: string;
    actorUserId: string;
  },
  now: Date,
): void {
  assertResolutionScopeAndState(record, input);
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_APPROVAL_EXPIRED',
      'Approval has expired',
    );
  }
}
```

The durable path calls `assertResolutionScopeAndState()` and then computes its effective outcome before any deadline error is thrown:

```ts
type DurableDecision = 'approve' | 'reject' | 'expire';

const deadlineExpired =
  Date.parse(approval.expiresAt) <= resolvedAt.getTime() ||
  Date.parse(job.deadlineAt) <= resolvedAt.getTime();
const decision: DurableDecision = deadlineExpired ? 'expire' : input.decision;
```

For `reject`, use transition `{ type: 'cancelled' }`. For `expire`, use transition `{ type: 'approval_expired' }`.

- [ ] **Step 5: Implement unfinished-Step, Approval, Job, and event writes**

For reject/expiry, conditionally update every locked Step at or after the target sequence whose status is `pending` or `awaiting_approval` to `cancelled`. Require the returned row count to equal the locked unfinished-Step count.

Use these Approval values:

```ts
decision === 'reject'
  ? {
      status: 'rejected',
      actingUserId: input.actorUserId,
      tokenHash: null,
      resolvedAt: resolvedAt.toISOString(),
    }
  : {
      status: 'expired',
      actingUserId: null,
      tokenHash: null,
      resolvedAt: resolvedAt.toISOString(),
    };
```

Set Job `terminalAt` to the resolution time and keep the lease pair null. Insert the matching event with Control-origin Worker fields null.

- [ ] **Step 6: Commit expiry before reporting its error**

Return an internal transaction outcome:

```ts
type DurableResolutionOutcome =
  | { kind: 'approved'; token: OneTimeApprovalToken }
  | { kind: 'rejected' }
  | { kind: 'expired' };
```

After `db.transaction()` resolves:

```ts
if (outcome.kind === 'expired') {
  throw new AutomationApprovalServiceError(
    'AUTOMATION_APPROVAL_EXPIRED',
    'Approval has expired',
  );
}
return outcome.kind === 'approved' ? outcome.token : null;
```

- [ ] **Step 7: Run tests and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts src/event-store.test.ts src/approval-service.postgres.test.ts
git add -- apps/automation-control/src/approval-service.ts apps/automation-control/src/approval-service.postgres.test.ts
git commit -m "feat: settle rejected and expired execution approvals"
```

Expected: approve, reject, and both expiry paths pass.

---

### Task 5: Negative matrix, rollback, and focused gates

**Files:**
- Modify: `apps/automation-control/src/approval-service.postgres.test.ts`
- Modify only if a failing test exposes a defect: `apps/automation-control/src/approval-service.ts`

**Interfaces:**
- Proves all trust-boundary mismatches fail without partial state.
- Proves database failures remain database failures and internal conditional conflicts map to `AUTOMATION_CONFLICT` after rollback.

- [ ] **Step 1: Add the table-driven semantic rejection matrix**

Cover these cases with no committed update or insert:

```ts
[
  'wrong account',
  'wrong project',
  'wrong actor',
  'wrong action hash',
  'approval already resolved',
  'job not awaiting approval',
  'job still has a lease',
  'target step not awaiting approval',
  'target approval id mismatch',
  'incomplete previous step',
  'started later step',
  'kill-switch generation changed before approve',
]
```

Account/project absence must remain `AUTOMATION_NOT_FOUND`; actor mismatch must remain `AUTOMATION_FORBIDDEN`; all durable snapshot and generation conflicts must be `AUTOMATION_CONFLICT`. Generation mismatch must prove that no raw token is returned or persisted.

- [ ] **Step 2: Add first-step and sparse-sequence cursor tests**

Use a first target with sequence `40` and assert the inserted event cursor is `0`. Use sequences `10 -> 40` and assert the inserted event cursor is `10`, never `1` or `39`. Also assert the inserted event sequence is the locked maximum plus one.

- [ ] **Step 3: Add conditional-update rollback tests**

Configure the fake to return no rows separately for:

```text
target/unfinished Step update
Approval update
Job update
```

The Step no-row case occurs before any successful mutation and may return `AUTOMATION_CONFLICT` directly. Approval and Job no-row cases occur after staged mutations, must increment `rollbacks`, must leave committed update/insert arrays empty, and must map to `AUTOMATION_CONFLICT`.

- [ ] **Step 4: Add event-insert database failure rollback**

Set `failInsertTarget: 'event'`. Assert `resolve()` rejects with the original fake database error, `rollbacks === 1`, and all committed update/insert arrays remain empty.

- [ ] **Step 5: Re-run focused tests**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts src/event-store.test.ts src/approval-service.test.ts src/approval-service.postgres.test.ts
```

Expected: all four focused files pass. Record final test and assertion counts from fresh output.

- [ ] **Step 6: Run typecheck and scoped Biome**

```powershell
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd exec biome check apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts apps/automation-control/src/approval-service.ts apps/automation-control/src/approval-service.postgres.test.ts
```

Expected: both commands exit `0`; Biome checks exactly six files.

- [ ] **Step 7: Inspect scope and commit**

```powershell
git diff --check
git status --short --branch
git diff -- apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts apps/automation-control/src/approval-service.ts apps/automation-control/src/approval-service.postgres.test.ts
git add -- apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts apps/automation-control/src/approval-service.ts apps/automation-control/src/approval-service.postgres.test.ts
git commit -m "test: harden atomic execution approval resolution"
```

## Completion Evidence

Report fresh focused test/assertion counts, Automation Control typecheck, six-file Biome, final Git status, and all implementation commits. State explicitly that production wiring, proactive expiry sweep, HTTP resume, Browser redispatch, approval credential envelope, Worker resume, Browser E2E, deployment, and real PostgreSQL concurrency remain unverified or out of scope.
