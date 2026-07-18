import {
  IntelligenceAgentCardResponseSchema,
  IntelligenceCapabilitiesResponseSchema,
  IntelligenceCapabilityDiscoveryResponseSchema,
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  IntelligenceTaskResponseSchema,
} from '@kortix/api-contract';
import type {
  IntelligenceAgentCardResponse,
  IntelligenceCapabilitiesResponse,
  IntelligenceCapabilityDiscoveryResponse,
} from '@kortix/api-contract';
import { ApiError } from '../api/client.ts';
import { executorProjectContext } from './gateway.ts';

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
type SafeIntelligenceCode = (typeof SAFE_INTELLIGENCE_CODES)[number];
const SAFE_INTELLIGENCE_CODE_SET = new Set<SafeIntelligenceCode>(SAFE_INTELLIGENCE_CODES);

export type {
  IntelligenceAgentCardResponse,
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCapabilitiesResponse,
  IntelligenceCreateTaskRequest,
} from '@kortix/api-contract';

export interface IntelligenceCapabilityDiscoveryStatus {
  response: IntelligenceCapabilityDiscoveryResponse;
  legacy: boolean;
}

export class IntelligenceClientError extends Error {
  readonly name = 'IntelligenceClientError';

  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super('Intelligence request failed');
  }
}

export function intelligenceProjectContext(projectOverride?: string) {
  return executorProjectContext(projectOverride);
}

export async function listIntelligenceCapabilities(
  projectOverride?: string,
): Promise<IntelligenceCapabilitiesResponse> {
  const { client, projectId } = intelligenceProjectContext(projectOverride);
  let response: unknown;
  try {
    response = await client.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/capabilities`,
    );
  } catch (error) {
    throw mapIntelligenceError(error);
  }
  const parsed = IntelligenceCapabilitiesResponseSchema.safeParse(response);
  if (!parsed.success) throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
  return parsed.data;
}

export async function discoverIntelligenceCapabilities(
  projectOverride?: string,
): Promise<IntelligenceCapabilityDiscoveryResponse> {
  return (await discoverIntelligenceCapabilitiesWithStatus(projectOverride)).response;
}

/**
 * Discover the project-scoped execution view and retain whether the server
 * understood the additive execution-target extension. Older API deployments
 * remain readable, but their legacy response is never a writable discovery
 * basis for task creation.
 */
export async function discoverIntelligenceCapabilitiesWithStatus(
  projectOverride?: string,
): Promise<IntelligenceCapabilityDiscoveryStatus> {
  const { client, projectId } = intelligenceProjectContext(projectOverride);
  let response: unknown;
  try {
    response = await client.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/capabilities?include=execution_targets`,
    );
  } catch (error) {
    throw mapIntelligenceError(error);
  }
  const parsed = IntelligenceCapabilityDiscoveryResponseSchema.safeParse(response);
  if (parsed.success) return { response: parsed.data, legacy: false };

  // Older API deployments ignore the opt-in query and return the original v1 view.
  const legacy = IntelligenceCapabilitiesResponseSchema.safeParse(response);
  if (legacy.success) {
    return {
      response: { ...legacy.data, execution_targets: [] },
      legacy: true,
    };
  }
  throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
}

export async function getIntelligenceAgentCard(
  projectOverride?: string,
): Promise<IntelligenceAgentCardResponse> {
  const { client, projectId } = intelligenceProjectContext(projectOverride);
  let response: unknown;
  try {
    response = await client.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/agent-card`,
    );
  } catch (error) {
    throw mapIntelligenceError(error);
  }
  const parsed = IntelligenceAgentCardResponseSchema.safeParse(response);
  if (!parsed.success) throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
  return parsed.data;
}

export async function createIntelligenceTask(
  input: unknown,
  projectOverride?: string,
): Promise<string> {
  const request = parseIntelligenceCreateTaskRequest(input);
  if (!request) {
    throw new IntelligenceClientError('INTELLIGENCE_VALIDATION_ERROR', 400);
  }
  const { client, projectId } = intelligenceProjectContext(projectOverride);
  let response: unknown;
  try {
    response = await client.post<unknown>(
      `/projects/${encodeURIComponent(projectId)}/intelligence/tasks`,
      request,
    );
  } catch (error) {
    throw mapIntelligenceError(error);
  }
  const parsed = IntelligenceTaskResponseSchema.safeParse(response);
  if (!parsed.success) throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
  return parsed.data.task_id;
}

export function parseIntelligenceCreateTaskRequest(
  input: unknown,
): IntelligenceCreateTaskRequest | null {
  const parsed = IntelligenceCreateTaskRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function isSafeIntelligenceCode(value: unknown): value is string {
  return typeof value === 'string' && SAFE_INTELLIGENCE_CODE_SET.has(value as SafeIntelligenceCode);
}

function mapIntelligenceError(error: unknown): IntelligenceClientError {
  if (error instanceof IntelligenceClientError) return error;
  if (error instanceof ApiError) {
    return new IntelligenceClientError(
      safeApiCode(error.body) ?? 'INTELLIGENCE_REQUEST_FAILED',
      error.status,
    );
  }
  return new IntelligenceClientError('INTELLIGENCE_REQUEST_FAILED', 0);
}

function safeApiCode(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('code' in body)) return null;
  const code = (body as { code?: unknown }).code;
  return isSafeIntelligenceCode(code) ? code : null;
}
