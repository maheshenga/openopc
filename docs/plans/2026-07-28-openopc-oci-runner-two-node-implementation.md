# OpenOPC OCI Runner and Two-Node Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute OCI module releases only on an independently deployed, rootless containerd plus gVisor Runner and bind that execution node safely to the BaoTa control plane.

**Architecture:** The existing Rust Runner claim/lease/finalize protocol remains server-owned and is refactored behind a shared executor trait after the current Task 8 checkpoint. A second binary, process, service identity, capacity pool, and artifact implements OCI execution through fixed-argument `nerdctl` calls to a rootless containerd socket using the `io.containerd.runsc.v1` runtime. Network egress is default-deny and reaches only the module egress proxy on a dedicated rootless network.

**Tech Stack:** Rust 1.97.1, Tokio, existing signed claim bundle, rootless containerd, nerdctl, gVisor/runsc, Linux namespaces/cgroups v2/seccomp/AppArmor/nftables, Hono control plane, PostgreSQL, systemd, WireGuard/Tailscale-compatible private routing.

## Global Constraints

- Do not begin overlapping Runner/API protocol edits until the uncommitted Task 8 work is preserved in a user-authorized checkpoint commit and its gates remain green.
- The API/database own authority, state, generation, deadlines, grants, terminal evidence, accepted usage, and audit.
- OCI runs only on the independent Linux execution node; never on the BaoTa control node and never as production proof through Docker Compose.
- The OCI process has a distinct identity, capacity, drain state, health, and deployment artifact from the WASI process.
- Runtime images are immutable `sha256:` digests; tags and mutable aliases are rejected.
- Rootless containerd and gVisor `io.containerd.runsc.v1` are mandatory. Docker Engine/socket and host containerd sockets are forbidden.
- Each invocation uses read-only root, non-root UID/GID, all capabilities dropped, no-new-privileges, private PID/mount/IPC/user/network namespaces, bounded tmpfs, and read-only input/output mounts.
- No host device/path/socket, cloud metadata, control-node management interface, or unrelated private route is reachable.
- CPU, memory, PID, file, byte, wall-time, output, concurrency, and cost limits are enforced outside the guest.
- Egress is denied by default and flows only through the runtime proxy.
- Claims, heartbeat, cancellation, terminalization, and retry remain generation-aware and idempotent.
- Never log raw invocation input, component/image bytes, capability tokens, storage keys, signed URLs, provider bodies, or guest secrets.
- Use `cargo +1.97.1`; do not terminate unrelated Cargo processes.
- Do not touch unrelated Docker containers; every test-created container/namespace must be removed.
- Do not modify protected files, use destructive Git commands, or run the full monorepo suite.
- Proposed commits require renewed user authorization.

---

## File Map

- `packages/db/migrations/20260728130000000_module_runner_nodes.sql`: node identity/profile/capacity/drain/attestation state.
- `apps/api/src/module-runtime/runner-nodes.*`: registration, heartbeat, scheduling eligibility, and drain authority.
- `packages/module-runtime-contracts/src/runner-node.ts`: strict node report contract.
- `apps/module-runner/src/executor.rs`: shared executor trait.
- `apps/module-runner/src/oci/*`: OCI validation, rootless containerd adapter, supervisor, evidence, and cleanup.
- `apps/module-runner/src/bin/openopc-module-oci-runner.rs`: independent OCI binary.
- `apps/module-runner/src/main.rs`: remains the WASI binary.
- `apps/developer-trust-worker/src/sandbox/oci-control.ts`: private verification adapter to the OCI Runner.
- `deploy/openopc-public-beta/execution-node/*`: rootless containerd/runsc, systemd, network, and private service configuration.
- `tests/public-beta/runtime-isolation/*`: real WASI/OCI authority, escape, and failure tests.

### Task 1: Persist Runner node identity, profiles, capacity, attestation, and drain state

