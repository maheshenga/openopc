# Module Runtime `service_role` Isolation

Status: implemented and verified on 2026-07-27

## Implementation Record

- All 14 module runtime tables and the three Runner procedures plus three trigger
  functions deny privileges to `PUBLIC`, `anon`, `authenticated`, and `service_role`.
- Database-owner repository behavior is unchanged; no role, connection pool,
  environment variable, route, or SDK contract was added.
- The real PostgreSQL suite passed three consecutive `18 pass / 0 fail` runs after
  later runtime regression coverage expanded the original planned total of `15`.
- An independent focused PostgreSQL rerun of the privilege boundary passed with
  `13` assertions, `1 pass`, `17 filtered out`, and `0 fail`.
- The wider workspace still has four unrelated recorded baseline test failures: one
  Windows file-mode assertion and three manifest-schema JSON synchronization checks.

## Context

The module runtime HTTP control plane authenticates Runner requests with mTLS, but the
database migration currently grants Supabase `service_role` direct access to the
claim, heartbeat, and finalize procedures and direct write access to runtime tables.
Possession of the Supabase service key can therefore bypass the HTTP identity boundary
and forge Runner state, including terminal execution results.

The API already connects directly to PostgreSQL through `DATABASE_URL`. In supported
deployments that connection uses the migration owner or an equivalent privileged API
role. Module runtime repositories use that direct connection; they do not use
PostgREST's `service_role` session.

## Goals

- Prevent `service_role`, `authenticated`, `anon`, and `PUBLIC` from invoking Runner
  database procedures directly.
- Prevent those roles from reading or mutating internal module runtime control-plane
  tables through PostgREST.
- Preserve all existing user-facing and mTLS-authenticated Runner HTTP behavior.
- Keep the fix local to the OpenOPC module runtime migration and its tests.
- Avoid new credentials, connection pools, services, and deployment configuration.

## Non-goals

- A dedicated PostgreSQL login for the Runner control plane.
- Process isolation between ordinary API handlers and Runner handlers.
- Changes to mTLS authentication, lease semantics, evidence locking, or heartbeat
  deadlines. Those are separate audit findings.
- Direct PostgREST access to module runtime tables.

## Decision

The module runtime schema is an internal API implementation detail. No Supabase JWT
role receives table or procedure privileges for it.

The migration will retain the existing `REVOKE ALL` table statement and include
`service_role` in every procedure revocation. The two table `GRANT` blocks and the
Runner procedure `GRANT EXECUTE ... TO service_role` block will be removed. Function
ownership remains unchanged, so the migration owner and the API's direct database
connection retain the authority needed by the Drizzle repositories.

This is deliberately narrower than introducing a second Runner database credential.
It closes the demonstrated external privilege bypass without adding an operational
dependency before private beta.

## Permission Matrix

| Principal | Runtime tables | Runner procedures | Access path |
| --- | --- | --- | --- |
| `PUBLIC` | none | none | denied |
| `anon` | none | none | denied |
| `authenticated` | none | none | denied |
| `service_role` | none | none | denied |
| migration owner / API DB role | owner privileges | owner privileges | API repositories only |

The protected functions are:

- `kortix.claim_module_execution(...)`
- `kortix.heartbeat_module_execution(...)`
- `kortix.finalize_module_execution(...)`
- the module runtime trigger functions, which are never public entry points

## Data Flow

1. A user calls the authenticated module execution HTTP API.
2. The API validates project access and uses the direct `DATABASE_URL` repository.
3. A Runner calls the private control-plane HTTP API through the trusted mTLS proxy.
4. The API validates the Runner identity, lease tuple, generation, and capability
   bindings before its repository invokes the database procedures.
5. A caller using a Supabase service key is mapped to `service_role`; direct table or
   procedure access is rejected by PostgreSQL before runtime data is disclosed or
   changed.

There is no fallback path and no alternate database connection.

## Error Behavior

- Direct calls under `service_role`, `authenticated`, `anon`, or `PUBLIC` fail with
  PostgreSQL SQLSTATE `42501` (`insufficient_privilege`).
- Permission failure must occur before tuple-dependent behavior, so callers cannot use
  error differences to discover whether an execution or lease exists.
- Existing API responses are unchanged because authorized API calls continue to use
  the direct database owner connection.

## Verification

The real PostgreSQL migration integration suite will prove both sides of the boundary:

- apply the migration idempotently;
- seed a valid execution and live lease as the database owner;
- switch to `service_role` and verify claim, heartbeat, and finalize each fail with
  SQLSTATE `42501` even when every tuple value is valid;
- verify `service_role` has no privileges on every module runtime table;
- verify the database owner still completes the existing claim, heartbeat, evidence,
  finalize, cancellation, expiry, tenant-isolation, and immutability happy paths;
- retain every existing assertion and explicit test timeout;
- run the integration suite three consecutive times to guard against timing flakes.

Focused verification also includes the DB schema test, module runtime API tests,
contracts and SDK tests, affected package typechecks, migration lint, Biome checks on
touched files, `git diff --check`, protected-file checks, and zero residual test
containers.

## Upgrade Compatibility

The change only tightens grants in the new OpenOPC module runtime migration. It does
not change Kortix shared database client APIs, existing Kortix tables, public SDK
contracts, routes, or deployment manifests. Reapplying the migration produces the same
permission state, so later base upgrades cannot restore the removed grants unless a
future migration explicitly adds them.

## Acceptance Criteria

- `service_role` cannot read or write module runtime tables.
- `service_role` cannot execute claim, heartbeat, finalize, or trigger functions.
- All existing authorized API and database-owner happy paths remain green.
- No new environment variable, database role, service, or deployment step is required.
- No protected file is modified, and no commit or push is performed.
