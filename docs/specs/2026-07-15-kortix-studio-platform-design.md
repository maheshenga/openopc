# Kortix Studio Platform Design

**Status:** Approved for phased implementation; Task 9 amended 2026-07-16

**Date:** 2026-07-15

**Target branch:** `studio-platform`

**Primary constraint:** Extend Kortix through additive packages and thin integration points so future upstream updates remain practical.

## 1. Outcome

Kortix gains a team-oriented AI production workspace with direct, production-ready pages for:

- image generation;
- video generation and scene editing;
- multi-speaker voice dialogue synthesis;
- professional AI-assisted 3D modeling;
- Alibaba Cloud digital-human production;
- Alibaba Cloud batch remix production.

The same platform later hosts developer-published industry modules and AI applications. Modules can be discovered in the marketplace, installed into projects, invoked by people or Agents, metered, and included in developer revenue sharing.

The product remains a Kortix extension rather than a competing application. It reuses projects, accounts, IAM, Secrets, Connectors, billing credits, SDK conventions, Agent sessions, audit infrastructure, mobile clients, and desktop shells.

## 2. Scope decomposition

This design is an umbrella architecture. Implementation is divided into independently shippable subprojects:

1. **Studio foundation and Image Studio**
   - shared contracts, job engine, asset storage, provider registry, OpenAI-compatible image adapter, SDK surface, Image Studio page, IAM, metering, and end-to-end verification;
2. **Video Studio and Voice Studio**
   - scene-oriented video jobs, timelines, dialogue speakers, per-line takes, audio alignment, and media-specific provider adapters;
3. **Professional 3D Studio, Digital Human Studio, and batch remix**
   - Three.js professional modeling workspace, 3D asset/version pipeline, Alibaba Cloud avatar adapter, signed callbacks, render timelines, and template-driven batch remix;
4. **Developer Center and module marketplace**
   - module authoring, schema validation, security review, signed versions, sandbox execution, catalog publishing, usage analytics, revenue events, and settlement;
5. **Advanced multi-Agent workflows**
   - reusable workflow definitions, dependency graphs, approval gates, and richer orchestration on top of existing Kortix Agent sessions.

Only subproject 1 is in the first implementation plan. The remaining subprojects must not be partially scaffolded into production code unless an interface is required by subproject 1.

## 3. Non-goals

- Do not replace Kortix projects, Agent sessions, OpenCode, IAM, Secrets, Connectors, SDK, billing wallets, or marketplace ownership semantics.
- Do not route every media provider through the existing chat-oriented LLM Gateway.
- Do not execute arbitrary developer JavaScript in the trusted web origin.
- Do not introduce Redis, Kafka, RabbitMQ, or a second database in the first delivery.
- Do not build a second mobile or desktop business-logic implementation.
- Do not make the first delivery implement video, voice, 3D, digital human, batch remix, payouts, or a general workflow DAG.

## 4. Upstream compatibility

The implementation follows an additive extension model.

### 4.1 Allowed integration points

- One project-router registration for `/v1/projects/:projectId/studio/*`. The signed raw-body callback mount at `/v1/webhooks/studio/:provider` is reserved for the first later provider that requires callbacks; Phase 1 image generation does not mount an unused webhook.
- One project navigation entry and additive Studio route files in the existing web application.
- Canonical SDK facade wiring at `kortix.project(projectId).studio` and React bindings through the existing `@kortix/sdk/react` export. Studio does not add a new SDK subpath.
- Shared wire schemas in `@kortix/api-contract`, additive SDK public-surface snapshots, package export checks, documentation, and publish/install smoke tests.
- Additive Drizzle schema exports, SQL migrations, a `StudioObjectStore` driver, private managed storage, and generated migration metadata.
- One bounded billing migration updates the existing `atomic_use_credits` function body, without changing its signature, so active Studio holds reduce spendable balance for every wallet consumer; account-state contracts gain additive `reserved` and `available` fields.
- Additive `project.studio.*` and `account.studio.*` IAM actions, action-catalog entries, built-in role grants, dispatcher descriptions, and authorization tests.
- One Studio tool-catalog/MCP registration so OpenCode discovers governed Studio tools without changing OpenCode core.
- Additive `apps/studio-worker` workspace, local-compose entry, health/metrics surface, and deployment manifests.
- Optional project experimental-feature registration while Studio is pre-release.
- Route-manifest regeneration, API/SDK/web/mobile tests, and product documentation updates.

### 4.2 Extension-owned paths

The implementation should remain concentrated in:

```text
packages/studio-runtime/
packages/studio-adapters/
packages/api-contract/src/studio/
packages/db/src/schema/kortix.ts                 # additive Studio table block
apps/api/src/studio/
apps/studio-worker/
apps/web/src/features/studio/
packages/sdk/src/core/rest/projects-client/studio/
packages/sdk/src/react/studio/
```

Database definitions remain additive and use a `studio` prefix. Existing core tables are referenced by foreign keys but are not given Studio-specific columns. Thin mandatory touchpoints outside these paths are allowlisted in section 4.1 and checked explicitly during upstream sync.

### 4.3 Compatibility rules

- Existing public SDK names and behavior remain unchanged. Studio follows the existing projects-client, project-facade, root export, and React export recipes.
- Studio contracts are versioned and additive within a major version.
- Provider-specific request and response bodies never escape the adapter boundary.
- Apps consume Studio through `kortix.project(projectId).studio` and `@kortix/sdk/react`, not host-local `fetch` calls.
- Project source files and marketplace-owned files remain git-native. Generated media assets remain in object storage unless a user explicitly saves one into project files.
- An upstream-sync CI job must merge or rebase the extension branch onto the current upstream base, run contract tests, and report conflicts in the allowed integration points.

## 5. Product surfaces

Studio is project-scoped because Kortix projects already define team membership, Agent configuration, Secrets, Connectors, and ownership. An account-level Studio entry may select a recent project and redirect into the corresponding project route.

