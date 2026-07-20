// Project-scoped Intelligence Fabric REST methods.
//
// The published SDK keeps a small, wire-shaped client contract here and shares
// only side-effect-free domain contracts from @kortix/intelligence-contracts.
// The response parsers stay at this boundary so malformed 2xx payloads fail
// closed before they reach a host application.

import {
  CAPABILITY_CATALOG_MAX_CURSOR,
  type AgentCard,
  AgentCardSchema,
  type CapabilityCatalogItem,
  CapabilityCatalogItemSchema,
  type CapabilityCatalogRef,
  CapabilityCatalogRefSchema,
  hasUnsafeCatalogCredentialLiteral,
  isPublicCatalogInputSchema,
  type CapabilityDescriptor,
  CapabilityDescriptorSchema,
  type ProtocolVersion,
  type TaskEvent,
  TaskEventSchema,
  type WorkflowApproval,
  WorkflowApprovalSchema,
  type WorkflowEvent,
  WorkflowEventSchema,
  type WorkflowNode,
  WorkflowNodeSchema,
  type WorkflowProtocolVersion,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@kortix/intelligence-contracts';
import { ApiError, type ApiResponse } from '../../http/api-client';
import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type {
  AgentCard,
  CapabilityCatalogItem,
  CapabilityCatalogRef,
  CapabilityDescriptor,
  ProtocolVersion,
  TaskEvent,
  WorkflowApproval,
  WorkflowEvent,
  WorkflowNode,
  WorkflowProtocolVersion,
  WorkflowRun,
} from '@kortix/intelligence-contracts';

const SAFE_INTELLIGENCE_CODES = [
  'INTELLIGENCE_AGENT_CARD_UNAVAILABLE',
  'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
  'INTELLIGENCE_CAPABILITIES_UNAVAILABLE',
  'INTELLIGENCE_CATALOG_UNAVAILABLE',
  'INTELLIGENCE_CAPABILITY_UNAVAILABLE',
  'INTELLIGENCE_DISCOVERY_INVALID',
  'INTELLIGENCE_DISCOVERY_TOO_LARGE',
  'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
  'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
  'INTELLIGENCE_ESTIMATE_INVALID',
  'INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED',
  'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
  'INTELLIGENCE_PROTOCOL_ERROR',
  'INTELLIGENCE_PROTOCOL_UNSUPPORTED',
  'INTELLIGENCE_REQUEST_FAILED',
  'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE',
  'INTELLIGENCE_TASK_EXECUTION_FAILED',
  'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
  'INTELLIGENCE_TASK_LOOKUP_UNAVAILABLE',
  'INTELLIGENCE_VALIDATION_ERROR',
  'INTELLIGENCE_WORKFLOW_CONFLICT',
  'INTELLIGENCE_WORKFLOW_UNAVAILABLE',
  'INTELLIGENCE_WORKFLOW_UNTRUSTED',
  'INTELLIGENCE_WORKFLOW_VALIDATION_ERROR',
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
export const INTELLIGENCE_WORKFLOW_PROTOCOL_VERSION =
  'intelligence.workflow.v1' as const satisfies WorkflowProtocolVersion;

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

export interface IntelligenceCatalogSearchInput {
  query: string;
  limit?: number;
  cursor?: number | null;
}

export interface IntelligenceCatalogSearchResponse {
  protocol_version: ProtocolVersion;
  items: CapabilityCatalogItem[];
  next_cursor: number | null;
}

export interface IntelligenceCatalogDescribeResponse {
  protocol_version: ProtocolVersion;
  ref: CapabilityCatalogRef;
  input_schema: Record<string, unknown>;
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

export interface IntelligenceEstimateApproval {
  estimate_id: string;
  estimate_token: string;
  max_approved_credits: number;
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
  estimate_approval?: IntelligenceEstimateApproval;
}

export interface IntelligenceTaskResponse {
  protocol_version: ProtocolVersion;
  task_id: string;
  job_id: string;
  created: boolean;
}

export interface IntelligenceTaskLookupResponse {
  protocol_version: ProtocolVersion;
  task_id: string;
  job_id: string;
}

export interface IntelligenceTaskEventsResponse {
  protocol_version: ProtocolVersion;
  task_id: string;
  items: TaskEvent[];
  next_cursor: string | null;
}

export interface IntelligenceWorkflowStartRequest {
  protocol_version: WorkflowProtocolVersion;
  idempotency_key: string;
  goal: string;
  context_asset_ids: string[];
  policy_snapshot_hash: string | null;
  evaluation_version: string | null;
  max_nodes: number;
  max_dependencies: number;
  max_approved_credits: number;
  deadline_at: string | null;
}

export interface IntelligenceWorkflowCancelRequest {
  protocol_version: WorkflowProtocolVersion;
  reason_code: string;
}

export interface IntelligenceWorkflowApprovalDecisionRequest {
  protocol_version: WorkflowProtocolVersion;
  decision: 'approve' | 'reject' | 'changes_requested';
  feedback_hash: string | null;
}

export interface IntelligenceWorkflowStartResponse {
  protocol_version: WorkflowProtocolVersion;
  run: WorkflowRun;
  created: boolean;
}

export interface IntelligenceWorkflowRunResponse {
  protocol_version: WorkflowProtocolVersion;
  run: WorkflowRun;
}

export interface IntelligenceWorkflowEventsResponse {
  protocol_version: WorkflowProtocolVersion;
  run_id: string;
  items: WorkflowEvent[];
  next_cursor: string | null;
}

export interface IntelligenceWorkflowApprovalDecisionResponse {
  protocol_version: WorkflowProtocolVersion;
  run: WorkflowRun;
  node: WorkflowNode;
  approval: WorkflowApproval;
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
      UNSAFE_PUBLIC_CREDENTIAL_TEXT_PATTERN.test(value) || hasUnsafeCatalogCredentialLiteral(value)
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
  return isRawProviderMetadataKey(normalized);
}

function isRawProviderMetadataKey(normalized: string): boolean {
  return (
    normalized === 'raw' ||
    normalized === 'rawdata' ||
    /^raw(?:provider|request|response)?(?:body|payload|request|response)$/.test(normalized) ||
    /^provider(?:request|response)(?:body|payload)?$/.test(normalized) ||
    /^(?:request|response)(?:body|payload)$/.test(normalized)
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

function parseWorkflowProtocolVersion(value: unknown): WorkflowProtocolVersion {
  if (value !== INTELLIGENCE_WORKFLOW_PROTOCOL_VERSION) {
    throw new Error('invalid workflow protocol version');
  }
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

function parseCatalogSearchResponse(value: unknown): IntelligenceCatalogSearchResponse {
  const record = asStrictRecord(value, ['protocol_version', 'items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 50) {
    throw new Error('invalid catalog');
  }
  if (
    record.next_cursor !== null &&
    (typeof record.next_cursor !== 'number' ||
      !Number.isSafeInteger(record.next_cursor) ||
      record.next_cursor < 0 ||
      record.next_cursor > CAPABILITY_CATALOG_MAX_CURSOR)
  ) {
    throw new Error('invalid catalog cursor');
  }
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    items: record.items.map((item) => CapabilityCatalogItemSchema.parse(item)),
    next_cursor: record.next_cursor,
  };
}

function parseCatalogDescribeResponse(
  value: unknown,
  expectedRef: CapabilityCatalogRef,
): IntelligenceCatalogDescribeResponse {
  const record = asStrictRecord(value, ['protocol_version', 'ref', 'input_schema']);
  if (!record.input_schema || typeof record.input_schema !== 'object' || Array.isArray(record.input_schema)) {
    throw new Error('invalid catalog description');
  }
  const inputSchema = record.input_schema as Record<string, unknown>;
  if (
    Object.keys(inputSchema).some((key) => key.length < 1 || key.length > 128) ||
    !isPublicCatalogInputSchema(inputSchema)
  ) {
    throw new Error('invalid catalog description');
  }
  const ref = CapabilityCatalogRefSchema.parse(record.ref);
  if (
    ref.kind !== expectedRef.kind ||
    ref.id !== expectedRef.id ||
    ref.version !== expectedRef.version
  ) {
    throw new Error('invalid catalog scope');
  }
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    ref,
    input_schema: inputSchema,
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

function parseTaskLookupResponse(value: unknown): IntelligenceTaskLookupResponse {
  const record = asStrictRecord(value, ['protocol_version', 'task_id', 'job_id']);
  return {
    protocol_version: parseProtocolVersion(record.protocol_version),
    task_id: parseUuid(record.task_id),
    job_id: parseUuid(record.job_id),
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

function parseWorkflowStartResponse(
  value: unknown,
  projectId: string,
): IntelligenceWorkflowStartResponse {
  const record = asStrictRecord(value, ['protocol_version', 'run', 'created']);
  if (typeof record.created !== 'boolean') throw new Error('invalid workflow response');
  const response = {
    protocol_version: parseWorkflowProtocolVersion(record.protocol_version),
    run: WorkflowRunSchema.parse(record.run),
    created: record.created,
  };
  assertWorkflowRunScope(response.run, projectId);
  return response;
}

function parseWorkflowRunResponse(
  value: unknown,
  projectId: string,
  runId: string,
): IntelligenceWorkflowRunResponse {
  const record = asStrictRecord(value, ['protocol_version', 'run']);
  const response = {
    protocol_version: parseWorkflowProtocolVersion(record.protocol_version),
    run: WorkflowRunSchema.parse(record.run),
  };
  assertWorkflowRunScope(response.run, projectId, runId);
  return response;
}

function parseWorkflowEventsResponse(
  value: unknown,
  runId: string,
): IntelligenceWorkflowEventsResponse {
  const record = asStrictRecord(value, ['protocol_version', 'run_id', 'items', 'next_cursor']);
  if (!Array.isArray(record.items) || record.items.length > 100) {
    throw new Error('invalid workflow events');
  }
  const response = {
    protocol_version: parseWorkflowProtocolVersion(record.protocol_version),
    run_id: parseUuid(record.run_id),
    items: record.items.map((item) => WorkflowEventSchema.parse(item)),
    next_cursor: parseCursor(record.next_cursor),
  };
  if (response.run_id !== runId || response.items.some((item) => item.run_id !== runId)) {
    throw new Error('invalid workflow scope');
  }
  return response;
}

function parseWorkflowApprovalDecisionResponse(
  value: unknown,
  projectId: string,
  runId: string,
  approvalId: string,
): IntelligenceWorkflowApprovalDecisionResponse {
  const record = asStrictRecord(value, ['protocol_version', 'run', 'node', 'approval']);
  const response = {
    protocol_version: parseWorkflowProtocolVersion(record.protocol_version),
    run: WorkflowRunSchema.parse(record.run),
    node: WorkflowNodeSchema.parse(record.node),
    approval: WorkflowApprovalSchema.parse(record.approval),
  };
  assertWorkflowRunScope(response.run, projectId, runId);
  if (
    response.node.run_id !== runId ||
    response.approval.run_id !== runId ||
    response.approval.approval_id !== approvalId ||
    response.approval.node_id !== response.node.node_id
  ) {
    throw new Error('invalid workflow scope');
  }
  return response;
}

function assertWorkflowRunScope(run: WorkflowRun, projectId: string, runId?: string): void {
  if (run.project_id !== projectId || (runId !== undefined && run.run_id !== runId)) {
    throw new Error('invalid workflow scope');
  }
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

export async function searchIntelligenceCatalog(
  projectId: string,
  input: IntelligenceCatalogSearchInput,
): Promise<IntelligenceCatalogSearchResponse> {
  return requestIntelligence(() => {
    const query = new URLSearchParams();
    if (input.query) query.set('query', input.query);
    query.set('limit', String(input.limit ?? 20));
    if (input.cursor != null) query.set('cursor', String(input.cursor));
    return backendApi.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/catalog?${query.toString()}`,
      { showErrors: false },
    );
  }, parseCatalogSearchResponse);
}

export async function describeIntelligenceCatalog(
  projectId: string,
  ref: CapabilityCatalogRef,
): Promise<IntelligenceCatalogDescribeResponse> {
  let expectedRef: CapabilityCatalogRef | null = null;
  return requestIntelligence(() => {
    expectedRef = CapabilityCatalogRefSchema.parse(ref);
    const query = new URLSearchParams({
      kind: expectedRef.kind,
      id: expectedRef.id,
      version: expectedRef.version,
    });
    return backendApi.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/catalog/describe?${query.toString()}`,
      { showErrors: false },
    );
  }, (value) => parseCatalogDescribeResponse(value, expectedRef!));
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

export async function getIntelligenceTaskByJob(
  projectId: string,
  jobId: string,
): Promise<IntelligenceTaskLookupResponse> {
  return requestIntelligence(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/tasks/by-job/${encodeURIComponent(jobId)}`,
        { showErrors: false },
      ),
    parseTaskLookupResponse,
  );
}

export async function startIntelligenceWorkflow(
  projectId: string,
  input: IntelligenceWorkflowStartRequest,
): Promise<IntelligenceWorkflowStartResponse> {
  return requestIntelligence(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/workflows`,
        input,
        { showErrors: false },
      ),
    (value) => parseWorkflowStartResponse(value, projectId),
  );
}

export async function getIntelligenceWorkflow(
  projectId: string,
  runId: string,
): Promise<IntelligenceWorkflowRunResponse> {
  return requestIntelligence(
    () =>
      backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/workflows/${encodeURIComponent(runId)}`,
        { showErrors: false },
      ),
    (value) => parseWorkflowRunResponse(value, projectId, runId),
  );
}

export async function cancelIntelligenceWorkflow(
  projectId: string,
  runId: string,
  input: IntelligenceWorkflowCancelRequest,
): Promise<IntelligenceWorkflowRunResponse> {
  return requestIntelligence(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/workflows/${encodeURIComponent(runId)}/cancel`,
        input,
        { showErrors: false },
      ),
    (value) => parseWorkflowRunResponse(value, projectId, runId),
  );
}

export async function getIntelligenceWorkflowEvents(
  projectId: string,
  runId: string,
  cursor?: string | null,
  limit?: number,
): Promise<IntelligenceWorkflowEventsResponse> {
  return requestIntelligence(
    () => {
      const query: string[] = [];
      if (cursor != null) query.push(`cursor=${encodeURIComponent(cursor)}`);
      if (limit !== undefined) query.push(`limit=${encodeURIComponent(String(limit))}`);
      const suffix = query.length === 0 ? '' : `?${query.join('&')}`;
      return backendApi.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/workflows/${encodeURIComponent(runId)}/events${suffix}`,
        { showErrors: false },
      );
    },
    (value) => parseWorkflowEventsResponse(value, runId),
  );
}

export async function decideIntelligenceWorkflowApproval(
  projectId: string,
  runId: string,
  approvalId: string,
  input: IntelligenceWorkflowApprovalDecisionRequest,
): Promise<IntelligenceWorkflowApprovalDecisionResponse> {
  return requestIntelligence(
    () =>
      backendApi.post<unknown>(
        `/projects/${encodeURIComponent(projectId)}/intelligence/workflows/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
        input,
        { showErrors: false },
      ),
    (value) => parseWorkflowApprovalDecisionResponse(value, projectId, runId, approvalId),
  );
}
