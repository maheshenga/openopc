import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MockApiResponse = { success: boolean; data?: unknown; error?: unknown };

const get = mock(async (_path: string, _options?: unknown): Promise<MockApiResponse> => ({
  success: true,
  data: {},
}));
const post = mock(async (_path: string, _body: unknown, _options?: unknown): Promise<MockApiResponse> => ({
  success: true,
  data: {},
}));

mock.module('@/lib/api-client', () => ({ backendApi: { get, post } }));

const {
  decideAdminDeveloperApplication,
  getAdminDeveloperApplication,
  listAdminDeveloperApplications,
  suspendAdminDeveloperApplication,
} = await import('./client');

const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';

describe('private Admin developer application client', () => {
  beforeEach(() => {
    get.mockClear();
    post.mockClear();
  });

  test('uses the exact bounded Admin application queue route', async () => {
    get.mockResolvedValueOnce({ success: true, data: { applications: [], next_cursor: null } });

    await listAdminDeveloperApplications({
      state: 'submitted',
      limit: 25,
      cursor: 'next page/+==',
    });

    expect(get).toHaveBeenCalledWith(
      '/admin/developer/applications?state=submitted&limit=25&cursor=next+page%2F%2B%3D%3D',
    );
  });

  test('uses exact private detail and mutation routes, bodies, and reasons', async () => {
    get.mockResolvedValueOnce({ success: true, data: { application: {}, organization: {}, history: [] } });
    post.mockResolvedValue({ success: true, data: { application_id: APPLICATION_ID } });

    await getAdminDeveloperApplication(APPLICATION_ID);
    await decideAdminDeveloperApplication(APPLICATION_ID, {
      decision: 'approve',
      expected_revision: 0,
      reason: 'Organization verified',
    });
    await suspendAdminDeveloperApplication(APPLICATION_ID, {
      expected_revision: 1,
      reason: 'Compliance hold',
    });

    expect(get).toHaveBeenCalledWith(`/admin/developer/applications/${APPLICATION_ID}`, {
      adminReason: `Reviewing developer application ${APPLICATION_ID}`,
    });
    expect(post).toHaveBeenNthCalledWith(
      1,
      `/admin/developer/applications/${APPLICATION_ID}/decision`,
      { decision: 'approve', expected_revision: 0, reason: 'Organization verified' },
      { adminReason: 'Organization verified' },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      `/admin/developer/applications/${APPLICATION_ID}/suspend`,
      { expected_revision: 1, reason: 'Compliance hold' },
      { adminReason: 'Compliance hold' },
    );
  });

  test('retains only stable server error codes', async () => {
    get.mockResolvedValueOnce({
      success: false,
      error: { message: 'provider response body', data: { error: 'DEVELOPER_APPLICATION_CONFLICT' } },
    });
    await expect(getAdminDeveloperApplication(APPLICATION_ID)).rejects.toMatchObject({
      message: 'DEVELOPER_APPLICATION_CONFLICT',
      code: 'DEVELOPER_APPLICATION_CONFLICT',
    });

    get.mockResolvedValueOnce({ success: false, error: { message: 'provider response body' } });
    await expect(getAdminDeveloperApplication(APPLICATION_ID)).rejects.toMatchObject({
      message: 'DEVELOPER_APPLICATION_REQUEST_FAILED',
      code: 'DEVELOPER_APPLICATION_REQUEST_FAILED',
    });
  });
});
