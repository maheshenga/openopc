# Studio Acceleration Progress

**Updated:** 2026-07-23

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
| Automation Task 8A-8B     | authenticated heartbeat plus bounded Browser Worker dispatch transport implemented; desktop observe coordinator implemented; production hardening partial; default-off | heartbeat commits through `5c6ec31d0`; dispatch commits `44ff08329`, `bf3b2a4a2`, `9f7399997`, and `cce38b4ff`; shared schemas, signed receipts, mTLS client options, replay fencing, and package gates verified | main-runtime composition, real mTLS deployment, sink concurrency validation, durable step/approval handling, and unknown-result recovery |
| Milestone 0-1 (Web)       | active (Task 10 complete; Task 11 partial)              | canonical Intelligence SDK; Task 10 commit `8dea9258c`; browser acceptance green                                                            | focused Web hardening without full-suite reruns                   |
| Desktop/Electron          | active (Windows unsigned installer acceptance complete) | commits `285f7a2a6`, `10ed33403`, and `5255a05e4`; focused tests plus browser/source/packaged Electron smoke and NSIS artifact checks green | signed Windows installer and macOS/Linux acceptance               |
| Mobile                    | deferred (implementation retained)                      | mobile commit `ae7202a65`; focused contract/wiring tests green                                                                              | resume Android/iOS acceptance only after product reprioritization |
| Developer Center          | planned                                                 | acceleration design Milestone 4                                                                                                             | separate plan                                                     |

## Task 15 Focused Acceptance Snapshot

**Updated:** 2026-07-24

The route manifest was regenerated from the mounted API (`516` routes). The
ke2e parity gate now passes with `437/516` routes covered, `9` explicitly
allowlisted, `70` pre-existing baseline-uncovered, and no new uncovered or
external routes. The coverage flow was updated to remove stale Marketplace
paths and to exercise the retained project install-session boundary plus the
Studio, Intelligence, and Automation route perimeter with anonymous requests.

Focused evidence recorded in this phase:

- API Studio/Intelligence/AG-UI/Billing suite: `32/32` tests passed.
- Studio adapters: `128` passed, `10` MinIO integration tests skipped because
  no MinIO endpoint was configured.
- Studio runtime: `30/30` passed.
- API Contract and SDK Studio/AG-UI suite: `37/37` passed.
- Web Studio/Assets suite: `41/41` passed from the Web package working
  directory.
- API, API Contract, Studio Runtime, Studio Adapters, and SDK typechecks
  passed.
- Cancelled first-party video, voice, 3D, digital-human, and batch-remix
  Studio pages remain absent from the route/navigation contracts.

Still open for a later protected environment: real local API/database and Web
browser black-box flows, live API/Worker metrics scrape, MinIO conformance,
live Provider smoke, Alibaba Cloud OSS smoke, and the 24-hour/7-day/30-day
incident lifecycle. These are not proven by this local focused snapshot, so
Studio production enablement remains disabled.

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

## Automation Task 8A-8B Desktop Observe Coordinator Slice

Commit `920375679` adds the secure Automation Control dispatch boundary without
creating a second desktop RPC channel. Browser dispatch binds the signed job
envelope, policy version, proof nonce, exact lease, receipt, deadline, and
pre/post lease checks. Desktop dispatch uses only the injected existing Tunnel
adapter, forwards the complete signed lease under controlled parameters, and
fences permission, action hash, device, generation, one-time approval,
full-access expiry, deadline, and lease currentness immediately before RPC.

Heartbeat inputs are restricted to worker-owned event schemas, and evidence is
an opaque `evidence:<UUID>` reference. Commit `5d4182f73` implements the
PostgreSQL heartbeat/ordinal sink: one transaction locks and revalidates the
exact account, project, job, lease owner, generation, and expiry; enforces a
contiguous ordinal scoped to the Worker and lease; allocates the next job event
sequence; applies supported state transitions; and persists the Worker receipt.

Commit `ff71d4bd4` adds the default-off server-side heartbeat receiver at
`POST /internal/automation/browser/heartbeat` and composes the Worker
authenticator, shared Redis monotonic nonce store, exact lease precheck,
heartbeat processor, and PostgreSQL event sink in the Automation Control
runtime. This is a sibling internal route rather than a `/v1/automation/*`
user/project API, so it does not change Kortix actor-HMAC middleware or public
routes.

