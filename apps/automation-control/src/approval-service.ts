import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type Database,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import { type AutomationApproval, AutomationApprovalSchema } from '@kortix/intelligence-contracts';
import { and, eq, gt, gte, inArray, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AppendAutomationEventInput,
  materializeAutomationEvent,
  resolveAutomationEventStatus,
} from './event-store';

const UuidSchema = z.string().uuid();
const ActionHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ApprovalTokenSchema = z.string().regex(/^approval\.v1\.[A-Za-z0-9_-]{43}$/);

export type ApprovalRequest = {
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  requestedByUserId: string;
  expiresAt: Date;
};

export type OneTimeApprovalToken = {
  token: string;
  approvalId: string;
  projectId: string;
  actionHash: `sha256:${string}`;
  expiresAt: string;
};

export interface ApprovalService {
  request(input: ApprovalRequest): Promise<AutomationApproval>;
  resolve(input: {
    accountId: string;
    projectId: string;
    approvalId: string;
    actionHash: `sha256:${string}`;
    actorUserId: string;
    decision: 'approve' | 'reject';
  }): Promise<OneTimeApprovalToken | null>;
  consume(input: {
    token: string;
    projectId: string;
    approvalId: string;
    actionHash: `sha256:${string}`;
    now: Date;
  }): Promise<boolean>;
}

export type ApprovalGenerationReader = (scope: {
  accountId: string;
  projectId: string;
}) => Promise<number>;

export type PostgresApprovalServiceOptions = {
  now?: () => Date;
  currentGeneration?: ApprovalGenerationReader;
  durableExecutionResolutionEnabled?: boolean;
  newEventId?: () => string;
};

type ApprovalErrorCode =
  | 'AUTOMATION_INVALID_REQUEST'
  | 'AUTOMATION_NOT_FOUND'
  | 'AUTOMATION_FORBIDDEN'
  | 'AUTOMATION_CONFLICT'
  | 'AUTOMATION_APPROVAL_EXPIRED';

export class AutomationApprovalServiceError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationApprovalServiceError';
  }
}

class DurableExecutionApprovalConflictError extends Error {
  constructor() {
    super('Durable execution approval state changed during resolution');
    this.name = 'DurableExecutionApprovalConflictError';
  }
}

type DurableDecision = 'approve' | 'reject' | 'expire';

type DurableResolutionOutcome =
  | { kind: 'approved'; token: OneTimeApprovalToken }
  | { kind: 'rejected' }
  | { kind: 'expired' };

