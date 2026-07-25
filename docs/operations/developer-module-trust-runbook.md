# Developer Module Trust Runbook

**Status:** pre-enable operational contract

**Scope:** OpenOPC Developer Center schema-v2 artifact verification and trust evidence

This runbook covers the disabled-by-default developer trust worker and the API gate for code-bearing module submissions. It does not authorize production deployment, arbitrary production module execution, metering, settlement, or production KMS use.

## Current Activation Boundary

The checked-in worker image is intentionally fail-closed. Its process exposes health and readiness endpoints, but the current `main.ts` mounts unavailable placeholders for artifact storage, policy, scanners, sandbox control, and database claims. Consequently:

- `/healthz` can return `200` while the process is alive;
- `/readyz` returns `503` while the worker is disabled or any required adapter is unavailable;
- `DEVELOPER_TRUST_ENABLED=true` alone does not make the worker ready;
- code-bearing submission remains blocked unless the API also sees an explicit ready response;
- existing Kortix behavior and declarative module reads remain available while both feature flags are off.

Do not enable either feature flag until concrete runtime adapters are composed and every acceptance gate in `developer-module-trust-progress.md` has fresh passing evidence.

## Deployment Topology

The API remains the authenticated control plane. The trust worker is a separate process with no public port and no Docker socket.

```text
Internet
  -> Web / API reverse proxy
       -> kortix-api
            -> internal readiness request
                 -> developer-trust-worker:8080
                      -> artifact store adapter
                      -> developer_trust_worker database role
                      -> pinned scanner processes or images
                      -> narrow sandbox control adapter
                      -> optional validation egress proxy
```

Compose places the worker only on these internal networks:

- `developer-trust-artifacts`
- `developer-trust-db`
- `developer-trust-sandbox-control`

The API shares only `developer-trust-sandbox-control`, which carries the readiness request. Scanner and sandbox ports must never be published by Compose or a BaoTa reverse proxy.

## Required Configuration

Keep secrets in the deployment environment or secret manager. Do not commit private keys, database URLs, object-store credentials, signed URLs, or scanner credentials.

### API

| Variable | Required value before activation | Notes |
| --- | --- | --- |
| `DEVELOPER_TRUST_ENABLED` | `false` until final activation | Enables the API readiness client only when exactly `true`. |
| `DEVELOPER_CODE_MODULES_ENABLED` | `false` until the worker is ready | This is the final code-bearing submission switch. |
| `DEVELOPER_TRUST_READINESS_URL` | Internal `http://developer-trust-worker:8080/readyz` or equivalent | Must not contain credentials or redirect. |
| `OPENOPC_PLATFORM_VERSION` | Deployed OpenOPC version | Included in the trust binding. |

### Worker process

| Variable | Constraint |
| --- | --- |
| `DEVELOPER_TRUST_ENABLED` | Exact `true` or `false`; default is disabled. |
| `DEVELOPER_TRUST_PORT` | Integer from 1 through 65535; internal default is 8080. |
| `DEVELOPER_TRUST_WORKER_ID` | Stable 1-128 character worker identity. |
| `DEVELOPER_TRUST_LEASE_MS` | Integer from 5000 through 300000. |
| `DEVELOPER_TRUST_POLICY_JSON` | Schema-1 immutable policy JSON, at most 1 MiB. |
| `DEVELOPER_TRUST_EVIDENCE_PRIVATE_KEY` | Ed25519 private key material supplied through a secret mount, at most 64 KiB. |
| `DEVELOPER_TRUST_EVIDENCE_KEY_ID` | Stable key identifier, at most 256 characters. |
| `DEVELOPER_TRUST_EVIDENCE_ISSUER` | Stable issuer identifier, at most 256 characters. |

These configuration values validate policy and evidence identity. Separate runtime adapter wiring for object storage, database claims, scanners, sandbox control, and egress remains a prerequisite and is not supplied by setting these variables.

## Artifact Storage

Use an S3-compatible private bucket or MinIO reachable only from the artifact network.

1. Deny public bucket and object access.
2. Use account-qualified staging and canonical object prefixes.
3. Limit upload size and signed-upload lifetime at both the API and object store.
4. Require checksum and byte-count verification before finalization.
5. Enable server-side encryption and provider audit logs.
6. Deny listing or cross-account existence probes through the public API.
7. Apply a short lifecycle policy to abandoned staging objects only.
8. Never delete a canonical artifact while a release, run, attestation, installation, or audit record references it.

For local self-host validation, MinIO may be attached to `developer-trust-artifacts`. Its API and console must bind to loopback or remain internal; neither belongs behind the public application proxy.

## Policy and Scanner Identities

The immutable policy must contain the exact executable or image identity, digest, version, timeout, and output limit for:

- Gitleaks
- Syft with CycloneDX 1.6 output
- OSV-Scanner with a pinned advisory snapshot
- Semgrep with a pinned rule pack
- license policy

At startup, resolve each configured identity and compare it to the policy digest. A missing executable, mutable tag, identity mismatch, stale advisory snapshot, malformed output, timeout, crash, or truncated result makes readiness unavailable or the run inconclusive. It never becomes passed evidence.

Scanner subprocess environments must use an allowlist. Do not forward the worker environment, evidence key, object-store credential, database credential, or platform secrets.

## Database Role and Claims

Use the migration-created `developer_trust_worker` role through a dedicated login or workload identity. The role may claim and heartbeat verification runs and append bounded findings and terminal evidence. It must not receive access to account membership, project content, Secrets, Connectors, sessions, billing, provider credentials, or ordinary application mutation tables.