**Files:**
- Create: `packages/module-runtime-contracts/src/runner-node.ts`
- Create: `packages/module-runtime-contracts/src/runner-node.test.ts`
- Modify: `packages/module-runtime-contracts/src/index.ts`
- Create: `packages/db/migrations/20260728130000000_module_runner_nodes.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Modify: `packages/db/src/module-runtime-schema.test.ts`
- Create: `packages/db/scripts/module-runner-node.integration.test.ts`
- Create: `apps/api/src/module-runtime/runner-nodes.ts`
- Create: `apps/api/src/module-runtime/runner-nodes.test.ts`
- Create: `apps/api/src/module-runtime/runner-nodes.drizzle.ts`

**Interfaces:**

```ts
export interface RunnerNodeReportV1 {
  schemaVersion:1; runnerId:string; nodeIdentity:string; softwareVersion:string;
  contractVersion:1; profiles:Array<{ runtimeKind:'wasi-component'|'oci-image'; profileName:string }>;
  capacity:number; active:number; attestationDigest:`sha256:${string}`;
  engine:{ wasmtime:'ready'|'unavailable'|'disabled'; oci:'ready'|'unavailable'|'disabled' };
  drain:boolean; reportedAt:string;
}
```

- [ ] **Step 1: Write failing contract/database/service tests**

Reject unknown keys, duplicate/unsorted profiles, capacity outside 1-256, active over capacity, invalid/stale report, identity change, attestation downgrade, OCI ready without exact profile, and drain set by Runner when server says drained. Assert composite account/runner identity, immutable registration history, server-owned drain revision, opaque cross-account behavior, and scheduling only when report is fresh and engine/profile/capacity match.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd packages/module-runtime-contracts; bun test src/runner-node.test.ts
cd ../db; bun test src/module-runtime-schema.test.ts scripts/module-runner-node.integration.test.ts
cd ../../apps/api; bun test src/module-runtime/runner-nodes.test.ts
```

Expected: FAIL because the node contract and persistence are absent.

- [ ] **Step 3: Implement registration and eligibility**

Add `module_runner_nodes` and append-only `module_runner_node_events`. Registration binds mTLS subject, runner UUID, account, node identity, contract/software, attestation, and permitted profiles. Heartbeat may update observed capacity/active/engine but cannot clear a server drain. A node becomes stale after 45 seconds and ineligible without deleting history.

- [ ] **Step 4: Run GREEN**

Run the RED commands plus `pnpm.cmd migrate:lint` and DB/API typechecks.

Expected: PASS; OCI work cannot schedule to a WASI-only or stale node.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/module-runtime-contracts packages/db apps/api/src/module-runtime/runner-nodes*
git commit -m "feat(runtime): register eligible runner nodes"
```

### Task 2: Extend claim scheduling with an exact Runner profile

**Files:**
- Modify after checkpoint: `apps/api/src/module-runtime/runner-protocol.ts`
- Modify after checkpoint: `apps/api/src/module-runtime/runner-protocol.test.ts`
- Modify after checkpoint: `apps/api/src/module-runtime/executions.drizzle.ts`
- Modify after checkpoint: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Modify: `packages/module-runtime-contracts/src/claim-bundle.ts`
- Modify: `packages/module-runtime-contracts/src/claim-bundle.test.ts`
- Modify: `packages/module-runtime-contracts/schema/claim-bundle.v1.schema.json`
- Modify after checkpoint: `apps/module-runner/src/protocol.rs`
- Modify after checkpoint: `apps/module-runner/tests/claim_bundle.rs`

**Interfaces:**
- Claim request adds `{ runnerId, nodeReportRevision, runtimeKind, profileName, availableSlots }`.
- Signed claim bundle adds `runnerId`, `nodeIdentity`, `runtimeKind`, `profileName`, and `nodeReportRevision` and retains existing execution/input/artifact/lease/grant bindings.

- [ ] **Step 1: Verify the Task 8 checkpoint and write failing scheduling tests**

Keep its exact claim-next semantics. Add cases for runtime/profile mismatch, stale node report revision, drained node, full capacity, wrong mTLS identity, attestation mismatch, OCI claim by WASI binary, and one compatible live node claiming the oldest compatible execution.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/module-runtime/runner-protocol.test.ts src/module-runtime/executions.drizzle.test.ts
cd ../../packages/module-runtime-contracts; bun test src/claim-bundle.test.ts
cd ../../apps/module-runner; cargo +1.97.1 test --test claim_bundle
```

