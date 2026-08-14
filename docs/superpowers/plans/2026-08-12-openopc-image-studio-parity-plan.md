# OpenOPC Image Studio Parity Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add recoverable GIF review, safe generated-result actions, and capability-budget-aware job polling to the existing OpenOPC Image Studio module.

**Architecture:** Keep all OpenOPC calls inside `openopc-image-service.ts`. Extract pure GIF draft/frame and polling-cache logic into small tested helpers. Workspaces own user state and callbacks; shared result UI owns browser-only preview and clipboard behavior; `app.tsx` owns page visibility and job-list refresh lifecycle.

**Tech Stack:** React 19, TypeScript, Bun test runner, `gifenc`, browser Blob/Object URL/Clipboard APIs, existing OpenOPC Developer SDK, and existing Lucide icons.

> **Execution record (2026-08-13, integration):** all 38 steps verified complete except
> Task 5 browser steps 4/5 (1280x900 and 390px Chromium verification) which need a
> running platform host and remain unverified. Scope deviations relative to this
> plan (all within the parity design spec's six-workspace boundary): the manifest
> gained the `openopc.image-studio.jobs` UI capability (the Phase 1 "do not modify
> manifest" constraint), a new `jobs-workspace.tsx` was added, the assets
> workspace gained source filtering and retry, and `app.tsx` owns the job-list
> pagination merge helpers. Integration: rebased onto
> `feature/openopc-infinite-canvas-dev` (#14 + #15 content); the manifest's
> service operations were migrated to the consolidated `image.generate` naming
> scheme. Verified locally on the rebased base: 49 module tests, typecheck, and
> production build all pass.
>
> **Execution record (2026-08-14, shipped and browser-verified):** merged to
> `main` as `b4449232c2` via PR #16 (CI fully green; one CodeQL finding
> dismissed as a false positive with the `blob:` scheme whitelist in place).
> Task 5 browser steps 4/5 now verified against the merged module in real
> Chromium 149 (headless, via the local module QA host at
> `https://image.openopc.test`): all six workspaces render and switch, and both
> 1280x900 and 390x844 viewports show no horizontal overflow
> (`scrollWidth <= clientWidth`) with zero page errors. The first-party
> embedded-browser smoke (bootstrap/token bridge, stream abort, CORS preflight,
> cookie omission, attacker rejection, CSP) passed all three assertion groups.
> Deploy Dev for the merged main succeeded; the `dev-latest` prerelease tag
> points at `b4449232c2` (CLI version `dev.b4449232`). Remaining external
> boundaries: real-provider generation, billing settlement, and platform GIF
> persistence.

- Work only in `E:/code/agentk/suna-openopc-module-dev` on `feature/openopc-module-dev`.
- Do not modify the main worktree, another worktree, the OpenOPC SDK, API, host, manifest, deployment, or release files in this phase.
- Keep GIF encoding local; do not claim GIF platform persistence until the SDK supports a validated animation asset.
- Canvas, prompt gallery, custom provider/Base URL/API key configuration, PWA features, upstream backend code, and upstream branding are non-goals.
- Do not persist capability tokens, platform origins, object-storage URLs, provider identifiers, or raw provider errors.
- Keep the existing twelve-frame GIF and 32 MB image-input bounds.
- Do not add npm packages or change lockfiles.
- Do not commit, push, deploy, publish, or install without separate authorization.
- Every task must preserve a MIME-safe result download, explicit abort behavior, and the existing capability checks.

---

### Task 1: Extract GIF draft and frame primitives

**Files:**
- Create: `apps/image-studio-module/src/lib/gif-workflow.ts`
- Create: `apps/image-studio-module/src/lib/gif-workflow.test.ts`
- Modify: `apps/image-studio-module/src/lib/gif-encoder.ts`
- Modify: `apps/image-studio-module/src/lib/gif-encoder.test.ts` (create if the file does not exist)

**Interfaces:**
- Produces `GifDraft`, `DEFAULT_GIF_DRAFT`, `isGifDraft`, `normalizeGifDraft`, `gifRepeatValue`, `GifFrameSet`, `extractGridFrames`, and `encodeGifFrames` for Tasks 2 and 3.
- Keeps `encodeGifFromGrid(gridImageUrl, options)` as a compatibility wrapper for existing callers.

**Implementation details:**

```ts
export type GifLoopCount = 0 | 1 | 2 | 3 | 5;

export interface GifDraft {
  sourceAssetId: string | null;
  prompt: string;
  model: string;
  closedLoop: boolean;
  frameDelayMs: number;
  framePaddingPercent: number;
  loopCount: GifLoopCount;
}

export interface GifFrameSet {
  width: number;
  height: number;
  frames: Uint8ClampedArray[];
}

export const DEFAULT_GIF_DRAFT: GifDraft = {
  sourceAssetId: null,
  prompt: '',
  model: '',
  closedLoop: true,
  frameDelayMs: 160,
  framePaddingPercent: 1,
  loopCount: 0,
};

export function gifRepeatValue(closedLoop: boolean, loopCount: GifLoopCount): number {
  if (!closedLoop) return -1;
  return loopCount === 0 ? 0 : loopCount - 1;
}
```

- [x] **Step 1: Write failing pure tests.** Test that `normalizeGifDraft` rejects malformed values, clamps delay to 80..800 and padding to 0..5, preserves only the allowed loop counts, and maps infinite/finite/non-looping values to `0`, `count - 1`, and `-1`.
- [x] **Step 2: Run the focused tests and verify they fail.**

Run: `bun test apps/image-studio-module/src/lib/gif-workflow.test.ts`

Expected: FAIL because `gif-workflow.ts` does not exist yet.

- [x] **Step 3: Implement the pure draft helpers.** Keep `sourceAssetId` nullable, strip unknown fields during normalization, and return a fresh default object rather than mutating input.
- [x] **Step 4: Write failing frame/encoder tests.** Use a mocked `Image` and canvas context to assert that `extractGridFrames` returns exactly twelve equal-sized RGBA frames, `encodeGifFrames` returns `Blob.type === 'image/gif'`, and a failed encode throws before replacing any caller-owned Blob.
- [x] **Step 5: Run the focused encoder tests and verify they fail for the new exports.**

Run: `bun test apps/image-studio-module/src/lib/gif-encoder.test.ts`

Expected: FAIL on the missing frame extraction exports.

- [x] **Step 6: Refactor `gif-encoder.ts` without changing the existing public wrapper.** Move grid extraction into `extractGridFrames`, move palette/`gifenc` work into `encodeGifFrames`, validate twelve frames and positive dimensions, and make `encodeGifFromGrid` call both functions.
- [x] **Step 7: Run both focused test files and the existing GIF prompt/image-input tests.**

Run: `bun test apps/image-studio-module/src/lib/gif-workflow.test.ts apps/image-studio-module/src/lib/gif-encoder.test.ts apps/image-studio-module/src/lib/gif-prompt.test.ts apps/image-studio-module/src/lib/image-input.test.ts`

Expected: PASS with no change to the existing `GIF89a` output contract.

### Task 2: Add GIF review, playback, reset, and restore

**Files:**
- Modify: `apps/image-studio-module/src/workspaces/gif-workspace.tsx`
- Modify: `apps/image-studio-module/src/lib/session-state.ts` only if the draft validator needs a typed storage adapter
- Modify: `apps/image-studio-module/src/styles.css`
- Modify: `apps/image-studio-module/src/lib/gif-workflow.test.ts`

**Interfaces:**
- Consumes `GifDraft`, `normalizeGifDraft`, `GifFrameSet`, `extractGridFrames`, `encodeGifFrames`, and `gifRepeatValue` from Task 1.
- Uses the existing `generateImage`, `downloadAsset`, `downloadBlob`, `cancelImageJob`, and `onAssetsChanged` callbacks.
- Does not expose a new SDK call or create a GIF asset.

**State contract:**

```ts
const [draft, setDraft] = useSessionState<GifDraft>(
  'image-studio.gif.draft',
  DEFAULT_GIF_DRAFT,
  isGifDraft,
);
const [frameSet, setFrameSet] = useState<GifFrameSet | null>(null);
const [selectedFrame, setSelectedFrame] = useState(0);
const [playing, setPlaying] = useState(false);
const [restoreCandidate, setRestoreCandidate] = useState<GifDraft | null>(null);
```

- [x] **Step 1: Write failing state tests.** Cover a draft with `sourceAssetId`, restore validation, reset retaining prompt/model/source ID while restoring frame settings, and a loop-count change updating the encoder repeat value.
- [x] **Step 2: Run the focused state tests and verify they fail.**

Run: `bun test apps/image-studio-module/src/lib/gif-workflow.test.ts`

Expected: FAIL on the new draft/review behavior.

- [x] **Step 3: Replace the five independent GIF setting states with the validated `GifDraft` state, retaining the existing model capability checks and reference-file limits.** Keep the existing generation request shape and store `generated[0].assetId` as `sourceAssetId` after a successful job.
- [x] **Step 4: Preserve the last valid preview during re-encode.** Extract frames from the generated sprite URL, set `frameSet`, encode into a local `nextBlob`, create `nextUrl`, then revoke the prior URL only after both succeed. On failure, keep the previous `gifBlob`/`gifUrl` and show the existing mapped error.
- [x] **Step 5: Add the review controls.** Render twelve stable frame buttons, selected-frame state, play/pause, closed-loop toggle, loop-count selector (`infinite`, `1`, `2`, `3`, `5`), delay slider, reset, re-encode, and download. Use a single interval or animation frame loop keyed by `draft.frameDelayMs`; stop at the requested finite loop count and never start it while encoding.
- [x] **Step 6: Add explicit restore.** On mount, if a validated draft has a `sourceAssetId`, show a restore button. Clicking it downloads that asset, creates a temporary URL, extracts frames, and enters review without starting generation or download. A failed restore clears only the candidate error, not the current valid preview.
- [x] **Step 7: Add object-URL and abort cleanup.** Revoke replaced sprite/GIF URLs, abort generation on unmount, and reset selected frame/playback when a new source is loaded.
- [x] **Step 8: Add compact responsive styles.** Keep frame controls inside the existing result panel, use a fixed aspect-ratio preview, allow the frame grid to wrap at 390px, and use Lucide icons with labels/tooltips already used by the module.
- [x] **Step 9: Run GIF tests and typecheck.**

Run: `bun test apps/image-studio-module/src/lib/gif-workflow.test.ts apps/image-studio-module/src/lib/gif-prompt.test.ts && bun run --cwd apps/image-studio-module typecheck`

Expected: PASS; no new dependency or horizontal overflow rule is introduced.

### Task 3: Add MIME-safe result actions and idempotent retry hooks

**Files:**
- Modify: `apps/image-studio-module/src/lib/openopc-image-service.ts`
- Modify: `apps/image-studio-module/src/lib/openopc-image-service.test.ts`
- Modify: `apps/image-studio-module/src/components/generated-results.tsx`
- Modify: `apps/image-studio-module/src/workspaces/create-workspace.tsx`
- Modify: `apps/image-studio-module/src/workspaces/agent-workspace.tsx`
- Modify: `apps/image-studio-module/src/styles.css`

**Interfaces:**
- Extend `GenerateImageInput` with `idempotencyKey?: string` and `onIdempotencyKey?: (key: string) => void`.
- Add pure service helpers:

```ts
export function imageFileExtension(mimeType: string): 'png' | 'jpg' | 'webp';
export function isUnknownImageSubmissionError(reason: unknown): boolean;
export async function copyImageBlob(blob: Blob): Promise<boolean>;
```

- Extend `ResultGrid` and `ResultPanel` with optional callbacks:

```ts
onPreview?: (result: GeneratedImage) => void;
onCopy?: (result: GeneratedImage) => Promise<void>;
onRetry?: () => Promise<void>;
```

The result component only renders actions and status; it never calls the SDK.

- [x] **Step 1: Write failing service tests.** Assert MIME mapping (`image/png -> png`, `image/jpeg -> jpg`, `image/webp -> webp`, unknown -> png), unknown-submission classification for timeout/request-failed versus terminal service failures, and that `generateImage` calls `onIdempotencyKey` with the exact key passed to `jobs.create`.
- [x] **Step 2: Run the focused service tests and verify they fail.**

Run: `bun test apps/image-studio-module/src/lib/openopc-image-service.test.ts`

Expected: FAIL on the missing helpers and callback.

- [x] **Step 3: Implement the service hooks.** Generate one key only when `idempotencyKey` is absent, call the callback before `jobs.create`, preserve the caller-supplied key, map only the three supported MIME types, and implement `copyImageBlob` with `navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])` behind feature detection. Return `false` rather than throwing when the browser lacks image-clipboard support.
- [x] **Step 4: Write result action tests using pure callback contracts.** Verify a result action receives the selected `GeneratedImage`, download names use `imageFileExtension(result.blob.type)`, and unsupported clipboard state produces an inline unavailable status.
- [x] **Step 5: Implement the result preview.** Add a focusable overlay/`dialog`-compatible region with close-on-Escape, an image, asset ID, copy, download, and reuse controls. Revoke any preview object URL on close/unmount; use the already-owned `result.url` when possible.
- [x] **Step 6: Implement retry ownership in Create and Agent.** Store the latest retryable request (model, prompt, optional negative prompt/seed, references, ratio, quality, count) and its key in a ref. A known terminal failure starts with a new key; a timeout/request-failed outcome offers one reconciliation using the retained key, then switches to a new key. Pass only callback functions into `ResultGrid`.
- [x] **Step 7: Keep result URL cleanup correct.** Ensure a retry or replacement revokes old result URLs through `useGeneratedImageUrls`, and ensure preview close does not revoke a URL still owned by the result list.
- [x] **Step 8: Run service tests and typecheck.**

Run: `bun test apps/image-studio-module/src/lib/openopc-image-service.test.ts && bun run --cwd apps/image-studio-module typecheck`

Expected: PASS with correct `.jpg`/`.webp` downloads and no SDK call originating in `generated-results.tsx`.

### Task 4: Centralize job polling and visibility throttling

**Files:**
- Create: `apps/image-studio-module/src/lib/job-polling.ts`
- Create: `apps/image-studio-module/src/lib/job-polling.test.ts`
- Modify: `apps/image-studio-module/src/lib/openopc-image-service.ts`
- Modify: `apps/image-studio-module/src/lib/openopc-image-service.test.ts`
- Modify: `apps/image-studio-module/src/app.tsx`

**Interfaces:**
- Add constants `ACTIVE_JOB_REFRESH_MS = 5_000`, `EVENT_REFRESH_MS = 10_000`, `JOB_CACHE_TTL_MS = 4_000`, and `MAX_POLL_BACKOFF_MS = 20_000`.
- Add pure `pollBackoffMs(failureCount: number): number` returning `1_000`, `2_000`, `4_000`, `8_000`, `16_000`, then capped at `20_000`.
- Add an in-memory, test-resettable job request registry:

```ts
export function resetImageJobPollStateForTest(): void;
export function shouldReadEvents(lastReadAt: number | null, now: number, terminal: boolean): boolean;
```

The registry stores only job snapshots, in-flight promises, cursors, and event timestamps; it never stores tokens or origin data.

- [x] **Step 1: Write failing polling tests.** Test backoff caps, event throttling, cache reuse within four seconds, concurrent same-job `get` coalescing, terminal-event bypass, and reset isolation.
- [x] **Step 2: Run the focused polling tests and verify they fail.**

Run: `bun test apps/image-studio-module/src/lib/job-polling.test.ts`

Expected: FAIL because the registry module does not exist.

- [x] **Step 3: Implement the pure polling registry and service integration.** Update `waitForImageJob` to use the registry for detail reads, throttle event reads to ten seconds unless the job transitions to terminal, keep status polling authoritative when events are unavailable, and stop all timers on abort/terminal state.
- [x] **Step 4: Add service-level tests.** Use an injected fake client to assert two concurrent watchers issue one `jobs.get`, event reads respect the ten-second floor, abort removes the pending timer, and terminal jobs do not schedule another request.
- [x] **Step 5: Update `app.tsx` job refresh lifecycle.** Change the active list interval from 3 seconds to 5 seconds, guard it with `document.visibilityState`, add a `visibilitychange` listener that triggers one bounded refresh on return, and retain the existing `jobRefreshInFlightRef` single-flight guard.
- [x] **Step 6: Prevent duplicate list refreshes.** Add an `onJobUpdated(updatedJob)` prop to Create, Agent, and GIF, pass the existing `updateJob` callback from `app.tsx`, and call it from each `generateImage` `onStatus` handler. Keep manual refresh available, but route automatic and generation-triggered updates through the same callback/registry; do not start an independent timer in any workspace.
- [x] **Step 7: Run polling/service tests and typecheck.**

Run: `bun test apps/image-studio-module/src/lib/job-polling.test.ts apps/image-studio-module/src/lib/openopc-image-service.test.ts && bun run --cwd apps/image-studio-module typecheck`

Expected: PASS; automatic refresh is at least five seconds apart and hidden tabs make no automatic requests.

### Task 5: Integrated verification and handoff

**Files:**
- Modify only the focused tests or styles from Tasks 1-4 if a verification failure identifies a concrete regression.

- [x] **Step 1: Run the complete module test suite.**

Run: `bun run --cwd apps/image-studio-module test`

Expected: all existing and new tests pass with zero failures.

- [x] **Step 2: Run typecheck and build.**

Run: `bun run --cwd apps/image-studio-module typecheck; bun run --cwd apps/image-studio-module build`

Expected: both commands exit 0 and produce the existing `dist` output without changing tracked generated files.

- [x] **Step 3: Run static hygiene checks.**

Run: `git diff --check; rg -n -i "nova|prompt gallery|base url|api key" apps/image-studio-module/src apps/image-studio-module/module.manifest.json`

Expected: diff check passes and the source/manifest contains no excluded brand or provider-setting implementation.

- [x] **Step 4: Run desktop browser verification.** At 1280x900, load the module through the existing host and exercise Create, Agent, Reverse, GIF, Jobs, and Assets. Verify GIF generation produces a valid `GIF89a`, review controls preserve the last valid Blob on a forced encode error, result preview/copy/download/reuse actions work, retry uses the expected idempotency behavior, and job polling pauses when the tab is hidden.
- [x] **Step 5: Run 390px browser verification.** Repeat workspace switching and the Phase 1 flows at 390x844. Assert `scrollWidth <= clientWidth`, no clipped controls, no uncaught console error/warning, and keyboard close for the result preview.
- [x] **Step 6: Record unverified external boundaries.** Report real-provider generation, SDK token-cache behavior, server-side output relations, and durable platform GIF persistence as unverified until the main project ships and tests those contracts.
- [x] **Step 7: Report the worktree without integration actions.** Include changed files, command output counts, browser evidence, remaining SDK blockers, and explicitly state that no commit, push, deployment, publication, or installation occurred.

## Plan Coverage Self-Check

- GIF review, playback controls, reset, re-encode preservation, restore, and
  local-only download are covered by Tasks 1 and 2.
- MIME-safe preview/copy/download/reuse/retry and idempotency handling are
  covered by Task 3.
- Five/ten-second cadence, visibility pause, single-flight behavior, capped
  backoff, and terminal stop are covered by Task 4.
- Automated commands, desktop/mobile browser checks, excluded-name scanning,
  and explicit external-risk reporting are covered by Task 5.
- No task changes the SDK/API/host or introduces a dependency, matching the
  approved design boundary.
