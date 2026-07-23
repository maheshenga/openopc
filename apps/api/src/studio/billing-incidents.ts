import {
  type StudioBillingIncidentResolutionDecision,
  type StudioErrorCode,
  type StudioResolveBillingIncidentRequest,
  type StudioResolveBillingIncidentResponse,
  StudioResolveBillingIncidentResponseSchema,
} from '@kortix/api-contract';
import { type Database, studioBillingIncidents } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';

export type StudioBillingIncidentLockedContext = {
  incident_id: string;
  account_id: string;
  project_id: string;
  job_id: string;
  attempt_id: string;
  status: 'open' | 'resolved';
  verified_cost_credits: number;
  potential_liability_credits: number;
  opened_at: string;
  resolution: Record<string, unknown> | null;
};

export type StudioBillingIncidentPreparedResolution = {
  decision: StudioBillingIncidentResolutionDecision;
  reason: string;
  evidence_reference: string;
  provider_liability_credits: number;
};

export type StudioBillingIncidentRepositoryInput = {
  account_id: string;
  incident_id: string;
  actor_user_id: string;
  acting_token_id: string | null;
  idempotency_key: string;
  request_hash: string;
  resolved_at: string;
};

export type StudioBillingIncidentResolution = StudioResolveBillingIncidentResponse;

export class StudioBillingIncidentServiceError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    readonly status: 404 | 409 | 500,
  ) {
    super(code);
    this.name = 'StudioBillingIncidentServiceError';
  }
}

export interface StudioBillingIncidentRepository {
  resolveLocked(
    input: StudioBillingIncidentRepositoryInput,
    prepare: (
      context: StudioBillingIncidentLockedContext,
    ) => Promise<StudioBillingIncidentPreparedResolution>,
  ): Promise<StudioBillingIncidentResolution>;
}

type StudioBillingIncidentRow = typeof studioBillingIncidents.$inferSelect;

