# Module Runtime Evidence and Finalize Serialization Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Do
> not use Superpowers or subagents. Stop for review after each task.

**Goal:** Prevent a Runner progress event from committing after terminal execution
state while adding no lease/execution deadlock edge.

**Architecture:** Make the live execution/lease validation query acquire only the
execution row lock. The existing `appendEvent(...)` call then reuses that transaction's
execution lock for event sequence allocation. Real PostgreSQL tests call the actual
Drizzle repository through independent sessions and use advisory-lock-backed test
gates to prove both concurrent orderings without timing sleeps.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM 0.45, postgres.js 3.4, PostgreSQL 16,
Docker, pnpm 8.

**Execution Status:** Implemented and focused verification complete. The repository
lock test first failed at 4/5 because the validation SQL lacked the live-lease JOIN,
then passed 6/6 after execution-only locking. Three consecutive real PostgreSQL runs
passed 17/17 in 35.73s, 56.97s, and 37.91s; append-first/finalize-first timings were
694/638ms, 1560/2407ms, and 690/635ms. Focused API, DB schema, contracts, and SDK
suites passed 27/27, 6/6, 10/10, and 1/1. API, DB, contracts, and SDK typechecks
passed. Migration lint passed 81 files with seven pre-existing destructive-operation
warnings. Targeted Biome, `git diff --check`, protected-file checks, and container
cleanup passed. The full workspace test was executed and retained four unrelated
baseline failures: one Windows mode assertion expected 0600 but observed 0666, and
three committed manifest-schema JSON exports were out of sync. No commit or push was
performed. The wider pre-existing mixed lease/execution lock order remains outside
this narrow append repair.

## Global Constraints

- Work in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`.
- Use `pnpm.cmd` from PowerShell and invoke `bun` directly.
- Do not run `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Do not commit or push.
- Do not use Superpowers or subagents.
- Do not modify `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`,
  `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`, or
  `tests/module-beta/evidence.json`.
- Preserve all unrelated and pre-existing worktree changes.
- Do not format `packages/db/scripts/module-runtime-migration.integration.test.ts` as
  a whole file or change its existing one-line `describe.skipIf(...)` layout.
- Do not touch pre-existing Docker containers. The integration suite may remove only
  its own randomly named `kortix-module-runtime-<suffix>` container.
- Map PostgreSQL with Docker's random loopback port
  `127.0.0.1::5432`; do not use occupied host port 5433.
- Keep `appendEvidence(...)` free of lease row locks. Its validation query must lock
  only the matching execution row.
- Preserve every existing account, project, execution, lease, Runner, generation,
  release, deadline, and state predicate.
- Preserve existing API fields, event schemas, and
  `MODULE_EXECUTION_LEASE_STALE` HTTP 409 behavior.
- Do not add a migration, PostgreSQL production function, privilege, dependency,
  environment variable, service, or deployment step.

## File Map

- `apps/api/src/module-runtime/executions.drizzle.test.ts`: mock the complete progress
  append transaction and assert the exact locking SQL and stale behavior.
- `apps/api/src/module-runtime/executions.drizzle.ts`: acquire the execution row during
  live lease validation before calling the existing event appender.
- `packages/db/scripts/module-runtime-migration.integration.test.ts`: expose the
  disposable database on a random host port and prove both repository races using
  independent PostgreSQL sessions.
- `docs/specs/2026-07-27-module-runtime-evidence-finalize-serialization.md`: record
  implementation and verification status after the code is proven.
- `docs/plans/2026-07-27-module-runtime-evidence-finalize-serialization-implementation.md`:
  track execution status and final evidence.

---

### Task 1: Add the failing repository lock-contract test

**Files:**

- Modify: `apps/api/src/module-runtime/executions.drizzle.test.ts:2,46-89,215-232`
- Test: `apps/api/src/module-runtime/executions.drizzle.test.ts`

**Interfaces:**

- Consumes: `createDrizzleModuleExecutionRepository(...)` and
  `AppendModuleExecutionEvidenceCommand`.
