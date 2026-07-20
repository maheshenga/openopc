import { z } from 'zod';
import { hasUnsafeCatalogCredentialLiteral } from './capability-catalog.js';
import { TaskEventSchema, WorkflowRunStatusSchema } from './schemas.js';

const OpenOpcAgUiIdSchema = z.string().uuid();
export const OpenOpcAgUiCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_.-]{0,127}$/)
  .refine((value) => !hasUnsafeCatalogCredentialLiteral(value), {
    message: 'AG-UI code contains a credential literal',
  });
const UnsafeAgUiTextPattern =
  /(?:https?:\/\/|["']?\s*(?:prompt|payload(?:[_-]?ref)?|api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz|(?:raw(?:[_-](?:provider|request|response))*|provider(?:[_-](?:request|response))?)[_-](?:body|payload)|headers?)\s*["']?\s*[:=]|\b(?:chain[- ]?of[- ]?thought|reasoning)\b)/i;

function publicAgUiText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !UnsafeAgUiTextPattern.test(value) && !hasUnsafeCatalogCredentialLiteral(value),
      { message: 'AG-UI text contains a private value' },
    );
}

const OpenOpcAgUiStatusSchema = z.union([TaskEventSchema.shape.status, WorkflowRunStatusSchema]);

export const OpenOpcAgUiStateSnapshotSchema = z
  .object({
    stage: publicAgUiText(128),
    run_id: OpenOpcAgUiIdSchema.optional(),
    node_id: OpenOpcAgUiIdSchema.optional(),
    task_id: OpenOpcAgUiIdSchema.optional(),
    status: OpenOpcAgUiStatusSchema.optional(),
    progress: z.number().finite().min(0).max(1).optional(),
    approval: z.enum(['required', 'resolved']).optional(),
    reason_code: OpenOpcAgUiCodeSchema.optional(),
    asset_ids: z.array(OpenOpcAgUiIdSchema).max(64).optional(),
  })
  .strict();
export type OpenOpcAgUiStateSnapshot = z.infer<typeof OpenOpcAgUiStateSnapshotSchema>;

export const OpenOpcAgUiResultSchema = z
  .object({ asset_ids: z.array(OpenOpcAgUiIdSchema).max(64) })
  .strict();
export type OpenOpcAgUiResult = z.infer<typeof OpenOpcAgUiResultSchema>;

/**
 * A local, strict subset of the published AG-UI wire events. Keeping this
 * contract local prevents an upstream package upgrade from changing our
 * project event boundary.
 */
export const OpenOpcAgUiEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('RUN_STARTED'),
      threadId: OpenOpcAgUiIdSchema,
      runId: OpenOpcAgUiIdSchema,
    })
    .strict(),
  z.object({ type: z.literal('STEP_STARTED'), stepName: publicAgUiText(256) }).strict(),
  z.object({ type: z.literal('STEP_FINISHED'), stepName: publicAgUiText(256) }).strict(),
  z
    .object({
      type: z.literal('TOOL_CALL_START'),
      toolCallId: OpenOpcAgUiIdSchema,
      toolCallName: publicAgUiText(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('TOOL_CALL_RESULT'),
      toolCallId: OpenOpcAgUiIdSchema,
      messageId: OpenOpcAgUiIdSchema,
      content: publicAgUiText(4096),
    })
    .strict(),
  z
    .object({ type: z.literal('STATE_SNAPSHOT'), snapshot: OpenOpcAgUiStateSnapshotSchema })
    .strict(),
  z
    .object({
      type: z.literal('RUN_FINISHED'),
      threadId: OpenOpcAgUiIdSchema,
      runId: OpenOpcAgUiIdSchema,
      result: OpenOpcAgUiResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('RUN_ERROR'),
      message: publicAgUiText(256),
      code: OpenOpcAgUiCodeSchema.optional(),
    })
    .strict(),
]);
export type OpenOpcAgUiEvent = z.infer<typeof OpenOpcAgUiEventSchema>;
