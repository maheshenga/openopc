# Studio Production Provider and Storage Design

**Status:** Approved; amended after implementation-readiness review

**Date:** 2026-07-16

**Branch:** `studio-platform`

**Parent architecture:** `docs/specs/2026-07-15-kortix-studio-platform-design.md`

**Amends:** Parent architecture sections 4.1, 4.2, 7.1, 11, 17, and 18, plus Tasks 3, 8, 9, 14, and 15 in `docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md`

## 1. Outcome

Task 9 turns the existing fake-only Studio worker into a production-capable Phase 1 image pipeline without exposing video, voice, 3D, digital-human, batch-remix, Developer Center, or workflow-DAG capabilities.

The delivery provides:

- an OpenAI-compatible `image.generate` adapter;
- private production object storage shared by the API and worker;
- project-scoped provider configuration and just-in-time credential resolution;
- provider-aware estimation and reservation-safe settlement;
- safe handling of synchronous and asynchronous provider results;
- deterministic crash recovery and explicit unknown-outcome operations;
- SSRF, response-size, MIME, secret-redaction, and signed-URL protections;
- deterministic tests, S3-compatible integration tests, and gated live smoke tests.

Task 9 remains disabled for production until the deployment and acceptance gates in Tasks 14 and 15 pass.

## 2. Design decision

Three approaches were considered.

### 2.1 API-local Supabase driver and provider adapter

This follows the original Phase 1 file map. It integrates well with managed Kortix deployments but leaves the independent worker coupled to API implementation modules and does not match the previously selected Alibaba Cloud asset direction without another driver.

### 2.2 Worker-only S3 driver with global provider environment variables

This is the smallest bootstrap change, but it is rejected. It leaves API upload and download routes on fake storage, bypasses project-level provider and Secret bindings, duplicates pricing decisions, and cannot safely recover synchronous provider responses.

### 2.3 Shared production adapters with project-scoped invocation resolution

This is the selected approach.

- `@kortix/studio-runtime` remains a vendor-neutral package containing contracts, typed errors, state rules, and conformance helpers.
- A new private `@kortix/studio-adapters` package contains the OpenAI-compatible adapter, S3-compatible object-store driver, safe outbound-fetch policy, provider descriptors, and configuration factories.
- `apps/api` owns project-scoped provider configuration, estimates, upload/finalize/download services, and capability readiness.
- `apps/studio-worker` owns job claiming, uncached authorization revalidation, just-in-time credential resolution, provider invocation, result staging, and settlement.

This adds extension-owned packages and thin dependency-injection points instead of changing Kortix projects, sessions, IAM, billing, SDK, or client ownership semantics.

## 3. Scope

### 3.1 In scope

- OpenAI-compatible prompt-to-image generation.
- Provider responses that complete synchronously with base64 or URL assets.
- Provider responses that expose a durable asynchronous handle, polling, and optional cancellation.
- S3-compatible private object storage used by both API and worker.
- Local MinIO conformance testing.
- A gated Alibaba Cloud OSS compatibility smoke test. S3 protocol compatibility is not assumed; if the smoke fails, a native OSS driver must implement the same `StudioObjectStore` port before Alibaba Cloud storage is enabled.
- Project Secret and default Connector credential bindings.
- Provider/model capability and pricing snapshots.
- Internal operator recovery for unknown submission outcomes.

### 3.2 Out of scope

- Video, voice, 3D, digital-human, or batch-remix adapters.
- Provider callbacks or the `/v1/webhooks/studio/:provider` route. The webhook surface is deferred until the first provider that requires signed callbacks.
- Public Developer Center modules, revenue sharing, or arbitrary code execution.
- A production UI for operator recovery; Task 9 provides an audited server-side service and command surface.
- Automatic bucket creation in production.
- Public buckets or permanent asset URLs.

## 4. Package and ownership boundaries

### 4.1 `@kortix/studio-runtime`

The runtime package owns only provider-neutral contracts and rules:

- `StudioProviderCallError` and retry classifications;
- `StudioProviderAdapter`, submission, handle, status, and result types;
- `StudioObjectStore` and object metadata types;
- the server-only `StudioCredentialResolver` port and opaque resolved-credential type;
- a side-effect-free server-only Secret-envelope subpath whose master secret is always supplied explicitly;
- provider and object-store conformance helpers;
- state, retry, idempotency, and lease rules;
- deterministic fake and in-memory test implementations.

