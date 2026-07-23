import { type Database, automationJobSteps, automationJobs, automationPolicies } from '@kortix/db';
import type { AutomationBrowserAuthorityCheckInput } from '@kortix/intelligence-contracts';
import { and, eq, max } from 'drizzle-orm';

export type BrowserAuthorityCheckResult =
  | Readonly<{
      accepted: true;
      checkedAt: string;
      currentGeneration: number;
      fullAccessGrantCurrent: boolean;
    }>
  | Readonly<{
      accepted: false;
      reason: 'stale_lease' | 'dispatch_mismatch';
    }>;

export interface BrowserAuthorityStore {
  check(
    input: AutomationBrowserAuthorityCheckInput,
    now: Date,
  ): Promise<BrowserAuthorityCheckResult>;
}

export type BrowserAuthoritySnapshot = Readonly<{
  job: Readonly<{
    accountId: string;
    projectId: string;
    jobId: string;
    executionDomain: string;
    requestHash: string;
    status: string;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    deadlineAt: string | null;
    killSwitchGeneration: number;
    cancelRequestedAt: string | null;
    approvalPolicy: string;
  }> | null;
  step: Readonly<{
    stepId: string;
    sequence: number;
    actionHash: string;
    status: string;
  }> | null;
  maxCompletedSequence: number | null;
  fullAccessAllowed: boolean;
}>;

export type BrowserAuthoritySnapshotReader = (
  input: AutomationBrowserAuthorityCheckInput,
) => Promise<BrowserAuthoritySnapshot>;

function rejected(reason: Extract<BrowserAuthorityCheckResult, { accepted: false }>['reason']) {
  return { accepted: false, reason } as const;
}

function timestampIsAfter(value: string | null, now: Date): boolean {
  if (value === null) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now.getTime();
}

function leaseIdFromOwner(owner: string): string | null {
  const separator = owner.lastIndexOf(':');
  return separator < 0 ? null : owner.slice(separator + 1);
}

function hasCurrentLease(
  job: NonNullable<BrowserAuthoritySnapshot['job']>,
  input: AutomationBrowserAuthorityCheckInput,
  now: Date,
): boolean {
  return (
    job.leaseOwner === input.lease_owner &&
    leaseIdFromOwner(input.lease_owner) === input.lease_id &&
    job.killSwitchGeneration === input.kill_switch_generation &&
    timestampIsAfter(job.leaseExpiresAt, now) &&
    timestampIsAfter(job.deadlineAt, now)
  );
}

export function createBrowserAuthorityStore(
  readSnapshot: BrowserAuthoritySnapshotReader,
): BrowserAuthorityStore {
  return {
    async check(input, now) {
      if (!Number.isFinite(now.getTime())) return rejected('stale_lease');
      let snapshot: BrowserAuthoritySnapshot;
      try {
        snapshot = await readSnapshot(input);
      } catch {
        return rejected('dispatch_mismatch');
      }
      const job = snapshot.job;
      if (
        job === null ||
        job.accountId !== input.account_id ||
        job.projectId !== input.project_id ||
        job.jobId !== input.job_id ||
        job.executionDomain !== 'browser' ||
        job.requestHash !== input.request_hash ||
        !['dispatched', 'running'].includes(job.status) ||
        job.cancelRequestedAt !== null
      ) {
        return rejected('dispatch_mismatch');
      }
      if (!hasCurrentLease(job, input, now)) return rejected('stale_lease');

      if (input.check.kind === 'action') {
        const step = snapshot.step;
        if (
          step === null ||
          step.stepId !== input.check.step_id ||
          step.actionHash !== input.check.action_hash ||
          !['pending', 'running'].includes(step.status)
        ) {
          return rejected('dispatch_mismatch');
        }
      }
      if (
        input.check.kind === 'cursor' &&
        snapshot.maxCompletedSequence !== input.check.resume_after_sequence
      ) {
        return rejected('dispatch_mismatch');
      }

      return {
        accepted: true,
        checkedAt: now.toISOString(),
        currentGeneration: job.killSwitchGeneration,
        fullAccessGrantCurrent: job.approvalPolicy === 'full-access' && snapshot.fullAccessAllowed,
      };
    },
  };
}

async function loadPostgresAuthoritySnapshot(
  db: Database,
  input: AutomationBrowserAuthorityCheckInput,
): Promise<BrowserAuthoritySnapshot> {
  const [job] = await db
    .select({
      accountId: automationJobs.accountId,
      projectId: automationJobs.projectId,
      jobId: automationJobs.jobId,
      executionDomain: automationJobs.executionDomain,
      requestHash: automationJobs.requestHash,
      status: automationJobs.status,
      leaseOwner: automationJobs.leaseOwner,
      leaseExpiresAt: automationJobs.leaseExpiresAt,
      deadlineAt: automationJobs.deadlineAt,
      killSwitchGeneration: automationJobs.killSwitchGeneration,
      cancelRequestedAt: automationJobs.cancelRequestedAt,
      approvalPolicy: automationJobs.approvalPolicy,
      fullAccessAllowed: automationPolicies.fullAccessAllowed,
    })
    .from(automationJobs)
    .leftJoin(automationPolicies, eq(automationPolicies.projectId, automationJobs.projectId))
    .where(
      and(
        eq(automationJobs.accountId, input.account_id),
        eq(automationJobs.projectId, input.project_id),
        eq(automationJobs.jobId, input.job_id),
      ),
    )
    .limit(1);
  if (!job) {
    return { job: null, step: null, maxCompletedSequence: null, fullAccessAllowed: false };
  }

  const [step] =
    input.check.kind === 'action'
      ? await db
          .select({
            stepId: automationJobSteps.stepId,
            sequence: automationJobSteps.sequence,
            actionHash: automationJobSteps.actionHash,
            status: automationJobSteps.status,
          })
          .from(automationJobSteps)
          .where(
            and(
              eq(automationJobSteps.jobId, input.job_id),
              eq(automationJobSteps.stepId, input.check.step_id),
            ),
          )
          .limit(1)
      : [];
  const [cursor] = await db
    .select({ maxCompletedSequence: max(automationJobSteps.sequence) })
    .from(automationJobSteps)
    .where(
      and(eq(automationJobSteps.jobId, input.job_id), eq(automationJobSteps.status, 'succeeded')),
    );

  return {
    job: {
      accountId: job.accountId,
      projectId: job.projectId,
      jobId: job.jobId,
      executionDomain: job.executionDomain,
      requestHash: job.requestHash,
      status: job.status,
      leaseOwner: job.leaseOwner,
      leaseExpiresAt: job.leaseExpiresAt,
      deadlineAt: job.deadlineAt,
      killSwitchGeneration: job.killSwitchGeneration,
      cancelRequestedAt: job.cancelRequestedAt,
      approvalPolicy: job.approvalPolicy,
    },
    step: step ?? null,
    maxCompletedSequence: cursor?.maxCompletedSequence ?? null,
    fullAccessAllowed: job.fullAccessAllowed ?? false,
  };
}

export function createPostgresBrowserAuthorityStore(db: Database): BrowserAuthorityStore {
  return createBrowserAuthorityStore(async (input) => loadPostgresAuthoritySnapshot(db, input));
}