Expected: FAIL on missing node/profile bindings.

- [ ] **Step 3: Implement profile-bound atomic claim**

The PostgreSQL claim query joins a fresh eligible node, filters exact runtime/profile, checks active leases below capacity, locks the oldest execution, increments generation, and returns a bundle signed with node/report bindings. Never trust the runtime kind supplied only by the claimant; compare it to its registered mTLS identity and node report.

- [ ] **Step 4: Run GREEN**

Run the RED commands and the Task 8 real two-Runner integration three times.

Expected: all pass; a mismatched binary never receives work.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/module-runtime packages/module-runtime-contracts apps/module-runner/src/protocol.rs apps/module-runner/tests/claim_bundle.rs
git commit -m "feat(runtime): bind claims to runner profiles"
```

### Task 3: Extract a shared executor boundary and add an independent OCI binary

**Files:**
- Create: `apps/module-runner/src/executor.rs`
- Modify: `apps/module-runner/src/lib.rs`
- Modify: `apps/module-runner/src/dispatcher.rs`
- Modify: `apps/module-runner/src/main.rs`
- Create: `apps/module-runner/src/bin/openopc-module-oci-runner.rs`
- Create: `apps/module-runner/tests/executor_boundary.rs`
- Modify: `apps/module-runner/Cargo.toml`

**Interfaces:**

```rust
#[async_trait::async_trait]
pub trait RuntimeExecutor: Send + Sync {
    fn runtime_kind(&self) -> RuntimeKind;
    fn profile_name(&self) -> &str;
    async fn execute(&self, claim: &VerifiedClaim, cancel: CancellationToken)
        -> Result<TerminalEvidence, ExecutionError>;
}
```

- [ ] **Step 1: Write failing binary/boundary tests**

Assert the WASI binary constructs only `WasiExecutor`, OCI binary only `OciExecutor`, configuration rejects mixed profiles, health reports the correct engine, dispatcher rejects a claim whose runtime/profile differs from its executor, and drain/shutdown semantics are shared.

- [ ] **Step 2: Run RED**

Run: `cd apps/module-runner; cargo +1.97.1 test --test executor_boundary`

Expected: FAIL because the trait and OCI binary are absent.

- [ ] **Step 3: Refactor without changing Task 8 dispatch semantics**

Move only the execution call behind `RuntimeExecutor`; leave signed claim verification, capacity semaphore, lease supervisor, artifact streaming, finalize retry, and shutdown order shared. Add two explicit `[[bin]]` targets: `openopc-module-wasi-runner` for `src/main.rs` and `openopc-module-oci-runner` for the new binary.

- [ ] **Step 4: Run GREEN and regression gates**

Run:

```powershell
cd apps/module-runner
cargo +1.97.1 fmt -- --check
cargo +1.97.1 test
cargo +1.97.1 clippy --all-targets --all-features -- -D warnings
```

Expected: all existing WASI/Task 8 tests remain green; OCI boundary tests pass before real OCI execution exists.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/module-runner
git commit -m "refactor(runner): split independent runtime executors"
```

### Task 4: Implement fixed-argument rootless containerd plus gVisor execution

**Files:**
- Create: `apps/module-runner/src/oci/mod.rs`
- Create: `apps/module-runner/src/oci/config.rs`
- Create: `apps/module-runner/src/oci/image.rs`
- Create: `apps/module-runner/src/oci/command.rs`
- Create: `apps/module-runner/src/oci/supervisor.rs`
- Create: `apps/module-runner/src/oci/evidence.rs`
- Create: `apps/module-runner/tests/oci_command.rs`
- Create: `apps/module-runner/tests/oci_execution.rs`

**Interfaces:**

