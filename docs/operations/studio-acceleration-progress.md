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
| Milestone 0-1 (Web) | active (Task 10 complete; Task 11 partial) | canonical Intelligence SDK; Task 10 commit `8dea9258c`; browser acceptance green | focused Web hardening without full-suite reruns |
| Desktop/Electron | active | existing Electron Web wrapper; Web Image Studio flow implemented | Electron navigation, generation, preview, and download acceptance |
| Mobile | deferred (implementation retained) | mobile commit `ae7202a65`; focused contract/wiring tests green | resume Android/iOS acceptance only after product reprioritization |
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

## Task 10 Evidence

Task 10 (`8dea9258c`) adds the debug-only Web Image Studio harness and repeatable
Playwright smoke at `apps/web/scripts/e2e/image-studio-smoke.ts`. The accepted
fake-provider run used a local webpack server on port `3300` and exited `0`.
It covered capability and Agent Card discovery, signed estimate approval,
provider/model/input binding, one `503` followed by idempotent task replay,
event pagination, signed reference upload/finalization, desktop/mobile layout
and pixel checks, durable task URL and reload recovery, cancellation,
insufficient-credit and permission errors, Assets source/reuse links, preview,
download, and redaction checks. The desktop and mobile screenshots were
inspected and remain ignored test artifacts.

The focused Web Studio suite passed (`33/33`), Web noEmit typecheck passed, and
Web ESLint exited `0` with the repository's existing warnings. The browser
smoke also passed after the browser-safe default UUID fix in
`createImageIdempotencyKey` and strict SDK-compatible fake job fixtures.

## Task 11 Acceptance Status

The shared package gates passed: API contract (`56/56`), Studio runtime
(`30/30`), Studio adapters (`127/127`), SDK (`1136/1136`), SDK typecheck, and
SDK bundle build. The Web full test ran `1057` passing and `6` failing; the
failures are outside this diff (public Markdown MDX syntax, three
ProjectManifest alert tests only when run in the full suite, and two
system-locale-sensitive timeline expectations). The same three files were
re-run independently: the alert file passed; the Markdown and timeline
failures remain reproducible baseline failures.

`i18n:audit` remains a baseline failure: English has `0` missing keys, the
other seven locales each have `70` missing `hardcodedUi.appHomePage` keys, and
the hardcoded UI audit reports `1291` findings. A full Web build was not
proven because the Windows host repeatedly exhausted commit memory during
Next compilation and exited without compiler diagnostics. These gates remain
open; this ledger does not claim Milestone 0-1 or production readiness is
complete.

## Milestone 3 Mobile Slice

Commit `ae7202a65` adds the capability-gated Expo project route at
`/projects/:id/studio`. The mobile page uses only `@kortix/sdk` and its React
bindings for discovery, Agent Cards, signed estimates, idempotent task
creation, durable event-cursor polling, job snapshot recovery, cancellation,
asset listing, signed preview URLs, and download/share. Active task state is
validated before project-scoped AsyncStorage recovery; signed URLs and
estimate tokens are never persisted.

The focused mobile contract and wiring suite passed (`8/8`), scoped Biome
checks passed, the drawer lint passed, both raw-fetch and cancelled multimedia
route scans returned no matches, and `git diff --check` passed. No full test
suite was run. Mobile TypeScript acceptance remains open because the existing
mobile baseline cannot currently resolve `@expo/vector-icons`, contains a
duplicate `ToolResultData` export, and ends with a missing `tsc` command
diagnostic. Native Android/iOS interaction and the Electron Web flow remain
separate Milestone 3 gates; this entry does not mark Milestone 3 complete.

Android/iOS work is deferred by product priority as of 2026-07-20. The mobile
implementation remains in the branch, but no additional native development or
acceptance is scheduled. Current execution priority is Web first and
Desktop/Electron second.
