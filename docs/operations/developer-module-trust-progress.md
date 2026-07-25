# Developer Module Trust Progress

**Updated:** 2026-07-25

**Branch:** `studio-platform`

**Evidence base commit:** `0d0e748f1b424087e3b4b8a9f701ea2b9051ef50`

**Implementation plan:** `docs/plans/2026-07-25-openopc-developer-module-trust-execution-implementation-plan.md`

This ledger records fresh acceptance evidence for the schema-v2 Developer Center trust pipeline. A passing focused test is not presented as browser, migration, full repository, production, or deployment acceptance.

```text
enablement: disabled
reason: acceptance evidence incomplete
```

## Delivery State

| Slice | Commit | State |
| --- | --- | --- |
| Registry schema v2 and artifact digest | `3d455f647` | implemented |
| Trust persistence and reset guard | `e6c1e73a5` | implemented |
| Artifact upload and release binding | `eb32f3802` | implemented |
| Signature schema 2 | `b8c9c2d0a` | implemented |
| Verification lifecycle and trust views | `40644ce60` | implemented |
| Scanners, SBOM, DSSE/in-toto | `add25ed6a` | implemented as tested domain adapters |
| Sandbox capability and egress boundaries | `27f686a64` | implemented as tested ports/adapters |
| Automatic-evidence review gate | `7477c96e6` | implemented |
| Publisher/Admin trust experience | `0d0e748f1` | implemented |
| Deployment and acceptance evidence | this commit | implemented; disabled |

## Fresh Task 10 Evidence

| Completed UTC | Command or artifact | Result | Evidence |
| --- | --- | --- | --- |
| 2026-07-25T08:06:23Z | `pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:developer-center` | pass, exit 0 | Package upload/finalize, queued/running/passed/failed/stale trust, findings, signing, 409 recovery, account substitution, immutable attempts, 1440px and 390px. Screenshots: `apps/web/test-results/developer-center-review-smoke.png` and `developer-center-review-smoke-mobile.png`. |
| 2026-07-25T08:08:00Z | `docker compose ... config --quiet` | pass after correction | Both feature flags resolve to false; worker has no ports, read-only root, dropped capabilities, no-new-privileges, PID limit 256, and three internal networks. |
| 2026-07-25T08:14:15Z | `docker compose ... build developer-trust-worker` | pass, exit 0 | Image `compose-developer-trust-worker:latest`; pnpm 8.11.0 is pinned and the lockfile is used. |
| 2026-07-25T08:15:31Z | isolated Compose runtime probe | pass, exit 0 | Container user `bun`, read-only root, PID 256, no published ports; `/healthz` 200; disabled `/readyz` 503 with every component `disabled`; test container and networks removed. |
| 2026-07-25T10:29:51Z | Registry, DB, SDK, and Web package suites | pass, exit 0 | Registry 67/0, DB 211/0 including real PostgreSQL migration tests, SDK 1163/0, Web 1148/0. Interrupted DB runs were diagnosed as orphaned Bun/PostgreSQL test resources; after bounded cleanup the exact DB package command completed in 315.95 seconds. |
| 2026-07-25T10:30:30Z | Registry/DB/SDK typechecks and DB migration lint | pass, exit 0 | All three typechecks passed. Migration lint accepted 75 files with seven pre-existing destructive-operation warnings. API, Web, and worker typechecks also passed in this Task 10 continuation. |
| 2026-07-25T10:42:06Z | disposable Supabase PostgreSQL migration acceptance | pass with one expected guard rejection | After supplying the baseline-declared Basejump prerequisite, fresh apply ran all 75 migrations; second apply returned `No migrations to run!`; status was up to date; all six trust tables existed. A valid signed fixture plus removal of only the trust ledger row caused the expected `P0001 OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED`. The container was removed. |
| 2026-07-25T10:43:27Z | direct Developer Trust API domain suite | pass, exit 0 | 194/0 across artifact storage, verification, trust gate, unforgeable automatic evidence, schema-2 signing, distribution, install/update/rollback, IAM, safe errors, and Admin routes. The public developer-route check separately passed 17/0. |
| 2026-07-25T10:43:27Z | credential, raw-source, route, and diff hygiene | pass, exit 0 | High-confidence committed-secret patterns: 0 matches. Reviewed sensitive-name matches: API strips `storage_key`; raw-source fixtures assert non-disclosure; scanner stdout/stderr remain bounded worker-internal inputs. `git diff --check` reported no errors; worker remains internal-only. |

