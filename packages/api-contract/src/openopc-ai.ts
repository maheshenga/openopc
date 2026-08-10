import { z } from 'zod';

export const OPENOPC_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const OPENOPC_CHAT_MAX_IMAGE_PARTS = 8;
export const OPENOPC_CHAT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const OPENOPC_CHAT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const OPENOPC_IMAGE_ASSET_MAX_BYTES = 50 * 1024 * 1024;

const MAX_CHAT_IMAGE_URL_LENGTH = 14_000_000;
const PRIVATE_HOSTNAME = /^(?:localhost|.+\.localhost|.+\.local|.+\.internal)$/i;
const PRIVATE_IPV4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export const OpenOpcImageMimeTypeSchema = z.enum(OPENOPC_IMAGE_MIME_TYPES);
export type OpenOpcImageMimeType = z.infer<typeof OpenOpcImageMimeTypeSchema>;

function uniqueValues<T extends z.ZodTypeAny>(schema: T, maximum: number) {
  return z
    .array(schema)
    .min(1)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'values must be unique' });
      }
    })
    .readonly();
}

function dataImage(value: string): { mimeType: OpenOpcImageMimeType; sizeBytes: number } | null {
  const separator = value.indexOf(',');
  if (separator < 0) return null;
  const header = value.slice(0, separator);
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(header);
  if (!match || !OPENOPC_IMAGE_MIME_TYPES.includes(match[1] as OpenOpcImageMimeType)) return null;
  const payload = value.slice(separator + 1);
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
  ) {
    return null;
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return {
    mimeType: match[1] as OpenOpcImageMimeType,
    sizeBytes: (payload.length / 4) * 3 - padding,
  };
}

function validRemoteImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      PRIVATE_HOSTNAME.test(url.hostname) ||
      PRIVATE_IPV4.test(url.hostname) ||
      url.hostname === '[::1]'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const OpenOpcChatTextContentPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(1_000_000),
  })
  .strict();
export type OpenOpcChatTextContentPart = z.infer<typeof OpenOpcChatTextContentPartSchema>;

export const OpenOpcChatImageUrlContentPartSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z.string().min(1).max(MAX_CHAT_IMAGE_URL_LENGTH),
        detail: z.enum(['auto', 'low', 'high']).optional(),
        mime_type: OpenOpcImageMimeTypeSchema.optional(),
        size_bytes: z.number().int().positive().max(OPENOPC_CHAT_MAX_IMAGE_BYTES).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((part, context) => {
    const embedded = dataImage(part.image_url.url);
    if (!embedded && !validRemoteImageUrl(part.image_url.url)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'image URL is invalid' });
      return;
    }
    if (!embedded) return;
    if (embedded.sizeBytes > OPENOPC_CHAT_MAX_IMAGE_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'image is too large' });
    }
    if (part.image_url.mime_type && part.image_url.mime_type !== embedded.mimeType) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'image MIME type does not match' });
    }
    if (part.image_url.size_bytes && part.image_url.size_bytes !== embedded.sizeBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'image size does not match' });
    }
  });
export type OpenOpcChatImageUrlContentPart = z.infer<typeof OpenOpcChatImageUrlContentPartSchema>;

export const OpenOpcChatContentPartSchema = z.union([
  OpenOpcChatTextContentPartSchema,
  OpenOpcChatImageUrlContentPartSchema,
]);
export type OpenOpcChatContentPart = z.infer<typeof OpenOpcChatContentPartSchema>;

const OpenOpcChatContentPartsSchema = z
  .array(OpenOpcChatContentPartSchema)
  .min(1)
  .max(64)
  .superRefine((parts, context) => {
    const images = parts.filter(
      (part): part is OpenOpcChatImageUrlContentPart => part.type === 'image_url',
    );
    if (images.length > OPENOPC_CHAT_MAX_IMAGE_PARTS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'too many image parts' });
    }
    const knownBytes = images.reduce((total, part) => {
      const embedded = dataImage(part.image_url.url);
      return total + (embedded?.sizeBytes ?? part.image_url.size_bytes ?? 0);
    }, 0);
    if (knownBytes > OPENOPC_CHAT_MAX_TOTAL_IMAGE_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'total image size is too large' });
    }
  })
  .readonly();

