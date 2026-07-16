import { describe, expect, test } from 'bun:test';
import type { StudioJobInput } from '@kortix/api-contract';
import type { StudioPricingSnapshot, StudioProviderDefinitionConfig } from '@kortix/studio-runtime';
import {
  OPENAI_IMAGE_GENERIC_PROFILE,
  type OpenAiCompatibleModelConfig,
  type StudioProviderCapabilityMap,
  parseOpenAiCompatibleCapabilityMap,
} from './config';
import { openAiCompatibleImageDefinition } from './definition';

const model = {
  model: 'image-model-v1',
  pricing_catalog_id: 'pricing-image-v1',
  dialect_profile_id: 'openai-images-v1-generic',
  supports_reference_images: false,
  allowed_advanced_fields: [],
  size_map: {
    '1:1': '1024x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
  },
} as const satisfies OpenAiCompatibleModelConfig;

function providerConfig(
  modelOverrides: Partial<OpenAiCompatibleModelConfig> = {},
): StudioProviderDefinitionConfig {
  return {
    provider_config_id: 'provider-config-1',
    provider: 'openai-compatible',
    base_url: 'https://images.example.test/v1',
    region: null,
    capability_map: {
      definition_id: 'openai-compatible',
      capabilities: {
        'image.generate': {
          models: [{ ...model, ...modelOverrides }],
        },
      },
    },
    version_token: 'provider-version-1',
  };
}

function imageInput(overrides: Partial<StudioJobInput['image']> = {}): StudioJobInput {
  return {
    capability: 'image.generate',
    image: {
      prompt: 'A precise product photograph',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 2,
      ...overrides,
    },
  };
}

function pricing(overrides: Partial<StudioPricingSnapshot> = {}): StudioPricingSnapshot {
  return {
    pricing_catalog_id: 'pricing-image-v1',
    version: 1,
    provider: 'openai-compatible',
    model: 'image-model-v1',
    unit: 'image',
    rate_credits: 3,
    max_provider_credits: 10,
    markup_credits: 1,
    ...overrides,
  };
}

