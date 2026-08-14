import {
  OPENOPC_AI_SERVICE_OPERATIONS,
  OPENOPC_DATA_SERVICE_OPERATIONS,
  OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  OPENOPC_SETTINGS_SERVICE_OPERATIONS,
} from '@openopc/developer-sdk';
import type { OpenOpcServiceName, OpenOpcServiceOperation } from './client';

export {
  createOpenOpcBrowserCapabilityTokenAdapter,
  createSandboxModuleServiceTokenAdapter,
  OpenOpcBrowserCapabilityTokenProtocolError,
} from '@openopc/developer-sdk';
export type {
  OpenOpcBrowserCapabilityTokenAdapterOptions,
  OpenOpcBrowserCapabilityTokenEvent,
  OpenOpcBrowserCapabilityTokenEventTarget,
  OpenOpcBrowserCapabilityTokenGetter,
  OpenOpcBrowserCapabilityTokenHostWindow,
  OpenOpcBrowserCapabilityTokenRequest,
  OpenOpcBrowserCapabilityTokenRequestOptions,
  OpenOpcBrowserCapabilityTokenResponse,
  SandboxModuleServiceAdapterEvent,
  SandboxModuleServiceAdapterEventTarget,
  SandboxModuleServiceHostWindow,
  SandboxModuleServiceTokenAdapterOptions,
} from '@openopc/developer-sdk';

const REQUEST_TYPE = 'openopc.module-service.token.request' as const;
const RESPONSE_TYPE = 'openopc.module-service.token.response' as const;
const ERROR_RESPONSE_TYPE = 'openopc.module-service.token.error' as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_OPERATIONS: Record<OpenOpcServiceName, readonly OpenOpcServiceOperation[]> = {
  ai: OPENOPC_AI_SERVICE_OPERATIONS,
  payment: OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  data: OPENOPC_DATA_SERVICE_OPERATIONS,
  settings: OPENOPC_SETTINGS_SERVICE_OPERATIONS,
};

export interface ModuleServiceTokenRequest {
  type: typeof REQUEST_TYPE;
  requestId: string;
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
}

export interface ModuleServiceTokenResponse {
  type: typeof RESPONSE_TYPE;
  requestId: string;
  token: string;
  expiresAt: string;
}

export interface ModuleServiceTokenErrorResponse {
  type: typeof ERROR_RESPONSE_TYPE;
  requestId: string;
  error: {
    code: 'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED';
    retryAfterMs: number;
  };
}

export type ModuleServiceTokenMessage =
  | ModuleServiceTokenResponse
  | ModuleServiceTokenErrorResponse;

export interface ModuleServiceMessageSource {
  postMessage: (message: ModuleServiceTokenMessage, targetOrigin: string) => void;
}

export interface ModuleServiceBridgeMessage {
  origin: string;
  source: ModuleServiceMessageSource;
  data: unknown;
}

export interface ModuleServiceTokenIssueInput {
  projectId: string;
  installationId: string;
  releaseId: string;
  installRevision: number;
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
}

export type ModuleServiceHostState = Omit<ModuleServiceTokenIssueInput, 'service' | 'operation'>;

export interface ModuleServiceBridgeOptions extends ModuleServiceHostState {
  moduleOrigin: string;
  moduleSource: ModuleServiceMessageSource;
  declaredServices: Readonly<
    Partial<Record<OpenOpcServiceName, readonly OpenOpcServiceOperation[]>>
  >;
  issueToken: (input: ModuleServiceTokenIssueInput) => Promise<{
    token: string;
    expiresAt: string;
  }>;
  resolveCurrentState: () => ModuleServiceHostState | Promise<ModuleServiceHostState>;
  now?: () => number;
  maxRequestsPerMinute?: number;
}

export interface ModuleServiceBridge {
  handleMessage(message: ModuleServiceBridgeMessage): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequest(value: unknown): value is ModuleServiceTokenRequest {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'operation,requestId,service,type') return false;
  return (
    value.type === REQUEST_TYPE &&
    typeof value.requestId === 'string' &&
    UUID_RE.test(value.requestId) &&
    (value.service === 'ai' ||
      value.service === 'payment' ||
      value.service === 'data' ||
      value.service === 'settings') &&
    typeof value.operation === 'string' &&
    SERVICE_OPERATIONS[value.service].includes(value.operation as never)
  );
}

