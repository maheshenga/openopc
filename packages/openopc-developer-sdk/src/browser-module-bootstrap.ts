import {
  type OpenOpcBrowserCapabilityTokenEvent,
  type OpenOpcBrowserCapabilityTokenEventTarget,
  type OpenOpcBrowserCapabilityTokenHostWindow,
  type OpenOpcBrowserCapabilityTokenRequest,
  createOpenOpcBrowserCapabilityTokenAdapter,
} from './browser-capability-token.js';
import {
  type OpenOpcModuleClient,
  type OpenOpcModuleContext,
  type OpenOpcModuleFetch,
  createOpenOpcModuleClient,
} from './client.js';
import { OpenOpcModuleRequestError } from './errors.js';

const REQUEST_TYPE = 'openopc.module.bootstrap.request' as const;
const RESPONSE_TYPE = 'openopc.module.bootstrap.response' as const;
const SDK_API_VERSION = 'v1' as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
const MAX_BOOTSTRAP_TIMEOUT_MS = 30_000;
const OPTION_KEYS = new Set([
  'window',
  'signal',
  'bootstrapTimeoutMs',
  'timeoutMs',
  'fetch',
  'requestId',
]);

export interface OpenOpcBrowserModuleBootstrapRequest {
  type: typeof REQUEST_TYPE;
  requestId: string;
  sdkApiVersion: typeof SDK_API_VERSION;
}

export interface OpenOpcBrowserModuleBootstrapResponse {
  type: typeof RESPONSE_TYPE;
  requestId: string;
  sdkApiVersion: typeof SDK_API_VERSION;
  context: OpenOpcModuleContext;
}

export interface OpenOpcBrowserModuleParentWindow extends OpenOpcBrowserCapabilityTokenHostWindow {
  postMessage(
    message: OpenOpcBrowserCapabilityTokenRequest | OpenOpcBrowserModuleBootstrapRequest,
    targetOrigin: string,
  ): void;
}

export interface OpenOpcBrowserModuleWindow extends OpenOpcBrowserCapabilityTokenEventTarget {
  readonly parent: OpenOpcBrowserModuleParentWindow;
}

export interface OpenOpcBrowserModuleClientOptions {
  window?: OpenOpcBrowserModuleWindow;
  signal?: AbortSignal;
  bootstrapTimeoutMs?: number;
  timeoutMs?: number;
  fetch?: OpenOpcModuleFetch;
  requestId?: () => string;
}

export class OpenOpcBrowserModuleBootstrapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenOpcBrowserModuleBootstrapProtocolError';
  }
}

function protocolError(message: string): never {
  throw new OpenOpcBrowserModuleBootstrapProtocolError(message);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  );
}

function validateOptions(options: OpenOpcBrowserModuleClientOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !OPTION_KEYS.has(key)) ||
    (options.signal !== undefined && !isAbortSignalLike(options.signal)) ||
    (options.fetch !== undefined && typeof options.fetch !== 'function') ||
    (options.requestId !== undefined && typeof options.requestId !== 'function')
  ) {
    protocolError('OpenOPC browser bootstrap options are invalid');
  }
  if (
    options.bootstrapTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.bootstrapTimeoutMs) ||
      options.bootstrapTimeoutMs <= 0 ||
      options.bootstrapTimeoutMs > MAX_BOOTSTRAP_TIMEOUT_MS)
  ) {
    protocolError('OpenOPC browser bootstrap timeout is invalid');
  }
}

function isBootstrapResponse(
  value: unknown,
  requestId: string,
): value is OpenOpcBrowserModuleBootstrapResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'context,requestId,sdkApiVersion,type' &&
    record.type === RESPONSE_TYPE &&
    record.requestId === requestId &&
    record.sdkApiVersion === SDK_API_VERSION &&
    isModuleContext(record.context)
  );
}