type StoredApprovalRecord = {
  approvalId: string;
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  requestedByUserId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  actingUserId: string | null;
  tokenHash: `sha256:${string}` | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

export class MemoryApprovalStore {
  readonly #records = new Map<string, StoredApprovalRecord>();

  get(approvalId: string): StoredApprovalRecord | undefined {
    return this.#records.get(approvalId);
  }

  set(record: StoredApprovalRecord): void {
    this.#records.set(record.approvalId, record);
  }

  snapshot(): readonly Readonly<StoredApprovalRecord>[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export function createMemoryApprovalStore(): MemoryApprovalStore {
  return new MemoryApprovalStore();
}

function validateRequest(input: ApprovalRequest, now: Date): ApprovalRequest {
  const parsed = z
    .object({
      accountId: UuidSchema,
      projectId: UuidSchema,
      jobId: UuidSchema,
      stepId: UuidSchema,
      actionHash: ActionHashSchema,
      requestedByUserId: UuidSchema,
      expiresAt: z.date(),
    })
    .strict()
    .parse(input) as ApprovalRequest;
  if (parsed.expiresAt.getTime() <= now.getTime()) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_INVALID_REQUEST',
      'Approval expiry must be in the future',
    );
  }
  return parsed;
}

function issueRawToken(): string {
  return `approval.v1.${randomBytes(32).toString('base64url')}`;
}

function boundTokenHash(input: {
  token: string;
  approvalId: string;
  projectId: string;
  actionHash: string;
  expiresAt: string;
  generation: number;
}): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(
      [
        input.token,
        input.approvalId,
        input.projectId,
        input.actionHash,
        input.expiresAt,
        input.generation,
      ].join('\0'),
    )
    .digest('hex');
  return `sha256:${digest}`;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toAutomationApproval(record: StoredApprovalRecord): AutomationApproval {
  return AutomationApprovalSchema.parse({
    approval_id: record.approvalId,
    job_id: record.jobId,
    step_id: record.stepId,
    project_id: record.projectId,
    action_hash: record.actionHash,
    status: record.status,
    acting_user_id: record.actingUserId,
    expires_at: record.expiresAt,
    resolved_at: record.resolvedAt,
  });
}

function notFound(): AutomationApprovalServiceError {
  return new AutomationApprovalServiceError('AUTOMATION_NOT_FOUND', 'Approval was not found');
}

function assertResolutionScopeAndState(
  record: StoredApprovalRecord,
  input: {
    accountId: string;
    projectId: string;
    actionHash: string;
    actorUserId: string;
  },
): void {
  if (record.accountId !== input.accountId || record.projectId !== input.projectId) {
    throw notFound();
  }
  if (record.actionHash !== input.actionHash) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_CONFLICT',
      'Approval action hash does not match',
    );
  }
  if (record.requestedByUserId !== input.actorUserId) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_FORBIDDEN',
      'Approval actor does not match the requesting user',
    );
  }
  if (record.status !== 'pending') {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_CONFLICT',
      'Approval is no longer pending',
    );
  }
}

function assertResolvable(
  record: StoredApprovalRecord,
  input: {
    accountId: string;
    projectId: string;
    actionHash: string;
    actorUserId: string;
  },
  now: Date,
): void {
  assertResolutionScopeAndState(record, input);
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    throw new AutomationApprovalServiceError('AUTOMATION_APPROVAL_EXPIRED', 'Approval has expired');
  }
}

export function createMemoryApprovalService(options?: {
  store?: MemoryApprovalStore;
  now?: () => Date;
  currentGeneration?: ApprovalGenerationReader;
}): ApprovalService {
  const store = options?.store ?? createMemoryApprovalStore();
  const now = options?.now ?? (() => new Date());
  const currentGeneration = options?.currentGeneration ?? (async () => 0);

  return {
    async request(requestInput) {
      const input = validateRequest(requestInput, now());
      const createdAt = now().toISOString();
      const record: StoredApprovalRecord = {
        approvalId: randomUUID(),
        accountId: input.accountId,
        projectId: input.projectId,
        jobId: input.jobId,
        stepId: input.stepId,
        actionHash: input.actionHash,
        requestedByUserId: input.requestedByUserId,
        status: 'pending',
        actingUserId: null,
        tokenHash: null,
        expiresAt: input.expiresAt.toISOString(),
        resolvedAt: null,
        createdAt,
      };
      store.set(record);
      return toAutomationApproval(record);
    },

    async resolve(input) {
      const record = store.get(input.approvalId);
      if (!record) throw notFound();
      const resolvedAt = now();
      assertResolvable(record, input, resolvedAt);

      if (input.decision === 'reject') {
        record.status = 'rejected';
        record.actingUserId = input.actorUserId;
        record.resolvedAt = resolvedAt.toISOString();
        return null;
      }

      const generation = await currentGeneration({
        accountId: record.accountId,
        projectId: record.projectId,
      });
      const token = issueRawToken();
      record.status = 'approved';
      record.actingUserId = input.actorUserId;
      record.resolvedAt = resolvedAt.toISOString();
      record.tokenHash = boundTokenHash({
        token,
        approvalId: record.approvalId,
        projectId: record.projectId,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
        generation,
      });
      return {
        token,
        approvalId: record.approvalId,
        projectId: record.projectId,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
      };
    },

    async consume(input) {
      if (!ApprovalTokenSchema.safeParse(input.token).success) return false;
      const record = store.get(input.approvalId);
      if (
        !record ||
        record.projectId !== input.projectId ||
        record.actionHash !== input.actionHash ||
        record.status !== 'approved' ||
        record.tokenHash === null ||
        Date.parse(record.expiresAt) <= Math.max(input.now.getTime(), now().getTime())
      ) {
        return false;
      }
      const generation = await currentGeneration({
        accountId: record.accountId,
        projectId: record.projectId,
      });
      const candidateHash = boundTokenHash({
        token: input.token,
        approvalId: record.approvalId,
        projectId: record.projectId,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
        generation,
      });
      if (!hashesEqual(candidateHash, record.tokenHash)) return false;

      record.status = 'consumed';
      return true;
    },
  };
}

