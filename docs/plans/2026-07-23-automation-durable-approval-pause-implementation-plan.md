# Automation Browser Worker Durable Approval Pause Implementation Plan

> **For agentic workers:** Execute inline with RED-GREEN-REFACTOR and one reviewable commit per task. Do not use superpowers or subagents. Track progress with checkbox (`- [ ]`) steps.

**Goal:** Add a default-disabled Control-side transaction that turns an authenticated Browser Worker `approval_required` event into a durable, fenced task pause.

**Architecture:** Add a lease-required internal transition for execution-time approval, then extend the existing PostgreSQL heartbeat sink behind an option that defaults to false. When explicitly enabled in tests, the sink locks the job and all steps, validates the sequential Browser snapshot, conditionally pauses the target step, creates the pending approval, clears the job lease, and appends the Worker event in one transaction.

**Tech Stack:** TypeScript, Bun tests, Drizzle ORM, PostgreSQL transaction semantics, Biome.

## Global Constraints

- Do not use superpowers or subagents.
- Do not run the full repository test suite.
- Do not modify `main.ts`, config, approval service, routes, shared contracts, database schema, migrations, Browser dispatcher, or Browser Worker.
- Keep durable approval pause default-disabled and unconnected to production runtime.
- Preserve the existing pre-dispatch `queued -> awaiting_approval` path without requiring a lease.
- Require a current lease for execution-time `running -> awaiting_approval`.
- Do not modify or commit the two protected untracked documents.

## File Map

- Modify `apps/automation-control/src/state-machine.ts` and `.test.ts`: define `execution_approval_required`.
- Modify `apps/automation-control/src/event-store.ts`; create `event-store.test.ts`: bind the new transition to `approval_required` and require a lease.
- Modify `apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts` and `.test.ts`: option gate, validation, approval creation, step/job mutation, event insertion, rollback tests.

---

### Task 1: Execution-time approval transition and lease boundary

**Interfaces:**

- Produces transition `{ type: 'execution_approval_required' }`.
- Allows only `running -> awaiting_approval`.
- Maps only to public event `approval_required` and requires `leaseOwner !== null` in generic event storage.

- [ ] **Step 1: Add one failing state-machine test**

```ts
test('pauses a running job for execution-time approval', () => {
  expect(
    transitionAutomationJob('running', { type: 'execution_approval_required' }),
  ).toBe('awaiting_approval');
});
```

- [ ] **Step 2: Confirm RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts -t "execution-time approval"
```

Expected: TypeScript/test failure because the transition does not exist.

- [ ] **Step 3: Implement the minimal transition**

Add the union member and branch:

```ts
| { type: 'execution_approval_required' }

if (current === 'running' && event.type === 'execution_approval_required') {
  return 'awaiting_approval';
}
```

- [ ] **Step 4: Add rejection coverage for queued, dispatched, awaiting and terminal jobs**

Use one table-driven test and expect `AutomationTransitionError` for every non-running status. Keep the existing queued `{ type: 'approval_required' }` test green.

- [ ] **Step 5: Add `event-store.test.ts` with RED lease and mapping tests**

Construct an `AppendAutomationEventInput` whose event is `approval_required`, status is `awaiting_approval`, transition is `execution_approval_required`, and lease owner is `worker:lease`. Assert:

```ts
expect(resolveAutomationEventStatus('running', input)).toBe('awaiting_approval');
expect(automationEventRequiresLease(input)).toBeTrue();
```

Also assert the same event with transition `{ type: 'approval_required' }` from queued does not require a lease, and mapping `execution_approval_required` to `job_started` throws `AutomationEventTransitionMismatchError`.

- [ ] **Step 6: Implement event-store mapping and lease requirement**

Add:

```ts
execution_approval_required: ['approval_required'],
```

and include `input.transition?.type === 'execution_approval_required'` in `automationEventRequiresLease`.

- [ ] **Step 7: Run focused tests and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts src/event-store.test.ts
git add -- apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts
git commit -m "feat: define execution approval pause transition"
```

Expected: focused tests pass.

---

### Task 2: Default-disabled approval projection

**Interfaces:**

- Extends `createPostgresHeartbeatEventSink(db, options?)`.
- Options: `durableApprovalPauseEnabled?: boolean`, `approvalTtlMs?: number`, `newApprovalId?: () => string`.
- Default remains fail-closed before starting a transaction.

- [ ] **Step 1: Add RED option-validation tests**

Assert the default sink still rejects `approval_required` with zero transactions. Then assert enabled construction rejects TTL values below `60_000` or above `3_600_000` and accepts exactly `600_000`.

- [ ] **Step 2: Add a RED projection test with an enabled sink**

Use deterministic values:

```ts
const APPROVAL_ID = '70000000-0000-4000-a000-000000000001';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
```

Construct an enabled sink and a running job selection. The test must fail later at missing step snapshot rather than at the pre-transaction projection gate; assert `state.transactions === 1` and `semantic_mismatch`.

- [ ] **Step 3: Implement options and projection**

Validate options once in the factory. Keep `projectWorkerEvent` returning `null` for approval when the option is false. When true, project:

