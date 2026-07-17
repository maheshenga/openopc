import { buildStudioWorkerRuntime } from './runtime';

export {
  closeStudioWorkerResources as shutdownStudioWorker,
  createProductionStudioMaintenanceCoordinator,
  createProductionStudioWorker,
  parseStudioWorkerEnvironment,
} from './runtime';

export async function runStudioWorkerLoop(input: {
  signal: AbortSignal;
  idleMs: number;
  tick: () => Promise<void>;
}): Promise<void> {
  while (!input.signal.aborted) {
    await input.tick();
    if (input.signal.aborted) break;
    await abortableDelay(input.idleMs, input.signal);
  }
}

export async function runStudioMaintenanceOnce(input: {
  runOnce: () => Promise<void>;
  logError?: (message: string, details: Record<string, unknown>) => void;
}): Promise<boolean> {
  try {
    await input.runOnce();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (input.logError ?? console.error)('[studio-worker] maintenance failed', { error: message });
    return false;
  }
}

export async function runStudioWorkerTick<T>(input: {
  signal?: AbortSignal;
  assertReady: () => Promise<void>;
  claim: () => Promise<T>;
}): Promise<{ ready: false } | { ready: true; result: T }> {
  if (input.signal?.aborted) return { ready: false };
  try {
    await input.assertReady();
  } catch {
    return { ready: false };
  }
  if (input.signal?.aborted) return { ready: false };
  return { ready: true, result: await input.claim() };
}

export async function runStudioWorkerBootstrap<
  TRuntime extends { enabled: false } | { enabled: true; close(): Promise<void> },
>(input: {
  controller: AbortController;
  buildRuntime: (signal: AbortSignal) => Promise<TRuntime>;
  runRuntime: (runtime: Extract<TRuntime, { enabled: true }>, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  let runtime: TRuntime | null = null;
  try {
    runtime = await input.buildRuntime(input.controller.signal);
    if (!runtime.enabled || input.controller.signal.aborted) return;
    await input.runRuntime(
      runtime as Extract<TRuntime, { enabled: true }>,
      input.controller.signal,
    );
  } finally {
    if (runtime?.enabled) await runtime.close();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runStudioWorkerBootstrap({
      controller,
      async buildRuntime(signal) {
        const runtime = await buildStudioWorkerRuntime(process.env, { signal });
        if (!runtime.enabled) {
          console.info('[studio-worker] STUDIO_ENABLED is not true; worker remains disabled');
        }
        return runtime;
      },
      async runRuntime(runtime, signal) {
        let nextMaintenanceAt = 0;
        console.info('[studio-worker] started', {
          workerId: runtime.workerId,
          fakeProviderEnabled: runtime.fakeProviderEnabled,
          openAiCompatibleEnabled: runtime.openAiCompatibleEnabled,
        });
        await runStudioWorkerLoop({
          signal,
          idleMs: runtime.idleMs,
          async tick() {
            const tick = await runStudioWorkerTick({
              signal,
              assertReady: runtime.assertReadyBeforeClaim,
              claim: () => runtime.worker.runOnce(),
            });
            if (tick.ready && tick.result.kind === 'error') {
              console.error('[studio-worker] tick failed', {
                code: tick.result.code,
                jobId: tick.result.jobId,
              });
            }
            const now = Date.now();
            if (now >= nextMaintenanceAt) {
              await runStudioMaintenanceOnce({
                async runOnce() {
                  await runtime.maintenance.runOnce();
                },
              });
              nextMaintenanceAt = now + runtime.maintenanceMs;
            }
          },
        });
      },
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[studio-worker] fatal', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
