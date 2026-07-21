# Studio Acceleration Progress

**Updated:** 2026-07-21

**Branch:** `studio-platform`

**Implementation plan:** `docs/plans/2026-07-20-milestone-0-1-image-studio-plan.md`

This ledger is the authoritative status source for the retained Studio acceleration work. Historical unchecked procedure boxes are not implementation evidence. Completion requires a commit plus the recorded verification gate.

## Current Status

| Slice                     | State                                                   | Evidence                                                                                                                                    | Next gate                                                         |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Studio backend foundation | implemented                                             | contracts, schema, billing, IAM, API, worker commits                                                                                        | protected production acceptance                                   |
| Intelligence protocol     | implemented                                             | REST, SDK, MCP, A2A, task/event commits                                                                                                     | retained regression gates                                         |
| Intelligence workflows    | implemented, disabled                                   | workflow, approval, routing, evaluation, Temporal commits                                                                                   | separately reviewed production rollout                            |
| OpenOPC Milestone A       | implemented, disabled by default                        | catalog, project SSE projection, SDK subscription, and focused contract/API/SDK/CLI gates verified locally                                  | production rollout and later milestones                           |
| Milestone 0-1 (Web)       | active (Task 10 complete; Task 11 partial)              | canonical Intelligence SDK; Task 10 commit `8dea9258c`; browser acceptance green                                                            | focused Web hardening without full-suite reruns                   |
| Desktop/Electron          | active (Windows unsigned installer acceptance complete) | commits `285f7a2a6`, `10ed33403`, and `5255a05e4`; focused tests plus browser/source/packaged Electron smoke and NSIS artifact checks green | signed Windows installer and macOS/Linux acceptance               |
| Mobile                    | deferred (implementation retained)                      | mobile commit `ae7202a65`; focused contract/wiring tests green                                                                              | resume Android/iOS acceptance only after product reprioritization |
| Developer Center          | planned                                                 | acceleration design Milestone 4                                                                                                             | separate plan                                                     |

## Canonical Client Contract

`kortix.project(projectId).intelligence` is the only product-facing SDK facade for capability discovery, Agent Cards, task creation/events, and governed workflows. Milestone 0-1 adds image estimates, Studio jobs, uploads, and assets as typed projections under that existing facade. The unimplemented `kortix.project(projectId).studio` proposal is superseded and must not be introduced.

## Product Boundary

Web Image Studio and project Assets are retained. First-party video, voice, 3D, digital-human, and batch-remix products remain cancelled. Generic developer module capability contracts remain extensible, but no cancelled first-party route, navigation item, capability descriptor, or seed data may return through this milestone.

## Production Boundary

`STUDIO_ENABLED=false` and `INTELLIGENCE_WORKFLOWS_ENABLED=false` remain production defaults. This milestone does not deploy or enable Studio workers, protected providers, or object storage, and it does not claim production readiness.

`INTELLIGENCE_AG_UI_ENABLED=false` is also the default. Its optional SSE
endpoint is a project-scoped projection over existing durable workflow events;
it has numeric cursor replay, `Last-Event-ID` resume, a 500ms poll cadence,
15-second keepalive comments, and existing REST cursor polling as the fallback.
It does not alter workflow persistence, scheduling, or the existing OpenCode
event stream.

The AG-UI public boundary is redaction constrained: prompts, payload
references, secrets, provider URLs, signed URLs, raw provider bodies, headers,
cookies, and reasoning text are prohibited. The capability catalog stays
read-only, while MCP `tools/list` remains a fixed meta-tool surface rather than
expanding with catalog items. These statements record a focused protocol slice,
not production readiness and not delivery of cancelled video, voice, 3D,
digital-human, or batch-remix pages.

The Responses provider-profile slice adds bounded capability-aware routing to
the existing LLM Gateway. Default clients continue to use Chat Completions;
native `/v1/responses`, state continuation, background jobs, and Computer Use
remain separate later plans. This slice adds no provider credentials, database
state, Web route, Desktop route, or production-readiness claim.

