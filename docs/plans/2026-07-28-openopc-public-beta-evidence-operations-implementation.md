# OpenOPC Public-Beta Evidence and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy OpenOPC as a reproducible BaoTa control node plus private execution node and produce fresh, commit-bound, machine-verifiable `G1-G12` and `B1-B10` evidence for a human public-beta decision.

**Architecture:** Evidence v2 is a new strict ledger and does not mutate the protected module-beta fixture. Versioned Web, Admin, API, workers, Runners, and Desktop artifacts share one release commit and provenance manifest. BaoTa/Nginx exposes only Web, Admin, API, and immutable module origins; private services and the execution node remain on private routes. OpenTelemetry, backup/PITR/object restore, staged failure drills, and protected approval are first-class Gates.

**Tech Stack:** TypeScript, Bun, JSON Schema 2020-12, GitHub Actions, Docker/OCI artifacts, BaoTa Nginx, systemd, PostgreSQL WAL/PITR, S3/MinIO versioning, OpenTelemetry/OTLP, Prometheus-compatible metrics, SHA-256, CycloneDX, DSSE/in-toto.

## Global Constraints

- Canonical staging environment ID is `openopc-public-beta-staging`.
- Default evidence age is 72 hours. B10 expires after 24 hours. B7 restore may be seven days old only for the same schema/artifact set and with a fresh 24-hour post-restore consistency smoke.
- A required Gate is invalid when not run, stale, another commit, another environment, missing canonical lane, missing raw artifacts/digests, or based only on a self-created fixture.
- Failed/blocked attempts remain retained. A later pass must bind the fix and may not erase the first failure.
- Existing `tests/module-beta/evidence.json` is protected and unchanged. Evidence v2 uses `tests/public-beta/` fixtures and `artifacts/public-beta/` runtime output.
- Web, Admin, API, every worker, WASI/OCI Runner, and Desktop are independent versioned artifacts bound to one commit and rollback target.
- Nginx is the only public ingress. PostgreSQL, object storage/queue administration, Runner control, trust worker, containerd, gVisor, and Docker sockets have no public listener.
- Web/Admin do not require Desktop. The module wildcard host receives no platform cookie.
- Hosted secrets use KMS envelope encryption; self-hosted deployment uses a typed secret provider and never stores plaintext secrets in the database or repository.
- Logs/traces/errors/findings/audit redact keys, bearer tokens, cookies, credentials, signed URLs, and detected prompt secrets.
- OpenTelemetry correlation crosses asynchronous hops without exposing another tenant's identifiers.
- RPO is at most 15 minutes and RTO at most four hours, proven by an isolated restore.
- Production approval is human and protected; code/staging cannot substitute for regional filing, privacy, content, or incident-notification prerequisites.
- Preserve dirty Task 8 work until checkpoint. Do not modify protected files, use destructive Git commands, touch unrelated containers, or run the full monorepo suite.
- Proposed commits require renewed user authorization.

---

## File Map

- `tests/public-beta/evidence.v2.schema.json`: strict evidence ledger schema.
- `tests/public-beta/evidence.fixture.json`: deterministic invalid/not-ready fixture, never staging proof.
- `scripts/release/public-beta-evidence-v2.ts`: parser, freshness, Gate/lane, artifact, failure-history, and commit validator.
- `scripts/release/public-beta-evidence-v2.test.ts`: exact validation cases.
- `.github/workflows/openopc-public-beta-gates.yml`: canonical `G1-G12`/`B1-B10` orchestration.
- `deploy/openopc-public-beta/control-node/*`: BaoTa control-plane images, Nginx rendering, service config, and verification.
- `deploy/openopc-public-beta/execution-node/*`: produced by the OCI/two-node plan.
- `packages/telemetry-contracts/*`: correlation and redaction contracts.
- `deploy/openopc-public-beta/observability/*`: collector, dashboards, alerts, and failure drill.
- `deploy/openopc-public-beta/backup/*`: backup, PITR/object restore, and consistency verification.
- `scripts/release/public-beta-artifacts.ts`: artifact digest/SBOM/provenance manifest.
- `scripts/release/public-beta-prerequisites.ts`: policy and regional evidence validator.
- `docs/runbooks/*`: deploy, rollback, incident, backup/restore, and secrets runbooks.

### Task 1: Define evidence v2 without changing module-beta evidence v1

