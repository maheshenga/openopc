import { describe, expect, test } from 'bun:test';
import {
  IntelligenceA2AMessageSendRequestSchema,
  IntelligenceA2ATaskResponseSchema,
  type IntelligenceCreateTaskRequest,
} from '@kortix/api-contract';
import type { CapabilityDescriptor, TaskEvent } from '@kortix/intelligence-contracts';
import { createA2ATaskAdapter, parseA2ATaskRequest, serializeAgentCard } from './a2a';
import { buildProjectAgentCard } from './agent-cards';

const imageCapability: CapabilityDescriptor = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image',
  operation: 'generate',
  input_schema: { type: 'object', name: 'StudioImageGenerateInput' },
  output_schema: { type: 'array', asset_kinds: ['image'] },
  execution: 'async',
  risk: 'write',
  provenance_required: true,
};

const card = buildProjectAgentCard({
  projectId: '12000000-0000-4000-a000-000000000001',
  agentId: 'content-planner',
  displayName: 'Content Planner',
  capabilities: [imageCapability],
});

const taskRequest: IntelligenceCreateTaskRequest = {
  protocol_version: 'intelligence.v1',
  capability_id: 'studio.image.generate',
  agent_card_hash: card.card_hash,
  provider_config_id: '14000000-0000-4000-a000-000000000001',
  model: 'fake/image-v1',
  input: {
    capability: 'image.generate',
    image: {
      prompt: 'A protocol fixture',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    },
  },
  idempotency_key: 'a2a-idempotency-key-01',
  parent_task_id: null,
  deadline_at: null,
};

const a2aEnvelope = (request: IntelligenceCreateTaskRequest = taskRequest) => ({
  jsonrpc: '2.0',
  id: 'message-1',
  method: 'message/send',
  params: { sender_card_hash: card.card_hash, task: request },
});

