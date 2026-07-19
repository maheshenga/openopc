import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { actReviewItem, listReviewItems } from './review';

const WORKFLOW_METADATA = {
  namespace: 'kortix.intelligence.workflow.approval.v1',
  approval_id: '67000000-0000-4000-a000-000000000001',
  run_id: '61000000-0000-4000-a000-000000000001',
  node_id: '62000000-0000-4000-a000-000000000001',
};

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        review_items: [
          {
            review_item_id: '69000000-0000-8000-a000-000000000001',
            account_id: '63000000-0000-4000-a000-000000000001',
            project_id: '64000000-0000-4000-a000-000000000001',
            origin_session_id: null,
            kind: 'decision',
            status: 'needs_you',
            risk: 'high',
            source: 'agent',
            title: 'Workflow approval required',
            summary: 'Publish the approved campaign image',
            detail: { reason_code: 'WORKFLOW_POLICY_APPROVAL_REQUIRED' },
            agent: 'content-reviewer',
            created_by: '65000000-0000-4000-a000-000000000002',
            acted_by: null,
            acted_at: null,
            feedback: null,
            metadata: WORKFLOW_METADATA,
            created_at: '2026-07-19T08:00:00.000Z',
            updated_at: '2026-07-19T08:00:00.000Z',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('lists native workflow decisions without flattening namespaced metadata', async () => {
  const result = await listReviewItems('64000000-0000-4000-a000-000000000001', {
    segment: 'needs_you',
    kind: 'decision',
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: 'GET',
    url: 'http://test.local/projects/64000000-0000-4000-a000-000000000001/review/items?segment=needs_you&kind=decision',
  });
  expect(result.review_items[0]?.metadata).toEqual(WORKFLOW_METADATA);
});

test('acts on a workflow decision through the existing Review Center endpoint', async () => {
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        review_item_id: '69000000-0000-8000-a000-000000000001',
        status: 'approved',
        metadata: WORKFLOW_METADATA,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const result = await actReviewItem(
    '64000000-0000-4000-a000-000000000001',
    '69000000-0000-8000-a000-000000000001',
    { verdict: 'approve', feedback: 'Approved after review' },
  );

  expect(calls).toEqual([
    {
      url: 'http://test.local/projects/64000000-0000-4000-a000-000000000001/review/items/69000000-0000-8000-a000-000000000001/act',
      method: 'POST',
      body: { verdict: 'approve', feedback: 'Approved after review' },
    },
  ]);
  expect(result).toMatchObject({ status: 'approved', metadata: WORKFLOW_METADATA });
});
