import { createServer, request as requestHttp } from 'node:http';
import { type Socket, connect as connectTcp } from 'node:net';
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
  return target.port === defaultPort ? target.hostname : `${target.hostname}:${target.port}`;
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
}): Promise<BrowserNetworkProxy> {
  const connector = input.connector ?? (({ host, port }) => connectTcp({ host, port }));
  const server = createServer(async (request, response) => {
    try {
      if (request.url === undefined) throw new Error('proxy request URL is missing');
      const target = await input.guard.resolve(request.url, input.policy);
      if (target === null || target.protocol !== 'http:') {
        response.writeHead(403).end();
        return;
      }
      const upstream = requestHttp({
        headers: { ...request.headers, host: originalHost(target) },
        host: target.address,
        method: request.method,
        path: new URL(target.url).pathname + new URL(target.url).search,
        port: target.port,
      });
      upstream.on('response', (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    } catch {
      if (!response.headersSent) response.writeHead(403);
      response.end();
    }
  });

  server.on('connect', async (request, client, head) => {
    try {
      const url = request.url === undefined ? null : connectUrl(request.url);
      if (url === null) throw new Error('invalid CONNECT authority');
      const target = await input.guard.resolve(url, input.policy);
      if (target === null || target.protocol !== 'https:') throw new Error('CONNECT denied');
      const upstream = connector({ host: target.address, port: target.port });
      const establish = () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.byteLength > 0) upstream.write(head);
        client.pipe(upstream).pipe(client);
      };
      const socket = upstream as Socket;
      if (socket.connecting) socket.once('connect', establish);
      else establish();
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });

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
  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
