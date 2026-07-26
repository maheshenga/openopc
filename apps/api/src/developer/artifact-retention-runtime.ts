import type {
  DeveloperArtifactRetentionRepository,
  DeveloperArtifactRetentionWorker,
} from './artifact-retention-spec';

export interface DeveloperArtifactRetentionScheduler {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DeveloperArtifactRetentionRuntime {
  start(): void;
  stop(): Promise<void>;
}

export interface DeveloperArtifactRetentionLifecycle {
  start(): void;
  stop(): Promise<void>;
  settled(): Promise<void>;
}

const systemScheduler: DeveloperArtifactRetentionScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createDeveloperArtifactRetentionRuntime(input: {
  repository: Pick<DeveloperArtifactRetentionRepository, 'enqueueRun'>;
  worker: DeveloperArtifactRetentionWorker;
  intervalMs: number;
  retryIntervalMs: number;
  scheduler?: DeveloperArtifactRetentionScheduler;
  onError?: (error: unknown) => void;
}): DeveloperArtifactRetentionRuntime {
  assertInterval(input.intervalMs, 'intervalMs');
  assertInterval(input.retryIntervalMs, 'retryIntervalMs');

  const scheduler = input.scheduler ?? systemScheduler;
  const worker = input.worker;
  let running = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let scheduledRunTimer: unknown | null = null;
  let pollTimer: unknown | null = null;
  let scheduledRunInFlight: Promise<void> | null = null;
  let pollInFlight: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // A telemetry callback must never escape the retention loop.
    }
  };

  const armScheduledRun = (delayMs: number, scheduledGeneration: number): void => {
    if (
      !running ||
      scheduledRunTimer !== null ||
      scheduledRunInFlight !== null ||
      scheduledGeneration !== generation
    ) {
      return;
    }
    scheduledRunTimer = scheduler.setTimeout(() => {
      scheduledRunTimer = null;
      if (!running || scheduledGeneration !== generation || !controller) return;
      const signal = controller.signal;
      let nextDelayMs = input.intervalMs;
      let task: Promise<void>;
      task = (async () => {
        try {
          if (signal.aborted) return;
          await input.repository.enqueueRun({ acceptanceRunId: null, delayMs: 0 });
        } catch (error) {
          if (!signal.aborted) {
            nextDelayMs = input.retryIntervalMs;
            reportError(error);
          }
        }
      })().finally(() => {
        if (scheduledRunInFlight === task) scheduledRunInFlight = null;
        if (running && scheduledGeneration === generation && !signal.aborted) {
          armScheduledRun(nextDelayMs, scheduledGeneration);
        }
      });
      scheduledRunInFlight = task;
      return task;
    }, delayMs);
  };

  const armPoll = (delayMs: number, scheduledGeneration: number): void => {
    if (
      !running ||
      pollTimer !== null ||
      pollInFlight !== null ||
      scheduledGeneration !== generation
    ) {
      return;
    }
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = null;
      if (!running || scheduledGeneration !== generation || !controller) return;
      const signal = controller.signal;
      let task: Promise<void>;
      task = (async () => {
        try {
          if (signal.aborted) return;
          const result = await worker.runOnce({ signal });
          if (signal.aborted) return;
          if (!result.success) {
            const error = new Error(
              `Developer artifact retention worker failed: ${result.error.code}`,
            ) as Error & { code: string };
            error.code = result.error.code;
            reportError(error);
          }
        } catch (error) {
          if (!signal.aborted) reportError(error);
        }
      })().finally(() => {
        if (pollInFlight === task) pollInFlight = null;
        if (running && scheduledGeneration === generation && !signal.aborted) {
          armPoll(input.retryIntervalMs, scheduledGeneration);
        }
      });
      pollInFlight = task;
      return task;
    }, delayMs);
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    if (
      !running &&
      scheduledRunTimer === null &&
      pollTimer === null &&
      scheduledRunInFlight === null &&
      pollInFlight === null
    ) {
      return Promise.resolve();
    }

    running = false;
    generation += 1;
    controller?.abort();
    controller = null;
    if (scheduledRunTimer !== null) {
      scheduler.clearTimeout(scheduledRunTimer);
      scheduledRunTimer = null;
    }
    if (pollTimer !== null) {
      scheduler.clearTimeout(pollTimer);
      pollTimer = null;
    }

    const inFlight = [scheduledRunInFlight, pollInFlight].filter(
      (task): task is Promise<void> => task !== null,
    );
    let operation: Promise<void>;
    operation = Promise.allSettled(inFlight)
      .then(() => undefined)
      .finally(() => {
        if (stopping === operation) stopping = null;
      });
    stopping = operation;
    return operation;
  };

  return {
    start() {
      if (running || stopping) return;
      running = true;
      generation += 1;
      controller = new AbortController();
      armScheduledRun(0, generation);
      armPoll(0, generation);
    },
    stop,
  };
}