**Files:**
- Create: `tests/public-beta/evidence.v2.schema.json`
- Create: `tests/public-beta/evidence.fixture.json`
- Create: `scripts/release/public-beta-evidence-v2.ts`
- Create: `scripts/release/public-beta-evidence-v2.test.ts`
- Modify: `package.json`
- Do not modify: `tests/module-beta/evidence.json`
- Do not modify: `scripts/release/module-beta-targets.ts`

**Interfaces:**

```ts
export type PublicBetaGateId = `G${1|2|3|4|5|6|7|8|9|10|11|12}` | `B${1|2|3|4|5|6|7|8|9|10}`;
export interface PublicBetaEvidenceArtifactV2 {
  path:string; digest:`sha256:${string}`; sizeBytes:number; mediaType:string;
}
export interface PublicBetaEvidenceRecordV2 {
  id:string; gate:PublicBetaGateId; lane:string; attempt:number;
  environment:'openopc-public-beta-staging'; commit:string; command:string;
  workflow:{ repository:string; workflow:string; runId:string; runAttempt:number };
  startedAt:string; finishedAt:string; expiresAt:string;
  outcome:'passed'|'failed'|'blocked'; stagingUrls:string[];
  dependencyIdentities:string[]; artifacts:PublicBetaEvidenceArtifactV2[];
  rawEvidencePaths:string[]; resolvesFailureIds:string[]; companionEvidenceIds:string[];
}
export interface PublicBetaEvidenceLedgerV2 {
  schemaVersion:2; candidateCommit:string; environment:'openopc-public-beta-staging';
  schemaDigest:`sha256:${string}`; artifactSetDigest:`sha256:${string}`;
  records:PublicBetaEvidenceRecordV2[];
}
```

- [ ] **Step 1: Write failing exact-schema and freshness tests**

Reject excess/missing keys, `not-run`, invalid outcome, unknown Gate/lane, duplicate IDs/attempts, non-40-hex candidate commit, passed record on another commit/environment, timestamp inversion, manually extended expiry, missing raw artifact/digest/dependency identity, localhost/prod URL, empty command, and unretained failure. Test default 72-hour expiry, B10 24-hour expiry, and B7 seven-day exception only with same schema/artifact digests plus a fresh 24-hour companion smoke.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-evidence-v2.test.ts`

Expected: FAIL because the v2 validator is absent.

- [ ] **Step 3: Implement exact validation and deterministic CLI**

```ts
export function validatePublicBetaEvidenceLedgerV2(
  value:unknown,
  options:{ now:Date; expectedCommit:string; verifyArtifact(path:string,digest:string,size:number):boolean },
):PublicBetaEvidenceLedgerV2;
```

Canonical lanes are hard-coded, not caller-selected. A required passing record is the newest valid passed attempt for its Gate/lane/candidate commit. Any retained failed/blocked record that claims resolution must be referenced by a later record and a digested fix artifact. CLI `pnpm.cmd public-beta:evidence:validate --ledger <path> --commit <sha> --now <RFC3339>` emits one JSON result and exits `0` only when all Gates are current.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
bun test scripts/release/public-beta-evidence-v2.test.ts
pnpm.cmd public-beta:evidence:validate --ledger tests/public-beta/evidence.fixture.json --commit 0000000000000000000000000000000000000000 --now 2026-07-28T00:00:00Z
git diff -- tests/module-beta/evidence.json scripts/release/module-beta-targets.ts
```

Expected: tests pass; fixture command exits nonzero as not ready; protected v1 diff is empty.

- [ ] **Step 5: Commit boundary**

```powershell
git add tests/public-beta/evidence.v2.schema.json tests/public-beta/evidence.fixture.json scripts/release/public-beta-evidence-v2.ts scripts/release/public-beta-evidence-v2.test.ts package.json
git commit -m "feat(release): add strict public beta evidence v2"
```

### Task 2: Encode exact Gate lanes, ownership, dependencies, and artifact requirements

**Files:**
- Create: `scripts/release/public-beta-lanes.ts`
- Create: `scripts/release/public-beta-lanes.test.ts`
- Modify: `scripts/release/public-beta-evidence-v2.ts`
- Modify: `scripts/release/public-beta-program.ts`

**Interfaces:**
- Canonical lanes are exactly:

```text
public-beta-g1-migration
public-beta-g2-artifact-storage
public-beta-g3-trust-pipeline
public-beta-g4-malicious-fixtures
public-beta-g5-wasi
public-beta-g6-oci
public-beta-g7-ui-capability
public-beta-g8-tenant-authority
public-beta-g9-sandbox-commerce
public-beta-g10-release-lifecycle
public-beta-g11-web-desktop
public-beta-g12-upstream-compatibility
public-beta-b1-registration
public-beta-b2-web-independence
public-beta-b3-admin-isolation
public-beta-b4-module-workflow
public-beta-b5-runtime-isolation
public-beta-b6-sandbox-ledger
public-beta-b7-backup-recovery
public-beta-b8-telemetry-incident
public-beta-b9-brand-upstream
public-beta-b10-two-node-deployment
```

