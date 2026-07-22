import { isAbsolute } from 'node:path';
import {
  AUTOMATION_BROWSER_DISPATCH_PATH,
  AutomationBrowserDispatchAcceptedSchema,
  AutomationBrowserDispatchRequestSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type { AutomationBrowserDispatchConfig } from '../config';
import type { BrowserWorkerConnection } from './browser-dispatcher';
import type { VerifiedWorkerPeer } from './worker-auth';

type BrowserDispatchSocket = Readonly<{
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: EventListenerOrEventListenerObject,
  ): void;
}>;

export type BrowserDispatchWebSocketFactory = (
  url: string | URL,
  options: Bun.WebSocketOptions,
) => BrowserDispatchSocket;

export type BrowserWorkerConnectionFailureReason =
  | 'configuration'
  | 'in_flight'
  | 'unavailable'
  | 'unknown_result';

export class BrowserWorkerConnectionError extends Error {
  override readonly name = 'BrowserWorkerConnectionError';

  constructor(
    message: string,
    readonly reason: BrowserWorkerConnectionFailureReason,
  ) {
    super(message);
  }
}

type EnabledDispatchConfig = Extract<AutomationBrowserDispatchConfig, { enabled: true }>;
type DispatchSendInput = Parameters<BrowserWorkerConnection['send']>[0];
type DispatchSendResult = Awaited<ReturnType<BrowserWorkerConnection['send']>>;

function endpointFor(config: EnabledDispatchConfig): URL {
  let base: URL;
  try {
    base = new URL(config.workerUrl);
  } catch {
    throw new BrowserWorkerConnectionError(
      'Browser Worker connection configuration is invalid',
      'configuration',
    );
  }
  if (
    base.protocol !== 'wss:' ||
    base.username !== '' ||
    base.password !== '' ||
    base.pathname !== '/' ||
    base.search !== '' ||
    base.hash !== '' ||
    !isAbsolute(config.mtlsCertificatePath) ||
    !isAbsolute(config.mtlsPrivateKeyPath) ||
    !isAbsolute(config.mtlsCaPath) ||
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 100 ||
    config.requestTimeoutMs > 30_000 ||
    !Number.isSafeInteger(config.maxMessageBytes) ||
    config.maxMessageBytes < 1_024 ||
    config.maxMessageBytes > 1024 * 1024
  ) {
    throw new BrowserWorkerConnectionError(
      'Browser Worker connection configuration is invalid',
      'configuration',
    );
  }
  return new URL(AUTOMATION_BROWSER_DISPATCH_PATH, base);
}

function connectionError(
  reason: BrowserWorkerConnectionFailureReason,
): BrowserWorkerConnectionError {
  if (reason === 'in_flight') {
    return new BrowserWorkerConnectionError(
      'Browser Worker connection already has an in-flight dispatch',
      reason,
    );
  }
  if (reason === 'unknown_result') {
    return new BrowserWorkerConnectionError('Browser Worker dispatch result is unknown', reason);
  }
  return new BrowserWorkerConnectionError('Browser Worker connection is unavailable', reason);
}

