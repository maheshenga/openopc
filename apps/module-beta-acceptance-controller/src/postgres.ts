import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface ArtifactRow {
  account_id: string;
  artifact_id: string;
  artifact_digest: string;
  content_digest: string;
  storage_key: string;
  size_bytes: string | number;
}

interface EvidenceRow {
  acceptance_run_id: string;
  run_id: string;
  account_id: string;
  artifact_id: string;
  artifact_digest: string;
  content_digest: string;
  artifact_storage_key: string;
  artifact_size_bytes: string | number;
  sbom_digest: string;
  sbom_storage_key: string;
  sbom_size_bytes: string | number;
  attestation_digest: string;
  dsse_envelope: unknown;
}

interface CleanupRunRow {
  acceptance_run_id: string;
  run_id: string;
  release_id: string;
  artifact_id: string;
  artifact_digest: string;
  state: string;
  lease_owner: string | null;
  lease_token_hash: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
}

interface RetentionRunRow {
  run_id: string;
  acceptance_run_id: string | null;
  state: string;
  attempts: string | number;
  available_at: string;
  cursor: string | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface ModuleBetaAcceptanceArtifactRecord {
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  contentDigest: `sha256:${string}`;
  storageKey: string;
  sizeBytes: number;
}

export interface ModuleBetaAcceptanceRunEvidenceRecord {
  acceptanceRunId: string;
  runId: string;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  artifactContentDigest: `sha256:${string}`;
  artifactStorageKey: string;
  artifactSizeBytes: number;
  sbomDigest: `sha256:${string}`;
  sbomStorageKey: string;
  sbomSizeBytes: number;
  attestationDigest: `sha256:${string}`;
  dsseEnvelope: unknown;
}

export interface ModuleBetaAcceptanceCleanupCoordinates {
  acceptanceRunId: string;
  accountId: string;
  cancelledUploadId: string;
  artifactIds: readonly string[];
  releaseIds: readonly string[];
  verificationRunIds: readonly string[];
}

export interface ModuleBetaAcceptanceCleanupBinding {
  cancelledUploadStorageKey: string;
  verificationRuns: ReadonlyArray<{
    runId: string;
    artifactId: string;
    artifactDigest: `sha256:${string}`;
  }>;
}

export interface ModuleBetaAcceptanceRetentionRunStatus {
  runId: string;
  acceptanceRunId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  availableAt: string;
  cursor: string | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface PostgresModuleBetaAcceptanceRepository {
  assertReady(): Promise<void>;
  getArtifact(input: {
    accountId: string;
    artifactId: string;
    artifactDigest: `sha256:${string}`;
  }): Promise<ModuleBetaAcceptanceArtifactRecord | null>;
  getRunEvidence(input: {
    acceptanceRunId: string;
    runId: string;
  }): Promise<ModuleBetaAcceptanceRunEvidenceRecord | null>;
  getCleanupBinding(
    input: ModuleBetaAcceptanceCleanupCoordinates,
  ): Promise<ModuleBetaAcceptanceCleanupBinding>;
  prepareExpiredRetentionProbe(input: {
    acceptanceRunId: string;
    accountId: string;
    cancelledUploadId: string;
    uploadId: string;
    storageKey: string;
    contentDigest: `sha256:${string}`;
    sizeBytes: number;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
  enqueueRetentionRun(input: {
    acceptanceRunId: string;
    delayMs: number;
  }): Promise<ModuleBetaAcceptanceRetentionRunStatus>;
  readRetentionRun(input: {
    acceptanceRunId: string;
  }): Promise<ModuleBetaAcceptanceRetentionRunStatus | null>;
  assertExpiredRetentionProbeDeleted(input: {
    accountId: string;
    uploadId: string;
    storageKey: string;
  }): Promise<void>;
  assertAttemptsPreserved(input: ModuleBetaAcceptanceCleanupCoordinates): Promise<void>;
}

export class ModuleBetaAcceptanceDatabaseError extends Error {
  override readonly name = 'ModuleBetaAcceptanceDatabaseError';

  constructor(readonly code: string) {
    super(code);
  }
}

export function createPostgresModuleBetaAcceptanceRepository(input: {
  sql: Sql;
  schema?: string;
}): PostgresModuleBetaAcceptanceRepository {
  const schema = input.schema ?? 'kortix';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    fail('MODULE_BETA_ACCEPTANCE_DATABASE_CONFIG_INVALID');
  const table = (name: string) => `"${schema}".${name}`;

  const cleanupRows = async (
    request: ModuleBetaAcceptanceCleanupCoordinates,
  ): Promise<CleanupRunRow[]> => {
    validateCleanupCoordinates(request);
    return input.sql.unsafe<CleanupRunRow[]>(
      `SELECT run.resource_summary #>> '{acceptance,acceptanceRunId}' AS acceptance_run_id,
              run.run_id, run.release_id, run.artifact_id, artifact.artifact_digest, run.state,
              run.lease_owner, run.lease_token_hash,
              run.lease_expires_at::text AS lease_expires_at,
              run.heartbeat_at::text AS heartbeat_at
       FROM ${table('developer_module_verification_runs')} AS run
       JOIN ${table('developer_module_artifacts')} AS artifact
         ON artifact.account_id = run.account_id
        AND artifact.artifact_id = run.artifact_id
       WHERE run.account_id = $1
         AND run.resource_summary #>> '{acceptance,acceptanceRunId}' = $2
       ORDER BY run.run_id`,
      [request.accountId, request.acceptanceRunId],
    );
  };

  const assertCleanupRows = (
    request: ModuleBetaAcceptanceCleanupCoordinates,
    rows: CleanupRunRow[],
  ): void => {
    if (
      rows.length !== request.verificationRunIds.length ||
      rows.some(
        (row) =>
          row.acceptance_run_id !== request.acceptanceRunId ||
          !['passed', 'failed', 'inconclusive', 'cancelled'].includes(row.state) ||
          row.lease_owner !== null ||
          row.lease_token_hash !== null ||
          row.lease_expires_at !== null ||
          row.heartbeat_at !== null ||
          !DIGEST.test(row.artifact_digest) ||
          !request.verificationRunIds.includes(row.run_id) ||
          !request.releaseIds.includes(row.release_id) ||
          !request.artifactIds.includes(row.artifact_id),
      ) ||
      !sameSet(
        rows.map((row) => row.release_id),
        request.releaseIds,
      ) ||
      !sameSet(
        rows.map((row) => row.artifact_id),
        request.artifactIds,
      )
    ) {
      fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
    }
  };

  return {
    async assertReady() {
      for (const name of [
        'developer_module_artifacts',
        'developer_module_artifact_uploads',
        'developer_artifact_retention_runs',
        'developer_module_verification_runs',
        'developer_module_trust_attestations',
      ]) {
        const qualifiedName = `${schema}.${name}`;
        let rows: Array<{ table_name: string | null }>;
        try {
          rows = await input.sql.unsafe<Array<{ table_name: string | null }>>(
            'SELECT to_regclass($1)::text AS table_name',
            [qualifiedName],
          );
        } catch {
          fail('MODULE_BETA_ACCEPTANCE_DATABASE_UNAVAILABLE');
        }
        if (rows[0]?.table_name !== qualifiedName) {
          fail('MODULE_BETA_ACCEPTANCE_DATABASE_UNAVAILABLE');
        }
      }
    },

    async getArtifact(request) {
      validateUuid(request.accountId);
      validateUuid(request.artifactId);
      validateDigest(request.artifactDigest);
      const rows = await input.sql.unsafe<ArtifactRow[]>(
        `SELECT artifact.account_id, artifact.artifact_id, artifact.artifact_digest,
                uploaded.expected_digest AS content_digest,
                artifact.storage_key, artifact.size_bytes::text AS size_bytes
         FROM ${table('developer_module_artifacts')} AS artifact
         JOIN LATERAL (
           SELECT upload.expected_digest
           FROM ${table('developer_module_artifact_uploads')} AS upload
           WHERE upload.account_id = artifact.account_id
             AND upload.artifact_id = artifact.artifact_id
             AND upload.state = 'finalized'
           ORDER BY upload.updated_at DESC, upload.upload_id DESC
           LIMIT 1
         ) AS uploaded ON TRUE
         WHERE artifact.account_id = $1
           AND artifact.artifact_id = $2
           AND artifact.artifact_digest = $3
         LIMIT 1`,
        [request.accountId, request.artifactId, request.artifactDigest],
      );
      const row = rows[0];
      if (!row) return null;
      const sizeBytes = safeSize(row.size_bytes, 512 * 1024 * 1024);
      if (
        row.account_id !== request.accountId ||
        row.artifact_id !== request.artifactId ||
        row.artifact_digest !== request.artifactDigest ||
        !DIGEST.test(row.content_digest) ||
        !safeStorageKey(row.storage_key)
      ) {
        fail('MODULE_BETA_ACCEPTANCE_DATABASE_INVALID');
      }
      return {
        accountId: row.account_id,
        artifactId: row.artifact_id,
        artifactDigest: row.artifact_digest as `sha256:${string}`,
        contentDigest: row.content_digest as `sha256:${string}`,
        storageKey: row.storage_key,
        sizeBytes,
      };
    },

    async getRunEvidence(request) {
      validateAcceptanceRunId(request.acceptanceRunId);
      validateUuid(request.runId);
      const rows = await input.sql.unsafe<EvidenceRow[]>(
        `SELECT run.resource_summary #>> '{acceptance,acceptanceRunId}' AS acceptance_run_id,
                run.run_id, run.account_id, run.artifact_id,
                artifact.artifact_digest,
                uploaded.expected_digest AS content_digest,
                artifact.storage_key AS artifact_storage_key,
                artifact.size_bytes::text AS artifact_size_bytes,
                run.sbom_digest, run.sbom_storage_key,
                run.sbom_size_bytes::text AS sbom_size_bytes,
                run.attestation_digest, attestation.dsse_envelope
         FROM ${table('developer_module_verification_runs')} AS run
         JOIN ${table('developer_module_artifacts')} AS artifact
           ON artifact.account_id = run.account_id
          AND artifact.artifact_id = run.artifact_id
         JOIN LATERAL (
           SELECT upload.expected_digest
           FROM ${table('developer_module_artifact_uploads')} AS upload
           WHERE upload.account_id = artifact.account_id
             AND upload.artifact_id = artifact.artifact_id
             AND upload.state = 'finalized'
           ORDER BY upload.updated_at DESC, upload.upload_id DESC
           LIMIT 1
         ) AS uploaded ON TRUE
         JOIN ${table('developer_module_trust_attestations')} AS attestation
           ON attestation.run_id = run.run_id
          AND attestation.account_id = run.account_id
          AND attestation.attestation_digest = run.attestation_digest
         WHERE run.run_id = $1
           AND run.resource_summary #>> '{acceptance,acceptanceRunId}' = $2
           AND run.state IN ('passed', 'failed', 'inconclusive')
         LIMIT 1`,
        [request.runId, request.acceptanceRunId],
      );
      const row = rows[0];
      if (!row) return null;
      const artifactSizeBytes = safeSize(row.artifact_size_bytes, 512 * 1024 * 1024);
      const sbomSizeBytes = safeSize(row.sbom_size_bytes, 16 * 1024 * 1024);
      if (
        row.acceptance_run_id !== request.acceptanceRunId ||
        row.run_id !== request.runId ||
        !UUID.test(row.account_id) ||
        !UUID.test(row.artifact_id) ||
        !DIGEST.test(row.artifact_digest) ||
        !DIGEST.test(row.content_digest) ||
        !safeStorageKey(row.artifact_storage_key) ||
        !DIGEST.test(row.sbom_digest) ||
        !safeStorageKey(row.sbom_storage_key) ||
        !DIGEST.test(row.attestation_digest) ||
        !isRecord(row.dsse_envelope)
      ) {
        fail('MODULE_BETA_ACCEPTANCE_DATABASE_INVALID');
      }
      return {
        acceptanceRunId: row.acceptance_run_id,
        runId: row.run_id,
        accountId: row.account_id,
        artifactId: row.artifact_id,
        artifactDigest: row.artifact_digest as `sha256:${string}`,
        artifactContentDigest: row.content_digest as `sha256:${string}`,
        artifactStorageKey: row.artifact_storage_key,
        artifactSizeBytes,
        sbomDigest: row.sbom_digest as `sha256:${string}`,
        sbomStorageKey: row.sbom_storage_key,
        sbomSizeBytes,
        attestationDigest: row.attestation_digest as `sha256:${string}`,
        dsseEnvelope: structuredClone(row.dsse_envelope),
      };
    },

    async getCleanupBinding(request) {
      validateCleanupCoordinates(request);
      const uploadRows = await input.sql.unsafe<
        Array<{
          upload_id: string;
          account_id: string;
          state: string;
          staging_storage_key: string;
        }>
      >(
        `SELECT upload_id, account_id, state, staging_storage_key
         FROM ${table('developer_module_artifact_uploads')}
         WHERE upload_id = $1
           AND account_id = $2
           AND state = 'cancelled'
         LIMIT 1`,
        [request.cancelledUploadId, request.accountId],
      );
      const upload = uploadRows[0];
      if (
        !upload ||
        upload.upload_id !== request.cancelledUploadId ||
        upload.account_id !== request.accountId ||
        upload.state !== 'cancelled' ||
        !safeStorageKey(upload.staging_storage_key)
      ) {
        fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
      }
      const rows = await cleanupRows(request);
      assertCleanupRows(request, rows);
      return {
        cancelledUploadStorageKey: upload.staging_storage_key,
        verificationRuns: rows.map((row) => ({
          runId: row.run_id,
          artifactId: row.artifact_id,
          artifactDigest: row.artifact_digest as `sha256:${string}`,
        })),
      };
    },

    async prepareExpiredRetentionProbe(request) {
      validateAcceptanceRunId(request.acceptanceRunId);
      validateUuid(request.accountId);
      validateUuid(request.cancelledUploadId);
      validateUuid(request.uploadId);
      validateDigest(request.contentDigest);
      if (
        !safeStorageKey(request.storageKey) ||
        !request.storageKey.startsWith('developer-modules/staging/acceptance-probes/') ||
        !Number.isSafeInteger(request.sizeBytes) ||
        request.sizeBytes < 1 ||
        request.sizeBytes > 16 * 1024
      ) {
        fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
      }
      const createdAt = validTimestamp(request.createdAt);
      const expiresAt = validTimestamp(request.expiresAt);
      if (expiresAt <= createdAt) fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
      const rows = await input.sql.unsafe<
        Array<{
          upload_id: string;
          account_id: string;
          state: string;
          staging_storage_key: string;
          staging_deleted_at: string | null;
        }>
      >(
        `WITH source_upload AS (
           SELECT account_id, publisher_id, created_by
           FROM ${table('developer_module_artifact_uploads')}
           WHERE upload_id = $1
             AND account_id = $2
             AND state = 'cancelled'
           LIMIT 1
         ), inserted AS (
           INSERT INTO ${table('developer_module_artifact_uploads')} (
             upload_id, account_id, publisher_id, state, expected_digest,
             expected_size, staging_storage_key, artifact_id, expires_at,
             staging_deleted_at, cleanup_attempts, cleanup_next_attempt_at,
             cleanup_last_error, created_by, created_at, updated_at
           )
           SELECT $3, source.account_id, source.publisher_id, 'expired', $4,
                  $5, $6, NULL, $7, NULL, 0, NULL, NULL,
                  source.created_by, $8, $8
           FROM source_upload AS source
           ON CONFLICT (upload_id) DO NOTHING
           RETURNING upload_id, account_id, state, staging_storage_key,
                     staging_deleted_at::text AS staging_deleted_at
         )
         SELECT * FROM inserted
         UNION ALL
         SELECT upload_id, account_id, state, staging_storage_key,
                staging_deleted_at::text AS staging_deleted_at
         FROM ${table('developer_module_artifact_uploads')}
         WHERE upload_id = $3
           AND NOT EXISTS (SELECT 1 FROM inserted)
         LIMIT 1`,
        [
          request.cancelledUploadId,
          request.accountId,
          request.uploadId,
          request.contentDigest,
          request.sizeBytes,
          request.storageKey,
          request.expiresAt,
          request.createdAt,
        ],
      );
      const row = rows[0];
      if (
        !row ||
        row.upload_id !== request.uploadId ||
        row.account_id !== request.accountId ||
        row.state !== 'expired' ||
        row.staging_storage_key !== request.storageKey ||
        row.staging_deleted_at !== null
      ) {
        fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
      }
    },

    async enqueueRetentionRun(request) {
      validateAcceptanceRunId(request.acceptanceRunId);
      validateDelayMs(request.delayMs);
      const rows = await input.sql.unsafe<RetentionRunRow[]>(
        `WITH inserted AS (
           INSERT INTO ${table('developer_artifact_retention_runs')} (
             acceptance_run_id, state, available_at
           )
           VALUES ($1, 'queued', CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'))
           ON CONFLICT DO NOTHING
           RETURNING run_id, acceptance_run_id, state, attempts,
                     available_at::text AS available_at, cursor, last_error,
                     lease_owner, lease_expires_at::text AS lease_expires_at,
                     created_at::text AS created_at, updated_at::text AS updated_at,
                     finished_at::text AS finished_at
         )
         SELECT * FROM inserted
         UNION ALL
         SELECT run_id, acceptance_run_id, state, attempts,
                available_at::text AS available_at, cursor, last_error,
                lease_owner, lease_expires_at::text AS lease_expires_at,
                created_at::text AS created_at, updated_at::text AS updated_at,
                finished_at::text AS finished_at
         FROM ${table('developer_artifact_retention_runs')}
         WHERE acceptance_run_id = $1
           AND NOT EXISTS (SELECT 1 FROM inserted)
         LIMIT 1`,
        [request.acceptanceRunId, request.delayMs],
      );
      const row = rows[0];
      if (!row) fail('MODULE_BETA_ACCEPTANCE_RETENTION_INVALID');
      return retentionRunStatus(row, request.acceptanceRunId);
    },

    async readRetentionRun(request) {
      validateAcceptanceRunId(request.acceptanceRunId);
      const rows = await input.sql.unsafe<RetentionRunRow[]>(
        `SELECT run_id, acceptance_run_id, state, attempts,
                available_at::text AS available_at, cursor, last_error,
                lease_owner, lease_expires_at::text AS lease_expires_at,
                created_at::text AS created_at, updated_at::text AS updated_at,
                finished_at::text AS finished_at
         FROM ${table('developer_artifact_retention_runs')}
         WHERE acceptance_run_id = $1
         LIMIT 1`,
        [request.acceptanceRunId],
      );
      return rows[0] ? retentionRunStatus(rows[0], request.acceptanceRunId) : null;
    },

    async assertExpiredRetentionProbeDeleted(request) {
      validateUuid(request.accountId);
      validateUuid(request.uploadId);
      if (
        !safeStorageKey(request.storageKey) ||
        !request.storageKey.startsWith('developer-modules/staging/acceptance-probes/')
      ) {
        fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
      }
      const rows = await input.sql.unsafe<
        Array<{
          upload_id: string;
          account_id: string;
          state: string;
          staging_storage_key: string;
          staging_deleted_at: string | null;
        }>
      >(
        `SELECT upload_id, account_id, state, staging_storage_key,
                staging_deleted_at::text AS staging_deleted_at
         FROM ${table('developer_module_artifact_uploads')}
         WHERE upload_id = $1
           AND account_id = $2
           AND staging_storage_key = $3
           AND state = 'expired'
           AND staging_deleted_at IS NOT NULL
         LIMIT 1`,
        [request.uploadId, request.accountId, request.storageKey],
      );
      const row = rows[0];
      if (
        !row ||
        row.upload_id !== request.uploadId ||
        row.account_id !== request.accountId ||
        row.state !== 'expired' ||
        row.staging_storage_key !== request.storageKey ||
        row.staging_deleted_at === null ||
        !Number.isFinite(Date.parse(row.staging_deleted_at))
      ) {
        fail('MODULE_BETA_ACCEPTANCE_RETENTION_INVALID');
      }
    },

    async assertAttemptsPreserved(request) {
      const rows = await cleanupRows(request);
      assertCleanupRows(request, rows);
    },
  };
}

function validateCleanupCoordinates(input: ModuleBetaAcceptanceCleanupCoordinates): void {
  validateAcceptanceRunId(input.acceptanceRunId);
  validateUuid(input.accountId);
  validateUuid(input.cancelledUploadId);
  for (const values of [input.artifactIds, input.releaseIds, input.verificationRunIds]) {
    if (values.length < 1 || values.length > 128 || new Set(values).size !== values.length) {
      fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
    }
    for (const value of values) validateUuid(value);
  }
}

function validateAcceptanceRunId(value: string): void {
  if (!RUN_ID.test(value)) fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
}

function validateUuid(value: string): void {
  if (!UUID.test(value)) fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
}

function validateDigest(value: string): void {
  if (!DIGEST.test(value)) fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
}

function validTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
  return timestamp;
}

function validateDelayMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 30 * 24 * 60 * 60_000) {
    fail('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
  }
}

function retentionRunStatus(
  row: RetentionRunRow,
  acceptanceRunId: string,
): ModuleBetaAcceptanceRetentionRunStatus {
  const states = new Set(['queued', 'running', 'succeeded', 'failed']);
  const attempts = Number(row.attempts);
  const cursorValid =
    row.cursor === null ||
    (Buffer.byteLength(row.cursor, 'utf8') >= 1 &&
      Buffer.byteLength(row.cursor, 'utf8') <= 2_048 &&
      !containsControlCharacter(row.cursor));
  const errorValid =
    row.last_error === null ||
    (Buffer.byteLength(row.last_error, 'utf8') >= 1 &&
      Buffer.byteLength(row.last_error, 'utf8') <= 1_024 &&
      !containsControlCharacter(row.last_error));
  const ownerValid =
    row.lease_owner === null ||
    (Buffer.byteLength(row.lease_owner, 'utf8') >= 1 &&
      Buffer.byteLength(row.lease_owner, 'utf8') <= 128 &&
      !containsControlCharacter(row.lease_owner));
  const availableAt = Date.parse(row.available_at);
  const createdAt = Date.parse(row.created_at);
  const updatedAt = Date.parse(row.updated_at);
  const leaseExpiresAt = row.lease_expires_at === null ? null : Date.parse(row.lease_expires_at);
  const finishedAt = row.finished_at === null ? null : Date.parse(row.finished_at);
  if (
    !UUID.test(row.run_id) ||
    row.acceptance_run_id !== acceptanceRunId ||
    !states.has(row.state) ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    !cursorValid ||
    !errorValid ||
    !ownerValid ||
    !Number.isFinite(availableAt) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt) ||
    updatedAt < createdAt ||
    (row.state === 'queued' &&
      (row.lease_owner !== null || row.lease_expires_at !== null || row.finished_at !== null)) ||
    (row.state === 'running' &&
      (row.lease_owner === null ||
        leaseExpiresAt === null ||
        !Number.isFinite(leaseExpiresAt) ||
        row.finished_at !== null)) ||
    (row.state === 'succeeded' &&
      (row.lease_owner !== null ||
        row.lease_expires_at !== null ||
        finishedAt === null ||
        !Number.isFinite(finishedAt) ||
        row.cursor !== null ||
        row.last_error !== null)) ||
    (row.state === 'failed' &&
      (row.lease_owner !== null ||
        row.lease_expires_at !== null ||
        finishedAt === null ||
        !Number.isFinite(finishedAt) ||
        row.last_error === null))
  ) {
    fail('MODULE_BETA_ACCEPTANCE_RETENTION_INVALID');
  }
  return {
    runId: row.run_id,
    acceptanceRunId,
    state: row.state as ModuleBetaAcceptanceRetentionRunStatus['state'],
    attempts,
    availableAt: row.available_at,
    cursor: row.cursor,
    lastError: row.last_error,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function safeSize(value: string | number, maximum: number): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) {
    fail('MODULE_BETA_ACCEPTANCE_DATABASE_INVALID');
  }
  return size;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function safeStorageKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 2_048 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\0\r\n]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = new Set(actual);
  const right = new Set(expected);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new ModuleBetaAcceptanceDatabaseError(code);
}
