import { describe, expect, test } from 'bun:test';

import {
  OPENOPC_CHAT_MAX_IMAGE_PARTS,
  OpenOpcChatCompletionRequestSchema,
  OpenOpcImageAssetListInputSchema,
  OpenOpcImageAssetPageSchema,
  OpenOpcImageAssetThumbnailSchema,
  OpenOpcImageEstimateSchema,
  OpenOpcImageEventFailureModeSchema,
  OpenOpcImageJobEventSchema,
  OpenOpcImageJobListInputSchema,
  OpenOpcImageJobPageSchema,
  OpenOpcImageModelSchema,
  OpenOpcImagePageInputSchema,
  OpenOpcModelSchema,
  openOpcImageEstimateRetryGuidance,
  openOpcModelSupportsImagePurpose,
} from './openopc-ai';

const imageUrl = `data:image/png;base64,${'A'.repeat(136)}`;
const imageCapability = {
  max_images: 4,
  max_bytes_per_image: 10 * 1024 * 1024,
  max_total_bytes: 20 * 1024 * 1024,
  accepted_mime_types: ['image/png', 'image/jpeg'] as const,
  purposes: ['vision'] as const,
};

const imageModel = {
  id: 'vision-model',
  object: 'model' as const,
  owned_by: 'openopc',
  name: 'Vision model',
  capabilities: {
    modalities: ['text', 'image'] as const,
    vision: imageCapability,
  },
};

const imageJobInput = {
  prompt: 'a red kite',
  aspect_ratio: '1:1' as const,
  quality: 'standard' as const,
  output_count: 1,
};

