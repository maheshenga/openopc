import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

import { createDb } from '@kortix/db';

import { createDrizzleModuleCapabilityConsumer } from './capabilities.drizzle';
import { createEgressPolicy } from './policy';
import {
  type ModuleEgressProxy,
  type ModuleEgressTransportRequest,
  type ModuleEgressTransportResponse,
  createModuleEgressProxy,
  createPasetoCapabilityVerifier,
} from './proxy';

export interface ModuleEgressProxyConfig {
  enabled: true;
  port: number;
  databaseUrl: string;
  publicKeys: ReadonlyMap<string, string>;
  credentials: ReadonlyMap<string, { name: string; value: string }>;
  mtlsProxySecret: string;
}

const KEY_ID = /^openopc-capability-(?:development|test|staging)-[A-Za-z0-9._-]{1,64}$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CERTIFICATE_THUMBPRINT = /^[0-9a-f]{64}$/;
const MAX_HTTP_REQUEST_BYTES = 1_048_576;
const encoder = new TextEncoder();
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value || value.length > 65_536) return null;
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function invalid(): never {
  throw new Error('MODULE_EGRESS_CONFIG_INVALID');
}

function json(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function denied(): Response {
  return json(403, { error: 'MODULE_EGRESS_DENIED' });
}

function sameSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const lengthValue = request.headers.get('content-length');
  if (lengthValue !== null) {
    const length = Number(lengthValue);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HTTP_REQUEST_BYTES) {
      throw new Error('MODULE_EGRESS_DENIED');
    }
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_HTTP_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error('MODULE_EGRESS_DENIED');
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedResponse(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('MODULE_EGRESS_UPSTREAM_LIMIT');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('MODULE_EGRESS_UPSTREAM_LIMIT');
    chunks.push(chunk);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function responseHeaders(rawHeaders: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    const value = rawHeaders[index + 1];
    if (!name || value === undefined || !HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) {
      throw new Error('MODULE_EGRESS_UPSTREAM_INVALID');
    }
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

export function createPinnedHttpsTransport(): (
  input: ModuleEgressTransportRequest,
) => Promise<ModuleEgressTransportResponse> {
  return async (input) => {
    const target = new URL(input.url);
    if (
      target.protocol !== 'https:' ||
      target.hostname !== input.tlsServername ||
      target.username !== '' ||
      target.password !== '' ||
      target.hash !== ''
    ) {
      throw new Error('MODULE_EGRESS_UPSTREAM_INVALID');
    }

    return new Promise((resolve, reject) => {
      const upstream = httpsRequest(
        {
          protocol: 'https:',
          hostname: input.address,
          family: input.family,
          port: target.port ? Number(target.port) : 443,
          servername: input.tlsServername,
          path: `${target.pathname}${target.search}`,
          method: input.method,
          headers: { ...input.headers, host: target.host },
          rejectUnauthorized: input.rejectUnauthorized,
          agent: false,
        },
        (response) => {
          void readBoundedResponse(response, input.maxResponseBytes)
            .then((body) => {
              resolve({
                status: response.statusCode ?? 502,
                headers: responseHeaders(response.rawHeaders),
                body,
              });
            })
            .catch((error) => {
              response.destroy(error instanceof Error ? error : undefined);
              reject(error);
            });
        },
      );
      upstream.setTimeout(input.timeoutMs, () => {
        upstream.destroy(new Error('MODULE_EGRESS_UPSTREAM_TIMEOUT'));
      });
      upstream.once('error', reject);
      if (input.body) upstream.write(input.body);
      upstream.end();
    });
  };
}

export function createModuleEgressHttpHandler(input: {
  mtlsProxySecret: string;
  proxy: ModuleEgressProxy;
  isReady?: () => Promise<boolean>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const requestUrl = new URL(request.url);
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      return json(200, { status: 'ok' });
    }
    if (request.method === 'GET' && requestUrl.pathname === '/readyz') {
      const ready = await input.isReady?.().catch(() => false);
      return ready === false ? json(503, { status: 'not_ready' }) : json(200, { status: 'ready' });
    }
    if (requestUrl.pathname !== '/v1/egress') return json(404, { error: 'NOT_FOUND' });

    try {
      const certificateThumbprint = request.headers
        .get('x-openopc-client-cert-sha256')
        ?.toLowerCase();
      if (
        request.headers.get('x-openopc-mtls-verified') !== 'SUCCESS' ||
        !sameSecret(request.headers.get('x-openopc-egress-proxy-secret'), input.mtlsProxySecret) ||
        !certificateThumbprint ||
        !CERTIFICATE_THUMBPRINT.test(certificateThumbprint) ||
        requestUrl.searchParams.getAll('url').length !== 1 ||
        [...requestUrl.searchParams.keys()].some((key) => key !== 'url')
      ) {
        return denied();
      }
      const targetUrl = requestUrl.searchParams.get('url');
      if (!targetUrl) return denied();

      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        if (name !== 'host' && !name.startsWith('x-openopc-')) headers[name] = value;
      });
      const result = await input.proxy.handle({
        authorization: request.headers.get('authorization'),
        certificateThumbprint,
        url: targetUrl,
        method: request.method,
        headers,
        body: await readBoundedBody(request),
      });
      return new Response(result.body.slice(), { status: result.status, headers: result.headers });
    } catch {
      return denied();
    }
  };
}