It does not import AWS, OpenAI, API application modules, process environment, or database clients. The Secret-envelope subpath may use `node:crypto`, but it cannot load configuration or open connections at module scope.

### 4.2 `@kortix/studio-adapters`

The adapters package owns concrete, reusable infrastructure:

- OpenAI-compatible provider descriptors and adapter factory;
- S3-compatible object-store driver and client seam;
- bounded response readers and streaming asset helpers;
- outbound origin validation and SSRF-safe fetch;
- provider/model pricing validation;
- parsing of plain configuration records supplied by API or worker.

The package declares direct dependencies on every AWS SDK module it imports. Transitive dependencies from Daytona or another Kortix package are not used as an implicit contract.

### 4.3 `apps/api`

The API owns:

- project-scoped provider configuration management and IAM checks;
- provider/model validation and signed estimates;
- account-scoped immutable pricing-catalog management gated by `billing.write`;
- the configured object-store instance;
- upload presigning, upload finalization, signed downloads, and storage readiness;
- capability responses that advertise executable capabilities only when storage is ready;
- an audited recovery route at `POST /v1/projects/:projectId/studio/jobs/:jobId/recovery`.

The API never receives or returns resolved provider credentials through public Studio contracts.

### 4.4 `apps/studio-worker`

The worker owns:

- provider config loading under the claimed job lease;
- uncached token, Service Account, project action, and Agent grant revalidation;
- just-in-time Secret or Connector credential resolution through `StudioCredentialResolver`;
- invocation-scoped adapter construction;
- provider submission, polling, staging, asset persistence, and billing settlement;
- startup and graceful-shutdown behavior for the independent process.

Plaintext credentials exist only in the invocation object for the duration of the outbound call. They are never added to jobs, attempts, handles, events, diagnostics, metrics, or asset metadata.

`StudioCredentialResolver` is declared in `@kortix/studio-runtime`. Its concrete server-only factory lives at `apps/api/src/studio/credentials.ts`, accepts narrow encrypted-row lookup and decrypt dependencies, and remains free of API database/config imports. The worker supplies a lookup backed by its existing SQL client, so importing the facade does not initialize the API Drizzle singleton or a second connection pool. A side-effect-free `@kortix/studio-runtime/secret-envelope` subpath contains the byte-compatible Kortix Secret cryptography and receives the master secret explicitly; `apps/api/src/projects/secrets.ts` keeps thin compatibility wrappers while worker runtime injects the same decrypt implementation. Neither consumer copies the cryptography or imports the other application's assembly module.

## 5. Provider configuration and credential flow

`studio_provider_configs` is the single source of truth for provider selection. A production provider config contains:

- provider type;
- display name;
- validated base URL and optional region;
- credential binding;
- capability map;
- supported model allowlist;
- a registered adapter-owned dialect profile ID;
- references from allowed models to immutable pricing-catalog entry IDs;
- enabled state and update version.

Operational provider configuration and pricing authority are separate. `project.studio.providers.manage` may change display name, base URL, credential binding, enabled state, select a code-registered dialect profile, and choose the subset of active catalog models exposed to the project. It cannot create retry/idempotency/reconciliation claims or edit rates, maximum-cost rules, or markup. Immutable account-scoped pricing entries are created only through the billing service by an actor with `billing.write`; changing a price creates a new version rather than mutating a version referenced by an estimate or job.

Dialect profiles are immutable reviewed definitions shipped by `@kortix/studio-adapters`. They own request/response shape, sync/async behavior, cancellation support, and whether submit replay or submission-key reconciliation is actually proven. A profile with replay/reconciliation support must also bind that proof to an adapter-controlled provider identity or exact allowed origin; a project manager cannot attach such semantics to an arbitrary compatible endpoint. The Phase 1 `openai-images-v1-generic` profile is synchronous, has no reconciliation or upstream cancellation, sends no idempotency header, and never replays a submit after dispatch.

Worker environment variables enable adapter types and storage infrastructure; they do not override a job's provider base URL, API key, or model.

The production provider flow is:

