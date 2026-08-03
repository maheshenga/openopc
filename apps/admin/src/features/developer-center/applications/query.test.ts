import { describe, expect, mock, test } from 'bun:test';

const decideAdminDeveloperApplication = mock(async () => ({ application_id: 'updated' }));

mock.module('./client', () => ({
  adminDeveloperApplicationErrorCode: () => 'DEVELOPER_APPLICATION_REQUEST_FAILED',
  decideAdminDeveloperApplication,
  getAdminDeveloperApplication: mock(async () => ({})),
  listAdminDeveloperApplications: mock(async () => ({ applications: [], next_cursor: null })),
  suspendAdminDeveloperApplication: mock(async () => ({ application_id: 'updated' })),
}));

const {
  adminDeveloperApplicationKeys,
  adminDeveloperApplicationQueueQuery,
  refreshAdminDeveloperApplicationAfterConflict,
  submitAdminDeveloperApplicationDecision,
} = await import('./query');

const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';
const APPLICATION = { application_id: APPLICATION_ID, state: 'submitted' as const, revision: 0 };

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

  test('removes and refetches only the conflicted application detail', async () => {
    const removeQueries = mock(() => undefined);
    const refetchQueries = mock(async () => undefined);

    await refreshAdminDeveloperApplicationAfterConflict({ removeQueries, refetchQueries }, APPLICATION_ID);

    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: adminDeveloperApplicationKeys.detail(APPLICATION_ID),
    });
    expect(refetchQueries).toHaveBeenCalledWith({
      queryKey: adminDeveloperApplicationKeys.detail(APPLICATION_ID),
    });
  });
});
