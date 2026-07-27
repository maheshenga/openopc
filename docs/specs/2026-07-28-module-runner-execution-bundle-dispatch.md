# Module Runner Execution Bundle and Dispatch

Date: 2026-07-28
Status: Design and specification approved

## Context

The private module control plane can create executions, claim a known execution ID, heartbeat a
lease, append evidence, and finalize. The Rust Runner can verify claims and execute a supplied WASI
component. The two sides are not yet connected into a usable execution path.

The current contract has four blocking gaps:

1. A Runner cannot discover work because `claim` requires a caller-supplied execution ID.
2. A module execution does not persist immutable invocation input.
3. A claim does not deliver the runtime descriptor or executable artifact needed by the Runner.
4. The Rust finalize fence becomes permanent before the control plane acknowledges the request, so
   a transient transport failure prevents a safe retry.

This design closes those gaps before OCI execution is added.

## Goals

- Let a registered Runner atomically claim the next compatible execution without learning IDs from
  an external dispatcher.
- Bind invocation input, runtime descriptor, and executable artifact to the signed work envelope.
- Deliver a bounded immutable WASI component without exposing object-store credentials or storage
  keys.
- Cancel local execution promptly when the lease is lost, revoked, or cancelled.
- Retry finalize after transient failures while preserving exact-once terminal semantics.
- Keep all changes inside the OpenOPC module subsystem so upstream base upgrades remain isolated.

## Non-Goals

- Adding Redis, NATS, SQS, Kafka, or another dispatch dependency.
- Implementing OCI execution. OCI will consume the same claim and lease lifecycle in Task 12.
- Supporting a legacy public work-envelope contract. The product is not released, so the current
  internal version is updated in place.
- Delivering an entire canonical developer package to the Runner.
- Allowing modules to receive arbitrary binary invocation input in the internal beta.

## Chosen Architecture

The control plane owns scheduling. A fixed set of local Runner workers calls `claim-next`; the
server chooses one compatible dispatchable execution and creates its lease atomically. A successful
claim returns a signed execution bundle containing the descriptor and canonical JSON input plus an
lease-bound fetch contract for a separately stored immutable runtime artifact.

For WASI releases, trust processing extracts the descriptor-selected component from the canonical
developer artifact, stores the component as a separate immutable runtime artifact, and persists its
digest and byte length. The Runner fetches only that component through an mTLS-protected control
plane endpoint and verifies the signed digest before compilation.

This keeps scheduling, tenant checks, profile checks, release state, consent, and kill-switch state
server-authoritative while allowing the Runner to verify every byte it executes.

## Contract Changes

### Execution Creation

`POST /projects/:projectId/module-executions` adds a required `input` JSON value.

- The API canonicalizes the value using the same recursively sorted JSON representation used by
  contract digests.
- Canonical input is limited to 256 KiB.
- The exact canonical UTF-8 bytes and `sha256:` digest are persisted before the execution becomes
  dispatchable.
- The WIT input handle exposes those exact bytes.
- SDK methods accept a JSON-compatible value and do not accept raw provider credentials, signed
  URLs, or capability tokens.

### Work Envelope

The current pre-release `WorkEnvelopeV1` gains these required fields:

```text
inputDigest: sha256:<64 lowercase hex>
runtimeArtifactDigest: sha256:<64 lowercase hex>
runtimeArtifactBytes: positive integer, maximum 33,554,432 for WASI
```

The binding digest includes all three fields. Changing input, descriptor bytes, runtime artifact
bytes, or byte length changes the binding digest and invalidates the signed envelope.

### Claim Next

Add `POST /module-runtime/claims/next` with an empty strict JSON object.

- `200` returns one verified claim bundle.
- `204` means no compatible work is currently dispatchable.
- `409` means the Runner is draining, quarantined, revoked, or has no usable profile.
- `503` is reserved for signing, capability issuance, or storage dependencies being unavailable.

The server derives account, Runner identity, certificate thumbprint, and supported profiles from the
authenticated Runner record. The Runner cannot submit a profile or tenant override.

The response is:

```text
signedEnvelope: string
capabilityTokens: RunnerCapabilityTokenV1[]
runtimeDescriptor: RuntimeDescriptorV1
inputBase64: base64url without padding
runtimeArtifact:
  fetchPath: fixed relative control-plane path
  digest: sha256 digest matching the envelope
  bytes: byte length matching the envelope
```

The Runner verifies the envelope signature and capability hashes first, then independently verifies
the descriptor and decoded input digests plus the signed artifact metadata. It verifies the actual
artifact digest and byte length while fetching the component.