- Produces: a unit contract requiring the first progress-append SQL statement to lock
  `execution`, not `lease_row`, before event insertion.

- [x] **Step 1: Extend the database fixture to execute a complete progress append**

Keep the existing capability-grant behavior, add an event row, make `select()` support
both the current live-lease builder and `appendEvent(...)`'s maximum-sequence query,
and return the correct row shape from `insert(...)`:

```typescript
const eventRow = {
  eventId: 'a0000000-0000-4000-a000-00000000000a',
  executionId: EXECUTION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  sequence: 1,
  eventType: 'runner_progress',
  payload: { completed: 1 },
  createdAt: '2026-07-27T01:00:00.000Z',
};

const query = {
  async execute(statement: unknown) {
    statements.push(statement);
    return input.live ? [{ leaseId: LEASE_ID, executionId: EXECUTION_ID }] : [];
  },
  select() {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => (input.live ? [{ leaseId: LEASE_ID }] : []),
      then(
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (error: unknown) => unknown,
      ) {
        return Promise.resolve([{ sequence: 0 }]).then(onFulfilled, onRejected);
      },
    };
    return chain;
  },
  insert(_table: unknown) {
    return {
      values(value: unknown) {
        insertedValues.push(value);
        const first = Array.isArray(value) ? value[0] : value;
        const isEvent =
          !!first && typeof first === 'object' && 'eventType' in first;
        return { returning: async () => (isEvent ? [eventRow] : [grantRow]) };
      },
    };
  },
};
```

The current builder path reaches `.limit(1)`. After the implementation switches the
validation to `execute(...)`, the remaining `select()` call is the thenable maximum
event-sequence lookup.

- [x] **Step 2: Add a reusable append command and success lock assertion**

```typescript
function appendCommand() {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    leaseId: LEASE_ID,
    runnerId: RUNNER_ID,
    generation: 2,
    eventType: 'runner_progress',
    evidence: { completed: 1 },
  };
}

test('locks only the execution while validating a live progress append', async () => {
  const fixture = databaseFixture({ live: true });
  const repository = createDrizzleModuleExecutionRepository(fixture.database);

  await expect(repository.appendEvidence(appendCommand())).resolves.toMatchObject({
    executionId: EXECUTION_ID,
    sequence: 1,
    eventType: 'runner_progress',
  });

  expect(fixture.transactionCalls()).toBe(1);
  expect(fixture.insertedValues).toHaveLength(1);
  const validation = render(fixture.statements[0]);
  expect(validation.sql).toContain(
    'INNER JOIN kortix.module_execution_leases AS lease_row',
  );
  expect(validation.sql).toContain('FOR UPDATE OF execution');
  expect(validation.sql).not.toContain('FOR UPDATE OF lease_row');
  expect(validation.params).toEqual(
    expect.arrayContaining([
      ACCOUNT_ID,
      PROJECT_ID,
      EXECUTION_ID,
      LEASE_ID,
      RUNNER_ID,
      2,
    ]),
  );
});
```

This assertion intentionally examines `statements[0]`. Before the fix, that statement
is `appendEvent(...)`'s execution-only sequence lock and does not contain the live
lease JOIN.

- [x] **Step 3: Add the empty-validation regression**

```typescript
test('rejects a progress append without inserting after the live fence is lost', async () => {
  const fixture = databaseFixture({ live: false });
  const repository = createDrizzleModuleExecutionRepository(fixture.database);

  await expect(repository.appendEvidence(appendCommand())).rejects.toMatchObject({
    code: 'MODULE_EXECUTION_LEASE_STALE',
    status: 409,
  });
  expect(fixture.transactionCalls()).toBe(1);
  expect(fixture.insertedValues).toEqual([]);
});
```

Retain the existing oversized-payload test and all capability-grant assertions.

- [x] **Step 4: Run the repository test and capture RED once**

Run:

```powershell
cd apps/api
bun test src/module-runtime/executions.drizzle.test.ts
```

Expected: the new success test fails because the first executed SQL statement lacks
the live-lease JOIN. The existing tests and the new stale-path test pass. Preserve the
complete output; do not weaken the SQL assertion.