## Known Task 10 Red Evidence

| Completed UTC | Check | Failure | Resolution or disposition |
| --- | --- | --- | --- |
| 2026-07-25T08:02:00Z | first self-starting browser run | 120-second readiness deadline expired during Windows cold Turbopack compilation | Default readiness window raised to 240 seconds and made configurable. |
| 2026-07-25T08:04:00Z | second browser run | timed out waiting for `Sandbox verification is still running.` | React development-mode duplicate trust reads advanced a counter-based fixture. Submitted packages now remain deterministically queued; fixed releases prove running and passed independently. |
| 2026-07-25T08:08:00Z | Compose config | service-level and deploy-level PID limits disagreed under Compose v5 | Added matching `deploy.resources.limits.pids: 256`. |
| 2026-07-25T08:09:01Z | first worker image build | cropped workspace included the root package but omitted root workspace dependencies | Root package manifest removed from the cropped install. |
| 2026-07-25T08:12:00Z | second worker image build review | build passed but Corepack selected pnpm 11 and ignored the pnpm-8 lockfile | Dockerfile now pins pnpm 8.11.0; the final build used the lockfile without the incompatibility warning. |
| 2026-07-25T10:18:00Z | recovered DB package suite | an interrupted tool session left two parentless `bun test` processes and disposable migration containers consuming CPU | Scoped test processes and only `kortix-*-migration-*` containers were removed. Split reproduction passed 129 + 18 + 17 + 14 + 33 tests; the exact full package command then passed 211/0. |
| 2026-07-25T10:31:00Z | `pnpm.cmd --filter kortix-api test` | exit 1 before tests: `scripts/test.sh: line 2: set: pipefail\r: invalid option name` | Confirmed CRLF bytes `13 10` after `set -euo pipefail`. This pre-existing Windows wrapper is outside Task 10; direct Developer Trust tests and API typecheck pass, but the package gate remains non-green. |
| 2026-07-25T10:31:35Z | root `pnpm.cmd test` | exit 1; recursive runner returned no package text and left Bun children after fail-fast | The independently reproduced API wrapper failure is the first known blocking package gate. Orphan children were removed; root status remains non-green and is not reclassified from focused passes. |
| 2026-07-25T10:36:00Z | repository-wide Biome/format/i18n gates | baseline non-green | Biome: 11767 errors and 1 warning; format: 3764 errors, dominated by repository CRLF; i18n: 70 missing homepage keys in each of seven non-English locales plus 1435 hardcoded-text findings. No bulk baseline rewrite was attempted. |
| 2026-07-25T10:38:00Z | first disposable fresh migration attempt | baseline stopped at missing external `basejump.account_user` prerequisite | The baseline migration declares Basejump as external. The transaction rolled back; a minimal disposable Basejump prerequisite was created, after which fresh apply and all Task 10 migration checks passed. |

## Migration Acceptance

No repository test database URL was configured in the shell. Acceptance therefore used a disposable `public.ecr.aws/supabase/postgres:17.6.1.143` container as `supabase_admin`; no production or persistent database was touched.

| Gate | State | Evidence |
| --- | --- | --- |
| Fresh apply | pass | All 75 migrations applied after the baseline-declared Basejump prerequisite was supplied; all six trust tables exist. |
| Second idempotent apply | pass | Exit 0: `No migrations to run!`. |
| Migration status | pass | Exit 0: `Up to date - no pending migrations.` |
| DB package tests | pass | 211/0, including all real PostgreSQL migration integration tests. |
| Schema-v1 signed-row reset rejection | pass | Expected non-zero exit with PostgreSQL `P0001` and `OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED`; disposable container removed. |

## Regression Gates

