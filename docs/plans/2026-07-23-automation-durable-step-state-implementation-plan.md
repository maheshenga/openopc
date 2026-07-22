# Automation Browser Worker Durable Step State Implementation Plan

> **For agentic workers:** Execute inline, task by task, with RED-GREEN-REFACTOR and a review checkpoint after every commit. Do not use superpowers or subagents. Track steps with the checkbox (`- [ ]`) syntax below.

**Goal:** Atomically persist authenticated Browser Worker `step_started`, `step_completed`, and `job_succeeded` events without allowing invalid step lifecycles or consuming ordinals on rejection.

**Architecture:** Extend the existing PostgreSQL heartbeat sink. Its job row lock remains the serialization boundary; target step rows are then locked and conditionally updated in the same transaction as the audit event. No contract, schema, migration, configuration, or runtime-entrypoint change is needed.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL, Biome.

## Global Constraints

- Do not use superpowers or subagents.
- Do not run the full repository test suite.
- Keep Automation and Worker feature flags default-off.
- Keep `approval_required` fail-closed.
- Do not change shared contracts, database schema, migrations, Browser Worker main runtime, or Desktop coordinator.
- Preserve `stale_lease`, `replayed_ordinal`, and `semantic_mismatch` result meanings.
- Do not impose cross-step sequence ordering; job success still requires every step to be `succeeded`.
- Do not modify or commit the two protected untracked documents recorded in the workspace checkpoint.

## File Map

- Modify `apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts`: project the three intents and apply their durable mutations.
- Modify `apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts`: model table-aware transaction commit/rollback and test every accepted/rejected transition.
- Create no other runtime, contract, schema, migration, configuration, or dependency files.

---

### Task 1: Persist `step_started`

**Files:**

- Modify: `apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts`
- Modify: `apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts`

**Interfaces:**

- Consumes: `{ type: 'step_started', payload: { step_id }, trace_id }`.
- Produces: `pending -> running`, `startedAt = observedAt`, plus a `running` audit event.
- Rejects: unknown/cross-job/non-`pending` step as `semantic_mismatch`.

- [ ] **Step 1: Make the fake transaction table-aware and rollback-capable**

Import `automationJobSteps` and `automationJobs`. Add `UpdateTarget = 'job' | 'step'`, `updateTargets`, `commits`, and `rollbacks` to `FakeState`, plus:

```ts
type FakeDatabaseOptions = {
  failInsert?: boolean;
  updateReturning?: Partial<Record<UpdateTarget, unknown[]>>;
};
```

Construct the fake transaction inside `db.transaction`. Stage updates/inserts locally; publish them to `state` only when the callback resolves. Determine the target with `table === automationJobSteps ? 'step' : 'job'`. On callback rejection discard staged data and increment `rollbacks`. Use these shared constants:

```ts
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const EVIDENCE_REFERENCE = 'evidence:60000000-0000-4000-a000-000000000001';
```

- [ ] **Step 2: Prove the upgraded fixture preserves existing behavior**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts
```

Expected: all pre-existing tests pass.

- [ ] **Step 3: Add RED tests for valid, unknown, and duplicate starts**

The valid query results must be ordered as locked job, last Worker ordinal, locked step, maximum event sequence:

```ts
const { db, state } = fakeDatabase([
  [{ jobId: JOB_ID, status: 'running' }],
  [{ value: 0 }],
  [{ stepId: STEP_ID, status: 'pending' }],
  [{ value: 4 }],
]);
const result = await sink.append({
  ...heartbeatInput(),
  event: { type: 'step_started', payload: { step_id: STEP_ID }, trace_id: null },
});
expect(result).toMatchObject({
  accepted: true,
  event: { type: 'step_started', status: 'running', sequence: 5 },
});
expect(state.updateTargets).toEqual(['step']);
expect(state.updates).toEqual([
  expect.objectContaining({ status: 'running', startedAt: NOW.toISOString() }),
]);
```

Repeat with `[]`, `running`, and `succeeded` step selections; expect `semantic_mismatch` and no update/insert.

- [ ] **Step 4: Run the new tests and confirm RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts -t "pending step|non-pending step"
```

Expected: FAIL because `step_started` is currently projected as unsupported.

- [ ] **Step 5: Implement the minimal start projection and mutation**

Project `step_started` with `status: 'running'` and `transition: null`. After job-status resolution and before event sequence allocation:

```ts
const [step] = await tx
  .select({ stepId: automationJobSteps.stepId, status: automationJobSteps.status })
  .from(automationJobSteps)
  .where(and(
    eq(automationJobSteps.jobId, input.binding.jobId),
    eq(automationJobSteps.stepId, input.event.payload.step_id),
  ))
  .limit(1)
  .for('update');
if (step?.status !== 'pending') {
  return { accepted: false, reason: 'semantic_mismatch' } as const;
}
const [updatedStep] = await tx
  .update(automationJobSteps)
  .set({ status: 'running', startedAt: observedAt })
  .where(and(
    eq(automationJobSteps.jobId, input.binding.jobId),
    eq(automationJobSteps.stepId, input.event.payload.step_id),
    eq(automationJobSteps.status, 'pending'),
  ))
  .returning({ stepId: automationJobSteps.stepId });
if (!updatedStep) {
  return { accepted: false, reason: 'semantic_mismatch' } as const;
}
```

- [ ] **Step 6: Run the complete sink test file and confirm GREEN**

