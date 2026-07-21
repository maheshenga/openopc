import { type OpenOpcAgUiEvent, OpenOpcAgUiEventSchema } from '@kortix/intelligence-contracts';
import { buildAuthHeaders } from '../../platform/auth-core';
import { getAuthTokenWithRetry } from '../http/auth';
import { platformConfig } from '../http/config';
import { getIntelligenceAgUiWorkflowStreamUrl } from '../rest/projects-client/intelligence';

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const MAX_EVENT_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface IntelligenceAgUiSubscription {
  close(): void;
}

export interface SubscribeIntelligenceAgUiInput {
  projectId: string;
  runId: string;
  cursor?: number | null;
  onEvent(event: OpenOpcAgUiEvent): void;
  onError(error: Error): void;
  onClosed?(): void;
}

export class IntelligenceAgUiUnavailableError extends Error {
  readonly code = 'INTELLIGENCE_AG_UI_UNAVAILABLE';

  constructor(readonly status = 404) {
    super('Intelligence AG-UI stream is unavailable');
    this.name = 'IntelligenceAgUiUnavailableError';
  }
}

export class IntelligenceAgUiProtocolError extends Error {
  readonly code = 'INTELLIGENCE_AG_UI_PROTOCOL_ERROR';

  constructor() {
    super('Intelligence AG-UI stream returned an invalid event');
    this.name = 'IntelligenceAgUiProtocolError';
  }
}

export function isIntelligenceAgUiUnavailableError(
  error: unknown,
): error is IntelligenceAgUiUnavailableError {
  return error instanceof IntelligenceAgUiUnavailableError;
}

type IntelligenceAgUiRequest = {
  url: string;
  headers: Headers;
  signal: AbortSignal;
};

type IntelligenceAgUiTimers = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** @internal Dependency seam used by focused transport tests. */
export type IntelligenceAgUiSubscriptionTestRuntime = {
  baseUrl: string;
  request(input: IntelligenceAgUiRequest): Promise<Response>;
  timers: IntelligenceAgUiTimers;
};

const runtimeTimers: IntelligenceAgUiTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function requestAgUiStream(input: IntelligenceAgUiRequest): Promise<Response> {
  const token = await getAuthTokenWithRetry();
  if (!token) return new Response(null, { status: 401 });
  const headers = buildAuthHeaders(input.url, { headers: input.headers }, token);
  return fetch(input.url, {
    headers,
    signal: input.signal,
    credentials: 'omit',
    cache: 'no-store',
  });
}

function defaultRuntime(): IntelligenceAgUiSubscriptionTestRuntime {
  return {
    baseUrl: platformConfig().backendUrl,
    request: requestAgUiStream,
    timers: runtimeTimers,
  };
}

export function subscribeIntelligenceAgUi(
  input: SubscribeIntelligenceAgUiInput,
): IntelligenceAgUiSubscription {
  return subscribe(input, defaultRuntime());
}

/** @internal Dependency-injected stream entry point for focused tests. */
export function __subscribeIntelligenceAgUiForTests(
  input: SubscribeIntelligenceAgUiInput,
  runtime: IntelligenceAgUiSubscriptionTestRuntime,
): IntelligenceAgUiSubscription {
  return subscribe(input, runtime);
}