export const OpenOpcChatMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string().max(1_000_000), OpenOpcChatContentPartsSchema, z.null()]),
    name: z.string().min(1).max(128).optional(),
    tool_call_id: z.string().min(1).max(512).optional(),
    tool_calls: z.array(z.unknown()).max(128).readonly().optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url') &&
      message.role !== 'user'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only user messages accept images',
      });
    }
  });
export type OpenOpcChatMessage = z.infer<typeof OpenOpcChatMessageSchema>;

export const OpenOpcChatCompletionRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(512),
    messages: z.array(OpenOpcChatMessageSchema).min(1).max(1024).readonly(),
    stream: z.boolean().optional(),
    temperature: z.number().finite().optional(),
    top_p: z.number().finite().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().max(16).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(16).readonly(), z.null()]).optional(),
    presence_penalty: z.number().finite().optional(),
    frequency_penalty: z.number().finite().optional(),
    seed: z.number().int().optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
    tools: z.array(z.unknown()).max(128).readonly().optional(),
    tool_choice: z.unknown().optional(),
    user: z.string().max(512).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type OpenOpcChatCompletionRequest = z.infer<typeof OpenOpcChatCompletionRequestSchema>;

export const OpenOpcModelImagePurposeSchema = z.enum(['vision', 'attachment']);
export type OpenOpcModelImagePurpose = z.infer<typeof OpenOpcModelImagePurposeSchema>;

export const OpenOpcModelImageInputCapabilitySchema = z
  .object({
    max_images: z.number().int().positive().max(OPENOPC_CHAT_MAX_IMAGE_PARTS),
    max_bytes_per_image: z.number().int().positive().max(OPENOPC_CHAT_MAX_IMAGE_BYTES),
    max_total_bytes: z.number().int().positive().max(OPENOPC_CHAT_MAX_TOTAL_IMAGE_BYTES),
    accepted_mime_types: uniqueValues(OpenOpcImageMimeTypeSchema, OPENOPC_IMAGE_MIME_TYPES.length),
    purposes: uniqueValues(OpenOpcModelImagePurposeSchema, 2),
  })
  .strict();
export type OpenOpcModelImageInputCapability = z.infer<
  typeof OpenOpcModelImageInputCapabilitySchema
>;

export const OpenOpcModelCapabilitiesSchema = z
  .object({
    modalities: uniqueValues(z.enum(['text', 'image']), 2),
    vision: OpenOpcModelImageInputCapabilitySchema.optional(),
    attachment: OpenOpcModelImageInputCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    const imageCapability = capabilities.vision ?? capabilities.attachment;
    if (Boolean(imageCapability) !== capabilities.modalities.includes('image')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'image modality requires a bounded image capability',
      });
    }
    if (capabilities.vision && !capabilities.vision.purposes.includes('vision')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'vision purpose is required' });
    }
    if (capabilities.attachment && !capabilities.attachment.purposes.includes('attachment')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'attachment purpose is required' });
    }
  });
export type OpenOpcModelCapabilities = z.infer<typeof OpenOpcModelCapabilitiesSchema>;

export const OpenOpcModelSchema = z
  .object({
    id: z.string().min(1).max(512),
    object: z.literal('model'),
    owned_by: z.string().min(1).max(128),
    name: z.string().min(1).max(512).optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    attachment: z.boolean().optional(),
    temperature: z.boolean().optional(),
    limit: z
      .object({
        context: z.number().int().positive(),
        output: z.number().int().positive(),
      })
      .strict()
      .optional(),
    capabilities: OpenOpcModelCapabilitiesSchema.optional(),
  })
  .strict();
export type OpenOpcModel = z.infer<typeof OpenOpcModelSchema>;

export const OpenOpcModelListResponseSchema = z
  .object({ data: z.array(OpenOpcModelSchema).max(512) })
  .strict();
export type OpenOpcModelListResponse = z.infer<typeof OpenOpcModelListResponseSchema>;

