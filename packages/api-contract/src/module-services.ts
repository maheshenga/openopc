import { z } from 'zod';

export const OPENOPC_SERVICE_NAMES = ['ai', 'payment'] as const;
export const OPENOPC_AI_SERVICE_OPERATIONS = [
  'models.read',
  'text.generate',
  'text.stream',
  'images.models.read',
  'images.estimates.create',
  'images.jobs.create',
  'images.jobs.read',
  'images.jobs.cancel',
  'images.assets.create',
  'images.assets.read',
  'images.assets.download',
] as const;
export const OPENOPC_PAYMENT_SERVICE_OPERATIONS = [
  'orders.create',
  'orders.read',
  'refunds.create',
] as const;
export const OPENOPC_SERVICE_OPERATIONS = [
  ...OPENOPC_AI_SERVICE_OPERATIONS,
  ...OPENOPC_PAYMENT_SERVICE_OPERATIONS,
] as const;

export const OpenOpcServiceNameSchema = z.enum(OPENOPC_SERVICE_NAMES);
export const OpenOpcAiServiceOperationSchema = z.enum(OPENOPC_AI_SERVICE_OPERATIONS);
export const OpenOpcPaymentServiceOperationSchema = z.enum(OPENOPC_PAYMENT_SERVICE_OPERATIONS);
export const OpenOpcServiceOperationSchema = z.enum(OPENOPC_SERVICE_OPERATIONS);

export type OpenOpcServiceName = z.infer<typeof OpenOpcServiceNameSchema>;
export type OpenOpcServiceOperation = z.infer<typeof OpenOpcServiceOperationSchema>;

function uniqueOperations<T extends z.ZodTypeAny>(schema: T) {
  return z
    .array(schema)
    .min(1)
    .max(OPENOPC_SERVICE_OPERATIONS.length)
    .superRefine((operations, context) => {
      if (new Set(operations).size !== operations.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'operations must be unique',
        });
      }
    });
}

const AiServiceOperationsSchema = uniqueOperations(OpenOpcAiServiceOperationSchema);
const PaymentServiceOperationsSchema = uniqueOperations(OpenOpcPaymentServiceOperationSchema);

export const ModuleServiceCapabilityRequestSchema = z.discriminatedUnion('service', [
  z
    .object({
      service: z.literal('ai'),
      operations: AiServiceOperationsSchema,
    })
    .strict(),
  z
    .object({
      service: z.literal('payment'),
      operations: PaymentServiceOperationsSchema,
    })
    .strict(),
]);
export type ModuleServiceCapabilityRequest = z.infer<typeof ModuleServiceCapabilityRequestSchema>;

export const ModuleServiceConsentPutInputSchema = z
  .object({
    operations: uniqueOperations(OpenOpcServiceOperationSchema),
    expected_install_revision: z.number().int().positive(),
  })
  .strict();
export type ModuleServiceConsentPutInput = z.infer<typeof ModuleServiceConsentPutInputSchema>;

export function parseModuleServiceConsentPutInput(
  service: OpenOpcServiceName,
  value: unknown,
): ModuleServiceConsentPutInput {
  const input = ModuleServiceConsentPutInputSchema.parse(value);
  ModuleServiceCapabilityRequestSchema.parse({ service, operations: input.operations });
  return input;
}

export const ModuleServiceConsentDeleteInputSchema = z
  .object({ expected_install_revision: z.number().int().positive() })
  .strict();
export type ModuleServiceConsentDeleteInput = z.infer<typeof ModuleServiceConsentDeleteInputSchema>;

