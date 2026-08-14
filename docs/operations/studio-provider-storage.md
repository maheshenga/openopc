# Studio Provider and Storage Operations

Studio production provider and storage capabilities remain disabled until the protected validation gates, Task 14 deployment validation, and Task 15 acceptance gate have recorded evidence. This runbook does not authorize setting `STUDIO_ENABLED=true` in a production deployment.

## Configuration and ownership

The API and worker receive the same storage identity through deployment Secret/Connector references. Required adapter fields are `STUDIO_OBJECT_STORE_MODE=s3`, `STUDIO_OBJECT_STORE_BUCKET`, `STUDIO_OBJECT_STORE_PREFIX`, `STUDIO_S3_ENDPOINT`, `STUDIO_S3_REGION`, `STUDIO_S3_FORCE_PATH_STYLE`, `STUDIO_S3_CREDENTIAL_MODE`, `STUDIO_S3_SSE`, and, for static credentials, `STUDIO_S3_ACCESS_KEY_ID` and `STUDIO_S3_SECRET_ACCESS_KEY`. `STUDIO_S3_PUBLIC_ENDPOINT` is only for signed browser URLs. Set `STUDIO_S3_EXPECTED_BUCKET_OWNER` only where the target supports that header. For KMS encryption, set `STUDIO_S3_SSE=aws:kms` and `STUDIO_S3_KMS_KEY_ID`; AES256 must not carry a KMS key.

`STUDIO_ENABLED` is unset or `false` until the production-enablement gates below pass. An enabled worker also requires the existing `DATABASE_URL` and `API_KEY_SECRET`; `STUDIO_WORKER_ID` is optional, and `STUDIO_WORKER_IDLE_MS`, `STUDIO_WORKER_LEASE_MS`, `STUDIO_WORKER_POLL_MS`, and `STUDIO_WORKER_MAINTENANCE_MS` use the bounded defaults enforced by the runtime parser. Provider registration uses `STUDIO_FAKE_PROVIDER_ENABLED`, `STUDIO_OPENAI_COMPATIBLE_ENABLED`, and the comma-separated `STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST`. No environment variable supplies a provider base URL, API key, or model: those values remain project-scoped immutable configuration and Secret/Connector bindings.

`STUDIO_S3_CREDENTIAL_MODE=default-chain` forbids `STUDIO_S3_ACCESS_KEY_ID`, `STUDIO_S3_SECRET_ACCESS_KEY`, and `STUDIO_S3_SESSION_TOKEN`; static mode requires the first two and permits a temporary session token. `STUDIO_ALLOW_EPHEMERAL_STORAGE` and `STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS` are local/test-only escape hatches and must remain unset or `false` in production. Production must not combine `STUDIO_OBJECT_STORE_MODE=memory` with the OpenAI-compatible provider.

Use a private bucket. Block anonymous read/list/write, block public ACLs, permit only the API/worker identities and dedicated smoke identity, and require TLS. Apply server-side encryption and a lifecycle rule that removes only the documented smoke prefix after evidence retention; never configure a broad lifecycle rule over active Studio prefixes. API/worker credentials are separate least-privilege principals, stored as Secret or Connector references rather than deployment literals. Rotate a Secret/Connector by adding the new value, validating the readiness probe, moving the consuming identity, then revoking the old value. Do not put access keys, provider API keys, database URLs, signed URLs, or raw provider response bodies into tickets, logs, command output, or this document.

Provider configuration is project-scoped and its pricing is immutable-versioned. The platform operator owns the catalog entry, maximum credits, and provider origin allowlist; a project administrator owns the credential binding and enabled configuration. A provider change is a new validated configuration/pricing version, never an in-place price edit for active jobs.

## Readiness and monitoring

The storage readiness probe writes, heads, reads, verifies, and deletes a one-byte object under `_studio-readiness/{api|worker}/`. It is cached for 60 seconds after success and deliberately performs no network extension after a failure. Treat it as a low-cost dependency probe, not a customer asset check.

Alert on consecutive readiness failures, failed cleanup under `studio-smoke/`, worker lease failures, provider unknown outcomes, settlement mismatch, signed URL failures, and increasing orphan/staging object counts. Capture only correlation IDs, job IDs, account/project IDs, numeric status, and sanitized error code. Redacted unknown-recovery examples are `STUDIO_STORAGE_UNAVAILABLE`, `STUDIO_SUBMISSION_OUTCOME_UNKNOWN`, and `STUDIO_INTERNAL_ERROR`; never attach a provider body, credential, endpoint query, or signed download URL.

## Protected smoke sequence

Run the local/CI MinIO conformance first. GitHub CI starts the pinned MinIO target, waits for `/minio/health/live`, runs `s3-object-store.integration.test.ts`, and always removes the container. Locally, `scripts/ci-local.sh` reports the MinIO gate as skipped when Docker is unavailable; that is not CI approval.

Run the live provider smoke only from the protected operations environment:

```bash
STUDIO_LIVE_PROVIDER_TESTS=true \
STUDIO_LIVE_PROVIDER_CONCURRENCY=1 \
STUDIO_LIVE_PROVIDER_MAX_CREDITS=1 \
STUDIO_LIVE_PROVIDER_TIMEOUT_SECONDS=300 \
STUDIO_LIVE_PROVIDER_CLEANUP_CONFIRMATION=DEDICATED_PROJECT_LIFECYCLE_CONFIRMED \
pnpm --filter @kortix/studio-worker exec bun scripts/live-provider-smoke.ts
```

