import {
  type CreateDeveloperPaymentOrderInput,
  CreateDeveloperPaymentOrderInputSchema,
  type CreateDeveloperPaymentOrderResult,
  CreateDeveloperPaymentOrderResultSchema,
  type CreateDeveloperPaymentRefundInput,
  CreateDeveloperPaymentRefundInputSchema,
  type DeveloperPaymentOrderView,
  DeveloperPaymentOrderViewSchema,
  type DeveloperPaymentRefundView,
  DeveloperPaymentRefundViewSchema,
  type OpenOpcImageAsset,
  OpenOpcImageAssetListSchema,
  type OpenOpcImageAssetList,
  type OpenOpcImageEstimate,
  OpenOpcImageEstimateRequestSchema,
  OpenOpcImageEstimateSchema,
  type OpenOpcImageEstimateRequest,
  type OpenOpcImageJob,
  OpenOpcImageJobCreateInputSchema,
  type OpenOpcImageJobCreateInput,
  OpenOpcImageJobCreateResultSchema,
  type OpenOpcImageJobCreateResult,
  OpenOpcImageJobEventListSchema,
  type OpenOpcImageJobEventList,
  OpenOpcImageJobSchema,
  OpenOpcImageJobListSchema,
  type OpenOpcImageJobList,
  OpenOpcImageListInputSchema,
  type OpenOpcImageListInput,
  OpenOpcImageModelSchema,
  type OpenOpcImageModel,
  OpenOpcImageAssetSchema,
  ModulePaymentIdempotencyKeySchema,
  ModuleServiceCapabilityRequestSchema,
  type ModuleServiceErrorCode,
  ModuleServiceErrorResponseSchema,
  RELEASE_PROFILE_UNAVAILABLE,
  ReleaseProfileUnavailableSchema,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
} from './contracts.js';
import { OpenOpcModuleRequestError, type OpenOpcModuleRequestErrorCode } from './errors.js';

const MAX_TOKEN_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const REQUEST_KEYS = new Set([
  'service',
  'operation',
  'method',
  'path',
  'body',
  'rawBody',
  'contentType',
  'idempotencyKey',
  'signal',
  'timeoutMs',
]);
const REQUEST_OPTION_KEYS = new Set(['signal', 'timeoutMs']);
const PROVIDER_SELECTION_KEYS = new Set([
  'provider',
  'baseUrl',
  'base_url',
  'apiKey',
  'api_key',
  'headers',
]);

export type OpenOpcModuleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenOpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OpenOpcModuleClientOptions {
  baseUrl: string;
  getCapabilityToken(
    input: {
      service: OpenOpcServiceName;
      operation: OpenOpcServiceOperation;
    },
    options?: Pick<OpenOpcRequestOptions, 'signal'>,
  ): Promise<string>;
  fetch?: OpenOpcModuleFetch;
  timeoutMs?: number;
}

export interface OpenOpcModuleTransportRequest extends OpenOpcRequestOptions {
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  idempotencyKey?: string;
}

export interface OpenOpcModel {
  id: string;
  object: 'model';
  owned_by: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context: number; output: number };
}

export interface OpenOpcChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | readonly unknown[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: readonly unknown[];
}

