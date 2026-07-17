import { z } from 'zod';
import { ProtocolVersionSchema } from './compatibility';

const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
  .max(64);
const CapabilityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/);
const NonEmptyTextSchema = z.string().trim().min(1).max(1024);
const JsonObjectSchema = z.record(z.string().min(1).max(128), z.unknown());
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidSchema = z.string().uuid();
const DateTimeSchema = z.string().datetime({ offset: true });

export const CapabilityDescriptorSchema = z
  .object({
    id: CapabilityIdSchema,
    version: SemverSchema,
    modality: z.enum(['text', 'image', 'video', 'audio', '3d', 'avatar']),
    operation: CapabilityIdSchema,
    input_schema: JsonObjectSchema,
    output_schema: JsonObjectSchema,
    execution: z.enum(['sync', 'async', 'stream']),
    risk: z.enum(['read', 'write', 'destructive']),
    estimated_cost_credits: z.number().finite().nonnegative().max(1_000_000).optional(),
    provenance_required: z.boolean(),
  })
  .strict();
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

const AgentAuthSchema = z
  .object({
    kind: z.enum(['kortix-project-token', 'service-token']),
  })
  .strict();

const AgentLimitsSchema = z
  .object({
    concurrency: z.number().int().positive().max(10_000),
    max_task_seconds: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60),
  })
  .strict();

export const AgentCardSchema = z
  .object({
    id: CapabilityIdSchema,
    version: SemverSchema,
    display_name: NonEmptyTextSchema,
    capabilities: z.array(CapabilityIdSchema).min(1).max(256),
    protocols: z
      .array(z.enum(['mcp', 'a2a']))
      .min(1)
      .max(2),
    auth: AgentAuthSchema,
    trust_tier: z.enum(['project', 'company', 'verified', 'community']),
    limits: AgentLimitsSchema,
    card_hash: HashSchema,
  })
  .strict();
export type AgentCard = z.infer<typeof AgentCardSchema>;

export const TaskEnvelopeSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: UuidSchema,
    parent_task_id: UuidSchema.nullable(),
    account_id: UuidSchema,
    project_id: UuidSchema,
    actor_type: z.enum(['user', 'agent', 'system']),
    actor_id: UuidSchema,
    capability_id: CapabilityIdSchema,
    agent_card_hash: HashSchema,
    input_ref: NonEmptyTextSchema,
    idempotency_key: z.string().trim().min(16).max(255),
    deadline_at: DateTimeSchema.nullable(),
    approval: z.enum(['not_required', 'pending', 'approved', 'denied']),
  })
  .strict();
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

const TaskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
]);

export const TaskEventSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    event_id: UuidSchema,
    task_id: UuidSchema,
    sequence: z.number().int().positive(),
    type: z.enum([
      'created',
      'queued',
      'running',
      'progress',
      'asset_created',
      'approval_required',
      'succeeded',
      'failed',
      'cancelled',
    ]),
    status: TaskStatusSchema,
    progress: z.number().finite().min(0).max(1).optional(),
    error_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_.-]{0,127}$/)
      .optional(),
    asset_ids: z.array(UuidSchema).max(64).optional(),
    created_at: DateTimeSchema,
  })
  .strict();
export type TaskEvent = z.infer<typeof TaskEventSchema>;
