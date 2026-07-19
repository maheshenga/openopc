import { expect, test } from 'bun:test';
import type { CapabilityDescriptor, WorkflowPlannerProposal } from '@kortix/intelligence-contracts';
import { createWorkflowPlanner } from './planner';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const PLANNER_HASH = 'a'.repeat(64);
const EXECUTOR_HASH = 'b'.repeat(64);
const INPUT_HASH = `sha256:${'c'.repeat(64)}`;

const imageCapability: CapabilityDescriptor = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image',
  operation: 'generate',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  execution: 'async',
  risk: 'write',
  provenance_required: true,
};

const proposal: WorkflowPlannerProposal = {
  protocol_version: 'intelligence.workflow.v1',
  proposal_id: PROPOSAL_ID,
  run_id: RUN_ID,
  planner_agent_name: 'content-planner',
  planner_card_hash: PLANNER_HASH,
  expected_graph_version: 0,
  nodes: [
    {
      node_key: 'generate-hero-image',
      role: 'executor',
      kind: 'capability',
      agent_name: 'image-executor',
      agent_card_hash: EXECUTOR_HASH,
      capability_id: 'studio.image.generate',
      capability_version: '1.0.0',
      input_ref: 'sealed:planner-output-1',
      input_hash: INPUT_HASH,
      action_summary: 'Generate the approved hero image',
      requires_approval: true,
      deadline_at: null,
    },
  ],
  dependencies: [],
  proposal_hash: `sha256:${'d'.repeat(64)}`,
  created_at: '2026-07-19T00:00:00.000Z',
};

test('returns only a strictly parsed and authorized bounded planner proposal', async () => {
  const calls: string[] = [];
  let invocationContext: unknown;
  const planner = createWorkflowPlanner({
    invokeAgent: {
      invoke: async (input) => {
        calls.push('invoke');
        invocationContext = input.context;
        return proposal;
      },
    },
    authorizeNode: async ({ node }) => {
      calls.push(`authorize:${node.node_key}`);
      return true;
    },
  });

  const result = await planner.plan({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    binding: { role: 'planner', agentName: 'content-planner', cardHash: PLANNER_HASH },
    context: {
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      expected_graph_version: 0,
      capabilities: [imageCapability],
      agents: [
        { name: 'content-planner', card_hash: PLANNER_HASH },
        { name: 'image-executor', card_hash: EXECUTOR_HASH },
      ],
      asset_ids: [],
      limits: {
        max_nodes: 128,
        max_dependencies: 256,
        max_approved_credits: 100,
        deadline_at: null,
      },
      evaluation_summaries: [],
    },
  });

  expect(calls).toEqual(['invoke', 'authorize:generate-hero-image']);
  expect(result).toEqual(proposal);
  expect(JSON.stringify(invocationContext)).not.toMatch(
    /chain.of.thought|reasoning|credential|authorization|provider_url|signed_url/i,
  );
});

test('rejects an oversized planner context before invoking an Agent session', async () => {
  let invocations = 0;
  const planner = createWorkflowPlanner({
    invokeAgent: {
      invoke: async () => {
        invocations += 1;
        return proposal;
      },
    },
    authorizeNode: async () => true,
  });
  const oversizedCapability: CapabilityDescriptor = {
    ...imageCapability,
    input_schema: { description: 'x'.repeat(300_000) },
  };

  let thrown: unknown;
  try {
    await planner.plan({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      binding: { role: 'planner', agentName: 'content-planner', cardHash: PLANNER_HASH },
      context: {
        protocol_version: 'intelligence.workflow.v1',
        run_id: RUN_ID,
        expected_graph_version: 0,
        capabilities: [oversizedCapability],
        agents: [{ name: 'content-planner', card_hash: PLANNER_HASH }],
        asset_ids: [],
        limits: {
          max_nodes: 128,
          max_dependencies: 256,
          max_approved_credits: 100,
          deadline_at: null,
        },
        evaluation_summaries: [],
      },
    });
  } catch (error) {
    thrown = error;
  }

  expect(invocations).toBe(0);
  expect(thrown).toMatchObject({ code: 'WORKFLOW_PLANNER_CONTEXT_INVALID' });
});

test('accepts a human approval node without inventing an Agent identity', async () => {
  const approvalProposal: WorkflowPlannerProposal = {
    ...proposal,
    nodes: [
      {
        node_key: 'approve-hero-image',
        role: 'system',
        kind: 'approval',
        agent_name: null,
        agent_card_hash: null,
        capability_id: null,
        capability_version: null,
        input_ref: 'sealed:approval-context-1',
        input_hash: INPUT_HASH,
        action_summary: 'Approve the hero image before publication',
        requires_approval: true,
        deadline_at: null,
      },
    ],
  };
  const planner = createWorkflowPlanner({
    invokeAgent: { invoke: async () => approvalProposal },
    authorizeNode: async () => true,
  });

  const result = await planner.plan({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    binding: { role: 'planner', agentName: 'content-planner', cardHash: PLANNER_HASH },
    context: {
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      expected_graph_version: 0,
      capabilities: [imageCapability],
      agents: [{ name: 'content-planner', card_hash: PLANNER_HASH }],
      asset_ids: [],
      limits: {
        max_nodes: 128,
        max_dependencies: 256,
        max_approved_credits: 100,
        deadline_at: null,
      },
      evaluation_summaries: [],
    },
  });

  expect(result.nodes[0]).toMatchObject({
    kind: 'approval',
    agent_name: null,
    agent_card_hash: null,
  });
});