### 5.1 Shared shell

All Studio pages share:

- current account and project context;
- navigation between production pages and assets;
- job status and run history;
- asset selection and version lineage;
- actor, Agent, cost, provider, and model attribution;
- review and handoff metadata;
- consistent loading, empty, error, retry, permission, and insufficient-credit states.

Each capability still receives a direct product page. The shared backend is not exposed as a generic module runner to ordinary users.

### 5.2 Image Studio

Image Studio presents the complete generation workflow immediately:

- prompt and reference images;
- provider/model, aspect ratio, quality, output count, and advanced controls;
- output grid, selection, download, and output-as-reference actions;
- run history and asset handoff;
- estimated and actual credit usage.

This is the first implemented page. Comparison, upscale, edit, and variation controls appear only when later executable capabilities advertise them; no inactive future controls ship in the first delivery.

### 5.3 Video Studio

Video Studio is scene-oriented and includes:

- storyboard scene list and ordering;
- per-scene prompt, model, duration, references, and motion controls;
- preview player;
- video and audio timeline;
- scene rendering, whole-cut rendering, review, and Agent handoff.

### 5.4 Voice Studio

Voice Studio treats dialogue as a first-class production artifact:

- cast and licensed/cloned/platform voice assignments;
- multi-speaker script lines;
- per-line emotion, speed, pitch, pronunciation, provider, and take history;
- per-line re-synthesis and comparison;
- waveform preview, loudness normalization, subtitle/alignment metadata, and full-mix export;
- separate modes for dialogue synthesis, text to speech, live conversation, transcription, and the voice library.

### 5.5 Professional 3D Studio

3D Studio is a professional modeling workspace, not only a prompt-and-download screen. Its desktop experience includes:

- Scene Outliner and Asset Browser;
- a full-bleed Three.js viewport with orbit, transform gizmos, grids, cameras, lights, selection, and multiple shading modes;
- Object/Edit/Sculpt/Paint-style modes where supported;
- transform, mesh, normals, UV, materials, rig, animation, and export properties;
- animation timeline and version history;
- AI operations for generation, retopology, UV unwrap, texturing, mesh repair, rigging, LOD generation, and map baking;
- GLB, OBJ, USDZ, textures, and preview exports.

Mobile exposes review, comments, asset preview, render status, and approvals. Professional mesh editing remains desktop/web only.

### 5.6 Digital Human Studio

Digital Human Studio includes:

- scenes, avatars, voices, backgrounds, brand kits, and render history;
- presenter preview with safe areas, subtitles, and branding;
- avatar, voice, script, scene, output, gesture, framing, and automation controls;
- Avatar, Voice, Captions, and Gestures timeline tracks;
- Alibaba Cloud connection and region status;
- scene templates that can feed batch remix jobs.

### 5.7 Batch remix

Batch remix creates controlled variants from an approved template. A batch input combines rows from CSV/XLSX/API data with selected template variables such as presenter, language, script, background, product media, captions, and output format. Each row becomes a child job with independent status, cost, error, and output assets. The batch exposes aggregate progress and a downloadable report.

## 6. Frontend architecture

### 6.1 Routes

The final route family is project-scoped:

```text
/projects/:projectId/studio/image
/projects/:projectId/studio/video
/projects/:projectId/studio/voice
/projects/:projectId/studio/3d
/projects/:projectId/studio/digital-human
/projects/:projectId/studio/batch-remix
/projects/:projectId/studio/jobs/:jobId
/projects/:projectId/studio/assets
/developer/modules
```

Only the Image Studio, jobs, and assets routes ship in subproject 1.

### 6.2 State ownership

- React Query owns server state, caching, refetching, and mutation invalidation.
- Web and Electron use SDK SSE bindings for live job events and reconnect cursors, with cursor polling as a fallback.
- React Native uses the same SDK job/event contracts through cursor polling in subproject 1 because the current SDK does not provide a React Native EventSource transport. Mobile suspension and resume continue from the last durable cursor.
- A future injectable SDK `EventStreamTransport` may enable native streaming. Studio must not introduce a third host-local event implementation.
- Zustand is limited to ephemeral view state such as selection, panel size, viewport tools, unsaved prompt drafts, and local filters.
- Durable prompts, jobs, outputs, comments, reviews, and assets live on the server.

### 6.3 UI composition

Studio reuses Kortix primitives and tokens. It must not introduce a separate design system.

- Use the existing project shell and central menu registry.
- Use `Modal`, `Hint`, `Badge`, `Loading`, `EmptyState`, `ConfirmDialog`, field primitives, compact tabs, and existing toast helpers.
- Keep operational pages dense, neutral, and scan-friendly.
- Do not nest decorative cards or use marketing-style hero composition.
- Use stable panel dimensions and responsive constraints.
- Every destructive action requires confirmation.
- All dynamically changing counts, timecodes, costs, frames, and progress values use tabular numerals.

### 6.4 Cross-platform behavior

- Web is the complete product surface.
- Electron continues to wrap the same web application.
- Expo mobile consumes the same SDK and implements task creation, job status, asset review, comments, approvals, and downloads.
- Mobile does not reproduce the professional 3D editor or a dense video timeline in the first related delivery.

## 7. Backend architecture

### 7.1 Data flow

```text
Web/Mobile/Desktop or Agent tool
  -> kortix.project(projectId).studio
  -> POST /v1/projects/:projectId/studio/jobs
  -> transaction: validate + authorize + estimate/reserve + queue event
  -> Postgres job row
  -> worker claims row with a lease
  -> provider adapter synchronous completion or durable submit/poll
  -> normalized result
  -> object storage assets + asset rows
  -> usage settlement + audit event
  -> durable Studio event
  -> SSE/polling client update
```

### 7.2 Capabilities

The platform reserves these capability identifiers for the subprojects that implement them:

```text
image.generate
video.generate
voice.dialogue
voice.synthesize
voice.transcribe
model3d.generate
model3d.process
avatar.render
video.batch_mix
```

