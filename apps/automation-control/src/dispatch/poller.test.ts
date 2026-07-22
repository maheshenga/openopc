import { describe, expect, test } from 'bun:test';
import type { AutomationDispatchCoordinatorStats } from './coordinator';
import { startAutomationDispatchPolling } from './poller';

const EMPTY_STATS: AutomationDispatchCoordinatorStats = {
  candidates: 0,
  claimed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushPollingTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('automation desktop coordinator polling', () => {
  test('waits for each run to finish before scheduling the next bounded poll', async () => {
    const pendingRuns = [deferred(), deferred()];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    let runCount = 0;
    let activeRuns = 0;
    let maximumActiveRuns = 0;

    const poller = startAutomationDispatchPolling({
      coordinator: {
        async runOnce() {
          const run = pendingRuns[runCount];
          runCount += 1;
          activeRuns += 1;
          maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
          await run?.promise;
          activeRuns -= 1;
          return EMPTY_STATS;
        },
      },
      intervalMs: 250,
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      cancel() {},
    });

    expect(runCount).toBe(1);
    expect(scheduled).toHaveLength(0);

    pendingRuns[0]?.resolve();
    await flushPollingTurn();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(250);

    scheduled[0]?.callback();
    expect(runCount).toBe(2);
    expect(maximumActiveRuns).toBe(1);

    poller.stop();
    pendingRuns[1]?.resolve();
    await flushPollingTurn();
    expect(scheduled).toHaveLength(1);
  });

  test('reports only a stable sanitized failure event and continues polling', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const failures: unknown[] = [];

    startAutomationDispatchPolling({
      coordinator: {
        async runOnce() {
          throw new Error('provider secret must never be logged');
        },
      },
      intervalMs: 1_000,
      onError: (failure) => failures.push(failure),
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      cancel() {},
    });

    await flushPollingTurn();

    expect(failures).toEqual([{ event: 'automation_desktop_coordinator_poll_failed' }]);
    expect(JSON.stringify(failures)).not.toContain('provider secret');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_000);
  });

  test('clears the pending poll and ignores callbacks after shutdown', async () => {
    const scheduled: Array<{ callback: () => void; handle: object }> = [];
    const cancelled: unknown[] = [];
    let runCount = 0;

    const poller = startAutomationDispatchPolling({
      coordinator: {
        async runOnce() {
          runCount += 1;
          return EMPTY_STATS;
        },
      },
      intervalMs: 500,
      schedule(callback) {
        const handle = {};
        scheduled.push({ callback, handle });
        return handle;
      },
      cancel: (handle) => cancelled.push(handle),
    });

    await flushPollingTurn();
    poller.stop();
    scheduled[0]?.callback();
    await flushPollingTurn();

    expect(cancelled).toEqual([scheduled[0]?.handle]);
    expect(runCount).toBe(1);
  });

  test('waits for an in-flight run to drain during shutdown', async () => {
    const activeRun = deferred();
    let stopped = false;
    const poller = startAutomationDispatchPolling({
      coordinator: {
        async runOnce() {
          await activeRun.promise;
          return EMPTY_STATS;
        },
      },
      intervalMs: 500,
    });

    const stop = Promise.resolve(poller.stop()).then(() => {
      stopped = true;
    });
    await flushPollingTurn();
    expect(stopped).toBeFalse();

    activeRun.resolve();
    await stop;
    expect(stopped).toBeTrue();
  });

  test('aborts an active run and bounds shutdown when the dependency does not drain', async () => {
    let receivedSignal: AbortSignal | undefined;
    const poller = startAutomationDispatchPolling({
      coordinator: {
        async runOnce(options) {
          receivedSignal = options?.signal;
          return new Promise<AutomationDispatchCoordinatorStats>(() => {});
        },
      },
      intervalMs: 500,
      drainTimeoutMs: 10,
    });

    const outcome = await Promise.race([
      poller.stop().then(() => 'stopped' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(outcome).toBe('stopped');
    expect(receivedSignal?.aborted).toBeTrue();
  });
});
