import { z } from 'zod';

export const OPENAI_COMPATIBLE_DEFINITION_ID = 'openai-compatible' as const;
export const OPENAI_IMAGE_GENERIC_PROFILE_ID = 'openai-images-v1-generic' as const;
export const OPENAI_IMAGE_GENERIC_PROFILE = Object.freeze({
  id: OPENAI_IMAGE_GENERIC_PROFILE_ID,
  response: 'synchronous' as const,
  submit_replay: false,
  reconciliation: false,
  upstream_cancellation: false,
  idempotency_header: null,
});

export type OpenAiCompatibleAspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16';

export interface OpenAiCompatibleModelConfig {
  model: string;
  pricing_catalog_id: string;
  dialect_profile_id: typeof OPENAI_IMAGE_GENERIC_PROFILE_ID;
  supports_reference_images: false;
  allowed_advanced_fields: readonly string[];
  size_map: Record<OpenAiCompatibleAspectRatio, string>;
}

export interface StudioProviderCapabilityMap {
  definition_id: typeof OPENAI_COMPATIBLE_DEFINITION_ID;
  capabilities: {
    'image.generate': {
      models: readonly OpenAiCompatibleModelConfig[];
    };
  };
}

const RESERVED_REQUEST_FIELDS = new Set([
  'model',
  'prompt',
  'n',
  'size',
  'quality',
  'response_format',
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'idempotency',
  'idempotency_key',
  'idempotency_header',
  'submission_key',
  'correlation_id',
  'reference_asset_ids',
  'credential',
  'api_key',
  'x_api_key',
  'async',
  'synchronous',
  'response',
  'replay',
  'submit_replay',
  'supports_submit_replay',
  'reconcile',
  'reconciliation',
  'supports_reconciliation',
  'cancellable',
  'cancellation',
  'upstream_cancellation',
  'supports_cancellation',
  'dialect_profile_id',
  'idempotency_header',
  'idempotency_field',
  'idempotency_request_field',
  'supports_idempotency',
]);

export function isOpenAiCompatibleReservedRequestField(field: string): boolean {
  return RESERVED_REQUEST_FIELDS.has(field.toLowerCase().replace(/[.-]/g, '_'));
}

const AdvancedFieldSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const SizeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/);
const SizeMapSchema = z
  .object({
    '1:1': SizeSchema,
    '4:3': SizeSchema,
    '3:4': SizeSchema,
    '16:9': SizeSchema,
    '9:16': SizeSchema,
  })
  .strict();
const ModelSchema = z
  .object({
    model: z.string().trim().min(1).max(255),
    pricing_catalog_id: z.string().trim().min(1).max(255),
    dialect_profile_id: z.literal(OPENAI_IMAGE_GENERIC_PROFILE_ID),
    supports_reference_images: z.literal(false),
    allowed_advanced_fields: z.array(AdvancedFieldSchema).max(64),
    size_map: SizeMapSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const unique = new Set(value.allowed_advanced_fields);
    if (unique.size !== value.allowed_advanced_fields.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate advanced field' });
    }
    if (value.allowed_advanced_fields.some(isOpenAiCompatibleReservedRequestField)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'reserved advanced field' });
    }
  });
const CapabilityMapSchema = z
  .object({
    definition_id: z.literal(OPENAI_COMPATIBLE_DEFINITION_ID),
    capabilities: z
      .object({
        'image.generate': z
          .object({
            models: z.array(ModelSchema).min(1).max(100),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const models = value.capabilities['image.generate'].models;
    if (new Set(models.map((entry) => entry.model)).size !== models.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate model' });
    }
    if (new Set(models.map((entry) => entry.pricing_catalog_id)).size !== models.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate pricing catalog' });
    }
  });

export class OpenAiCompatibleConfigurationError extends Error {
  constructor() {
    super('Invalid OpenAI-compatible capability map');
    this.name = 'OpenAiCompatibleConfigurationError';
  }
}

export function parseOpenAiCompatibleCapabilityMap(
  value: Record<string, unknown>,
): StudioProviderCapabilityMap {
  const parsed = CapabilityMapSchema.safeParse(value);
  if (!parsed.success) throw new OpenAiCompatibleConfigurationError();
  return parsed.data;
}