export const MODULE_SERVICE_ERROR_CODES = [
  'MODULE_SERVICE_INPUT_INVALID',
  'MODULE_SERVICE_UNAVAILABLE',
  'MODULE_SERVICE_INSTALLATION_NOT_FOUND',
  'MODULE_SERVICE_INSTALLATION_STALE',
  'MODULE_SERVICE_RELEASE_REVOKED',
  'MODULE_SERVICE_NOT_DECLARED',
  'MODULE_SERVICE_CONSENT_REQUIRED',
  'MODULE_SERVICE_CONSENT_REVOKED',
  'MODULE_SERVICE_CAPABILITY_INVALID',
  'MODULE_SERVICE_CAPABILITY_EXPIRED',
  'MODULE_SERVICE_CAPABILITY_REVOKED',
  'MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH',
  'MODULE_SERVICE_OPERATION_DENIED',
  'MODULE_SERVICE_CONFLICT',
  'MODULE_AI_PROVIDER_UNAVAILABLE',
  'MODULE_IMAGE_INVALID',
  'MODULE_IMAGE_UNAVAILABLE',
  'MODULE_IMAGE_NOT_FOUND',
  'MODULE_IMAGE_ESTIMATE_EXPIRED',
  'MODULE_IMAGE_IDEMPOTENCY_CONFLICT',
  'MODULE_IMAGE_STORAGE_UNAVAILABLE',
  'MODULE_IMAGE_JOB_NOT_CANCELLABLE',
  'MODULE_PAYMENT_IDEMPOTENCY_CONFLICT',
  'MODULE_PAYMENT_ORDER_NOT_FOUND',
  'MODULE_PAYMENT_ORDER_STATE_CONFLICT',
  'MODULE_PAYMENT_PROVIDER_UNAVAILABLE',
  'MODULE_PAYMENT_REFUND_CONFLICT',
] as const;
export const ModuleServiceErrorCodeSchema = z.enum(MODULE_SERVICE_ERROR_CODES);
export type ModuleServiceErrorCode = z.infer<typeof ModuleServiceErrorCodeSchema>;
export const ModuleServiceErrorResponseSchema = z
  .object({
    error: ModuleServiceErrorCodeSchema,
    message: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ModuleServiceErrorResponse = z.infer<typeof ModuleServiceErrorResponseSchema>;

export const OpenOpcImageAspectRatioSchema = z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']);
export type OpenOpcImageAspectRatio = z.infer<typeof OpenOpcImageAspectRatioSchema>;

export const OpenOpcImageQualitySchema = z.enum(['standard', 'high']);
export type OpenOpcImageQuality = z.infer<typeof OpenOpcImageQualitySchema>;

const OpenOpcImageModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const OpenOpcImageModelSchema = z
  .object({
    id: OpenOpcImageModelIdSchema,
    object: z.literal('image_model'),
    owned_by: z.literal('openopc'),
    name: z.string().trim().min(1).max(200),
    capabilities: z
      .object({
        reference_images: z.boolean(),
        max_reference_images: z.number().int().min(0).max(8),
        supports_negative_prompt: z.boolean(),
        supports_seed: z.boolean(),
        aspect_ratios: z.array(OpenOpcImageAspectRatioSchema).min(1).max(5),
        qualities: z.array(OpenOpcImageQualitySchema).min(1).max(2),
        max_output_count: z.number().int().min(1).max(8),
      })
      .strict(),
  })
  .strict();
export type OpenOpcImageModel = z.infer<typeof OpenOpcImageModelSchema>;

export const OpenOpcImageGenerateInputSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    negative_prompt: z.string().max(4000).optional(),
    reference_asset_ids: z.array(z.string().uuid()).max(8).default([]),
    aspect_ratio: OpenOpcImageAspectRatioSchema,
    quality: OpenOpcImageQualitySchema,
    output_count: z.number().int().min(1).max(8),
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type OpenOpcImageGenerateInput = z.infer<typeof OpenOpcImageGenerateInputSchema>;

export const OpenOpcImageEstimateRequestSchema = z
  .object({ model: OpenOpcImageModelIdSchema, input: OpenOpcImageGenerateInputSchema })
  .strict();
export type OpenOpcImageEstimateRequest = z.infer<typeof OpenOpcImageEstimateRequestSchema>;

export const OpenOpcImageEstimateSchema = z
  .object({
    estimate_id: z.string().uuid(),
    estimate_token: z.string().trim().min(1).max(8192),
    expires_at: z.string().datetime({ offset: true }),
    currency: z.literal('credits'),
    provider_cost_credits: z.number().finite().nonnegative(),
    platform_cost_credits: z.number().finite().nonnegative(),
    max_approved_credits: z.number().finite().nonnegative().max(1_000_000),
    input_hash: z.string().min(16).max(256),
    line_items: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            credits: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type OpenOpcImageEstimate = z.infer<typeof OpenOpcImageEstimateSchema>;

export const OpenOpcImageJobCreateInputSchema = z
  .object({
    model: OpenOpcImageModelIdSchema,
    input: OpenOpcImageGenerateInputSchema,
    estimate: z
      .object({
        estimate_id: z.string().uuid(),
        estimate_token: z.string().trim().min(1).max(8192),
        max_approved_credits: z.number().finite().nonnegative().max(1_000_000),
      })
      .strict(),
  })
  .strict();
export type OpenOpcImageJobCreateInput = z.infer<typeof OpenOpcImageJobCreateInputSchema>;

export const OpenOpcImageJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type OpenOpcImageJobStatus = z.infer<typeof OpenOpcImageJobStatusSchema>;

const OpenOpcImageErrorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_.-]{0,127}$/)
  .nullable();

export const OpenOpcImageJobSchema = z
  .object({
    job_id: z.string().uuid(),
    model: OpenOpcImageModelIdSchema,
    input: OpenOpcImageGenerateInputSchema,
    status: OpenOpcImageJobStatusSchema,
    reserved_credits: z.number().finite().nonnegative(),
    actual_credits: z.number().finite().nonnegative().nullable(),
    error_code: OpenOpcImageErrorCodeSchema,
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    started_at: z.string().datetime({ offset: true }).nullable(),
    completed_at: z.string().datetime({ offset: true }).nullable(),
    cancellable: z.boolean(),
  })
  .strict();
export type OpenOpcImageJob = z.infer<typeof OpenOpcImageJobSchema>;

export const OpenOpcImageJobCreateResultSchema = z
  .object({ job: OpenOpcImageJobSchema, created: z.boolean() })
  .strict();
export type OpenOpcImageJobCreateResult = z.infer<typeof OpenOpcImageJobCreateResultSchema>;

export const OpenOpcImageListInputSchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type OpenOpcImageListInput = z.infer<typeof OpenOpcImageListInputSchema>;

export const OpenOpcImageJobListSchema = z
  .object({ items: z.array(OpenOpcImageJobSchema).max(100), next_cursor: z.string().nullable() })
  .strict();
export type OpenOpcImageJobList = z.infer<typeof OpenOpcImageJobListSchema>;

export const OpenOpcImageJobEventSchema = z
  .object({
    event_id: z.string().uuid(),
    cursor: z.string().trim().min(1).max(2048),
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
    progress: z.number().finite().min(0).max(1).nullable(),
    asset_ids: z.array(z.string().uuid()).max(8),
    error_code: OpenOpcImageErrorCodeSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcImageJobEvent = z.infer<typeof OpenOpcImageJobEventSchema>;

export const OpenOpcImageJobEventListSchema = z
  .object({
    items: z.array(OpenOpcImageJobEventSchema).max(100),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type OpenOpcImageJobEventList = z.infer<typeof OpenOpcImageJobEventListSchema>;

export const OpenOpcImageAssetSchema = z
  .object({
    asset_id: z.string().uuid(),
    source_job_id: z.string().uuid().nullable(),
    kind: z.literal('image'),
    mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    size_bytes: z.number().int().positive().max(32 * 1024 * 1024),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcImageAsset = z.infer<typeof OpenOpcImageAssetSchema>;

export const OpenOpcImageAssetListSchema = z
  .object({ items: z.array(OpenOpcImageAssetSchema).max(100), next_cursor: z.string().nullable() })
  .strict();
export type OpenOpcImageAssetList = z.infer<typeof OpenOpcImageAssetListSchema>;

const capabilityClaimsShape = {
  schemaVersion: z.literal(1),
  iss: z.literal('openopc-control-plane'),
  aud: z.literal('openopc:module-service'),
  jti: z.string().uuid(),
  iat: z.string().datetime({ offset: true }),
  exp: z.string().datetime({ offset: true }),
  accountId: z.string().uuid(),
  projectId: z.string().uuid(),
  installationId: z.string().uuid(),
  installRevision: z.number().int().positive(),
  releaseId: z.string().uuid(),
  moduleId: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
  moduleVersion: z.string().min(1).max(128),
  consentId: z.string().uuid(),
  grantId: z.string().uuid(),
  actorUserId: z.string().uuid().optional(),
} as const;

export const ModuleServiceCapabilityClaimsV1Schema = z.discriminatedUnion('service', [
  z
    .object({
      ...capabilityClaimsShape,
      service: z.literal('ai'),
      operations: AiServiceOperationsSchema,
    })
    .strict(),
  z
    .object({
      ...capabilityClaimsShape,
      service: z.literal('payment'),
      operations: PaymentServiceOperationsSchema,
    })
    .strict(),
]);
export type ModuleServiceCapabilityClaimsV1 = z.infer<typeof ModuleServiceCapabilityClaimsV1Schema>;

export function parseModuleServiceCapabilityClaims(
  value: unknown,
): ModuleServiceCapabilityClaimsV1 {
  return ModuleServiceCapabilityClaimsV1Schema.parse(value);
}

export const ModulePaymentIdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
export type ModulePaymentIdempotencyKey = z.infer<typeof ModulePaymentIdempotencyKeySchema>;

const ModulePaymentProductNameSchema = z.string().superRefine((value, context) => {
  const length = [...value].length;
  if (length < 1 || length > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'product_name length is invalid' });
  }
});

export const CreateDeveloperPaymentOrderInputSchema = z
  .object({
    amount_minor: z.number().int().positive().max(100_000_000),
    currency: z.literal('CNY'),
    product_name: ModulePaymentProductNameSchema,
  })
  .strict();
export type CreateDeveloperPaymentOrderInput = z.infer<
  typeof CreateDeveloperPaymentOrderInputSchema
>;

export const DeveloperModulePaymentOrderStatusSchema = z.enum([
  'checkout_issued',
  'paid',
  'expired',
  'paid_late',
  'refund_requested',
  'refunded',
  'refund_failed',
]);
export type DeveloperModulePaymentOrderStatus = z.infer<
  typeof DeveloperModulePaymentOrderStatusSchema
>;

const ModulePaymentCheckoutSchema = z
  .object({
    kind: z.enum(['redirect', 'qr']),
    url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => /^https?:$/.test(new URL(value).protocol)),
    mobile_url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => /^https?:$/.test(new URL(value).protocol))
      .nullable(),
  })
  .strict();

export const CreateDeveloperPaymentOrderResultSchema = z
  .object({
    order_id: z.string().uuid(),
    status: z.literal('checkout_issued'),
    expires_at: z.string().datetime({ offset: true }),
    checkout: ModulePaymentCheckoutSchema,
  })
  .strict();
export type CreateDeveloperPaymentOrderResult = z.infer<
  typeof CreateDeveloperPaymentOrderResultSchema
>;

export const DeveloperPaymentOrderViewSchema = z
  .object({
    order_id: z.string().uuid(),
    amount_minor: z.number().int().positive().max(100_000_000),
    currency: z.literal('CNY'),
    product_name: ModulePaymentProductNameSchema,
    status: DeveloperModulePaymentOrderStatusSchema,
    expires_at: z.string().datetime({ offset: true }),
    paid_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type DeveloperPaymentOrderView = z.infer<typeof DeveloperPaymentOrderViewSchema>;

export const CreateDeveloperPaymentRefundInputSchema = z
  .object({
    amount_minor: z.number().int().positive().max(100_000_000),
  })
  .strict();
export type CreateDeveloperPaymentRefundInput = z.infer<
  typeof CreateDeveloperPaymentRefundInputSchema
>;

export const DeveloperPaymentRefundStatusSchema = z.enum([
  'refund_requested',
  'refunded',
  'refund_failed',
]);
export type DeveloperPaymentRefundStatus = z.infer<typeof DeveloperPaymentRefundStatusSchema>;

export const DeveloperPaymentRefundViewSchema = z
  .object({
    refund_id: z.string().uuid(),
    order_id: z.string().uuid(),
    amount_minor: z.number().int().positive().max(100_000_000),
    status: DeveloperPaymentRefundStatusSchema,
    requested_at: z.string().datetime({ offset: true }),
    resolved_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type DeveloperPaymentRefundView = z.infer<typeof DeveloperPaymentRefundViewSchema>;