```rust
pub trait ContainerRuntime: Send + Sync {
    async fn inspect_digest(&self, digest: &Sha256Digest) -> Result<ImageIdentity, OciError>;
    async fn run(&self, spec: &OciInvocationSpec, cancel: CancellationToken) -> Result<OciExit, OciError>;
    async fn delete(&self, invocation_id: &InvocationId) -> Result<(), OciError>;
}
```

- [ ] **Step 1: Write failing command-construction and supervisor tests**

Assert no shell, tag, arbitrary runtime, host network/PID/IPC/user namespace, privileged flag, device, host socket, writable bind, unbounded tmpfs, environment injection, newline/NUL, or caller-chosen container name. Assert fixed rootless address, namespace, `io.containerd.runsc.v1`, read-only root, non-root user, drop ALL, no-new-privileges, configured seccomp/AppArmor, pids/memory/cpu limits, bounded mounts, output cap, wall timeout, cancellation, and cleanup after every terminal path.

- [ ] **Step 2: Run RED**

Run: `cd apps/module-runner; cargo +1.97.1 test --test oci_command --test oci_execution`

Expected: FAIL because OCI implementation is absent.

- [ ] **Step 3: Implement `nerdctl` adapter without a shell**

Use `tokio::process::Command` with a fixed executable path and validated separate arguments. Address must match `/run/user/<configured-uid>/containerd/containerd.sock`; namespace is `openopc-modules`; runtime is `io.containerd.runsc.v1`. Inspect the resolved image and require its content digest to equal the descriptor. Stream bounded input through a read-only file and collect bounded output/evidence; send TERM then KILL on cancellation/deadline; always issue forced delete and remove scratch.

- [ ] **Step 4: Run GREEN**

Run the RED command, `cargo +1.97.1 fmt -- --check`, and Clippy with warnings denied.

Expected: PASS using a fake process adapter; real gVisor evidence comes later.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/module-runner/src/oci apps/module-runner/tests/oci_command.rs apps/module-runner/tests/oci_execution.rs apps/module-runner/Cargo.toml apps/module-runner/Cargo.lock
git commit -m "feat(runner): execute OCI through rootless gVisor"
```

### Task 5: Enforce proxy-only network and capability brokering

**Files:**
- Create: `apps/module-runner/src/oci/network.rs`
- Create: `apps/module-runner/tests/oci_network.rs`
- Modify: `apps/module-egress-proxy/src/policy.ts`
- Modify: `apps/module-egress-proxy/src/proxy.ts`
- Modify: `apps/module-egress-proxy/src/proxy.test.ts`
- Modify: `apps/api/src/module-runtime/capabilities.ts`
- Modify: `apps/api/src/module-runtime/capabilities.test.ts`

**Interfaces:**
- OCI receives only `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY=''`, and one execution-scoped broker reference.
- Egress grant binds execution, lease, generation, account, installation, release, allowed origin/method/bytes/redirects, expiry, and nonce.

- [ ] **Step 1: Write failing network/capability attack tests**

Test direct IP, DNS rebinding, alternative numeric IP encodings, IPv6, metadata IPs, private/control-node routes, proxy bypass, CONNECT, redirect to denied origin, response oversize, grant replay, stale generation, host header mismatch, and token leakage in errors/logs. Assert allowed HTTPS origin works only through proxy.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/module-runner; cargo +1.97.1 test --test oci_network
cd ../module-egress-proxy; bun test src/proxy.test.ts
cd ../api; bun test src/module-runtime/capabilities.test.ts
```

Expected: FAIL on absent OCI network binding and incomplete proxy-only enforcement.

- [ ] **Step 3: Implement dedicated network and signed grant checks**

The execution-node setup creates a rootless CNI network whose namespace policy permits DNS only to the controlled resolver and TCP only to the egress proxy. The proxy resolves and pins destinations, denies metadata/private/control networks before and after redirects, verifies signed execution grants against current lease generation, and enforces byte/method/origin ceilings.

- [ ] **Step 4: Run GREEN**

Run the RED commands again.

