# Infinite Canvas parity matrix

This matrix compares the pinned upstream revision with the OpenOPC sandbox
port. `Available` means the workflow is implemented in the module. `Platform
bounded` means the UI and error state are present, but execution depends on a
public platform contract that is not currently available.

| Upstream area | OpenOPC module status | Boundary or implementation |
| --- | --- | --- |
| Project create, select, rename, delete, bulk select | Available | Local project library plus installation-namespaced recovery |
| Project JSON and ZIP import/export | Available | Bounded validation, safe ZIP paths, media round-trip |
| Canvas pan, cursor zoom, fit, box selection, grid modes | Available | Pointer and wheel interactions in the sandbox |
| Undo, redo, copy, cut, paste, select all, delete | Available | Bounded editor history and keyboard guards for form controls |
| Node connections and minimap | Available | Directed edges, duplicate prevention, interactive minimap |
| Text, image, video, audio, panorama, Director, config, group nodes | Available | All eight upstream node kinds render and serialize |
| Node move, resize, rotate, flip, lock, group and ungroup | Available | Inspector and canvas gestures |
| Local image, video, audio, and panorama upload | Available | Validated MIME and size; blobs stay in IndexedDB |
| Media metadata, asset picker, search, edit, download, delete | Available | Local installation-namespaced asset library |
| Panorama viewing and 2:1 import validation | Available | Same-origin viewer; invalid aspect ratios are rejected |
| Panorama generation | Platform bounded | OpenOPC `image.generate` has no strict 2:1 output contract |
| 3D Director scene and capture bridge | Available | Pinned same-origin Director bundle and model attribution |
| Text generation | Available when granted | `ai.text.generate`; provider and credential stay platform-owned |
| Image generation, references, batches, retry and history | Available when granted | `ai.image.generate`, platform model catalog, local durable history |
| Video generation and recovery | Platform bounded | No public OpenOPC video generation/task contract |
| Audio generation and recovery | Platform bounded | No public OpenOPC audio generation/task contract |
| Assistant sessions, selected/upstream context, retry | Available when granted | OpenOPC text/image services; local mode never calls a provider |
| Prompt library and insertion | Available | Local searchable built-ins and user records |
| Workflow templates, apply, save and run history | Available | Local deterministic workflow composition |
| Upstream server prompt/asset catalogs | Adapted | Local defaults replace upstream server routes |
| Upstream remote workflow sync and series-review backend | Platform bounded | Requires public workflow/task contracts; upstream backend is not copied |
| Persistent project JSON across releases | Available when hosted | `data.documents.*` scoped to account/project/installation |
| Persistent generic binary assets across releases | Platform bounded | Generic installation-scoped binary data API is not yet exposed |
| User/provider configuration | Replaced | Platform-owned non-secret module settings; module has read-only access |
| Direct provider URL/API-key mode | Intentionally removed | Violates the OpenOPC capability and credential boundary |
| Generation logs and cancellation | Available | Local history plus `AbortSignal` for all SDK operations |

The bounded rows are explicit platform requirements, not hidden provider
fallbacks. They must not be reported as live until the corresponding SDK,
worker, provider, and production paths are verified.
