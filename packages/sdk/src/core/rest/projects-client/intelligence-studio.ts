// Strict, dependency-light projections over the existing project Studio routes.

import { ApiError, type ApiResponse, backendApi } from '../../http/api-client';
import type { IntelligenceStudioJobInput } from './intelligence';
import { unwrap } from './shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STABLE_STUDIO_ERROR_CODES = [
  'STUDIO_VALIDATION_ERROR',
  'STUDIO_PERMISSION_DENIED',
  'STUDIO_INSUFFICIENT_CREDITS',
  'STUDIO_CREDENTIAL_MISSING',
  'STUDIO_CREDENTIAL_EXPIRED',
  'STUDIO_CREDENTIAL_UNAVAILABLE',
  'STUDIO_MODEL_UNSUPPORTED',
  'STUDIO_ESTIMATE_EXPIRED',
  'STUDIO_IDEMPOTENCY_MISMATCH',
  'STUDIO_PROVIDER_UNAVAILABLE',
  'STUDIO_PROVIDER_CONFIG_INVALID',
  'STUDIO_PROVIDER_CONFIG_STALE',
  'STUDIO_PROVIDER_RATE_LIMITED',
  'STUDIO_PROVIDER_REJECTED',
  'STUDIO_PROVIDER_TIMEOUT',
  'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
  'STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED',
  'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED',
  'STUDIO_PRICING_STALE',
  'STUDIO_ASSET_INVALID',
  'STUDIO_ASSET_TOO_LARGE',
  'STUDIO_UPLOAD_EXPIRED',
  'STUDIO_STORAGE_UNAVAILABLE',
  'STUDIO_JOB_CONFLICT',
  'STUDIO_RECOVERY_CONFLICT',
  'STUDIO_BILLING_INCIDENT_REQUIRED',
  'STUDIO_JOB_NOT_CANCELLABLE',
  'STUDIO_WEBHOOK_SIGNATURE_INVALID',
  'STUDIO_WEBHOOK_REPLAYED',
  'STUDIO_EVENT_CURSOR_EXPIRED',
  'STUDIO_INTERNAL_ERROR',
] as const;

export type IntelligenceStudioErrorCode = (typeof STABLE_STUDIO_ERROR_CODES)[number];

const SAFE_STUDIO_CODES = new Set<string>(STABLE_STUDIO_ERROR_CODES);

export interface IntelligenceImageEstimateRequest {
  capability: 'image.generate';
  provider_config_id: string;
  model: string;
  input: IntelligenceStudioJobInput;
}

export interface IntelligenceImageEstimateLineItem {
  label: string;
  credits: number;
}

export interface IntelligenceImageEstimate {
  estimate_id: string;
  estimate_token: string;
  expires_at: string;
  currency: 'credits';
  provider_cost_credits: number;
  platform_cost_credits: number;
  max_approved_credits: number;
  input_hash: string;
  line_items: IntelligenceImageEstimateLineItem[];
}

export type IntelligenceStudioJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface IntelligenceStudioJob {
  job_id: string;
  account_id: string;
  project_id: string;
  actor_user_id: string | null;
  actor_type: 'user' | 'agent' | 'system';
  capability: 'image.generate';
  provider_config_id: string;
  provider: string;
  model: string;
  input: IntelligenceStudioJobInput;
  status: IntelligenceStudioJobStatus;
  idempotency_key: string;
  request_hash: string;
  attempt_count: number;
  reserved_credits: number;
  actual_credits: number | null;
  error_code: IntelligenceStudioErrorCode | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancellable?: boolean;
}

export interface IntelligenceStudioJobList {
  items: IntelligenceStudioJob[];
  next_cursor: string | null;
}

export interface IntelligenceStudioJobEvent {
  event_id: string;
  job_id: string;
  cursor: string;
  type:
    | 'queued'
    | 'claimed'
    | 'provider-submitted'
    | 'progress'
    | 'asset-created'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'retry-scheduled'
    | 'billing-settled';
  payload: Record<string, unknown>;
  created_at: string;
}

export interface IntelligenceStudioJobEvents {
  items: IntelligenceStudioJobEvent[];
  next_cursor: string | null;
}

