import { describe, expect, test } from 'bun:test';
import type { AdminDeveloperApplicationListItem } from './client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AdminDeveloperApplicationQueueView } from './application-queue-page';

const ITEM: AdminDeveloperApplicationListItem = {
  application: {
    application_id: '10000000-0000-4000-a000-000000000001',
    account_id: '20000000-0000-4000-a000-000000000002',
    organization_id: '30000000-0000-4000-a000-000000000003',
    state: 'submitted',
    revision: 0,
    policy_versions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
    submitted_at: '2026-08-03T08:00:00.000Z',
    decided_at: null,
    suspended_at: null,
    decision_reason: null,
    created_by: '40000000-0000-4000-a000-000000000004',
    updated_by: null,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
  organization: {
    organization_id: '30000000-0000-4000-a000-000000000003',
    account_id: '20000000-0000-4000-a000-000000000002',
    name: 'Acme Studio',
    verification_state: 'pending',
    verification_metadata: {},
    verification_revision: 0,
    verification_changed_by: null,
    verification_changed_at: null,
    created_by: '40000000-0000-4000-a000-000000000004',
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
};

const noop = () => undefined;

describe('Admin developer application pages', () => {
  test('renders submitted applications with loaded-page search and pagination', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperApplicationQueueView
        state="ready"
        applicationState="submitted"
        applications={[ITEM]}
        search="Acme"
        nextCursor="cursor"
        errorCode={null}
        onSearchChange={noop}
        onStateChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenApplication={noop}
      />,
    );

    expect(html).toContain('Developer applications');
    expect(html).toContain('Acme Studio');
    expect(html).toContain('Submitted');
    expect(html).toContain('Revision 0');
    expect(html).toContain('Next page');
  });

  test('hides non-matching loaded-page applications', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperApplicationQueueView
        state="ready"
        applicationState="submitted"
        applications={[ITEM]}
        search="Other organization"
        nextCursor={null}
        errorCode={null}
        onSearchChange={noop}
        onStateChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenApplication={noop}
      />,
    );

    expect(html).toContain('No applications match your search.');
    expect(html).not.toContain('Acme Studio');
  });

  test('offers cursor reset without exposing stable error codes', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperApplicationQueueView
        state="error"
        applicationState="submitted"
        applications={[]}
        search=""
        nextCursor={null}
        errorCode="DEVELOPER_APPLICATION_INPUT_INVALID"
        onSearchChange={noop}
        onStateChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenApplication={noop}
      />,
    );

    expect(html).toContain('Reset to first page');
    expect(html).not.toContain('DEVELOPER_APPLICATION_INPUT_INVALID');
  });

  test('renders an empty queue state', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperApplicationQueueView
        state="empty"
        applicationState="submitted"
        applications={[]}
        search=""
        nextCursor={null}
        errorCode={null}
        onSearchChange={noop}
        onStateChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenApplication={noop}
      />,
    );

    expect(html).toContain('No developer applications are in this queue.');
  });
});
