# OpenOPC Image Studio Parity Phase 1 Design

**Date:** 2026-08-12

**Status:** Approved design; implementation plan in progress

## Goal

Complete the next bounded slice of the recovered OpenOPC Image Studio module
without reintroducing the upstream canvas, prompt gallery, provider settings,
or brand-specific naming. The slice focuses on the parts of the original
workflow that users need after submitting a generation request: reviewing and
recovering a local GIF, inspecting generated images, retrying safely, and
keeping long-running jobs inside the host capability budget.

## Current Boundary

The module already exposes six host-integrated workspaces:

- Create: prompt optimization, reverse prompt input, model capabilities,
  references, estimates, generation, cancellation, and result reuse.
- Agent: text streaming, vision references, multi-turn conversation, stop,
  generation, cancellation, and result reuse.
- Reverse prompt: image upload, vision model selection, streaming, stop, and
  prompt editing.
- GIF: a fixed twelve-frame local workflow, references, closed-loop framing,
  delay, crop, local encoding, preview, and download.
- Jobs: status filters, cursor pagination, active polling, cancellation, and
  prompt reuse.
- Assets: generated/uploaded source filters, lazy thumbnails, retry, download,
  and use-as-reference.

The current worktree contains the seven recovered module files and no changes
from this design stage are assumed to be committed or pushed.

## Phase 1 Scope

### 1. GIF review and recovery

Keep GIF encoding entirely in the browser until the platform SDK supports a
validated animation asset. The workflow gains an explicit review state after
encoding:

1. The frame grid shows all twelve frames and identifies the selected frame.
2. The preview supports play/pause, loop on/off, loop count, and frame delay.
3. The existing crop mode remains available before re-encoding.
4. Reset restores the source frame order, crop, delay, loop settings, and
   closed-loop choice from the current draft.
5. Re-encode replaces the preview only after the new Blob has been produced;
   an encode failure leaves the previous valid preview intact.
6. A recoverable draft stores the source frame references and bounded GIF
   parameters in the existing session state. An explicit restore action is
   shown when a draft is found; no generation or download happens implicitly.

Per-frame pan, zoom, rotation, onion skin, eyedropper, and touch-specific
tuning remain Phase 2. This keeps the first slice compatible with the current
frame and crop data model while preserving a clear extension point.

The encoded result remains a local download. The UI must not claim that a GIF
was saved as a platform asset, and it must enforce the existing twelve-frame
and browser-memory bounds.

### 2. Generated-result actions

Extend the shared result grid so every generated image can be:

- opened in a focused preview with keyboard-close and a mobile-safe layout;
- downloaded with an extension derived from the actual MIME type;
- copied through the Clipboard API when the browser supports image blobs;
- reused as a reference through the existing asset flow; and
- retried from the original input after a failed or unknown request.

The retry path creates a new idempotency key after the prior request has a
known terminal result. If the network result is unknown, the original key is
retained for one reconciliation attempt before offering a new submission.
The result component receives action callbacks and does not create SDK
requests itself.

### 3. Polling and capability-budget mitigation

Until the main project ships SDK token caching and request coalescing, reduce
module pressure without changing the authorization model:

- active job refresh runs no faster than every five seconds;
- event history is read at most every ten seconds, at terminal transitions,
  or when the user explicitly refreshes;
- only one detail/event request for a job may be in flight at a time;
- hidden documents pause automatic polling and visible documents resume with a
  bounded refresh;
- transient failures use capped exponential backoff; cancellation and terminal
  states stop polling; and
- the jobs workspace and generation status share the same in-flight refresh
  rather than starting independent loops.

This is a mitigation, not a replacement for the SDK fix. The module will adopt
authoritative `output_asset_ids` or a server-side `source_job_id` query when
that contract is available, while retaining the current bounded fallback for
older hosts.

## Deferred Work

The following remains outside Phase 1 and is tracked as later slices:

- Agent proposal/approval flow with editable size, quality, count, and seed;
- reverse-prompt modes, previous-result comparison, paste/drop input, and
  durable drafts;
