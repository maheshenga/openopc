import type { LookupFunction } from 'node:net';
// Bun shadows the bare `undici` specifier with a compatibility shim that ignores Agent lookup.
// The reviewed package entrypoint is required so DNS pinning uses the declared direct dependency.
import { Agent, Headers, type RequestInit, Response, fetch as undiciFetch } from 'undici/index.js';
import { StudioNetworkPolicyError, type StudioResolvedAddress, validateStudioOrigin } from './ssrf';

export interface SafeStudioFetchOptions {
  redirectPolicy: 'error' | 'output-get';
  maxRedirects: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
  authorizationOrigin?: string;
}

export interface SafeStudioFetchInput {
  url: URL;
  init?: RequestInit;
  resolve: (hostname: string) => Promise<readonly StudioResolvedAddress[]>;
  allowPrivateOrigins: ReadonlySet<string>;
  allowInsecureLocalEndpoints: boolean;
  options: SafeStudioFetchOptions;
}

export type StudioSafeFetchErrorCode =
  | 'STUDIO_NETWORK_REQUEST_FAILED'
  | 'STUDIO_NETWORK_TIMEOUT'
  | 'STUDIO_REDIRECT_LIMIT'
  | 'STUDIO_RESPONSE_TOO_LARGE';

export class StudioSafeFetchError extends Error {
  constructor(readonly code: StudioSafeFetchErrorCode) {
    super(code);
    this.name = 'StudioSafeFetchError';
  }
}

export async function safeStudioFetch(input: SafeStudioFetchInput): Promise<Response> {
  assertSafeOptions(input.options);

  const initialMethod = (input.init?.method ?? 'GET').toUpperCase();
  const initialHeaders = new Headers(input.init?.headers);
  const initialBody = input.init?.body ?? null;
  const credentialHeadersPresent = hasCredentialHeaders(initialHeaders);

  if (input.options.redirectPolicy === 'output-get') {
    if (initialMethod !== 'GET' || initialBody !== null || credentialHeadersPresent) {
      throw new StudioNetworkPolicyError();
    }
  }
  if (
    credentialHeadersPresent &&
    (!input.options.authorizationOrigin || input.options.authorizationOrigin !== input.url.origin)
  ) {
    throw new StudioNetworkPolicyError();
  }

  const timeout = createTimeoutSignal(input.init?.signal, input.options.totalTimeoutMs);
  try {
    return await Promise.race([
      executeFetch(input, {
        signal: timeout.signal,
        didTimeout: timeout.didTimeout,
        initialMethod,
        initialHeaders,
        initialBody,
      }),
      timeout.expired,
    ]);
  } finally {
    timeout.dispose();
  }
}

async function executeFetch(
  input: SafeStudioFetchInput,
  state: {
    signal: AbortSignal;
    didTimeout: () => boolean;
    initialMethod: string;
    initialHeaders: Headers;
    initialBody: RequestInit['body'] | null;
  },
): Promise<Response> {
  let currentUrl = new URL(input.url);
  let method = state.initialMethod;
  let headers = state.initialHeaders;
  let body = state.initialBody;
  let redirects = 0;

  while (true) {
    const addresses = await validateRequestOrigin(currentUrl, input);
    const agent = createPinnedAgent(currentUrl, addresses, input.options.connectTimeoutMs);
    let response: Response;
    try {
      response = await undiciFetch(currentUrl, {
        ...input.init,
        method,
        headers,
        body,
        redirect: 'manual',
        dispatcher: agent,
        signal: state.signal,
        ...(body === null ? {} : { duplex: 'half' as const }),
      });
    } catch {
      await destroyAgent(agent);
      if (state.didTimeout()) throw new StudioSafeFetchError('STUDIO_NETWORK_TIMEOUT');
      throw new StudioSafeFetchError('STUDIO_NETWORK_REQUEST_FAILED');
    }

    const location = response.headers.get('location');
    if (
      input.options.redirectPolicy === 'output-get' &&
      isRedirectStatus(response.status) &&
      location !== null
    ) {
      await response.body?.cancel();
      await closeAgent(agent);
      if (redirects >= input.options.maxRedirects) {
        throw new StudioSafeFetchError('STUDIO_REDIRECT_LIMIT');
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new StudioNetworkPolicyError();
      }
      redirects += 1;
      method = 'GET';
      headers = new Headers();
      body = null;
      continue;
    }

    try {
      const buffered = await bufferResponse(response, input.options.maxResponseBytes);
      await closeAgent(agent);
      return buffered;
    } catch (error) {
      await destroyAgent(agent);
      if (error instanceof StudioSafeFetchError) throw error;
      if (state.didTimeout()) throw new StudioSafeFetchError('STUDIO_NETWORK_TIMEOUT');
      throw new StudioSafeFetchError('STUDIO_NETWORK_REQUEST_FAILED');
    }
  }
}

