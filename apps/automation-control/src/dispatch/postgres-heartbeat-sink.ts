import { type Database, automationJobEvents, automationJobSteps, automationJobs } from '@kortix/db';
import type { AutomationJobStatus } from '@kortix/intelligence-contracts';
import { and, eq, gt, max, sql } from 'drizzle-orm';
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

function projectWorkerEvent(
  projectId: string,
  event: WorkerHeartbeat['event'],
): Pick<AppendAutomationEventInput, 'event' | 'transition'> | null {
  switch (event.type) {
    case 'approval_required':
    case 'job_succeeded':
      // These intents require atomic automation_job_steps validation and, for approval,
      // a durable pause/resume handoff. Reject them until that runtime is composed.
      return null;
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

export function createPostgresHeartbeatEventSink(db: Database): HeartbeatEventSink {
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
      const projected = projectWorkerEvent(input.binding.projectId, input.event);
      if (!projected) return { accepted: false, reason: 'semantic_mismatch' };
      const eventInput: AppendAutomationEventInput = {
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

      return db.transaction(async (tx) => {
        const [job] = await tx
          .select({ jobId: automationJobs.jobId, status: automationJobs.status })
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
          if (!updated) return { accepted: false, reason: 'stale_lease' } as const;
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
    },
  };
}
