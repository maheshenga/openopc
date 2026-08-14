import {
  type OpenOpcChatCompletionRequest as ContractOpenOpcChatCompletionRequest,
  type OpenOpcModel as ContractOpenOpcModel,
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
  ModulePaymentIdempotencyKeySchema,
  ModuleServiceCapabilityRequestSchema,
  type ModuleServiceErrorCode,
  ModuleServiceErrorResponseSchema,
  OPENOPC_IMAGE_ASSET_MAX_BYTES,
  OPENOPC_IMAGE_MIME_TYPES,
  OpenOpcChatCompletionRequestSchema,
  type OpenOpcImageAsset,
  type OpenOpcImageAssetCreateMetadata,
  OpenOpcImageAssetCreateMetadataSchema,
  type OpenOpcImageAssetDeleteResult,
  OpenOpcImageAssetDeleteResultSchema,
  type OpenOpcImageAssetListInput,
  OpenOpcImageAssetListInputSchema,
  type OpenOpcImageAssetPage,
  OpenOpcImageAssetPageSchema,
  type OpenOpcImageAssetPreview,
  OpenOpcImageAssetPreviewSchema,
  OpenOpcImageAssetSchema,
  type OpenOpcImageAssetThumbnail,
  type OpenOpcImageAssetThumbnailInput,
  OpenOpcImageAssetThumbnailInputSchema,
  OpenOpcImageAssetThumbnailSchema,
  type OpenOpcImageEstimate,
  type OpenOpcImageEstimateCreateInput,
  OpenOpcImageEstimateCreateInputSchema,
  type OpenOpcImageEstimateRetryGuidance,
  OpenOpcImageEstimateSchema,
  type OpenOpcImageEventFailureMode,
  OpenOpcImageEventFailureModeSchema,
  type OpenOpcImageEventHistoryState,
  type OpenOpcImageJob,
  type OpenOpcImageJobCreateInput,
  OpenOpcImageJobCreateInputSchema,
  type OpenOpcImageJobEvent,
  type OpenOpcImageJobEventPage,
  OpenOpcImageJobEventPageSchema,
  type OpenOpcImageJobListInput,
  OpenOpcImageJobListInputSchema,
  type OpenOpcImageJobPage,
  OpenOpcImageJobPageSchema,
  OpenOpcImageJobSchema,
  type OpenOpcImageModelListResponse,
  OpenOpcImageModelListResponseSchema,
  type OpenOpcImagePageInput,
  OpenOpcImagePageInputSchema,
  type OpenOpcModelListResponse,
  OpenOpcModelListResponseSchema,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
  openOpcImageEstimateRetryGuidance,
} from './contracts.js';
import {
  type OpenOpcModuleDocument,
  OpenOpcModuleDocumentDeleteInputSchema,
  type OpenOpcModuleDocumentDeleteResult,
  OpenOpcModuleDocumentDeleteResultSchema,
  OpenOpcModuleDocumentKeySchema,
  type OpenOpcModuleDocumentListInput,
  OpenOpcModuleDocumentListInputSchema,
  type OpenOpcModuleDocumentPage,
  OpenOpcModuleDocumentPageSchema,
  OpenOpcModuleDocumentSchema,
  type OpenOpcModuleDocumentValue,
  OpenOpcModuleDocumentWriteInputSchema,
} from './data-contracts.js';
import { OpenOpcModuleRequestError, type OpenOpcModuleRequestErrorCode } from './errors.js';
import {
  type OpenOpcEffectiveModuleSettings,
  OpenOpcEffectiveModuleSettingsSchema,
} from './settings-contracts.js';

