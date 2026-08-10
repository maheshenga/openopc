import { expect, mock, test } from 'bun:test';

const getDeveloperAccess = mock(async () => ({ publishers: [] }));
const createDeveloperPublisher = mock(async () => ({}));

mock.module('@kortix/sdk', () => ({
  getDeveloperAccess,
  createDeveloperPublisher,
}));

const { createPublisher, developerPublisherAccessQuery, invalidateDeveloperPublisherAccess } =
  await import('./access-query');

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';

test('delegates account-scoped Publisher access and creation to the SDK', async () => {
  await developerPublisherAccessQuery(ACCOUNT_ID).queryFn();
  expect(getDeveloperAccess).toHaveBeenCalledWith({ accountId: ACCOUNT_ID });

  await createPublisher({
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    slug: 'acme',
    displayName: 'Acme Studio',
  });
  expect(createDeveloperPublisher).toHaveBeenCalledWith({
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    slug: 'acme',
    displayName: 'Acme Studio',
  });
});

test('invalidates only the exact account Publisher access query after creation', async () => {
  const invalidateQueries = mock(async () => undefined);

  await invalidateDeveloperPublisherAccess({ invalidateQueries }, ACCOUNT_ID);

  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: ['developer-publisher-access', ACCOUNT_ID],
    exact: true,
  });
});
