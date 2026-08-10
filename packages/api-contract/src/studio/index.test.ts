import { describe, expect, test } from 'bun:test';
import {
  studioAssetFixture,
  studioCreateJobRequestFixture,
  studioCreatePricingCatalogRequestFixture,
  studioCreateProviderConfigRequestFixture,
  studioEstimateRequestFixture,
  studioEstimateResponseFixture,
  studioJobEventFixture,
  studioJobFixture,
  studioPricingCatalogEntryFixture,
  studioProviderConfigFixture,
  studioRecoveryRequestFixture,
  studioRecoveryResponseFixture,
  studioUpdateProviderConfigRequestFixture,
  studioUploadFixture,
} from './fixtures';
import {
  STUDIO_JOB_STATES,
  StudioAssetListResponseSchema,
  StudioAssetSchema,
  StudioCapabilityDescriptorSchema,
  StudioCreateJobRequestSchema,
  StudioCreatePricingCatalogRequestSchema,
  StudioCreateProviderConfigRequestSchema,
  StudioCredentialBindingSchema,
  StudioErrorCodeSchema,
  StudioEstimateRequestSchema,
  StudioEstimateResponseSchema,
  StudioJobEventSchema,
  StudioJobListResponseSchema,
  StudioJobSchema,
  StudioPricingCatalogEntrySchema,
  StudioProviderConfigSchema,
  StudioProviderListResponseSchema,
  StudioRecoveryRequestSchema,
  StudioRecoveryResponseSchema,
  StudioResolveBillingIncidentRequestSchema,
  StudioResolveBillingIncidentResponseSchema,
  StudioUpdateProviderConfigRequestSchema,
  StudioUploadSchema,
  studioPhase1Capabilities,
} from './index';
import type { StudioErrorCode } from './index';

const newStudioErrorCodes = [
  'STUDIO_PROVIDER_CONFIG_INVALID',
  'STUDIO_CREDENTIAL_UNAVAILABLE',
  'STUDIO_PROVIDER_CONFIG_STALE',
  'STUDIO_PRICING_STALE',
  'STUDIO_RECOVERY_CONFLICT',
  'STUDIO_BILLING_INCIDENT_REQUIRED',
  'STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED',
  'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED',
  'STUDIO_MODULE_SERVICE_GRANT_INVALID',
] as const satisfies readonly StudioErrorCode[];