Monitor lease age, heartbeat age, stale claims, duplicate attempts, and terminal evidence transaction failures. A stale worker cannot finalize after its lease fence expires.

## Sandbox Control and Egress

The worker must call a narrow sandbox control adapter. Never mount `/var/run/docker.sock`, a Docker Engine pipe, or a Kubernetes administrator credential into the worker.

Validation containers require:

- non-root UID/GID;
- read-only root and artifact mounts;
- isolated `tmpfs` scratch space;
- all capabilities dropped and no privilege escalation;
- PID, CPU, memory, file-count, byte-count, and time limits;
- no project, account, Secret, Connector, billing, provider, desktop, or ordinary sandbox token;
- only a short-lived verification capability for synthetic fixtures.

Network is denied by default. When a policy permits network tests, route HTTPS through the validation egress proxy. The proxy performs DNS resolution, blocks private/loopback/link-local/metadata and rebinding destinations, strips credentials, enforces origin/method/byte limits, and stores only sanitized origin-level evidence.

## Readiness Interpretation

| Result | Operator meaning |
| --- | --- |
| `/healthz` `200` | The HTTP process is alive only. |
| `/readyz` `503`, `enabled=false` | Expected disabled state. Existing Kortix reads must remain unaffected. |
| `/readyz` `503`, component `unavailable` | Dependency cannot be reached or runtime adapter is absent. Do not enable code modules. |
| `/readyz` `503`, policy `invalid` | Policy JSON, digest, scanner identity, or signing configuration is invalid. |
| `/readyz` `503`, scanner `identity_mismatch` | Resolved binary/image does not match the immutable policy. |
| `/readyz` `200`, `enabled=true`, `ready=true` | All required components passed the current readiness check. This is necessary but not sufficient for production activation. |

Probe from the API network, not through a public proxy:

```sh
curl --fail http://developer-trust-worker:8080/healthz
curl --fail http://developer-trust-worker:8080/readyz
```

The second command is expected to fail while disabled.

## Activation Sequence

1. Back up the database and verify restore on a disposable target.
2. Apply migrations twice and verify the second run is idempotent.
3. Prove the schema-v1 reset guard in a disposable database.
4. Configure private artifact storage, worker database identity, pinned policy/scanners, sandbox control, and egress proxy.
5. Start the worker with both API flags still false.
6. Require component-level readiness and run a clean synthetic fixture plus every blocking fixture.
7. Set API `DEVELOPER_TRUST_ENABLED=true`; confirm declarative reads still work and code modules remain blocked.
8. Set `DEVELOPER_CODE_MODULES_ENABLED=true` only after the evidence ledger is complete and a separate deployment is authorized.
9. Monitor queue age, failures, inconclusive results, lease recovery, object cleanup backlog, and audit events.

No step in this repository plan authorizes production activation.

## Queue Drain, Retry, and Cancel

For planned maintenance:

1. Keep API trust enabled for reads but set `DEVELOPER_CODE_MODULES_ENABLED=false` to stop new code-bearing submissions.
2. Wait until no active run remains in `queued` or `running`, or cancel non-terminal work through the authenticated Admin verification action.
3. Stop workers only after heartbeats cease and active leases expire or are explicitly cancelled.
4. Preserve all terminal runs, findings, and attestations.

A publisher retry uses the account-scoped release verification-retry endpoint; Admin may retry or cancel according to the verification service policy. Retry always creates a new attempt. Never edit or replace an earlier attempt, finding, SBOM, or attestation.

Upload cancellation deletes staging data on a best-effort basis and changes the upload state. It does not delete a finalized canonical artifact.

## Cleanup and Retention

- Remove expired, cancelled, and never-finalized staging objects after the configured grace period.
- Reconcile object deletion failures from a durable cleanup backlog.
- Retain canonical artifacts, immutable attempts, findings, attestations, release events, installation history, and revocation events according to audit policy.
- Sanitize logs before retention. Never retain raw source, artifact bytes, stdout/stderr bodies, tokens, signed URLs, private keys, or unredacted scanner output in logs.

## Evidence Key Rotation

1. Add a new key ID and verification public key before use.
2. Keep old public keys available for historical verification.
3. Route new attestations to the new private key without rewriting old evidence.
4. Re-run a clean fixture and verify DSSE/in-toto subject, policy, scanner, sandbox, and SBOM digests.
5. Revoke a compromised key ID and require new attempts for affected unsigned releases.
6. Never claim production KMS coverage from file- or environment-backed development keys.

## BaoTa Placement

Use BaoTa only as the host-level Compose and reverse-proxy manager:

- proxy public Web and API routes only;
- do not add worker, scanner, MinIO, PostgreSQL, sandbox control, capability broker, or egress-proxy ports to the public site;
- keep API-to-worker readiness on the internal Compose network;
- store environment secrets outside the repository and restrict file permissions;
- take database and object-store backups before migration or rollback.

## Rollback

If readiness degrades or trust evidence is suspect:

1. Set `DEVELOPER_CODE_MODULES_ENABLED=false` immediately.
2. Set API and worker `DEVELOPER_TRUST_ENABLED=false` if the incident affects trust reads or worker integrity.
3. Drain or cancel active verification runs; do not convert them to passed.
4. Preserve artifacts, attempts, findings, attestations, and audit logs.
5. Roll back application images to the last known version only after checking database compatibility.
6. Do not roll back the schema by deleting trust columns or restoring schema-v1 signatures. This project intentionally has no v1 compatibility path.
7. Restore from a verified backup only when data integrity requires it.

Existing declarative reads and normal Kortix project, session, IAM, billing, Marketplace, installation, update, rollback, and revocation paths must remain available while trust submission is disabled.
