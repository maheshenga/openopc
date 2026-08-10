# OpenOPC Image and Module Production Validation

This runbook records the production-only gates for the OpenOPC module service and
Studio image path. It is an execution checklist, not evidence that a production
provider has already been called. Run it only against a dedicated project with a
bounded credit budget and credentials provisioned through the approved secret or
connector binding.

## Current Boundary

The repository has deterministic coverage for the API contract, module grant
revalidation, PostgreSQL query shape, the leased worker, provider-neutral image
asset validation, and the local HTTPS module QA host. The following production
claims remain unverified until this runbook is completed in the target environment:

- provider credential and provider-config handshake;
- asynchronous worker submission, output asset persistence, manifest checksum,
  signed download, and billing settlement;
- OpenOPC text generation and streaming through an Agent;
- OpenOPC vision input and reverse-prompt workflow through an Agent;
- GIF creation and delivery through the production chain.

Do not mark a gate passed from a fake provider, an in-memory repository, or a
module-side test run alone.

## Preconditions

1. Use a dedicated production or production-like account and project. Set a
   single-worker concurrency limit and record the project lifecycle owner.
2. Configure the provider with either an approved secret binding or connector
   binding. Never place a raw key in a request body, fixture, terminal command,
   log, or evidence file.
3. Confirm the deployed API and worker carry the same release profile and schema
   migration. The deployment identity must match the signed profile before any
   capability is enabled.
4. Set the smoke guard variables required by the existing script:
   `STUDIO_LIVE_PROVIDER_TESTS=true`,
   `STUDIO_LIVE_PROVIDER_CONCURRENCY=1`,
   `STUDIO_LIVE_PROVIDER_CLEANUP_CONFIRMATION=DEDICATED_PROJECT_LIFECYCLE_CONFIRMED`,
   `STUDIO_LIVE_PROVIDER_API_URL`, `STUDIO_LIVE_PROVIDER_API_TOKEN`,
   `STUDIO_LIVE_PROVIDER_PROJECT_ID`, `STUDIO_LIVE_PROVIDER_PROVIDER_CONFIG_ID`,
   `STUDIO_LIVE_PROVIDER_DATABASE_URL`, `STUDIO_LIVE_PROVIDER_MODEL`,
   `STUDIO_LIVE_PROVIDER_PROMPT`, `STUDIO_LIVE_PROVIDER_MAX_CREDITS`, and
   `STUDIO_LIVE_PROVIDER_TIMEOUT_SECONDS`.

## Gates

### 1. Provider and credential handshake

- Read the public provider configuration and confirm tenant/project ownership,
  enabled state, capability `image.generate`, immutable version token, and
  production pricing snapshot.
- Submit one bounded estimate. Confirm the response contains only the public
  credential binding descriptor and strict ISO 8601 timestamps; it must not
  contain ciphertext or provider secrets.
- Rotate or revoke the test binding in the approved secret/connector system and
  confirm a new estimate fails closed before restoring the binding.

### 2. Async image worker and output assets

Run the existing bounded smoke from the repository root:

```powershell
bun apps/studio-worker/scripts/live-provider-smoke.ts
```

The script must report one succeeded job, one provider-submitted event, one
asset-created event, a persisted staging manifest and checksum, a non-empty
signed download, and settled actual credits within the configured limit. Inspect
the retained evidence through the dedicated project lifecycle; do not delete or
reuse another tenant's rows.

For object storage backed by Alibaba OSS, run the separately guarded smoke after
the provider gate:

```powershell
bun apps/studio-worker/scripts/aliyun-oss-smoke.ts
```

The dedicated prefix must be empty after cleanup. Record the provider, worker,
database migration, object-store, and API build identifiers with the result.

### 3. OpenOPC text and vision agent flows

Using the signed module release and the local HTTPS QA host as the test fixture,
exercise each declared operation through the real Agent bridge:

- `text.generate`: one bounded prompt and one refusal/error case;
- `text.stream`: verify ordered terminal events and cancellation;
- vision input: one image reference and one invalid/oversized reference;
- reverse prompt: verify the returned prompt is attached to the correct Agent
  and does not disclose provider credentials or signed object-store URLs.

For each case capture request id, grant id, install revision, release id,
operation, public status, and audit outcome. Do not capture capability tokens or
raw provider responses containing secrets. A module-only browser pass is not a
production Agent/worker pass.

### 4. GIF path

Run the GIF scenario only when a signed release profile explicitly exposes the
GIF capability and the production adapter is enabled. Verify asynchronous job
state, frame/output count, MIME type, size bound, checksum, manifest, signed
download, cancellation, and billing settlement using the same dedicated project
rules. Until those prerequisites exist, record the gate as `blocked`, not
`passed`.

## Evidence Record

Store a redacted record containing:

- environment and deployment/profile identity;
- project and provider configuration identifiers (not credential values);
- migration version and worker/API build identifiers;
- operation-level request ids, grant ids, consent/install revision, and outcomes;
- job, attempt, event, asset, and manifest identifiers;
- cleanup confirmation and any failed gate with its public error code.

The current implementation work did not execute these production calls. Until a
dedicated environment supplies the prerequisites above, P2 remains open.
