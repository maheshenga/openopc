# Module Runtime Server-Owned Heartbeat Deadline Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Do not
> use Superpowers or subagents. Stop for review after each task.

**Goal:** Prevent a Runner from choosing its heartbeat lease deadline by making every
renewal a PostgreSQL-clock-owned, execution-bounded 30-second lease.

**Architecture:** Remove `deadlineAt` from the private heartbeat wire and TypeScript
repository contracts. The in-memory repository derives the deadline from its injected
clock, while PostgreSQL captures `clock_timestamp()` after acquiring both existing row
locks and persists `LEAST(observed_at + interval '30 seconds', execution.deadline_at)`.
The migration explicitly removes the obsolete seven-argument function overload.

**Tech Stack:** TypeScript, Hono, Zod, Bun test, Drizzle ORM, PostgreSQL 16, Docker,
pnpm 8.

**Execution Status:** Implemented. Focused suites, three consecutive PostgreSQL runs,
typechecks, migration lint, and targeted static checks passed. The full workspace test
was executed and stopped on unrelated baseline failures in the sandbox-agent file-mode
test and generated manifest-schema sync tests.

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
  a whole file; retain its existing `describe.skipIf(...)` layout.
- Do not touch pre-existing Docker containers. The integration suite may remove only
  its own `kortix-module-runtime-<random>` container.
- The old heartbeat request and database signature require no compatibility path.
- A successful heartbeat grants at most 30 seconds and never passes the execution
  deadline.

## File Map

- `apps/api/src/module-runtime/app.ts`: strict private heartbeat HTTP schema.
- `apps/api/src/module-runtime/app.test.ts`: wire-contract acceptance and rejection.
- `apps/api/src/module-runtime/runner-protocol.ts`: authenticated Runner command and
  repository forwarding.
- `apps/api/src/module-runtime/runner-protocol.test.ts`: protocol-level heartbeat
  behavior.
- `apps/api/src/module-runtime/executions.ts`: repository contract, shared duration,
  and deterministic memory implementation.
- `apps/api/src/module-runtime/executions.test.ts`: execution-deadline cap coverage.
- `apps/api/src/module-runtime/executions.drizzle.ts`: six-argument PostgreSQL call.
- `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`:
  authoritative renewal calculation and obsolete-overload removal.
- `packages/db/scripts/module-runtime-migration.integration.test.ts`: real PostgreSQL
  timing, cap, signature, permissions, and regression coverage.

---

### Task 1: Remove Runner deadline input and implement deterministic memory renewal

**Files:**

- Modify: `apps/api/src/module-runtime/app.test.ts`
- Modify: `apps/api/src/module-runtime/app.ts:390`
- Modify: `apps/api/src/module-runtime/runner-protocol.test.ts:273`
- Modify: `apps/api/src/module-runtime/runner-protocol.ts:88,208,334,430`
- Modify: `apps/api/src/module-runtime/executions.test.ts`
- Modify: `apps/api/src/module-runtime/executions.ts:102,637,768`
- Modify: `apps/api/src/module-runtime/executions.drizzle.ts:534`

**Interfaces:**

- Produces:

```typescript
export const MODULE_EXECUTION_LEASE_DURATION_MS = 30_000;

export interface RunnerLeaseHeartbeatCommand {
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
}

export interface HeartbeatModuleExecutionLeaseCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
}
```

- Preserves: `HeartbeatModuleExecutionLeaseResult` with both `execution` and `lease`,
  including the authoritative `lease.deadlineAt` response field.

- [x] **Step 1: Add failing strict-wire tests**

Add a test that installs a heartbeat protocol spy, sends the four trusted fields, and
asserts that the exact four-field command reaches `heartbeatLease`. Add a second
request with an extra far-future `deadlineAt` and assert HTTP 400 with no protocol
call:

```typescript
const command = {
  projectId: '40000000-0000-4000-a000-000000000004',
  executionId: EXECUTION_ID,
  leaseId: '50000000-0000-4000-a000-000000000005',
  generation: 3,
};

expect(validResponse.status).toBe(409);
expect(received).toEqual(command);

expect(legacyResponse.status).toBe(400);
expect(await legacyResponse.json()).toEqual({ error: 'RUNNER_EXECUTION_UNAVAILABLE' });
expect(callCount).toBe(1);
```

Have the spy throw
`new ModuleRunnerProtocolError('RUNNER_EXECUTION_UNAVAILABLE', 409)` after capturing
the valid command so the test does not need to fabricate a persistence result.

- [x] **Step 2: Add failing protocol and memory deadline tests**

Update the existing authenticated heartbeat test to omit `deadlineAt` and expect the
repository clock's 30-second result:

```typescript
const heartbeat = await protocol.heartbeatLease(identity, {
  projectId: PROJECT_ID,
  executionId: execution.executionId,
  leaseId: lease.leaseId,
  generation: lease.generation,
});

expect(heartbeat.execution.state).toBe('running');
expect(heartbeat.lease.deadlineAt).toBe('2026-07-27T08:00:30.000Z');
```