function rowToApproval(
  row: typeof automationApprovals.$inferSelect,
  projectId: string,
): AutomationApproval {
  return AutomationApprovalSchema.parse({
    approval_id: row.approvalId,
    job_id: row.jobId,
    step_id: row.stepId,
    project_id: projectId,
    action_hash: row.actionHash,
    status: row.status,
    acting_user_id: row.actingUserId,
    expires_at: row.expiresAt,
    resolved_at: row.resolvedAt,
  });
}

export function createPostgresApprovalService(
  db: Database,
  options?: PostgresApprovalServiceOptions,
): ApprovalService {
  const now = options?.now ?? (() => new Date());
  const currentGeneration = options?.currentGeneration ?? (async () => 0);
  const durableExecutionResolutionEnabled = options?.durableExecutionResolutionEnabled ?? false;
  const newEventId = options?.newEventId ?? randomUUID;

  return {
    async request(requestInput) {
      const input = validateRequest(requestInput, now());
      const [scope] = await db
        .select({ actorUserId: automationJobs.actorUserId })
        .from(automationJobs)
        .innerJoin(
          automationJobSteps,
          and(
            eq(automationJobSteps.jobId, automationJobs.jobId),
            eq(automationJobSteps.stepId, input.stepId),
          ),
        )
        .where(
          and(
            eq(automationJobs.accountId, input.accountId),
            eq(automationJobs.projectId, input.projectId),
            eq(automationJobs.jobId, input.jobId),
            eq(automationJobSteps.actionHash, input.actionHash),
          ),
        )
        .limit(1);
      if (!scope) throw notFound();
      if (scope.actorUserId !== input.requestedByUserId) {
        throw new AutomationApprovalServiceError(
          'AUTOMATION_FORBIDDEN',
          'Approval requester does not own the job action',
        );
      }

      const [created] = await db
        .insert(automationApprovals)
        .values({
          approvalId: randomUUID(),
          jobId: input.jobId,
          stepId: input.stepId,
          actionHash: input.actionHash,
          status: 'pending',
          expiresAt: input.expiresAt.toISOString(),
          createdAt: now().toISOString(),
        })
        .returning();
      if (!created) throw new Error('Approval insert returned no row');
      return rowToApproval(created, input.projectId);
    },

    async resolve(input) {
      try {
        const outcome = await db.transaction(async (tx) => {
          const [approval] = await tx
            .select()
            .from(automationApprovals)
            .where(eq(automationApprovals.approvalId, input.approvalId))
            .limit(1)
            .for('update');
          if (!approval) throw notFound();
          const jobQuery = tx
            .select({
              accountId: automationJobs.accountId,
              projectId: automationJobs.projectId,
              actorUserId: automationJobs.actorUserId,
              status: automationJobs.status,
              leaseOwner: automationJobs.leaseOwner,
              leaseExpiresAt: automationJobs.leaseExpiresAt,
              killSwitchGeneration: automationJobs.killSwitchGeneration,
              deadlineAt: automationJobs.deadlineAt,
            })
            .from(automationJobs)
            .where(eq(automationJobs.jobId, approval.jobId))
            .limit(1);
          const [job] = durableExecutionResolutionEnabled
            ? await jobQuery.for('update')
            : await jobQuery;
          if (!job) throw notFound();

          let steps: Array<
            Pick<
              typeof automationJobSteps.$inferSelect,
              'stepId' | 'sequence' | 'status' | 'actionHash' | 'approvalId'
            >
          > = [];
          if (durableExecutionResolutionEnabled) {
            steps = await tx
              .select({
                stepId: automationJobSteps.stepId,
                sequence: automationJobSteps.sequence,
                status: automationJobSteps.status,
                actionHash: automationJobSteps.actionHash,
                approvalId: automationJobSteps.approvalId,
              })
              .from(automationJobSteps)
              .where(eq(automationJobSteps.jobId, approval.jobId))
              .for('update');
          }

          const record: StoredApprovalRecord = {
            approvalId: approval.approvalId,
            accountId: job.accountId,
            projectId: job.projectId,
            jobId: approval.jobId,
            stepId: approval.stepId,
            actionHash: approval.actionHash as `sha256:${string}`,
            requestedByUserId: job.actorUserId,
            status: approval.status,
            actingUserId: approval.actingUserId,
            tokenHash: approval.tokenHash as `sha256:${string}` | null,
            expiresAt: approval.expiresAt,
            resolvedAt: approval.resolvedAt,
            createdAt: approval.createdAt,
          };
          const resolvedAt = now();
          assertResolutionScopeAndState(record, input);

          if (durableExecutionResolutionEnabled) {
            const orderedSteps = [...steps].sort((left, right) => left.sequence - right.sequence);
            const targetIndex = orderedSteps.findIndex((step) => step.stepId === approval.stepId);
            const target = orderedSteps[targetIndex];
            const executionPauseSignalled =
              target?.approvalId === approval.approvalId || target?.status === 'awaiting_approval';

            if (executionPauseSignalled) {
              const previousSteps = orderedSteps.slice(0, targetIndex);
              const laterSteps = orderedSteps.slice(targetIndex + 1);
              const validSnapshot =
                job.status === 'awaiting_approval' &&
                job.leaseOwner === null &&
                job.leaseExpiresAt === null &&
                target?.status === 'awaiting_approval' &&
                target.approvalId === approval.approvalId &&
                target.actionHash === approval.actionHash &&
                previousSteps.every((step) => step.status === 'succeeded') &&
                laterSteps.every((step) => step.status === 'pending');
              if (!validSnapshot || !target) {
                throw new AutomationApprovalServiceError(
                  'AUTOMATION_CONFLICT',
                  'Durable execution approval snapshot is invalid',
                );
              }

              const deadlineExpired =
                Date.parse(approval.expiresAt) <= resolvedAt.getTime() ||
                Date.parse(job.deadlineAt) <= resolvedAt.getTime();
              const decision: DurableDecision = deadlineExpired ? 'expire' : input.decision;
              const eventType =
                decision === 'approve'
                  ? 'job_dispatched'
                  : decision === 'reject'
                    ? 'job_cancelled'
                    : 'job_expired';
              const eventStatus =
                decision === 'approve'
                  ? 'dispatched'
                  : decision === 'reject'
                    ? 'cancelled'
                    : 'expired';
              const eventDecision =
                decision === 'approve'
                  ? 'approved'
                  : decision === 'reject'
                    ? 'rejected'
                    : 'expired';
              const transition: NonNullable<AppendAutomationEventInput['transition']> =
                decision === 'approve'
                  ? { type: 'approval_granted' }
                  : decision === 'reject'
                    ? { type: 'cancelled' }
                    : { type: 'approval_expired' };

              const eventInput: AppendAutomationEventInput = {
                accountId: job.accountId,
                projectId: job.projectId,
                jobId: approval.jobId,
                leaseOwner: null,
                killSwitchGeneration: job.killSwitchGeneration,
                event: {
                  protocol_version: 'automation.v1',
                  type: eventType,
                  status: eventStatus,
                  payload: {
                    approval_id: approval.approvalId,
                    step_id: target.stepId,
                    action_hash: target.actionHash,
                    decision: eventDecision,
                    resume_after_sequence: previousSteps.at(-1)?.sequence ?? 0,
                    expires_at: approval.expiresAt,
                  },
                  trace_id: null,
                },
                transition,
                occurredAt: resolvedAt,
              };
              const nextStatus = resolveAutomationEventStatus(job.status, eventInput);
              const [maximumEvent] = await tx
                .select({ value: max(automationJobEvents.sequence) })
                .from(automationJobEvents)
                .where(eq(automationJobEvents.jobId, approval.jobId));
              const event = materializeAutomationEvent(
                eventInput,
                Number(maximumEvent?.value ?? 0) + 1,
                newEventId() as ReturnType<typeof randomUUID>,
              );

              if (decision === 'approve') {
                const generation = await currentGeneration({
                  accountId: job.accountId,
                  projectId: job.projectId,
                });
                if (generation !== job.killSwitchGeneration) {
                  throw new AutomationApprovalServiceError(
                    'AUTOMATION_CONFLICT',
                    'Approval generation is no longer current',
                  );
                }
                const token = issueRawToken();
                const tokenHash = boundTokenHash({
                  token,
                  approvalId: approval.approvalId,
                  projectId: job.projectId,
                  actionHash: approval.actionHash,
                  expiresAt: approval.expiresAt,
                  generation,
                });

                const [updatedStep] = await tx
                  .update(automationJobSteps)
                  .set({ status: 'pending' })
                  .where(
                    and(
                      eq(automationJobSteps.jobId, approval.jobId),
                      eq(automationJobSteps.stepId, target.stepId),
                      eq(automationJobSteps.status, 'awaiting_approval'),
                      eq(automationJobSteps.approvalId, approval.approvalId),
                      eq(automationJobSteps.actionHash, approval.actionHash),
                    ),
                  )
                  .returning({ stepId: automationJobSteps.stepId });
                if (!updatedStep) throw new DurableExecutionApprovalConflictError();

                const [updatedApproval] = await tx
                  .update(automationApprovals)
                  .set({
                    status: 'approved',
                    actingUserId: input.actorUserId,
                    tokenHash,
                    resolvedAt: resolvedAt.toISOString(),
                  })
                  .where(
                    and(
                      eq(automationApprovals.approvalId, approval.approvalId),
                      eq(automationApprovals.jobId, approval.jobId),
                      eq(automationApprovals.stepId, approval.stepId),
                      eq(automationApprovals.actionHash, approval.actionHash),
                      eq(automationApprovals.status, 'pending'),
                      gt(automationApprovals.expiresAt, sql`clock_timestamp()`),
                    ),
                  )
                  .returning({ approvalId: automationApprovals.approvalId });
                if (!updatedApproval) throw new DurableExecutionApprovalConflictError();

                const [updatedJob] = await tx
                  .update(automationJobs)
                  .set({
                    status: nextStatus,
                    updatedAt: resolvedAt.toISOString(),
                    terminalAt: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                  })
                  .where(
                    and(
                      eq(automationJobs.jobId, approval.jobId),
                      eq(automationJobs.accountId, job.accountId),
                      eq(automationJobs.projectId, job.projectId),
                      eq(automationJobs.status, 'awaiting_approval'),
                      isNull(automationJobs.leaseOwner),
                      isNull(automationJobs.leaseExpiresAt),
                      eq(automationJobs.killSwitchGeneration, job.killSwitchGeneration),
                      gt(automationJobs.deadlineAt, sql`clock_timestamp()`),
                    ),
                  )
                  .returning({ jobId: automationJobs.jobId });
                if (!updatedJob) throw new DurableExecutionApprovalConflictError();

                await tx.insert(automationJobEvents).values({
                  eventId: event.event_id,
                  jobId: event.job_id,
                  sequence: event.sequence,
                  type: event.type,
                  status: event.status,
                  payload: event.payload,
                  traceId: event.trace_id,
                  workerId: null,
                  workerLeaseId: null,
                  workerOrdinal: null,
                  createdAt: event.created_at,
                });
                return {
                  kind: 'approved',
                  token: {
                    token,
                    approvalId: approval.approvalId,
                    projectId: job.projectId,
                    actionHash: approval.actionHash as `sha256:${string}`,
                    expiresAt: approval.expiresAt,
                  },
                } satisfies DurableResolutionOutcome;
              }

              const unfinishedSteps = orderedSteps
                .slice(targetIndex)
                .filter((step) => step.status === 'pending' || step.status === 'awaiting_approval');
              const updatedSteps = await tx
                .update(automationJobSteps)
                .set({ status: 'cancelled' })
                .where(
                  and(
                    eq(automationJobSteps.jobId, approval.jobId),
                    gte(automationJobSteps.sequence, target.sequence),
                    inArray(automationJobSteps.status, ['pending', 'awaiting_approval']),
                  ),
                )
                .returning({ stepId: automationJobSteps.stepId });
              if (updatedSteps.length !== unfinishedSteps.length) {
                throw new DurableExecutionApprovalConflictError();
              }

              const [updatedApproval] = await tx
                .update(automationApprovals)
                .set(
                  decision === 'reject'
                    ? {
                        status: 'rejected',
                        actingUserId: input.actorUserId,
                        tokenHash: null,
                        resolvedAt: resolvedAt.toISOString(),
                      }
                    : {
                        status: 'expired',
                        actingUserId: null,
                        tokenHash: null,
                        resolvedAt: resolvedAt.toISOString(),
                      },
                )
                .where(
                  and(
                    eq(automationApprovals.approvalId, approval.approvalId),
                    eq(automationApprovals.jobId, approval.jobId),
                    eq(automationApprovals.stepId, approval.stepId),
                    eq(automationApprovals.actionHash, approval.actionHash),
                    eq(automationApprovals.status, 'pending'),
                  ),
                )
                .returning({ approvalId: automationApprovals.approvalId });
              if (!updatedApproval) throw new DurableExecutionApprovalConflictError();

              const [updatedJob] = await tx
                .update(automationJobs)
                .set({
                  status: nextStatus,
                  updatedAt: resolvedAt.toISOString(),
                  terminalAt: resolvedAt.toISOString(),
                  leaseOwner: null,
                  leaseExpiresAt: null,
                })
                .where(
                  and(
                    eq(automationJobs.jobId, approval.jobId),
                    eq(automationJobs.accountId, job.accountId),
                    eq(automationJobs.projectId, job.projectId),
                    eq(automationJobs.status, 'awaiting_approval'),
                    isNull(automationJobs.leaseOwner),
                    isNull(automationJobs.leaseExpiresAt),
                    eq(automationJobs.killSwitchGeneration, job.killSwitchGeneration),
                  ),
                )
                .returning({ jobId: automationJobs.jobId });
              if (!updatedJob) throw new DurableExecutionApprovalConflictError();

              await tx.insert(automationJobEvents).values({
                eventId: event.event_id,
                jobId: event.job_id,
                sequence: event.sequence,
                type: event.type,
                status: event.status,
                payload: event.payload,
                traceId: event.trace_id,
                workerId: null,
                workerLeaseId: null,
                workerOrdinal: null,
                createdAt: event.created_at,
              });
              return decision === 'reject'
                ? ({ kind: 'rejected' } satisfies DurableResolutionOutcome)
                : ({ kind: 'expired' } satisfies DurableResolutionOutcome);
            }
          }

          assertResolvable(record, input, resolvedAt);

          if (input.decision === 'reject') {
            const [updated] = await tx
              .update(automationApprovals)
              .set({
                status: 'rejected',
                actingUserId: input.actorUserId,
                resolvedAt: resolvedAt.toISOString(),
              })
              .where(
                and(
                  eq(automationApprovals.approvalId, approval.approvalId),
                  eq(automationApprovals.status, 'pending'),
                  gt(automationApprovals.expiresAt, sql`clock_timestamp()`),
                ),
              )
              .returning({ approvalId: automationApprovals.approvalId });
            if (!updated) {
              throw new AutomationApprovalServiceError(
                'AUTOMATION_APPROVAL_EXPIRED',
                'Approval has expired',
              );
            }
            return null;
          }

          const generation = await currentGeneration({
            accountId: job.accountId,
            projectId: job.projectId,
          });
          const token = issueRawToken();
          const tokenHash = boundTokenHash({
            token,
            approvalId: approval.approvalId,
            projectId: job.projectId,
            actionHash: approval.actionHash,
            expiresAt: approval.expiresAt,
            generation,
          });
          const [updated] = await tx
            .update(automationApprovals)
            .set({
              status: 'approved',
              actingUserId: input.actorUserId,
              tokenHash,
              resolvedAt: resolvedAt.toISOString(),
            })
            .where(
              and(
                eq(automationApprovals.approvalId, approval.approvalId),
                eq(automationApprovals.status, 'pending'),
                gt(automationApprovals.expiresAt, sql`clock_timestamp()`),
              ),
            )
            .returning({ approvalId: automationApprovals.approvalId });
          if (!updated) {
            throw new AutomationApprovalServiceError(
              'AUTOMATION_APPROVAL_EXPIRED',
              'Approval has expired',
            );
          }
          return {
            token,
            approvalId: approval.approvalId,
            projectId: job.projectId,
            actionHash: approval.actionHash as `sha256:${string}`,
            expiresAt: approval.expiresAt,
          };
        });
        if (outcome !== null && 'kind' in outcome) {
          if (outcome.kind === 'expired') {
            throw new AutomationApprovalServiceError(
              'AUTOMATION_APPROVAL_EXPIRED',
              'Approval has expired',
            );
          }
          return outcome.kind === 'approved' ? outcome.token : null;
        }
        return outcome;
      } catch (error) {
        if (error instanceof DurableExecutionApprovalConflictError) {
          throw new AutomationApprovalServiceError('AUTOMATION_CONFLICT', 'Approval state changed');
        }
        throw error;
      }
    },

    async consume(input) {
      if (!ApprovalTokenSchema.safeParse(input.token).success) return false;
      return db.transaction(async (tx) => {
        const [approval] = await tx
          .select()
          .from(automationApprovals)
          .where(eq(automationApprovals.approvalId, input.approvalId))
          .limit(1)
          .for('update');
        if (!approval || approval.status !== 'approved' || approval.tokenHash === null) {
          return false;
        }
        const [job] = await tx
          .select({
            accountId: automationJobs.accountId,
            projectId: automationJobs.projectId,
          })
          .from(automationJobs)
          .where(eq(automationJobs.jobId, approval.jobId))
          .limit(1);
        if (!job || job.projectId !== input.projectId || approval.actionHash !== input.actionHash) {
          return false;
        }

        const generation = await currentGeneration(job);
        const candidateHash = boundTokenHash({
          token: input.token,
          approvalId: approval.approvalId,
          projectId: job.projectId,
          actionHash: approval.actionHash,
          expiresAt: approval.expiresAt,
          generation,
        });
        if (!hashesEqual(candidateHash, approval.tokenHash)) return false;

        const [consumed] = await tx
          .update(automationApprovals)
          .set({ status: 'consumed' })
          .where(
            and(
              eq(automationApprovals.approvalId, approval.approvalId),
              eq(automationApprovals.status, 'approved'),
              eq(automationApprovals.tokenHash, candidateHash),
              gt(
                automationApprovals.expiresAt,
                sql`GREATEST(clock_timestamp(), ${input.now.toISOString()}::timestamptz)`,
              ),
            ),
          )
          .returning({ approvalId: automationApprovals.approvalId });
        return consumed !== undefined;
      });
    },
  };
}
