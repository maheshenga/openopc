# Module Runtime `service_role` Isolation Implementation Plan

> **For the current Codex session:** Execute this plan inline in the existing
> `studio-platform` checkout. Do not use Superpowers, subagents, commits, or pushes.
> Track every RED and GREEN result explicitly.

**Goal:** Prevent Supabase JWT roles, especially `service_role`, from bypassing the
mTLS Runner HTTP boundary to read or mutate module runtime control-plane state.

**Architecture:** The module runtime schema remains private to the API's direct
PostgreSQL connection. The existing migration revokes all table and procedure access
from Supabase JWT roles, while the database owner used by the Drizzle repositories
retains its existing privileges. No new database role, connection pool, environment
variable, service, route, or SDK contract is introduced.

**Tech Stack:** PostgreSQL 16, PL/pgSQL, Bun test, Docker, Drizzle schema tests,
TypeScript, pnpm workspace tooling.

## Global Constraints

- Work only in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`.
- Never run `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Do not modify user changes outside the files named in this plan.
- Do not modify `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`.
- Do not modify `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`.
- Do not modify `tests/module-beta/evidence.json`.
- Do not commit or push.
- Use `pnpm.cmd`; invoke Bun as `bun`.
- Do not format the existing single-line `describe.skipIf(...)` layout or trigger an
  unrelated full-file reformat.
- Do not touch containers that this test did not create. Remove every container whose
  name starts with `kortix-module-runtime-` if and only if it was created by this run.
- Preserve every existing test and happy-path assertion.

## File Map

- Modify `packages/db/scripts/module-runtime-migration.integration.test.ts`: add the
  real PostgreSQL RED/GREEN privilege-boundary test and isolated fixtures.
- Modify `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`:
  remove `service_role` grants and include it in all revocations.
- Keep `packages/db/src/module-runtime-schema.test.ts` unchanged; run it as the Drizzle
  schema regression gate.
- Keep API, contracts, SDK, deployment, and shared Kortix database client code
  unchanged.

---

### Task 1: Prove the Existing `service_role` Bypass

**Files:**

- Modify: `packages/db/scripts/module-runtime-migration.integration.test.ts`
- Test: `packages/db/scripts/module-runtime-migration.integration.test.ts`

**Interfaces:**

- Consumes: the existing `dockerPsql(sql, allowFailure)` harness and migration-owned
  `claim_module_execution`, `heartbeat_module_execution`, and
  `finalize_module_execution` procedures.
- Produces: one isolated integration test that fails against the current grants and
  passes only when `service_role` has no module runtime table or procedure authority.

- [x] **Step 1: Add isolated execution and lease identifiers**

Add constants beside the existing execution and lease constants:

```typescript
const EXECUTION_SERVICE_ROLE_CLAIM = '80000000-0000-4000-a000-000000000009';
const EXECUTION_SERVICE_ROLE_LEASED = '80000000-0000-4000-a000-000000000010';
const LEASE_SERVICE_ROLE = '90000000-0000-4000-a000-000000000009';
const LEASE_SERVICE_ROLE_FORBIDDEN = '90000000-0000-4000-a000-000000000010';
```

- [x] **Step 2: Add the failing real-PostgreSQL privilege test**

Insert a test before the existing terminal-finalize happy path. Seed two dispatchable
executions by copying immutable bindings from `EXECUTION_A` with distinct execution
IDs and idempotency keys. Claim `EXECUTION_SERVICE_ROLE_LEASED` as the database owner
to create a valid live lease. Then verify all direct calls made after
`SET LOCAL ROLE service_role` fail.

The test body must use this assertion shape for claim, heartbeat, and finalize:

```typescript
const attempts = [
  dockerPsql(
    `\set VERBOSITY verbose
     BEGIN;
     SET LOCAL ROLE service_role;
     SELECT * FROM kortix.claim_module_execution(
       '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_CLAIM}', '${RUNNER_A}',
       '${LEASE_SERVICE_ROLE_FORBIDDEN}', 1, now() + interval '30 seconds'
     );
     ROLLBACK;`,
    true,
  ),
  dockerPsql(
    `\set VERBOSITY verbose
     BEGIN;
     SET LOCAL ROLE service_role;
     SELECT * FROM kortix.heartbeat_module_execution(
       '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_LEASED}',
       '${LEASE_SERVICE_ROLE}', 1, '${RUNNER_A}', now() + interval '30 seconds'
     );
     ROLLBACK;`,
    true,
  ),
  dockerPsql(
    `\set VERBOSITY verbose
     BEGIN;
     SET LOCAL ROLE service_role;
     SELECT * FROM kortix.finalize_module_execution(
       '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_LEASED}',
       '${LEASE_SERVICE_ROLE}', 1, '${RUNNER_A}', 'succeeded', '${DIGEST_B}',
       '{"outcome":"succeeded"}'::jsonb, 'outbox-service-role-forbidden',
       '{"usage":[]}'::jsonb
     );
     ROLLBACK;`,
    true,
  ),
];

for (const attempt of attempts) {
  expect(attempt.exitCode).not.toBe(0);
  expect(attempt.output).toMatch(/42501/);
  expect(attempt.output).toMatch(/permission denied for function/i);
  expect(attempt.output).not.toMatch(/not found|does not exist|missing lease/i);
}
```

