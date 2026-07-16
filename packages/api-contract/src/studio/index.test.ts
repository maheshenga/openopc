import { describe, expect, test } from 'bun:test';
import {
  studioAssetFixture,
  studioCreateJobRequestFixture,
  studioEstimateRequestFixture,
  studioEstimateResponseFixture,
  studioJobEventFixture,
  studioJobFixture,
  studioProviderConfigFixture,
  studioUploadFixture,
} from './fixtures';
import {
  STUDIO_JOB_STATES,
  StudioAssetListResponseSchema,
  StudioAssetSchema,
  StudioCapabilityDescriptorSchema,
  StudioCreateJobRequestSchema,
  StudioCredentialBindingSchema,
  StudioErrorCodeSchema,
  StudioEstimateRequestSchema,
  StudioEstimateResponseSchema,
  StudioJobEventSchema,
  StudioJobListResponseSchema,
  StudioJobSchema,
  StudioProviderConfigSchema,
  StudioProviderListResponseSchema,
  StudioUploadSchema,
  studioPhase1Capabilities,
} from './index';

describe('studio phase 1 contracts', () => {
  test('advertises only executable image generation and the five public job states', () => {
    expect(STUDIO_JOB_STATES).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

    expect(studioPhase1Capabilities).toHaveLength(1);
    expect(studioPhase1Capabilities[0]?.capability).toBe('image.generate');
    expect(studioPhase1Capabilities[0]?.accepted_credential_types).toEqual(['secret', 'connector']);
    expect(() =>
      StudioCapabilityDescriptorSchema.strict().parse(studioPhase1Capabilities[0]),
    ).not.toThrow();
    expect(
      StudioCapabilityDescriptorSchema.strict().safeParse({
        ...studioPhase1Capabilities[0],
        accepted_credential_types: [],
      }).success,
    ).toBe(false);
    expect(
      StudioCapabilityDescriptorSchema.strict().safeParse({
        ...studioPhase1Capabilities[0],
        accepted_credential_types: ['none', 'secret'],
      }).success,
    ).toBe(false);
  });

  test('parses the phase 1 estimate, job, event, asset, upload, provider, and error contracts', () => {
    expect(() =>
      StudioEstimateRequestSchema.strict().parse(studioEstimateRequestFixture()),
    ).not.toThrow();
    expect(() =>
      StudioEstimateResponseSchema.strict().parse(studioEstimateResponseFixture()),
    ).not.toThrow();
    expect(() =>
      StudioCreateJobRequestSchema.strict().parse(studioCreateJobRequestFixture()),
    ).not.toThrow();
    expect(() => StudioJobSchema.strict().parse(studioJobFixture())).not.toThrow();
    expect(() => StudioJobEventSchema.strict().parse(studioJobEventFixture())).not.toThrow();
    expect(() => StudioAssetSchema.strict().parse(studioAssetFixture())).not.toThrow();
    expect(() => StudioUploadSchema.strict().parse(studioUploadFixture())).not.toThrow();
    expect(() =>
      StudioProviderConfigSchema.strict().parse(studioProviderConfigFixture()),
    ).not.toThrow();
    expect(StudioErrorCodeSchema.safeParse('STUDIO_IDEMPOTENCY_MISMATCH').success).toBe(true);
    expect(StudioErrorCodeSchema.safeParse('STUDIO_VIDEO_NOT_IN_PHASE_1').success).toBe(false);
  });

  test('keeps list envelopes typed and rejects future media capabilities in phase 1', () => {
    expect(
      StudioJobListResponseSchema.parse({
        items: [studioJobFixture()],
        next_cursor: null,
      }).items[0]?.status,
    ).toBe('queued');
    expect(
      StudioAssetListResponseSchema.parse({
        items: [studioAssetFixture()],
        next_cursor: 'cursor-2',
      }).next_cursor,
    ).toBe('cursor-2');
    expect(
      StudioProviderListResponseSchema.parse({
        items: [studioProviderConfigFixture()],
        next_cursor: null,
      }).items[0]?.capabilities,
    ).toEqual(['image.generate']);
    expect(
      StudioCreateJobRequestSchema.safeParse(
        studioCreateJobRequestFixture({ capability: 'video.generate' as never }),
      ).success,
    ).toBe(false);
    expect(
      StudioProviderConfigSchema.safeParse(
        studioProviderConfigFixture({
          capabilities: ['image.generate', 'voice.dialogue'] as never,
        }),
      ).success,
    ).toBe(false);
  });

  test('validates reusable provider credential bindings', () => {
    expect(
      StudioCredentialBindingSchema.safeParse({ kind: 'secret', identifier: '   ' }).success,
    ).toBe(false);
    expect(StudioCredentialBindingSchema.safeParse({ kind: 'connector', slug: '\t' }).success).toBe(
      false,
    );
    expect(StudioCredentialBindingSchema.safeParse({ kind: 'none' }).success).toBe(true);
  });
});
