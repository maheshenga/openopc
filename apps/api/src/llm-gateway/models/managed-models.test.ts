import { describe, expect, test } from 'bun:test';

import {
  RUNTIME_MANAGED_MODELS,
  getRuntimeManagedModel,
  isRuntimeManagedModelId,
  parseManagedModels,
} from './managed-models';

describe('runtime managed model registry', () => {
  test('exposes the configured control-plane overlay through one lookup', () => {
    expect(RUNTIME_MANAGED_MODELS.length).toBeGreaterThan(0);
    const first = RUNTIME_MANAGED_MODELS[0];
    if (!first) throw new Error('expected at least one runtime managed model');
    expect(getRuntimeManagedModel(first.id)).toBe(first);
    expect(isRuntimeManagedModelId(first.id)).toBe(true);
    expect(isRuntimeManagedModelId('not-managed')).toBe(false);
  });

  test('accepts a complete operator-defined managed-model replacement', () => {
    const configured = parseManagedModels(JSON.stringify([{
      id: 'operator-model',
      name: 'Operator Model',
      upstreamModelId: 'vendor/model-v2',
      transport: 'openrouter',
      pricingRef: 'vendor/model-v2',
      tier: 'balanced',
      vision: true,
      limit: { context: 64_000, output: 8_000 },
      openrouterProvider: { order: ['Vendor'] },
    }]));

    expect(configured).toEqual([expect.objectContaining({
      id: 'operator-model',
      upstreamModelId: 'vendor/model-v2',
      vision: true,
    })]);
  });

  test('accepts NewAPI as an operator-defined managed transport', () => {
    const configured = parseManagedModels(
      JSON.stringify([
        {
          id: 'shared-new-api-model',
          name: 'Shared NewAPI Model',
          upstreamModelId: 'vendor/model-v3',
          transport: 'new-api',
          pricingRef: 'vendor/model-v3',
          tier: 'balanced',
          vision: false,
          limit: { context: 128_000, output: 16_000 },
        },
      ]),
    );

    expect(configured).toEqual([
      expect.objectContaining({
        id: 'shared-new-api-model',
        transport: 'new-api',
        upstreamModelId: 'vendor/model-v3',
      }),
    ]);
  });

  test('rejects malformed and duplicate managed-model definitions', () => {
    expect(() => parseManagedModels('{broken')).toThrow('must be valid JSON');
    const duplicate = {
      id: 'same',
      name: 'Same',
      upstreamModelId: 'vendor/same',
      transport: 'openrouter',
      pricingRef: 'vendor/same',
      tier: 'fast',
      vision: false,
      limit: { context: 1, output: 1 },
    };
    expect(() => parseManagedModels(JSON.stringify([duplicate, duplicate]))).toThrow('duplicate');
  });
});
