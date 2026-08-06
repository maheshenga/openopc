import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { AdminDeveloperApplicationDetail } from './client';

const decideAdminDeveloperApplication = mock(async () => ({ application_id: 'updated' }));
const getAdminDeveloperApplication = mock(
  async (_applicationId: string): Promise<AdminDeveloperApplicationDetail> => detail(APPLICATION_ID, 0),
);

mock.module('./client', () => ({
  adminDeveloperApplicationErrorCode: () => 'DEVELOPER_APPLICATION_REQUEST_FAILED',
  decideAdminDeveloperApplication,
  getAdminDeveloperApplication,
  listAdminDeveloperApplications: mock(async () => ({ applications: [], next_cursor: null })),
  suspendAdminDeveloperApplication: mock(async () => ({ application_id: 'updated' })),
}));

const {
  adminDeveloperApplicationKeys,
  adminDeveloperApplicationDetailQuery,
  adminDeveloperApplicationQueueQuery,
  refreshAdminDeveloperApplicationAfterConflict,
  submitAdminDeveloperApplicationDecision,
} = await import('./query');

const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';
const APPLICATION = { application_id: APPLICATION_ID, state: 'submitted' as const, revision: 0 };

function detail(applicationId: string, revision: number): AdminDeveloperApplicationDetail {
  return {
    application: {
      application_id: applicationId,
      account_id: '10000000-0000-4000-a000-000000000010',
      organization_id: '10000000-0000-4000-a000-000000000011',
      state: 'submitted',
      revision,
      policy_versions: { acceptableUse: '2026-08', moduleRules: '2026-08' },
      submitted_at: '2026-08-03T00:00:00.000Z',
      decided_at: null,
      suspended_at: null,
      decision_reason: null,
      created_by: '20000000-0000-4000-a000-000000000010',
      updated_by: null,
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    },
    organization: {
      organization_id: '10000000-0000-4000-a000-000000000011',
      account_id: '10000000-0000-4000-a000-000000000010',
      name: 'Example Organization',
      verification_state: 'pending',
      verification_metadata: {},
      verification_revision: 0,
      verification_changed_by: null,
      verification_changed_at: null,
      created_by: '20000000-0000-4000-a000-000000000010',
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    },
    policy_acceptances: [],
    history: [],
  };
}

describe('Admin developer application queries', () => {
  test('isolates submitted queue cache keys by opaque cursor', () => {
    expect(adminDeveloperApplicationQueueQuery('submitted', null).queryKey).toEqual([
      'admin-developer-applications',
      'list',
      'submitted',
      'first',
    ]);
    expect(adminDeveloperApplicationQueueQuery('submitted', 'cursor').queryKey).toEqual([
      'admin-developer-applications',
      'list',
      'submitted',
      'cursor',
    ]);
  });

  test('submits the selected application revision as the decision fence', async () => {
    await submitAdminDeveloperApplicationDecision({
      application: APPLICATION,
      decision: 'approve',
      reason: 'Organization verified',
    });

    expect(decideAdminDeveloperApplication).toHaveBeenCalledWith(APPLICATION_ID, {
      decision: 'approve',
      expected_revision: APPLICATION.revision,
      reason: 'Organization verified',
    });
  });

  test('resets an active conflicted detail to its newest value without refetching unrelated details', async () => {
    const newestDetail = detail(APPLICATION_ID, 1);
    const unrelatedApplicationId = '10000000-0000-4000-a000-000000000002';
    const unrelatedDetail = detail(unrelatedApplicationId, 7);
    let conflictedDetailRequests = 0;
    let unrelatedDetailRequests = 0;

    getAdminDeveloperApplication.mockImplementation(async (applicationId: string) => {
      if (applicationId === APPLICATION_ID) {
        conflictedDetailRequests += 1;
        return conflictedDetailRequests === 1 ? detail(APPLICATION_ID, 0) : newestDetail;
      }
      unrelatedDetailRequests += 1;
      return unrelatedDetail;
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const detailObserver = new QueryObserver(
      queryClient,
      adminDeveloperApplicationDetailQuery(APPLICATION_ID),
    );
    const unrelatedObserver = new QueryObserver(
      queryClient,
      adminDeveloperApplicationDetailQuery(unrelatedApplicationId),
    );
    const stopDetailObserver = detailObserver.subscribe(() => undefined);
    const stopUnrelatedObserver = unrelatedObserver.subscribe(() => undefined);

    await queryClient.fetchQuery(adminDeveloperApplicationDetailQuery(APPLICATION_ID));
    await queryClient.fetchQuery(adminDeveloperApplicationDetailQuery(unrelatedApplicationId));
    await refreshAdminDeveloperApplicationAfterConflict(queryClient, APPLICATION_ID);

    expect(conflictedDetailRequests).toBe(2);
    expect(unrelatedDetailRequests).toBe(1);
    expect(detailObserver.getCurrentResult().data).toEqual(newestDetail);
    expect(unrelatedObserver.getCurrentResult().data).toEqual(unrelatedDetail);
    expect(
      queryClient.getQueryData<AdminDeveloperApplicationDetail>(
        adminDeveloperApplicationKeys.detail(unrelatedApplicationId),
      ),
    ).toEqual(unrelatedDetail);

    stopDetailObserver();
    stopUnrelatedObserver();
    queryClient.clear();
  });
});
