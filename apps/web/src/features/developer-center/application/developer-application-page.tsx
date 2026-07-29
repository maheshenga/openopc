'use client';

import {
  type DeveloperApplication,
  type DeveloperApplicationPolicyVersions,
  type DeveloperApplicationSubmission,
  getCurrentDeveloperApplication,
  submitDeveloperApplication,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building2, CheckCircle2, Clock3, ShieldAlert, XCircle } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { usePermission } from '@/lib/use-permission';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export type DeveloperApplicationPageState =
  | 'loading'
  | 'no_account'
  | 'permission_denied'
  | 'error'
  | 'available'
  | 'current';

export interface DeveloperApplicationViewProps {
  state: DeveloperApplicationPageState;
  application: DeveloperApplication | null;
  currentPolicyVersions: DeveloperApplicationPolicyVersions | null;
  organizationName: string;
  acceptedPolicies: Record<keyof DeveloperApplicationPolicyVersions, boolean>;
  canWrite: boolean;
  pending: boolean;
  errorCode: string | null;
  onOrganizationNameChange: (value: string) => void;
  onPolicyAcceptedChange: (
    policy: keyof DeveloperApplicationPolicyVersions,
    checked: boolean,
  ) => void;
  onSubmit: () => void;
}

export interface DeveloperApplicationFormState {
  accountId: string | null;
  organizationName: string;
  acceptedPolicies: Record<keyof DeveloperApplicationPolicyVersions, boolean>;
}

export function developerApplicationFormStateForAccount(
  current: DeveloperApplicationFormState,
  accountId: string | null,
): DeveloperApplicationFormState {
  if (current.accountId === accountId) return current;
  return {
    accountId,
    organizationName: '',
    acceptedPolicies: { moduleRules: false, acceptableUse: false },
  };
}

const APPLICATION_ERROR_CODES = new Set([
  'DEVELOPER_APPLICATION_INPUT_INVALID',
  'DEVELOPER_APPLICATION_POLICY_STALE',
  'DEVELOPER_APPLICATION_NOT_FOUND',
  'DEVELOPER_APPLICATION_FORBIDDEN',
  'DEVELOPER_APPLICATION_STEP_UP_REQUIRED',
  'DEVELOPER_APPLICATION_CONFLICT',
  'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE',
]);

function developerApplicationErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'DEVELOPER_APPLICATION_REQUEST_FAILED';
  const record = error as { code?: unknown; body?: unknown };
  const candidates = [
    record.code,
    record.body && typeof record.body === 'object'
      ? (record.body as { error?: unknown }).error
      : null,
  ];
  const known = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && APPLICATION_ERROR_CODES.has(candidate),
  );
  return known ?? 'DEVELOPER_APPLICATION_REQUEST_FAILED';
}

function dateLabel(value: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}

