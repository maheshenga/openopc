import {
  type Database,
  developerModuleArtifactUploads,
  developerModuleArtifacts,
  developerPublishers,
} from '@kortix/db';
import type { RegistryItem, RegistryModuleSourceProvenance } from '@kortix/registry';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  DeveloperModuleArtifactError,
  type DeveloperModuleArtifactRecord,
  type DeveloperModuleArtifactRepository,
  type DeveloperModuleArtifactUploadRecord,
} from './artifacts';
import type {
  DeveloperArtifactCleanupCandidate,
  DeveloperArtifactRetentionRepository,
  DeveloperArtifactRetentionRun,
  DeveloperArtifactRetentionRunStatus,
} from './artifact-retention-spec';

type ArtifactRow = typeof developerModuleArtifacts.$inferSelect;
type UploadRow = typeof developerModuleArtifactUploads.$inferSelect;
type RetentionRow = Record<string, unknown>;

const SAFE_RETENTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const RETENTION_STATUS_COLUMNS = sql.raw(`
  run_id AS "runId",
  acceptance_run_id AS "acceptanceRunId",
  state,
  attempts,
  available_at AS "availableAt",
  cursor,
  last_error AS "lastError",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  finished_at AS "finishedAt"
`);

function retentionRows(result: unknown): RetentionRow[] {
  if (Array.isArray(result)) return result as RetentionRow[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: RetentionRow[] }).rows;
  }
  return [];
}

function retentionValue(row: RetentionRow, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function retentionString(row: RetentionRow, camel: string, snake: string): string {
  const value = retentionValue(row, camel, snake);
  if (typeof value !== 'string') throw new TypeError(`Missing retention row field ${camel}`);
  return value;
}

function retentionNullableString(row: RetentionRow, camel: string, snake: string): string | null {
  const value = retentionValue(row, camel, snake);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`Invalid retention row field ${camel}`);
  return value;
}

function retentionTimestamp(row: RetentionRow, camel: string, snake: string): string {
  const value = retentionValue(row, camel, snake);
  const timestamp = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!timestamp || !Number.isFinite(timestamp.getTime())) {
    throw new TypeError(`Invalid retention row field ${camel}`);
  }
  return timestamp.toISOString();
}

function retentionNullableTimestamp(
  row: RetentionRow,
  camel: string,
  snake: string,
): string | null {
  const value = retentionValue(row, camel, snake);
  if (value === null || value === undefined) return null;
  return retentionTimestamp(row, camel, snake);
}

function retentionNumber(row: RetentionRow, camel: string, snake: string): number {
  const value = Number(retentionValue(row, camel, snake));
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`Invalid retention row field ${camel}`);
  }
  return value;
}

function retentionBoolean(row: RetentionRow, camel: string, snake: string): boolean {
  const value = retentionValue(row, camel, snake);
  if (typeof value !== 'boolean') throw new TypeError(`Invalid retention row field ${camel}`);
  return value;
}

function serializeRetentionRunStatus(row: RetentionRow): DeveloperArtifactRetentionRunStatus {
  const state = retentionString(row, 'state', 'state');
  if (!['queued', 'running', 'succeeded', 'failed'].includes(state)) {
    throw new TypeError('Invalid retention row field state');
  }
  return {
    runId: retentionString(row, 'runId', 'run_id'),
    acceptanceRunId: retentionNullableString(row, 'acceptanceRunId', 'acceptance_run_id'),
    state: state as DeveloperArtifactRetentionRunStatus['state'],
    attempts: retentionNumber(row, 'attempts', 'attempts'),
    availableAt: retentionTimestamp(row, 'availableAt', 'available_at'),
    cursor: retentionNullableString(row, 'cursor', 'cursor'),
    lastError: retentionNullableString(row, 'lastError', 'last_error'),
    leaseOwner: retentionNullableString(row, 'leaseOwner', 'lease_owner'),
    leaseExpiresAt: retentionNullableTimestamp(row, 'leaseExpiresAt', 'lease_expires_at'),
    createdAt: retentionTimestamp(row, 'createdAt', 'created_at'),
    updatedAt: retentionTimestamp(row, 'updatedAt', 'updated_at'),
    finishedAt: retentionNullableTimestamp(row, 'finishedAt', 'finished_at'),
  };
}