```ts
{
  event: {
    protocol_version: 'automation.v1',
    type: 'approval_required',
    status: 'awaiting_approval',
    payload: event.payload,
    trace_id: event.trace_id,
  },
  transition: { type: 'execution_approval_required' },
}
```

- [ ] **Step 4: Run sink tests and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts
git add -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "feat: gate durable browser approval pause"
```

---

### Task 3: Atomic durable pause success path

**Interfaces:**

- Consumes a current running job and all locked step rows.
- Produces one step update, one pending approval insert, one job update, and one Worker event insert in the same transaction.
- Output payload contains `approval_id`, `expires_at`, and `resume_after_sequence` derived by Control.

- [ ] **Step 1: Upgrade the fake insert fixture**

Import `automationApprovals` and `automationJobEvents`. Add `InsertTarget = 'approval' | 'event'`, `insertTargets`, and `failInsertTarget` to the fake state/options. Determine the target by table identity; stage both inserts and publish only on transaction commit. Preserve existing `failInsert: true` behavior for earlier tests.

- [ ] **Step 2: Add one RED valid-pause test**

Use query order: locked job, last Worker ordinal, all locked steps, maximum event sequence. Job selection includes `deadlineAt` and `deadlineCurrent: true`. Step rows are:

```ts
[
  { stepId: PREVIOUS_STEP_ID, sequence: 10, status: 'succeeded', risk: 'observe', actionHash: PREVIOUS_HASH, approvalId: null },
  { stepId: STEP_ID, sequence: 20, status: 'pending', risk: 'operate', actionHash: ACTION_HASH, approvalId: null },
  { stepId: NEXT_STEP_ID, sequence: 30, status: 'pending', risk: 'observe', actionHash: NEXT_HASH, approvalId: null },
]
```

Enable the sink with TTL 10 minutes and deterministic approval ID. Assert accepted event status `awaiting_approval`, expiry `2026-07-22T10:10:00.000Z`, resume cursor `10`, update targets `['step', 'job']`, insert targets `['approval', 'event']`, step status/approval ID, job cleared lease, and one commit.

- [ ] **Step 3: Implement locked snapshot validation**

Extend the job selection with `deadlineAt` and a SQL boolean comparing deadline to `GREATEST(clock_timestamp(), observed_at)`. Lock all job steps. Sort by sequence, find the target, and require:

```ts
target.status === 'pending'
target.approvalId === null
target.actionHash === input.event.payload.action_hash
target.risk !== 'observe'
previous.every((step) => step.status === 'succeeded')
later.every((step) => step.status === 'pending')
```

Compute resume cursor from the last previous row or zero, and cap approval expiry at the job deadline.

- [ ] **Step 4: Implement mutations and final event payload**

Conditionally update the target step to `awaiting_approval` with the approval ID. If it returns no row, return `semantic_mismatch` before another mutation. Then insert the pending approval, update the job through the existing transition path, and append the event with:

```ts
payload: {
  step_id: target.stepId,
  action_hash: target.actionHash,
  approval_id: approvalId,
  expires_at: expiresAt,
  resume_after_sequence: resumeAfterSequence,
}
```

If the job conditional update fails after the step mutation, throw an internal conflict; catch it outside `db.transaction` and convert it to `semantic_mismatch` after rollback.

- [ ] **Step 5: Confirm GREEN and commit**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts
git add -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "feat: persist durable browser approval pauses"
```

---

### Task 4: Failure matrix, rollback, and focused gates

- [ ] **Step 1: Add table-driven semantic rejection coverage**

Cover unknown target, hash mismatch, observe risk, non-pending target, existing approval ID, incomplete previous step, started later step, non-running job, and expired deadline. Every case must leave update/insert targets empty.

- [ ] **Step 2: Add first-step and sparse-sequence cursor coverage**

Assert the first target gets cursor `0`; assert sequences `10 -> 40` produce cursor `10`, never count `1` or `39`.

- [ ] **Step 3: Add rollback tests**

Test conditional step update returning no row, approval insert failure, job update returning no row, and final event insert failure. After each failure assert no committed updates/inserts; thrown database errors remain thrown, while the internal job conflict becomes `semantic_mismatch`.

- [ ] **Step 4: Re-run the focused sink and state tests**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts src/event-store.test.ts src/dispatch/postgres-heartbeat-sink.test.ts
```

Expected: all focused tests pass; record test and assertion counts.

- [ ] **Step 5: Run typecheck and scoped Biome**

```powershell
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd exec biome check apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
```

Expected: both commands exit 0; Biome checks six files.

- [ ] **Step 6: Inspect scope and commit**

```powershell
git diff --check
git status --short --branch
git diff -- apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git add -- apps/automation-control/src/state-machine.ts apps/automation-control/src/state-machine.test.ts apps/automation-control/src/event-store.ts apps/automation-control/src/event-store.test.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "test: harden durable browser approval pause"
```

## Completion Evidence

Report fresh focused test/assertion counts, Automation Control typecheck, six-file Biome, final status, and commits. State explicitly that production wiring, Browser E2E, deployment, approval resolution, redispatch, and Worker resume remain unverified or out of scope.