Subproject 1 advertises only executable `image.generate` descriptors. Reserved identifiers for video, voice, 3D, digital human, and batch remix do not appear in `/capabilities`, routes, database seed rows, or UI controls until their own subproject is enabled.

Capability descriptors include a version, accepted input contract, output asset kinds, supported models, limits, estimated-cost inputs, asynchronous behavior, cancellation support, region constraints, and required credential type.

### 7.3 Job lifecycle

Subproject 1 public job states are:

```text
queued -> running -> succeeded
              \-> failed
      \-> cancelled
```

Drafts remain client-side until submission. A later collaboration contract version may add `review`, meaning provider work succeeded but configured human approval is required before downstream use. Subproject 1 does not emit, persist, or render `draft` or `review` job states.

The database enforces public state transitions in application code through one state-machine package. Routes and adapters cannot update status directly. Attempt-level internal states may include `created`, `submitting`, `submitted`, `polling`, `reconciling`, `succeeded`, `failed`, and `cancelled` without expanding the public job state contract.

Each job stores account, project, actor, capability, provider, model, versioned input, status, cost estimate, reserved amount, actual amount, idempotency key, attempt count, provider handle, cancellation state, error code, error message, timestamps, and optional parent/batch/Agent session references.

### 7.4 Provider adapter contract

Provider-specific behavior is split between a credential-free definition used by API estimates and a credential-bound invocation adapter used by the worker:

```ts
interface StudioProviderDefinitionConfig {
  provider_config_id: string;
  provider: string;
  base_url: string | null;
  region: string | null;
  capability_map: Record<string, unknown>;
  version_token: string;
}

interface StudioProviderDefinition {
  readonly id: string;
  capabilities(config: StudioProviderDefinitionConfig): readonly CapabilityDescriptor[];
  validate(config: StudioProviderDefinitionConfig, model: string, input: StudioJobInput): StudioValidationResult;
  estimate(config: StudioProviderDefinitionConfig, pricing: StudioPricingSnapshot, input: StudioJobInput): StudioCostEstimate;
}

interface StudioProviderAdapter {
  readonly id: string;
  submit(ctx: StudioProviderContext, input: StudioJobInput): Promise<StudioProviderSubmission>;
  poll(ctx: StudioProviderContext, handle: StudioProviderHandle): Promise<StudioProviderStatus>;
  cancel(ctx: StudioProviderContext, handle: StudioProviderHandle): Promise<void>;
  reconcile?(ctx: StudioProviderContext, submissionKey: string): Promise<StudioProviderHandle | 'not-found' | 'unknown'>;
  fetchResult(ctx: StudioProviderContext, handle: StudioProviderHandle): Promise<StudioProviderResult>;
}
```

Definitions validate models and calculate estimates without provider credentials. Invocation adapters return either a synchronous completed result or an asynchronous canonical handle, plus canonical statuses, errors, usage, and replayable-within-attempt asset streams. Raw provider bodies may be stored only as redacted diagnostic metadata with bounded size and retention.

Planned adapters are:

- `openai-compatible` for compatible image/audio/media endpoints and custom base URLs;
- `aliyun` for Alibaba Cloud digital human and batch remix APIs;
- `http-json` for reviewed REST providers supporting synchronous, polling, or webhook completion;
- later local/private adapters for enterprise GPU deployments.

### 7.5 Credential resolution

Studio does not store raw API keys in job rows or provider configuration rows. A provider configuration stores only:

- provider kind and display metadata;
- base URL and optional region;
- model/capability mappings;
- a reference to an existing Kortix Secret or Connector credential;
- account/project scope and activation state.

The worker resolves the binding through the server-only `StudioCredentialResolver` port. Its concrete implementation is exposed by the extension-owned `apps/api/src/studio/credentials.ts` facade, which reuses Kortix Secret encryption and default Connector profile rules without making the worker import API core modules directly.

Provider administration and provider use are separate authorities. Creating, changing, disabling, or rebinding a provider configuration requires `project.studio.providers.manage`. Estimating or running a job through an enabled configuration requires both `project.studio.jobs.run` and `project.studio.providers.use`; it does not grant the caller raw Secret/Connector read access. The job stores the configuration and credential-binding IDs, never the credential value.

Before every provider submission, the worker revalidates project membership, the provider configuration, and the binding's active state, then uses the existing server-side Secret/Connector service under its service role to resolve the value for that submission only. Agent-created jobs must pass the Agent grant fold both at creation and immediately before submission: `project.studio.jobs.run` and `project.studio.providers.use` must be admitted by `agentGrant.kortixCli`; a Secret binding's stable project-secret identifier must match `agentGrant.env` through the existing `agentMayUseEnv` semantics, while a Connector binding's slug must match `agentGrant.connectors` through `agentMayUseConnector`. Provider credentials are never returned to clients, Agents, job payloads, logs, or developer modules.

## 8. Persistence

Subproject 1 introduces the minimum durable model:

### 8.1 `studio_jobs`

One row per execution unit. In addition to execution fields, it stores the actor principal type, actor user ID, optional `acting_token_id`, Agent name, and session ID required to re-evaluate the current human or Agent grant. Important indexes cover account/time, project/time, status/availability, provider handle, parent job, and lease expiry. A unique `(account_id, idempotency_key)` constraint prevents duplicate job creation. Reusing a key with a different canonical request hash returns `STUDIO_IDEMPOTENCY_MISMATCH`.

### 8.2 `studio_job_attempts`

One row per provider submission or retry, including a stable unique submission key, provider request ID, adapter version, internal attempt status, start/end time, retry classification, redacted diagnostic metadata, and upstream usage/cost. The attempt and submission key are committed before external I/O.

### 8.3 `studio_job_events`

