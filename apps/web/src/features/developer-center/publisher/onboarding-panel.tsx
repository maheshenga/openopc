'use client';

import type { DeveloperAccess, DeveloperOrganization } from '@kortix/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';

import { developerCenterErrorCode } from '../model';
import {
  reconcilePublisherSelection,
  selectableDeveloperPublishers,
  type SelectableDeveloperPublisher,
} from './access';
import {
  developerPublisherAccessKeys,
  useCreateDeveloperPublisher,
  useDeveloperPublisherAccess,
} from './access-query';
import { DeveloperPublisherSelect } from './publisher-select';

export type DeveloperPublisherOnboardingState = 'loading' | 'error' | 'ready';

export interface DeveloperPublisherOnboardingViewProps {
  state: DeveloperPublisherOnboardingState;
  organization: DeveloperOrganization | null;
  publishers: readonly SelectableDeveloperPublisher[];
  selectedPublisherId: string;
  createOpen?: boolean;
  slug: string;
  displayName: string;
  canWrite: boolean;
  pending: boolean;
  errorCode: string | null;
  onSlugChange: (value: string) => void;
  onDisplayNameChange: (value: string) => void;
  onPublisherChange: (publisherId: string) => void;
  onCreateOpenChange?: (open: boolean) => void;
  onCreate: () => void;
}

function CreationForm({
  slug,
  displayName,
  canWrite,
  pending,
  organization,
  onSlugChange,
  onDisplayNameChange,
  onCreate,
}: Pick<
  DeveloperPublisherOnboardingViewProps,
  | 'slug'
  | 'displayName'
  | 'canWrite'
  | 'pending'
  | 'organization'
  | 'onSlugChange'
  | 'onDisplayNameChange'
  | 'onCreate'
>) {
  const canCreate =
    canWrite &&
    !pending &&
    Boolean(organization) &&
    Boolean(slug.trim()) &&
    Boolean(displayName.trim());
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canCreate) onCreate();
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 border-t pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
    >
      <div className="space-y-2">
        <label htmlFor="developer-publisher-slug" className="text-sm font-medium">
          Publisher slug
        </label>
        <Input
          id="developer-publisher-slug"
          value={slug}
          maxLength={64}
          placeholder="acme"
          disabled={!canWrite || pending || !organization}
          onChange={(event) => onSlugChange(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="developer-publisher-display-name" className="text-sm font-medium">
          Display name
        </label>
        <Input
          id="developer-publisher-display-name"
          value={displayName}
          maxLength={255}
          placeholder="Acme Studio"
          disabled={!canWrite || pending || !organization}
          onChange={(event) => onDisplayNameChange(event.target.value)}
        />
      </div>
      <Button type="submit" className="min-h-10" disabled={!canCreate}>
        {pending ? <Loading /> : null}
        {pending ? 'Creating...' : 'Create Publisher'}
      </Button>
    </form>
  );
}

