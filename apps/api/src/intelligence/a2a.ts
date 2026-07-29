import {
  IntelligenceA2AMessageSendEnvelopeSchema,
  IntelligenceA2AMessageSendRequestSchema,
  type IntelligenceA2ATaskResponse,
  IntelligenceA2ATaskResponseSchema,
  type IntelligenceA2ATaskState,
  type IntelligenceCreateTaskRequest,
} from '@kortix/api-contract';
import {
  type AgentCard,
  AgentCardSchema,
  type TaskEvent,
  TaskEventSchema,
} from '@kortix/intelligence-contracts';
import { PRODUCT_BRAND } from '@kortix/product-brand';
import type { IntelligenceTaskCreateInput, IntelligenceTaskCreateResult } from './task-service';

export const A2A_PROTOCOL_VERSION = '1.0.1' as const;

export class A2AProtocolError extends Error {
  constructor(
    readonly code:
      | 'A2A_INVALID_REQUEST'
      | 'A2A_UNSUPPORTED_CAPABILITY'
      | 'A2A_DEADLINE_EXPIRED'
      | 'A2A_AGENT_UNTRUSTED',
    readonly status: 400 | 403 | 409,
  ) {
    super(code);
    this.name = 'A2AProtocolError';
  }
}

export type A2ATaskState = IntelligenceA2ATaskState;
export type A2ATaskResponse = IntelligenceA2ATaskResponse;

export interface A2ATaskService {
  replay?(input: {
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    actorType: 'user' | 'agent' | 'system';
    agentName?: string | null;
    request: IntelligenceCreateTaskRequest;
  }): Promise<IntelligenceTaskCreateResult | null>;
  create(input: IntelligenceTaskCreateInput): Promise<IntelligenceTaskCreateResult>;
  events(input: {
    accountId: string;
    projectId: string;
    taskId: string;
    cursor: string | null;
  }): Promise<{ items: TaskEvent[]; nextCursor: string | null } | null>;
}

export type A2ATaskAdapterCreateInput = Omit<IntelligenceTaskCreateInput, 'request'> & {
  body: unknown;
};

export type A2ATaskAdapterEventsInput = {
  accountId: string;
  projectId: string;
  taskId: string;
  cursor: string | null;
};

export function serializeAgentCard(card: AgentCard): Response {
  const parsed = AgentCardSchema.parse(card);
  const body = {
    name: parsed.display_name,
    description: `${PRODUCT_BRAND.displayName} project agent ${parsed.id}`,
    version: parsed.version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: parsed.capabilities.map((id) => ({
      id,
      name: id,
      description: `Execute ${id}`,
      tags: [id],
      examples: [],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    })),
    metadata: {
      card_hash: parsed.card_hash,
      agent_id: parsed.id,
      protocols: parsed.protocols,
      trust_tier: parsed.trust_tier,
      limits: parsed.limits,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/a2a+json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function parseA2ATaskRequest(body: unknown): {
  request: IntelligenceCreateTaskRequest;
  senderCardHash: string;
} {
  const rawEnvelope = IntelligenceA2AMessageSendEnvelopeSchema.safeParse(body);
  if (!rawEnvelope.success) {
    throw new A2AProtocolError('A2A_INVALID_REQUEST', 400);
  }
  const rawTask = rawEnvelope.data.params.task;
  if (
    isRecord(rawTask) &&
    typeof rawTask.capability_id === 'string' &&
    rawTask.capability_id !== 'studio.image.generate'
  ) {
    throw new A2AProtocolError('A2A_UNSUPPORTED_CAPABILITY', 400);
  }
  const envelope = IntelligenceA2AMessageSendRequestSchema.safeParse(body);
  if (!envelope.success) {
    throw new A2AProtocolError('A2A_INVALID_REQUEST', 400);
  }
  const parsedRequest = envelope.data.params.task;
  if (
    parsedRequest.deadline_at !== null &&
    parsedRequest.deadline_at !== undefined &&
    Date.parse(parsedRequest.deadline_at) <= Date.now()
  ) {
    throw new A2AProtocolError('A2A_DEADLINE_EXPIRED', 409);
  }
  if (parsedRequest.agent_card_hash !== envelope.data.params.sender_card_hash) {
    throw new A2AProtocolError('A2A_AGENT_UNTRUSTED', 403);
  }
  return {
    request: parsedRequest,
    senderCardHash: envelope.data.params.sender_card_hash,
  };
}

export function createA2ATaskAdapter(service: A2ATaskService) {
  return {
    async create(input: A2ATaskAdapterCreateInput): Promise<A2ATaskResponse> {
      const parsed = parseA2ATaskRequest(input.body);
      if (service.replay) {
        const replay = await service.replay({
          accountId: input.accountId,
          projectId: input.projectId,
          actorUserId: input.actorUserId,
          actorType: input.actorType,
          agentName: input.agentName,
          request: parsed.request,
        });
        if (replay) return taskResponse(input.projectId, replay);
      }
      const { body: _body, ...createInput } = input;
      const result = await service.create({ ...createInput, request: parsed.request });
      return taskResponse(input.projectId, result);
    },
    async events(input: A2ATaskAdapterEventsInput): Promise<A2ATaskResponse | null> {
      const page = await service.events(input);
      if (!page) return null;
      const items = page.items.map((event) => TaskEventSchema.parse(event));
      const last = items.at(-1);
      return IntelligenceA2ATaskResponseSchema.parse({
        id: input.taskId,
        contextId: input.projectId,
        status: {
          state: mapA2ATaskState(items),
          timestamp: last?.created_at ?? new Date(0).toISOString(),
        },
        metadata: { events: items },
      });
    },
  };
}

export function mapA2ATaskState(events: readonly TaskEvent[]): A2ATaskState {
  const latest = events.at(-1);
  if (!latest) return 'submitted';
  switch (latest.status) {
    case 'running':
      return 'working';
    case 'waiting_approval':
      return 'input-required';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'submitted';
  }
}

function taskResponse(projectId: string, result: IntelligenceTaskCreateResult): A2ATaskResponse {
  return IntelligenceA2ATaskResponseSchema.parse({
    id: result.taskId,
    contextId: projectId,
    status: {
      state: result.created ? 'submitted' : 'working',
      timestamp: new Date().toISOString(),
    },
    metadata: { job_id: result.jobId },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
