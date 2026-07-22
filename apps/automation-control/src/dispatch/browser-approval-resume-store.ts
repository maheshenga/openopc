import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type Database,
  automationApprovalResumeAttempts,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import {
  type AutomationBrowserApprovalConsumeInput,
  AutomationBrowserApprovalConsumeInputSchema,
  type AutomationJob,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
} from '@kortix/intelligence-contracts';
import { and, asc, eq, gt, isNull, lte, max, sql } from 'drizzle-orm';
import { materializeAutomationEvent, resolveAutomationEventStatus } from '../event-store';

export type BrowserApprovalResumeCandidate = Readonly<{
  job: AutomationJob;
  approvalId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  resumeAfterSequence: number;
  approvalExpiresAt: string;
}>;

export type IssuedBrowserApprovalResume = Readonly<{
  attemptId: string;
  approvalId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  token: string;
  expiresAt: string;
  resumeAfterSequence: number;
}>;

export type BrowserApprovalResumeConsumeResult =
  | Readonly<{ accepted: true; idempotent: boolean; startedAt: string }>
  | Readonly<{
      accepted: false;
      reason:
        | 'credential_invalid'
        | 'stale_lease'
        | 'dispatch_mismatch'
        | 'approval_terminal'
        | 'conflict';
    }>;

export type BrowserApprovalResumeObservation = Readonly<{
  type:
    | 'browser_resume_attempt_issued'
    | 'browser_resume_dispatched'
    | 'browser_resume_consumed'
    | 'browser_resume_rejected'
    | 'browser_resume_expired'
    | 'browser_resume_duplicate';
  jobId: string;
  stepId: string;
  approvalId: string;
  attemptId: string;
  traceId: string | null;
  reason?: Extract<BrowserApprovalResumeConsumeResult, { accepted: false }>['reason'];
  occurredAt: string;
}>;

export interface BrowserApprovalResumeStore {
  listCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<readonly BrowserApprovalResumeCandidate[]>;
  issue(input: {
    candidate: BrowserApprovalResumeCandidate;
    lease: AutomationLease;
    now: Date;
  }): Promise<IssuedBrowserApprovalResume | null>;
  consumeAndStart(
    input: AutomationBrowserApprovalConsumeInput & {
      workerId: string;
      now: Date;
    },
  ): Promise<BrowserApprovalResumeConsumeResult>;
}

export type PostgresBrowserApprovalResumeStoreOptions = Readonly<{
  tokenPepper: string;
  newAttemptId?: () => string;
  randomBytes?: (size: number) => Buffer;
  observe?: (event: BrowserApprovalResumeObservation) => void;
}>;

type BrowserApprovalResumeTokenBinding = Readonly<{
  token: string;
  accountId: string;
  projectId: string;
  approvalId: string;
  jobId: string;
  stepId: string;
  actionHash: string;
  leaseId: string;
  leaseOwner: string;
  killSwitchGeneration: number;
  attemptId: string;
  resumeAfterSequence: number;
  expiresAt: string;
}>;

function issueRawResumeToken(random: (size: number) => Buffer): string {
  return `approval-resume.v1.${random(32).toString('base64url')}`;
}

function boundResumeTokenHash(
  input: BrowserApprovalResumeTokenBinding,
  tokenPepper: string,
): `sha256:${string}` {
  const digest = createHmac('sha256', tokenPepper)
    .update(
      [
        input.token,
        input.accountId,
        input.projectId,
        input.approvalId,
        input.jobId,
        input.stepId,
        input.actionHash,
        input.leaseId,
        input.leaseOwner,
        input.killSwitchGeneration,
        input.attemptId,
        input.resumeAfterSequence,
        input.expiresAt,
      ].join('\0'),
    )
    .digest('hex');
  return `sha256:${digest}`;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class BrowserApprovalResumeSettlementConflictError extends Error {
  override readonly name = 'BrowserApprovalResumeSettlementConflictError';
}

function candidateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Browser approval resume candidate limit must be between 1 and 100');
  }
  return limit;
}