The receiver requires two independent proofs: an HMAC attestation produced by
a trusted mTLS proxy and the Browser Worker proof bound to its certificate
fingerprint and heartbeat body. Certificate service ID, proof service ID, and
heartbeat `worker_id` must all agree. The proxy attestation covers timestamp,
service ID, fingerprint, certificate expiry, HTTP method, complete path and
query, and the SHA-256 digest of the exact request bytes. Production proxies
must strip all external `x-automation-worker-*` headers before adding their own;
the TLS attestation secret belongs only to that proxy and must never be given to
a Browser Worker.

The receiver limits the body to 64 KiB and the complete body-read interval to
five seconds by default, with bounded configuration overrides. It rejects
oversized certificate metadata, invalid UTF-8/JSON, stale attestations,
tampered path/body data, untrusted fingerprints, identity substitution, proof
replay, stale leases, ordinal replay, and semantic conflicts with stable
Automation Protocol errors. Unknown Redis/PostgreSQL failures return a generic
retryable unavailable response without exposing internal errors or connection
strings.

Commit `5c6ec31d0` adds the Browser Worker side of this protocol while preserving
the receiver's trust boundary. The default-off client accepts only an HTTPS
Automation Control origin and uses Bun's client certificate, private key, CA,
`rejectUnauthorized=true`, and explicit TLS `serverName` settings. It signs the
canonical shared Worker proof, emits a contiguous ordinal per lease, rejects
redirects, and never sends the proxy-owned `x-automation-worker-*` attestation
headers. The TLS proxy attestation secret remains unavailable to the Worker.

The client applies one deadline to both request headers and the streamed
response body and accepts no more than 64 KiB. A rejected, malformed, timed-out,
or otherwise unknown result permanently closes that lease's heartbeat stream,
so a retry cannot ambiguously duplicate a durable event. Closed-lease state is
bounded rather than retained without limit.

The isolated browser execution path starts heartbeating only after permission,
lease, and runtime-isolation checks pass. It reports the latest completed step,
runs periodic sends serially during execution, aborts the active action on the
first heartbeat failure, and still closes the page, context, browser, and proxy.
Heartbeat-loop cleanup is deadline bounded.

Commit `44ff08329` moves the Browser dispatch path, request, envelope, receipt,
and accepted response into the shared strict Automation Protocol contract.
Commit `bf3b2a4a2` adds the default-off Worker authenticated source. A trusted
TLS proxy attestation binds the Control certificate to the WebSocket upgrade,
and every dispatch is separately protected by a body-bound HMAC proof, bounded
timestamp, and monotonic nonce. The source admits only one queued or active
request, sends a signed receipt before exposing work, rejects replay/tampering,
bounds messages and backpressure to 64 KiB by default, and aborts
connection-owned work on close.

Commit `cce38b4ff` adds the default-off Automation Control WebSocket adapter. It
accepts only a `wss://` origin, supplies Bun client certificate, private key,
CA, `rejectUnauthorized=true`, explicit `serverName`, and no spoofable Worker
proxy-attestation headers. It permits one in-flight dispatch, strictly parses
the shared accepted schema, and classifies timeout or disconnect after dispatch
as an unknown result. The existing Browser Dispatcher still verifies the
Worker receipt proof, dispatch hash, nonce, job, lease, Worker identity, and
post-transport lease fence. Commit `9f7399997` replaces four host-speed guesses
in runtime deadline tests with operation-start synchronization and bounded
cleanup safety.

The Browser Worker process still does not compose this authenticated source
with the execution loop in its production entry point; that entry server
remains fail closed and not ready. No real mTLS proxy/certificate deployment or
end-to-end Control-to-Worker exchange has been accepted. Real concurrent sink
execution against PostgreSQL has also not been verified.
Reclaimed leases still receive a new per-claim fencing token, and unknown or
external-effect outcomes do not automatically retry.

Commits `c6fda9161` and `497a46d35` bind the desktop permission fence to the
existing API-to-Tunnel route. Commit `e07ffd813` adds the default-off production
composition for exactly one `desktop.read_screen` /
`desktop.cua.get_screen_size` step. Candidate polling requires the declared
device and permission, claims a signed permission-bound lease, rechecks the
lease before and after dispatch, persists bounded lifecycle events, and never
stores raw provider results or errors. Once execution crosses the dispatcher
boundary, a failure is conservatively recorded as an unknown result.

