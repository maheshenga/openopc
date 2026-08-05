'use client';

import type { DeveloperApplicationState } from '@kortix/sdk';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

import {
  adminDeveloperApplicationErrorCode,
  type AdminDeveloperApplicationDetail,
} from './client';
import {
  refreshAdminDeveloperApplicationAfterConflict,
  useAdminDeveloperApplicationDecision,
  useAdminDeveloperApplicationDetail,
  useAdminDeveloperApplicationSuspension,
} from './query';
import { useQueryClient } from '@tanstack/react-query';

export type AdminDeveloperApplicationDetailState = 'loading' | 'error' | 'ready';

const STATE_LABELS: Record<DeveloperApplicationState, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

const ACTION_LABELS = {
  'developer_application.submitted': 'Application submitted',
  'developer_application.approved': 'Application approved',
  'developer_application.rejected': 'Application rejected',
  'developer_application.suspended': 'Application suspended',
} as const;

function dateTimeLabel(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().replace('.000Z', 'Z');
}

function applicationStateVariant(state: DeveloperApplicationState) {
  if (state === 'approved') return 'success' as const;
  if (state === 'rejected') return 'destructive' as const;
  if (state === 'suspended') return 'muted' as const;
  if (state === 'under_review') return 'warning' as const;
  return 'secondary' as const;
}

function verificationStateVariant(state: string) {
  if (state === 'verified') return 'success' as const;
  if (state === 'rejected') return 'destructive' as const;
  return 'warning' as const;
}

function detailErrorMessage(errorCode: string | null): string {
  if (errorCode === 'DEVELOPER_APPLICATION_NOT_FOUND') return 'This developer application is not available.';
  if (errorCode === 'DEVELOPER_APPLICATION_FORBIDDEN') {
    return 'You do not have permission to review this developer application.';
  }
  if (errorCode === 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED') {
    return 'A fresh administrator sign-in is required before making a decision.';
  }
  return 'The developer application could not be loaded. Try again.';
}

function boundedReason(metadata: Record<string, unknown>): string {
  const reason = metadata.reason;
  if (typeof reason !== 'string' || !reason.trim()) return '—';
  return reason.trim().slice(0, 4_000);
}

export interface AdminDeveloperApplicationDetailViewProps {
  state: AdminDeveloperApplicationDetailState;
  detail: AdminDeveloperApplicationDetail | null;
  reason: string;
  pending: boolean;
  conflict: boolean;
  errorCode: string | null;
  onReasonChange: (value: string) => void;
  onDecision: (decision: 'approve' | 'reject') => void;
  onSuspend: () => void;
  onReload: () => void | Promise<void>;
}