function subscribe(
  input: SubscribeIntelligenceAgUiInput,
  runtime: IntelligenceAgUiSubscriptionTestRuntime,
): IntelligenceAgUiSubscription {
  let lastEventId = parseSequence(input.cursor ?? 0);
  let stopped = false;
  let closedNotified = false;
  let reconnectTimer: unknown;
  let activeRequest: AbortController | null = null;
  let reconnectAttempt = 0;

  const close = () => {
    if (stopped) return;
    stopped = true;
    activeRequest?.abort();
    activeRequest = null;
    if (reconnectTimer !== undefined) runtime.timers.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (closedNotified) return;
    closedNotified = true;
    try {
      input.onClosed?.();
    } catch {}
  };

  const report = (error: Error) => {
    try {
      input.onError(error);
    } catch {}
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== undefined) return;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectAttempt += 1;
    reconnectTimer = runtime.timers.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (stopped) return;
    const controller = new AbortController();
    activeRequest = controller;
    try {
      const response = await runtime.request({
        url: getIntelligenceAgUiWorkflowStreamUrl(input.projectId, input.runId, runtime.baseUrl),
        headers: new Headers({
          Accept: 'text/event-stream',
          'Last-Event-ID': String(lastEventId),
        }),
        signal: controller.signal,
      });
      if (stopped) return;
      if (response.status === 404) {
        report(new IntelligenceAgUiUnavailableError(response.status));
        close();
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error('Intelligence AG-UI stream request failed');
      }
      const result = await consumeAgUiStream(
        response.body,
        controller.signal,
        (event, sequence) => {
          lastEventId = sequence;
          try {
            input.onEvent(event);
          } catch {}
        },
      );
      if (stopped) return;
      if (result.terminal) {
        close();
        return;
      }
      if (result.delivered) reconnectAttempt = 0;
      scheduleReconnect();
    } catch (error) {
      if (stopped) return;
      controller.abort();
      report(asError(error));
      scheduleReconnect();
    } finally {
      if (activeRequest === controller) activeRequest = null;
    }
  };

  void connect();
  return { close };
}

async function consumeAgUiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: OpenOpcAgUiEvent, sequence: number) => void,
): Promise<{ delivered: boolean; terminal: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let delivered = false;
  const cancel = () => {
    void reader.cancel();
  };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const result = drainFrames(buffer, onEvent);
      buffer = result.remainder;
      delivered ||= result.delivered;
      if (result.terminal) return { delivered, terminal: true };
    }
    buffer += decoder.decode();
    const result = drainFrames(buffer, onEvent, true);
    return { delivered: delivered || result.delivered, terminal: result.terminal };
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function drainFrames(
  input: string,
  onEvent: (event: OpenOpcAgUiEvent, sequence: number) => void,
  flush = false,
): { remainder: string; delivered: boolean; terminal: boolean } {
  let remainder = input;
  let delivered = false;
  while (true) {
    const boundary = remainder.match(/\r?\n\r?\n/);
    if (!boundary || boundary.index === undefined) break;
    const frame = remainder.slice(0, boundary.index);
    remainder = remainder.slice(boundary.index + boundary[0].length);
    const event = parseFrame(frame);
    if (!event) continue;
    delivered = true;
    onEvent(event.value, event.sequence);
    if (event.value.type === 'RUN_FINISHED' || event.value.type === 'RUN_ERROR') {
      return { remainder, delivered, terminal: true };
    }
  }
  if (!flush || remainder.trim() === '') return { remainder, delivered, terminal: false };
  const event = parseFrame(remainder);
  if (!event) return { remainder: '', delivered, terminal: false };
  onEvent(event.value, event.sequence);
  return {
    remainder: '',
    delivered: true,
    terminal: event.value.type === 'RUN_FINISHED' || event.value.type === 'RUN_ERROR',
  };
}

function parseFrame(frame: string): { sequence: number; value: OpenOpcAgUiEvent } | null {
  if (frame.split(/\r?\n/).every((line) => line === '' || line.startsWith(':'))) return null;
  let id: string | null = null;
  let type: string | null = null;
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    if (separator < 0) continue;
    const key = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1).replace(/^ /, '');
    if (key === 'id') id = value;
    if (key === 'event') type = value;
    if (key === 'data') data.push(value);
  }
  if (!id || !type || data.length === 0) throw new IntelligenceAgUiProtocolError();
  const sequence = parseSequence(id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch {
    throw new IntelligenceAgUiProtocolError();
  }
  const event = OpenOpcAgUiEventSchema.safeParse(parsed);
  if (!event.success || event.data.type !== type) throw new IntelligenceAgUiProtocolError();
  return { sequence, value: event.data };
}

function parseSequence(value: unknown): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d{1,16}$/.test(String(value))
  ) {
    throw new IntelligenceAgUiProtocolError();
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_EVENT_SEQUENCE) {
    throw new IntelligenceAgUiProtocolError();
  }
  return sequence;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Intelligence AG-UI stream failed');
}
