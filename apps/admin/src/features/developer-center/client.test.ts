import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MockApiResponse = { success: boolean; data?: unknown; error?: unknown };

const get = mock(
  async (_path: string, _options?: unknown): Promise<MockApiResponse> => ({
    success: true,
    data: {},
  }),
);
const post = mock(
  async (_path: string, _body: unknown, _options?: unknown): Promise<MockApiResponse> => ({
    success: true,
    data: {},
  }),
);

mock.module('@/lib/api-client', () => ({
  backendApi: { get, post },
}));

const {
  cancelAdminDeveloperModuleVerification,
  decideAdminDeveloperReview,
  getAdminDeveloperModuleTrust,
  getAdminDeveloperReview,
  listAdminDeveloperReviews,
  retryAdminDeveloperModuleVerification,
  signAdminDeveloperModuleRelease,
  publishAdminDeveloperModuleRelease,
} = await import('./client');

const RELEASE_ID = '14000000-0000-4000-a000-000000000001';
const COMPLETE_EVIDENCE = [
  {
    requirement: 'manifest_review' as const,
    outcome: 'passed' as const,
    method: 'manual' as const,
    summary: 'Manifest fields and permissions were reviewed.',
    observed_at: '2026-07-24T06:00:00.000Z',
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

    expect(get).toHaveBeenCalledWith(`/admin/developer/modules/releases/${RELEASE_ID}/review`, {
      adminReason: `Reviewing developer module release ${RELEASE_ID}`,
    });
    expect(post).toHaveBeenCalledWith(
      `/admin/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        decision: 'approve',
        expected_status: 'review_pending',
        expected_revision: 4,
        evidence: COMPLETE_EVIDENCE,
      },
      { adminReason: `approve developer module release ${RELEASE_ID}` },
    );
  });

  test('uses private safe trust read, retry and cancellation routes', async () => {
    get.mockResolvedValueOnce({
      success: true,
      data: { release_id: RELEASE_ID, artifact: {}, attempts: [] },
    });
    post.mockResolvedValueOnce({ success: true, data: { run_id: 'run-2', state: 'queued' } });
    post.mockResolvedValueOnce({
      success: true,
      data: { run_id: 'run-2', state: 'cancelled' },
    });

    await getAdminDeveloperModuleTrust(RELEASE_ID);
    await retryAdminDeveloperModuleVerification(RELEASE_ID);
    await cancelAdminDeveloperModuleVerification(RELEASE_ID);

    expect(get).toHaveBeenCalledWith(`/admin/developer/modules/releases/${RELEASE_ID}/trust`, {
      adminReason: `Reviewing trust evidence for developer module release ${RELEASE_ID}`,
    });
    expect(post).toHaveBeenNthCalledWith(
      1,
      `/admin/developer/modules/releases/${RELEASE_ID}/verification-retries`,
      {},
      { adminReason: `Retrying verification for developer module release ${RELEASE_ID}` },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      `/admin/developer/modules/releases/${RELEASE_ID}/verification-cancellations`,
      {},
      { adminReason: `Cancelling verification for developer module release ${RELEASE_ID}` },
    );
  });

  test('sends explicit reasons for signing and publishing a release', async () => {
    post.mockResolvedValue({ success: true, data: { release: {}, event: {} } });

    await signAdminDeveloperModuleRelease(RELEASE_ID, {
      expected_status: 'approved',
      expected_revision: 2,
    });
    await publishAdminDeveloperModuleRelease(RELEASE_ID, {
      expected_status: 'signed',
      expected_revision: 3,
    });

    expect(post).toHaveBeenNthCalledWith(
      1,
      `/admin/developer/modules/releases/${RELEASE_ID}/sign`,
      { expected_status: 'approved', expected_revision: 2 },
      { adminReason: `Signing developer module release ${RELEASE_ID}` },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      `/admin/developer/modules/releases/${RELEASE_ID}/publish`,
      { expected_status: 'signed', expected_revision: 3 },
      { adminReason: `Publishing developer module release ${RELEASE_ID}` },
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

    get.mockResolvedValueOnce({
      success: false,
      error: { body: { error: 'DEVELOPER_TRUST_GATE_UNMET' } },
    });
    await expect(getAdminDeveloperModuleTrust(RELEASE_ID)).rejects.toMatchObject({
      code: 'DEVELOPER_TRUST_GATE_UNMET',
    });
  });
});
