import { z } from 'zod';

export * from './ai-contracts.js';

export const OPENOPC_SERVICE_NAMES = ['ai', 'payment', 'data', 'settings'] as const;
export const OPENOPC_AI_SERVICE_OPERATIONS = [
  'models.read',
  'text.generate',
  'text.stream',
  'image.generate',
] as const;
export const OPENOPC_PAYMENT_SERVICE_OPERATIONS = [
  'orders.create',
  'orders.read',
  'refunds.create',
] as const;
export const OPENOPC_DATA_SERVICE_OPERATIONS = [
  'documents.list',
  'documents.read',
  'documents.write',
  'documents.delete',
] as const;
export const OPENOPC_SETTINGS_SERVICE_OPERATIONS = ['settings.read'] as const;
export const OPENOPC_SERVICE_OPERATIONS = [
  ...OPENOPC_AI_SERVICE_OPERATIONS,
  ...OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  ...OPENOPC_DATA_SERVICE_OPERATIONS,
  ...OPENOPC_SETTINGS_SERVICE_OPERATIONS,
] as const;

export const OpenOpcServiceNameSchema = z.enum(OPENOPC_SERVICE_NAMES);
export const OpenOpcAiServiceOperationSchema = z.enum(OPENOPC_AI_SERVICE_OPERATIONS);
export const OpenOpcPaymentServiceOperationSchema = z.enum(OPENOPC_PAYMENT_SERVICE_OPERATIONS);
export const OpenOpcDataServiceOperationSchema = z.enum(OPENOPC_DATA_SERVICE_OPERATIONS);
export const OpenOpcSettingsServiceOperationSchema = z.enum(OPENOPC_SETTINGS_SERVICE_OPERATIONS);
export const OpenOpcServiceOperationSchema = z.enum(OPENOPC_SERVICE_OPERATIONS);

export type OpenOpcServiceName = z.infer<typeof OpenOpcServiceNameSchema>;
export type OpenOpcAiServiceOperation = z.infer<typeof OpenOpcAiServiceOperationSchema>;
export type OpenOpcPaymentServiceOperation = z.infer<typeof OpenOpcPaymentServiceOperationSchema>;
export type OpenOpcDataServiceOperation = z.infer<typeof OpenOpcDataServiceOperationSchema>;
export type OpenOpcSettingsServiceOperation = z.infer<typeof OpenOpcSettingsServiceOperationSchema>;
export type OpenOpcServiceOperation = z.infer<typeof OpenOpcServiceOperationSchema>;

function uniqueOperations<T extends z.ZodTypeAny>(schema: T) {
  return z
    .array(schema)
    .min(1)
    .max(OPENOPC_SERVICE_OPERATIONS.length)
    .superRefine((operations, context) => {
      if (new Set(operations).size !== operations.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'operations must be unique' });
      }
    });
}

const AiServiceOperationsSchema = uniqueOperations(OpenOpcAiServiceOperationSchema);
const PaymentServiceOperationsSchema = uniqueOperations(OpenOpcPaymentServiceOperationSchema);
const DataServiceOperationsSchema = uniqueOperations(OpenOpcDataServiceOperationSchema);
const SettingsServiceOperationsSchema = uniqueOperations(OpenOpcSettingsServiceOperationSchema);

export const ModuleServiceCapabilityRequestSchema = z.discriminatedUnion('service', [
  z.object({ service: z.literal('ai'), operations: AiServiceOperationsSchema }).strict(),
  z.object({ service: z.literal('payment'), operations: PaymentServiceOperationsSchema }).strict(),
  z.object({ service: z.literal('data'), operations: DataServiceOperationsSchema }).strict(),
  z
    .object({ service: z.literal('settings'), operations: SettingsServiceOperationsSchema })
    .strict(),
]);
export type ModuleServiceCapabilityRequest = z.infer<typeof ModuleServiceCapabilityRequestSchema>;

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
  'MODULE_DATA_DOCUMENT_NOT_FOUND',
  'MODULE_DATA_STORAGE_UNAVAILABLE',
  'MODULE_SETTINGS_INVALID',
  'MODULE_SETTINGS_STORAGE_UNAVAILABLE',
  'MODULE_AI_PROVIDER_UNAVAILABLE',
  'MODULE_PAYMENT_IDEMPOTENCY_CONFLICT',
  'MODULE_PAYMENT_ORDER_NOT_FOUND',
  'MODULE_PAYMENT_ORDER_STATE_CONFLICT',
  'MODULE_PAYMENT_PROVIDER_UNAVAILABLE',
  'MODULE_PAYMENT_REFUND_CONFLICT',
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
export const ModuleServiceErrorCodeSchema = z.enum(MODULE_SERVICE_ERROR_CODES);
export type ModuleServiceErrorCode = z.infer<typeof ModuleServiceErrorCodeSchema>;
export const ModuleServiceErrorResponseSchema = z
  .object({ error: ModuleServiceErrorCodeSchema, message: z.string().min(1).max(512).optional() })
  .strict();
export type ModuleServiceErrorResponse = z.infer<typeof ModuleServiceErrorResponseSchema>;

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
  .object({ amount_minor: z.number().int().positive().max(100_000_000) })
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
