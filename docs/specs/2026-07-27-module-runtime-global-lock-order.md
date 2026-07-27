# Module Runtime Global Execution and Lease Lock Order

Status: implemented and verified on 2026-07-27

## Implementation Record

- Heartbeat, finalize, claim abandonment, and capability-grant storage now follow
  `module_executions -> module_execution_leases`; claim, cancellation, and expiry
  retain their existing execution-first behavior.
- Focused API, database schema, contracts, and SDK suites passed with `29`, `7`,
  `10`, and `1` tests respectively.
- The real PostgreSQL integration suite passed three consecutive runs with `18 pass`
  and `0 fail` in each run.
- Migration lint passed all `81` migration files with the existing seven warnings,
  and all four affected package typechecks passed.
- The full workspace test command was run once. It remains non-green because of four
  unrelated baseline failures: one Windows file-mode assertion expects `0600` but
  observes `0666`, and three manifest-schema checks report committed JSON fixtures
  out of synchronization. No module-runtime test failed in that run.
- Protected files were unchanged, no `kortix-module-runtime-*` test container
  remained, and no commit or push was performed.

## Context

Before this change, the module runtime control plane had no single lock-order
invariant for an execution and its lease. The paths were:

- `claim_module_execution`: execution, then Runner, then lease insertion;
- `heartbeat_module_execution`: lease, then execution;
- `finalize_module_execution`: lease, then execution;
- expiry and cancellation: execution, then lease;
- claim abandonment: lease, then execution;
- capability-grant storage: one `FOR UPDATE OF lease_row, execution` query whose
  physical row-lock order is left to the PostgreSQL query plan;
- progress append: execution only; and
- event append: execution only.

This creates a direct cycle between cancellation or expiry and heartbeat or
finalization. A disposable PostgreSQL 16 reproduction confirmed the cycle with the
real migration and the same statements used by the control plane:

1. The cancellation path updated and locked the execution row.
2. The heartbeat transaction locked the live lease row.
3. Cancellation waited to release the lease.
4. Heartbeat entered `heartbeat_module_execution`, reacquired its lease lock, and
   waited for the execution.
5. PostgreSQL reported `deadlock detected` and aborted the cancellation transaction.

Deadlock retry would reduce the visible failure rate but would not remove the
contradictory protocol. A second advisory-lock protocol would add operational and
maintenance complexity. The selected design instead makes the existing rows obey one
global order.

## Goals

- Establish one explicit execution/lease row-lock order for every module runtime
  transaction.
- Remove the confirmed cancellation-versus-heartbeat/finalize deadlock cycle.
- Make lock order independent of PostgreSQL join planning.
- Preserve public APIs, SQL function signatures, result columns, HTTP status codes,
  repository errors, permissions, events, and persisted state transitions.
- Prove the new order with deterministic real-PostgreSQL concurrency coverage.
- Keep the change inside the additive OpenOPC module runtime boundary.

## Non-goals

- Adding deadlock retries, advisory locks to production code, or a queue.
- Changing lease duration, heartbeat timing, execution deadlines, or fencing rules.
- Changing the event-sequence serialization introduced for progress append.
- Redesigning Runner, capability-grant, evidence, or outbox schemas.
- Normalizing unrelated Kortix transaction locking.
- Changing deployment topology or public SDK contracts.

## Considered Approaches

### Execution then lease for every combined path (selected)

Every transaction that must lock both resources first obtains the tenant-scoped
execution row with `FOR UPDATE` or an equivalent `UPDATE`, then obtains the specific
lease row. Claim already starts with execution and can continue to insert the new
lease after its existing Runner checks.

This direction matches cancellation, expiry, claim, progress serialization, and event
sequence allocation. It requires focused changes to the two PostgreSQL functions and
two Drizzle repository methods but introduces no new locking primitive.

### Transaction-scoped advisory lock before row locks

Every path could take an advisory lock derived from the execution identifier before
touching either table. This would serialize the paths even if their row-lock order
remained mixed. It creates a second lock namespace, requires collision and key
derivation rules, and fails open if any future path forgets the advisory lock.

### Retry deadlocks