The process loop is serialized and batch-bounded. Shutdown cancels the active
API request, drains it for at most five seconds, clears the next timer, and then
closes the service. Poll failures expose only a stable event name and service
identifier. The independent `AUTOMATION_DESKTOP_COORDINATOR_ENABLED` flag stays
false by default and cannot be enabled while Automation Control is disabled.

Commit `5d4182f73` also runtime-wires API desktop-executor replay protection to
shared Redis whenever `AUTOMATION_DESKTOP_EXECUTOR_ENABLED=true`. Feature
configuration validation requires a valid `AUTOMATION_REDIS_URL`; the runtime
uses a hashed service/nonce key with atomic Redis `SET PX NX`. The production
runtime selects the in-memory nonce store only while the executor is disabled,
while tests may inject it directly. Long Worker IDs use the reserved
`worker~sha256~<digest>` namespace so a valid short service ID cannot
impersonate a hash alias.

The same commit adds `worker_id`, `worker_lease_id`, and `worker_ordinal`
receipts, an all-null or all-present receipt CHECK constraint, and a
lease-scoped ordinal replay index. The real PostgreSQL migration gate verifies
idempotent application, rejection of partial receipts, and rejection of an
exact lease-scoped ordinal replay. It does not verify real concurrent execution
of the PostgreSQL sink.

Worker `approval_required`, `step_started`, `step_completed`, and
`job_succeeded` events deliberately fail closed with a semantic mismatch before
a transaction is opened. They remain unavailable until atomic
`automation_job_steps` validation and state updates are implemented and, for
approval, the durable pause, lease release, approval, redispatch, new-lease,
and cursor-resume protocol exists.

The fresh focused gates passed `11/11` API desktop-executor tests with `31`
assertions, `41/41` Automation Control dispatch/sink/lease tests with `173`
assertions, `10/10` DB schema and migration-structure tests with `68`
assertions, and `3/3` real PostgreSQL migration tests with `11` assertions. API,
Automation Control, and DB typechecks passed; scoped Biome over nine files and
`git diff --check` were clean. Migration lint passed all 69 migrations while
reporting seven pre-existing destructive-operation warnings. A live Redis probe
accepted the first reservation, rejected its replay, and observed approximately
`4941ms` remaining on the configured five-second TTL. No full suite was run.

For `ff71d4bd4`, the seven focused Automation Control files passed `63/63`
tests with `248` assertions. Automation Control typecheck passed, scoped Biome
over 13 files passed, and `git diff --check` passed. A direct `redis-cli` check
of the monotonic Worker nonce Lua accepted the first and higher nonces, rejected
the replay and lower nonce, and reported approximately `4960ms` TTL. The local
Bun Redis client could not connect to the host's legacy Windows Redis `3.0.504`,
so Bun-to-Redis integration is not claimed. No full suite was run.

For `5c6ec31d0`, the shared contract, Browser Worker, and Automation Control
focused slice passed `135/135` tests with `489` assertions, and all three package
typechecks passed. The wider pre-commit package gates passed `278/278` tests
with `901` assertions. Scoped Biome over the 11 changed files and
`git diff --check` passed. No full repository suite was run.

For `44ff08329` through `cce38b4ff`, the final package gates passed `50/50`
Intelligence Contracts tests with `138` assertions, `100/100` Browser Worker
tests with `338` assertions, and `144/144` Automation Control tests with `492`
assertions: `294/294` tests and `968` assertions total. All three package
typechecks passed, and scoped Biome over 13 files passed. An earlier Worker
package run exposed the existing client-close-during-CONNECT-resolution timing
test once; the final package gate passed, but that test still depends on a
fixed local socket propagation delay and remains a stability risk. No full
repository suite was run.

Production authenticated job-source/main-runtime composition, real mTLS
proxy/certificate deployment and end-to-end verification, real sink concurrency
validation, durable step and approval-resume handling, dispatch-attempt
idempotency and unknown-result recovery, and complete readiness/deployment
wiring remain open. Complete Task 8 and production readiness are therefore not
claimed.
