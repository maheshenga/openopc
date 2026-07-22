import { type ClientRequest, createServer, request as requestHttp } from 'node:http';
import { type Socket, connect as connectTcp, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';
import type { BrowserOriginGuard, ResolvedBrowserTarget } from './origin-guard';

export type PinnedConnector = (input: { host: string; port: number }) => Duplex;

export async function openPinnedUpstream(
  url: string,
  policy: BrowserPolicy,
  guard: BrowserOriginGuard,
  connect: PinnedConnector = ({ host, port }) => connectTcp({ host, port }),
): Promise<Duplex> {
  const target = await guard.resolve(url, policy);
  if (target === null) throw new Error('proxy target is not allowed');
  return connect({ host: target.address, port: target.port });
}

export interface BrowserNetworkProxy {
  readonly serverUrl: string;
  close(): Promise<void>;
}

function originalHost(target: ResolvedBrowserTarget): string {
  const defaultPort = target.protocol === 'https:' ? 443 : 80;
  const hostname = isIP(target.hostname) === 6 ? `[${target.hostname}]` : target.hostname;
  return target.port === defaultPort ? hostname : `${hostname}:${target.port}`;
}

function connectUrl(authority: string): string | null {
  try {
    const parsed = new URL(`https://${authority}/`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export async function startBrowserNetworkProxy(input: {
  guard: BrowserOriginGuard;
  policy: BrowserPolicy;
  connector?: PinnedConnector;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  resolveTimeoutMs?: number;
}): Promise<BrowserNetworkProxy> {
  const connector = input.connector ?? (({ host, port }) => connectTcp({ host, port }));
  const connectTimeoutMs = input.connectTimeoutMs ?? 10_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 30_000;
  const idleTimeoutMs = input.idleTimeoutMs ?? requestTimeoutMs;
  const resolveTimeoutMs = input.resolveTimeoutMs ?? connectTimeoutMs;
  const openNetworkExpiresAt =
    input.policy.network_mode === 'open' && input.policy.open_network_expires_at !== null
      ? Date.parse(input.policy.open_network_expires_at)
      : null;
  if (
    !Number.isSafeInteger(connectTimeoutMs) ||
    connectTimeoutMs < 1 ||
    connectTimeoutMs > 2_147_483_647
  ) {
    throw new Error('proxy connect timeout must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 2_147_483_647
  ) {
    throw new Error('proxy request timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 2_147_483_647) {
    throw new Error('proxy idle timeout must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(resolveTimeoutMs) ||
    resolveTimeoutMs < 1 ||
    resolveTimeoutMs > 2_147_483_647
  ) {
    throw new Error('proxy resolve timeout must be a positive safe integer');
  }
  if (
    input.policy.network_mode === 'open' &&
    (openNetworkExpiresAt === null ||
      !Number.isFinite(openNetworkExpiresAt) ||
      openNetworkExpiresAt <= Date.now())
  ) {
    throw new Error('open-network proxy grant is expired');
  }
  const clientSockets = new Set<Socket>();
  const outboundRequests = new Set<ClientRequest>();
  const upstreamSockets = new Set<Duplex>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let openNetworkExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  const closingToken = Symbol('proxy-closing');
  let signalClosing: (() => void) | undefined;
  const closingSignal = new Promise<typeof closingToken>((resolve) => {
    signalClosing = () => resolve(closingToken);
  });
  const whileOpen = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await Promise.race([operation, closingSignal]);
    if (result === closingToken) throw new Error('proxy is closing');
    return result;
  };
  const whileClientOpen = async <T>(
    operation: Promise<T>,
    client: Duplex,
    subscribeAbort?: (listener: () => void) => () => void,
  ): Promise<T> => {
    const clientClosedToken = Symbol('proxy-client-closed');
    const resolveTimedOutToken = Symbol('proxy-resolve-timed-out');
    let resolveClientClosed: ((value: typeof clientClosedToken) => void) | undefined;
    const clientClosed = new Promise<typeof clientClosedToken>((resolve) => {
      resolveClientClosed = resolve;
    });
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    const resolveTimedOut = new Promise<typeof resolveTimedOutToken>((resolve) => {
      resolveTimer = setTimeout(() => resolve(resolveTimedOutToken), resolveTimeoutMs);
    });
    const signalClientClosed = () => resolveClientClosed?.(clientClosedToken);
    client.once('close', signalClientClosed);
    client.once('end', signalClientClosed);
    const unsubscribeAbort = subscribeAbort?.(signalClientClosed);
    try {
      if (client.destroyed) throw new Error('proxy client is closed');
      const result = await Promise.race([whileOpen(operation), clientClosed, resolveTimedOut]);
      if (result === resolveTimedOutToken) throw new Error('proxy target resolution timed out');
      if (result === clientClosedToken || client.destroyed) {
        throw new Error('proxy client is closed');
      }
      return result;
    } finally {
      client.off('close', signalClientClosed);
      client.off('end', signalClientClosed);
      if (resolveTimer !== undefined) clearTimeout(resolveTimer);
      unsubscribeAbort?.();
    }
  };
  const trackClient = (socket: Socket): void => {
    clientSockets.add(socket);
    socket.once('close', () => clientSockets.delete(socket));
  };
  const trackUpstream = (socket: Duplex): void => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  };
  const server = createServer(async (request, response) => {
    try {
      if (closing) throw new Error('proxy is closing');
      if (request.url === undefined) throw new Error('proxy request URL is missing');
      const target = await whileClientOpen(
        input.guard.resolve(request.url, input.policy),
        request.socket,
        (listener) => {
          request.once('aborted', listener);
          return () => request.off('aborted', listener);
        },
      );
      if (closing) throw new Error('proxy is closing');
      if (target === null || target.protocol !== 'http:') {
        response.writeHead(403).end();
        return;
      }
      const upstream = requestHttp({
        headers: { ...request.headers, connection: 'close', host: originalHost(target) },
        host: target.address,
        method: request.method,
        path: new URL(target.url).pathname + new URL(target.url).search,
        port: target.port,
      });
      outboundRequests.add(upstream);
      upstream.once('close', () => outboundRequests.delete(upstream));
      upstream.once('socket', trackUpstream);
      const headerTimer = setTimeout(() => {
        if (!response.headersSent) response.writeHead(504);
        response.end();
        upstream.destroy();
        upstream.socket?.destroy();
      }, requestTimeoutMs);
      const clearHeaderTimer = () => clearTimeout(headerTimer);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdleTimeout = () => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      };
      const destroyUpstream = () => {
        clearHeaderTimer();
        clearIdleTimeout();
        upstream.destroy();
        upstream.socket?.destroy();
      };
      const armIdleTimeout = () => {
        clearIdleTimeout();
        idleTimer = setTimeout(() => {
          if (!response.headersSent) response.writeHead(504);
          response.end();
          destroyUpstream();
        }, idleTimeoutMs);
      };
      upstream.on('response', (upstreamResponse) => {
        clearHeaderTimer();
        armIdleTimeout();
        upstreamResponse.on('data', armIdleTimeout);
        upstreamResponse.once('end', clearIdleTimeout);
        upstreamResponse.once('close', clearIdleTimeout);
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => {
        clearHeaderTimer();
        clearIdleTimeout();
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.once('aborted', destroyUpstream);
      request.once('error', destroyUpstream);
      request.socket.once('close', destroyUpstream);
      response.once('finish', () => {
        clearHeaderTimer();
        clearIdleTimeout();
        request.socket.off('close', destroyUpstream);
      });
      response.once('close', () => {
        if (!response.writableEnded) destroyUpstream();
      });
      request.pipe(upstream);
    } catch {
      if (!response.headersSent) response.writeHead(403);
      response.end();
    }
  });
  server.on('connection', trackClient);

  server.on('connect', async (request, client, head) => {
    try {
      if (closing) throw new Error('proxy is closing');
      const url = request.url === undefined ? null : connectUrl(request.url);
      if (url === null) throw new Error('invalid CONNECT authority');
      const pendingClientData: Buffer[] = [];
      let pendingClientBytes = 0;
      const bufferClientData = (chunk: Buffer) => {
        pendingClientBytes += chunk.byteLength;
        if (pendingClientBytes > 64 * 1024) {
          client.destroy(new Error('CONNECT pre-resolution data limit exceeded'));
          return;
        }
        pendingClientData.push(chunk);
      };
      // CONNECT sockets are paused by default. Buffer bounded early tunnel bytes so a
      // disconnect remains observable while origin resolution is still pending.
      client.on('data', bufferClientData);
      client.resume();
      let target: ResolvedBrowserTarget | null;
      try {
        target = await whileClientOpen(input.guard.resolve(url, input.policy), client);
      } finally {
        client.pause();
        client.off('data', bufferClientData);
      }
      if (closing) throw new Error('proxy is closing');
      if (target === null || target.protocol !== 'https:') throw new Error('CONNECT denied');
      const upstream = connector({ host: target.address, port: target.port });
      trackUpstream(upstream);
      const socket = upstream as Socket;
      let established = false;
      let timedOut = false;
      const connectTimer = setTimeout(() => {
        if (established || timedOut) return;
        timedOut = true;
        client.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n', () => client.destroy());
        upstream.destroy();
      }, connectTimeoutMs);
      const clearConnectTimer = () => clearTimeout(connectTimer);
      const clearIdleTimeout = () => {
        if (typeof socket.setTimeout === 'function') socket.setTimeout(0);
      };
      const establish = () => {
        clearConnectTimer();
        if (established || timedOut || closing || client.destroyed || upstream.destroyed) {
          upstream.destroy();
          client.destroy();
          return;
        }
        established = true;
        if (typeof socket.setTimeout === 'function') {
          socket.setTimeout(idleTimeoutMs, () => {
            upstream.destroy();
            client.destroy();
          });
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.byteLength > 0) upstream.write(head);
        for (const chunk of pendingClientData) upstream.write(chunk);
        client.pipe(upstream).pipe(client);
      };
      upstream.once('error', () => {
        clearConnectTimer();
        clearIdleTimeout();
        client.destroy();
      });
      client.once('error', () => {
        clearConnectTimer();
        clearIdleTimeout();
        upstream.destroy();
      });
      upstream.once('close', () => {
        clearConnectTimer();
        clearIdleTimeout();
        if (established || !timedOut) client.destroy();
      });
      client.once('close', () => {
        clearConnectTimer();
        clearIdleTimeout();
        upstream.destroy();
      });
      if (socket.connecting) socket.once('connect', establish);
      else establish();
    } catch {
      if (closing) client.destroy();
      else client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  server.headersTimeout = requestTimeoutMs;
  server.requestTimeout = requestTimeoutMs;

  const closeProxy = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    signalClosing?.();
    if (openNetworkExpiryTimer !== undefined) clearTimeout(openNetworkExpiryTimer);
    closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      for (const request of outboundRequests) request.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      for (const socket of clientSockets) socket.destroy();
      server.closeAllConnections();
    });
    return closePromise;
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('proxy failed to bind a TCP address');
  }
  if (openNetworkExpiresAt !== null) {
    const scheduleExpiry = (): void => {
      const remainingMs = openNetworkExpiresAt - Date.now();
      if (remainingMs <= 0) {
        void closeProxy().catch(() => undefined);
        return;
      }
      openNetworkExpiryTimer = setTimeout(scheduleExpiry, Math.min(remainingMs, 2_147_483_647));
    };
    scheduleExpiry();
  }
  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    close: closeProxy,
  };
}
