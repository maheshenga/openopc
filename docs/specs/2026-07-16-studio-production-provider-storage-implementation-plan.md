# Studio Production Provider and Storage Implementation Plan

> **For agentic workers:** Execute this plan through normal repository tasks, TDD loops, commits, and review checkpoints. Do not use `using-superpowers`. Keep checkbox state in this document.

**Goal:** Deliver a project-scoped OpenAI-compatible `image.generate` path and private S3-compatible asset storage shared by the Studio API and worker, while preserving Task 8 idempotency, authorization, billing, and upgrade boundaries.

**Architecture:** `@kortix/studio-runtime` keeps vendor-neutral contracts. A new private `@kortix/studio-adapters` package owns reviewed provider/storage drivers and safe network policy. API services own provider configuration, immutable pricing, uploads/downloads, estimates, and recovery; the independent worker resolves credentials just in time and stages results before settlement.

**Tech stack:** TypeScript, Bun test runner, Zod, Hono, Drizzle/PostgreSQL, AWS SDK v3 S3 client and presigner, Undici, Sharp, MinIO, pnpm workspaces.

**Design source:** `docs/specs/2026-07-16-studio-production-provider-storage-design.md`

**Branch:** `studio-platform`

**Prerequisite:** Commits through Task 8, ending with `41af43e3d feat: add studio worker`.

**Canonical-plan prerequisite:** This implementation plan is committed together with the amended parent architecture and Phase 1 Task 3/8/9/14/15 text before Task 1 starts. Task 10 may record completion evidence, but it is not the first point at which stale Supabase/webhook instructions are superseded.

## Global constraints

- Keep all production changes in the extension-owned paths listed by the design, plus documented thin wiring and migration/CI touchpoints.
- Keep `image.generate` as the only executable Phase 1 capability.
- Keep provider credentials server-side and invocation-scoped. Never persist or log plaintext credentials, Authorization headers, provider output URLs, or signed S3 URLs.
- Treat a dispatched but ambiguous provider submission as `unknown_outcome` unless a reviewed dialect proves idempotent replay or reconciliation.
- Do not mount `/v1/webhooks/studio/:provider` in this task.
- Do not use process-global provider base URL, API key, or model settings. Provider rows and credential bindings are authoritative.
- Keep idempotency, reconciliation, cancellation, and submit-replay guarantees in immutable adapter-owned dialect profiles. Project provider rows may select only a registered profile and cannot declare those guarantees for an arbitrary endpoint.
- Keep Studio disabled for production until Tasks 14 and 15, the live provider smoke, and the Alibaba Cloud OSS compatibility smoke pass.
- Use TDD for every behavior change: write a focused failing test, run it and capture the expected failure, implement the smallest correct change, rerun focused tests, then run the task gate.
- Do not format all of `packages/db/src/schema/kortix.ts`; format or check only touched files and preserve unrelated worktree changes.
- End every task with `git diff --check`, a focused review of the staged diff, and one commit.

## Final file map

### Runtime contracts

- `packages/api-contract/src/studio/index.ts` — credential, pricing, provider-management, recovery, and error wire schemas.
- `packages/studio-runtime/src/provider.ts` — provider definition/invocation contracts and shared provider error.
- `packages/studio-runtime/src/credentials.ts` — server-only credential resolver port.
- `packages/studio-runtime/src/secret-envelope.ts` — side-effect-free server-only project Secret envelope cryptography shared by API and worker.
- `packages/studio-runtime/src/object-store.ts` — bound-bucket object-store port and in-memory conformance driver.
- `packages/studio-runtime/src/conformance.ts` — reusable object-store/provider contract suites.

### Production adapters

- `packages/studio-adapters/package.json` — direct production dependencies and package gates.
- `packages/studio-adapters/src/config.ts` — shared storage/adapter configuration parser.
- `packages/studio-adapters/src/network/ssrf.ts` — address/origin validation.
- `packages/studio-adapters/src/network/safe-fetch.ts` — DNS-pinned, redirect-bounded fetch.
- `packages/studio-adapters/src/media/image.ts` — bounded image MIME/signature/dimension validation.
- `packages/studio-adapters/src/storage/s3-object-store.ts` — S3-compatible driver.
- `packages/studio-adapters/src/storage/readiness.ts` — active put/head/get/delete readiness probe.
- `packages/studio-adapters/src/providers/openai-compatible/*` — credential-free definition and credential-bound image adapter.

### Database and API

- `packages/db/migrations/20260716120000000_studio_production_provider_storage.sql` — pricing, snapshots, staging, and recovery schema.
- `packages/db/src/schema/kortix.ts` — additive Drizzle declarations.
- `apps/api/src/studio/credentials.ts` — extension-owned Secret/Connector resolver facade.
- `apps/api/src/studio/pricing.ts` — immutable pricing catalog repository/service.
- `apps/api/src/studio/providers.ts` — provider CRUD and definition registry.
- `apps/api/src/studio/storage.ts` — upload/finalize/download services.
- `apps/api/src/studio/recovery.ts` — audited unknown-outcome recovery service.
- `apps/api/src/studio/account-routes.ts` — account pricing routes.
- `apps/api/src/studio/index.ts` — project routes and production dependencies.
- `apps/api/src/studio/default-routes.ts` — API runtime assembly.

### Worker and verification

- `apps/studio-worker/src/provider-registry.ts` — invocation-scoped adapter resolution.
- `apps/studio-worker/src/result-stager.ts` — deterministic object/manifest staging.
- `apps/studio-worker/src/runtime.ts` — worker environment and dependency assembly.
- `apps/studio-worker/src/metrics.ts` — low-cardinality provider/storage/queue/billing instrumentation.
- `apps/studio-worker/src/worker.ts` — completed/async submission flow.
- `apps/api/src/studio/metrics.ts` — API readiness, recovery, and reservation instrumentation.
- `.github/workflows/ci.yml` — Studio adapter/worker/MinIO required gate.
- `.github/workflows/package-tests.yml` and `scripts/ci-local.sh` — local/CI package-gate parity.
- `docs/operations/studio-provider-storage.md` — configuration, smoke, unknown recovery, rotation, and rollback runbook.

---

## Task 1: Evolve the runtime contracts without enabling external I/O

**Files:**

- Modify: `packages/api-contract/src/studio/index.ts`
- Modify: `packages/studio-runtime/src/provider.ts`
- Create: `packages/studio-runtime/src/credentials.ts`
- Modify: `packages/studio-runtime/src/object-store.ts`
- Create: `packages/studio-runtime/src/conformance.ts`
- Modify: `packages/studio-runtime/src/index.ts`
- Modify: `packages/studio-runtime/src/provider.test.ts`
- Modify: `packages/studio-runtime/src/object-store.test.ts`
- Modify: `apps/studio-worker/src/worker.ts`
- Modify: `apps/studio-worker/src/worker.test.ts`

**Interfaces:**

- Produces `StudioProviderDefinition`, `StudioProviderSubmission`, `StudioProviderCallError`, replayable-within-attempt assets, `StudioCredentialResolver`, and the expanded `StudioObjectStore` port.
- Keeps the fake provider asynchronous so the existing Task 8 worker remains functional while production completed-result handling is added in Task 8 of this plan.

- [x] **Step 1: Extract the credential binding wire type and add failing contract tests**

Add an exported schema instead of keeping the union inline:

```ts
export const StudioCredentialBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('secret'), identifier: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('connector'), slug: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
export type StudioCredentialBinding = z.infer<typeof StudioCredentialBindingSchema>;
```

Update `StudioProviderConfigSchema` to reuse it. Add tests proving whitespace-only identifiers/slugs fail and `{ kind: 'none' }` remains valid for fake fixtures.

Run:

```powershell
pnpm --filter @kortix/api-contract test
```

Expected RED: the named schema/type is not exported.

- [x] **Step 2: Write failing runtime tests for the new provider contract**

The tests must construct both submission variants and assert shared error identity:

```ts
const completed: StudioProviderSubmission = {
  kind: 'completed',
  provider: 'openai-compatible',
  submission_key: 'submission-1',
  result: { assets: [], usage: {} },
};
expect(completed.kind).toBe('completed');
expect(new StudioProviderCallError('unknown_outcome', 'ambiguous')).toMatchObject({
  classification: 'unknown_outcome',
});
```

Run:

```powershell
pnpm --filter @kortix/studio-runtime test
```

Expected RED: `StudioProviderSubmission` and `StudioProviderCallError` are missing from runtime exports.

- [x] **Step 3: Implement the provider definition and invocation types**

Use these exact public shapes in `provider.ts`:

```ts
export interface StudioPricingSnapshot {
  pricing_catalog_id: string;
  version: number;
  provider: string;
  model: string;
  unit: 'image';
  rate_credits: number;
  max_provider_credits: number;
  markup_credits: number;
}

export interface StudioProviderDefinitionConfig {
  provider_config_id: string;
  provider: string;
  base_url: string | null;
  region: string | null;
  capability_map: Record<string, unknown>;
  version_token: string;
}

export interface StudioProviderDefinition {
  readonly id: string;
  capabilities(config: StudioProviderDefinitionConfig): readonly StudioCapabilityDescriptor[];
  validate(
    config: StudioProviderDefinitionConfig,
    model: string,
    input: StudioJobInput,
  ): StudioValidationResult;
  estimate(
    config: StudioProviderDefinitionConfig,
    pricing: StudioPricingSnapshot,
    input: StudioJobInput,
  ): StudioCostEstimate;
}

export interface StudioProviderAsset {
  kind: 'image';
  filename: string;
  mime_type: string;
  size_bytes: number;
  replayable_within_attempt: boolean;
  openBody(): Promise<ReadableStream<Uint8Array>>;
}

export interface StudioReferenceAssetResolver {
  resolve(input: {
    projectId: string;
    assetIds: readonly string[];
  }): Promise<readonly StudioProviderAsset[]>;
}

export type StudioProviderSubmission =
  | {
      kind: 'completed';
      provider: string;
      submission_key: string;
      result: StudioProviderResult;
    }
  | { kind: 'async'; handle: StudioProviderHandle };

export class StudioProviderCallError extends Error {
  constructor(
    readonly classification: StudioRetryClassification,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'StudioProviderCallError';
  }
}
```

