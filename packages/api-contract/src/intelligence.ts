import {
  AgentCardSchema,
  CapabilityDescriptorSchema,
  ProtocolVersionSchema,
  TaskEventSchema,
  WORKFLOW_MAX_DEPENDENCIES,
  WORKFLOW_MAX_NODES,
  WorkflowApprovalSchema,
  WorkflowDependencySchema,
  WorkflowEventSchema,
  WorkflowNodeKindSchema,
  WorkflowNodeSchema,
  WorkflowProtocolVersionSchema,
  WorkflowRoleSchema,
  WorkflowRunSchema,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';
import { StudioJobInputSchema } from './studio';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CursorSchema = z.string().trim().min(1).max(256).nullable();

export const IntelligenceErrorCodeSchema = z.enum([
  'INTELLIGENCE_AGENT_CARD_UNAVAILABLE',
  'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
  'INTELLIGENCE_CAPABILITIES_UNAVAILABLE',
  'INTELLIGENCE_CAPABILITY_UNAVAILABLE',
  'INTELLIGENCE_DISCOVERY_INVALID',
  'INTELLIGENCE_DISCOVERY_TOO_LARGE',
  'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
  'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
  'INTELLIGENCE_ESTIMATE_INVALID',
  'INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED',
  'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
  'INTELLIGENCE_PROTOCOL_ERROR',
  'INTELLIGENCE_PROTOCOL_UNSUPPORTED',
  'INTELLIGENCE_REQUEST_FAILED',
  'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE',
  'INTELLIGENCE_TASK_EXECUTION_FAILED',
  'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
  'INTELLIGENCE_TASK_LOOKUP_UNAVAILABLE',
  'INTELLIGENCE_VALIDATION_ERROR',
  'INTELLIGENCE_WORKFLOW_CONFLICT',
  'INTELLIGENCE_WORKFLOW_UNAVAILABLE',
  'INTELLIGENCE_WORKFLOW_UNTRUSTED',
  'INTELLIGENCE_WORKFLOW_VALIDATION_ERROR',
]);
export type IntelligenceErrorCode = z.infer<typeof IntelligenceErrorCodeSchema>;
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
const UNSAFE_WORKFLOW_SECRET_TEXT_PATTERN =
  /(?:api[_-]?key|secret|password|credential|authorization|access[_-]?token)\s*[:=]|\bbearer\s+[A-Za-z0-9._-]{8,}/i;
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

export const IntelligenceEstimateApprovalSchema = z
  .object({
    estimate_id: z.string().uuid(),
    estimate_token: z.string().trim().min(1).max(8192),
    max_approved_credits: z.number().finite().nonnegative().max(1_000_000),
  })
  .strict();
export type IntelligenceEstimateApproval = z.infer<typeof IntelligenceEstimateApprovalSchema>;

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
    estimate_approval: IntelligenceEstimateApprovalSchema.optional(),
  })
  .strict();
export type IntelligenceCreateTaskRequest = z.infer<typeof IntelligenceCreateTaskRequestSchema>;

const WorkflowSha256HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const WorkflowVersionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const WorkflowNodeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/);
const WorkflowReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_.-]{0,127}$/);
const WorkflowPayloadSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (Object.keys(value).length > 128 || encodedJsonSize(value) > 1024 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workflow payload exceeds the public request limit',
    });
    return;
  }
  if (hasUnsafeWorkflowPayload(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workflow payload cannot contain credentials or provider URLs',
    });
  }
});

const IntelligenceWorkflowStartRequestShape = {
  protocol_version: WorkflowProtocolVersionSchema,
  idempotency_key: z.string().trim().min(16).max(255),
  goal: z.string().trim().min(1).max(16_384),
  context_asset_ids: z.array(z.string().uuid()).max(64),
  policy_snapshot_hash: WorkflowSha256HashSchema.nullable(),
  evaluation_version: WorkflowVersionIdSchema.nullable(),
  max_nodes: z.number().int().positive().max(WORKFLOW_MAX_NODES),
  max_dependencies: z.number().int().nonnegative().max(WORKFLOW_MAX_DEPENDENCIES),
  max_approved_credits: z.number().finite().nonnegative().max(1_000_000),
  deadline_at: z.string().datetime({ offset: true }).nullable(),
} as const;

function rejectUnsafeWorkflowGoal(value: { goal: string }, context: z.RefinementCtx): void {
  if (hasUnsafeWorkflowPayload(value.goal)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workflow goal cannot contain provider URLs',
      path: ['goal'],
    });
  }
}

export const IntelligenceWorkflowStartRequestSchema = z
  .object(IntelligenceWorkflowStartRequestShape)
  .strict()
  .superRefine(rejectUnsafeWorkflowGoal);
