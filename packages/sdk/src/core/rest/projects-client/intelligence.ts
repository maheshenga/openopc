// Project-scoped Intelligence Fabric REST methods.
//
// The published SDK keeps a small, wire-shaped client contract here and shares
// only side-effect-free domain contracts from @kortix/intelligence-contracts.
// The response parsers stay at this boundary so malformed 2xx payloads fail
// closed before they reach a host application.

import {
  type AgentCard,
  AgentCardSchema,
  type CapabilityDescriptor,
  CapabilityDescriptorSchema,
  type ProtocolVersion,
  type TaskEvent,
  TaskEventSchema,
} from '@kortix/intelligence-contracts';
import { ApiError, type ApiResponse } from '../../http/api-client';
import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type {
  AgentCard,
  CapabilityDescriptor,
  ProtocolVersion,
  TaskEvent,
} from '@kortix/intelligence-contracts';

const SAFE_INTELLIGENCE_CODES = [
  'INTELLIGENCE_AGENT_CARD_UNAVAILABLE',
  'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
  'INTELLIGENCE_CAPABILITIES_UNAVAILABLE',
  'INTELLIGENCE_CAPABILITY_UNAVAILABLE',
  'INTELLIGENCE_DISCOVERY_INVALID',
  'INTELLIGENCE_DISCOVERY_TOO_LARGE',
  'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
  'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
  'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
  'INTELLIGENCE_PROTOCOL_ERROR',
  'INTELLIGENCE_PROTOCOL_UNSUPPORTED',
  'INTELLIGENCE_REQUEST_FAILED',
  'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE',
  'INTELLIGENCE_TASK_EXECUTION_FAILED',
  'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
  'INTELLIGENCE_VALIDATION_ERROR',
] as const;
const SAFE_INTELLIGENCE_CODE_SET = new Set<(typeof SAFE_INTELLIGENCE_CODES)[number]>(
  SAFE_INTELLIGENCE_CODES,
);
const UNSAFE_PUBLIC_KEY_PATTERN =
  /(?:api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz|raw(?:[_-](?:provider|request|response))?[_-]?(?:body|payload)|headers?)/i;
