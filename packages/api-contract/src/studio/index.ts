import { z } from 'zod';

export const STUDIO_JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const StudioJobStateSchema = z.enum(STUDIO_JOB_STATES);
export type StudioJobState = z.infer<typeof StudioJobStateSchema>;

export const STUDIO_CAPABILITIES = ['image.generate'] as const;
export const StudioCapabilitySchema = z.enum(STUDIO_CAPABILITIES);
export type StudioCapability = z.infer<typeof StudioCapabilitySchema>;

export const StudioCapabilityDescriptorSchema = z.object({
  capability: StudioCapabilitySchema,
  version: z.number().int().positive(),
  display_name: z.string().min(1),
  input_schema: z.string().min(1),
  output_asset_kinds: z.array(z.string().min(1)).readonly(),
  supported_models: z.array(z.string().min(1)).readonly(),
  limits: z.record(z.string(), z.unknown()),
  async: z.boolean(),
  cancellable: z.boolean(),
  required_credential_type: z.enum(['secret', 'connector', 'none']),
});
export type StudioCapabilityDescriptor = z.infer<typeof StudioCapabilityDescriptorSchema>;

export const StudioAspectRatioSchema = z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']);
export type StudioAspectRatio = z.infer<typeof StudioAspectRatioSchema>;

export const StudioImageQualitySchema = z.enum(['standard', 'high']);
export type StudioImageQuality = z.infer<typeof StudioImageQualitySchema>;

export const StudioImageGenerateInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8000),
    negative_prompt: z.string().trim().max(4000).optional(),
    reference_asset_ids: z.array(z.string().uuid()).max(8).default([]),
    aspect_ratio: StudioAspectRatioSchema,
    quality: StudioImageQualitySchema,
    output_count: z.number().int().min(1).max(8),
    seed: z.number().int().nonnegative().optional(),
    advanced: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type StudioImageGenerateInput = z.infer<typeof StudioImageGenerateInputSchema>;

export const StudioJobInputSchema = z.discriminatedUnion('capability', [
  z.object({
    capability: z.literal('image.generate'),
    image: StudioImageGenerateInputSchema,
  }),
]);
export type StudioJobInput = z.infer<typeof StudioJobInputSchema>;

export const StudioEstimateRequestSchema = z
  .object({
    capability: StudioCapabilitySchema,
    provider_config_id: z.string().uuid(),
    model: z.string().min(1),
    input: StudioJobInputSchema,
  })
  .strict();
export type StudioEstimateRequest = z.infer<typeof StudioEstimateRequestSchema>;

export const StudioEstimateResponseSchema = z
  .object({
    estimate_id: z.string().uuid(),
    estimate_token: z.string().min(16),
    expires_at: z.string(),
    currency: z.literal('credits'),
    provider_cost_credits: z.number().nonnegative(),
    platform_cost_credits: z.number().nonnegative(),
    max_approved_credits: z.number().positive(),
    input_hash: z.string().min(16),
    line_items: z.array(
      z.object({
        label: z.string().min(1),
        credits: z.number().nonnegative(),
      }),
    ),
  })
  .strict();
export type StudioEstimateResponse = z.infer<typeof StudioEstimateResponseSchema>;

export const StudioCreateJobRequestSchema = z
  .object({
    capability: StudioCapabilitySchema,
    provider_config_id: z.string().uuid(),
    model: z.string().min(1),
    input: StudioJobInputSchema,
    estimate_id: z.string().uuid(),
    estimate_token: z.string().min(16),
    idempotency_key: z.string().min(16).max(255),
    request_hash: z.string().min(16),
  })
  .strict();
export type StudioCreateJobRequest = z.infer<typeof StudioCreateJobRequestSchema>;

export const StudioErrorCodeSchema = z.enum([
  'STUDIO_VALIDATION_ERROR',
  'STUDIO_PERMISSION_DENIED',
  'STUDIO_INSUFFICIENT_CREDITS',
  'STUDIO_CREDENTIAL_MISSING',
  'STUDIO_CREDENTIAL_EXPIRED',
  'STUDIO_MODEL_UNSUPPORTED',
  'STUDIO_ESTIMATE_EXPIRED',
  'STUDIO_IDEMPOTENCY_MISMATCH',
  'STUDIO_PROVIDER_UNAVAILABLE',
  'STUDIO_PROVIDER_RATE_LIMITED',
  'STUDIO_PROVIDER_REJECTED',
  'STUDIO_PROVIDER_TIMEOUT',
  'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
  'STUDIO_ASSET_INVALID',
  'STUDIO_ASSET_TOO_LARGE',
  'STUDIO_UPLOAD_EXPIRED',
  'STUDIO_STORAGE_UNAVAILABLE',
  'STUDIO_JOB_CONFLICT',
  'STUDIO_JOB_NOT_CANCELLABLE',
  'STUDIO_WEBHOOK_SIGNATURE_INVALID',
  'STUDIO_WEBHOOK_REPLAYED',
  'STUDIO_EVENT_CURSOR_EXPIRED',
  'STUDIO_INTERNAL_ERROR',
]);
export type StudioErrorCode = z.infer<typeof StudioErrorCodeSchema>;

