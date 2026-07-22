import type { AutomationDispatchCoordinator } from './coordinator';

export type AutomationDispatchPollingFailure = Readonly<{
  event: 'automation_desktop_coordinator_poll_failed';
}>;

export type AutomationDispatchPoller = Readonly<{
  stop(): Promise<void>;
}>;

type PollingCoordinator = Pick<AutomationDispatchCoordinator, 'runOnce'>;

type PollingDependencies = Readonly<{
  coordinator: PollingCoordinator;
  intervalMs: number;
  drainTimeoutMs?: number;
  onError?: (failure: AutomationDispatchPollingFailure) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}>;

export function startAutomationDispatchPolling(
  dependencies: PollingDependencies,
): AutomationDispatchPoller {
  if (!Number.isSafeInteger(dependencies.intervalMs) || dependencies.intervalMs < 1) {
    throw new Error('automation coordinator poll interval must be a positive integer');
  }
  const drainTimeoutMs = dependencies.drainTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60_000) {
    throw new Error('automation coordinator drain timeout must be between 1 and 60000 ms');
  }
  const schedule =
    dependencies.schedule ??
    ((callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs));
  const cancel =
    dependencies.cancel ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let scheduledHandle: unknown;
  let activePoll: Promise<void> | null = null;
  let activeAbortController: AbortController | null = null;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    scheduledHandle = undefined;
    const abortController = new AbortController();
    activeAbortController = abortController;
    try {
      await dependencies.coordinator.runOnce({ signal: abortController.signal });
    } catch {
      if (!stopped) {
        try {
          dependencies.onError?.({ event: 'automation_desktop_coordinator_poll_failed' });
        } catch {
          // A diagnostics sink must not stop the coordinator's bounded retry loop.
        }
      }
    } finally {
      if (activeAbortController === abortController) activeAbortController = null;
      if (!stopped) {
        scheduledHandle = schedule(() => {
          startPoll();
        }, dependencies.intervalMs);
      }
    }
  };

  const startPoll = (): void => {
    const current = poll();
    activePoll = current;
    void current.then(
      () => {
        if (activePoll === current) activePoll = null;
      },
      () => {
        if (activePoll === current) activePoll = null;
      },
    );
  };

  startPoll();

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        activeAbortController?.abort();
        if (scheduledHandle !== undefined) {
          cancel(scheduledHandle);
          scheduledHandle = undefined;
        }
      }
      const draining = activePoll;
      if (draining === null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, drainTimeoutMs);
        void draining.then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          () => {
            clearTimeout(timeout);
            resolve();
          },
        );
      });
    },
  };
}