function ApplicationStatus({ application }: { application: DeveloperApplication }) {
  const presentation = {
    draft: {
      icon: Clock3,
      title: 'Application draft',
      description: 'Complete and submit the application before it can be reviewed.',
    },
    submitted: {
      icon: Clock3,
      title: 'Application submitted',
      description: 'The platform team will verify the organization before granting authority.',
    },
    under_review: {
      icon: Clock3,
      title: 'Application under review',
      description: 'Organization verification and policy checks are in progress.',
    },
    approved: {
      icon: CheckCircle2,
      title: 'Application approved',
      description: 'The verified organization can now create a Publisher and manage modules.',
    },
    rejected: {
      icon: XCircle,
      title: 'Application rejected',
      description: 'The application did not satisfy the current verification requirements.',
    },
    suspended: {
      icon: ShieldAlert,
      title: 'Application suspended',
      description: 'Developer authority is paused while the organization is reviewed again.',
    },
  }[application.state];
  const Icon = presentation.icon;

  return (
    <section className="space-y-6 border-y py-8" aria-label="Developer application status">
      <div className="flex items-start gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground/5">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{presentation.title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {presentation.description}
          </p>
        </div>
      </div>

      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Revision</dt>
          <dd className="mt-1 text-sm font-medium">Revision {application.revision}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Submitted</dt>
          <dd className="mt-1 text-sm font-medium">{dateLabel(application.submitted_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Policy versions</dt>
          <dd className="mt-1 text-sm font-medium">
            {application.policy_versions.moduleRules} · {application.policy_versions.acceptableUse}
          </dd>
        </div>
      </dl>

      {application.decision_reason ? (
        <div className="border-l-2 pl-4 text-sm">
          <p className="font-medium">Platform decision</p>
          <p className="mt-1 leading-6 text-muted-foreground">{application.decision_reason}</p>
        </div>
      ) : null}

      {application.state === 'approved' ? (
        <Button asChild>
          <Link href="/developer/modules">
            Open Developer Center
            <ArrowRight />
          </Link>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          An application by itself does not grant module upload or release access.
        </p>
      )}
    </section>
  );
}

export function DeveloperApplicationView({
  state,
  application,
  currentPolicyVersions,
  organizationName,
  acceptedPolicies,
  canWrite,
  pending,
  errorCode,
  onOrganizationNameChange,
  onPolicyAcceptedChange,
  onSubmit,
}: DeveloperApplicationViewProps) {
  const canSubmit =
    state === 'available' &&
    canWrite &&
    !pending &&
    Boolean(currentPolicyVersions) &&
    Boolean(organizationName.trim()) &&
    acceptedPolicies.moduleRules &&
    acceptedPolicies.acceptableUse;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8 md:py-10">
      <header className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Developer application</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Verify one organization before creating Publishers, uploading modules, or requesting a
          release.
        </p>
      </header>

      {errorCode ? (
        <div className="border-l-2 border-destructive py-1 pl-4 text-sm">
          <p className="font-medium">{errorCode}</p>
          <p className="mt-1 text-muted-foreground">Try again after checking your connection.</p>
        </div>
      ) : null}

      {state === 'loading' ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loading />
          Loading developer application...
        </div>
      ) : null}
      {state === 'no_account' ? (
        <p className="border-y py-12 text-center text-sm text-muted-foreground">
          Select an account to apply for developer access.
        </p>
      ) : null}
      {state === 'permission_denied' ? (
        <p className="border-y py-12 text-center text-sm text-muted-foreground">
          You do not have permission to view developer admission for this account.
        </p>
      ) : null}
      {state === 'error' ? (
        <p className="border-y py-12 text-center text-sm text-muted-foreground">
          Developer admission is temporarily unavailable.
        </p>
      ) : null}

      {state === 'available' ? (
        <form
          onSubmit={submit}
          className="grid gap-8 border-y py-8 md:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <section className="space-y-6" aria-label="Developer application form">
            <div className="space-y-2">
              <label htmlFor="developer-organization-name" className="text-sm font-medium">
                Organization
              </label>
              <Input
                id="developer-organization-name"
                value={organizationName}
                maxLength={255}
                placeholder="Organization legal or public name"
                disabled={!canWrite || pending}
                onChange={(event) => onOrganizationNameChange(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Invited applicants must use the same organization name already linked to the
                account.
              </p>
            </div>

            <fieldset className="space-y-3" disabled={!canWrite || pending}>
              <legend className="text-sm font-medium">Required policies</legend>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input accent-foreground"
                  checked={acceptedPolicies.moduleRules}
                  onChange={(event) => onPolicyAcceptedChange('moduleRules', event.target.checked)}
                />
                <span>
                  I accept Module Rules{' '}
                  <span className="font-medium">{currentPolicyVersions?.moduleRules ?? '—'}</span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input accent-foreground"
                  checked={acceptedPolicies.acceptableUse}
                  onChange={(event) =>
                    onPolicyAcceptedChange('acceptableUse', event.target.checked)
                  }
                />
                <span>
                  I accept Acceptable Use{' '}
                  <span className="font-medium">{currentPolicyVersions?.acceptableUse ?? '—'}</span>
                </span>
              </label>
            </fieldset>

            {!canWrite ? (
              <p className="text-sm text-muted-foreground">
                Account write permission is required to submit an application.
              </p>
            ) : null}
            <Button type="submit" disabled={!canSubmit}>
              {pending ? <Loading /> : <Building2 />}
              {pending ? 'Submitting...' : 'Submit application'}
            </Button>
          </section>

          <aside className="space-y-4 border-t pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
            <h2 className="text-sm font-semibold">What happens next</h2>
            <ol className="space-y-4 text-sm text-muted-foreground">
              <li>1. The platform reviews the account and organization.</li>
              <li>2. Organization verification is recorded once and shared with invitations.</li>
              <li>3. Publisher creation unlocks only after approval and verification.</li>
            </ol>
          </aside>
        </form>
      ) : null}

      {state === 'current' && application ? <ApplicationStatus application={application} /> : null}
    </main>
  );
}

const developerApplicationKeys = {
  current: (accountId: string) => ['developer-application', accountId, 'current'] as const,
};

export function DeveloperApplicationPage() {
  const queryClient = useQueryClient();
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const accountId = selectedAccountId ?? undefined;
  const readPermission = usePermission(accountId, 'account.read');
  const writePermission = usePermission(accountId, 'account.write');
  const [storedFormState, setStoredFormState] = useState<DeveloperApplicationFormState>({
    accountId: selectedAccountId,
    organizationName: '',
    acceptedPolicies: { moduleRules: false, acceptableUse: false },
  });
  const formState = developerApplicationFormStateForAccount(storedFormState, selectedAccountId);
  const { organizationName, acceptedPolicies } = formState;

  const currentQuery = useQuery({
    queryKey: selectedAccountId
      ? developerApplicationKeys.current(selectedAccountId)
      : ['developer-application', 'no-account'],
    queryFn: () => getCurrentDeveloperApplication({ accountId: selectedAccountId as string }),
    enabled: Boolean(selectedAccountId) && readPermission.allowed,
    retry: false,
    staleTime: 15_000,
  });

  const submission = useMutation({
    mutationFn: async () => {
      if (!selectedAccountId || !currentQuery.data) {
        throw new Error('DEVELOPER_APPLICATION_REQUEST_FAILED');
      }
      return submitDeveloperApplication({
        accountId: selectedAccountId,
        organizationName: organizationName.trim(),
        policyVersions: currentQuery.data.current_policy_versions,
      });
    },
    onSuccess: (result: DeveloperApplicationSubmission) => {
      if (!selectedAccountId) return;
      queryClient.setQueryData(developerApplicationKeys.current(selectedAccountId), result);
    },
  });

  let state: DeveloperApplicationPageState;
  if (!selectedAccountId) state = 'no_account';
  else if (readPermission.isLoading || writePermission.isLoading) state = 'loading';
  else if (readPermission.isError || !readPermission.allowed) state = 'permission_denied';
  else if (currentQuery.isLoading) state = 'loading';
  else if (currentQuery.isError) state = 'error';
  else if (currentQuery.data?.application) state = 'current';
  else state = 'available';

  const error = submission.error ?? currentQuery.error;

  return (
    <DeveloperApplicationView
      state={state}
      application={currentQuery.data?.application ?? null}
      currentPolicyVersions={currentQuery.data?.current_policy_versions ?? null}
      organizationName={organizationName}
      acceptedPolicies={acceptedPolicies}
      canWrite={writePermission.allowed}
      pending={submission.isPending}
      errorCode={error ? developerApplicationErrorCode(error) : null}
      onOrganizationNameChange={(value) =>
        setStoredFormState((current) => ({
          ...developerApplicationFormStateForAccount(current, selectedAccountId),
          organizationName: value,
        }))
      }
      onPolicyAcceptedChange={(policy, checked) =>
        setStoredFormState((current) => {
          const active = developerApplicationFormStateForAccount(current, selectedAccountId);
          return {
            ...active,
            acceptedPolicies: { ...active.acceptedPolicies, [policy]: checked },
          };
        })
      }
      onSubmit={() => submission.mutate()}
    />
  );
}