export function openOpcModelSupportsImagePurpose(
  model: Pick<OpenOpcModel, 'capabilities'>,
  purpose: OpenOpcModelImagePurpose,
): boolean {
  const capability =
    purpose === 'vision' ? model.capabilities?.vision : model.capabilities?.attachment;
  return Boolean(
    model.capabilities?.modalities.includes('image') && capability?.purposes.includes(purpose),
  );
}

export const OpenOpcImageAspectRatioSchema = z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']);
export type OpenOpcImageAspectRatio = z.infer<typeof OpenOpcImageAspectRatioSchema>;
export const OpenOpcImageQualitySchema = z.enum(['standard', 'high']);
export type OpenOpcImageQuality = z.infer<typeof OpenOpcImageQualitySchema>;

export const OpenOpcImageGenerateInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8000),
    negative_prompt: z.string().trim().max(4000).optional(),
    reference_asset_ids: z.array(z.string().uuid()).max(8).readonly().optional(),
    aspect_ratio: OpenOpcImageAspectRatioSchema,
    quality: OpenOpcImageQualitySchema,
    output_count: z.number().int().min(1).max(8),
    seed: z.number().int().nonnegative().optional(),
    advanced: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type OpenOpcImageGenerateInput = z.infer<typeof OpenOpcImageGenerateInputSchema>;

export const OpenOpcImageModelCapabilitiesSchema = z
  .object({
    prompt: z
      .object({
        max_characters: z.number().int().positive().max(8000),
        max_negative_prompt_characters: z.number().int().nonnegative().max(4000),
      })
      .strict(),
    reference_images: z
      .object({
        max_images: z.number().int().nonnegative().max(8),
        max_bytes_per_image: z.number().int().positive().max(OPENOPC_IMAGE_ASSET_MAX_BYTES),
        max_total_bytes: z
          .number()
          .int()
          .positive()
          .max(OPENOPC_IMAGE_ASSET_MAX_BYTES * 8),
        accepted_mime_types: uniqueValues(
          OpenOpcImageMimeTypeSchema,
          OPENOPC_IMAGE_MIME_TYPES.length,
        ),
      })
      .strict(),
    output: z
      .object({
        min_images: z.number().int().positive().max(8),
        max_images: z.number().int().positive().max(8),
        max_bytes_per_image: z.number().int().positive().max(OPENOPC_IMAGE_ASSET_MAX_BYTES),
        accepted_mime_types: uniqueValues(
          OpenOpcImageMimeTypeSchema,
          OPENOPC_IMAGE_MIME_TYPES.length,
        ),
        aspect_ratios: uniqueValues(OpenOpcImageAspectRatioSchema, 5),
        qualities: uniqueValues(OpenOpcImageQualitySchema, 2),
      })
      .strict()
      .refine((output) => output.min_images <= output.max_images, {
        message: 'minimum output count must not exceed maximum output count',
      }),
  })
  .strict();
export type OpenOpcImageModelCapabilities = z.infer<typeof OpenOpcImageModelCapabilitiesSchema>;

export const OpenOpcImageModelSchema = z
  .object({
    id: z.string().min(1).max(512),
    object: z.literal('image.model'),
    owned_by: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    capabilities: OpenOpcImageModelCapabilitiesSchema,
  })
  .strict();
export type OpenOpcImageModel = z.infer<typeof OpenOpcImageModelSchema>;

export const OpenOpcImageModelListResponseSchema = z
  .object({ data: z.array(OpenOpcImageModelSchema).max(512) })
  .strict();
export type OpenOpcImageModelListResponse = z.infer<typeof OpenOpcImageModelListResponseSchema>;

export const OpenOpcImageEstimateCreateInputSchema = z
  .object({
    model: z.string().min(1).max(512),
    input: OpenOpcImageGenerateInputSchema,
  })
  .strict();
export type OpenOpcImageEstimateCreateInput = z.infer<typeof OpenOpcImageEstimateCreateInputSchema>;

