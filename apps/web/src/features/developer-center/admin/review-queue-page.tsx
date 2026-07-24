'use client';

import type { DeveloperModuleRelease, DeveloperModuleReleaseStatus } from '@kortix/sdk';
import { PackageCheck, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { SectionContainer, SectionHeader } from '@/app/admin/_components/section-header';
import { requirementComplexity } from '../model';
import { DeveloperModuleStatusBadge } from '../shared/module-status-badge';
import { adminDeveloperReviewErrorCode } from './client';
import { useAdminDeveloperReviewQueue } from './query';

export type AdminReviewQueueState = 'loading' | 'error' | 'empty' | 'ready';

const QUEUE_STATUSES: readonly DeveloperModuleReleaseStatus[] = [
  'review_pending',
  'changes_requested',
  'approved',
  'revoked',
];

const STATUS_LABELS: Record<DeveloperModuleReleaseStatus, string> = {
  validated: 'Validated',
  review_pending: 'Review pending',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  signed: 'Signed',
  published: 'Published',
  revoked: 'Revoked',
  deprecated: 'Deprecated',
};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}

function matchesSearch(release: DeveloperModuleRelease, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [release.item_name, release.module_id, release.publisher_id, release.module_version].some(
    (value) => value.toLowerCase().includes(needle),
  );
}

function queueErrorMessage(errorCode: string | null): string {
  if (errorCode === 'DEVELOPER_REVIEW_INPUT_INVALID') {
    return 'The review queue cursor is invalid. Reset to the first page and try again.';
  }
  if (errorCode === 'DEVELOPER_REQUEST_FAILED') {
    return 'The review queue could not be loaded. Try again.';
  }
  return 'The review queue is temporarily unavailable. Reset the cursor or try again.';
}

export interface AdminDeveloperReviewQueueViewProps {
  state: AdminReviewQueueState;
  status: DeveloperModuleReleaseStatus;
  releases: readonly DeveloperModuleRelease[];
  search: string;
  nextCursor: string | null;
  errorCode: string | null;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: DeveloperModuleReleaseStatus) => void;
  onNextPage: () => void;
  onResetCursor: () => void;
  onOpenRelease: (releaseId: string) => void;
}

export function AdminDeveloperReviewQueueView({
  state,
  status,
  releases,
  search,
  nextCursor,
  errorCode,
  onSearchChange,
  onStatusChange,
  onNextPage,
  onResetCursor,
  onOpenRelease,
}: AdminDeveloperReviewQueueViewProps) {
  const visibleReleases = useMemo(
    () => releases.filter((release) => matchesSearch(release, search)),
    [releases, search],
  );
  const complexityCounts = useMemo(
    () => ({
      standard: releases.filter(
        (release) => requirementComplexity(release.review_requirements) === 'standard',
      ).length,
      elevated: releases.filter(
        (release) => requirementComplexity(release.review_requirements) === 'elevated',
      ).length,
    }),
    [releases],
  );

  return (
    <SectionContainer>
      <SectionHeader
        icon={PackageCheck}
        title="Review queue"
        description="Module reviews for submitted releases with bounded evidence and immutable history."
      />

      <div className="flex flex-wrap gap-2" aria-label="Review status">
        {QUEUE_STATUSES.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="xs"
            variant={status === candidate ? 'secondary' : 'ghost'}
            onClick={() => onStatusChange(candidate)}
          >
            {STATUS_LABELS[candidate]}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="border-border/60 bg-card rounded-xl border p-4">
          <p className="text-muted-foreground text-xs uppercase">Standard review</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{complexityCounts.standard}</p>
        </div>
        <div className="border-border/60 bg-card rounded-xl border p-4">
          <p className="text-muted-foreground text-xs uppercase">Elevated review</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{complexityCounts.elevated}</p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search loaded releases"
          className="pl-9"
        />
      </div>

      {state === 'loading' ? (
        <div className="text-muted-foreground flex min-h-48 items-center justify-center gap-2 text-sm">
          <Loading />
          Loading review queue...
        </div>
      ) : null}
      {state === 'error' ? (
        <div className="border-destructive/30 bg-destructive/5 rounded-lg border p-6 text-sm">
          <p className="font-medium">{queueErrorMessage(errorCode)}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={onResetCursor}
          >
            Reset to first page
          </Button>
        </div>
      ) : null}
      {state === 'empty' ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          No releases are waiting in this queue.
        </p>
      ) : null}
      {state === 'ready' && visibleReleases.length === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          No releases match your search.
        </p>
      ) : null}
      {state === 'ready' && visibleReleases.length > 0 ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Review</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleReleases.map((release) => (
                <TableRow key={release.release_id}>
                  <TableCell>
                    <p className="font-medium">{release.item_name}</p>
                    <p className="text-muted-foreground text-xs">{release.module_id}</p>
                  </TableCell>
                  <TableCell>{release.module_version}</TableCell>
                  <TableCell>
                    <DeveloperModuleStatusBadge status={release.status} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {requirementComplexity(release.review_requirements) === 'elevated'
                        ? 'Elevated'
                        : 'Standard'}
                    </Badge>
                  </TableCell>
                  <TableCell>{dateLabel(release.updated_at)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => onOpenRelease(release.release_id)}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {nextCursor ? (
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="outline" onClick={onNextPage}>
                Next page
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </SectionContainer>
  );
}

export function AdminDeveloperReviewQueuePage() {
  const router = useRouter();
  const [status, setStatus] = useState<DeveloperModuleReleaseStatus>('review_pending');
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const queueQuery = useAdminDeveloperReviewQueue(status, cursor);
  const releases = queueQuery.data?.releases ?? [];

  let state: AdminReviewQueueState;
  if (queueQuery.isLoading) state = 'loading';
  else if (queueQuery.isError) state = 'error';
  else if (releases.length === 0) state = 'empty';
  else state = 'ready';

  return (
    <AdminDeveloperReviewQueueView
      state={state}
      status={status}
      releases={releases}
      search={search}
      nextCursor={queueQuery.data?.next_cursor ?? null}
      errorCode={queueQuery.error ? adminDeveloperReviewErrorCode(queueQuery.error) : null}
      onSearchChange={setSearch}
      onStatusChange={(nextStatus) => {
        setStatus(nextStatus);
        setCursor(null);
        setSearch('');
      }}
      onNextPage={() => {
        if (queueQuery.data?.next_cursor) setCursor(queueQuery.data.next_cursor);
      }}
      onResetCursor={() => setCursor(null)}
      onOpenRelease={(releaseId) =>
        router.push(`/admin/developer-reviews/${encodeURIComponent(releaseId)}`)
      }
    />
  );
}
