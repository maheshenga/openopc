import { describe, expect, test } from 'bun:test';
import {
  InMemoryStudioObjectStore,
  studioStagingPrefix,
  studioSubmissionKeyHash,
} from '@kortix/studio-runtime';
import {
  StudioMaintenanceCoordinator,
  createMemoryStudioMaintenanceRepository,
} from './maintenance';

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
    await expect(oldStore.headObject({ key: siblingKey })).resolves.toMatchObject({
      key: siblingKey,
    });
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

  test('defaults orphan retention to seven days and rejects retention beyond thirty days', async () => {
    const now = new Date('2026-07-15T10:00:00.000Z');
    const retentionInputs: Date[] = [];
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async listOrphanStagingCandidates(input: { retentionBefore: Date }) {
        retentionInputs.push(input.retentionBefore);
        return [];
      },
    };
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => now,
      objectStore: store,
    });

    await coordinator.runOnce();

    expect(retentionInputs).toEqual([new Date('2026-07-08T10:00:00.000Z')]);
    expect(
      () =>
        new StudioMaintenanceCoordinator({
          repository,
          ownerId: 'studio-owner',
          lockKey: 'studio-maintenance',
          ttlMs: 60_000,
          objectStore: store,
          orphanRetentionMs: 30 * 24 * 60 * 60_000 + 1,
        }),
    ).toThrow(/retention.*30 days/i);
  });

  test('resumes an object cursor across runs when the global object budget is exhausted', async () => {
    const candidate = orphanCandidate('1');
    const prefix = orphanPrefix(candidate);
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    const firstKey = `${prefix}assets/a.png`;
    const secondKey = `${prefix}assets/b.png`;
    const thirdKey = `${prefix}assets/c.png`;
    const keys = [firstKey, secondKey, thirdKey];
    await seedObjects(store, keys);
    const listCursors: Array<string | null> = [];
    const listObjects = store.listObjects.bind(store);
    store.listObjects = async (input) => {
      listCursors.push(input.cursor ?? null);
      return listObjects(input);
    };
    let candidateLists = 0;
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async listOrphanStagingCandidates(input: { after?: unknown }) {
        candidateLists += 1;
        return input.after ? [] : [candidate];
      },
      async isOrphanStagingCandidate() {
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
      orphanCandidatePageLimit: 10,
      orphanObjectPageLimit: 10,
      orphanCandidateBudget: 10,
      orphanPageBudget: 10,
      orphanObjectBudget: 1,
    } as never);

    await coordinator.runOnce();
    await expect(store.headObject({ key: firstKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.headObject({ key: secondKey })).resolves.toMatchObject({ key: secondKey });
    await coordinator.runOnce();
    await expect(store.headObject({ key: secondKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await coordinator.runOnce();
    await expect(store.headObject({ key: thirdKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(candidateLists).toBe(1);
    expect(listCursors).toEqual([null, keys[0], keys[1]]);
  });

  test('rotates keyset candidates across runs and wraps only after reaching the end', async () => {
    const firstCandidate = orphanCandidate('1');
    const secondCandidate = orphanCandidate('2');
    const candidates = [firstCandidate, secondCandidate];
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    const firstKey = `${orphanPrefix(firstCandidate)}assets/result.png`;
    const secondKey = `${orphanPrefix(secondCandidate)}assets/result.png`;
    const keys = [firstKey, secondKey];
    await seedObjects(store, keys);
    const afterAttempts: Array<string | null> = [];
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async listOrphanStagingCandidates(input: {
        after?: { terminalAt: Date; attemptId: string };
        limit: number;
      }) {
        afterAttempts.push(input.after?.attemptId ?? null);
        const start = input.after
          ? candidates.findIndex((candidate) => candidate.attemptId === input.after?.attemptId) + 1
          : 0;
        return candidates.slice(start, start + input.limit);
      },
      async isOrphanStagingCandidate() {
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
      orphanCandidatePageLimit: 1,
      orphanObjectPageLimit: 10,
      orphanCandidateBudget: 1,
      orphanPageBudget: 10,
      orphanObjectBudget: 10,
    } as never);

    await coordinator.runOnce();
    await expect(store.headObject({ key: firstKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.headObject({ key: secondKey })).resolves.toMatchObject({ key: secondKey });
    await coordinator.runOnce();
    await expect(store.headObject({ key: secondKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await coordinator.runOnce();
    await coordinator.runOnce();

    expect(afterAttempts).toEqual([
      null,
      firstCandidate.attemptId,
      secondCandidate.attemptId,
      null,
    ]);
  });

  test('deletes only objects whose head confirms the required SSE and KMS key', async () => {
    const candidate = orphanCandidate('kms');
    const prefix = orphanPrefix(candidate);
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    const keys = {
      wrongSse: `${prefix}assets/wrong-sse.png`,
      wrongKms: `${prefix}assets/wrong-kms.png`,
      valid: `${prefix}assets/valid.png`,
    };
    await seedObjects(store, Object.values(keys));
    Object.defineProperty(store, 'required_server_side_encryption', { value: 'aws:kms' });
    Object.defineProperty(store, 'required_sse_kms_key_id', { value: 'kms-production' });
    const headObject = store.headObject.bind(store);
    store.headObject = async (input) => {
      const head = await headObject(input);
      if (input.key === keys.wrongSse) {
        return { ...head, server_side_encryption: 'AES256', sse_kms_key_id: null };
      }
      return {
        ...head,
        server_side_encryption: 'aws:kms',
        sse_kms_key_id: input.key === keys.valid ? 'kms-production' : 'kms-other',
      };
    };
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async listOrphanStagingCandidates() {
        return [candidate];
      },
      async isOrphanStagingCandidate() {
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
    });

    await coordinator.runOnce();

    await expect(headObject({ key: keys.wrongSse })).resolves.toMatchObject({ key: keys.wrongSse });
    await expect(headObject({ key: keys.wrongKms })).resolves.toMatchObject({ key: keys.wrongKms });
    await expect(headObject({ key: keys.valid })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('treats object-store cursors as opaque tokens across multiple pages', async () => {
    const candidate = orphanCandidate('opaque');
    const prefix = orphanPrefix(candidate);
    const firstKey = `${prefix}assets/a.png`;
    const secondKey = `${prefix}assets/b.png`;
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    await seedObjects(store, [firstKey, secondKey]);
    const cursors: Array<string | null> = [];
    const listObjects = store.listObjects.bind(store);
    store.listObjects = async (input) => {
      cursors.push(input.cursor ?? null);
      if (!input.cursor) {
        const page = await listObjects({ prefix: input.prefix, limit: 1 });
        return { ...page, next_cursor: 'next-page-token' };
      }
      if (input.cursor !== 'next-page-token') throw new Error('unexpected opaque cursor');
      return listObjects({ prefix: input.prefix, cursor: firstKey, limit: input.limit });
    };
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async listOrphanStagingCandidates() {
        return [candidate];
      },
      async isOrphanStagingCandidate() {
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
      orphanObjectPageLimit: 1,
      orphanPageBudget: 2,
      orphanObjectBudget: 2,
    } as never);

    await coordinator.runOnce();

    expect(cursors).toEqual([null, 'next-page-token']);
    await expect(store.headObject({ key: firstKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.headObject({ key: secondKey })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('stops after a slow page loses the maintenance lease and resumes on a later run', async () => {
    const candidate = orphanCandidate('lease');
    const prefix = orphanPrefix(candidate);
    const key = `${prefix}assets/result.png`;
    let clock = new Date('2026-07-15T10:00:00.000Z');
    let leaseLost = false;
    let loseLeaseDuringPage = true;
    const leaseTimes: Date[] = [];
    let fenceChecks = 0;
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    await seedObjects(store, [key]);
    const listObjects = store.listObjects.bind(store);
    store.listObjects = async (input) => {
      const page = await listObjects(input);
      if (loseLeaseDuringPage) {
        loseLeaseDuringPage = false;
        clock = new Date(clock.getTime() + 1_001);
        leaseLost = true;
      }
      return page;
    };
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async acquireOrRenewLease(input: { now: Date }) {
        leaseTimes.push(new Date(input.now));
        return !leaseLost;
      },
      async listOrphanStagingCandidates() {
        return [candidate];
      },
      async isOrphanStagingCandidate() {
        fenceChecks += 1;
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 1_000,
      now: () => new Date(clock),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
    });

    await coordinator.runOnce();

    expect(leaseTimes.length).toBeGreaterThan(1);
    expect(leaseTimes.at(-1)).toEqual(new Date('2026-07-15T10:00:01.001Z'));
    expect(fenceChecks).toBe(0);
    await expect(store.headObject({ key })).resolves.toMatchObject({ key });

    leaseLost = false;
    await coordinator.runOnce();
    await expect(store.headObject({ key })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('stops before the database fence when a slow object head loses the lease', async () => {
    const candidate = orphanCandidate('slow-head');
    const key = `${orphanPrefix(candidate)}assets/result.png`;
    let clock = new Date('2026-07-15T10:00:00.000Z');
    let leaseLost = false;
    let fenceChecks = 0;
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    await seedObjects(store, [key]);
    const headObject = store.headObject.bind(store);
    store.headObject = async (input) => {
      const head = await headObject(input);
      clock = new Date(clock.getTime() + 1_001);
      leaseLost = true;
      return head;
    };
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async acquireOrRenewLease() {
        return !leaseLost;
      },
      async listOrphanStagingCandidates() {
        return [candidate];
      },
      async isOrphanStagingCandidate() {
        fenceChecks += 1;
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 1_000,
      now: () => new Date(clock),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
    });

    await coordinator.runOnce();

    expect(fenceChecks).toBe(0);
    await expect(headObject({ key })).resolves.toMatchObject({ key });
  });

  test('stops before object deletion when a slow database fence loses the lease', async () => {
    const candidate = orphanCandidate('slow-fence');
    const key = `${orphanPrefix(candidate)}assets/result.png`;
    let clock = new Date('2026-07-15T10:00:00.000Z');
    let leaseLost = false;
    let deleteCalls = 0;
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    await seedObjects(store, [key]);
    const headObject = store.headObject.bind(store);
    const deleteObject = store.deleteObject.bind(store);
    store.deleteObject = async (input) => {
      deleteCalls += 1;
      return deleteObject(input);
    };
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async acquireOrRenewLease() {
        return !leaseLost;
      },
      async listOrphanStagingCandidates() {
        return [candidate];
      },
      async isOrphanStagingCandidate() {
        clock = new Date(clock.getTime() + 1_001);
        leaseLost = true;
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 1_000,
      now: () => new Date(clock),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
    });

    await coordinator.runOnce();

    expect(deleteCalls).toBe(0);
    await expect(headObject({ key })).resolves.toMatchObject({ key });
  });

  test('revalidates the lease after a slow delete even when the object budget is exhausted', async () => {
    const candidate = orphanCandidate('slow-delete');
    const key = `${orphanPrefix(candidate)}assets/result.png`;
    let clock = new Date('2026-07-15T10:00:00.000Z');
    let leaseLost = false;
    const leaseTimes: Date[] = [];
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    await seedObjects(store, [key]);
    const headObject = store.headObject.bind(store);
    const deleteObject = store.deleteObject.bind(store);
    store.deleteObject = async (input) => {
      await deleteObject(input);
      clock = new Date(clock.getTime() + 1_001);
      leaseLost = true;
    };
    const repository = {
      ...createMemoryStudioMaintenanceRepository(),
      async acquireOrRenewLease(input: { now: Date }) {
        leaseTimes.push(new Date(input.now));
        return !leaseLost;
      },
      async listOrphanStagingCandidates() {
        return [candidate];
      },
      async isOrphanStagingCandidate() {
        return true;
      },
    };
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 1_000,
      now: () => new Date(clock),
      objectStore: store,
      orphanRetentionMs: 7 * 24 * 60 * 60_000,
      orphanObjectBudget: 1,
    });

    await coordinator.runOnce();

    expect(leaseTimes.at(-1)).toEqual(new Date('2026-07-15T10:00:01.001Z'));
    await expect(headObject({ key })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

function orphanCandidate(suffix: string) {
  return {
    accountId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    jobId: `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`,
    attemptId: `44444444-4444-4444-8444-${suffix.padStart(12, '0')}`,
    submissionKey: `submission-orphan-${suffix}`,
    terminalAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

function orphanPrefix(candidate: ReturnType<typeof orphanCandidate>): string {
  return studioStagingPrefix({
    ...candidate,
    submissionKeyHash: studioSubmissionKeyHash(candidate.submissionKey),
  });
}

async function seedObjects(store: InMemoryStudioObjectStore, keys: string[]): Promise<void> {
  const bytes = new Uint8Array([1, 2, 3]);
  const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  for (const key of keys) {
    await store.putObject({
      key,
      body: new Blob([bytes]).stream(),
      content_type: 'image/png',
      size_bytes: bytes.byteLength,
      checksum_sha256: checksum,
      metadata: {},
    });
  }
}