export function AdminDeveloperApplicationDetailView({
  state,
  detail,
  reason,
  pending,
  conflict,
  errorCode,
  onReasonChange,
  onDecision,
  onSuspend,
  onReload,
}: AdminDeveloperApplicationDetailViewProps) {
  const [suspendOpen, setSuspendOpen] = useState(false);

  if (state !== 'ready' || !detail) {
    return (
      <main className="text-muted-foreground mx-auto flex min-h-80 w-full max-w-6xl items-center justify-center gap-2 px-4 py-8 text-sm">
        {state === 'loading' ? <Loading /> : null}
        {state === 'loading' ? 'Loading developer application...' : detailErrorMessage(errorCode)}
      </main>
    );
  }

  const { application, organization, policy_acceptances: policyAcceptances, history } = detail;
  const normalizedReason = reason.trim();
  const reasonValid = normalizedReason.length >= 1 && normalizedReason.length <= 4_000;
  const controlsDisabled = pending || conflict || !reasonValid;
  const canDecide = application.state === 'submitted' || application.state === 'under_review';
  const canSuspend = application.state === 'approved';
  const orderedHistory = [...history].sort(
    (left, right) => new Date(left.created_at).valueOf() - new Date(right.created_at).valueOf(),
  );

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="space-y-4">
        <Button asChild type="button" size="xs" variant="ghost" className="min-h-10">
          <Link href="/developer-applications">
            <ArrowLeft className="size-4 shrink-0" />
            Developer applications
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-balance">{organization.name}</h1>
              <Badge size="sm" variant={applicationStateVariant(application.state)}>
                {STATE_LABELS[application.state]}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 break-all text-sm">Account {application.account_id}</p>
            <p className="text-muted-foreground mt-1 break-all text-xs">
              Application {application.application_id}
            </p>
          </div>
          <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
            Revision {application.revision}
          </p>
        </div>
      </header>

      {conflict ? (
        <InfoBanner
          tone="warning"
          title="Another administrator changed this application."
          action={
            <Button type="button" size="sm" variant="outline" className="min-h-10" onClick={onReload}>
              Reload latest application
            </Button>
          }
        >
          Reload the current state and revision before recording a new decision.
        </InfoBanner>
      ) : null}
      {errorCode && !conflict ? (
        <InfoBanner tone="destructive">
          {detailErrorMessage(errorCode)}
        </InfoBanner>
      ) : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-3" aria-label="Application details">
            <h2 className="text-base font-semibold">Application details</h2>
            <div className="bg-popover rounded-md border px-4 py-5">
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-xs">Organization verification</dt>
                  <dd className="mt-1">
                    <Badge size="sm" variant={verificationStateVariant(organization.verification_state)}>
                      {organization.verification_state}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Verification revision</dt>
                  <dd className="mt-1 tabular-nums">{organization.verification_revision}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Submitted</dt>
                  <dd className="mt-1 break-all tabular-nums">{dateTimeLabel(application.submitted_at)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Last updated</dt>
                  <dd className="mt-1 break-all tabular-nums">{dateTimeLabel(application.updated_at)}</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="space-y-3" aria-label="Policy acceptances">
            <h2 className="text-base font-semibold">Policy acceptances</h2>
            {policyAcceptances.length === 0 ? (
              <p className="text-muted-foreground rounded-md border px-4 py-5 text-sm">
                No policy acceptances were recorded.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Policy</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Accepted</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {policyAcceptances.map((acceptance) => (
                      <TableRow key={`${acceptance.policy}-${acceptance.user_id}-${acceptance.accepted_at}`}>
                        <TableCell>{acceptance.policy === 'acceptable_use' ? 'Acceptable use' : 'Module rules'}</TableCell>
                        <TableCell>{acceptance.version}</TableCell>
                        <TableCell className="break-all">{acceptance.user_id}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {dateTimeLabel(acceptance.accepted_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section className="space-y-3" aria-label="Application audit history">
            <h2 className="text-base font-semibold">Audit history</h2>
            {orderedHistory.length === 0 ? (
              <p className="text-muted-foreground rounded-md border px-4 py-5 text-sm">
                No application events have been recorded.
              </p>
            ) : (
              <ol className="space-y-2">
                {orderedHistory.map((event) => (
                  <li key={`${event.action}-${event.created_at}-${event.actor_user_id}`} className="bg-popover rounded-md border px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{ACTION_LABELS[event.action]}</p>
                        <p className="text-muted-foreground mt-1 break-all text-xs">Actor {event.actor_user_id}</p>
                      </div>
                      <time className="text-muted-foreground text-xs tabular-nums">{dateTimeLabel(event.created_at)}</time>
                    </div>
                    <p className="text-muted-foreground mt-2 whitespace-pre-wrap break-words text-sm">
                      {boundedReason(event.metadata)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="min-w-0 space-y-3" aria-label="Application decisions">
          <h2 className="text-base font-semibold">Application decision</h2>
          <div className="bg-popover space-y-4 rounded-md border px-4 py-5">
            <Textarea
              value={reason}
              maxLength={4_000}
              minHeight={112}
              placeholder="Required decision reason"
              aria-label="Decision reason"
              disabled={pending || conflict}
              onChange={(event) => onReasonChange(event.target.value)}
            />
            <p className="text-muted-foreground text-xs tabular-nums">{reason.length}/4000</p>
            <div className="flex flex-wrap gap-2">
              {canDecide ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={controlsDisabled}
                    onClick={() => onDecision('reject')}
                  >
                    {pending ? <Loading className="size-4 shrink-0" /> : null}
                    Reject application
                  </Button>
                  <Button type="button" disabled={controlsDisabled} onClick={() => onDecision('approve')}>
                    {pending ? <Loading className="size-4 shrink-0" /> : null}
                    Approve application
                  </Button>
                </>
              ) : null}
              {canSuspend ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={controlsDisabled}
                  onClick={() => setSuspendOpen(true)}
                >
                  {pending ? <Loading className="size-4 shrink-0" /> : null}
                  Suspend application
                </Button>
              ) : null}
            </div>
          </div>
          <ConfirmDialog
            open={suspendOpen}
            onOpenChange={setSuspendOpen}
            title="Suspend developer application?"
            description="This changes the application state and records the reason in the audit history."
            confirmLabel="Suspend application"
            onConfirm={() => {
              setSuspendOpen(false);
              onSuspend();
            }}
            isPending={pending}
            confirmVariant="destructive"
          />
        </aside>
      </div>
    </main>
  );
}

export function AdminDeveloperApplicationDetailPage({ applicationId }: { applicationId: string }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const detailQuery = useAdminDeveloperApplicationDetail(applicationId);
  const decision = useAdminDeveloperApplicationDecision();
  const suspension = useAdminDeveloperApplicationSuspension();
  const detail = detailQuery.data ?? null;
  const decisionErrorCode = decision.error ? adminDeveloperApplicationErrorCode(decision.error) : null;
  const suspensionErrorCode = suspension.error ? adminDeveloperApplicationErrorCode(suspension.error) : null;
  const conflict =
    decisionErrorCode === 'DEVELOPER_APPLICATION_CONFLICT' ||
    suspensionErrorCode === 'DEVELOPER_APPLICATION_CONFLICT';

  let state: AdminDeveloperApplicationDetailState;
  if (detailQuery.isLoading) state = 'loading';
  else if (detailQuery.isError || !detail) state = 'error';
  else state = 'ready';

  return (
    <AdminDeveloperApplicationDetailView
      state={state}
      detail={detail}
      reason={reason}
      pending={decision.isPending || suspension.isPending}
      conflict={conflict}
      errorCode={
        decisionErrorCode ??
        suspensionErrorCode ??
        (detailQuery.error ? adminDeveloperApplicationErrorCode(detailQuery.error) : null)
      }
      onReasonChange={setReason}
      onDecision={(nextDecision) => {
        if (!detail) return;
        decision.mutate({
          application: detail.application,
          decision: nextDecision,
          reason: reason.trim(),
        });
      }}
      onSuspend={() => {
        if (!detail) return;
        suspension.mutate({ application: detail.application, reason: reason.trim() });
      }}
      onReload={async () => {
        await refreshAdminDeveloperApplicationAfterConflict(queryClient, applicationId);
        decision.reset();
        suspension.reset();
      }}
    />
  );
}
