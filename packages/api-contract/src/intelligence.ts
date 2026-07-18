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
const StrictStudioJobInputSchema = z
  .object({
    capability: z.literal('image.generate'),
    image: z.unknown(),
  })
  .strict()
  .and(StudioJobInputSchema);

export const IntelligenceCapabilitiesResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    items: z.array(CapabilityDescriptorSchema).max(256),
    next_cursor: CursorSchema,
  })
  .strict();
export type IntelligenceCapabilitiesResponse = z.infer<
  typeof IntelligenceCapabilitiesResponseSchema
>;

export const IntelligenceAgentCardResponseSchema = AgentCardSchema;
export type IntelligenceAgentCardResponse = z.infer<typeof IntelligenceAgentCardResponseSchema>;

export const IntelligenceCreateTaskRequestSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    capability_id: z.literal('studio.image.generate'),
    agent_card_hash: HashSchema,
    provider_config_id: z.string().uuid(),
    model: z.string().trim().min(1).max(255),
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