An append-only event stream with a monotonically increasing cursor per job. Subproject 1 events include queued, claimed, provider-submitted, progress, asset-created, succeeded, failed, cancelled, retry-scheduled, and billing-settled. A later collaboration contract may add review events. Retention jobs compact old progress events while retaining terminal and billing events.

### 8.4 `studio_assets`

Durable asset metadata: account, project, creator, source job, kind, MIME type, object-storage bucket/key, checksum, size, dimensions, duration, frame rate, media metadata, version parent, visibility, and timestamps.

### 8.5 `studio_job_assets`

Links assets to jobs with roles such as input, reference, output, preview, thumbnail, source, mask, audio, caption, texture, and report.

### 8.6 `studio_asset_uploads`

Tracks a pending client upload before it becomes a trusted asset. It stores account, project, actor, object key, declared MIME type, expected size/checksum, signed-upload expiry, status, and finalized asset ID. Signed upload URLs expire after 15 minutes; unfinished rows expire after 30 minutes and are removed by maintenance. Finalization verifies object existence, detected MIME type, exact size, checksum, ownership, and image limits before creating `studio_assets` and attaching it to a job.

### 8.7 `studio_credit_reservations`

Stores one reservation per billable job: account, job, maximum amount, settled amount, status, expiry, reservation idempotency key, settlement key, and final credit-ledger transaction ID. A unique job key and unique settlement key make creation, settlement, and release idempotent.

### 8.8 `studio_usage_events`

Records operational and financial attribution independent of LLM token fields: account, project, actor, job, attempt, capability, provider, model, upstream cost, platform price, final cost, reservation, credit-ledger transaction, outcome, and timestamp.

### 8.9 `studio_provider_configs`

Stores account/project-scoped adapter configuration: adapter kind, display name, base URL, region, enabled model/capability mappings, credential binding ID, immutable pricing-catalog references, enabled state, creator, and timestamps. It never stores a raw credential. Project configuration takes precedence over an enabled account default. `project.studio.providers.manage` cannot edit rates or markup.

### 8.10 `studio_pricing_catalog`

Stores immutable account-scoped pricing versions: provider, model, unit, rate data, maximum-cost rule, markup rule, version, active state, creator, and creation time. An actor with `billing.write` creates a new version or deactivates one for future estimates; estimates and jobs keep referencing the exact version they signed.

### 8.11 `studio_job_recoveries`

Stores immutable, idempotent unknown-outcome decisions keyed by job and caller idempotency key: decision, actor, reason, evidence reference, prior state, resulting state, and creation time. It never stores a raw provider URL or credential.

### 8.12 `studio_billing_incidents`

Stores an immutable account/project/job/attempt-scoped incident when an unknown-outcome reservation reaches its 30-day cap. Opening the incident atomically ends the user's active hold after settling only verified cost, records remaining potential provider liability, and requires the Task 14 billing-operations path for later evidence. Late unknown cost is never charged automatically to the user.

### 8.13 `studio_webhook_deliveries`

Introduced only with the first later callback-based provider. It provides callback replay protection and auditability through a unique `(provider, delivery_id)` key, verified body hash, received time, mapped attempt, processing result, and terminal event cursor.

### 8.14 Later tables

Module, review, batch, workflow, and revenue tables are introduced only in the subprojects that need them. Their identifiers are reserved in contracts but no empty production tables are created in subproject 1.

## 9. API surface

Subproject 1 exposes:

```text
GET    /v1/accounts/:accountId/studio/pricing-catalog
POST   /v1/accounts/:accountId/studio/pricing-catalog
POST   /v1/accounts/:accountId/studio/pricing-catalog/:pricingCatalogId/deactivate
POST   /v1/accounts/:accountId/studio/billing-incidents/:incidentId/resolve
GET    /v1/projects/:projectId/studio/capabilities
GET    /v1/projects/:projectId/studio/providers
POST   /v1/projects/:projectId/studio/providers
PATCH  /v1/projects/:projectId/studio/providers/:providerConfigId
DELETE /v1/projects/:projectId/studio/providers/:providerConfigId
POST   /v1/projects/:projectId/studio/estimates
POST   /v1/projects/:projectId/studio/jobs
GET    /v1/projects/:projectId/studio/jobs
GET    /v1/projects/:projectId/studio/jobs/:jobId
POST   /v1/projects/:projectId/studio/jobs/:jobId/cancel
POST   /v1/projects/:projectId/studio/jobs/:jobId/retry
POST   /v1/projects/:projectId/studio/jobs/:jobId/recovery
GET    /v1/projects/:projectId/studio/jobs/:jobId/events
POST   /v1/projects/:projectId/studio/uploads
POST   /v1/projects/:projectId/studio/uploads/:uploadId/finalize
DELETE /v1/projects/:projectId/studio/uploads/:uploadId
GET    /v1/projects/:projectId/studio/assets
GET    /v1/projects/:projectId/studio/assets/:assetId
POST   /v1/projects/:projectId/studio/assets/:assetId/download-url
```

Contracts use Zod from `@kortix/api-contract` and Hono OpenAPI. Pricing-catalog writes and billing-incident resolution require `billing.write` for the exact account and never expose provider credentials. The incident route is internal/non-SDK, validates evidence server-side, and never re-debits a user after the 30-day hold transfer. Every project route derives scope only from the path parameter, authorizes that exact project, and constrains every job, upload, asset, provider configuration, event, and credential query by the same project ID. There is no account-wide job or asset fallback listing in subproject 1. Cross-project identifier substitution returns 404 after authorization and never leaks existence. The recovery route additionally requires `billing.write` and `project.studio.jobs.cancel`, is omitted from the public SDK, and has no Phase 1 UI.

Errors use stable machine-readable codes and an optional retry hint. List endpoints use cursor pagination. Creation accepts an `Idempotency-Key` header and returns the same job for a repeated matching request; a different request hash with the same key returns 409.