describe('OpenAI-compatible image definition', () => {
  test('owns immutable generic-profile execution semantics in adapter code', () => {
    expect(OPENAI_IMAGE_GENERIC_PROFILE).toEqual({
      id: 'openai-images-v1-generic',
      response: 'synchronous',
      submit_replay: false,
      reconciliation: false,
      upstream_cancellation: false,
      idempotency_header: null,
    });
    expect(Object.isFrozen(OPENAI_IMAGE_GENERIC_PROFILE)).toBe(true);
  });

  test('exposes only the configured image models through the fixed generic profile', () => {
    expect(openAiCompatibleImageDefinition.capabilities(providerConfig())).toEqual([
      {
        capability: 'image.generate',
        version: 1,
        display_name: 'Image generation',
        input_schema: 'StudioImageGenerateInput',
        output_asset_kinds: ['image'],
        supported_models: ['image-model-v1'],
        limits: { min_outputs: 1, max_outputs: 8, max_reference_images: 0 },
        async: true,
        cancellable: true,
        required_credential_type: 'secret',
        accepted_credential_types: ['secret', 'connector'],
      },
    ]);
  });

  test('rejects project configuration that adds fields or overrides adapter-owned semantics', () => {
    for (const forbidden of [
      'synchronous',
      'supports_submit_replay',
      'supports_reconciliation',
      'supports_cancellation',
      'idempotency_header',
    ]) {
      const capabilityMap = providerConfig().capability_map as Record<string, unknown>;
      expect(() =>
        parseOpenAiCompatibleCapabilityMap({ ...capabilityMap, [forbidden]: true }),
      ).toThrow('Invalid OpenAI-compatible capability map');
    }
  });

  test('rejects advanced fields that could smuggle request identity or credentials', () => {
    for (const reserved of [
      'authorization',
      'Authorization',
      'cookie',
      'idempotency_key',
      'idempotency_header',
      'Idempotency-Key',
      'submission_key',
      'correlation_id',
      'reference_asset_ids',
      'submit_replay',
      'supports_submit_replay',
      'reconciliation',
      'supports_reconciliation',
      'upstream_cancellation',
      'supports_cancellation',
      'synchronous',
      'dialect_profile_id',
    ]) {
      expect(() =>
        parseOpenAiCompatibleCapabilityMap(
          providerConfig({ allowed_advanced_fields: [reserved] }).capability_map,
        ),
      ).toThrow('Invalid OpenAI-compatible capability map');
    }
  });

  test('rejects execution-semantic overrides at capability and model levels', () => {
    const valid: StudioProviderCapabilityMap = parseOpenAiCompatibleCapabilityMap(
      providerConfig().capability_map,
    );
    const imageCapability = valid.capabilities['image.generate'];
    const validModel = imageCapability.models[0];
    if (!validModel) throw new Error('expected model fixture');

    expect(() =>
      parseOpenAiCompatibleCapabilityMap({
        ...valid,
        capabilities: {
          'image.generate': { ...imageCapability, supports_submit_replay: true },
        },
      }),
    ).toThrow('Invalid OpenAI-compatible capability map');
    expect(() =>
      parseOpenAiCompatibleCapabilityMap({
        ...valid,
        capabilities: {
          'image.generate': {
            models: [{ ...validModel, idempotency_header: 'Idempotency-Key' }],
          },
        },
      }),
    ).toThrow('Invalid OpenAI-compatible capability map');
  });

  test('accepts a supported model and rejects an absent model with a stable code', () => {
    expect(
      openAiCompatibleImageDefinition.validate(providerConfig(), 'image-model-v1', imageInput()),
    ).toEqual({ ok: true });
    expect(
      openAiCompatibleImageDefinition.validate(providerConfig(), 'not-allowed', imageInput()),
    ).toMatchObject({ ok: false, code: 'STUDIO_MODEL_UNSUPPORTED' });
  });

  test('rejects invalid prompt, aspect ratio, quality, count, and reference assets', () => {
    const invalidInputs = [
      imageInput({ prompt: '   ' }),
      imageInput({ prompt: 'x'.repeat(8001) }),
      imageInput({ aspect_ratio: '2:1' as never }),
      imageInput({ quality: 'ultra' as never }),
      imageInput({ output_count: 0 }),
      imageInput({ output_count: 1.5 }),
      imageInput({ output_count: 9 }),
      imageInput({ reference_asset_ids: ['11111111-1111-4111-8111-111111111111'] }),
    ];

    for (const input of invalidInputs) {
      expect(
        openAiCompatibleImageDefinition.validate(providerConfig(), 'image-model-v1', input),
      ).toMatchObject({ ok: false, code: 'STUDIO_VALIDATION_ERROR' });
    }
  });

  test('accepts every declared ratio, quality, and output-count boundary', () => {
    for (const aspectRatio of ['1:1', '4:3', '3:4', '16:9', '9:16'] as const) {
      for (const quality of ['standard', 'high'] as const) {
        for (const outputCount of [1, 8]) {
          expect(
            openAiCompatibleImageDefinition.validate(
              providerConfig(),
              'image-model-v1',
              imageInput({ aspect_ratio: aspectRatio, quality, output_count: outputCount }),
            ),
          ).toEqual({ ok: true });
        }
      }
    }
  });

  test('allows negative prompt, seed, and advanced values only through the model allowlist', () => {
    const input = imageInput({
      negative_prompt: 'blur',
      seed: 42,
      advanced: { style: 'photographic' },
    });

    expect(
      openAiCompatibleImageDefinition.validate(providerConfig(), 'image-model-v1', input),
    ).toMatchObject({ ok: false, code: 'STUDIO_VALIDATION_ERROR' });
    expect(
      openAiCompatibleImageDefinition.validate(
        providerConfig({ allowed_advanced_fields: ['negative_prompt', 'seed', 'style'] }),
        'image-model-v1',
        input,
      ),
    ).toEqual({ ok: true });
    expect(
      openAiCompatibleImageDefinition.validate(
        providerConfig({ allowed_advanced_fields: ['style'] }),
        'image-model-v1',
        imageInput({ advanced: { style: 'photo', undocumented: true } }),
      ),
    ).toMatchObject({ ok: false, code: 'STUDIO_VALIDATION_ERROR' });
  });

  test('estimates solely from the immutable matching pricing snapshot', () => {
    expect(
      openAiCompatibleImageDefinition.estimate(providerConfig(), pricing(), imageInput()),
    ).toEqual({
      provider_credits: 6,
      platform_credits: 2,
      max_credits: 12,
    });

    for (const mismatch of [
      pricing({ provider: 'different-provider' }),
      pricing({ model: 'different-model' }),
      pricing({ pricing_catalog_id: 'different-catalog' }),
    ]) {
      expect(() =>
        openAiCompatibleImageDefinition.estimate(providerConfig(), mismatch, imageInput()),
      ).toThrow('Studio pricing snapshot does not match provider configuration');
    }
    expect(() =>
      openAiCompatibleImageDefinition.estimate(
        providerConfig(),
        pricing({ max_provider_credits: 5 }),
        imageInput(),
      ),
    ).toThrow('Studio pricing maximum is lower than calculated provider cost');
    expect(() =>
      openAiCompatibleImageDefinition.estimate(
        providerConfig(),
        pricing({
          rate_credits: 0,
          max_provider_credits: Number.MAX_VALUE,
          markup_credits: Number.MAX_VALUE,
        }),
        imageInput({ output_count: 1 }),
      ),
    ).toThrow('Studio pricing snapshot does not match provider configuration');
  });
});
