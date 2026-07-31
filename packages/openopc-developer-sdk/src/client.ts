import {
  ModuleServiceCapabilityRequestSchema,
  type ModuleServiceErrorCode,
  ModuleServiceErrorResponseSchema,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
} from '@kortix/api-contract';

const MAX_TOKEN_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_KEYS = new Set(['service', 'operation', 'method', 'path', 'body']);

export type OpenOpcModuleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenOpcModuleClientOptions {
  baseUrl: string;
  getCapabilityToken(input: {
    service: OpenOpcServiceName;
    operation: OpenOpcServiceOperation;
  }): Promise<string>;
  fetch?: OpenOpcModuleFetch;
}

export interface OpenOpcModuleTransportRequest {
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface OpenOpcModuleClient {
  request<T = unknown>(input: OpenOpcModuleTransportRequest): Promise<T>;
}

export class OpenOpcModuleProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenOpcModuleProtocolError';
  }
}

export class OpenOpcModuleServiceError extends Error {
  constructor(
    readonly code: ModuleServiceErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = 'OpenOpcModuleServiceError';
  }
}

function protocolError(message: string): never {
  throw new OpenOpcModuleProtocolError(message);
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    protocolError('OpenOPC module service base URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !['/', '/v1', '/v1/'].includes(url.pathname)
  ) {
    protocolError('OpenOPC module service base URL is invalid');
  }
  return new URL(url.origin);
}

function validateRequest(input: OpenOpcModuleTransportRequest): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((key) => !REQUEST_KEYS.has(key))
  ) {
    protocolError('OpenOPC module service request is invalid');
  }
  const capability = ModuleServiceCapabilityRequestSchema.safeParse({
    service: input.service,
    operations: [input.operation],
  });
  if (!capability.success || (input.method !== 'GET' && input.method !== 'POST')) {
    protocolError('OpenOPC module service request is invalid');
  }
  if (input.method === 'GET' && input.body !== undefined) {
    protocolError('OpenOPC module service request is invalid');
  }
  const expectedPrefix =
    input.service === 'ai' ? '/v1/module-services/ai/' : '/v1/module-services/payments/';
  if (
    typeof input.path !== 'string' ||
    !input.path.startsWith(expectedPrefix) ||
    input.path.includes('\\') ||
    input.path.includes('//') ||
    input.path.includes('?') ||
    input.path.includes('#') ||
    input.path.includes('%') ||
    input.path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    protocolError('OpenOPC module service path is invalid');
  }
}

function validateToken(token: string): string {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !token.startsWith('v4.public.') ||
    /\s/.test(token)
  ) {
    protocolError('OpenOPC module service capability is invalid');
  }
  return token;
}

function parseJson(text: string): unknown {
  if (text.length > MAX_RESPONSE_BYTES) {
    protocolError('OpenOPC module service response is too large');
  }
  try {
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    protocolError('OpenOPC module service returned invalid JSON');
  }
}

export function createOpenOpcModuleClient(
  options: OpenOpcModuleClientOptions,
): OpenOpcModuleClient {
  if (
    !options ||
    typeof options !== 'object' ||
    typeof options.getCapabilityToken !== 'function' ||
    (options.fetch !== undefined && typeof options.fetch !== 'function')
  ) {
    protocolError('OpenOPC module client options are invalid');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (typeof requestFetch !== 'function') {
    protocolError('OpenOPC module client options are invalid');
  }

  return {
    async request<T>(input: OpenOpcModuleTransportRequest): Promise<T> {
      validateRequest(input);
      const token = validateToken(
        await options.getCapabilityToken({ service: input.service, operation: input.operation }),
      );
      const headers = new Headers({
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      });
      let body: string | undefined;
      if (input.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        try {
          body = JSON.stringify(input.body);
        } catch {
          protocolError('OpenOPC module service request body is invalid');
        }
        if (body === undefined) protocolError('OpenOPC module service request body is invalid');
      }

      let response: Response;
      try {
        response = await requestFetch(new URL(input.path, baseUrl), {
          method: input.method,
          headers,
          body,
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        protocolError('OpenOPC module service request failed');
      }
      let responseText: string;
      try {
        responseText = await response.text();
      } catch {
        protocolError('OpenOPC module service response failed');
      }
      const payload = parseJson(responseText);
      if (!response.ok) {
        const parsed = ModuleServiceErrorResponseSchema.safeParse(payload);
        if (!parsed.success) {
          protocolError('OpenOPC module service returned an invalid error response');
        }
        throw new OpenOpcModuleServiceError(parsed.data.error, response.status);
      }
      return payload as T;
    },
  };
}