---

### Task 2: Add deterministic real PostgreSQL race reproductions

**Files:**

- Modify: `packages/db/scripts/module-runtime-migration.integration.test.ts:1-70,112-199,786`
- Test: `packages/db/scripts/module-runtime-migration.integration.test.ts`

**Interfaces:**

- Consumes: the real `createDrizzleModuleExecutionRepository(...)`, PostgreSQL 16,
  `createDbFromClient(...)`, and the migration's existing finalize function.
- Produces: two independent-session tests that observe PostgreSQL lock waits and
  reproduce both progress/finalize orderings.

- [x] **Step 1: Add real repository imports and random-port state**

```typescript
import postgres, { type Sql } from 'postgres';
import { createDrizzleModuleExecutionRepository } from '../../../apps/api/src/module-runtime/executions.drizzle';
import { createDbFromClient } from '../src/client';

let mappedPostgresPort = '';

const EXECUTION_APPEND_FIRST = '80000000-0000-4000-a000-000000000011';
const EXECUTION_FINALIZE_FIRST = '80000000-0000-4000-a000-000000000012';
const LEASE_APPEND_FIRST = '90000000-0000-4000-a000-000000000011';
const LEASE_FINALIZE_FIRST = '90000000-0000-4000-a000-000000000012';
const APPEND_GATE = 27_101;
const FINALIZE_GATE = 27_102;
const CONCURRENCY_TEST_TIMEOUT = 120_000;
```

- [x] **Step 2: Map the disposable PostgreSQL container to a random loopback port**

Add these Docker arguments before `postgres:16-alpine`:

```typescript
'-p',
'127.0.0.1::5432',
```

After the existing real `SELECT current_database()` readiness check succeeds, resolve
the assigned port before applying the migration:

```typescript
const mappedPort = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
  stdout: 'pipe',
  stderr: 'pipe',
});
if (mappedPort.exitCode !== 0) throw new Error(mappedPort.stderr.toString());
const value = mappedPort.stdout.toString().trim().match(/:(\d+)$/)?.[1];
if (!value) throw new Error(`Could not resolve mapped PostgreSQL port: ${mappedPort.stdout}`);
mappedPostgresPort = value;
```

Do not replace the existing `testdb` query readiness gate with `pg_isready`.

- [x] **Step 3: Add session and condition-wait helpers**

```typescript
function postgresUrl(): string {
  if (!mappedPostgresPort) throw new Error('PostgreSQL host port is not mapped');
  return `postgres://postgres:test@127.0.0.1:${mappedPostgresPort}/testdb`;
}

function postgresSession(applicationName: string) {
  return postgres(postgresUrl(), {
    max: 1,
    prepare: false,
    connection: { application_name: applicationName, statement_timeout: 60_000 },
  });
}

function runtimeSession(applicationName: string) {
  const client = postgresSession(applicationName);
  return {
    client,
    repository: createDrizzleModuleExecutionRepository(createDbFromClient(client)),
  };
}

async function waitForLock(observer: Sql, applicationName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [activity] = await observer<{ waiting: boolean }[]>`
      SELECT wait_event_type = 'Lock' AS waiting
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
      ORDER BY backend_start DESC
      LIMIT 1
    `;
    if (activity?.waiting) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}
```

Every client created in a test must be closed in `finally` with
`await client.end({ timeout: 5 })`.

- [x] **Step 4: Install disposable test gates after migration setup**

Run this only inside the disposable container setup, after both migration applications
and before `seedControlPlaneRows()`:

```sql
CREATE OR REPLACE FUNCTION kortix.module_runtime_concurrency_test_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  app_name text := current_setting('application_name', true);
BEGIN
  IF TG_TABLE_NAME = 'module_execution_events'
     AND app_name = 'module-runtime-append-first' THEN
    PERFORM pg_advisory_xact_lock(27101);
  ELSIF TG_TABLE_NAME = 'module_execution_evidence'
        AND app_name = 'module-runtime-finalize-first' THEN
    PERFORM pg_advisory_xact_lock(27102);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER module_runtime_events_concurrency_test_gate
