import { expect, test } from 'bun:test';
import {
  WORKFLOW_REVIEW_METADATA_NAMESPACE,
  type WorkflowReviewProjectionRecord,
} from '../intelligence/workflows/review-adapter';
import type { ReviewItemRow } from './review-items';
import { dispatchReviewVerdict } from './review-verdict-dispatch';

test('dispatches workflow projections through the authoritative workflow adapter', async () => {
  const calls: string[] = [];
  const projection = {
    reviewItemId: 'review-1',
    status: 'approved',
  } as WorkflowReviewProjectionRecord;

  const result = await dispatchReviewVerdict(
    {
      reviewItem: {
        metadata: {
          namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
          approval_id: 'approval-1',
          run_id: 'run-1',
          node_id: 'node-1',
        },
      },
      reviewItemId: 'review-1',
      accountId: 'account-1',
      projectId: 'project-1',
      actorUserId: 'reviewer-1',
      actorType: 'user',
      actingTokenId: null,
      verdict: 'approve',
      feedback: 'ship it',
    },
    {
      getWorkflowReviewAdapter: () => ({
        resolve: async (input) => {
          calls.push(`workflow:${input.reviewItemId}:${input.verdict}`);
          return { projection } as never;
        },
      }),
      applyVerdict: async () => {
        calls.push('native');
        return null;
      },
    },
  );

  expect(calls).toEqual(['workflow:review-1:approve']);
  expect(result).toEqual({ kind: 'workflow', row: projection });
});

test('dispatches ordinary review items through the native verdict updater', async () => {
  const calls: unknown[] = [];
  const row = { reviewItemId: 'review-2', status: 'rejected' } as ReviewItemRow;

  const result = await dispatchReviewVerdict(
    {
      reviewItem: { metadata: { source: 'manual' } },
      reviewItemId: 'review-2',
      accountId: 'account-1',
      projectId: 'project-1',
      actorUserId: 'reviewer-1',
      actorType: 'user',
      actingTokenId: null,
      verdict: 'reject',
      feedback: 'not ready',
    },
    {
      getWorkflowReviewAdapter: () => {
        calls.push('workflow');
        return null;
      },
      applyVerdict: async (...args) => {
        calls.push(args);
        return row;
      },
    },
  );

  expect(calls).toEqual([
    [
      'review-2',
      'project-1',
      { verdict: 'reject', feedback: 'not ready', actingUserId: 'reviewer-1' },
    ],
  ]);
  expect(result).toEqual({ kind: 'native', row });
});
