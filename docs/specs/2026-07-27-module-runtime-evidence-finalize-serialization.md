# Module Runtime Evidence and Finalize Serialization

Status: implemented; focused verification passed; full workspace verification has
unrelated baseline failures recorded in the implementation plan

## Context

`appendEvidence(...)` validates a live Runner lease and an execution in `leased` or
`running` state inside a database transaction, then calls `appendEvent(...)` in the
same transaction. The validation query does not lock either row. A concurrent
`finalize_module_execution(...)` can therefore release the lease and make the
execution terminal after validation succeeds but before the progress event is
inserted. The result can be a progress event committed after terminal finalization.

`appendEvent(...)` already locks the execution row before allocating the next event
sequence. That lock is the existing event-ordering mutex. The first draft of this
design proposed locking only the lease during validation, but that would actually
produce a lease-then-execution order when `appendEvent(...)` runs. Cancellation and
expiry use execution-then-lease, so the draft would have introduced a deadlock cycle.

All current paths that release a module execution lease also update the matching
execution in the same transaction: expiry, claim abandonment, cancellation, and
fenced finalization. The execution row can therefore serialize progress insertion
with those state changes without adding a lease lock to the append path.

Although the repository method is named `appendEvidence`, it appends a module
execution progress event. It does not write the immutable terminal evidence row that
is produced by fenced finalization.

## Goals

- Make live-lease validation and progress-event insertion atomic with respect to
  terminal execution state.
- Reuse the execution row lock already required for event sequence allocation.
- Ensure progress and terminal commits have one deterministic order.
- Preserve the existing HTTP, repository, event payload, and error contracts.
- Avoid adding a new edge to the existing mixed lease/execution lock graph.
- Prove both race orderings against a real PostgreSQL instance.

## Non-goals

- Changing the `appendEvidence(...)` request or event schema.
- Adding retries, queues, advisory locks, or a new PostgreSQL function.
- Normalizing every module runtime lock order in this task.
- Changing finalization, cancellation, expiry, or claim-abandonment behavior.
- Locking the lease row from `appendEvidence(...)`.
- Refactoring unrelated module runtime persistence code.

## Considered Approaches

### Lock only the execution row during validation (selected)

Run the live-lease JOIN as a parameterized query ending in
`FOR UPDATE OF execution`. Keep that lock and the progress-event insert in the same
transaction. `appendEvent(...)` then reacquires a row lock already owned by its
transaction and uses it to allocate the next event sequence.

This reuses the current event-ordering invariant. Append never requests a lease row
lock, so it cannot form a lease/execution lock cycle even when finalization already
holds the lease and is waiting for the execution row.

### Normalize every execution and lease lock order

Heartbeat, finalization, claim abandonment, cancellation, and expiry could be changed
to acquire both rows in one global order. This would improve the wider control plane,
but it changes PostgreSQL functions and several repository operations. It is a
separate lock-order project rather than the narrow evidence/finalize repair.

### Replace event sequence locking

The event stream could receive a dedicated counter or PostgreSQL append function so
progress insertion no longer locks the execution row. This expands schema, migration,
permission, and adapter surfaces without being required for the current guarantee.

## Decision

Replace the unlocked Drizzle live-lease lookup with a parameterized raw-SQL query,
following the repository's existing explicit row-lock style. The query retains every
current predicate:

- lease, execution, account, project, Runner, and generation identity;
- an unreleased lease;
- a lease deadline later than the database clock; and
- an execution state of `leased` or `running`.

The query selects the execution identifier and ends with:

```sql
FOR UPDATE OF execution
```

It deliberately does not lock `lease_row`. The successful query and
`appendEvent(...)` remain in one database transaction. The execution row therefore
stays locked from the authoritative state-and-lease check through event sequence
allocation and insertion.

No changes are made to `finalize_module_execution(...)`, database privileges, public
types, HTTP schemas, or event storage.

## Concurrency Semantics

The operation that acquires the execution row lock first defines the committed order.

When append wins the execution lock, it validates the visible live lease, inserts the
progress event, and commits. A concurrent finalize, cancel, or expire operation waits
for the execution row where it validates or updates execution state. It then continues
and commits terminal state after the progress event.

