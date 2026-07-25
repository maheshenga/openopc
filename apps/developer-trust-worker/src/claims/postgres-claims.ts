import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

import type { DeveloperTrustWorkerControlPort } from '../index';
import type { DeveloperTrustPipelineResult, DeveloperTrustWorkItem } from '../pipeline';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class PostgresVerificationClaimError extends Error {
  override readonly name = 'PostgresVerificationClaimError';

  constructor(readonly code: string) {
    super(code);
  }
}

export interface PostgresVerificationClaims extends DeveloperTrustWorkerControlPort {
  assertReady(): Promise<void>;
}

interface ClaimRow {
  run_id: string;
  release_id: string;
  account_id: string;
  artifact_id: string;
  artifact_digest: string;
  storage_key: string;
  size_bytes: string | number;
  policy_digest: string;
  scanner_set_digest: string;
  sandbox_profile_digest: string;
  attempt: number;
  lease_generation: number;
  lease_expires_at: Date | string;
  module_id: string;
  module_version: string;
  manifest: unknown;
  runtime_descriptor_path: string | null;
  runtime_kind: 'wasi-component' | 'oci-image' | null;
}

export function createPostgresVerificationClaims(input: {
  sql: Sql;
  schema?: string;
  tokenSource?: () => string;
}): PostgresVerificationClaims {
  const schema = input.schema ?? 'kortix';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) fail('POSTGRES_CLAIMS_CONFIG_INVALID');
  const table = (name: string) => `"${schema}".${name}`;
  const tokenSource = input.tokenSource ?? (() => randomBytes(32).toString('base64url'));

  return {
    async assertReady() {
      const rows = await input.sql.unsafe<Array<{ table_name: string | null }>>(
        'SELECT to_regclass($1)::text AS table_name',
        [`${schema}.developer_module_verification_runs`],
      );
      if (rows[0]?.table_name !== `${schema}.developer_module_verification_runs`) {
        fail('DEVELOPER_TRUST_POSTGRES_CLAIMS_UNAVAILABLE');
      }
    },

    async claim(request) {
      validateWorkerRequest(request.workerId, request.leaseMs);
      const leaseToken = tokenSource();
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(leaseToken)) fail('POSTGRES_CLAIMS_TOKEN_INVALID');
      const tokenHash = sha256(leaseToken);
      let rows: ClaimRow[];
      try {
        rows = await input.sql.unsafe<ClaimRow[]>(
          `WITH candidate AS (
             SELECT run_id
             FROM ${table('developer_module_verification_runs')}
             WHERE state = 'queued'
                OR (state = 'running' AND lease_expires_at <= clock_timestamp())
             ORDER BY created_at, run_id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           ), claimed AS (
             UPDATE ${table('developer_module_verification_runs')} AS run
             SET state = 'running',
                 lease_owner = $1,
                 lease_token_hash = $2,
                 lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
                 heartbeat_at = clock_timestamp(),
                 started_at = COALESCE(run.started_at, clock_timestamp()),
                 resource_summary = jsonb_set(
                   COALESCE(run.resource_summary, '{}'::jsonb),
                   '{lease_generation}',
                   to_jsonb(CASE WHEN run.state = 'queued' THEN 1
                     ELSE COALESCE((run.resource_summary->>'lease_generation')::integer, 0) + 1 END),
                   true
                 ),
                 updated_at = clock_timestamp()
             FROM candidate
             WHERE run.run_id = candidate.run_id
             RETURNING run.*,
               (run.resource_summary->>'lease_generation')::integer AS lease_generation
           )
           SELECT claimed.run_id, claimed.release_id, claimed.account_id, claimed.artifact_id,
                  claimed.policy_digest, claimed.scanner_set_digest,
                  claimed.sandbox_profile_digest, claimed.attempt,
                  claimed.lease_generation, claimed.lease_expires_at,
                  artifact.artifact_digest, artifact.storage_key,
                  artifact.size_bytes::text AS size_bytes,
                  release.module_id, release.module_version, release.manifest,
                  release.runtime_descriptor_path, release.runtime_kind
           FROM claimed
           JOIN ${table('developer_module_artifacts')} AS artifact
             ON artifact.artifact_id = claimed.artifact_id
            AND artifact.account_id = claimed.account_id
           JOIN ${table('developer_module_releases')} AS release
             ON release.release_id = claimed.release_id
            AND release.account_id = claimed.account_id
            AND release.artifact_id = claimed.artifact_id`,
          [request.workerId, tokenHash, request.leaseMs],
        );
      } catch (error) {
        if (error instanceof PostgresVerificationClaimError) throw error;
        fail('DEVELOPER_TRUST_POSTGRES_CLAIM_FAILED');
      }
      const row = rows[0];
      return row ? claimFromRow(row, leaseToken) : null;
    },

    async heartbeat(request) {
      validateLeaseRequest(request);
      const leaseGeneration = request.leaseGeneration as number;
      const rows = await input.sql.unsafe<Array<{ run_id: string }>>(
        `UPDATE ${table('developer_module_verification_runs')}
         SET heartbeat_at = clock_timestamp(),
             lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'),
             updated_at = clock_timestamp()
         WHERE run_id = $1
           AND state = 'running'
           AND lease_owner = $2
           AND lease_token_hash = $3
           AND (resource_summary->>'lease_generation')::integer = $4
           AND lease_expires_at > clock_timestamp()
         RETURNING run_id`,
        [
          request.runId,
          request.workerId,
          sha256(request.leaseToken),
          leaseGeneration,
          request.leaseMs,
        ],
      );
      if (rows.length !== 1) staleLease();
    },

    async finalize(request) {
      validateFinalizeRequest(request);
      const leaseGeneration = request.leaseGeneration as number;
      await input.sql.begin(async (transaction) => {
        const rows = await transaction.unsafe<Array<{ account_id: string }>>(
          `UPDATE ${table('developer_module_verification_runs')}
           SET state = $6,
               terminal_reason = $7,
               sbom_digest = $8,
               attestation_digest = $9,
               resource_summary = $10::jsonb,
               lease_owner = NULL,
               lease_token_hash = NULL,
               lease_expires_at = NULL,
               heartbeat_at = NULL,
               finished_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE run_id = $1
             AND state = 'running'
             AND lease_owner = $2
             AND lease_token_hash = $3
             AND (resource_summary->>'lease_generation')::integer = $4
             AND lease_expires_at > clock_timestamp()
             AND artifact_id IN (
               SELECT artifact_id FROM ${table('developer_module_artifacts')}
               WHERE artifact_digest = $5
             )
           RETURNING account_id`,
          [
            request.runId,
            request.workerId,
            sha256(request.leaseToken),
            leaseGeneration,
            request.artifactDigest,
            request.state,
            request.terminalReason,
            request.sbomDigest,
            request.attestation.attestationDigest,
            JSON.stringify(request.resourceSummary),
          ],
        );
        const accountId = rows[0]?.account_id;
        if (!accountId) staleLease();
        for (const finding of request.findings) {
          await transaction.unsafe(
            `INSERT INTO ${table('developer_module_verification_findings')}
              (finding_id, run_id, account_id, fingerprint, scanner, rule_id, severity,
               path, location, summary, disposition)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
            [
              randomUUID(),
              request.runId,
              accountId,
              finding.fingerprint,
              finding.scanner,
              finding.ruleId,
              finding.severity,
              finding.path,
              finding.location === null ? null : JSON.stringify(finding.location),
              finding.summary,
              finding.disposition,
            ],
          );
        }
        await transaction.unsafe(
          `INSERT INTO ${table('developer_module_trust_attestations')}
            (attestation_id, run_id, account_id, attestation_digest,
             subject_artifact_digest, predicate_type, policy_digest, result,
             sbom_digest, dsse_envelope, issuer)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [
            randomUUID(),
            request.runId,
            accountId,
            request.attestation.attestationDigest,
            request.attestation.subjectArtifactDigest,
            request.attestation.predicateType,
            request.attestation.policyDigest,
            request.attestation.result,
            request.attestation.sbomDigest,
            JSON.stringify(request.attestation.dsseEnvelope),
            request.attestation.issuer,
          ],
        );
      });
    },
  };
}