- a shared platform-asset picker in Create, Agent, Reverse, and GIF;
- task details, event timeline, server-side status filtering, output preview,
  failure retry metadata, and virtualized history;
- asset upload, full preview, search, sort, tags, notes, rename, favorites,
  deletion, bulk actions, text assets, and AI metadata;
- per-frame GIF transforms and platform-persisted animation assets; and
- durable preferences beyond the current session-level recovery state.

Canvas, prompt gallery, custom provider/Base URL/API key configuration, PWA
features, upstream backend code, and upstream branding are explicit
non-goals.

## Component and Data Flow

The existing service remains the only module boundary for SDK calls:

```text
Create or Agent
  -> estimate
  -> create job with idempotency key
  -> shared job watcher
  -> terminal job and asset resolution
  -> GeneratedResults actions

GIF input
  -> bounded frame draft
  -> local encode
  -> review state
  -> local download or re-encode
```

`GifWorkspace` owns review controls and a serial encode operation. The shared
result component owns preview state and browser action capability detection.
`app.tsx` owns the single polling coordinator and visibility lifecycle.
`openopc-image-service.ts` owns retry classification, job reconciliation, and
MIME-safe asset helpers. `session-state.ts` stores only the bounded draft and
never capability tokens or provider data.

## Error and Security Behavior

- Abort errors remain silent except when the user initiated a visible action.
- Encode failures preserve the last valid GIF Blob and expose a retry action.
- Clipboard or preview API absence is reported as an unavailable action, not
  as a successful copy.
- A retry never bypasses estimate, capability, cancellation, or platform
  authorization checks.
- No token, platform origin, object-storage URL, provider identifier, or raw
  provider error is written to session state or rendered in the module.
- GIF memory limits are checked before decoding and encoding; object URLs are
  revoked when previews are replaced or unmounted.

## Files in the First Implementation Slice

- `apps/image-studio-module/src/workspaces/gif-workspace.tsx`
- `apps/image-studio-module/src/components/generated-results.tsx`
- `apps/image-studio-module/src/app.tsx`
- `apps/image-studio-module/src/lib/openopc-image-service.ts`
- `apps/image-studio-module/src/lib/session-state.ts`
- focused module tests under `apps/image-studio-module/src/lib/`
- `apps/image-studio-module/src/styles.css`

No SDK, API, host, main-worktree, manifest, deployment, or release file is
changed by this Phase 1 module implementation. SDK contract changes remain a
separate handoff to the main project.

## Verification Plan

### Automated

Add focused tests for:

1. GIF draft serialization, restore confirmation, reset, bounded parameters,
   and preservation of the prior Blob on encode failure;
2. MIME-to-extension mapping and object URL cleanup;
3. Clipboard capability fallback and retry idempotency behavior;
4. single-flight polling, five/ten-second limits, visibility pause/resume,
   backoff, terminal stop, and cancellation; and
5. existing prompt, image-input, service, and GIF encoder tests.

Run, from the module worktree:

```text
bun test
bun run typecheck
bun run build
```

### Browser

Use the in-app browser against the module host at desktop and 390px mobile
width. Exercise all six workspaces, including GIF encode/review/reset/re-
encode/download, result preview/copy/download/reuse, a failed retry path, and
job visibility pause/resume. Assert no horizontal overflow, no uncaught
console errors or warnings, stable loading/error/empty states, and correct
keyboard/mobile controls.

Real provider generation and durable platform GIF persistence remain explicitly
unverified until credentials and the corresponding SDK contract are available.

## Acceptance Criteria

This design is ready for implementation when the user approves this document.
The Phase 1 implementation is accepted only when:

1. GIF review and recovery never lose the last valid encoded result.
2. GIF controls produce a valid downloadable `GIF89a` file and never claim
   platform persistence.
3. Results preview, copy fallback, MIME-safe download, reuse, and retry are
   visible and testable without duplicating SDK calls.
4. Automatic polling obeys the stated cadence, visibility, single-flight, and
   backoff rules.
5. All automated gates and both responsive browser checks pass on the same
   worktree state.
6. No source file contains the excluded upstream brand name or provider
   configuration.
7. No commit, push, deployment, publication, or installation occurs without
   separate authorization.