### Runtime Artifact Fetch

Add `POST /module-runtime/artifacts/fetch` with strict lease coordinates:

```text
projectId
executionId
leaseId
generation
```

The endpoint:

- authenticates the Runner through the existing mTLS identity boundary;
- verifies that the lease is live and owned by that Runner;
- resolves the artifact only through the execution's immutable release and descriptor records;
- streams the extracted runtime artifact, never the canonical developer package;
- sets `content-length` and `x-openopc-artifact-sha256` from persisted trusted metadata;
- rejects range requests, redirects, storage keys, user-supplied paths, and alternate artifact IDs;
- stops after the persisted byte length and never buffers the component in the API process.

The Rust client streams to a private temporary file, rejects length or digest mismatches, reads at
most 32 MiB for the current Wasmtime component limit, and removes the temporary file after the
component is compiled or the execution fails.

## Data Model

### Module Execution Input

Add a one-to-one `module_execution_inputs` table:

```text
execution_id uuid primary key
account_id uuid
project_id uuid
input_payload bytea
input_digest varchar(71)
created_at timestamptz
```

The row is immutable. The foreign key includes execution, account, and project. Database checks
enforce a maximum 262,144-byte payload and lowercase SHA-256 format.

### Runtime Artifact

Add a one-to-one `module_runtime_artifacts` table for executable derivatives:

```text
runtime_artifact_id uuid primary key
account_id uuid
release_id uuid
runtime_descriptor_id uuid
artifact_digest varchar(71)
artifact_bytes bigint
media_type varchar(128)
storage_key text
created_at timestamptz
```

For internal-beta WASI, `media_type` is `application/wasm` and the byte limit is 32 MiB. The storage
key is internal-only and is never serialized into a claim, log, event, or SDK response. Rows and
objects are immutable and are retained with the release.

### Scheduling Snapshot

Add immutable `runtime_kind` and `runtime_profile` snapshot columns to `module_executions`. They are
derived from the approved binding when the execution is created. This permits indexed compatible
work selection without reparsing descriptor JSON inside the claim transaction.

Add an index beginning with account, state, runtime kind, runtime profile, deadline, and creation
time for dispatchable rows.

## Atomic Scheduling

Add a database operation that claims the next compatible execution using the established global
lock order and `FOR UPDATE SKIP LOCKED`.

Selection rules:

- execution account equals Runner account;
- state is `dispatchable`;
- deadline is in the future;
- runtime kind and profile match an active registered Runner profile;
- release, installation, consent, descriptor, and kill-switch checks still pass;
- no live lease already exists;
- oldest creation time wins, with execution ID as a deterministic tie breaker.

Selection, lease insertion, state transition, and `execution_claimed` event append occur in one
transaction. Concurrent Runners either receive different executions or `204`; they never share a
lease generation.

## Runner Lifecycle

The Runner starts exactly `OPENOPC_RUNNER_CAPACITY` worker loops. No unbounded task spawning is
allowed.

Each worker performs:

1. Call `claim-next`.
2. On `204`, wait with jittered exponential backoff from 250 ms to 5 seconds.
3. Verify the complete execution bundle before using a capability token or artifact handle.
4. Fetch and verify the runtime artifact.
5. Append sanitized `runtime_started` evidence.
6. Start a lease heartbeat every 10 seconds and execute the selected runtime.
7. Cancel the local executor if heartbeat reports cancellation, terminal state, stale generation,
   revoked lease, or execution deadline.
8. Convert terminal runtime evidence into the canonical finalize payload.
9. Retry finalize on transport and 5xx failures with bounded backoff until acknowledged or the
   signed execution deadline expires.
10. Restore worker capacity and return to `claim-next`.

`RunnerState.capacity.available` is decremented only after a verified claim is accepted and restored
in a scope guard on every exit path.

## Lease and Cancellation Semantics

The lease heartbeat response becomes a typed contract containing server-owned state and deadline.
The Runner never supplies a deadline.

- A live response refreshes the local observed lease deadline.
- `cancelled`, terminal state, `404`, or lease-fence `409` cancels the local executor immediately.
- After lease loss, the Runner does not append evidence or attempt finalize with stale authority.
- Transport failure does not immediately cancel execution. The Runner retries within the last
  server-confirmed lease window and cancels if it cannot re-establish authority before that window
  expires.
- Node drain stops new claims but does not terminate already leased work.

## Finalize Semantics

The control plane remains the source of exact-once terminal truth through the existing terminal
idempotency key and immutable terminal evidence row.

The Rust client tracks finalize fences with three local states:

```text
available -> in_flight -> acknowledged
                  |-> available on retryable failure
```

- Concurrent finalize attempts for the same lease fence are rejected while one is in flight.
- Only a successful or exact-idempotent server response marks the fence acknowledged.
- Transport errors and 5xx responses release the local in-flight state for retry.
- Stale lease, mismatched evidence, and conflicting terminal results are permanent failures.
- The server returns the existing terminal result for an exact replay and rejects a different
  terminal payload.

## Failure Evidence

After the signed envelope is verified, descriptor, input, or artifact mismatch produces bounded
terminal evidence with a stable code and no raw payload:

```text
RUNNER_DESCRIPTOR_DIGEST_MISMATCH
RUNNER_INPUT_DIGEST_MISMATCH
RUNNER_ARTIFACT_DIGEST_MISMATCH
RUNNER_ARTIFACT_LIMIT
RUNNER_ARTIFACT_UNAVAILABLE
```

An invalid envelope signature or capability binding is not trusted enough for follow-up lease
operations. The Runner reports a sanitized node error, stops claiming new work, and becomes not
ready; the untrusted lease expires server-side.

No evidence or tracing span may contain input bytes, component bytes, capability tokens, object
storage keys, provider bodies, signed URLs, or raw Wasmtime traps.

## API and Runner Boundaries

The implementation introduces focused units:

- `ExecutionInputStore`: canonical input persistence and retrieval.
- `RuntimeArtifactStore`: immutable executable derivative storage and streaming.
- `claimNext`: server-owned compatible scheduling and claim bundle construction.
- `RunnerDispatcher`: fixed worker lifecycle and capacity accounting.
- `ClaimBundleVerifier`: envelope, descriptor, input, and artifact metadata verification.
- `RuntimeArtifactClient`: bounded streaming download and digest verification.
- `LeaseSupervisor`: heartbeat, cancellation, and last-confirmed-deadline tracking.
- `FinalizeFence`: retryable local concurrency fence.

The Wasmtime executor remains unaware of HTTP, database, scheduling, and artifact storage. It
continues to receive verified component bytes, canonical input bytes, a cancellation token, and a
capability bridge.

## Testing

### Contract Tests

- TypeScript and Rust accept identical claim bundle fixtures.
- Unknown fields, non-canonical input, digest mismatch, invalid base64url, oversized input, and
  artifact metadata mismatch fail closed.
- Work-envelope binding digest changes when input or runtime artifact metadata changes.

### Control Plane Tests

- Two concurrent Runners cannot claim the same execution or lease generation.
- Profile and tenant mismatches return no candidate without disclosing execution existence.
- Claim-next returns `204` when no compatible row exists.
- Input and runtime artifact records are immutable.
- Artifact fetch rejects stale lease, wrong Runner, wrong tenant, alternate path, and oversized
  object responses.
- Exact finalize replay succeeds idempotently; conflicting replay fails.

### Runner Tests

- Fixed worker count never exceeds configured capacity.
- No-work polling backs off and resets after a successful claim.
- Lease loss cancels Wasmtime and suppresses stale finalize.
- Transient heartbeat failure is tolerated only within the confirmed lease window.
- Transient finalize failure retries and eventually acknowledges exactly once.
- Artifact and input tampering produce stable bounded evidence.
- Temporary files are removed after success, failure, cancellation, and panic containment.

### Focused Integration

A real PostgreSQL integration test starts two Runner dispatchers against one dispatchable WASI
execution. Exactly one Runner executes and finalizes it, one terminal evidence row and one usage
outbox row exist, no live lease remains, and the losing Runner never receives capability tokens.

## Upgrade Isolation

- New code remains under `apps/module-runner`, `apps/api/src/module-runtime`, module runtime contract
  packages, and additive database tables/columns.
- Existing Kortix agent, sandbox, project, and desktop execution paths are not replaced.
- API registration remains through the existing module-runtime app boundary.
- No upstream Kortix file is copied or forked into an OpenOPC-specific implementation.
- Generated CodeGraph data and runtime artifacts remain local or in object storage and are not
  committed.

## Acceptance Criteria

This phase is complete only when:

- a user-created execution with canonical JSON input is discovered without an external execution
  ID handoff;
- a compatible Runner exclusively leases it;
- the Runner verifies and executes the exact approved WASI component;
- cancellation and lease loss stop local execution;
- terminal evidence and usage finalize exactly once despite a simulated transient network failure;
- no secret, raw input, component body, storage key, or provider response appears in evidence or
  logs;
- focused TypeScript, PostgreSQL, Rustfmt, Clippy, Rust, and cross-language contract gates pass.
