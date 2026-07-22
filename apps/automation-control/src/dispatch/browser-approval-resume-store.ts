import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  type Database,
  automationApprovalResumeAttempts,
  automationApprovals,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import {
  type AutomationBrowserApprovalConsumeInput,
  type AutomationJob,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
} from '@kortix/intelligence-contracts';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';

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

    async consumeAndStart() {
      throw new Error('Browser approval resume settlement is not implemented');
    },
  };
}
