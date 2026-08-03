import type { DeveloperOrganization } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SelectableDeveloperPublisher } from './access';
import { DeveloperPublisherOnboardingView } from './onboarding-panel';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';
const USER_ID = '30000000-0000-4000-a000-000000000003';
const noop = () => undefined;

function publisherOption(publisherId: string, displayName: string): SelectableDeveloperPublisher {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: ACCOUNT_ID,
      organization_id: ORGANIZATION_ID,
      slug: publisherId,
      display_name: displayName,
      status: 'active',
      authority_revision: 0,
      suspended_reason: null,
      suspended_by: null,
      suspended_at: null,
      created_by: USER_ID,
      created_at: '2026-08-03T08:00:00.000Z',
      updated_at: '2026-08-03T08:00:00.000Z',
    },
    membership: {
      member_id: `${publisherId}-member`,
      account_id: ACCOUNT_ID,
      publisher_id: publisherId,
      user_id: USER_ID,
      role: 'owner',
      revision: 0,
      created_by: USER_ID,
      created_at: '2026-08-03T08:00:00.000Z',
      updated_by: null,
      updated_at: '2026-08-03T08:00:00.000Z',
    },
  };
}

const ORGANIZATION: DeveloperOrganization = {
  organization_id: ORGANIZATION_ID,
  account_id: ACCOUNT_ID,
  name: 'Acme Studio',
  verification_state: 'verified',
  verification_metadata: {},
  verification_revision: 1,
  verification_changed_by: USER_ID,
  verification_changed_at: '2026-08-03T08:05:00.000Z',
  created_by: USER_ID,
  created_at: '2026-08-03T08:00:00.000Z',
  updated_at: '2026-08-03T08:05:00.000Z',
};
const PUBLISHER_A = publisherOption('acme', 'Acme Studio');
const PUBLISHER_B = publisherOption('second', 'Second Studio');
const BASE = {
  state: 'ready' as const,
  organization: ORGANIZATION,
  publishers: [PUBLISHER_A] as readonly SelectableDeveloperPublisher[],
  selectedPublisherId: 'acme',
  createOpen: false,
  slug: '',
  displayName: '',
  canWrite: true,
  pending: false,
  errorCode: null,
  onSlugChange: noop,
  onDisplayNameChange: noop,
  onPublisherChange: noop,
  onCreateOpenChange: noop,
  onCreate: noop,
};

test('renders bounded Publisher creation when no Publisher exists', () => {
  const createHtml = renderToStaticMarkup(
    <DeveloperPublisherOnboardingView
      state="ready"
      organization={ORGANIZATION}
      publishers={[]}
      selectedPublisherId=""
      slug="acme"
      displayName="Acme Studio"
      canWrite
      pending={false}
      errorCode={null}
      onSlugChange={noop}
      onDisplayNameChange={noop}
      onPublisherChange={noop}
      onCreate={noop}
    />,
  );
  expect(createHtml).toContain('Create Publisher');
  expect(createHtml).toContain('Acme Studio');
  expect(createHtml).not.toContain('Organization ID');
});

test('renders selector and additional-create command for multiple Publishers', () => {
  const oneHtml = renderToStaticMarkup(<DeveloperPublisherOnboardingView {...BASE} />);
  expect(oneHtml).toContain('Choose a Publisher');
  expect(oneHtml).toContain('Open modules');

  const multipleHtml = renderToStaticMarkup(
    <DeveloperPublisherOnboardingView {...BASE} publishers={[PUBLISHER_A, PUBLISHER_B]} />,
  );
  expect(multipleHtml).toContain('Choose a Publisher');
  expect(multipleHtml).toContain('Create another Publisher');
  expect(multipleHtml).toContain('/developer/modules');
  expect(multipleHtml).not.toContain('Publisher ID');

  const additionalCreateHtml = renderToStaticMarkup(
    <DeveloperPublisherOnboardingView
      {...BASE}
      publishers={[PUBLISHER_A, PUBLISHER_B]}
      createOpen
    />,
  );
  expect(additionalCreateHtml).toContain('Publisher slug');
  expect(additionalCreateHtml).toContain('Display name');
});

test('renders read-only, loading, and bounded error states', () => {
  const readonlyHtml = renderToStaticMarkup(
    <DeveloperPublisherOnboardingView {...BASE} canWrite={false} />,
  );
  expect(readonlyHtml).toContain('Account write permission is required');
  expect(readonlyHtml).toContain('disabled=""');

  expect(
    renderToStaticMarkup(
      <DeveloperPublisherOnboardingView
        {...BASE}
        state="loading"
        publishers={[]}
        organization={null}
      />,
    ),
  ).toContain('Loading Publisher access');

  expect(
    renderToStaticMarkup(
      <DeveloperPublisherOnboardingView
        {...BASE}
        state="error"
        errorCode="DEVELOPER_REQUEST_FAILED"
      />,
    ),
  ).toContain('DEVELOPER_REQUEST_FAILED');
});
