import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MockApiResponse = { success: boolean; data?: unknown; error?: unknown };

const get = mock(
  async (_path: string): Promise<MockApiResponse> => ({
    success: true,
    data: {},
  }),
);
const post = mock(
  async (_path: string, _body: unknown): Promise<MockApiResponse> => ({
    success: true,
    data: {},
  }),
);

mock.module('@/lib/api-client', () => ({
  backendApi: { get, post },
}));

const { decideAdminDeveloperReview, getAdminDeveloperReview, listAdminDeveloperReviews } =
  await import('./client');

const RELEASE_ID = '14000000-0000-4000-a000-000000000001';
const COMPLETE_EVIDENCE = [
  {
    requirement: 'manifest_review' as const,
    outcome: 'passed' as const,
    method: 'manual' as const,
    summary: 'Manifest fields and permissions were reviewed.',
    observed_at: '2026-07-24T06:00:00.000Z',
    tool: 'openopc-review-console',
    tool_version: '1.0.0',
    evidence_digest: `sha256:${'a'.repeat(64)}` as const,
  },
];

describe('private Admin developer review client', () => {
  beforeEach(() => {
    get.mockClear();
    post.mockClear();
  });

  test('uses the exact bounded Admin review queue route', async () => {
    get.mockResolvedValueOnce({
      success: true,
      data: { releases: [], next_cursor: null },
    });

    await listAdminDeveloperReviews({ status: 'review_pending' });

    expect(get).toHaveBeenCalledWith(
      '/admin/developer/modules/reviews?status=review_pending&limit=50',
    );
  });

  test('URL-encodes an opaque queue cursor', async () => {
    get.mockResolvedValueOnce({
      success: true,
      data: { releases: [], next_cursor: null },
    });

    await listAdminDeveloperReviews({
      status: 'review_pending',
      limit: 25,
      cursor: 'next page/+==',
    });

    expect(get).toHaveBeenCalledWith(
      '/admin/developer/modules/reviews?status=review_pending&limit=25&cursor=next+page%2F%2B%3D%3D',
    );
  });

  test('uses the exact private detail and decision routes and body', async () => {
    get.mockResolvedValueOnce({
      success: true,
      data: { release: { release_id: RELEASE_ID }, history: [] },
    });
    post.mockResolvedValueOnce({
      success: true,
      data: { release: { release_id: RELEASE_ID }, event: { review_event_id: 'event' } },
    });

    await getAdminDeveloperReview(RELEASE_ID);
    await decideAdminDeveloperReview(RELEASE_ID, {
      decision: 'approve',
      expected_status: 'review_pending',
      expected_revision: 4,
      evidence: COMPLETE_EVIDENCE,
    });

    expect(get).toHaveBeenCalledWith(`/admin/developer/modules/releases/${RELEASE_ID}/review`);
    expect(post).toHaveBeenCalledWith(
      `/admin/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        decision: 'approve',
        expected_status: 'review_pending',
        expected_revision: 4,
        evidence: COMPLETE_EVIDENCE,
      },
    );
  });

  test('throws a stable server code without leaking an arbitrary error message', async () => {
    get.mockResolvedValueOnce({
      success: false,
      error: {
        message: 'release manifest contents must not escape',
        code: '409',
        details: { error: 'DEVELOPER_REVIEW_CONFLICT' },
      },
    });

    let conflict: unknown;
    try {
      await getAdminDeveloperReview(RELEASE_ID);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      message: 'DEVELOPER_REVIEW_CONFLICT',
      code: 'DEVELOPER_REVIEW_CONFLICT',
    });
    expect(conflict).not.toHaveProperty('cause');

    get.mockResolvedValueOnce({
      success: false,
      error: { message: 'provider response body', code: '500' },
    });

    await expect(getAdminDeveloperReview(RELEASE_ID)).rejects.toMatchObject({
      message: 'DEVELOPER_REQUEST_FAILED',
      code: 'DEVELOPER_REQUEST_FAILED',
    });
  });
});
