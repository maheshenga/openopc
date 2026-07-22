import { createHash, randomUUID } from 'node:crypto';
import {
  type AutomationJob as AutomationJobRow,
  type Database,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import {
  type AutomationEvent,
  type AutomationJob,
  type AutomationJobRequest,
  AutomationJobRequestSchema,
  AutomationJobSchema,
  type AutomationJobStatus,
  canonicalAutomationRequestJson as sharedCanonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { and, eq, max } from 'drizzle-orm';
import {
  type AppendAutomationEventInput,
  AutomationJobNotFoundError,
  AutomationLeaseExpiredError,
  appendPostgresAutomationEvent,
  automationEventRequiresLease,
  materializeAutomationEvent,
  resolveAutomationEventStatus,
} from './event-store';
import { transitionAutomationJob } from './state-machine';

export {
  AutomationEventStatusMismatchError,
  AutomationEventTransitionMismatchError,
  AutomationJobNotFoundError,
  AutomationLeaseExpiredError,
} from './event-store';
export type { AppendAutomationEventInput } from './event-store';

export type AutomationActor = Readonly<{
  accountId: string;
  projectId: string;
  userId: string;
  roles: readonly ('member' | 'project_admin' | 'device_owner' | 'security_admin')[];
  deviceId: string | null;
}>;

export interface AutomationRepository {
  createJob(
    input: AutomationJobRequest,
    actor: AutomationActor,
  ): Promise<{ job: AutomationJob; created: boolean }>;
  getJobForProject(
    accountId: string,
    projectId: string,
    jobId: string,
  ): Promise<AutomationJob | null>;
  appendEvent(input: AppendAutomationEventInput): Promise<AutomationEvent>;
  requestCancellation(
    accountId: string,
    projectId: string,
    jobId: string,
    actorUserId: string,
  ): Promise<AutomationJob>;
}

export class AutomationIdempotencyConflictError extends Error {
  readonly code = 'AUTOMATION_CONFLICT' as const;

  constructor() {
    super('Idempotency key was already used for a different automation request');
    this.name = 'AutomationIdempotencyConflictError';
  }
}

export class AutomationScopeMismatchError extends Error {
  readonly code = 'AUTOMATION_FORBIDDEN' as const;

  constructor() {
    super('Automation request is outside the actor scope');
    this.name = 'AutomationScopeMismatchError';
  }
}

export function canonicalAutomationRequestJson(value: unknown): string {
  return sharedCanonicalAutomationRequestJson(value);
}

export function canonicalAutomationRequestHash(value: unknown): `sha256:${string}` {
  const digest = createHash('sha256').update(canonicalAutomationRequestJson(value)).digest('hex');
  return `sha256:${digest}`;
}

function policySnapshotHash(request: AutomationJobRequest): `sha256:${string}` {
  return canonicalAutomationRequestHash({
    approval_policy: request.approval_policy,
    browser_policy: request.browser_policy,
    desktop_policy: request.desktop_policy,
  });
}

function parseScopedRequest(
  input: AutomationJobRequest,
  actor: AutomationActor,
): AutomationJobRequest {
  const request = AutomationJobRequestSchema.parse(input);
  if (request.tenant_id !== actor.accountId || request.project_id !== actor.projectId) {
    throw new AutomationScopeMismatchError();
  }
  return request;
}

function toAutomationJob(row: AutomationJobRow): AutomationJob {
  return AutomationJobSchema.parse({
    job_id: row.jobId,
    account_id: row.accountId,
    actor_user_id: row.actorUserId,
    request: row.requestEnvelope,
    request_hash: row.requestHash,
    status: row.status,
    policy_version: row.policySnapshotHash,
    kill_switch_generation: row.killSwitchGeneration,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    terminal_at: row.terminalAt,
  });
}

function terminalAtFor(status: AutomationJobStatus, occurredAt: string): string | null {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(status) ? occurredAt : null;
}

function cloneJob(job: AutomationJob): AutomationJob {
  return structuredClone(job);
}

type MemoryJobRecord = {
  job: AutomationJob;
  cancelRequestedAt: string | null;
  events: AutomationEvent[];
};

export function createMemoryAutomationRepository(input?: {
  now?: () => Date;
}): AutomationRepository {
  const now = input?.now ?? (() => new Date());
  const jobs = new Map<string, MemoryJobRecord>();
  const idempotency = new Map<string, string>();

  function scopedRecord(accountId: string, projectId: string, jobId: string) {
    const record = jobs.get(jobId);
    if (
      !record ||
      record.job.account_id !== accountId ||
      record.job.request.project_id !== projectId
    ) {
      return null;
    }
    return record;
  }

  return {
    async createJob(requestInput, actor) {
      const request = parseScopedRequest(requestInput, actor);
      const requestHash = canonicalAutomationRequestHash(request);
      const key = `${request.project_id}\0${request.idempotency_key}`;
      const existingId = idempotency.get(key);
      if (existingId) {
        const existing = jobs.get(existingId);
        if (!existing || existing.job.request_hash !== requestHash) {
          throw new AutomationIdempotencyConflictError();
        }
        return { job: cloneJob(existing.job), created: false };
      }

      const createdAt = now().toISOString();
      const job = AutomationJobSchema.parse({
        job_id: randomUUID(),
        account_id: actor.accountId,
        actor_user_id: actor.userId,
        request,
        request_hash: requestHash,
        status: 'queued',
        policy_version: policySnapshotHash(request),
        kill_switch_generation: 0,
        created_at: createdAt,
        updated_at: createdAt,
        terminal_at: null,
      });
      const queued = materializeAutomationEvent(
        {
          accountId: actor.accountId,
          projectId: actor.projectId,
          jobId: job.job_id,
          leaseOwner: null,
          killSwitchGeneration: 0,
          event: {
            protocol_version: 'automation.v1',
            type: 'job_queued',
            status: 'queued',
            payload: { execution_domain: request.execution_domain },
            trace_id: request.traceparent?.split('-')[1] ?? null,
          },
          transition: null,
          occurredAt: new Date(createdAt),
        },
        1,
      );

      jobs.set(job.job_id, { job, cancelRequestedAt: null, events: [queued] });
      idempotency.set(key, job.job_id);
      return { job: cloneJob(job), created: true };
    },

    async getJobForProject(accountId, projectId, jobId) {
      const record = scopedRecord(accountId, projectId, jobId);
      return record ? cloneJob(record.job) : null;
    },

    async appendEvent(eventInput) {
      const record = scopedRecord(eventInput.accountId, eventInput.projectId, eventInput.jobId);
      if (!record) throw new AutomationJobNotFoundError();
      if (record.job.kill_switch_generation !== eventInput.killSwitchGeneration) {
        throw new AutomationLeaseExpiredError();
      }
      // The in-memory repository has no lease coordinator. It intentionally
      // refuses worker-owned events instead of pretending a lease is current.
      if (automationEventRequiresLease(eventInput) || eventInput.leaseOwner !== null) {
        throw new AutomationLeaseExpiredError();
      }

      const nextStatus = resolveAutomationEventStatus(record.job.status, eventInput);
      const event = materializeAutomationEvent(eventInput, record.events.length + 1);
      const updatedAt = eventInput.occurredAt.toISOString();
      const nextJob = AutomationJobSchema.parse({
        ...record.job,
        status: nextStatus,
        updated_at: updatedAt,
        terminal_at: terminalAtFor(nextStatus, updatedAt),
      });

      // Commit both mutations only after transition and wire validation succeed.
      record.job = nextJob;
      record.events.push(event);
      return event;
    },

    async requestCancellation(accountId, projectId, jobId, actorUserId) {
      const record = scopedRecord(accountId, projectId, jobId);
      if (!record) throw new AutomationJobNotFoundError();
      if (record.job.status === 'cancelled') return cloneJob(record.job);

      const nextStatus = transitionAutomationJob(record.job.status, { type: 'cancelled' });
      const occurredAt = now();
      const eventInput: AppendAutomationEventInput = {
        accountId,
        projectId,
        jobId,
        leaseOwner: null,
        killSwitchGeneration: record.job.kill_switch_generation,
        event: {
          protocol_version: 'automation.v1',
          type: 'job_cancelled',
          status: nextStatus,
          payload: { actor_user_id: actorUserId },
          trace_id: null,
        },
        transition: { type: 'cancelled' },
        occurredAt,
      };
      const event = materializeAutomationEvent(eventInput, record.events.length + 1);
      const occurredAtIso = occurredAt.toISOString();
      const nextJob = AutomationJobSchema.parse({
        ...record.job,
        status: nextStatus,
        updated_at: occurredAtIso,
        terminal_at: occurredAtIso,
      });

      record.job = nextJob;
      record.cancelRequestedAt = occurredAtIso;
      record.events.push(event);
      return cloneJob(nextJob);
    },
  };
}

export function createPostgresAutomationRepository(db: Database): AutomationRepository {
  return {
    async createJob(requestInput, actor) {
      const request = parseScopedRequest(requestInput, actor);
      const requestHash = canonicalAutomationRequestHash(request);
      const snapshotHash = policySnapshotHash(request);
      const createdAt = new Date().toISOString();
      const jobId = randomUUID();

      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(automationJobs)
          .values({
            jobId,
            accountId: actor.accountId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            sourceRunId: request.source_run_id,
            protocolVersion: request.protocol_version,
            executionDomain: request.execution_domain,
            requestEnvelope: request,
            requestHash,
            idempotencyKey: request.idempotency_key,
            status: 'queued',
            approvalPolicy: request.approval_policy,
            policySnapshotHash: snapshotHash,
            browserProfileId:
              request.browser_policy?.context.mode === 'persistent'
                ? request.browser_policy.context.profile_id
                : null,
            targetDeviceId: request.desktop_policy?.device_id ?? null,
            leaseOwner: null,
            leaseExpiresAt: null,
            cancelRequestedAt: null,
            killSwitchGeneration: request.desktop_policy?.kill_switch_generation ?? 0,
            deadlineAt: request.deadline_at,
            createdAt,
            updatedAt: createdAt,
            terminalAt: null,
          })
          .onConflictDoNothing({
            target: [automationJobs.projectId, automationJobs.idempotencyKey],
          })
          .returning();

        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(automationJobs)
            .where(
              and(
                eq(automationJobs.accountId, actor.accountId),
                eq(automationJobs.projectId, actor.projectId),
                eq(automationJobs.idempotencyKey, request.idempotency_key),
              ),
            )
            .limit(1);
          if (!existing || existing.requestHash !== requestHash) {
            throw new AutomationIdempotencyConflictError();
          }
          return { job: toAutomationJob(existing), created: false };
        }

        await tx.insert(automationJobSteps).values(
          request.steps.map((step) => ({
            stepId: step.step_id,
            jobId: inserted.jobId,
            sequence: step.sequence,
            action: step.action,
            args: step.args,
            risk: step.risk,
            actionHash: step.action_hash,
            status: 'pending' as const,
          })),
        );

        const queued = materializeAutomationEvent(
          {
            accountId: actor.accountId,
            projectId: actor.projectId,
            jobId: inserted.jobId,
            leaseOwner: null,
            killSwitchGeneration: inserted.killSwitchGeneration,
            event: {
              protocol_version: 'automation.v1',
              type: 'job_queued',
              status: 'queued',
              payload: { execution_domain: request.execution_domain },
              trace_id: request.traceparent?.split('-')[1] ?? null,
            },
            transition: null,
            occurredAt: new Date(createdAt),
          },
          1,
        );
        await tx.insert(automationJobEvents).values({
          eventId: queued.event_id,
          jobId: queued.job_id,
          sequence: queued.sequence,
          type: queued.type,
          status: queued.status,
          payload: queued.payload,
          traceId: queued.trace_id,
          createdAt: queued.created_at,
        });

        return { job: toAutomationJob(inserted), created: true };
      });
    },

    async getJobForProject(accountId, projectId, jobId) {
      const [job] = await db
        .select()
        .from(automationJobs)
        .where(
          and(
            eq(automationJobs.accountId, accountId),
            eq(automationJobs.projectId, projectId),
            eq(automationJobs.jobId, jobId),
          ),
        )
        .limit(1);
      return job ? toAutomationJob(job) : null;
    },

    appendEvent(eventInput) {
      return appendPostgresAutomationEvent(db, eventInput);
    },

    async requestCancellation(accountId, projectId, jobId, actorUserId) {
      const occurredAt = new Date();
      const occurredAtIso = occurredAt.toISOString();

      return db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(automationJobs)
          .where(
            and(
              eq(automationJobs.accountId, accountId),
              eq(automationJobs.projectId, projectId),
              eq(automationJobs.jobId, jobId),
            ),
          )
          .limit(1)
          .for('update');
        if (!job) throw new AutomationJobNotFoundError();
        if (job.status === 'cancelled') return toAutomationJob(job);

        const nextStatus = transitionAutomationJob(job.status, { type: 'cancelled' });
        const [maximum] = await tx
          .select({ value: max(automationJobEvents.sequence) })
          .from(automationJobEvents)
          .where(eq(automationJobEvents.jobId, jobId));
        const eventInput: AppendAutomationEventInput = {
          accountId,
          projectId,
          jobId,
          leaseOwner: null,
          killSwitchGeneration: job.killSwitchGeneration,
          event: {
            protocol_version: 'automation.v1',
            type: 'job_cancelled',
            status: nextStatus,
            payload: { actor_user_id: actorUserId },
            trace_id: null,
          },
          transition: { type: 'cancelled' },
          occurredAt,
        };
        const event = materializeAutomationEvent(eventInput, Number(maximum?.value ?? 0) + 1);
        const [updated] = await tx
          .update(automationJobs)
          .set({
            status: nextStatus,
            cancelRequestedAt: occurredAtIso,
            updatedAt: occurredAtIso,
            terminalAt: occurredAtIso,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(eq(automationJobs.jobId, jobId))
          .returning();
        if (!updated) throw new AutomationJobNotFoundError();

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
        return toAutomationJob(updated);
      });
    },
  };
}
