import type {
  AutomationBrowserDispatchReceipt,
  AutomationJob,
  AutomationLease,
} from '@kortix/intelligence-contracts';
import type { LeaseManager } from '../lease-manager';
import type {
  BrowserApprovalResumeObservation,
  BrowserApprovalResumeStore,
  IssuedBrowserApprovalResume,
} from './browser-approval-resume-store';
import type { BrowserWorkerConnection } from './browser-dispatcher';

export type BrowserApprovalResumeCoordinatorStats = Readonly<{
  candidates: number;
  claimed: number;
  issued: number;
  dispatched: number;
  failed: number;
  skipped: number;
}>;

export type BrowserApprovalResumeCoordinator = Readonly<{
  runOnce(options?: { signal?: AbortSignal }): Promise<BrowserApprovalResumeCoordinatorStats>;
}>;

type BrowserApprovalResumeDispatcher = Readonly<{
  dispatchResume(raw: {
    job: AutomationJob;
    lease: AutomationLease;
    connection: BrowserWorkerConnection;
    resumeAfterSequence: number;
    approval: IssuedBrowserApprovalResume;
  }): Promise<AutomationBrowserDispatchReceipt>;
}>;

export function createBrowserApprovalResumeCoordinator(input: {
  store: Pick<BrowserApprovalResumeStore, 'listCandidates' | 'issue'>;
  leaseManager: Pick<LeaseManager, 'claim' | 'release'>;
  dispatcher: BrowserApprovalResumeDispatcher;
  connection: BrowserWorkerConnection;
  owner: string;
  leaseMs: number;
  maxClaimsPerRun: number;
  now?: () => Date;
  observe?: (event: BrowserApprovalResumeObservation) => void;
}): BrowserApprovalResumeCoordinator {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input.owner)) {
    throw new Error('browser approval resume owner is invalid');
  }
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 300_000) {
    throw new Error('browser approval resume lease duration is invalid');
  }
  if (
    !Number.isSafeInteger(input.maxClaimsPerRun) ||
    input.maxClaimsPerRun < 1 ||
    input.maxClaimsPerRun > 100
  ) {
    throw new Error('browser approval resume claim limit is invalid');
  }
  const now = input.now ?? (() => new Date());
  const emptyStats = (): {
    candidates: number;
    claimed: number;
    issued: number;
    dispatched: number;
    failed: number;
    skipped: number;
  } => ({ candidates: 0, claimed: 0, issued: 0, dispatched: 0, failed: 0, skipped: 0 });

  return Object.freeze({
    async runOnce(options = {}) {
      const stats = emptyStats();
      if (options.signal?.aborted) return stats;
      const candidates = await input.store.listCandidates({
        now: now(),
        limit: input.maxClaimsPerRun,
      });
      const boundedCandidates = candidates.slice(0, input.maxClaimsPerRun);
      stats.candidates = boundedCandidates.length;

      for (const candidate of boundedCandidates) {
        if (options.signal?.aborted) break;
        const lease = await input.leaseManager.claim(
          candidate.job.job_id,
          input.owner,
          now(),
          input.leaseMs,
          null,
        );
        if (lease === null) {
          stats.skipped += 1;
          continue;
        }
        stats.claimed += 1;
        if (options.signal?.aborted) {
          await input.leaseManager.release(candidate.job.job_id, lease.owner, now());
          break;
        }

        let issued: IssuedBrowserApprovalResume | null;
        try {
          issued = await input.store.issue({ candidate, lease, now: now() });
        } catch {
          stats.failed += 1;
          await input.leaseManager
            .release(candidate.job.job_id, lease.owner, now())
            .catch(() => undefined);
          continue;
        }
        if (issued === null) {
          stats.skipped += 1;
          await input.leaseManager
            .release(candidate.job.job_id, lease.owner, now())
            .catch(() => undefined);
          continue;
        }
        stats.issued += 1;

        try {
          await input.dispatcher.dispatchResume({
            job: candidate.job,
            lease,
            connection: input.connection,
            resumeAfterSequence: candidate.resumeAfterSequence,
            approval: issued,
          });
          stats.dispatched += 1;
          try {
            input.observe?.({
              type: 'browser_resume_dispatched',
              jobId: issued.jobId,
              stepId: issued.stepId,
              approvalId: issued.approvalId,
              attemptId: issued.attemptId,
              traceId: candidate.job.request.traceparent?.split('-')[1] ?? null,
              occurredAt: now().toISOString(),
            });
          } catch {
            // Diagnostics cannot alter dispatch or lease-fencing behavior.
          }
        } catch {
          stats.failed += 1;
        }
      }
      return stats;
    },
  });
}
