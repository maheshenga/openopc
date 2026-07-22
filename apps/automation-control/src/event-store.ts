import { randomUUID } from 'node:crypto';
import { type Database, automationJobEvents, automationJobs } from '@kortix/db';
import {
  type AutomationEvent,
  AutomationEventSchema,
  type AutomationJobStatus,
} from '@kortix/intelligence-contracts';
import { and, eq, gt, max, sql } from 'drizzle-orm';
import { type AutomationTransitionEvent, transitionAutomationJob } from './state-machine';

export type AppendAutomationEventInput = {
  accountId: string;
  projectId: string;
  jobId: string;
  leaseOwner: string | null;
  killSwitchGeneration: number;
  event: Omit<AutomationEvent, 'event_id' | 'job_id' | 'sequence' | 'created_at'>;
  transition: AutomationTransitionEvent | null;
  occurredAt: Date;
};

export class AutomationJobNotFoundError extends Error {
  readonly code = 'AUTOMATION_NOT_FOUND' as const;

  constructor() {
    super('Automation job was not found');
    this.name = 'AutomationJobNotFoundError';
  }
}

export class AutomationLeaseExpiredError extends Error {
  readonly code = 'AUTOMATION_LEASE_EXPIRED' as const;

  constructor() {
    super('Automation lease is stale or no longer current');
    this.name = 'AutomationLeaseExpiredError';
  }
}

export class AutomationEventStatusMismatchError extends Error {
  readonly code = 'AUTOMATION_CONFLICT' as const;

  constructor(
    readonly expected: AutomationJobStatus,
    readonly received: AutomationJobStatus | null,
  ) {
    super(`Automation event status must be ${expected}`);
    this.name = 'AutomationEventStatusMismatchError';
  }
}

export class AutomationEventTransitionMismatchError extends Error {
  readonly code = 'AUTOMATION_CONFLICT' as const;

  constructor() {
    super('Automation event type does not match its state transition');
    this.name = 'AutomationEventTransitionMismatchError';
  }
}

const TERMINAL_STATUSES: ReadonlySet<AutomationJobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

const TRANSITION_EVENT_TYPES: Readonly<
  Record<AutomationTransitionEvent['type'], readonly AutomationEvent['type'][]>
> = {
  approval_required: ['approval_required'],
  execution_approval_required: ['approval_required'],
  approval_expired: ['job_expired'],
  approval_granted: ['job_dispatched'],
  dispatched: ['job_dispatched'],
  started: ['job_started'],
  succeeded: ['job_succeeded'],
  failed: ['job_failed'],
  cancelled: ['job_cancelled', 'kill_switch_activated'],
  lease_expired: ['job_expired'],
  retry_allowed: ['job_queued'],
};

export function automationEventRequiresLease(input: AppendAutomationEventInput): boolean {
  return (
    input.event.type === 'job_started' ||
    input.event.type === 'step_started' ||
    input.event.type === 'step_completed' ||
    input.event.type === 'job_succeeded' ||
    input.event.type === 'job_failed' ||
    input.event.type === 'heartbeat' ||
    input.transition?.type === 'execution_approval_required' ||
    input.transition?.type === 'started' ||
    input.transition?.type === 'succeeded' ||
    input.transition?.type === 'failed'
  );
}

export function resolveAutomationEventStatus(
  current: AutomationJobStatus,
  input: Pick<AppendAutomationEventInput, 'event' | 'transition'>,
): AutomationJobStatus {
  if (
    input.transition !== null &&
    !TRANSITION_EVENT_TYPES[input.transition.type].includes(input.event.type)
  ) {
    throw new AutomationEventTransitionMismatchError();
  }
  const next =
    input.transition === null ? current : transitionAutomationJob(current, input.transition);
  if (
    (input.transition !== null && input.event.status !== next) ||
    (input.transition === null && input.event.status !== null && input.event.status !== current)
  ) {
    throw new AutomationEventStatusMismatchError(next, input.event.status);
  }
  return next;
}

export function materializeAutomationEvent(
  input: AppendAutomationEventInput,
  sequence: number,
  eventId = randomUUID(),
): AutomationEvent {
  return AutomationEventSchema.parse({
    ...input.event,
    event_id: eventId,
    job_id: input.jobId,
    sequence,
    created_at: input.occurredAt.toISOString(),
  });
}

function shouldClearLease(status: AutomationJobStatus): boolean {
  return status !== 'dispatched' && status !== 'running';
}

export async function appendPostgresAutomationEvent(
  db: Database,
  input: AppendAutomationEventInput,
): Promise<AutomationEvent> {
  // Validate the wire payload before opening a transaction. The final sequence is
  // validated again below, but malformed JSON must never reach a state update.
  materializeAutomationEvent(input, 1);
  if (automationEventRequiresLease(input) && input.leaseOwner === null) {
    throw new AutomationLeaseExpiredError();
  }
  const occurredAt = input.occurredAt.toISOString();

  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({
        jobId: automationJobs.jobId,
        status: automationJobs.status,
        killSwitchGeneration: automationJobs.killSwitchGeneration,
      })
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.accountId, input.accountId),
          eq(automationJobs.projectId, input.projectId),
          eq(automationJobs.jobId, input.jobId),
        ),
      )
      .limit(1)
      .for('update');
    if (!job) throw new AutomationJobNotFoundError();
    if (job.killSwitchGeneration !== input.killSwitchGeneration) {
      throw new AutomationLeaseExpiredError();
    }

    if (input.leaseOwner !== null) {
      const [currentLease] = await tx
        .select({ jobId: automationJobs.jobId })
        .from(automationJobs)
        .where(
          and(
            eq(automationJobs.jobId, input.jobId),
            eq(automationJobs.leaseOwner, input.leaseOwner),
            gt(
              automationJobs.leaseExpiresAt,
              sql`GREATEST(clock_timestamp(), ${occurredAt}::timestamptz)`,
            ),
          ),
        )
        .limit(1);
      if (!currentLease) throw new AutomationLeaseExpiredError();
    }

    const nextStatus = resolveAutomationEventStatus(job.status, input);
    const [maximum] = await tx
      .select({ value: max(automationJobEvents.sequence) })
      .from(automationJobEvents)
      .where(eq(automationJobEvents.jobId, input.jobId));
    const event = materializeAutomationEvent(input, Number(maximum?.value ?? 0) + 1);

    if (input.transition !== null) {
      await tx
        .update(automationJobs)
        .set({
          status: nextStatus,
          updatedAt: occurredAt,
          terminalAt: TERMINAL_STATUSES.has(nextStatus) ? occurredAt : null,
          ...(shouldClearLease(nextStatus) ? { leaseOwner: null, leaseExpiresAt: null } : {}),
        })
        .where(
          and(
            eq(automationJobs.jobId, input.jobId),
            eq(automationJobs.accountId, input.accountId),
            eq(automationJobs.projectId, input.projectId),
            eq(automationJobs.killSwitchGeneration, input.killSwitchGeneration),
          ),
        );
    }

    await tx.insert(automationJobEvents).values({
      eventId: event.event_id,
      jobId: event.job_id,
      sequence: event.sequence,
      type: event.type,
      status: event.status,
      payload: event.payload,
      traceId: event.trace_id,
      createdAt: event.created_at,
    });
    return event;
  });
}
