import { describe, expect, test } from 'bun:test';
import type {
  StudioPricingSnapshot,
  StudioProviderDefinition,
  StudioProviderDefinitionConfig,
  StudioProviderSubmission,
} from './provider';
import type { StudioCredentialResolver, StudioResolvedCredential } from './index';
import {
  STUDIO_MAX_PROVIDER_ATTEMPTS,
  StudioProviderCallError,
  classifyProviderRetry,
  createFakeStudioProvider,
  parseRetryAfterMs,
} from './provider';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe('Studio provider runtime', () => {
  test('defines an invocation-scoped credential resolver port', async () => {
    const resolved: StudioResolvedCredential = {
      source: 'secret',
      value: 'invocation-only-value',
      version_token: 'secret-version-1',
    };
    const resolver: StudioCredentialResolver = {
      resolve: async (input) => {
        expect(input).toEqual({
          accountId: 'account-1',
          projectId: 'project-1',
          binding: { kind: 'secret', identifier: 'provider-key' },
        });
        return resolved;
      },
    };

    await expect(
      resolver.resolve({
        accountId: 'account-1',
        projectId: 'project-1',
        binding: { kind: 'secret', identifier: 'provider-key' },
      }),
    ).resolves.toEqual(resolved);
  });

  test('exposes provider definitions, both submission variants, and shared call errors', () => {
    const config: StudioProviderDefinitionConfig = {
      provider_config_id: 'provider-config-1',
      provider: 'openai-compatible',
      base_url: null,
      region: null,
      capability_map: {},
      version_token: 'version-1',
    };
    const pricing: StudioPricingSnapshot = {
      pricing_catalog_id: 'pricing-1',
      version: 1,
      provider: 'openai-compatible',
      model: 'image-model',
      unit: 'image',
      rate_credits: 1,
      max_provider_credits: 1,
      markup_credits: 0,
    };
    const definition: StudioProviderDefinition = {
      id: 'openai-compatible',
      capabilities: () => [],
      validate: () => ({ ok: true }),
      estimate: () => ({ max_credits: 1, provider_credits: 1, platform_credits: 0 }),
    };
    const completed: StudioProviderSubmission = {
      kind: 'completed',
      provider: 'openai-compatible',
      submission_key: 'submission-1',
      result: { assets: [], usage: {} },
    };
    const asynchronous: StudioProviderSubmission = {
      kind: 'async',
      handle: { provider: 'fake', id: 'provider-job-1', submission_key: 'submission-2' },
    };

    expect(definition.capabilities(config)).toEqual([]);
    expect(definition.estimate(config, pricing, {} as never).max_credits).toBe(1);
    expect(completed.kind).toBe('completed');
    expect(asynchronous.kind).toBe('async');
    expect(new StudioProviderCallError('unknown_outcome', 'ambiguous')).toMatchObject({
      classification: 'unknown_outcome',
    });
  });

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
    const submission = await createFakeStudioProvider().submit(ctx, input);
    expect(submission.kind).toBe('async');
    if (submission.kind !== 'async') throw new Error('fake provider must submit asynchronously');

    const restartedProvider = createFakeStudioProvider();
    const result = await restartedProvider.fetchResult(ctx, submission.handle);

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
    const submission = await provider.submit(ctx, input);
    expect(submission.kind).toBe('async');
    if (submission.kind !== 'async') throw new Error('fake provider must submit asynchronously');
    const status = await provider.poll(ctx, submission.handle);
    const result = await provider.fetchResult(ctx, submission.handle);

    expect(provider.id).toBe('fake');
    expect(provider).not.toHaveProperty('capabilities');
    expect(provider).not.toHaveProperty('validate');
    expect(provider).not.toHaveProperty('estimate');
    expect(submission.handle.submission_key).toBe('submission-c1');
    expect(status.status).toBe('succeeded');
    expect(result.assets).toHaveLength(2);
    expect(result.assets.map((asset) => asset.filename)).toEqual([
      'fake-studio-image-1.png',
      'fake-studio-image-2.png',
    ]);
    for (const asset of result.assets) {
      expect(asset.mime_type).toBe('image/png');
      expect(asset.replayable_within_attempt).toBe(true);
      const first = await readAll(await asset.openBody());
      const replay = await readAll(await asset.openBody());
      expect(asset.size_bytes).toBe(first.byteLength);
      expect(first.byteLength).toBeGreaterThan(60);
      expect([...first.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(replay).toEqual(first);
    }
  });
});
