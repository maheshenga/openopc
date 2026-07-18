import {
  AgentCardSchema,
  CapabilityDescriptorSchema,
  ProtocolVersionSchema,
  TaskEventSchema,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';
import { StudioJobInputSchema } from './studio';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CursorSchema = z.string().trim().min(1).max(256).nullable();
const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const IntelligenceModelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !URI_SCHEME_PATTERN.test(value) &&
      !value.startsWith('//') &&
      !/[?&#]/.test(value) &&
      !/(?:api[_-]?key|secret|password|credential|authorization|bearer|access[_-]?token)/i.test(
        value,
      ),
    'model must be a non-sensitive identifier',
  );
const SENSITIVE_PUBLIC_KEY_PATTERN =
  /(^|[._-])(api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz)([._-]|$)/i;
const UNSAFE_PUBLIC_URL_PATTERN = /(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/i;
const UNSAFE_PUBLIC_SCHEME_PATTERN = /(?:^|[\s"'=(:,])(data|file|mailto|javascript|blob|urn):/i;
const StrictStudioJobInputSchema = z
  .object({
    capability: z.literal('image.generate'),
    image: z.unknown(),
  })
  .strict()
  .and(StudioJobInputSchema)
  .superRefine((value, context) => {
    const advanced = (value as { image?: { advanced?: unknown } }).image?.advanced;
    if (advanced !== undefined && hasUnsafePublicPayload(advanced)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'advanced input cannot contain credentials or provider URLs',
      });
    }
  });

export const IntelligenceCapabilitiesResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    items: z
      .array(
        CapabilityDescriptorSchema.superRefine((descriptor, context) => {
          if (
            hasUnsafePublicPayload(descriptor.input_schema) ||
            hasUnsafePublicPayload(descriptor.output_schema)
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'capability schemas cannot contain credentials or provider URLs',
            });
          }
        }),
      )
      .max(256),
    next_cursor: CursorSchema,
  })
  .strict();
export type IntelligenceCapabilitiesResponse = z.infer<
  typeof IntelligenceCapabilitiesResponseSchema
>;

export const IntelligenceExecutionTargetSchema = z
  .object({
    capability_id: z.literal('studio.image.generate'),
    provider_config_id: z.string().uuid(),
    model: IntelligenceModelIdentifierSchema,
  })
  .strict();
export type IntelligenceExecutionTarget = z.infer<typeof IntelligenceExecutionTargetSchema>;

export const IntelligenceCapabilityDiscoveryResponseSchema =
  IntelligenceCapabilitiesResponseSchema.extend({
    execution_targets: z.array(IntelligenceExecutionTargetSchema).max(1024),
  }).strict();
export type IntelligenceCapabilityDiscoveryResponse = z.infer<
  typeof IntelligenceCapabilityDiscoveryResponseSchema
>;

export const IntelligenceAgentCardResponseSchema = AgentCardSchema;
export type IntelligenceAgentCardResponse = z.infer<typeof IntelligenceAgentCardResponseSchema>;

export const IntelligenceCreateTaskRequestSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    capability_id: z.literal('studio.image.generate'),
    agent_card_hash: HashSchema,
    provider_config_id: z.string().uuid(),
    model: IntelligenceModelIdentifierSchema,
    input: StrictStudioJobInputSchema,
    idempotency_key: z.string().trim().min(16).max(255),
    parent_task_id: z.string().uuid().nullable().optional(),
    deadline_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type IntelligenceCreateTaskRequest = z.infer<typeof IntelligenceCreateTaskRequestSchema>;

export const IntelligenceTaskResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: z.string().uuid(),
    job_id: z.string().uuid(),
    created: z.boolean(),
  })
  .strict();
export type IntelligenceTaskResponse = z.infer<typeof IntelligenceTaskResponseSchema>;

export const IntelligenceTaskEventsResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: z.string().uuid(),
    items: z.array(TaskEventSchema).max(1024),
    next_cursor: CursorSchema,
  })
  .strict();
export type IntelligenceTaskEventsResponse = z.infer<typeof IntelligenceTaskEventsResponseSchema>;

function hasUnsafePublicPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    return UNSAFE_PUBLIC_URL_PATTERN.test(value) || UNSAFE_PUBLIC_SCHEME_PATTERN.test(value);
  }
  if (Array.isArray(value)) return value.some(hasUnsafePublicPayload);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, nested]) => SENSITIVE_PUBLIC_KEY_PATTERN.test(key) || hasUnsafePublicPayload(nested),
  );
}