export interface OpenOpcChatCompletionRequest {
  model: string;
  messages: readonly OpenOpcChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: number;
  stop?: string | readonly string[] | null;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  response_format?: Record<string, unknown>;
  tools?: readonly unknown[];
  tool_choice?: unknown;
  user?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenOpcChatCompletion {
  id: string;
  object: string;
  created?: number;
  model: string;
  choices: readonly Record<string, unknown>[];
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenOpcChatChunk {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: readonly Record<string, unknown>[];
  usage?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface OpenOpcAiClient {
  models: {
    list(options?: OpenOpcRequestOptions): Promise<{ data: OpenOpcModel[] }>;
  };
  chat: {
    create(
      input: OpenOpcChatCompletionRequest & { stream?: false },
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcChatCompletion>;
    create(
      input: OpenOpcChatCompletionRequest & { stream: true },
      options?: OpenOpcRequestOptions,
    ): Promise<AsyncIterable<OpenOpcChatChunk>>;
  };
  images: {
    models: {
      list(options?: OpenOpcRequestOptions): Promise<{ data: OpenOpcImageModel[] }>;
    };
    estimates: {
      create(
        input: OpenOpcImageEstimateRequest,
        options?: OpenOpcRequestOptions,
      ): Promise<OpenOpcImageEstimate>;
    };
    jobs: {
      create(
        input: OpenOpcImageJobCreateInput,
        idempotencyKey: string,
        options?: OpenOpcRequestOptions,
      ): Promise<OpenOpcImageJobCreateResult>;
      list(
        input?: OpenOpcImageListInput,
        options?: OpenOpcRequestOptions,
      ): Promise<OpenOpcImageJobList>;
      get(jobId: string, options?: OpenOpcRequestOptions): Promise<OpenOpcImageJob>;
      events(
        jobId: string,
        input?: OpenOpcImageListInput,
        options?: OpenOpcRequestOptions,
      ): Promise<OpenOpcImageJobEventList>;
      cancel(jobId: string, options?: OpenOpcRequestOptions): Promise<OpenOpcImageJob>;
    };
    assets: {
      create(
        input: Blob | ArrayBuffer | Uint8Array,
        options?: OpenOpcRequestOptions,
      ): Promise<OpenOpcImageAsset>;
      list(
        input?: OpenOpcImageListInput,
        options?: OpenOpcRequestOptions,
      ): Promise<OpenOpcImageAssetList>;
      get(assetId: string, options?: OpenOpcRequestOptions): Promise<OpenOpcImageAsset>;
      download(assetId: string, options?: OpenOpcRequestOptions): Promise<Blob>;
    };
  };
}

export interface OpenOpcPaymentClient {
  orders: {
    create(
      input: CreateDeveloperPaymentOrderInput,
      idempotencyKey: string,
      options?: OpenOpcRequestOptions,
    ): Promise<CreateDeveloperPaymentOrderResult>;
    get(orderId: string, options?: OpenOpcRequestOptions): Promise<DeveloperPaymentOrderView>;
  };
  refunds: {
    create(
      orderId: string,
      input: CreateDeveloperPaymentRefundInput,
      idempotencyKey: string,
      options?: OpenOpcRequestOptions,
    ): Promise<DeveloperPaymentRefundView>;
  };
}

export interface OpenOpcModuleClient {
  request<T = unknown>(input: OpenOpcModuleTransportRequest): Promise<T>;
  ai: OpenOpcAiClient;
  payments: OpenOpcPaymentClient;
}

export class OpenOpcModuleProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenOpcModuleProtocolError';
  }
}

export class OpenOpcModuleServiceError extends Error {
  constructor(
    readonly code: ModuleServiceErrorCode | typeof RELEASE_PROFILE_UNAVAILABLE,
    readonly status: number,
    readonly capability?: string,
  ) {
    super(code);
    this.name = 'OpenOpcModuleServiceError';
  }
}

export { OpenOpcModuleRequestError };
export type { OpenOpcModuleRequestErrorCode };

function protocolError(message: string): never {
  throw new OpenOpcModuleProtocolError(message);
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

function validateTimeoutMs(value: unknown): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) ||
      (value as number) <= 0 ||
      (value as number) > MAX_REQUEST_TIMEOUT_MS)
  ) {
    protocolError('OpenOPC module service request timeout is invalid');
  }
}

function validateRequestOptions(options: OpenOpcRequestOptions): void {
  if (options.signal !== undefined && !isAbortSignalLike(options.signal)) {
    protocolError('OpenOPC module service request signal is invalid');
  }
  validateTimeoutMs(options.timeoutMs);
}

