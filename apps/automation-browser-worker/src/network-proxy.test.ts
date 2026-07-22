import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { type Socket, connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { PassThrough } from 'node:stream';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';
import { openPinnedUpstream, startBrowserNetworkProxy } from './network-proxy';
import type { BrowserOriginGuard } from './origin-guard';

const policy: BrowserPolicy = {
  allowed_origins: ['https://console.example.test'],
  network_mode: 'allowlist',
  open_network_expires_at: null,
  context: { mode: 'temporary', profile_id: null },
};

test('opens the upstream socket to the single validated IP without a second DNS lookup', async () => {
  let resolutions = 0;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      resolutions += 1;
      return resolutions === 1
        ? {
            address: '93.184.216.34',
            hostname: 'console.example.test',
            port: 443,
            protocol: 'https:',
            url,
          }
        : null;
    },
  };
  const connections: Array<{ host: string; port: number }> = [];

  const upstream = await openPinnedUpstream(
    'https://console.example.test/workflows',
    policy,
    guard,
    ({ host, port }) => {
      connections.push({ host, port });
      return new PassThrough();
    },
  );

  expect(upstream).toBeInstanceOf(PassThrough);
  expect(resolutions).toBe(1);
  expect(connections).toEqual([{ host: '93.184.216.34', port: 443 }]);
});