| Gate | State | Latest Task 10 evidence |
| --- | --- | --- |
| Registry tests/typecheck | pass | 67/0; typecheck exit 0. |
| DB tests/typecheck/lint/status | pass | 211/0; typecheck exit 0; 75 migration files linted; status up to date. |
| SDK tests/typecheck | pass | 1163/0; typecheck exit 0. |
| API tests/typecheck | package wrapper blocked; focused and typecheck pass | Package command exits before tests on CRLF `pipefail\r`. Direct Developer Trust suite 194/0, route suite 17/0, artifact/readiness 15/0, and API typecheck pass. |
| Web tests/typecheck | pass except repository i18n baseline | 1148/0; TypeScript exit 0; desktop/mobile browser acceptance exit 0. i18n baseline remains non-green. |
| Worker tests/typecheck | pass | 60/0; typecheck exit 0. |
| Root `pnpm.cmd test` | non-green | Ran twice; exit 1. The recursive runner fails after the independently reproduced API CRLF wrapper error and does not provide full-repository completion evidence. |
| Biome/format/i18n | baseline non-green | Biome 11767 errors/1 warning; format 3764 errors; i18n seven locales x 70 missing keys plus 1435 hardcoded findings. |
| Route/public surface | pass | Developer route tests 17/0; no Admin distribution action or worker endpoint is mounted publicly; Compose publishes no worker port. |
| Credential/raw-source scan | pass | High-confidence credential patterns 0; sensitive-name review confirmed bounded internal handling and explicit non-disclosure tests. |
| CodeGraph sync | pass | CodeGraph reports zero added, modified, or removed pending changes. |

## Acceptance Criteria 1-12

| # | Criterion | Current evidence | State |
| --- | --- | --- | --- |
| 1 | One immutable digest covers every installable byte. | Registry 67/0 plus direct artifact/domain tests 194/0 cover digest vectors, byte recomputation, immutable binding, and tamper rejection. | satisfied pre-enable |
| 2 | Code-bearing approval/sign/publication requires current source scan and sandbox evidence. | Direct domain 194/0 covers queued/running/failed/inconclusive/cancelled/stale policy gates; browser covers blocked and passing states. | satisfied pre-enable |
| 3 | Manual input cannot forge automatic evidence. | Direct domain tests reject manual `source_scan` and `sandbox_test` at service and Admin HTTP boundaries. | satisfied pre-enable |
| 4 | Clean fixture yields deterministic CycloneDX and DSSE/in-toto evidence. | Worker 60/0 covers deterministic SBOM and attestation adapters; runtime adapters remain intentionally unavailable. | satisfied as tested adapter contract |
| 5 | Blocking inputs and dependency failures prevent trust completion. | Worker 60/0 and direct domain 194/0 cover scanner/sandbox failures, stale leases, mismatches, and fail-closed signing. | satisfied pre-enable |
| 6 | Sandbox receives no real tenant or ordinary Kortix token. | Worker isolation/capability tests 60/0 plus credential/raw-source scan pass. | satisfied as tested isolation contract |
| 7 | Signature schema 2 binds all trust digests with no v1 fallback. | Registry 67/0 and direct domain 194/0 include schema-1 rejection and tamper checks across sign/publish/install/update/rollback. | satisfied pre-enable |
| 8 | New identifiers are tenant scoped without existence disclosure. | Direct domain 194/0, route 17/0, DB 211/0, and browser account substitution prove account-qualified reads and opaque 404s. | satisfied pre-enable |
| 9 | Artifact, evidence, install history, and revocation remain immutable and auditable. | Migration acceptance, DB 211/0, direct domain 194/0, and browser immutable-attempt evidence pass. | satisfied pre-enable |
| 10 | Hosted/self-hosted contracts match and disabled trust preserves Kortix. | Compose/image/runtime disabled-state acceptance and package suites pass; root/API wrapper baselines and unavailable production adapters keep this partial. | partial |
| 11 | Focused, package, migration, route, browser, and wider gates are recorded before enablement. | All commands are recorded, but API/root/Biome/format/i18n remain non-green and visible compatibility flows are not full production acceptance. | incomplete |
| 12 | Production execution, metering, settlement, KMS, deployment, and production acceptance remain unclaimed. | Runbook and this ledger explicitly preserve the boundary. | satisfied |

## Enablement Decision

The worker image and deployment contract are buildable, and migration, focused security, route, package, browser, and disabled-runtime checks have recorded evidence. However, the shipped runtime intentionally has no concrete artifact-store, scanner, sandbox-control, or database-claim adapters mounted by `main.ts`. The API/root package gates, repository-wide Biome/format/i18n baselines, and visible end-to-end Kortix compatibility flows are also not fully green. Therefore both `DEVELOPER_TRUST_ENABLED` and `DEVELOPER_CODE_MODULES_ENABLED` remain false.

Production deployment is not authorized by this task.