The events endpoint has two contract representations. Web and Electron request `Accept: text/event-stream`; the initial position comes from the `cursor` query parameter, a reconnect may send `Last-Event-ID`, and `Last-Event-ID` takes precedence when both are present. Every data event sets its SSE `id` to the durable event cursor. The API sends an SSE comment heartbeat every 15 seconds without advancing the cursor. JSON clients use the same endpoint without the SSE accept header for cursor pages or a bounded wait of at most 25 seconds; this is the Phase 1 mobile and Agent transport.

The Studio events route is explicitly exempt from the API request-deadline middleware for both representations; the SSE `Accept` check is retained as defense in depth. The SDK SSE binding uses a dedicated authenticated fetch-stream transport with caller cancellation and reconnect handling, and does not inherit `api-client`'s 30-second request timeout. Tests hold an idle stream beyond both deadlines, verify heartbeats, reconnect from `Last-Event-ID`, and recover from an expired cursor.

## 10. Worker model

The API process does not hold a long HTTP request open while a provider generates media.

- `apps/studio-worker` is a separate Bun process and deployment. API-only pods never claim Studio jobs. The first managed deployment may run one worker replica, and the same row-lease protocol supports horizontal replicas without a queue migration.
- Any Studio worker replica may claim new submissions and due provider polls with `FOR UPDATE SKIP LOCKED`.
- A claim writes `locked_by` and `locked_until`; workers heartbeat leases while performing a local transfer, provider submission, or result download.
- For an Agent job, the worker performs an uncached read of `acting_token_id` before IAM evaluation and requires `status = 'active'`, `revoked_at IS NULL`, `expires_at IS NULL OR expires_at > now()`, and the persisted project binding to match the job. Only then may it pass the current binding and grant into `authorizeV2()` and the credential-grant checks. This authentication step is mandatory because `authorizeV2()` assumes request middleware has already validated token lifecycle state and its memoized binding lookup is not a revocation check.
- Before external submission, one transaction creates the attempt, assigns a stable unique submission key, changes the public job to `running`, and commits the lease. Only an adapter-owned, provider-bound reviewed profile may pass that key as an upstream idempotency mechanism; project configuration cannot declare the guarantee.
- An asynchronous provider persists its handle and `next_poll_at`. If the worker crashes between acceptance and handle persistence, the next worker calls the adapter's `reconcile` method with the stable submission key. A provider without idempotency or reconciliation support leaves the attempt in `reconciling` and the public job in `running`; it is never automatically resubmitted. After 15 minutes it raises `STUDIO_SUBMISSION_OUTCOME_UNKNOWN` for operator resolution while retaining the reservation. At 30 days, maintenance ends the user hold atomically and transfers remaining uncertainty to an audited billing incident; it never holds the user's available balance indefinitely.
- A synchronous completed result is written to deterministic object staging and a durable manifest before finalization. Storage retries use `openBody()` only while the same attempt retains a replayable source. A process exit, consumed source, or expired output URL before durable staging becomes an explicit unknown outcome and never causes a second provider submission.
- Retryable failures receive at most three total attempts by default. Delays use full jitter bounded by 5 seconds, 30 seconds, and 120 seconds; a longer provider `Retry-After` is honored up to 15 minutes. Adapters may lower the attempt limit but cannot exceed three in subproject 1.
- A Studio-owned maintenance lease uses `kortix.worker_leader_lease` with the distinct lock key `studio-maintenance`. `apps/studio-worker` obtains it through a Studio-owned, instance-based parameterized lease primitive whose constructor accepts lock key, owner ID, TTL, and renewal interval. It must not import `apps/api/src/shared/leader-election.ts`, whose module-global state and `LOCK_KEY = 'background-workers'` are intentionally API-specific. The maintenance owner requeues expired local leases, detects stuck reconciliation, compacts events, expires uploads, and reconciles leaked credit reservations; it does not poll normal provider handles.
- Polling, reconciliation, staging recovery, and terminal writes are idempotent. A terminal job cannot be charged or completed twice.
- Cancellation is best effort at the provider and definitive in Kortix. Late provider results after cancellation are quarantined and never become active outputs unless an operator explicitly recovers them.

No in-memory queue is authoritative.

## 11. Assets and storage

Studio runtime code depends on a streaming `StudioObjectStore` port rather than Supabase APIs directly. The port provides readiness, signed upload creation, object stat, bounded streaming read/write, short-lived signed download, and delete operations. Transfers use `ReadableStream<Uint8Array>` (or an equivalent adapter-native stream) and must not buffer complete video, audio, or 3D outputs in API/worker memory.

The first production driver uses the S3 protocol with a private Studio bucket and fixed prefix. MinIO provides deterministic conformance coverage. Alibaba Cloud OSS must pass a gated compatibility smoke before the S3-compatible driver is enabled for its endpoint; if it fails, a native OSS driver implements the same port. Database rows store the selected driver namespace plus bucket/key, not provider-specific client objects.

Studio storage is not assumed to exist in every self-hosted deployment. On startup and with a 60-second success cache, the API and worker run a one-byte put/head/get/delete probe under `_studio-readiness/{role}/{uuid}`; a 24-hour lifecycle rule removes abandoned probe keys. When no driver is configured, Studio remains unavailable and `/capabilities` advertises no executable `image.generate`; upload and job-creation attempts return `STUDIO_STORAGE_UNAVAILABLE` with an administrator-facing configuration hint. A transiently unhealthy configured store also returns 503 for new media work, while already durable jobs remain queued for bounded recovery instead of losing state. Bucket creation remains an operator action.

- Upload creation inserts `studio_asset_uploads` and returns a signed URL valid for 15 minutes. An unfinalized upload expires after 30 minutes.
- The API validates ownership, declared MIME type, detected MIME type, size, checksum, and capability limits before attaching an input.
- Provider output URLs are fetched server-side with SSRF protections, bounded size, timeouts, redirect limits, and content validation.
- Downloads use short-lived signed URLs after IAM checks.
- Deleting an asset requires a retention check because it may be referenced by another job or version.
- A user may explicitly export an asset into project files through the existing project/file workflow.