The Gateway observability slice validates W3C trace context, carries it through
the existing control-plane hooks and internal API RPCs, and projects bounded
GenAI token, retry, status, provider, model, billing-mode, and cost attributes.
It does not forward trace context to model providers, and the new GenAI
observation excludes prompts, responses, identities, URLs, credentials,
candidate lists, and arbitrary errors. Existing configurable trace body capture
is unchanged. OTLP deployment and the Web cost dashboard remain later gates.

## Milestone 0-1 Gate

The milestone closes only after all eleven tasks in the implementation plan have commit-backed evidence, package/type/public-surface gates pass, and Electron acceptance proves the Web Image Studio and Assets flow without exposing credentials, signed URLs, request bodies, or identifiers in logs or telemetry. Android/iOS acceptance is deferred and is not a current milestone gate.

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

## Desktop/Electron Image Studio Slice

Commit `285f7a2a6` keeps `/projects/:id/studio/image` inside the Electron app and
adds one native `download_url` command to the existing `window.__TAURI__`
bridge. Image Studio results and project Assets now share the same Web helper:
regular browsers retain the no-referrer anchor flow, while Electron sends the
short-lived URL to the requesting `WebContents.downloadURL()` and never to
`shell.openExternal`.

The Electron policy accepts HTTPS and loopback HTTP only, rejects URL
credentials and non-network schemes, and requires an existing trusted Kortix
sender before the IPC command runs. The focused Electron suite passed `14/14`,
and the related Web suite passed `32/32` for the native bridge commit.

Commit `10ed33403` adds repeatable real-shell acceptance without changing the
Electron application boundary. Playwright launches Electron 39 through
`chromium.launchPersistentContext()`, the supported `--app=<desktop-root>`
switch, and Playwright's `--remote-debugging-pipe`; no Inspector or TCP debug
port is opened. Electron first loads the same-origin static `robots.txt`, so
request interception and console/error diagnostics are installed before the
real Studio route can issue a request. Each run uses isolated temporary app
data, a 60-second cold-start budget, and cleanup in both success and failure
paths.

Commit `5255a05e4` extends the same smoke to a packaged executable. Source
mode keeps the development `--app=<desktop-root>` switch; packaged mode takes
`E2E_ELECTRON_EXECUTABLE` and passes no development switch. The packaged smoke
sets `KORTIX_E2E_DISABLE_PROTOCOL_REGISTRATION=1`, an explicit test-only guard
that leaves normal dev and production `kortix://` registration unchanged while
preventing a local acceptance run from changing the user's protocol handler.

The Electron smoke exited `0` after proving the preload and desktop user-agent
markers, generation, idempotent recovery, cancellation, reference upload,
credit and permission failures, Assets preview, and native downloads from both
Image Studio and Assets. The browser smoke also exited `0` and retained its
desktop/mobile layout and pixel checks. The Windows screenshot was inspected:
window controls remain at the upper right, while the debug Image Studio and
Assets controls remain visible and clickable.

The title-bar regression fix keeps the Win/Linux flex spacer so controls stay
right-aligned, but makes that spacer pointer-inert and `no-drag`; only the macOS
6px top strip restores pointer handling and dragging. The debug harness also
reserves the Win/Linux control width. The focused Electron suite passed
`15/15`, the related Web suite passed `35/35`, Web ESLint and Prettier passed,
Node syntax checks passed, and `git diff --check` passed. A Windows x64
directory package was built from the installed Electron 39.8.10 runtime with
`--publish never`, `--dir`, and `signAndEditExecutable=false`; it contains
`Kortix.exe` and `resources/app.asar`. The exact packaged executable passed the
same Image Studio/Assets smoke, including native downloads. No full suite was
run. The same unsigned configuration produced `Kortix-Setup-0.1.0.exe`, its
`.blockmap`, and `latest.yml` with `--publish never`; the installer PE metadata,
SHA-256, version `0.1.0`, and referenced files were checked, but the installer
was not executed. Signed Windows installer, macOS/Linux package acceptance, and
production readiness remain open.

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