function claimFromRow(row: ClaimRow, leaseToken: string): DeveloperTrustWorkItem {
  const artifactSizeBytes = Number(row.size_bytes);
  const manifest = record(row.manifest) ? row.manifest : null;
  const verification = manifest && record(manifest.verification) ? manifest.verification : null;
  const execution = manifest && record(manifest.execution) ? manifest.execution : null;
  const verificationProfile =
    execution?.mode === 'declarative' ? 'declarative' : verification?.profile;
  if (
    !DIGEST.test(row.artifact_digest) ||
    !DIGEST.test(row.policy_digest) ||
    !DIGEST.test(row.scanner_set_digest) ||
    !DIGEST.test(row.sandbox_profile_digest) ||
    !Number.isSafeInteger(artifactSizeBytes) ||
    artifactSizeBytes < 1 ||
    ![
      'declarative',
      'agent-project',
      'sandboxed-web',
      'server-conformance',
      'desktop-package',
    ].includes(String(verificationProfile))
  ) {
    fail('DEVELOPER_TRUST_POSTGRES_CLAIM_INVALID');
  }
  return {
    runId: row.run_id,
    releaseId: row.release_id,
    accountId: row.account_id,
    artifactId: row.artifact_id,
    artifactDigest: row.artifact_digest as `sha256:${string}`,
    artifactStorageKey: row.storage_key,
    artifactSizeBytes,
    runtimeDescriptorPath: row.runtime_descriptor_path,
    runtimeKind: row.runtime_kind,
    policyDigest: row.policy_digest as `sha256:${string}`,
    scannerSetDigest: row.scanner_set_digest as `sha256:${string}`,
    sandboxProfileDigest: row.sandbox_profile_digest as `sha256:${string}`,
    attempt: row.attempt,
    leaseToken,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    verificationProfile: verificationProfile as DeveloperTrustWorkItem['verificationProfile'],
    moduleId: row.module_id,
    moduleVersion: row.module_version,
    workspacePath: '',
    lockGraph: null,
    dependencyLicenses: [],
  };
}