The repository could retry PostgreSQL `40P01` failures. This does not remove the
cycle, makes latency and side-effect reasoning less predictable, and can repeatedly
abort work under sustained heartbeat traffic. It is recovery behavior, not a lock
protocol.

## Decision

The global invariant is:

```text
module_executions -> module_execution_leases
```

Any module runtime transaction that takes row locks on both tables must lock the
tenant-scoped execution first and the matching lease second. Queries may read a lease
without locking it, but no path may acquire a lease row lock and later request the
execution row. A multi-table `FOR UPDATE` clause is not sufficient because it does not
express a stable inter-table acquisition order.

The invariant applies within one execution. Transactions operating on different
execution identifiers remain concurrent.

## Function Changes

### Heartbeat

`heartbeat_module_execution` will lock the execution row first and the fenced lease
row second. It will defer state and deadline validation until both rows have been
looked up so the existing error precedence remains intact.

An absent tenant-scoped execution will raise the existing lease-not-found class of
error. This matches current behavior because the function currently checks the lease
first, and the lease foreign key prevents a valid lease without its execution. After
both locks are held, the function will retain the current checks and mutation order:

1. execution state is `leased` or `running`;
2. lease and execution deadlines are live;
3. the new server-owned lease deadline is calculated;
4. the lease deadline is updated;
5. a leased execution becomes running; and
6. the heartbeat evidence row is appended.

The function signature, six-argument overload, return columns, 30-second duration,
execution-deadline cap, and permissions remain unchanged.

### Finalize

`finalize_module_execution` will keep its input validation before row access, then
lock the execution first and the fenced lease second. It will defer execution-state
and deadline validation until the lease lookup completes. Missing or cross-tenant
rows will retain the lease-stale error wording used by the repository mapping.

After both locks are held, finalization keeps the existing behavior: release the
lease, write terminal execution state, persist immutable evidence, append the terminal
event, and enqueue the outbox row in one transaction. The security-definer boundary,
search path, function signature, result columns, and grants do not change.

## Repository Changes

### Claim abandonment

`abandonClaim` will explicitly lock and validate the tenant-scoped execution in
`leased` state before updating the fenced live lease. A missing execution, invalid
state, or stale lease continues to produce `MODULE_EXECUTION_LEASE_STALE` with HTTP
409. The transaction then changes the already-locked execution to `dispatchable`,
revokes grants, and appends the abandonment event.

Any later validation failure rolls back all changes, so the operation cannot expose
a dispatchable execution with an unreleased lease or a released lease with a leased
execution.

### Capability-grant storage

`storeCapabilityGrants` will replace its combined multi-table lock with two explicit
queries in the same transaction:

1. lock the tenant-scoped execution and require state `leased` or `running`;
2. lock the exact live lease and validate Runner, generation, deadline, and requested
   grant expiry against that lease.

Only after both steps succeed may grant rows be inserted. The execution lock prevents
cancel, expire, abandon, or finalize from changing state while the lease validation
waits. The lease predicates are evaluated after its lock is acquired, so a concurrent
release cannot be accepted from a stale snapshot.

An empty result at either step continues to return
`MODULE_EXECUTION_LEASE_STALE` with HTTP 409. Grant fields and token behavior do not
change.

## Paths That Remain Unchanged

- Claim already locks execution before inserting a lease.
- Cancellation and expiry already update execution before releasing a lease.
- Progress append locks only execution and deliberately does not lock the lease.
- Event append locks only execution for sequence allocation.
- Reads that take no row lock do not participate in the lock-order graph.

The Runner row locked by claim is outside this two-table invariant. No reverse
Runner-to-execution path was found in the module runtime control-plane boundary.

## Concurrency Semantics

When cancellation or expiry obtains execution first, heartbeat, finalize, abandonment,
and capability-grant storage wait before acquiring a lease lock. The terminal or
dispatchable transition can therefore update both rows and commit without forming a
cycle. The waiter resumes, rechecks the current row predicates at PostgreSQL
`READ COMMITTED` isolation, and returns the existing stale/state conflict.

