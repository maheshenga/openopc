'use client';

import type { DeveloperModuleRelease, DeveloperModuleReviewEvent } from '@kortix/sdk';
import { ArrowLeft, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/lib/use-permission';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import { developerCenterErrorCode, publisherActionFor } from '../model';
import { DeveloperModuleManifestView } from '../shared/module-manifest-view';
import { DeveloperModuleRequirements } from '../shared/module-requirements';
import { DeveloperModuleStatusBadge } from '../shared/module-status-badge';
import { DeveloperModuleReviewTimeline } from '../shared/review-timeline';
import {
  usePublisherModuleDetail,
  usePublisherModuleHistory,
  useRequestPublisherReview,
} from './query';

export type PublisherReleaseDetailState =
  | 'loading'
  | 'no_account'
  | 'permission_denied'
  | 'error'
  | 'ready';

export interface PublisherReleaseDetailViewProps {
  state: PublisherReleaseDetailState;
  release: DeveloperModuleRelease | null;
  history: readonly DeveloperModuleReviewEvent[];
  canWrite: boolean;
  pending: boolean;
  errorCode: string | null;
  reason: string;
  onReasonChange: (value: string) => void;
  onRequestReview: (reason?: string) => void;
}

export function PublisherReleaseDetailView({
  state,
  release,
  history,
  canWrite,
  pending,
  errorCode,
  reason,
  onReasonChange,
  onRequestReview,
}: PublisherReleaseDetailViewProps) {
  if (state !== 'ready' || !release) {
    const message =
      state === 'loading'
        ? 'Loading release...'
        : state === 'no_account'
          ? 'Select an account to view this release.'
          : state === 'permission_denied'
            ? 'You do not have permission to view this release.'
            : (errorCode ?? 'DEVELOPER_REQUEST_FAILED');
    return (
      <main className="mx-auto flex min-h-80 w-full max-w-6xl items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
        {state === 'loading' ? <Loading /> : null}
        {message}
      </main>
    );
  }

  const action = publisherActionFor(release.status);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="space-y-4">
        <Button asChild type="button" size="xs" variant="ghost">
          <Link href="/developer/modules">
            <ArrowLeft />
            Recent releases
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{release.item_name}</h1>
              <DeveloperModuleStatusBadge status={release.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {release.module_id} · {release.module_version}
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>Revision {release.review_revision}</p>
            <p className="mt-1 break-all">{release.manifest_digest}</p>
          </div>
        </div>
      </header>

      {errorCode ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {errorCode}
        </div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <DeveloperModuleManifestView manifest={release.manifest} />
        <div className="space-y-6">
          <DeveloperModuleRequirements requirements={release.review_requirements} />
          {release.signature_algorithm && release.signature_key_id && release.signed_at ? (
            <section className="space-y-2 border-t pt-5" aria-label="Public signature">
              <h2 className="text-sm font-semibold">Signature verified</h2>
              <p className="text-muted-foreground text-xs">
                {release.signature_algorithm} / {release.signature_key_id}
              </p>
              <p className="text-muted-foreground text-xs">Signed {release.signed_at}</p>
              {release.published_at ? (
                <p className="text-muted-foreground text-xs">Published {release.published_at}</p>
              ) : null}
            </section>
          ) : null}
          <section className="space-y-3 border-t pt-5" aria-label="Publisher action">
            <h2 className="text-sm font-semibold">Publisher action</h2>
            {!action ? (
              <p className="text-sm text-muted-foreground">
                Read-only in the current lifecycle state.
              </p>
            ) : !canWrite ? (
              <p className="text-sm text-muted-foreground">
                Read-only. Account write permission is required.
              </p>
            ) : (
              <>
                {action === 'resubmit' ? (
                  <Textarea
                    value={reason}
                    maxLength={4_000}
                    minHeight={88}
                    placeholder="Optional explanation of the changes"
                    onChange={(event) => onReasonChange(event.target.value)}
                  />
                ) : null}
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => onRequestReview(action === 'resubmit' ? reason : undefined)}
                >
                  {pending ? <Loading /> : <Send />}
                  {pending
                    ? 'Submitting...'
                    : action === 'request_review'
                      ? 'Request review'
                      : 'Resubmit for review'}
                </Button>
              </>
            )}
          </section>
        </div>
      </div>

      <div className="border-t pt-6">
        <DeveloperModuleReviewTimeline events={history} />
      </div>
    </main>
  );
}

export function PublisherReleaseDetailPage({ releaseId }: { releaseId: string }) {
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const accountId = selectedAccountId ?? undefined;
  const readPermission = usePermission(accountId, 'account.read');
  const writePermission = usePermission(accountId, 'account.write');
  const detailQuery = usePublisherModuleDetail(
    selectedAccountId,
    releaseId,
    readPermission.allowed,
  );
  const historyQuery = usePublisherModuleHistory(
    selectedAccountId,
    releaseId,
    readPermission.allowed,
  );
  const reviewMutation = useRequestPublisherReview();
  const [reason, setReason] = useState('');

  let state: PublisherReleaseDetailState;
  if (!selectedAccountId) state = 'no_account';
  else if (readPermission.isLoading) state = 'loading';
  else if (readPermission.isError || !readPermission.allowed) state = 'permission_denied';
  else if (detailQuery.isLoading || historyQuery.isLoading) state = 'loading';
  else if (detailQuery.isError || historyQuery.isError || !detailQuery.data) state = 'error';
  else state = 'ready';

  const requestReview = (explanation?: string) => {
    const release = detailQuery.data;
    if (!selectedAccountId || !release) return;
    const action = publisherActionFor(release.status);
    if (!action) return;

    reviewMutation.mutate({
      accountId: selectedAccountId,
      releaseId,
      expectedStatus: release.status as 'validated' | 'changes_requested',
      expectedRevision: release.review_revision,
      reason: action === 'resubmit' && explanation?.trim() ? explanation.trim() : undefined,
    });
  };

  const error = reviewMutation.error ?? detailQuery.error ?? historyQuery.error;

  return (
    <PublisherReleaseDetailView
      state={state}
      release={detailQuery.data ?? null}
      history={historyQuery.data?.history ?? []}
      canWrite={writePermission.allowed}
      pending={reviewMutation.isPending}
      errorCode={error ? developerCenterErrorCode(error) : null}
      reason={reason}
      onReasonChange={setReason}
      onRequestReview={requestReview}
    />
  );
}
