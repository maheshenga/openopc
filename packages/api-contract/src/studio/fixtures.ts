import type {
  StudioAsset,
  StudioCreateJobRequest,
  StudioEstimateRequest,
  StudioEstimateResponse,
  StudioJob,
  StudioJobEvent,
  StudioProviderConfig,
  StudioUpload,
} from './index';

export const STUDIO_FIXTURE_NOW = '2026-07-15T08:00:00.000Z';
export const STUDIO_FIXTURE_PROJECT_ID = '11111111-2222-4333-8444-555555555555';
export const STUDIO_FIXTURE_ACCOUNT_ID = '99999999-8888-4777-8666-555555555555';
export const STUDIO_FIXTURE_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const STUDIO_FIXTURE_JOB_ID = '22222222-3333-4444-8555-666666666666';
export const STUDIO_FIXTURE_PROVIDER_CONFIG_ID = '33333333-4444-4555-8666-777777777777';
export const STUDIO_FIXTURE_ESTIMATE_ID = '44444444-5555-4666-8777-888888888888';
export const STUDIO_FIXTURE_ASSET_ID = '55555555-6666-4777-8888-999999999999';
export const STUDIO_FIXTURE_UPLOAD_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
export const STUDIO_FIXTURE_EVENT_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

export function studioImageInputFixture() {
  return {
    capability: 'image.generate' as const,
    image: {
      prompt: 'A quiet product photo of a modular AI workstation',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 2,
      advanced: { style: 'neutral-studio' },
    },
  };
}

export function studioEstimateRequestFixture(
  overrides: Partial<StudioEstimateRequest> = {},
): StudioEstimateRequest {
  return {
    capability: 'image.generate',
    provider_config_id: STUDIO_FIXTURE_PROVIDER_CONFIG_ID,
    model: 'openai-compatible/default-image',
    input: studioImageInputFixture(),
    ...overrides,
  };
}

export function studioEstimateResponseFixture(
  overrides: Partial<StudioEstimateResponse> = {},
): StudioEstimateResponse {
  return {
    estimate_id: STUDIO_FIXTURE_ESTIMATE_ID,
    estimate_token: 'estimate_token_1234567890',
    expires_at: STUDIO_FIXTURE_NOW,
    currency: 'credits',
    provider_cost_credits: 2,
    platform_cost_credits: 3,
    max_approved_credits: 5,
    input_hash: 'sha256:studio-image-request',
    line_items: [
      { label: 'Provider image generation', credits: 2 },
      { label: 'Studio platform fee', credits: 3 },
    ],
    ...overrides,
  };
}

export function studioCreateJobRequestFixture(
  overrides: Partial<StudioCreateJobRequest> = {},
): StudioCreateJobRequest {
  return {
    capability: 'image.generate',
    provider_config_id: STUDIO_FIXTURE_PROVIDER_CONFIG_ID,
    model: 'openai-compatible/default-image',
    input: studioImageInputFixture(),
    estimate_id: STUDIO_FIXTURE_ESTIMATE_ID,
    estimate_token: 'estimate_token_1234567890',
    idempotency_key: 'studio-job-idempotency-key',
    request_hash: 'sha256:studio-image-request',
    ...overrides,
  };
}

export function studioJobFixture(overrides: Partial<StudioJob> = {}): StudioJob {
  return {
    job_id: STUDIO_FIXTURE_JOB_ID,
    account_id: STUDIO_FIXTURE_ACCOUNT_ID,
    project_id: STUDIO_FIXTURE_PROJECT_ID,
    actor_user_id: STUDIO_FIXTURE_USER_ID,
    actor_type: 'user',
    capability: 'image.generate',
    provider_config_id: STUDIO_FIXTURE_PROVIDER_CONFIG_ID,
    provider: 'openai-compatible',
    model: 'openai-compatible/default-image',
    input: studioImageInputFixture(),
    status: 'queued',
    idempotency_key: 'studio-job-idempotency-key',
    request_hash: 'sha256:studio-image-request',
    attempt_count: 0,
    reserved_credits: 5,
    actual_credits: null,
    error_code: null,
    error_message: null,
    created_at: STUDIO_FIXTURE_NOW,
    updated_at: STUDIO_FIXTURE_NOW,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

export function studioJobEventFixture(
  overrides: Partial<StudioJobEvent> = {},
): StudioJobEvent {
  return {
    event_id: STUDIO_FIXTURE_EVENT_ID,
    job_id: STUDIO_FIXTURE_JOB_ID,
    cursor: '0000000000000001',
    type: 'queued',
    payload: { status: 'queued' },
    created_at: STUDIO_FIXTURE_NOW,
    ...overrides,
  };
}

export function studioAssetFixture(overrides: Partial<StudioAsset> = {}): StudioAsset {
  return {
    asset_id: STUDIO_FIXTURE_ASSET_ID,
    account_id: STUDIO_FIXTURE_ACCOUNT_ID,
    project_id: STUDIO_FIXTURE_PROJECT_ID,
    source_job_id: STUDIO_FIXTURE_JOB_ID,
    kind: 'image',
    mime_type: 'image/png',
    bucket: 'studio-assets',
    object_key: 'projects/11111111-2222-4333-8444-555555555555/assets/output.png',
    checksum_sha256: 'a'.repeat(64),
    size_bytes: 1024,
    width: 1024,
    height: 1024,
    metadata: { prompt: 'A quiet product photo of a modular AI workstation' },
    created_at: STUDIO_FIXTURE_NOW,
    ...overrides,
  };
}

export function studioUploadFixture(overrides: Partial<StudioUpload> = {}): StudioUpload {
  return {
    upload_id: STUDIO_FIXTURE_UPLOAD_ID,
    project_id: STUDIO_FIXTURE_PROJECT_ID,
    asset_id: null,
    object_key: 'projects/11111111-2222-4333-8444-555555555555/uploads/reference.png',
    declared_mime_type: 'image/png',
    expected_size_bytes: 2048,
    expected_checksum_sha256: 'b'.repeat(64),
    signed_upload_url: 'https://storage.kortix.test/signed-upload/reference.png',
    expires_at: STUDIO_FIXTURE_NOW,
    status: 'pending',
    ...overrides,
  };
}

export function studioProviderConfigFixture(
  overrides: Partial<StudioProviderConfig> = {},
): StudioProviderConfig {
  return {
    provider_config_id: STUDIO_FIXTURE_PROVIDER_CONFIG_ID,
    project_id: STUDIO_FIXTURE_PROJECT_ID,
    provider: 'openai-compatible',
    display_name: 'OpenAI-compatible image provider',
    base_url: 'https://api.openai-compatible.test/v1',
    region: null,
    credential_binding: { kind: 'secret', identifier: 'openai-compatible-primary' },
    capabilities: ['image.generate'],
    enabled: true,
    created_at: STUDIO_FIXTURE_NOW,
    updated_at: STUDIO_FIXTURE_NOW,
    ...overrides,
  };
}