export function createModuleEgressProxyRuntime(config: ModuleEgressProxyConfig): {
  handler: (request: Request) => Promise<Response>;
} {
  const database = createDb(config.databaseUrl, { max: 5 });
  const consumer = createDrizzleModuleCapabilityConsumer(database);
  const proxy = createModuleEgressProxy({
    verifier: createPasetoCapabilityVerifier({ keys: config.publicKeys }),
    policy: createEgressPolicy({
      async resolve(hostname) {
        const addresses = await lookup(hostname, { all: true, verbatim: true });
        return addresses.flatMap(({ address, family }) =>
          family === 4 || family === 6 ? [{ address, family }] : [],
        );
      },
    }),
    consume: (request) => consumer.consume(request),
    async credentialFor({ origin }) {
      const credential = config.credentials.get(origin);
      if (!credential) throw new Error('MODULE_EGRESS_CREDENTIAL_UNAVAILABLE');
      return credential;
    },
    transport: createPinnedHttpsTransport(),
  });
  return {
    handler: createModuleEgressHttpHandler({
      mtlsProxySecret: config.mtlsProxySecret,
      proxy,
      isReady: () => consumer.ready(),
    }),
  };
}

export function startModuleEgressProxyServer(
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof Bun.serve> {
  const config = loadModuleEgressProxyConfig(env);
  const runtime = createModuleEgressProxyRuntime(config);
  return Bun.serve({
    hostname: '0.0.0.0',
    port: config.port,
    fetch: runtime.handler,
  });
}

if (import.meta.main) {
  const server = startModuleEgressProxyServer();
  console.log(`OpenOPC module egress proxy listening on private port ${server.port}`);
}

export function loadModuleEgressProxyConfig(
  env: Record<string, string | undefined>,
): ModuleEgressProxyConfig {
  const port = Number(env.OPENOPC_MODULE_EGRESS_PORT ?? 4013);
  const publicKeyValue = parseJsonObject(env.OPENOPC_MODULE_EGRESS_PUBLIC_KEYS_JSON);
  const credentialValue = parseJsonObject(env.OPENOPC_MODULE_EGRESS_CREDENTIALS_JSON);
  const databaseUrl = env.DATABASE_URL;
  const mtlsProxySecret = env.OPENOPC_MODULE_EGRESS_MTLS_PROXY_SECRET;
  if (
    env.OPENOPC_MODULE_EGRESS_ENABLED !== 'true' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !publicKeyValue ||
    !credentialValue ||
    !databaseUrl ||
    !mtlsProxySecret ||
    mtlsProxySecret.length < 32 ||
    mtlsProxySecret.length > 4_096
  ) {
    invalid();
  }

  try {
    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname) invalid();
  } catch {
    invalid();
  }

  const publicKeys = new Map<string, string>();
  for (const [keyId, key] of Object.entries(publicKeyValue)) {
    if (!KEY_ID.test(keyId) || typeof key !== 'string' || !key.startsWith('k4.public.')) invalid();
    publicKeys.set(keyId, key);
  }
  if (publicKeys.size === 0) invalid();

  const credentials = new Map<string, { name: string; value: string }>();
  for (const [origin, unknownCredential] of Object.entries(credentialValue)) {
    const credential = object(unknownCredential);
    if (
      !validOrigin(origin) ||
      !credential ||
      Object.keys(credential).sort().join(',') !== 'name,value' ||
      typeof credential.name !== 'string' ||
      !HEADER_NAME.test(credential.name) ||
      FORBIDDEN_CREDENTIAL_HEADERS.has(credential.name.toLowerCase()) ||
      credential.name.toLowerCase().startsWith('x-openopc-') ||
      typeof credential.value !== 'string' ||
      credential.value.length < 1 ||
      credential.value.length > 8_192 ||
      /[\r\n\0]/.test(credential.value)
    ) {
      invalid();
    }
    credentials.set(origin, { name: credential.name, value: credential.value });
  }
  if (credentials.size === 0) invalid();

  return {
    enabled: true,
    port,
    databaseUrl,
    publicKeys,
    credentials,
    mtlsProxySecret,
  };
}
