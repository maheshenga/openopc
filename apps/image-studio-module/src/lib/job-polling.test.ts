import { describe, expect, test } from 'bun:test';
import type { OpenOpcImageJob } from '@openopc/developer-sdk';
import {
  ACTIVE_JOB_REFRESH_MS,
  EVENT_REFRESH_MS,
  JOB_CACHE_TTL_MS,
  MAX_POLL_BACKOFF_MS,
  markJobEventsRead,
  pollBackoffMs,
  rememberImageJobSnapshots,
  readImageJobSnapshot,
  resetImageJobPollStateForTest,
  shouldAutoRefreshJobs,
  shouldReadEvents,
  shouldReadJobEvents,
} from './job-polling';

function job(status: OpenOpcImageJob['status'] = 'running'): OpenOpcImageJob {
  return {
    job_id: '00000000-0000-4000-8000-000000000001',
    model: 'openopc-image-v1',
    input: {
      prompt: 'A quiet workspace',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    },
    status,
    attempt_count: 0,
    reserved_credits: 2,
    actual_credits: null,
    error_code: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:01.000Z',
    started_at: '2026-08-12T00:00:01.000Z',
    completed_at: null,
    cancellable: status === 'queued' || status === 'running',
  };
}

describe('job polling policy', () => {
  test('backs off exponentially and caps transient retries at twenty seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(pollBackoffMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      20_000,
      20_000,
    ]);
    expect(ACTIVE_JOB_REFRESH_MS).toBe(5_000);
    expect(EVENT_REFRESH_MS).toBe(10_000);
    expect(JOB_CACHE_TTL_MS).toBe(4_000);
    expect(MAX_POLL_BACKOFF_MS).toBe(20_000);
  });

  test('reads events on first observation, after ten seconds, or at a terminal transition', () => {
    expect(shouldReadEvents(null, 1_000, false)).toBe(true);
    expect(shouldReadEvents(1_000, 10_999, false)).toBe(false);
    expect(shouldReadEvents(1_000, 11_000, false)).toBe(true);
    expect(shouldReadEvents(10_999, 11_000, true)).toBe(true);
  });

  test('refreshes active jobs only while the jobs workspace is visible', () => {
    expect(shouldAutoRefreshJobs(true, true, 'visible')).toBe(true);
    expect(shouldAutoRefreshJobs(false, true, 'visible')).toBe(false);
    expect(shouldAutoRefreshJobs(true, false, 'visible')).toBe(false);
    expect(shouldAutoRefreshJobs(true, true, 'hidden')).toBe(false);
  });

  test('coalesces concurrent reads and reuses a fresh snapshot for four seconds', async () => {
    resetImageJobPollStateForTest();
    let calls = 0;
    let resolveLoad!: (value: OpenOpcImageJob) => void;
    const loader = () => {
      calls += 1;
      return new Promise<OpenOpcImageJob>((resolve) => {
        resolveLoad = resolve;
      });
    };

    const first = readImageJobSnapshot(job().job_id, loader, 1_000);
    const second = readImageJobSnapshot(job().job_id, loader, 1_000);
    expect(calls).toBe(1);
    resolveLoad(job());
    expect(await first).toEqual(job());
    expect(await second).toEqual(job());

    await expect(readImageJobSnapshot(job().job_id, loader, 4_999)).resolves.toEqual(job());
    expect(calls).toBe(1);
  });

  test('refreshes stale snapshots and reset clears cached and event state', async () => {
    resetImageJobPollStateForTest();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return job();
    };

    await readImageJobSnapshot(job().job_id, loader, 2_000);
    await readImageJobSnapshot(job().job_id, loader, 6_000);
    expect(calls).toBe(2);

    markJobEventsRead(job().job_id, 6_000);
    expect(shouldReadJobEvents(job().job_id, 10_000, false)).toBe(false);
    resetImageJobPollStateForTest();
    expect(shouldReadJobEvents(job().job_id, 10_000, false)).toBe(true);
    await readImageJobSnapshot(job().job_id, loader, 10_000);
    expect(calls).toBe(3);
  });

  test('uses a fresh jobs-list snapshot for a subsequent detail read', async () => {
    resetImageJobPollStateForTest();
    const listed = job('queued');
    let calls = 0;
    rememberImageJobSnapshots([listed], 4_000);

    await expect(
      readImageJobSnapshot(listed.job_id, async () => {
        calls += 1;
        return job('running');
      }, 7_999),
    ).resolves.toEqual(listed);
    expect(calls).toBe(0);
  });
});
