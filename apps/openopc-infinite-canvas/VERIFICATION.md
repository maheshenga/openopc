# Infinite Canvas OpenOPC verification

Verified on 2026-08-12 in the isolated worktree
`E:\code\agentk\suna-openopc-infinite-canvas-dev` on branch
`feature/openopc-infinite-canvas-dev`.

No commit, push, deployment, publication, credential read, or credential write was performed.

## Package and manifest

- Module: `openopc.infinite-canvas@0.5.2-openopc.1`
- Execution mode: `sandboxed-web`
- Release files: 11 files, 2,908,154 bytes
- Artifact digest: `sha256:61ccfba3faebbb64c05955a29c500f4e63511f3742be71526324b15679038ac9`
- Capability: `openopc.infinite-canvas.workspace`
- AI operations: `image.generate`, `models.read`, `text.generate`
- Data operations: `documents.delete`, `documents.list`, `documents.read`, `documents.write`
- Settings operations: `settings.read`
- Backend setting fields: `canvas.autosave`, `canvas.background`, `canvas.snap_size`,
  `generation.aspect_ratio`, `generation.image_quality`, `generation.output_count`,
  `workspace.compact_mode`, and `workspace.show_image_info`

The module has no provider URL, provider credential, authorization header, API key, or secret
setting. The only credential-pattern source match is a negative unit-test assertion.

## Automated verification

| Gate | Result |
| --- | --- |
| Module unit tests | 18 passed, 0 failed, 75 assertions |
| Module typecheck | Passed |
| Module Biome format check | Passed, 24 files |
| Module production build | Passed |
| Artifact/manifest validation | Passed |
| API full unit suite | 3,818 passed, 15 integration tests skipped, 0 failed |
| API typecheck | Passed |
| Web full unit suite | 1,244 passed, 0 failed |
| Web typecheck | Passed |
| Web production build | Passed with command-scoped 8 GB Node heap; the default 4 GB run exhausted memory |
| Changed Web ESLint | Passed, 0 errors and 0 warnings |
| Changed-source Biome format check | Passed, 82 files; the legacy mixed-style DB schema file was excluded to avoid unrelated whole-file churn |
| OpenOPC API contract tests | 93 passed, 0 failed |
| Registry tests | 87 passed, 0 failed |
| Developer SDK tests | 50 passed, 0 failed |
| DB OpenOPC schema tests | 12 passed, 0 failed |
| DB migration lint | 89 files passed; 7 warnings belong to older destructive migrations |
| Sandboxed module bootstrap browser smoke | Passed allowed, abort, cleanup, hostile-parent, and CSP cases |
| Git whitespace check | Passed |

The SDK tests cover caller cancellation, `AbortSignal` propagation, listener/timer removal,
capability request correlation, unsafe path rejection, provider-neutral errors, and asset paging
loop protection. The browser smoke test also verifies that a hostile parent cannot obtain a
bootstrap or capability token.

## Rendered browser verification

The production module artifact was served at `http://127.0.0.1:4178/` and exercised in a real
Chromium browser.

- Desktop: 1,280 px viewport, persisted imported project restored, no document overflow, 0 console errors.
- Mobile: 390 x 844 px, no horizontal document overflow, resource drawer and inspector drawer fit
  within the viewport, 0 console errors.
- JSON import restored a real fixture after reload.
- JSON export produced `未命名画布.json` through a real browser download event.
- Provider-unavailable generation produced a visible degraded state without a console error.
- Local project and node-title persistence survived reload.

## Verified boundaries

- Upstream source is pinned to `tigerowo/infinite-canvas` revision
  `6d0bed4eb1ad9f1ec4fe0ec635b267bcb3bc901b`.
- AGPL-3.0, third-party notices, and the Director model attribution ship in the artifact.
- The module obtains project/installation identity from the host bootstrap context.
- Project documents and effective settings use capability-token-mediated SDK calls.
- Media transformation fetches are limited by imported-state validation to local `blob:` or
  `data:image/` assets; Director captures require same-origin messages and bounded `data:image/` data.
- Object URLs, message listeners, timers, and capability request listeners have explicit cleanup.

## Not verified or platform-bounded

- No real provider image/text generation, worker execution, production capability issuer, or live
  account session was used.
- The new database migration was linted and schema-tested but not applied to a real database.
- Video/audio generation and strict 2:1 panorama generation remain unavailable because the public
  OpenOPC SDK does not expose those provider-neutral operations.
- Generic installation-scoped binary asset storage remains a platform gap. Local uploads use
  IndexedDB and generated images use the platform image service; no credential-bearing fallback was
  added.
- Upstream server-side task recovery, remote workflow catalogs, and production sync were not claimed.
- Nothing was committed, pushed, deployed, or published.