export const OpenOpcImageEstimateSchema = z
  .object({
    estimate_id: z.string().uuid(),
    estimate_token: z.string().min(16).max(8192),
    expires_at: z.string().datetime({ offset: true }),
    valid_for_ms: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000),
    retry: z
      .object({
        on_expired: z.literal('create-new-estimate'),
        automatic_job_retry: z.literal(false),
      })
      .strict(),
    currency: z.literal('credits'),
    provider_cost_credits: z.number().finite().nonnegative().optional(),
    platform_cost_credits: z.number().finite().nonnegative().optional(),
    max_approved_credits: z.number().finite().nonnegative(),
    quota: z
      .object({
        required_credits: z.number().finite().nonnegative(),
        available_credits: z.number().finite().nonnegative().nullable(),
        remaining_after_estimate_credits: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    settlement: z
      .object({
        succeeded: z.literal('settle-actual-usage'),
        failed: z.enum(['release-reservation', 'settle-verified-usage']),
        cancelled: z.enum(['release-reservation', 'settle-verified-usage']),
        maximum_charge_credits: z.number().finite().nonnegative(),
      })
      .strict(),
    input_hash: z.string().min(16).max(256),
    line_items: z
      .array(
        z
          .object({
            label: z.string().min(1).max(255),
            credits: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type OpenOpcImageEstimate = z.infer<typeof OpenOpcImageEstimateSchema>;

export const OpenOpcImageEstimateRetryActionSchema = z.enum([
  'create-new-estimate',
  'refresh-quota',
  'retry-later',
  'fix-input',
  'reconcile-before-retry',
  'do-not-retry',
]);
export type OpenOpcImageEstimateRetryAction = z.infer<typeof OpenOpcImageEstimateRetryActionSchema>;

export const OpenOpcImageEstimateRetryGuidanceSchema = z
  .object({
    action: OpenOpcImageEstimateRetryActionSchema,
    can_reestimate: z.boolean(),
    retry_same_estimate: z.literal(false),
  })
  .strict();
export type OpenOpcImageEstimateRetryGuidance = z.infer<
  typeof OpenOpcImageEstimateRetryGuidanceSchema
>;

/**
 * Maps stable platform errors to a safe client action. Unknown errors are
 * deliberately non-retryable so callers never infer billing behavior.
 */
export function openOpcImageEstimateRetryGuidance(
  errorOrCode: unknown,
): OpenOpcImageEstimateRetryGuidance {
  const code =
    typeof errorOrCode === 'string'
      ? errorOrCode
      : errorOrCode && typeof errorOrCode === 'object'
        ? (errorOrCode as { code?: unknown }).code
        : undefined;
  switch (code) {
    case 'OPENOPC_IMAGE_ESTIMATE_EXPIRED':
    case 'OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH':
      return { action: 'create-new-estimate', can_reestimate: true, retry_same_estimate: false };
    case 'OPENOPC_IMAGE_INSUFFICIENT_CREDITS':
      return { action: 'refresh-quota', can_reestimate: true, retry_same_estimate: false };
    case 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE':
    case 'OPENOPC_IMAGE_STORAGE_UNAVAILABLE':
      return { action: 'retry-later', can_reestimate: false, retry_same_estimate: false };
    case 'OPENOPC_IMAGE_VALIDATION_ERROR':
    case 'OPENOPC_IMAGE_ESTIMATE_INVALID':
    case 'OPENOPC_IMAGE_MODEL_UNAVAILABLE':
      return { action: 'fix-input', can_reestimate: true, retry_same_estimate: false };
    case 'OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED':
      return {
        action: 'reconcile-before-retry',
        can_reestimate: false,
        retry_same_estimate: false,
      };
    default:
      return { action: 'do-not-retry', can_reestimate: false, retry_same_estimate: false };
  }
}

export const OpenOpcImageJobCreateInputSchema = z
  .object({
    model: z.string().min(1).max(512),
    input: OpenOpcImageGenerateInputSchema,
    estimate_id: z.string().uuid(),
    estimate_token: z.string().min(16).max(8192),
    idempotency_key: z.string().min(16).max(255),
  })
  .strict();
export type OpenOpcImageJobCreateInput = z.infer<typeof OpenOpcImageJobCreateInputSchema>;

export const OPENOPC_IMAGE_ERROR_CODES = [
  'OPENOPC_IMAGE_VALIDATION_ERROR',
  'OPENOPC_IMAGE_ESTIMATE_INVALID',
  'OPENOPC_IMAGE_ESTIMATE_EXPIRED',
  'OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH',
  'OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED',
  'OPENOPC_IMAGE_INSUFFICIENT_CREDITS',
  'OPENOPC_IMAGE_MODEL_UNAVAILABLE',
  'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
  'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE',
  'OPENOPC_IMAGE_JOB_NOT_FOUND',
  'OPENOPC_IMAGE_JOB_NOT_CANCELLABLE',
  'OPENOPC_IMAGE_EVENT_CURSOR_EXPIRED',
  'OPENOPC_IMAGE_ASSET_NOT_FOUND',
  'OPENOPC_IMAGE_ASSET_NOT_DELETABLE',
  'OPENOPC_IMAGE_ASSET_INVALID',
  'OPENOPC_IMAGE_ASSET_TOO_LARGE',
  'OPENOPC_IMAGE_STORAGE_UNAVAILABLE',
  'OPENOPC_IMAGE_INTERNAL_ERROR',
] as const;
export const OpenOpcImageErrorCodeSchema = z.enum(OPENOPC_IMAGE_ERROR_CODES);
export type OpenOpcImageErrorCode = z.infer<typeof OpenOpcImageErrorCodeSchema>;

export const OpenOpcImageJobStateSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type OpenOpcImageJobState = z.infer<typeof OpenOpcImageJobStateSchema>;

export const OpenOpcImageJobSchema = z
  .object({
    job_id: z.string().uuid(),
    model: z.string().min(1).max(512),
    input: OpenOpcImageGenerateInputSchema,
    status: OpenOpcImageJobStateSchema,
    attempt_count: z.number().int().nonnegative(),
    reserved_credits: z.number().finite().nonnegative(),
    actual_credits: z.number().finite().nonnegative().nullable(),
    error_code: OpenOpcImageErrorCodeSchema.nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    started_at: z.string().datetime({ offset: true }).nullable(),
    completed_at: z.string().datetime({ offset: true }).nullable(),
    cancellable: z.boolean(),
  })
  .strict();
export type OpenOpcImageJob = z.infer<typeof OpenOpcImageJobSchema>;

export const OpenOpcImageJobEventSchema = z
  .object({
    event_id: z.string().uuid(),
    job_id: z.string().uuid(),
    cursor: z.string().min(1).max(2048),
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
    progress: z.number().finite().min(0).max(1).optional(),
    retry_after_ms: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1000)
      .nullable()
      .optional(),
    asset_ids: z.array(z.string().uuid()).max(8).readonly().optional(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.type === 'progress' && event.progress === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'progress value is required' });
    }
    if (event.type === 'asset-created' && !event.asset_ids?.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'asset ids are required' });
    }
  });
export type OpenOpcImageJobEvent = z.infer<typeof OpenOpcImageJobEventSchema>;

export const OpenOpcImageJobEventPageSchema = z
  .object({
    items: z.array(OpenOpcImageJobEventSchema).max(100),
    next_cursor: z.string().min(1).max(2048).nullable(),
  })
  .strict();
export type OpenOpcImageJobEventPage = z.infer<typeof OpenOpcImageJobEventPageSchema>;

export const OpenOpcImageEventFailureModeSchema = z.enum(['fallback-to-polling', 'error']);
export type OpenOpcImageEventFailureMode = z.infer<typeof OpenOpcImageEventFailureModeSchema>;
export const OpenOpcImageEventHistoryStateSchema = z.enum(['available', 'unavailable']);
export type OpenOpcImageEventHistoryState = z.infer<typeof OpenOpcImageEventHistoryStateSchema>;

export const OpenOpcImagePageInputSchema = z
  .object({
    cursor: z.string().min(1).max(2048).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type OpenOpcImagePageInput = z.infer<typeof OpenOpcImagePageInputSchema>;

export const OpenOpcImageAssetOriginSchema = z.enum(['generated', 'uploaded']);
export type OpenOpcImageAssetOrigin = z.infer<typeof OpenOpcImageAssetOriginSchema>;

export const OpenOpcImageAssetListInputSchema = OpenOpcImagePageInputSchema.extend({
  source_job_id: z.string().uuid().optional(),
  source: OpenOpcImageAssetOriginSchema.optional(),
})
  .strict()
  .superRefine((input, context) => {
    if (input.source_job_id && input.source === 'uploaded') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: 'uploaded assets cannot have a source job',
      });
    }
  });