Expected: PASS; direct network attempts fail even if guest code ignores proxy variables.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/module-runner/src/oci/network.rs apps/module-runner/tests/oci_network.rs apps/module-egress-proxy apps/api/src/module-runtime/capabilities*
git commit -m "feat(runtime): enforce proxy only OCI egress"
```

### Task 6: Route trust sandbox OCI verification through the independent Runner

**Files:**
- Modify: `apps/developer-trust-worker/src/sandbox/oci-control.ts`
- Modify: `apps/developer-trust-worker/src/sandbox/oci-control.test.ts`
- Modify: `apps/developer-trust-worker/src/config.ts`
- Modify: `apps/developer-trust-worker/src/config.test.ts`
- Create: `apps/module-runner/src/oci/verification.rs`
- Create: `apps/module-runner/tests/oci_verification.rs`

**Interfaces:**
- Private operation `run-verification` binds run ID, artifact/image digest, profile digest, fixture digest, limits, broker URL, nonce, and expiry.
- Authentication uses distinct mTLS/service identity plus one-time signed control token; it is not the execution claim endpoint.

- [ ] **Step 1: Write failing trust/Runner integration tests**

Reject Docker socket endpoint, public endpoint, missing mTLS identity, expired/replayed token, mismatched profile/image/artifact/result digest, limit drift, direct network, and result counts/bytes over bounds. Assert cancellation deletes the container and returns deterministic inconclusive evidence.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/developer-trust-worker; bun test src/sandbox/oci-control.test.ts src/config.test.ts
cd ../module-runner; cargo +1.97.1 test --test oci_verification
```

Expected: FAIL because the real verification endpoint is absent.

- [ ] **Step 3: Implement the private adapter**

Expose the verification operation only on the private execution interface, validate both identities, call the same `OciExecutor` with a verification-specific profile/capability broker, and return bounded digested evidence. Scanner error, timeout, stale policy, or signature mismatch remains fail closed in the trust pipeline.

- [ ] **Step 4: Run GREEN**

Run the RED commands.

