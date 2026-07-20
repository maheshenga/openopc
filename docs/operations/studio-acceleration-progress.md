# Studio Acceleration Progress

**Updated:** 2026-07-20

**Branch:** `studio-platform`

**Implementation plan:** `docs/plans/2026-07-20-milestone-0-1-image-studio-plan.md`

This ledger is the authoritative status source for the retained Studio acceleration work. Historical unchecked procedure boxes are not implementation evidence. Completion requires a commit plus the recorded verification gate.

## Current Status

| Slice | State | Evidence | Next gate |
| --- | --- | --- | --- |
| Studio backend foundation | implemented | contracts, schema, billing, IAM, API, worker commits | protected production acceptance |
| Intelligence protocol | implemented | REST, SDK, MCP, A2A, task/event commits | retained regression gates |
| Intelligence workflows | implemented, disabled | workflow, approval, routing, evaluation, Temporal commits | separately reviewed production rollout |
| Milestone 0-1 | active | canonical Intelligence SDK decision; Task 2 commit `4a50cf771` | Web Image Studio browser acceptance |
| Mobile and Electron | planned | acceleration design Milestone 3 | separate plan |
| Developer Center | planned | acceleration design Milestone 4 | separate plan |

## Canonical Client Contract

`kortix.project(projectId).intelligence` is the only product-facing SDK facade for capability discovery, Agent Cards, task creation/events, and governed workflows. Milestone 0-1 adds image estimates, Studio jobs, uploads, and assets as typed projections under that existing facade. The unimplemented `kortix.project(projectId).studio` proposal is superseded and must not be introduced.

## Product Boundary

Web Image Studio and project Assets are retained. First-party video, voice, 3D, digital-human, and batch-remix products remain cancelled. Generic developer module capability contracts remain extensible, but no cancelled first-party route, navigation item, capability descriptor, or seed data may return through this milestone.

## Production Boundary

`STUDIO_ENABLED=false` and `INTELLIGENCE_WORKFLOWS_ENABLED=false` remain production defaults. This milestone does not deploy or enable Studio workers, protected providers, or object storage, and it does not claim production readiness.

## Milestone 0-1 Gate

The milestone closes only after all eleven tasks in the implementation plan have commit-backed evidence, package/type/public-surface gates pass, and desktop/mobile Playwright acceptance proves the Web Image Studio and Assets flow without exposing credentials, signed URLs, request bodies, or identifiers in logs or telemetry.

## Task 2 Evidence

Task 2 (`4a50cf771`) binds Intelligence tasks to signed estimates and workflow provenance. The focused API suite passed (`139/139`), API and package typechecks passed, API contract checks passed (`9/9`), database schema checks passed (`67/67`), workflow conformance passed (`24/24`), real PostgreSQL workflow checks passed (`57/57`), migration integration passed (`8/8`), and the SDK suite passed (`1124/1124`) with typecheck, build, packed-install smoke, and public-surface checks. The full database suite exceeded the local 304-second execution limit, so that gate remains explicitly unverified.

## Task 4 Evidence

Task 4 (`026eb2ea6`) adds strict typed Image Studio estimate, job, upload, and
asset projections under `kortix.project(projectId).intelligence`. It restores
the projects-client barrel and facade methods without adding `project().studio`,
and updates runtime/type snapshots with additive-only changes. The focused REST
projection suite passed (`15/15`), the full facade test file passed (`63/63`),
SDK typecheck passed, both public-surface tests passed, and scoped Biome checks
passed. React hooks, Web pages, full SDK suite, and package smoke install remain
later milestone gates.

## Task 2 Scheduler Follow-up

Follow-up `0c932761a` prevents retryable workflow execution failures from being
reclaimed repeatedly within the same scheduler tick. The regression proves one
attempt per tick and a retry on the next tick; scheduler and task-bridge tests
passed (`30/30`) and API typecheck passed.

## Task 5 Evidence

Task 5 (`019c512d9`) adds project-scoped React Query hooks for Image Studio jobs,
assets, estimates, cancellation, uploads, finalization, and signed-download URL
creation through the existing `@kortix/sdk/react` barrel. Query invalidation is
limited to durable Intelligence project data, and signed URLs remain one-shot
mutation results. The complete SDK suite passed (`1135/1135`), SDK typecheck
passed, packed-install smoke passed, and runtime/type snapshots contain only
additive `./react` exports.
