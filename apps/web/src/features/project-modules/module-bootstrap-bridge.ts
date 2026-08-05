const REQUEST_TYPE = 'openopc.module.bootstrap.request' as const;
const RESPONSE_TYPE = 'openopc.module.bootstrap.response' as const;
const SDK_API_VERSION = 'v1' as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ModuleBootstrapRequest {
  type: typeof REQUEST_TYPE;
  requestId: string;
  sdkApiVersion: typeof SDK_API_VERSION;
}

export interface ModuleBootstrapResponse {
  type: typeof RESPONSE_TYPE;
  requestId: string;
  sdkApiVersion: typeof SDK_API_VERSION;
}

export interface ModuleBootstrapMessageSource {
  postMessage(message: ModuleBootstrapResponse, targetOrigin: string): void;
}

export interface ModuleBootstrapBridgeMessage {
  origin: string;
  source: ModuleBootstrapMessageSource;
  data: unknown;
}

export interface ModuleBootstrapBridgeOptions {
  moduleOrigin: string;
  moduleSource: ModuleBootstrapMessageSource;
  sdkApiVersion: typeof SDK_API_VERSION;
}

export interface ModuleBootstrapBridge {
  handleMessage(message: ModuleBootstrapBridgeMessage): boolean;
}

function immutableHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function isBootstrapRequest(value: unknown): value is ModuleBootstrapRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'requestId,sdkApiVersion,type' &&
    record.type === REQUEST_TYPE &&
    typeof record.requestId === 'string' &&
    UUID_RE.test(record.requestId) &&
    record.sdkApiVersion === SDK_API_VERSION
  );
}

export function createModuleBootstrapBridge(
  options: ModuleBootstrapBridgeOptions,
): ModuleBootstrapBridge {
  const moduleOrigin = immutableHttpsOrigin(options?.moduleOrigin);
  if (
    !moduleOrigin ||
    !options.moduleSource ||
    typeof options.moduleSource.postMessage !== 'function' ||
    options.sdkApiVersion !== SDK_API_VERSION
  ) {
    throw new Error('OpenOPC module bootstrap bridge options are invalid');
  }

  return {
    handleMessage(message) {
      if (
        message.origin !== moduleOrigin ||
        message.source !== options.moduleSource ||
        !isBootstrapRequest(message.data)
      ) {
        return false;
      }
      message.source.postMessage(
        {
          type: RESPONSE_TYPE,
          requestId: message.data.requestId,
          sdkApiVersion: options.sdkApiVersion,
        },
        moduleOrigin,
      );
      return true;
    },
  };
}

export function attachModuleBootstrapBridge(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  options: ModuleBootstrapBridgeOptions,
): () => void {
  const bridge = createModuleBootstrapBridge(options);
  const listener = (event: MessageEvent) => {
    bridge.handleMessage(event as unknown as ModuleBootstrapBridgeMessage);
  };
  target.addEventListener('message', listener);
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    target.removeEventListener('message', listener);
  };
}