Also query effective privileges as the database owner. Use
`has_table_privilege` across all seven PostgreSQL table privileges for every one of
the 14 runtime tables, and use `has_function_privilege` for the three Runner
procedures plus all three trigger functions:

```sql
SELECT
  (SELECT count(*)
   FROM unnest(ARRAY[
       'module_runtime_descriptors',
       'project_module_consent_revisions',
       'module_runners',
       'module_runner_profiles',
       'module_executions',
       'module_execution_leases',
       'module_execution_heartbeats',
       'module_capability_grants',
       'module_capability_uses',
       'module_execution_events',
       'module_execution_outputs',
       'module_execution_evidence',
       'module_kill_switch_generations', 'module_execution_outbox'
   ]) AS runtime_table(table_name)
   CROSS JOIN unnest(ARRAY[
     'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
   ]) AS requested(privilege)
   WHERE has_table_privilege(
     'service_role', format('kortix.%I', runtime_table.table_name), requested.privilege
   )),
  (SELECT count(*)
   FROM pg_proc AS procedure
   INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'kortix'
     AND procedure.proname IN (
       'claim_module_execution', 'heartbeat_module_execution',
       'finalize_module_execution', 'reject_module_runtime_append_only',
       'protect_module_execution', 'protect_module_execution_outbox'
     )
     AND has_function_privilege('service_role', procedure.oid, 'EXECUTE'));
```

Assert both effective privilege counts are zero. Give the test the existing
`DOCKER_TEST_TIMEOUT` third argument.

- [x] **Step 3: Run the test once and retain the RED output**

Run from `packages/db`:

```powershell
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected RED: the new test reports non-zero table/procedure grant counts or one of the
three direct calls exits `0`. Existing tests remain present; do not weaken their
assertions to obtain RED.

---

### Task 2: Remove the Supabase JWT-Role Grants

**Files:**

- Modify: `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`
- Test: `packages/db/scripts/module-runtime-migration.integration.test.ts`

**Interfaces:**

- Consumes: existing API database-owner execution through `DATABASE_URL`.
- Produces: an idempotent migration where Supabase JWT roles have no privileges on
  module runtime tables or procedures and owner happy paths are unchanged.

- [x] **Step 1: Tighten the function revocation**

Change the existing procedure/trigger-function revocation principal list to:

```sql
FROM PUBLIC, anon, authenticated, service_role;
```

This list applies to the three Runner procedures and all module runtime trigger
functions in the existing `REVOKE ALL ON FUNCTION` statement.

- [x] **Step 2: Remove every module runtime grant to `service_role`**

Delete both table grant blocks:

```sql
GRANT SELECT, INSERT ON TABLE ... TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE ... TO service_role;
```

Delete the procedure grant block:

```sql
GRANT EXECUTE ON FUNCTION ... TO service_role;
```

Keep the preceding table-level `REVOKE ALL ... FROM PUBLIC, anon, authenticated,
service_role` statement intact. Do not create a replacement role or grant.

- [x] **Step 3: Run the integration test and retain the first GREEN output**

Run from `packages/db`:

```powershell
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected GREEN: `15 pass`, `0 fail`. The new test must observe SQLSTATE `42501`
messages, and every previous owner happy path must still pass.

- [x] **Step 4: Check the exact migration diff**

Run from the repository root:

```powershell
git diff -- packages/db/migrations/20260727150000000_module_runtime_control_plane.sql packages/db/scripts/module-runtime-migration.integration.test.ts
```

Confirm the diff contains only the new test fixtures/assertions and grant removal. It
must not change procedure return columns, function bodies, lease rules, or formatting
outside the edited grant block.

---

### Task 3: Regression and Stability Gates

