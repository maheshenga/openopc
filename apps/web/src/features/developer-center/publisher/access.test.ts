import type { DeveloperAccess, DeveloperPublisher, DeveloperPublisherMember } from '@kortix/sdk';
import { expect, test } from 'bun:test';

import { reconcilePublisherSelection, selectableDeveloperPublishers } from './access';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';
const USER_ID = '30000000-0000-4000-a000-000000000003';

function publisherEntry(
  publisherId: string,
  status: DeveloperPublisher['status'],
  role: DeveloperPublisherMember['role'] | null,
): DeveloperAccess['publishers'][number] {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: ACCOUNT_ID,
      organization_id: ORGANIZATION_ID,
      slug: publisherId,
      display_name: `${publisherId} Studio`,
      status,
      authority_revision: 0,
      suspended_reason: null,
      suspended_by: null,
      suspended_at: null,
      created_by: USER_ID,
      created_at: '2026-08-03T08:00:00.000Z',
      updated_at: '2026-08-03T08:00:00.000Z',
    },
    membership: role
      ? {
          member_id: `${publisherId}-member`,
          account_id: ACCOUNT_ID,
          publisher_id: publisherId,
          user_id: USER_ID,
          role,
          revision: 0,
          created_by: USER_ID,
          created_at: '2026-08-03T08:00:00.000Z',
          updated_by: null,
          updated_at: '2026-08-03T08:00:00.000Z',
        }
      : null,
  };
}

function access(publishers: DeveloperAccess['publishers']): DeveloperAccess {
  return {
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    organization: null,
    invitations: [],
    publishers,
  };
}

const activeOwner = publisherEntry('acme', 'active', 'owner');
const secondOwner = publisherEntry('second', 'active', 'owner');
const suspendedOwner = publisherEntry('suspended', 'suspended', 'owner');
const noMembership = publisherEntry('foreign', 'active', null);
const uploadOnlyDeveloper = publisherEntry('upload-only', 'active', 'developer');
const releaseManager = publisherEntry('release-manager', 'active', 'release_manager');

test('selects one active membership and requires a choice for multiple Publishers', () => {
  expect(selectableDeveloperPublishers(access([activeOwner]))).toEqual([activeOwner]);
  expect(
    reconcilePublisherSelection(
      { accountId: ACCOUNT_ID, publisherId: '' },
      ACCOUNT_ID,
      access([activeOwner]),
    ),
  ).toEqual({ accountId: ACCOUNT_ID, publisherId: 'acme' });

  expect(
    reconcilePublisherSelection(
      { accountId: ACCOUNT_ID, publisherId: '' },
      ACCOUNT_ID,
      access([activeOwner, secondOwner]),
    ),
  ).toEqual({ accountId: ACCOUNT_ID, publisherId: '' });
});

test('drops suspended, membership-free, and previous-account selections', () => {
  expect(
    selectableDeveloperPublishers(
      access([suspendedOwner, noMembership, uploadOnlyDeveloper, releaseManager]),
    ),
  ).toEqual([]);
  expect(
    reconcilePublisherSelection(
      { accountId: 'old-account', publisherId: 'old-publisher' },
      ACCOUNT_ID,
      access([activeOwner]),
    ),
  ).toEqual({ accountId: ACCOUNT_ID, publisherId: 'acme' });
});