BEFORE INSERT ON kortix.module_execution_events
FOR EACH ROW EXECUTE FUNCTION kortix.module_runtime_concurrency_test_gate();

CREATE TRIGGER module_runtime_evidence_concurrency_test_gate
BEFORE INSERT ON kortix.module_execution_evidence
FOR EACH ROW EXECUTE FUNCTION kortix.module_runtime_concurrency_test_gate();
```

The application-name conditions make these test-only triggers inert for all existing
tests and normal setup queries.

- [x] **Step 5: Add a helper that seeds an isolated live execution and lease**

```typescript
function seedLeasedExecution(input: {
  executionId: string;
  leaseId: string;
  idempotencyKey: string;
}) {
  dockerPsql(`
    INSERT INTO kortix.module_executions(
      execution_id, account_id, project_id, installation_id, release_id,
      consent_revision_id, runtime_descriptor_id, state, idempotency_key,
      work_envelope_digest, kill_switch_generation, deadline_at
    )
    SELECT
      '${input.executionId}', account_id, project_id, installation_id, release_id,
      consent_revision_id, runtime_descriptor_id, 'dispatchable',
      '${input.idempotencyKey}', work_envelope_digest, kill_switch_generation,
      now() + interval '10 minutes'
    FROM kortix.module_executions
    WHERE execution_id = '${EXECUTION_A}';

    SELECT * FROM kortix.claim_module_execution(
      '${ACCOUNT_A}', '${PROJECT_A}', '${input.executionId}', '${RUNNER_A}',
      '${input.leaseId}', 1, now() + interval '5 minutes'
    );
  `);
}
```

- [x] **Step 6: Add the append-first no-deadlock test**

Acquire `APPEND_GATE` on a dedicated one-connection postgres.js client. Start
`appendEvidence(...)` with application name `module-runtime-append-first`; its event
trigger blocks only after the repository holds the execution lock. Wait for that lock,
then start `finalize(...)` under `module-runtime-append-first-finalize` and wait until
it is blocked on the execution row. Release the advisory gate and assert both calls
succeed:

```typescript
const appendPromise = append.repository.appendEvidence({
  accountId: ACCOUNT_A,
  projectId: PROJECT_A,
  executionId: EXECUTION_APPEND_FIRST,
  leaseId: LEASE_APPEND_FIRST,
  runnerId: RUNNER_A,
  generation: 1,
  eventType: 'runner_progress',
  evidence: { completed: 1 },
});

const finalizePromise = finalizer.repository.finalize({
  accountId: ACCOUNT_A,
  projectId: PROJECT_A,
  executionId: EXECUTION_APPEND_FIRST,
  leaseId: LEASE_APPEND_FIRST,
  runnerId: RUNNER_A,
  generation: 1,
  outcome: 'succeeded',
  evidenceDigest: DIGEST_B,
  evidence: { outcome: 'succeeded' },
  usage: { units: [] },
});
```

After completion, query and assert:

```sql
SELECT
  execution.state,
  string_agg(event.event_type, ',' ORDER BY event.sequence),
  (SELECT count(*) FROM kortix.module_execution_evidence
    WHERE execution_id = execution.execution_id),
  (SELECT count(*) FROM kortix.module_execution_outbox
    WHERE execution_id = execution.execution_id)
FROM kortix.module_executions AS execution
JOIN kortix.module_execution_events AS event
  ON event.execution_id = execution.execution_id
