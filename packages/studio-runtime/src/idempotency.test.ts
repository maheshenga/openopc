import { describe, expect, test } from 'bun:test';
import {
  assertMatchingIdempotencyHash,
  canonicalStudioRequestHash,
} from './idempotency';

describe('Studio idempotency', () => {
  test('hashes canonical request content independent of object key order', () => {
    const first = {
      capability: 'image.generate',
      model: 'openai-compatible/default-image',
      input: {
        image: {
          prompt: 'Studio desk',
          output_count: 1,
          quality: 'standard',
          aspect_ratio: '1:1',
          reference_asset_ids: [],
        },
        capability: 'image.generate',
      },
    };
    const reordered = {
      input: {
        capability: 'image.generate',
        image: {
          aspect_ratio: '1:1',
          quality: 'standard',
          reference_asset_ids: [],
          output_count: 1,
          prompt: 'Studio desk',
        },
      },
      model: 'openai-compatible/default-image',
      capability: 'image.generate',
    };

    const hash = canonicalStudioRequestHash(first);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalStudioRequestHash(reordered)).toBe(hash);
    expect(() => assertMatchingIdempotencyHash(hash, reordered)).not.toThrow();
    expect(() =>
      assertMatchingIdempotencyHash(hash, { ...first, model: 'other-model' }),
    ).toThrow('STUDIO_IDEMPOTENCY_MISMATCH');
  });
});
