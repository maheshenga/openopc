import { describe, expect, test } from 'bun:test';
import {
  StudioMaintenanceCoordinator,
  createMemoryStudioMaintenanceRepository,
} from './maintenance';
import {
  InMemoryStudioObjectStore,
  studioStagingPrefix,
  studioSubmissionKeyHash,
} from '@kortix/studio-runtime';

describe('Studio maintenance lease', () => {
  test('uses its own parameterized lease and never mutates the API background-worker owner', async () => {
    const repository = createMemoryStudioMaintenanceRepository();
    repository.seedLease('background-workers', 'api-owner', new Date('2026-07-15T10:05:00.000Z'));
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    const result = await coordinator.runOnce();

    expect(result).toEqual({ acquired: true, tasksRun: 5 });
    expect(repository.getLease('studio-maintenance')?.ownerId).toBe('studio-owner');
    expect(repository.getLease('background-workers')?.ownerId).toBe('api-owner');
    expect(repository.calls).toEqual([
      'requeueExpiredJobLeases',
      'failStuckUnknownOutcomes',
      'compactProgressEvents',
      'expireUploads',
      'reconcileCreditReservations',
    ]);
  });

  test('a live peer lease skips maintenance work', async () => {
    const repository = createMemoryStudioMaintenanceRepository();
    repository.seedLease('studio-maintenance', 'peer', new Date('2026-07-15T10:05:00.000Z'));
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(await coordinator.runOnce()).toEqual({ acquired: false, tasksRun: 0 });
    expect(repository.calls).toEqual([]);
  });

  test('conditionally deletes only retained orphan objects after a second database fence', async () => {
    const repository = createMemoryStudioMaintenanceRepository();
    const candidate = {
      accountId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      jobId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      submissionKey: 'submission-orphan-1',
      terminalAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const prefix = studioStagingPrefix({
      ...candidate,
      submissionKeyHash: studioSubmissionKeyHash(candidate.submissionKey),
    });
    const oldStore = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    const oldKeys = [`${prefix}assets/old-a.png`, `${prefix}assets/old-b.png`];
    const siblingKey = `${prefix.slice(0, -1)}-other/keep.png`;
    const bytes = new Uint8Array([1, 2, 3]);
    const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    for (const key of [...oldKeys, siblingKey]) {
      await oldStore.putObject({
        key,
        body: new Blob([bytes]).stream(),
        content_type: 'image/png',
        size_bytes: bytes.byteLength,
        checksum_sha256: checksum,
        metadata: {},
      });
    }
    let fenceChecks = 0;
    const fencedRepository = {
      ...repository,
      listOrphanStagingCandidates: async () => [candidate],
      isOrphanStagingCandidate: async () => {
        fenceChecks += 1;
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository: fencedRepository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
      objectStore: oldStore,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
      orphanPageLimit: 1,
    } as never);

    expect(await coordinator.runOnce()).toEqual({ acquired: true, tasksRun: 6 });
    expect(fenceChecks).toBe(2);
    for (const key of oldKeys) {
      await expect(oldStore.headObject({ key })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(oldStore.headObject({ key: siblingKey })).resolves.toMatchObject({ key: siblingKey });
  });

  test('retains recent objects and objects whose terminal database fence changed', async () => {
    const repository = createMemoryStudioMaintenanceRepository();
    const candidate = {
      accountId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      jobId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      submissionKey: 'submission-orphan-2',
      terminalAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const prefix = studioStagingPrefix({
      ...candidate,
      submissionKeyHash: studioSubmissionKeyHash(candidate.submissionKey),
    });
    let storedAt = new Date('2026-06-01T10:00:00.000Z');
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => storedAt,
    });
    const oldKey = `${prefix}assets/old-fence.png`;
    const recentKey = `${prefix}assets/recent.png`;
    const bytes = new Uint8Array([1, 2, 3]);
    await store.putObject({
      key: oldKey,
      body: new Blob([bytes]).stream(),
      content_type: 'image/png',
      size_bytes: bytes.byteLength,
      checksum_sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
      metadata: {},
    });
    storedAt = new Date('2026-07-14T10:00:00.000Z');
    await store.putObject({
      key: recentKey,
      body: new Blob([bytes]).stream(),
      content_type: 'image/png',
      size_bytes: bytes.byteLength,
      checksum_sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
      metadata: {},
    });
    let fenceChecks = 0;
    const coordinator = new StudioMaintenanceCoordinator({
      repository: {
        ...repository,
        listOrphanStagingCandidates: async () => [candidate],
        isOrphanStagingCandidate: async () => {
          fenceChecks += 1;
          return false;
        },
      },
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
    } as never);

    await coordinator.runOnce();
    expect(fenceChecks).toBe(1);
    await expect(store.headObject({ key: oldKey })).resolves.toMatchObject({ key: oldKey });
    await expect(store.headObject({ key: recentKey })).resolves.toMatchObject({ key: recentKey });
  });
});
