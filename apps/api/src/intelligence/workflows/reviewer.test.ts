import { expect, test } from 'bun:test';
import type { WorkflowReviewerVerdict } from '@kortix/intelligence-contracts';
import { createWorkflowReviewer } from './reviewer';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const NODE_ID = '44444444-4444-4444-8444-444444444444';
const VERDICT_ID = '55555555-5555-4555-8555-555555555555';
const ASSET_ID = '66666666-6666-4666-8666-666666666666';
const REVIEWER_HASH = 'a'.repeat(64);
const EXECUTOR_HASH = 'b'.repeat(64);

const verdict: WorkflowReviewerVerdict = {
  protocol_version: 'intelligence.workflow.v1',
  verdict_id: VERDICT_ID,
  run_id: RUN_ID,
  node_id: NODE_ID,
  reviewer_agent_name: 'quality-reviewer',
  reviewer_card_hash: REVIEWER_HASH,
  verdict: 'approve',
  reason_codes: ['QUALITY_PASS'],
  feedback_ref: null,
  feedback_hash: null,
  evaluation_version: null,
  created_at: '2026-07-19T00:00:00.000Z',
};

test('returns only a strictly parsed and authorized reviewer verdict', async () => {
  const calls: string[] = [];
  let invocationContext: unknown;
  const reviewer = createWorkflowReviewer({
    invokeAgent: {
      invoke: async (input) => {
        calls.push('invoke');
        invocationContext = input.context;
        return verdict;
      },
    },
    authorizeVerdict: async () => {
      calls.push('authorize');
      return true;
    },
  });

  const result = await reviewer.review({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    binding: { role: 'reviewer', agentName: 'quality-reviewer', cardHash: REVIEWER_HASH },
    context: {
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      node: {
        node_id: NODE_ID,
        role: 'executor',
        agent_name: 'image-executor',
        agent_card_hash: EXECUTOR_HASH,
      },
      result: {
        status: 'succeeded',
        asset_ids: [ASSET_ID],
        reason_codes: [],
      },
      evaluation_summary: null,
      separation_of_duty: true,
    },
  });

  expect(calls).toEqual(['invoke', 'authorize']);
  expect(result).toEqual(verdict);
  expect(JSON.stringify(invocationContext)).not.toMatch(
    /chain.of.thought|reasoning|credential|authorization|provider_url|signed_url/i,
  );
});

test('rejects reviewer self-review before invoking an Agent session', async () => {
  let invocations = 0;
  const reviewer = createWorkflowReviewer({
    invokeAgent: {
      invoke: async () => {
        invocations += 1;
        return verdict;
      },
    },
    authorizeVerdict: async () => true,
  });

  let thrown: unknown;
  try {
    await reviewer.review({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      binding: { role: 'reviewer', agentName: 'image-executor', cardHash: EXECUTOR_HASH },
      context: {
        protocol_version: 'intelligence.workflow.v1',
        run_id: RUN_ID,
        node: {
          node_id: NODE_ID,
          role: 'executor',
          agent_name: 'image-executor',
          agent_card_hash: EXECUTOR_HASH,
        },
        result: { status: 'succeeded', asset_ids: [ASSET_ID], reason_codes: [] },
        evaluation_summary: null,
        separation_of_duty: true,
      },
    });
  } catch (error) {
    thrown = error;
  }

  expect(invocations).toBe(0);
  expect(thrown).toMatchObject({ code: 'WORKFLOW_REVIEWER_SELF_REVIEW_DENIED' });
});