export type IntelligenceWorkflowStartRequest = z.infer<
  typeof IntelligenceWorkflowStartRequestSchema
>;

const IntelligenceWorkflowNodeInputSchema = z
  .object({
    node_id: z.string().uuid(),
    node_key: WorkflowNodeKeySchema,
    role: WorkflowRoleSchema,
    kind: WorkflowNodeKindSchema,
    agent_name: z.string().trim().min(1).max(255).nullable(),
    agent_card_hash: HashSchema.nullable(),
    capability_id: z.literal('studio.image.generate').nullable(),
    capability_version: z.literal('1.0.0').nullable(),
    policy_snapshot_hash: WorkflowSha256HashSchema.nullable(),
    evaluation_version: WorkflowVersionIdSchema.nullable(),
    deadline_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((node, context) => {
    const capabilityIdentity =
      node.capability_id === 'studio.image.generate' && node.capability_version === '1.0.0';
    if ((node.kind === 'capability') !== capabilityIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workflow capability identity does not match node kind',
        path: ['kind'],
      });
    }
    const agentIdentity = node.agent_name !== null && node.agent_card_hash !== null;
    if ((node.kind !== 'approval') !== agentIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workflow Agent identity does not match node kind',
        path: ['agent_name'],
      });
    }
  });

export const IntelligenceWorkflowAppendNodeRequestSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    sender_card_hash: HashSchema,
    expected_graph_version: z.number().int().nonnegative(),
    idempotency_key: z.string().trim().min(16).max(255),
    node: IntelligenceWorkflowNodeInputSchema,
    payload: WorkflowPayloadSchema,
  })
  .strict();
export type IntelligenceWorkflowAppendNodeRequest = z.infer<
  typeof IntelligenceWorkflowAppendNodeRequestSchema
>;

export const IntelligenceWorkflowAddDependencyRequestSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    sender_card_hash: HashSchema,
    expected_graph_version: z.number().int().nonnegative(),
    dependency_id: z.string().uuid(),
    node_id: z.string().uuid(),
    depends_on_node_id: z.string().uuid(),
    condition: z.enum(['on_success', 'on_completion']),
  })
  .strict();
export type IntelligenceWorkflowAddDependencyRequest = z.infer<
  typeof IntelligenceWorkflowAddDependencyRequestSchema
>;

export const IntelligenceWorkflowSealRequestSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    sender_card_hash: HashSchema,
    expected_graph_version: z.number().int().nonnegative(),
  })
  .strict();
export type IntelligenceWorkflowSealRequest = z.infer<typeof IntelligenceWorkflowSealRequestSchema>;

export const IntelligenceWorkflowCancelRequestSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    reason_code: WorkflowReasonCodeSchema,
  })
  .strict();
export type IntelligenceWorkflowCancelRequest = z.infer<
  typeof IntelligenceWorkflowCancelRequestSchema
>;

export const IntelligenceWorkflowApprovalDecisionRequestSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    decision: z.enum(['approve', 'reject', 'changes_requested']),
    feedback_hash: WorkflowSha256HashSchema.nullable(),
  })
  .strict();
export type IntelligenceWorkflowApprovalDecisionRequest = z.infer<
  typeof IntelligenceWorkflowApprovalDecisionRequestSchema
>;

export const IntelligenceWorkflowStartResponseSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    run: WorkflowRunSchema,
    created: z.boolean(),
  })
  .strict();
export type IntelligenceWorkflowStartResponse = z.infer<
  typeof IntelligenceWorkflowStartResponseSchema
>;

export const IntelligenceWorkflowRunResponseSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    run: WorkflowRunSchema,
  })
  .strict();
export type IntelligenceWorkflowRunResponse = z.infer<typeof IntelligenceWorkflowRunResponseSchema>;

export const IntelligenceWorkflowNodeResponseSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    node: WorkflowNodeSchema,
    created: z.boolean(),
    graph_version: z.number().int().nonnegative(),
  })
  .strict();
export type IntelligenceWorkflowNodeResponse = z.infer<
  typeof IntelligenceWorkflowNodeResponseSchema
>;

export const IntelligenceWorkflowDependencyResponseSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    dependency: WorkflowDependencySchema,
    created: z.boolean(),
    graph_version: z.number().int().nonnegative(),
  })
  .strict();
export type IntelligenceWorkflowDependencyResponse = z.infer<
  typeof IntelligenceWorkflowDependencyResponseSchema
>;

export const IntelligenceWorkflowEventsResponseSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    run_id: z.string().uuid(),
    items: z.array(WorkflowEventSchema).max(100),
    next_cursor: CursorSchema,
  })
  .strict();
export type IntelligenceWorkflowEventsResponse = z.infer<
  typeof IntelligenceWorkflowEventsResponseSchema
>;