It requires a dedicated project/provider configuration, a dedicated read-only smoke database identity, one output, one submission, and one active process. It asserts one job, provider submission, persisted staging manifest, asset, billing settlement, signed download, and redaction scan. Durable billing evidence is intentionally retained: the explicit confirmation acknowledges that the dedicated project lifecycle, rather than the script, owns its cleanup.

Run the cloud storage compatibility smoke only with an exact dedicated `studio-smoke/...` prefix and exactly one armed target gate. The shared script `apps/studio-worker/scripts/s3-cloud-smoke.ts` owns a validated provider profile matrix (see `apps/studio-worker/src/smoke/s3-cloud-smoke.ts`):

| Target | Gate env | Path-style | SSE allowed | Owner check |
| --- | --- | --- | --- | --- |
| Alibaba Cloud OSS | `STUDIO_ALIYUN_OSS_SMOKE=true` | required true | `AES256` / `aws:kms` | optional |
| Tencent COS | `STUDIO_TENCENT_COS_SMOKE=true` | either | `none` (SSE-COS is operator-verified per bucket) | forbidden |
| Cloudflare R2 | `STUDIO_CLOUDFLARE_R2_SMOKE=true` | required false (virtual-host only) | `none` (encrypted at rest) | forbidden |

```bash
# Alibaba Cloud OSS
STUDIO_ALIYUN_OSS_SMOKE=true \
STUDIO_OBJECT_STORE_MODE=s3 \
STUDIO_OBJECT_STORE_PREFIX=studio \
STUDIO_S3_SMOKE_PREFIX=studio/studio-smoke/change-123 \
STUDIO_S3_SMOKE_CLEANUP_CONFIRMATION=EXACT_PREFIX_ONLY \
STUDIO_S3_FORCE_PATH_STYLE=true \
STUDIO_S3_SSE=AES256 \
pnpm --filter @kortix/studio-worker exec bun scripts/s3-cloud-smoke.ts

# Tencent COS
STUDIO_TENCENT_COS_SMOKE=true \
STUDIO_OBJECT_STORE_MODE=s3 \
STUDIO_OBJECT_STORE_PREFIX=studio \
STUDIO_S3_SMOKE_PREFIX=studio/studio-smoke/change-123 \
STUDIO_S3_SMOKE_CLEANUP_CONFIRMATION=EXACT_PREFIX_ONLY \
STUDIO_S3_FORCE_PATH_STYLE=true \
STUDIO_S3_SSE=none \
pnpm --filter @kortix/studio-worker exec bun scripts/s3-cloud-smoke.ts

# Cloudflare R2
STUDIO_CLOUDFLARE_R2_SMOKE=true \
STUDIO_OBJECT_STORE_MODE=s3 \
STUDIO_OBJECT_STORE_PREFIX=studio \
STUDIO_S3_SMOKE_PREFIX=studio/studio-smoke/change-123 \
STUDIO_S3_SMOKE_CLEANUP_CONFIRMATION=EXACT_PREFIX_ONLY \
STUDIO_S3_FORCE_PATH_STYLE=false \
STUDIO_S3_SSE=none \
pnpm --filter @kortix/studio-worker exec bun scripts/s3-cloud-smoke.ts
```

The environment must also provide the configured S3 endpoint, bucket, region, and credentials, plus `STUDIO_S3_KMS_KEY_ID` for `aws:kms` and the optional owner-check settings on the OSS profile. The smoke verifies direct and signed transfers, checksum, metadata, HTTPS, the configured path-style behavior, anonymous GET denial, and — where the profile allows SSE — `HeadObject`-reported SSE/KMS state. It deletes only its exact prefix and confirms the prefix is empty. A failure blocks S3-driver approval for that endpoint; do not weaken conformance or replace it with a mock.

## Canary, retention, and rollback

Canary in this order: validate Secret/Connector references, run API and worker readiness, run MinIO conformance, run the provider smoke in the dedicated project, run the OSS smoke for the target endpoint, then allow a deliberately capped internal canary. Monitor job/asset/settlement events before each expansion. The hold policy for an unknown provider outcome is operational state, not general retention: issue a warning at 24 hours, escalate to critical at 7 days, and at 30 days `atomic_expire_studio_unknown_hold` automatically ends the hold and opens an incident. Task 14 owns audited incident resolution after that automatic transition. Send billing discrepancies to the billing-incident owner with redacted job and settlement identifiers; do not attempt manual credit mutation from the worker.

For an incident, disable the affected provider configuration first, stop the worker from claiming new jobs if storage is unavailable, preserve existing attempts and manifests, rotate compromised Secrets/Connectors, and roll back to the prior validated configuration. Delete an orphan only after all four checks pass: it is under the configured exact Studio prefix; it has no durable asset or manifest reference; every linked attempt is terminal and its retention threshold has passed; and a reviewed inventory records the current ETag/checksum used for the conditional delete. Reconcile through the approved exact-prefix tool; never bulk-delete a bucket. Recovery requests use the audited recovery flow and redacted evidence only.

Task 14's audited incident-resolution operation, metrics exporter/scrape wiring, and alert rules are production-enablement prerequisites. Until those prerequisites and protected smoke evidence exist, Studio remains production-disabled.