Remove `capabilities`, `validate`, and `estimate` from the credential-bound `StudioProviderAdapter`; change `submit` to return `StudioProviderSubmission`. Move the worker-owned error class into runtime and update imports. The fake provider returns `{ kind: 'async', handle }` and exposes PNGs through `openBody()`.

- [x] **Step 4: Write failing credential-resolver tests and implement the port**

Create `credentials.ts`:

```ts
export interface StudioResolvedCredential {
  source: 'secret' | 'connector';
  value: string;
  version_token: string;
}

export interface StudioCredentialResolver {
  resolve(input: {
    accountId: string;
    projectId: string;
    binding: StudioCredentialBinding;
  }): Promise<StudioResolvedCredential | null>;
}
```

The port contains no SQL, API config, or decryption implementation.

- [x] **Step 5: Write failing object-store conformance tests**

Cover bound namespace, metadata, constrained presign, head, conditional delete, and readiness:

```ts
const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
const written = await store.putObject({
  key: 'accounts/a/projects/p/file.png',
  body: new Blob([PNG]).stream(),
  content_type: 'image/png',
  size_bytes: PNG.byteLength,
  checksum_sha256: SHA256,
  metadata: { project_id: 'p' },
});
expect(await store.headObject({ key: written.key })).toMatchObject({
  checksum_sha256: SHA256,
  size_bytes: PNG.byteLength,
});
await store.deleteObject({ key: written.key, if_match: written.etag });
await expect(store.headObject({ key: written.key })).rejects.toMatchObject({ code: 'NOT_FOUND' });
```

Run the focused test and verify it fails because the methods and fields are absent.

- [x] **Step 6: Implement the bound-bucket object-store port**

Use inputs without a caller-controlled bucket:

```ts
export interface StudioObjectRef {
  key: string;
}

export interface StudioObjectMetadata extends StudioObjectRef {
  namespace: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  etag: string | null;
  metadata: Record<string, string>;
}

export interface StudioPutObjectInput extends StudioObjectRef {
  body: ReadableStream<Uint8Array>;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  metadata: Record<string, string>;
}

export interface StudioStoredObject extends StudioObjectMetadata {
  body: ReadableStream<Uint8Array>;
}

export interface StudioDeleteObjectInput extends StudioObjectRef {
  if_match?: string;
}

export interface StudioSignedUploadInput extends StudioObjectRef {
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  expires_in_seconds: number;
}

export interface StudioSignedDownloadInput extends StudioObjectRef {
  filename: string;
  expires_in_seconds: number;
}

export interface StudioObjectStore {
  readonly namespace: string;
  assertReady(): Promise<void>;
  putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata>;
  headObject(ref: StudioObjectRef): Promise<StudioObjectMetadata>;
  getObject(ref: StudioObjectRef): Promise<StudioStoredObject>;
  deleteObject(input: StudioDeleteObjectInput): Promise<void>;
  createSignedUploadUrl(input: StudioSignedUploadInput): Promise<string>;
  createSignedDownloadUrl(input: StudioSignedDownloadInput): Promise<string>;
}
```

Update the in-memory driver, fake provider tests, and worker asset writer to call `openBody()`.

CRUD methods do not call `assertReady()` internally; API/worker services call the cached readiness gate before accepting work. This prevents readiness probes from recursively invoking themselves while still mapping direct storage failures to typed errors.

Move the reusable assertions into `runStudioObjectStoreConformance(name, createStore)` in `conformance.ts`. The in-memory test calls it here; the MinIO test in Task 3 calls the same suite so the fake and production drivers cannot drift.

- [x] **Step 7: Run the Task 1 gate**

```powershell
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter @kortix/studio-runtime test
pnpm --filter @kortix/studio-runtime typecheck
pnpm --filter @kortix/studio-worker test
pnpm --filter @kortix/studio-worker typecheck
git diff --check
```

Expected: all commands pass; fake jobs still complete once.

- [x] **Step 8: Commit**

```powershell
git add packages/api-contract/src/studio packages/studio-runtime apps/studio-worker/src/worker.ts apps/studio-worker/src/worker.test.ts
git commit -m "refactor: evolve studio provider and storage contracts"
```

---

## Task 2: Scaffold production adapters and shared safe-network policy

**Files:**

- Create: `packages/studio-adapters/package.json`
- Create: `packages/studio-adapters/tsconfig.json`
- Create: `packages/studio-adapters/src/index.ts`
- Create: `packages/studio-adapters/src/config.ts`
- Create: `packages/studio-adapters/src/config.test.ts`
- Create: `packages/studio-adapters/src/network/ssrf.ts`
- Create: `packages/studio-adapters/src/network/ssrf.test.ts`
- Create: `packages/studio-adapters/src/network/safe-fetch.ts`
- Create: `packages/studio-adapters/src/network/safe-fetch.test.ts`
- Create: `packages/studio-adapters/src/media/image.ts`
- Create: `packages/studio-adapters/src/media/image.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `parseStudioAdapterEnvironment`, `validateStudioOrigin`, `safeStudioFetch`, and `validateStudioImage` for Tasks 3, 4, 6, and 9.

- [x] **Step 1: Add the package manifest and direct dependencies**

Use:

```json
{
  "name": "@kortix/studio-adapters",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "bun test src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1079.0",
    "@aws-sdk/s3-request-presigner": "^3.1079.0",
    "@kortix/api-contract": "workspace:*",
    "@kortix/studio-runtime": "workspace:*",
    "ipaddr.js": "^2.2.0",
    "sharp": "^0.34.5",
    "undici": "^6.27.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.12",
    "typescript": "^5.4.0"
  }
}
```

Run `pnpm install` once to update the lockfile. Do not rely on Daytona's transitive AWS SDK.

- [x] **Step 2: Write RED tests for environment parsing**

Cover disabled mode, fake+memory, fake+s3, production+s3, forbidden production+memory, incomplete static credentials, KMS without a key, insecure endpoint outside test mode, and secret-safe errors.

The parsed shape is:

```ts
interface StudioMemoryStorageConfig {
  mode: 'memory';
  namespace: string;
  ephemeral: true;
}

interface StudioS3StorageConfig {
  mode: 's3';
  bucket: string;
  prefix: string;
  endpoint: URL;
  publicEndpoint: URL | null;
  region: string;
  forcePathStyle: boolean;
  expectedBucketOwner: string | null;
  credentialMode: 'default-chain' | 'static';
  accessKeyId: string | null;
  secretAccessKey: string | null;
  sessionToken: string | null;
  sse: 'AES256' | 'aws:kms';
  kmsKeyId: string | null;
}

type StudioAdapterEnvironment =
  | { enabled: false }
  | {
      enabled: true;
      fakeProviderEnabled: boolean;
      openAiCompatibleEnabled: boolean;
      storage: StudioMemoryStorageConfig | StudioS3StorageConfig;
      privateProviderOrigins: readonly string[];
      allowInsecureLocalEndpoints: boolean;
    };