const UNSAFE_PUBLIC_URL_PATTERN = /(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/i;
const UNSAFE_PUBLIC_SCHEME_PATTERN = /(?:^|[\s"'=(:,])(data|file|mailto|javascript|blob|urn):/i;
const UNSAFE_PUBLIC_CREDENTIAL_TEXT_PATTERN =
  /(?:\bauthorization\s*:|\bbearer\s+[^\s,;]+|\b(?:api[_-]?key|secret|access[_-]?token|password|credential)\s*[:=]\s*[^\s,;]+)/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_IDENTIFIER_SENSITIVE_PATTERN =
  /(?:api[_-]?key|secret|password|credential|authorization|bearer|access[_-]?token)/i;

/** The only protocol revision currently accepted by the Intelligence API. */
export const INTELLIGENCE_PROTOCOL_VERSION = 'intelligence.v1' as const satisfies ProtocolVersion;

export interface IntelligenceCapabilitiesResponse {
  protocol_version: ProtocolVersion;
  items: CapabilityDescriptor[];
  next_cursor: string | null;
}

export interface IntelligenceExecutionTarget {
  capability_id: 'studio.image.generate';
  provider_config_id: string;
  model: string;
}

export interface IntelligenceCapabilityDiscoveryResponse extends IntelligenceCapabilitiesResponse {
  execution_targets: IntelligenceExecutionTarget[];
}

export type IntelligenceAgentCardResponse = AgentCard;

/** The Studio image input currently accepted by Intelligence v1. */
export interface IntelligenceImageGenerateInput {
  prompt: string;
  negative_prompt?: string;
  reference_asset_ids: string[];
  aspect_ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
  quality: 'standard' | 'high';
  output_count: number;
  seed?: number;
  advanced?: Record<string, unknown>;
}

/** Studio job input nested in an Intelligence task request. */
export interface IntelligenceStudioJobInput {
  capability: 'image.generate';
  image: IntelligenceImageGenerateInput;
}

export interface IntelligenceCreateTaskRequest {
  protocol_version: ProtocolVersion;
  capability_id: 'studio.image.generate';
  agent_card_hash: string;
  provider_config_id: string;
  model: string;
  input: IntelligenceStudioJobInput;
  idempotency_key: string;
  parent_task_id?: string | null;
  deadline_at?: string | null;
}

export interface IntelligenceTaskResponse {
  protocol_version: ProtocolVersion;
  task_id: string;
  job_id: string;
  created: boolean;
}

export interface IntelligenceTaskEventsResponse {
  protocol_version: ProtocolVersion;
  task_id: string;
  items: TaskEvent[];
  next_cursor: string | null;
}

/**
 * Return only stable, protocol-scoped error metadata. `backendApi` retains the
 * response body and request URL on ApiError for legacy consumers; that is not
 * safe to pass through this boundary because provider failures can contain
 * signed URLs or credential-bearing diagnostics.
 */
async function requestIntelligence<T>(
  request: () => Promise<ApiResponse<unknown>>,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    const data = unwrap(await request());
    let parsed: T;
    try {
      parsed = parse(data);
    } catch {
      throw new ApiError('Intelligence response rejected', {
        code: 'INTELLIGENCE_PROTOCOL_ERROR',
      });
    }
    assertSafeIntelligencePayload(parsed);
    return parsed;
  } catch (error) {
    const source = error as { status?: unknown; code?: unknown };
    const status = typeof source.status === 'number' ? source.status : undefined;
    const code =
      typeof source.code === 'string' &&
      SAFE_INTELLIGENCE_CODE_SET.has(source.code as (typeof SAFE_INTELLIGENCE_CODES)[number])
        ? source.code
        : 'INTELLIGENCE_REQUEST_FAILED';
    throw new ApiError('Intelligence request failed', { status, code });
  }
}

/**
 * The API validates these envelopes, but the SDK still guards the boundary so
 * a stale proxy or a compromised 2xx response cannot hand provider material to
 * a browser consumer. The strict parsers enforce shape; this dependency-light
 * walk separately enforces content redaction inside schema-valued JSON fields.
 */
function assertSafeIntelligencePayload(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    if (
      UNSAFE_PUBLIC_URL_PATTERN.test(value) ||
      UNSAFE_PUBLIC_SCHEME_PATTERN.test(value) ||
      UNSAFE_PUBLIC_CREDENTIAL_TEXT_PATTERN.test(value)
    ) {
      throw new ApiError('Intelligence response rejected', {
        code: 'INTELLIGENCE_PROTOCOL_ERROR',
      });
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) assertSafeIntelligencePayload(item, seen);
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isUnsafePublicKey(key)) {
      throw new ApiError('Intelligence response rejected', {
        code: 'INTELLIGENCE_PROTOCOL_ERROR',
      });
    }
    assertSafeIntelligencePayload(nested, seen);
  }
}

function isUnsafePublicKey(key: string): boolean {
  if (UNSAFE_PUBLIC_KEY_PATTERN.test(key)) return true;
  const normalized = key.replace(/[^a-z\d]/gi, '').toLowerCase();
  return (
    normalized === 'raw' ||
    /^raw(?:provider|request|response)?(?:body|payload)$/.test(normalized) ||
    /^provider(?:request|response)?(?:body|payload)$/.test(normalized)
  );
}

function asStrictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid intelligence response');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('invalid intelligence response');
  }
  return record;
}

function parseProtocolVersion(value: unknown): ProtocolVersion {
  if (value !== INTELLIGENCE_PROTOCOL_VERSION) throw new Error('invalid protocol version');
  return value;
}

function parseCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error('invalid cursor');
  }
  return value;
}

function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('invalid UUID');
  return value;
}

function parseCapabilitiesResponse(value: unknown): IntelligenceCapabilitiesResponse {
  const record = asStrictRecord(value, ['protocol_version', 'items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 256) {
    throw new Error('invalid capabilities');
  }
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    items: record.items.map((item) => CapabilityDescriptorSchema.parse(item)),
    next_cursor: parseCursor(record.next_cursor),
  };
}

