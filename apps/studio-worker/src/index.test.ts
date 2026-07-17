import { describe, expect, test } from 'bun:test';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import {
  parseStudioWorkerEnvironment,
  runStudioMaintenanceOnce,
  runStudioWorkerLoop,
  runStudioWorkerTick,
  shutdownStudioWorker,
} from './index';
import { createMemoryStudioWorkerRepository } from './memory-repository';

describe('studio worker bootstrap loop', () => {
  test('captures maintenance failures so the worker loop can continue', async () => {
    const errors: unknown[] = [];

    const completed = await runStudioMaintenanceOnce({
      runOnce: async () => {
        throw new Error('maintenance database timeout');
      },
      logError: (message, details) => {
        errors.push({ message, details });
      },
    });

    expect(completed).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: '[studio-worker] maintenance failed',
    });
  });

  test('assembles production orphan cleanup with storage and bounded seven-day defaults', async () => {
    const module = await import('./index');
    const createProductionMaintenance = (
      module as typeof module & {
        createProductionStudioMaintenanceCoordinator?: (input: Record<string, unknown>) => {
          runOnce(): Promise<{ acquired: boolean; tasksRun: number }>;
        };
      }
    ).createProductionStudioMaintenanceCoordinator;
    expect(createProductionMaintenance).toBeFunction();
    if (!createProductionMaintenance) return;
    const now = new Date('2026-07-15T10:00:00.000Z');
    const candidateInputs: Array<{ retentionBefore: Date; limit: number }> = [];
    const repository = {
      acquireOrRenewLease: async () => true,
      releaseLease: async () => {},
      requeueExpiredJobLeases: async () => {},
      failStuckUnknownOutcomes: async () => {},
      compactProgressEvents: async () => {},
      expireUploads: async () => {},
      reconcileCreditReservations: async () => {},
      listOrphanStagingCandidates: async (input: { retentionBefore: Date; limit: number }) => {
        candidateInputs.push(input);
        return [];
      },
      isOrphanStagingCandidate: async () => false,
    };
    const objectStore = {
      namespace: 'studio-production',
      required_server_side_encryption: 'AES256',
      required_sse_kms_key_id: null,
      assertReady: async () => {},
      putObject: async () => {
        throw new Error('unused');
      },
      headObject: async () => {
        throw new Error('unused');
      },
      getObject: async () => {
        throw new Error('unused');
      },
      listObjects: async () => ({ objects: [], next_cursor: null }),
      deleteObject: async () => {},
      createSignedUploadUrl: async () => 'unused',
      createSignedDownloadUrl: async () => 'unused',
    };
    const coordinator = createProductionMaintenance({
      repository,
      objectStore,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => now,
    });

    expect(await coordinator.runOnce()).toEqual({ acquired: true, tasksRun: 6 });
    expect(candidateInputs).toHaveLength(1);
    expect(candidateInputs[0]?.retentionBefore).toEqual(new Date('2026-07-08T10:00:00.000Z'));
    expect(candidateInputs[0]?.limit).toBeGreaterThan(0);
    expect(candidateInputs[0]?.limit).toBeLessThanOrEqual(100);
  });

  test('assembles the production worker with durable completed-result staging', async () => {
    const module = await import('./index');
    const createProductionWorker = (
      module as typeof module & {
        createProductionStudioWorker?: (input: Record<string, unknown>) => {
          runOnce(): Promise<Record<string, unknown>>;
        };
      }
    ).createProductionStudioWorker;
    expect(createProductionWorker).toBeFunction();
    if (!createProductionWorker) return;

    const now = new Date('2026-07-15T10:00:00.000Z');
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 2,
        markup_credits: 0.25,
      },
      reservedCredits: 2.25,
    });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    let pollCalls = 0;
    const adapter = {
      id: 'fake',
      submit: async (ctx: { submissionKey: string }) => ({
        kind: 'completed' as const,
        provider: 'fake',
        submission_key: ctx.submissionKey,
        result: {
          assets: [
            {
              kind: 'image' as const,
              filename: 'production-result.png',
              mime_type: 'image/png',
              size_bytes: png.byteLength,
              replayable_within_attempt: true,
              openBody: async () => new Blob([png]).stream(),
            },
          ],
        },
      }),
      poll: async () => {
        pollCalls += 1;
        return { status: 'succeeded' as const };
      },
      cancel: async () => {},
      fetchResult: async () => ({ assets: [] }),
    };
    const worker = createProductionWorker({
      config: {
        workerId: 'production-worker',
        leaseMs: 30_000,
        pollIntervalMs: 0,
        unknownOutcomeTimeoutMs: 15 * 60_000,
      },
      repository,
      providers: {
        get: () => adapter,
        resolve: async () => adapter,
      },
      credentialResolver: { resolve: async () => null },
      referenceAssets: { resolve: async () => [] },
      authorization: { revalidate: async () => ({ authorized: true }) },
      objectStore: new InMemoryStudioObjectStore({ namespace: 'studio-production', ready: true }),
      now: () => now,
      random: () => 0,
    });

    expect(await worker.runOnce()).toMatchObject({
      kind: 'processed',
      jobId: job.jobId,
      status: 'succeeded',
    });
    expect(pollCalls).toBe(0);
    expect(repository.getAttempts(job.jobId)[0]?.stagingManifestKey).toContain('/manifest.json');
  });

  test('accepts an explicit production adapter enablement flag with the worker secret', () => {
    expect(
      parseStudioWorkerEnvironment({
        STUDIO_ENABLED: 'true',
        DATABASE_URL: 'postgres://studio-worker',
        API_KEY_SECRET: 'worker-master-secret',
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
      }),
    ).toMatchObject({
      enabled: true,
      apiKeySecret: 'worker-master-secret',
      fakeProviderEnabled: false,
      openAiCompatibleEnabled: true,
    });
  });

  test('checks storage readiness before every claim and skips claims while unavailable', async () => {
    let claims = 0;
    const unavailable = await runStudioWorkerTick({
      assertReady: async () => {
        throw new Error('storage unavailable');
      },
      claim: async () => {
        claims += 1;
      },
    });
    expect(unavailable).toEqual({ ready: false });
    expect(claims).toBe(0);

    expect(
      await runStudioWorkerTick({
        assertReady: async () => {},
        claim: async () => {
          claims += 1;
          return 'claimed';
        },
      }),
    ).toEqual({ ready: true, result: 'claimed' });
    expect(claims).toBe(1);
  });

  test('does not claim when shutdown arrives while readiness is pending', async () => {
    const controller = new AbortController();
    let finishReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      finishReadiness = resolve;
    });
    let claims = 0;

    const tick = runStudioWorkerTick({
      signal: controller.signal,
      assertReady: async () => readiness,
      claim: async () => {
        claims += 1;
      },
    });
    controller.abort();
    finishReadiness();

    await expect(tick).resolves.toEqual({ ready: false });
    expect(claims).toBe(0);
  });

  test('shuts down maintenance, database, and storage exactly once', async () => {
    const calls: string[] = [];
    await shutdownStudioWorker({
      releaseMaintenance: async () => {
        calls.push('maintenance');
      },
      closeDatabase: async () => {
        calls.push('database');
      },
      closeStorage: async () => {
        calls.push('storage');
      },
    });
    expect(calls).toEqual(['maintenance', 'database', 'storage']);
  });

  test('attempts every cleanup step when the database close fails', async () => {
    const calls: string[] = [];
    await shutdownStudioWorker({
      releaseMaintenance: async () => {
        calls.push('maintenance');
      },
      closeDatabase: async () => {
        calls.push('database');
        throw new Error('database close failed');
      },
      closeStorage: async () => {
        calls.push('storage');
      },
    });
    expect(calls).toEqual(['maintenance', 'database', 'storage']);
  });

  test('waits for maintenance release before starting database close', async () => {
    let releaseSettled = false;
    let closeDatabaseStarted = false;
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = () => {
        releaseSettled = true;
        resolve();
      };
    });
    const closing = shutdownStudioWorker({
      releaseMaintenance: async () => releasePromise,
      closeDatabase: async () => {
        closeDatabaseStarted = true;
        expect(releaseSettled).toBe(true);
      },
      closeStorage: async () => {},
    });
    await Promise.resolve();
    expect(closeDatabaseStarted).toBe(false);
    release();
    await closing;
    expect(closeDatabaseStarted).toBe(true);
  });

  test('does not make a second claim after an abort', async () => {
    const controller = new AbortController();
    let claims = 0;
    await runStudioWorkerLoop({
      signal: controller.signal,
      idleMs: 0,
      tick: async () => {
        claims += 1;
        controller.abort();
      },
    });
    expect(claims).toBe(1);
  });
});