- [ ] **Step 1: Write failing registry tests**

For each Gate assert exact lane, owning child plan, workflow job ID, required services, required artifacts, maximum age, whether visible browser/packaged/real dependency/production approval evidence is required, and dependency Gates. Assert no cycle and every Gate in program ownership matches this registry.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-lanes.test.ts scripts/release/public-beta-program.test.ts`

Expected: FAIL because the lane registry is absent.

- [ ] **Step 3: Implement immutable lane metadata**

Represent each lane as a frozen object. G1 requires real PostgreSQL/backup/restore; G2 real private object storage; G3 pinned scanners/provenance; G4 malicious fixtures; G5 real Wasmtime; G6 real rootless containerd/runsc; G7 real cross-origin browser; G9/B6 real PostgreSQL/API/worker; G11 packaged Desktop and responsive Web; G12 upstream rehearsal; B7 isolated restore; B10 public exposure/TLS/realtime/private dependency scan.

- [ ] **Step 4: Run GREEN**

Run the RED command.

Expected: PASS with 22 unique Gate/lane records.

- [ ] **Step 5: Commit boundary**

```powershell
git add scripts/release/public-beta-lanes* scripts/release/public-beta-evidence-v2.ts scripts/release/public-beta-program.ts
git commit -m "test(release): lock public beta lane ownership"
```

### Task 3: Create the canonical Gate workflow without weakening assertions

**Files:**
- Create: `.github/workflows/openopc-public-beta-gates.yml`
- Create: `.github/workflows/openopc-public-beta-gate-runner.yml`
- Create: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: existing workflows only to publish reusable versioned artifacts, not to rename their existing lanes.

**Interfaces:**
- Manual input: `candidate_commit`, `staging_environment_id`, and approved staging URLs.
- Output artifact: `openopc-public-beta-evidence-<commit>` containing raw outputs, digests, and ledger v2.

- [ ] **Step 1: Write failing workflow security/coverage tests**

Parse both workflows and assert all 22 canonical job IDs, environment equality, SHA checkout, read-only default permissions, per-job minimal escalations, pinned actions, no `pull_request_target`, no untrusted script from artifacts, no continue-on-error for required Gate commands, failure artifact upload with `if: always()`, exact commit propagation, and final v2 validation.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-workflow-contract.test.ts`

Expected: FAIL because workflows are absent.

- [ ] **Step 3: Implement orchestration and reusable raw-evidence wrapper**

Each canonical job calls the owning plan's named runner and uploads stdout/stderr/JUnit/browser traces/screenshots/SQL results/node reports as appropriate. The wrapper records start/end/outcome even on failure, computes every artifact digest, and appends without deleting prior attempts. Expensive lanes use explicit dependencies, never a skipped-success fallback.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-lanes.test.ts`

Expected: PASS with exact 22-job coverage.

- [ ] **Step 5: Commit boundary**

```powershell
git add .github/workflows/openopc-public-beta-gates.yml .github/workflows/openopc-public-beta-gate-runner.yml scripts/release/public-beta-workflow-contract.test.ts
git commit -m "ci(beta): orchestrate canonical public beta gates"
```

### Task 4: Package the BaoTa control node and strict Nginx ingress

**Files:**
- Create: `deploy/openopc-public-beta/control-node/README.md`
- Create: `deploy/openopc-public-beta/control-node/release-compose.yml`
- Create: `deploy/openopc-public-beta/control-node/release.env.schema.json`
- Create: `deploy/openopc-public-beta/control-node/render-nginx.ts`
- Create: `deploy/openopc-public-beta/control-node/render-nginx.test.ts`
- Create: `deploy/openopc-public-beta/control-node/nginx/openopc.conf.template`
- Create: `deploy/openopc-public-beta/control-node/verify-control-node.ts`
- Create: `deploy/openopc-public-beta/control-node/verify-control-node.test.ts`
- Modify: Web/Admin/API/worker Dockerfiles only where independent artifacts are missing.

**Interfaces:**
- Config requires explicit `appHost`, `adminHost`, `apiHost`, `moduleHostSuffix`, TLS certificate paths, private dependency endpoints, execution private CIDRs, artifact digests, and release commit.
- Control Compose includes Web, Admin, API, control-plane workers, ledger worker, module host, and telemetry agent; it never includes WASI/OCI Runner, containerd, runsc, or trust sandbox execution.

