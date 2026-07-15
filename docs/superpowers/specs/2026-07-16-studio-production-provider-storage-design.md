# Studio Production Provider and Storage Design

## Problem

Task 8 introduced the Studio worker, durable job attempts, billing reservations, and a fake provider path. The next slice must let the worker run against production-style infrastructure without expanding the public Studio surface beyond Phase 1 image generation.

## Goals

- Add a production provider wiring path for OpenAI-compatible image generation.
- Add a production object storage wiring path for Studio output assets.
- Keep the worker provider-agnostic so later video, voice, 3D, avatar, and batch remix adapters can plug into the same registry.
- Preserve Task 8 safety properties: durable submission keys, no duplicate provider submissions on transient errors, tenant credential validation, reservation-capped settlement, and redacted diagnostics.

## Non-Goals

- Do not expose video, voice, 3D, digital human, batch remix, or Developer Center public capabilities in this slice.
- Do not call real provider APIs in automated tests.
- Do not introduce a new platform layer outside the existing Kortix workspace packages.
- Do not replace the Task 8 fake provider; it remains the deterministic development/test adapter.

## Recommended Approach

Use a small production wiring layer:

- `@kortix/studio-runtime` owns reusable provider and object-store adapters.
- `apps/studio-worker` owns environment parsing and runtime assembly.
- API-created provider config rows continue to decide which provider config a job uses.
- Secret/connector resolution remains server-side; the worker receives only resolved runtime settings and never logs credentials.

This keeps the integration compatible with future Kortix upgrades because the new code hangs off existing package boundaries instead of changing core job, billing, or API contracts.

## Components

### OpenAI-Compatible Image Provider

Create an adapter that implements the existing `StudioProviderAdapter` interface for `image.generate`.

The adapter should:

- Validate Phase 1 image requests only.
- Build OpenAI-compatible image generation requests from Studio inputs.
- Use the worker-committed `submissionKey` as the provider idempotency key when the upstream endpoint supports headers.
- Classify HTTP 429 and 5xx through existing retry helpers.
- Treat ambiguous network failures after request dispatch as `unknown_outcome`.
- Convert returned base64 or URL image outputs into `StudioProviderAsset` objects.
- Map upstream usage or configured pricing into `actual_credits`, capped later by SQL settlement.

### Object Storage Driver

Add a production object-store implementation behind the existing `StudioObjectStore` interface.

The first implementation should target S3-compatible storage because it covers AWS S3 and common S3-compatible providers. It should:

- Support `putObject`, `getObject`, signed download URLs, signed upload URLs, and readiness checks.
- Read configuration from worker environment variables.
- Avoid logging access keys, bucket secrets, or signed URLs.
- Keep the existing in-memory store for tests and fake local mode.

### Worker Runtime Assembly

Replace the Task 8 fake-only bootstrap guard with a runtime builder that can assemble:

- fake provider + in-memory object store for development;
- OpenAI-compatible image provider + S3-compatible object store for production-like deployments.

The worker should fail closed during startup when production mode is requested but required provider or storage settings are missing.

## Configuration

Initial environment shape:

- `STUDIO_PROVIDER_MODE=fake|openai-compatible`
- `STUDIO_OPENAI_BASE_URL`
- `STUDIO_OPENAI_API_KEY`
- `STUDIO_OPENAI_IMAGE_MODEL`
- `STUDIO_OBJECT_STORE_MODE=memory|s3`
- `STUDIO_OBJECT_STORE_BUCKET`
- `STUDIO_S3_ENDPOINT`
- `STUDIO_S3_REGION`
- `STUDIO_S3_ACCESS_KEY_ID`
- `STUDIO_S3_SECRET_ACCESS_KEY`
- `STUDIO_S3_FORCE_PATH_STYLE=true|false`

Names may be refined during implementation if the repo already has a stronger convention.

## Error Handling

- Missing configuration fails startup with a redacted error.
- Provider HTTP errors are converted into `StudioProviderCallError` classifications.
- Provider diagnostics go through `redactStudioDiagnostic` before persistence.
- Storage readiness failures surface as `STUDIO_STORAGE_UNAVAILABLE`.
- Unknown provider outcomes stay on the existing operator-recovery path.

## Testing

Use TDD with no real external providers:

- Unit-test environment parsing and startup mode selection.
- Unit-test OpenAI-compatible request construction and response parsing with mocked `fetch`.
- Unit-test retry, rate-limit, terminal, and unknown-outcome classification.
- Unit-test S3 object-store behavior with a fake S3 client or adapter-level client seam.
- Keep worker integration tests deterministic with fake provider and in-memory storage.

## Implementation Order

1. Runtime provider adapter contract seams for injectable HTTP clients.
2. OpenAI-compatible image provider unit tests and adapter.
3. S3-compatible object store unit tests and driver.
4. Worker runtime builder and environment parsing.
5. Focused verification and CI coverage.