test('destroys the real HTTP upstream request and socket when the proxy client closes', async () => {
  let upstreamRequestDestroyed = false;
  let upstreamSocket: Socket | undefined;
  let markRequestSeen: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve;
  });
  const upstreamServer = createHttpServer((request) => {
    upstreamSocket = request.socket;
    request.once('close', () => {
      upstreamRequestDestroyed = request.destroyed;
    });
    markRequestSeen?.();
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('HTTP test upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '127.0.0.1',
      hostname: 'public.example.test',
      port: upstreamAddress.port,
      protocol: 'http:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      `POST http://public.example.test:${upstreamAddress.port}/slow HTTP/1.1\r\nHost: public.example.test:${upstreamAddress.port}\r\nContent-Length: 1024\r\n\r\nx`,
    );
    await requestSeen;
    if (upstreamSocket === undefined) throw new Error('HTTP test upstream socket was not captured');
    const upstreamClosed = once(upstreamSocket, 'close');

    client.destroy();
    await Promise.race([
      upstreamClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HTTP upstream socket remained open')), 250),
      ),
    ]);

    expect(upstreamRequestDestroyed).toBeTrue();
    expect(upstreamSocket.destroyed).toBeTrue();
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('brackets an IPv6 literal in the forwarded HTTP Host header', async () => {
  let forwardedHost: string | undefined;
  let markRequestSeen: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve;
  });
  const upstreamServer = createHttpServer((request, response) => {
    forwardedHost = request.headers.host;
    response.writeHead(204).end();
    markRequestSeen?.();
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('IPv6 Host test upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '127.0.0.1',
      hostname: '2001:db8::1',
      port: upstreamAddress.port,
      protocol: 'http:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      `GET http://[2001:db8::1]:${upstreamAddress.port}/resource HTTP/1.1\r\n` +
        `Host: [2001:db8::1]:${upstreamAddress.port}\r\n\r\n`,
    );
    await requestSeen;

    expect(forwardedHost).toBe(`[2001:db8::1]:${upstreamAddress.port}`);
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('times out a stalled HTTP request and still closes promptly', async () => {
  let upstreamSocket: Socket | undefined;
  const upstreamServer = createHttpServer((request) => {
    upstreamSocket = request.socket;
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('HTTP timeout test upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '127.0.0.1',
      hostname: 'public.example.test',
      port: upstreamAddress.port,
      protocol: 'http:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    requestTimeoutMs: 10,
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    const response = once(client, 'data') as Promise<[Buffer]>;
    client.write(
      `GET http://public.example.test:${upstreamAddress.port}/slow HTTP/1.1\r\n` +
        `Host: public.example.test:${upstreamAddress.port}\r\n\r\n`,
    );
    const [data] = await Promise.race([
      response,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HTTP timeout response was not bounded')), 250),
      ),
    ]);

    expect(data.toString()).toContain('504 Gateway Timeout');
    const closing = proxy.close();
    await expect(
      Promise.race([
        closing,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('proxy close remained pending')), 250),
        ),
      ]),
    ).resolves.toBeUndefined();
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('does not open an HTTP upstream after close wins a pending resolution', async () => {
  let upstreamConnections = 0;
  const upstreamServer = createHttpServer();
  upstreamServer.on('connection', (socket) => {
    upstreamConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('HTTP close-race test upstream failed to bind');
  }
  let releaseResolution: (() => void) | undefined;
  const resolutionReleased = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  let markResolutionStarted: (() => void) | undefined;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      markResolutionStarted?.();
      await resolutionReleased;
      return {
        address: '127.0.0.1',
        hostname: 'public.example.test',
        port: upstreamAddress.port,
        protocol: 'http:',
        url,
      };
    },
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      `GET http://public.example.test:${upstreamAddress.port}/slow HTTP/1.1\r\n` +
        `Host: public.example.test:${upstreamAddress.port}\r\n\r\n`,
    );
    await resolutionStarted;
    const closing = proxy.close();
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseResolution?.();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closedPromptly).toBeTrue();
    expect(upstreamConnections).toBe(0);
  } finally {
    releaseResolution?.();
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('does not open an HTTP upstream after the client closes during resolution', async () => {
  let markUpstreamConnection: (() => void) | undefined;
  const upstreamConnection = new Promise<void>((resolve) => {
    markUpstreamConnection = resolve;
  });
  const upstreamServer = createHttpServer();
  upstreamServer.on('connection', (socket) => {
    markUpstreamConnection?.();
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('HTTP client-close race test upstream failed to bind');
  }
  let releaseResolution: (() => void) | undefined;
  const resolutionReleased = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  let markResolutionStarted: (() => void) | undefined;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      markResolutionStarted?.();
      await resolutionReleased;
      return {
        address: '127.0.0.1',
        hostname: 'public.example.test',
        port: upstreamAddress.port,
        protocol: 'http:',
        url,
      };
    },
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      `GET http://public.example.test:${upstreamAddress.port}/slow HTTP/1.1\r\n` +
        `Host: public.example.test:${upstreamAddress.port}\r\n\r\n`,
    );
    await resolutionStarted;
    const clientClosed = once(client, 'close');
    client.destroy();
    await clientClosed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseResolution?.();

    const opened = await Promise.race([
      upstreamConnection.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(opened).toBeFalse();
  } finally {
    releaseResolution?.();
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('closes active CONNECT client and upstream sockets without hanging', async () => {
  let upstream: PassThrough | undefined;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '93.184.216.34',
      hostname: 'console.example.test',
      port: 443,
      protocol: 'https:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    connector: () => {
      upstream = new PassThrough();
      return upstream;
    },
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  await once(client, 'connect');
  client.write(
    'CONNECT console.example.test:443 HTTP/1.1\r\nHost: console.example.test:443\r\n\r\n',
  );
  const [response] = (await once(client, 'data')) as [Buffer];
  expect(response.toString()).toContain('200 Connection Established');

  const closing = proxy.close();
  const closedPromptly = await Promise.race([
    closing.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  client.destroy();
  upstream?.destroy();
  await closing;

  expect(closedPromptly).toBeTrue();
  expect(client.destroyed).toBeTrue();
  expect(upstream?.destroyed).toBeTrue();
});

test('times out a stalled CONNECT attempt and still closes promptly', async () => {
  const upstream = new PassThrough() as PassThrough & { connecting: boolean };
  upstream.connecting = true;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '93.184.216.34',
      hostname: 'console.example.test',
      port: 443,
      protocol: 'https:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    connector: () => upstream,
    connectTimeoutMs: 10,
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    const response = once(client, 'data') as Promise<[Buffer]>;
    client.write(
      'CONNECT console.example.test:443 HTTP/1.1\r\nHost: console.example.test:443\r\n\r\n',
    );
    const [data] = await Promise.race([
      response,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CONNECT timeout response was not bounded')), 250),
      ),
    ]);

    expect(data.toString()).toContain('504 Gateway Timeout');
    expect(upstream.destroyed).toBeTrue();
    const closing = proxy.close();
    await expect(
      Promise.race([
        closing,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('proxy close remained pending')), 250),
        ),
      ]),
    ).resolves.toBeUndefined();
  } finally {
    client.destroy();
    upstream.destroy();
    await proxy.close();
  }
});

test('does not establish a CONNECT tunnel after its connect deadline fires', async () => {
  const upstream = new PassThrough() as PassThrough & { connecting: boolean };
  upstream.connecting = true;
  let upstreamWrites = 0;
  upstream.write = (() => {
    upstreamWrites += 1;
    return true;
  }) as typeof upstream.write;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '93.184.216.34',
      hostname: 'console.example.test',
      port: 443,
      protocol: 'https:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    connector: () => upstream,
    connectTimeoutMs: 10,
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    const response = once(client, 'data') as Promise<[Buffer]>;
    client.write(
      'CONNECT console.example.test:443 HTTP/1.1\r\n' +
        'Host: console.example.test:443\r\n\r\nearly tunnel bytes',
    );
    const [data] = await response;
    expect(data.toString()).toContain('504 Gateway Timeout');

    upstream.connecting = false;
    upstream.emit('connect');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamWrites).toBe(0);
  } finally {
    client.destroy();
    upstream.destroy();
    await proxy.close();
  }
});

test('does not open a CONNECT upstream after close wins a pending resolution', async () => {
  let releaseResolution: (() => void) | undefined;
  const resolutionReleased = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  let markResolutionStarted: (() => void) | undefined;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  let connections = 0;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      markResolutionStarted?.();
      await resolutionReleased;
      return {
        address: '93.184.216.34',
        hostname: 'console.example.test',
        port: 443,
        protocol: 'https:',
        url,
      };
    },
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    connector: () => {
      connections += 1;
      return new PassThrough();
    },
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      'CONNECT console.example.test:443 HTTP/1.1\r\nHost: console.example.test:443\r\n\r\n',
    );
    await resolutionStarted;
    const closing = proxy.close();
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseResolution?.();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closedPromptly).toBeTrue();
    expect(connections).toBe(0);
  } finally {
    releaseResolution?.();
    client.destroy();
    await proxy.close();
  }
});

