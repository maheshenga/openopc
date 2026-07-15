import { and, desc, eq, gt, lt } from 'drizzle-orm';
import {
  studioJobEvents,
  studioJobs,
  studioProviderConfigs,
} from '@kortix/db';
import type { StudioJob, StudioJobEvent, StudioProviderConfig } from '@kortix/api-contract';
import type {
  StudioCreateJobInput,
  StudioCreateJobResult,
  StudioProviderConfigWire,
  StudioRepository,
} from '../types';

type DbClient = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

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

function serializeProvider(row: any): StudioProviderConfigWire | null {
  if (row.provider !== 'fake' && row.provider !== 'openai-compatible') return null;
  const credential = row.credentialBinding ?? { kind: 'none' };
  if (
    !credential ||
    typeof credential !== 'object' ||
    !['secret', 'connector', 'none'].includes(String((credential as Record<string, unknown>).kind))
  ) {
    return null;
  }
  return {
    provider_config_id: row.providerConfigId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.provider,
    display_name: row.displayName,
    base_url: row.baseUrl ?? null,
    region: row.region ?? null,
    credential_binding: credential as StudioProviderConfig['credential_binding'],
    capabilities: providerCapabilities(row.capabilityMap),
    enabled: row.enabled === true,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function serializeJob(row: any): StudioJob {
  return {
    job_id: row.jobId,
    account_id: row.accountId,
    project_id: row.projectId,
    actor_user_id: row.actorUserId ?? null,
    actor_type: row.actorType,
    capability: row.capability,
    provider_config_id: row.providerConfigId,
    provider: row.provider,
    model: row.model,
    input: row.input,
    status: row.status,
    idempotency_key: row.idempotencyKey,
    request_hash: row.requestHash,
    attempt_count: row.attemptCount,
    reserved_credits: numberValue(row.reservedCredits),
    actual_credits: nullableNumberValue(row.actualCredits),
    error_code: row.errorCode ?? null,
    error_message: row.errorMessage ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    started_at: row.startedAt ?? null,
    completed_at: row.completedAt ?? null,
  };
}

function serializeEvent(row: any): StudioJobEvent {
  return {
    event_id: row.eventId,
    job_id: row.jobId,
    cursor: String(row.cursor),
    type: row.eventType,
    payload: row.payload ?? {},
    created_at: row.createdAt,
  };
}

export function createDrizzleStudioRepository(db: DbClient): StudioRepository {
  const estimates = new Map<string, import('@kortix/api-contract').StudioEstimateResponse>();

  async function insertEvent(jobId: string, type: StudioJobEvent['type'], payload: Record<string, unknown>) {
    const current = await db
      .select({ cursor: studioJobEvents.cursor })
      .from(studioJobEvents)
      .where(eq(studioJobEvents.jobId, jobId))
      .orderBy(desc(studioJobEvents.cursor))
      .limit(1);
    const nextCursor = Number(current[0]?.cursor ?? 0) + 1;
    await db.insert(studioJobEvents).values({
      jobId,
      cursor: nextCursor,
      eventType: type,
      payload,
    });
  }

  return {
    async listProviders(projectId) {
      const rows = await db
        .select()
        .from(studioProviderConfigs)
        .where(and(eq(studioProviderConfigs.projectId, projectId), eq(studioProviderConfigs.enabled, true)));
      return rows
        .map(serializeProvider)
        .filter((provider: StudioProviderConfigWire | null): provider is StudioProviderConfigWire => !!provider);
    },

    async getProvider(projectId, providerConfigId) {
      const rows = await db
        .select()
        .from(studioProviderConfigs)
        .where(and(
          eq(studioProviderConfigs.projectId, projectId),
          eq(studioProviderConfigs.providerConfigId, providerConfigId),
          eq(studioProviderConfigs.enabled, true),
        ))
        .limit(1);
      return rows[0] ? serializeProvider(rows[0]) : null;
    },

    async saveEstimate(_input, estimate) {
      estimates.set(estimate.estimate_id, estimate);
    },

    async getEstimate(estimateId) {
      return estimates.get(estimateId) ?? null;
    },

    async createJob(input, provider, estimate): Promise<StudioCreateJobResult> {
      const existing = await db
        .select()
        .from(studioJobs)
        .where(and(
          eq(studioJobs.accountId, input.account_id),
          eq(studioJobs.idempotencyKey, input.idempotency_key),
        ))
        .limit(1);
      if (existing[0]) {
        return {
          job: serializeJob(existing[0]),
          created: false,
          mismatch: existing[0].requestHash !== input.request_hash,
        };
      }

      const inserted = await db
        .insert(studioJobs)
        .values({
          accountId: input.account_id,
          projectId: input.project_id,
          actorUserId: input.actor_user_id,
          actorType: input.actor_type,
          capability: input.capability,
          providerConfigId: input.provider_config_id,
          provider: provider.provider,
          model: input.model,
          input: input.input,
          status: 'queued',
          idempotencyKey: input.idempotency_key,
          requestHash: input.request_hash,
          reservedCredits: String(estimate.max_approved_credits),
        })
        .returning();
      const job = serializeJob(inserted[0]);
      await insertEvent(job.job_id, 'queued', {
        capability: job.capability,
        provider_config_id: job.provider_config_id,
        model: job.model,
      });
      return { job, created: true };
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

    async cancelQueuedJob(projectId, jobId) {
      const existing = await this.getJob(projectId, jobId);
      if (!existing || existing.status !== 'queued') return null;
      const completedAt = new Date().toISOString();
      const rows = await db
        .update(studioJobs)
        .set({
          status: 'cancelled',
          cancellationRequestedAt: completedAt,
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(eq(studioJobs.projectId, projectId), eq(studioJobs.jobId, jobId), eq(studioJobs.status, 'queued')))
        .returning();
      if (!rows[0]) return null;
      await insertEvent(jobId, 'cancelled', { reason: 'user_cancelled' });
      return serializeJob(rows[0]);
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
  };
}
