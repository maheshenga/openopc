'use client';

import type {
  DeveloperModuleHumanReviewEvidence,
  DeveloperModuleRelease,
  DeveloperModuleTrustView,
} from '@kortix/sdk';
import { ArrowLeft, ClipboardCheck, ShieldAlert, XCircle } from 'lucide-react';
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

import {
  developerModuleTrustGateStatus,
  humanReviewRequirements,
} from '@/features/developer-center/model';
import { DeveloperModuleManifestView } from '@/features/developer-center/shared/module-manifest-view';
import { DeveloperModuleRequirements } from '@/features/developer-center/shared/module-requirements';
import { DeveloperModuleStatusBadge } from '@/features/developer-center/shared/module-status-badge';
import { DeveloperModuleReviewTimeline } from '@/features/developer-center/shared/review-timeline';
import { DeveloperModuleTrustSummary } from '@/features/developer-center/shared/trust-summary';
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
  useAdminDeveloperTrust,
  useAdminDeveloperVerification,
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
  if (errorCode === 'DEVELOPER_TRUST_GATE_UNMET') {
    return 'Server trust requirements changed. Inspect the latest automatic evidence.';
  }
  return 'The review detail could not be loaded. Try again.';
}

export interface AdminDeveloperReviewDetailViewProps {
  state: AdminReviewDetailState;
  release: DeveloperModuleRelease | null;
  history: readonly AdminDeveloperLifecycleEvent[];
  trust?: DeveloperModuleTrustView | null;
  evidence: readonly DeveloperModuleHumanReviewEvidence[];
  reason: string;
  pending: boolean;
  reloadPending?: boolean;
  conflict: boolean;
  distributionPending?: boolean;
  verificationPending?: boolean;
  revokeOpen: boolean;
  errorCode: string | null;
  onReasonChange: (value: string) => void;
  onEvidenceChange: (index: number, patch: Partial<DeveloperModuleHumanReviewEvidence>) => void;
  onDecision: (
    decision: AdminDeveloperReviewDecision,
    input: { reason?: string; evidence?: readonly DeveloperModuleHumanReviewEvidence[] },
  ) => void;
  onDistributionAction?: (action: 'sign' | 'publish') => void;
  onRetryVerification?: () => void;
  onCancelVerification?: () => void;
  onReload: () => void | Promise<void>;
  onRevokeOpenChange: (open: boolean) => void;
}