export const StudioJobSchema = z
  .object({
    job_id: z.string().uuid(),
    account_id: z.string().uuid(),
    project_id: z.string().uuid(),
    actor_user_id: z.string().uuid().nullable(),
    actor_type: z.enum(['user', 'agent', 'system']),
    capability: StudioCapabilitySchema,
    provider_config_id: z.string().uuid(),
    provider: z.string().min(1),
    model: z.string().min(1),
    input: StudioJobInputSchema,
    status: StudioJobStateSchema,
    idempotency_key: z.string(),
    request_hash: z.string(),
    attempt_count: z.number().int().nonnegative(),
    reserved_credits: z.number().nonnegative(),
    actual_credits: z.number().nonnegative().nullable(),
    error_code: StudioErrorCodeSchema.nullable(),
    error_message: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
  })
  .strict();
export type StudioJob = z.infer<typeof StudioJobSchema>;

export const StudioJobEventSchema = z
  .object({
    event_id: z.string().uuid(),
    job_id: z.string().uuid(),
    cursor: z.string().min(1),
    type: z.enum([
      'queued',
      'claimed',
      'provider-submitted',
      'progress',
      'asset-created',
      'succeeded',
      'failed',
      'cancelled',
      'retry-scheduled',
      'billing-settled',
    ]),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .strict();
export type StudioJobEvent = z.infer<typeof StudioJobEventSchema>;

export const StudioAssetSchema = z
  .object({
    asset_id: z.string().uuid(),
    account_id: z.string().uuid(),
    project_id: z.string().uuid(),
    source_job_id: z.string().uuid().nullable(),
    kind: z.enum(['image']),
    mime_type: z.string().min(1),
    bucket: z.string().min(1),
    object_key: z.string().min(1),
    checksum_sha256: z.string().min(32),
    size_bytes: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .strict();
export type StudioAsset = z.infer<typeof StudioAssetSchema>;

export const StudioUploadSchema = z
  .object({
    upload_id: z.string().uuid(),
    project_id: z.string().uuid(),
    asset_id: z.string().uuid().nullable(),
    object_key: z.string().min(1),
    declared_mime_type: z.string().min(1),
    expected_size_bytes: z.number().int().positive(),
    expected_checksum_sha256: z.string().min(32),
    signed_upload_url: z.string().url(),
    expires_at: z.string(),
    status: z.enum(['pending', 'finalized', 'expired']),
  })
  .strict();
export type StudioUpload = z.infer<typeof StudioUploadSchema>;

export const StudioProviderConfigSchema = z
  .object({
    provider_config_id: z.string().uuid(),
    project_id: z.string().uuid(),
    provider: z.enum(['fake', 'openai-compatible']),
    display_name: z.string().min(1),
    base_url: z.string().url().nullable(),
    region: z.string().nullable(),
    credential_binding: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('secret'), identifier: z.string().min(1) }),
      z.object({ kind: z.literal('connector'), slug: z.string().min(1) }),
      z.object({ kind: z.literal('none') }),
    ]),
    capabilities: z.array(StudioCapabilitySchema),
    enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type StudioProviderConfig = z.infer<typeof StudioProviderConfigSchema>;

export const StudioPaginatedResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item),
      next_cursor: z.string().nullable(),
    })
    .strict();

export const StudioJobListResponseSchema = StudioPaginatedResponseSchema(StudioJobSchema);
export type StudioJobListResponse = z.infer<typeof StudioJobListResponseSchema>;

export const StudioAssetListResponseSchema = StudioPaginatedResponseSchema(StudioAssetSchema);
export type StudioAssetListResponse = z.infer<typeof StudioAssetListResponseSchema>;

export const StudioProviderListResponseSchema = StudioPaginatedResponseSchema(
  StudioProviderConfigSchema,
);
export type StudioProviderListResponse = z.infer<typeof StudioProviderListResponseSchema>;

export const studioPhase1Capabilities = [
  {
    capability: 'image.generate',
    version: 1,
    display_name: 'Image generation',
    input_schema: 'StudioImageGenerateInput',
    output_asset_kinds: ['image'],
    supported_models: ['openai-compatible/default-image'],
    limits: {
      min_outputs: 1,
      max_outputs: 8,
      max_reference_images: 8,
    },
    async: true,
    cancellable: true,
    required_credential_type: 'secret',
  },
] as const satisfies readonly StudioCapabilityDescriptor[];