function parseCapabilityDiscoveryResponse(value: unknown): IntelligenceCapabilityDiscoveryResponse {
  const record = asStrictRecord(value, [
    'protocol_version',
    'items',
    'execution_targets',
    'next_cursor',
  ]);
  if (!Array.isArray(record.items) || record.items.length > 256) {
    throw new Error('invalid capabilities');
  }
  if (!Array.isArray(record.execution_targets) || record.execution_targets.length > 1024) {
    throw new Error('invalid execution targets');
  }
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    items: record.items.map((item) => CapabilityDescriptorSchema.parse(item)),
    execution_targets: record.execution_targets.map(parseExecutionTarget),
    next_cursor: parseCursor(record.next_cursor),
  };
}

function parseExecutionTarget(value: unknown): IntelligenceExecutionTarget {
  const record = asStrictRecord(value, ['capability_id', 'provider_config_id', 'model']);
  if (record.capability_id !== 'studio.image.generate') {
    throw new Error('invalid capability');
  }
  const model = record.model;
  if (
    typeof model !== 'string' ||
    model.trim().length < 1 ||
    model.length > 255 ||
    /^[a-z][a-z\d+.-]*:/i.test(model) ||
    model.startsWith('//') ||
    /[?&#]/.test(model) ||
    MODEL_IDENTIFIER_SENSITIVE_PATTERN.test(model)
  ) {
    throw new Error('invalid model');
  }
  return {
    capability_id: record.capability_id,
    provider_config_id: parseUuid(record.provider_config_id),
    model,
  };
}

function parseTaskResponse(value: unknown): IntelligenceTaskResponse {
  const record = asStrictRecord(value, ['protocol_version', 'task_id', 'job_id', 'created']);
  if (typeof record.created !== 'boolean') throw new Error('invalid task response');
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    task_id: parseUuid(record.task_id),
    job_id: parseUuid(record.job_id),
    created: record.created,
  };
}

function parseTaskEventsResponse(value: unknown): IntelligenceTaskEventsResponse {
  const record = asStrictRecord(value, ['protocol_version', 'task_id', 'items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 1024) {
    throw new Error('invalid task events');
  }
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    task_id: parseUuid(record.task_id),
    items: record.items.map((item) => TaskEventSchema.parse(item)),
    next_cursor: parseCursor(record.next_cursor),
  };
}

export async function listIntelligenceCapabilities(
  projectId: string,
): Promise<IntelligenceCapabilitiesResponse> {
  return requestIntelligence(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/capabilities`,
        { showErrors: false },
      ),
    parseCapabilitiesResponse,
  );
}

/**
 * Discover executable provider/model choices. This is an additive opt-in
 * view; callers that only need public descriptors should use the simpler list
 * method above.
 */
export async function discoverIntelligenceCapabilities(
  projectId: string,
): Promise<IntelligenceCapabilityDiscoveryResponse> {
  return requestIntelligence(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/capabilities?include=execution_targets`,
        { showErrors: false },
      ),
    parseCapabilityDiscoveryResponse,
  );
}

export async function getIntelligenceAgentCard(
  projectId: string,
): Promise<IntelligenceAgentCardResponse> {
  return requestIntelligence(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/agent-card`,
        { showErrors: false },
      ),
    (value) => AgentCardSchema.parse(value),
  );
}

export async function createIntelligenceTask(
  projectId: string,
  input: IntelligenceCreateTaskRequest,
): Promise<IntelligenceTaskResponse> {
  return requestIntelligence(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/tasks`,
        input,
        { showErrors: false },
      ),
    parseTaskResponse,
  );
}

export async function getIntelligenceTaskEvents(
  projectId: string,
  taskId: string,
  cursor?: string | null,
): Promise<IntelligenceTaskEventsResponse> {
  return requestIntelligence(() => {
    const query = cursor == null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return backendApi.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/tasks/${encodeURIComponent(taskId)}/events${query}`,
      { showErrors: false },
    );
  }, parseTaskEventsResponse);
}