**Files:**

- Verify: `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`
- Verify: `packages/db/scripts/module-runtime-migration.integration.test.ts`
- Verify unchanged: `packages/db/src/module-runtime-schema.test.ts`
- Verify unchanged: `apps/api/src/module-runtime/*.test.ts`
- Verify unchanged: `packages/module-runtime-contracts/src/contracts.test.ts`
- Verify unchanged: `packages/sdk/src/core/rest/projects-client/module-executions.test.ts`

**Interfaces:**

- Consumes: the GREEN migration and integration test from Task 2.
- Produces: repeatable timing, type, migration, package, hygiene, and cleanup evidence.

- [x] **Step 1: Run the real PostgreSQL suite two more times**

The Task 2 GREEN run is run 1. From `packages/db`, execute two additional independent
runs:

```powershell
bun test scripts/module-runtime-migration.integration.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected for all three consecutive runs: `15 pass`, `0 fail`. Preserve each run's
per-test timing and final pass/fail lines. Stop and report the first failure rather
than retrying until green.

- [x] **Step 2: Run focused package tests**

```powershell
Set-Location packages/db
bun test src/module-runtime-schema.test.ts

Set-Location ../../apps/api
bun test src/module-runtime

Set-Location ../../packages/module-runtime-contracts
bun test src/contracts.test.ts

Set-Location ../sdk
bun test --isolate src/core/rest/projects-client/module-executions.test.ts
```

Expected: DB schema `6 pass`; all module runtime API, contracts, and SDK tests pass
with zero failures. Report exact counts from the current run.

- [x] **Step 3: Run migration and type gates from the repository root**

```powershell
pnpm.cmd migrate:lint
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @openopc/module-runtime-contracts typecheck
pnpm.cmd --filter @kortix/sdk typecheck
```

Expected: every command exits `0`. If the known API Bash/Node environment prevents an
official wrapper from running, do not claim that wrapper passed; retain the direct Bun
test evidence from Step 2.

- [x] **Step 4: Run source hygiene checks without reformatting**

```powershell
pnpm.cmd exec biome check packages/db/migrations/20260727150000000_module_runtime_control_plane.sql packages/db/scripts/module-runtime-migration.integration.test.ts
git diff --check
git diff -- docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md tests/module-beta/evidence.json
git status --porcelain --untracked-files=all
docker ps -a --filter "name=kortix-module-runtime-" --format "{{.Names}}"
```

Expected: `git diff --check` is empty; protected-file diff is empty; Docker filter is
empty. If Biome reports only the pre-existing whole-file layout issue, preserve its
exact output and do not run a formatter.

- [x] **Step 5: Produce the final Chinese report**

Report, in order:

1. The revoked table and procedure permissions and why API behavior is unchanged.
2. The original RED output proving the bypass existed.
3. All three consecutive integration outputs with individual test timings and
   pass/fail totals.
4. Focused test, typecheck, migration lint, hygiene, protected-file, and container
   cleanup outputs.
5. Any remaining audit findings, explicitly noting that heartbeat deadline control,
   evidence TOCTOU, lock ordering, null binding, resource ceilings, mixed clocks, and
   duplicate Runner registration are outside this focused fix.

Do not state that the entire monorepo or official API wrapper passed unless those exact
commands were executed successfully in this run.

## Completion Record

Status: implemented and independently reverified on 2026-07-27.

- The migration revokes all runtime-table and protected-function privileges from
  `PUBLIC`, `anon`, `authenticated`, and `service_role`; no replacement JWT-role
  grant was introduced.
- The retained three-run PostgreSQL evidence was produced after later runtime
  regressions expanded the suite from the planned `15` tests to `18`: every run was
  `18 pass / 0 fail`, taking `44.66s`, `42.19s`, and `40.12s`.
- A separate focused rerun of the `service_role` boundary test passed with `13`
  assertions in `849.44ms` (`1 pass`, `17 filtered out`, `0 fail`; total `29.06s`).
- Focused API, database schema, contracts, and SDK suites passed with `29`, `7`, `10`,
  and `1` tests respectively. Migration lint passed `81` files with seven existing
  warnings, and all four affected typechecks passed.
- The original RED stdout is not retained in this task window. The failing test and
  design record preserve the demonstrated bypass, but this record does not invent an
  exact historical pass/fail count.
- The full workspace test remains non-green only for the four recorded unrelated
  baseline failures: one Windows file-mode assertion and three manifest-schema JSON
  synchronization checks.