In `executions.test.ts`, seed a `leased` execution ending at
`2026-07-27T08:00:20.000Z`, a live matching lease, and an injected repository clock of
`2026-07-27T08:00:00.000Z`. Call `heartbeatLease` without a deadline and assert:

```typescript
expect(result.execution.state).toBe('running');
expect(result.lease.deadlineAt).toBe('2026-07-27T08:00:20.000Z');
```

- [x] **Step 3: Run the focused tests and capture RED**

Run:

```powershell
cd apps/api
bun test src/module-runtime/app.test.ts src/module-runtime/runner-protocol.test.ts src/module-runtime/executions.test.ts
```

Expected: failures show that the route still requires or accepts `deadlineAt`, and the
repositories do not yet derive a 30-second bounded deadline. Do not weaken assertions.

- [x] **Step 4: Remove the external and repository deadline fields**

Delete `deadlineAt` from the Zod heartbeat object, `RunnerLeaseHeartbeatCommand`, and
`HeartbeatModuleExecutionLeaseCommand`. Remove forwarding from
`ModuleRunnerProtocol.heartbeatLease(...)`:

```typescript
return this.input.executionRepository.heartbeatLease({
  accountId: runner.accountId,
  projectId: command.projectId,
  executionId: command.executionId,
  leaseId: command.leaseId,
  generation: command.generation,
  runnerId: runner.runnerId,
});
```

Export `MODULE_EXECUTION_LEASE_DURATION_MS = 30_000` from `executions.ts` and use it
as the default initial claim duration in `runner-protocol.ts`. Retain the existing
trusted `leaseDurationMs` constructor override for initial-claim tests; it does not
apply to heartbeats.

- [x] **Step 5: Implement one-clock-read memory renewal**

Capture `now()` once before validation, require both the lease and execution to remain
live at that instant, and calculate the deadline internally:

```typescript
const observedAt = now();
const observedAtMs = observedAt.valueOf();
const executionDeadlineMs = Date.parse(execution.deadlineAt);

if (
  Date.parse(lease.deadlineAt) <= observedAtMs ||
  executionDeadlineMs <= observedAtMs
) {
  throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
}

const deadlineAt = new Date(
  Math.min(observedAtMs + MODULE_EXECUTION_LEASE_DURATION_MS, executionDeadlineMs),
).toISOString();
```

Use `deadlineAt` for the new lease and `observedAt.toISOString()` for the execution
update and heartbeat event. Keep every existing tuple, state, release, and generation
check.

- [x] **Step 6: Update the Drizzle adapter to the six-argument call**

Remove the deleted command field from the SQL invocation. PostgreSQL's current
seven-argument draft has a default for its final argument, so this call remains valid
during Task 1 and becomes the final signature in Task 2:

```typescript
await db.execute(sql`
  SELECT * FROM kortix.heartbeat_module_execution(
    ${command.accountId}::uuid,
    ${command.projectId}::uuid,
    ${command.executionId}::uuid,
    ${command.leaseId}::uuid,
    ${command.generation}::integer,
    ${command.runnerId}::uuid
  )
`);
```

Keep the existing conflict mapping and post-call row reads unchanged.

- [x] **Step 7: Run focused tests and typecheck for GREEN**

Run:

```powershell
cd apps/api
bun test src/module-runtime/app.test.ts src/module-runtime/runner-protocol.test.ts src/module-runtime/executions.test.ts
cd ../..
pnpm.cmd --filter kortix-api typecheck
```

Expected: all focused tests and API typecheck pass with zero failures.

---

### Task 2: Make PostgreSQL authoritative and remove the obsolete overload

**Files:**

- Modify: `packages/db/scripts/module-runtime-migration.integration.test.ts:201,447,516,639`
- Modify: `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql:903,1194`

**Interfaces:**

- Consumes: the six-value Drizzle call and `HeartbeatModuleExecutionLeaseCommand`
  without `deadlineAt` from Task 1.
- Produces:

```sql
kortix.heartbeat_module_execution(
  p_account_id uuid,
  p_project_id uuid,
  p_execution_id uuid,
  p_lease_id uuid,
  p_generation integer,
  p_runner_id uuid
)
```

- Preserves return columns: `lease_id`, `execution_id`, `generation`, `deadline_at`,
  and `state` in their current order and types.

- [x] **Step 1: Rewrite integration assertions to express server-owned time**

In the idempotency shape query, assert that the six-argument signature exists and the
seven-argument signature does not:

```sql
to_regprocedure(
  'kortix.heartbeat_module_execution(uuid,uuid,uuid,uuid,integer,uuid)'
) IS NOT NULL,
to_regprocedure(
  'kortix.heartbeat_module_execution(uuid,uuid,uuid,uuid,integer,uuid,timestamptz)'
) IS NULL
```

Change the happy-path heartbeat to six arguments and assert a robust 25-to-30-second
window rather than exact host time:

```sql
SELECT
  lease_id,
  execution_id,
  generation,
  deadline_at > clock_timestamp() + interval '25 seconds',
  deadline_at <= clock_timestamp() + interval '30 seconds',
  state
FROM kortix.heartbeat_module_execution(
  '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_HEARTBEAT}',
  '${LEASE_HEARTBEAT}', 1, '${RUNNER_A}'
);
```

