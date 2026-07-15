import { describe, expect, test } from 'bun:test';
import {
  STUDIO_MAX_PROVIDER_ATTEMPTS,
  classifyProviderRetry,
  createFakeStudioProvider,
  parseRetryAfterMs,
} from './provider';

describe('Studio provider runtime', () => {
  test('classifies retries, bounds attempts, parses Retry-After, and returns deterministic fake results', async () => {
    expect(STUDIO_MAX_PROVIDER_ATTEMPTS).toBe(3);
    expect(parseRetryAfterMs('2', new Date('2026-07-15T08:00:00.000Z'))).toBe(2000);
    expect(
      parseRetryAfterMs('Wed, 15 Jul 2026 08:00:05 GMT', new Date('2026-07-15T08:00:00.000Z')),
    ).toBe(5000);
    expect(classifyProviderRetry({ status: 429, retryAfter: '1' })).toEqual({
      classification: 'rate_limited',
      retryable: true,
      retry_after_ms: 1000,
    });
    expect(classifyProviderRetry({ status: 408 })).toMatchObject({
      classification: 'retryable',
      retryable: true,
    });
    expect(classifyProviderRetry({ outcomeUnknown: true })).toMatchObject({
      classification: 'unknown_outcome',
      retryable: false,
    });
    expect(classifyProviderRetry({ status: 400 })).toMatchObject({
      classification: 'terminal',
      retryable: false,
    });

    const provider = createFakeStudioProvider();
    const input = {
      capability: 'image.generate' as const,
      image: {
        prompt: 'Studio desk',
        reference_asset_ids: [],
        aspect_ratio: '1:1' as const,
        quality: 'standard' as const,
        output_count: 1,
      },
    };
    const estimate = await provider.estimate({ correlationId: 'c1' }, input);
    const handle = await provider.submit({ correlationId: 'c1' }, input);
    const status = await provider.poll({ correlationId: 'c1' }, handle);
    const result = await provider.fetchResult({ correlationId: 'c1' }, handle);

    expect(provider.id).toBe('fake');
    expect(estimate.max_credits).toBe(1);
    expect(status.status).toBe('succeeded');
    expect(result.assets).toEqual([
      {
        kind: 'image',
        mime_type: 'image/png',
        bytes: new Uint8Array([137, 80, 78, 71]),
        filename: 'fake-studio-image.png',
      },
    ]);
  });
});
