# Module Runner Execution Bundle and Dispatch Implementation Plan

> **Execution mode:** Execute this plan inline, task-by-task, in the current worktree. Do not use
> Superpowers or subagents. Stop after each task for a focused review and preserve the first RED
> output and every subsequent GREEN result.

**Goal:** Connect user-created module executions to fixed-capacity Rust Runner workers through a
server-owned claim-next bundle, immutable canonical input, an independently verified WASI
component, lease supervision, and retryable exact-once finalization.

**Architecture:** PostgreSQL remains the scheduling and terminal-truth authority. The API creates
an immutable execution/input pair, trust processing extracts one content-addressed runtime
component, and `claim-next` atomically leases the oldest compatible execution before returning a
signed bundle. The Rust Runner verifies every contract and byte, downloads the component through a
lease-bound stream, executes it under Wasmtime, supervises the lease, and retries finalization only
while the signed execution authority remains live.

**Tech Stack:** TypeScript, Hono, Zod, Ajv 2020, Bun test, Drizzle ORM, PostgreSQL 16, Docker,
`pnpm.cmd`, Rust 1.97.1, Tokio 1.48, Reqwest 0.13, Wasmtime 47.0.2, Ed25519, SHA-256.

**Plan Status:** Task 1 implemented. Contract package: 42 pass, 0 fail; Runner crate: 25 pass,
0 fail; contract/API typechecks, Rustfmt, Clippy, and targeted Biome passed. Tasks 2-8 remain.

## Global Constraints

- Work in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`.
- Preserve all unrelated and pre-existing worktree changes.
- Do not run `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Do not commit or push.
- Do not use Superpowers or subagents.
- Do not modify `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`,
  `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`, or
  `tests/module-beta/evidence.json`.
- Use `pnpm.cmd` from PowerShell, invoke `bun` directly, and use `cargo +1.97.1` for every Runner
  command.
- Do not run the full repository test suite. Run only the focused gates listed in each task and in
  Task 8.
- Do not touch any pre-existing Docker container. Every integration-test container must use the
  `openopc-module-dispatch-<random>` prefix and must be removed by the test that created it.
- Do not terminate the four unrelated pre-existing `cargo` processes.
- Keep new implementation under the existing OpenOPC module boundaries: `apps/module-runner`,
  `apps/api/src/module-runtime`, `apps/api/src/developer`, `packages/module-runtime-contracts`,
  additive database schema/migration changes, and the existing SDK execution client.
- Do not add Redis, NATS, SQS, Kafka, or another dispatch dependency.
- Do not add OCI execution in this phase.
- Do not retain the old caller-supplied execution-ID claim contract. The product is not released.
- Canonical invocation input is required and limited to 262,144 UTF-8 bytes.
- A WASI runtime artifact is `application/wasm`, must be non-empty, and is limited to 33,554,432
  bytes.
- Never log or persist raw input, component bytes, capability tokens, storage keys, signed URLs,
  provider bodies, or raw Wasmtime traps in execution evidence.

## File Map

- `packages/module-runtime-contracts/src/canonical-json.ts`: canonical byte encoding and SHA-256
  helpers shared by input and descriptor verification.
- `packages/module-runtime-contracts/src/work-envelope.ts`: signed envelope fields for input and
  runtime artifact binding.
- `packages/module-runtime-contracts/src/claim-bundle.ts`: strict claim bundle wire contract.
- `packages/module-runtime-contracts/schema/claim-bundle.v1.schema.json`: exact JSON schema for the
  claim response.
- `apps/api/src/module-runtime/execution-inputs.ts`: immutable execution input contract and memory
  store.
- `apps/api/src/module-runtime/runtime-artifacts.ts`: runtime artifact metadata, storage contract,
  lease-bound read service, and memory fixtures.
- `apps/api/src/module-runtime/runtime-artifacts.s3.ts`: content-addressed `application/wasm`
  object-store adapter.
- `apps/api/src/module-runtime/runtime-artifacts.drizzle.ts`: trusted metadata and live-lease
  resolution queries.
- `apps/api/src/module-runtime/executions.ts`: creation, binding digest, scheduling interfaces, and
  memory implementation.
- `apps/api/src/module-runtime/executions.drizzle.ts`: atomic PostgreSQL creation and claim-next
  adapter.
- `apps/api/src/module-runtime/runner-protocol.ts`: authenticated claim bundle construction and
  Runner lifecycle commands.
- `apps/api/src/module-runtime/app.ts`: project execution input, claim-next, heartbeat, artifact
  stream, evidence, and finalize HTTP routes.
- `apps/api/src/module-runtime/index.ts`: production repositories, stores, signer, and route wiring.
- `apps/api/src/developer/runtime-descriptors.ts`: descriptor-selected WASI component extraction.
- `apps/api/src/developer/releases.ts`: trusted derivative storage before release persistence.
- `apps/api/src/developer/releases.drizzle.ts`: release, descriptor, and runtime artifact metadata
  transaction.
- `packages/db/src/schema/kortix.ts`: execution input, runtime artifact, and scheduling snapshot
  schema.
- `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`: authoritative tables,
  immutable triggers, indexes, and claim-next function.
- `packages/sdk/src/core/rest/projects-client/module-executions.ts`: public JSON input creation API.
- `apps/module-runner/src/protocol.rs`: Rust envelope/bundle structs and fail-closed verification.
- `apps/module-runner/src/client.rs`: claim-next, typed heartbeat, bounded artifact transfer, and
  retryable finalize fence.
- `apps/module-runner/src/lease.rs`: last-confirmed lease deadline and cancellation supervisor.
- `apps/module-runner/src/dispatcher.rs`: fixed worker loops, backoff, capacity, and execution
  lifecycle.
- `apps/module-runner/src/service.rs`: capacity permits, drain state, and readiness state.
- `apps/module-runner/src/main.rs`: node heartbeat, dispatcher, health server, and shutdown wiring.
- `packages/db/scripts/module-runner-dispatch.integration.test.ts`: real PostgreSQL/API/two-Runner
  orchestration.
- `apps/module-runner/tests/dispatcher_live.rs`: two real dispatcher instances used by the focused
  integration harness.

---

### Task 1: Define canonical JSON bytes and the strict claim bundle container

**Files:**