test('does not open a CONNECT upstream after the client closes during resolution', async () => {
  let releaseResolution: (() => void) | undefined;
  const resolutionReleased = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  let markResolutionStarted: (() => void) | undefined;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  let connections = 0;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      markResolutionStarted?.();
      await resolutionReleased;
      return {
        address: '93.184.216.34',
        hostname: 'console.example.test',
        port: 443,
        protocol: 'https:',
        url,
      };
    },
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    connector: () => {
      connections += 1;
      return new PassThrough();
    },
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      'CONNECT console.example.test:443 HTTP/1.1\r\nHost: console.example.test:443\r\n\r\n',
    );
    await resolutionStarted;
    const clientClosed = once(client, 'close');
    client.destroy();
    await clientClosed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseResolution?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connections).toBe(0);
  } finally {
    releaseResolution?.();
    client.destroy();
    await proxy.close();
  }
});

test('closes an established CONNECT tunnel when its open-network grant expires', async () => {
  const upstream = new PassThrough();
  const openPolicy: BrowserPolicy = {
    ...policy,
    network_mode: 'open',
    open_network_expires_at: new Date(Date.now() + 500).toISOString(),
  };
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '93.184.216.34',
      hostname: 'console.example.test',
      port: 443,
      protocol: 'https:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy: openPolicy,
    connector: () => upstream,
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      'CONNECT console.example.test:443 HTTP/1.1\r\nHost: console.example.test:443\r\n\r\n',
    );
    const [response] = (await once(client, 'data')) as [Buffer];
    expect(response.toString()).toContain('200 Connection Established');
    const clientClosed = once(client, 'close');

    await Promise.race([
      clientClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('open-network tunnel outlived its grant')), 1_500),
      ),
    ]);

    expect(client.destroyed).toBeTrue();
    expect(upstream.destroyed).toBeTrue();
  } finally {
    client.destroy();
    upstream.destroy();
    await proxy.close();
  }
});