export interface IntelligenceCreateUploadRequest {
  declared_mime_type: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  metadata?: Record<string, unknown>;
}

export interface IntelligenceStudioUpload {
  upload_id: string;
  project_id: string;
  asset_id: string | null;
  object_key: string;
  declared_mime_type: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  signed_upload_url: string;
  signed_upload_headers: Readonly<Record<string, string>>;
  expires_at: string;
  status: 'pending' | 'finalized' | 'expired';
}

export interface IntelligenceStudioAsset {
  asset_id: string;
  account_id: string;
  project_id: string;
  source_job_id: string | null;
  kind: 'image';
  mime_type: string;
  bucket: string;
  object_key: string;
  checksum_sha256: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface IntelligenceStudioAssetList {
  items: IntelligenceStudioAsset[];
  next_cursor: string | null;
}

export interface IntelligenceAssetDownload {
  asset_id: string;
  signed_download_url: string;
  expires_at: string;
}

async function requestStudio<T>(
  request: () => Promise<ApiResponse<unknown>>,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    const value = unwrap(await request());
    try {
      return parse(value);
    } catch {
      throw new ApiError('Studio response rejected', { code: 'INTELLIGENCE_PROTOCOL_ERROR' });
    }
  } catch (error) {
    const source = error as { status?: unknown; code?: unknown; detail?: unknown };
    const status = typeof source.status === 'number' ? source.status : undefined;
    const detail =
      source.detail && typeof source.detail === 'object'
        ? (source.detail as Record<string, unknown>)
        : undefined;
    const candidateCode =
      typeof source.code === 'string'
        ? source.code
        : typeof detail?.code === 'string'
          ? detail.code
          : typeof detail?.error_code === 'string'
            ? detail.error_code
            : undefined;
    const code =
      candidateCode === 'INTELLIGENCE_PROTOCOL_ERROR' ||
      (candidateCode !== undefined && SAFE_STUDIO_CODES.has(candidateCode))
        ? candidateCode
        : 'INTELLIGENCE_REQUEST_FAILED';
    throw new ApiError('Studio request failed', { status, code });
  }
}

function asStrictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Studio response');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('invalid Studio response');
  }
  return record;
}

function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('invalid UUID');
  }
  return value;
}

function parseBoundedString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new Error('invalid string');
  }
  return value;
}

function parseDate(value: unknown): string {
  const date = parseBoundedString(value, 1, 64);
  if (!Number.isFinite(Date.parse(date))) throw new Error('invalid date');
  return date;
}

function parseSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('invalid SHA-256');
  }
  return value;
}

function parseNonnegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('invalid number');
  }
  return value;
}