- Create: `packages/module-runtime-contracts/schema/claim-bundle.v1.schema.json`
- Create: `packages/module-runtime-contracts/src/claim-bundle.ts`
- Create: `packages/module-runtime-contracts/src/claim-bundle.test.ts`
- Modify: `packages/module-runtime-contracts/src/canonical-json.ts`
- Modify: `packages/module-runtime-contracts/src/contracts.test.ts`
- Modify: `packages/module-runtime-contracts/src/index.ts`
- Modify: `apps/module-runner/src/protocol.rs`
- Modify: `apps/module-runner/tests/contracts.rs`

**Interfaces:**

- Produces:

```typescript
export const MODULE_EXECUTION_INPUT_MAX_BYTES = 262_144;
export const WASI_RUNTIME_ARTIFACT_MAX_BYTES = 33_554_432;
export const RUNTIME_ARTIFACT_FETCH_PATH = 'module-runtime/artifacts/fetch' as const;

export function canonicalJsonBytes(value: unknown): Uint8Array;
export async function sha256Digest(bytes: Uint8Array): Promise<Sha256Digest>;

export interface RunnerCapabilityTokenV1 {
  grantId: string;
  audience: CapabilityAudience;
  token: string;
}

export interface RunnerClaimBundleV1 {
  signedEnvelope: string;
  capabilityTokens: readonly RunnerCapabilityTokenV1[];
  runtimeDescriptor: RuntimeDescriptorV1;
  inputBase64: string;
  runtimeArtifact: {
    fetchPath: typeof RUNTIME_ARTIFACT_FETCH_PATH;
    digest: Sha256Digest;
    bytes: number;
  };
}

export function parseRunnerClaimBundle(value: unknown): RunnerClaimBundleV1;
```

- [x] **Step 1: Add TypeScript RED tests for canonical bytes and the strict bundle**

Add tests that require recursive key ordering, reject sparse arrays/invalid Unicode/non-finite
numbers, and prove the returned bytes are the exact bytes hashed by `sha256Digest`:

```typescript
const bytes = canonicalJsonBytes({ z: [3, { b: true, a: 'x' }], a: null });
expect(new TextDecoder().decode(bytes)).toBe('{"a":null,"z":[3,{"a":"x","b":true}]}');
expect(await sha256Digest(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
```

Add a valid `RunnerClaimBundleV1` fixture and mutate it once per case to assert
`RUNNER_CLAIM_BUNDLE_INVALID` for unknown fields, padded or malformed base64url, an input larger
than 262,144 decoded bytes, a non-positive artifact length, a length above 33,554,432, a non-SHA256
digest, or a changed fetch path.

- [x] **Step 2: Add strict container RED tests for substitution and limit bypasses**

Using one hand-checked valid bundle, reject unknown top-level/nested fields, padded or malformed
base64url, decoded input above 262,144 bytes, duplicate grant IDs, unsupported audiences, a changed
fetch path, a non-canonical digest, zero artifact bytes, and artifact bytes above 33,554,432.

- [x] **Step 3: Add Rust RED tests against the same wire shape**

Add `RunnerClaimBundleV1` deserialization tests that reject unknown fields, invalid base64url,
oversized input, a changed fetch path, duplicate grants, and invalid artifact metadata. Keep signed
work-envelope changes out of this task: Task 5 adds those fields only after input and runtime
artifact metadata have authoritative sources.

- [x] **Step 4: Run the contract tests and capture RED**

```powershell
cd packages/module-runtime-contracts
bun test src/contracts.test.ts src/claim-bundle.test.ts
cd ../../apps/module-runner
cargo +1.97.1 test --test contracts
```

Expected: TypeScript fails because canonical-byte and bundle exports do not exist; Rust fails because
the strict bundle struct/parser does not exist.

- [x] **Step 5: Implement canonical bytes and the strict TypeScript bundle parser**

Refactor `canonical-json.ts` so the existing recursive encoder backs both exports:

```typescript
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeCanonicalJson(value, new WeakSet()));
}

export async function sha256Digest(bytes: Uint8Array): Promise<Sha256Digest> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export async function canonicalDigest(value: unknown): Promise<Sha256Digest> {
  return sha256Digest(canonicalJsonBytes(value));
}
```

Compile `claim-bundle.v1.schema.json` with Ajv 2020, `additionalProperties: false` at every object,
and exact patterns/limits. After schema validation, decode `inputBase64` with a round-trip check:

```typescript
const input = Buffer.from(value.inputBase64, 'base64url');
if (input.toString('base64url') !== value.inputBase64 || input.byteLength > 262_144) invalid();
```

- [x] **Step 6: Implement the strict Rust bundle container**

Add `RunnerClaimBundleV1`, `RuntimeArtifactReferenceV1`, and
`parse_runner_claim_bundle_value(...)`. Use `deny_unknown_fields`, enforce the exact fetch path,
UUID/digest/token bounds, unique grants, base64url round-trip, decoded input size, runtime descriptor
validity, and artifact bytes in `1..=33_554_432`.

- [x] **Step 7: Run the focused contract tests for GREEN**

Run the three commands from Step 4 again. Expected: every suite passes with zero failures and the
TypeScript and Rust fixture JSON remains byte-for-byte compatible.

---

### Task 2: Add immutable input, runtime artifact, and scheduling schema

**Files:**

- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/module-runtime-schema.test.ts`
- Modify: `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`
- Modify: `packages/db/scripts/module-runtime-migration.integration.test.ts`

**Interfaces:**

- Produces Drizzle exports `moduleExecutionInputs` and `moduleRuntimeArtifacts`.
- Adds non-null `runtimeKind` and `runtimeProfile` snapshots to `moduleExecutions`.
- Produces these database identities:

```text
module_execution_inputs(execution_id, account_id, project_id)
module_runtime_artifacts(runtime_artifact_id, account_id)
module_runtime_artifacts(release_id, account_id) UNIQUE
module_runtime_artifacts(runtime_descriptor_id, account_id) UNIQUE
```

- Produces the dispatch index in this exact leading order:

```text
(account_id, state, runtime_kind, runtime_profile, deadline_at, created_at, execution_id)
WHERE state = 'dispatchable'
```

- [x] **Step 1: Add schema RED assertions**

Assert the two tables exist, both tuple foreign keys include tenant coordinates, both tables have
append-only protection, and the execution table exposes the two non-null snapshots. Assert these
checks are present:

```text
octet_length(input_payload) <= 262144
input_digest ~ '^sha256:[0-9a-f]{64}$'
artifact_digest ~ '^sha256:[0-9a-f]{64}$'
artifact_bytes BETWEEN 1 AND 33554432
media_type = 'application/wasm'
```

- [x] **Step 2: Add real PostgreSQL RED cases**

Extend the migration integration suite to insert one canonical input and one runtime artifact, then
assert `UPDATE` and `DELETE` fail for both tables. Add negative inserts for a 262,145-byte input, an
uppercase digest, a zero-byte artifact, a 33,554,433-byte artifact, and a non-WASM media type.

Add an `EXPLAIN (COSTS OFF)` assertion showing the compatible dispatch query can use
`idx_module_executions_dispatchable_profile` without parsing descriptor JSON.

- [x] **Step 3: Run schema and migration tests for RED**

```powershell
cd packages/db
bun test src/module-runtime-schema.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: the schema test cannot import the new tables and the integration test reports missing
relations/columns/indexes.

- [x] **Step 4: Add the Drizzle schema and migration objects**

Add `runtime_kind` and `runtime_profile` to `module_executions`, create both tables with composite
foreign keys, and install append-only triggers through the existing
`kortix.reject_module_runtime_append_only()` function. Use `bytea` for `input_payload`, `bigint` for
`artifact_bytes`, `varchar(128)` for `media_type`, and internal `text` for `storage_key`.

Propagate the two authoritative snapshots through `ModuleExecution`, the execution service, and the
Drizzle repository in this task so the new non-null database contract does not leave the API type
surface or insert path temporarily broken.

Replace the old broad `idx_module_executions_claimable` index with
`idx_module_executions_dispatchable_profile` using the exact order above. No descriptor JSON
expression belongs in this index.

- [x] **Step 5: Make the migration idempotent without retaining old schema**

Use `ADD COLUMN IF NOT EXISTS` only where the migration must tolerate its own second application.
Because the product is unreleased, seed no compatibility defaults and create no old-signature view.
The integration fixture must supply `runtime_kind` and `runtime_profile` for every execution row.

- [x] **Step 6: Run schema, migration lint, and real PostgreSQL tests for GREEN**

```powershell
cd packages/db
bun test src/module-runtime-schema.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
cd ../..
pnpm.cmd migrate:lint
pnpm.cmd --filter @kortix/db typecheck
```

Expected: all four commands exit 0. Confirm the integration suite removes its own container.

---

### Task 3: Persist canonical execution input and expose it through the SDK

**Files:**

- Create: `apps/api/src/module-runtime/execution-inputs.ts`
- Create: `apps/api/src/module-runtime/execution-inputs.test.ts`
- Modify: `apps/api/src/module-runtime/executions.ts`
- Modify: `apps/api/src/module-runtime/executions.test.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Modify: `apps/api/src/module-runtime/app.ts`
- Modify: `apps/api/src/module-runtime/app.test.ts`
- Modify: `apps/api/src/module-runtime/index.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/module-executions.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/module-executions.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/src/public-surface.snapshot.json`
- Modify: `packages/sdk/src/public-type-surface.snapshot.json`

**Interfaces:**

- Produces:

```typescript
export interface ModuleExecutionInput {
  executionId: string;
  accountId: string;
  projectId: string;
  payload: Uint8Array;
  digest: Sha256Digest;
  createdAt: string;
}

export interface ExecutionInputStore {
  get(accountId: string, projectId: string, executionId: string): Promise<ModuleExecutionInput | null>;
}

export interface CreateModuleExecutionCommand extends ResolveModuleExecutionBindingInput {
  idempotencyKey: string;
  deadlineAt: string;
  input: unknown;
}

