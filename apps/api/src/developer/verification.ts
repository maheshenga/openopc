import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RegistryModuleManifest } from '@kortix/registry';

export type DeveloperModuleVerificationState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'cancelled';

export type DeveloperModuleFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type DeveloperModuleFindingDisposition = 'blocking' | 'observed';

export interface DeveloperModuleVerificationRun {
  run_id: string;
  release_id: string;
  artifact_id: string;
  account_id: string;
  policy_digest: `sha256:${string}`;
  scanner_set_digest: `sha256:${string}`;
  sandbox_profile_digest: `sha256:${string}`;
  attempt: number;
  state: DeveloperModuleVerificationState;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  terminal_reason: string | null;
  sbom_digest: `sha256:${string}` | null;
  attestation_digest: `sha256:${string}` | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeveloperModuleVerificationClaim {
  runId: string;
  releaseId: string;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface EnqueueVerificationInput {
  releaseId: string;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
}

export interface DeveloperModuleVerificationFindingInput {
  fingerprint: `sha256:${string}`;
  scanner: string;
  ruleId: string;
  severity: DeveloperModuleFindingSeverity;
  path: string | null;
  location: Record<string, unknown> | null;
  summary: string;
  disposition: DeveloperModuleFindingDisposition;
}

export interface DeveloperModuleTrustAttestationInput {
  attestationDigest: `sha256:${string}`;
  subjectArtifactDigest: `sha256:${string}`;
  predicateType: string;
  policyDigest: `sha256:${string}`;
  result: Exclude<DeveloperModuleVerificationState, 'queued' | 'running'>;
  sbomDigest: `sha256:${string}`;
  dsseEnvelope: Record<string, unknown>;
  issuer: string;
}

export interface FinalizeVerificationInput {
  runId: string;
  workerId: string;
  leaseToken: string;
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  result: 'passed' | 'failed' | 'inconclusive';
  terminalReason: string;
  sbomDigest: `sha256:${string}`;
  resourceSummary: Record<string, unknown>;
  findings: DeveloperModuleVerificationFindingInput[];
  attestation: DeveloperModuleTrustAttestationInput;
}

export interface RetryVerificationInput {
  releaseId: string;
  accountId?: string;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
}

export interface CancelVerificationInput {
  releaseId: string;
  accountId?: string;
  reason: string;
}

export interface DeveloperModuleVerificationFindingView {
  finding_id: string;
  fingerprint: `sha256:${string}`;
  scanner: string;
  rule_id: string;
  severity: DeveloperModuleFindingSeverity;
  path: string | null;
  location: Record<string, unknown> | null;
  summary: string;
  disposition: DeveloperModuleFindingDisposition;
  created_at: string;
}

export interface DeveloperModuleTrustAttestationView {
  attestation_digest: `sha256:${string}`;
  subject_artifact_digest: `sha256:${string}`;
  predicate_type: string;
  policy_digest: `sha256:${string}`;
  result: Exclude<DeveloperModuleVerificationState, 'queued' | 'running'>;
  sbom_digest: `sha256:${string}`;
  issuer: string;
  created_at: string;
}

export interface DeveloperModuleVerificationAttemptView {
  run_id: string;
  attempt: number;
  state: DeveloperModuleVerificationState;
  policy_digest: `sha256:${string}`;
  scanner_set_digest: `sha256:${string}`;
  sandbox_profile_digest: `sha256:${string}`;
  terminal_reason: string | null;
  sbom_digest: `sha256:${string}` | null;
  attestation_digest: `sha256:${string}` | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  findings: DeveloperModuleVerificationFindingView[];
  attestation: DeveloperModuleTrustAttestationView | null;
}

export interface DeveloperModuleTrustView {
  release_id: string;
  account_id: string;
  artifact: {
    artifact_id: string;
    artifact_digest: `sha256:${string}`;
    media_type: string;
    size_bytes: number;
    source_provenance: Record<string, unknown> | null;
    created_at: string;
  };
  attempts: DeveloperModuleVerificationAttemptView[];
}

export interface DeveloperModuleVerificationRepository {
  enqueue(input: EnqueueVerificationInput): Promise<DeveloperModuleVerificationRun>;
  claim(input: {
    workerId: string;
    leaseMs: number;
  }): Promise<DeveloperModuleVerificationClaim | null>;
  heartbeat(input: {
    runId: string;
    workerId: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<void>;
  finalize(input: FinalizeVerificationInput): Promise<DeveloperModuleVerificationRun>;
  retry(input: RetryVerificationInput): Promise<DeveloperModuleVerificationRun>;
  cancel(input: CancelVerificationInput): Promise<DeveloperModuleVerificationRun>;
  getPublisherView(accountId: string, releaseId: string): Promise<DeveloperModuleTrustView | null>;
  getAdminView(releaseId: string): Promise<DeveloperModuleTrustView | null>;
}

export type DeveloperModuleVerificationErrorCode =
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'DEVELOPER_VERIFICATION_CONFLICT'
  | 'DEVELOPER_VERIFICATION_LEASE_LOST'
  | 'DEVELOPER_VERIFICATION_RESULT_INVALID'
  | 'DEVELOPER_VERIFICATION_ALREADY_FINALIZED'
  | 'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED'
  | 'DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED';

export class DeveloperModuleVerificationError extends Error {
  constructor(
    readonly code: DeveloperModuleVerificationErrorCode,
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = 'DeveloperModuleVerificationError';
  }
}

function fail(
  code: DeveloperModuleVerificationErrorCode,
  status: DeveloperModuleVerificationError['status'],
): never {
  throw new DeveloperModuleVerificationError(code, status);
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const WORKER_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_TEXT =
  /(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i;
const TERMINAL_STATES = new Set<DeveloperModuleVerificationState>([
  'passed',
  'failed',
  'inconclusive',
  'cancelled',
]);

function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function assertDeveloperModuleServiceNetworkPolicy(
  manifest: RegistryModuleManifest,
  configured: { newApiBaseUrl?: string; zPayBaseUrl?: string } = {
    newApiBaseUrl: process.env.NEWAPI_BASE_URL,
    zPayBaseUrl: process.env.ZPAY_BASE_URL,
  },
): void {
  if (manifest.schemaVersion !== 3) return;
  const network = new Set(
    (manifest.permissions?.network ?? []).flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    }),
  );
  const services = manifest.openopc.services;
  if (
    services !== undefined &&
    Object.keys(services).length > 0 &&
    [configuredOrigin(configured.newApiBaseUrl), configuredOrigin(configured.zPayBaseUrl)].some(
      (origin) => origin !== null && network.has(origin),
    )
  ) {
    fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
  }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function validateLeaseInput(workerId: string, leaseMs: number): void {
  if (
    !WORKER_ID.test(workerId) ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1_000 ||
    leaseMs > 900_000
  ) {
    fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
  }
}

function safeText(value: unknown, maxCharacters: number, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxCharacters &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !CREDENTIAL_TEXT.test(value)
  );
}

function safePath(value: string | null): boolean {
  if (value === null) return true;
  if (!safeText(value, 2_048, 2_048) || value.includes('\\') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'),
  );
}

function safeLocation(value: Record<string, unknown> | null): boolean {
  if (value === null) return true;
  const allowed = new Set(['line', 'column', 'end_line', 'end_column']);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    Object.values(value).every(
      (entry) =>
        Number.isInteger(entry) && (entry as number) > 0 && (entry as number) <= 10_000_000,
    ) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4_096
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Only finite JSON numbers are supported');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('Only JSON values are supported');
}

function validateFinding(input: DeveloperModuleVerificationFindingInput): void {
  if (
    !validDigest(input.fingerprint) ||
    !safeText(input.scanner, 128, 256) ||
    !safeText(input.ruleId, 256, 512) ||
    !['info', 'low', 'medium', 'high', 'critical'].includes(input.severity) ||
    !safePath(input.path) ||
    !safeLocation(input.location) ||
    !safeText(input.summary, 2_000, 4_096) ||
    !['blocking', 'observed'].includes(input.disposition)
  ) {
    fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
  }
}

export function assertValidDeveloperModuleVerificationFinalization(
  input: FinalizeVerificationInput,
): void {
  validateLeaseInput(input.workerId, 1_000);
  if (
    !validDigest(input.artifactDigest) ||
    !validDigest(input.policyDigest) ||
    !validDigest(input.scannerSetDigest) ||
    !['passed', 'failed', 'inconclusive'].includes(input.result) ||
    !safeText(input.terminalReason, 256, 512) ||
    !validDigest(input.sbomDigest) ||
    input.findings.length > 256 ||
    new Set(input.findings.map((finding) => finding.fingerprint)).size !== input.findings.length ||
    Buffer.byteLength(canonicalJson(input.resourceSummary), 'utf8') > 32_768
  ) {
    fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
  }
  for (const finding of input.findings) validateFinding(finding);
  const attestation = input.attestation;
  if (
    !validDigest(attestation.attestationDigest) ||
    !validDigest(attestation.subjectArtifactDigest) ||
    !safeText(attestation.predicateType, 256, 512) ||
    !attestation.predicateType.startsWith('https://') ||
    !validDigest(attestation.policyDigest) ||
    attestation.result !== input.result ||
    !validDigest(attestation.sbomDigest) ||
    !safeText(attestation.issuer, 256, 512) ||
    Buffer.byteLength(canonicalJson(attestation.dsseEnvelope), 'utf8') > 1_048_576
  ) {
    fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
  }
}

function equalTokenHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

type MemoryRelease = {
  releaseId: string;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  mediaType: string;
  sizeBytes: number;
  sourceProvenance: Record<string, unknown> | null;
  createdAt: string;
  sbomDigest?: `sha256:${string}` | null;
  trustAttestationDigest?: `sha256:${string}` | null;
  verificationPolicyDigest?: `sha256:${string}` | null;
};

type InternalRun = DeveloperModuleVerificationRun & {
  artifact_digest: `sha256:${string}`;
  lease_token_hash: `sha256:${string}` | null;
  finalization_fingerprint: `sha256:${string}` | null;
};

type InternalFinding = DeveloperModuleVerificationFindingView & { account_id: string };
type InternalAttestation = DeveloperModuleTrustAttestationView & {
  account_id: string;
  dsse_envelope: Record<string, unknown>;
};

function cloneRun(run: InternalRun): DeveloperModuleVerificationRun {
  const {
    artifact_digest: _artifactDigest,
    lease_token_hash: _leaseTokenHash,
    finalization_fingerprint: _finalizationFingerprint,
    ...safe
  } = run;
  return structuredClone(safe);
}

export function createMemoryDeveloperModuleVerificationRepository(input?: {
  releases?: readonly MemoryRelease[];
  now?: () => Date;
  createId?: () => string;
  createLeaseToken?: () => string;
}): DeveloperModuleVerificationRepository {
  const releases = new Map(
    (input?.releases ?? []).map((release) => [release.releaseId, structuredClone(release)]),
  );
  const runs = new Map<string, InternalRun>();
  const findings = new Map<string, InternalFinding[]>();
  const attestations = new Map<string, InternalAttestation>();
  const now = input?.now ?? (() => new Date());
  const createId = input?.createId ?? randomUUID;
  const createLeaseToken = input?.createLeaseToken ?? (() => randomBytes(32).toString('base64url'));

  function currentTime(): Date {
    const value = now();
    if (!Number.isFinite(value.getTime())) fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
    return value;
  }

  function releaseFor(releaseId: string, accountId?: string): MemoryRelease {
    const release = releases.get(releaseId);
    if (!release || (accountId !== undefined && release.accountId !== accountId)) {
      fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    }
    return release;
  }

  function attempts(releaseId: string): InternalRun[] {
    return [...runs.values()]
      .filter((run) => run.release_id === releaseId)
      .sort((left, right) => left.attempt - right.attempt);
  }

  function active(releaseId: string, policyDigest: string): InternalRun | undefined {
    return attempts(releaseId).find(
      (run) => run.policy_digest === policyDigest && ['queued', 'running'].includes(run.state),
    );
  }

  function ensureLease(run: InternalRun, workerId: string, leaseToken: string): void {
    const time = currentTime();
    if (
      run.state !== 'running' ||
      run.lease_owner !== workerId ||
      !run.lease_token_hash ||
      !equalTokenHash(run.lease_token_hash, digest(leaseToken)) ||
      !run.lease_expires_at ||
      new Date(run.lease_expires_at).getTime() <= time.getTime()
    ) {
      fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
    }
  }

  function trustView(release: MemoryRelease): DeveloperModuleTrustView {
    return {
      release_id: release.releaseId,
      account_id: release.accountId,
      artifact: {
        artifact_id: release.artifactId,
        artifact_digest: release.artifactDigest,
        media_type: release.mediaType,
        size_bytes: release.sizeBytes,
        source_provenance: structuredClone(release.sourceProvenance),
        created_at: release.createdAt,
      },
      attempts: attempts(release.releaseId).map((run) => ({
        run_id: run.run_id,
        attempt: run.attempt,
        state: run.state,
        policy_digest: run.policy_digest,
        scanner_set_digest: run.scanner_set_digest,
        sandbox_profile_digest: run.sandbox_profile_digest,
        terminal_reason: run.terminal_reason,
        sbom_digest: run.sbom_digest,
        attestation_digest: run.attestation_digest,
        started_at: run.started_at,
        finished_at: run.finished_at,
        created_at: run.created_at,
        findings: (findings.get(run.run_id) ?? []).map((finding) => {
          const { account_id: _accountId, ...safeFinding } = finding;
          return structuredClone(safeFinding);
        }),
        attestation: (() => {
          const attestation = attestations.get(run.run_id);
          if (!attestation) return null;
          const {
            account_id: _accountId,
            dsse_envelope: _dsseEnvelope,
            ...safeAttestation
          } = attestation;
          return structuredClone(safeAttestation);
        })(),
      })),
    };
  }

  const repository: DeveloperModuleVerificationRepository = {
    async enqueue(enqueueInput) {
      const release = releaseFor(enqueueInput.releaseId, enqueueInput.accountId);
      if (
        release.artifactId !== enqueueInput.artifactId ||
        release.artifactDigest !== enqueueInput.artifactDigest ||
        !validDigest(enqueueInput.policyDigest) ||
        !validDigest(enqueueInput.scannerSetDigest) ||
        !validDigest(enqueueInput.sandboxProfileDigest)
      ) {
        fail('DEVELOPER_VERIFICATION_CONFLICT', 409);
      }
      const existing = active(enqueueInput.releaseId, enqueueInput.policyDigest);
      if (existing) {
        if (
          existing.artifact_id === enqueueInput.artifactId &&
          existing.artifact_digest === enqueueInput.artifactDigest &&
          existing.scanner_set_digest === enqueueInput.scannerSetDigest &&
          existing.sandbox_profile_digest === enqueueInput.sandboxProfileDigest
        ) {
          return cloneRun(existing);
        }
        fail('DEVELOPER_VERIFICATION_CONFLICT', 409);
      }
      const createdAt = currentTime().toISOString();
      const run: InternalRun = {
        run_id: createId(),
        release_id: enqueueInput.releaseId,
        artifact_id: enqueueInput.artifactId,
        artifact_digest: enqueueInput.artifactDigest,
        account_id: enqueueInput.accountId,
        policy_digest: enqueueInput.policyDigest,
        scanner_set_digest: enqueueInput.scannerSetDigest,
        sandbox_profile_digest: enqueueInput.sandboxProfileDigest,
        attempt:
          Math.max(0, ...attempts(enqueueInput.releaseId).map((candidate) => candidate.attempt)) +
          1,
        state: 'queued',
        lease_owner: null,
        lease_token_hash: null,
        lease_expires_at: null,
        heartbeat_at: null,
        terminal_reason: null,
        sbom_digest: null,
        attestation_digest: null,
        started_at: null,
        finished_at: null,
        created_at: createdAt,
        updated_at: createdAt,
        finalization_fingerprint: null,
      };
      runs.set(run.run_id, run);
      return cloneRun(run);
    },

    async claim(claimInput) {
      validateLeaseInput(claimInput.workerId, claimInput.leaseMs);
      const time = currentTime();
      const run = [...runs.values()]
        .filter(
          (candidate) =>
            candidate.state === 'queued' ||
            (candidate.state === 'running' &&
              candidate.lease_expires_at !== null &&
              new Date(candidate.lease_expires_at).getTime() <= time.getTime()),
        )
        .sort(
          (left, right) =>
            left.created_at.localeCompare(right.created_at) ||
            left.run_id.localeCompare(right.run_id),
        )[0];
      if (!run) return null;
      const release = releaseFor(run.release_id, run.account_id);
      const leaseToken = createLeaseToken();
      if (!/^[A-Za-z0-9_-]{43}$/.test(leaseToken)) {
        fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
      }
      const leaseExpiresAt = new Date(time.getTime() + claimInput.leaseMs).toISOString();
      run.state = 'running';
      run.lease_owner = claimInput.workerId;
      run.lease_token_hash = digest(leaseToken);
      run.lease_expires_at = leaseExpiresAt;
      run.heartbeat_at = time.toISOString();
      run.started_at ??= time.toISOString();
      run.updated_at = time.toISOString();
      return {
        runId: run.run_id,
        releaseId: run.release_id,
        accountId: run.account_id,
        artifactId: run.artifact_id,
        artifactDigest: release.artifactDigest,
        policyDigest: run.policy_digest,
        scannerSetDigest: run.scanner_set_digest,
        attempt: run.attempt,
        leaseToken,
        leaseExpiresAt,
      };
    },

    async heartbeat(heartbeatInput) {
      validateLeaseInput(heartbeatInput.workerId, heartbeatInput.leaseMs);
      const run = runs.get(heartbeatInput.runId);
      if (!run) fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
      ensureLease(run, heartbeatInput.workerId, heartbeatInput.leaseToken);
      const time = currentTime();
      run.heartbeat_at = time.toISOString();
      run.lease_expires_at = new Date(time.getTime() + heartbeatInput.leaseMs).toISOString();
      run.updated_at = time.toISOString();
    },

    async finalize(finalizeInput) {
      const run = runs.get(finalizeInput.runId);
      if (!run) fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
      const fingerprint = digest(canonicalJson(finalizeInput));
      if (TERMINAL_STATES.has(run.state)) {
        if (run.finalization_fingerprint === fingerprint) return cloneRun(run);
        fail('DEVELOPER_VERIFICATION_ALREADY_FINALIZED', 409);
      }
      ensureLease(run, finalizeInput.workerId, finalizeInput.leaseToken);
      assertValidDeveloperModuleVerificationFinalization(finalizeInput);
      const release = releaseFor(run.release_id, run.account_id);
      if (
        finalizeInput.artifactDigest !== run.artifact_digest ||
        finalizeInput.artifactDigest !== release.artifactDigest ||
        finalizeInput.policyDigest !== run.policy_digest ||
        finalizeInput.scannerSetDigest !== run.scanner_set_digest ||
        finalizeInput.attestation.subjectArtifactDigest !== run.artifact_digest ||
        finalizeInput.attestation.policyDigest !== run.policy_digest ||
        finalizeInput.attestation.sbomDigest !== finalizeInput.sbomDigest
      ) {
        fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
      }
      const finishedAt = currentTime().toISOString();
      const findingRows = finalizeInput.findings.map<InternalFinding>((finding) => ({
        finding_id: createId(),
        account_id: run.account_id,
        fingerprint: finding.fingerprint,
        scanner: finding.scanner.trim(),
        rule_id: finding.ruleId.trim(),
        severity: finding.severity,
        path: finding.path,
        location: structuredClone(finding.location),
        summary: finding.summary.trim(),
        disposition: finding.disposition,
        created_at: finishedAt,
      }));
      const attestation: InternalAttestation = {
        account_id: run.account_id,
        attestation_digest: finalizeInput.attestation.attestationDigest,
        subject_artifact_digest: finalizeInput.attestation.subjectArtifactDigest,
        predicate_type: finalizeInput.attestation.predicateType,
        policy_digest: finalizeInput.attestation.policyDigest,
        result: finalizeInput.attestation.result,
        sbom_digest: finalizeInput.attestation.sbomDigest,
        dsse_envelope: structuredClone(finalizeInput.attestation.dsseEnvelope),
        issuer: finalizeInput.attestation.issuer,
        created_at: finishedAt,
      };
      findings.set(run.run_id, findingRows);
      attestations.set(run.run_id, attestation);
      run.state = finalizeInput.result;
      run.terminal_reason = finalizeInput.terminalReason.trim();
      run.sbom_digest = finalizeInput.sbomDigest;
      run.attestation_digest = finalizeInput.attestation.attestationDigest;
      run.finished_at = finishedAt;
      run.lease_owner = null;
      run.lease_token_hash = null;
      run.lease_expires_at = null;
      run.updated_at = finishedAt;
      run.finalization_fingerprint = fingerprint;
      if (finalizeInput.result === 'passed') {
        release.sbomDigest = finalizeInput.sbomDigest;
        release.trustAttestationDigest = finalizeInput.attestation.attestationDigest;
        release.verificationPolicyDigest = finalizeInput.policyDigest;
      }
      return cloneRun(run);
    },

    async retry(retryInput) {
      const release = releaseFor(retryInput.releaseId, retryInput.accountId);
      const releaseAttempts = attempts(retryInput.releaseId);
      if (
        releaseAttempts.length === 0 ||
        releaseAttempts.some((run) => ['queued', 'running'].includes(run.state)) ||
        !TERMINAL_STATES.has(releaseAttempts.at(-1)?.state ?? 'queued')
      ) {
        fail('DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED', 409);
      }
      return repository.enqueue({
        releaseId: release.releaseId,
        accountId: release.accountId,
        artifactId: release.artifactId,
        artifactDigest: release.artifactDigest,
        policyDigest: retryInput.policyDigest,
        scannerSetDigest: retryInput.scannerSetDigest,
        sandboxProfileDigest: retryInput.sandboxProfileDigest,
      });
    },

    async cancel(cancelInput) {
      releaseFor(cancelInput.releaseId, cancelInput.accountId);
      if (!safeText(cancelInput.reason, 256, 512)) {
        fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
      }
      const run = attempts(cancelInput.releaseId).find((candidate) =>
        ['queued', 'running'].includes(candidate.state),
      );
      if (!run) {
        const latest = attempts(cancelInput.releaseId).at(-1);
        if (latest?.state === 'cancelled' && latest.terminal_reason === cancelInput.reason.trim()) {
          return cloneRun(latest);
        }
        fail('DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED', 409);
      }
      const finishedAt = currentTime().toISOString();
      run.state = 'cancelled';
      run.terminal_reason = cancelInput.reason.trim();
      run.finished_at = finishedAt;
      run.lease_owner = null;
      run.lease_token_hash = null;
      run.lease_expires_at = null;
      run.updated_at = finishedAt;
      return cloneRun(run);
    },

    async getPublisherView(accountId, releaseId) {
      const release = releases.get(releaseId);
      return !release || release.accountId !== accountId ? null : trustView(release);
    },

    async getAdminView(releaseId) {
      const release = releases.get(releaseId);
      return release ? trustView(release) : null;
    },
  };
  return repository;
}

export class DeveloperModuleVerificationService {
  constructor(
    private readonly input: {
      repository: DeveloperModuleVerificationRepository;
      currentPolicy: {
        policyDigest: `sha256:${string}`;
        scannerSetDigest: `sha256:${string}`;
        sandboxProfileDigest: `sha256:${string}`;
      };
    },
  ) {}

  async getTrustView(input: {
    accountId: string;
    releaseId: string;
  }): Promise<DeveloperModuleTrustView> {
    const view = await this.input.repository.getPublisherView(input.accountId, input.releaseId);
    if (!view) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    return view;
  }

  async getAdminTrustView(input: { releaseId: string }): Promise<DeveloperModuleTrustView> {
    const view = await this.input.repository.getAdminView(input.releaseId);
    if (!view) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    return view;
  }

  retryPublisher(input: { accountId: string; releaseId: string }) {
    return this.input.repository.retry({
      accountId: input.accountId,
      releaseId: input.releaseId,
      ...this.input.currentPolicy,
    });
  }

  retryAdmin(input: { releaseId: string }) {
    return this.input.repository.retry({
      releaseId: input.releaseId,
      ...this.input.currentPolicy,
    });
  }

  cancelAdmin(input: { releaseId: string }) {
    return this.input.repository.cancel({
      releaseId: input.releaseId,
      reason: 'cancelled by platform administrator',
    });
  }
}
