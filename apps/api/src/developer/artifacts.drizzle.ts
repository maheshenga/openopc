import {
  type Database,
  developerModuleArtifactUploads,
  developerModuleArtifacts,
  developerPublishers,
} from '@kortix/db';
import type { RegistryItem, RegistryModuleSourceProvenance } from '@kortix/registry';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  DeveloperModuleArtifactError,
  type DeveloperModuleArtifactRecord,
  type DeveloperModuleArtifactRepository,
  type DeveloperModuleArtifactUploadRecord,
} from './artifacts';

type ArtifactRow = typeof developerModuleArtifacts.$inferSelect;
type UploadRow = typeof developerModuleArtifactUploads.$inferSelect;

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
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .insert(developerPublishers)
          .values({
            publisherId: input.publisherId,
            accountId: input.accountId,
            displayName: input.displayName.trim() || input.publisherId,
            createdBy: input.actorUserId,
          })
          .onConflictDoNothing({ target: developerPublishers.publisherId })
          .returning({ publisherId: developerPublishers.publisherId });
        if (claimed) return;

        const [existing] = await tx
          .select()
          .from(developerPublishers)
          .where(eq(developerPublishers.publisherId, input.publisherId))
          .limit(1);
        if (!existing || existing.accountId !== input.accountId) {
          throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT', 409);
        }
      });
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
