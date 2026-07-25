import type { AuthorizedDeveloperEgressTarget, DeveloperModuleEgressPolicy } from './egress-policy';

export class DeveloperVerificationProxyError extends Error {
  readonly code = 'DEVELOPER_VERIFICATION_PROXY_DENIED';

  constructor() {
    super('DEVELOPER_VERIFICATION_PROXY_DENIED');
    this.name = 'DeveloperVerificationProxyError';
  }
}

export interface DeveloperProxyTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  address: string;
  family: 4 | 6;
  tlsServername: string;
  rejectUnauthorized: true;
  signal?: AbortSignal;
}

export interface DeveloperProxyTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export function createDeveloperModuleEgressProxy(_input: {
  policy: DeveloperModuleEgressPolicy;
  transport(request: DeveloperProxyTransportRequest): Promise<DeveloperProxyTransportResponse>;
  recordEvidence(entry: {
    origin: string;
    method: string;
    outcome: 'allowed' | 'denied';
  }): Promise<void>;
  maxRedirects?: number;
}): {
  forward(input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Uint8Array | null;
    declaredOrigins: readonly string[];
    policyOrigins: readonly string[];
    signal?: AbortSignal;
  }): Promise<DeveloperProxyTransportResponse>;
} {
  const input = _input;
  const maxRedirects = input.maxRedirects ?? 3;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
    throw new TypeError('DEVELOPER_VERIFICATION_PROXY_CONFIG_INVALID');
  }
  return {
    async forward(request) {
      let url = request.url;
      let method = request.method.toUpperCase();
      let body = request.body;
      let headers = sanitizeRequestHeaders(request.headers);
      let redirects = 0;
      while (true) {
        let target: AuthorizedDeveloperEgressTarget;
        try {
          target = await input.policy.authorize({
            url,
            method,
            requestBytes: body?.byteLength ?? 0,
            declaredOrigins: request.declaredOrigins,
            policyOrigins: request.policyOrigins,
          });
        } catch {
          await recordSafely(input.recordEvidence, {
            origin: safeOrigin(url),
            method,
            outcome: 'denied',
          });
          throw new DeveloperVerificationProxyError();
        }
        let response: DeveloperProxyTransportResponse;
        try {
          response = await input.transport({
            url: target.url,
            method,
            headers,
            body,
            address: target.address,
            family: target.family,
            tlsServername: target.tlsServername,
            rejectUnauthorized: true,
            signal: request.signal,
          });
        } catch {
          await recordSafely(input.recordEvidence, {
            origin: target.origin,
            method,
            outcome: 'denied',
          });
          throw new DeveloperVerificationProxyError();
        }
        if (
          !response ||
          !Number.isSafeInteger(response.status) ||
          response.status < 100 ||
          response.status > 599 ||
          !(response.body instanceof Uint8Array) ||
          response.body.byteLength > target.maxResponseBytes
        ) {
          await recordSafely(input.recordEvidence, {
            origin: target.origin,
            method,
            outcome: 'denied',
          });
          throw new DeveloperVerificationProxyError();
        }
        const location = header(response.headers, 'location');
        if (isRedirect(response.status) && location !== null) {
          await recordSafely(input.recordEvidence, {
            origin: target.origin,
            method,
            outcome: 'allowed',
          });
          if (redirects >= maxRedirects) throw new DeveloperVerificationProxyError();
          try {
            url = new URL(location, target.url).href;
          } catch {
            throw new DeveloperVerificationProxyError();
          }
          redirects += 1;
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && method === 'POST')
          ) {
            method = 'GET';
            body = null;
            headers = removeBodyHeaders(headers);
          }
          continue;
        }
        await recordSafely(input.recordEvidence, {
          origin: target.origin,
          method,
          outcome: 'allowed',
        });
        return {
          status: response.status,
          headers: sanitizeResponseHeaders(response.headers),
          body: new Uint8Array(response.body),
        };
      }
    },
  };
}

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'proxy-connection',
  'x-api-key',
  'api-key',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'host',
  'content-length',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      CREDENTIAL_HEADERS.has(lower) ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower.startsWith('proxy-') ||
      lower.startsWith('x-amz-') ||
      lower.startsWith('x-goog-') ||
      /[\0\r\n]/.test(name) ||
      /[\0\r\n]/.test(value)
    ) {
      continue;
    }
    result[lower] = value.slice(0, 8_192);
  }
  return result;
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === 'set-cookie' ||
      lower === 'proxy-authenticate' ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      /[\0\r\n]/.test(name) ||
      /[\0\r\n]/.test(value)
    ) {
      continue;
    }
    result[lower] = value.slice(0, 8_192);
  }
  return result;
}

function removeBodyHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name !== 'content-type' && name !== 'content-encoding',
    ),
  );
}

function header(headers: Record<string, string>, wanted: string): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) return value;
  }
  return null;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : 'invalid-origin';
  } catch {
    return 'invalid-origin';
  }
}

async function recordSafely(
  recorder: (entry: {
    origin: string;
    method: string;
    outcome: 'allowed' | 'denied';
  }) => Promise<void>,
  entry: { origin: string; method: string; outcome: 'allowed' | 'denied' },
): Promise<void> {
  try {
    await recorder(entry);
  } catch {
    throw new DeveloperVerificationProxyError();
  }
}