function isModuleContext(value: unknown): value is OpenOpcModuleContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'installRevision,installationId,projectId,releaseId' &&
    typeof record.projectId === 'string' &&
    UUID_RE.test(record.projectId) &&
    typeof record.installationId === 'string' &&
    UUID_RE.test(record.installationId) &&
    typeof record.releaseId === 'string' &&
    UUID_RE.test(record.releaseId) &&
    Number.isSafeInteger(record.installRevision) &&
    (record.installRevision as number) > 0
  );
}

function identifiesBootstrapResponse(value: unknown, requestId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === RESPONSE_TYPE && record.requestId === requestId;
}

function canonicalHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function resolveBrowserWindow(candidate?: OpenOpcBrowserModuleWindow): OpenOpcBrowserModuleWindow {
  const browserWindow =
    candidate ??
    (typeof globalThis.window === 'object'
      ? (globalThis.window as unknown as OpenOpcBrowserModuleWindow)
      : undefined);
  if (
    !browserWindow ||
    typeof browserWindow.addEventListener !== 'function' ||
    typeof browserWindow.removeEventListener !== 'function' ||
    !browserWindow.parent ||
    typeof browserWindow.parent.postMessage !== 'function' ||
    Object.is(browserWindow.parent, browserWindow)
  ) {
    protocolError('OpenOPC browser bootstrap requires an embedded module window');
  }
  return browserWindow;
}

function discoverPlatformOrigin(
  browserWindow: OpenOpcBrowserModuleWindow,
  options: OpenOpcBrowserModuleClientOptions,
): Promise<{ origin: string; context: OpenOpcModuleContext }> {
  validateOptions(options);
  const requestId = (options.requestId ?? (() => globalThis.crypto.randomUUID()))();
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    return Promise.reject(
      new OpenOpcBrowserModuleBootstrapProtocolError(
        'OpenOPC browser bootstrap request id is invalid',
      ),
    );
  }
  if (options.signal?.aborted) {
    return Promise.reject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'));
  }

  const timeoutMs = options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  return new Promise<{ origin: string; context: OpenOpcModuleContext }>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      browserWindow.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finishResolve = (origin: string, context: OpenOpcModuleContext) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ origin, context });
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishProtocolError = (message: string) => {
      finishReject(new OpenOpcBrowserModuleBootstrapProtocolError(message));
    };
    const onAbort = () => {
      finishReject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'));
    };
    const onMessage = (event: OpenOpcBrowserCapabilityTokenEvent) => {
      if (settled || event.source !== browserWindow.parent) return;
      if (!identifiesBootstrapResponse(event.data, requestId)) return;
      const origin = canonicalHttpsOrigin(event.origin);
      if (!origin || !isBootstrapResponse(event.data, requestId)) {
        finishProtocolError('OpenOPC browser bootstrap response is invalid');
        return;
      }
      finishResolve(origin, event.data.context);
    };

    browserWindow.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      finishReject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'));
    }, timeoutMs);
    if (options.signal?.aborted) onAbort();
    if (settled) return;

    try {
      browserWindow.parent.postMessage(
        { type: REQUEST_TYPE, requestId, sdkApiVersion: SDK_API_VERSION },
        '*',
      );
    } catch {
      finishReject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED'));
    }
  });
}

export async function createOpenOpcBrowserModuleClient(
  options: OpenOpcBrowserModuleClientOptions = {},
): Promise<OpenOpcModuleClient> {
  validateOptions(options);
  const browserWindow = resolveBrowserWindow(options.window);
  const { origin: platformOrigin, context } = await discoverPlatformOrigin(browserWindow, options);
  const getCapabilityToken = createOpenOpcBrowserCapabilityTokenAdapter({
    hostOrigin: platformOrigin,
    hostWindow: browserWindow.parent,
    eventTarget: browserWindow,
    requestId: options.requestId,
  });
  return createOpenOpcModuleClient({
    baseUrl: platformOrigin,
    context,
    getCapabilityToken,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
}