- [ ] **Step 1: Write failing render/deployment contract tests**

Assert four disjoint host routes, TLS only, websocket/realtime upgrade only on API, Web `/admin` 404, Admin consumer routes 404, wildcard module host has no platform cookie, host-only Web/Admin cookies, request size/time limits, security headers, no Host-header authority, no public database/object/queue/Runner port, health endpoints, artifact digest pins, and rollback manifest. Reject shared image tags and `latest`.

- [ ] **Step 2: Run RED**

Run: `bun test deploy/openopc-public-beta/control-node/render-nginx.test.ts deploy/openopc-public-beta/control-node/verify-control-node.test.ts`

Expected: FAIL because control-node assets are absent.

- [ ] **Step 3: Implement deterministic render and service topology**

Render a concrete Nginx file from validated JSON; never interpolate raw directives. Map app/admin/api hosts to independent services and `<digest>.modules.<suffix>` to module-host. Bind PostgreSQL/object/queue and all container ports to a private Docker network or loopback only. The release file uses digest-pinned images and reads secret file paths, not values.

- [ ] **Step 4: Run GREEN**

Run the RED command, render the example config, and run `nginx -t` in a disposable test container named with `openopc-public-beta-nginx-<random>`; remove it and prove zero matching residue.

Expected: contract tests and Nginx syntax pass.

- [ ] **Step 5: Commit boundary**

```powershell
git add deploy/openopc-public-beta/control-node
git commit -m "ops(beta): package BaoTa control node ingress"
```

### Task 5: Implement secret-provider, artifact, SBOM, and provenance boundaries

**Files:**
- Create: `scripts/release/public-beta-artifacts.ts`
- Create: `scripts/release/public-beta-artifacts.test.ts`
- Create: `tests/public-beta/release-artifacts.schema.json`
- Create: `deploy/openopc-public-beta/control-node/secrets/README.md`
- Create: `deploy/openopc-public-beta/control-node/secrets/validate-secret-files.ts`
- Create: `deploy/openopc-public-beta/control-node/secrets/validate-secret-files.test.ts`
- Create: `docs/runbooks/openopc-secrets.md`
- Modify: build workflows to emit CycloneDX SBOM and DSSE/in-toto provenance.

**Interfaces:**

```ts
export interface PublicBetaArtifactManifestV1 {
  schemaVersion:1; commit:string;
  artifacts:Array<{ name:string; digest:`sha256:${string}`; sbomDigest:`sha256:${string}`; provenanceDigest:`sha256:${string}`; mediaType:string }>;
  manifestDigest:`sha256:${string}`;
}
```

- [ ] **Step 1: Write failing artifact/secret tests**

Assert required independent artifacts, same commit, immutable digests, SBOM/provenance/signature binding, no tag-only image, no missing worker, and no Desktop mismatch. Secret validator rejects repo paths, world/group readable files, symlinks, plaintext `.env` values, missing KMS/self-host provider identity, master credentials passed to Runner, and secret-shaped log output.

- [ ] **Step 2: Run RED**

Run:

```powershell
bun test scripts/release/public-beta-artifacts.test.ts
bun test deploy/openopc-public-beta/control-node/secrets/validate-secret-files.test.ts
```

Expected: FAIL because validators are absent.

- [ ] **Step 3: Implement canonical artifact and secret-file validation**

Build manifest includes Web, Admin, API, module host, each worker, WASI Runner, OCI Runner, and Windows Desktop. Self-hosted secret files must be owned by the deployment identity, mode 0400/0600, outside repo/web roots, and referenced through typed config; hosted mode records KMS key/provider identity but no secret ciphertext/plaintext in evidence. Use pinned SBOM/scanner/provenance tools.

- [ ] **Step 4: Run GREEN**

Run the RED commands and the secret-redaction focused tests in API/workers/Runners.

Expected: PASS; fixture secrets never appear in captured output.

- [ ] **Step 5: Commit boundary**

```powershell
git add scripts/release/public-beta-artifacts* tests/public-beta/release-artifacts.schema.json deploy/openopc-public-beta/control-node/secrets docs/runbooks/openopc-secrets.md .github/workflows
git commit -m "build(beta): bind artifacts secrets and provenance"
```

### Task 6: Propagate tenant-safe OpenTelemetry correlation and actionable signals

