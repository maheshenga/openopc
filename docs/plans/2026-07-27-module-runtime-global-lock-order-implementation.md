# Module Runtime Global Lock Order Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, with a review gate
> after each GREEN result. Do not use Superpowers or subagents. Track progress with
> the checkbox (`- [ ]`) items below.

**Goal:** Eliminate the confirmed module execution/lease deadlock cycle by making
every combined path lock `module_executions` before `module_execution_leases` without
changing public behavior.

**Architecture:** PostgreSQL heartbeat and finalize functions will acquire explicit
execution and lease row locks in that order. Drizzle claim abandonment and
capability-grant storage will adopt the same protocol. Deterministic PostgreSQL and
repository tests will make the order executable rather than relying only on
documentation.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM, PostgreSQL 16 PL/pgSQL, Docker,
pnpm workspaces.

## Global Constraints

- Preserve the public API, SQL function signatures, return columns, HTTP status
  codes, repository error codes, database grants, events, and persisted transitions.
- The global two-table row-lock order is exactly
  `module_executions -> module_execution_leases`.
- Do not add production advisory locks or deadlock retries.
- Keep all changes inside the additive OpenOPC module runtime migration, repository,
  and focused tests.
- Do not modify
  `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`,
  `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`, or
  `tests/module-beta/evidence.json`.
- Do not run `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Do not overwrite or revert user changes in the dirty worktree.
- Use `pnpm.cmd`; invoke `bun` directly.
- Do not reformat the full migration integration test. Preserve its current
  `describe.skipIf(...)` layout.
- Do not touch containers that this test suite did not create. Every created
  `kortix-module-runtime-*` container must be removed.
- Do not commit or push.

## File Map

- Modify
  `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`:
  authoritative heartbeat and finalize lock order.
- Modify `packages/db/src/module-runtime-schema.test.ts`: static regression proving
  both SQL functions request execution before lease.
- Modify `packages/db/scripts/module-runtime-migration.integration.test.ts`:
  deterministic real-PostgreSQL cancellation/heartbeat deadlock regression.
- Modify `apps/api/src/module-runtime/executions.drizzle.ts`: explicit execution-first
  locking for abandonment and capability-grant storage.
- Modify `apps/api/src/module-runtime/executions.drizzle.test.ts`: ordered-query and
  failure-path repository coverage.
- Reference
  `docs/specs/2026-07-27-module-runtime-global-lock-order.md`: approved behavior and
  acceptance criteria; do not rewrite it during implementation unless a discovered
  contradiction requires user review.

---

### Task 1: PostgreSQL Function Lock Order and Deadlock Regression

**Files:**

- Modify: `packages/db/src/module-runtime-schema.test.ts`
- Modify: `packages/db/scripts/module-runtime-migration.integration.test.ts`
- Modify: `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`

**Interfaces:**

- Consumes: existing
  `kortix.heartbeat_module_execution(uuid,uuid,uuid,uuid,integer,uuid)` and
  `kortix.finalize_module_execution(...)` signatures.
- Produces: the same functions and result rows with an internal
  execution-then-lease locking guarantee.

- [x] **Step 1: Add a migration-source helper and failing static lock-order test**

Add `resolve` and the migration text near the top of
`packages/db/src/module-runtime-schema.test.ts`:

```ts
import { resolve } from 'node:path';

const migrationSql = (
  await Bun.file(
  resolve(
    import.meta.dir,
    '..',
    'migrations',
    '20260727150000000_module_runtime_control_plane.sql',
  ),
  ).text()
).replaceAll('\r\n', '\n');

function migrationFunctionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION kortix.${name}(`;
  const start = migrationSql.indexOf(marker);
  if (start < 0) throw new Error(`Missing migration function: ${name}`);
  const end = migrationSql.indexOf('\nEND;\n$$;', start);
  if (end < 0) throw new Error(`Unterminated migration function: ${name}`);
  return migrationSql.slice(start, end);
}
```

Add this test after the enum test:

```ts
test('locks execution before lease in heartbeat and finalize functions', () => {
  for (const name of ['heartbeat_module_execution', 'finalize_module_execution']) {
    const body = migrationFunctionBody(name);
    const executionLock = body.indexOf('FROM kortix.module_executions AS execution');
    const leaseLock = body.indexOf('FROM kortix.module_execution_leases AS lease');

    expect(executionLock).toBeGreaterThan(-1);
    expect(leaseLock).toBeGreaterThan(-1);
    expect(executionLock).toBeLessThan(leaseLock);
  }
});
```

- [x] **Step 2: Run the schema RED test**

Run from the repository root:

```powershell
Set-Location packages/db
bun test src/module-runtime-schema.test.ts
Set-Location ../..
```

Expected: `1 fail`, with `executionLock` greater than `leaseLock`; the existing six
schema tests remain green. Return to the repository root after the command.

- [x] **Step 3: Add deterministic cancellation/heartbeat test identifiers and gate**

In `module-runtime-migration.integration.test.ts`, add unique constants without
renumbering existing fixtures:

```ts
const EXECUTION_LOCK_ORDER = '80000000-0000-4000-a000-000000000013';
const LEASE_LOCK_ORDER = '90000000-0000-4000-a000-000000000013';
const CANCEL_GATE = 27_103;
```

Extend `module_runtime_concurrency_test_gate()` with this branch before `RETURN NEW`:

```sql
ELSIF TG_TABLE_NAME = 'module_executions'
      AND app_name = 'module-runtime-lock-order-cancel'
      AND NEW.execution_id = '${EXECUTION_LOCK_ORDER}'::uuid THEN
  PERFORM pg_advisory_xact_lock(${CANCEL_GATE});
```

Install a test-only trigger alongside the existing event/evidence gates:

```sql
CREATE TRIGGER module_runtime_execution_lock_order_test_gate
AFTER UPDATE ON kortix.module_executions
FOR EACH ROW EXECUTE FUNCTION kortix.module_runtime_concurrency_test_gate();
```

The application-name and execution-id checks prevent this gate from affecting any
other test.

- [x] **Step 4: Add the real PostgreSQL RED test**

Add this test immediately after the two append/finalize concurrency tests. Use outcome
objects so cleanup always runs and failures remain inspectable:

```ts
test('lets cancellation finish before a waiting heartbeat without deadlock', async () => {
  seedLeasedExecution({
    executionId: EXECUTION_LOCK_ORDER,
    leaseId: LEASE_LOCK_ORDER,
    idempotencyKey: 'idem-lock-order',
  });
  const gate = postgresSession('module-runtime-lock-order-gate');
  const observer = postgresSession('module-runtime-lock-order-observer');
  const cancel = runtimeSession('module-runtime-lock-order-cancel');
  const heartbeat = runtimeSession('module-runtime-lock-order-heartbeat');
  let gateHeld = false;

  try {
    await cancel.client`SET deadlock_timeout = '100ms'`;
    await heartbeat.client`SET deadlock_timeout = '5s'`;
    await gate`SELECT pg_advisory_lock(${CANCEL_GATE})`;
    gateHeld = true;

    const cancelOutcomePromise = cancel.repository
      .cancel({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        executionId: EXECUTION_LOCK_ORDER,
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitForLock(observer, 'module-runtime-lock-order-cancel');

    const heartbeatOutcomePromise = heartbeat.repository
      .heartbeatLease({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        executionId: EXECUTION_LOCK_ORDER,
        leaseId: LEASE_LOCK_ORDER,
        runnerId: RUNNER_A,
        generation: 1,
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitForLock(observer, 'module-runtime-lock-order-heartbeat');

    await gate`SELECT pg_advisory_unlock(${CANCEL_GATE})`;
    gateHeld = false;
    const [cancelOutcome, heartbeatOutcome] = await Promise.all([
      cancelOutcomePromise,
      heartbeatOutcomePromise,
    ]);

    expect(cancelOutcome.ok).toBe(true);
    if (!cancelOutcome.ok) throw cancelOutcome.error;
    expect(cancelOutcome.value.state).toBe('cancelled');
    expect(heartbeatOutcome.ok).toBe(false);
    if (heartbeatOutcome.ok) throw new Error('Heartbeat unexpectedly succeeded');
    expect(heartbeatOutcome.error).toMatchObject({ status: 409 });

    const persisted = dockerPsql(`
      SELECT
        execution.state,
        bool_and(lease.released_at IS NOT NULL),
        string_agg(event.event_type, ',' ORDER BY event.sequence)
      FROM kortix.module_executions AS execution
      INNER JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      INNER JOIN kortix.module_execution_events AS event
        ON event.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_LOCK_ORDER}'
      GROUP BY execution.execution_id, execution.state;
    `).output.trim();
    expect(persisted).toBe('cancelled|t|execution_cancelled');
  } finally {
    if (gateHeld) await gate`SELECT pg_advisory_unlock(${CANCEL_GATE})`;
    await Promise.all([
      gate.end({ timeout: 5 }),
      observer.end({ timeout: 5 }),
      cancel.client.end({ timeout: 5 }),
      heartbeat.client.end({ timeout: 5 }),
    ]);
  }
}, CONCURRENCY_TEST_TIMEOUT);
```

