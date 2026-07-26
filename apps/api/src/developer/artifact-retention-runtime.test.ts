import { describe, expect, test } from 'bun:test';

import {
  createDeveloperArtifactRetentionLifecycle,
  createDeveloperArtifactRetentionRuntime,
} from './artifact-retention-runtime';
import type {
  DeveloperArtifactRetentionRunStatus,
  DeveloperArtifactRetentionWorker,
} from './artifact-retention-spec';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const RUN_ID = '70000000-0000-4000-a000-000000000007';

function queuedRun(): DeveloperArtifactRetentionRunStatus {
  return {
    runId: RUN_ID,
    acceptanceRunId: null,
    state: 'queued',
    attempts: 0,
    availableAt: NOW.toISOString(),
    cursor: null,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
  };
}

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map<number, { callback: () => void | Promise<void>; delayMs: number }>();
  return {
    scheduler: {
      setTimeout(callback: () => void | Promise<void>, delayMs: number) {
        const id = nextId++;
        tasks.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout(id: unknown) {
        tasks.delete(id as number);
      },
    },
    delays() {
      return [...tasks.values()].map((task) => task.delayMs).sort((a, b) => a - b);
    },
    async runNext() {
      const entry = [...tasks.entries()].sort(
        ([leftId, left], [rightId, right]) => left.delayMs - right.delayMs || leftId - rightId,
      )[0];
      if (!entry) throw new Error('No scheduled retention callback');
      const [id, task] = entry;
      tasks.delete(id);
      await task.callback();
    },
  };
}

describe('developer artifact retention runtime', () => {
  test('separates hourly run creation from fast queue polling', async () => {
    const events: string[] = [];
    const scheduled = fakeScheduler();
    const worker: DeveloperArtifactRetentionWorker = {
      async runOnce() {
        events.push('run-once');
        return { success: true, data: { kind: 'idle' } };
      },
    };
    const runtime = createDeveloperArtifactRetentionRuntime({
      repository: {
        async enqueueRun(input) {
          events.push(`enqueue:${input.acceptanceRunId}:${input.delayMs}`);
          return queuedRun();
        },
      },
      worker,
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      scheduler: scheduled.scheduler,
    });

    runtime.start();
    runtime.start();
    expect(scheduled.delays()).toEqual([0, 0]);

    await scheduled.runNext();
    expect(events).toEqual(['enqueue:null:0']);
    expect(scheduled.delays()).toEqual([0, 60_000]);

    await scheduled.runNext();
    expect(events).toEqual(['enqueue:null:0', 'run-once']);
    expect(scheduled.delays()).toEqual([5_000, 60_000]);

    await runtime.stop();
    await runtime.stop();
    expect(scheduled.delays()).toEqual([]);
  });

  test('aborts and awaits an in-flight worker tick before stop resolves', async () => {
    const scheduled = fakeScheduler();
    const workerStarted = deferred();
    const releaseWorker = deferred();
    let observedSignal: AbortSignal | undefined;
    let stopResolved = false;
    const runtime = createDeveloperArtifactRetentionRuntime({
      repository: { async enqueueRun() { return queuedRun(); } },
      worker: {
        async runOnce(options?: { signal?: AbortSignal }) {
          observedSignal = options?.signal;
          workerStarted.resolve();
          await releaseWorker.promise;
          return { success: true, data: { kind: 'idle' } };
        },
      },
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      scheduler: scheduled.scheduler,
    });

    runtime.start();
    const firstTick = scheduled.runNext();
    const firstOutcome = await Promise.race([
      firstTick.then(() => 'completed' as const),
      workerStarted.promise.then(() => 'worker-started' as const),
    ]);
    const tick = firstOutcome === 'completed' ? scheduled.runNext() : firstTick;
    await workerStarted.promise;

    const stopping = runtime.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();

    expect(observedSignal?.aborted).toBe(true);
    expect(stopResolved).toBe(false);
    expect(scheduled.delays()).toEqual([]);

    releaseWorker.resolve();
    await stopping;
    await tick;
    expect(stopResolved).toBe(true);
    expect(scheduled.delays()).toEqual([]);
  });

  test('awaits an in-flight scheduled enqueue before stop resolves', async () => {
    const scheduled = fakeScheduler();
    const enqueueStarted = deferred();
    const releaseEnqueue = deferred();
    let stopResolved = false;
    const runtime = createDeveloperArtifactRetentionRuntime({
      repository: {
        async enqueueRun() {
          enqueueStarted.resolve();
          await releaseEnqueue.promise;
          return queuedRun();
        },
      },
      worker: { async runOnce() { return { success: true, data: { kind: 'idle' } }; } },
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      scheduler: scheduled.scheduler,
    });

    runtime.start();
    const enqueueTick = scheduled.runNext();
    await enqueueStarted.promise;
    const stopping = runtime.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    releaseEnqueue.resolve();
    await stopping;
    await enqueueTick;
    expect(stopResolved).toBe(true);
    expect(scheduled.delays()).toEqual([]);
  });

  test('contains independent enqueue and worker failures at the fast retry cadence', async () => {
    const scheduled = fakeScheduler();
    const errors: string[] = [];
    const runtime = createDeveloperArtifactRetentionRuntime({
      repository: {
        async enqueueRun() {
          throw new Error('database unavailable');
        },
      },
      worker: {
        async runOnce() {
          throw new Error('unexpected worker exception');
        },
      },
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      scheduler: scheduled.scheduler,
      onError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    runtime.start();
    await scheduled.runNext();
    await scheduled.runNext();

    expect(errors).toEqual(['database unavailable', 'unexpected worker exception']);
    expect(scheduled.delays()).toEqual([5_000, 5_000]);
    await runtime.stop();
  });

  test('uses the fast polling cadence for idle, progress, and terminal results', async () => {
    const scheduled = fakeScheduler();
    const errors: Array<{ message: string; code: unknown }> = [];
    let call = 0;
    const runtime = createDeveloperArtifactRetentionRuntime({
      repository: { async enqueueRun() { return queuedRun(); } },
      worker: {
        async runOnce() {
          call += 1;
          if (call === 1) return { success: true, data: { kind: 'idle' } };
          if (call === 2) {
            return {
              success: true,
              data: {
                kind: 'progress',
                runId: RUN_ID,
                uploadsDeleted: 1,
                orphanObjectsDeleted: 0,
              },
            };
          }
          return {
            success: false,
            error: { code: 'RETENTION_OBJECT_STORE_FAILED', recoverable: false },
          };
        },
      },
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      scheduler: scheduled.scheduler,
      onError(error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: unknown }).code,
        });
      },
    });

    runtime.start();
    await scheduled.runNext();
    await scheduled.runNext();
    expect(scheduled.delays()).toEqual([5_000, 60_000]);

    await scheduled.runNext();
    expect(scheduled.delays()).toEqual([5_000, 60_000]);
    await scheduled.runNext();
    expect(scheduled.delays()).toEqual([5_000, 60_000]);
    // Structured worker failures surface through onError with their code.
    expect(errors).toEqual([
      {
        message: 'Developer artifact retention worker failed: RETENTION_OBJECT_STORE_FAILED',
        code: 'RETENTION_OBJECT_STORE_FAILED',
      },
    ]);
    await runtime.stop();
  });
});