test('bounds stalled HTTP target resolution before opening an upstream', async () => {
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async () => new Promise<never>(() => undefined),
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy, resolveTimeoutMs: 10 });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    const response = once(client, 'data') as Promise<[Buffer]>;
    client.write(
      'GET http://console.example.test/slow-dns HTTP/1.1\r\nHost: console.example.test\r\n\r\n',
    );
    const [data] = await Promise.race([
      response,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HTTP target resolution remained unbounded')), 250),
      ),
    ]);

    expect(data.toString()).toContain('403 Forbidden');
  } finally {
    client.destroy();
    await proxy.close();
  }
});

test('bounds stalled CONNECT target resolution without opening an upstream', async () => {
  let connections = 0;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async () => new Promise<never>(() => undefined),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    resolveTimeoutMs: 10,
    connector: () => {
      connections += 1;
      return new PassThrough();
    },
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    const response = once(client, 'data') as Promise<[Buffer]>;
    client.write(
      'CONNECT console.example.test:443 HTTP/1.1\r\nHost: console.example.test:443\r\n\r\n',
    );
    const [data] = await Promise.race([
      response,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CONNECT target resolution remained unbounded')), 250),
      ),
    ]);

    expect(data.toString()).toContain('403 Forbidden');
    expect(connections).toBe(0);
  } finally {
    client.destroy();
    await proxy.close();
  }
});