describe('OpenOPC AI wire contracts', () => {
  test('accepts bounded multimodal messages and exposes a conservative capability helper', () => {
    const parsed = OpenOpcChatCompletionRequestSchema.parse({
      model: 'vision-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this image' },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
          ],
        },
      ],
    });
    expect(Array.isArray(parsed.messages[0]?.content)).toBe(true);
    expect(openOpcModelSupportsImagePurpose(imageModel, 'vision')).toBe(true);
    expect(
      openOpcModelSupportsImagePurpose({ capabilities: { modalities: ['text'] } }, 'vision'),
    ).toBe(false);
  });

  test('rejects unsafe URLs, non-user image messages, and image count overflow', () => {
    expect(
      OpenOpcChatCompletionRequestSchema.safeParse({
        model: 'vision-model',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/a.png' } }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      OpenOpcChatCompletionRequestSchema.safeParse({
        model: 'vision-model',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'image_url', image_url: { url: 'https://images.example/a.png' } }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      OpenOpcChatCompletionRequestSchema.safeParse({
        model: 'vision-model',
        messages: [
          {
            role: 'user',
            content: Array.from({ length: OPENOPC_CHAT_MAX_IMAGE_PARTS + 1 }, () => ({
              type: 'image_url',
              image_url: { url: 'https://images.example/a.png' },
            })),
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('requires complete image-model limits instead of accepting a coarse boolean', () => {
    expect(
      OpenOpcImageModelSchema.safeParse({
        id: 'image-v1',
        object: 'image.model',
        owned_by: 'openopc',
        name: 'Image v1',
        capabilities: {
          prompt: { max_characters: 8000, max_negative_prompt_characters: 4000 },
          reference_images: {
            max_images: 4,
            max_bytes_per_image: 20 * 1024 * 1024,
            max_total_bytes: 50 * 1024 * 1024,
            accepted_mime_types: ['image/png'],
          },
          output: {
            min_images: 1,
            max_images: 4,
            max_bytes_per_image: 50 * 1024 * 1024,
            accepted_mime_types: ['image/png'],
            aspect_ratios: ['1:1'],
            qualities: ['standard'],
          },
        },
      }).success,
    ).toBe(true);
    expect(
      OpenOpcModelSchema.safeParse({
        id: 'text-only',
        object: 'model',
        owned_by: 'openopc',
        attachment: true,
      }).success,
    ).toBe(true);
    expect(
      OpenOpcModelSchema.safeParse({
        ...imageModel,
        capabilities: { modalities: ['text', 'image'] },
      }).success,
    ).toBe(false);
  });

  test('carries estimate expiry, quota, and settlement semantics', () => {
    const estimate = {
      estimate_id: '10000000-0000-4000-8000-000000000001',
      estimate_token: 'estimate-token-000000000001',
      expires_at: '2026-08-07T00:05:00.000Z',
      valid_for_ms: 300_000,
      retry: { on_expired: 'create-new-estimate' as const, automatic_job_retry: false as const },
      currency: 'credits' as const,
      max_approved_credits: 3,
      quota: {
        required_credits: 3,
        available_credits: 20,
        remaining_after_estimate_credits: 17,
      },
      settlement: {
        succeeded: 'settle-actual-usage' as const,
        failed: 'release-reservation' as const,
        cancelled: 'release-reservation' as const,
        maximum_charge_credits: 3,
      },
      input_hash: `sha256:${'a'.repeat(64)}`,
      line_items: [{ label: 'image generation', credits: 3 }],
    };
    expect(OpenOpcImageEstimateSchema.parse(estimate).retry.automatic_job_retry).toBe(false);
    expect(openOpcImageEstimateRetryGuidance('OPENOPC_IMAGE_ESTIMATE_EXPIRED')).toEqual({
      action: 'create-new-estimate',
      can_reestimate: true,
      retry_same_estimate: false,
    });
    expect(openOpcImageEstimateRetryGuidance('OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED')).toEqual({
      action: 'reconcile-before-retry',
      can_reestimate: false,
      retry_same_estimate: false,
    });
    expect(openOpcImageEstimateRetryGuidance('unknown')).toEqual({
      action: 'do-not-retry',
      can_reestimate: false,
      retry_same_estimate: false,
    });
  });

  test('normalizes terminal event semantics and asset source/retention metadata', () => {
    expect(OpenOpcImageJobPageSchema.parse({ items: [], next_cursor: null })).toEqual({
      items: [],
      next_cursor: null,
    });
    expect(
      OpenOpcImageJobEventSchema.parse({
        event_id: '20000000-0000-4000-8000-000000000001',
        job_id: '30000000-0000-4000-8000-000000000001',
        cursor: '12',
        type: 'retry-scheduled',
        retry_after_ms: 5000,
        created_at: '2026-08-07T00:00:00.000Z',
      }).retry_after_ms,
    ).toBe(5000);
    expect(
      OpenOpcImageAssetPageSchema.safeParse({
        items: [
          {
            asset_id: '40000000-0000-4000-8000-000000000001',
            source: {
              job_id: '30000000-0000-4000-8000-000000000001',
              prompt: 'a red kite',
            },
            kind: 'image',
            mime_type: 'image/png',
            checksum_sha256: 'a'.repeat(64),
            size_bytes: 10,
            width: 1,
            height: 1,
            metadata: {},
            retention: { policy: 'temporary', expires_at: null, deletable: true },
            created_at: '2026-08-07T00:00:00.000Z',
          },
        ],
        next_cursor: null,
      }).success,
    ).toBe(true);
    expect(OpenOpcImageEventFailureModeSchema.parse('fallback-to-polling')).toBe(
      'fallback-to-polling',
    );
    expect(OpenOpcImagePageInputSchema.parse({ cursor: null, limit: 100 })).toEqual({
      cursor: null,
      limit: 100,
    });
    expect(
      OpenOpcImageJobListInputSchema.parse({
        status: 'running',
        created_after: '2026-08-07T00:00:00.000Z',
        created_before: '2026-08-08T00:00:00.000Z',
      }),
    ).toMatchObject({ status: 'running' });
    expect(
      OpenOpcImageJobListInputSchema.safeParse({
        created_after: '2026-08-08T00:00:00.000Z',
        created_before: '2026-08-07T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      OpenOpcImageAssetListInputSchema.parse({
        cursor: null,
        limit: 20,
        source: 'generated',
        source_job_id: '30000000-0000-4000-8000-000000000001',
        created_after: '2026-08-07T00:00:00.000Z',
        created_before: '2026-08-08T00:00:00.000Z',
      }),
    ).toMatchObject({ source: 'generated' });
    expect(OpenOpcImageAssetListInputSchema.parse({ source: 'uploaded' })).toEqual({
      source: 'uploaded',
    });
    expect(
      OpenOpcImageAssetListInputSchema.safeParse({
        source: 'uploaded',
        source_job_id: '30000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      OpenOpcImageAssetThumbnailSchema.safeParse({
        asset_id: '40000000-0000-4000-8000-000000000001',
        preset: 'small',
        url: 'https://cdn.example.test/thumb.webp?sig=redacted',
        mime_type: 'image/webp',
        width: 256,
        height: 128,
        size_bytes: 1024,
        cache: { visibility: 'private', max_age_seconds: 900, immutable: true },
        expires_at: '2026-08-07T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