Replace the old “rejects extension beyond execution deadline” test with an execution
whose deadline is approximately 10 seconds away. Assert the six-argument heartbeat
succeeds and its returned and persisted lease deadline equal that immutable execution
deadline.

Update the `service_role` heartbeat permission probe to the six-argument signature;
retain its SQLSTATE `42501` assertion.

- [x] **Step 2: Run the real PostgreSQL test and capture RED once**

First inspect only matching containers:

```powershell
docker ps -a --filter "name=kortix-module-runtime-" --format "{{.Names}}"
cd packages/db
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: the timing/cap/signature assertions fail against the current function. Keep
the complete failure output. Do not retry RED until it happens to pass. Confirm the
test's randomly named container is removed; do not touch any other container.

- [x] **Step 3: Replace the database function signature safely**

Immediately before the heartbeat function definition, remove the obsolete overload:

```sql
DROP FUNCTION IF EXISTS kortix.heartbeat_module_execution(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz
);
```

Create the six-argument function and add `v_observed_at timestamptz`. Keep the existing
lease-then-execution lock order and all tuple filters. Move lease expiry evaluation
until after both locks are held, then use one database timestamp:

```sql
v_observed_at := clock_timestamp();

IF v_lease.deadline_at <= v_observed_at THEN
  RAISE EXCEPTION 'module execution lease not found';
END IF;

IF v_execution.deadline_at <= v_observed_at THEN
  RAISE EXCEPTION 'module execution not found';
END IF;

v_deadline := LEAST(
  v_observed_at + interval '30 seconds',
  v_execution.deadline_at
);
```

Persist `v_deadline`, insert the heartbeat with `v_observed_at`, and return
`v_deadline`. Remove all `p_deadline_at` logic. Update the final `REVOKE ALL ON
FUNCTION` entry to the six-argument signature so `PUBLIC`, `anon`, `authenticated`,
and `service_role` remain denied.

- [x] **Step 4: Run migration integration and affected typechecks for GREEN**

Run:

```powershell
cd packages/db
bun test scripts/module-runtime-migration.integration.test.ts
cd ../..
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd migrate:lint
```

Expected: the integration suite passes once, both typechecks pass, and migration lint
passes with only its already-known repository warnings. Any new warning or failure is
part of this task and must be fixed before continuing.

---

### Task 3: Regression verification and worktree audit

**Files:**

- Verify only; do not modify unrelated files to satisfy global checks.

**Interfaces:**

- Consumes: the four-field Runner heartbeat contract and six-argument PostgreSQL
  function from Tasks 1 and 2.
- Produces: reproducible evidence that the security boundary and existing module
  runtime behavior remain intact.

- [x] **Step 1: Run all focused module runtime suites**

Run:

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

Expected: every suite passes with zero failures.

- [x] **Step 2: Run the real PostgreSQL suite three consecutive times**

From `packages/db`, run the exact command three times without hiding any failure:

```powershell
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: all three runs pass. Preserve each run's full test names, timings, and
pass/fail totals. If any run fails, report that run and diagnose it; do not retry until
three lucky outputs are obtained.

- [x] **Step 3: Run package checks and restored full test suite**

Run from the repository root:

```powershell
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter @openopc/module-runtime-contracts typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd migrate:lint
pnpm.cmd test
```

Expected: affected typechecks and the full workspace test command pass. Report any
pre-existing unrelated full-suite failure verbatim; do not edit unrelated code to
mask it.

- [x] **Step 4: Run targeted static and repository hygiene checks**

Run:

```powershell
pnpm.cmd exec biome check apps/api/src/module-runtime/app.ts apps/api/src/module-runtime/app.test.ts apps/api/src/module-runtime/runner-protocol.ts apps/api/src/module-runtime/runner-protocol.test.ts apps/api/src/module-runtime/executions.ts apps/api/src/module-runtime/executions.test.ts apps/api/src/module-runtime/executions.drizzle.ts
git diff --check
git diff --name-only -- docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md tests/module-beta/evidence.json
docker ps -a --filter "name=kortix-module-runtime-" --format "{{.Names}}"
git status --porcelain --untracked-files=all
```

Expected: touched TypeScript files have no new Biome issue, `git diff --check` is
clean, protected-file output is empty, the test-container filter is empty, and status
shows only intended changes plus pre-existing user work. Do not format the integration
test merely to change its known whole-file layout.

- [x] **Step 5: Report evidence without committing**

Report in Chinese:

- the removed HTTP and TypeScript `deadlineAt` fields;
- the PostgreSQL `clock_timestamp()` calculation and six-argument signature;
- the old-overload absence assertion;
- RED output and the subsequent focused GREEN output;
- all three PostgreSQL integration outputs with per-test timings and totals;
- typecheck, migration lint, full-suite, Biome, protected-file, container, and worktree
  outputs;
- any residual risk or unrelated failure exactly as observed.

Do not commit or push after reporting.