WHERE execution.execution_id = '${EXECUTION_APPEND_FIRST}'
GROUP BY execution.execution_id, execution.state;
```

Expected scalar output:

```text
succeeded|runner_progress,execution_finalized|1|1
```

Always unlock `APPEND_GATE` and close the gate, observer, append, and finalizer clients
in `finally`. Use `CONCURRENCY_TEST_TIMEOUT` as the test's third argument.

- [x] **Step 7: Add the finalize-first stale-append test**

Acquire `FINALIZE_GATE`, start finalization under application name
`module-runtime-finalize-first`, and wait until the evidence trigger blocks after the
function holds both row locks and has written terminal state in its uncommitted
transaction. Start append under `module-runtime-finalize-first-append`, wait for its
execution lock wait, release the gate, and collect the append as a value so its
expected rejection is never unhandled:

```typescript
const appendOutcome = append.repository
  .appendEvidence({
    accountId: ACCOUNT_A,
    projectId: PROJECT_A,
    executionId: EXECUTION_FINALIZE_FIRST,
    leaseId: LEASE_FINALIZE_FIRST,
    runnerId: RUNNER_A,
    generation: 1,
    eventType: 'runner_progress',
    evidence: { completed: 1 },
  })
  .then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
```

After both operations settle, require `ok === false`, and require the error to match
`{ code: 'MODULE_EXECUTION_LEASE_STALE', status: 409 }`. Persisted state must be:

```text
succeeded|execution_finalized|0|1|1
```

where the last three values are runner-progress count, terminal-evidence count, and
outbox count. Close all four clients and unlock the advisory gate in `finally`.

- [x] **Step 8: Run the real PostgreSQL suite for the first concurrency result**

Run:

```powershell
cd packages/db
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected with the already completed unit-level implementation: all 17 tests pass,
including both concurrency cases. If either new test fails, preserve the entire first
failure output and diagnose it before retrying. Do not revert the implementation to
manufacture an integration RED; Task 1 already captured the missing-lock RED. Confirm
the suite removes its own container:

```powershell
docker ps -a --filter "name=kortix-module-runtime-" --format "{{.Names}}"
```

Expected: no output.

---

### Task 3: Lock execution during authoritative progress validation

**Files:**

- Modify: `apps/api/src/module-runtime/executions.drizzle.ts:565-609`
- Test: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Test: `packages/db/scripts/module-runtime-migration.integration.test.ts`

**Interfaces:**

- Consumes: `AppendModuleExecutionEvidenceCommand` unchanged.
- Produces: `appendEvidence(...)` with one execution-locked validation query and the
  existing `Promise<ModuleExecutionEvent>` result and stale error contract.

- [x] **Step 1: Replace only the unlocked validation builder**

Keep payload validation and `appendEvent(...)` unchanged. Replace the transaction's
current `.select(...).innerJoin(...).where(...).limit(1)` block with:

```typescript
const live = await tx.execute<{ executionId: string }>(sql`
  SELECT execution.execution_id AS "executionId"
  FROM kortix.module_executions AS execution
  INNER JOIN kortix.module_execution_leases AS lease_row
    ON lease_row.execution_id = execution.execution_id
   AND lease_row.account_id = execution.account_id
   AND lease_row.project_id = execution.project_id
  WHERE execution.execution_id = ${command.executionId}::uuid
    AND execution.account_id = ${command.accountId}::uuid
    AND execution.project_id = ${command.projectId}::uuid
    AND execution.state IN ('leased', 'running')
    AND lease_row.lease_id = ${command.leaseId}::uuid
    AND lease_row.execution_id = ${command.executionId}::uuid
    AND lease_row.account_id = ${command.accountId}::uuid
    AND lease_row.project_id = ${command.projectId}::uuid
    AND lease_row.runner_id = ${command.runnerId}::uuid
    AND lease_row.generation = ${command.generation}::integer
    AND lease_row.released_at IS NULL
    AND lease_row.deadline_at > now()
  FOR UPDATE OF execution
`);
if (!live[0]) throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
```

Do not add `FOR UPDATE OF lease_row`, do not call a new helper, and do not modify
`appendEvent(...)`. Retaining execution/account/project conditions on both sides of
the JOIN preserves tenant non-disclosure and the composite identity fence.

- [x] **Step 2: Run the focused repository test for GREEN**

```powershell
cd apps/api
bun test src/module-runtime/executions.drizzle.test.ts
```

Expected: all tests pass, including the exact SQL shape, stale path, bounded grants,
and oversized payload rejection.

- [x] **Step 3: Run the real PostgreSQL suite once for GREEN**

