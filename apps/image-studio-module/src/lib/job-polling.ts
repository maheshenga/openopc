import type { OpenOpcImageJob } from '@openopc/developer-sdk';

export const ACTIVE_JOB_REFRESH_MS = 5_000;
export const EVENT_REFRESH_MS = 10_000;
export const JOB_CACHE_TTL_MS = 4_000;
export const MAX_POLL_BACKOFF_MS = 20_000;

interface CachedImageJob {
  job: OpenOpcImageJob;
  readAt: number;
}

const jobSnapshots = new Map<string, CachedImageJob>();
const jobReads = new Map<string, Promise<OpenOpcImageJob>>();
const eventReadTimes = new Map<string, number>();

export function pollBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, Math.floor(failureCount));
  return Math.min(1_000 * 2 ** exponent, MAX_POLL_BACKOFF_MS);
}

export function shouldReadEvents(
  lastReadAt: number | null,
  now: number,
  terminal: boolean,
): boolean {
  return terminal || lastReadAt === null || now - lastReadAt >= EVENT_REFRESH_MS;
}

export function shouldAutoRefreshJobs(
  jobsWorkspaceActive: boolean,
  hasActiveJobs: boolean,
  visibilityState: DocumentVisibilityState,
): boolean {
  return jobsWorkspaceActive && hasActiveJobs && visibilityState === 'visible';
}

export function markJobEventsRead(jobId: string, now: number): void {
  eventReadTimes.set(jobId, now);
}

export function rememberImageJobSnapshots(jobs: readonly OpenOpcImageJob[], now: number): void {
  jobs.forEach((job) => jobSnapshots.set(job.job_id, { job, readAt: now }));
}

export function shouldReadJobEvents(jobId: string, now: number, terminal: boolean): boolean {
  return shouldReadEvents(eventReadTimes.get(jobId) ?? null, now, terminal);
}

export function resetImageJobPollStateForTest(): void {
  jobSnapshots.clear();
  jobReads.clear();
  eventReadTimes.clear();
}

export function readImageJobSnapshot(
  jobId: string,
  load: () => Promise<OpenOpcImageJob>,
  now: number = Date.now(),
): Promise<OpenOpcImageJob> {
  const cached = jobSnapshots.get(jobId);
  if (cached && now - cached.readAt < JOB_CACHE_TTL_MS) return Promise.resolve(cached.job);
  const pending = jobReads.get(jobId);
  if (pending) return pending;

  const request = load()
    .then((job) => {
      jobSnapshots.set(jobId, { job, readAt: now });
      return job;
    })
    .finally(() => {
      if (jobReads.get(jobId) === request) jobReads.delete(jobId);
    });
  jobReads.set(jobId, request);
  return request;
}