- [x] **Step 5: Run the integration RED test once**

Run:

```powershell
Set-Location packages/db
bun test scripts/module-runtime-migration.integration.test.ts --test-name-pattern 'lets cancellation finish before a waiting heartbeat without deadlock'
Set-Location ../..
```

Expected on the current migration: cancellation is rejected after PostgreSQL reports
`deadlock detected`, heartbeat succeeds, or the persisted state is not cancelled. The
new test must fail. Preserve this output in the implementation report; do not rerun
until it happens to choose a different victim.

- [x] **Step 6: Reorder heartbeat locks without changing validation behavior**

In `heartbeat_module_execution`, move the execution `SELECT ... FOR UPDATE` before the
lease lock. Use this error for an absent execution so current lease-first error mapping
is preserved:

```sql
SELECT *
INTO v_execution
FROM kortix.module_executions AS execution
WHERE execution.execution_id = p_execution_id
  AND execution.account_id = p_account_id
  AND execution.project_id = p_project_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE EXCEPTION 'module execution lease not found';
END IF;

SELECT *
INTO v_lease
FROM kortix.module_execution_leases AS lease
WHERE lease.lease_id = p_lease_id
  AND lease.execution_id = p_execution_id
  AND lease.account_id = p_account_id
  AND lease.project_id = p_project_id
  AND lease.runner_id = p_runner_id
  AND lease.generation = p_generation
  AND lease.released_at IS NULL
FOR UPDATE;

IF NOT FOUND THEN
  RAISE EXCEPTION 'module execution lease not found';
END IF;
```

Keep the existing state, lease-deadline, execution-deadline, deadline calculation,
updates, heartbeat insert, return columns, and ordering after these lookups.

- [x] **Step 7: Reorder finalize locks without changing validation behavior**

Keep all existing input validation first. Then lock execution before lease:

```sql
SELECT *
INTO v_execution
FROM kortix.module_executions AS execution
WHERE execution.execution_id = p_execution_id
  AND execution.account_id = p_account_id
  AND execution.project_id = p_project_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE EXCEPTION 'module execution lease not found or stale generation';
END IF;

SELECT *
INTO v_lease
FROM kortix.module_execution_leases AS lease
WHERE lease.lease_id = p_lease_id
  AND lease.execution_id = p_execution_id
  AND lease.account_id = p_account_id
  AND lease.project_id = p_project_id
  AND lease.runner_id = p_runner_id
  AND lease.generation = p_generation
  AND lease.released_at IS NULL
FOR UPDATE;

IF NOT FOUND THEN
  RAISE EXCEPTION 'module execution lease not found or stale generation';
END IF;
```

Do not move state or deadline validation ahead of the lease lookup. That would change
which existing conflict wins when both state and lease are stale. Leave all mutations,
evidence/event/outbox inserts, security-definer settings, and return columns intact.

- [x] **Step 8: Run Task 1 GREEN tests**

Run:

```powershell
Set-Location packages/db
bun test src/module-runtime-schema.test.ts
bun test scripts/module-runtime-migration.integration.test.ts --test-name-pattern 'lets cancellation finish before a waiting heartbeat without deadlock'
bun test scripts/module-runtime-migration.integration.test.ts
Set-Location ../..
```

