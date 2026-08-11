import type { OpenOpcServiceName, OpenOpcServiceOperation } from './contracts.js';
import { OpenOpcModuleRequestError } from './errors.js';

const REQUEST_TYPE = 'openopc.module-service.token.request' as const;
const RESPONSE_TYPE = 'openopc.module-service.token.response' as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_OPERATIONS: Record<OpenOpcServiceName, readonly OpenOpcServiceOperation[]> = {
  ai: ['models.read', 'text.generate', 'text.stream', 'image.generate'],
  payment: ['orders.create', 'orders.read', 'refunds.create'],
};

export interface OpenOpcBrowserCapabilityTokenRequest {
  type: typeof REQUEST_TYPE;
  requestId: string;
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
}

export interface OpenOpcBrowserCapabilityTokenResponse {
  type: typeof RESPONSE_TYPE;
  requestId: string;
  token: string;
  expiresAt: string;
}

export interface OpenOpcBrowserCapabilityTokenErrorResponse {
  type: 'openopc.module-service.token.error';
  requestId: string;
  error: {
    code: 'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED';
    retryAfterMs: number;
  };
}

export interface OpenOpcBrowserCapabilityTokenEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface OpenOpcBrowserCapabilityTokenEventTarget {
  addEventListener(
    type: 'message',
    listener: (event: OpenOpcBrowserCapabilityTokenEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: OpenOpcBrowserCapabilityTokenEvent) => void,
  ): void;
}

export interface OpenOpcBrowserCapabilityTokenHostWindow {
  postMessage(message: OpenOpcBrowserCapabilityTokenRequest, targetOrigin: string): void;
}

export interface OpenOpcBrowserCapabilityTokenAdapterOptions {
  hostOrigin: string;
  hostWindow: OpenOpcBrowserCapabilityTokenHostWindow;
  eventTarget: OpenOpcBrowserCapabilityTokenEventTarget;
  requestId?: () => string;
  timeoutMs?: number;
  now?: () => number;
}

export class OpenOpcBrowserCapabilityTokenProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenOpcBrowserCapabilityTokenProtocolError';
  }
}

function protocolError(message: string): never {
  throw new OpenOpcBrowserCapabilityTokenProtocolError(message);
}

function immutableOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      protocolError('OpenOPC browser capability host origin must be HTTPS');
    }
    return url.origin;
  } catch {
    protocolError('OpenOPC browser capability host origin must be HTTPS');
  }
}

function isServiceOperation(service: unknown, operation: unknown): service is OpenOpcServiceName {
  return (
    (service === 'ai' || service === 'payment') &&
    typeof operation === 'string' &&
    SERVICE_OPERATIONS[service].includes(operation as OpenOpcServiceOperation)
  );
}

function isResponse(
  value: unknown,
  requestId: string,
): value is OpenOpcBrowserCapabilityTokenResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'expiresAt,requestId,token,type') return false;
  return (
    record.type === RESPONSE_TYPE &&
    record.requestId === requestId &&
    typeof record.token === 'string' &&
    record.token.startsWith('v4.public.') &&
    record.token.length <= 8_192 &&
    !/\s/.test(record.token) &&
    typeof record.expiresAt === 'string' &&
    Number.isFinite(Date.parse(record.expiresAt))
  );
}

function isRateLimitErrorResponse(
  value: unknown,
  requestId: string,
): value is OpenOpcBrowserCapabilityTokenErrorResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'error,requestId,type') return false;
  const error = record.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return false;
  const errorRecord = error as Record<string, unknown>;
  const errorKeys = Object.keys(errorRecord).sort();
  return (
    errorKeys.join(',') === 'code,retryAfterMs' &&
    record.type === 'openopc.module-service.token.error' &&
    record.requestId === requestId &&
    errorRecord.code === 'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED' &&
    Number.isSafeInteger(errorRecord.retryAfterMs) &&
    (errorRecord.retryAfterMs as number) >= 0 &&
    (errorRecord.retryAfterMs as number) <= 60_000
  );
}

export interface OpenOpcBrowserCapabilityTokenGetter {
  (
    input: {
      service: OpenOpcServiceName;
      operation: OpenOpcServiceOperation;
    },
    options?: OpenOpcBrowserCapabilityTokenRequestOptions,
  ): Promise<string>;
  invalidate?: (input: {
    service: OpenOpcServiceName;
    operation: OpenOpcServiceOperation;
  }) => void;
}

export interface OpenOpcBrowserCapabilityTokenRequestOptions {
  signal?: AbortSignal;
}

type TokenKey = `${OpenOpcServiceName}:${OpenOpcServiceOperation}`;
type CachedToken = { token: string; expiresAt: number };
type PendingTokenRequest = {
  promise: Promise<string>;
  controller: AbortController;
  subscribers: number;
};

function tokenKey(input: {
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
}): TokenKey {
  return `${input.service}:${input.operation}`;
}

