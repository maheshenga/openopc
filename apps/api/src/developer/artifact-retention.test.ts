import { describe, expect, test } from 'bun:test';

import { createDeveloperArtifactRetentionWorker } from './artifact-retention';
import type {
  DeveloperArtifactCleanupCandidate,
  DeveloperArtifactRetentionRepository,
  DeveloperArtifactRetentionRun,
  DeveloperArtifactRetentionStore,
} from './artifact-retention-spec';

const RUN_ID = '70000000-0000-4000-a000-000000000007';
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '80000000-0000-4000-a000-000000000008';
const CLAIMED_AT = '2026-07-26T12:00:00.000Z';

function runningRun(
  overrides: Partial<DeveloperArtifactRetentionRun> = {},
): DeveloperArtifactRetentionRun {
  return {
    runId: RUN_ID,
    acceptanceRunId: null,
    state: 'running',
    attempts: 1,
    cursor: null,
    leaseOwner: 'api-retention-test',
    leaseExpiresAt: '2026-07-26T12:01:00.000Z',
    claimedAt: CLAIMED_AT,
    ...overrides,
  };
}

function config() {
  return {
    ownerId: 'api-retention-test',
    leaseMs: 60_000,
    uploadBatchSize: 1,
    objectBatchSize: 10,
    orphanGraceMs: 300_000,
    maxAttempts: 5,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
  };
}

function candidateFixture(
  overrides: Partial<DeveloperArtifactCleanupCandidate> = {},
): DeveloperArtifactCleanupCandidate {
  return {
    accountId: ACCOUNT_ID,
    uploadId: UPLOAD_ID,
    state: 'expired',
    storageKey: `developer-modules/staging/${'a'.repeat(64)}/${UPLOAD_ID}`,
    cleanupAttempts: 0,
    ...overrides,
  };
}

function repositoryFixture(
  overrides: Partial<DeveloperArtifactRetentionRepository> = {},
): DeveloperArtifactRetentionRepository {
  return {
    async enqueueRun() {
      throw new Error('test run is already claimed');
    },
    async getRunByAcceptanceRunId() {
      return null;
    },
    async claimRun() {
      return runningRun();
    },
    async renewRunLease() {
      return { valid: true, now: CLAIMED_AT };
    },
    async claimUploadCandidates() {
      return [];
    },
    async markUploadDeleted() {
      throw new Error('no upload candidates');
    },
    async recordUploadFailure() {
      return true;
    },
    async isStagingKeyReferenced() {
      return { leaseValid: true, referenced: false };
    },
    async rescheduleRun() {
      return true;
    },
    async completeRun() {
      return true;
    },
    async retryRun() {
      return true;
    },
    ...overrides,
  };
}

function storeFixture(
  overrides: Partial<DeveloperArtifactRetentionStore> = {},
): DeveloperArtifactRetentionStore {
  return {
    async head() {
      return null;
    },
    async delete() {},
    async listStaging() {
      return { objects: [], nextCursor: null };
    },
    ...overrides,
  };
}

