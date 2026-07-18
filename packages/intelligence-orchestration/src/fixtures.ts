import {
  type WorkflowApproval,
  WorkflowApprovalSchema,
  type WorkflowDependency,
  WorkflowDependencySchema,
  type WorkflowEvent,
  WorkflowEventSchema,
  type WorkflowNode,
  WorkflowNodeSchema,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@kortix/intelligence-contracts';

const RUN_ID = '61000000-0000-4000-a000-000000000001';
const NODE_ID = '62000000-0000-4000-a000-000000000001';
const PARENT_NODE_ID = '62000000-0000-4000-a000-000000000002';
const ACCOUNT_ID = '63000000-0000-4000-a000-000000000001';
const PROJECT_ID = '64000000-0000-4000-a000-000000000001';
const ACTOR_ID = '65000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);
const SHA256_HASH = `sha256:${CARD_HASH}`;
const NOW = '2026-07-18T10:00:00.000Z';

export function workflowRunFixture(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return WorkflowRunSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    run_id: RUN_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_type: 'agent',
    actor_id: ACTOR_ID,
    agent_name: 'content-planner',
    idempotency_key: 'workflow-fixture-run-0001',
    request_hash: SHA256_HASH,
    status: 'draft',
    graph_version: 0,
    policy_snapshot_hash: null,
    evaluation_version: null,
    max_nodes: 128,
    max_dependencies: 256,
    max_approved_credits: 5,
    deadline_at: null,
    created_at: NOW,
    updated_at: NOW,
    terminal_at: null,
    ...overrides,
  });
}

export function workflowNodeFixture(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return WorkflowNodeSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    node_id: NODE_ID,
    run_id: RUN_ID,
    node_key: 'render-primary',
    role: 'executor',
    kind: 'capability',
    agent_name: 'image-executor',
    agent_card_hash: CARD_HASH,
    capability_id: 'studio.image.generate',
    capability_version: '1.0.0',
    input_hash: SHA256_HASH,
    policy_snapshot_hash: null,
    evaluation_version: null,
    task_id: null,
    status: 'pending',
    attempt_count: 0,
    deadline_at: null,
    created_at: NOW,
    updated_at: NOW,
    terminal_at: null,
    ...overrides,
  });
}

export function workflowDependencyFixture(
  overrides: Partial<WorkflowDependency> = {},
): WorkflowDependency {
  return WorkflowDependencySchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    dependency_id: '66000000-0000-4000-a000-000000000001',
    run_id: RUN_ID,
    node_id: NODE_ID,
    depends_on_node_id: PARENT_NODE_ID,
    condition: 'on_success',
    created_at: NOW,
    ...overrides,
  });
}

export function workflowApprovalFixture(
  overrides: Partial<WorkflowApproval> = {},
): WorkflowApproval {
  return WorkflowApprovalSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    approval_id: '67000000-0000-4000-a000-000000000001',
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
    requested_at: NOW,
    resolved_at: null,
    ...overrides,
  });
}

export function workflowEventFixture(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return WorkflowEventSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    event_id: '68000000-0000-4000-a000-000000000001',
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
    created_at: NOW,
    ...overrides,
  });
}
