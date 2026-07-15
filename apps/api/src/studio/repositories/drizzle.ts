import type {
  StudioAsset,
  StudioJob,
  StudioJobEvent,
  StudioProviderConfig,
  StudioUpload,
} from '@kortix/api-contract';
import {
  type Database,
  studioAssetUploads,
  studioAssets,
  studioJobEvents,
  studioJobs,
  studioProviderConfigs,
} from '@kortix/db';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { StudioRepositoryError } from '../types';
import type {
  StudioCreateJobInput,
  StudioCreateJobResult,
  StudioProviderConfigWire,
  StudioRepository,
} from '../types';

type ProviderRow = typeof studioProviderConfigs.$inferSelect;
type JobRow = typeof studioJobs.$inferSelect;
type EventRow = typeof studioJobEvents.$inferSelect;
type UploadRow = typeof studioAssetUploads.$inferSelect;
type AssetRow = typeof studioAssets.$inferSelect;

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function nullableNumberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function providerCapabilities(raw: unknown): StudioProviderConfig['capabilities'] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is 'image.generate' => item === 'image.generate');
  }
  if (raw && typeof raw === 'object') {
    const candidate = (raw as Record<string, unknown>).capabilities;
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is 'image.generate' => item === 'image.generate');
    }
    if ((raw as Record<string, unknown>)['image.generate']) return ['image.generate'];
  }
  return [];
}

function publicCredentialBinding(raw: unknown): StudioProviderConfig['credential_binding'] | null {
  if (!raw || typeof raw !== 'object') return raw == null ? { kind: 'none' } : null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === 'none') return { kind: 'none' };
  if (candidate.kind === 'secret' && typeof candidate.identifier === 'string') {
    return candidate.identifier ? { kind: 'secret', identifier: candidate.identifier } : null;
  }
  if (candidate.kind === 'connector' && typeof candidate.slug === 'string') {
    return candidate.slug ? { kind: 'connector', slug: candidate.slug } : null;
  }
  return null;
}

function serializeProvider(row: ProviderRow): StudioProviderConfigWire | null {
  if (row.provider !== 'fake' && row.provider !== 'openai-compatible') return null;
  const credential = publicCredentialBinding(row.credentialBinding);
  if (!credential) return null;
  return {
    provider_config_id: row.providerConfigId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.provider,
    display_name: row.displayName,
    base_url: row.baseUrl ?? null,
    region: row.region ?? null,
    credential_binding: credential,
    capabilities: providerCapabilities(row.capabilityMap),
    enabled: row.enabled === true,
    created_at: row.createdAt ?? new Date(0).toISOString(),
    updated_at: row.updatedAt ?? new Date(0).toISOString(),
  };
}

function serializeJob(row: JobRow): StudioJob {
  return {
    job_id: row.jobId,
    account_id: row.accountId,
    project_id: row.projectId,
    actor_user_id: row.actorUserId ?? null,
    actor_type: row.actorType as StudioJob['actor_type'],
    capability: row.capability as StudioJob['capability'],
    provider_config_id: row.providerConfigId,
    provider: row.provider,
    model: row.model,
    input: row.input as StudioJob['input'],
    status: row.status as StudioJob['status'],
    idempotency_key: row.idempotencyKey,
    request_hash: row.requestHash,
    attempt_count: row.attemptCount,
    reserved_credits: numberValue(row.reservedCredits),
    actual_credits: nullableNumberValue(row.actualCredits),
    error_code: (row.errorCode as StudioJob['error_code']) ?? null,
    error_message: row.errorMessage ?? null,
    created_at: row.createdAt ?? new Date(0).toISOString(),
    updated_at: row.updatedAt ?? new Date(0).toISOString(),
    started_at: row.startedAt ?? null,
    completed_at: row.completedAt ?? null,
  };
}

function serializeEvent(row: EventRow): StudioJobEvent {
  return {
    event_id: row.eventId,
    job_id: row.jobId,
    cursor: String(row.cursor),
    type: row.eventType as StudioJobEvent['type'],
    payload: row.payload ?? {},
    created_at: row.createdAt ?? new Date(0).toISOString(),
  };
}

function serializeUpload(row: UploadRow): StudioUpload {
  return {
    upload_id: row.uploadId,
    project_id: row.projectId,
    asset_id: row.finalizedAssetId ?? null,
    object_key: row.objectKey,
    declared_mime_type: row.declaredMimeType,
    expected_size_bytes: Number(row.expectedSizeBytes),
    expected_checksum_sha256: row.expectedChecksumSha256,
    signed_upload_url: `https://studio.local/upload/${row.uploadId}`,
    expires_at: row.expiresAt,
    status: row.status as StudioUpload['status'],
  };
}

function serializeAsset(row: AssetRow): StudioAsset {
  return {
    asset_id: row.assetId,
    account_id: row.accountId,
    project_id: row.projectId,
    source_job_id: row.sourceJobId ?? null,
    kind: row.kind as StudioAsset['kind'],
    mime_type: row.mimeType,
    bucket: row.bucket,
    object_key: row.objectKey,
    checksum_sha256: row.checksumSha256,
    size_bytes: Number(row.sizeBytes),
    width: row.width ?? null,
    height: row.height ?? null,
    metadata: row.metadata ?? {},
    created_at: row.createdAt ?? new Date(0).toISOString(),
  };
}