export interface CreateModuleExecutionPersistenceInput {
  execution: ModuleExecution;
  input: ModuleExecutionInput;
}
```

- Changes `CreateProjectModuleExecutionInput` to require `input: unknown`.
- Uses the immutable `runtimeKind` and `runtimeProfile` snapshots introduced in Task 2.
- `ModuleExecutionBinding` gains the parsed `runtimeDescriptor`, `runtimeArtifactDigest`, and
  `runtimeArtifactBytes` supplied by the trusted binding resolver.

- [ ] **Step 1: Add service RED tests for canonical input**

Create with `{ z: 1, a: ['x'] }` and assert the repository receives these exact bytes and digest:

```typescript
expect(new TextDecoder().decode(persisted.input.payload)).toBe('{"a":["x"],"z":1}');
expect(persisted.input.digest).toBe(await sha256Digest(persisted.input.payload));
```

Assert 262,144 bytes is accepted, 262,145 bytes is rejected with
`MODULE_EXECUTION_INPUT_INVALID`, unsupported values are rejected, and an idempotency replay with a
different input fails with `MODULE_EXECUTION_STATE_CONFLICT`.

- [ ] **Step 2: Add route and SDK RED tests**

Require this request body:

```json
{
  "installation_id": "30000000-0000-4000-a000-000000000003",
  "deadline_at": "2026-07-30T09:30:00.000Z",
  "input": { "prompt": "bounded user value", "count": 2 }
}
```

Assert the API forwards the exact JSON value to `executionService.create`, rejects a missing input
or unknown top-level field, and never accepts `input_base64`, capability tokens, storage keys, or
signed URLs as alternate transport fields. Update the SDK request assertion to include the `input`
property unchanged.

- [ ] **Step 3: Add Drizzle RED tests for one transaction**

Assert `create(...)` inserts `module_executions` and `module_execution_inputs` in the same Drizzle
transaction before `execution_created` is appended. The idempotent read must compare account,
installation, release, descriptor, snapshots, work-envelope digest, deadline, and input digest.

- [ ] **Step 4: Run the focused API and SDK tests for RED**

```powershell
cd apps/api
bun test src/module-runtime/execution-inputs.test.ts src/module-runtime/executions.test.ts src/module-runtime/executions.drizzle.test.ts src/module-runtime/app.test.ts
cd ../../packages/sdk
bun test src/core/rest/projects-client/module-executions.test.ts
```

Expected: input fields/stores are missing and the API still accepts the old two-field create body.

- [ ] **Step 5: Implement canonical creation and immutable persistence**

In `ModuleExecutionService.create`, canonicalize before any database write:

```typescript
const payload = canonicalJsonBytes(command.input);
if (payload.byteLength > MODULE_EXECUTION_INPUT_MAX_BYTES) invalid();
const inputDigest = await sha256Digest(payload);
const workEnvelopeDigest = await computeModuleExecutionBindingDigest(
  binding,
  command.deadlineAt,
  inputDigest,
);
```

Store `runtimeKind` and `runtimeProfile` from the binding in the execution row. Pass a
`ModuleExecutionInput` with the same `createdAt` as the execution to the repository. Confirmation
must load the persisted input and recompute the binding digest with its digest; absence is a stale
binding failure.

- [ ] **Step 6: Implement the route, SDK, and index exports**

Use `z.object({ installation_id, deadline_at, input: z.unknown() }).strict()`; do not stringify or
reorder input in the route. Add the SDK type and body, export the new symbols, and regenerate only
the two existing SDK public surface snapshots with the package's existing snapshot command.

- [ ] **Step 7: Run focused GREEN tests and typechecks**

```powershell
cd apps/api
bun test src/module-runtime/execution-inputs.test.ts src/module-runtime/executions.test.ts src/module-runtime/executions.drizzle.test.ts src/module-runtime/app.test.ts
cd ../../packages/sdk
bun test src/core/rest/projects-client/module-executions.test.ts
cd ../..
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/sdk typecheck
```

Expected: every command exits 0 and no public execution response contains raw canonical input.

---

### Task 4: Extract and store the immutable WASI runtime artifact

**Files:**

- Create: `apps/api/src/module-runtime/runtime-artifacts.ts`
- Create: `apps/api/src/module-runtime/runtime-artifacts.test.ts`
- Create: `apps/api/src/module-runtime/runtime-artifacts.s3.ts`
- Create: `apps/api/src/module-runtime/runtime-artifacts.s3.test.ts`
- Create: `apps/api/src/module-runtime/runtime-artifacts.drizzle.ts`
- Create: `apps/api/src/module-runtime/runtime-artifacts.drizzle.test.ts`
- Modify: `apps/api/src/developer/runtime-descriptors.ts`
- Modify: `apps/api/src/developer/runtime-descriptors.test.ts`
- Modify: `apps/api/src/developer/releases.ts`
- Modify: `apps/api/src/developer/releases.test.ts`
- Modify: `apps/api/src/developer/releases.drizzle.ts`
- Modify: `apps/api/src/developer/releases.drizzle.test.ts`
- Modify: `apps/api/src/developer/index.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Modify: `apps/api/src/module-runtime/index.ts`

**Interfaces:**

- Produces:

```typescript
export interface ExtractedRuntimeArtifact {
  componentPath: string;
  mediaType: 'application/wasm';
  digest: Sha256Digest;
  bytes: Uint8Array;
}

export interface RuntimeDescriptorEvidence {
  descriptor: RuntimeDescriptorV1;
  descriptorDigest: Sha256Digest;
  entryPath: string;
  runtimeKind: 'wasi-component' | 'oci-image';
  runtimeArtifact: ExtractedRuntimeArtifact | null;
}

export interface StoredRuntimeArtifact {
  digest: Sha256Digest;
  bytes: number;
  mediaType: 'application/wasm';
  storageKey: string;
}

export interface RuntimeArtifactStore {
  write(input: {
    accountId: string;
    digest: Sha256Digest;
    bytes: Uint8Array;
  }): Promise<StoredRuntimeArtifact>;
  read(storageKey: string, maxBytes: number): AsyncIterable<Uint8Array>;
}
```

- `DeveloperModuleReleaseInsert` gains `runtimeArtifact: StoredRuntimeArtifact | null`.
- The Drizzle release submission transaction creates one `module_runtime_descriptors` row and, for
  WASI, one `module_runtime_artifacts` row linked to that descriptor.

- [ ] **Step 1: Add extraction RED tests**

For a WASI descriptor, assert the selected component's exact bytes, path, digest, media type, and
length are returned. Add failures for a missing component, duplicate component target, symlink,
zero bytes, and 33,554,433 bytes. For OCI, assert `runtimeArtifact` is `null`.

- [ ] **Step 2: Add store and repository RED tests**

Assert the S3 adapter writes to a partitioned content-addressed key under
`module-runtime/artifacts/`, uses `application/wasm`, checksum SHA-256, server-side encryption, and
`if_none_match: '*'`. Rewriting the same digest is accepted only when size, checksum, and media type
match.

Assert the Drizzle release transaction inserts descriptor JSON first, then runtime artifact metadata
with the generated descriptor ID. An idempotent release replay must reject mismatched runtime
artifact digest, byte length, media type, or missing metadata.

- [ ] **Step 3: Run focused developer/runtime artifact tests for RED**

```powershell
cd apps/api
bun test src/developer/runtime-descriptors.test.ts src/developer/releases.test.ts src/developer/releases.drizzle.test.ts src/module-runtime/runtime-artifacts.test.ts src/module-runtime/runtime-artifacts.s3.test.ts src/module-runtime/runtime-artifacts.drizzle.test.ts src/module-runtime/executions.drizzle.test.ts
```

Expected: the extractor currently validates component presence but does not return/store the
component derivative and production code does not populate the runtime descriptor table.

- [ ] **Step 4: Return bounded component bytes from descriptor extraction**

For `wasi-component`, validate the selected file exactly once, enforce `1..=33_554_432`, compute
SHA-256 over its exact bytes, and return a cloned `Uint8Array`. Never infer the component path from
the package filename; use only `descriptor.runtime.component` after descriptor validation.

- [ ] **Step 5: Store the derivative before the database transaction**

`DeveloperModuleReleaseService.submit` writes the extracted component through the injected
`RuntimeArtifactStore` before calling `repository.submit`. It passes only the returned digest,
length, media type, and internal storage key to the repository. A storage failure maps to
`DEVELOPER_ARTIFACT_STORE_UNAVAILABLE` with status 503. A content-addressed orphan after a database
race is acceptable and contains no tenant-readable key.

- [ ] **Step 6: Persist descriptor and runtime artifact metadata atomically**

