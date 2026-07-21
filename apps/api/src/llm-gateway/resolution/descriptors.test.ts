import { describe, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({ config: {} }));
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
});