describe('developer artifact retention worker', () => {
  test('claims one upload at a time and renews the lease before every destructive delete', async () => {
    const events: string[] = [];
    const storageKey = `developer-modules/staging/${'a'.repeat(64)}/${UPLOAD_ID}`;
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimRun() {
          events.push('claim-run');
          return runningRun();
        },
        async claimUploadCandidates(input) {
          events.push(`claim-uploads:${input.limit}`);
          return [candidateFixture({ cleanupAttempts: 1 })];
        },
        async renewRunLease(input) {
          events.push(`renew:${input.leaseMs}`);
          return { valid: true, now: CLAIMED_AT };
        },
        async markUploadDeleted() {
          events.push('mark-upload-deleted');
          return true;
        },
        async isStagingKeyReferenced() {
          throw new Error('orphan scan must wait for the next bounded tick');
        },
        async rescheduleRun(input) {
          events.push(`reschedule:${input.cursor ?? 'start'}:${input.delayMs}`);
          return true;
        },
        async completeRun() {
          throw new Error('a saturated upload batch cannot complete the run');
        },
      }),
      store: storeFixture({
        async head(key: string) {
          events.push(`head:${key}`);
          return { key, etag: 'upload-etag', lastModified: '2026-07-26T11:00:00.000Z' };
        },
        async delete(key: string, etag: string) {
          events.push(`delete:${key}:${etag}`);
        },
        async listStaging() {
          throw new Error('orphan scan must wait for the next bounded tick');
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: true,
      data: { kind: 'progress', runId: RUN_ID, uploadsDeleted: 1, orphanObjectsDeleted: 0 },
    });
    expect(events).toEqual([
      'claim-run',
      'claim-uploads:1',
      'renew:60000',
      `head:${storageKey}`,
      `delete:${storageKey}:upload-etag`,
      'mark-upload-deleted',
      'reschedule:start:0',
    ]);
  });

  test('loops single upload claims up to the configured batch size before yielding', async () => {
    const claims: number[] = [];
    let remaining = 2;
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 5 },
      repository: repositoryFixture({
        async claimUploadCandidates(input) {
          claims.push(input.limit);
          if (remaining === 0) return [];
          remaining -= 1;
          return [candidateFixture({ uploadId: UPLOAD_ID })];
        },
        async markUploadDeleted() {
          return true;
        },
      }),
      store: storeFixture({
        async head(key: string) {
          return { key, etag: 'etag', lastModified: '2026-07-26T11:00:00.000Z' };
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: true,
      data: { kind: 'completed', runId: RUN_ID, uploadsDeleted: 2, orphanObjectsDeleted: 0 },
    });
    expect(claims).toEqual([1, 1, 1]);
  });

  test('derives the orphan cutoff from database claim time instead of the API host clock', async () => {
    // A database clock far behind the host clock must keep every listed object immature.
    const stale = `developer-modules/staging/${'b'.repeat(64)}/${'9'.repeat(36)}`;
    let deleteCalled = false;
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async claimRun() {
          return runningRun({ claimedAt: '2020-01-01T00:00:00.000Z' });
        },
        async isStagingKeyReferenced() {
          throw new Error('immature objects must never be reference-checked');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return {
            objects: [{ key: stale, etag: 'etag', lastModified: '2026-07-26T11:00:00.000Z' }],
            nextCursor: null,
          };
        },
        async delete() {
          deleteCalled = true;
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: true,
      data: { kind: 'completed', runId: RUN_ID, uploadsDeleted: 0, orphanObjectsDeleted: 0 },
    });
    expect(deleteCalled).toBe(false);
  });

  test('deletes only mature unreferenced staging objects with their listed ETag', async () => {
    const oldOrphan = `developer-modules/staging/${'b'.repeat(64)}/${'9'.repeat(36)}`;
    const oldReferenced = `developer-modules/staging/${'c'.repeat(64)}/${'8'.repeat(36)}`;
    const recentOrphan = `developer-modules/staging/${'d'.repeat(64)}/${'7'.repeat(36)}`;
    const events: string[] = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async claimRun() {
          return runningRun({ cursor: 'opaque-cursor' });
        },
        async renewRunLease() {
          events.push('renew');
          return { valid: true, now: CLAIMED_AT };
        },
        async isStagingKeyReferenced(input) {
          events.push(`referenced:${input.storageKey}`);
          return { leaseValid: true, referenced: input.storageKey === oldReferenced };
        },
        async rescheduleRun() {
          throw new Error('the final object page must complete');
        },
        async completeRun() {
          events.push('complete');
          return true;
        },
      }),
      store: storeFixture({
        async head() {
          throw new Error('listed objects already carry the deletion ETag');
        },
        async delete(key: string, etag: string) {
          events.push(`delete:${key}:${etag}`);
        },
        async listStaging(input: { cursor: string | null; limit: number }) {
          events.push(`list:${input.cursor}:${input.limit}`);
          return {
            objects: [
              { key: oldOrphan, etag: 'orphan-etag', lastModified: '2026-07-26T11:00:00.000Z' },
              {
                key: oldReferenced,
                etag: 'referenced-etag',
                lastModified: '2026-07-26T11:00:00.000Z',
              },
              { key: recentOrphan, etag: 'recent-etag', lastModified: '2026-07-26T11:59:00.000Z' },
            ],
            nextCursor: null,
          };
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: true,
      data: { kind: 'completed', runId: RUN_ID, uploadsDeleted: 0, orphanObjectsDeleted: 1 },
    });
    expect(events).toEqual([
      'list:opaque-cursor:10',
      `referenced:${oldOrphan}`,
      'renew',
      `delete:${oldOrphan}:orphan-etag`,
      `referenced:${oldReferenced}`,
      'complete',
    ]);
  });

  test('never deletes an upload once the renewal reports the lease was fenced out', async () => {
    let deleteCalled = false;
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimUploadCandidates() {
          return [candidateFixture()];
        },
        async renewRunLease() {
          return { valid: false, now: CLAIMED_AT };
        },
        async retryRun() {
          throw new Error('a fenced-out run must not rewrite the owning worker state');
        },
      }),
      store: storeFixture({
        async head(key: string) {
          return { key, etag: 'etag', lastModified: '2026-07-26T11:00:00.000Z' };
        },
        async delete() {
          deleteCalled = true;
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
    });
    expect(deleteCalled).toBe(false);
  });

  test('never deletes an orphan once the renewal reports the lease was fenced out', async () => {
    const orphan = `developer-modules/staging/${'2'.repeat(64)}/${UPLOAD_ID}`;
    let deleteCalled = false;
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async renewRunLease() {
          return { valid: false, now: CLAIMED_AT };
        },
        async retryRun() {
          throw new Error('a fenced-out run must not rewrite the owning worker state');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return {
            objects: [{ key: orphan, etag: 'orphan-etag', lastModified: '2026-07-26T11:00:00.000Z' }],
            nextCursor: null,
          };
        },
        async delete() {
          deleteCalled = true;
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
    });
    expect(deleteCalled).toBe(false);
  });

  test('classifies a lease renewal exception as a recoverable repository failure', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimUploadCandidates() {
          return [candidateFixture()];
        },
        async renewRunLease() {
          throw new Error('database unavailable');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
    });
  });

  test('records object-store failure with bounded retry delays instead of throwing', async () => {
    const events: string[] = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimUploadCandidates() {
          return [candidateFixture({ cleanupAttempts: 2 })];
        },
        async markUploadDeleted() {
          throw new Error('must not mark a failed delete');
        },
        async recordUploadFailure(input) {
          events.push(`upload-failure:${input.errorCode}:${input.delayMs}`);
          return true;
        },
        async retryRun(input) {
          events.push(`run-retry:${input.errorCode}:${input.delayMs}:${input.terminal}`);
          return true;
        },
      }),
      store: storeFixture({
        async head(key: string) {
          return { key, etag: 'failed-etag', lastModified: '2026-07-26T11:00:00.000Z' };
        },
        async delete() {
          throw new Error('S3 unavailable');
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_OBJECT_STORE_FAILED', recoverable: true },
    });
    expect(events).toEqual([
      'upload-failure:RETENTION_OBJECT_STORE_FAILED:4000',
      'run-retry:RETENTION_OBJECT_STORE_FAILED:1000:false',
    ]);
  });

  test('marks the run terminally failed once the claimed attempt reaches the cap', async () => {
    const retries: string[] = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), maxAttempts: 3 },
      repository: repositoryFixture({
        async claimRun() {
          return runningRun({ attempts: 3 });
        },
        async claimUploadCandidates() {
          throw new Error('database unavailable');
        },
        async retryRun(input) {
          retries.push(`${input.delayMs}:${input.terminal}`);
          return true;
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: false },
    });
    expect(retries).toEqual(['4000:true']);
  });

  test('classifies a claim failure as a recoverable repository failure without a run', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimRun() {
          throw new Error('database unavailable');
        },
        async retryRun() {
          throw new Error('there is no claimed run to retry');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
    });
  });

  test('reports idle when no durable run is available', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimRun() {
          return null;
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({ success: true, data: { kind: 'idle' } });
  });

  test('classifies a failed upload marker as a repository failure without escaping the tick', async () => {
    const retryCodes: string[] = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimUploadCandidates() {
          return [candidateFixture()];
        },
        async markUploadDeleted() {
          throw new Error('database unavailable');
        },
        async retryRun(input) {
          retryCodes.push(input.errorCode);
          return true;
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
    });
    expect(retryCodes).toEqual(['RETENTION_REPOSITORY_FAILED']);
  });

  test('reports lease loss when the upload marker is fenced out by another owner', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimUploadCandidates() {
          return [candidateFixture()];
        },
        async markUploadDeleted() {
          return false;
        },
        async retryRun() {
          throw new Error('a fenced-out run must not rewrite the owning worker state');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
    });
  });

  test('classifies an orphan reference lookup failure as a repository failure', async () => {
    const orphan = `developer-modules/staging/${'1'.repeat(64)}/${UPLOAD_ID}`;
    let deleteCalled = false;
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async isStagingKeyReferenced() {
          throw new Error('database unavailable');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return {
            objects: [{ key: orphan, etag: 'orphan-etag', lastModified: '2026-07-26T11:00:00.000Z' }],
            nextCursor: null,
          };
        },
        async delete() {
          deleteCalled = true;
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
    });
    expect(deleteCalled).toBe(false);
  });

  test('never deletes an orphan after the database lease has expired', async () => {
    const orphan = `developer-modules/staging/${'2'.repeat(64)}/${UPLOAD_ID}`;
    const decisions: string[] = [];
    let deleteCalled = false;
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async isStagingKeyReferenced(input) {
          decisions.push(`${input.runId}:${input.ownerId}:${input.storageKey}`);
          return { leaseValid: false, referenced: false };
        },
        async retryRun() {
          throw new Error('a fenced-out run must not rewrite the owning worker state');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return {
            objects: [{ key: orphan, etag: 'orphan-etag', lastModified: '2026-07-26T11:00:00.000Z' }],
            nextCursor: null,
          };
        },
        async delete() {
          deleteCalled = true;
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
    });
    expect(decisions).toEqual([`${RUN_ID}:api-retention-test:${orphan}`]);
    expect(deleteCalled).toBe(false);
  });

  test('persists an opaque next cursor before reporting orphan-scan progress', async () => {
    const cursors: Array<string | null> = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async rescheduleRun(input) {
          cursors.push(input.cursor);
          return true;
        },
        async completeRun() {
          throw new Error('a non-final page cannot complete');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return { objects: [], nextCursor: 'opaque-next-cursor' };
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: true,
      data: { kind: 'progress', runId: RUN_ID, uploadsDeleted: 0, orphanObjectsDeleted: 0 },
    });
    expect(cursors).toEqual(['opaque-next-cursor']);
  });

  test('reports lease loss when cursor persistence is fenced out', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async rescheduleRun() {
          return false;
        },
        async retryRun() {
          throw new Error('a fenced-out run must not rewrite the owning worker state');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return { objects: [], nextCursor: 'opaque-next-cursor' };
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
    });
  });

  test('classifies a cursor persistence exception as a repository failure', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async rescheduleRun() {
          throw new Error('database unavailable');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return { objects: [], nextCursor: 'opaque-next-cursor' };
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
    });
  });

  test('classifies an object listing failure as a recoverable object-store failure', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture(),
      store: storeFixture({
        async listStaging() {
          throw new Error('S3 unavailable');
        },
      }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_OBJECT_STORE_FAILED', recoverable: true },
    });
  });

  test('classifies a completion write failure as a repository failure', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async completeRun() {
          throw new Error('database unavailable');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
    });
  });

  test('reports lease loss when completion is fenced out by another owner', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async completeRun() {
          return false;
        },
        async retryRun() {
          throw new Error('a fenced-out run must not rewrite the owning worker state');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
    });
  });

  test('rejects an invalid configuration without touching the database or object store', async () => {
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), leaseMs: 10 },
      repository: repositoryFixture({
        async claimRun() {
          throw new Error('an invalid configuration must never claim work');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      success: false,
      error: { code: 'RETENTION_CONFIG_INVALID', recoverable: false },
    });
  });
});