## 12. IAM and collaboration

Studio adds resource actions to the existing project/account authorization model:

```text
project.studio.jobs.read
project.studio.jobs.run
project.studio.jobs.cancel
project.studio.assets.read
project.studio.assets.write
project.studio.providers.use
project.studio.providers.manage
account.studio.modules.publish
billing.read
```

The `project.` prefix is required by Kortix's current IAM resource-type dispatcher. The actions are added to the existing action catalog and built-in role matrices: project members receive Studio job/asset read, job run, and configured-provider use; editors receive cancel and asset write; managers receive provider management. `providers.use` permits execution through an enabled binding but never exposes its raw credential, while `providers.manage` controls configuration and rebinding. Studio review requests reuse the existing `project.review.read`, `project.review.submit`, and `project.review.act` actions instead of defining a second review permission family. Developer publication is account-scoped and billing visibility continues to use the existing `billing.read` action.

Every mutation stores the actor user ID or Agent principal. Project membership determines the default scope. Jobs revalidate the actor's continued project access before the first provider submission; access revocation before submission cancels the queued job and releases its reservation. Review comments, assignment, and presence are later collaboration features, but the first delivery includes creator attribution and audit events.

## 13. Billing and metering

Studio reuses the Kortix credit wallet while adding a reservation/settlement layer suitable for asynchronous media jobs.

1. `estimate` returns provider cost, platform price, a maximum approved amount, and a signed estimate token expiring five minutes after issuance. The token binds project, actor, capability, provider config/version, immutable pricing-catalog version, model, canonical input hash, maximum amount, and expiry; job creation requires it.
2. Job creation calls `public.atomic_create_studio_job`, which locks the credit account, verifies the unreserved available balance, and inserts the job, active reservation, and queued event in one database transaction.
3. Provider attempts record upstream usage and cost.
4. Success settles the actual amount and releases unused reservation.
5. Retryable failure accrues any upstream cost while retaining the remaining approved reservation for the bounded retry budget.
6. Permanent failure or cancellation settles unavoidable upstream cost and releases the unused amount.
7. Self-hosted billing-disabled deployments record usage but do not deduct credits.

An active hold must be respected by every existing wallet consumer. The Studio migration therefore replaces the body, but not the signature, of `public.atomic_use_credits` so it subtracts active `studio_credit_reservations` when checking spendable balance. Focused migration tests must prove that existing LLM, compute, auto-top-up, expiry, and billing-ledger semantics remain unchanged when no Studio reservation exists.

The account-state response gains additive `reserved` and `available` credit fields so every host reports spendable balance accurately. `total` retains its existing meaning; with no active holds, `reserved` is zero and `available` equals `total`.

`public.atomic_settle_studio_job` locks the reservation and credit account, applies the same daily/expiring/non-expiring bucket ordering as the current wallet, inserts exactly one final `credit_ledger` debit keyed by the unique settlement key, writes `studio_usage_events`, and marks the reservation settled. `public.atomic_release_studio_job` releases an unused reservation idempotently. The maintenance reconciler releases an expired reservation only when its job is terminal or no provider attempt can still incur cost; otherwise it extends the hold and emits an operational alert.

Credential-free provider definitions estimate from immutable account pricing-catalog versions. Project provider managers may select active catalog entries but cannot edit rates or markup. If verified actual provider cost exceeds the approved maximum because a provider violated its pricing contract, the user is charged no more than the reservation, the platform records the excess, and a critical estimate-violation alert is emitted.

Reservations and usage records do not overload LLM token fields. Usage attribution includes capability, provider, model, job, actor, upstream cost, markup, final cost, and billing transaction reference.

Developer revenue sharing is not implemented in subproject 1. Later it uses an append-only revenue ledger derived from successful paid module runs. Settlement never edits historical run records.

## 14. Agent integration

Studio uses the existing OpenCode Task/subagent/session runtime. It exposes governed tools:

```text
studio.create_job
studio.get_job
studio.wait_job
studio.list_assets
studio.get_asset
studio.attach_asset
studio.request_review
```

The first delivery requires create, get, wait, list assets, and get asset. Tools call the same SDK/API contracts as the UI. Agents receive asset IDs and signed, short-lived access only when permitted. Provider keys are never exposed.

The tool face is an additive, versioned Studio registration in the existing Kortix CLI/MCP tool catalog. `apps/api/src/studio/tools` maps tool calls to the same service methods used by project routes, and the existing injected Kortix MCP configuration discovers the catalog entry. OpenCode core and its Task implementation are not modified.

The session-scoped token supplies project, actor, Agent, and grant context. Jobs persist `acting_token_id` so the worker can perform the uncached lifecycle validation defined in section 10, then re-evaluate IAM, the current Agent action grant, and the selected Secret/Connector grant before submission. `studio.wait_job` is a bounded long poll of at most 25 seconds and returns a durable event cursor plus current status; Agents repeat it until terminal or cancel their own wait without cancelling the underlying job.

Jobs may store `session_id` and `parent_job_id`. This supports observable Agent handoffs without adding a new orchestration runtime. A later workflow subproject adds explicit step dependency edges and approval gates.

## 15. Developer module system

Developer Center is a later subproject, but the architecture reserves the following contract:

- versioned module manifest;
- module identity, publisher, semantic version, category, and supported locales;
- declared capabilities, JSON Schema inputs/outputs, asset kinds, permissions, Secrets/Connectors, UI surfaces, and execution mode;
- execution modes for reviewed Studio adapters, Agent skills/projects, declarative forms, and sandboxed web applications;
- automated validation, static scanning, sandbox tests, permission review, human review, signing, publishing, revocation, and deprecation;
- no arbitrary JavaScript in the trusted Kortix web origin;
- custom UI runs in a sandboxed iframe with a narrow postMessage capability bridge;
- modules receive scoped capability tokens, not raw platform or provider credentials.

