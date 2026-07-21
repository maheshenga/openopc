import { describe, expect, test } from 'bun:test';
import { createMemoryLeaseManager } from './lease-manager';

const JOB_ID = '40000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-22T00:00:00.000Z');

describe('automation fencing leases', () => {
  test('claims a queued job and recognizes the current owner before expiry', async () => {
    const manager = createMemoryLeaseManager({
      sharedSecret: 'test-shared-secret-that-is-at-least-32-bytes',
      jobs: [
        {
          jobId: JOB_ID,
          projectId: PROJECT_ID,
          executionDomain: 'browser',
          requestHash: `sha256:${'a'.repeat(64)}`,
          killSwitchGeneration: 0,
          status: 'queued',
        },
      ],
    });

    const lease = await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000);

    expect(lease).toMatchObject({
      job_id: JOB_ID,
      project_id: PROJECT_ID,
      owner: 'browser-worker-1',
      execution_domain: 'browser',
    });
    expect(await manager.isCurrent(JOB_ID, 'browser-worker-1', NOW)).toBeTrue();
  });

  test('heartbeats only the current unexpired owner and extends its lease', async () => {
    const manager = createMemoryLeaseManager({
      sharedSecret: 'test-shared-secret-that-is-at-least-32-bytes',
      jobs: [
        {
          jobId: JOB_ID,
          projectId: PROJECT_ID,
          executionDomain: 'browser',
          requestHash: `sha256:${'a'.repeat(64)}`,
          killSwitchGeneration: 0,
          status: 'queued',
        },
      ],
    });
    await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000);
    const heartbeatAt = new Date(NOW.getTime() + 10_000);

    expect(await manager.heartbeat(JOB_ID, 'stale-worker', heartbeatAt, 30_000)).toBeFalse();
    expect(await manager.heartbeat(JOB_ID, 'browser-worker-1', heartbeatAt, 30_000)).toBeTrue();
    expect(
      await manager.isCurrent(JOB_ID, 'browser-worker-1', new Date(NOW.getTime() + 35_000)),
    ).toBeTrue();
  });

  test('releases only the current owner without letting a stale worker clear the lease', async () => {
    const manager = createMemoryLeaseManager({
      sharedSecret: 'test-shared-secret-that-is-at-least-32-bytes',
      jobs: [
        {
          jobId: JOB_ID,
          projectId: PROJECT_ID,
          executionDomain: 'browser',
          requestHash: `sha256:${'a'.repeat(64)}`,
          killSwitchGeneration: 0,
          status: 'queued',
        },
      ],
    });
    await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000);
    const releaseAt = new Date(NOW.getTime() + 1_000);

    await manager.release(JOB_ID, 'stale-worker', releaseAt);
    expect(await manager.isCurrent(JOB_ID, 'browser-worker-1', releaseAt)).toBeTrue();

    await manager.release(JOB_ID, 'browser-worker-1', releaseAt);
    expect(await manager.isCurrent(JOB_ID, 'browser-worker-1', releaseAt)).toBeFalse();
  });

  test('does not bypass explicit retry approval by claiming a retryable job', async () => {
    const manager = createMemoryLeaseManager({
      sharedSecret: 'test-shared-secret-that-is-at-least-32-bytes',
      jobs: [
        {
          jobId: JOB_ID,
          projectId: PROJECT_ID,
          executionDomain: 'browser',
          requestHash: `sha256:${'a'.repeat(64)}`,
          killSwitchGeneration: 0,
          status: 'retryable',
        },
      ],
    });

    expect(await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000)).toBeNull();
  });
});