**Files:**
- Create: `packages/telemetry-contracts/package.json`
- Create: `packages/telemetry-contracts/tsconfig.json`
- Create: `packages/telemetry-contracts/src/index.ts`
- Create: `packages/telemetry-contracts/src/index.test.ts`
- Modify: `apps/api/src/lib/otel.ts`
- Instrument: module API, outbox, trust worker, ledger worker, egress proxy, WASI/OCI Runner, Web, and Admin boundaries.
- Create: `deploy/openopc-public-beta/observability/otel-collector.yaml`
- Create: `deploy/openopc-public-beta/observability/dashboards/public-beta.json`
- Create: `deploy/openopc-public-beta/observability/alerts/public-beta.yml`
- Create: `deploy/openopc-public-beta/observability/verify-telemetry.ts`
- Create: `deploy/openopc-public-beta/observability/verify-telemetry.test.ts`

**Interfaces:**
- `CorrelationContextV1 = { correlationId: uuid; traceparent: string; tracestate?: string }`.
- Async payloads store correlation/trace context separately from tenant display identifiers; public logs use hashed tenant partition labels.

- [ ] **Step 1: Write failing propagation/redaction/alert tests**

Trace one user task and module execution across Web/API/execution input/claim/Runner/finalize/outbox/usage/ledger/statement. Reject invalid trace headers, cross-tenant baggage, secret attributes, unbounded labels, missing async links, and broken correlation. Assert metrics/alerts for auth decisions, API latency, queue age, leases/retries/cancel, runtime capacity/isolation, trust policy age, model/provider usage/cost, outbox/ledger lag/imbalance, statements, storage, signed delivery, dead letters, and node loss.

- [ ] **Step 2: Run RED**

Run: `bun test packages/telemetry-contracts/src/index.test.ts deploy/openopc-public-beta/observability/verify-telemetry.test.ts`

Expected: FAIL because contracts/config are absent.

- [ ] **Step 3: Implement W3C propagation, low-cardinality metrics, and redaction**

Use package name `@openopc/telemetry-contracts` with `test` and `typecheck` scripts. Use existing API/Rust OTel libraries and the shared strict TypeScript contract. Create spans at authority transitions, links for async deliveries, and metrics with bounded runtime/profile/outcome labels. Never attach raw account/project/user IDs, prompts, tokens, signed URLs, or provider bodies. Alert ledger imbalance immediately and oldest queue/outbox age before SLO exhaustion.

- [ ] **Step 4: Run GREEN**

Run focused tests for the contract and each touched service, then validate collector/dashboard/alert files.