function rowsFromExecute(value: unknown): Record<string, unknown>[] {
  if (!value || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    return [];
  }
  return Array.from(value as Iterable<Record<string, unknown>>);
}

export function createDrizzleStudioRepository(db: Database): StudioRepository {
  return {
    async listProviders(projectId) {
      const rows = await db
        .select()
        .from(studioProviderConfigs)
        .where(
          and(
            eq(studioProviderConfigs.projectId, projectId),
            eq(studioProviderConfigs.enabled, true),
          ),
        );
      return rows
        .map(serializeProvider)
        .filter(
          (provider: StudioProviderConfigWire | null): provider is StudioProviderConfigWire =>
            !!provider,
        );
    },

    async getProvider(projectId, providerConfigId) {
      const rows = await db
        .select()
        .from(studioProviderConfigs)
        .where(
          and(
            eq(studioProviderConfigs.projectId, projectId),
            eq(studioProviderConfigs.providerConfigId, providerConfigId),
            eq(studioProviderConfigs.enabled, true),
          ),
        )
        .limit(1);
      return rows[0] ? serializeProvider(rows[0]) : null;
    },

    async createJob(input, provider, estimate): Promise<StudioCreateJobResult> {
      const existing = await db
        .select()
        .from(studioJobs)
        .where(
          and(
            eq(studioJobs.accountId, input.account_id),
            eq(studioJobs.idempotencyKey, input.idempotency_key),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (
          existing[0].projectId !== input.project_id ||
          existing[0].requestHash !== input.request_hash
        ) {
          return { created: false, mismatch: true };
        }
        return {
          job: serializeJob(existing[0]),
          created: false,
        };
      }

      const reservationExpiresAt = new Date(
        Math.max(Date.now() + 24 * 60 * 60_000, Date.parse(estimate.expires_at)),
      ).toISOString();
      const rpcRows = await db.execute(sql`
        SELECT public.atomic_create_studio_job(
          ${input.account_id}::uuid,
          ${input.project_id}::uuid,
          ${input.actor_user_id}::uuid,
          ${input.actor_type},
          ${input.acting_token_id}::uuid,
          ${input.agent_name},
          ${input.session_id},
          ${input.parent_job_id}::uuid,
          ${input.capability},
          ${input.provider_config_id}::uuid,
          ${provider.provider},
          ${input.model},
          ${JSON.stringify(input.input)}::jsonb,
          ${input.idempotency_key},
          ${input.request_hash},
          ${String(estimate.max_approved_credits)}::numeric,
          ${reservationExpiresAt}::timestamptz
        ) AS result
      `);
      const rpc = rowsFromExecute(rpcRows)[0]?.result as Record<string, unknown> | undefined;
      if (!rpc || rpc.success !== true) {
        if (rpc?.code === 'idempotency_mismatch') {
          return { created: false, mismatch: true };
        }
        if (rpc?.code === 'insufficient_credits') {
          throw new StudioRepositoryError(
            'STUDIO_INSUFFICIENT_CREDITS',
            402,
            'Insufficient credits',
          );
        }
        throw new Error(String(rpc?.error ?? 'Studio job reservation failed'));
      }
      const jobId = String(rpc.job_id);
      const rows = await db
        .select()
        .from(studioJobs)
        .where(and(eq(studioJobs.projectId, input.project_id), eq(studioJobs.jobId, jobId)))
        .limit(1);
      if (!rows[0]) throw new Error('Studio job was created but could not be reloaded');
      const job = serializeJob(rows[0]);
      return { job, created: rpc.idempotent !== true };
    },

    async listJobs(projectId, limit, cursor) {
      const conditions = [eq(studioJobs.projectId, projectId)];
      if (cursor) conditions.push(lt(studioJobs.createdAt, cursor));
      const rows = await db
        .select()
        .from(studioJobs)
        .where(and(...conditions))
        .orderBy(desc(studioJobs.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(serializeJob);
      return {
        items: page,
        next_cursor: rows.length > limit ? rows[limit].createdAt : null,
      };
    },

    async getJob(projectId, jobId) {
      const rows = await db
        .select()
        .from(studioJobs)
        .where(and(eq(studioJobs.projectId, projectId), eq(studioJobs.jobId, jobId)))
        .limit(1);
      return rows[0] ? serializeJob(rows[0]) : null;
    },

    async requestCancellation(projectId, jobId) {
      const now = new Date().toISOString();
      const rows = await db.execute(sql`
        WITH locked AS (
          SELECT job_id, status
          FROM kortix.studio_jobs
          WHERE project_id = ${projectId}::uuid
            AND job_id = ${jobId}::uuid
            AND status IN ('queued', 'running')
          FOR UPDATE
        ), updated AS (
          UPDATE kortix.studio_jobs job
          SET cancellation_requested_at = ${now}::timestamptz,
              status = CASE WHEN locked.status = 'queued' THEN 'cancelled'::kortix.studio_job_status ELSE job.status END,
              completed_at = CASE WHEN locked.status = 'queued' THEN ${now}::timestamptz ELSE job.completed_at END,
              lease_owner = CASE WHEN locked.status = 'queued' THEN NULL ELSE job.lease_owner END,
              lease_expires_at = CASE WHEN locked.status = 'queued' THEN NULL ELSE job.lease_expires_at END,
              updated_at = ${now}::timestamptz
          FROM locked
          WHERE job.job_id = locked.job_id
          RETURNING job.job_id, job.status, locked.status AS prior_status
        ), released AS (
          UPDATE kortix.studio_credit_reservations reservation
          SET status = 'released',
              release_key = ${`studio:cancel:${jobId}`},
              released_at = ${now}::timestamptz
          FROM updated
          WHERE reservation.job_id = updated.job_id
            AND updated.prior_status = 'queued'
            AND reservation.status = 'active'
          RETURNING reservation.job_id
        ), next_cursor AS (
          SELECT COALESCE(MAX(event.cursor), 0) + 1 AS cursor
          FROM kortix.studio_job_events event
          JOIN updated ON updated.job_id = event.job_id
        ), terminal_event AS (
          INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
          SELECT updated.job_id, next_cursor.cursor, 'cancelled', ${JSON.stringify({ reason: 'user_cancelled' })}::jsonb, ${now}::timestamptz
          FROM updated CROSS JOIN next_cursor
          WHERE updated.prior_status = 'queued'
          RETURNING job_id
        )
        SELECT job_id, status FROM updated
      `);
      if (!rowsFromExecute(rows)[0]) return null;
      return this.getJob(projectId, jobId);
    },

    async listEvents(projectId, jobId, afterCursor) {
      const job = await this.getJob(projectId, jobId);
      if (!job) return { items: [], next_cursor: null };
      const conditions = [eq(studioJobEvents.jobId, jobId)];
      if (afterCursor) conditions.push(gt(studioJobEvents.cursor, Number(afterCursor)));
      const rows = await db
        .select()
        .from(studioJobEvents)
        .where(and(...conditions))
        .orderBy(studioJobEvents.cursor)
        .limit(101);
      const page = rows.slice(0, 100).map(serializeEvent);
      return {
        items: page,
        next_cursor: rows.length > 100 ? String(rows[100].cursor) : null,
      };
    },

    async createUpload(input) {
      const uploadId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const rows = await db
        .insert(studioAssetUploads)
        .values({
          uploadId,
          accountId: input.account_id,
          projectId: input.project_id,
          actorUserId: input.actor_user_id,
          objectKey: `studio/uploads/${input.project_id}/${uploadId}`,
          declaredMimeType: input.declared_mime_type,
          expectedSizeBytes: input.expected_size_bytes,
          expectedChecksumSha256: input.expected_checksum_sha256,
          expiresAt,
          status: 'pending',
        })
        .returning();
      return serializeUpload(rows[0]);
    },

    async finalizeUpload(projectId, uploadId) {
      const uploads = await db
        .select()
        .from(studioAssetUploads)
        .where(
          and(
            eq(studioAssetUploads.projectId, projectId),
            eq(studioAssetUploads.uploadId, uploadId),
            eq(studioAssetUploads.status, 'pending'),
          ),
        )
        .limit(1);
      const upload = uploads[0];
      if (!upload) return null;

      const inserted = await db
        .insert(studioAssets)
        .values({
          accountId: upload.accountId,
          projectId: upload.projectId,
          creatorUserId: upload.actorUserId,
          sourceJobId: null,
          kind: 'image',
          mimeType: upload.declaredMimeType,
          bucket: 'studio',
          objectKey: upload.objectKey,
          checksumSha256: upload.expectedChecksumSha256,
          sizeBytes: upload.expectedSizeBytes,
          metadata: {},
        })
        .returning();
      const asset = serializeAsset(inserted[0]);
      await db
        .update(studioAssetUploads)
        .set({
          status: 'finalized',
          finalizedAssetId: asset.asset_id,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(studioAssetUploads.uploadId, uploadId));
      return asset;
    },

    async listAssets(projectId, limit, cursor) {
      const conditions = [eq(studioAssets.projectId, projectId)];
      if (cursor) conditions.push(lt(studioAssets.createdAt, cursor));
      const rows = await db
        .select()
        .from(studioAssets)
        .where(and(...conditions))
        .orderBy(desc(studioAssets.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(serializeAsset);
      return {
        items: page,
        next_cursor: rows.length > limit ? rows[limit].createdAt : null,
      };
    },

    async getAsset(projectId, assetId) {
      const rows = await db
        .select()
        .from(studioAssets)
        .where(and(eq(studioAssets.projectId, projectId), eq(studioAssets.assetId, assetId)))
        .limit(1);
      return rows[0] ? serializeAsset(rows[0]) : null;
    },
  };
}
