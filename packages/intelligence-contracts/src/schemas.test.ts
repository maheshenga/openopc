import { describe, expect, test } from 'bun:test';
import {
  AgentCardSchema,
  CapabilityDescriptorSchema,
  TaskEnvelopeSchema,
  TaskEventSchema,
  WorkflowApprovalSchema,
  WorkflowDependencySchema,
  WorkflowEventSchema,
  WorkflowNodeSchema,
  WorkflowPayloadRefSchema,
  WorkflowPlannerProposalSchema,
  WorkflowProposedNodeSchema,
  WorkflowReviewerVerdictSchema,
  WorkflowRunSchema,
} from './schemas';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const TASK_ID = '13000000-0000-4000-a000-000000000001';
const EVENT_ID = '14000000-0000-4000-a000-000000000001';
const ACTOR_ID = '15000000-0000-4000-a000-000000000001';
const RUN_ID = '16000000-0000-4000-a000-000000000001';
const NODE_ID = '17000000-0000-4000-a000-000000000001';
const SECOND_NODE_ID = '17000000-0000-4000-a000-000000000002';
const DEPENDENCY_ID = '18000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '19000000-0000-4000-a000-000000000001';
const WORKFLOW_EVENT_ID = '1a000000-0000-4000-a000-000000000001';
const PROPOSAL_ID = '1b000000-0000-4000-a000-000000000001';
const VERDICT_ID = '1c000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);

const imageCapability = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image' as const,
  operation: 'generate',
  input_schema: { type: 'object' },
  output_schema: { type: 'array' },
  execution: 'async' as const,
  risk: 'write' as const,
  provenance_required: true,
};

const agentCard = {
  id: 'content-planner',
  version: '1.0.0',
  display_name: 'Content Planner',
  capabilities: ['studio.image.generate'],
  protocols: ['mcp', 'a2a'] as const,
  auth: { kind: 'kortix-project-token' as const },
  trust_tier: 'project' as const,
  limits: { concurrency: 2, max_task_seconds: 900 },
  card_hash: CARD_HASH,
};

const taskEnvelope = {
  protocol_version: 'intelligence.v1' as const,
  task_id: TASK_ID,
  parent_task_id: null,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  actor_type: 'agent' as const,
  actor_id: ACTOR_ID,
  capability_id: 'studio.image.generate',
  agent_card_hash: CARD_HASH,
  input_ref: 'studio-job-input',
  idempotency_key: 'task-key-00000001',
  deadline_at: '2026-07-18T12:00:00.000Z',
  approval: 'pending' as const,
};

const taskEvent = {
  protocol_version: 'intelligence.v1' as const,
  event_id: EVENT_ID,
  task_id: TASK_ID,
  sequence: 1,
  type: 'created' as const,
  status: 'queued' as const,
  created_at: '2026-07-18T10:00:00.000Z',
};

const workflowNode = {
  protocol_version: 'intelligence.workflow.v1' as const,
  node_id: NODE_ID,
  run_id: RUN_ID,
  node_key: 'render-primary',
  role: 'executor' as const,
  kind: 'capability' as const,
  agent_name: 'image-executor',
  agent_card_hash: CARD_HASH,
  capability_id: 'studio.image.generate' as const,
  capability_version: '1.0.0' as const,
  input_hash: `sha256:${CARD_HASH}`,
  policy_snapshot_hash: null,
  evaluation_version: null,
  task_id: null,
  status: 'pending' as const,
  attempt_count: 0,
  deadline_at: null,
  created_at: '2026-07-18T10:00:00.000Z',
  updated_at: '2026-07-18T10:00:00.000Z',
  terminal_at: null,
};