describe('developer artifact retention worker abort handling', () => {
  test('never claims work when the tick is aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = createDeveloperArtifactRetentionWorker({
      config: config(),
      repository: repositoryFixture({
        async claimRun() {
          throw new Error('an aborted tick must never claim work');
        },
      }),
      store: storeFixture(),
    });

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toEqual({
      success: true,
      data: { kind: 'idle' },
    });
  });

  test('completes the consistency marker for a delete already in flight, then stops', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 5 },
      repository: repositoryFixture({
        async claimUploadCandidates() {
          events.push('claim-uploads');
          return [candidateFixture()];
        },
        async markUploadDeleted() {
          events.push('mark-upload-deleted');
          return true;
        },
        async rescheduleRun(input) {
          events.push(`reschedule:${input.delayMs}`);
          return true;
        },
        async completeRun() {
          throw new Error('an aborted tick must not claim completion');
        },
      }),
      store: storeFixture({
        async head(key: string) {
          return { key, etag: 'etag', lastModified: '2026-07-26T11:00:00.000Z' };
        },
        async delete() {
          // Abort while the destructive call is already in flight.
          controller.abort();
          events.push('delete');
        },
        async listStaging() {
          throw new Error('an aborted tick must not start an orphan scan');
        },
      }),
    });

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toEqual({
      success: true,
      data: { kind: 'progress', runId: RUN_ID, uploadsDeleted: 1, orphanObjectsDeleted: 0 },
    });
    expect(events).toEqual([
      'claim-uploads',
      'delete',
      'mark-upload-deleted',
      'reschedule:0',
    ]);
  });

  test('stops before starting a new orphan delete and preserves the scan cursor', async () => {
    const controller = new AbortController();
    const first = `developer-modules/staging/${'3'.repeat(64)}/${'1'.repeat(36)}`;
    const second = `developer-modules/staging/${'4'.repeat(64)}/${'2'.repeat(36)}`;
    const deleted: string[] = [];
    const cursors: Array<string | null> = [];
    const worker = createDeveloperArtifactRetentionWorker({
      config: { ...config(), uploadBatchSize: 10 },
      repository: repositoryFixture({
        async claimRun() {
          return runningRun({ cursor: 'resume-cursor' });
        },
        async rescheduleRun(input) {
          cursors.push(input.cursor);
          return true;
        },
        async completeRun() {
          throw new Error('an aborted scan must not claim completion');
        },
      }),
      store: storeFixture({
        async listStaging() {
          return {
            objects: [
              { key: first, etag: 'first-etag', lastModified: '2026-07-26T11:00:00.000Z' },
              { key: second, etag: 'second-etag', lastModified: '2026-07-26T11:00:00.000Z' },
            ],
            nextCursor: null,
          };
        },
        async delete(key: string) {
          deleted.push(key);
          controller.abort();
        },
      }),
    });

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toEqual({
      success: true,
      data: { kind: 'progress', runId: RUN_ID, uploadsDeleted: 0, orphanObjectsDeleted: 1 },
    });
    expect(deleted).toEqual([first]);
    // The unfinished page must resume from the cursor that produced it.
    expect(cursors).toEqual(['resume-cursor']);
  });
});