Use the command from Step 2. Expected: all tests pass.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "feat: persist browser automation step starts"
```

---

### Task 2: Persist `step_completed`

**Files:** the same two sink files.

**Interfaces:** `running -> succeeded`, `endedAt = observedAt`, `resultRef = evidence_reference`; all other target-step states reject as `semantic_mismatch`.

- [ ] **Step 1: Add RED success and rejection tests**

Use query order job, ordinal, running step, event sequence. Append ordinal 2 with `EVIDENCE_REFERENCE` and assert:

```ts
expect(result).toMatchObject({
  accepted: true,
  event: { type: 'step_completed', status: 'running', sequence: 6 },
});
expect(state.updateTargets).toEqual(['step']);
expect(state.updates).toEqual([expect.objectContaining({
  status: 'succeeded',
  endedAt: NOW.toISOString(),
  resultRef: EVIDENCE_REFERENCE,
})]);
```

Repeat with unknown, `pending`, and `succeeded` step rows; expect no mutation.

- [ ] **Step 2: Confirm RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts -t "completes a running step|non-running step"
```

Expected: FAIL because `step_completed` remains unsupported.

- [ ] **Step 3: Implement completion projection and locked update**

Project `step_completed` with `status: 'running'` and `transition: null`. Lock by `jobId + stepId`, require `running`, then conditionally update:

```ts
.set({
  status: 'succeeded',
  endedAt: observedAt,
  resultRef: input.event.payload.evidence_reference,
})
.where(and(
  eq(automationJobSteps.jobId, input.binding.jobId),
  eq(automationJobSteps.stepId, input.event.payload.step_id),
  eq(automationJobSteps.status, 'running'),
))
.returning({ stepId: automationJobSteps.stepId });
```

Return `semantic_mismatch` if either the locked precondition or conditional update fails.

- [ ] **Step 4: Confirm GREEN and commit**

Run the complete sink test file, then:

```powershell
git add -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "feat: persist browser automation step completions"
```

---

### Task 3: Guard and persist `job_succeeded`

**Files:** the same two sink files.

**Interfaces:** consume a running leased job; require at least one step and every step `succeeded`; produce the existing `{ type: 'succeeded' }` transition, terminal timestamp, cleared lease, and final event.

- [ ] **Step 1: Add RED success and incomplete-step tests**

The valid selections are job, ordinal, all steps, event sequence:

```ts
const stepRows = [
  { stepId: STEP_ID, sequence: 1, status: 'succeeded' },
  { stepId: '50000000-0000-4000-a000-000000000002', sequence: 2, status: 'succeeded' },
];
```

Assert accepted `job_succeeded`, `status: 'succeeded'`, a job update containing `terminalAt`, `leaseOwner: null`, `leaseExpiresAt: null`, two row locks, and one event insert. Then table-test `[]`, one `pending`, one `running`, and a mixed succeeded/running set; each must reject without update or insert.

- [ ] **Step 2: Confirm RED**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts -t "every step|zero or incomplete"
```

Expected: FAIL because `job_succeeded` remains unsupported.

- [ ] **Step 3: Implement the success projection and all-step lock**

Project `job_succeeded` with `status: 'succeeded'` and `transition: { type: 'succeeded' }`. Before sequence allocation:

```ts
const steps = await tx
  .select({
    stepId: automationJobSteps.stepId,
    sequence: automationJobSteps.sequence,
    status: automationJobSteps.status,
  })
  .from(automationJobSteps)
  .where(eq(automationJobSteps.jobId, input.binding.jobId))
  .for('update');
if (steps.length === 0 || steps.some((step) => step.status !== 'succeeded')) {
  return { accepted: false, reason: 'semantic_mismatch' } as const;
}
```

Reuse the existing transition update: it already maps `running -> succeeded`, sets `terminalAt`, and clears the lease.

- [ ] **Step 4: Confirm GREEN and commit**

Run the complete sink test file, then:

```powershell
git add -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "feat: guard browser automation job success"
```

---

### Task 4: Prove rollback and run focused gates

**Files:** primarily the sink test; modify production only if a new RED test exposes a defect.

- [ ] **Step 1: Test conditional update failure**

Use a locked `pending` step with `updateReturning: { step: [] }`. Append `step_started`; expect `semantic_mismatch`, zero committed updates, and zero inserts.

- [ ] **Step 2: Test event-insert rollback**

Use a valid `step_started` transaction with `failInsert: true`. Assert:

```ts
await expect(sink.append(input)).rejects.toThrow('fake event insert failed');
expect(state.updates).toHaveLength(0);
expect(state.inserts).toHaveLength(0);
expect(state.commits).toBe(0);
expect(state.rollbacks).toBe(1);
```

- [ ] **Step 3: Preserve early failure boundaries**

Extend stale-lease and replayed/skipped-ordinal tests with `state.updateTargets` empty and no second row lock. Keep the dedicated `approval_required` test proving it opens no transaction.

- [ ] **Step 4: Run the focused sink suite**

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts
```

Expected: all tests pass. Record the exact test/assertion count.

- [ ] **Step 5: Run typecheck and scoped Biome**

```powershell
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd exec biome check apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
```

Expected: both exit 0; Biome checks exactly two files.

- [ ] **Step 6: Inspect final scope**

```powershell
git diff --check
git status --short --branch
git diff -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
```

Expected: only the two intended code files differ, plus the two pre-existing protected untracked files.

- [ ] **Step 7: Commit hardening tests**

```powershell
git add -- apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
git commit -m "test: harden durable browser step state"
```

## Completion Evidence

Report fresh focused test count/assertions, typecheck, scoped Biome, final status, and Task 1-4 commits. Do not describe these as full repository, browser E2E, deployment, or production verification.
