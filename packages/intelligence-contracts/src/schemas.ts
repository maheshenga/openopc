import { z } from 'zod';
import { ProtocolVersionSchema, WorkflowProtocolVersionSchema } from './compatibility.js';

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
const Sha256HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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

export const WORKFLOW_MAX_NODES = 128 as const;
export const WORKFLOW_MAX_DEPENDENCIES = 256 as const;

export const WorkflowRunStatusSchema = z.enum([
  'draft',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

const WorkflowVersionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const WorkflowPayloadRefSchema = z
  .string()
  .trim()
  .min(8)
  .max(263)
  .regex(/^sealed:[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type WorkflowPayloadRef = z.infer<typeof WorkflowPayloadRefSchema>;

export const WorkflowRunSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    run_id: UuidSchema,
    account_id: UuidSchema,
    project_id: UuidSchema,
    actor_type: z.enum(['user', 'agent', 'system']),
    actor_id: UuidSchema.nullable(),
    agent_name: NonEmptyTextSchema.nullable(),
    idempotency_key: z.string().trim().min(16).max(255),
    request_hash: Sha256HashSchema,
    status: WorkflowRunStatusSchema,
    graph_version: z.number().int().nonnegative(),
    policy_snapshot_hash: Sha256HashSchema.nullable(),
    evaluation_version: WorkflowVersionIdSchema.nullable(),
    max_nodes: z.number().int().positive().max(WORKFLOW_MAX_NODES),
    max_dependencies: z.number().int().nonnegative().max(WORKFLOW_MAX_DEPENDENCIES),
    max_approved_credits: z.number().finite().nonnegative().max(1_000_000),
    deadline_at: DateTimeSchema.nullable(),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
    terminal_at: DateTimeSchema.nullable(),
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const WorkflowRoleSchema = z.enum(['planner', 'executor', 'reviewer', 'system']);
export type WorkflowRole = z.infer<typeof WorkflowRoleSchema>;

export const WorkflowNodeKindSchema = z.enum(['agent', 'capability', 'approval']);
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKindSchema>;

export const WorkflowNodeStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;

const WorkflowNodeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/);

function requireCapabilityNodeIdentity(
  node: {
    kind: z.infer<typeof WorkflowNodeKindSchema>;
    capability_id: 'studio.image.generate' | null;
    capability_version: '1.0.0' | null;
  },
  context: z.RefinementCtx,
): void {
  if (
    node.kind === 'capability' &&
    (node.capability_id !== 'studio.image.generate' || node.capability_version !== '1.0.0')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'capability node identity is required',
      path: ['capability_id'],
    });
  }
}

export const WorkflowNodeSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    node_id: UuidSchema,
    run_id: UuidSchema,
    node_key: WorkflowNodeKeySchema,
    role: WorkflowRoleSchema,
    kind: WorkflowNodeKindSchema,
    agent_name: NonEmptyTextSchema.nullable(),
    agent_card_hash: HashSchema.nullable(),
    capability_id: z.literal('studio.image.generate').nullable(),
    capability_version: z.literal('1.0.0').nullable(),
    input_hash: Sha256HashSchema,
    policy_snapshot_hash: Sha256HashSchema.nullable(),
    evaluation_version: WorkflowVersionIdSchema.nullable(),
    task_id: UuidSchema.nullable(),
    status: WorkflowNodeStatusSchema,
    attempt_count: z.number().int().nonnegative().max(1_000),
    deadline_at: DateTimeSchema.nullable(),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
    terminal_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine(requireCapabilityNodeIdentity);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowDependencySchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    dependency_id: UuidSchema,
    run_id: UuidSchema,
    node_id: UuidSchema,
    depends_on_node_id: UuidSchema,
    condition: z.enum(['on_success', 'on_completion']),
    created_at: DateTimeSchema,
  })
  .strict();
export type WorkflowDependency = z.infer<typeof WorkflowDependencySchema>;

const WorkflowReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_.-]{0,127}$/);