1. The worker reloads the provider row by job, account, project, and lease owner.
2. It verifies the provider row is enabled and still supports the job capability and model.
3. It revalidates the acting token, Service Account, Studio actions, and Secret or Connector grant.
4. It resolves the credential binding through a server-only resolver. Missing, inactive, cross-project, undecryptable, or empty credentials fail before provider I/O.
5. It creates an invocation-scoped adapter with the resolved base URL, model, dialect, and opaque credential value.
6. It commits the attempt and stable submission key before outbound I/O.
7. It drops all references to the invocation object after the operation completes or fails. JavaScript string credentials cannot be guaranteed to be zeroized in memory, so the design relies on short lifetime, non-persistence, and strict logging boundaries rather than claiming memory erasure.

There is no fallback from a failed project credential binding to a platform-wide key. If a future managed platform credential is required, it must be introduced as an explicit credential mode with separate IAM, quota, metering, and audit rules.

The OpenAI-compatible production adapter accepts only `secret` or `connector` bindings. `kind: none` remains valid only for the fake provider and cannot consume a production adapter or platform credential.

## 6. Provider contract changes

### 6.1 Credential-free provider definition

The API estimates without resolving a provider credential. `@kortix/studio-runtime` therefore separates the definition used for validation and pricing from the invocation adapter used for external I/O:

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
  capabilities(config: StudioProviderDefinitionConfig): readonly StudioCapabilityDescriptor[];
  validate(config: StudioProviderDefinitionConfig, model: string, input: StudioJobInput): StudioValidationResult;
  estimate(config: StudioProviderDefinitionConfig, pricing: StudioPricingSnapshot, input: StudioJobInput): StudioCostEstimate;
}
```

`@kortix/studio-adapters` exports the reviewed OpenAI-compatible definition and an invocation-adapter factory. API and worker resolve the same definition ID; only the worker creates the credential-bound invocation adapter.

### 6.2 Typed errors

`StudioProviderCallError` moves into `@kortix/studio-runtime`. Adapters throw this shared type and the worker consumes the same runtime identity, so `instanceof` classification cannot fail across package boundaries.

### 6.3 Synchronous and asynchronous submission

`submit` returns a discriminated result:

```ts
type StudioProviderSubmission =
  | {
      kind: 'completed';
      provider: string;
      submission_key: string;
      result: StudioProviderResult;
    }
  | {
      kind: 'async';
      handle: StudioProviderHandle;
    };