function allowedOperation(
  declaredServices: ModuleServiceBridgeOptions['declaredServices'],
  service: OpenOpcServiceName,
  operation: OpenOpcServiceOperation,
): boolean {
  return declaredServices[service]?.includes(operation) ?? false;
}

function immutableOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function sameHostState(left: ModuleServiceHostState, right: ModuleServiceHostState): boolean {
  return (
    left.projectId === right.projectId &&
    left.installationId === right.installationId &&
    left.releaseId === right.releaseId &&
    left.installRevision === right.installRevision
  );
}

function validIssuedToken(issued: { token: string; expiresAt: string }, now: number): boolean {
  const expiresAt = Date.parse(issued.expiresAt);
  return (
    typeof issued.token === 'string' &&
    issued.token.startsWith('v4.public.') &&
    issued.token.length <= 8_192 &&
    !/\s/.test(issued.token) &&
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    expiresAt <= now + 5 * 60_000
  );
}

export function createModuleServiceBridge(
  options: ModuleServiceBridgeOptions,
): ModuleServiceBridge {
  const moduleOrigin = immutableOrigin(options.moduleOrigin);
  if (!moduleOrigin) throw new Error('Module service origin must be an immutable HTTPS origin');
  if (
    !UUID_RE.test(options.projectId) ||
    !UUID_RE.test(options.installationId) ||
    !UUID_RE.test(options.releaseId)
  ) {
    throw new Error('Module service host state is invalid');
  }
  if (!Number.isSafeInteger(options.installRevision) || options.installRevision <= 0) {
    throw new Error('Module service installation revision is invalid');
  }
  const now = options.now ?? (() => Date.now());
  const limit = Math.max(1, Math.trunc(options.maxRequestsPerMinute ?? 30));
  const requestTimes: number[] = [];

  return {
    async handleMessage(message) {
      if (
        message.origin !== moduleOrigin ||
        message.source !== options.moduleSource ||
        !isRequest(message.data)
      )
        return false;
      const request = message.data;
      if (!allowedOperation(options.declaredServices, request.service, request.operation))
        return false;

      let currentState: ModuleServiceHostState;
      try {
        currentState = await options.resolveCurrentState();
      } catch {
        return false;
      }
      if (!sameHostState(options, currentState)) return false;

      const issuedAt = now();
      const cutoff = issuedAt - 60_000;
      while (requestTimes[0] !== undefined && requestTimes[0] <= cutoff) requestTimes.shift();
      if (requestTimes.length >= limit) {
        const oldest = requestTimes[0] ?? issuedAt;
        message.source.postMessage(
          {
            type: ERROR_RESPONSE_TYPE,
            requestId: request.requestId,
            error: {
              code: 'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED',
              retryAfterMs: Math.max(0, Math.min(60_000, 60_000 - (issuedAt - oldest))),
            },
          },
          moduleOrigin,
        );
        return true;
      }
      requestTimes.push(issuedAt);

      let issued: { token: string; expiresAt: string };
      try {
        issued = await options.issueToken({
          projectId: currentState.projectId,
          installationId: currentState.installationId,
          releaseId: currentState.releaseId,
          installRevision: currentState.installRevision,
          service: request.service,
          operation: request.operation,
        });
      } catch {
        return false;
      }
      if (!validIssuedToken(issued, issuedAt)) return false;
      message.source.postMessage(
        {
          type: RESPONSE_TYPE,
          requestId: request.requestId,
          token: issued.token,
          expiresAt: issued.expiresAt,
        },
        moduleOrigin,
      );
      return true;
    },
  };
}

/** Attach the host bridge to a window and return a deterministic cleanup callback. */
export function attachModuleServiceBridge(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  options: ModuleServiceBridgeOptions,
): () => void {
  const bridge = createModuleServiceBridge(options);
  const listener = (event: MessageEvent) => {
    void bridge.handleMessage(event as unknown as ModuleServiceBridgeMessage);
  };
  target.addEventListener('message', listener);
  return () => target.removeEventListener('message', listener);
}