function validateWorkerRequest(workerId: string, leaseMs: number): void {
  if (
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(workerId) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 5_000 ||
    leaseMs > 300_000
  ) {
    fail('POSTGRES_CLAIMS_REQUEST_INVALID');
  }
}

function validateLeaseRequest(input: {
  runId: string;
  workerId: string;
  leaseToken: string;
  leaseGeneration?: number;
  leaseMs: number;
}): void {
  validateWorkerRequest(input.workerId, input.leaseMs);
  validateLeaseIdentity(input);
}

function validateLeaseIdentity(input: {
  runId: string;
  workerId: string;
  leaseToken: string;
  leaseGeneration?: number;
}): void {
  if (
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input.workerId) ||
    !/^[0-9a-f-]{36}$/i.test(input.runId) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(input.leaseToken) ||
    typeof input.leaseGeneration !== 'number' ||
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration < 1
  ) {
    fail('POSTGRES_CLAIMS_REQUEST_INVALID');
  }
}

function validateFinalizeRequest(
  input: Parameters<DeveloperTrustWorkerControlPort['finalize']>[0],
): void {
  validateLeaseIdentity(input);
  if (
    !['passed', 'failed', 'inconclusive'].includes(input.state) ||
    !DIGEST.test(input.artifactDigest) ||
    !DIGEST.test(input.policyDigest) ||
    !DIGEST.test(input.scannerSetDigest) ||
    !DIGEST.test(input.sbomDigest) ||
    input.attestation.subjectArtifactDigest !== input.artifactDigest ||
    input.attestation.policyDigest !== input.policyDigest ||
    input.attestation.sbomDigest !== input.sbomDigest ||
    input.attestation.result !== input.state
  ) {
    fail('POSTGRES_CLAIMS_FINALIZE_INVALID');
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function staleLease(): never {
  fail('STALE_VERIFICATION_LEASE');
}

function fail(code: string): never {
  throw new PostgresVerificationClaimError(code);
}