function subscribeToTokenRequest(
  pending: PendingTokenRequest,
  signal: AbortSignal | undefined,
  release: () => void,
): Promise<string> {
  pending.subscribers += 1;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      release();
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED')));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.promise.then(
      (token) => finish(() => resolve(token)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function createOpenOpcBrowserCapabilityTokenAdapter(
  options: OpenOpcBrowserCapabilityTokenAdapterOptions,
): OpenOpcBrowserCapabilityTokenGetter {
  if (
    !options ||
    typeof options !== 'object' ||
    !options.hostWindow ||
    typeof options.hostWindow.postMessage !== 'function' ||
    !options.eventTarget ||
    typeof options.eventTarget.addEventListener !== 'function' ||
    typeof options.eventTarget.removeEventListener !== 'function'
  ) {
    protocolError('OpenOPC browser capability adapter options are invalid');
  }
  const hostOrigin = immutableOrigin(options.hostOrigin);
  const requestId = options.requestId ?? (() => globalThis.crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    protocolError('OpenOPC browser capability token timeout is invalid');
  }

  const cache = new Map<TokenKey, CachedToken>();
  const pendingRequests = new Map<TokenKey, PendingTokenRequest>();

  const startRequest = (
    input: {
      service: OpenOpcServiceName;
      operation: OpenOpcServiceOperation;
    },
    key: TokenKey,
  ): PendingTokenRequest => {
    const controller = new AbortController();
    const promise = new Promise<string>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const timeout: { id?: ReturnType<typeof setTimeout> } = {};
      const cleanup = () => {
        if (timeout.id !== undefined) clearTimeout(timeout.id);
        options.eventTarget.removeEventListener('message', listener);
        controller.signal.removeEventListener('abort', onAbort);
      };
      const finishReject = (error: OpenOpcModuleRequestError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        finishReject(
          new OpenOpcModuleRequestError(
            timedOut ? 'OPENOPC_MODULE_REQUEST_TIMEOUT' : 'OPENOPC_MODULE_REQUEST_ABORTED',
            timedOut
              ? 'OpenOPC browser capability token request timed out'
              : 'OpenOPC browser capability token request was aborted',
          ),
        );
      };
      const listener = (event: OpenOpcBrowserCapabilityTokenEvent) => {
        if (settled || event.origin !== hostOrigin || event.source !== options.hostWindow) return;
        if (isResponse(event.data, id)) {
          settled = true;
          cleanup();
          cache.set(key, { token: event.data.token, expiresAt: Date.parse(event.data.expiresAt) });
          resolve(event.data.token);
          return;
        }
        if (isRateLimitErrorResponse(event.data, id)) {
          finishReject(
            new OpenOpcModuleRequestError(
              'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED',
              undefined,
              event.data.error.retryAfterMs,
            ),
          );
        }
      };
      const id = requestId();
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        finishReject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED'));
        return;
      }
      options.eventTarget.addEventListener('message', listener);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timeout.id = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      try {
        options.hostWindow.postMessage(
          { type: REQUEST_TYPE, requestId: id, service: input.service, operation: input.operation },
          hostOrigin,
        );
      } catch {
        finishReject(
          new OpenOpcModuleRequestError(
            'OPENOPC_MODULE_REQUEST_FAILED',
            'OpenOPC browser capability token request failed',
          ),
        );
      }
    });
    const pending: PendingTokenRequest = { promise, controller, subscribers: 0 };
    promise.then(
      () => {
        if (pendingRequests.get(key)?.promise === promise) pendingRequests.delete(key);
      },
      () => {
        if (pendingRequests.get(key)?.promise === promise) pendingRequests.delete(key);
      },
    );
    return pending;
  };

  const getToken: OpenOpcBrowserCapabilityTokenGetter = async (input, requestOptions) => {
    if (!isServiceOperation(input?.service, input?.operation)) {
      protocolError('OpenOPC browser capability service operation is invalid');
    }

    if (
      requestOptions !== undefined &&
      (!requestOptions ||
        typeof requestOptions !== 'object' ||
        Array.isArray(requestOptions) ||
        Object.keys(requestOptions).some((key) => key !== 'signal'))
    ) {
      protocolError('OpenOPC browser capability request options are invalid');
    }
    const signal = requestOptions?.signal;
    if (
      signal !== undefined &&
      (typeof signal !== 'object' ||
        signal === null ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      protocolError('OpenOPC browser capability request signal is invalid');
    }
    if (signal?.aborted) {
      return Promise.reject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'));
    }
    const key = tokenKey(input);
    const cached = cache.get(key);
    if (cached && cached.expiresAt - 30_000 > now()) return cached.token;
    let pending = pendingRequests.get(key);
    if (!pending) {
      pending = startRequest(input, key);
      pendingRequests.set(key, pending);
    }
    return subscribeToTokenRequest(pending, signal, () => {
      pending.subscribers -= 1;
      if (pending.subscribers === 0 && pendingRequests.get(key) === pending) {
        pending.controller.abort();
      }
    });
  };

  getToken.invalidate = (input) => {
    if (isServiceOperation(input?.service, input?.operation)) cache.delete(tokenKey(input));
  };
  return getToken;
}

/** @deprecated Use createOpenOpcBrowserCapabilityTokenAdapter. */
export const createSandboxModuleServiceTokenAdapter = createOpenOpcBrowserCapabilityTokenAdapter;

/** @deprecated Use OpenOpcBrowserCapabilityTokenAdapterOptions. */
export type SandboxModuleServiceTokenAdapterOptions = OpenOpcBrowserCapabilityTokenAdapterOptions;

/** @deprecated Use OpenOpcBrowserCapabilityTokenEvent. */
export type SandboxModuleServiceAdapterEvent = OpenOpcBrowserCapabilityTokenEvent;

/** @deprecated Use OpenOpcBrowserCapabilityTokenEventTarget. */
export type SandboxModuleServiceAdapterEventTarget = OpenOpcBrowserCapabilityTokenEventTarget;

/** @deprecated Use OpenOpcBrowserCapabilityTokenHostWindow. */
export type SandboxModuleServiceHostWindow = OpenOpcBrowserCapabilityTokenHostWindow;