export function createDrizzleStudioBillingIncidentRepository(
  db: Database,
): StudioBillingIncidentRepository {
  return {
    async resolveLocked(input, prepare) {
      try {
        return await db.transaction(
          async (tx) => {
            const [incident] = await tx
              .select()
              .from(studioBillingIncidents)
              .where(
                and(
                  eq(studioBillingIncidents.accountId, input.account_id),
                  eq(studioBillingIncidents.incidentId, input.incident_id),
                ),
              )
              .for('update')
              .limit(1);
            if (!incident) {
              throw new StudioBillingIncidentServiceError('STUDIO_JOB_CONFLICT', 404);
            }

            if (incident.status === 'resolved') {
              const resolution = incident.resolution;
              if (
                !resolution ||
                resolution.idempotency_key !== input.idempotency_key ||
                resolution.request_hash !== input.request_hash
              ) {
                throw new StudioBillingIncidentServiceError('STUDIO_RECOVERY_CONFLICT', 409);
              }
              return serializeResolvedIncident(incident);
            }
            if (incident.status !== 'open') {
              throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
            }

            const context = serializeLockedIncident(incident);
            const prepared = await prepare(context);
            assertPreparedResolution(context, prepared);
            const resolution = {
              ...prepared,
              idempotency_key: input.idempotency_key,
              request_hash: input.request_hash,
              actor_user_id: input.actor_user_id,
              acting_token_id: input.acting_token_id,
              resolved_at: input.resolved_at,
            };
            const [updated] = await tx
              .update(studioBillingIncidents)
              .set({
                status: 'resolved',
                resolvedAt: input.resolved_at,
                resolvedByUserId: input.actor_user_id,
                resolution,
              })
              .where(
                and(
                  eq(studioBillingIncidents.accountId, input.account_id),
                  eq(studioBillingIncidents.incidentId, input.incident_id),
                  eq(studioBillingIncidents.status, 'open'),
                ),
              )
              .returning();
            if (!updated) {
              throw new StudioBillingIncidentServiceError('STUDIO_RECOVERY_CONFLICT', 409);
            }
            return serializeResolvedIncident(updated);
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        if (error instanceof StudioBillingIncidentServiceError) throw error;
        throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
      }
    },
  };
}

export class StudioBillingIncidentService {
  constructor(
    private readonly input: {
      repository: StudioBillingIncidentRepository;
      now?: () => Date;
    },
  ) {}

  resolve(input: {
    accountId: string;
    incidentId: string;
    actorUserId: string;
    actingTokenId: string | null;
    request: StudioResolveBillingIncidentRequest;
  }): Promise<StudioBillingIncidentResolution> {
    const request = input.request;
    return this.input.repository.resolveLocked(
      {
        account_id: input.accountId,
        incident_id: input.incidentId,
        actor_user_id: input.actorUserId,
        acting_token_id: input.actingTokenId,
        idempotency_key: request.idempotency_key,
        request_hash: canonicalStudioRequestHash({
          decision: request.decision,
          reason: request.reason,
          evidence_reference: request.evidence_reference,
        }),
        resolved_at: (this.input.now ?? (() => new Date()))().toISOString(),
      },
      async (context) => ({
        decision: request.decision,
        reason: request.reason,
        evidence_reference: request.evidence_reference,
        provider_liability_credits:
          request.decision === 'record_platform_liability'
            ? context.potential_liability_credits
            : 0,
      }),
    );
  }
}

function serializeLockedIncident(
  incident: StudioBillingIncidentRow,
): StudioBillingIncidentLockedContext {
  return {
    incident_id: incident.incidentId,
    account_id: incident.accountId,
    project_id: incident.projectId,
    job_id: incident.jobId,
    attempt_id: incident.attemptId,
    status: incident.status as 'open' | 'resolved',
    verified_cost_credits: numericValue(incident.verifiedCostCredits),
    potential_liability_credits: numericValue(incident.potentialLiabilityCredits),
    opened_at: timestampValue(incident.openedAt),
    resolution: incident.resolution ?? null,
  };
}

function serializeResolvedIncident(
  incident: StudioBillingIncidentRow,
): StudioBillingIncidentResolution {
  const context = serializeLockedIncident(incident);
  const resolution = context.resolution;
  if (!resolution || !incident.resolvedAt || !incident.resolvedByUserId) {
    throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
  }
  const parsed = StudioResolveBillingIncidentResponseSchema.safeParse({
    incident_id: context.incident_id,
    account_id: context.account_id,
    project_id: context.project_id,
    job_id: context.job_id,
    attempt_id: context.attempt_id,
    status: incident.status,
    decision: resolution.decision,
    evidence_reference: resolution.evidence_reference,
    verified_cost_credits: context.verified_cost_credits,
    potential_liability_credits: context.potential_liability_credits,
    provider_liability_credits: resolution.provider_liability_credits,
    resolved_at: timestampValue(incident.resolvedAt),
    resolved_by_user_id: incident.resolvedByUserId,
  });
  if (!parsed.success) {
    throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
  }
  const expectedLiability =
    parsed.data.decision === 'record_platform_liability' ? context.potential_liability_credits : 0;
  if (
    parsed.data.provider_liability_credits !== expectedLiability ||
    resolution.actor_user_id !== incident.resolvedByUserId ||
    typeof resolution.idempotency_key !== 'string' ||
    typeof resolution.request_hash !== 'string' ||
    typeof resolution.reason !== 'string'
  ) {
    throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
  }
  return parsed.data;
}

function assertPreparedResolution(
  context: StudioBillingIncidentLockedContext,
  prepared: StudioBillingIncidentPreparedResolution,
): void {
  const credits = prepared.provider_liability_credits;
  if (!Number.isFinite(credits) || credits < 0) {
    throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
  }
  const expected =
    prepared.decision === 'record_platform_liability' ? context.potential_liability_credits : 0;
  if (credits !== expected) {
    throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
  }
}

function numericValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new StudioBillingIncidentServiceError('STUDIO_INTERNAL_ERROR', 500);
  }
  return parsed;
}

function timestampValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