Expected: PASS with one synthetic end-to-end trace graph and redaction proof. B8 still requires real staging telemetry.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/telemetry-contracts apps/api apps/module-ledger-worker apps/module-egress-proxy apps/module-runner apps/developer-trust-worker apps/web apps/admin deploy/openopc-public-beta/observability pnpm-lock.yaml
git commit -m "feat(observability): trace public beta async workflows"
```

### Task 7: Prove backup, PITR, object restore, RPO, RTO, and consistency

**Files:**
- Create: `deploy/openopc-public-beta/backup/README.md`
- Create: `deploy/openopc-public-beta/backup/postgres-backup.sh`
- Create: `deploy/openopc-public-beta/backup/postgres-restore.sh`
- Create: `deploy/openopc-public-beta/backup/object-backup.sh`
- Create: `deploy/openopc-public-beta/backup/object-restore.sh`
- Create: `deploy/openopc-public-beta/backup/verify-restore.ts`
- Create: `deploy/openopc-public-beta/backup/verify-restore.test.ts`
- Create: `tests/public-beta/backup-recovery/run.ts`
- Create: `tests/public-beta/backup-recovery/run.test.ts`
- Create: `docs/runbooks/openopc-backup-restore.md`

**Interfaces:**
- Restore report includes source backup/WAL/object versions, selected recovery time, schema/artifact-set digests, start/end, measured RPO/RTO, row/object counts, consistency queries, smoke URLs, and cleanup result.

- [ ] **Step 1: Write failing script/report tests**

Assert daily full plus continuous WAL configuration, encrypted/versioned object backup to an independently protected target, selected PITR time, no production overwrite, isolated destination, checksum verification, and consistency across releases/trust/installations/executions/evidence/usage/ledger/audit/object references. Reject RPO over 15 minutes, RTO over four hours, missing object, stale schema/artifact set, absent post-restore Web/API/worker/Runner smoke, and leftover restore infrastructure.

- [ ] **Step 2: Run RED**

Run: `bun test deploy/openopc-public-beta/backup/verify-restore.test.ts tests/public-beta/backup-recovery/run.test.ts`

Expected: FAIL because backup/restore tooling is absent.

- [ ] **Step 3: Implement safe isolated restore automation**

Scripts require explicit source/destination identifiers, refuse production destination labels, verify resolved paths/buckets, restore PostgreSQL to selected time, restore referenced objects and versions, run migration/schema checks, start isolated Web/API/workers/Runners, and execute consistency/smoke. They never print credentials and always produce a cleanup manifest.

- [ ] **Step 4: Run local contracts and real B7 drill**

Run local tests, then one real isolated staging restore. Record measured RPO/RTO and all digests. If the restore is older than 24 hours at release time, run the required fresh post-restore consistency smoke; after seven days rerun the full restore.

Expected: B7 passes only when both numeric objectives and consistency hold.

- [ ] **Step 5: Commit boundary**

```powershell
git add deploy/openopc-public-beta/backup tests/public-beta/backup-recovery docs/runbooks/openopc-backup-restore.md
git commit -m "ops(beta): automate isolated backup recovery proof"
```

### Task 8: Add incident/dead-letter recovery and a staged failure drill

**Files:**
- Create: `tests/public-beta/telemetry-incident/run.ts`
- Create: `tests/public-beta/telemetry-incident/run.test.ts`
- Create: `docs/runbooks/openopc-incident-response.md`
- Create: `docs/runbooks/openopc-dead-letter-recovery.md`
- Modify: dead-letter/retry handlers in owning services only when tests prove a missing operation.

**Interfaces:**
- Drill scenarios: `api-dependency-loss`, `execution-node-loss`, `trust-scanner-crash`, `provider-circuit-open`, `outbox-backlog`, `ledger-worker-crash`, `object-storage-error`.
- Recovery commands are idempotent, scoped by exact event/execution IDs, reasoned, audited, and dry-run by default.

- [ ] **Step 1: Write failing drill contract tests**

Require real staging dependencies, before/after telemetry snapshots, alert firing and acknowledgement times, bounded failure injection, cleanup, no data loss/duplicate terminal/ledger posting, and audited dead-letter replay. Reject production target, unbounded network/process kill, missing cleanup, or an alert asserted only through a fixture object.

- [ ] **Step 2: Run RED**

Run: `bun test tests/public-beta/telemetry-incident/run.test.ts`

Expected: FAIL because the drill runner is absent.

- [ ] **Step 3: Implement bounded drills and recovery tooling**

Each scenario verifies expected fail-closed behavior, alert, trace, operator action, and recovery. Execution-node loss must leave work queued/lease-expired; control-node loss must stop new authority; Runners stop when grants expire. Dead-letter replay requires exact ID, expected digest, reason, step-up for sensitive events, and audit.

- [ ] **Step 4: Run local contracts and one real B8 staging drill**

Run local tests, then choose one staged failure from the fixed list and execute it once. Preserve any failure artifact and repair before a new candidate.

Expected: B8 includes end-to-end trace, dashboards, alerts, dead-letter recovery, and real drill evidence.

- [ ] **Step 5: Commit boundary**

```powershell
git add tests/public-beta/telemetry-incident docs/runbooks/openopc-incident-response.md docs/runbooks/openopc-dead-letter-recovery.md
git commit -m "test(beta): add telemetry and incident recovery drill"
```

### Task 9: Publish versioned policies and validate regional prerequisites

**Files:**
- Create: `apps/web/content/legal/terms.mdx`
- Create: `apps/web/content/legal/privacy.mdx`
- Create: `apps/web/content/legal/acceptable-use.mdx`
- Create: `apps/web/content/legal/module-publishing.mdx`
- Create: `apps/web/content/legal/retention-deletion.mdx`
- Create: `apps/web/src/app/(public)/(seo)/legal/terms/page.tsx`
- Create: `apps/web/src/app/(public)/(seo)/legal/privacy/page.tsx`
- Create: `apps/web/src/app/(public)/(seo)/legal/acceptable-use/page.tsx`
- Create: `apps/web/src/app/(public)/(seo)/legal/module-publishing/page.tsx`
- Create: `apps/web/src/app/(public)/(seo)/legal/retention-deletion/page.tsx`
- Create: `tests/public-beta/release-prerequisites.schema.json`
- Create: `tests/public-beta/release-prerequisites.fixture.json`
- Create: `scripts/release/public-beta-prerequisites.ts`
- Create: `scripts/release/public-beta-prerequisites.test.ts`

**Interfaces:**
- Each policy exports exact `policyId`, semantic `version`, `effectiveAt`, and content digest used by registration/developer acceptance.
- Regional evidence record: `{ id, jurisdiction, requirement, status:'satisfied'|'not_applicable', authority, issuedAt, expiresAt?, artifactDigest }`.

- [ ] **Step 1: Write failing policy/prerequisite tests**

Assert all policies/security contact/abuse/reporting routes are public, versioned, digest-bound, and registration configuration names the current versions. Reject missing domain/filing/privacy/content-governance/incident evidence, expired approval, blank authority, absent artifact digest, or `not_applicable` without a reasoned legal-scope artifact. For mainland-China configuration require applicable ICP and related service approvals.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-prerequisites.test.ts`