const MODULE_SERVICE_GRANT_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

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
    expect(
      StudioEstimateResponseSchema.strict().parse({
        ...studioEstimateResponseFixture(),
        provider_cost_credits: 0,
        platform_cost_credits: 0,
        max_approved_credits: 0,
      }).max_approved_credits,
    ).toBe(0);
    expect(
      StudioEstimateResponseSchema.strict().safeParse({
        ...studioEstimateResponseFixture(),
        max_approved_credits: -0.0001,
      }).success,
    ).toBe(false);
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

  test('models a module service grant independently from an account token', () => {
    expect(
      StudioCreateJobRequestSchema.strict().parse({
        ...studioCreateJobRequestFixture(),
        module_service_grant_id: MODULE_SERVICE_GRANT_ID,
      }).module_service_grant_id,
    ).toBe(MODULE_SERVICE_GRANT_ID);

    expect(
      StudioJobSchema.strict().parse({
        ...studioJobFixture(),
        actor_type: 'module',
        module_service_grant_id: MODULE_SERVICE_GRANT_ID,
      }),
    ).toMatchObject({
      actor_type: 'module',
      module_service_grant_id: MODULE_SERVICE_GRANT_ID,
    });
  });

  test('rejects PostgreSQL timestamp text at the public contract boundary', () => {
    expect(
      StudioJobSchema.safeParse({
        ...studioJobFixture(),
        created_at: '2026-08-01 00:00:00+00',
      }).success,
    ).toBe(false);
  });

  test('requires browser-safe signed upload headers', () => {
    const upload = studioUploadFixture();
    const { signed_upload_headers: _headers, ...withoutHeaders } = upload;

    expect(
      StudioUploadSchema.strict().parse({
        ...upload,
        signed_upload_headers: {
          'content-type': 'image/png',
          'x-amz-checksum-sha256': 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=',
        },
      }).signed_upload_headers,
    ).toEqual({
      'content-type': 'image/png',
      'x-amz-checksum-sha256': 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=',
    });
    expect(StudioUploadSchema.safeParse(withoutHeaders).success).toBe(false);
  });

  test('rejects unsafe signed upload header names', () => {
    const unsafeNames = [
      'content-length',
      'authorization',
      'cookie',
      'host',
      'X-Amz-Checksum-Sha256',
      'bad header',
    ];

    for (const name of unsafeNames) {
      expect(
        StudioUploadSchema.safeParse({
          ...studioUploadFixture(),
          signed_upload_headers: { [name]: 'unsafe' },
        }).success,
      ).toBe(false);
    }
  });

  test('rejects signed upload header values containing CR or LF', () => {
    for (const value of ['safe\runsafe', 'safe\nunsafe', 'safe\r\nunsafe']) {
      expect(
        StudioUploadSchema.safeParse({
          ...studioUploadFixture(),
          signed_upload_headers: { 'content-type': value },
        }).success,
      ).toBe(false);
    }
  });

  test('rejects more than sixteen signed upload headers', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`x-studio-${index}`, 'value']),
    );

    expect(
      StudioUploadSchema.safeParse({
        ...studioUploadFixture(),
        signed_upload_headers: headers,
      }).success,
    ).toBe(false);
  });

  test('rejects signed upload header values longer than 2048 characters', () => {
    expect(
      StudioUploadSchema.safeParse({
        ...studioUploadFixture(),
        signed_upload_headers: { 'content-type': 'a'.repeat(2049) },
      }).success,
    ).toBe(false);
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

  test('parses strict pricing catalog entry and create contracts', () => {
    expect(
      StudioPricingCatalogEntrySchema.safeParse(studioPricingCatalogEntryFixture()).success,
    ).toBe(true);
    expect(
      StudioCreatePricingCatalogRequestSchema.safeParse(studioCreatePricingCatalogRequestFixture())
        .success,
    ).toBe(true);
    expect(
      StudioCreatePricingCatalogRequestSchema.safeParse({
        ...studioCreatePricingCatalogRequestFixture(),
        account_id: '99999999-8888-4777-8666-555555555555',
      }).success,
    ).toBe(false);
    expect(
      StudioPricingCatalogEntrySchema.safeParse({
        ...studioPricingCatalogEntryFixture(),
        provider_usage: { output_count: 2 },
      }).success,
    ).toBe(false);
  });

  test('parses strict provider create and non-empty PATCH contracts', () => {
    expect(
      StudioCreateProviderConfigRequestSchema.safeParse(studioCreateProviderConfigRequestFixture())
        .success,
    ).toBe(true);
    expect(
      StudioUpdateProviderConfigRequestSchema.safeParse(studioUpdateProviderConfigRequestFixture())
        .success,
    ).toBe(true);
    expect(StudioUpdateProviderConfigRequestSchema.safeParse({}).success).toBe(false);
    expect(
      StudioCreateProviderConfigRequestSchema.safeParse({
        ...studioCreateProviderConfigRequestFixture(),
        credential: 'must-not-cross-the-wire',
      }).success,
    ).toBe(false);
    expect(StudioUpdateProviderConfigRequestSchema.safeParse({ provider: 'fake' }).success).toBe(
      false,
    );
    expect(
      StudioUpdateProviderConfigRequestSchema.safeParse({
        rate_data: { rate_credits: 1 },
      }).success,
    ).toBe(false);
  });

  test('parses exact recovery contracts and rejects client-supplied server state', () => {
    expect(StudioRecoveryRequestSchema.safeParse(studioRecoveryRequestFixture()).success).toBe(
      true,
    );
    expect(StudioRecoveryResponseSchema.safeParse(studioRecoveryResponseFixture()).success).toBe(
      true,
    );
    expect(
      StudioRecoveryRequestSchema.safeParse({
        ...studioRecoveryRequestFixture(),
        result_assets: [],
      }).success,
    ).toBe(false);
    expect(
      StudioRecoveryRequestSchema.safeParse({
        ...studioRecoveryRequestFixture(),
        evidence: {
          ...studioRecoveryRequestFixture().evidence,
          signed_s3_url: 'https://storage.kortix.test/signed-result',
        },
      }).success,
    ).toBe(false);
    expect(
      StudioRecoveryRequestSchema.safeParse({
        ...studioRecoveryRequestFixture(),
        evidence: {
          ...studioRecoveryRequestFixture().evidence,
          staging_manifest_checksum: 'ABC123',
        },
      }).success,
    ).toBe(false);
    expect(
      StudioRecoveryResponseSchema.safeParse({
        ...studioRecoveryResponseFixture(),
        replayed: true,
      }).success,
    ).toBe(false);
  });

  test('accepts bounded billing incident evidence without caller-supplied credits or actors', () => {
    const request = {
      decision: 'record_platform_liability',
      idempotency_key: 'incident-resolution-key-0001',
      reason: 'Provider evidence confirms that the request was created.',
      evidence_reference: 'evidence:provider-case-0001',
    };

    expect(StudioResolveBillingIncidentRequestSchema.safeParse(request).success).toBe(true);
    expect(
      StudioResolveBillingIncidentRequestSchema.safeParse({
        ...request,
        provider_credits: 99,
      }).success,
    ).toBe(false);
    expect(
      StudioResolveBillingIncidentRequestSchema.safeParse({
        ...request,
        actor_user_id: '20000000-0000-4000-a000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      StudioResolveBillingIncidentRequestSchema.safeParse({
        ...request,
        evidence_reference: 'https://provider.example/case?id=0001&signature=secret',
      }).success,
    ).toBe(false);
  });

  test('returns only the bounded billing incident resolution audit summary', () => {
    const response = {
      incident_id: '12000000-0000-4000-a000-000000000001',
      account_id: '10000000-0000-4000-a000-000000000001',
      project_id: '11000000-0000-4000-a000-000000000001',
      job_id: '13000000-0000-4000-a000-000000000001',
      attempt_id: '14000000-0000-4000-a000-000000000001',
      status: 'resolved',
      decision: 'confirm_not_created',
      evidence_reference: 'evidence:provider-case-0002',
      verified_cost_credits: 2,
      potential_liability_credits: 6,
      provider_liability_credits: 0,
      resolved_at: '2026-07-24T00:00:00.000Z',
      resolved_by_user_id: '20000000-0000-4000-a000-000000000001',
    };

    expect(StudioResolveBillingIncidentResponseSchema.safeParse(response).success).toBe(true);
    expect(
      StudioResolveBillingIncidentResponseSchema.safeParse({
        ...response,
        idempotency_key: 'must-not-cross-the-wire',
      }).success,
    ).toBe(false);
  });

  test('accepts every production provider, pricing, recovery, and billing error code', () => {
    for (const code of newStudioErrorCodes) {
      expect(StudioErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