Finalization may acquire the lease row before append acquires the execution row. If
append wins the execution row, it does not wait for the lease row and therefore cannot
complete a deadlock cycle. It commits progress, releases the execution row, and lets
finalization continue. The durable order remains progress before terminal state.

When a terminal operation wins the execution lock, append waits. At PostgreSQL's
`READ COMMITTED` isolation level, the locking query rechecks the updated target
execution row after the waiter wakes. A terminal state no longer satisfies the
`leased` or `running` predicate, so append receives no matching row and inserts no
progress event.

Claim abandonment changes execution to `dispatchable`; cancellation and expiry make
it terminal; finalization writes its terminal outcome. Each change is committed in
the same transaction that releases the lease. Consequently, the execution predicate
also rejects an append ordered after any current lease-release path.

## Data Flow

1. The repository validates the event type and serialized payload size before opening
   a transaction, preserving the existing fast rejection path.
2. The transaction executes the parameterized live-lease JOIN with
   `FOR UPDATE OF execution`.
3. No matching row produces the existing stale-lease conflict.
4. A matching execution remains locked while `appendEvent(...)` repeats the same
   execution lock, reads the maximum event sequence, and inserts the next event.
5. Commit makes the progress event visible and releases the execution lock; rollback
   makes neither change visible.
6. A waiting state-changing operation resumes and re-evaluates its fencing and state
   conditions.

## Error Behavior

- Invalid event types and payloads larger than 256 KiB continue to return
  `MODULE_EXECUTION_LEASE_STALE` with HTTP 409 before a transaction is opened.
- Missing, released, expired, cross-tenant, wrong-Runner, or stale-generation leases
  continue to return `MODULE_EXECUTION_LEASE_STALE` with HTTP 409.
- An append ordered after finalization observes terminal execution state and uses the
  same stale conflict; no concurrency-specific error is exposed.
- Database failures still roll back the transaction and do not leave a progress event
  without a successfully validated execution and lease.

## Verification

Implementation follows test-driven development.

A Drizzle repository test captures the first SQL statement executed by
`appendEvidence(...)` and fails until it is the complete live-lease JOIN ending in
`FOR UPDATE OF execution`. It asserts that `lease_row` is not a lock target, that the
complete tenant and fencing tuple remains parameterized, that an empty result maps to
`MODULE_EXECUTION_LEASE_STALE`, and that a failed validation inserts no event.

A real PostgreSQL integration test uses two independent sessions and verifies both
orders deterministically. It identifies sessions with explicit application names and
polls PostgreSQL lock-wait state before releasing the first transaction; correctness
does not depend on an arbitrary sleep duration.

- Append-first: append holds the execution row while finalization acquires the lease
  and waits for execution. Append commits, finalization completes without deadlock,
  and the progress event precedes the terminal event and evidence/outbox result.
- Finalize-first: finalization holds the execution row while append waits. After
  finalization commits, append returns no live execution/lease match and no
  post-terminal progress event persists. The repository test covers mapping that
  empty result to HTTP 409 behavior.

Regression verification includes the module runtime API and repository tests, three
consecutive real PostgreSQL integration runs, the DB schema test, affected package
typechecks, migration lint, targeted static checks, the full workspace test command,
protected-file checks, and zero residual test containers. Any unrelated baseline
failure is reported as observed and is not hidden by unrelated edits.

## Upgrade Compatibility

The change remains inside the additive OpenOPC module runtime repository and its
tests. It does not alter Kortix base tables, shared authentication, existing user
routes, migrations, deployment services, or public SDK contracts. Reusing the
existing execution-row event mutex minimizes the surface that must be carried across
future Kortix upgrades.

## Acceptance Criteria

- A progress event cannot commit after terminal execution state has committed.
- A progress operation that acquires the execution row first may commit before a
  waiting terminal operation.
- The locking validation query targets the execution row only and retains every
  existing liveness, tenant, Runner, and generation predicate.
- The validation and event insert remain one transaction.
- `appendEvidence(...)` introduces no lease row lock and no new deadlock edge.
- Existing API fields, event schemas, and stale-lease error behavior are unchanged.
- Both race orders pass deterministic real PostgreSQL tests.
- No new function, privilege, environment variable, service, or deployment step is
  introduced.
- No protected file is modified, and no commit or push is performed.