export const IntelligenceWorkflowApprovalDecisionResponseSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    run: WorkflowRunSchema,
    node: WorkflowNodeSchema,
    approval: WorkflowApprovalSchema,
  })
  .strict();
export type IntelligenceWorkflowApprovalDecisionResponse = z.infer<
  typeof IntelligenceWorkflowApprovalDecisionResponseSchema
>;

const IntelligenceA2ARequestIdSchema = z.union([
  z.string().trim().min(1).max(256),
  z.number().int().finite(),
]);
const IntelligenceA2AMessageSendEnvelopeParamsSchema = z
  .object({
    sender_card_hash: HashSchema,
    task: z.unknown(),
  })
  .strict();

export const IntelligenceA2AMessageSendEnvelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: IntelligenceA2ARequestIdSchema,
    method: z.literal('message/send'),
    params: IntelligenceA2AMessageSendEnvelopeParamsSchema,
  })
  .strict();
export type IntelligenceA2AMessageSendEnvelope = z.infer<
  typeof IntelligenceA2AMessageSendEnvelopeSchema
>;

export const IntelligenceA2AMessageSendRequestSchema =
  IntelligenceA2AMessageSendEnvelopeSchema.extend({
    params: IntelligenceA2AMessageSendEnvelopeParamsSchema.extend({
      task: IntelligenceCreateTaskRequestSchema,
    }).strict(),
  }).strict();
export type IntelligenceA2AMessageSendRequest = z.infer<
  typeof IntelligenceA2AMessageSendRequestSchema
>;

const IntelligenceWorkflowA2ATaskRequestSchema = z
  .object({
    ...IntelligenceWorkflowStartRequestShape,
    parent_task_id: z.string().uuid().nullable(),
  })
  .strict()
  .superRefine(rejectUnsafeWorkflowGoal);

export const IntelligenceWorkflowA2AMessageSendRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: IntelligenceA2ARequestIdSchema,
    method: z.literal('message/send'),
    params: z
      .object({
        sender_card_hash: HashSchema,
        task: IntelligenceWorkflowA2ATaskRequestSchema,
      })
      .strict(),
  })
  .strict();
export type IntelligenceWorkflowA2AMessageSendRequest = z.infer<
  typeof IntelligenceWorkflowA2AMessageSendRequestSchema
>;

export const IntelligenceTaskResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: z.string().uuid(),
    job_id: z.string().uuid(),
    created: z.boolean(),
  })
  .strict();
export type IntelligenceTaskResponse = z.infer<typeof IntelligenceTaskResponseSchema>;

export const IntelligenceTaskLookupResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: z.string().uuid(),
    job_id: z.string().uuid(),
  })
  .strict();
export type IntelligenceTaskLookupResponse = z.infer<typeof IntelligenceTaskLookupResponseSchema>;

export const IntelligenceTaskEventsResponseSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: z.string().uuid(),
    items: z.array(TaskEventSchema).max(1024),
    next_cursor: CursorSchema,
  })
  .strict();
export type IntelligenceTaskEventsResponse = z.infer<typeof IntelligenceTaskEventsResponseSchema>;

export const IntelligenceA2ATaskStateSchema = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]);
export type IntelligenceA2ATaskState = z.infer<typeof IntelligenceA2ATaskStateSchema>;

export const IntelligenceWorkflowA2ATaskResponseSchema = z
  .object({
    id: z.string().uuid(),
    contextId: z.string().uuid(),
    status: z
      .object({
        state: IntelligenceA2ATaskStateSchema,
        timestamp: z.string().datetime({ offset: true }),
      })
      .strict(),
    metadata: z
      .object({
        parent_task_id: z.string().uuid().nullable(),
        graph_version: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type IntelligenceWorkflowA2ATaskResponse = z.infer<
  typeof IntelligenceWorkflowA2ATaskResponseSchema
>;

export const IntelligenceA2ATaskResponseSchema = z
  .object({
    id: z.string().uuid(),
    contextId: z.string().uuid(),
    status: z
      .object({
        state: IntelligenceA2ATaskStateSchema,
        timestamp: z.string().datetime({ offset: true }),
      })
      .strict(),
    metadata: z
      .object({
        job_id: z.string().uuid().optional(),
        events: z.array(TaskEventSchema).max(1024).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IntelligenceA2ATaskResponse = z.infer<typeof IntelligenceA2ATaskResponseSchema>;

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

function hasUnsafeWorkflowPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasUnsafePublicPayload(value) || UNSAFE_WORKFLOW_SECRET_TEXT_PATTERN.test(value);
  }
  if (Array.isArray(value)) return value.some(hasUnsafeWorkflowPayload);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, nested]) => SENSITIVE_PUBLIC_KEY_PATTERN.test(key) || hasUnsafeWorkflowPayload(nested),
  );
}

function encodedJsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