```

The worker does not invent a polling handle for a synchronous response. An asynchronous handle contains only allowlisted durable identifiers and never includes credentials, raw URLs with sensitive query parameters, or provider payloads.

The public capability remains `async: true` because Kortix always executes it as a durable background job. Public `cancellable: true` means Kortix accepts a cancellation request; the adapter-owned dialect profile separately declares whether an already-dispatched upstream operation can be cancelled. When it cannot, Kortix stops further processing where safe, records unavoidable provider cost, and reports that upstream cancellation was not available.

### 6.4 Streaming asset result

Provider results expose bounded streams rather than requiring full `Uint8Array` assets:

```ts
interface StudioProviderAsset {
  kind: 'image';
  filename: string;
  mime_type: string;
  size_bytes: number;
  replayable_within_attempt: boolean;
  openBody(): Promise<ReadableStream<Uint8Array>>;
}
```

`openBody()` permits a bounded storage retry in the same worker attempt when the adapter can reopen a base64 buffer or refetch an unexpired validated output URL. It is not a durable function and is never serialized. The Phase 1 OpenAI-compatible adapter may parse a bounded JSON/base64 response, but it must expose decoded bytes through `openBody()` and enforce the limits in section 10. Later video and 3D adapters must not use base64 JSON for large outputs.

### 6.5 Reference assets

When a selected model advertises reference-image support, the provider invocation receives a project-scoped, read-only `StudioReferenceAssetResolver`. It resolves only finalized assets owned by the job project, enforces declared and detected MIME/size limits, and returns streams. Provider-specific code never queries Studio asset tables directly. The initial `openai-images-v1` definition advertises no reference-image support and rejects non-empty reference IDs; the fake provider continues to exercise the Phase 1 reference workflow until a reviewed compatible edit dialect is added.

## 7. Submission durability and retry semantics

The stable submission key is committed before any outbound request. A replay of the same logical upstream submission always uses the same key.

Adapter-owned dialect profile metadata declares:

- whether submission idempotency is supported;
- the exact idempotency header or request field;
- whether reconciliation by submission key is supported;
- whether the provider is synchronous or asynchronous;
- whether cancellation is supported.

Retry behavior depends on operation and dispatch certainty:

- Validation, DNS, TLS, or configuration failure proven to occur before request dispatch is terminal or safely retryable without a provider submission.
- A submit request that may have been dispatched and then times out, disconnects, or receives an ambiguous response becomes `unknown_outcome` unless an adapter-owned profile bound to the verified provider identity guarantees idempotent replay or reconciliation.
- A submit 429 or 5xx is not automatically replayed. Project configuration cannot opt into replay. Replay is allowed only when a reviewed, provider-bound profile's conformance tests cover that response.
- Provider submit POST requests do not follow redirects in the generic profile. Any 3xx received after dispatch becomes `unknown_outcome`; method, body, authorization, and prompt data are never forwarded to the redirect target.
- Poll, reconciliation, and result-fetch GET operations may retry 408, 425, 429, and 5xx with the existing bounded jitter and clamped `Retry-After` rules.
- A new attempt and new submission key are created only after the previous attempt is proven not to have been accepted.

### 7.1 Durable synchronous-result staging

For a completed submission, the worker writes validated assets and a deterministic staging manifest under the submission key before marking the submission durable. The manifest binds account, project, job, attempt, submission-key hash, provider-config ID/version, and pricing-catalog ID/version. It otherwise contains only object locations, hashes, sizes, MIME types, filenames, and provider usage fields accepted by the server-side pricing calculator.

On restart, the worker checks the staging manifest before invoking provider reconciliation. This closes the crash window after object staging. A crash after upstream success but before the first durable staging write remains an explicit unknown outcome and is never blindly resubmitted.

Before provider submission, the worker requires a fresh storage readiness result. If staging fails, it retries only while the same attempt still owns a replayable asset source. A consumed non-replayable source, an expired provider URL, or a process exit before the manifest becomes durable transitions the attempt to `unknown_outcome`; the design does not claim durable storage retry for a one-shot synchronous response.

Final asset object keys and staging keys include account, project, job, attempt, and submission-key hash prefixes. Database finalization and billing settlement remain idempotent. Orphan staging objects are removed only after the corresponding attempt is terminal and retention rules allow deletion.

Recovery never trusts a caller-supplied key/checksum alone. The service derives the exact expected prefix from locked database rows, verifies every manifest identity field, requires every asset key to stay under that prefix, and re-heads objects to compare size, checksum, MIME metadata, and encryption before passing normalized assets to SQL.

## 8. Unknown-outcome operations

Task 9 adds an audited handler at `POST /v1/projects/:projectId/studio/jobs/:jobId/recovery` with three idempotent decisions:

- `confirm_succeeded`: attach a validated staging manifest or imported provider result, create assets, and settle the reservation;
- `confirm_not_created`: mark the attempt failed and release the unused reservation;
- `keep_unknown`: extend the reservation, retain evidence, and emit an operational alert.

`keep_unknown` is server-timed: one decision extends at most seven days, the default extension is 24 hours, and no active reservation may be held beyond 30 days from creation. At the cap, maintenance atomically settles any verified earlier-attempt cost (or releases a zero-cost hold), marks the job unresolved-expired, and opens a `studio_billing_incidents` row for the remaining potential provider liability. The user's balance is no longer held or charged later automatically. Task 14's billing-incident operation resolves later evidence as platform liability before production enablement; repeated recovery calls cannot hold credits forever.

The route uses normal authenticated API context and never accepts an actor ID from request data. Every decision requires both `billing.write` at account scope and `project.studio.jobs.cancel` for the owning project. It records actor, reason, evidence reference, previous state, and resulting state. Existing finalizers emit the existing asset/billing/terminal events; a non-terminal `keep_unknown` emits existing `progress` with an operator-review phase. No recovery-specific public event type is added. The route is omitted from the public SDK and has no Phase 1 UI. Direct manual SQL is not the supported recovery path.

Idempotency and audit evidence are stored in `studio_job_recoveries`, keyed uniquely by job and caller-supplied idempotency key. The row stores decision, actor, reason, evidence reference, prior state, resulting state, and creation time; it never stores a raw provider URL or credential.

## 9. Object-store contract

The object store is bound to a configured private bucket and namespace. Callers supply tenant-scoped keys but cannot switch buckets.

The production port provides:

- readiness check;
- streaming put and get;
- object head/stat;
- conditional delete using the expected object ETag or checksum when one is supplied;
- signed upload bound to key, content type, size, and checksum;
- short-lived signed download with safe `Content-Disposition`;
- metadata and checksum round trips.

The S3-compatible driver enforces:

- HTTPS endpoints outside explicit local-test mode;
- private bucket policy and no public ACL use;
- server-side encryption using AES-256 or a configured KMS key;
- fixed key prefix;
- optional expected bucket owner where the protocol supports it;
- bounded signed-URL TTLs;
- default workload credential chain for AWS environments, or an explicit static access-key/session-token configuration for compatible providers;
- separate internal service and public signing endpoints when deployment networking requires them;
- redaction of `X-Amz-Credential`, `X-Amz-Signature`, security tokens, and all signed query strings.

Readiness uses a reserved `_studio-readiness/{role}/{uuid}` key. Each API or worker process performs a one-byte put, head, get-and-verify, and delete sequence with the configured encryption and checksum settings, then caches success for 60 seconds. A bucket lifecycle rule removes abandoned readiness keys after 24 hours. This produces ordinary low-volume storage requests, does not create a bucket, and never calls a paid AI provider. Presigned-browser behavior is proven by integration tests and the upload flow rather than inferred from the readiness probe.

## 10. Network and media safety

### 10.1 Provider base URL

- Require HTTPS outside explicit local-test mode.
- Reject URL userinfo, query strings, fragments, non-HTTP schemes, malformed ports, and ambiguous host encodings.
- Resolve and validate every A and AAAA result.
- Reject loopback, unspecified, private, carrier-grade NAT, link-local, multicast, documentation, and cloud-metadata destinations.
- Allow a private enterprise provider only through an exact-origin administrator allowlist. Wildcards are not accepted.
- Bind credentials to the validated provider origin. Redirects never carry provider authorization to another origin.

### 10.2 Provider output URL

- Apply the same address validation independently from the provider base URL policy.
- Follow at most three redirects and revalidate every hop and resolved address.
- Redirect following is available only for credential-free provider output GETs, never for the provider submit POST.
- Never forward provider Authorization, cookies, or signed provider headers.
- Use a 10-second connect timeout and a 120-second total download timeout.
- Reject compressed or chunked bodies that exceed the decoded byte limit while streaming.

### 10.3 Phase 1 image limits

- Maximum provider JSON response: 128 MiB.
- Maximum decoded single image: 32 MiB.
- Maximum decoded assets per job: 128 MiB.
- Maximum output count: eight.
- Allowed output MIME types: `image/png`, `image/jpeg`, and `image/webp`.
- Reject SVG, HTML, XML, archives, and MIME/magic mismatches.
- Validate image dimensions before finalization; maximum width or height is 16,384 pixels and maximum decoded pixel count is 100 megapixels.

The `advanced` input object is mapped through a provider/model allowlist. It is never spread directly into the upstream request.

## 11. API storage flow

### 11.1 Upload creation

The API creates a pending upload row with an account/project-prefixed object key. The storage driver creates a 15-minute signed upload URL bound to expected content type, exact size, and checksum. The response never includes storage credentials.

### 11.2 Upload finalization

Finalization performs object head and bounded content validation before creating an asset row. It verifies:

- account and project ownership;
- pending status and 30-minute upload expiry;
- expected and actual size;
- expected and actual SHA-256 checksum;
- declared, stored, detected, and allowed MIME types;
- Phase 1 image dimensions and content limits.

The asset row and upload status transition are committed idempotently. Missing, mismatched, expired, or unsafe objects do not create assets.

### 11.3 Downloads

After project IAM and asset ownership checks, the API creates a download URL valid for at most 15 minutes. URLs are generated per request, never persisted, never included in durable diagnostics, and returned with a safe attachment filename.

### 11.4 Capability readiness

When Studio is disabled, the API does not require storage configuration. When Studio is enabled but storage is missing or unhealthy:

- `/capabilities` does not advertise executable `image.generate`;
- upload and new-job requests return `STUDIO_STORAGE_UNAVAILABLE` with HTTP 503;
- no new reservation is created;
- already durable jobs remain queued for bounded recovery;
- API liveness remains healthy while Studio readiness reports the dependency failure.

The project capability response also requires at least one enabled provider config whose provider type is registered, whose capability/model map passes the shared schema, and whose credential binding exists. Missing credential setup is reported as configuration-required state; it does not cause a provider call during readiness.

## 12. Estimation, model validation, and settlement

The API and worker use the same provider descriptor and pricing parser from `@kortix/studio-adapters`.

The provider config capability map contains an allowlisted model entry with:

- provider model identifier;
- supported request fields and limits;
- quality, size, and output-count mapping;
- immutable pricing-catalog entry ID;
- registered dialect profile ID. Idempotency, polling, cancellation, and output semantics come only from that adapter-owned profile.

An immutable `studio_pricing_catalog` entry contains account, provider type, model, pricing unit, rate data, maximum provider-cost rule, platform markup rule, integer version, active state, creator, and creation time. An update inserts a new version and may deactivate the old entry for new estimates; existing estimates and jobs retain the referenced version.

The signed estimate binds account, project, actor, provider config ID and version, model, pricing version, canonical input hash, maximum credits, and expiry. Job creation persists the pricing snapshot needed to calculate attempt and final cost.

Job creation rejects an estimate when the provider config or pricing version changed after estimation. Before first provider I/O, the worker compares the persisted snapshot with the live provider config and rejects a stale or newly unsupported model without submitting upstream. Credential value rotation does not invalidate the estimate because it does not change provider capability or pricing; the worker always resolves the latest authorized credential value.

The worker calculates credits from allowlisted provider usage fields and the persisted pricing snapshot. It never trusts an upstream `actual_credits` value directly. Each evidenced attempt cost is written idempotently before retry, failure, cancellation, or success finalization. A successful job charges the sum of verified provider costs across all attempts plus the successful-output markup; a failed or cancelled job charges only verified provider cost. Unknown attempts without evidence remain reserved until recovery. SQL finalizers aggregate the immutable attempt-cost rows, cap the user's charge to the active reservation, record final user charge and excess platform loss, and emit a critical estimate-violation alert. Attempt usage rows are the only additive upstream-cost series; the final row keeps the verified aggregate only as non-additive metadata so accounting queries cannot double count it.

## 13. Configuration and compatibility

Provider adapter registration uses:

- `STUDIO_ENABLED=true|false`;
- `STUDIO_FAKE_PROVIDER_ENABLED=true|false` for the existing deterministic development path;
- `STUDIO_OPENAI_COMPATIBLE_ENABLED=true|false` to enable the adapter type.

It does not use global OpenAI base URL, API key, or model variables.

Shared storage configuration uses:

- `STUDIO_OBJECT_STORE_MODE=memory|s3`;
- `STUDIO_ALLOW_EPHEMERAL_STORAGE=true|false`;
- `STUDIO_OBJECT_STORE_BUCKET`;
- `STUDIO_OBJECT_STORE_PREFIX`;
- `STUDIO_S3_ENDPOINT`;
- `STUDIO_S3_PUBLIC_ENDPOINT` when different;
- `STUDIO_S3_REGION`;
- `STUDIO_S3_FORCE_PATH_STYLE=true|false`;
- `STUDIO_S3_EXPECTED_BUCKET_OWNER` where supported;
- `STUDIO_S3_CREDENTIAL_MODE=default-chain|static`;
- `STUDIO_S3_ACCESS_KEY_ID`, `STUDIO_S3_SECRET_ACCESS_KEY`, and optional `STUDIO_S3_SESSION_TOKEN` for static mode;
- `STUDIO_S3_SSE=AES256|aws:kms` and `STUDIO_S3_KMS_KEY_ID` when KMS is selected.
- `STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST` as a comma-separated exact-origin allowlist;
- `STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS=true|false`, accepted only in tests or when ephemeral storage is explicitly enabled.

Valid assembly rules are:

- `STUDIO_ENABLED=false`: no provider or storage settings required;
- fake provider plus memory store: permitted only when ephemeral storage is explicitly allowed;
- fake provider plus S3: permitted for integration and deployment verification;
- OpenAI-compatible provider plus S3: production candidate;
- OpenAI-compatible provider plus memory: rejected outside tests.

Conflicting settings fail startup with secret-safe field names only. Existing `STUDIO_FAKE_PROVIDER_ENABLED=true` remains supported. No old production handle exists before this task, so no provider-handle migration is required; any new staging or pricing columns must nevertheless support mixed-version database rollout and rollback.

## 14. Error handling

- Configuration validation fails before database claims or provider I/O.
- Credential failures return Studio credential/configuration errors without revealing identifiers beyond the caller's authorized provider config.
- Provider/pricing version mismatch maps to `STUDIO_PROVIDER_CONFIG_STALE` or `STUDIO_PRICING_STALE`; recovery idempotency/state mismatch maps to `STUDIO_RECOVERY_CONFLICT`.
- Provider HTTP bodies are allowlisted and bounded before diagnostic extraction.
- Provider submit ambiguity maps to `STUDIO_SUBMISSION_OUTCOME_UNKNOWN`.
- Confirmed absence maps to `STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED`; a 30-day unresolved hold maps to `STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED` and later recovery requires the audited billing-incident path.
- Storage permission, availability, timeout, and integrity failures map to `STUDIO_STORAGE_UNAVAILABLE` or `STUDIO_ASSET_INVALID` as appropriate.
- Storage failures during result persistence retry only through `openBody()` while the source remains replayable in the owned attempt. Otherwise they become `unknown_outcome`; they never resubmit the provider request.
- All persisted diagnostics pass shared redaction that covers bearer/basic authorization, API keys, passwords, tokens, signed URLs, `X-Amz-*` signatures, and sensitive query parameters.

## 15. Testing and acceptance

### 15.1 Unit and conformance tests

- Provider request mapping for prompt, aspect ratio, quality, output count, and allowlisted advanced fields.
- Base64 and URL response parsing.
- Synchronous completed and asynchronous handle submissions.
- Unsupported capability, model, field, and dialect rejection.
- Shared typed-error classification.
- Object-store put/get/head/delete, signed upload/download, metadata, checksum, readiness, timeout, abort, and transient failure behavior.
- Environment parsing and legal/illegal assembly combinations.
- Secret and signed-URL redaction.

### 15.2 Security tests

All tests use local resolvers and HTTP servers, not public network targets. They cover loopback, RFC1918, carrier-grade NAT, link-local, metadata addresses, IPv4-mapped IPv6, multiple DNS answers, DNS rebinding, cross-origin redirects, userinfo, HTTP downgrade, redirect limits, timeouts, MIME/magic mismatch, oversized JSON/base64/chunked responses, and authorization non-forwarding.

### 15.3 Crash and idempotency matrix

Tests inject failure at:

- before request dispatch;
- after dispatch with lost response;
- after response but before staging;
- after asset staging but before manifest write;
- after manifest write but before attempt update;
- after object persistence but before database finalization;
- after finalization but before acknowledgement.

For every recoverable case, assertions prove one provider submission, one logical asset set, one billing settlement, and deterministic object keys. Irrecoverably ambiguous cases remain unknown and are never automatically resubmitted.

### 15.4 Integration tests

A CI service runs the shared object-store conformance suite against MinIO. It verifies multi-chunk streaming, signed upload and download, metadata, checksum, private access, readiness permissions, connection failure, cleanup, and API/worker use of the same bucket and namespace.

The API integration flow proves real presign, upload, finalize validation, download signing, storage-unavailable behavior, provider/model estimate validation, and cross-project isolation. The worker integration flow proves mocked OpenAI-compatible submission through S3 staging to asset and settlement rows.

### 15.5 Gated live smoke

Default pull-request CI performs no paid or public provider calls.

A protected manual/release workflow may run when `STUDIO_LIVE_PROVIDER_TESTS=true`. It uses one low-cost image, output count one, concurrency one, `STUDIO_LIVE_PROVIDER_MAX_CREDITS` with a default of one and an accepted maximum of five, a 180-second timeout capped at 300 seconds, and a dedicated low-privilege project credential. It proves one job, one provider submission, private object persistence, one asset, one settlement, signed download, and secret-free logs.

Alibaba Cloud OSS must pass a separate low-volume storage compatibility smoke before the S3-compatible driver is approved for that endpoint. Failure routes implementation to a native OSS driver behind the same port rather than weakening conformance requirements.

## 16. Deployment, rollout, and rollback

Task 9 merges with production Studio disabled.

The enablement order is:

1. deploy database changes that are backward compatible with the fake worker;
2. configure the private bucket, encryption, lifecycle policy, and low-privilege credentials;
3. deploy API and one worker with production adapters disabled;
4. pass storage readiness and MinIO/target compatibility checks;
5. enable the adapter for one canary project/provider config;
6. pass the gated live smoke and observe queue, storage, unknown-outcome, and reservation metrics;
7. expand worker replicas and provider availability only after Tasks 14 and 15 pass.

SIGTERM stops new claims, allows the active bounded operation to finish or safely returns the lease, releases maintenance ownership, and exits without creating a second provider submission.

Rollback first disables new Studio submissions, drains or fences workers, reconciles unknown outcomes, and preserves a worker version that understands every durable production handle and staging manifest. Database migrations must be expand-first and remain readable by the previous fake-only release until rollout is complete.

## 17. Observability and operations

Task 9 exposes structured, secret-safe metrics for:

- queue age and claim latency;
- provider submission, polling, and completion latency;
- 429, 5xx, retry, and unknown-outcome counts;
- output bytes and validation failures;
- storage readiness, latency, retries, integrity failures, and orphan staging objects;
- estimate error, provider cost, user charge, and platform-covered excess;
- reservation age and leak candidates.

Liveness does not depend on an external AI provider. Readiness checks database and storage dependencies but never initiates paid generation.

The operations runbook covers credential rotation, bucket policy, encryption, lifecycle cleanup, provider-origin allowlisting, unknown-outcome decisions, reservation reconciliation, canary enablement, and rollback.

## 18. Upstream compatibility

The implementation remains concentrated in extension-owned paths:

```text
packages/studio-runtime/
packages/studio-adapters/
packages/api-contract/src/studio/
packages/db/src/schema/kortix.ts                 # additive Studio changes
packages/db/migrations/                          # additive Studio migrations
apps/api/src/studio/
apps/studio-worker/
```

Thin existing touchpoints are limited to workspace registration, API dependency assembly, configuration schema, CI path filters, deployment manifests, and additive database migrations. Public SDK and Studio API contracts remain additive. Provider-specific payloads, credentials, S3 client objects, and storage endpoints do not escape their adapter or server-side service boundaries.

The parent architecture and existing Phase 1 implementation plan must be updated with this document before implementation begins. Task 3's initial ports are deliberately evolved in Task 9; Tasks 8, 14, and 15 consume the amended contracts and gates. The stale Supabase-only, API-local adapter, and mandatory Phase 1 webhook instructions are not executed in parallel.

## 19. Acceptance checklist

- [ ] Project provider config, not process-global provider values, controls base URL, model, capability, pricing, and credential binding.
- [ ] API and worker use the same production object-store implementation and namespace.
- [ ] API upload, finalize, download, and capability readiness no longer use placeholder URLs or trusted client metadata.
- [ ] Synchronous provider results survive every recoverable crash window through deterministic staging.
- [ ] Ambiguous submit outcomes are never blindly retried.
- [ ] Provider and output URLs pass SSRF, redirect, timeout, byte, MIME, and content validation.
- [ ] API estimates and worker settlement share one versioned pricing source.
- [ ] Reference assets are project-scoped and streamed through an explicit resolver.
- [ ] Runtime contracts remain vendor neutral and shared typed errors classify correctly.
- [ ] Object storage supports head/stat, delete, constrained presign, encryption, and signed-URL redaction.
- [ ] MinIO conformance and API/worker integration tests pass in CI.
- [ ] Gated provider and Alibaba Cloud OSS smoke tests pass before production enablement.
- [ ] Unknown outcomes have an audited operator recovery path.
- [ ] Task 14 deployment and Task 15 acceptance gates pass before Studio production enablement.
