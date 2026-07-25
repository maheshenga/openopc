import { describe, expect, mock, test } from 'bun:test';

const listDeveloperModuleReleases = mock(async () => ({ releases: [] }));
const getDeveloperModuleRelease = mock(async () => ({
  release_id: 'release',
  account_id: 'account',
}));
const getDeveloperModuleReviewHistory = mock(async () => ({ history: [] }));
const requestDeveloperModuleReview = mock(async () => ({
  release: {
    release_id: 'release',
    account_id: 'account',
    status: 'review_pending',
    review_revision: 2,
  },
  event: { review_event_id: 'event' },
}));
const getDeveloperModuleTrust = mock(async () => ({
  release_id: 'release',
  account_id: 'account',
  artifact: { artifact_id: 'artifact' },
  attempts: [{ state: 'running' }],
}));
const retryDeveloperModuleVerification = mock(async () => ({
  run_id: 'run-2',
  state: 'queued',
}));

mock.module('@kortix/sdk', () => ({
  getDeveloperModuleRelease,
  getDeveloperModuleReviewHistory,
  getDeveloperModuleTrust,
  listDeveloperModuleReleases,
  requestDeveloperModuleReview,
  retryDeveloperModuleVerification,
}));

const {
  developerModuleKeys,
  developerModuleTrustPollInterval,
  publisherModuleDetailQuery,
  publisherModuleHistoryQuery,
  publisherModuleReleasesQuery,
  publisherModuleTrustQuery,
  submitPublisherReview,
  submitPublisherVerificationRetry,
} = await import('./query');

describe('publisher Developer Center queries', () => {
  test('isolates every publisher key by account', () => {
    expect(developerModuleKeys.list('account-a')).not.toEqual(
      developerModuleKeys.list('account-b'),
    );
    expect(developerModuleKeys.detail('account-a', 'release')).not.toEqual(
      developerModuleKeys.detail('account-b', 'release'),
    );
    expect(developerModuleKeys.history('account-a', 'release')).not.toEqual(
      developerModuleKeys.history('account-b', 'release'),
    );
    expect(developerModuleKeys.trust('account-a', 'release')).not.toEqual(
      developerModuleKeys.trust('account-b', 'release'),
    );
  });

  test('uses the public SDK with the bounded recent-release contract', async () => {
    await publisherModuleReleasesQuery('account-a').queryFn();
    expect(listDeveloperModuleReleases).toHaveBeenCalledWith({
      accountId: 'account-a',
      limit: 100,
    });

    await publisherModuleDetailQuery('account-a', 'release').queryFn();
    expect(getDeveloperModuleRelease).toHaveBeenCalledWith('release', { accountId: 'account-a' });

    await publisherModuleHistoryQuery('account-a', 'release').queryFn();
    expect(getDeveloperModuleReviewHistory).toHaveBeenCalledWith('release', {
      accountId: 'account-a',
    });

    await publisherModuleTrustQuery('account-a', 'release').queryFn();
    expect(getDeveloperModuleTrust).toHaveBeenCalledWith('release', { accountId: 'account-a' });
  });

  test('sends the current status and revision without optimistic state', async () => {
    await submitPublisherReview({
      accountId: 'account-a',
      releaseId: 'release',
      expectedStatus: 'validated',
      expectedRevision: 3,
      reason: undefined,
    });

    expect(requestDeveloperModuleReview).toHaveBeenCalledWith('release', {
      accountId: 'account-a',
      expectedStatus: 'validated',
      expectedRevision: 3,
      reason: undefined,
    });
  });

  test('polls only while the newest immutable verification attempt is active', () => {
    expect(developerModuleTrustPollInterval({ attempts: [{ state: 'queued' }] } as never)).toBe(
      2_000,
    );
    expect(developerModuleTrustPollInterval({ attempts: [{ state: 'running' }] } as never)).toBe(
      2_000,
    );
    expect(developerModuleTrustPollInterval({ attempts: [{ state: 'passed' }] } as never)).toBe(
      false,
    );
    expect(developerModuleTrustPollInterval({ attempts: [] } as never)).toBe(false);
  });

  test('retries verification through the publisher account boundary', async () => {
    await submitPublisherVerificationRetry({ accountId: 'account-a', releaseId: 'release' });
    expect(retryDeveloperModuleVerification).toHaveBeenCalledWith('release', {
      accountId: 'account-a',
    });
  });
});