export const WorkflowApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);
export type WorkflowApprovalStatus = z.infer<typeof WorkflowApprovalStatusSchema>;

export const WorkflowApprovalSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    approval_id: UuidSchema,
    run_id: UuidSchema,
    node_id: UuidSchema,
    risk: z.enum(['none', 'low', 'medium', 'high']),
    reason_code: WorkflowReasonCodeSchema,
    action_summary: NonEmptyTextSchema,
    status: WorkflowApprovalStatusSchema,
    review_item_id: UuidSchema.nullable(),
    acting_user_id: UuidSchema.nullable(),
    decision: z.enum(['approve', 'reject', 'changes_requested']).nullable(),
    feedback_hash: Sha256HashSchema.nullable(),
    requested_at: DateTimeSchema,
    resolved_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (
      approval.status === 'pending' &&
      (approval.acting_user_id !== null ||
        approval.decision !== null ||
        approval.feedback_hash !== null ||
        approval.resolved_at !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pending workflow approval cannot be resolved',
        path: ['status'],
      });
    }
  });
export type WorkflowApproval = z.infer<typeof WorkflowApprovalSchema>;

export const WorkflowEventTypeSchema = z.enum([
  'run_created',
  'node_appended',
  'dependency_added',
  'graph_sealed',
  'run_started',
  'node_ready',
  'node_started',
  'node_waiting_approval',
  'approval_resolved',
  'route_selected',
  'task_attached',
  'node_succeeded',
  'node_failed',
  'node_skipped',
  'run_succeeded',
  'run_failed',
  'run_cancelled',
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const WorkflowEventSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    event_id: UuidSchema,
    run_id: UuidSchema,
    sequence: z.number().int().positive(),
    type: WorkflowEventTypeSchema,
    status: WorkflowRunStatusSchema,
    graph_version: z.number().int().nonnegative(),
    node_id: UuidSchema.nullable(),
    task_id: UuidSchema.nullable(),
    progress: z.number().finite().min(0).max(1).nullable(),
    reason_code: WorkflowReasonCodeSchema.nullable(),
    asset_ids: z.array(UuidSchema).max(64),
    route_reason_codes: z.array(WorkflowReasonCodeSchema).max(16),
    evaluation_version: WorkflowVersionIdSchema.nullable(),
    created_at: DateTimeSchema,
  })
  .strict();
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const WorkflowProposedNodeSchema = z
  .object({
    node_key: WorkflowNodeKeySchema,
    role: WorkflowRoleSchema,
    kind: WorkflowNodeKindSchema,
    agent_name: NonEmptyTextSchema.nullable(),
    agent_card_hash: HashSchema.nullable(),
    capability_id: z.literal('studio.image.generate').nullable(),
    capability_version: z.literal('1.0.0').nullable(),
    input_ref: WorkflowPayloadRefSchema,
    input_hash: Sha256HashSchema,
    action_summary: NonEmptyTextSchema,
    requires_approval: z.boolean(),
    deadline_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine(requireCapabilityNodeIdentity);
export type WorkflowProposedNode = z.infer<typeof WorkflowProposedNodeSchema>;

const WorkflowProposedDependencySchema = z
  .object({
    node_key: WorkflowNodeKeySchema,
    depends_on_node_key: WorkflowNodeKeySchema,
    condition: z.enum(['on_success', 'on_completion']),
  })
  .strict();

export const WorkflowPlannerProposalSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    proposal_id: UuidSchema,
    run_id: UuidSchema,
    planner_agent_name: NonEmptyTextSchema,
    planner_card_hash: HashSchema,
    expected_graph_version: z.number().int().nonnegative(),
    nodes: z.array(WorkflowProposedNodeSchema).min(1).max(WORKFLOW_MAX_NODES),
    dependencies: z.array(WorkflowProposedDependencySchema).max(WORKFLOW_MAX_DEPENDENCIES),
    proposal_hash: Sha256HashSchema,
    created_at: DateTimeSchema,
  })
  .strict();
export type WorkflowPlannerProposal = z.infer<typeof WorkflowPlannerProposalSchema>;

export const WorkflowReviewerVerdictSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    verdict_id: UuidSchema,
    run_id: UuidSchema,
    node_id: UuidSchema,
    reviewer_agent_name: NonEmptyTextSchema,
    reviewer_card_hash: HashSchema,
    verdict: z.enum(['approve', 'reject', 'changes_requested']),
    reason_codes: z.array(WorkflowReasonCodeSchema).min(1).max(16),
    feedback_ref: WorkflowPayloadRefSchema.nullable(),
    feedback_hash: Sha256HashSchema.nullable(),
    evaluation_version: WorkflowVersionIdSchema.nullable(),
    created_at: DateTimeSchema,
  })
  .strict();
export type WorkflowReviewerVerdict = z.infer<typeof WorkflowReviewerVerdictSchema>;

export const IntelligenceEvaluationScorerIdSchema = z.enum([
  'image.schema_validity',
  'image.integrity',
  'image.safety',
  'system.latency',
  'system.availability',
  'system.failure',
  'system.retry',
  'system.cost',
  'human.image_quality',
]);
export type IntelligenceEvaluationScorerId = z.infer<
  typeof IntelligenceEvaluationScorerIdSchema
>;

const IntelligenceEvaluationScorerVersionSchema = z
  .object({
    scorer_id: IntelligenceEvaluationScorerIdSchema,
    version: SemverSchema,
  })
  .strict();

const FixedPointRateSchema = z.number().int().min(0).max(1_000_000);

export const IntelligenceEvaluationSuiteSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    suite_id: UuidSchema,
    suite_version: WorkflowVersionIdSchema,
    account_id: UuidSchema,
    project_id: UuidSchema,
    capability_id: z.literal('studio.image.generate'),
    capability_version: z.literal('1.0.0'),
    dataset_manifest_hash: Sha256HashSchema,
    dataset_ref: WorkflowPayloadRefSchema,
    scorer_versions: z.array(IntelligenceEvaluationScorerVersionSchema).min(1).max(32),
    thresholds: z
      .object({
        minimum_schema_valid_rate_ppm: FixedPointRateSchema,
        minimum_integrity_rate_ppm: FixedPointRateSchema,
        minimum_safety_rate_ppm: FixedPointRateSchema,
        minimum_human_approval_rate_ppm: FixedPointRateSchema,
        maximum_failure_rate_ppm: FixedPointRateSchema,
      })
      .strict(),
    minimum_sample_count: z.number().int().positive().max(10_000),
    confidence_level_bps: z.number().int().positive().max(10_000),
    status: z.enum(['draft', 'published', 'retired']),
    created_at: DateTimeSchema,
    published_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((suite, context) => {
    const scorerIds = suite.scorer_versions.map((scorer) => scorer.scorer_id);
    if (new Set(scorerIds).size !== scorerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation scorer ids must be unique',
        path: ['scorer_versions'],
      });
    }
    if ((suite.status === 'draft') !== (suite.published_at === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation suite publication state is inconsistent',
        path: ['published_at'],
      });
    }
  });
export type IntelligenceEvaluationSuite = z.infer<typeof IntelligenceEvaluationSuiteSchema>;

const EvaluationMicreditsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const IntelligenceEvaluationRunSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    evaluation_run_id: UuidSchema,
    suite_id: UuidSchema,
    suite_version: WorkflowVersionIdSchema,
    account_id: UuidSchema,
    project_id: UuidSchema,
    idempotency_key: z.string().trim().min(16).max(255),
    request_hash: Sha256HashSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    budget_micredits: EvaluationMicreditsSchema.positive(),
    max_samples: z.number().int().positive().max(10_000),
    processed_samples: z.number().int().nonnegative().max(10_000),
    spent_micredits: EvaluationMicreditsSchema,
    failure_code: WorkflowReasonCodeSchema.nullable(),
    started_at: DateTimeSchema.nullable(),
    completed_at: DateTimeSchema.nullable(),
    created_at: DateTimeSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.processed_samples > run.max_samples || run.spent_micredits > run.budget_micredits) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation run exceeded its declared budget',
        path: ['processed_samples'],
      });
    }
    const validState =
      (run.status === 'queued' &&
        run.started_at === null &&
        run.completed_at === null &&
        run.processed_samples === 0 &&
        run.spent_micredits === 0 &&
        run.failure_code === null) ||
      (run.status === 'running' &&
        run.started_at !== null &&
        run.completed_at === null &&
        run.failure_code === null) ||
      (run.status === 'succeeded' &&
        run.started_at !== null &&
        run.completed_at !== null &&
        run.failure_code === null) ||
      (run.status === 'failed' &&
        run.started_at !== null &&
        run.completed_at !== null &&
        run.failure_code !== null) ||
      (run.status === 'cancelled' && run.completed_at !== null && run.failure_code === null);
    if (!validState) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation run lifecycle is inconsistent',
        path: ['status'],
      });
    }
  });
export type IntelligenceEvaluationRun = z.infer<typeof IntelligenceEvaluationRunSchema>;

const IntelligenceEvaluationMetricsSchema = z
  .object({
    schema_valid_rate_ppm: FixedPointRateSchema,
    integrity_rate_ppm: FixedPointRateSchema,
    safety_rate_ppm: FixedPointRateSchema,
    availability_rate_ppm: FixedPointRateSchema,
    failure_rate_ppm: FixedPointRateSchema,
    retry_rate_ppm: FixedPointRateSchema,
    human_approval_rate_ppm: FixedPointRateSchema,
    latency_p50_ms: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1_000),
    latency_p95_ms: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1_000),
    mean_cost_micredits: EvaluationMicreditsSchema,
    total_cost_micredits: EvaluationMicreditsSchema,
  })
  .strict();
export type IntelligenceEvaluationMetrics = z.infer<
  typeof IntelligenceEvaluationMetricsSchema
>;

export const IntelligenceModelEvaluationSnapshotSchema = z
  .object({
    protocol_version: WorkflowProtocolVersionSchema,
    snapshot_id: UuidSchema,
    snapshot_version: WorkflowVersionIdSchema,
    evaluation_run_id: UuidSchema,
    suite_id: UuidSchema,
    suite_version: WorkflowVersionIdSchema,
    account_id: UuidSchema,
    project_id: UuidSchema,
    candidate_hash: Sha256HashSchema,
    capability_id: z.literal('studio.image.generate'),
    capability_version: z.literal('1.0.0'),
    sample_count: z.number().int().positive().max(10_000),
    minimum_sample_count: z.number().int().positive().max(10_000),
    meets_minimum_samples: z.boolean(),
    confidence: z
      .object({
        method: z.enum(['wilson', 'none']),
        level_bps: z.number().int().positive().max(10_000),
        lower_bound_ppm: FixedPointRateSchema,
        upper_bound_ppm: FixedPointRateSchema,
      })
      .strict(),
    metrics: IntelligenceEvaluationMetricsSchema,
    scorer_versions: z.array(IntelligenceEvaluationScorerVersionSchema).min(1).max(32),
    published_at: DateTimeSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.meets_minimum_samples !== (snapshot.sample_count >= snapshot.minimum_sample_count)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation sample sufficiency is inconsistent',
        path: ['meets_minimum_samples'],
      });
    }
    if (snapshot.confidence.lower_bound_ppm > snapshot.confidence.upper_bound_ppm) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation confidence interval is invalid',
        path: ['confidence'],
      });
    }
    if (snapshot.metrics.latency_p50_ms > snapshot.metrics.latency_p95_ms) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation latency percentiles are invalid',
        path: ['metrics'],
      });
    }
    const scorerIds = snapshot.scorer_versions.map((scorer) => scorer.scorer_id);
    if (new Set(scorerIds).size !== scorerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation scorer ids must be unique',
        path: ['scorer_versions'],
      });
    }
  });
export type IntelligenceModelEvaluationSnapshot = z.infer<
  typeof IntelligenceModelEvaluationSnapshotSchema
>;