Expected: FAIL because pages and validator are absent.

- [ ] **Step 3: Implement policy metadata and external-evidence validation**

Policy content is operator-approved legal text stored as versioned content; code tests validate metadata/digest/linking, not legal sufficiency. Real regional documents remain secured release artifacts, never committed secrets. Registration stays disabled when the configured deployment region lacks a required current record.

- [ ] **Step 4: Run GREEN**

Run the RED command and `pnpm.cmd --filter Kortix-Computer-Frontend build`.

Expected: tests/build pass; fixture remains not-ready because it is not external approval evidence.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/web/content/legal apps/web/src/app/'(public)'/'(seo)'/legal tests/public-beta/release-prerequisites* scripts/release/public-beta-prerequisites*
git commit -m "feat(beta): version policies and regional prerequisites"
```

### Task 10: Deploy and verify the complete two-node staging candidate

**Files:**
- Create: `deploy/openopc-public-beta/deploy.ts`
- Create: `deploy/openopc-public-beta/deploy.test.ts`
- Create: `deploy/openopc-public-beta/verify-two-node.ts`
- Create: `deploy/openopc-public-beta/verify-two-node.test.ts`
- Create: `docs/runbooks/openopc-baota-deployment.md`
- Modify: `.github/workflows/deploy-staging.yml` to call the versioned deploy entry point after existing safeguards.

**Interfaces:**
- Deploy input is one artifact manifest, one candidate commit, explicit control/execution node identities, private route, backup state, and rollback manifest.
- Verification outputs B10 evidence and never returns secret values.

- [ ] **Step 1: Write failing deploy/preflight/two-node tests**

Assert rollout order backup/preflight → compatible migrations → API/workers → Web/Admin → Runners → feature flags. Reject mixed commits/digests, missing rollback, migration guard failure, public private-service port, absent private route, OCI service on control node, unavailable Runner profile, wildcard cookie, Admin/Web route bleed, TLS/realtime/health failure, and unapproved regional evidence.

- [ ] **Step 2: Run RED**

Run: `bun test deploy/openopc-public-beta/deploy.test.ts deploy/openopc-public-beta/verify-two-node.test.ts`

Expected: FAIL because deploy/verification entry points are absent.

- [ ] **Step 3: Implement resumable phase deployment and rollback**

Every phase writes a digested checkpoint and is idempotent. Deployment refuses feature enablement before health/evidence, drains Runners before replacement, and records the prior manifest as rollback target. Verification performs public exposure scan, TLS chain/hostname/expiry, websocket/realtime, Web/Admin/API/module-host routing, private PostgreSQL/object/queue/Runner/containerd checks, artifact/commit equality, and no Desktop dependency.

- [ ] **Step 4: Run GREEN and the real B10 lane**

Run local contract tests, deploy the exact staging candidate, then execute `public-beta-b10-two-node-deployment`. B10 evidence is valid for 24 hours only.

Expected: two distinct node identities, only Nginx public, all artifacts same commit, and zero forbidden public listeners.

- [ ] **Step 5: Commit boundary**

```powershell
git add deploy/openopc-public-beta/deploy* deploy/openopc-public-beta/verify-two-node* docs/runbooks/openopc-baota-deployment.md .github/workflows/deploy-staging.yml
git commit -m "ops(beta): deploy verified two node staging"
```

### Task 11: Run upstream compatibility rehearsal and protected-file audit

**Files:**
- Create: `scripts/release/public-beta-upstream-compatibility.ts`
- Create: `scripts/release/public-beta-upstream-compatibility.test.ts`
- Create: `tests/public-beta/upstream-compatibility/expected-boundaries.json`
- Do not write merge results into the active worktree during the rehearsal.

**Interfaces:**
- Input: candidate commit, upstream ref, protected boundary manifest, and disabled-state smoke command list.
- Output: merge-tree/diff artifact, conflicting files, compatibility test results, and additive-boundary score.

- [ ] **Step 1: Write failing rehearsal tests**

Assert use of a temporary isolated worktree only with explicit absolute path, no reset/restore/stash/clean, protected file list, upstream merge-tree result, Kortix core smoke, existing SDK/API/Desktop callback contracts, disabled-feature behavior, internal identifiers, and cleanup. Reject self-declared compatibility without an upstream ref/diff.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-upstream-compatibility.test.ts`