function parseNonnegativeInteger(value: unknown): number {
  const parsed = parseNonnegativeNumber(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid integer');
  return parsed;
}

function parseNullable<T>(value: unknown, parse: (candidate: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid boolean');
  return value;
}

function parseJobStatus(value: unknown): IntelligenceStudioJobStatus {
  if (
    value !== 'queued' &&
    value !== 'running' &&
    value !== 'succeeded' &&
    value !== 'failed' &&
    value !== 'cancelled'
  ) {
    throw new Error('invalid job status');
  }
  return value;
}

function parseActorType(value: unknown): IntelligenceStudioJob['actor_type'] {
  if (value !== 'user' && value !== 'agent' && value !== 'system') {
    throw new Error('invalid actor type');
  }
  return value;
}

function parseStudioErrorCode(value: unknown): IntelligenceStudioErrorCode {
  if (typeof value !== 'string' || !SAFE_STUDIO_CODES.has(value)) {
    throw new Error('invalid Studio error code');
  }
  return value as IntelligenceStudioErrorCode;
}

function parseStudioInput(value: unknown): IntelligenceStudioJobInput {
  const input = asStrictRecord(value, ['capability', 'image']);
  if (input.capability !== 'image.generate') throw new Error('invalid Studio input');
  const image = asStrictRecord(input.image, [
    'prompt',
    'negative_prompt',
    'reference_asset_ids',
    'aspect_ratio',
    'quality',
    'output_count',
    'seed',
    'advanced',
  ]);
  const prompt = parseBoundedString(image.prompt, 1, 8000);
  const negativePrompt =
    image.negative_prompt === undefined
      ? undefined
      : parseBoundedString(image.negative_prompt, 0, 4000);
  if (!Array.isArray(image.reference_asset_ids) || image.reference_asset_ids.length > 8) {
    throw new Error('invalid reference assets');
  }
  const aspectRatio = image.aspect_ratio;
  if (!['1:1', '4:3', '3:4', '16:9', '9:16'].includes(String(aspectRatio))) {
    throw new Error('invalid aspect ratio');
  }
  const quality = image.quality;
  if (quality !== 'standard' && quality !== 'high') throw new Error('invalid quality');
  const outputCount = parseNonnegativeInteger(image.output_count);
  if (outputCount < 1 || outputCount > 8) throw new Error('invalid output count');
  const seed = image.seed === undefined ? undefined : parseNonnegativeInteger(image.seed);
  const advanced = image.advanced === undefined ? undefined : parseSafeRecord(image.advanced, 0);
  return {
    capability: 'image.generate',
    image: {
      prompt,
      ...(negativePrompt !== undefined ? { negative_prompt: negativePrompt } : {}),
      reference_asset_ids: image.reference_asset_ids.map(parseUuid),
      aspect_ratio: aspectRatio as IntelligenceStudioJobInput['image']['aspect_ratio'],
      quality,
      output_count: outputCount,
      ...(seed !== undefined ? { seed } : {}),
      ...(advanced !== undefined ? { advanced } : {}),
    },
  };
}

function parseSafeRecord(value: unknown, depth: number): Record<string, unknown> {
  if (depth > 6) throw new Error('nested data too deep');
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length > 128) throw new Error('too many metadata fields');
  return Object.fromEntries(
    entries.map(([key, nested]) => {
      const normalizedKey = key.replace(/[^a-z\d]/gi, '').toLowerCase();
      if (
        key.length < 1 ||
        key.length > 255 ||
        /(?:authorization|cookie|secret|credential|api[_-]?key|access[_-]?token|signed[_-]?url|provider[_-]?url|raw[_-]?(?:body|payload))/i.test(
          key,
        )
      ) {
        throw new Error('unsafe metadata key');
      }
      if (
        normalizedKey === 'raw' ||
        /^raw(?:provider|request|response)?(?:body|payload)$/.test(normalizedKey) ||
        /^provider(?:request|response)?(?:body|payload)$/.test(normalizedKey)
      ) {
        throw new Error('unsafe metadata key');
      }
      return [key, parseSafeJson(nested, depth + 1)];
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid record');
  }
  return value as Record<string, unknown>;
}

function parseSafeJson(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid JSON number');
    return value;
  }
  if (typeof value === 'string') return parseBoundedString(value, 0, 8192);
  if (Array.isArray(value)) {
    if (depth > 6 || value.length > 128) throw new Error('invalid JSON array');
    return value.map((item) => parseSafeJson(item, depth + 1));
  }
  return parseSafeRecord(value, depth);
}

function parseJob(value: unknown, projectId: string, jobId?: string): IntelligenceStudioJob {
  const record = asStrictRecord(value, [
    'job_id',
    'account_id',
    'project_id',
    'actor_user_id',
    'actor_type',
    'capability',
    'provider_config_id',
    'provider',
    'model',
    'input',
    'status',
    'idempotency_key',
    'request_hash',
    'attempt_count',
    'reserved_credits',
    'actual_credits',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'started_at',
    'completed_at',
    'cancellable',
  ]);
  if (record.capability !== 'image.generate') throw new Error('invalid capability');
  const parsed: IntelligenceStudioJob = {
    job_id: parseUuid(record.job_id),
    account_id: parseUuid(record.account_id),
    project_id: parseUuid(record.project_id),
    actor_user_id: parseNullable(record.actor_user_id, parseUuid),
    actor_type: parseActorType(record.actor_type),
    capability: record.capability,
    provider_config_id: parseUuid(record.provider_config_id),
    provider: parseBoundedString(record.provider, 1, 255),
    model: parseBoundedString(record.model, 1, 255),
    input: parseStudioInput(record.input),
    status: parseJobStatus(record.status),
    idempotency_key: parseBoundedString(record.idempotency_key, 1, 255),
    request_hash: parseBoundedString(record.request_hash, 16, 256),
    attempt_count: parseNonnegativeInteger(record.attempt_count),
    reserved_credits: parseNonnegativeNumber(record.reserved_credits),
    actual_credits: parseNullable(record.actual_credits, parseNonnegativeNumber),
    error_code: parseNullable(record.error_code, parseStudioErrorCode),
    error_message: parseNullable(record.error_message, (item) => parseBoundedString(item, 0, 2000)),
    created_at: parseDate(record.created_at),
    updated_at: parseDate(record.updated_at),
    started_at: parseNullable(record.started_at, parseDate),
    completed_at: parseNullable(record.completed_at, parseDate),
    ...(record.cancellable === undefined ? {} : { cancellable: parseBoolean(record.cancellable) }),
  };
  if (parsed.project_id !== projectId || (jobId !== undefined && parsed.job_id !== jobId)) {
    throw new Error('invalid job scope');
  }
  return parsed;
}

function parseCursor(value: unknown): string | null {
  return value === null ? null : parseBoundedString(value, 1, 2048);
}

function parseJobList(value: unknown, projectId: string): IntelligenceStudioJobList {
  const record = asStrictRecord(value, ['items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 100) {
    throw new Error('invalid job list');
  }
  return {
    items: record.items.map((item) => parseJob(item, projectId)),
    next_cursor: parseCursor(record.next_cursor),
  };
}

function parseEventType(value: unknown): IntelligenceStudioJobEvent['type'] {
  const values: IntelligenceStudioJobEvent['type'][] = [
    'queued',
    'claimed',
    'provider-submitted',
    'progress',
    'asset-created',
    'succeeded',
    'failed',
    'cancelled',
    'retry-scheduled',
    'billing-settled',
  ];
  if (!values.includes(value as IntelligenceStudioJobEvent['type'])) {
    throw new Error('invalid event type');
  }
  return value as IntelligenceStudioJobEvent['type'];
}

function parseJobEvents(value: unknown, jobId: string): IntelligenceStudioJobEvents {
  const record = asStrictRecord(value, ['items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 100) {
    throw new Error('invalid event list');
  }
  return {
    items: record.items.map((item) => {
      const event = asStrictRecord(item, [
        'event_id',
        'job_id',
        'cursor',
        'type',
        'payload',
        'created_at',
      ]);
      const parsed: IntelligenceStudioJobEvent = {
        event_id: parseUuid(event.event_id),
        job_id: parseUuid(event.job_id),
        cursor: parseBoundedString(event.cursor, 1, 2048),
        type: parseEventType(event.type),
        payload: parseSafeRecord(event.payload, 0),
        created_at: parseDate(event.created_at),
      };
      if (parsed.job_id !== jobId) throw new Error('invalid event scope');
      return parsed;
    }),
    next_cursor: parseCursor(record.next_cursor),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets[0] === 127 && octets.every((octet) => octet >= 0 && octet <= 255);
}

function parseSignedUrl(value: unknown): string {
  const raw = parseBoundedString(value, 1, 8192);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid signed URL');
  }
  if (url.username || url.password) throw new Error('invalid signed URL');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    throw new Error('invalid signed URL');
  }
  return raw;
}

function parseSignedUploadHeaders(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length > 16) throw new Error('too many upload headers');
  const forbidden = new Set(['authorization', 'cookie', 'host', 'content-length']);
  const parsed: Record<string, string> = {};
  for (const [name, candidate] of entries) {
    if (
      name !== name.toLowerCase() ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      forbidden.has(name)
    ) {
      throw new Error('unsafe upload header');
    }
    if (typeof candidate !== 'string' || candidate.length > 2048 || /[\r\n\0]/.test(candidate)) {
      throw new Error('unsafe upload header');
    }
    parsed[name] = candidate;
  }
  return Object.freeze(parsed);
}

function parseUploadStatus(value: unknown): IntelligenceStudioUpload['status'] {
  if (value !== 'pending' && value !== 'finalized' && value !== 'expired') {
    throw new Error('invalid upload status');
  }
  return value;
}

function parseUpload(value: unknown, projectId: string): IntelligenceStudioUpload {
  const record = asStrictRecord(value, [
    'upload_id',
    'project_id',
    'asset_id',
    'object_key',
    'declared_mime_type',
    'expected_size_bytes',
    'expected_checksum_sha256',
    'signed_upload_url',
    'signed_upload_headers',
    'expires_at',
    'status',
  ]);
  const parsed: IntelligenceStudioUpload = {
    upload_id: parseUuid(record.upload_id),
    project_id: parseUuid(record.project_id),
    asset_id: parseNullable(record.asset_id, parseUuid),
    object_key: parseBoundedString(record.object_key, 1, 2048),
    declared_mime_type: parseBoundedString(record.declared_mime_type, 1, 255),
    expected_size_bytes: parsePositiveInteger(record.expected_size_bytes),
    expected_checksum_sha256: parseSha256(record.expected_checksum_sha256),
    signed_upload_url: parseSignedUrl(record.signed_upload_url),
    signed_upload_headers: parseSignedUploadHeaders(record.signed_upload_headers),
    expires_at: parseDate(record.expires_at),
    status: parseUploadStatus(record.status),
  };
  if (parsed.project_id !== projectId) throw new Error('invalid upload scope');
  return parsed;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = parseNonnegativeInteger(value);
  if (parsed < 1) throw new Error('invalid positive integer');
  return parsed;
}

function parseAsset(value: unknown, projectId: string, assetId?: string): IntelligenceStudioAsset {
  const record = asStrictRecord(value, [
    'asset_id',
    'account_id',
    'project_id',
    'source_job_id',
    'kind',
    'mime_type',
    'bucket',
    'object_key',
    'checksum_sha256',
    'size_bytes',
    'width',
    'height',
    'metadata',
    'created_at',
  ]);
  if (record.kind !== 'image') throw new Error('invalid asset kind');
  const parsed: IntelligenceStudioAsset = {
    asset_id: parseUuid(record.asset_id),
    account_id: parseUuid(record.account_id),
    project_id: parseUuid(record.project_id),
    source_job_id: parseNullable(record.source_job_id, parseUuid),
    kind: record.kind,
    mime_type: parseBoundedString(record.mime_type, 1, 255),
    bucket: parseBoundedString(record.bucket, 1, 255),
    object_key: parseBoundedString(record.object_key, 1, 2048),
    checksum_sha256: parseSha256(record.checksum_sha256),
    size_bytes: parseNonnegativeInteger(record.size_bytes),
    width: parseNullable(record.width, parsePositiveInteger),
    height: parseNullable(record.height, parsePositiveInteger),
    metadata: parseSafeRecord(record.metadata, 0),
    created_at: parseDate(record.created_at),
  };
  if (parsed.project_id !== projectId || (assetId !== undefined && parsed.asset_id !== assetId)) {
    throw new Error('invalid asset scope');
  }
  return parsed;
}

function parseAssetList(value: unknown, projectId: string): IntelligenceStudioAssetList {
  const record = asStrictRecord(value, ['items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 100) {
    throw new Error('invalid asset list');
  }
  return {
    items: record.items.map((item) => parseAsset(item, projectId)),
    next_cursor: parseCursor(record.next_cursor),
  };
}

function parseAssetDownload(value: unknown, assetId: string): IntelligenceAssetDownload {
  const record = asStrictRecord(value, ['asset_id', 'signed_download_url', 'expires_at']);
  const parsed = {
    asset_id: parseUuid(record.asset_id),
    signed_download_url: parseSignedUrl(record.signed_download_url),
    expires_at: parseDate(record.expires_at),
  };
  if (parsed.asset_id !== assetId) throw new Error('invalid asset scope');
  return parsed;
}

function parseEstimate(value: unknown): IntelligenceImageEstimate {
  const record = asStrictRecord(value, [
    'estimate_id',
    'estimate_token',
    'expires_at',
    'currency',
    'provider_cost_credits',
    'platform_cost_credits',
    'max_approved_credits',
    'input_hash',
    'line_items',
  ]);
  if (record.currency !== 'credits' || !Array.isArray(record.line_items)) {
    throw new Error('invalid estimate');
  }
  if (record.line_items.length > 32) throw new Error('invalid estimate');
  return {
    estimate_id: parseUuid(record.estimate_id),
    estimate_token: parseBoundedString(record.estimate_token, 16, 8192),
    expires_at: parseDate(record.expires_at),
    currency: record.currency,
    provider_cost_credits: parseNonnegativeNumber(record.provider_cost_credits),
    platform_cost_credits: parseNonnegativeNumber(record.platform_cost_credits),
    max_approved_credits: parseNonnegativeNumber(record.max_approved_credits),
    input_hash: parseBoundedString(record.input_hash, 16, 256),
    line_items: record.line_items.map((item) => {
      const line = asStrictRecord(item, ['label', 'credits']);
      return {
        label: parseBoundedString(line.label, 1, 255),
        credits: parseNonnegativeNumber(line.credits),
      };
    }),
  };
}

export async function estimateIntelligenceImage(
  projectId: string,
  input: IntelligenceImageEstimateRequest,
): Promise<IntelligenceImageEstimate> {
  return requestStudio(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/estimates`,
        input,
        { showErrors: false },
      ),
    parseEstimate,
  );
}

export async function listIntelligenceJobs(
  projectId: string,
  cursor?: string | null,
): Promise<IntelligenceStudioJobList> {
  return requestStudio(
    () => {
      const query = cursor == null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/jobs${query}`,
        { showErrors: false },
      );
    },
    (value) => parseJobList(value, projectId),
  );
}

export async function getIntelligenceJob(
  projectId: string,
  jobId: string,
): Promise<IntelligenceStudioJob> {
  return requestStudio(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/jobs/${encodeURIComponent(jobId)}`,
        { showErrors: false },
      ),
    (value) => parseJob(value, projectId, jobId),
  );
}

export async function getIntelligenceJobEvents(
  projectId: string,
  jobId: string,
  cursor?: string | null,
): Promise<IntelligenceStudioJobEvents> {
  return requestStudio(
    () => {
      const query = cursor == null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/jobs/${encodeURIComponent(jobId)}/events${query}`,
        { showErrors: false },
      );
    },
    (value) => parseJobEvents(value, jobId),
  );
}

