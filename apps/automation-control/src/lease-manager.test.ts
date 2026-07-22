import { describe, expect, test } from 'bun:test';
import {
  automationLeaseOwnerPrefix,
  createMemoryLeaseManager,
  verifyAutomationLeaseSignature,
} from './lease-manager';

const JOB_ID = '40000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const PERMISSION_ID = '80000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-22T00:00:00.000Z');

describe('automation fencing leases', () => {
  test('hashes long worker identities into a namespace no valid worker id can impersonate', () => {
    const sharedPrefix = `browser-worker-${'a'.repeat(100)}`;
    const first = automationLeaseOwnerPrefix(`${sharedPrefix}1`);
    const second = automationLeaseOwnerPrefix(`${sharedPrefix}2`);

    expect(first).toMatch(/^worker~sha256~[a-f0-9]{64}$/);
    expect(second).toMatch(/^worker~sha256~[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(91);
    expect(() => automationLeaseOwnerPrefix(first)).toThrow();
  });

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

    expect(lease).not.toBeNull();
    if (lease === null) throw new Error('expected a claimed lease');
    expect(lease).toMatchObject({
      job_id: JOB_ID,
      project_id: PROJECT_ID,
      execution_domain: 'browser',
    });
    expect(lease.owner).toBe(`browser-worker-1:${lease.lease_id}`);
    expect(await manager.isCurrent(JOB_ID, lease.owner, NOW)).toBeTrue();
  });

  test('verifies the signed lease and rejects authority tampering', async () => {
    const sharedSecret = 'test-shared-secret-that-is-at-least-32-bytes';
    const manager = createMemoryLeaseManager({
      sharedSecret,
      jobs: [
        {
          jobId: JOB_ID,
          projectId: PROJECT_ID,
          executionDomain: 'desktop',
          requestHash: `sha256:${'a'.repeat(64)}`,
          killSwitchGeneration: 7,
          status: 'queued',
        },
      ],
    });
    const lease = await manager.claim(JOB_ID, 'desktop-worker-1', NOW, 30_000, PERMISSION_ID);
    if (lease === null) throw new Error('expected a claimed lease');

    expect(verifyAutomationLeaseSignature(lease, sharedSecret)).toBeTrue();
    expect(
      verifyAutomationLeaseSignature(
        { ...lease, permission_id: '80000000-0000-4000-a000-000000000099' },
        sharedSecret,
      ),
    ).toBeFalse();
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
    const lease = await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000);
    if (lease === null) throw new Error('expected a claimed lease');
    const heartbeatAt = new Date(NOW.getTime() + 10_000);

    expect(await manager.heartbeat(JOB_ID, 'stale-worker', heartbeatAt, 30_000)).toBeFalse();
    expect(await manager.heartbeat(JOB_ID, lease.owner, heartbeatAt, 30_000)).toBeTrue();
    expect(
      await manager.isCurrent(JOB_ID, lease.owner, new Date(NOW.getTime() + 35_000)),
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
    const lease = await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000);
    if (lease === null) throw new Error('expected a claimed lease');
    const releaseAt = new Date(NOW.getTime() + 1_000);

    await manager.release(JOB_ID, 'stale-worker', releaseAt);
    expect(await manager.isCurrent(JOB_ID, lease.owner, releaseAt)).toBeTrue();

    await manager.release(JOB_ID, lease.owner, releaseAt);
    expect(await manager.isCurrent(JOB_ID, lease.owner, releaseAt)).toBeFalse();
  });

  test('fences a reclaimed lease when the same worker identity is reused', async () => {
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
    const first = await manager.claim(JOB_ID, 'browser-worker-1', NOW, 1_000);
    if (first === null) throw new Error('expected the first lease');
    const reclaimAt = new Date(NOW.getTime() + 1_001);
    const second = await manager.claim(JOB_ID, 'browser-worker-1', reclaimAt, 30_000);
    if (second === null) throw new Error('expected the replacement lease');

    expect(second.lease_id).not.toBe(first.lease_id);
    expect(second.owner).not.toBe(first.owner);
    expect(second.owner).toBe(`browser-worker-1:${second.lease_id}`);
    expect(await manager.heartbeat(JOB_ID, first.owner, reclaimAt, 30_000)).toBeFalse();
    expect(await manager.isCurrent(JOB_ID, first.owner, reclaimAt)).toBeFalse();
    expect(await manager.heartbeat(JOB_ID, second.owner, reclaimAt, 30_000)).toBeTrue();
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

  test('binds desktop claims to a supplied permission without mutating on invalid permission input', async () => {
    const manager = createMemoryLeaseManager({
      sharedSecret: 'test-shared-secret-that-is-at-least-32-bytes',
      jobs: [
        {
          jobId: JOB_ID,
          projectId: PROJECT_ID,
          executionDomain: 'desktop',
          requestHash: `sha256:${'a'.repeat(64)}`,
          killSwitchGeneration: 7,
          status: 'queued',
        },
      ],
    });

    await expect(manager.claim(JOB_ID, 'desktop-worker-1', NOW, 30_000)).rejects.toThrow(
      /permission/i,
    );
    await expect(
      manager.claim(JOB_ID, 'desktop-worker-1', NOW, 30_000, 'not-a-uuid'),
    ).rejects.toThrow(/permission/i);

    const lease = await manager.claim(JOB_ID, 'desktop-worker-1', NOW, 30_000, PERMISSION_ID);
    expect(lease).toMatchObject({
      execution_domain: 'desktop',
      permission_id: PERMISSION_ID,
    });
  });

  test('keeps browser claims permissionless and rejects a desktop permission before claim mutation', async () => {
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

    await expect(
      manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000, PERMISSION_ID),
    ).rejects.toThrow(/permission/i);
    const lease = await manager.claim(JOB_ID, 'browser-worker-1', NOW, 30_000);
    expect(lease?.permission_id).toBeNull();
  });
});