When heartbeat or finalization obtains execution first, cancellation and expiry wait
before changing state. Heartbeat can extend the lease and commit, after which the
terminal operation proceeds. Finalization can atomically make the execution terminal
and release the lease, after which a waiting cancellation observes terminal state and
uses its existing conflict behavior.

The invariant prevents a transaction holding a lease lock from waiting for execution,
so the confirmed two-row cycle cannot form among compliant paths.

## Error and Compatibility Behavior

- SQL input validation remains before row mutation.
- Missing, wrong-tenant, wrong-Runner, released, expired, or stale-generation leases
  continue to map to `MODULE_EXECUTION_LEASE_STALE` where they do today.
- Invalid execution state continues to map to the current stale/state conflict for
  each repository method.
- No raw PostgreSQL deadlock error becomes part of the public contract.
- Function names, arguments, result column names, and privilege boundaries remain
  unchanged.
- Existing execution, lease, heartbeat, evidence, event, grant, and outbox schemas
  remain unchanged.

## Verification Design

Implementation follows test-driven development.

### Real PostgreSQL RED and regression

The migration integration suite will install a test-only `AFTER UPDATE` trigger on
`module_executions`. For one named cancellation session and one seeded execution, the
trigger waits on a test advisory gate after cancellation has updated and locked the
execution but before the repository can update the lease.

The test then starts a real repository heartbeat in a second named session and uses
`pg_stat_activity` to confirm it is waiting. Releasing the cancellation gate produces
these results:

- Before the fix, heartbeat has already locked lease and waits for execution;
  cancellation then waits for lease, PostgreSQL detects a deadlock, and the expected
  cancellation result is lost.
- After the fix, heartbeat waits for execution without holding lease; cancellation
  releases lease and commits, then heartbeat resumes and returns the existing conflict
  without a deadlock.

The assertion requires cancellation to succeed, heartbeat to reject with the existing
domain conflict, the execution to remain cancelled, the lease to be released, and no
`deadlock detected` result. Application names and observed lock waits provide the
ordering; arbitrary sleeps are not used as correctness gates. The cancellation test
session uses a shorter test-only `deadlock_timeout` than the heartbeat session so the
current implementation deterministically aborts the transaction that closes the
cycle. This setting is diagnostic scaffolding and does not alter production database
configuration.

### Static and repository coverage

- The DB schema test will assert that heartbeat and finalize lock execution before
  lease and contain no lease-then-execution sequence.
- Drizzle repository tests will assert that `abandonClaim` locks execution before
  updating lease.
- Drizzle repository tests will assert that capability-grant storage issues separate
  execution and lease lock queries in that order and inserts nothing when either
  validation fails.
- Existing heartbeat, finalize, cancellation, expiry, append/finalize serialization,
  permissions, tenant-isolation, immutable evidence, and outbox tests remain intact.

Focused verification will include three consecutive real PostgreSQL integration runs,
module runtime DB schema and API/repository tests, contracts and SDK tests, affected
package typechecks, migration lint, protected-file checks, Git status, and zero
residual `kortix-module-runtime-*` test containers. Full workspace tests will also run;
unrelated baseline failures will be reported rather than hidden.

## Upgrade Compatibility

The change is confined to the additive OpenOPC module runtime migration, repository,
and focused tests. It does not modify Kortix base tables, authentication, existing
routes, shared services, deployment manifests, or public SDK contracts. The invariant
is documented in the module runtime boundary so future upstream merges need only keep
new execution/lease paths compliant with one explicit rule.

## Acceptance Criteria

- Every transaction that row-locks execution and lease uses execution then lease.
- Heartbeat and finalize no longer lock lease before execution.
- Claim abandonment and capability-grant storage follow the same explicit order.
- No combined multi-table `FOR UPDATE` remains in the module runtime repository.
- The confirmed cancellation-versus-heartbeat cycle no longer produces PostgreSQL
  `40P01` or aborts cancellation.
- Existing state transitions, fencing, deadlines, error codes, events, evidence,
  outbox behavior, permissions, and public contracts remain unchanged.
- Deterministic real PostgreSQL concurrency coverage passes three consecutive runs.
- No protected file is modified, and no commit or push is performed.