Inside `DeveloperModuleReleaseRepository.submit`, insert the release, then the parsed descriptor,
then runtime artifact metadata, then the verification run in one transaction. For non-server
modules create neither descriptor nor runtime artifact. For OCI create the descriptor only. Keep
the storage key out of every release serializer and API response.

- [ ] **Step 7: Extend the binding resolver with trusted executable metadata**

Join `module_runtime_artifacts` for WASI bindings and return:

```typescript
runtimeDescriptor: descriptor,
runtimeArtifactDigest: artifact.artifactDigest as Sha256Digest,
runtimeArtifactBytes: Number(artifact.artifactBytes),
```

Return `null` if WASI metadata is missing, exceeds 33,554,432, has a different descriptor/release,
or is not `application/wasm`. OCI remains unavailable to this phase's Runner execution path but its
descriptor contract remains valid.

- [ ] **Step 8: Run focused GREEN tests and API typecheck**

Run the command from Step 3, then:

```powershell
pnpm.cmd --filter kortix-api typecheck
```

Expected: all focused tests pass, typecheck exits 0, and no serialized object includes
`storage_key`.

---

### Task 5: Implement atomic claim-next and lease-bound artifact streaming

**Files:**

- Modify: `packages/module-runtime-contracts/schema/work-envelope.v1.schema.json`
- Modify: `packages/module-runtime-contracts/src/work-envelope.ts`
- Modify: `packages/module-runtime-contracts/src/contracts.test.ts`
- Modify: `apps/api/src/module-runtime/executions.ts`
- Modify: `apps/api/src/module-runtime/executions.test.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.ts`
- Modify: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Modify: `apps/api/src/module-runtime/runtime-artifacts.ts`
- Modify: `apps/api/src/module-runtime/runtime-artifacts.test.ts`
- Modify: `apps/api/src/module-runtime/runtime-artifacts.drizzle.ts`
- Modify: `apps/api/src/module-runtime/runtime-artifacts.drizzle.test.ts`
- Modify: `apps/api/src/module-runtime/runner-protocol.ts`
- Modify: `apps/api/src/module-runtime/runner-protocol.test.ts`
- Modify: `apps/api/src/module-runtime/app.ts`
- Modify: `apps/api/src/module-runtime/app.test.ts`
- Modify: `apps/api/src/module-runtime/index.ts`
- Modify: `packages/db/migrations/20260727150000000_module_runtime_control_plane.sql`
- Modify: `packages/db/scripts/module-runtime-migration.integration.test.ts`

**Interfaces:**

- Replaces `findDispatchable(...)` plus caller-selected `claim(...)` with:

```typescript
export interface ClaimNextModuleExecutionCommand {
  accountId: string;
  runnerId: string;
}

export interface ModuleExecutionRepository {
  claimNext(command: ClaimNextModuleExecutionCommand): Promise<ClaimModuleExecutionResult | null>;
}

export interface RunnerClaimNextCommand {}

export interface RuntimeArtifactLeaseCoordinates {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
}

export interface RuntimeArtifactRead {
  digest: Sha256Digest;
  bytes: number;
  body: ReadableStream<Uint8Array>;
}
```

- Produces the database function:

```sql
kortix.claim_next_module_execution(
  p_account_id uuid,
  p_runner_id uuid
)
```

- Removes `kortix.claim_module_execution(...)`, `POST /module-runtime/claims`,
  `RunnerClaimCommand`, and `ModuleRunnerProtocol.claim(...)`.
- Adds these required `WorkEnvelopeV1` fields after Task 3 and Task 4 provide their authoritative
  values:

```typescript
inputDigest: Sha256Digest;
runtimeArtifactDigest: Sha256Digest;
runtimeArtifactBytes: number;

export function computeModuleExecutionBindingDigest(
  binding: ModuleExecutionBinding,
  deadlineAt: string,
  inputDigest: Sha256Digest,
): Promise<Sha256Digest>;
```

The TypeScript binding JSON includes `inputDigest`, `runtimeArtifactDigest`, and
`runtimeArtifactBytes` using those exact camel-case names.

- [ ] **Step 1: Add protocol and route RED tests**

Assert `POST /module-runtime/claims/next` accepts only `{}`, returns 204 with no JSON body when the
protocol returns `null`, returns the strict bundle on 200, maps an inactive/draining/quarantined/
revoked Runner or no usable profile to 409, and maps signer/capability/storage unavailability to
503. Assert `/module-runtime/claims` is no longer registered.

Add a happy-path protocol fixture and assert the returned bundle contains the parsed descriptor,
canonical input base64url, fixed artifact fetch path, and metadata identical to the signed envelope.
Changing descriptor, input, artifact digest, or artifact length must abandon the lease and fail
closed.

Extend the TypeScript work-envelope fixture with all three required fields. Assert structural
rejection for missing/invalid fields and calculate four binding digests to prove that changing only
input digest, artifact digest, or artifact byte length changes the binding digest.

- [ ] **Step 2: Add atomic scheduling RED tests**

In memory tests, seed three dispatchable executions and assert selection is restricted by account,
active server-owned Runner profiles, future deadline, runtime kind/profile snapshot, and creation
order with execution ID tie breaking.

In real PostgreSQL, run two concurrent `claim_next_module_execution` calls against one execution
and assert one row plus one empty result, one live lease, generation 1, state `leased`, and exactly
one `execution_claimed` event. Add profile and tenant mismatch cases that return zero rows without
revealing the execution ID.

- [ ] **Step 3: Add artifact route RED tests**

Assert `POST /module-runtime/artifacts/fetch` rejects a `Range` header, unknown fields, wrong tenant,
wrong Runner, stale generation, released/expired lease, terminal execution, mismatched descriptor,
and a stored stream longer than metadata. A valid request returns status 200 with exact
`content-length`, `x-openopc-artifact-sha256`, `content-type: application/wasm`, and no redirect,
storage key, or alternate artifact selector.

- [ ] **Step 4: Run API and PostgreSQL tests for RED**

