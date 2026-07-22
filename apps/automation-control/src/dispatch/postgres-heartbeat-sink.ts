import { randomUUID } from 'node:crypto';
import {
  type Database,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import type { AutomationJobStatus } from '@kortix/intelligence-contracts';
import { and, eq, gt, isNull, max, sql } from 'drizzle-orm';
import {
  type AppendAutomationEventInput,
  AutomationEventStatusMismatchError,
  AutomationEventTransitionMismatchError,
  materializeAutomationEvent,
  resolveAutomationEventStatus,
} from '../event-store';
import { automationLeaseOwnerPrefix } from '../lease-manager';
import { AutomationTransitionError } from '../state-machine';
import type { HeartbeatEventSink, WorkerHeartbeat } from './heartbeat';

const TERMINAL_STATUSES: ReadonlySet<AutomationJobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

const DEFAULT_APPROVAL_TTL_MS = 600_000;
const MIN_APPROVAL_TTL_MS = 60_000;
const MAX_APPROVAL_TTL_MS = 3_600_000;

export type PostgresHeartbeatEventSinkOptions = {
  durableApprovalPauseEnabled?: boolean;
  approvalTtlMs?: number;
  newApprovalId?: () => string;
};

class DurableApprovalPauseConflictError extends Error {
  constructor() {
    super('Durable approval pause lost its locked job state');
    this.name = 'DurableApprovalPauseConflictError';
  }
}

function projectWorkerEvent(
  projectId: string,
  event: WorkerHeartbeat['event'],
  durableApprovalPauseEnabled: boolean,
): Pick<AppendAutomationEventInput, 'event' | 'transition'> | null {
  switch (event.type) {
    case 'approval_required':
      return durableApprovalPauseEnabled
        ? {
            event: {
              protocol_version: 'automation.v1',
              type: event.type,
              status: 'awaiting_approval',
              payload: event.payload,
              trace_id: event.trace_id,
            },
            transition: { type: 'execution_approval_required' },
          }
        : null;
    case 'step_started':
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: 'running',
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: null,
      };
    case 'job_succeeded':
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: 'succeeded',
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: { type: 'succeeded' },
      };
    case 'step_completed':
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: 'running',
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: null,
      };
    case 'job_started':
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: 'running',
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: { type: 'started' },
      };
    case 'job_failed':
      if (event.payload.project_id !== projectId) return null;
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: 'failed',
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: {
          type: 'failed',
          retryable: false,
          externalEffectCommitted: false,
        },
      };
    case 'kill_switch_activated':
      if (event.payload.project_id !== projectId) return null;
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: 'cancelled',
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: { type: 'cancelled' },
      };
    case 'heartbeat':
      return {
        event: {
          protocol_version: 'automation.v1',
          type: event.type,
          status: null,
          payload: event.payload,
          trace_id: event.trace_id,
        },
        transition: null,
      };
  }
}

function shouldClearLease(status: AutomationJobStatus): boolean {
  return status !== 'dispatched' && status !== 'running';
}

function isSemanticError(error: unknown): boolean {
  return (
    error instanceof AutomationTransitionError ||
    error instanceof AutomationEventStatusMismatchError ||
    error instanceof AutomationEventTransitionMismatchError
  );
}