describe('intelligence contract schemas', () => {
  test('accepts the first image capability descriptor', () => {
    expect(CapabilityDescriptorSchema.parse(imageCapability).id).toBe('studio.image.generate');
  });

  test('accepts a project Agent Card, task envelope, and task event', () => {
    expect(AgentCardSchema.parse(agentCard).card_hash).toBe(CARD_HASH);
    expect(TaskEnvelopeSchema.parse(taskEnvelope).project_id).toBe(PROJECT_ID);
    expect(TaskEventSchema.parse(taskEvent).sequence).toBe(1);
  });

  test('rejects malformed project identifiers', () => {
    expect(() => TaskEnvelopeSchema.parse({ ...taskEnvelope, project_id: 'project-1' })).toThrow();
  });

  test('rejects an unknown capability modality', () => {
    expect(() =>
      CapabilityDescriptorSchema.parse({ ...imageCapability, modality: 'prompt' }),
    ).toThrow();
  });

  test('rejects a missing or malformed card hash', () => {
    const { card_hash: _cardHash, ...withoutHash } = agentCard;
    expect(() => AgentCardSchema.parse(withoutHash)).toThrow();
    expect(() => AgentCardSchema.parse({ ...agentCard, card_hash: 'not-a-hash' })).toThrow();
  });

  test('rejects an invalid trust tier', () => {
    expect(() => AgentCardSchema.parse({ ...agentCard, trust_tier: 'untrusted' })).toThrow();
  });

  test('rejects unknown top-level keys instead of silently stripping them', () => {
    expect(() =>
      CapabilityDescriptorSchema.parse({ ...imageCapability, secret: 'value' }),
    ).toThrow();
    expect(() => AgentCardSchema.parse({ ...agentCard, token: 'value' })).toThrow();
    expect(() =>
      TaskEnvelopeSchema.parse({ ...taskEnvelope, provider_url: 'https://example.test' }),
    ).toThrow();
  });

  test('accepts a project-scoped workflow run envelope', () => {
    const run = WorkflowRunSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_type: 'agent',
      actor_id: ACTOR_ID,
      agent_name: 'content-planner',
      idempotency_key: 'workflow-run-key-000001',
      request_hash: `sha256:${CARD_HASH}`,
      status: 'draft',
      graph_version: 0,
      policy_snapshot_hash: null,
      evaluation_version: null,
      max_nodes: 128,
      max_dependencies: 256,
      max_approved_credits: 5,
      deadline_at: null,
      created_at: '2026-07-18T10:00:00.000Z',
      updated_at: '2026-07-18T10:00:00.000Z',
      terminal_at: null,
    });

    expect(run).toMatchObject({ run_id: RUN_ID, status: 'draft', graph_version: 0 });
  });

  test('accepts a public executor capability node without a private payload reference', () => {
    const node = WorkflowNodeSchema.parse(workflowNode);

    expect(node).toMatchObject({ node_key: 'render-primary', status: 'pending' });
    expect(node).not.toHaveProperty('input_ref');
  });

  test('rejects a capability node that omits its fixed image capability identity', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        ...workflowNode,
        capability_id: null,
        capability_version: null,
      }),
    ).toThrow();
  });

  test('accepts a same-run workflow dependency envelope', () => {
    expect(
      WorkflowDependencySchema.parse({
        protocol_version: 'intelligence.workflow.v1',
        dependency_id: DEPENDENCY_ID,
        run_id: RUN_ID,
        node_id: SECOND_NODE_ID,
        depends_on_node_id: NODE_ID,
        condition: 'on_success',
        created_at: '2026-07-18T10:00:00.000Z',
      }),
    ).toMatchObject({ node_id: SECOND_NODE_ID, depends_on_node_id: NODE_ID });
  });

  test('accepts a redaction-safe workflow approval envelope', () => {
    const approval = WorkflowApprovalSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      approval_id: APPROVAL_ID,
      run_id: RUN_ID,
      node_id: NODE_ID,
      risk: 'high',
      reason_code: 'WORKFLOW_POLICY_APPROVAL_REQUIRED',
      action_summary: 'Approve image generation',
      status: 'pending',
      review_item_id: null,
      acting_user_id: null,
      decision: null,
      feedback_hash: null,
      requested_at: '2026-07-18T10:00:00.000Z',
      resolved_at: null,
    });

    expect(approval.status).toBe('pending');
    expect(approval).not.toHaveProperty('detail');
  });

  test('rejects a pending workflow approval with a prefilled decision', () => {
    expect(() =>
      WorkflowApprovalSchema.parse({
        protocol_version: 'intelligence.workflow.v1',
        approval_id: APPROVAL_ID,
        run_id: RUN_ID,
        node_id: NODE_ID,
        risk: 'high',
        reason_code: 'WORKFLOW_POLICY_APPROVAL_REQUIRED',
        action_summary: 'Approve image generation',
        status: 'pending',
        review_item_id: null,
        acting_user_id: ACTOR_ID,
        decision: 'approve',
        feedback_hash: null,
        requested_at: '2026-07-18T10:00:00.000Z',
        resolved_at: '2026-07-18T10:01:00.000Z',
      }),
    ).toThrow();
  });

  test('accepts a monotonic redaction-safe workflow event', () => {
    const event = WorkflowEventSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      event_id: WORKFLOW_EVENT_ID,
      run_id: RUN_ID,
      sequence: 1,
      type: 'run_created',
      status: 'draft',
      graph_version: 0,
      node_id: null,
      task_id: null,
      progress: null,
      reason_code: null,
      asset_ids: [],
      route_reason_codes: [],
      evaluation_version: null,
      created_at: '2026-07-18T10:00:00.000Z',
    });

    expect(event).toMatchObject({ sequence: 1, type: 'run_created' });
    expect(event).not.toHaveProperty('payload');
  });

  test('accepts a bounded planner graph proposal as untrusted structured data', () => {
    const proposal = WorkflowPlannerProposalSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      proposal_id: PROPOSAL_ID,
      run_id: RUN_ID,
      planner_agent_name: 'content-planner',
      planner_card_hash: CARD_HASH,
      expected_graph_version: 0,
      nodes: [
        {
          node_key: 'render-primary',
          role: 'executor',
          kind: 'capability',
          agent_name: 'image-executor',
          agent_card_hash: CARD_HASH,
          capability_id: 'studio.image.generate',
          capability_version: '1.0.0',
          input_ref: 'sealed:workflow-input-1',
          input_hash: `sha256:${CARD_HASH}`,
          action_summary: 'Generate the approved image',
          requires_approval: true,
          deadline_at: null,
        },
      ],
      dependencies: [],
      proposal_hash: `sha256:${CARD_HASH}`,
      created_at: '2026-07-18T10:00:00.000Z',
    });

    expect(proposal.nodes).toHaveLength(1);
    expect(proposal.nodes[0]?.capability_id).toBe('studio.image.generate');
  });

  test('accepts only opaque sealed workflow payload references', () => {
    expect(WorkflowPayloadRefSchema.parse('sealed:workflow-input-1')).toBe(
      'sealed:workflow-input-1',
    );
    expect(() => WorkflowPayloadRefSchema.parse('https://storage.example.test/signed')).toThrow();
  });

  test('rejects a planner capability node without the fixed image identity', () => {
    expect(() =>
      WorkflowProposedNodeSchema.parse({
        node_key: 'render-primary',
        role: 'executor',
        kind: 'capability',
        agent_name: 'image-executor',
        agent_card_hash: CARD_HASH,
        capability_id: null,
        capability_version: null,
        input_ref: 'sealed:workflow-input-1',
        input_hash: `sha256:${CARD_HASH}`,
        action_summary: 'Generate the approved image',
        requires_approval: true,
        deadline_at: null,
      }),
    ).toThrow();
  });

  test('accepts a structured reviewer verdict without hidden reasoning', () => {
    const verdict = WorkflowReviewerVerdictSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      verdict_id: VERDICT_ID,
      run_id: RUN_ID,
      node_id: NODE_ID,
      reviewer_agent_name: 'quality-reviewer',
      reviewer_card_hash: CARD_HASH,
      verdict: 'approve',
      reason_codes: ['WORKFLOW_REVIEW_OUTPUT_VALID'],
      feedback_ref: null,
      feedback_hash: null,
      evaluation_version: 'image-golden-v1',
      created_at: '2026-07-18T10:00:00.000Z',
    });

    expect(verdict.verdict).toBe('approve');
    expect(verdict).not.toHaveProperty('reasoning');
  });
});
