import { describe, expect, test } from 'bun:test';
import {
  AgentCardSchema,
  CapabilityDescriptorSchema,
  TaskEnvelopeSchema,
  TaskEventSchema,
} from './schemas';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const TASK_ID = '13000000-0000-4000-a000-000000000001';
const EVENT_ID = '14000000-0000-4000-a000-000000000001';
const ACTOR_ID = '15000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);

const imageCapability = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image' as const,
  operation: 'generate',
  input_schema: { type: 'object' },
  output_schema: { type: 'array' },
  execution: 'async' as const,
  risk: 'write' as const,
  provenance_required: true,
};

const agentCard = {
  id: 'content-planner',
  version: '1.0.0',
  display_name: 'Content Planner',
  capabilities: ['studio.image.generate'],
  protocols: ['mcp', 'a2a'] as const,
  auth: { kind: 'kortix-project-token' as const },
  trust_tier: 'project' as const,
  limits: { concurrency: 2, max_task_seconds: 900 },
  card_hash: CARD_HASH,
};

const taskEnvelope = {
  protocol_version: 'intelligence.v1' as const,
  task_id: TASK_ID,
  parent_task_id: null,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  actor_type: 'agent' as const,
  actor_id: ACTOR_ID,
  capability_id: 'studio.image.generate',
  agent_card_hash: CARD_HASH,
  input_ref: 'studio-job-input',
  idempotency_key: 'task-key-00000001',
  deadline_at: '2026-07-18T12:00:00.000Z',
  approval: 'pending' as const,
};

const taskEvent = {
  protocol_version: 'intelligence.v1' as const,
  event_id: EVENT_ID,
  task_id: TASK_ID,
  sequence: 1,
  type: 'created' as const,
  status: 'queued' as const,
  created_at: '2026-07-18T10:00:00.000Z',
};

describe('intelligence contract schemas', () => {
  test('accepts the first image capability descriptor', () => {
    expect(CapabilityDescriptorSchema.parse(imageCapability).id).toBe('studio.image.generate');
  });

  test('accepts a project Agent Card, task envelope, and task event', () => {
    expect(AgentCardSchema.parse(agentCard).card_hash).toBe(CARD_HASH);
    expect(TaskEnvelopeSchema.parse(taskEnvelope).project_id).toBe(PROJECT_ID);
    expect(TaskEventSchema.parse(taskEvent).sequence).toBe(1);
  });

  test('rejects malformed project identifiers', () => {
    expect(() => TaskEnvelopeSchema.parse({ ...taskEnvelope, project_id: 'project-1' })).toThrow();
  });

  test('rejects an unknown capability modality', () => {
    expect(() =>
      CapabilityDescriptorSchema.parse({ ...imageCapability, modality: 'prompt' }),
    ).toThrow();
  });

  test('rejects a missing or malformed card hash', () => {
    const { card_hash: _cardHash, ...withoutHash } = agentCard;
    expect(() => AgentCardSchema.parse(withoutHash)).toThrow();
    expect(() => AgentCardSchema.parse({ ...agentCard, card_hash: 'not-a-hash' })).toThrow();
  });

  test('rejects an invalid trust tier', () => {
    expect(() => AgentCardSchema.parse({ ...agentCard, trust_tier: 'untrusted' })).toThrow();
  });

  test('rejects unknown top-level keys instead of silently stripping them', () => {
    expect(() =>
      CapabilityDescriptorSchema.parse({ ...imageCapability, secret: 'value' }),
    ).toThrow();
    expect(() => AgentCardSchema.parse({ ...agentCard, token: 'value' })).toThrow();
    expect(() =>
      TaskEnvelopeSchema.parse({ ...taskEnvelope, provider_url: 'https://example.test' }),
    ).toThrow();
  });
});
