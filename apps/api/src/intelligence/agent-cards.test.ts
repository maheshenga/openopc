import { describe, expect, test } from 'bun:test';
import { AgentCardSchema, type CapabilityDescriptor } from '@kortix/intelligence-contracts';
import { buildProjectAgentCard } from './agent-cards';

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
} satisfies CapabilityDescriptor;

const baseInput = {
  projectId: '12000000-0000-4000-a000-000000000001',
  agentId: 'content-planner',
  displayName: 'Content Planner',
  capabilities: [imageCapability],
  trustTier: 'project' as const,
};

describe('project Agent Cards', () => {
  test('builds a schema-valid card with a deterministic hash', () => {
    const card = buildProjectAgentCard(baseInput);

    expect(AgentCardSchema.parse(card)).toEqual(card);
    expect(card.card_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('keeps the hash stable across input ordering and changes it for capability versions', () => {
    const reordered = buildProjectAgentCard({
      ...baseInput,
      capabilities: [{ ...imageCapability, output_schema: { type: 'array' } }],
      protocols: ['a2a', 'mcp'],
    });
    const changed = buildProjectAgentCard({
      ...baseInput,
      capabilities: [{ ...imageCapability, version: '1.1.0' }],
    });

    expect(reordered.card_hash).toBe(buildProjectAgentCard(baseInput).card_hash);
    expect(changed.card_hash).not.toBe(buildProjectAgentCard(baseInput).card_hash);
  });

  test('does not copy secret or provider connection fields into the public card', () => {
    const card = buildProjectAgentCard({
      ...baseInput,
      capabilities: [
        {
          ...imageCapability,
          input_schema: {
            api_key: 'raw-secret',
            provider_url: 'https://user:password@example.com',
          },
        },
      ],
    });

    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('raw-secret');
    expect(serialized).not.toContain('provider_url');
    expect(serialized).not.toContain('example.com');
  });
});