Industry modules such as recruiting and local-information workflows remain compatible with Kortix's git-native project/skill model. Studio modules add server-executed capabilities without replacing owned project files.

Module manifests, source, and marketplace/registry packages remain git-native and are the canonical catalog. Later database rows may index discovery fields and store review decisions, signatures, runtime installations, usage analytics, revenue events, and revocation state, but they are derived operational metadata, never a second canonical module catalog. Reindexing from the signed git-native package must be sufficient to rebuild catalog metadata.

## 16. Errors and recovery

Stable error families include:

```text
STUDIO_VALIDATION_ERROR
STUDIO_PERMISSION_DENIED
STUDIO_INSUFFICIENT_CREDITS
STUDIO_CREDENTIAL_MISSING
STUDIO_CREDENTIAL_EXPIRED
STUDIO_CREDENTIAL_UNAVAILABLE
STUDIO_MODEL_UNSUPPORTED
STUDIO_ESTIMATE_EXPIRED
STUDIO_IDEMPOTENCY_MISMATCH
STUDIO_PROVIDER_CONFIG_INVALID
STUDIO_PROVIDER_CONFIG_STALE
STUDIO_PRICING_STALE
STUDIO_PROVIDER_UNAVAILABLE
STUDIO_PROVIDER_RATE_LIMITED
STUDIO_PROVIDER_REJECTED
STUDIO_PROVIDER_TIMEOUT
STUDIO_SUBMISSION_OUTCOME_UNKNOWN
STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED
STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED
STUDIO_ASSET_INVALID
STUDIO_ASSET_TOO_LARGE
STUDIO_UPLOAD_EXPIRED
STUDIO_STORAGE_UNAVAILABLE
STUDIO_JOB_CONFLICT
STUDIO_JOB_NOT_CANCELLABLE
STUDIO_RECOVERY_CONFLICT
STUDIO_BILLING_INCIDENT_REQUIRED
STUDIO_WEBHOOK_SIGNATURE_INVALID
STUDIO_WEBHOOK_REPLAYED
STUDIO_EVENT_CURSOR_EXPIRED
STUDIO_INTERNAL_ERROR
```

Errors distinguish user-fixable, retryable, provider-terminal, and platform-internal failures. Retryable HTTP responses include `Retry-After` when known and API error bodies include `retryable`, `nextRetryAt`, and a correlation ID. Provider messages are normalized and redacted. The UI shows a specific recovery action: edit inputs, reconnect credentials, refresh an estimate, top up, retry, choose another provider, or contact an administrator.

`studio_job_events` retains terminal, billing, and asset events for the life of the job. High-frequency progress events are compacted after 30 days. A cursor older than the retained progress range returns `STUDIO_EVENT_CURSOR_EXPIRED` with the current job snapshot and earliest available cursor so clients recover without losing terminal truth.

## 17. Security

- Reuse Supabase authentication, project/account IAM, audit events, Secret encryption, Connector scoping, and request deadlines for non-streaming, non-long-poll requests; the explicit Studio events exemption in section 9 remains authoritative.
- When a later provider introduces callbacks, validate every callback signature and enforce replay protection before mounting the reserved webhook route.
- Apply SSRF protection to custom base URLs and provider output downloads.
- Reject private/link-local destinations unless an administrator explicitly enables a private enterprise provider.
- Never log API keys, signed asset URLs, raw Authorization headers, or unredacted provider payloads.
- Enforce upload/output MIME, size, duration, dimension, frame-count, and archive-content limits.
- Scan developer artifacts before publication and execute them outside the trusted web/API process.
- Store immutable audit events for provider configuration, job execution, cancellation, retry, review, asset download, module publication, and billing settlement.

## 18. Observability

Metrics include queue age, claim latency, provider submission latency, provider completion latency, success/failure/cancellation rate, retries, unknown outcomes, asset transfer latency, storage readiness, SSE reconnects, estimate error, upstream cost, final cost, and reservation leaks. Webhook delay is added with the first callback-based provider.

Every request, job, attempt, event, asset, billing record, and provider callback carries a correlation ID. Structured logs include IDs and classifications but no sensitive payloads. Existing operational surfaces should add Studio queue depth and oldest queued job.

## 19. Testing strategy

### 19.1 Contracts

- `@kortix/api-contract` Zod/JSON fixtures for every capability, job state, event, error, provider status, upload, asset, estimate, and API body.
- Public SDK export and type-surface snapshots.
- Backward-compatible fixture tests when adding contract fields.

### 19.2 Runtime

- State-machine transition tests.
- Idempotent job creation, synchronous staging, polling, reconciliation, cancellation, settlement, and retry tests.
- Lease expiry and concurrent `SKIP LOCKED` claim tests against Postgres.
- Parameterized maintenance-lease tests prove `studio-maintenance` cannot collide with or mutate the existing `background-workers` lease owner.
- Fault-injection tests at attempt commit, provider acceptance, handle persistence, output download, asset commit, reservation settlement, and terminal event emission boundaries.
- Reconciliation tests for providers with idempotency, providers with lookup-by-submission-key, and providers that return an unknown submission outcome.
- Adapter conformance suite run against every provider adapter.
- `StudioObjectStore` conformance tests cover streaming, signed URLs, readiness failure, self-host feature gating, and recovery from transient storage loss.
- SSRF, credential-redaction, asset validation, token lifecycle, Secret/Connector Agent-grant, pricing-authority separation, recovery-route, and authorization tests.

### 19.3 API and SDK

- Authenticated black-box HTTP tests for pricing catalog, provider configuration, estimate, create, list, read, cancel, retry, recovery, events, upload presign/finalize/expiry, and assets.
- Cross-project isolation tests replace project, job, upload, asset, provider, and event identifiers independently and assert no existence leak.
- SDK transport, facade, and React binding tests, including SSE timeout exemption, 15-second heartbeat, `Last-Event-ID` reconnect, and JSON cursor polling.
- Exact read-back assertions for persisted jobs, events, assets, usage, and billing settlement.

