'use client';

import type {
  DeveloperModuleRelease,
  DeveloperModuleReviewEvidence,
} from '@kortix/sdk';
import { ArrowLeft, ClipboardCheck, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';

import { DeveloperModuleManifestView } from '../shared/module-manifest-view';
import { DeveloperModuleRequirements } from '../shared/module-requirements';
import { DeveloperModuleStatusBadge } from '../shared/module-status-badge';
import { DeveloperModuleReviewTimeline } from '../shared/review-timeline';
import {
  type AdminDeveloperLifecycleEvent,
  type AdminDeveloperReviewDecision,
  adminDeveloperReviewErrorCode,
} from './client';
import { createEvidenceDrafts, isApprovalEvidenceComplete, isReviewReasonValid } from './evidence';
import {
  useAdminDeveloperDistribution,
  useAdminDeveloperReviewDecision,
  useAdminDeveloperReviewDetail,
} from './query';

export type AdminReviewDetailState = 'loading' | 'error' | 'ready';

function dateTimeInputValue(value: string): string {
  return value.slice(0, 16);
}

function isoFromDateTimeInput(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? value : timestamp.toISOString();
}

function detailErrorMessage(errorCode: string | null): string {
  if (errorCode === 'DEVELOPER_RELEASE_NOT_FOUND') return 'This release is not available.';
  if (errorCode === 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED') {
    return 'An independent administrator must approve this release.';
  }
  return 'The review detail could not be loaded. Try again.';
}

export interface AdminDeveloperReviewDetailViewProps {
  state: AdminReviewDetailState;
  release: DeveloperModuleRelease | null;
  history: readonly AdminDeveloperLifecycleEvent[];
  evidence: readonly DeveloperModuleReviewEvidence[];
  reason: string;
  pending: boolean;
  reloadPending?: boolean;
  conflict: boolean;
  distributionPending?: boolean;
  revokeOpen: boolean;
  errorCode: string | null;
  onReasonChange: (value: string) => void;
  onEvidenceChange: (index: number, patch: Partial<DeveloperModuleReviewEvidence>) => void;
  onDecision: (
    decision: AdminDeveloperReviewDecision,
    input: { reason?: string; evidence?: readonly DeveloperModuleReviewEvidence[] },
  ) => void;
  onDistributionAction?: (action: 'sign' | 'publish') => void;
  onReload: () => void | Promise<void>;
  onRevokeOpenChange: (open: boolean) => void;
}

export function AdminDeveloperReviewDetailView({
  state,
  release,
  history,
  evidence,
  reason,
  pending,
  reloadPending = false,
  conflict,
  distributionPending = false,
  revokeOpen,
  errorCode,
  onReasonChange,
  onEvidenceChange,
  onDecision,
  onDistributionAction = () => undefined,
  onReload,
  onRevokeOpenChange,
}: AdminDeveloperReviewDetailViewProps) {
  if (state !== 'ready' || !release) {
    return (
      <main className="text-muted-foreground mx-auto flex min-h-80 w-full max-w-6xl items-center justify-center gap-2 px-4 py-8 text-sm">
        {state === 'loading' ? <Loading /> : null}
        {state === 'loading' ? 'Loading review...' : detailErrorMessage(errorCode)}
      </main>
    );
  }

  const evidenceComplete = isApprovalEvidenceComplete(release.review_requirements, evidence, {
    releaseCreatedAt: release.created_at,
  });
  const reasonComplete = isReviewReasonValid(reason);
  const optionalReasonValid = !reason.trim() || reasonComplete;
  const controlsPending = pending || reloadPending;
  const reviewPending = release.status === 'review_pending';
  const approved = release.status === 'approved';
  const distributionAction =
    release.status === 'approved' ? 'sign' : release.status === 'signed' ? 'publish' : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="space-y-4">
        <Button asChild type="button" size="xs" variant="ghost">
          <Link href="/admin/developer-reviews">
            <ArrowLeft />
            Review queue
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{release.item_name}</h1>
              <DeveloperModuleStatusBadge status={release.status} />
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {release.module_id} / {release.module_version}
            </p>
          </div>
          <div className="text-muted-foreground text-right text-xs">
            <p>Revision {release.review_revision}</p>
            <p className="mt-1 break-all">{release.manifest_digest}</p>
          </div>
        </div>
      </header>

      {conflict ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium">Another administrator changed this release.</p>
          <p className="text-muted-foreground mt-1">
            Inspect the latest status and revision before submitting a new decision.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={reloadPending}
            onClick={onReload}
          >
            Reload latest release
          </Button>
        </div>
      ) : null}
      {errorCode && !conflict ? (
        <div className="border-destructive/30 bg-destructive/5 rounded-lg border p-3 text-sm">
          {detailErrorMessage(errorCode)}
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
          <section className="space-y-3 border-t pt-5" aria-label="Review decisions">
            <h2 className="text-sm font-semibold">Review decisions</h2>
            <Textarea
              value={reason}
              maxLength={4_000}
              minHeight={96}
              placeholder="Reason for request changes or emergency revoke"
              onChange={(event) => onReasonChange(event.target.value)}
              disabled={controlsPending || conflict}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-testid="request-changes-decision"
                variant="outline"
                disabled={controlsPending || conflict || !reviewPending || !reasonComplete}
                onClick={() => onDecision('request_changes', { reason: reason.trim() })}
              >
                Request changes
              </Button>
              <Button
                type="button"
                data-testid="approve-decision"
                disabled={
                  controlsPending ||
                  conflict ||
                  !reviewPending ||
                  !evidenceComplete ||
                  !optionalReasonValid
                }
                onClick={() => onDecision('approve', { evidence })}
              >
                {pending ? <Loading /> : <ClipboardCheck />}
                Approve
              </Button>
              <AlertDialog open={revokeOpen} onOpenChange={onRevokeOpenChange}>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    data-testid="revoke-decision"
                    variant="destructive"
                    disabled={controlsPending || conflict || !approved || !reasonComplete}
                  >
                    <ShieldAlert />
                    Emergency revoke
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Confirm emergency revoke</AlertDialogTitle>
                    <AlertDialogDescription>
                      Revoke {release.module_id} version {release.module_version}? This changes the
                      release lifecycle and is recorded in the immutable review history.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <Textarea
                    value={reason}
                    maxLength={4_000}
                    minHeight={96}
                    placeholder="Required emergency reason"
                    onChange={(event) => onReasonChange(event.target.value)}
                    disabled={controlsPending}
                  />
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={controlsPending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={controlsPending || !reasonComplete}
                      onClick={() => onDecision('revoke', { reason: reason.trim() })}
                    >
                      Revoke release
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {distributionAction ? (
                <Button
                  type="button"
                  data-testid={`${distributionAction}-release`}
                  disabled={controlsPending || conflict || distributionPending}
                  onClick={() => onDistributionAction(distributionAction)}
                >
                  {distributionPending ? <Loading /> : null}
                  {distributionAction === 'sign' ? 'Sign release' : 'Publish release'}
                </Button>
              ) : release.status === 'revoked' ? (
                <p data-testid="distribution-disabled" className="text-muted-foreground text-xs">
                  No distribution actions available for a revoked release.
                </p>
              ) : null}
              <span className="sr-only">
                Confirm emergency revoke {release.module_id} version {release.module_version}
              </span>
            </div>
            {!evidenceComplete && reviewPending ? (
              <p className="text-muted-foreground text-xs">
                Complete one manual passed attestation for every requirement before approval.
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {reviewPending ? (
        <section className="space-y-4 border-t pt-6" aria-label="Manual review evidence">
          <div>
            <h2 className="text-base font-semibold">Manual review evidence</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Record a redacted conclusion for each declared requirement. Raw logs and credentials
              do not belong here.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {release.review_requirements.map((requirement, index) => {
              const entry = evidence[index] ?? {
                requirement,
                outcome: 'passed' as const,
                method: 'manual' as const,
                summary: '',
                observed_at: new Date().toISOString(),
              };
              return (
                <div
                  key={requirement}
                  className="border-border/60 bg-card space-y-3 rounded-xl border p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{requirement}</h3>
                    <span className="text-muted-foreground text-xs">Manual / Passed</span>
                  </div>
                  <Textarea
                    value={entry.summary}
                    maxLength={1_000}
                    minHeight={88}
                    placeholder="Redacted review conclusion"
                    aria-label={`${requirement} evidence summary`}
                    disabled={controlsPending || conflict}
                    onChange={(event) => onEvidenceChange(index, { summary: event.target.value })}
                  />
                  <Input
                    type="datetime-local"
                    value={dateTimeInputValue(entry.observed_at)}
                    aria-label={`${requirement} observed at`}
                    disabled={controlsPending || conflict}
                    onChange={(event) =>
                      onEvidenceChange(index, {
                        observed_at: isoFromDateTimeInput(event.target.value),
                      })
                    }
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      value={entry.tool ?? ''}
                      placeholder="Tool (optional)"
                      aria-label={`${requirement} tool`}
                      disabled={controlsPending || conflict}
                      onChange={(event) =>
                        onEvidenceChange(index, { tool: event.target.value || undefined })
                      }
                    />
                    <Input
                      value={entry.tool_version ?? ''}
                      placeholder="Tool version"
                      aria-label={`${requirement} tool version`}
                      disabled={controlsPending || conflict}
                      onChange={(event) =>
                        onEvidenceChange(index, { tool_version: event.target.value || undefined })
                      }
                    />
                  </div>
                  <Input
                    value={entry.evidence_digest ?? ''}
                    placeholder="sha256:... (optional)"
                    aria-label={`${requirement} evidence digest`}
                    disabled={controlsPending || conflict}
                    onChange={(event) =>
                      onEvidenceChange(index, {
                        evidence_digest: (event.target.value || undefined) as
                          DeveloperModuleReviewEvidence['evidence_digest'] | undefined,
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="border-t pt-6">
        <DeveloperModuleReviewTimeline events={history} />
      </div>
    </main>
  );
}

export function AdminDeveloperReviewDetailPage({ releaseId }: { releaseId: string }) {
  const detailQuery = useAdminDeveloperReviewDetail(releaseId);
  const mutation = useAdminDeveloperReviewDecision();
  const distributionMutation = useAdminDeveloperDistribution();
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<DeveloperModuleReviewEvidence[]>([]);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reloadPending, setReloadPending] = useState(false);

  useEffect(() => {
    const release = detailQuery.data?.release;
    if (!release) return;
    setEvidence(createEvidenceDrafts(release.review_requirements));
    setReason('');
    setRevokeOpen(false);
  }, [detailQuery.data?.release.release_id, detailQuery.data?.release.review_revision]);

  const release = detailQuery.data?.release ?? null;
  const mutationErrorCode = mutation.error ? adminDeveloperReviewErrorCode(mutation.error) : null;
  const distributionErrorCode = distributionMutation.error
    ? adminDeveloperReviewErrorCode(distributionMutation.error)
    : null;
  const conflict =
    mutationErrorCode === 'DEVELOPER_REVIEW_CONFLICT' ||
    distributionErrorCode === 'DEVELOPER_DISTRIBUTION_CONFLICT';
  const state: AdminReviewDetailState = detailQuery.isLoading
    ? 'loading'
    : detailQuery.isError || !release
      ? 'error'
      : 'ready';

  return (
    <AdminDeveloperReviewDetailView
      state={state}
      release={release}
      history={detailQuery.data?.history ?? []}
      evidence={evidence}
      reason={reason}
      pending={mutation.isPending}
      reloadPending={reloadPending}
      conflict={conflict}
      revokeOpen={revokeOpen}
      errorCode={
        distributionErrorCode ??
        mutationErrorCode ??
        (detailQuery.error ? adminDeveloperReviewErrorCode(detailQuery.error) : null)
      }
      onReasonChange={setReason}
      onEvidenceChange={(index, patch) =>
        setEvidence((current) =>
          current.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, ...patch } : entry,
          ),
        )
      }
      onDecision={(decision, input) => {
        if (!release) return;
        mutation.mutate({
          release,
          decision,
          reason: input.reason,
          evidence: input.evidence,
        });
        if (decision === 'revoke') setRevokeOpen(false);
      }}
      distributionPending={distributionMutation.isPending}
      onDistributionAction={(action) => {
        const currentRelease = detailQuery.data?.release;
        if (!currentRelease) return;
        distributionMutation.mutate({ release: currentRelease, action });
      }}
      onReload={async () => {
        setReloadPending(true);
        try {
          await detailQuery.refetch();
          mutation.reset();
        } finally {
          setReloadPending(false);
        }
      }}
      onRevokeOpenChange={setRevokeOpen}
    />
  );
}
