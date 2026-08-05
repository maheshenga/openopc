import type { DeveloperApplication, DeveloperApplicationPolicyVersions } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import type { ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const POLICIES: DeveloperApplicationPolicyVersions = {
  moduleRules: '2026-07-28',
  acceptableUse: '2026-07-28',
};

const APPLICATION: DeveloperApplication = {
  application_id: '10000000-0000-4000-a000-000000000001',
  account_id: '20000000-0000-4000-a000-000000000002',
  organization_id: '30000000-0000-4000-a000-000000000003',
  state: 'submitted',
  revision: 0,
  policy_versions: POLICIES,
  submitted_at: '2026-07-28T08:00:00.000Z',
  decided_at: null,
  suspended_at: null,
  decision_reason: null,
  created_by: '40000000-0000-4000-a000-000000000004',
  updated_by: null,
  created_at: '2026-07-28T08:00:00.000Z',
  updated_at: '2026-07-28T08:00:00.000Z',
};

type ViewProps = {
  state: 'loading' | 'no_account' | 'permission_denied' | 'error' | 'available' | 'current';
  application: DeveloperApplication | null;
  currentPolicyVersions: DeveloperApplicationPolicyVersions | null;
  organizationName: string;
  acceptedPolicies: { moduleRules: boolean; acceptableUse: boolean };
  canWrite: boolean;
  pending: boolean;
  errorCode: string | null;
  onOrganizationNameChange: (value: string) => void;
  onPolicyAcceptedChange: (
    policy: keyof DeveloperApplicationPolicyVersions,
    checked: boolean,
  ) => void;
  onSubmit: () => void;
  approvedContent?: ReactNode;
};

async function view(): Promise<ComponentType<ViewProps>> {
  let loadedModule: Record<string, unknown> = {};
  try {
    loadedModule = (await import('./developer-application-page')) as Record<string, unknown>;
  } catch {}
  expect(loadedModule.DeveloperApplicationView).toBeFunction();
  return loadedModule.DeveloperApplicationView as ComponentType<ViewProps>;
}

const noop = () => undefined;

test('renders a policy-bound application form without implying module authority', async () => {
  const View = await view();
  const base = {
    state: 'available' as const,
    application: null,
    currentPolicyVersions: POLICIES,
    organizationName: 'Acme Studio',
    canWrite: true,
    pending: false,
    errorCode: null,
    onOrganizationNameChange: noop,
    onPolicyAcceptedChange: noop,
    onSubmit: noop,
  };
  const blocked = renderToStaticMarkup(
    <View {...base} acceptedPolicies={{ moduleRules: true, acceptableUse: false }} />,
  );
  const ready = renderToStaticMarkup(
    <View {...base} acceptedPolicies={{ moduleRules: true, acceptableUse: true }} />,
  );

  expect(blocked).toContain('Developer application');
  expect(blocked).toContain('Module Rules');
  expect(blocked).toContain('Acceptable Use');
  expect(blocked).toContain('2026-07-28');
  expect(blocked).toContain('disabled=""');
  expect(ready).toContain('Submit application');
  expect(ready).not.toContain('disabled=""');
  expect(ready).not.toContain('Upload module');
});

test('renders governed submitted, approved, rejected, and suspended states', async () => {
  const View = await view();
  const render = (application: DeveloperApplication) =>
    renderToStaticMarkup(
      <View
        state="current"
        application={application}
        currentPolicyVersions={POLICIES}
        organizationName=""
        acceptedPolicies={{ moduleRules: false, acceptableUse: false }}
        canWrite
        pending={false}
        errorCode={null}
        onOrganizationNameChange={noop}
        onPolicyAcceptedChange={noop}
        onSubmit={noop}
      />,
    );

  const submitted = render(APPLICATION);
  const approved = render({ ...APPLICATION, state: 'approved', revision: 1 });
  const rejected = render({
    ...APPLICATION,
    state: 'rejected',
    revision: 1,
    decision_reason: 'Organization details could not be verified.',
  });
  const suspended = render({
    ...APPLICATION,
    state: 'suspended',
    revision: 2,
    decision_reason: 'Verification needs to be renewed.',
  });

  expect(submitted).toContain('Application submitted');
  expect(submitted).toContain('Revision 0');
  expect(submitted).toContain('does not grant module upload or release access');
  expect(approved).toContain('Open Developer Center');
  expect(rejected).toContain('Organization details could not be verified.');
  expect(suspended).toContain('Verification needs to be renewed.');

  const approvedWithContent = renderToStaticMarkup(
    <View
      state="current"
      application={{ ...APPLICATION, state: 'approved', revision: 1 }}
      currentPolicyVersions={POLICIES}
      organizationName=""
      acceptedPolicies={{ moduleRules: false, acceptableUse: false }}
      canWrite
      pending={false}
      errorCode={null}
      onOrganizationNameChange={noop}
      onPolicyAcceptedChange={noop}
      onSubmit={noop}
      approvedContent={<div>Publisher onboarding ready</div>}
    />,
  );
  expect(approvedWithContent).toContain('Publisher onboarding ready');
});

test('renders account, permission, loading, and recoverable error boundaries', async () => {
  const View = await view();
  const render = (state: ViewProps['state'], errorCode: string | null = null) =>
    renderToStaticMarkup(
      <View
        state={state}
        application={null}
        currentPolicyVersions={null}
        organizationName=""
        acceptedPolicies={{ moduleRules: false, acceptableUse: false }}
        canWrite={false}
        pending={false}
        errorCode={errorCode}
        onOrganizationNameChange={noop}
        onPolicyAcceptedChange={noop}
        onSubmit={noop}
      />,
    );

  expect(render('loading')).toContain('Loading developer application');
  expect(render('no_account')).toContain('Select an account');
  expect(render('permission_denied')).toContain('permission');
  expect(render('error', 'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE')).toContain(
    'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE',
  );
});

test('resets organization and policy confirmations when the selected account changes', async () => {
  const loadedModule = (await import('./developer-application-page')) as Record<string, unknown>;
  expect(loadedModule.developerApplicationFormStateForAccount).toBeFunction();
  const formStateForAccount = loadedModule.developerApplicationFormStateForAccount as (
    current: {
      accountId: string | null;
      organizationName: string;
      acceptedPolicies: { moduleRules: boolean; acceptableUse: boolean };
    },
    accountId: string | null,
  ) => {
    accountId: string | null;
    organizationName: string;
    acceptedPolicies: { moduleRules: boolean; acceptableUse: boolean };
  };
  const current = {
    accountId: 'account-a',
    organizationName: 'Account A Studio',
    acceptedPolicies: { moduleRules: true, acceptableUse: true },
  };

  expect(formStateForAccount(current, 'account-a')).toEqual(current);
  expect(formStateForAccount(current, 'account-b')).toEqual({
    accountId: 'account-b',
    organizationName: '',
    acceptedPolicies: { moduleRules: false, acceptableUse: false },
  });
});
