import { describe, expect, test } from 'bun:test';
import type { AdminDeveloperApplicationDetail, AdminDeveloperApplicationListItem } from './client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AdminDeveloperApplicationDetailView } from './application-detail-page';
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

const APPLICATION_ID = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-a000-000000000002';
const ORGANIZATION_ID = '30000000-0000-4000-a000-000000000003';
const APPLICANT_ID = '40000000-0000-4000-a000-000000000004';

const DETAIL: AdminDeveloperApplicationDetail = {
  application: {
    application_id: APPLICATION_ID,
    account_id: ACCOUNT_ID,
    organization_id: ORGANIZATION_ID,
    state: 'submitted',
    revision: 0,
    policy_versions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
    submitted_at: '2026-08-03T08:00:00.000Z',
    decided_at: null,
    suspended_at: null,
    decision_reason: null,
    created_by: APPLICANT_ID,
    updated_by: null,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
  organization: {
    organization_id: ORGANIZATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Acme Studio',
    verification_state: 'pending',
    verification_metadata: {},
    verification_revision: 0,
    verification_changed_by: null,
    verification_changed_at: null,
    created_by: APPLICANT_ID,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  },
  policy_acceptances: [],
  history: [],
};

const BASE_DETAIL_PROPS = {
  state: 'ready' as const,
  detail: DETAIL,
  reason: 'Organization verified',
  pending: false,
  conflict: false,
  errorCode: null,
  onReasonChange: noop,
  onDecision: noop,
  onSuspend: noop,
  onReload: noop,
};

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

  test('application detail gates submitted and approved lifecycle actions by state', () => {
    // Production break caught: rendering an action for an invalid application state enables an illegal decision.
    const submitted = renderToStaticMarkup(
      <AdminDeveloperApplicationDetailView {...BASE_DETAIL_PROPS} />,
    );
    const approved = renderToStaticMarkup(
      <AdminDeveloperApplicationDetailView
        {...BASE_DETAIL_PROPS}
        detail={{ ...DETAIL, application: { ...DETAIL.application, state: 'approved' } }}
      />,
    );

    expect(submitted).toContain('Approve application');
    expect(submitted).toContain('Reject application');
    expect(submitted).not.toContain('Suspend application');
    expect(approved).toContain('Suspend application');
    expect(approved).not.toContain('Approve application');
  });

  test('application detail disables mutations without a reason and offers only a latest-data reload after conflict', () => {
    // Production break caught: a blank reason or stale conflict permits a mutation instead of requiring fresh administrator input.
    const emptyReason = renderToStaticMarkup(
      <AdminDeveloperApplicationDetailView {...BASE_DETAIL_PROPS} reason="   " />,
    );
    const conflict = renderToStaticMarkup(
      <AdminDeveloperApplicationDetailView {...BASE_DETAIL_PROPS} conflict />,
    );

    expect(emptyReason).toMatch(/<button[^>]*disabled=""[^>]*>Approve application<\/button>/);
    expect(emptyReason).toMatch(/<button[^>]*disabled=""[^>]*>Reject application<\/button>/);
    expect(conflict).toContain('Reload latest application');
    expect(conflict).not.toContain('Retry decision');
  });

  test('application detail alerts expose an accessible alert role', () => {
    // Production break caught: hand-rolled status containers are not announced as alerts.
    const conflict = renderToStaticMarkup(
      <AdminDeveloperApplicationDetailView {...BASE_DETAIL_PROPS} conflict />,
    );
    const error = renderToStaticMarkup(
      <AdminDeveloperApplicationDetailView
        {...BASE_DETAIL_PROPS}
        errorCode="DEVELOPER_APPLICATION_INPUT_INVALID"
      />,
    );

    expect(conflict).toContain('role="alert"');
    expect(conflict).toContain('Reload latest application');
    expect(error).toContain('role="alert"');
  });
});