export type OpenOpcImageAssetListInput = z.infer<typeof OpenOpcImageAssetListInputSchema>;

export const OpenOpcImageAssetRetentionSchema = z
  .object({
    policy: z.enum(['temporary', 'retained']),
    expires_at: z.string().datetime({ offset: true }).nullable(),
    deletable: z.boolean(),
  })
  .strict();
export type OpenOpcImageAssetRetention = z.infer<typeof OpenOpcImageAssetRetentionSchema>;

export const OpenOpcImageAssetSchema = z
  .object({
    asset_id: z.string().uuid(),
    source: z
      .object({
        job_id: z.string().uuid().nullable(),
        prompt: z.string().max(8000).nullable(),
      })
      .strict(),
    kind: z.literal('image'),
    mime_type: OpenOpcImageMimeTypeSchema,
    checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().nonnegative().max(OPENOPC_IMAGE_ASSET_MAX_BYTES),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    retention: OpenOpcImageAssetRetentionSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcImageAsset = z.infer<typeof OpenOpcImageAssetSchema>;

export const OpenOpcImageAssetPageSchema = z
  .object({
    items: z.array(OpenOpcImageAssetSchema).max(100),
    next_cursor: z.string().min(1).max(2048).nullable(),
  })
  .strict();
export type OpenOpcImageAssetPage = z.infer<typeof OpenOpcImageAssetPageSchema>;

export const OpenOpcImageAssetCreateMetadataSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    metadata: z.record(z.string(), z.unknown()).optional(),
    retention: z.enum(['temporary', 'retained']).optional(),
  })
  .strict();