export function createDeveloperArtifactRetentionLifecycle(input: {
  initialize(): Promise<DeveloperArtifactRetentionRuntime>;
  scheduler?: DeveloperArtifactRetentionScheduler;
  retryInitialMs?: number;
  retryMaxMs?: number;
  onError?: (error: unknown) => void;
}): DeveloperArtifactRetentionLifecycle {
  const scheduler = input.scheduler ?? systemScheduler;
  const retryInitialMs = input.retryInitialMs ?? 1_000;
  const retryMaxMs = input.retryMaxMs ?? 30_000;
  assertInterval(retryInitialMs, 'initialization retry interval');
  assertInterval(retryMaxMs, 'initialization retry maximum');
  if (retryInitialMs > retryMaxMs) {
    throw new Error('Invalid developer artifact retention initialization retry bounds');
  }

  let desired = false;
  let generation = 0;
  let active: DeveloperArtifactRetentionRuntime | null = null;
  let initializing: Promise<void> | null = null;
  let initializingRuntime: Promise<DeveloperArtifactRetentionRuntime> | null = null;
  let retryTimer: unknown | null = null;
  let nextRetryMs = retryInitialMs;
  let stopping: Promise<void> | null = null;

  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // A telemetry callback must never escape API boot or leader release.
    }
  };

  const stopRuntime = async (runtime: DeveloperArtifactRetentionRuntime): Promise<void> => {
    try {
      await runtime.stop();
    } catch (error) {
      reportError(error);
    }
  };

  const scheduleRetry = (scheduledGeneration: number): void => {
    if (
      !desired ||
      retryTimer !== null ||
      active !== null ||
      scheduledGeneration !== generation
    ) {
      return;
    }
    const delayMs = nextRetryMs;
    nextRetryMs = Math.min(retryMaxMs, nextRetryMs * 2);
    retryTimer = scheduler.setTimeout(() => {
      retryTimer = null;
      if (!desired || scheduledGeneration !== generation) return;
      return beginInitialization(scheduledGeneration);
    }, delayMs);
  };

  const beginInitialization = (requestedGeneration: number): Promise<void> => {
    if (
      !desired ||
      active !== null ||
      initializing !== null ||
      requestedGeneration !== generation
    ) {
      return Promise.resolve();
    }

    // Invoke initialize synchronously and keep the raw runtime promise so a
    // stop that arrives mid-initialization can claim disposal of its result.
    let runtimePromise: Promise<DeveloperArtifactRetentionRuntime>;
    try {
      runtimePromise = Promise.resolve(input.initialize());
    } catch (error) {
      runtimePromise = Promise.reject(error);
    }
    initializingRuntime = runtimePromise;
    let attempt: Promise<void>;
    attempt = runtimePromise
      .then(async (runtime) => {
        if (!desired || requestedGeneration !== generation) {
          // The stop that bumped the generation owns disposal of this runtime.
          return;
        }
        try {
          runtime.start();
          active = runtime;
          nextRetryMs = retryInitialMs;
        } catch (error) {
          await stopRuntime(runtime);
          throw error;
        }
      })
      .catch((error) => {
        reportError(error);
        if (desired && requestedGeneration === generation && active === null) {
          scheduleRetry(requestedGeneration);
        }
      })
      .finally(() => {
        if (initializing === attempt) initializing = null;
        if (initializingRuntime === runtimePromise) initializingRuntime = null;
      });
    initializing = attempt;
    return attempt;
  };

  const start = (): void => {
    if (desired) return;
    desired = true;
    generation += 1;
    nextRetryMs = retryInitialMs;
    const requestedGeneration = generation;
    if (stopping) {
      void stopping.then(() => {
        if (desired && requestedGeneration === generation) {
          void beginInitialization(requestedGeneration);
        }
      });
      return;
    }
    void beginInitialization(requestedGeneration);
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    if (!desired && !active && !initializing && retryTimer === null) {
      return Promise.resolve();
    }

    desired = false;
    generation += 1;
    if (retryTimer !== null) {
      scheduler.clearTimeout(retryTimer);
      retryTimer = null;
    }
    const runtime = active;
    active = null;
    const initialization = initializing;
    // A runtime that is still materializing must be stopped as soon as it
    // exists; the initialization chain above skips starting it.
    const pendingRuntime = runtime === null ? initializingRuntime : null;
    const disposal = pendingRuntime
      ? pendingRuntime.then(
          (materialized) => stopRuntime(materialized),
          () => undefined,
        )
      : runtime
        ? stopRuntime(runtime)
        : Promise.resolve();
    let operation: Promise<void>;
    operation = Promise.all([initialization ?? Promise.resolve(), disposal])
      .then(() => undefined)
      .finally(() => {
        if (stopping === operation) stopping = null;
      });
    stopping = operation;
    return operation;
  };

  return {
    start,
    stop,
    settled() {
      return stopping ?? initializing ?? Promise.resolve();
    },
  };
}

function assertInterval(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60_000) {
    throw new Error(`Invalid developer artifact retention ${label}`);
  }
}