```powershell
cd apps/api
bun test src/module-runtime/app.test.ts src/module-runtime/runner-protocol.test.ts src/module-runtime/executions.test.ts src/module-runtime/executions.drizzle.test.ts src/module-runtime/runtime-artifacts.test.ts src/module-runtime/runtime-artifacts.drizzle.test.ts
cd ../../packages/db
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: claim-next and artifact routes are absent and the database still requires a known
execution ID.

- [ ] **Step 5: Implement the database-owned claim-next transaction**

The function first locks and validates the Runner row. It then selects one compatible execution:

```sql
SELECT execution.*
INTO v_execution
FROM kortix.module_executions AS execution
WHERE execution.account_id = p_account_id
  AND execution.state = 'dispatchable'
  AND execution.deadline_at > clock_timestamp()
  AND EXISTS (
    SELECT 1
    FROM kortix.module_runner_profiles AS profile
    WHERE profile.runner_id = p_runner_id
      AND profile.account_id = p_account_id
      AND profile.runtime_kind = execution.runtime_kind
      AND profile.profile_name = execution.runtime_profile
  )
ORDER BY execution.created_at, execution.execution_id
FOR UPDATE OF execution SKIP LOCKED
LIMIT 1;
```

After selection, retain the current installation/release/consent/descriptor/kill-switch validation,
derive `generation` from prior leases, generate the lease ID with `gen_random_uuid()`, set
`deadline_at = LEAST(clock_timestamp() + interval '30 seconds', execution.deadline_at)`, insert the
lease, transition the execution, and append `execution_claimed` before returning. If no candidate
exists, return no row. Do not throw an execution-specific error for a mismatch.

- [ ] **Step 6: Build and sign the complete bundle**

Split identity authentication from claimability: certificate/account/Runner mismatches remain 401;
non-active status or zero profiles is 409 for claim-next. After `claimNext`, load the immutable
input and current trusted binding, recompute `workEnvelopeDigest`, issue/store capabilities, sign the
envelope, build `RunnerClaimBundleV1`, call `parseRunnerClaimBundle` as a final server-side assertion,
and return it. Any post-claim failure calls the existing lease abandonment fence.

- [ ] **Step 7: Implement lease-bound artifact streaming**

`RuntimeArtifactService.openForLease(identity)` performs one tenant-qualified query joining
execution, live lease, descriptor, runtime artifact, Runner, and release. It then wraps the store's
async iterable in a `ReadableStream`, counts every emitted byte, errors before byte
`artifact.bytes + 1`, and requires the final count to equal metadata. The route creates a fresh
`Response` with the three trusted headers and never buffers the component in the API process.

- [ ] **Step 8: Run API, PostgreSQL, lint, and typecheck gates for GREEN**

Run the commands from Step 4, followed by:

```powershell
cd ../..
pnpm.cmd migrate:lint
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/db typecheck
```

Expected: every focused test passes, both typechecks pass, migration lint passes, and the disposable
container list is empty.

---

### Task 6: Verify bundles, stream artifacts, and make finalize retryable in Rust

**Files:**

- Modify: `apps/module-runner/Cargo.toml`
- Modify: `apps/module-runner/Cargo.lock`
- Modify: `apps/module-runner/src/protocol.rs`
- Modify: `apps/module-runner/src/client.rs`
- Modify: `apps/module-runner/src/lib.rs`
- Create: `apps/module-runner/tests/claim_bundle.rs`
- Create: `apps/module-runner/tests/runtime_artifact.rs`
- Modify: `apps/module-runner/tests/contracts.rs`

**Interfaces:**

- Produces:

```rust
pub struct VerifiedExecutionBundle {
    pub claim: VerifiedClaim,
    pub runtime_descriptor: RuntimeDescriptorV1,
    pub input: Vec<u8>,
    pub runtime_artifact: RuntimeArtifactReference,
}

pub struct RuntimeArtifactReference {
    pub fetch_path: String,
    pub digest: String,
    pub bytes: u64,
}

pub struct HeartbeatLeaseResponse {
    pub execution: HeartbeatExecution,
    pub lease: HeartbeatLease,
}