function toAutomationJob(row: typeof automationJobs.$inferSelect): AutomationJob {
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

function timestampAfter(value: string | null, now: Date): value is string {
  return value !== null && Date.parse(value) > now.getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lockedJobSelection(value: unknown, now: Date) {
  const wrapped = isRecord(value) && 'job' in value;
  const job = (wrapped ? value.job : value) as typeof automationJobs.$inferSelect | undefined;
  return {
    job,
    leaseCurrent:
      wrapped && typeof value.leaseCurrent === 'boolean'
        ? value.leaseCurrent
        : timestampAfter(job?.leaseExpiresAt ?? null, now),
    deadlineCurrent:
      wrapped && typeof value.deadlineCurrent === 'boolean'
        ? value.deadlineCurrent
        : timestampAfter(job?.deadlineAt ?? null, now),
  };
}

function lockedApprovalSelection(value: unknown, now: Date) {
  const wrapped = isRecord(value) && 'approval' in value;
  const approval = (wrapped ? value.approval : value) as
    | typeof automationApprovals.$inferSelect
    | undefined;
  return {
    approval,
    current:
      wrapped && typeof value.current === 'boolean'
        ? value.current
        : timestampAfter(approval?.expiresAt ?? null, now),
  };
}

function lockedAttemptSelection(value: unknown, now: Date) {
  const wrapped = isRecord(value) && 'attempt' in value;
  const attempt = (wrapped ? value.attempt : value) as
    | typeof automationApprovalResumeAttempts.$inferSelect
    | undefined;
  return {
    attempt,
    current:
      wrapped && typeof value.current === 'boolean'
        ? value.current
        : timestampAfter(attempt?.expiresAt ?? null, now),
  };
}

function leaseIdFromOwner(owner: string): string | null {
  const separator = owner.lastIndexOf(':');
  return separator < 0 ? null : owner.slice(separator + 1);
}

function minimumTimestamp(...values: string[]): string {
  return new Date(Math.min(...values.map((value) => Date.parse(value)))).toISOString();
}

function safeObserve(
  observe: PostgresBrowserApprovalResumeStoreOptions['observe'],
  events: readonly BrowserApprovalResumeObservation[],
): void {
  if (!observe) return;
  for (const event of events) {
    try {
      observe(event);
    } catch {
      // Telemetry must never change credential issuance semantics.
    }
  }
}

function traceIdFromJobRow(row: typeof automationJobs.$inferSelect | undefined): string | null {
  if (!row) return null;
  const parsed = AutomationJobSchema.safeParse({
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
  return parsed.success ? (parsed.data.request.traceparent?.split('-')[1] ?? null) : null;
}

function requireSingleWrite(rows: readonly unknown[]): void {
  if (rows.length !== 1) throw new BrowserApprovalResumeSettlementConflictError();
}

function stepsProveResumeCursor(
  steps: readonly (typeof automationJobSteps.$inferSelect)[],
  candidate: BrowserApprovalResumeCandidate,
): boolean {
  const target = steps.find((step) => step.stepId === candidate.stepId);
  if (
    !target ||
    target.status !== 'pending' ||
    target.approvalId !== candidate.approvalId ||
    target.actionHash !== candidate.actionHash
  ) {
    return false;
  }
  const previous = steps.filter((step) => step.sequence < target.sequence);
  const later = steps.filter((step) => step.sequence > target.sequence);
  const resumeAfterSequence = previous.at(-1)?.sequence ?? 0;
  return (
    previous.every((step) => step.status === 'succeeded') &&
    later.every((step) => step.status === 'pending') &&
    resumeAfterSequence === candidate.resumeAfterSequence
  );
}

export function createPostgresBrowserApprovalResumeStore(
  db: Database,
  options: PostgresBrowserApprovalResumeStoreOptions,
): BrowserApprovalResumeStore {
  if (options.tokenPepper.length < 32) {
    throw new RangeError(
      'Browser approval resume token pepper must contain at least 32 characters',
    );
  }
  const newAttemptId = options.newAttemptId ?? randomUUID;
  const tokenRandomBytes = options.randomBytes ?? randomBytes;

  return {
    async listCandidates(input) {
      const limit = candidateLimit(input.limit);
      const nowIso = input.now.toISOString();
      const rows = await db
        .select({
          job: automationJobs,
          approval: automationApprovals,
          step: automationJobSteps,
        })
        .from(automationJobs)
        .innerJoin(automationApprovals, eq(automationApprovals.jobId, automationJobs.jobId))
        .innerJoin(
          automationJobSteps,
          and(
            eq(automationJobSteps.jobId, automationApprovals.jobId),
            eq(automationJobSteps.stepId, automationApprovals.stepId),
          ),
        )
        .where(
          and(
            eq(automationJobs.executionDomain, 'browser'),
            eq(automationJobs.status, 'dispatched'),
            isNull(automationJobs.cancelRequestedAt),
            gt(automationJobs.deadlineAt, sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`),
            eq(automationApprovals.status, 'approved'),
            gt(
              automationApprovals.expiresAt,
              sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
            ),
            eq(automationJobSteps.status, 'pending'),
            eq(automationJobSteps.approvalId, automationApprovals.approvalId),
            eq(automationJobSteps.actionHash, automationApprovals.actionHash),
          ),
        )
        .orderBy(asc(automationJobSteps.sequence), asc(automationJobs.createdAt))
        .limit(limit);

      const candidates: BrowserApprovalResumeCandidate[] = [];
      for (const row of rows) {
        const steps = await db
          .select()
          .from(automationJobSteps)
          .where(eq(automationJobSteps.jobId, row.job.jobId))
          .orderBy(asc(automationJobSteps.sequence));
        const target = steps.find((step) => step.stepId === row.step.stepId);
        if (!target) continue;
        const previous = steps.filter((step) => step.sequence < target.sequence);
        const later = steps.filter((step) => step.sequence > target.sequence);
        if (
          target.status !== 'pending' ||
          target.approvalId !== row.approval.approvalId ||
          target.actionHash !== row.approval.actionHash ||
          !previous.every((step) => step.status === 'succeeded') ||
          !later.every((step) => step.status === 'pending')
        ) {
          continue;
        }
        candidates.push({
          job: toAutomationJob(row.job),
          approvalId: row.approval.approvalId,
          stepId: target.stepId,
          actionHash: target.actionHash as `sha256:${string}`,
          resumeAfterSequence: previous.at(-1)?.sequence ?? 0,
          approvalExpiresAt: row.approval.expiresAt,
        });
      }
      return candidates;
    },

    async issue(input) {
      const candidate = {
        ...input.candidate,
        job: AutomationJobSchema.parse(input.candidate.job),
      };
      const parsedLease = AutomationLeaseSchema.safeParse(input.lease);
      if (!parsedLease.success) return null;
      const lease = parsedLease.data;
      const nowIso = input.now.toISOString();

      const committed = await db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(automationJobs)
          .where(
            and(
              eq(automationJobs.accountId, candidate.job.account_id),
              eq(automationJobs.projectId, candidate.job.request.project_id),
              eq(automationJobs.jobId, candidate.job.job_id),
              eq(automationJobs.executionDomain, 'browser'),
              eq(automationJobs.status, 'dispatched'),
              isNull(automationJobs.cancelRequestedAt),
              gt(
                automationJobs.deadlineAt,
                sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
              ),
              gt(
                automationJobs.leaseExpiresAt,
                sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
              ),
            ),
          )
          .limit(1)
          .for('update');
        if (
          !job ||
          job.accountId !== candidate.job.account_id ||
          job.projectId !== candidate.job.request.project_id ||
          job.jobId !== candidate.job.job_id ||
          job.executionDomain !== 'browser' ||
          job.status !== 'dispatched' ||
          job.cancelRequestedAt !== null ||
          job.leaseOwner !== lease.owner ||
          job.leaseExpiresAt !== lease.expires_at ||
          job.killSwitchGeneration !== lease.kill_switch_generation ||
          job.requestHash !== lease.request_hash ||
          job.deadlineAt !== candidate.job.request.deadline_at ||
          !timestampAfter(job.deadlineAt, input.now) ||
          !timestampAfter(job.leaseExpiresAt, input.now) ||
          lease.job_id !== candidate.job.job_id ||
          lease.project_id !== candidate.job.request.project_id ||
          lease.execution_domain !== 'browser' ||
          lease.permission_id !== null ||
          leaseIdFromOwner(lease.owner) !== lease.lease_id ||
          !timestampAfter(lease.expires_at, input.now)
        ) {
          return null;
        }

        const [approval] = await tx
          .select()
          .from(automationApprovals)
          .where(eq(automationApprovals.approvalId, candidate.approvalId))
          .limit(1)
          .for('update');
        if (
          !approval ||
          approval.approvalId !== candidate.approvalId ||
          approval.jobId !== candidate.job.job_id ||
          approval.stepId !== candidate.stepId ||
          approval.actionHash !== candidate.actionHash ||
          approval.status !== 'approved' ||
          approval.expiresAt !== candidate.approvalExpiresAt ||
          !timestampAfter(approval.expiresAt, input.now)
        ) {
          return null;
        }

        const steps = await tx
          .select()
          .from(automationJobSteps)
          .where(eq(automationJobSteps.jobId, candidate.job.job_id))
          .orderBy(asc(automationJobSteps.sequence))
          .for('update');
        if (!stepsProveResumeCursor(steps, candidate)) return null;

        const expiredAttempts = await tx
          .update(automationApprovalResumeAttempts)
          .set({ status: 'expired' })
          .where(
            and(
              eq(automationApprovalResumeAttempts.approvalId, candidate.approvalId),
              eq(automationApprovalResumeAttempts.status, 'issued'),
              lte(
                automationApprovalResumeAttempts.expiresAt,
                sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
              ),
            ),
          )
          .returning({ attemptId: automationApprovalResumeAttempts.attemptId });

        const activeAttempts = await tx
          .select()
          .from(automationApprovalResumeAttempts)
          .where(
            and(
              eq(automationApprovalResumeAttempts.approvalId, candidate.approvalId),
              eq(automationApprovalResumeAttempts.status, 'issued'),
            ),
          )
          .orderBy(asc(automationApprovalResumeAttempts.issuedAt))
          .limit(1)
          .for('update');
        if (activeAttempts.length > 0) return null;

        const expiresAt = minimumTimestamp(approval.expiresAt, lease.expires_at, job.deadlineAt);
        if (!timestampAfter(expiresAt, input.now)) return null;

        const attemptId = newAttemptId();
        const token = issueRawResumeToken(tokenRandomBytes);
        const tokenHash = boundResumeTokenHash(
          {
            token,
            accountId: candidate.job.account_id,
            projectId: candidate.job.request.project_id,
            approvalId: candidate.approvalId,
            jobId: candidate.job.job_id,
            stepId: candidate.stepId,
            actionHash: candidate.actionHash,
            leaseId: lease.lease_id,
            leaseOwner: lease.owner,
            killSwitchGeneration: lease.kill_switch_generation,
            attemptId,
            resumeAfterSequence: candidate.resumeAfterSequence,
            expiresAt,
          },
          options.tokenPepper,
        );

        const [inserted] = await tx
          .insert(automationApprovalResumeAttempts)
          .values({
            attemptId,
            accountId: candidate.job.account_id,
            projectId: candidate.job.request.project_id,
            approvalId: candidate.approvalId,
            jobId: candidate.job.job_id,
            stepId: candidate.stepId,
            leaseId: lease.lease_id,
            leaseOwner: lease.owner,
            killSwitchGeneration: lease.kill_switch_generation,
            resumeAfterSequence: candidate.resumeAfterSequence,
            actionHash: candidate.actionHash,
            tokenHash,
            status: 'issued',
            issuedAt: nowIso,
            expiresAt,
          })
          .returning({ attemptId: automationApprovalResumeAttempts.attemptId });
        if (!inserted) return null;

        const traceId = candidate.job.request.traceparent?.split('-')[1] ?? null;
        const observations: BrowserApprovalResumeObservation[] = expiredAttempts.map((attempt) => ({
          type: 'browser_resume_expired',
          jobId: candidate.job.job_id,
          stepId: candidate.stepId,
          approvalId: candidate.approvalId,
          attemptId: attempt.attemptId,
          traceId,
          occurredAt: nowIso,
        }));
        observations.push({
          type: 'browser_resume_attempt_issued',
          jobId: candidate.job.job_id,
          stepId: candidate.stepId,
          approvalId: candidate.approvalId,
          attemptId,
          traceId,
          occurredAt: nowIso,
        });
        return {
          issued: {
            attemptId,
            approvalId: candidate.approvalId,
            jobId: candidate.job.job_id,
            stepId: candidate.stepId,
            actionHash: candidate.actionHash,
            token,
            expiresAt,
            resumeAfterSequence: candidate.resumeAfterSequence,
          } satisfies IssuedBrowserApprovalResume,
          observations,
        };
      });

      if (!committed) return null;
      safeObserve(options.observe, committed.observations);
      return committed.issued;
    },

    async consumeAndStart(input) {
      const { now, workerId, ...consumeInput } = input;
      void workerId;
      const parsed = AutomationBrowserApprovalConsumeInputSchema.parse(consumeInput);
      const startedAt = now.toISOString();

      const committed = await db.transaction(async (tx) => {
        const [jobLock] = await tx
          .select({
            job: automationJobs,
            leaseCurrent: sql<boolean>`${automationJobs.leaseExpiresAt}
              > GREATEST(clock_timestamp(), ${startedAt}::timestamptz)`,
            deadlineCurrent: sql<boolean>`${automationJobs.deadlineAt}
              > GREATEST(clock_timestamp(), ${startedAt}::timestamptz)`,
          })
          .from(automationJobs)
          .where(
            and(
              eq(automationJobs.accountId, parsed.account_id),
              eq(automationJobs.projectId, parsed.project_id),
              eq(automationJobs.jobId, parsed.job_id),
            ),
          )
          .limit(1)
          .for('update');
        const { job, leaseCurrent, deadlineCurrent } = lockedJobSelection(jobLock, now);

        const [approvalLock] = await tx
          .select({
            approval: automationApprovals,
            current: sql<boolean>`${automationApprovals.expiresAt}
              > GREATEST(clock_timestamp(), ${startedAt}::timestamptz)`,
          })
          .from(automationApprovals)
          .where(
            and(
              eq(automationApprovals.approvalId, parsed.approval_id),
              eq(automationApprovals.jobId, parsed.job_id),
            ),
          )
          .limit(1)
          .for('update');
        const { approval, current: approvalCurrent } = lockedApprovalSelection(approvalLock, now);

        const steps = await tx
          .select()
          .from(automationJobSteps)
          .where(eq(automationJobSteps.jobId, parsed.job_id))
          .orderBy(asc(automationJobSteps.sequence))
          .for('update');

        const [attemptLock] = await tx
          .select({
            attempt: automationApprovalResumeAttempts,
            current: sql<boolean>`${automationApprovalResumeAttempts.expiresAt}
              > GREATEST(clock_timestamp(), ${startedAt}::timestamptz)`,
          })
          .from(automationApprovalResumeAttempts)
          .where(
            and(
              eq(automationApprovalResumeAttempts.accountId, parsed.account_id),
              eq(automationApprovalResumeAttempts.projectId, parsed.project_id),
              eq(automationApprovalResumeAttempts.attemptId, parsed.attempt_id),
            ),
          )
          .limit(1)
          .for('update');
        const { attempt, current: attemptCurrent } = lockedAttemptSelection(attemptLock, now);

        if (!attempt) {
          return {
            result: { accepted: false, reason: 'credential_invalid' } as const,
            observations: [] as BrowserApprovalResumeObservation[],
          };
        }

        const candidateHash = boundResumeTokenHash(
          {
            token: parsed.token,
            accountId: attempt.accountId,
            projectId: attempt.projectId,
            approvalId: attempt.approvalId,
            jobId: attempt.jobId,
            stepId: attempt.stepId,
            actionHash: attempt.actionHash,
            leaseId: attempt.leaseId,
            leaseOwner: attempt.leaseOwner,
            killSwitchGeneration: attempt.killSwitchGeneration,
            attemptId: attempt.attemptId,
            resumeAfterSequence: attempt.resumeAfterSequence,
            expiresAt: attempt.expiresAt,
          },
          options.tokenPepper,
        );
        if (!hashesEqual(attempt.tokenHash, candidateHash)) {
          return {
            result: { accepted: false, reason: 'credential_invalid' } as const,
            observations: [] as BrowserApprovalResumeObservation[],
          };
        }

        const traceId = traceIdFromJobRow(job);
        const observation = (
          type: BrowserApprovalResumeObservation['type'],
          reason?: Extract<BrowserApprovalResumeConsumeResult, { accepted: false }>['reason'],
        ): BrowserApprovalResumeObservation => ({
          type,
          jobId: attempt.jobId,
          stepId: attempt.stepId,
          approvalId: attempt.approvalId,
          attemptId: attempt.attemptId,
          traceId,
          ...(reason === undefined ? {} : { reason }),
          occurredAt: startedAt,
        });

        if (
          attempt.accountId !== parsed.account_id ||
          attempt.projectId !== parsed.project_id ||
          (job !== undefined &&
            (job.accountId !== parsed.account_id || job.projectId !== parsed.project_id))
        ) {
          return {
            result: { accepted: false, reason: 'credential_invalid' } as const,
            observations: [] as BrowserApprovalResumeObservation[],
          };
        }

        const targetStep = steps.find((step) => step.stepId === parsed.step_id);
        const exactIdempotentState =
          attempt.status === 'consumed' &&
          approval?.status === 'consumed' &&
          targetStep?.status === 'running' &&
          job?.status === 'running' &&
          attempt.consumedAt !== null &&
          attempt.accountId === parsed.account_id &&
          attempt.projectId === parsed.project_id &&
          attempt.approvalId === parsed.approval_id &&
          attempt.jobId === parsed.job_id &&
          attempt.stepId === parsed.step_id &&
          attempt.actionHash === parsed.action_hash &&
          attempt.leaseId === parsed.lease_id &&
          attempt.leaseOwner === parsed.lease_owner &&
          attempt.killSwitchGeneration === parsed.kill_switch_generation &&
          attempt.resumeAfterSequence === parsed.resume_after_sequence &&
          approval.jobId === parsed.job_id &&
          approval.stepId === parsed.step_id &&
          targetStep.jobId === parsed.job_id &&
          targetStep.stepId === parsed.step_id &&
          job.accountId === parsed.account_id &&
          job.projectId === parsed.project_id;
        if (exactIdempotentState) {
          return {
            result: {
              accepted: true,
              idempotent: true,
              startedAt: attempt.consumedAt as string,
            } as const,
            observations: [observation('browser_resume_duplicate')],
          };
        }

        if (attempt.status === 'issued' && !attemptCurrent) {
          const expired = await tx
            .update(automationApprovalResumeAttempts)
            .set({ status: 'expired' })
            .where(
              and(
                eq(automationApprovalResumeAttempts.attemptId, attempt.attemptId),
                eq(automationApprovalResumeAttempts.status, 'issued'),
                lte(
                  automationApprovalResumeAttempts.expiresAt,
                  sql`GREATEST(clock_timestamp(), ${startedAt}::timestamptz)`,
                ),
              ),
            )
            .returning({ attemptId: automationApprovalResumeAttempts.attemptId });
          requireSingleWrite(expired);
          return {
            result: { accepted: false, reason: 'credential_invalid' } as const,
            observations: [observation('browser_resume_expired', 'credential_invalid')],
          };
        }

        if (
          attempt.leaseId !== parsed.lease_id ||
          attempt.leaseOwner !== parsed.lease_owner ||
          attempt.killSwitchGeneration !== parsed.kill_switch_generation ||
          (job !== undefined &&
            (job.leaseOwner !== parsed.lease_owner ||
              job.killSwitchGeneration !== parsed.kill_switch_generation ||
              !leaseCurrent))
        ) {
          return {
            result: { accepted: false, reason: 'stale_lease' } as const,
            observations: [] as BrowserApprovalResumeObservation[],
          };
        }

        const rejectAttempt = async (
          reason: 'dispatch_mismatch' | 'approval_terminal' | 'conflict',
        ) => {
          const rejected = await tx
            .update(automationApprovalResumeAttempts)
            .set({ status: 'rejected' })
            .where(
              and(
                eq(automationApprovalResumeAttempts.attemptId, attempt.attemptId),
                eq(automationApprovalResumeAttempts.status, 'issued'),
              ),
            )
            .returning({ attemptId: automationApprovalResumeAttempts.attemptId });
          requireSingleWrite(rejected);
          return {
            result: { accepted: false, reason } as const,
            observations: [observation('browser_resume_rejected', reason)],
          };
        };

        if (
          attempt.approvalId !== parsed.approval_id ||
          attempt.jobId !== parsed.job_id ||
          attempt.stepId !== parsed.step_id ||
          attempt.actionHash !== parsed.action_hash ||
          attempt.resumeAfterSequence !== parsed.resume_after_sequence
        ) {
          return rejectAttempt('dispatch_mismatch');
        }

        if (!approval || approval.status !== 'approved' || !approvalCurrent) {
          if (attempt.status !== 'issued') {
            return {
              result: { accepted: false, reason: 'approval_terminal' } as const,
              observations: [] as BrowserApprovalResumeObservation[],
            };
          }
          return rejectAttempt('approval_terminal');
        }

        if (
          attempt.status !== 'issued' ||
          !job ||
          job.status !== 'dispatched' ||
          job.cancelRequestedAt !== null ||
          !deadlineCurrent ||
          !targetStep ||
          targetStep.status !== 'pending'
        ) {
          if (attempt.status !== 'issued') {
            return {
              result: { accepted: false, reason: 'conflict' } as const,
              observations: [] as BrowserApprovalResumeObservation[],
            };
          }
          return rejectAttempt('conflict');
        }

        const candidate: BrowserApprovalResumeCandidate = {
          job: toAutomationJob(job),
          approvalId: parsed.approval_id,
          stepId: parsed.step_id,
          actionHash: parsed.action_hash as `sha256:${string}`,
          resumeAfterSequence: parsed.resume_after_sequence,
          approvalExpiresAt: approval.expiresAt,
        };
        if (
          approval.jobId !== parsed.job_id ||
          approval.stepId !== parsed.step_id ||
          approval.actionHash !== parsed.action_hash ||
          !approvalCurrent ||
          targetStep.approvalId !== parsed.approval_id ||
          targetStep.actionHash !== parsed.action_hash ||
          !stepsProveResumeCursor(steps, candidate)
        ) {
          return rejectAttempt('conflict');
        }

        const eventInput = {
          accountId: parsed.account_id,
          projectId: parsed.project_id,
          jobId: parsed.job_id,
          leaseOwner: parsed.lease_owner,
          killSwitchGeneration: parsed.kill_switch_generation,
          event: {
            protocol_version: 'automation.v1' as const,
            type: 'job_started' as const,
            status: 'running' as const,
            payload: {
              execution_domain: 'browser',
              approval_id: parsed.approval_id,
              attempt_id: parsed.attempt_id,
              step_id: parsed.step_id,
              resume_after_sequence: parsed.resume_after_sequence,
            },
            trace_id: null,
          },
          transition: { type: 'started' as const },
          occurredAt: now,
        };
        resolveAutomationEventStatus(job.status, eventInput);

        const consumedAttempt = await tx
          .update(automationApprovalResumeAttempts)
          .set({ status: 'consumed', consumedAt: startedAt })
          .where(
            and(
              eq(automationApprovalResumeAttempts.attemptId, parsed.attempt_id),
              eq(automationApprovalResumeAttempts.status, 'issued'),
              gt(automationApprovalResumeAttempts.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ attemptId: automationApprovalResumeAttempts.attemptId });
        requireSingleWrite(consumedAttempt);

        const consumedApproval = await tx
          .update(automationApprovals)
          .set({ status: 'consumed' })
          .where(
            and(
              eq(automationApprovals.approvalId, parsed.approval_id),
              eq(automationApprovals.status, 'approved'),
              eq(automationApprovals.actionHash, parsed.action_hash),
              gt(automationApprovals.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ approvalId: automationApprovals.approvalId });
        requireSingleWrite(consumedApproval);

        const startedStep = await tx
          .update(automationJobSteps)
          .set({ status: 'running', startedAt })
          .where(
            and(
              eq(automationJobSteps.jobId, parsed.job_id),
              eq(automationJobSteps.stepId, parsed.step_id),
              eq(automationJobSteps.status, 'pending'),
              eq(automationJobSteps.approvalId, parsed.approval_id),
              eq(automationJobSteps.actionHash, parsed.action_hash),
            ),
          )
          .returning({ stepId: automationJobSteps.stepId });
        requireSingleWrite(startedStep);

        const startedJob = await tx
          .update(automationJobs)
          .set({ status: 'running', updatedAt: startedAt })
          .where(
            and(
              eq(automationJobs.accountId, parsed.account_id),
              eq(automationJobs.projectId, parsed.project_id),
              eq(automationJobs.jobId, parsed.job_id),
              eq(automationJobs.status, 'dispatched'),
              eq(automationJobs.leaseOwner, parsed.lease_owner),
              eq(automationJobs.killSwitchGeneration, parsed.kill_switch_generation),
              gt(automationJobs.leaseExpiresAt, sql`clock_timestamp()`),
              gt(automationJobs.deadlineAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ jobId: automationJobs.jobId });
        requireSingleWrite(startedJob);

        const [maximum] = await tx
          .select({ value: max(automationJobEvents.sequence) })
          .from(automationJobEvents)
          .where(eq(automationJobEvents.jobId, parsed.job_id));
        const event = materializeAutomationEvent(eventInput, Number(maximum?.value ?? 0) + 1);
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
          result: { accepted: true, idempotent: false, startedAt } as const,
          observations: [observation('browser_resume_consumed')],
        };
      });

      safeObserve(options.observe, committed.observations);
      return committed.result;
    },
  };
}
