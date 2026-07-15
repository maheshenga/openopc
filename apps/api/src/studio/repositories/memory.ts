import type { StudioAsset, StudioJob, StudioJobEvent, StudioUpload } from '@kortix/api-contract';
import type {
  StudioCreateJobInput,
  StudioCreateJobResult,
  StudioProviderConfigWire,
  StudioRepository,
} from '../types';

type MemoryStudioRepositoryInput = {
  providers?: StudioProviderConfigWire[];
  now?: () => string;
};

function isoNow() {
  return new Date().toISOString();
}

export function createMemoryStudioRepository(
  input: MemoryStudioRepositoryInput = {},
): StudioRepository {
  const providers = new Map(
    input.providers?.map((provider) => [provider.provider_config_id, provider]) ?? [],
  );
  const jobs = new Map<string, StudioJob>();
  const events = new Map<string, StudioJobEvent[]>();
  const uploads = new Map<
    string,
    StudioUpload & {
      account_id: string;
      actor_user_id: string | null;
      metadata: Record<string, unknown>;
    }
  >();
  const assets = new Map<string, StudioAsset>();
  const now = input.now ?? isoNow;

  const appendEvent = (
    jobId: string,
    type: StudioJobEvent['type'],
    payload: Record<string, unknown>,
  ) => {
    const list = events.get(jobId) ?? [];
    const cursor = String(list.length + 1);
    list.push({
      event_id: crypto.randomUUID(),
      job_id: jobId,
      cursor,
      type,
      payload,
      created_at: now(),
    });
    events.set(jobId, list);
  };

  return {
    async listProviders(projectId) {
      return [...providers.values()].filter(
        (provider) => provider.project_id === projectId && provider.enabled,
      );
    },

    async getProvider(projectId, providerConfigId) {
      const provider = providers.get(providerConfigId);
      return provider?.project_id === projectId && provider.enabled ? provider : null;
    },

    async createJob(input, provider, estimate): Promise<StudioCreateJobResult> {
      const existing = [...jobs.values()].find(
        (job) =>
          job.account_id === input.account_id && job.idempotency_key === input.idempotency_key,
      );
      if (existing) {
        if (
          existing.project_id !== input.project_id ||
          existing.request_hash !== input.request_hash
        ) {
          return { created: false, mismatch: true };
        }
        return {
          job: existing,
          created: false,
        };
      }

      const createdAt = now();
      const job: StudioJob = {
        job_id: crypto.randomUUID(),
        account_id: input.account_id,
        project_id: input.project_id,
        actor_user_id: input.actor_user_id,
        actor_type: input.actor_type,
        capability: input.capability,
        provider_config_id: input.provider_config_id,
        provider: provider.provider,
        model: input.model,
        input: input.input,
        status: 'queued',
        idempotency_key: input.idempotency_key,
        request_hash: input.request_hash,
        attempt_count: 0,
        reserved_credits: estimate.max_approved_credits,
        actual_credits: null,
        error_code: null,
        error_message: null,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: null,
        completed_at: null,
      };
      jobs.set(job.job_id, job);
      appendEvent(job.job_id, 'queued', {
        capability: job.capability,
        provider_config_id: job.provider_config_id,
        model: job.model,
      });
      return { job, created: true };
    },

    async listJobs(projectId, limit, cursor) {
      const after = cursor ? Number(cursor) : 0;
      const all = [...jobs.values()]
        .filter((job) => job.project_id === projectId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      const page = all.slice(after, after + limit);
      const next = after + page.length < all.length ? String(after + page.length) : null;
      return { items: page, next_cursor: next };
    },

    async getJob(projectId, jobId) {
      const job = jobs.get(jobId);
      return job?.project_id === projectId ? job : null;
    },

    async requestCancellation(projectId, jobId) {
      const job = jobs.get(jobId);
      if (!job || job.project_id !== projectId || !['queued', 'running'].includes(job.status))
        return null;
      if (job.status === 'running') {
        const updated = { ...job, updated_at: now() };
        jobs.set(jobId, updated);
        return updated;
      }
      const updated: StudioJob = {
        ...job,
        status: 'cancelled',
        updated_at: now(),
        completed_at: now(),
      };
      jobs.set(jobId, updated);
      appendEvent(jobId, 'cancelled', { reason: 'user_cancelled' });
      return updated;
    },

    async listEvents(projectId, jobId, afterCursor) {
      const job = jobs.get(jobId);
      if (!job || job.project_id !== projectId) return { items: [], next_cursor: null };
      const after = afterCursor ? Number(afterCursor) : 0;
      const page = (events.get(jobId) ?? []).filter((event) => Number(event.cursor) > after);
      return { items: page, next_cursor: null };
    },

    async createUpload(input) {
      const uploadId = crypto.randomUUID();
      const upload: StudioUpload & {
        account_id: string;
        actor_user_id: string | null;
        metadata: Record<string, unknown>;
      } = {
        upload_id: uploadId,
        project_id: input.project_id,
        asset_id: null,
        object_key: `studio/uploads/${input.project_id}/${uploadId}`,
        declared_mime_type: input.declared_mime_type,
        expected_size_bytes: input.expected_size_bytes,
        expected_checksum_sha256: input.expected_checksum_sha256,
        signed_upload_url: `https://studio.local/upload/${uploadId}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        status: 'pending',
        account_id: input.account_id,
        actor_user_id: input.actor_user_id,
        metadata: input.metadata,
      };
      uploads.set(uploadId, upload);
      const {
        account_id: _accountId,
        actor_user_id: _actorUserId,
        metadata: _metadata,
        ...wire
      } = upload;
      return wire;
    },

    async finalizeUpload(projectId, uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.project_id !== projectId || upload.status !== 'pending') return null;
      const assetId = crypto.randomUUID();
      const asset: StudioAsset = {
        asset_id: assetId,
        account_id: upload.account_id,
        project_id: upload.project_id,
        source_job_id: null,
        kind: 'image',
        mime_type: upload.declared_mime_type,
        bucket: 'studio',
        object_key: upload.object_key,
        checksum_sha256: upload.expected_checksum_sha256,
        size_bytes: upload.expected_size_bytes,
        width: null,
        height: null,
        metadata: upload.metadata,
        created_at: now(),
      };
      assets.set(assetId, asset);
      uploads.set(uploadId, { ...upload, asset_id: assetId, status: 'finalized' });
      return asset;
    },

    async listAssets(projectId, limit, cursor) {
      const after = cursor ? Number(cursor) : 0;
      const all = [...assets.values()]
        .filter((asset) => asset.project_id === projectId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      const page = all.slice(after, after + limit);
      return {
        items: page,
        next_cursor: after + page.length < all.length ? String(after + page.length) : null,
      };
    },

    async getAsset(projectId, assetId) {
      const asset = assets.get(assetId);
      return asset?.project_id === projectId ? asset : null;
    },
  };
}
