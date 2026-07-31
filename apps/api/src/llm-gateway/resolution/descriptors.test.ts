import { describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  NEWAPI_BASE_URL: 'https://new-api.example.com/gateway/',
  NEWAPI_SERVICE_API_KEY: 'server-only-new-api-key',
  NEWAPI_API_COMPATIBILITY: 'openai-v1',
  INTERNAL_KORTIX_ENV: 'prod',
};

mock.module('../../config', () => ({ config: mockConfig }));
mock.module('../../billing/services/tiers', () => ({ llmPriceMarkup: () => 0 }));
mock.module('../../router/config/model-pricing', () => ({ getModelPricing: () => undefined }));

describe('gateway upstream capability descriptors', () => {
  test('declares only the verified Codex Responses capabilities', async () => {
    const { codexDescriptor } = await import('./descriptors');
    const descriptor = codexDescriptor(
      { access: 'private-access-token', accountId: 'account-1' },
      'codex/gpt-5.6-sol',
    );

    expect(descriptor.kind).toBe('openai-responses');
    expect(descriptor.capabilities).toEqual({
      transport: 'responses',
      streaming: true,
      imageInput: true,
      functionTools: true,
      reasoning: true,
      stateContinuation: false,
      background: false,
    });
    expect(JSON.stringify(descriptor.capabilities)).not.toContain('private-access-token');
    expect(JSON.stringify(descriptor.capabilities)).not.toMatch(/url|header|token|credential/i);
  });

  test('builds one OpenAI-compatible descriptor for an allowlisted NewAPI model', async () => {
    const { managedCandidates, newApiManagedDescriptor } = await import('./descriptors');
    const managed = {
      id: 'shared-new-api-model',
      name: 'Shared NewAPI Model',
      upstreamModelId: 'vendor/model-v3',
      transport: 'new-api',
      pricingRef: 'vendor/model-v3',
      tier: 'balanced',
      vision: false,
      limit: { context: 128_000, output: 16_000 },
    } as const;

    const descriptor = newApiManagedDescriptor(managed as never, mockConfig as never);
    if (!descriptor) throw new Error('expected configured NewAPI descriptor');
    expect(descriptor).toEqual({
      provider: 'new-api',
      kind: 'openai-compat',
      baseUrl: 'https://new-api.example.com/gateway/v1',
      apiKey: 'server-only-new-api-key',
      billingMode: 'credits',
      markup: 0,
      resolvedModel: 'vendor/model-v3',
      pricing: undefined,
    });
    expect(managedCandidates(managed as never, mockConfig as never)).toEqual([descriptor]);
  });
});