Expected: PASS and no test accepts a fake success-only transport as production readiness.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/developer-trust-worker/src apps/module-runner/src/oci/verification.rs apps/module-runner/tests/oci_verification.rs
git commit -m "feat(trust): verify OCI on independent runner"
```

### Task 7: Package the private execution node

**Files:**
- Create: `deploy/openopc-public-beta/execution-node/README.md`
- Create: `deploy/openopc-public-beta/execution-node/install-rootless-containerd.sh`
- Create: `deploy/openopc-public-beta/execution-node/containerd/config.toml`
- Create: `deploy/openopc-public-beta/execution-node/containerd/runsc.toml`
- Create: `deploy/openopc-public-beta/execution-node/systemd/openopc-wasi-runner.service`
- Create: `deploy/openopc-public-beta/execution-node/systemd/openopc-oci-runner.service`
- Create: `deploy/openopc-public-beta/execution-node/systemd/openopc-egress-proxy.service`
- Create: `deploy/openopc-public-beta/execution-node/systemd/openopc-trust-worker.service`
- Create: `deploy/openopc-public-beta/execution-node/network/apply-policy.sh`
- Create: `deploy/openopc-public-beta/execution-node/verify-execution-node.ts`
- Create: `deploy/openopc-public-beta/execution-node/verify-execution-node.test.ts`
- Create: `.github/workflows/module-oci-runner.yml`

**Interfaces:**
- Validator JSON includes OS/kernel/cgroups, rootless UID, containerd/nerdctl/runsc versions, runtime handler, socket ownership, service identities, listening addresses, private route, proxy policy digest, and test timestamp.

- [ ] **Step 1: Write failing configuration/workflow tests**

Assert rootless socket under `/run/user`, runsc runtime, no Docker dependency, no public listener, distinct system users/service credentials, `ProtectSystem=strict`, `PrivateTmp=true`, restricted address families/capabilities, restart limits, drain-before-stop, pinned install checksums/versions, workflow version pins, and no Compose substitution for real acceptance.

- [ ] **Step 2: Run RED**

Run: `bun test deploy/openopc-public-beta/execution-node/verify-execution-node.test.ts`

Expected: FAIL because execution-node artifacts are absent.

- [ ] **Step 3: Implement idempotent provisioning and validation**

Scripts install pinned containerd/nerdctl/runsc only after checksum verification, create an unprivileged service account, configure the user service socket/runtime/network, install distinct systemd units, and refuse to start OCI Runner when gVisor/rootless/network validation fails. Private-route choice is operator input; it must not add a default public route to Runner control endpoints.

- [ ] **Step 4: Run GREEN**

Run the RED command and a shell syntax check for every new script.

Expected: PASS locally; a real Linux execution node is still required for acceptance.

- [ ] **Step 5: Commit boundary**

```powershell
git add deploy/openopc-public-beta/execution-node .github/workflows/module-oci-runner.yml
git commit -m "ops(runtime): package private OCI execution node"
```

### Task 8: Prove real OCI isolation, node loss, and cleanup

**Files:**
- Create: `tests/public-beta/runtime-isolation/run.ts`
- Create: `tests/public-beta/runtime-isolation/run.test.ts`
- Create: `tests/public-beta/runtime-isolation/fixtures/Containerfile`
- Create: `tests/public-beta/runtime-isolation/fixtures/escape-probes.sh`
- Create: `tests/public-beta/runtime-isolation/fixtures/network-probes.sh`
- Extend: `packages/db/scripts/module-runner-dispatch.integration.test.ts`

**Interfaces:**
- Scenario IDs: `clean`, `non-root`, `readonly-root`, `capabilities`, `namespaces`, `host-path`, `socket`, `metadata`, `private-route`, `proxy-allow`, `proxy-deny`, `cpu`, `memory`, `pids`, `files`, `output`, `deadline`, `cancel`, `node-loss`, `stale-lease`, `cleanup`.

- [ ] **Step 1: Write failing acceptance-runner contract tests**

Require a real private Runner URL, gVisor runtime proof, containerd namespace listing before/after, exact commit/environment, mTLS identity, raw guest output digests, host-side evidence, and zero residue. Reject Docker/default-runc/mock engine, localhost staging, missing escape probe, or assertion-only fixture.

- [ ] **Step 2: Run RED**

Run: `bun test tests/public-beta/runtime-isolation/run.test.ts`

Expected: FAIL because the acceptance runner is absent.

- [ ] **Step 3: Implement the real scenario runner**

Publish a digest-addressed malicious test release, schedule it through the real API/claim path, observe execution through independent OCI Runner, verify each denial from guest and host, interrupt the node during a lease, restart it, and verify controlled retry/exact terminalization. List rootless containerd tasks/containers/snapshots and scratch directories after every scenario; fail on residue.

- [ ] **Step 4: Run local contracts and real staging lanes**

Local:

```powershell
bun test tests/public-beta/runtime-isolation/run.test.ts
cd apps/module-runner; cargo +1.97.1 test; cargo +1.97.1 clippy --all-targets --all-features -- -D warnings
git diff --check
```

Staging: run `public-beta-g6-oci` and `public-beta-b5-runtime-isolation` once for the candidate commit. Preserve any failure and repair its root cause before a new candidate run.

- [ ] **Step 5: Commit boundary**

```powershell
git add tests/public-beta/runtime-isolation packages/db/scripts/module-runner-dispatch.integration.test.ts
git commit -m "test(beta): prove independent OCI isolation"
```

## OCI and Execution-Node Completion Gate

- OCI claims reach only a fresh, attested, exact-profile independent Runner.
- The production binary uses rootless containerd plus gVisor and no Docker/host socket.
- Every resource, namespace, mount, capability, network, cancellation, and cleanup probe is enforced externally.
- Trust verification uses the same isolated engine through a distinct private authority.
- Node loss preserves control-plane availability and exact terminal/usage behavior.
- G6 and B5 have real, commit-bound staging evidence with zero residue.