export function createBrowserWorkerConnection(input: {
  config: AutomationBrowserDispatchConfig;
  peer: VerifiedWorkerPeer;
  webSocketFactory?: BrowserDispatchWebSocketFactory;
}): BrowserWorkerConnection & Readonly<{ close(reason?: string): void }> {
  if (!input.config.enabled) {
    throw new BrowserWorkerConnectionError(
      'Browser Worker connection is not enabled',
      'configuration',
    );
  }
  const config = input.config;
  const endpoint = endpointFor(config);
  const webSocketFactory =
    input.webSocketFactory ??
    ((url: string | URL, options: Bun.WebSocketOptions) => {
      const BunWebSocket = WebSocket as unknown as {
        new (target: string | URL, init: Bun.WebSocketOptions): WebSocket;
      };
      return new BunWebSocket(url, options);
    });
  const socket = webSocketFactory(endpoint, {
    tls: {
      cert: Bun.file(config.mtlsCertificatePath),
      key: Bun.file(config.mtlsPrivateKeyPath),
      ca: Bun.file(config.mtlsCaPath),
      rejectUnauthorized: true,
      serverName: endpoint.hostname,
    },
    perMessageDeflate: false,
  });
  let open = socket.readyState === WebSocket.OPEN;
  let unusable = socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED;
  let inFlight:
    | {
        body: string;
        timer: ReturnType<typeof setTimeout>;
        resolve: (value: DispatchSendResult) => void;
        reject: (reason: BrowserWorkerConnectionError) => void;
      }
    | undefined;

  const closeSocket = (code: number, reason: string): void => {
    try {
      socket.close(code, reason);
    } catch {
      // The connection is already unusable; closing is best-effort only.
    }
  };
  const failUnknown = (): void => {
    unusable = true;
    open = false;
    const pending = inFlight;
    inFlight = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(connectionError('unknown_result'));
    }
    closeSocket(1011, 'dispatch result unknown');
  };
  const transmit = (): void => {
    if (!open || unusable || inFlight === undefined) return;
    try {
      socket.send(inFlight.body);
    } catch {
      failUnknown();
    }
  };

  socket.addEventListener('open', () => {
    if (unusable) {
      closeSocket(1008, 'connection unavailable');
      return;
    }
    open = true;
    transmit();
  });
  socket.addEventListener('message', (event) => {
    const pending = inFlight;
    const data = (event as MessageEvent<unknown>).data;
    if (
      pending === undefined ||
      typeof data !== 'string' ||
      new TextEncoder().encode(data).byteLength > config.maxMessageBytes
    ) {
      failUnknown();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      failUnknown();
      return;
    }
    const accepted = AutomationBrowserDispatchAcceptedSchema.safeParse(raw);
    if (!accepted.success) {
      failUnknown();
      return;
    }
    clearTimeout(pending.timer);
    inFlight = undefined;
    pending.resolve({ receipt: accepted.data.receipt, proof: accepted.data.proof });
  });
  socket.addEventListener('error', failUnknown);
  socket.addEventListener('close', failUnknown);

  return Object.freeze({
    peer: input.peer,
    send(raw: DispatchSendInput): Promise<DispatchSendResult> {
      if (unusable) return Promise.reject(connectionError('unavailable'));
      if (inFlight !== undefined) return Promise.reject(connectionError('in_flight'));
      const dispatch = AutomationBrowserDispatchRequestSchema.safeParse({
        protocol_version: 'automation.v1',
        envelope: raw.envelope,
        proof: raw.proof,
      });
      if (!dispatch.success) {
        return Promise.reject(
          new BrowserWorkerConnectionError(
            'Browser Worker dispatch request is invalid',
            'configuration',
          ),
        );
      }
      const body = canonicalAutomationRequestJson(dispatch.data);
      if (new TextEncoder().encode(body).byteLength > config.maxMessageBytes) {
        return Promise.reject(
          new BrowserWorkerConnectionError(
            'Browser Worker dispatch request is too large',
            'configuration',
          ),
        );
      }
      return new Promise<DispatchSendResult>((resolve, reject) => {
        const timer = setTimeout(failUnknown, config.requestTimeoutMs);
        inFlight = { body, timer, resolve, reject };
        transmit();
      });
    },
    close(reason = 'Browser Worker connection closed') {
      if (unusable) return;
      if (inFlight !== undefined) {
        failUnknown();
        return;
      }
      unusable = true;
      open = false;
      closeSocket(1000, reason.slice(0, 123));
    },
  });
}

export function createConfiguredBrowserWorkerConnection(input: {
  config: AutomationBrowserDispatchConfig;
  peer: VerifiedWorkerPeer;
  webSocketFactory?: BrowserDispatchWebSocketFactory;
}): ReturnType<typeof createBrowserWorkerConnection> | undefined {
  if (!input.config.enabled) return undefined;
  return createBrowserWorkerConnection(input);
}