export type OpenOpcImageAssetCreateMetadata = z.infer<typeof OpenOpcImageAssetCreateMetadataSchema>;

export const OpenOpcImageAssetPreviewSchema = z
  .object({
    asset_id: z.string().uuid(),
    url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      }),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcImageAssetPreview = z.infer<typeof OpenOpcImageAssetPreviewSchema>;

export const OpenOpcImageAssetThumbnailPresetSchema = z.enum(['small', 'medium', 'large']);
export type OpenOpcImageAssetThumbnailPreset = z.infer<
  typeof OpenOpcImageAssetThumbnailPresetSchema
>;

export const OpenOpcImageAssetThumbnailInputSchema = z
  .object({ preset: OpenOpcImageAssetThumbnailPresetSchema.optional() })
  .strict();
export type OpenOpcImageAssetThumbnailInput = z.infer<typeof OpenOpcImageAssetThumbnailInputSchema>;

export const OpenOpcImageAssetThumbnailSchema = z
  .object({
    asset_id: z.string().uuid(),
    preset: OpenOpcImageAssetThumbnailPresetSchema,
    url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      }),
    mime_type: z.literal('image/webp'),
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(1024),
    size_bytes: z.number().int().positive().max(OPENOPC_IMAGE_ASSET_MAX_BYTES),
    cache: z
      .object({
        visibility: z.literal('private'),
        max_age_seconds: z.number().int().positive().max(900),
        immutable: z.literal(true),
      })
      .strict(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcImageAssetThumbnail = z.infer<typeof OpenOpcImageAssetThumbnailSchema>;

export const OpenOpcImageAssetDeleteResultSchema = z
  .object({ asset_id: z.string().uuid(), deleted: z.literal(true) })
  .strict();
export type OpenOpcImageAssetDeleteResult = z.infer<typeof OpenOpcImageAssetDeleteResultSchema>;