Expected: FAIL because rehearsal tooling is absent.

- [ ] **Step 3: Implement read-only-first compatibility analysis**

Fetch is a separate operator step. The script uses the already available upstream ref, `git merge-tree` for read-only conflict analysis, and only creates an isolated worktree after an explicit flag. It runs Kortix core/auth/session/project/Agent/SDK/API/Desktop smokes with OpenOPC flags disabled, records protected-file diffs, and removes only the worktree it created after verifying its path.

- [ ] **Step 4: Run GREEN and canonical G12/B9 lanes**

Run local tests, then the upstream rehearsal against the selected upstream commit. Combine G12 with B9 visible-brand/internal-identifier evidence from the foundation plan.

Expected: retained report shows whether the candidate absorbs the upstream ref; any conflict is a blocking Gate, not an automatic overwrite.

- [ ] **Step 5: Commit boundary**

```powershell
git add scripts/release/public-beta-upstream-compatibility* tests/public-beta/upstream-compatibility
git commit -m "test(beta): add upstream compatibility rehearsal"
```

### Task 12: Close every Gate and assemble the approval bundle

**Files:**
- No product code changes during evidence assembly.
- Produce runtime artifacts under `artifacts/public-beta/<candidate-commit>/`; do not commit real secret-bearing evidence.
- Consume the program plan release manifest and protected approval workflow.

**Interfaces:**
- Approval bundle: artifact manifest, evidence v2 ledger, prerequisite record, migration report, backup/restore report, staging topology report, rollback manifest, open-risk exceptions, and canonical digest manifest.

- [ ] **Step 1: Run focused local validators**

```powershell
bun test scripts/release/public-beta-evidence-v2.test.ts scripts/release/public-beta-lanes.test.ts scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-prerequisites.test.ts scripts/release/public-beta-program.test.ts scripts/release/public-beta-release-manifest.test.ts
pnpm.cmd migrate:lint
git diff --check
```

Expected: all pass; this does not assert public-beta readiness.

- [ ] **Step 2: Dispatch G1-G12 once for the exact candidate**

Run every canonical G lane with the required real dependency/visible/package topology. Preserve all failed/blocked attempts and their raw output. Do not continue to B closure when a dependency Gate is invalid.

- [ ] **Step 3: Dispatch B1-B10 once for the exact candidate**

Run every canonical B lane against `openopc-public-beta-staging`. B7 must carry measured recovery; B10 must be within 24 hours; B8 must include a real failure drill.

- [ ] **Step 4: Validate evidence, prerequisites, and release candidate**

```powershell
pnpm.cmd public-beta:evidence:validate --ledger artifacts/public-beta/<candidate-commit>/evidence.v2.json --commit <candidate-commit> --now <current-RFC3339>
pnpm.cmd public-beta:prerequisites:validate --record artifacts/public-beta/<candidate-commit>/prerequisites.json
pnpm.cmd public-beta:validate --manifest artifacts/public-beta/<candidate-commit>/release-candidate.json --evidence artifacts/public-beta/<candidate-commit>/evidence.v2.json --now <current-RFC3339>
```

Expected before approval: evidence and prerequisites pass; candidate exits `2` only for human approval. Any other reason returns to its owning plan.

- [ ] **Step 5: Obtain protected human approval and revalidate**

Run the program plan approval workflow for the exact bundle. Approval must display commit, all artifact digests, staging evidence, migration, backup, rollback target, regional prerequisites, and open risk exceptions.

Expected after approval: candidate validator exits `0` and public registration may be enabled through the documented feature flag rollout.

## Evidence and Operations Completion Gate

- Every required Gate has exact lane, commit, environment, timestamps, freshness, raw output, and artifact digests.
- Failed attempts and their stability fixes remain visible.
- BaoTa control node and private execution node are separately identified and verified.
- Nginx is the only public ingress and private dependencies are not exposed.
- Telemetry, incident response, restore, RPO/RTO, policies, regional evidence, supply chain, and rollback are real artifacts.
- An authorized human approves the exact current bundle; otherwise status remains **not ready for public beta**.