export function createPostgresHeartbeatEventSink(
  db: Database,
  options: PostgresHeartbeatEventSinkOptions = {},
): HeartbeatEventSink {
  const approvalPause = {
    enabled: options.durableApprovalPauseEnabled ?? false,
    ttlMs: options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
    newApprovalId: options.newApprovalId ?? randomUUID,
  };
  if (
    !Number.isSafeInteger(approvalPause.ttlMs) ||
    approvalPause.ttlMs < MIN_APPROVAL_TTL_MS ||
    approvalPause.ttlMs > MAX_APPROVAL_TTL_MS
  ) {
    throw new RangeError(
      `approvalTtlMs must be an integer between ${MIN_APPROVAL_TTL_MS} and ${MAX_APPROVAL_TTL_MS}`,
    );
  }

  return {
    async append(input) {
      if (
        !Number.isSafeInteger(input.workerOrdinal) ||
        input.workerOrdinal < 1 ||
        !Number.isFinite(input.observedAt.getTime())
      ) {
        return { accepted: false, reason: 'semantic_mismatch' };
      }
      const expectedOwner = `${automationLeaseOwnerPrefix(input.workerId)}:${input.binding.leaseId}`;
      if (input.binding.owner !== expectedOwner) {
        return { accepted: false, reason: 'stale_lease' };
      }
      const projected = projectWorkerEvent(
        input.binding.projectId,
        input.event,
        approvalPause.enabled,
      );
      if (!projected) return { accepted: false, reason: 'semantic_mismatch' };
      let eventInput: AppendAutomationEventInput = {
        accountId: input.binding.accountId,
        projectId: input.binding.projectId,
        jobId: input.binding.jobId,
        leaseOwner: input.binding.owner,
        killSwitchGeneration: input.binding.killSwitchGeneration,
        ...projected,
        occurredAt: input.observedAt,
      };
      try {
        materializeAutomationEvent(eventInput, 1);
      } catch {
        return { accepted: false, reason: 'semantic_mismatch' };
      }
      const observedAt = input.observedAt.toISOString();

      try {
        return await db.transaction(async (tx) => {
          const [job] = await tx
            .select({
              jobId: automationJobs.jobId,
              status: automationJobs.status,
              deadlineAt: automationJobs.deadlineAt,
              deadlineCurrent: sql<boolean>`${automationJobs.deadlineAt} > GREATEST(clock_timestamp(), ${observedAt}::timestamptz)`,
            })
            .from(automationJobs)
            .where(
              and(
                eq(automationJobs.accountId, input.binding.accountId),
                eq(automationJobs.projectId, input.binding.projectId),
                eq(automationJobs.jobId, input.binding.jobId),
                eq(automationJobs.leaseOwner, input.binding.owner),
                eq(automationJobs.killSwitchGeneration, input.binding.killSwitchGeneration),
                gt(
                  automationJobs.leaseExpiresAt,
                  sql`GREATEST(clock_timestamp(), ${observedAt}::timestamptz)`,
                ),
              ),
            )
            .limit(1)
            .for('update');
          if (!job) return { accepted: false, reason: 'stale_lease' } as const;

          const [lastWorkerEvent] = await tx
            .select({ value: max(automationJobEvents.workerOrdinal) })
            .from(automationJobEvents)
            .where(
              and(
                eq(automationJobEvents.jobId, input.binding.jobId),
                eq(automationJobEvents.workerId, input.workerId),
                eq(automationJobEvents.workerLeaseId, input.binding.leaseId),
              ),
            );
          const expectedOrdinal = Number(lastWorkerEvent?.value ?? 0) + 1;
          if (input.workerOrdinal !== expectedOrdinal) {
            return { accepted: false, reason: 'replayed_ordinal' } as const;
          }

          let nextStatus: AutomationJobStatus;
          try {
            nextStatus = resolveAutomationEventStatus(job.status, eventInput);
          } catch (error) {
            if (isSemanticError(error)) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
            throw error;
          }

          if (input.event.type === 'approval_required') {
            if (job.status !== 'running' || !job.deadlineCurrent) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
            const approvalEvent = input.event as Extract<
              WorkerHeartbeat['event'],
              { type: 'approval_required' }
            >;
            const steps = await tx
              .select({
                stepId: automationJobSteps.stepId,
                sequence: automationJobSteps.sequence,
                status: automationJobSteps.status,
                risk: automationJobSteps.risk,
                actionHash: automationJobSteps.actionHash,
                approvalId: automationJobSteps.approvalId,
              })
              .from(automationJobSteps)
              .where(eq(automationJobSteps.jobId, input.binding.jobId))
              .for('update');
            const orderedSteps = [...steps].sort((left, right) => left.sequence - right.sequence);
            const targetIndex = orderedSteps.findIndex(
              (step) => step.stepId === approvalEvent.payload.step_id,
            );
            const target = orderedSteps[targetIndex];
            if (
              !target ||
              target.status !== 'pending' ||
              target.approvalId !== null ||
              target.actionHash !== approvalEvent.payload.action_hash ||
              target.risk === 'observe'
            ) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
            const previousSteps = orderedSteps.slice(0, targetIndex);
            const laterSteps = orderedSteps.slice(targetIndex + 1);
            if (
              previousSteps.some((step) => step.status !== 'succeeded') ||
              laterSteps.some((step) => step.status !== 'pending')
            ) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }

            const resumeAfterSequence = previousSteps.at(-1)?.sequence ?? 0;
            const deadlineAtMs = Date.parse(job.deadlineAt);
            const expiresAt = new Date(
              Math.min(input.observedAt.getTime() + approvalPause.ttlMs, deadlineAtMs),
            ).toISOString();
            const approvalId = approvalPause.newApprovalId();
            eventInput = {
              ...eventInput,
              event: {
                ...eventInput.event,
                payload: {
                  step_id: target.stepId,
                  action_hash: target.actionHash,
                  approval_id: approvalId,
                  expires_at: expiresAt,
                  resume_after_sequence: resumeAfterSequence,
                },
              },
            };
            materializeAutomationEvent(eventInput, 1);

            const [updatedStep] = await tx
              .update(automationJobSteps)
              .set({ status: 'awaiting_approval', approvalId })
              .where(
                and(
                  eq(automationJobSteps.jobId, input.binding.jobId),
                  eq(automationJobSteps.stepId, target.stepId),
                  eq(automationJobSteps.status, 'pending'),
                  eq(automationJobSteps.actionHash, target.actionHash),
                  isNull(automationJobSteps.approvalId),
                ),
              )
              .returning({ stepId: automationJobSteps.stepId });
            if (!updatedStep) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }

            await tx.insert(automationApprovals).values({
              approvalId,
              jobId: input.binding.jobId,
              stepId: target.stepId,
              actionHash: target.actionHash,
              status: 'pending',
              expiresAt,
              createdAt: observedAt,
            });
          }

          if (input.event.type === 'step_started') {
            const [step] = await tx
              .select({ stepId: automationJobSteps.stepId, status: automationJobSteps.status })
              .from(automationJobSteps)
              .where(
                and(
                  eq(automationJobSteps.jobId, input.binding.jobId),
                  eq(automationJobSteps.stepId, input.event.payload.step_id),
                ),
              )
              .limit(1)
              .for('update');
            if (step?.status !== 'pending') {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
            const [updatedStep] = await tx
              .update(automationJobSteps)
              .set({ status: 'running', startedAt: observedAt })
              .where(
                and(
                  eq(automationJobSteps.jobId, input.binding.jobId),
                  eq(automationJobSteps.stepId, input.event.payload.step_id),
                  eq(automationJobSteps.status, 'pending'),
                ),
              )
              .returning({ stepId: automationJobSteps.stepId });
            if (!updatedStep) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
          }

          if (input.event.type === 'step_completed') {
            const [step] = await tx
              .select({ stepId: automationJobSteps.stepId, status: automationJobSteps.status })
              .from(automationJobSteps)
              .where(
                and(
                  eq(automationJobSteps.jobId, input.binding.jobId),
                  eq(automationJobSteps.stepId, input.event.payload.step_id),
                ),
              )
              .limit(1)
              .for('update');
            if (step?.status !== 'running') {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
            const [updatedStep] = await tx
              .update(automationJobSteps)
              .set({
                status: 'succeeded',
                endedAt: observedAt,
                resultRef: input.event.payload.evidence_reference,
              })
              .where(
                and(
                  eq(automationJobSteps.jobId, input.binding.jobId),
                  eq(automationJobSteps.stepId, input.event.payload.step_id),
                  eq(automationJobSteps.status, 'running'),
                ),
              )
              .returning({ stepId: automationJobSteps.stepId });
            if (!updatedStep) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
          }

          if (input.event.type === 'job_succeeded') {
            const steps = await tx
              .select({
                stepId: automationJobSteps.stepId,
                sequence: automationJobSteps.sequence,
                status: automationJobSteps.status,
              })
              .from(automationJobSteps)
              .where(eq(automationJobSteps.jobId, input.binding.jobId))
              .for('update');
            if (steps.length === 0 || steps.some((step) => step.status !== 'succeeded')) {
              return { accepted: false, reason: 'semantic_mismatch' } as const;
            }
          }

          const [maximum] = await tx
            .select({ value: max(automationJobEvents.sequence) })
            .from(automationJobEvents)
            .where(eq(automationJobEvents.jobId, input.binding.jobId));
          const event = materializeAutomationEvent(eventInput, Number(maximum?.value ?? 0) + 1);

          if (projected.transition !== null) {
            const terminalAt = TERMINAL_STATUSES.has(nextStatus) ? observedAt : null;
            const [updated] = await tx
              .update(automationJobs)
              .set({
                status: nextStatus,
                updatedAt: observedAt,
                terminalAt,
                ...(shouldClearLease(nextStatus) ? { leaseOwner: null, leaseExpiresAt: null } : {}),
              })
              .where(
                and(
                  eq(automationJobs.jobId, input.binding.jobId),
                  eq(automationJobs.accountId, input.binding.accountId),
                  eq(automationJobs.projectId, input.binding.projectId),
                  eq(automationJobs.leaseOwner, input.binding.owner),
                  eq(automationJobs.killSwitchGeneration, input.binding.killSwitchGeneration),
                ),
              )
              .returning({ jobId: automationJobs.jobId });
            if (!updated) {
              if (input.event.type === 'approval_required') {
                throw new DurableApprovalPauseConflictError();
              }
              return { accepted: false, reason: 'stale_lease' } as const;
            }
          }

          await tx.insert(automationJobEvents).values({
            eventId: event.event_id,
            jobId: event.job_id,
            sequence: event.sequence,
            type: event.type,
            status: event.status,
            payload: event.payload,
            traceId: event.trace_id,
            workerId: input.workerId,
            workerLeaseId: input.binding.leaseId,
            workerOrdinal: input.workerOrdinal,
            createdAt: event.created_at,
          });
          return { accepted: true, event } as const;
        });
      } catch (error) {
        if (error instanceof DurableApprovalPauseConflictError) {
          return { accepted: false, reason: 'semantic_mismatch' } as const;
        }
        throw error;
      }
    },
  };
}