describe('A2A adapter', () => {
  test('serializes a redaction-safe Agent Card with the A2A media type', async () => {
    const response = serializeAgentCard(card);
    expect(response.headers.get('content-type')).toMatch(/^application\/a2a\+json/);

    const body = await response.json();
    expect(body).toMatchObject({
      name: card.display_name,
      version: card.version,
      protocolVersion: '1.0.1',
      skills: [{ id: 'studio.image.generate' }],
    });
    expect(JSON.stringify(body)).toContain(card.card_hash);
    expect(JSON.stringify(body)).not.toMatch(/secret|token|credential|signed_url|provider_url/i);
  });

  test('parses a supported A2A message/send task envelope', () => {
    const envelope = {
      jsonrpc: '2.0',
      id: 'message-1',
      method: 'message/send',
      params: {
        sender_card_hash: card.card_hash,
        task: taskRequest,
      },
    } as const;
    const parsed = parseA2ATaskRequest(envelope);
    expect(IntelligenceA2AMessageSendRequestSchema.parse(envelope)).toEqual(envelope);
    expect(parsed).toEqual({ request: taskRequest, senderCardHash: card.card_hash });
  });

  test('rejects an unsupported A2A capability with a typed protocol error', () => {
    expect(() =>
      parseA2ATaskRequest({
        jsonrpc: '2.0',
        id: 'message-2',
        method: 'message/send',
        params: {
          sender_card_hash: card.card_hash,
          task: { ...taskRequest, capability_id: 'studio.video.generate' },
        },
      }),
    ).toThrow('A2A_UNSUPPORTED_CAPABILITY');
  });

  test('classifies an invalid JSON-RPC envelope before inspecting its capability', () => {
    expect(() =>
      parseA2ATaskRequest({
        params: {
          sender_card_hash: card.card_hash,
          task: { ...taskRequest, capability_id: 'studio.video.generate' },
        },
      }),
    ).toThrow('A2A_INVALID_REQUEST');
  });

  test('rejects an expired A2A task deadline before execution', () => {
    expect(() =>
      parseA2ATaskRequest({
        jsonrpc: '2.0',
        id: 'message-3',
        method: 'message/send',
        params: {
          sender_card_hash: card.card_hash,
          task: { ...taskRequest, deadline_at: '2020-01-01T00:00:00.000Z' },
        },
      }),
    ).toThrow('A2A_DEADLINE_EXPIRED');
  });

  test('maps a validated A2A task to the existing Intelligence service', async () => {
    const calls: unknown[] = [];
    const adapter = createA2ATaskAdapter({
      async create(input) {
        calls.push(input);
        return {
          taskId: '15000000-0000-4000-a000-000000000001',
          jobId: '16000000-0000-4000-a000-000000000001',
          created: true,
        };
      },
      async events() {
        return { items: [], nextCursor: null };
      },
    });

    const response = await adapter.create({
      accountId: '11000000-0000-4000-a000-000000000001',
      projectId: '12000000-0000-4000-a000-000000000001',
      actorUserId: '13000000-0000-4000-a000-000000000001',
      actorType: 'agent',
      actingTokenId: '18000000-0000-4000-a000-000000000001',
      agentName: 'content-planner',
      sessionId: 'session-1',
      body: a2aEnvelope(),
    });

    expect(response).toMatchObject({
      id: '15000000-0000-4000-a000-000000000001',
      contextId: '12000000-0000-4000-a000-000000000001',
      status: { state: 'submitted' },
      metadata: { job_id: '16000000-0000-4000-a000-000000000001' },
    });
    expect(IntelligenceA2ATaskResponseSchema.parse(response)).toEqual(response);
    expect(calls[0]).toMatchObject({
      accountId: '11000000-0000-4000-a000-000000000001',
      projectId: '12000000-0000-4000-a000-000000000001',
      request: taskRequest,
    });
    expect(JSON.stringify(response)).not.toMatch(/provider|secret|signed_url|raw_body/i);
  });

  test('maps public task events to A2A task states without leaking the internal cursor', async () => {
    const cases: Array<[TaskEvent['status'], string]> = [
      ['queued', 'submitted'],
      ['running', 'working'],
      ['waiting_approval', 'input-required'],
      ['succeeded', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'canceled'],
    ];

    for (const [status, expectedState] of cases) {
      const event: TaskEvent = {
        protocol_version: 'intelligence.v1',
        event_id: '17000000-0000-4000-a000-000000000001',
        task_id: '15000000-0000-4000-a000-000000000001',
        sequence: 1,
        type: eventType(status),
        status,
        created_at: '2026-07-18T12:00:00.000Z',
      };
      const adapter = createA2ATaskAdapter({
        async create() {
          throw new Error('not used');
        },
        async events() {
          return { items: [event], nextCursor: 'private-source-cursor' };
        },
      });

      const response = await adapter.events({
        accountId: '11000000-0000-4000-a000-000000000001',
        projectId: '12000000-0000-4000-a000-000000000001',
        taskId: '15000000-0000-4000-a000-000000000001',
        cursor: null,
      });

      expect(response).toMatchObject({
        id: '15000000-0000-4000-a000-000000000001',
        contextId: '12000000-0000-4000-a000-000000000001',
        status: { state: expectedState, timestamp: event.created_at },
        metadata: { events: [event] },
      });
      expect(JSON.stringify(response)).not.toContain('private-source-cursor');
    }
  });

  test('replays an idempotent A2A task without executing it twice', async () => {
    const result = {
      taskId: '15000000-0000-4000-a000-000000000001',
      jobId: '16000000-0000-4000-a000-000000000001',
      created: true,
    };
    let existing = false;
    let creates = 0;
    const adapter = createA2ATaskAdapter({
      async replay() {
        return existing ? { ...result, created: false } : null;
      },
      async create() {
        creates += 1;
        existing = true;
        return result;
      },
      async events() {
        return { items: [], nextCursor: null };
      },
    });
    const input = {
      accountId: '11000000-0000-4000-a000-000000000001',
      projectId: '12000000-0000-4000-a000-000000000001',
      actorUserId: '13000000-0000-4000-a000-000000000001',
      actorType: 'agent' as const,
      actingTokenId: '18000000-0000-4000-a000-000000000001',
      agentName: 'content-planner',
      sessionId: 'session-1',
      body: a2aEnvelope(),
    };

    const first = await adapter.create(input);
    const replay = await adapter.create(input);

    expect(creates).toBe(1);
    expect(first).toMatchObject({ id: result.taskId, status: { state: 'submitted' } });
    expect(replay).toMatchObject({ id: result.taskId, status: { state: 'working' } });
  });
});

function eventType(status: TaskEvent['status']): TaskEvent['type'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'waiting_approval':
      return 'approval_required';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}
