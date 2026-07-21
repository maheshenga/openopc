import { describe, expect, test } from 'bun:test';
import type { OpenOpcAgUiEvent } from '@kortix/intelligence-contracts';
import {
  type IntelligenceAgUiSubscriptionTestRuntime,
  IntelligenceAgUiUnavailableError,
  __subscribeIntelligenceAgUiForTests,
} from './intelligence-ag-ui';

const RUN_ID = '84000000-0000-4000-a000-000000000001';

class FakeTimers {
  readonly scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];

  setTimeout = (callback: () => void, delay: number) => {
    const handle = { callback, delay, cleared: false };
    this.scheduled.push(handle);
    return handle;
  };

  clearTimeout = (handle: { cleared: boolean } | undefined) => {
    if (handle) handle.cleared = true;
  };

  runNext() {
    const handle = this.scheduled.find((candidate) => !candidate.cleared);
    if (!handle) throw new Error('expected a scheduled retry');
    handle.cleared = true;
    handle.callback();
  }
}

function eventFrame(sequence: number, event: OpenOpcAgUiEvent): string {
  return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamResponse(...frames: string[]): Response {
  return new Response(frames.join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createRuntime(results: Array<Response | Error>) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const timers = new FakeTimers();
  const runtime: IntelligenceAgUiSubscriptionTestRuntime = {
    baseUrl: 'https://api.example.test/v1/',
    request: async (input) => {
      requests.push({ url: input.url, headers: input.headers });
      const next = results.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('no response configured');
      return next;
    },
    timers,
  };
  return { requests, runtime, timers };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('subscribeIntelligenceAgUi', () => {
  test('uses an encoded project stream URL, resumes with Last-Event-ID, and parses AG-UI data', async () => {
    const expected: OpenOpcAgUiEvent = {
      type: 'RUN_FINISHED',
      threadId: RUN_ID,
      runId: RUN_ID,
    };
    const { requests, runtime } = createRuntime([streamResponse(eventFrame(7, expected))]);
    const events: OpenOpcAgUiEvent[] = [];

    __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project / one',
        runId: 'run / one',
        cursor: 4,
        onEvent: (event) => events.push(event),
        onError: (error) => {
          throw error;
        },
      },
      runtime,
    );
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.example.test/v1/projects/project%20%2F%20one/intelligence/ag-ui/workflows/run%20%2F%20one/stream',
    );
    expect(requests[0]?.headers.get('Last-Event-ID')).toBe('4');
    expect(requests[0]?.headers.get('Accept')).toBe('text/event-stream');
    expect(events).toEqual([expected]);
  });

  test('rejects invalid SSE payloads without dispatching them', async () => {
    const { runtime } = createRuntime([
      streamResponse(`id: 1\nevent: RUN_STARTED\ndata: {"type":"RUN_STARTED"}\n\n`),
    ]);
    const events: OpenOpcAgUiEvent[] = [];
    const errors: Error[] = [];
    const subscription = __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project-1',
        runId: RUN_ID,
        onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error),
      },
      runtime,
    );
    await settle();
    subscription.close();

    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe('IntelligenceAgUiProtocolError');
  });

  test('ignores server keepalive comments while waiting for an AG-UI event', async () => {
    const expected: OpenOpcAgUiEvent = {
      type: 'RUN_FINISHED',
      threadId: RUN_ID,
      runId: RUN_ID,
    };
    const { runtime } = createRuntime([
      streamResponse(': keep-alive\n\n', eventFrame(3, expected)),
    ]);
    const events: OpenOpcAgUiEvent[] = [];
    const errors: Error[] = [];
    __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project-1',
        runId: RUN_ID,
        onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error),
      },
      runtime,
    );
    await settle();

    expect(events).toEqual([expected]);
    expect(errors).toEqual([]);
  });

  test('cancels a malformed response before scheduling a reconnect', async () => {
    const encoder = new TextEncoder();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 1\nevent: RUN_STARTED\ndata: {}\n\n'));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const { runtime } = createRuntime([
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    ]);
    const subscription = __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project-1',
        runId: RUN_ID,
        onEvent: () => {},
        onError: () => {},
      },
      runtime,
    );
    await settle();
    subscription.close();

    expect(cancelled).toBe(1);
  });

  test('reconnects with the latest durable cursor after a stream closes', async () => {
    const expected: OpenOpcAgUiEvent = {
      type: 'RUN_FINISHED',
      threadId: RUN_ID,
      runId: RUN_ID,
    };
    const { requests, runtime, timers } = createRuntime([
      streamResponse(eventFrame(9, { type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID })),
      streamResponse(eventFrame(10, expected)),
    ]);
    const errors: Error[] = [];
    const events: OpenOpcAgUiEvent[] = [];
    __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project-1',
        runId: RUN_ID,
        cursor: 6,
        onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error),
      },
      runtime,
    );
    await settle();

    expect(errors).toEqual([]);
    expect(timers.scheduled[0]?.delay).toBe(250);
    timers.runNext();
    await settle();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get('Last-Event-ID')).toBe('9');
    expect(events).toEqual([{ type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID }, expected]);
  });

  test('reports disabled and 404 endpoints as a typed unavailable capability', async () => {
    const { runtime, timers } = createRuntime([
      new Response(JSON.stringify({ code: 'INTELLIGENCE_AG_UI_DISABLED' }), { status: 404 }),
    ]);
    const errors: Error[] = [];
    let closed = 0;
    __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project-1',
        runId: RUN_ID,
        onEvent: () => {},
        onError: (error) => errors.push(error),
        onClosed: () => {
          closed += 1;
        },
      },
      runtime,
    );
    await settle();

    expect(errors[0]).toBeInstanceOf(IntelligenceAgUiUnavailableError);
    expect(closed).toBe(1);
    expect(timers.scheduled).toEqual([]);
  });

  test('close aborts an in-flight subscription, clears retries, and notifies once', async () => {
    const pendingResponse = {} as { resolve(response: Response): void };
    const response = new Promise<Response>((resolve) => {
      pendingResponse.resolve = resolve;
    });
    const timers = new FakeTimers();
    const runtime: IntelligenceAgUiSubscriptionTestRuntime = {
      baseUrl: 'https://api.example.test/v1',
      request: async () => response,
      timers,
    };
    let closed = 0;
    const subscription = __subscribeIntelligenceAgUiForTests(
      {
        projectId: 'project-1',
        runId: RUN_ID,
        onEvent: () => {},
        onError: () => {},
        onClosed: () => {
          closed += 1;
        },
      },
      runtime,
    );
    await settle();
    subscription.close();
    pendingResponse.resolve(
      streamResponse(eventFrame(1, { type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID })),
    );
    await settle();

    expect(closed).toBe(1);
    expect(timers.scheduled).toEqual([]);
  });
});