const MAX_TOKEN_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_DOCUMENT_RESPONSE_BYTES = 3 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const MODULE_CONTEXT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEYS = new Set([
  'service',
  'operation',
  'method',
  'path',
  'body',
  'query',
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

export interface OpenOpcCapabilityTokenGetter {
  (
    input: {
      service: OpenOpcServiceName;
      operation: OpenOpcServiceOperation;
    },
    options?: Pick<OpenOpcRequestOptions, 'signal'>,
  ): Promise<string>;
  invalidate?: (input: {
    service: OpenOpcServiceName;
    operation: OpenOpcServiceOperation;
  }) => void;
}

export interface OpenOpcModuleContext {
  readonly projectId: string;
  readonly installationId: string;
  readonly releaseId: string;
  readonly installRevision: number;
}

export interface OpenOpcModuleClientOptions {
  baseUrl: string;
  context?: OpenOpcModuleContext;
  getCapabilityToken: OpenOpcCapabilityTokenGetter;
  fetch?: OpenOpcModuleFetch;
  timeoutMs?: number;
}

export interface OpenOpcModuleTransportRequest extends OpenOpcRequestOptions {
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
}

export type OpenOpcModel = ContractOpenOpcModel;
export type OpenOpcChatMessage = ContractOpenOpcChatCompletionRequest['messages'][number];
export type OpenOpcChatCompletionRequest = ContractOpenOpcChatCompletionRequest;

export interface OpenOpcImageAssetCreateInput extends OpenOpcImageAssetCreateMetadata {
  file: Blob;
}

export interface OpenOpcImageWaitUpdate {
  job: OpenOpcImageJob;
  event?: OpenOpcImageJobEvent;
  progress?: number;
  retryAfterMs?: number;
  cursor: string | null;
  eventHistory: OpenOpcImageEventHistoryState;
  eventErrorCode?: 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE';
  terminal: boolean;
}

export interface OpenOpcImageWaitOptions extends OpenOpcRequestOptions {
  cursor?: string | null;
  pollIntervalMs?: number;
  initialEventPage?: OpenOpcImageJobEventPage;
  eventFailureMode?: OpenOpcImageEventFailureMode;
  onEvent?: (event: OpenOpcImageJobEvent) => void;
  onUpdate?: (update: OpenOpcImageWaitUpdate) => void;
}

export interface OpenOpcImageAssetCreateOptions extends OpenOpcRequestOptions {
  metadata?: OpenOpcImageAssetCreateMetadata;
}

export interface OpenOpcImageAssetListAllOptions extends OpenOpcImageAssetListInput {
  maxItems?: number;
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
    list(options?: OpenOpcRequestOptions): Promise<OpenOpcModelListResponse>;
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
  images: OpenOpcImageClient;
}

export interface OpenOpcImageClient {
  models: {
    list(options?: OpenOpcRequestOptions): Promise<OpenOpcImageModelListResponse>;
  };
  estimates: {
    create(
      input: OpenOpcImageEstimateCreateInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageEstimate>;
    isExpired(estimate: OpenOpcImageEstimate, now?: Date): boolean;
    retryGuidance(errorOrCode: unknown): OpenOpcImageEstimateRetryGuidance;
  };
  jobs: {
    list(
      input?: OpenOpcImageJobListInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageJobPage>;
    create(
      input: OpenOpcImageJobCreateInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageJob>;
    get(jobId: string, options?: OpenOpcRequestOptions): Promise<OpenOpcImageJob>;
    events(
      jobId: string,
      input?: { cursor?: string | null; limit?: number },
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageJobEventPage>;
    outputs(
      jobId: string,
      input?: OpenOpcImagePageInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAssetPage>;
    cancel(jobId: string, options?: OpenOpcRequestOptions): Promise<OpenOpcImageJob>;
    subscribe(
      jobId: string,
      options?: OpenOpcImageWaitOptions,
    ): AsyncIterable<OpenOpcImageWaitUpdate>;
    waitForTerminal(jobId: string, options?: OpenOpcImageWaitOptions): Promise<OpenOpcImageJob>;
  };
  assets: {
    create(
      input: OpenOpcImageAssetCreateInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAsset>;
    create(
      file: Blob,
      metadata?: OpenOpcImageAssetCreateMetadata,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAsset>;
    list(
      input?: OpenOpcImageAssetListInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAssetPage>;
    pages(
      input?: OpenOpcImageAssetListInput,
      options?: OpenOpcRequestOptions,
    ): AsyncIterable<OpenOpcImageAssetPage>;
    listAll(
      input?: OpenOpcImageAssetListAllOptions,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAsset[]>;
    preview(assetId: string, options?: OpenOpcRequestOptions): Promise<OpenOpcImageAssetPreview>;
    thumbnail(
      assetId: string,
      input?: OpenOpcImageAssetThumbnailInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAssetThumbnail>;
    download(assetId: string, options?: OpenOpcRequestOptions): Promise<Blob>;
    delete(
      assetId: string,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAssetDeleteResult>;
    setRetention(
      assetId: string,
      policy: 'temporary' | 'retained',
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcImageAsset>;
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

export interface OpenOpcDataClient {
  documents: {
    list(
      input?: OpenOpcModuleDocumentListInput,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcModuleDocumentPage>;
    read(key: string, options?: OpenOpcRequestOptions): Promise<OpenOpcModuleDocument>;
    write(
      key: string,
      input: { expected_revision: number | null; value: OpenOpcModuleDocumentValue },
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcModuleDocument>;
    delete(
      key: string,
      expectedRevision: number,
      options?: OpenOpcRequestOptions,
    ): Promise<OpenOpcModuleDocumentDeleteResult>;
  };
}

export interface OpenOpcSettingsClient {
  read(options?: OpenOpcRequestOptions): Promise<OpenOpcEffectiveModuleSettings>;
}

export interface OpenOpcModuleClient {
  readonly context: OpenOpcModuleContext | null;
  request<T = unknown>(input: OpenOpcModuleTransportRequest): Promise<T>;
  ai: OpenOpcAiClient;
  payments: OpenOpcPaymentClient;
  data: OpenOpcDataClient;
  settings: OpenOpcSettingsClient;
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

export type OpenOpcImageEventHistoryErrorCode = 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE';

/** Event history could not be read and the caller opted out of polling fallback. */
export class OpenOpcImageEventHistoryError extends Error {
  readonly code: OpenOpcImageEventHistoryErrorCode = 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE';

  constructor() {
    super('OpenOPC image event history is unavailable');
    this.name = 'OpenOpcImageEventHistoryError';
  }
}

export type OpenOpcImagePaginationErrorCode = 'OPENOPC_IMAGE_PAGINATION_CURSOR_REPEATED';

/** A page endpoint returned a cursor already consumed by this iterator. */
export class OpenOpcImagePaginationError extends Error {
  readonly code: OpenOpcImagePaginationErrorCode = 'OPENOPC_IMAGE_PAGINATION_CURSOR_REPEATED';

  constructor() {
    super('OpenOPC image pagination cursor repeated');
    this.name = 'OpenOpcImagePaginationError';
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

function validateModuleContext(value: unknown): value is OpenOpcModuleContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    protocolError('OpenOPC module client context is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'installRevision,installationId,projectId,releaseId' ||
    typeof record.projectId !== 'string' ||
    !MODULE_CONTEXT_UUID_RE.test(record.projectId) ||
    typeof record.installationId !== 'string' ||
    !MODULE_CONTEXT_UUID_RE.test(record.installationId) ||
    typeof record.releaseId !== 'string' ||
    !MODULE_CONTEXT_UUID_RE.test(record.releaseId) ||
    !Number.isSafeInteger(record.installRevision) ||
    (record.installRevision as number) <= 0
  ) {
    protocolError('OpenOPC module client context is invalid');
  }
  return true;
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
  if (!capability.success || !['GET', 'POST', 'PUT', 'DELETE'].includes(input.method)) {
    protocolError('OpenOPC module service request is invalid');
  }
  if (input.method === 'GET' && input.body !== undefined) {
    protocolError('OpenOPC module service request is invalid');
  }
  if (input.query !== undefined) {
    if (
      !input.query ||
      typeof input.query !== 'object' ||
      Array.isArray(input.query) ||
      Object.keys(input.query).some((key) => {
        const value = input.query?.[key];
        return (
          !/^[A-Za-z0-9_.~-]{1,64}$/.test(key) ||
          (value !== undefined &&
            (typeof value !== 'string' || value.length > 2048) &&
            (typeof value !== 'number' || !Number.isFinite(value)))
        );
      })
    ) {
      protocolError('OpenOPC module service query is invalid');
    }
  }
  if (
    input.idempotencyKey !== undefined &&
    (input.method !== 'POST' ||
      !ModulePaymentIdempotencyKeySchema.safeParse(input.idempotencyKey).success)
  ) {
    protocolError('OpenOPC module service request is invalid');
  }
  const expectedPrefix = {
    ai: '/v1/module-services/ai/',
    payment: '/v1/module-services/payments/',
    data: '/v1/module-services/data/',
    settings: '/v1/module-services/settings/',
  }[input.service];
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    protocolError('OpenOPC AI chat request is invalid');
  }
  if (Object.keys(input).some((key) => PROVIDER_SELECTION_KEYS.has(key))) {
    protocolError('OpenOPC AI chat request is invalid');
  }
  if (!OpenOpcChatCompletionRequestSchema.safeParse(input).success) {
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

function parseJson(text: string, maxBytes = MAX_RESPONSE_BYTES): unknown {
  if (text.length > maxBytes) {
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

async function readResponseBlob(response: Response, context: RequestContext): Promise<Blob> {
  try {
    return await abortable(response.blob(), context);
  } catch (error) {
    requestFailure(error, context);
  }
}

function validateResourceId(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    /[\\/?#%]/.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    protocolError(`OpenOPC image ${label} is invalid`);
  }
  return value;
}

function isBlobValue(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function validateImagePageInput(input: { cursor?: string | null; limit?: number } | undefined) {
  if (input === undefined) return;
  if (!OpenOpcImagePageInputSchema.safeParse(input).success) {
    protocolError('OpenOPC image page input is invalid');
  }
}

function validateImageJobListInput(input: OpenOpcImageJobListInput | undefined) {
  if (input === undefined) return;
  if (!OpenOpcImageJobListInputSchema.safeParse(input).success) {
    protocolError('OpenOPC image job list input is invalid');
  }
}

function validateImageAssetListInput(input: OpenOpcImageAssetListInput | undefined) {
  if (input === undefined) return;
  if (!OpenOpcImageAssetListInputSchema.safeParse(input).success) {
    protocolError('OpenOPC image asset list input is invalid');
  }
}

function validateImageWaitOptions(options: OpenOpcImageWaitOptions | undefined): void {
  if (options === undefined) return;
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'signal',
          'timeoutMs',
          'cursor',
          'pollIntervalMs',
          'initialEventPage',
          'eventFailureMode',
          'onEvent',
          'onUpdate',
        ].includes(key),
    )
  ) {
    protocolError('OpenOPC image wait options are invalid');
  }
  validateRequestOptions(options);
  if (
    options.cursor !== undefined &&
    options.cursor !== null &&
    (typeof options.cursor !== 'string' ||
      options.cursor.length < 1 ||
      options.cursor.length > 2048)
  ) {
    protocolError('OpenOPC image wait cursor is invalid');
  }
  if (
    options.pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 50 ||
      options.pollIntervalMs > 10_000)
  ) {
    protocolError('OpenOPC image wait interval is invalid');
  }
  if (
    options.initialEventPage !== undefined &&
    !OpenOpcImageJobEventPageSchema.safeParse(options.initialEventPage).success
  ) {
    protocolError('OpenOPC image initial event page is invalid');
  }
  if (options.cursor !== undefined && options.initialEventPage !== undefined) {
    protocolError('OpenOPC image wait cursor is ambiguous');
  }
  if (
    options.eventFailureMode !== undefined &&
    !OpenOpcImageEventFailureModeSchema.safeParse(options.eventFailureMode).success
  ) {
    protocolError('OpenOPC image event failure mode is invalid');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    protocolError('OpenOPC image wait event callback is invalid');
  }
  if (options.onUpdate !== undefined && typeof options.onUpdate !== 'function') {
    protocolError('OpenOPC image wait update callback is invalid');
  }
}

function isTerminalImageJob(job: OpenOpcImageJob): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(job.status);
}

function isTerminalImageEvent(event: OpenOpcImageJobEvent): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(event.type);
}

function shouldFallbackFromImageEvents(error: unknown): boolean {
  if (error instanceof OpenOpcModuleRequestError) {
    return error.code === 'OPENOPC_MODULE_REQUEST_FAILED';
  }
  if (error instanceof OpenOpcModuleServiceError) {
    return (
      error.status >= 500 ||
      error.code === 'OPENOPC_IMAGE_EVENT_CURSOR_EXPIRED' ||
      error.code === 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE'
    );
  }
  return false;
}

function imageEstimateIsExpired(estimate: OpenOpcImageEstimate, now = new Date()): boolean {
  const parsed = OpenOpcImageEstimateSchema.safeParse(estimate);
  if (!parsed.success || !(now instanceof Date) || Number.isNaN(now.getTime())) return true;
  const expiresAt = Date.parse(parsed.data.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  if (options.context !== undefined) validateModuleContext(options.context);
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
      const isDownload = input.path.endsWith('/download');
      const headers = new Headers({
        Accept:
          input.operation === 'text.stream'
            ? 'text/event-stream'
            : isDownload
              ? 'image/*'
              : 'application/json',
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
      });
      let body: BodyInit | undefined;
      if (input.body !== undefined) {
        if (typeof FormData !== 'undefined' && input.body instanceof FormData) {
          body = input.body;
        } else if (typeof Blob !== 'undefined' && input.body instanceof Blob) {
          body = input.body;
        } else {
          headers.set('Content-Type', 'application/json');
          try {
            body = JSON.stringify(input.body);
          } catch {
            protocolError('OpenOPC module service request body is invalid');
          }
          if (body === undefined) protocolError('OpenOPC module service request body is invalid');
        }
      }

      const url = new URL(input.path, baseUrl);
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      let token = validateToken(
        await abortable(
          Promise.resolve().then(() =>
            options.getCapabilityToken(
              { service: input.service, operation: input.operation },
              { signal: context.signal },
            ),
          ),
          context,
        ),
      );
      for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
        headers.set('Authorization', `Bearer ${token}`);
        const response = await abortable(
          Promise.resolve().then(() =>
            requestFetch(url, {
              method: input.method,
              headers,
              body,
              signal: context.signal,
              credentials: 'omit',
              redirect: 'error',
              referrerPolicy: 'no-referrer',
            }),
          ),
          context,
        );
        if ((response.status === 401 || response.status === 403) && authAttempt === 0) {
          try {
            options.getCapabilityToken.invalidate?.({
              service: input.service,
              operation: input.operation,
            });
          } catch {
            // An optional cache invalidator must not prevent the one safe retry.
          }
          try {
            await response.body?.cancel();
          } catch {
            // The unauthorized response is discarded before the retry.
          }
          token = validateToken(
            await abortable(
              Promise.resolve().then(() =>
                options.getCapabilityToken(
                  { service: input.service, operation: input.operation },
                  { signal: context.signal },
                ),
              ),
              context,
            ),
          );
          continue;
        }
        if (!response.ok) {
          const payload = parseJson(await readResponseText(response, context));
          const parsed = ModuleServiceErrorResponseSchema.safeParse(payload);
          if (!parsed.success) {
            protocolError('OpenOPC module service returned an invalid error response');
          }
          throw new OpenOpcModuleServiceError(parsed.data.error, response.status);
        }
        handedOff = true;
        return { response, context };
      }
      throw new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED');
    } catch (error) {
      requestFailure(error, context);
    } finally {
      if (!handedOff) context.cleanup();
    }
  };

  const request = async <T>(input: OpenOpcModuleTransportRequest): Promise<T> => {
    const sent = await send(input);
    try {
      return parseJson(
        await readResponseText(sent.response, sent.context),
        input.service === 'data' ? MAX_DOCUMENT_RESPONSE_BYTES : MAX_RESPONSE_BYTES,
      ) as T;
    } finally {
      sent.context.cleanup();
    }
  };

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

  const listModels = async (options?: OpenOpcRequestOptions): Promise<OpenOpcModelListResponse> => {
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'models.read',
          method: 'GET',
          path: '/v1/module-services/ai/models',
        },
        options,
      ),
    );
    const parsed = OpenOpcModelListResponseSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC AI model response is invalid');
    return parsed.data;
  };

  const listImageModels = async (
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageModelListResponse> => {
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: '/v1/module-services/ai/images/models',
        },
        options,
      ),
    );
    const parsed = OpenOpcImageModelListResponseSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image model response is invalid');
    return parsed.data;
  };

  const createImageEstimate = async (
    input: OpenOpcImageEstimateCreateInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageEstimate> => {
    if (!OpenOpcImageEstimateCreateInputSchema.safeParse(input).success) {
      protocolError('OpenOPC image estimate input is invalid');
    }
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'POST',
          path: '/v1/module-services/ai/images/estimates',
          body: input,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageEstimateSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image estimate response is invalid');
    return parsed.data;
  };

  const createImageJob = async (
    input: OpenOpcImageJobCreateInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJob> => {
    if (!OpenOpcImageJobCreateInputSchema.safeParse(input).success) {
      protocolError('OpenOPC image job input is invalid');
    }
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'POST',
          path: '/v1/module-services/ai/images/jobs',
          body: input,
          idempotencyKey: input.idempotency_key,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageJobSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image job response is invalid');
    return parsed.data;
  };

  const listImageJobs = async (
    input?: OpenOpcImageJobListInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJobPage> => {
    validateImageJobListInput(input);
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: '/v1/module-services/ai/images/jobs',
          query: {
            cursor: input?.cursor ?? undefined,
            limit: input?.limit,
            status: input?.status,
            created_after: input?.created_after,
            created_before: input?.created_before,
          },
        },
        options,
      ),
    );
    const parsed = OpenOpcImageJobPageSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image job page response is invalid');
    return parsed.data;
  };

  const getImageJob = async (
    jobId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJob> => {
    validateResourceId(jobId, 'job id');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: `/v1/module-services/ai/images/jobs/${encodeURIComponent(jobId)}`,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageJobSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image job response is invalid');
    return parsed.data;
  };

  const getImageJobEvents = async (
    jobId: string,
    input?: OpenOpcImagePageInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJobEventPage> => {
    validateResourceId(jobId, 'job id');
    validateImagePageInput(input);
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: `/v1/module-services/ai/images/jobs/${encodeURIComponent(jobId)}/events`,
          query: {
            cursor: input?.cursor ?? undefined,
            limit: input?.limit,
          },
        },
        options,
      ),
    );
    const parsed = OpenOpcImageJobEventPageSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image event response is invalid');
    return parsed.data;
  };

  const getImageJobOutputs = async (
    jobId: string,
    input?: OpenOpcImagePageInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAssetPage> => {
    validateResourceId(jobId, 'job id');
    validateImagePageInput(input);
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: `/v1/module-services/ai/images/jobs/${encodeURIComponent(jobId)}/outputs`,
          query: {
            cursor: input?.cursor ?? undefined,
            limit: input?.limit,
          },
        },
        options,
      ),
    );
    const parsed = OpenOpcImageAssetPageSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image job outputs response is invalid');
    return parsed.data;
  };

  const cancelImageJob = async (
    jobId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageJob> => {
    validateResourceId(jobId, 'job id');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'POST',
          path: `/v1/module-services/ai/images/jobs/${encodeURIComponent(jobId)}/cancel`,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageJobSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image job response is invalid');
    return parsed.data;
  };

  const subscribeToImageJob = async function* (
    jobId: string,
    options?: OpenOpcImageWaitOptions,
  ): AsyncIterable<OpenOpcImageWaitUpdate> {
    validateResourceId(jobId, 'job id');
    validateImageWaitOptions(options);
    const waitTimeoutMs = options?.timeoutMs ?? 300_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    const eventFailureMode = options?.eventFailureMode ?? 'fallback-to-polling';
    const waitController = new AbortController();
    let timedOut = false;
    let cleaned = false;
    const callerSignal = options?.signal;
    if (callerSignal?.aborted) {
      throw new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED');
    }
    const onCallerAbort = () => waitController.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      waitController.abort();
    }, waitTimeoutMs);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    const startedAt = Date.now();
    const requestOptions = (): OpenOpcRequestOptions => {
      const remaining = waitTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        timedOut = true;
        waitController.abort();
      }
      return {
        signal: waitController.signal,
        timeoutMs: Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, remaining)),
      };
    };
    let eventHistory: OpenOpcImageEventHistoryState = 'available';
    let cursor = options?.cursor ?? null;
    const seenEventIds = new Set<string>();
    let pendingRetryAfterMs = 0;
    let job: OpenOpcImageJob;

    const emit = (input: {
      job: OpenOpcImageJob;
      event?: OpenOpcImageJobEvent;
      progress?: number;
      retryAfterMs?: number;
      eventErrorCode?: 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE';
    }): OpenOpcImageWaitUpdate => {
      const update: OpenOpcImageWaitUpdate = {
        job: input.job,
        ...(input.event ? { event: input.event } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
        ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
        cursor,
        eventHistory,
        ...(input.eventErrorCode ? { eventErrorCode: input.eventErrorCode } : {}),
        terminal:
          isTerminalImageJob(input.job) ||
          Boolean(input.event && isTerminalImageEvent(input.event)),
      };
      options?.onUpdate?.(update);
      return update;
    };

    const acceptEvent = (event: OpenOpcImageJobEvent): boolean => {
      if (event.job_id !== jobId) protocolError('OpenOPC image event job id is invalid');
      if (seenEventIds.has(event.event_id)) return false;
      seenEventIds.add(event.event_id);
      cursor = event.cursor;
      options?.onEvent?.(event);
      return true;
    };

    try {
      job = await getImageJob(jobId, requestOptions());
      const initialEventPage = options?.initialEventPage;
      if (initialEventPage) {
        for (const event of initialEventPage.items) {
          if (!acceptEvent(event)) continue;
          if (event.type === 'retry-scheduled') {
            pendingRetryAfterMs = Math.max(pendingRetryAfterMs, event.retry_after_ms ?? 0);
          }
          yield emit({
            job,
            event,
            ...(event.type === 'progress' ? { progress: event.progress } : {}),
            ...(event.type === 'retry-scheduled'
              ? { retryAfterMs: event.retry_after_ms ?? 0 }
              : {}),
          });
        }
        cursor = initialEventPage.next_cursor ?? cursor;
      }
      yield emit({ job });
      while (!isTerminalImageJob(job)) {
        let retryAfterMs = pendingRetryAfterMs;
        pendingRetryAfterMs = 0;
        if (eventHistory === 'available') {
          try {
            const page = await getImageJobEvents(jobId, { cursor, limit: 100 }, requestOptions());
            for (const event of page.items) {
              if (!acceptEvent(event)) continue;
              if (event.type === 'progress') {
                yield emit({ job, event, progress: event.progress });
              } else if (event.type === 'retry-scheduled') {
                retryAfterMs = Math.max(retryAfterMs, event.retry_after_ms ?? 0);
                yield emit({ job, event, retryAfterMs });
              } else {
                yield emit({ job, event });
              }
            }
            cursor = page.next_cursor ?? page.items[page.items.length - 1]?.cursor ?? cursor;
          } catch (error) {
            if (!shouldFallbackFromImageEvents(error)) throw error;
            if (eventFailureMode === 'error') throw new OpenOpcImageEventHistoryError();
            eventHistory = 'unavailable';
            yield emit({
              job,
              eventErrorCode: 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE',
            });
          }
        }
        job = await getImageJob(jobId, requestOptions());
        yield emit({ job });
        if (isTerminalImageJob(job)) break;
        await sleepWithAbort(Math.max(pollIntervalMs, retryAfterMs), waitController.signal);
      }
    } catch (error) {
      if (timedOut) {
        throw new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT');
      }
      throw error;
    } finally {
      cleanup();
    }
  };

  const waitForImageJobTerminal = async (
    jobId: string,
    options?: OpenOpcImageWaitOptions,
  ): Promise<OpenOpcImageJob> => {
    let terminalJob: OpenOpcImageJob | undefined;
    for await (const update of subscribeToImageJob(jobId, options)) {
      if (isTerminalImageJob(update.job)) terminalJob = update.job;
    }
    if (!terminalJob) throw new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED');
    return terminalJob;
  };

  const createImageAsset = async (
    inputOrFile: OpenOpcImageAssetCreateInput | Blob,
    metadataOrOptions?: OpenOpcImageAssetCreateMetadata | OpenOpcRequestOptions,
    maybeOptions?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAsset> => {
    const isBlobInput = isBlobValue(inputOrFile);
    let file: Blob;
    let metadata: OpenOpcImageAssetCreateMetadata | undefined;
    let optionsForRequest: OpenOpcRequestOptions | undefined;
    if (isBlobInput) {
      file = inputOrFile;
      const candidate = metadataOrOptions as Record<string, unknown> | undefined;
      const candidateIsOptions =
        candidate !== undefined &&
        Object.keys(candidate).every((key) => ['signal', 'timeoutMs'].includes(key));
      metadata = candidateIsOptions
        ? undefined
        : ((metadataOrOptions ?? {}) as OpenOpcImageAssetCreateMetadata);
      optionsForRequest = candidateIsOptions
        ? (metadataOrOptions as OpenOpcRequestOptions)
        : maybeOptions;
    } else {
      const assetInput = inputOrFile as OpenOpcImageAssetCreateInput;
      file = assetInput.file;
      metadata = assetInput;
      optionsForRequest = metadataOrOptions as OpenOpcRequestOptions | undefined;
    }
    const fileMimeType = isBlobValue(file) ? file.type.split(';')[0]?.toLowerCase() : '';
    if (
      !isBlobValue(file) ||
      file.size < 1 ||
      file.size > OPENOPC_IMAGE_ASSET_MAX_BYTES ||
      !OPENOPC_IMAGE_MIME_TYPES.includes(fileMimeType as (typeof OPENOPC_IMAGE_MIME_TYPES)[number])
    ) {
      protocolError('OpenOPC image asset file is invalid');
    }
    const parsedMetadata = OpenOpcImageAssetCreateMetadataSchema.safeParse({
      filename:
        metadata?.filename ??
        (typeof File !== 'undefined' && file instanceof File && file.name ? file.name : 'asset'),
      metadata: metadata?.metadata,
      retention: metadata?.retention,
    });
    if (!parsedMetadata.success) protocolError('OpenOPC image asset metadata is invalid');
    const form = new FormData();
    form.append('file', file, parsedMetadata.data.filename);
    form.append('filename', parsedMetadata.data.filename);
    if (parsedMetadata.data.metadata !== undefined) {
      try {
        form.append('metadata', JSON.stringify(parsedMetadata.data.metadata));
      } catch {
        protocolError('OpenOPC image asset metadata is invalid');
      }
    }
    if (parsedMetadata.data.retention !== undefined)
      form.append('retention', parsedMetadata.data.retention);
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'POST',
          path: '/v1/module-services/ai/images/assets',
          body: form,
        },
        optionsForRequest,
      ),
    );
    const parsed = OpenOpcImageAssetSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image asset response is invalid');
    return parsed.data;
  };

  const listImageAssets = async (
    input?: OpenOpcImageAssetListInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAssetPage> => {
    validateImageAssetListInput(input);
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: '/v1/module-services/ai/images/assets',
          query: {
            cursor: input?.cursor ?? undefined,
            limit: input?.limit,
            source_job_id: input?.source_job_id,
            source: input?.source,
            created_after: input?.created_after,
            created_before: input?.created_before,
          },
        },
        options,
      ),
    );
    const parsed = OpenOpcImageAssetPageSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image asset response is invalid');
    return parsed.data;
  };

  const imageAssetPages = async function* (
    input?: OpenOpcImageAssetListInput,
    options?: OpenOpcRequestOptions,
  ): AsyncIterable<OpenOpcImageAssetPage> {
    if (input !== undefined) validateImageAssetListInput(input);
    let cursor: string | null = input?.cursor ?? null;
    const visitedCursors = new Set<string>();
    if (cursor !== null) visitedCursors.add(cursor);
    for (;;) {
      const page = await listImageAssets(
        {
          cursor,
          limit: input?.limit,
          source_job_id: input?.source_job_id,
          source: input?.source,
          created_after: input?.created_after,
          created_before: input?.created_before,
        },
        options,
      );
      yield page;
      if (!page.next_cursor) return;
      if (visitedCursors.has(page.next_cursor)) throw new OpenOpcImagePaginationError();
      visitedCursors.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  };

  const listAllImageAssets = async (
    input?: OpenOpcImageAssetListAllOptions,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAsset[]> => {
    if (
      input !== undefined &&
      (!input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              'cursor',
              'limit',
              'source_job_id',
              'source',
              'created_after',
              'created_before',
              'maxItems',
            ].includes(key),
        ))
    ) {
      protocolError('OpenOPC image asset list options are invalid');
    }
    if (
      input?.maxItems !== undefined &&
      (!Number.isSafeInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 10_000)
    ) {
      protocolError('OpenOPC image asset maxItems is invalid');
    }
    const pageInput: OpenOpcImageAssetListInput | undefined = input
      ? {
          cursor: input.cursor,
          limit: input.limit,
          source_job_id: input.source_job_id,
          source: input.source,
          created_after: input.created_after,
          created_before: input.created_before,
        }
      : undefined;
    if (pageInput !== undefined) validateImageAssetListInput(pageInput);
    const maxItems = input?.maxItems ?? 10_000;
    const assets: OpenOpcImageAsset[] = [];
    const seenAssetIds = new Set<string>();
    for await (const page of imageAssetPages(pageInput, options)) {
      for (const asset of page.items) {
        if (seenAssetIds.has(asset.asset_id)) continue;
        seenAssetIds.add(asset.asset_id);
        assets.push(asset);
        if (assets.length >= maxItems) break;
      }
      if (assets.length >= maxItems) break;
    }
    return assets;
  };

  const previewImageAsset = async (
    assetId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAssetPreview> => {
    validateResourceId(assetId, 'asset id');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: `/v1/module-services/ai/images/assets/${encodeURIComponent(assetId)}/preview-url`,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageAssetPreviewSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image asset preview response is invalid');
    return parsed.data;
  };

  const thumbnailImageAsset = async (
    assetId: string,
    input?: OpenOpcImageAssetThumbnailInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAssetThumbnail> => {
    validateResourceId(assetId, 'asset id');
    const parsedInput = OpenOpcImageAssetThumbnailInputSchema.safeParse(input ?? {});
    if (!parsedInput.success) protocolError('OpenOPC image asset thumbnail input is invalid');
    const query = parsedInput.data.preset ? { preset: parsedInput.data.preset } : undefined;
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: `/v1/module-services/ai/images/assets/${encodeURIComponent(assetId)}/thumbnail-url`,
          query,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageAssetThumbnailSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image asset thumbnail response is invalid');
    return parsed.data;
  };

  const downloadImageAsset = async (
    assetId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<Blob> => {
    validateResourceId(assetId, 'asset id');
    const sent = await send(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'GET',
          path: `/v1/module-services/ai/images/assets/${encodeURIComponent(assetId)}/download`,
        },
        options,
      ),
    );
    try {
      const blob = await readResponseBlob(sent.response, sent.context);
      const contentType = (blob.type || sent.response.headers.get('content-type') || '')
        .split(';')[0]
        .toLowerCase();
      if (
        blob.size > OPENOPC_IMAGE_ASSET_MAX_BYTES ||
        !OPENOPC_IMAGE_MIME_TYPES.includes(contentType as (typeof OPENOPC_IMAGE_MIME_TYPES)[number])
      ) {
        protocolError('OpenOPC image asset download is invalid');
      }
      return blob;
    } finally {
      sent.context.cleanup();
    }
  };

  const deleteImageAsset = async (
    assetId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAssetDeleteResult> => {
    validateResourceId(assetId, 'asset id');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'POST',
          path: `/v1/module-services/ai/images/assets/${encodeURIComponent(assetId)}/delete`,
        },
        options,
      ),
    );
    const parsed = OpenOpcImageAssetDeleteResultSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image asset delete response is invalid');
    return parsed.data;
  };

  const setImageAssetRetention = async (
    assetId: string,
    policy: 'temporary' | 'retained',
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcImageAsset> => {
    validateResourceId(assetId, 'asset id');
    if (policy !== 'temporary' && policy !== 'retained') {
      protocolError('OpenOPC image asset retention policy is invalid');
    }
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'ai',
          operation: 'image.generate',
          method: 'POST',
          path: `/v1/module-services/ai/images/assets/${encodeURIComponent(assetId)}/retention`,
          body: { policy },
        },
        options,
      ),
    );
    const parsed = OpenOpcImageAssetSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC image asset response is invalid');
    return parsed.data;
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

  const listDocuments = async (
    input?: OpenOpcModuleDocumentListInput,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcModuleDocumentPage> => {
    const parsedInput = OpenOpcModuleDocumentListInputSchema.safeParse(input ?? {});
    if (!parsedInput.success) protocolError('OpenOPC module document list input is invalid');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'data',
          operation: 'documents.list',
          method: 'GET',
          path: '/v1/module-services/data/documents',
          query: {
            cursor: parsedInput.data.cursor ?? undefined,
            limit: input?.limit,
          },
        },
        options,
      ),
    );
    const parsed = OpenOpcModuleDocumentPageSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module document page response is invalid');
    return parsed.data;
  };

  const readDocument = async (
    key: string,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcModuleDocument> => {
    const parsedKey = OpenOpcModuleDocumentKeySchema.safeParse(key);
    if (!parsedKey.success) protocolError('OpenOPC module document key is invalid');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'data',
          operation: 'documents.read',
          method: 'GET',
          path: '/v1/module-services/data/document',
          query: { key: parsedKey.data },
        },
        options,
      ),
    );
    const parsed = OpenOpcModuleDocumentSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module document response is invalid');
    return parsed.data;
  };

  const writeDocument = async (
    key: string,
    input: { expected_revision: number | null; value: OpenOpcModuleDocumentValue },
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcModuleDocument> => {
    const parsedInput = OpenOpcModuleDocumentWriteInputSchema.safeParse({ ...input, key });
    if (!parsedInput.success) protocolError('OpenOPC module document write input is invalid');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'data',
          operation: 'documents.write',
          method: 'PUT',
          path: '/v1/module-services/data/document',
          body: parsedInput.data,
        },
        options,
      ),
    );
    const parsed = OpenOpcModuleDocumentSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module document response is invalid');
    return parsed.data;
  };

  const deleteDocument = async (
    key: string,
    expectedRevision: number,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcModuleDocumentDeleteResult> => {
    const parsedInput = OpenOpcModuleDocumentDeleteInputSchema.safeParse({
      key,
      expected_revision: expectedRevision,
    });
    if (!parsedInput.success) protocolError('OpenOPC module document delete input is invalid');
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'data',
          operation: 'documents.delete',
          method: 'DELETE',
          path: '/v1/module-services/data/document',
          body: parsedInput.data,
        },
        options,
      ),
    );
    const parsed = OpenOpcModuleDocumentDeleteResultSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module document delete response is invalid');
    return parsed.data;
  };

  const readSettings = async (
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcEffectiveModuleSettings> => {
    const value = await request<unknown>(
      withRequestOptions(
        {
          service: 'settings',
          operation: 'settings.read',
          method: 'GET',
          path: '/v1/module-services/settings/',
        },
        options,
      ),
    );
    const parsed = OpenOpcEffectiveModuleSettingsSchema.safeParse(value);
    if (!parsed.success) protocolError('OpenOPC module settings response is invalid');
    return parsed.data;
  };

  return {
    context: options.context ?? null,
    request,
    ai: {
      models: { list: listModels },
      chat: { create: createChat },
      images: {
        models: { list: listImageModels },
        estimates: {
          create: createImageEstimate,
          isExpired: imageEstimateIsExpired,
          retryGuidance: openOpcImageEstimateRetryGuidance,
        },
        jobs: {
          list: listImageJobs,
          create: createImageJob,
          get: getImageJob,
          events: getImageJobEvents,
          outputs: getImageJobOutputs,
          cancel: cancelImageJob,
          subscribe: subscribeToImageJob,
          waitForTerminal: waitForImageJobTerminal,
        },
        assets: {
          create: createImageAsset,
          list: listImageAssets,
          pages: imageAssetPages,
          listAll: listAllImageAssets,
          preview: previewImageAsset,
          thumbnail: thumbnailImageAsset,
          download: downloadImageAsset,
          delete: deleteImageAsset,
          setRetention: setImageAssetRetention,
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
    data: {
      documents: {
        list: listDocuments,
        read: readDocument,
        write: writeDocument,
        delete: deleteDocument,
      },
    },
    settings: { read: readSettings },
  };
}
