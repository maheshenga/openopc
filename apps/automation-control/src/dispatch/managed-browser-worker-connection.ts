import type { BrowserWorkerConnection } from './browser-dispatcher';
import {
  BrowserWorkerConnectionError,
  type BrowserWorkerConnectionState,
  type ObservableBrowserWorkerConnection,
} from './browser-worker-connection';
import type { VerifiedWorkerPeer } from './worker-auth';

type DispatchSendInput = Parameters<BrowserWorkerConnection['send']>[0];
type DispatchSendResult = Awaited<ReturnType<BrowserWorkerConnection['send']>>;

export type ManagedBrowserWorkerConnection = BrowserWorkerConnection &
  Readonly<{
    isReady(): boolean;
    close(reason?: string): void;
  }>;

type ReconnectTimer = {
  handle: unknown;
};

export function createManagedBrowserWorkerConnection(input: {
  peer: VerifiedWorkerPeer;
  connect(): ObservableBrowserWorkerConnection;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  initialBackoffMs: number;
  maxBackoffMs: number;
}): ManagedBrowserWorkerConnection {
  const maxBackoffMs = Math.min(input.maxBackoffMs, 5_000);
  let closed = false;
  let ready = false;
  let backoffMs = input.initialBackoffMs;
  let reconnectTimer: ReconnectTimer | undefined;
  let owned:
    | {
        connection: ObservableBrowserWorkerConnection;
        unsubscribe(): void;
      }
    | undefined;

  const disposeOwned = (reason: string): void => {
    const current = owned;
    owned = undefined;
    ready = false;
    if (current === undefined) return;
    current.unsubscribe();
    current.connection.close(reason);
  };

  const scheduleReconnect = (): void => {
    ready = false;
    if (closed || reconnectTimer !== undefined) return;
    const delayMs = Math.min(backoffMs, maxBackoffMs);
    backoffMs = Math.min(delayMs * 2, maxBackoffMs);
    const timer: ReconnectTimer = { handle: undefined };
    reconnectTimer = timer;
    timer.handle = input.schedule(() => {
      if (closed || reconnectTimer !== timer) return;
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  };

  const observe = (
    connection: ObservableBrowserWorkerConnection,
    state: BrowserWorkerConnectionState,
  ): void => {
    if (closed || owned?.connection !== connection) return;
    ready = state === 'ready';
    if (state === 'ready') {
      backoffMs = input.initialBackoffMs;
    } else if (state === 'unusable') {
      scheduleReconnect();
    }
  };

  function connect(): void {
    if (closed) return;
    disposeOwned('Browser Worker connection replaced');
    let connection: ObservableBrowserWorkerConnection;
    try {
      connection = input.connect();
    } catch {
      scheduleReconnect();
      return;
    }
    if (connection.peer !== input.peer) {
      connection.close('Browser Worker peer mismatch');
      scheduleReconnect();
      return;
    }
    let unsubscribe = (): void => {};
    owned = {
      connection,
      unsubscribe: () => unsubscribe(),
    };
    unsubscribe = connection.subscribe((state) => observe(connection, state));
    observe(connection, connection.state());
  }

  connect();

  return Object.freeze({
    peer: input.peer,
    isReady: () => !closed && ready,
    async send(raw: DispatchSendInput): Promise<DispatchSendResult> {
      const current = owned?.connection;
      if (closed || !ready || current === undefined) {
        throw new BrowserWorkerConnectionError(
          'Browser Worker connection is unavailable',
          'unavailable',
        );
      }
      try {
        return await current.send(raw);
      } catch (error) {
        if (
          !closed &&
          owned?.connection === current &&
          error instanceof BrowserWorkerConnectionError &&
          (error.reason === 'unavailable' || error.reason === 'unknown_result')
        ) {
          disposeOwned('Browser Worker dispatch connection discarded');
          scheduleReconnect();
        }
        throw error;
      }
    },
    close(reason = 'Browser Worker connection manager closed') {
      if (closed) return;
      closed = true;
      ready = false;
      const timer = reconnectTimer;
      reconnectTimer = undefined;
      if (timer !== undefined) input.cancel(timer.handle);
      disposeOwned(reason);
    },
  });
}
