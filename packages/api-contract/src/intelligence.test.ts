import { describe, expect, test } from 'bun:test';
import {
  IntelligenceCapabilitiesResponseSchema,
  IntelligenceCapabilityDiscoveryResponseSchema,
  IntelligenceCreateTaskRequestSchema,
  IntelligenceErrorCodeSchema,
  IntelligenceExecutionTargetSchema,
} from './intelligence';

const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';

describe('Intelligence API contract', () => {
  test('exposes only stable Intelligence error codes', () => {
    expect(IntelligenceErrorCodeSchema.parse('INTELLIGENCE_IDEMPOTENCY_MISMATCH')).toBe(
      'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
    );
    expect(
      IntelligenceErrorCodeSchema.safeParse('provider=https://secret.example.test').success,
    ).toBe(false);
  });

  test('accepts only redaction-safe execution options', () => {
    const option = {
      capability_id: 'studio.image.generate' as const,
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
    };

    expect(IntelligenceExecutionTargetSchema.parse(option)).toEqual(option);
    expect(
      IntelligenceExecutionTargetSchema.safeParse({
        ...option,
        provider_url: 'https://secret.example.test/v1',
      }).success,
    ).toBe(false);
    expect(
      IntelligenceExecutionTargetSchema.safeParse({
        ...option,
        credential_binding: { kind: 'secret', identifier: 'IMAGE_API_KEY' },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceExecutionTargetSchema.safeParse({
        ...option,
        model: 'https://secret.example.test/v1?api_key=raw',
      }).success,
    ).toBe(false);
    for (const model of [
      'data:text/plain,secret',
      'file:///tmp/key',
      'mailto:secret@example.test',
    ]) {
      expect(IntelligenceExecutionTargetSchema.safeParse({ ...option, model }).success).toBe(false);
    }
  });

  test('keeps the default capabilities view strict and validates the explicit discovery view', () => {
    const capabilities = {
      protocol_version: 'intelligence.v1' as const,
      items: [],
      next_cursor: null,
    };
    expect(IntelligenceCapabilitiesResponseSchema.parse(capabilities)).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
    });
    expect(
      IntelligenceCapabilitiesResponseSchema.safeParse({
        ...capabilities,
        execution_targets: [],
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCapabilityDiscoveryResponseSchema.parse({
        protocol_version: 'intelligence.v1',
        items: [],
        execution_targets: [
          {
            capability_id: 'studio.image.generate',
            provider_config_id: PROVIDER_CONFIG_ID,
            model: 'fake/image-v1',
          },
        ],
        next_cursor: null,
      }).execution_targets,
    ).toHaveLength(1);
    expect(
      IntelligenceCapabilitiesResponseSchema.safeParse({
        protocol_version: 'intelligence.v1',
        items: [
          {
            id: 'studio.image.generate',
            version: '1.0.0',
            modality: 'image',
            operation: 'generate',
            input_schema: { type: 'object', provider_url: 'https://secret.example.test' },
            output_schema: { type: 'array', asset_kinds: ['image'] },
            execution: 'async',
            risk: 'write',
            provenance_required: true,
          },
        ],
        next_cursor: null,
      }).success,
    ).toBe(false);
  });

  test('does not accept a provider URL as a task model identifier', () => {
    const valid = {
      protocol_version: 'intelligence.v1' as const,
      capability_id: 'studio.image.generate' as const,
      agent_card_hash: 'a'.repeat(64),
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
      input: {
        capability: 'image.generate' as const,
        image: {
          prompt: 'safe prompt',
          aspect_ratio: '1:1' as const,
          quality: 'standard' as const,
          output_count: 1,
        },
      },
      idempotency_key: 'intelligence-contract-task-0001',
    };
    expect(IntelligenceCreateTaskRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: {
            ...valid.input.image,
            advanced: { provider_url: 'https://secret.example.test/v1' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: {
            ...valid.input.image,
            advanced: { accessToken: 'secret-value' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: {
            ...valid.input.image,
            advanced: { endpoint: 'endpoint=https://secret.example.test/v1' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: { ...valid.input.image, advanced: { value: '//secret.example.test/key' } },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        model: 'https://secret.example.test/v1?api_key=raw',
      }).success,
    ).toBe(false);
  });
});