export function AdminDeveloperReviewDetailView({
  state,
  release,
  history,
  trust,
  evidence,
  reason,
  pending,
  reloadPending = false,
  conflict,
  distributionPending = false,
  verificationPending = false,
  revokeOpen,
  errorCode,
  onReasonChange,
  onEvidenceChange,
  onDecision,
  onDistributionAction = () => undefined,
  onRetryVerification = () => undefined,
  onCancelVerification = () => undefined,
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
  const trustStatus =
    trust === undefined
      ? { ready: true as const, code: null, message: 'Automatic trust checks passed.' }
      : developerModuleTrustGateStatus(release, trust);
  const manualRequirements = humanReviewRequirements(release.review_requirements);
  const latestVerification = trust?.attempts.at(-1);
  const verificationActive =
    latestVerification?.state === 'queued' || latestVerification?.state === 'running';
  const reasonComplete = isReviewReasonValid(reason);
  const optionalReasonValid = !reason.trim() || reasonComplete;
  const controlsPending = pending || reloadPending || verificationPending;
  const reviewPending = release.status === 'review_pending';
  const approved = release.status === 'approved';
  const distributionAction =
    release.status === 'approved' ? 'sign' : release.status === 'signed' ? 'publish' : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="space-y-4">
        <Button asChild type="button" size="xs" variant="ghost">
          <Link href="/developer-reviews">
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
                  !trustStatus.ready ||
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
                  disabled={
                    controlsPending ||
                    conflict ||
                    distributionPending ||
                    (distributionAction === 'sign' && !trustStatus.ready)
                  }
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
            {(!evidenceComplete || !trustStatus.ready) && reviewPending ? (
              <p className="text-muted-foreground text-xs">
                Complete every human review and automatic trust requirement before approval.
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {trust !== undefined ? (
        <div className="space-y-3">
          <DeveloperModuleTrustSummary
            trust={trust}
            gateStatus={trustStatus}
            requirements={release.review_requirements}
            canRetry
            retryPending={verificationPending}
            showProvenance
            onRetry={onRetryVerification}
          />
          {verificationActive ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={verificationPending}
              onClick={onCancelVerification}
            >
              {verificationPending ? <Loading /> : <XCircle />}
              {verificationPending ? 'Cancelling...' : 'Cancel verification'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {reviewPending && manualRequirements.length > 0 ? (
        <section className="space-y-4 border-t pt-6" aria-label="Manual review evidence">
          <div>
            <h2 className="text-base font-semibold">Manual review evidence</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Record a redacted conclusion for each declared requirement. Raw logs and credentials
              do not belong here.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {manualRequirements.map((requirement, index) => {
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
                  className="border-border/60 bg-card space-y-3 rounded-lg border p-4"
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
  const trustQuery = useAdminDeveloperTrust(releaseId);
  const mutation = useAdminDeveloperReviewDecision();
  const distributionMutation = useAdminDeveloperDistribution();
  const verificationMutation = useAdminDeveloperVerification();
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<DeveloperModuleHumanReviewEvidence[]>([]);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reloadPending, setReloadPending] = useState(false);
  const loadedRelease = detailQuery.data?.release;

  useEffect(() => {
    if (!loadedRelease) return;
    setEvidence(createEvidenceDrafts(loadedRelease.review_requirements));
    setReason('');
    setRevokeOpen(false);
  }, [loadedRelease]);

  const release = loadedRelease ?? null;
  const mutationErrorCode = mutation.error ? adminDeveloperReviewErrorCode(mutation.error) : null;
  const distributionErrorCode = distributionMutation.error
    ? adminDeveloperReviewErrorCode(distributionMutation.error)
    : null;
  const verificationErrorCode = verificationMutation.error
    ? adminDeveloperReviewErrorCode(verificationMutation.error)
    : null;
  const conflict =
    mutationErrorCode === 'DEVELOPER_REVIEW_CONFLICT' ||
    distributionErrorCode === 'DEVELOPER_DISTRIBUTION_CONFLICT';
  const state: AdminReviewDetailState =
    detailQuery.isLoading || trustQuery.isLoading
      ? 'loading'
      : detailQuery.isError || trustQuery.isError || !release
        ? 'error'
        : 'ready';

  return (
    <AdminDeveloperReviewDetailView
      state={state}
      release={release}
      history={detailQuery.data?.history ?? []}
      trust={trustQuery.data ?? null}
      evidence={evidence}
      reason={reason}
      pending={mutation.isPending}
      reloadPending={reloadPending}
      conflict={conflict}
      verificationPending={verificationMutation.isPending}
      revokeOpen={revokeOpen}
      errorCode={
        verificationErrorCode ??
        distributionErrorCode ??
        mutationErrorCode ??
        (detailQuery.error
          ? adminDeveloperReviewErrorCode(detailQuery.error)
          : trustQuery.error
            ? adminDeveloperReviewErrorCode(trustQuery.error)
            : null)
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
      onRetryVerification={() => verificationMutation.mutate({ releaseId, action: 'retry' })}
      onCancelVerification={() => verificationMutation.mutate({ releaseId, action: 'cancel' })}
      onReload={async () => {
        setReloadPending(true);
        try {
          await Promise.all([detailQuery.refetch(), trustQuery.refetch()]);
          mutation.reset();
          distributionMutation.reset();
          verificationMutation.reset();
        } finally {
          setReloadPending(false);
        }
      }}
      onRevokeOpenChange={setRevokeOpen}
    />
  );
}
