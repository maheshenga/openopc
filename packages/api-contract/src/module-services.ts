import { z } from 'zod';

export const OPENOPC_SERVICE_NAMES = ['ai', 'payment'] as const;
export const OPENOPC_AI_SERVICE_OPERATIONS = [
  'models.read',
  'text.generate',
  'text.stream',
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
