import type { StudioEstimateResponse, StudioJob, StudioJobEvent } from '@kortix/api-contract';
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

export function createMemoryStudioRepository(input: MemoryStudioRepositoryInput = {}): StudioRepository {
  const providers = new Map(input.providers?.map((provider) => [provider.provider_config_id, provider]) ?? []);
  const estimates = new Map<string, StudioEstimateResponse>();
  const jobs = new Map<string, StudioJob>();
  const events = new Map<string, StudioJobEvent[]>();
  const now = input.now ?? isoNow;

  const appendEvent = (jobId: string, type: StudioJobEvent['type'], payload: Record<string, unknown>) => {
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
      return [...providers.values()].filter((provider) => provider.project_id === projectId && provider.enabled);
    },

    async getProvider(projectId, providerConfigId) {
      const provider = providers.get(providerConfigId);
      return provider?.project_id === projectId && provider.enabled ? provider : null;
    },

    async saveEstimate(_input, estimate) {
      estimates.set(estimate.estimate_id, estimate);
    },

    async getEstimate(estimateId) {
      return estimates.get(estimateId) ?? null;
    },

    async createJob(input, provider, estimate): Promise<StudioCreateJobResult> {
      const existing = [...jobs.values()].find(
        (job) => job.account_id === input.account_id && job.idempotency_key === input.idempotency_key,
      );
      if (existing) {
        return {
          job: existing,
          created: false,
          mismatch: existing.request_hash !== input.request_hash,
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

    async cancelQueuedJob(projectId, jobId) {
      const job = jobs.get(jobId);
      if (!job || job.project_id !== projectId || job.status !== 'queued') return null;
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
  };
}
