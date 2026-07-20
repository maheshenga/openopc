import type { OpenOpcAgUiEvent, WorkflowEvent } from '@kortix/intelligence-contracts';
import { projectWorkflowEvent } from './projector';

const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const EVENT_PAGE_SIZE = 100;

export type IntelligenceAgUiConnectionPool = {
  tryAcquire(): (() => void) | null;
  active(): number;
};

export type IntelligenceAgUiStreamRuntime = {
  connections?: IntelligenceAgUiConnectionPool;
  pollIntervalMs?: number;
  keepAliveIntervalMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  setInterval?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
};

export type IntelligenceAgUiWorkflowStreamInput = IntelligenceAgUiStreamRuntime & {
  scope: { accountId: string; projectId: string; runId: string };
  afterSequence: number;
  signal: AbortSignal;
  connections: IntelligenceAgUiConnectionPool;
  readEvents(input: {
    accountId: string;
    projectId: string;
    runId: string;
    afterSequence: number;
    limit: number;
  }): Promise<{ items: WorkflowEvent[]; nextCursor: string | null }>;
};

export function createIntelligenceAgUiConnectionPool(
  maximum = DEFAULT_MAX_CONNECTIONS,
): IntelligenceAgUiConnectionPool {
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? maximum : DEFAULT_MAX_CONNECTIONS;
  let current = 0;
  return {
    tryAcquire() {
      if (current >= limit) return null;
      current += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        current -= 1;
      };
    },
    active() {
      return current;
    },
  };
}

export function createIntelligenceAgUiWorkflowStream(
  input: IntelligenceAgUiWorkflowStreamInput,
): Response | null {
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) return null;
  const release = input.connections.tryAcquire();
  if (!release) return null;

  const pollIntervalMs = positiveInterval(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const keepAliveIntervalMs = positiveInterval(
    input.keepAliveIntervalMs,
    DEFAULT_KEEPALIVE_INTERVAL_MS,
  );
  const sleep = input.sleep ?? sleepFor;
  const scheduleInterval = input.setInterval ?? setInterval;
  const clearScheduledInterval = input.clearInterval ?? clearInterval;
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let close = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      const onDisconnect = () => {
        abort.abort();
        close();
      };
      close = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearScheduledInterval(keepalive);
        input.signal.removeEventListener('abort', onDisconnect);
        release();
        try {
          controller.close();
        } catch {}
      };

      if (input.signal.aborted) {
        onDisconnect();
        return;
      }
      input.signal.addEventListener('abort', onDisconnect, { once: true });
      keepalive = scheduleInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          onDisconnect();
        }
      }, keepAliveIntervalMs);

      void pump();

      async function pump() {
        let cursor = input.afterSequence;
        let finalFlush = false;
        try {
          while (!closed && !abort.signal.aborted) {
            const page = await input.readEvents({
              ...input.scope,
              afterSequence: cursor,
              limit: EVENT_PAGE_SIZE,
            });
            if (closed || abort.signal.aborted) break;

            let terminal = false;
            for (const event of [...page.items].sort(
              (left, right) => left.sequence - right.sequence,
            )) {
              if (event.sequence <= cursor) continue;
              const projectedEvents = projectWorkflowEvent(event);
              const priorCursor = cursor;
              for (const [index, projected] of projectedEvents.entries()) {
                // Intermediate frames retain the previous cursor so reconnects replay this event.
                controller.enqueue(
                  encoder.encode(
                    formatSse(
                      index === projectedEvents.length - 1 ? event.sequence : priorCursor,
                      projected,
                    ),
                  ),
                );
              }
              cursor = event.sequence;
              terminal ||= isTerminal(event);
            }

            if (finalFlush) break;
            if (terminal) {
              finalFlush = true;
              continue;
            }
            await sleep(pollIntervalMs, abort.signal);
          }
        } catch {
          // The authenticated REST cursor remains the fallback when streaming fails.
        } finally {
          close();
        }
      }
    },
    cancel() {
      abort.abort();
      close();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function formatSse(sequence: number, event: OpenOpcAgUiEvent): string {
  return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isTerminal(event: WorkflowEvent): boolean {
  return (
    event.type === 'run_succeeded' || event.type === 'run_failed' || event.type === 'run_cancelled'
  );
}

function positiveInterval(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleepFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
