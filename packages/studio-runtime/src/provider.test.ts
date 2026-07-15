import { describe, expect, test } from 'bun:test';
import {
  STUDIO_MAX_PROVIDER_ATTEMPTS,
  classifyProviderRetry,
  createFakeStudioProvider,
  parseRetryAfterMs,
} from './provider';

describe('Studio provider runtime', () => {
  test('restores output count from a persisted fake provider handle after restart', async () => {
    const ctx = { correlationId: 'restart-c1', submissionKey: 'restart-submission-c1' };
    const input = {
      capability: 'image.generate' as const,
      image: {
        prompt: 'Restart-safe studio desk',
        reference_asset_ids: [],
        aspect_ratio: '1:1' as const,
        quality: 'standard' as const,
        output_count: 2,
      },
    };
    const handle = await createFakeStudioProvider().submit(ctx, input);

    const restartedProvider = createFakeStudioProvider();
    const result = await restartedProvider.fetchResult(ctx, handle);

    expect(result.assets).toHaveLength(2);
  });

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
    const nearFuture = new Date(Date.now() + 3_000).toUTCString();
    const dateRetry = classifyProviderRetry({ status: 429, retryAfter: nearFuture });
    expect(dateRetry.retry_after_ms).toBeGreaterThanOrEqual(0);
    expect(dateRetry.retry_after_ms).toBeLessThanOrEqual(3_500);

    const provider = createFakeStudioProvider();
    const input = {
      capability: 'image.generate' as const,
      image: {
        prompt: 'Studio desk',
        reference_asset_ids: [],
        aspect_ratio: '1:1' as const,
        quality: 'standard' as const,
        output_count: 2,
      },
    };
    const ctx = { correlationId: 'c1', submissionKey: 'submission-c1' };
    const estimate = await provider.estimate(ctx, input);
    const handle = await provider.submit(ctx, input);
    const status = await provider.poll(ctx, handle);
    const result = await provider.fetchResult(ctx, handle);

    expect(provider.id).toBe('fake');
    expect(handle.submission_key).toBe('submission-c1');
    expect(estimate.max_credits).toBe(2);
    expect(status.status).toBe('succeeded');
    expect(result.assets).toHaveLength(2);
    expect(result.assets.map((asset) => asset.filename)).toEqual([
      'fake-studio-image-1.png',
      'fake-studio-image-2.png',
    ]);
    for (const asset of result.assets) {
      expect(asset.mime_type).toBe('image/png');
      expect(asset.bytes.byteLength).toBeGreaterThan(60);
      expect([...asset.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });
});