```powershell
cd ../../packages/db
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: `17 pass`, `0 fail`. Both concurrency tests must show their lock-wait
assertions completed. If either times out or fails, preserve that first failure and
diagnose it; do not retry until it happens to pass.

- [x] **Step 4: Run affected typechecks**

```powershell
cd ../..
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/db typecheck
```

Expected: both commands exit 0 with no TypeScript errors.

---

### Task 4: Regression verification and worktree audit

**Files:**

- Modify after verification:
  `docs/specs/2026-07-27-module-runtime-evidence-finalize-serialization.md:3`
- Modify after verification:
  `docs/plans/2026-07-27-module-runtime-evidence-finalize-serialization-implementation.md`
- Verify all implementation and test files; do not change unrelated files to satisfy
  global checks.

**Interfaces:**

- Consumes: the execution-locked progress validation and both concurrency tests.
- Produces: reproducible completion evidence with no commit, push, protected-file
  change, or residual test container.

- [x] **Step 1: Run all focused module runtime suites**

```powershell
cd apps/api
bun test src/module-runtime/app.test.ts src/module-runtime/runner-auth.test.ts src/module-runtime/runner-protocol.test.ts src/module-runtime/executions.test.ts src/module-runtime/executions.drizzle.test.ts
cd ../../packages/db
bun test src/module-runtime-schema.test.ts
cd ../module-runtime-contracts
bun test src/contracts.test.ts
cd ../sdk
bun test src/core/rest/projects-client/module-executions.test.ts
```

Expected: every focused suite passes with zero failures.

- [x] **Step 2: Run the real PostgreSQL suite three consecutive times**

From `packages/db`:

```powershell
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: each run reports `17 pass`, `0 fail`. Preserve every test name, timing, and
total from all three runs. Report any failure immediately; do not hide it behind later
successful retries.

- [x] **Step 3: Run package checks and the restored full workspace test**

```powershell
cd ../..
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter @openopc/module-runtime-contracts typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd migrate:lint
pnpm.cmd test
```

Expected: affected typechecks and migration lint pass. The full workspace test is
still expected to expose the known unrelated Windows file-mode assertion (`0600`
expected, `0666` observed) and three committed manifest-schema synchronization
failures unless those baselines changed independently. Report the actual output; do
not edit unrelated files to force a green full-suite result.

- [x] **Step 4: Run targeted static and repository hygiene checks**

```powershell
pnpm.cmd exec biome check apps/api/src/module-runtime/executions.drizzle.ts apps/api/src/module-runtime/executions.drizzle.test.ts
git diff --check
git diff --name-only -- docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md tests/module-beta/evidence.json
docker ps -a --filter "name=kortix-module-runtime-" --format "{{.Names}}"
git status --porcelain --untracked-files=all
```

Expected: the two targeted TypeScript files pass Biome, `git diff --check` is clean,
protected-file output is empty, container output is empty, and status contains only
intended work plus pre-existing user changes. Do not run whole-file Biome formatting
on the migration integration test.

- [x] **Step 5: Update document status and report without committing**

After all evidence is captured, change the spec status to reflect the actual result.
If the full workspace test passes, use:

```markdown
Status: implemented; full verification passed
```

If unrelated baseline failures remain, use:

```markdown
Status: implemented; focused verification passed; full workspace verification has
unrelated baseline failures recorded in the implementation report
```

Mark completed plan checkboxes and add a concise execution-status paragraph containing
the real focused totals, all three integration totals, typecheck/lint results, and any
full-suite baseline failures. Report in Chinese:

- the original TOCTOU and the hidden `appendEvent(...)` execution lock;
- why execution-only validation adds no lease/execution deadlock edge;
- the exact RED evidence and subsequent GREEN evidence;
- all three PostgreSQL integration outputs with per-test timings and totals;
- typecheck, migration lint, full-suite, Biome, protected-file, container, and worktree
  outputs;
- any residual risk, especially the wider pre-existing mixed lock order outside this
  narrow append path.

Do not commit or push after reporting.