export function DeveloperPublisherOnboardingView({
  state,
  organization,
  publishers,
  selectedPublisherId,
  createOpen = false,
  slug,
  displayName,
  canWrite,
  pending,
  errorCode,
  onSlugChange,
  onDisplayNameChange,
  onPublisherChange,
  onCreateOpenChange = () => undefined,
  onCreate,
}: DeveloperPublisherOnboardingViewProps) {
  const hasPublishers = publishers.length > 0;
  return (
    <section className="space-y-5 border-y py-8" aria-label="Publisher onboarding">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Publisher onboarding</h2>
        <p className="text-muted-foreground text-sm leading-6">
          Create or choose an account-scoped Publisher for your approved developer application.
        </p>
      </div>

      {state === 'loading' ? (
        <div className="text-muted-foreground flex min-h-24 items-center gap-2 text-sm">
          <Loading />
          Loading Publisher access...
        </div>
      ) : null}
      {state === 'error' ? (
        <InfoBanner tone="destructive" title={errorCode ?? 'DEVELOPER_REQUEST_FAILED'}>
          Developer access is temporarily unavailable.
        </InfoBanner>
      ) : null}
      {state === 'ready' && errorCode ? (
        <InfoBanner tone="destructive" title={errorCode}>
          Try again after checking your connection.
        </InfoBanner>
      ) : null}
      {state === 'ready' && !organization ? (
        <InfoBanner tone="destructive" title="DEVELOPER_ORGANIZATION_NOT_FOUND">
          Publisher onboarding is unavailable until the approved organization is linked.
        </InfoBanner>
      ) : null}
      {state === 'ready' && organization ? (
        <div className="space-y-4">
          {hasPublishers ? (
            <div className="space-y-2">
              <label htmlFor="developer-publisher-select" className="text-sm font-medium">
                Choose a Publisher
              </label>
              <DeveloperPublisherSelect
                id="developer-publisher-select"
                publishers={publishers}
                value={selectedPublisherId}
                disabled={!canWrite || pending}
                onValueChange={onPublisherChange}
              />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Link
                  href="/developer/modules"
                  className="text-muted-foreground hover:text-foreground inline-flex min-h-10 items-center gap-1.5 underline-offset-4 hover:underline"
                >
                  Open modules <ExternalLink className="size-3.5" />
                </Link>
                {canWrite ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-10"
                    onClick={() => onCreateOpenChange(!createOpen)}
                  >
                    <Plus />
                    Create another Publisher
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {!hasPublishers || createOpen ? (
            <CreationForm
              slug={slug}
              displayName={displayName}
              canWrite={canWrite}
              pending={pending}
              organization={organization}
              onSlugChange={onSlugChange}
              onDisplayNameChange={onDisplayNameChange}
              onCreate={onCreate}
            />
          ) : null}
          {!canWrite ? (
            <p className="text-muted-foreground text-sm">
              Account write permission is required to create or change a Publisher.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export interface DeveloperPublisherOnboardingPanelProps {
  accountId: string;
  canWrite: boolean;
}

export function DeveloperPublisherOnboardingPanel({
  accountId,
  canWrite,
}: DeveloperPublisherOnboardingPanelProps) {
  const queryClient = useQueryClient();
  const accessQuery = useDeveloperPublisherAccess(accountId);
  const createMutation = useCreateDeveloperPublisher();
  const [selection, setSelection] = useState({ accountId: null as string | null, publisherId: '' });
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const accountAccess = accessQuery.data?.account_id === accountId ? accessQuery.data : undefined;

  const publishers = useMemo(() => selectableDeveloperPublishers(accountAccess), [accountAccess]);
  const reconciledSelection = reconcilePublisherSelection(selection, accountId, accountAccess);
  useEffect(() => {
    if (
      selection.accountId !== reconciledSelection.accountId ||
      selection.publisherId !== reconciledSelection.publisherId
    ) {
      setSelection(reconciledSelection);
    }
  }, [reconciledSelection, selection.accountId, selection.publisherId]);

  const state: DeveloperPublisherOnboardingState = accessQuery.isLoading
    ? 'loading'
    : accessQuery.isError
      ? 'error'
      : 'ready';
  const errorCode = createMutation.error
    ? developerCenterErrorCode(createMutation.error)
    : accessQuery.error
      ? developerCenterErrorCode(accessQuery.error)
      : null;

  const create = () => {
    const organization = accountAccess?.organization;
    if (
      !canWrite ||
      createMutation.isPending ||
      !organization ||
      !slug.trim() ||
      !displayName.trim()
    ) {
      return;
    }
    createMutation.mutate(
      {
        accountId,
        organizationId: organization.organization_id,
        slug: slug.trim(),
        displayName: displayName.trim(),
      },
      {
        onSuccess: (result) => {
          setSelection({ accountId, publisherId: result.publisher.publisher_id });
          setCreateOpen(false);
          setSlug('');
          setDisplayName('');
          queryClient.setQueryData<DeveloperAccess>(
            developerPublisherAccessKeys.account(accountId),
            (current) =>
              current
                ? {
                    ...current,
                    publishers: [
                      ...current.publishers,
                      { publisher: result.publisher, membership: result.member },
                    ],
                  }
                : current,
          );
        },
      },
    );
  };

  return (
    <DeveloperPublisherOnboardingView
      state={state}
      organization={accountAccess?.organization ?? null}
      publishers={publishers}
      selectedPublisherId={reconciledSelection.publisherId}
      createOpen={createOpen}
      slug={slug}
      displayName={displayName}
      canWrite={canWrite}
      pending={createMutation.isPending}
      errorCode={errorCode}
      onSlugChange={setSlug}
      onDisplayNameChange={setDisplayName}
      onPublisherChange={(publisherId) => setSelection({ accountId, publisherId })}
      onCreateOpenChange={setCreateOpen}
      onCreate={create}
    />
  );
}