async function validateRequestOrigin(
  requestUrl: URL,
  input: SafeStudioFetchInput,
): Promise<readonly StudioResolvedAddress[]> {
  const policyUrl = new URL(requestUrl);
  policyUrl.search = '';
  policyUrl.hash = '';
  return validateStudioOrigin({
    url: policyUrl,
    resolve: input.resolve,
    allowPrivateOrigins: input.allowPrivateOrigins,
    allowInsecureLocalEndpoints: input.allowInsecureLocalEndpoints,
  });
}

function createPinnedAgent(
  url: URL,
  addresses: readonly StudioResolvedAddress[],
  connectTimeoutMs: number,
): Agent {
  const expectedHostname = normalizeHostname(url.hostname);
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (normalizeHostname(hostname) !== expectedHostname) {
      callback(new Error('STUDIO_DNS_PIN_MISMATCH'), '', 4);
      return;
    }
    const family = typeof options.family === 'number' ? options.family : 0;
    const candidates = addresses.filter((address) => family === 0 || address.family === family);
    if (candidates.length === 0) {
      callback(new Error('STUDIO_DNS_PIN_EMPTY'), '', 4);
      return;
    }
    if (options.all) {
      callback(
        null,
        candidates.map((candidate) => ({ ...candidate })),
      );
      return;
    }
    const selected = candidates[0];
    if (!selected) {
      callback(new Error('STUDIO_DNS_PIN_EMPTY'), '', 4);
      return;
    }
    callback(null, selected.address, selected.family);
  };

  return new Agent({
    connect: {
      lookup,
      timeout: connectTimeoutMs,
      autoSelectFamily: addresses.length > 1,
      autoSelectFamilyAttemptTimeout: Math.min(250, connectTimeoutMs),
    },
  });
}

async function bufferResponse(response: Response, maxBytes: number): Promise<Response> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new StudioSafeFetchError('STUDIO_RESPONSE_TOO_LARGE');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('transfer-encoding');
  responseHeaders.set('content-length', String(bytes.byteLength));
  const body = responseHasNoBody(response.status) ? null : bytes;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function createTimeoutSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  expired: Promise<never>;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: (error: StudioSafeFetchError) => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new StudioSafeFetchError('STUDIO_NETWORK_TIMEOUT'));
  }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    expired,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function hasCredentialHeaders(headers: Headers): boolean {
  for (const name of headers.keys()) {
    const lower = name.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower === 'cookie' ||
      lower === 'x-api-key' ||
      lower === 'api-key' ||
      lower.startsWith('x-amz-') ||
      lower.startsWith('x-goog-')
    ) {
      return true;
    }
  }
  return false;
}

function assertSafeOptions(options: SafeStudioFetchOptions): void {
  if (
    !Number.isInteger(options.maxRedirects) ||
    options.maxRedirects < 0 ||
    options.maxRedirects > 3 ||
    !Number.isFinite(options.connectTimeoutMs) ||
    options.connectTimeoutMs <= 0 ||
    !Number.isFinite(options.totalTimeoutMs) ||
    options.totalTimeoutMs <= 0 ||
    !Number.isSafeInteger(options.maxResponseBytes) ||
    options.maxResponseBytes <= 0
  ) {
    throw new StudioNetworkPolicyError();
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function responseHasNoBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

async function closeAgent(agent: Agent): Promise<void> {
  try {
    await agent.close();
  } catch {
    await destroyAgent(agent);
  }
}

async function destroyAgent(agent: Agent): Promise<void> {
  try {
    await agent.destroy();
  } catch {
    // Best-effort cleanup; caller receives the allowlisted network error.
  }
}