```

Run:

```powershell
pnpm --filter @kortix/studio-adapters test src/config.test.ts
```

Expected RED: package/config module does not exist.

- [x] **Step 3: Implement configuration parsing with Zod**

Parse the exact environment variables in the approved design. Error messages may name missing fields but must never include field values. `STUDIO_ENABLED=false` returns before validating S3/provider variables. Reject OpenAI-compatible+memory unless the caller passes `{ test: true }` to the parser.

- [x] **Step 4: Write RED tests for address and origin policy**

Use table tests for IPv4, IPv6, IPv4-mapped IPv6, localhost, RFC1918, carrier-grade NAT, link-local, multicast, documentation ranges, userinfo, base-URL query strings, HTTP downgrade, exact private-origin allowlist, and multiple DNS answers. No test calls a public network.

The validator signature is:

```ts
export async function validateStudioOrigin(input: {
  url: URL;
  resolve: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  allowPrivateOrigins: ReadonlySet<string>;
  allowInsecureLocalEndpoints: boolean;
}): Promise<readonly { address: string; family: 4 | 6 }[]>;
```

- [x] **Step 5: Implement DNS-pinned, redirect-bounded fetch**

`safeStudioFetch` validates each URL, constructs an Undici `Agent` whose lookup callback returns only the validated addresses, always sets Undici `redirect: 'manual'`, and enforces connect/total timeout plus a streamed byte ceiling. It follows redirects only for a credential-free output GET under the explicit `output-get` policy. Provider submit uses `error`; a 3xx is returned to the adapter without forwarding method, body, prompt, Authorization, cookies, or provider headers to another request.

```ts
export interface SafeStudioFetchOptions {
  redirectPolicy: 'error' | 'output-get';
  maxRedirects: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
  authorizationOrigin?: string;
}
```

Reject `redirectPolicy: 'output-get'` unless the request method is GET and the outbound request has no Authorization, cookie, or body. Tests run local HTTP servers and injected resolvers to prove output redirect revalidation and to prove a submit redirect sends zero method/body/header/prompt bytes to the second origin.

- [x] **Step 6: Implement bounded image validation**

`validateStudioImage` accepts only PNG, JPEG, or WebP, compares supplied MIME with magic detection, calls `sharp(..., { limitInputPixels: 100_000_000 }).metadata()`, and rejects width/height above 16,384, decoded pixel count above 100 million, or bytes above 32 MiB. SVG/XML/HTML are rejected before Sharp.

- [x] **Step 7: Run the Task 2 gate and commit**

```powershell
pnpm --filter @kortix/studio-adapters test
pnpm --filter @kortix/studio-adapters typecheck
git diff --check
git add packages/studio-adapters pnpm-lock.yaml
git commit -m "feat: add studio production adapter foundation"
```

---

## Task 3: Implement the S3-compatible object store and MinIO conformance

**Files:**

- Create: `packages/studio-adapters/src/storage/s3-object-store.ts`
- Create: `packages/studio-adapters/src/storage/s3-object-store.test.ts`
- Create: `packages/studio-adapters/src/storage/s3-object-store.integration.test.ts`
- Create: `packages/studio-adapters/src/storage/readiness.ts`
- Create: `packages/studio-adapters/src/storage/readiness.test.ts`
- Modify: `packages/studio-adapters/src/index.ts`

**Interfaces:**

- Produces `S3StudioObjectStore`, `createS3StudioObjectStore`, and `createCachedStudioReadinessProbe` for API/worker assembly.

- [x] **Step 1: Write RED unit tests against an injected S3 client seam**

Use a seam with `send(command)` and assert exact commands for Put, Head, Get, Delete, signed upload, signed download, SSE, KMS, checksum, content disposition, configured bucket, fixed prefix, and a distinct public signing endpoint. Include 403/404/5xx mapping, verify callers cannot choose a bucket, and prove errors redact `X-Amz-Credential`, `X-Amz-Signature`, session tokens, and the complete signed query string.

- [x] **Step 2: Implement the driver**

Use `S3Client`, `PutObjectCommand`, `HeadObjectCommand`, `GetObjectCommand`, and `DeleteObjectCommand`. Convert web streams with `Readable.fromWeb`, pass known content length, set `ChecksumSHA256`, use `ServerSideEncryption`, and return normalized metadata. The driver exposes the configured bucket through `namespace` but never accepts a bucket in method inputs.

Presigned uploads bind `ContentType`, `ContentLength`, and checksum headers. Presigned downloads set an attachment-only `ResponseContentDisposition` using the sanitized filename. Clamp upload/download TTL to 60-900 seconds.

Conditional deletion performs an `If-Match` head preflight and still sends `IfMatch` on `DeleteObject`. The preflight preserves wrong-ETag rejection on compatible stores that ignore conditional DELETE; atomic delete semantics remain provided by targets that implement S3 conditional DELETE and must be rechecked by each provider compatibility smoke.

- [x] **Step 3: Write RED readiness tests**

Use a deterministic clock/client and assert one-byte put, head, get/verify, delete, 60-second success cache, failure without cache extension, role-prefixed keys, and best-effort cleanup after a failed intermediate operation.

- [x] **Step 4: Implement active readiness**

Expose:

```ts
export function createCachedStudioReadinessProbe(input: {
  store: StudioObjectStore;
  role: 'api' | 'worker';
  cacheMs?: number;
  now?: () => number;
}): () => Promise<void>;
```

The object body is one byte, the checksum is known, and the key starts `_studio-readiness/{role}/`. A failure throws `StudioStorageUnavailableError` without embedding endpoints or credentials.

`S3StudioObjectStore.assertReady()` delegates to this cached probe. The probe calls CRUD methods directly; those methods never call `assertReady()` recursively.

- [x] **Step 5: Add a real MinIO integration test**

The test reads `STUDIO_S3_INTEGRATION_URL`, creates `studio-test` with `CreateBucketCommand`, runs the shared conformance suite, proves direct anonymous GET fails, validates signed upload/download plus rejected MIME/size/checksum mutations, confirms server-side AES256 with `HeadObject`, and deletes all test objects/bucket in `afterAll`. The browser request reconstructs required SSE/KMS headers from signed reserved-metadata query markers while the actual encryption headers remain in `X-Amz-SignedHeaders`; omitting them is rejected and leaves no object.

Local RED/GREEN command:

```powershell
docker run --rm -d --name kortix-studio-minio -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin -e MINIO_KMS_SECRET_KEY=studio-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= minio/minio:RELEASE.2025-04-22T22-12-26Z server /data
$env:STUDIO_S3_INTEGRATION_URL='http://127.0.0.1:9000'
$env:STUDIO_S3_ACCESS_KEY_ID='minioadmin'
$env:STUDIO_S3_SECRET_ACCESS_KEY='minioadmin'
pnpm --filter @kortix/studio-adapters test src/storage/s3-object-store.integration.test.ts
docker stop kortix-studio-minio
```

Expected GREEN: conformance passes and container cleanup succeeds.

- [x] **Step 6: Run the Task 3 gate and commit**

```powershell
pnpm --filter @kortix/studio-adapters test
pnpm --filter @kortix/studio-adapters typecheck
git diff --check
git add packages/studio-adapters/src/storage packages/studio-adapters/src/index.ts
git commit -m "feat: add studio s3 object store"
```

---

## Task 4: Implement the OpenAI-compatible image definition and adapter

**Files:**

- Create: `packages/studio-adapters/src/providers/openai-compatible/config.ts`
- Create: `packages/studio-adapters/src/providers/openai-compatible/definition.ts`
- Create: `packages/studio-adapters/src/providers/openai-compatible/adapter.ts`
- Create: `packages/studio-adapters/src/providers/openai-compatible/request.ts`
- Create: `packages/studio-adapters/src/providers/openai-compatible/response.ts`
- Create: `packages/studio-adapters/src/providers/openai-compatible/*.test.ts`
- Modify: `packages/api-contract/src/studio/index.ts`
- Modify: `packages/api-contract/src/studio/index.test.ts`
- Modify: `packages/studio-adapters/src/network/safe-fetch.ts`
- Modify: `packages/studio-adapters/src/network/safe-fetch.test.ts`
- Modify: `packages/studio-adapters/src/index.ts`

**Interfaces:**

- Produces `openAiCompatibleImageDefinition` and `createOpenAiCompatibleImageAdapter(runtime)`.
- Implements the reviewed synchronous `openai-images-v1-generic` profile. Runtime contracts still support durable asynchronous adapters, exercised by the fake provider.

- [x] **Step 1: Write RED definition tests**

Cover model allowlist, pricing-catalog reference, prompt, aspect ratio, quality, output count, unsupported reference assets, negative prompt/seed only when allowed, and rejection of unknown `advanced` fields.

The definition config uses this strict model entry:

```ts
export interface OpenAiCompatibleModelConfig {
  model: string;
  pricing_catalog_id: string;
  dialect_profile_id: 'openai-images-v1-generic';
  supports_reference_images: false;
  allowed_advanced_fields: readonly string[];
  size_map: Record<'1:1' | '4:3' | '3:4' | '16:9' | '9:16', string>;
}

export interface StudioProviderCapabilityMap {
  definition_id: 'openai-compatible';
  capabilities: {
    'image.generate': {
      models: readonly OpenAiCompatibleModelConfig[];
    };
  };
}
```

`openai-images-v1-generic` is an immutable adapter-owned profile: synchronous response, no submit replay after dispatch, no reconciliation, no upstream cancellation, and no idempotency header. Reject capability-map fields that try to override any of those guarantees. A future replay-capable profile requires a code change, provider-identity/origin binding, and its own conformance tests; project configuration alone can never enable replay.

- [x] **Step 2: Implement credential-free validation and estimation**

The definition returns `STUDIO_MODEL_UNSUPPORTED` for an absent model and `STUDIO_VALIDATION_ERROR` for unsupported inputs. Estimate is calculated only from the immutable `StudioPricingSnapshot`:

```ts
const provider = pricing.rate_credits * input.image.output_count;
const platform = pricing.markup_credits * input.image.output_count;
if (provider > pricing.max_provider_credits) {
  throw new Error('Studio pricing maximum is lower than calculated provider cost');
}
return {
  provider_credits: provider,
  platform_credits: platform,
  max_credits: pricing.max_provider_credits + platform,
};
```

Reject a pricing snapshot whose provider/model does not equal the definition config.

- [x] **Step 3: Write RED request tests**

Assert POST to `{baseUrl}/images/generations`, exact Authorization, JSON content type, no idempotency header for the generic profile, and an allowlisted body containing `model`, `prompt`, `n`, `size`, `quality`, and `response_format: 'b64_json'`. Verify `advanced` is never spread wholesale.

- [x] **Step 4: Write RED response and ambiguity tests**

Cover base64 outputs, safe URL outputs, output-count mismatch, malformed/oversized JSON, invalid base64, MIME mismatch, a 32 MiB single-image ceiling, a 128 MiB total-output ceiling, 400/401/403 terminal errors, submit 3xx/429/5xx becoming `unknown_outcome`, timeout after dispatch, rejection of user-supplied replay/idempotency declarations, and redacted diagnostics. The redirect test proves the target server receives no second request. No generic-profile test expects a second submit.

- [x] **Step 5: Implement the invocation adapter**

The factory accepts an invocation-only runtime:

```ts
interface OpenAiCompatibleRuntime {
  baseUrl: URL;
  model: OpenAiCompatibleModelConfig;
  credential: StudioResolvedCredential;
  fetch: typeof safeStudioFetch;
}
```

For base64 results, retain only bounded decoded bytes and return `openBody()` that creates a fresh stream while the attempt lives. For URL results, `openBody()` calls safe fetch again only before the URL expiry and never forwards provider Authorization. Set `replayable_within_attempt` accurately.

The synchronous `openai-images-v1-generic` adapter reports no upstream cancellation support. Its `cancel()` is a typed no-op; Kortix cancellation remains definitive locally and records unavoidable provider cost when dispatch already occurred.

Implementation keeps the reviewed runtime shape while allowing assembly to inject a policy-bound `safeStudioFetch` wrapper; the adapter supplies conservative public-origin defaults. URL outputs require an adapter-recognized signed expiry, are downloaded once for bounded validation and fingerprinting, and are refetched without provider credentials on every `openBody()` before expiry. The first URL byte buffer is not retained. Capability descriptors keep the legacy primary credential field and add authoritative `accepted_credential_types`, allowing Secret or Connector while still rejecting `none`. Safe-fetch errors carry only an allowlisted dispatch state and numeric HTTP status so 400/401/403 remain terminal even when their body is oversized or interrupted, while ambiguous dispatched outcomes remain non-replayable.

- [x] **Step 6: Run the Task 4 gate and commit**

```powershell
pnpm --filter @kortix/studio-adapters test src/providers/openai-compatible
pnpm --filter @kortix/studio-adapters test
pnpm --filter @kortix/studio-adapters typecheck
git diff --check
git add docs/specs/2026-07-16-studio-production-provider-storage-implementation-plan.md packages/api-contract/src/studio/index.ts packages/api-contract/src/studio/index.test.ts packages/studio-adapters/src/network/safe-fetch.ts packages/studio-adapters/src/network/safe-fetch.test.ts packages/studio-adapters/src/providers packages/studio-adapters/src/index.ts
git commit -m "feat: add openai compatible studio image adapter"
```

---

## Task 5: Add immutable pricing, job snapshots, staging, and recovery schema

**Files:**

- Modify: `packages/api-contract/src/studio/index.ts`
- Modify: `packages/api-contract/src/studio/fixtures.ts`
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/migrations/20260716120000000_studio_production_provider_storage.sql`
- Create: `tests/migration/studio-production-provider-storage.test.ts`
- Modify: `packages/db/scripts/studio-worker-migration.integration.test.ts`
- Modify: `apps/api/src/studio/estimate-token.ts`
- Modify: `apps/api/src/studio/estimate-token.test.ts`

**Interfaces:**

- Produces immutable pricing rows, signed pricing/provider snapshots, staging-manifest columns, recovery audit rows, capped-hold billing incidents, and an expand-first job-creation overload.

- [x] **Step 1: Write RED API-contract tests**

Add strict schemas for:

```ts
StudioPricingCatalogEntrySchema
StudioCreatePricingCatalogRequestSchema
StudioCreateProviderConfigRequestSchema
StudioUpdateProviderConfigRequestSchema
StudioRecoveryRequestSchema
StudioRecoveryResponseSchema
```

`StudioRecoveryRequestSchema` is:

```ts
z.object({
  decision: z.enum(['confirm_succeeded', 'confirm_not_created', 'keep_unknown']),
  idempotency_key: z.string().min(16).max(255),
  reason: z.string().trim().min(8).max(2000),
  evidence: z.object({
    staging_manifest_key: z.string().min(1).max(1024).optional(),
    staging_manifest_checksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    provider_request_id: z.string().min(1).max(255).optional(),
  }).strict(),
}).strict()
```

Add these exact error codes:

```text
STUDIO_PROVIDER_CONFIG_INVALID
STUDIO_CREDENTIAL_UNAVAILABLE
STUDIO_PROVIDER_CONFIG_STALE
STUDIO_PRICING_STALE
STUDIO_RECOVERY_CONFLICT
STUDIO_BILLING_INCIDENT_REQUIRED
STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED
STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED
```

- [x] **Step 2: Write RED migration tests**

Assert:

- `studio_pricing_catalog` is account-scoped and unique by `(account_id, provider, model, version)`;
- `studio_job_recoveries` is unique by `(job_id, idempotency_key)`;
- `studio_billing_incidents` is unique by `(job_id, attempt_id, kind)` and cannot be opened before the 30-day cap;
- jobs have nullable expand-first provider/pricing snapshot columns;
- attempts have provider-config version, submission kind, staging manifest key/checksum;
- attempts have idempotent verified-cost outcome/time fields, and usage events can attribute one immutable cost record per attempt plus platform loss;
- pricing rows referenced by jobs cannot be deleted;
- the old `atomic_create_studio_job` overload remains executable for fake-only rollback;
- `to_regprocedure` resolves both the retained 17-argument and new 21-argument `atomic_create_studio_job` signatures;
- the new overload atomically stores snapshots with the reservation and job;
- the new overload rejects a provider config from another account/project, a stale/inactive price, a provider/model/version mismatch, a partial snapshot, and a reservation not equal to `max_provider_credits + markup_credits * input.image.output_count`;
- `to_regprocedure` resolves the 15-argument `atomic_recover_studio_job` signature and only `service_role` has execute privilege;
- recovery replay with the same key/hash returns the stored result, while the same key with a different hash returns `recovery_conflict`;
- all three recovery decisions enforce the state and decision-specific arguments described below, and an injected finalization/event failure leaves no recovery row or partial billing transition.
- `to_regprocedure('public.atomic_record_studio_attempt_cost(uuid,uuid,text,jsonb,numeric,text,timestamptz)')` resolves, only `service_role` can execute it, and it is idempotent for the same usage/cost/outcome while conflicting on a different second write;
- success, failure, cancellation, retry, and recovery finalization sum verified attempt costs; zero-cost terminal work releases, non-zero terminal work settles, and attempt/final usage rows follow the non-double-counting semantics below.
- recovery success reuses an identical pre-existing `unknown` cost observation without rewriting its outcome, while usage/cost mismatch conflicts; `confirm_not_created` rejects a positive current-attempt cost but still settles verified earlier-attempt cost.
- legacy null-snapshot jobs preserve the exact old success/cancel/terminal billing behavior, while production non-null-snapshot jobs ignore `p_actual_credits` as an authority and reject an expected-value mismatch.
- after multiple cost-bearing attempts and finalization, `SUM(studio_usage_events.upstream_cost_credits)` equals the attempt-cost sum exactly once; the final row carries only user charge, platform loss, and non-additive aggregate metadata.
- 30-day expiry atomically ends the active user hold, settles only verified cost, marks the job unresolved-expired, and opens one idempotent billing incident with remaining potential provider liability.

Run and capture RED:

```powershell
pnpm exec bun test tests/migration/studio-production-provider-storage.test.ts
```

- [x] **Step 3: Implement additive Drizzle schema**

Add `studioPricingCatalog` with these exact columns and constraints:

```text
pricing_catalog_id uuid primary key default gen_random_uuid()
account_id uuid not null references kortix.accounts(account_id) on delete cascade
provider text not null
model text not null
unit text not null check (unit = 'image')
rate_data jsonb not null
maximum_cost_rule jsonb not null
markup_rule jsonb not null
version integer not null check (version > 0)
active boolean not null default true
created_by_user_id uuid null
created_at timestamptz not null default now()
unique (account_id, provider, model, version)
```

The table is append-only except for a one-way `active: true -> false` transition. Add a trigger that rejects changes to identity, scope, rate/rule JSON, version, creator, or creation time and rejects reactivation. Jobs reference `pricing_catalog_id` with `ON DELETE RESTRICT`, so a catalog row used by a job cannot be deleted.

Add `studioJobRecoveries` with these exact columns and constraints:

```text
recovery_id uuid primary key default gen_random_uuid()
account_id uuid not null references kortix.accounts(account_id) on delete cascade
project_id uuid not null references kortix.projects(project_id) on delete cascade
job_id uuid not null references kortix.studio_jobs(job_id) on delete cascade
attempt_id uuid not null references kortix.studio_job_attempts(attempt_id) on delete cascade
idempotency_key text not null
request_hash text not null
decision text not null check (decision in ('confirm_succeeded', 'confirm_not_created', 'keep_unknown'))
actor_user_id uuid not null
actor_type text not null
acting_token_id uuid null
reason text not null
evidence jsonb not null
prior_job_status text not null
prior_attempt_status text not null
resulting_job_status text not null
resulting_attempt_status text not null
result jsonb not null
created_at timestamptz not null default now()
unique (job_id, idempotency_key)
```

Recovery rows are immutable after insertion. `request_hash` is the SHA-256 of the canonical validated request body and is used to distinguish an idempotent replay from reuse of the key with a different decision, reason, or evidence.

Add `studioBillingIncidents`:

```text
incident_id uuid primary key default gen_random_uuid()
account_id uuid not null references kortix.accounts(account_id) on delete cascade
project_id uuid not null references kortix.projects(project_id) on delete cascade
job_id uuid not null references kortix.studio_jobs(job_id) on delete cascade
attempt_id uuid not null references kortix.studio_job_attempts(attempt_id) on delete cascade
kind text not null check (kind = 'unknown_outcome_hold_expired')
status text not null default 'open' check (status in ('open', 'resolved'))
verified_cost_credits numeric(12,4) not null
potential_liability_credits numeric(12,4) not null
metadata jsonb not null default '{}'::jsonb
opened_at timestamptz not null
resolved_at timestamptz null
resolved_by_user_id uuid null
resolution jsonb null
unique (job_id, attempt_id, kind)
```

Task 9 only opens incidents. The one-way audited `open -> resolved` operation belongs to Task 14 and is a production-enablement prerequisite; there is no direct manual-SQL workflow or automatic late user charge.

Add nullable columns:

```text
studio_jobs.provider_config_version text
studio_jobs.pricing_catalog_id uuid
studio_jobs.pricing_version integer
studio_jobs.pricing_snapshot jsonb
studio_job_attempts.provider_config_version text
studio_job_attempts.submission_kind text
studio_job_attempts.staging_manifest_key text
studio_job_attempts.staging_manifest_checksum text
studio_job_attempts.cost_outcome text
studio_job_attempts.cost_recorded_at timestamptz
studio_usage_events.attempt_id uuid
studio_usage_events.outcome text
studio_usage_events.platform_loss_credits numeric(12,4) not null default 0
```

Add expand-first checks so the four job snapshot columns are either all null or all non-null, the two staging-manifest columns are either both null or both non-null, non-null `submission_kind` is `async` or `completed`, and non-null `cost_outcome` is `succeeded`, `failed`, `cancelled`, or `unknown`. Add a partial unique index on `studio_usage_events(attempt_id)` where `attempt_id IS NOT NULL`, making the per-attempt provider-cost record immutable and idempotent.

Attempt usage rows are the only additive source for upstream cost: they have non-null `attempt_id` and observation `outcome`, with `final_cost_credits = 0` and `platform_loss_credits = 0`. A production final usage row has null `attempt_id`, a terminal `outcome`, `upstream_cost_credits = 0`, the user charge in `final_cost_credits`, platform loss in its dedicated column, and the non-additive aggregate under `metadata.verified_upstream_cost_credits`. Constraints enforce those shapes whenever `outcome` is non-null while allowing pre-migration legacy rows with null `outcome`. Existing fake jobs and attempts remain valid with null production fields. Do not alter the original 20260715 migrations.

- [x] **Step 4: Implement the expand-first SQL migration**

Create tables/indexes/columns with `IF NOT EXISTS`. Preserve this original overload and its existing `service_role` grant unchanged for mixed-version fake-only rollback:

```sql
public.atomic_create_studio_job(
  uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid,
  text, text, jsonb, text, text, numeric, timestamptz
) RETURNS jsonb
```

Add this exact overload; do not add defaults, because defaults would make calls ambiguous with the old signature:

```sql
CREATE OR REPLACE FUNCTION public.atomic_create_studio_job(
  p_account_id uuid,
  p_project_id uuid,
  p_actor_user_id uuid,
  p_actor_type text,
  p_acting_token_id uuid,
  p_agent_name text,
  p_session_id text,
  p_parent_job_id uuid,
  p_capability text,
  p_provider_config_id uuid,
  p_provider_config_version text,
  p_provider text,
  p_model text,
  p_pricing_catalog_id uuid,
  p_pricing_version integer,
  p_pricing_snapshot jsonb,
  p_input jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_reserved_credits numeric,
  p_reservation_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
```

Use one canonical provider-version SQL expression in the API query, this overload, and the worker query:

```sql
md5(jsonb_build_object(
  'provider_config_id', config.provider_config_id,
  'account_id', config.account_id,
  'project_id', config.project_id,
  'provider', config.provider,
  'base_url', config.base_url,
  'region', config.region,
  'credential_binding', config.credential_binding,
  'capability_map', config.capability_map,
  'enabled', config.enabled
)::text)
```

Do not include display name, `updated_at`, or decrypted credential value. First perform the old account-scoped idempotency lookup: the same key/hash returns the original job even if its price was later deactivated, and it never backfills null snapshot columns on a job created by the 17-argument overload. Only for a new job, lock the provider row, require the supplied version to equal the canonical expression, validate provider account/project/type, and validate an active pricing row by `(pricing_catalog_id, account_id, provider, model, version)`.

Construct the trusted comparison snapshot from the locked catalog row as:

```sql
jsonb_build_object(
  'pricing_catalog_id', price.pricing_catalog_id::text,
  'version', price.version,
  'provider', price.provider,
  'model', price.model,
  'unit', price.unit,
  'rate_credits', (price.rate_data ->> 'rate_credits')::numeric,
  'max_provider_credits', (price.maximum_cost_rule ->> 'max_provider_credits')::numeric,
  'markup_credits', (price.markup_rule ->> 'markup_credits')::numeric
)
```

Reject a supplied snapshot that is not exactly equal to that trusted snapshot, an invalid `input.image.output_count`, and a reservation not equal to `snapshot.max_provider_credits + snapshot.markup_credits * input.image.output_count`. Numeric comparisons use the schema's `numeric(12,4)` precision, not JavaScript floating-point equality. Insert the job, reservation, all four snapshot fields, and `queued` event in the same transaction.

Apply exact privileges:

```sql
REVOKE ALL ON FUNCTION public.atomic_create_studio_job(
  uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid,
  text, text, text, uuid, integer, jsonb, jsonb, text, text,
  numeric, timestamptz
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_create_studio_job(
  uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid,
  text, text, text, uuid, integer, jsonb, jsonb, text, text,
  numeric, timestamptz
) TO service_role;
```

Add an idempotent verified-attempt-cost primitive:

```sql
CREATE OR REPLACE FUNCTION public.atomic_record_studio_attempt_cost(
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_owner text,
  p_upstream_usage jsonb,
  p_upstream_cost_credits numeric,
  p_outcome text,
  p_recorded_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
```

It locks job then attempt, requires a matching live lease and `queued/running` job, accepts only non-negative server-calculated cost and an allowlisted observation outcome, and writes `upstream_usage`, `upstream_cost_credits`, `cost_outcome`, `cost_recorded_at`, plus exactly one attempt-scoped usage event. An identical repeat returns the stored result; a second write with different canonical usage, cost, or outcome returns `attempt_cost_conflict`. `cost_outcome` records the observation when cost became evidenced and is immutable; later recovery changes job/attempt state, not this historical observation.

```sql
REVOKE ALL ON FUNCTION public.atomic_record_studio_attempt_cost(
  uuid, uuid, text, jsonb, numeric, text, timestamptz
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_record_studio_attempt_cost(
  uuid, uuid, text, jsonb, numeric, text, timestamptz
) TO service_role;
```

In the same migration, `CREATE OR REPLACE` the existing six-argument `atomic_finalize_studio_job_success` and nine-argument `atomic_finalize_studio_job_terminal` bodies without removing or changing either signature or grant. Branch explicitly on the locked job:

- `pricing_snapshot IS NULL` is the legacy/fake branch. Execute the current 20260715180000000 behavior unchanged: success uses the caller's `p_actual_credits`, the existing cancellation fence releases, and terminal finalization releases. This preserves old-worker rollback behavior.
- `pricing_snapshot IS NOT NULL` is the production branch. Sum only attempts with non-null `cost_recorded_at`; derive the success charge from the locked snapshot, verified costs, and successful asset/output count. Treat `p_actual_credits` only as an expected-value integrity check and roll back on mismatch. A success settles that derived charge. A cancellation fence or terminal failure/cancellation settles verified upstream cost when positive and releases only when zero.

For the production branch, record `platform_loss_credits = GREATEST(0, summed_upstream_cost - settled_charge)`; unrealized markup is not provider loss. The final usage row sets `upstream_cost_credits = 0` and stores the aggregate only in non-additive metadata, so summing the numeric upstream column counts each attempt exactly once. Both branches keep finalization and billing-event insertion idempotent.

Task 8 must call `atomic_record_studio_attempt_cost` before retry, terminalization, cancellation finalization, or success finalization whenever allowlisted provider usage proves cost. The final user charge is `sum(verified attempt provider credits) + successful_output_count * snapshot.markup_credits`; failed/cancelled jobs charge only the verified provider-cost sum. SQL still caps the user charge to the reservation and reports the excess as platform loss.

Add the recovery primitive with this exact internal-only signature:

```sql
CREATE OR REPLACE FUNCTION public.atomic_recover_studio_job(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_actor_user_id uuid,
  p_actor_type text,
  p_acting_token_id uuid,
  p_decision text,
  p_idempotency_key text,
  p_request_hash text,
  p_reason text,
  p_evidence jsonb,
  p_result_assets jsonb,
  p_actual_credits numeric,
  p_keep_unknown_until timestamptz,
  p_recovered_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
```

Apply exact privileges:

```sql
REVOKE ALL ON FUNCTION public.atomic_recover_studio_job(
  uuid, uuid, uuid, uuid, text, uuid, text, text, text, text,
  jsonb, jsonb, numeric, timestamptz, timestamptz
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_recover_studio_job(
  uuid, uuid, uuid, uuid, text, uuid, text, text, text, text,
  jsonb, jsonb, numeric, timestamptz, timestamptz
) TO service_role;
```

The API computes `p_request_hash`, validates and loads the staging manifest, converts it to the existing `atomic_finalize_studio_job_success` asset JSON, and calculates `p_actual_credits` from the persisted pricing snapshot before calling SQL. For `confirm_succeeded`, it enriches the internal `p_evidence` with allowlisted manifest usage and server-calculated upstream credits; those fields are never accepted from the public request body. Request data can never supply actor IDs, result assets, usage, credits, or a lease owner directly.

Inside one transaction, lock in this order: job row, transaction-scoped `(job_id, idempotency_key)` advisory key, existing recovery row when present, named attempt row, then reservation row. Return the stored `result` when the key and request hash match; return `recovery_conflict` when the key exists with another hash. For a new decision, require the job to belong to `p_project_id`, the named attempt to belong to the job and be `reconciling`, the reservation to be active, and any job lease to be absent or expired.

Decision behavior is exact:

- `confirm_succeeded` requires the manifest key/checksum in `p_evidence` to equal the locked attempt columns, a non-empty validated `p_result_assets` array, non-negative server-calculated usage/upstream/final credits, null `p_keep_unknown_until`, and no pending cancellation. Generate a short synthetic recovery lease inside SQL. If the attempt has no cost record, call `atomic_record_studio_attempt_cost` with observation outcome `succeeded`; if it already has one, require canonical usage/cost equality and reuse it without changing its immutable `cost_outcome`. Then call `public.atomic_finalize_studio_job_success`; the functions create assets, aggregate all attempt costs, and settle exactly once in the recovery transaction.
- `confirm_not_created` requires null/empty result assets, null current-attempt usage/credits, null keep-until, and no positive verified cost on the locked current attempt. Assign the recovery lease and call the cost-aware `public.atomic_finalize_studio_job_terminal` body with `failed`, `STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED`, retry classification `unknown_outcome`, and a deterministic release reason/key. It settles verified costs from earlier attempts and releases only when the aggregate is zero.
- `keep_unknown` requires null/empty result assets, null credits, `p_recovered_at < p_keep_unknown_until <= p_recovered_at + interval '7 days'`, and `p_keep_unknown_until <= reservation.created_at + interval '30 days'`. The API, not request data, chooses `min(p_recovered_at + interval '24 hours', reservation.created_at + interval '30 days')`; once the cumulative cap is reached it rejects another extension and escalates the alert. Keep the attempt `reconciling`, set reservation expiry and job `available_at` with `GREATEST(current_value, p_keep_unknown_until)` so a replay cannot shorten the hold, and clear the recovery lease without releasing or settling credits.

Finally insert the immutable recovery row and store the returned outcome in `studio_job_recoveries.result` so replay is byte-for-byte stable. Do not add recovery-specific public event types: success/failed/billing/asset events come from the existing finalizers, while `keep_unknown` appends the existing `progress` type with `{ phase: 'operator-review', recovery_id, decision: 'keep_unknown' }`. Any validation, finalization, settlement, release, audit insertion, or event failure rolls back the entire decision.

Add the capped-hold maintenance primitive:

```sql
CREATE OR REPLACE FUNCTION public.atomic_expire_studio_unknown_hold(
  p_job_id uuid,
  p_attempt_id uuid,
  p_expired_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
```

It locks the job, checks/locks an existing incident first and returns it idempotently, then locks the named attempt and active reservation. For a new incident it requires a production snapshot, `running/reconciling`, no live worker lease, and `reservation.created_at + interval '30 days' <= p_expired_at`. It generates a synthetic lease, calls the cost-aware terminal finalizer with `STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED`, settles verified attempt cost or releases a zero-cost hold, and inserts one open incident. `potential_liability_credits` is `GREATEST(0, snapshot.max_provider_credits - verified_cost_credits)` and is never debited from the user. Any partial failure rolls back.

```sql
REVOKE ALL ON FUNCTION public.atomic_expire_studio_unknown_hold(
  uuid, uuid, timestamptz
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_expire_studio_unknown_hold(
  uuid, uuid, timestamptz
) TO service_role;
```

Do not emit a new public event type: the terminal finalizer emits existing `failed` and `billing-settled` events with the incident/error code in payload. The incident row is the immutable operations record.

- [x] **Step 5: Bind provider/pricing version into estimate tokens**

Extend internal token claims with `provider_config_version`, `pricing_catalog_id`, and `pricing_version`. Verification rejects mismatches before job creation. Public estimate response remains additive and does not expose rate internals beyond line items and totals.

- [x] **Step 6: Run the Task 5 gate and commit**

```powershell
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter @kortix/db test
pnpm exec bun test tests/migration/studio-production-provider-storage.test.ts
pnpm --filter kortix-api exec bun test src/studio/estimate-token.test.ts
git diff --check
git add packages/api-contract/src/studio packages/db/src/schema/kortix.ts packages/db/migrations/20260716120000000_studio_production_provider_storage.sql packages/db/scripts/studio-worker-migration.integration.test.ts tests/migration/studio-production-provider-storage.test.ts apps/api/src/studio/estimate-token.ts apps/api/src/studio/estimate-token.test.ts
git commit -m "feat: add studio pricing and recovery schema"
```

---

## Task 6: Connect production provider, pricing, and storage API services

**Files:**

- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/studio/credentials.ts`
- Create: `apps/api/src/studio/credentials.test.ts`
- Create: `apps/api/src/studio/pricing.ts`
- Create: `apps/api/src/studio/pricing.test.ts`
- Create: `apps/api/src/studio/providers.ts`
- Create: `apps/api/src/studio/providers.test.ts`
- Create: `apps/api/src/studio/storage.ts`
- Create: `apps/api/src/studio/storage.test.ts`
- Create: `apps/api/src/studio/recovery.ts`
- Create: `apps/api/src/studio/recovery.test.ts`
- Create: `apps/api/src/studio/account-routes.ts`
- Create: `apps/api/src/studio/default-account-routes.test.ts`
- Create: `apps/api/src/studio/default-account-routes.ts`
- Create: `apps/api/src/studio/management.postgres.test.ts`
- Modify: `apps/api/src/accounts/index.ts`
- Modify: `apps/api/src/studio/index.ts`
- Modify: `apps/api/src/studio/types.ts`
- Modify: `apps/api/src/studio/repositories/drizzle.ts`
- Modify: `apps/api/src/studio/repositories/memory.ts`
- Modify: `apps/api/src/studio/default-routes.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/api/src/__tests__/e2e-studio-project-api.test.ts`
- Create: `apps/api/src/__tests__/e2e-studio-production-api.test.ts`

**Interfaces:**

- Produces `createStudioCredentialResolver`, `StudioPricingService`, `StudioProviderConfigService`, `StudioStorageService`, `StudioRecoveryService`, account pricing routes, and production project route dependencies.

- [x] **Step 1: Write RED credential-facade tests**

Inject a narrow encrypted-row lookup and decrypt function. At this seam, prove exact account/project/binding argument forwarding, no cross-kind fallback, missing-row handling, owning-project checks, malformed/empty row rejection, decryption failure redaction, version-token passthrough, and rotation visibility without caching. The facade implements `StudioCredentialResolver`, remains pure dependency injection, and must not import the API database/config singleton or the existing Secret route module. Task 7, not this facade unit, proves shared-active Secret rules, active-default Connector rules, account/project SQL isolation, and metadata-derived version-token generation.

- [x] **Step 2: Implement the credential facade**

Export these exact test seam and factory shapes:

```ts
export interface StudioEncryptedCredentialRow {
  project_id: string;
  value_enc: string;
  version_token: string;
}

export interface StudioCredentialLookup {
  findSharedSecret(input: {
    accountId: string;
    projectId: string;
    identifier: string;
  }): Promise<StudioEncryptedCredentialRow | null>;
  findActiveDefaultConnectorCredential(input: {
    accountId: string;
    projectId: string;
    slug: string;
  }): Promise<StudioEncryptedCredentialRow | null>;
}

export function createStudioCredentialResolver(input: {
  lookup: StudioCredentialLookup;
  decrypt: (projectId: string, valueEnc: string) => string;
}): StudioCredentialResolver
```

The factory receives decryption as an injected dependency and does not import `apps/api/src/projects/secrets.ts`, because that route module initializes API database/config state at module load. Task 7 extracts the existing Secret envelope cryptography into a side-effect-free shared server module used by both the API route and worker assembly; it must not copy or fork the cryptography. Task 7 also supplies the production lookup through the worker's existing SQL client. Those queries reproduce current shared active Secret and active default shared Connector-profile rules, fence both account and project, and derive `version_token` from row identity/update metadata rather than plaintext. Never return binding identifiers in thrown messages.

- [x] **Step 3: Write RED pricing and provider-management tests**

Prove `billing.write` is required to create/deactivate immutable pricing entries; `project.studio.providers.manage` can create/update operational provider fields but cannot submit rate/markup or idempotency/replay/reconciliation/cancellation declarations; models reference active same-account/provider pricing entries; OpenAI-compatible configs reject `kind: none`, unsafe base URLs, unregistered dialect-profile IDs, and models without prices. The only Phase 1 production profile is the code-owned conservative `openai-images-v1-generic` profile.

- [x] **Step 4: Implement pricing/provider repositories and routes**

Mount:

```text
GET  /v1/accounts/:accountId/studio/pricing-catalog
POST /v1/accounts/:accountId/studio/pricing-catalog
POST /v1/accounts/:accountId/studio/pricing-catalog/:pricingCatalogId/deactivate
POST /v1/projects/:projectId/studio/providers
PATCH /v1/projects/:projectId/studio/providers/:providerConfigId
DELETE /v1/projects/:projectId/studio/providers/:providerConfigId
```

Provider delete is a soft disable. Base URL validation uses `validateStudioOrigin`; it performs no provider call.

- [x] **Step 5: Write RED storage API tests**

Use an in-memory/conformance store and prove:

- upload creation returns the driver URL, not `studio.local`;
- signed upload binds size/MIME/checksum and expires in 15 minutes;
- finalize heads/reads the real object and rejects missing, expired, size, checksum, MIME, magic, or dimension mismatch;
- successful finalize is idempotent and writes actual metadata;
- download URL is generated after project IAM and expires within 15 minutes;
- storage unready returns 503 before reservation/job creation;
- executable capabilities are empty when storage is unready or no enabled provider config has a registered definition, valid model map, and existing credential binding;
- cross-project IDs return 404 without presigning.

- [x] **Step 6: Implement `StudioStorageService` and route injection**

Move presign/finalize/download logic out of the repository. Repositories store rows only. `StudioStorageService` owns object keys, driver calls, hashing, image validation, and ready cache. Use account/project-prefixed keys and sanitize attachment filenames.

Export `createStudioReferenceAssetResolver(repository, store)` implementing `StudioReferenceAssetResolver`. It loads only finalized assets for the exact project, rejects missing/cross-project/unsafe assets, and returns bounded `openBody()` sources. Tests prove the initial `openai-images-v1-generic` definition never calls it because that profile rejects reference IDs, while fake/reference-capable definitions receive only project-owned assets.

- [x] **Step 7: Replace the fake estimate with the shared definition/pricing path**

The estimate route loads provider config and immutable pricing, resolves `StudioProviderDefinition`, validates model/input, and signs the exact provider/pricing versions. The job route repeats version validation and calls the new atomic overload. Remove the `Fake image generation` hard-coded line item except for the fake definition.

- [x] **Step 8: Write RED and GREEN recovery-route tests**

Mount `POST /v1/projects/:projectId/studio/jobs/:jobId/recovery`. Prove normal auth actor attribution, both permission checks, idempotent replay, conflicting idempotency payload rejection, only-reconciling state, settlement/release/extension behavior, audit row, and absence from public SDK exports. Assert every emitted event still validates the existing `StudioJobEventSchema`; recovery adds no event type and uses `progress.phase = 'operator-review'` when no terminal finalizer runs.

For `confirm_succeeded`, derive the expected manifest prefix from locked account/project/job/attempt/submission rows. Independently attack the caller manifest key, manifest account ID, project ID, job ID, attempt ID, submission hash, provider-config version, pricing version, and an internal asset key. Each substitution must fail without cross-project existence disclosure or billing mutation. Re-head every referenced object and reject size/checksum/MIME/SSE mismatch before calling `atomic_recover_studio_job`.

- [x] **Step 9: Run the Task 6 gate and commit**

```powershell
pnpm --filter kortix-api exec bun test src/studio src/__tests__/e2e-studio-project-api.test.ts src/__tests__/e2e-studio-production-api.test.ts
$env:STUDIO_POSTGRES_INTEGRATION='1'; bun test apps/api/src/studio/management.postgres.test.ts
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/studio-adapters test
git diff --check
git add apps/api/package.json apps/api/src/accounts/index.ts apps/api/src/studio apps/api/src/__tests__/e2e-studio-project-api.test.ts apps/api/src/__tests__/e2e-studio-production-api.test.ts packages/db/src/index.ts pnpm-lock.yaml docs/specs/2026-07-16-studio-production-provider-storage-implementation-plan.md
git commit -m "feat: connect studio production api services"
```

---

## Task 7: Resolve project credentials and production adapters in the worker

**Files:**

- Create: `packages/studio-runtime/src/secret-envelope.ts`
- Create: `packages/studio-runtime/src/secret-envelope.test.ts`
- Modify: `packages/studio-runtime/package.json`
- Modify: `apps/api/src/projects/secrets.ts`
- Create: `apps/api/src/projects/secrets-envelope.test.ts`
- Create: `apps/studio-worker/src/provider-registry.ts`
- Create: `apps/studio-worker/src/provider-registry.test.ts`
- Create: `apps/studio-worker/src/credential-lookup.ts`
- Create: `apps/studio-worker/src/credential-lookup.test.ts`
- Modify: `apps/studio-worker/src/contracts.ts`
- Modify: `apps/studio-worker/src/postgres.ts`
- Modify: `apps/studio-worker/src/postgres.test.ts`
- Modify: `apps/studio-worker/src/postgres.integration.test.ts`
- Modify: `apps/studio-worker/src/authorization.ts`
- Modify: `apps/studio-worker/src/runtime.ts`
- Modify: `apps/studio-worker/src/runtime.test.ts`
- Modify: `apps/studio-worker/src/worker.ts`
- Modify: `apps/studio-worker/src/worker.test.ts`

**Interfaces:**

- Produces async `StudioProviderRegistry.resolve(job, config, credential)` and provider config rows containing base URL, region, model map, definition ID, pricing refs, and version.

- [x] **Step 1: Write RED tests for a side-effect-free Secret envelope module**

Create a server-only `@kortix/studio-runtime/secret-envelope` subpath that receives the master secret explicitly and imports neither API config nor database state. Tests use fixed legacy `v1` fixtures plus fresh round trips to prove byte-compatible decryption/encryption, project-bound HKDF isolation, malformed envelope rejection, and wrong-key failure. Add assembly tests proving the API wrapper and worker resolver inject the same shared implementation; `apps/api/src/projects/secrets.ts` must no longer contain envelope constants or cipher/HKDF implementation.

- [x] **Step 2: Extract and wire the shared Secret envelope implementation**

Move the existing AES-256-GCM/HKDF envelope implementation without changing its version, salt/info, IV/tag encoding, or stored ciphertext contract. Keep the existing API `encryptProjectSecret(projectId, value)` and `decryptProjectSecret(projectId, valueEnc)` signatures as thin wrappers that supply `config.API_KEY_SECRET`. Worker runtime supplies its validated secret directly and injects only the project-bound decrypt function into `createStudioCredentialResolver`; neither shared module nor credential lookup may create a database pool or load API config.

- [x] **Step 3: Write RED repository tests for the complete provider snapshot**

Require `loadProviderConfigForSubmission` to return `baseUrl`, `region`, strict capability/model map, definition ID, and version token. Prove the query is fenced by job, account, project, provider, and lease owner. Prove a config/model/pricing version change prevents attempt creation.

- [x] **Step 4: Implement provider snapshot loading**

Extend `StudioWorkerProviderConfig` with:

```ts
baseUrl: string | null;
region: string | null;
definitionId: string;
capabilityMap: StudioProviderDefinitionConfig['capability_map'];
versionToken: string;
```

The provider registry parses `capabilityMap` with the definition-specific schema before narrowing it; the generic worker row does not pretend every provider uses the OpenAI-specific map. The version hash includes every operational field and catalog reference but not decrypted credential value.

In `credential-lookup.ts`, implement `StudioCredentialLookup` with the worker's existing Postgres client. Query shared active Secrets by stable identifier and active default shared Connector credentials by project slug, always joining through account/project ownership. Return only encrypted value, owning project, and a metadata-derived version token. Tests prove this module opens no second pool and never imports the API shared DB singleton.

- [x] **Step 5: Write RED registry tests**

Cover fake resolution, disabled adapter type, wrong provider/config, unsafe base URL, missing credential, `kind: none` on production, model mismatch, unregistered or user-overridden dialect semantics, and successful invocation-scoped OpenAI adapter construction. Assert the registry object returned to the worker contains no serializable credential getter or diagnostic representation.

- [x] **Step 6: Implement async provider resolution**

Use:

```ts
export interface StudioProviderRegistry {
  resolve(input: {
    job: StudioWorkerJob;
    config: StudioWorkerProviderConfig;
    credential: StudioResolvedCredential | null;
    referenceAssets: StudioReferenceAssetResolver;
  }): Promise<StudioProviderAdapter | null>;
}
```

Fake requires `kind: none`; OpenAI-compatible requires a resolved Secret/Connector and an enabled adapter type.

- [x] **Step 7: Enforce authorization before plaintext resolution**

Split authorization into binding validation and IAM/token/grant revalidation. The worker order is: load config → validate binding shape/existence → revalidate token/IAM/grants → resolve plaintext → prepare attempt → provider I/O. Tests assert the resolver is never called after any denied authorization and the provider is never called after resolver failure.

- [x] **Step 8: Run the Task 7 gate and commit**

```powershell
pnpm --filter @kortix/studio-worker test src/provider-registry.test.ts src/postgres.test.ts src/authorization.test.ts src/worker.test.ts
pnpm --filter @kortix/studio-worker typecheck
pnpm --filter @kortix/studio-runtime test src/secret-envelope.test.ts
pnpm --filter @kortix/studio-runtime typecheck
pnpm --filter kortix-api exec bun test src/projects/secrets-envelope.test.ts src/studio/credentials.test.ts
git diff --check
git add packages/studio-runtime apps/studio-worker apps/api/src/projects/secrets.ts apps/api/src/projects/secrets-envelope.test.ts apps/api/src/studio/credentials.ts apps/api/src/studio/credentials.test.ts
git commit -m "feat: resolve studio provider credentials in worker"
```

---

## Task 8: Add synchronous result staging and crash-safe recovery

**Files:**

- Create: `apps/studio-worker/src/result-stager.ts`
- Create: `apps/studio-worker/src/result-stager.test.ts`
- Modify: `apps/studio-worker/src/contracts.ts`
- Modify: `apps/studio-worker/src/memory-repository.ts`
- Modify: `apps/studio-worker/src/postgres.ts`
- Modify: `apps/studio-worker/src/postgres.test.ts`
- Modify: `apps/studio-worker/src/postgres.integration.test.ts`
- Modify: `apps/studio-worker/src/worker.ts`
- Modify: `apps/studio-worker/src/worker.test.ts`
- Modify: `apps/studio-worker/src/maintenance.ts`
- Modify: `apps/studio-worker/src/maintenance.test.ts`

**Interfaces:**

- Produces `StudioResultStager.stage`, `loadManifest`, deterministic staging keys, and completed/async worker branches.

- [x] **Step 1: Write RED result-stager tests**

Prove deterministic keys include account/project/job/attempt/submission hash; each asset is streamed, hashed, validated, and written once; the manifest is written last; same input is idempotent; a partial failure leaves no manifest; replayable sources reopen at most three times in the same owned attempt; non-replayable failure becomes unknown.

Manifest shape:

```ts
interface StudioStagingManifest {
  version: 1;
  account_id: string;
  project_id: string;
  job_id: string;
  attempt_id: string;
  submission_key_hash: string;
  provider_config_id: string;
  provider_config_version: string;
  pricing_catalog_id: string;
  pricing_version: number;
  assets: Array<{
    kind: 'image';
    key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    checksum_sha256: string;
  }>;
  usage: Record<string, number>;
}
```

- [x] **Step 2: Implement the stager**

Write assets to `accounts/{accountId}/projects/{projectId}/jobs/{jobId}/attempts/{attemptId}/submissions/{submissionKeyHash}/...`; write `manifest.json` only after all objects pass validation. Never place provider URLs, credentials, or raw response bodies in the manifest. Verify an existing manifest checksum and every identity field before treating it as recovery evidence. Require every asset key to remain under the database-derived exact submission prefix.

- [x] **Step 3: Write the crash-window RED matrix**

Inject faults:

```text
before dispatch
after dispatch/lost response
after response/before first object
after object/before manifest
after manifest/before DB mark
after DB mark/before finalize
after finalize/before acknowledgement
```

For recoverable rows assert provider submit count 1, logical assets 1 set, settlement 1. For pre-manifest ambiguity assert `STUDIO_SUBMISSION_OUTCOME_UNKNOWN` and no automatic submit. Add billing cases for a first attempt with verified cost followed by retry success, dispatch followed by cancellation with verified cost, unknown followed by `confirm_not_created`, and cost above reservation. Assert one immutable cost row per attempt, aggregate upstream cost, capped user charge, and exact platform loss.

- [x] **Step 4: Implement worker completed/async branching**

On `{ kind: 'async' }`, keep Task 8 handle/poll behavior. On `{ kind: 'completed' }`, verify submission key, stage, persist manifest reference/checksum, record allowlisted usage and server-calculated attempt cost, aggregate the pricing-derived final charge, then finalize and settle. When a failed/cancelled/retry response contains trusted usage, persist its attempt cost before changing attempt state. When claiming a `submitting/reconciling` attempt, check a durable manifest before provider reconciliation.

Submit 429/5xx/timeout classification is operation-aware. Poll/result GET retries never create a new submission. A new submission key is minted only after the prior attempt is proven not accepted.

- [x] **Step 5: Add orphan staging maintenance**

Replace the current `failStuckUnknownOutcomes` behavior before any production runtime is enabled: an aged `reconciling` attempt remains `reconciling`, retains its active reservation and evidence, releases only an expired worker lease, and emits a deduplicated existing `progress` event with `{ phase: 'operator-review' }` plus the unknown/reservation-age metric. It must not become `failed` after 15 minutes. This change is a prerequisite for the Task 6 recovery route to be operationally usable; the route remains production-disabled until this task and runtime assembly are complete.

Add Postgres integration cases that seed three `running/reconciling` jobs older than 15 minutes, run maintenance, then execute `confirm_succeeded`, `confirm_not_created`, and `keep_unknown` through the recovery service. All three must remain recoverable after maintenance; assert the expected final job/attempt/reservation/audit/event state and one settlement or release at most.

Add a fourth job left untouched through `reservation.created_at + 30 days`. Maintenance calls `atomic_expire_studio_unknown_hold`; assert the reservation is no longer active, verified cost is settled at most once (or zero cost released), job/attempt are terminal with `STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED`, one open billing incident exists, the user's available balance is no longer held, and rerunning maintenance is idempotent.

Maintenance deletes objects only when no manifest is attached, the attempt is terminal, the retention threshold passed, and conditional ETag/checksum matches. Unknown attempts retain evidence and reservation. Tests prove active/unknown objects are never deleted.

- [x] **Step 6: Run the Task 8 gate and commit**

```powershell
pnpm --filter @kortix/studio-worker test
pnpm --filter @kortix/studio-worker typecheck
pnpm --filter @kortix/db exec bun test scripts/studio-worker-migration.integration.test.ts
git diff --check
git add apps/studio-worker
git commit -m "feat: stage studio provider results durably"
```

---

## Task 9: Assemble production API and worker runtimes

**Files:**

- Create: `apps/studio-worker/src/runtime.ts`
- Create: `apps/studio-worker/src/runtime.test.ts`
- Create: `apps/studio-worker/src/metrics.ts`
- Create: `apps/studio-worker/src/metrics.test.ts`
- Modify: `apps/studio-worker/src/index.ts`
- Modify: `apps/studio-worker/src/index.test.ts`
- Modify: `apps/studio-worker/package.json`
- Modify: `apps/api/src/studio/default-routes.ts`
- Create: `apps/api/src/studio/default-routes.test.ts`
- Create: `apps/api/src/studio/metrics.ts`
- Create: `apps/api/src/studio/metrics.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**

- Produces `buildStudioWorkerRuntime(env)` and `buildStudioApiRuntime(env)`, both using the same adapter config parser and object-store driver.

- [ ] **Step 1: Write RED assembly matrix tests**

Cover:

```text
STUDIO_ENABLED=false -> no storage/provider requirements
fake + memory + explicit ephemeral -> allowed
fake + S3 -> allowed
OpenAI-compatible + S3 -> allowed
OpenAI-compatible + memory outside test -> rejected
static S3 missing either key -> redacted startup failure
KMS without key ID -> redacted startup failure
conflicting legacy/new fake flags -> fail closed
```

Assert no startup error includes secret values or signed URLs.

- [ ] **Step 2: Implement thin runtime builders**

`runtime.ts` constructs SQL repositories, authorization, credential resolver, provider registry, S3/memory store, cached readiness, result stager, worker, and maintenance coordinator. `index.ts` handles signals and loop only. The API builder constructs the same configured store, readiness service, provider definitions, repositories, and routes.

No environment variable supplies provider base URL, API key, or model.

- [ ] **Step 3: Prove readiness precedes claims/reservations**

Worker tests assert an unready production store prevents the first claim. API tests assert unready storage yields empty executable capabilities and HTTP 503 before estimate reservation/job creation. Liveness remains independent from AI provider reachability.

- [ ] **Step 4: Prove graceful shutdown**

Test SIGTERM-equivalent abort: stop new claims, finish or abandon the active lease safely, release maintenance ownership, close DB/S3 clients, and never create a second submit.

- [ ] **Step 5: Add production telemetry injection**

Instrument and test these exact low-cardinality series/events without account, project, job, object key, URL, model, credential, or error-message labels:

```text
studio_provider_requests_total{operation,outcome,profile}
studio_provider_request_duration_seconds{operation,profile}
studio_unknown_outcomes_total{phase,profile}
studio_storage_operations_total{operation,outcome}
studio_storage_operation_duration_seconds{operation}
studio_storage_readiness{role}
studio_queue_oldest_age_seconds
studio_reservation_oldest_age_seconds{state}
studio_orphan_staging_objects
studio_estimate_violations_total{profile}
studio_platform_loss_credits_total{profile}
studio_recovery_decisions_total{decision,outcome}
```

Use injected counter/gauge/histogram sinks so tests assert exact emissions and runtime tests can use an in-memory sink. Task 14 owns scrape endpoints and alert-manager deployment, but these production code paths must emit before Task 14 begins. Add reservation-age warning at 24 hours and critical escalation at seven days; reaching the 30-day hold cap is always critical.

- [ ] **Step 6: Run the Task 9 gate and commit**

```powershell
pnpm --filter @kortix/studio-adapters test
pnpm --filter @kortix/studio-adapters typecheck
pnpm --filter @kortix/studio-worker test
pnpm --filter @kortix/studio-worker typecheck
pnpm --filter kortix-api exec bun test src/studio/default-routes.test.ts src/__tests__/e2e-studio-production-api.test.ts
pnpm --filter kortix-api typecheck
git diff --check
git add apps/studio-worker apps/api/src/studio/default-routes.ts apps/api/src/studio/default-routes.test.ts apps/api/src/studio/metrics.ts apps/api/src/studio/metrics.test.ts apps/api/package.json
git commit -m "feat: assemble studio production runtimes"
```

---

## Task 10: Make production verification required and document operations

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/package-tests.yml`
- Modify: `scripts/ci-local.sh`
- Create: `apps/studio-worker/scripts/live-provider-smoke.ts`
- Create: `apps/studio-worker/scripts/aliyun-oss-smoke.ts`
- Create: `docs/operations/studio-provider-storage.md`
- Modify: `docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md`
- Modify: `tests/spec/end-to-end.md`

**Interfaces:**

- Produces required CI gates, manual bounded smokes, and an operator runbook. It does not enable production Studio.

- [ ] **Step 1: Add adapter paths and gates to CI filters**

Add `packages/studio-adapters/**` and `apps/api/src/studio/**` to both API and Studio worker dependency closures. The Studio job runs runtime, adapters, and worker test/typecheck commands explicitly.

- [ ] **Step 2: Add a required MinIO CI step**

Start the pinned MinIO image used in Task 3, wait on `/minio/health/live`, create the test bucket from the integration test, run `s3-object-store.integration.test.ts`, and always stop the container. A missing Docker service or failed health check fails the job; it is not silently skipped.

- [ ] **Step 3: Synchronize local/package CI entrypoints**

Add `@kortix/studio-adapters` and `@kortix/studio-worker` to `package-tests.yml` and `scripts/ci-local.sh`. Ensure focused-test detection and package test discovery see all new test files.

- [ ] **Step 4: Add the bounded live provider smoke**

The script exits without a request unless `STUDIO_LIVE_PROVIDER_TESTS=true`. When enabled it requires a dedicated project/provider config, `STUDIO_LIVE_PROVIDER_MAX_CREDITS` from 1 through 5, timeout at most 300 seconds, output count one, concurrency one, and explicit cleanup confirmation. It asserts one job, one provider submission, one manifest, one asset, one settlement, signed download, and redaction scan.

- [ ] **Step 5: Add the Alibaba Cloud OSS compatibility smoke**

The script uses only the configured bucket and an exact dedicated prefix, verifies the expected bucket owner when the target protocol supports it, and performs put/head/get/delete, signed upload/download, checksum, metadata, HTTPS, path-style setting under test, and cleanup. It must also prove an unsigned anonymous GET is denied and that `HeadObject` reports the configured SSE mode/KMS key rather than merely asserting the request option sent by the client. It prints no access key or signed URL. A failure blocks S3-driver approval for the endpoint and does not weaken conformance.

- [ ] **Step 6: Write the operations runbook**

Document exact environment fields, private bucket/SSE/lifecycle policy, API/worker credentials, readiness probe cost/behavior, provider config and immutable pricing ownership, Secret/Connector rotation, canary sequence, redacted unknown-recovery examples, the 24-hour/7-day/30-day hold policy and billing-incident handoff, orphan cleanup, metrics/alerts, rollback, and smoke cleanup. State explicitly that Task 14's audited incident-resolution operation, exporter/scrape wiring, and alert rules are production-enablement prerequisites.

- [ ] **Step 7: Run the complete Task 9 verification gate**

```powershell
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter @kortix/db test
pnpm --filter @kortix/studio-runtime test
pnpm --filter @kortix/studio-runtime typecheck
pnpm --filter @kortix/studio-adapters test
pnpm --filter @kortix/studio-adapters typecheck
pnpm --filter @kortix/studio-worker test
pnpm --filter @kortix/studio-worker typecheck
pnpm --filter kortix-api exec bun test src/studio src/__tests__/e2e-studio-project-api.test.ts src/__tests__/e2e-studio-production-api.test.ts
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/db exec bun test scripts/studio-worker-migration.integration.test.ts
pnpm exec bun test tests/migration/studio-production-provider-storage.test.ts
pnpm exec biome check packages/studio-runtime packages/studio-adapters apps/studio-worker apps/api/src/studio tests/migration/studio-production-provider-storage.test.ts
pnpm --filter kortix-api exec bun -e "import { parse } from 'yaml'; for (const f of process.argv.slice(2)) parse(await Bun.file(f).text());" ../../.github/workflows/ci.yml ../../.github/workflows/package-tests.yml
git diff --check
```

Then run the MinIO command from Task 3. Live provider and Alibaba Cloud OSS smokes remain explicit protected-environment gates and are not replaced by mocks.

- [ ] **Step 8: Review production-disable boundary**

Verify `STUDIO_ENABLED` remains false in production deployment values and that Task 14 still owns compose/Kubernetes enablement. Verify no video, voice, 3D, digital-human, batch-remix, Developer Center, or webhook capability/routes were added.

- [ ] **Step 9: Commit**

```powershell
git add .github/workflows/ci.yml .github/workflows/package-tests.yml scripts/ci-local.sh apps/studio-worker/scripts docs/operations/studio-provider-storage.md docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md tests/spec/end-to-end.md
git commit -m "test: gate studio production provider path"
```

---

## Execution checkpoints

After each task:

1. Read the full staged diff, not only the summary.
2. Confirm no credential, signed URL, raw provider body, or generated local environment file is staged.
3. Run the task's focused and package gates.
4. Confirm `git diff --check` passes.
5. Commit only that task.
6. Perform a reviewer pass before starting the next task.

After Task 10, do not claim production readiness until the protected live provider smoke, Alibaba Cloud OSS compatibility smoke, Task 14 deployment validation, and Task 15 full acceptance gate have all produced recorded evidence.