function serializeClaimedRetentionRun(row: RetentionRow): DeveloperArtifactRetentionRun {
  if (retentionString(row, 'state', 'state') !== 'running') {
    throw new TypeError('Claimed retention run is not running');
  }
  return {
    runId: retentionString(row, 'runId', 'run_id'),
    acceptanceRunId: retentionNullableString(row, 'acceptanceRunId', 'acceptance_run_id'),
    state: 'running',
    attempts: retentionNumber(row, 'attempts', 'attempts'),
    cursor: retentionNullableString(row, 'cursor', 'cursor'),
    leaseOwner: retentionString(row, 'leaseOwner', 'lease_owner'),
    leaseExpiresAt: retentionTimestamp(row, 'leaseExpiresAt', 'lease_expires_at'),
    claimedAt: retentionTimestamp(row, 'claimedAt', 'claimed_at'),
  };
}

function assertRetentionIdentifier(value: string, label: string): void {
  if (!SAFE_RETENTION_IDENTIFIER.test(value)) throw new TypeError(`Invalid ${label}`);
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${label}`);
}

function assertDurationMs(value: number, label: string, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 30 * 24 * 60 * 60_000) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertCursor(value: string | null): void {
  if (
    value !== null &&
    (value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > 2_048 ||
      value.trim() !== value ||
      CONTROL_CHARACTER.test(value))
  ) {
    throw new TypeError('Invalid retention cursor');
  }
}

function assertStagingStorageKey(value: string): void {
  if (
    !value.startsWith('developer-modules/staging/') ||
    Buffer.byteLength(value, 'utf8') > 2_048 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError('Invalid retention storage key');
  }
}

export function serializeDeveloperModuleArtifactUploadRow(
  row: UploadRow,
): DeveloperModuleArtifactUploadRecord {
  return {
    upload_id: row.uploadId,
    account_id: row.accountId,
    publisher_id: row.publisherId,
    state: row.state,
    expected_digest: row.expectedDigest as `sha256:${string}`,
    expected_size: row.expectedSize,
    staging_storage_key: row.stagingStorageKey,
    artifact_id: row.artifactId,
    expires_at: row.expiresAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeDeveloperModuleArtifactRow(
  row: ArtifactRow,
): DeveloperModuleArtifactRecord {
  return {
    artifact_id: row.artifactId,
    account_id: row.accountId,
    publisher_id: row.publisherId,
    artifact_digest: row.artifactDigest as `sha256:${string}`,
    envelope_digest: row.envelopeDigest as `sha256:${string}`,
    storage_key: row.storageKey,
    media_type: row.mediaType as DeveloperModuleArtifactRecord['media_type'],
    size_bytes: row.sizeBytes,
    runtime_kind: row.runtimeKind,
    item_snapshot: structuredClone(row.itemSnapshot) as unknown as RegistryItem,
    source_provenance: structuredClone(
      row.sourceProvenance,
    ) as RegistryModuleSourceProvenance | null,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

function uploadValues(input: DeveloperModuleArtifactUploadRecord) {
  return {
    uploadId: input.upload_id,
    accountId: input.account_id,
    publisherId: input.publisher_id,
    state: input.state,
    expectedDigest: input.expected_digest,
    expectedSize: input.expected_size,
    stagingStorageKey: input.staging_storage_key,
    artifactId: input.artifact_id,
    expiresAt: input.expires_at,
    createdBy: input.created_by,
    createdAt: input.created_at,
    updatedAt: input.updated_at,
  };
}

function artifactValues(input: DeveloperModuleArtifactRecord) {
  return {
    artifactId: input.artifact_id,
    accountId: input.account_id,
    publisherId: input.publisher_id,
    artifactDigest: input.artifact_digest,
    envelopeDigest: input.envelope_digest,
    storageKey: input.storage_key,
    mediaType: input.media_type,
    sizeBytes: input.size_bytes,
    runtimeKind: input.runtime_kind,
    itemSnapshot: input.item_snapshot as unknown as Record<string, unknown>,
    sourceProvenance: input.source_provenance as unknown as Record<string, unknown> | null,
    createdBy: input.created_by,
    createdAt: input.created_at,
  };
}

function sameImmutableArtifact(
  existing: DeveloperModuleArtifactRecord,
  requested: DeveloperModuleArtifactRecord,
): boolean {
  return (
    existing.account_id === requested.account_id &&
    existing.publisher_id === requested.publisher_id &&
    existing.artifact_digest === requested.artifact_digest &&
    existing.envelope_digest === requested.envelope_digest &&
    existing.storage_key === requested.storage_key &&
    existing.media_type === requested.media_type &&
    existing.size_bytes === requested.size_bytes
  );
}

export function createDrizzleDeveloperModuleArtifactRepository(
  db: Database,
): DeveloperModuleArtifactRepository {
  return {
    async claimPublisher(input) {
      const [existing] = await db
        .select({ publisherId: developerPublishers.publisherId })
        .from(developerPublishers)
        .where(
          and(
            eq(developerPublishers.accountId, input.accountId),
            eq(developerPublishers.publisherId, input.publisherId),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT', 409);
      }
    },

    async createUpload(input) {
      const [inserted] = await db
        .insert(developerModuleArtifactUploads)
        .values(uploadValues(input))
        .returning();
      if (!inserted) throw new Error('Developer artifact upload insert failed');
    },

    async getUpload(accountId, uploadId) {
      const [row] = await db
        .select()
        .from(developerModuleArtifactUploads)
        .where(
          and(
            eq(developerModuleArtifactUploads.accountId, accountId),
            eq(developerModuleArtifactUploads.uploadId, uploadId),
          ),
        )
        .limit(1);
      return row ? serializeDeveloperModuleArtifactUploadRow(row) : null;
    },

    async setUploadState(input) {
      const rows = await db
        .update(developerModuleArtifactUploads)
        .set({ state: input.to, updatedAt: input.updatedAt })
        .where(
          and(
            eq(developerModuleArtifactUploads.accountId, input.accountId),
            eq(developerModuleArtifactUploads.uploadId, input.uploadId),
            inArray(developerModuleArtifactUploads.state, [...input.from]),
          ),
        )
        .returning({ uploadId: developerModuleArtifactUploads.uploadId });
      return rows.length === 1;
    },

    async createArtifact(input) {
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(developerModuleArtifacts)
          .values(artifactValues(input))
          .onConflictDoNothing({
            target: [developerModuleArtifacts.accountId, developerModuleArtifacts.artifactDigest],
          })
          .returning();
        if (inserted) return serializeDeveloperModuleArtifactRow(inserted);
        const [existingRow] = await tx
          .select()
          .from(developerModuleArtifacts)
          .where(
            and(
              eq(developerModuleArtifacts.accountId, input.account_id),
              eq(developerModuleArtifacts.artifactDigest, input.artifact_digest),
            ),
          )
          .limit(1);
        if (!existingRow) throw new Error('Developer artifact digest conflict lookup failed');
        const existing = serializeDeveloperModuleArtifactRow(existingRow);
        if (!sameImmutableArtifact(existing, input)) {
          throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 409);
        }
        return existing;
      });
    },

    async finalizeUpload(input) {
      return db.transaction(async (tx) => {
        const uploadRows = await tx
          .select()
          .from(developerModuleArtifactUploads)
          .where(
            and(
              eq(developerModuleArtifactUploads.accountId, input.accountId),
              eq(developerModuleArtifactUploads.uploadId, input.uploadId),
            ),
          )
          .limit(1)
          .for('update');
        const upload = uploadRows[0];
        if (!upload) {
          throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND', 404);
        }
        if (upload.state === 'finalized' && upload.artifactId) {
          const [existing] = await tx
            .select()
            .from(developerModuleArtifacts)
            .where(
              and(
                eq(developerModuleArtifacts.accountId, input.accountId),
                eq(developerModuleArtifacts.artifactId, upload.artifactId),
              ),
            )
            .limit(1);
          if (existing) return serializeDeveloperModuleArtifactRow(existing);
        }
        if (upload.state !== 'created' && upload.state !== 'uploaded') {
          throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID', 409);
        }

        const [inserted] = await tx
          .insert(developerModuleArtifacts)
          .values(artifactValues(input.artifact))
          .onConflictDoNothing({
            target: [developerModuleArtifacts.accountId, developerModuleArtifacts.artifactDigest],
          })
          .returning();
        let artifact = inserted ? serializeDeveloperModuleArtifactRow(inserted) : null;
        if (!artifact) {
          const [existing] = await tx
            .select()
            .from(developerModuleArtifacts)
            .where(
              and(
                eq(developerModuleArtifacts.accountId, input.accountId),
                eq(developerModuleArtifacts.artifactDigest, input.artifact.artifact_digest),
              ),
            )
            .limit(1);
          if (existing) artifact = serializeDeveloperModuleArtifactRow(existing);
        }
        if (!artifact || !sameImmutableArtifact(artifact, input.artifact)) {
          throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 409);
        }

        const updated = await tx
          .update(developerModuleArtifactUploads)
          .set({
            state: 'finalized',
            artifactId: artifact.artifact_id,
            updatedAt: input.updatedAt,
          })
          .where(
            and(
              eq(developerModuleArtifactUploads.accountId, input.accountId),
              eq(developerModuleArtifactUploads.uploadId, input.uploadId),
              inArray(developerModuleArtifactUploads.state, ['created', 'uploaded']),
            ),
          )
          .returning({ uploadId: developerModuleArtifactUploads.uploadId });
        if (updated.length !== 1) {
          throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID', 409);
        }
        return artifact;
      });
    },

    async getArtifact(accountId, artifactId) {
      const [row] = await db
        .select()
        .from(developerModuleArtifacts)
        .where(
          and(
            eq(developerModuleArtifacts.accountId, accountId),
            eq(developerModuleArtifacts.artifactId, artifactId),
          ),
        )
        .limit(1);
      return row ? serializeDeveloperModuleArtifactRow(row) : null;
    },

    async listArtifacts(accountId) {
      const rows = await db
        .select()
        .from(developerModuleArtifacts)
        .where(eq(developerModuleArtifacts.accountId, accountId))
        .orderBy(
          desc(developerModuleArtifacts.createdAt),
          desc(developerModuleArtifacts.artifactId),
        );
      return rows.map(serializeDeveloperModuleArtifactRow);
    },
  };
}

export function createDrizzleDeveloperArtifactRetentionRepository(
  db: Database,
): DeveloperArtifactRetentionRepository {
  return {
    async enqueueRun(input) {
      if (input.acceptanceRunId !== null) {
        assertRetentionIdentifier(input.acceptanceRunId, 'acceptance run id');
      }
      assertDurationMs(input.delayMs, 'retention enqueue delay', true);
      return db.transaction(async (tx) => {
        const inserted = retentionRows(
          await tx.execute(sql`
            INSERT INTO kortix.developer_artifact_retention_runs (
              acceptance_run_id,
              state,
              available_at
            )
            VALUES (
              ${input.acceptanceRunId},
              'queued',
              CURRENT_TIMESTAMP + (${input.delayMs} * INTERVAL '1 millisecond')
            )
            ON CONFLICT DO NOTHING
            RETURNING ${RETENTION_STATUS_COLUMNS}
          `),
        )[0];
        if (inserted) return serializeRetentionRunStatus(inserted);
        const existing = retentionRows(
          await tx.execute(sql`
            SELECT ${RETENTION_STATUS_COLUMNS}
            FROM kortix.developer_artifact_retention_runs
            WHERE ${
              input.acceptanceRunId === null
                ? sql`acceptance_run_id IS NULL AND state IN ('queued', 'running')`
                : sql`acceptance_run_id = ${input.acceptanceRunId}`
            }
            ORDER BY created_at ASC, run_id ASC
            LIMIT 1
          `),
        )[0];
        if (!existing) throw new Error('Idempotent retention run lookup failed');
        return serializeRetentionRunStatus(existing);
      });
    },

    async getRunByAcceptanceRunId(acceptanceRunId) {
      assertRetentionIdentifier(acceptanceRunId, 'acceptance run id');
      const row = retentionRows(
        await db.execute(sql`
          SELECT ${RETENTION_STATUS_COLUMNS}
          FROM kortix.developer_artifact_retention_runs
          WHERE acceptance_run_id = ${acceptanceRunId}
          LIMIT 1
        `),
      )[0];
      return row ? serializeRetentionRunStatus(row) : null;
    },

    async claimRun(input) {
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertDurationMs(input.leaseMs, 'retention lease duration');
      const row = retentionRows(
        await db.execute(sql`
          WITH candidate AS (
            SELECT run.run_id
            FROM kortix.developer_artifact_retention_runs run
            WHERE (
              run.state = 'queued'
              AND run.available_at <= CURRENT_TIMESTAMP
            ) OR (
              run.state = 'running'
              AND run.lease_expires_at <= CURRENT_TIMESTAMP
            )
            ORDER BY run.created_at ASC, run.run_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE kortix.developer_artifact_retention_runs run
          SET state = 'running',
              attempts = run.attempts + 1,
              lease_owner = ${input.ownerId},
              lease_expires_at = CURRENT_TIMESTAMP
                + (${input.leaseMs} * INTERVAL '1 millisecond'),
              updated_at = CURRENT_TIMESTAMP
          FROM candidate
          WHERE run.run_id = candidate.run_id
          RETURNING
            run.run_id AS "runId",
            run.acceptance_run_id AS "acceptanceRunId",
            run.state,
            run.attempts,
            run.cursor,
            run.lease_owner AS "leaseOwner",
            run.lease_expires_at AS "leaseExpiresAt",
            CURRENT_TIMESTAMP AS "claimedAt"
        `),
      )[0];
      return row ? serializeClaimedRetentionRun(row) : null;
    },

    async renewRunLease(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertDurationMs(input.leaseMs, 'retention lease duration');
      const row = retentionRows(
        await db.execute(sql`
          WITH owned_run AS MATERIALIZED (
            SELECT
              run.run_id,
              run.lease_expires_at AS previous_lease_expires_at,
              CURRENT_TIMESTAMP
                + (${input.leaseMs} * INTERVAL '1 millisecond')
                AS renewed_lease_expires_at
            FROM kortix.developer_artifact_retention_runs run
            WHERE run.run_id = ${input.runId}
              AND run.state = 'running'
              AND run.lease_owner = ${input.ownerId}
              AND run.lease_expires_at > CURRENT_TIMESTAMP
            FOR UPDATE
          ),
          renewed_uploads AS (
            UPDATE kortix.developer_module_artifact_uploads upload
            SET cleanup_next_attempt_at = owned_run.renewed_lease_expires_at,
                updated_at = CURRENT_TIMESTAMP
            FROM owned_run
            WHERE upload.staging_deleted_at IS NULL
              AND upload.state IN ('cancelled', 'expired', 'finalized')
              AND upload.cleanup_next_attempt_at = owned_run.previous_lease_expires_at
            RETURNING upload.upload_id
          ),
          renewed_run AS (
            UPDATE kortix.developer_artifact_retention_runs run
            SET lease_expires_at = owned_run.renewed_lease_expires_at,
                updated_at = CURRENT_TIMESTAMP
            FROM owned_run
            WHERE run.run_id = owned_run.run_id
            RETURNING run.run_id
          )
          SELECT
            EXISTS (SELECT 1 FROM renewed_run) AS valid,
            CURRENT_TIMESTAMP AS "now"
        `),
      )[0];
      if (!row) throw new Error('Retention lease renewal query failed');
      return {
        valid: retentionBoolean(row, 'valid', 'valid'),
        now: retentionTimestamp(row, 'now', 'now'),
      };
    },

    async claimUploadCandidates(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new TypeError('Invalid retention candidate limit');
      }
      return db.transaction(async (tx) => {
        const ownedRun = retentionRows(
          await tx.execute(sql`
            SELECT run_id AS "runId"
            FROM kortix.developer_artifact_retention_runs
            WHERE run_id = ${input.runId}
              AND state = 'running'
              AND lease_owner = ${input.ownerId}
              AND lease_expires_at > CURRENT_TIMESTAMP
            FOR UPDATE
          `),
        )[0];
        if (!ownedRun) throw new Error('Developer artifact retention lease lost');

        const candidates = retentionRows(
          await tx.execute(sql`
            WITH candidate AS (
              SELECT upload.upload_id, upload.account_id
              FROM kortix.developer_module_artifact_uploads upload
              WHERE upload.staging_deleted_at IS NULL
                AND (
                  upload.cleanup_next_attempt_at IS NULL
                  OR upload.cleanup_next_attempt_at <= CURRENT_TIMESTAMP
                )
                AND (
                  upload.state IN ('cancelled', 'expired', 'finalized')
                  OR (
                    upload.state IN ('created', 'uploaded')
                    AND upload.expires_at <= CURRENT_TIMESTAMP
                  )
                )
              ORDER BY upload.expires_at ASC, upload.upload_id ASC
              FOR UPDATE SKIP LOCKED
              LIMIT ${input.limit}
            )
            UPDATE kortix.developer_module_artifact_uploads upload
            SET state = CASE
                  WHEN upload.state IN ('created', 'uploaded')
                    THEN 'expired'::kortix.developer_artifact_upload_state
                  ELSE upload.state
                END,
                cleanup_next_attempt_at = run.lease_expires_at,
                updated_at = CURRENT_TIMESTAMP
            FROM candidate, kortix.developer_artifact_retention_runs run
            WHERE upload.upload_id = candidate.upload_id
              AND upload.account_id = candidate.account_id
              AND run.run_id = ${input.runId}
              AND run.state = 'running'
              AND run.lease_owner = ${input.ownerId}
              AND run.lease_expires_at > CURRENT_TIMESTAMP
            RETURNING
              upload.account_id AS "accountId",
              upload.upload_id AS "uploadId",
              upload.state,
              upload.staging_storage_key AS "storageKey",
              upload.cleanup_attempts AS "cleanupAttempts"
          `),
        );
        return candidates.map((row): DeveloperArtifactCleanupCandidate => {
          const state = retentionString(row, 'state', 'state');
          if (state !== 'cancelled' && state !== 'expired' && state !== 'finalized') {
            throw new TypeError('Invalid retention upload state');
          }
          return {
            accountId: retentionString(row, 'accountId', 'account_id'),
            uploadId: retentionString(row, 'uploadId', 'upload_id'),
            state,
            storageKey: retentionString(row, 'storageKey', 'staging_storage_key'),
            cleanupAttempts: retentionNumber(row, 'cleanupAttempts', 'cleanup_attempts'),
          };
        });
      });
    },

    async markUploadDeleted(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertUuid(input.accountId, 'retention account id');
      assertUuid(input.uploadId, 'retention upload id');
      const result = await db.execute(sql`
        UPDATE kortix.developer_module_artifact_uploads upload
        SET staging_deleted_at = CURRENT_TIMESTAMP,
            cleanup_next_attempt_at = NULL,
            cleanup_last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        FROM kortix.developer_artifact_retention_runs run
        WHERE upload.account_id = ${input.accountId}
          AND upload.upload_id = ${input.uploadId}
          AND upload.state IN ('cancelled', 'expired', 'finalized')
          AND upload.staging_deleted_at IS NULL
          AND upload.cleanup_next_attempt_at = run.lease_expires_at
          AND run.run_id = ${input.runId}
          AND run.state = 'running'
          AND run.lease_owner = ${input.ownerId}
          AND run.lease_expires_at > CURRENT_TIMESTAMP
        RETURNING upload.upload_id AS "uploadId"
      `);
      return retentionRows(result).length === 1;
    },

    async recordUploadFailure(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertUuid(input.accountId, 'retention account id');
      assertUuid(input.uploadId, 'retention upload id');
      assertRetentionIdentifier(input.errorCode, 'retention error code');
      assertDurationMs(input.delayMs, 'retention retry delay');
      const result = await db.execute(sql`
        UPDATE kortix.developer_module_artifact_uploads upload
        SET cleanup_attempts = upload.cleanup_attempts + 1,
            cleanup_next_attempt_at = CURRENT_TIMESTAMP
              + (${input.delayMs} * INTERVAL '1 millisecond'),
            cleanup_last_error = ${input.errorCode},
            updated_at = CURRENT_TIMESTAMP
        FROM kortix.developer_artifact_retention_runs run
        WHERE upload.account_id = ${input.accountId}
          AND upload.upload_id = ${input.uploadId}
          AND upload.state IN ('cancelled', 'expired', 'finalized')
          AND upload.staging_deleted_at IS NULL
          AND upload.cleanup_next_attempt_at = run.lease_expires_at
          AND run.run_id = ${input.runId}
          AND run.state = 'running'
          AND run.lease_owner = ${input.ownerId}
          AND run.lease_expires_at > CURRENT_TIMESTAMP
        RETURNING upload.upload_id AS "uploadId"
      `);
      return retentionRows(result).length === 1;
    },

    async isStagingKeyReferenced(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertStagingStorageKey(input.storageKey);
      const row = retentionRows(
        await db.execute(sql`
          WITH lease AS (
            SELECT EXISTS (
              SELECT 1
              FROM kortix.developer_artifact_retention_runs run
              WHERE run.run_id = ${input.runId}
                AND run.state = 'running'
                AND run.lease_owner = ${input.ownerId}
                AND run.lease_expires_at > CURRENT_TIMESTAMP
            ) AS lease_valid
          )
          SELECT
            lease.lease_valid AS "leaseValid",
            CASE
              WHEN lease.lease_valid THEN EXISTS (
                SELECT 1
                FROM kortix.developer_module_artifact_uploads upload
                WHERE upload.staging_storage_key = ${input.storageKey}
                  AND upload.staging_deleted_at IS NULL
              )
              ELSE false
            END AS referenced
          FROM lease
        `),
      )[0];
      if (!row) throw new Error('Retention lease decision query failed');
      return {
        leaseValid: retentionBoolean(row, 'leaseValid', 'lease_valid'),
        referenced: retentionBoolean(row, 'referenced', 'referenced'),
      };
    },

    async rescheduleRun(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertCursor(input.cursor);
      assertDurationMs(input.delayMs, 'retention reschedule delay', true);
      const result = await db.execute(sql`
        UPDATE kortix.developer_artifact_retention_runs
        SET state = 'queued',
            available_at = CURRENT_TIMESTAMP
              + (${input.delayMs} * INTERVAL '1 millisecond'),
            lease_owner = NULL,
            lease_expires_at = NULL,
            cursor = ${input.cursor},
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ${input.runId}
          AND state = 'running'
          AND lease_owner = ${input.ownerId}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING run_id AS "runId"
      `);
      return retentionRows(result).length === 1;
    },

    async completeRun(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      const result = await db.execute(sql`
        UPDATE kortix.developer_artifact_retention_runs
        SET state = 'succeeded',
            lease_owner = NULL,
            lease_expires_at = NULL,
            cursor = NULL,
            last_error = NULL,
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ${input.runId}
          AND state = 'running'
          AND lease_owner = ${input.ownerId}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING run_id AS "runId"
      `);
      return retentionRows(result).length === 1;
    },

    async retryRun(input) {
      assertUuid(input.runId, 'retention run id');
      assertRetentionIdentifier(input.ownerId, 'retention owner id');
      assertRetentionIdentifier(input.errorCode, 'retention error code');
      assertDurationMs(input.delayMs, 'retention retry delay');
      const terminalState = input.terminal ? sql.raw("'failed'") : sql.raw("'queued'");
      const finishedAt = input.terminal
        ? sql.raw('CURRENT_TIMESTAMP')
        : sql.raw('NULL');
      // The claim already consumed this attempt, so a retry must not double count it.
      const result = await db.execute(sql`
        UPDATE kortix.developer_artifact_retention_runs
        SET state = ${terminalState},
            available_at = CURRENT_TIMESTAMP
              + (${input.delayMs} * INTERVAL '1 millisecond'),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ${input.errorCode},
            finished_at = ${finishedAt},
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ${input.runId}
          AND state = 'running'
          AND lease_owner = ${input.ownerId}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING run_id AS "runId"
      `);
      return retentionRows(result).length === 1;
    },
  };
}