export async function cancelIntelligenceJob(
  projectId: string,
  jobId: string,
): Promise<IntelligenceStudioJob> {
  return requestStudio(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/jobs/${encodeURIComponent(jobId)}/cancel`,
        {},
        { showErrors: false },
      ),
    (value) => parseJob(value, projectId, jobId),
  );
}

export async function createIntelligenceUpload(
  projectId: string,
  input: IntelligenceCreateUploadRequest,
): Promise<IntelligenceStudioUpload> {
  return requestStudio(
    () =>
      backendApi.post<unknown>(`/projects/${encodeURIComponent(projectId)}/studio/uploads`, input, {
        showErrors: false,
      }),
    (value) => parseUpload(value, projectId),
  );
}

export async function finalizeIntelligenceUpload(
  projectId: string,
  uploadId: string,
): Promise<IntelligenceStudioAsset> {
  return requestStudio(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/uploads/${encodeURIComponent(uploadId)}/finalize`,
        {},
        { showErrors: false },
      ),
    (value) => parseAsset(value, projectId),
  );
}

export async function listIntelligenceAssets(
  projectId: string,
  cursor?: string | null,
): Promise<IntelligenceStudioAssetList> {
  return requestStudio(
    () => {
      const query = cursor == null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/assets${query}`,
        { showErrors: false },
      );
    },
    (value) => parseAssetList(value, projectId),
  );
}

export async function getIntelligenceAsset(
  projectId: string,
  assetId: string,
): Promise<IntelligenceStudioAsset> {
  return requestStudio(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/assets/${encodeURIComponent(assetId)}`,
        { showErrors: false },
      ),
    (value) => parseAsset(value, projectId, assetId),
  );
}

export async function createIntelligenceAssetDownloadUrl(
  projectId: string,
  assetId: string,
): Promise<IntelligenceAssetDownload> {
  return requestStudio(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/studio/assets/${encodeURIComponent(assetId)}/download-url`,
        {},
        { showErrors: false },
      ),
    (value) => parseAssetDownload(value, assetId),
  );
}