pub enum FinalizeFenceState {
    Available,
    InFlight,
    Acknowledged,
}
```

- `RunnerClient::claim_next_at(now)` returns
  `Result<Option<VerifiedExecutionBundle>, RunnerClientError>`.
- `RunnerClient::heartbeat(...)` returns `HeartbeatLeaseResponse`.
- `RuntimeArtifactClient::fetch(...)` returns a private temporary artifact handle that deletes its
  file on drop.

- [ ] **Step 1: Add bundle verification RED tests**

Using a valid signed fixture, assert successful verification of signature, capabilities, descriptor,
canonical input, and artifact metadata. Mutate one property at a time and require stable errors:

```text
RUNNER_DESCRIPTOR_DIGEST_MISMATCH
RUNNER_INPUT_DIGEST_MISMATCH
RUNNER_ARTIFACT_DIGEST_MISMATCH
RUNNER_ARTIFACT_LIMIT
```

Reject non-canonical input bytes even when they parse to the same JSON value, padded base64url,
unknown fields, descriptor/envelope runtime-kind disagreement, and artifact response metadata that
differs from the envelope.

Extend Rust `WorkEnvelopeV1` with `input_digest`, `runtime_artifact_digest`, and
`runtime_artifact_bytes`. Reproduce the TypeScript binding vector exactly and prove each new field
changes `compute_binding_digest(...)` independently.

- [ ] **Step 2: Add streaming artifact RED tests**

Use an injected recording transport that writes chunks into the provided destination. Assert a
valid 32 MiB stream succeeds without using `MAX_CONTROL_PLANE_RESPONSE_BYTES`; byte 33,554,433,
short body, long body, missing/changed headers, redirect, 404, and transport interruption fail with
bounded stable errors. Assert the private temporary file is absent after success scope exit, failure,
cancellation, and panic containment.

- [ ] **Step 3: Add finalize-fence RED tests**

Drive responses `503`, transport error, `200`, then a duplicate local call. Assert the first two
failures restore `Available`, the 200 moves to `Acknowledged`, concurrent calls see `InFlight`, and a
409 permanent rejection cannot be retried. The transport must record three network attempts before
acknowledgement and zero after acknowledgement.

- [ ] **Step 4: Run Rust tests for RED**

```powershell
cd apps/module-runner
cargo +1.97.1 test --test contracts --test claim_bundle --test runtime_artifact
```

Expected: claim-next, typed heartbeat, artifact streaming, and stateful finalize behavior are not yet
implemented.

- [ ] **Step 5: Implement fail-closed bundle verification**

Deserialize with `deny_unknown_fields`, verify the signed envelope and capabilities first, then:

1. Canonically serialize the descriptor and compare SHA-256 to `runtime_descriptor_digest`.
2. Decode base64url without padding, enforce 262,144 bytes, parse JSON, recursively sort it, and
   require the canonical serialization to equal the decoded bytes before comparing `input_digest`.
3. Require bundle artifact digest/length/path to equal the signed envelope.

An invalid signature or capability binding remains `ProtocolError` and is not converted into
lease-follow-up evidence.

- [ ] **Step 6: Add bounded streaming transport and temporary storage**

Extend the injected transport with a separate `fetch_to` operation that accepts lease coordinates,
an expected maximum, and a destination path. The Reqwest implementation uses `Response::chunk()`
and `tokio::fs::File`, disables redirects through the existing client builder, and stops before
writing a byte beyond the signed length or 33,554,432. Move `tempfile` to normal dependencies and
enable Tokio `fs` plus `io-util` features.

- [ ] **Step 7: Replace the finalize HashSet with a three-state map**

Validate/sanitize the payload before acquiring the fence. Atomically transition
`Available -> InFlight`. On transport or 5xx, restore `Available`; on 2xx, set `Acknowledged`; on
404/409 or another non-retryable status, keep the fence closed and return the permanent status.
Never hold the mutex across `.await`.

- [ ] **Step 8: Run Rustfmt, focused tests, and Clippy for GREEN**

```powershell
cargo +1.97.1 fmt --all -- --check
cargo +1.97.1 test --test contracts --test claim_bundle --test runtime_artifact
cargo +1.97.1 clippy --all-targets --all-features -- -D warnings
```

Expected: all commands exit 0 with no warnings.

---

### Task 7: Add fixed-capacity dispatch, lease supervision, and main wiring

**Files:**

- Create: `apps/module-runner/src/lease.rs`
- Create: `apps/module-runner/src/dispatcher.rs`
- Modify: `apps/module-runner/src/service.rs`
- Modify: `apps/module-runner/src/main.rs`
- Modify: `apps/module-runner/src/lib.rs`
- Modify: `apps/module-runner/src/wasi.rs`
- Create: `apps/module-runner/tests/lease_supervisor.rs`
- Create: `apps/module-runner/tests/dispatcher.rs`
- Modify: `apps/module-runner/tests/wasi_execution.rs`

**Interfaces:**

- Produces:

```rust
pub struct LeaseSupervisor {
    // Owns the 10-second heartbeat loop and last server-confirmed deadline.
}

pub struct RunnerDispatcher {
    // Owns exactly config.capacity worker loops.
}

pub trait ClaimedExecutionRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        bundle: VerifiedExecutionBundle,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = TerminalEvidence> + Send + 'a>>;
}

