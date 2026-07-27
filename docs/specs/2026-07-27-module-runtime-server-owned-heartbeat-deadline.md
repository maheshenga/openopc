# Module Runtime Server-Owned Heartbeat Deadline

Status: implemented; focused verification passed; full workspace verification has
unrelated baseline failures recorded in the implementation report

## Context

The private Runner heartbeat endpoint currently accepts an absolute `deadlineAt` from
the Runner and forwards it unchanged through the protocol and repository layers to
`kortix.heartbeat_module_execution(...)`. PostgreSQL only verifies that the requested
lease deadline does not exceed the execution deadline. A Runner can therefore turn a
30-second lease into a lease lasting until the execution deadline with one heartbeat.

The production `ModuleRunnerProtocol` uses the existing 30-second default for initial
claims. The project has not shipped and does not require compatibility with the old
heartbeat request or PostgreSQL function signature.

## Goals

- Remove Runner control over heartbeat lease deadlines.
- Use PostgreSQL's wall clock as the authority for durable heartbeat renewal.
- Renew a live lease for at most 30 seconds and never beyond the execution deadline.
- Preserve the existing heartbeat response, execution state transition, event, and
  error contracts.
- Keep migration application idempotent without leaving the old callable overload.

## Non-goals

- Changing initial claim deadline generation.
- Making the lease duration configurable.
- Supporting the old heartbeat request body or seven-argument database function.
- Changing Runner authentication, capability issuance, evidence appends, finalization,
  cancellation, expiry, or lock ordering outside the heartbeat function.

## Considered Approaches

### Database-owned absolute deadline (selected)

The Runner sends only lease identity and fencing data. PostgreSQL calculates
`LEAST(clock_timestamp() + interval '30 seconds', execution.deadline_at)` after it has
locked and validated both rows. This removes untrusted deadline input and avoids API
and database clock skew.

### API-owned absolute deadline

The API could calculate 30 seconds from its local clock and pass the result to
PostgreSQL. This has a smaller database signature change but retains cross-host clock
skew and makes PostgreSQL accept an externally calculated absolute time.

### Retain and ignore the Runner field

The API could continue accepting `deadlineAt` while ignoring it. This would preserve
wire compatibility, but the contract would remain misleading and obsolete code paths
would survive without a deployment requirement.

## Decision

The heartbeat request includes `projectId`, `executionId`, `leaseId`, and `generation`.
It does not include `deadlineAt`. The HTTP Zod schema remains strict, so a request that
still sends the removed field is rejected instead of being silently accepted.

`RunnerLeaseHeartbeatCommand` and `HeartbeatModuleExecutionLeaseCommand` remove their
deadline fields. `ModuleRunnerProtocol.heartbeatLease(...)` derives the account and
Runner identifiers from the authenticated mTLS identity and forwards only those
trusted coordinates plus the request's lease fencing tuple.

The PostgreSQL function changes from seven input arguments to six. Before creating the
six-argument function, the migration explicitly drops the old seven-argument
signature. This is necessary because PostgreSQL treats different input signatures as
overloads: `CREATE OR REPLACE FUNCTION` alone would leave the insecure function
callable when the edited migration is reapplied to a database that has already seen
the earlier draft.

The six-argument function locks the matching live lease and execution using the
existing order. After both locks are acquired, it captures `clock_timestamp()` once as
the heartbeat observation time. It rejects a lease that has expired by that time,
then calculates:

```sql
LEAST(observed_at + interval '30 seconds', execution.deadline_at)
```

The calculated deadline is persisted on the lease and returned to the Runner. The
same captured timestamp is used for the heartbeat row. The existing first-heartbeat
transition from `leased` to `running` and its event semantics remain unchanged.

The in-memory repository mirrors this behavior with its injected `now()` clock so
unit tests stay deterministic. It computes the lesser of `now + 30 seconds` and the
execution deadline; callers cannot supply an alternative duration.

## Data Flow

1. The Runner sends its project, execution, lease, and generation coordinates through
   the private mTLS heartbeat endpoint.
2. The endpoint authenticates the Runner before parsing the strict request body.
3. The protocol derives `accountId` and `runnerId` from the authenticated identity.
4. The repository invokes the six-argument PostgreSQL heartbeat function.
5. PostgreSQL locks and validates the lease and execution, captures its current wall
   clock time, and calculates the bounded 30-second deadline.
6. PostgreSQL updates the lease, records the heartbeat, performs the existing running
   transition when required, and returns the authoritative deadline.
7. The Runner uses the returned deadline to schedule its next heartbeat.

## Error Behavior

- A request containing the removed `deadlineAt` field fails strict HTTP body
  validation through the existing Runner error response path.
- A missing, released, expired, mismatched, stale-generation, or wrong-Runner lease
  continues to map to `MODULE_EXECUTION_LEASE_STALE` with HTTP 409.
- A missing, terminal, or tenant-mismatched execution remains non-disclosing through
  the same stable conflict behavior.
- The function does not revive a lease that expires while waiting for locks because
  liveness is checked against a fresh timestamp captured after both locks are held.
- A live execution whose remaining lifetime is less than 30 seconds receives a lease
  deadline equal to the execution deadline; this is a successful bounded heartbeat,
  not an error.

## Verification

The implementation follows test-driven development. Tests first demonstrate that the
Runner-controlled deadline is accepted, then pass only after control is removed.

Focused API tests will verify:

- the strict heartbeat route accepts the four-field request;
- the route rejects an extra `deadlineAt` field;
- an authenticated Runner heartbeat advances `leased` to `running`;
- the in-memory deadline is exactly 30 seconds from the injected current time;
- a deadline less than 30 seconds away is capped at the execution deadline;
- stale lease, identity, generation, and terminal-state behavior remains unchanged.

The real PostgreSQL migration integration suite will verify:

- migration application remains idempotent;
- the six-argument heartbeat function renews a live lease for approximately 30
  seconds using the database wall clock;
- renewal is capped at the execution deadline;
- an expired lease cannot be revived;
- the old seven-argument function signature does not exist after migration;
- heartbeat persistence, execution transition, tenant isolation, terminal behavior,
  and `service_role` denial assertions remain intact.

Completion verification includes the module runtime API tests, real PostgreSQL
integration suite, DB schema tests, affected package typechecks, migration lint,
targeted formatting checks without unrelated whole-file rewrites, `git diff --check`,
protected-file checks, and zero residual test containers.

## Upgrade Compatibility

The change is confined to the additive OpenOPC module runtime files and does not alter
Kortix base tables, shared authentication, existing user APIs, or deployment services.
The HTTP schema, protocol types, repository contract, memory implementation, Drizzle
implementation, and PostgreSQL function change together, leaving no compatibility
branch to carry forward. Explicitly dropping the obsolete overload makes repeated
migration application converge on one secure function signature.

## Acceptance Criteria

- A Runner cannot submit or influence an absolute heartbeat deadline.
- Every successful heartbeat grants no more than 30 seconds from PostgreSQL's observed
  time and never exceeds the execution deadline.
- The old seven-argument database function is absent.
- Existing heartbeat response and stable error contracts are preserved.
- Existing module runtime tests and authorization boundaries remain green.
- No new environment variable, service, database role, or deployment step is added.
- No protected file is modified, and no commit or push is performed.