test('closes an idle established CONNECT tunnel', async () => {
  let upstreamSocket: Socket | undefined;
  const upstreamServer = createTcpServer((socket) => {
    upstreamSocket = socket;
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('CONNECT idle test upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '127.0.0.1',
      hostname: 'console.example.test',
      port: upstreamAddress.port,
      protocol: 'https:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy, idleTimeoutMs: 10 });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      `CONNECT console.example.test:${upstreamAddress.port} HTTP/1.1\r\n` +
        `Host: console.example.test:${upstreamAddress.port}\r\n\r\n`,
    );
    const [response] = (await once(client, 'data')) as [Buffer];
    expect(response.toString()).toContain('200 Connection Established');
    const clientClosed = once(client, 'close');

    await Promise.race([
      clientClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('idle CONNECT tunnel remained open')), 250),
      ),
    ]);

    expect(client.destroyed).toBeTrue();
    expect(upstreamSocket?.destroyed).toBeTrue();
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('closes an idle HTTP response stream after its headers arrive', async () => {
  let upstreamSocket: Socket | undefined;
  let sendHeaders: (() => void) | undefined;
  const headersReady = new Promise<void>((resolve) => {
    sendHeaders = resolve;
  });
  const upstreamServer = createHttpServer((request, response) => {
    upstreamSocket = request.socket;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first chunk');
    sendHeaders?.();
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('HTTP idle test upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '127.0.0.1',
      hostname: 'public.example.test',
      port: upstreamAddress.port,
      protocol: 'http:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({
    guard,
    policy,
    idleTimeoutMs: 10,
    requestTimeoutMs: 1_000,
  });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    const response = once(client, 'data');
    client.write(
      `GET http://public.example.test:${upstreamAddress.port}/idle HTTP/1.1\r\n` +
        `Host: public.example.test:${upstreamAddress.port}\r\n\r\n`,
    );
    await headersReady;
    await response;
    if (upstreamSocket === undefined) throw new Error('HTTP idle test socket was not captured');
    const upstreamClosed = once(upstreamSocket, 'close');

    await Promise.race([
      upstreamClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('idle HTTP upstream remained open')), 250),
      ),
    ]);

    expect(upstreamSocket.destroyed).toBeTrue();
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('destroys a real CONNECT upstream socket when its proxy client aborts', async () => {
  let upstreamSocket: Socket | undefined;
  const upstreamServer = createTcpServer((socket) => {
    upstreamSocket = socket;
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstreamServer.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('CONNECT abort test upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => ({
      address: '127.0.0.1',
      hostname: 'console.example.test',
      port: upstreamAddress.port,
      protocol: 'https:',
      url,
    }),
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy });
  const proxyUrl = new URL(proxy.serverUrl);
  const client = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await once(client, 'connect');
    client.write(
      `CONNECT console.example.test:${upstreamAddress.port} HTTP/1.1\r\n` +
        `Host: console.example.test:${upstreamAddress.port}\r\n\r\n`,
    );
    const [response] = (await once(client, 'data')) as [Buffer];
    expect(response.toString()).toContain('200 Connection Established');
    if (upstreamSocket === undefined) throw new Error('CONNECT abort socket was not captured');
    const upstreamClosed = once(upstreamSocket, 'close');

    client.destroy();
    await Promise.race([
      upstreamClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CONNECT upstream survived client abort')), 250),
      ),
    ]);

    expect(upstreamSocket.destroyed).toBeTrue();
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('proxy shutdown destroys real HTTP and CONNECT upstream sockets', async () => {
  let httpSocket: Socket | undefined;
  let markHttpConnected: () => void = () => undefined;
  const httpConnected = new Promise<void>((resolve) => {
    markHttpConnected = resolve;
  });
  const httpServer = createHttpServer((request) => {
    httpSocket = request.socket;
    markHttpConnected();
  });
  let connectSocket: Socket | undefined;
  const connectServer = createTcpServer((socket) => {
    connectSocket = socket;
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    }),
    new Promise<void>((resolve, reject) => {
      connectServer.once('error', reject);
      connectServer.listen(0, '127.0.0.1', resolve);
    }),
  ]);
  const httpAddress = httpServer.address();
  const connectAddress = connectServer.address();
  if (
    httpAddress === null ||
    typeof httpAddress === 'string' ||
    connectAddress === null ||
    typeof connectAddress === 'string'
  ) {
    throw new Error('proxy shutdown upstream failed to bind');
  }
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      const isHttp = url.startsWith('http:');
      return {
        address: '127.0.0.1',
        hostname: isHttp ? 'public.example.test' : 'console.example.test',
        port: isHttp ? httpAddress.port : connectAddress.port,
        protocol: isHttp ? ('http:' as const) : ('https:' as const),
        url,
      };
    },
  };
  const proxy = await startBrowserNetworkProxy({ guard, policy });
  const proxyUrl = new URL(proxy.serverUrl);
  const httpClient = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  const connectClient = connectTcp({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });

  try {
    await Promise.all([once(httpClient, 'connect'), once(connectClient, 'connect')]);
    httpClient.write(
      `GET http://public.example.test:${httpAddress.port}/slow HTTP/1.1\r\n` +
        `Host: public.example.test:${httpAddress.port}\r\n\r\n`,
    );
    connectClient.write(
      `CONNECT console.example.test:${connectAddress.port} HTTP/1.1\r\n` +
        `Host: console.example.test:${connectAddress.port}\r\n\r\n`,
    );
    await Promise.all([httpConnected, once(connectClient, 'data')]);
    if (httpSocket === undefined || connectSocket === undefined) {
      throw new Error('proxy shutdown sockets were not captured');
    }
    const httpClosed = once(httpSocket, 'close');
    const connectClosed = once(connectSocket, 'close');

    await proxy.close();
    await Promise.all([httpClosed, connectClosed]);

    expect(httpSocket.destroyed).toBeTrue();
    expect(connectSocket.destroyed).toBeTrue();
    expect(httpClient.destroyed).toBeTrue();
    expect(connectClient.destroyed).toBeTrue();
  } finally {
    httpClient.destroy();
    connectClient.destroy();
    httpSocket?.destroy();
    connectSocket?.destroy();
    await proxy.close();
    await Promise.all([
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      new Promise<void>((resolve) => connectServer.close(() => resolve())),
    ]);
  }
});