Expected: schema `7 pass / 0 fail`; the focused concurrency test passes; the complete
integration file is `18 pass / 0 fail`. If test discovery reports a different total,
verify it equals all pre-existing tests plus exactly one new test.

- [x] **Step 9: Review Task 1 diff**

Confirm only the two function lookup blocks, the static test, and test-only concurrency
gate/test changed. Confirm no function signature, return declaration, grant, trigger
protection, happy-path assertion, or existing test was removed.

---

### Task 2: Drizzle Repository Lock Order

**Files:**

- Modify: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.ts`

**Interfaces:**

- Consumes: existing `AbandonModuleExecutionClaimCommand` and
  `StoreModuleCapabilityGrantsCommand` repository methods.
- Produces: unchanged method signatures and results with explicit ordered row locks.

- [x] **Step 1: Make the repository fixture expose ordered operations**

Replace the fixture's single `live` boolean with queued SQL/update results and an
operation log:

```ts
function databaseFixture(input: {
  executeResults: unknown[][];
  updateResults?: unknown[][];
}) {
  const executeResults = [...input.executeResults];
  const updateResults = [...(input.updateResults ?? [])];
  const operations: Array<'execute' | 'update' | 'insert'> = [];
  // Keep statements, insertedValues, transactionCalls, grantRow, and eventRow.

  const query = {
    async execute(statement: unknown) {
      operations.push('execute');
      statements.push(statement);
      return executeResults.shift() ?? [];
    },
    update(_table: unknown) {
      operations.push('update');
      const rows = updateResults.shift() ?? [];
      const chain = {
        set: (_value: unknown) => chain,
        where: () => chain,
        returning: async () => rows,
        then: <TResult1 = unknown[]>(
          resolve?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => never) | null,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
    // Preserve select().from()..., and add operations.push('insert') in insert().
  };
```

Return `operations` from the fixture. Update current callers:

```ts
databaseFixture({ executeResults: [[]] });
databaseFixture({ executeResults: [[{ executionId: EXECUTION_ID }]] });
```

Use two queued results only in tests for the new two-lock capability flow.

- [x] **Step 2: Add failing capability-grant lock-order tests**

Replace the current combined-lock assertion with:

```ts
test('locks execution then lease before storing bounded grants', async () => {
  const fixture = databaseFixture({
    executeResults: [
      [{ executionId: EXECUTION_ID }],
      [{ leaseId: LEASE_ID }],
    ],
  });
  const repository = createDrizzleModuleExecutionRepository(fixture.database);

  await expect(repository.storeCapabilityGrants(command())).resolves.toHaveLength(1);
  expect(fixture.statements).toHaveLength(2);
  const executionLock = render(fixture.statements[0]);
  const leaseLock = render(fixture.statements[1]);
  expect(executionLock.sql).toContain('FROM kortix.module_executions AS execution');
  expect(executionLock.sql).toContain('FOR UPDATE');
  expect(executionLock.sql).not.toContain('module_execution_leases');
  expect(leaseLock.sql).toContain('FROM kortix.module_execution_leases AS lease_row');
  expect(leaseLock.sql).toContain('FOR UPDATE');
  expect(leaseLock.sql).not.toContain('JOIN kortix.module_executions');
  expect(fixture.insertedValues).toHaveLength(1);
});
```

Add the second-stage failure case:

```ts
test('does not store grants when lease validation fails after execution lock', async () => {
  const fixture = databaseFixture({
    executeResults: [[{ executionId: EXECUTION_ID }], []],
  });
  const repository = createDrizzleModuleExecutionRepository(fixture.database);

  await expect(repository.storeCapabilityGrants(command())).rejects.toMatchObject({
    code: 'MODULE_EXECUTION_LEASE_STALE',
    status: 409,
  });
  expect(fixture.statements).toHaveLength(2);
  expect(fixture.insertedValues).toEqual([]);
});
```

Keep the first-stage stale test and update it to assert one statement and no insert.

- [x] **Step 3: Add a failing abandonment lock-order test**

Define the complete execution fixture consumed by `execution(...)`:

```ts
const dispatchableExecutionRow = {
  executionId: EXECUTION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  installationId: INSTALLATION_ID,
  releaseId: RELEASE_ID,
  consentRevisionId: CONSENT_ID,
  runtimeDescriptorId: DESCRIPTOR_ID,
  state: 'dispatchable' as const,
  idempotencyKey: 'idem-lock-order',
  workEnvelopeDigest: RELEASE_DIGEST,
  killSwitchGeneration: 0,
  deadlineAt: '2026-07-27T02:00:00.000Z',
  createdAt: '2026-07-27T01:00:00.000Z',
  updatedAt: '2026-07-27T01:00:01.000Z',
  terminalAt: null,
};
```

Then add:

```ts
test('locks execution before releasing a claim lease', async () => {
  const fixture = databaseFixture({
    executeResults: [
      [{ executionId: EXECUTION_ID }],
      [{ executionId: EXECUTION_ID }],
    ],
    updateResults: [
      [{ leaseId: LEASE_ID }],
      [dispatchableExecutionRow],
      [],
    ],
  });
  const repository = createDrizzleModuleExecutionRepository(fixture.database);

  await expect(
    repository.abandonClaim({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      executionId: EXECUTION_ID,
      leaseId: LEASE_ID,
      runnerId: RUNNER_ID,
      generation: 2,
    }),
  ).resolves.toMatchObject({ state: 'dispatchable' });

  expect(fixture.operations[0]).toBe('execute');
  const lock = render(fixture.statements[0]);
  expect(lock.sql).toContain('FROM kortix.module_executions AS execution');
  expect(lock.sql).toContain("execution.state = 'leased'");
  expect(lock.sql).toContain('FOR UPDATE');
  expect(lock.sql).not.toContain('module_execution_leases');
});
```

- [x] **Step 4: Run repository RED tests**

Run:

```powershell
bun test apps/api/src/module-runtime/executions.drizzle.test.ts
```

Expected: the capability test fails because only one combined lock statement exists;
the abandonment test fails because the first operation is an update. Existing progress
append tests remain green.

- [x] **Step 5: Split capability-grant locking into two queries**

Inside the existing transaction, replace the combined join lock with this first query:

```ts
const activeExecution = await tx.execute<{ executionId: string }>(sql`
  SELECT execution.execution_id AS "executionId"
  FROM kortix.module_executions AS execution
  WHERE execution.execution_id = ${command.executionId}::uuid
    AND execution.account_id = ${command.accountId}::uuid
    AND execution.project_id = ${command.projectId}::uuid
    AND execution.state IN ('leased', 'running')
  FOR UPDATE
`);
if (!activeExecution[0]) {
  throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
}
```

Then lock and validate only the lease:

```ts
const liveLease = await tx.execute<{ leaseId: string }>(sql`
  SELECT lease_row.lease_id AS "leaseId"
  FROM kortix.module_execution_leases AS lease_row
  WHERE lease_row.lease_id = ${command.leaseId}::uuid
    AND lease_row.execution_id = ${command.executionId}::uuid
    AND lease_row.account_id = ${command.accountId}::uuid
    AND lease_row.project_id = ${command.projectId}::uuid
    AND lease_row.runner_id = ${command.runnerId}::uuid
    AND lease_row.generation = ${command.generation}::integer
    AND lease_row.released_at IS NULL
    AND lease_row.deadline_at > now()
    AND ${latestExpiresAt}::timestamptz <= lease_row.deadline_at
  FOR UPDATE
`);
if (!liveLease[0]) {
  throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
}
```

Keep grant values, insert, mapping, expiry parsing, and transaction boundaries
unchanged.

- [x] **Step 6: Lock execution before claim abandonment updates**

At the start of the existing `abandonClaim` transaction, after `abandonedAt`, add:

```ts
const lockedExecution = await tx.execute<{ executionId: string }>(sql`
  SELECT execution.execution_id AS "executionId"
  FROM kortix.module_executions AS execution
  WHERE execution.execution_id = ${command.executionId}::uuid
    AND execution.account_id = ${command.accountId}::uuid
    AND execution.project_id = ${command.projectId}::uuid
    AND execution.state = 'leased'
  FOR UPDATE
`);
if (!lockedExecution[0]) {
  throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
}
```

Keep the fenced lease update, execution transition, grant revocation, event append, and
rollback-on-any-missing-row behavior intact. It is acceptable for the lease update to
precede the execution update after the explicit execution lock is held.

- [x] **Step 7: Run Task 2 GREEN tests**

Run:

```powershell
bun test apps/api/src/module-runtime/executions.drizzle.test.ts
bun test apps/api/src/module-runtime
```

Expected: the Drizzle file has its six existing tests plus two new tests, all green;
the complete module-runtime API directory reports `29 pass / 0 fail`.

- [x] **Step 8: Review Task 2 diff**

Confirm no combined `FOR UPDATE OF lease_row, execution` remains, no lease row is
locked before execution, and `appendEvidence` still locks execution only. Confirm no
repository interface, route, error class, or event payload changed.

---

### Task 3: Focused and Full Verification

**Files:**

- Verify only; no planned implementation edits.

**Interfaces:**

- Consumes: Tasks 1 and 2 GREEN results.
- Produces: reproducible validation evidence and a precise report of unrelated
  baseline failures.

- [x] **Step 1: Run focused unit and schema suites**

Run each command once and preserve its tail output:

```powershell
Set-Location apps/api
& '..\..\node_modules\.bin\dotenvx.CMD' run -- bun test src/module-runtime
Set-Location ../..
Set-Location packages/db
bun test src/module-runtime-schema.test.ts
Set-Location ../..
bun test packages/module-runtime-contracts/src/contracts.test.ts
bun test packages/sdk/src/core/rest/projects-client/module-executions.test.ts
```

Expected: all focused suites pass. Expected historical counts before the new tests are
API `27/27`, DB schema `6/6`, contracts `10/10`, and SDK `1/1`; report the exact new
counts rather than forcing those old totals.

- [x] **Step 2: Run the real PostgreSQL suite three consecutive times**

Run exactly three times, recording every run even if one fails:

```powershell
Set-Location packages/db
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
Set-Location ../..
```

Expected: each run reports all tests passing, expected `18 pass / 0 fail`, including
per-test durations. If any run fails, stop treating the task as complete and report
that run; do not repeat until three lucky passes appear.

- [x] **Step 3: Run migration lint and affected typechecks**

Run:

```powershell
pnpm.cmd migrate:lint
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @openopc/module-runtime-contracts typecheck
pnpm.cmd --filter @kortix/sdk typecheck
```

Expected: migration lint passes all 81 migrations with only the seven recorded
pre-existing warnings; all four package typechecks pass.

- [x] **Step 4: Run full workspace tests once**

Run:

```powershell
pnpm.cmd test
```

Do not hide or repeatedly rerun failures. The current known unrelated baseline is one
Windows permission assertion (`0600` expected, `0666` observed) and three
manifest-schema JSON synchronization failures. Record the real output and distinguish
any new module-runtime failure from those existing failures.

- [x] **Step 5: Run lock-order and protected-file checks**

Run:

```powershell
rg -n -C 4 'FOR UPDATE|\.update\(moduleExecutionLeases\)|\.update\(moduleExecutions\)' apps/api/src/module-runtime/executions.drizzle.ts
rg -n -C 4 'FOR UPDATE|UPDATE kortix\.module_execution_leases|UPDATE kortix\.module_executions' packages/db/migrations/20260727150000000_module_runtime_control_plane.sql
git diff --exit-code -- docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md tests/module-beta/evidence.json
```

Expected: every combined lock path is execution then lease; protected-file diff exits
zero.

- [x] **Step 6: Prove container cleanup and report worktree state**

Run:

```powershell
docker ps -a --format '{{.Names}}' --filter 'name=^kortix-module-runtime-'
git status --porcelain --untracked-files=all
```

Expected: the Docker command prints nothing. Preserve the full Git status so the
report distinguishes this task's files from the user's existing uncommitted work.

- [x] **Step 7: Final implementation review**

Review the final diff against every acceptance criterion in
`docs/specs/2026-07-27-module-runtime-global-lock-order.md`. Report:

- the original RED schema and PostgreSQL outputs;
- the final lock order for each affected path;
- the three consecutive PostgreSQL outputs with durations;
- focused, lint, typecheck, and full-test outputs;
- protected-file and container checks;
- any unrelated baseline failure without claiming a fully green workspace; and
- confirmation that no commit or push occurred.