describe('developer artifact retention lifecycle', () => {
  test('initializes once and awaits an idempotent active-runtime stop', async () => {
    let initializeCalls = 0;
    let starts = 0;
    let stops = 0;
    const stopGate = deferred();
    const lifecycle = createDeveloperArtifactRetentionLifecycle({
      async initialize() {
        initializeCalls += 1;
        return {
          start() {
            starts += 1;
          },
          async stop() {
            stops += 1;
            await stopGate.promise;
          },
        };
      },
    });

    lifecycle.start();
    lifecycle.start();
    await lifecycle.settled();
    expect({ initializeCalls, starts, stops }).toEqual({ initializeCalls: 1, starts: 1, stops: 0 });

    let stopResolved = false;
    const firstStop = lifecycle.stop().then(() => {
      stopResolved = true;
    });
    const secondStop = lifecycle.stop();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(stops).toBe(1);

    stopGate.resolve();
    await Promise.all([firstStop, secondStop]);
    expect(stopResolved).toBe(true);
    expect(stops).toBe(1);
  });

  test('awaits disposal when leadership is released during initialization', async () => {
    let resolveRuntime:
      | ((runtime: { start(): void; stop(): Promise<void> }) => void)
      | undefined;
    const pendingRuntime = new Promise<{ start(): void; stop(): Promise<void> }>((resolve) => {
      resolveRuntime = resolve;
    });
    const stopGate = deferred();
    let starts = 0;
    let stops = 0;
    const lifecycle = createDeveloperArtifactRetentionLifecycle({
      initialize: () => pendingRuntime,
    });

    lifecycle.start();
    const stopping = lifecycle.stop();
    resolveRuntime?.({
      start() {
        starts += 1;
      },
      async stop() {
        stops += 1;
        await stopGate.promise;
      },
    });
    await Promise.resolve();
    expect({ starts, stops }).toEqual({ starts: 0, stops: 1 });

    stopGate.resolve();
    await stopping;
    await lifecycle.settled();
    expect({ starts, stops }).toEqual({ starts: 0, stops: 1 });
  });

  test('retries initialization with bounded backoff while still desired', async () => {
    const scheduled = fakeScheduler();
    const errors: string[] = [];
    let initializeCalls = 0;
    let starts = 0;
    const lifecycle = createDeveloperArtifactRetentionLifecycle({
      async initialize() {
        initializeCalls += 1;
        if (initializeCalls <= 3) throw new Error(`storage unavailable ${initializeCalls}`);
        return {
          start() {
            starts += 1;
          },
          async stop() {},
        };
      },
      scheduler: scheduled.scheduler,
      retryInitialMs: 100,
      retryMaxMs: 200,
      onError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    lifecycle.start();
    await lifecycle.settled();
    expect(scheduled.delays()).toEqual([100]);

    await scheduled.runNext();
    expect(scheduled.delays()).toEqual([200]);
    await scheduled.runNext();
    expect(scheduled.delays()).toEqual([200]);
    await scheduled.runNext();

    expect({ initializeCalls, starts }).toEqual({ initializeCalls: 4, starts: 1 });
    expect(errors).toEqual([
      'storage unavailable 1',
      'storage unavailable 2',
      'storage unavailable 3',
    ]);
    expect(scheduled.delays()).toEqual([]);
    await lifecycle.stop();
  });

  test('cancels a pending initialization retry when stopped', async () => {
    const scheduled = fakeScheduler();
    let initializeCalls = 0;
    const lifecycle = createDeveloperArtifactRetentionLifecycle({
      async initialize() {
        initializeCalls += 1;
        throw new Error('storage unavailable');
      },
      scheduler: scheduled.scheduler,
      retryInitialMs: 100,
      retryMaxMs: 200,
    });

    lifecycle.start();
    await lifecycle.settled();
    expect(scheduled.delays()).toEqual([100]);

    await lifecycle.stop();
    expect(scheduled.delays()).toEqual([]);
    expect(initializeCalls).toBe(1);
  });
});
