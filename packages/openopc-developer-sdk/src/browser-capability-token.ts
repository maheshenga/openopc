import type { OpenOpcServiceName, OpenOpcServiceOperation } from './contracts.js';
import { OpenOpcModuleRequestError } from './errors.js';

const REQUEST_TYPE = 'openopc.module-service.token.request' as const;
const RESPONSE_TYPE = 'openopc.module-service.token.response' as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_OPERATIONS: Record<OpenOpcServiceName, readonly OpenOpcServiceOperation[]> = {
  ai: ['models.read', 'text.generate', 'text.stream'],
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

export type OpenOpcBrowserCapabilityTokenGetter = (
  input: {
    service: OpenOpcServiceName;
    operation: OpenOpcServiceOperation;
  },
  options?: OpenOpcBrowserCapabilityTokenRequestOptions,
) => Promise<string>;

export interface OpenOpcBrowserCapabilityTokenRequestOptions {
  signal?: AbortSignal;
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
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    protocolError('OpenOPC browser capability token timeout is invalid');
  }

  return async (input, requestOptions) => {
    if (!isServiceOperation(input?.service, input?.operation)) {
      protocolError('OpenOPC browser capability service operation is invalid');
    }
    const id = requestId();
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      protocolError('OpenOPC browser capability request id is invalid');
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

    return new Promise<string>((resolve, reject) => {
      const timeout: { id?: ReturnType<typeof setTimeout> } = {};
      let settled = false;
      let timedOut = false;
      const cleanup = () => {
        if (timeout.id !== undefined) clearTimeout(timeout.id);
        options.eventTarget.removeEventListener('message', listener);
        signal?.removeEventListener('abort', onAbort);
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
        if (settled) return;
        if (
          event.origin !== hostOrigin ||
          event.source !== options.hostWindow ||
          !isResponse(event.data, id)
        ) {
          return;
        }
        settled = true;
        cleanup();
        resolve(event.data.token);
      };
      options.eventTarget.addEventListener('message', listener);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout.id = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      if (signal?.aborted) onAbort();
      if (settled) return;
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
  };
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