### 19.4 Web

- Real-browser assertions for input validation, provider/model selection, image upload, estimate display, idempotent submit, live progress, output selection, retry, cancellation, insufficient credits, permission denial, reload recovery, and responsive layout.
- Network assertions verify the outgoing SDK/API contract.
- Desktop and mobile viewport screenshots accompany DOM and request assertions.
- Mobile tests cover cursor polling, background suspension, resume from the last cursor, cursor expiry snapshot recovery, output preview, and signed download.

### 19.5 Live provider verification

Provider live tests are environment-gated and spend a bounded budget. Subproject 1 must run one real image request through the configured OpenAI-compatible provider, persist its output, settle usage, and render the result in the real web application.

### 19.6 Required verification commands

The implementation plan may narrow individual red/green loops, but the final subproject gate includes:

```text
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/db test
pnpm --filter @kortix/studio-runtime test
pnpm --filter @kortix/studio-worker test
pnpm --filter kortix-api test
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk build
pnpm --filter @kortix/sdk smoke:install
pnpm --filter Kortix-Computer-Frontend test
pnpm --filter ./apps/mobile test
bun run apps/api/scripts/dump-routes.ts
git diff --check
```

The regenerated route manifest is committed. Local authenticated HTTP, real-browser, mobile, Electron, and bounded live-provider checks supplement these package gates.

## 20. Subproject 1 acceptance criteria

Studio foundation and Image Studio are complete when:

1. An authorized project member can open Image Studio on web and Electron.
2. The member can upload references, enter a prompt, select an enabled model, request one to eight outputs, and see a cost estimate.
3. Upload URLs expire, finalization verifies MIME/size/checksum, abandoned uploads are removed, and cross-project upload identifiers do not leak.
4. Duplicate submissions with the same idempotency key and request hash create one job, one provider submission, and one settlement; a mismatched hash returns 409.
5. A Studio worker executes the job through the OpenAI-compatible adapter without holding the creation request open or relying on an API pod claim loop.
6. Fault injection after provider acceptance does not automatically submit a duplicate. The job either reconciles by submission key or enters the explicit unknown-outcome recovery path.
7. Progress survives API and worker restarts and reconnects through durable events.
8. Completed images are validated, copied into the private Studio bucket, recorded as assets, and displayed in the output grid.
9. The user can select, download, and reuse an output as a new input.
10. Cancellation, retryable failure, permanent failure, missing/expired credentials, unsupported model, expired estimate/upload, invalid assets, insufficient credits, permission denial, unknown outcome, storage failure, and cursor expiry have tested recovery behavior.
11. Usage is attributed to account, project, actor, provider, model, and job; reservation, partial upstream cost, settlement, release, and ledger idempotency are consistent.
12. Active Studio reservations prevent concurrent LLM, compute, or other Studio spend from consuming held balance, while accounts without reservations retain existing wallet behavior.
13. Cross-project job, event, provider, upload, asset, and download access fails without revealing resource existence.
14. An authorized Agent can create a job, wait with bounded polling, and obtain an asset reference through the existing Kortix MCP tool discovery path; revoked tokens/grants fail before provider submission.
15. Mobile can list jobs, inspect status, resume cursor polling after suspension, preview outputs, and download an asset without a host-local networking implementation.
16. Existing Kortix SDK, manifest, session, IAM, billing, marketplace, web, API, desktop, and mobile tests show no regression attributable to Studio.

## 21. Decisions

- Direct specialized product pages are preferred over a generic end-user module runner.
- Shared jobs, assets, permissions, billing, and provider adapters remain unified behind those pages.
- Professional 3D editing is a first-class desktop/web experience built on Three.js.
- Postgres is the authoritative first queue; row leases allow horizontal worker concurrency.
- A Studio-owned parameterized lease instance controls the `studio-maintenance` row in `worker_leader_lease`; it is independent from the API's hardcoded `background-workers` singleton, and normal submission/provider polling remain horizontally claimable by `apps/studio-worker` replicas.
- Studio media assets use the streaming `StudioObjectStore` abstraction and do not automatically enter git.
- OpenAI-compatible configuration is supported, but provider-specific media protocols use dedicated adapters.
- Alibaba Cloud digital human and batch remix use a dedicated adapter with signed callback handling.
- Existing Kortix Agent sessions remain the orchestration runtime.
- Developer modules use versioned manifests, scoped capabilities, sandboxing, review, signing, and an independent revenue ledger.
- The first implementation is foundation plus Image Studio only.

## 22. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Provider APIs have incompatible async semantics | Canonical adapter conformance tests and durable provider handles |
| Media jobs are long-running and expensive | Estimates, reservations, cancellation, bounded retries, and explicit status |
| Duplicate callbacks or client retries cause duplicate charges | Idempotency constraints, terminal-state guards, and settlement transaction keys |
| A worker crashes after provider acceptance | Precommitted submission key, provider idempotency/reconciliation, and no blind resubmission |
| Studio holds regress existing wallet behavior | Unchanged RPC signature, reservation-aware balance check, additive account-state fields, and full LLM/compute billing regression tests |
| Worker load interferes with API replicas | Separate `apps/studio-worker` process, independent scaling, row leases, and health/queue metrics |
| Large outputs overload API memory or bandwidth | Streaming server-side transfers, size limits, object storage, and signed URLs |
| Upstream Kortix changes conflict with Studio | Concentrated extension paths, thin mounts, additive contracts, and upstream-sync CI |
| Arbitrary developer modules threaten tenant data | Declarative UI by default, sandboxed custom UI, scoped tokens, scanning, and review |
| A professional 3D editor expands without bound | Separate 3D subproject with explicit mode/tool acceptance criteria |
| Mobile cannot reproduce desktop creative tools | Mobile focuses on creation parameters, monitoring, review, approvals, and assets |