function withRequestOptions(
  input: Omit<OpenOpcModuleTransportRequest, keyof OpenOpcRequestOptions>,
  options?: OpenOpcRequestOptions,
): OpenOpcModuleTransportRequest {
  if (options === undefined) return input;
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !REQUEST_OPTION_KEYS.has(key))
  ) {
    protocolError('OpenOPC module service request options are invalid');
  }
  validateRequestOptions(options);
  return { ...input, signal: options.signal, timeoutMs: options.timeoutMs };
}

interface RequestContext {
  signal: AbortSignal;
  cleanup: () => void;
  error: () => OpenOpcModuleRequestError;
}

function createRequestContext(
  options: OpenOpcRequestOptions,
  defaultTimeoutMs: number,
): RequestContext {
  validateRequestOptions(options);
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    throw new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED');
  }

  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const onCallerAbort = () => {
    controller.abort();
    cleanup();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    cleanup();
  }, timeoutMs);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

  return {
    signal: controller.signal,
    cleanup,
    error: () =>
      new OpenOpcModuleRequestError(
        timedOut ? 'OPENOPC_MODULE_REQUEST_TIMEOUT' : 'OPENOPC_MODULE_REQUEST_ABORTED',
      ),
  };
}

async function abortable<T>(operation: Promise<T>, context: RequestContext): Promise<T> {
  if (context.signal.aborted) throw context.error();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      context.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(context.error());
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function requestFailure(error: unknown, context: RequestContext): never {
  if (error instanceof OpenOpcModuleProtocolError) throw error;
  if (error instanceof OpenOpcModuleServiceError) throw error;
  if (error instanceof OpenOpcModuleRequestError) throw error;
  if (context.signal.aborted) throw context.error();
  throw new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED');
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
  validateRequestOptions(input);
  const capability = ModuleServiceCapabilityRequestSchema.safeParse({
    service: input.service,
    operations: [input.operation],
  });
  if (
    !capability.success ||
    (input.method !== 'GET' && input.method !== 'POST' && input.method !== 'PUT')
  ) {
    protocolError('OpenOPC module service request is invalid');
  }
  if (
    (input.method === 'GET' && (input.body !== undefined || input.rawBody !== undefined)) ||
    (input.body !== undefined && input.rawBody !== undefined)
  ) {
    protocolError('OpenOPC module service request is invalid');
  }
  if (
    input.rawBody !== undefined &&
    (input.method !== 'POST' || typeof input.contentType !== 'string' || input.contentType.length > 128)
  ) {
    protocolError('OpenOPC module service request is invalid');
  }
  if (
    input.idempotencyKey !== undefined &&
    (input.method !== 'POST' ||
      !ModulePaymentIdempotencyKeySchema.safeParse(input.idempotencyKey).success)
  ) {
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

function validateChatInput(input: OpenOpcChatCompletionRequest): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => PROVIDER_SELECTION_KEYS.has(key)) ||
    typeof input.model !== 'string' ||
    input.model.length === 0 ||
    input.model.length > 512 ||
    input.model.trim() !== input.model ||
    !Array.isArray(input.messages) ||
    input.messages.length === 0 ||
    input.messages.length > 1024 ||
    (input.stream !== undefined && typeof input.stream !== 'boolean') ||
    input.messages.some(
      (message) =>
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
        !Object.hasOwn(message, 'content'),
    )
  ) {
    protocolError('OpenOPC AI chat request is invalid');
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

async function readResponseText(response: Response, context: RequestContext): Promise<string> {
  try {
    return await abortable(response.text(), context);
  } catch (error) {
    requestFailure(error, context);
  }
}

async function* parseEventStream(
  response: Response,
  context: RequestContext,
): AsyncIterable<OpenOpcChatChunk> {
  try {
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      protocolError('OpenOPC module service returned an invalid stream');
    }
    if (!response.body) protocolError('OpenOPC module service returned an invalid stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), context);
        buffer += decoder.decode(value, { stream: !done });
        if (buffer.length > MAX_RESPONSE_BYTES) {
          protocolError('OpenOPC module service response is too large');
        }

        let separator = /\r?\n\r?\n/.exec(buffer);
        while (separator?.index !== undefined) {
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data === '[DONE]') {
            completed = true;
            return;
          }
          if (data) {
            const parsed = parseJson(data);
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed) ||
              typeof (parsed as Record<string, unknown>).id !== 'string' ||
              !Array.isArray((parsed as Record<string, unknown>).choices)
            ) {
              protocolError('OpenOPC module service returned an invalid stream');
            }
            yield parsed as OpenOpcChatChunk;
          }
          separator = /\r?\n\r?\n/.exec(buffer);
        }
        if (done) {
          if (buffer.trim() !== '') {
            protocolError('OpenOPC module service returned an invalid stream');
          }
          completed = true;
          return;
        }
      }
    } catch (error) {
      if (error instanceof OpenOpcModuleProtocolError) throw error;
      requestFailure(error, context);
    } finally {
      // `reader.cancel()` is best effort; the lifecycle error above is the
      // authoritative result when the consumer or platform aborts the stream.
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    context.cleanup();
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
  validateTimeoutMs(options.timeoutMs);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (typeof requestFetch !== 'function') {
    protocolError('OpenOPC module client options are invalid');
  }

  const send = async (
    input: OpenOpcModuleTransportRequest,
  ): Promise<{ response: Response; context: RequestContext }> => {
    validateRequest(input);
    const context = createRequestContext(
      input,
      options.timeoutMs ??
        (input.operation === 'text.stream'
          ? DEFAULT_STREAM_TIMEOUT_MS
          : DEFAULT_REQUEST_TIMEOUT_MS),
    );
    let handedOff = false;
    try {
      const token = validateToken(
        await abortable(
          Promise.resolve().then(() =>
            options.getCapabilityToken(
              {
                service: input.service,
                operation: input.operation,
              },
              { signal: context.signal },
            ),
          ),
          context,
        ),
      );
      const headers = new Headers({
        Accept:
          input.operation === 'text.stream'
            ? 'text/event-stream'
            : input.operation === 'images.assets.download'
              ? 'image/*'
              : 'application/json',
        Authorization: `Bearer ${token}`,
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
      });
      let body: string | undefined;
      let rawBody: BodyInit | undefined;
      if (input.rawBody !== undefined) {
        headers.set('Content-Type', input.contentType ?? 'application/octet-stream');
        rawBody = input.rawBody;
      } else if (input.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        try {
          body = JSON.stringify(input.body);
        } catch {
          protocolError('OpenOPC module service request body is invalid');
        }
        if (body === undefined) protocolError('OpenOPC module service request body is invalid');
      }

      const response = await abortable(
        Promise.resolve().then(() =>
          requestFetch(new URL(input.path, baseUrl), {
            method: input.method,
            headers,
            body: rawBody ?? body,
            signal: context.signal,
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
          }),
        ),
        context,
      );
      if (!response.ok) {
        const payload = parseJson(await readResponseText(response, context));
        const parsed = ModuleServiceErrorResponseSchema.safeParse(payload);
        if (parsed.success) {
          throw new OpenOpcModuleServiceError(parsed.data.error, response.status);
        }
        const releaseProfile = ReleaseProfileUnavailableSchema.safeParse(payload);
        if (releaseProfile.success) {
          throw new OpenOpcModuleServiceError(
            RELEASE_PROFILE_UNAVAILABLE,
            response.status,
            releaseProfile.data.capability,
          );
        }
        protocolError('OpenOPC module service returned an invalid error response');
      }
      handedOff = true;
      return { response, context };
    } catch (error) {
      requestFailure(error, context);
    } finally {
      if (!handedOff) context.cleanup();
    }
  };

  const request = async <T>(input: OpenOpcModuleTransportRequest): Promise<T> => {
    const sent = await send(input);
    try {
      return parseJson(await readResponseText(sent.response, sent.context)) as T;
    } finally {
      sent.context.cleanup();
    }
  };

  const requestBlob = async (
    input: OpenOpcModuleTransportRequest,
    options?: OpenOpcRequestOptions,
  ): Promise<Blob> => {
    const sent = await send(withRequestOptions(input, options));
    try {
      let bytes: ArrayBuffer;
      try {
        bytes = await abortable(sent.response.arrayBuffer(), sent.context);
      } catch (error) {
        requestFailure(error, sent.context);
      }
      if (bytes.byteLength <= 0) protocolError('OpenOPC module service returned an invalid image response');
      if (bytes.byteLength > MAX_BINARY_BYTES) protocolError('OpenOPC module service response is too large');
      const contentType = sent.response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (!contentType || !IMAGE_MIME_TYPES.includes(contentType as (typeof IMAGE_MIME_TYPES)[number])) {
        protocolError('OpenOPC module service returned an invalid image response');
      }
      return new Blob([new Uint8Array(bytes)], {
        type: contentType,
      });
    } finally {
      sent.context.cleanup();
    }
  };

  const requestRawJson = async <T>(
    input: OpenOpcModuleTransportRequest,
    options?: OpenOpcRequestOptions,
  ): Promise<T> => request<T>(withRequestOptions(input, options));

  async function createChat(
    input: OpenOpcChatCompletionRequest & { stream: true },
    options?: OpenOpcRequestOptions,
  ): Promise<AsyncIterable<OpenOpcChatChunk>>;
  async function createChat(
    input: OpenOpcChatCompletionRequest & { stream?: false },
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcChatCompletion>;
  async function createChat(
    input: OpenOpcChatCompletionRequest,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcChatCompletion | AsyncIterable<OpenOpcChatChunk>> {
    validateChatInput(input);
    if (input.stream === true) {
      const sent = await send(
        withRequestOptions(
          {
            service: 'ai',
            operation: 'text.stream',
            method: 'POST',
            path: '/v1/module-services/ai/chat/completions',
            body: input,
          },
          options,
        ),
      );
      return parseEventStream(sent.response, sent.context);
    }
    return request<OpenOpcChatCompletion>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'text.generate',
          method: 'POST',
          path: '/v1/module-services/ai/chat/completions',
          body: input,
        },
        options,
      ),
    );
  }

  const imagePath = (suffix: string) => `/v1/module-services/ai/images/${suffix}`;
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function validateImageId(value: string, label: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      protocolError(`OpenOPC module image ${label} is invalid`);
    }
  }

  function validateImageIdempotencyKey(value: string): void {
    if (!ModulePaymentIdempotencyKeySchema.safeParse(value).success) {
      protocolError('OpenOPC module image idempotency key is invalid');
    }
  }

  function normalizeImageListInput(input: OpenOpcImageListInput | undefined): OpenOpcImageListInput {
    const parsed = OpenOpcImageListInputSchema.safeParse(input ?? {});
    if (!parsed.success) protocolError('OpenOPC module image list input is invalid');
    return parsed.data;
  }

  function asImageBody(input: Blob | ArrayBuffer | Uint8Array): Blob {
    if (input instanceof Blob) return input;
    if (input instanceof ArrayBuffer) return new Blob([new Uint8Array(input)]);
    if (input instanceof Uint8Array) {
      return new Blob([new Uint8Array(input)]);
    }
    protocolError('OpenOPC module image asset input is invalid');
  }

  const listImageModels = async (
    options?: OpenOpcRequestOptions,
  ): Promise<{ data: OpenOpcImageModel[] }> => {
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.models.read',
        method: 'GET',
        path: imagePath('models'),
      },
      options,
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      protocolError('OpenOPC module image model response is invalid');
    }
    const data = (value as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length > 1024) {
      protocolError('OpenOPC module image model response is invalid');
    }
    const models: OpenOpcImageModel[] = [];
    for (const item of data) {
      const parsed = OpenOpcImageModelSchema.safeParse(item);
      if (!parsed.success) protocolError('OpenOPC module image model response is invalid');
      models.push(parsed.data);
    }
    return { data: models };
  };

  const createImageEstimate = async (
    input: OpenOpcImageEstimateRequest,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageEstimate> => {
    const parsedInput = OpenOpcImageEstimateRequestSchema.safeParse(input);
    if (!parsedInput.success) protocolError('OpenOPC module image estimate input is invalid');
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.estimates.create',
        method: 'POST',
        path: imagePath('estimates'),
        body: parsedInput.data,
      },
      options,
    );
    const parsed = OpenOpcImageEstimateSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image estimate response is invalid');
    return parsed.data;
  };

  const createImageJob = async (
    input: OpenOpcImageJobCreateInput,
    idempotencyKey: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJobCreateResult> => {
    const parsedInput = OpenOpcImageJobCreateInputSchema.safeParse(input);
    if (!parsedInput.success) protocolError('OpenOPC module image job input is invalid');
    validateImageIdempotencyKey(idempotencyKey);
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.jobs.create',
        method: 'POST',
        path: imagePath('jobs'),
        body: parsedInput.data,
        idempotencyKey,
      },
      options,
    );
    const parsed = OpenOpcImageJobCreateResultSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image job response is invalid');
    return parsed.data;
  };

  const listImageJobs = async (
    input?: OpenOpcImageListInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJobList> => {
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.jobs.read',
        method: 'POST',
        path: imagePath('jobs/list'),
        body: normalizeImageListInput(input),
      },
      options,
    );
    const parsed = OpenOpcImageJobListSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image job list response is invalid');
    return parsed.data;
  };

  const getImageJob = async (
    jobId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJob> => {
    validateImageId(jobId, 'job id');
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.jobs.read',
        method: 'GET',
        path: imagePath(`jobs/${jobId}`),
      },
      options,
    );
    const parsed = OpenOpcImageJobSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image job response is invalid');
    return parsed.data;
  };

  const getImageJobEvents = async (
    jobId: string,
    input?: OpenOpcImageListInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJobEventList> => {
    validateImageId(jobId, 'job id');
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.jobs.read',
        method: 'POST',
        path: imagePath(`jobs/${jobId}/events`),
        body: normalizeImageListInput(input),
      },
      options,
    );
    const parsed = OpenOpcImageJobEventListSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image event response is invalid');
    return parsed.data;
  };

  const cancelImageJob = async (
    jobId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJob> => {
    validateImageId(jobId, 'job id');
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.jobs.cancel',
        method: 'POST',
        path: imagePath(`jobs/${jobId}/cancel`),
      },
      options,
    );
    const parsed = OpenOpcImageJobSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image job response is invalid');
    return parsed.data;
  };

  const createImageAsset = async (
    input: Blob | ArrayBuffer | Uint8Array,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAsset> => {
    const body = asImageBody(input);
    if (!IMAGE_MIME_TYPES.includes(body.type as (typeof IMAGE_MIME_TYPES)[number])) {
      protocolError('OpenOPC module image asset MIME type is invalid');
    }
    if (body.size <= 0 || body.size > MAX_BINARY_BYTES) {
      protocolError('OpenOPC module image asset size is invalid');
    }
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.assets.create',
        method: 'POST',
        path: imagePath('assets'),
        rawBody: body,
        contentType: body.type,
      },
      options,
    );
    const parsed = OpenOpcImageAssetSchema.safeParse(value);
    if (!parsed.success || parsed.data.size_bytes !== body.size) {
      protocolError('OpenOPC module image asset response is invalid');
    }
    return parsed.data;
  };

  const listImageAssets = async (
    input?: OpenOpcImageListInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAssetList> => {
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.assets.read',
        method: 'POST',
        path: imagePath('assets/list'),
        body: normalizeImageListInput(input),
      },
      options,
    );
    const parsed = OpenOpcImageAssetListSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image asset list response is invalid');
    return parsed.data;
  };

  const getImageAsset = async (
    assetId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAsset> => {
    validateImageId(assetId, 'asset id');
    const value = await requestRawJson<unknown>(
      {
        service: 'ai',
        operation: 'images.assets.read',
        method: 'GET',
        path: imagePath(`assets/${assetId}`),
      },
      options,
    );
    const parsed = OpenOpcImageAssetSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module image asset response is invalid');
    return parsed.data;
  };

  const downloadImageAsset = async (
    assetId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<Blob> => {
    validateImageId(assetId, 'asset id');
    return requestBlob(
      {
        service: 'ai',
        operation: 'images.assets.download',
        method: 'POST',
        path: imagePath(`assets/${assetId}/content`),
      },
      options,
    );
  };

  const createPaymentOrder = async (
    input: CreateDeveloperPaymentOrderInput,
    idempotencyKey: string,
    options?: OpenOpcRequestOptions,
  ): Promise<CreateDeveloperPaymentOrderResult> => {
    if (!CreateDeveloperPaymentOrderInputSchema.safeParse(input).success) {
      protocolError('OpenOPC module payment order input is invalid');
    }
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'payment',
          operation: 'orders.create',
          method: 'POST',
          path: '/v1/module-services/payments/orders',
          body: input,
          idempotencyKey,
        },
        options,
      ),
    );
    const parsed = CreateDeveloperPaymentOrderResultSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module payment response is invalid');
    return parsed.data;
  };

  const getPaymentOrder = async (
    orderId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<DeveloperPaymentOrderView> => {
    if (typeof orderId !== 'string' || orderId.length === 0) {
      protocolError('OpenOPC module payment order id is invalid');
    }
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'payment',
          operation: 'orders.read',
          method: 'GET',
          path: `/v1/module-services/payments/orders/${encodeURIComponent(orderId)}`,
        },
        options,
      ),
    );
    const parsed = DeveloperPaymentOrderViewSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module payment response is invalid');
    return parsed.data;
  };

  const createPaymentRefund = async (
    orderId: string,
    input: CreateDeveloperPaymentRefundInput,
    idempotencyKey: string,
    options?: OpenOpcRequestOptions,
  ): Promise<DeveloperPaymentRefundView> => {
    if (typeof orderId !== 'string' || orderId.length === 0) {
      protocolError('OpenOPC module payment order id is invalid');
    }
    if (!CreateDeveloperPaymentRefundInputSchema.safeParse(input).success) {
      protocolError('OpenOPC module payment refund input is invalid');
    }
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'payment',
          operation: 'refunds.create',
          method: 'POST',
          path: `/v1/module-services/payments/orders/${encodeURIComponent(orderId)}/refunds`,
          body: input,
          idempotencyKey,
        },
        options,
      ),
    );
    const parsed = DeveloperPaymentRefundViewSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module payment response is invalid');
    return parsed.data;
  };

  return {
    request,
    ai: {
      models: {
        list: (options?: OpenOpcRequestOptions) =>
          request<{ data: OpenOpcModel[] }>(
            withRequestOptions(
              {
                service: 'ai',
                operation: 'models.read',
                method: 'GET',
                path: '/v1/module-services/ai/models',
              },
              options,
            ),
          ),
      },
      chat: { create: createChat },
      images: {
        models: { list: listImageModels },
        estimates: { create: createImageEstimate },
        jobs: {
          create: createImageJob,
          list: listImageJobs,
          get: getImageJob,
          events: getImageJobEvents,
          cancel: cancelImageJob,
        },
        assets: {
          create: createImageAsset,
          list: listImageAssets,
          get: getImageAsset,
          download: downloadImageAsset,
        },
      },
    },
    payments: {
      orders: {
        create: createPaymentOrder,
        get: getPaymentOrder,
      },
      refunds: { create: createPaymentRefund },
    },
  };
}