impl RunnerState {
    pub fn try_acquire_capacity(self: &Arc<Self>) -> Option<CapacityPermit>;
    pub fn is_draining(&self) -> bool;
    pub fn set_protocol_ready(&self, ready: bool);
}
```

- Dropping `CapacityPermit` restores exactly one unit and cannot exceed total capacity.
- The dispatcher starts exactly `OPENOPC_RUNNER_CAPACITY` workers and never spawns per-claim tasks.

- [ ] **Step 1: Add lease supervisor RED tests**

With an injected clock and heartbeat transport, assert:

- heartbeats occur every 10 seconds with missed ticks skipped;
- a live response updates the last-confirmed lease deadline;
- `cancelled`, any terminal state, 404, or lease-fence 409 cancels immediately;
- transport failure is tolerated only before the last confirmed deadline;
- after lease loss, the execution path suppresses evidence and finalize.

- [ ] **Step 2: Add dispatcher RED tests**

Start with capacity 3 and a recording execution runner. Assert exactly three worker loops exist,
concurrent accepted work never exceeds three, capacity decrements only after a verified bundle, and
every success/error/cancellation/panic exit restores capacity.

For no work, assert deterministic jittered delays remain within these caps and reset after a claim:

```text
250 ms, 500 ms, 1 s, 2 s, 4 s, 5 s, 5 s ...
```

Set drain and assert workers finish leased jobs but make no new claim-next request. Deliver an
invalid signature and assert protocol readiness becomes false and all claim loops stop.

- [ ] **Step 3: Run dispatcher tests for RED**

```powershell
cd apps/module-runner
cargo +1.97.1 test --test lease_supervisor --test dispatcher --test wasi_execution
```

Expected: the current binary has only node heartbeat and health endpoints; no execution lifecycle
exists.

- [ ] **Step 4: Implement capacity permits and lease supervision**

Use an atomic compare-exchange loop for capacity acquisition. `CapacityPermit::drop` increments once
with a debug assertion that the result is not above `capacity_total`.

`LeaseSupervisor` starts from the signed lease deadline, sends heartbeat every 10 seconds, updates
the observed deadline only from a valid typed response, and cancels the shared `CancellationToken`
on server-owned cancellation/terminal state/fence loss or when authority cannot be re-established
before the last confirmed deadline.

- [ ] **Step 5: Implement one complete worker lifecycle**

Each fixed worker performs this exact sequence:

```text
claim-next -> verify bundle -> acquire capacity -> fetch/verify artifact
-> append runtime_started -> start lease supervisor -> execute WASI
-> stop supervisor -> finalize with bounded retry -> release capacity
```

Map descriptor/input/artifact verification failures after a trusted envelope to the five bounded
codes from the specification. Convert `TerminalEvidence` into sanitized evidence plus usage. Retry
finalize only for transport/5xx with 250 ms to 5 s bounded backoff and never beyond
`execution_deadline`. Do not append or finalize after lease authority is lost.

- [ ] **Step 6: Wire the production Wasmtime runner**

`WasiClaimRunner` accepts the verified descriptor, canonical input, downloaded artifact, cancellation
token, and capability bridge. Keep HTTP, scheduling, and database types out of `WasiExecutor`.
Hold the temporary artifact handle until execution completes, then allow drop-based deletion on all
paths.

- [ ] **Step 7: Wire dispatcher and shutdown in `main.rs`**

Construct one shared `RunnerClient`, `RunnerState`, runtime artifact client, and dispatcher. Start
node heartbeat, dispatcher workers, and Axum health server. On Ctrl+C, set drain, signal dispatcher
shutdown, wait for leased work up to the configured process shutdown window, then stop the server.
Node heartbeat failure changes registration readiness but does not kill already leased work.

- [ ] **Step 8: Run all Runner gates for GREEN**

```powershell
cargo +1.97.1 fmt --all -- --check
cargo +1.97.1 test
cargo +1.97.1 clippy --all-targets --all-features -- -D warnings
```

Expected: every Runner test passes, Clippy emits no warning, and no test depends on loopback network
availability unless explicitly marked as the Task 8 live integration.

---

### Task 8: Prove the real PostgreSQL/API/two-Runner path and run focused final gates

**Files:**

- Create: `packages/db/scripts/module-runner-dispatch.integration.test.ts`
- Create: `apps/module-runner/tests/dispatcher_live.rs`
- Modify: `apps/module-runner/Cargo.toml`
- Modify after verification:
  `docs/specs/2026-07-28-module-runner-execution-bundle-dispatch.md`
- Modify after verification:
  `docs/plans/2026-07-28-module-runner-execution-bundle-dispatch-implementation.md`

**Interfaces:**

- The Bun harness owns one disposable PostgreSQL 16 container, a real Hono module-runtime app, an
  in-memory content-addressed runtime artifact store, and a fixed Ed25519 test signer.
- `dispatcher_live.rs` reads only test-scoped environment variables, creates two capacity-1
  `RunnerDispatcher` instances for two registered Runner identities, and exits after the single
  execution reaches terminal state or a 120-second deadline.
- The live test uses the existing `echo.component.wasm` fixture and canonical JSON input
  `{"message":"dispatch-e2e"}`.

- [ ] **Step 1: Build the real integration harness**

The Bun test must:

1. Create `openopc-module-dispatch-<random>` on a random high loopback port.
2. Wait for `SELECT 1` against `testdb`, not `pg_isready`.
3. Apply migrations twice.
4. Seed one account/project/published release/installation/consent/descriptor/runtime artifact,
   two active WASI Runner profiles, and one dispatchable execution with immutable input.
5. Start `createModuleRuntimeApp(...)` with real Drizzle repositories, real protocol logic, a fixed
   signer, and test-only authenticated Runner identity derived from the two known headers.
6. Spawn
   `cargo +1.97.1 test --manifest-path ../../apps/module-runner/Cargo.toml --test dispatcher_live -- --ignored --nocapture`
   with the server URL, Runner coordinates, public key, and a 120-second deadline.
7. Always stop the Hono server and remove only its own container in `finally`.

- [ ] **Step 2: Assert exclusive execution and exact-once terminal truth**

After both dispatchers exit, one query must prove:

```text
execution state = succeeded
execution_claimed events = 1
runtime_started events = 1
terminal evidence rows = 1
usage outbox rows = 1
live leases = 0
capability grants belong to one lease only
```

The losing Runner must observe 204 and must never receive a signed envelope or capability token.
The winning Runner must experience one injected transient finalize 503 followed by an exact
successful retry. Scan captured structured logs and evidence JSON for forbidden keys/values,
including the raw input string and component bytes.

- [ ] **Step 3: Run the live integration three consecutive times**

```powershell
cd packages/db
bun test scripts/module-runner-dispatch.integration.test.ts
bun test scripts/module-runner-dispatch.integration.test.ts
bun test scripts/module-runner-dispatch.integration.test.ts
```

Expected: all three runs pass. Preserve the complete first failure if any run fails; diagnose before
another attempt instead of retrying until green.

- [ ] **Step 4: Run focused TypeScript and PostgreSQL gates**

```powershell
cd apps/api
bun test src/module-runtime/app.test.ts src/module-runtime/execution-inputs.test.ts src/module-runtime/executions.test.ts src/module-runtime/executions.drizzle.test.ts src/module-runtime/runner-protocol.test.ts src/module-runtime/runtime-artifacts.test.ts src/module-runtime/runtime-artifacts.s3.test.ts src/module-runtime/runtime-artifacts.drizzle.test.ts src/developer/runtime-descriptors.test.ts src/developer/releases.test.ts src/developer/releases.drizzle.test.ts
cd ../../packages/module-runtime-contracts
bun test src/contracts.test.ts src/claim-bundle.test.ts src/capability-token.test.ts
cd ../sdk
bun test src/core/rest/projects-client/module-executions.test.ts
cd ../db
bun test src/module-runtime-schema.test.ts
bun test scripts/module-runtime-migration.integration.test.ts
```

Expected: all focused suites pass with zero failures.

- [ ] **Step 5: Run focused package, migration, and Rust gates**

```powershell
cd ../..
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @openopc/module-runtime-contracts typecheck
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd migrate:lint
cd apps/module-runner
cargo +1.97.1 fmt --all -- --check
cargo +1.97.1 test
cargo +1.97.1 clippy --all-targets --all-features -- -D warnings
```

Expected: all commands exit 0. Do not substitute a full workspace test.

- [ ] **Step 6: Run hygiene and protected-file checks**

```powershell
cd ../..
git diff --check
git diff --name-only -- docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md tests/module-beta/evidence.json
docker ps -a --filter "name=openopc-module-dispatch-" --format "{{.Names}}"
git status --porcelain --untracked-files=all
```

Expected: `git diff --check` is clean, protected-file output is empty, container output is empty,
and status contains only intended work plus pre-existing user changes.

- [ ] **Step 7: Update status and produce the Chinese implementation report**

Only after every required gate passes, set the specification status to:

```markdown
Status: Implemented; focused verification passed
```

Mark completed plan checkboxes and replace `Plan Status` with real totals. Report:

- exact contract and storage limits;
- the atomic claim-next selection and why two Runners cannot share a lease;
- descriptor/input/artifact verification order;
- lease-loss cancellation and finalize retry state transitions;
- all three live integration outputs with per-test timing and pass/fail totals;
- focused TypeScript, PostgreSQL, SDK, Rustfmt, Rust, Clippy, typecheck, and migration-lint output;
- protected-file, container-residue, and worktree status output;
- any residual risk, including OCI execution remaining outside this phase.

Do not commit or push after reporting.
