'use client';

import type { DeveloperModuleRelease, DeveloperModuleReleaseStatus } from '@kortix/sdk';
import { ArrowRight, PackagePlus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

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
import { usePermission } from '@/lib/use-permission';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import {
  developerCenterErrorCode,
  filterRecentReleases,
  type ReleaseStatusFilter,
} from '../model';
import { DeveloperModuleStatusBadge } from '../shared/module-status-badge';
import { usePublisherModuleReleases } from './query';

export type PublisherReleaseListState =
  | 'loading'
  | 'no_account'
  | 'permission_denied'
  | 'error'
  | 'empty'
  | 'ready';

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

const STATUS_FILTERS: readonly ReleaseStatusFilter[] = [
  'all',
  'validated',
  'review_pending',
  'changes_requested',
  'approved',
  'signed',
  'published',
  'revoked',
  'deprecated',
];

export interface PublisherReleaseListViewProps {
  state: PublisherReleaseListState;
  releases: readonly DeveloperModuleRelease[];
  search: string;
  status: ReleaseStatusFilter;
  canWrite: boolean;
  errorCode: string | null;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: ReleaseStatusFilter) => void;
  onOpenRelease: (releaseId: string) => void;
  onSubmit: () => void;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}

export function PublisherReleaseListView({
  state,
  releases,
  search,
  status,
  canWrite,
  errorCode,
  onSearchChange,
  onStatusChange,
  onOpenRelease,
  onSubmit,
}: PublisherReleaseListViewProps) {
  const showFilters = state === 'ready' || state === 'empty';

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Developer Center</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Validate, submit, and track governed module releases.
          </p>
        </div>
        {canWrite ? (
          <Button type="button" onClick={onSubmit}>
            <PackagePlus />
            Submit new version
          </Button>
        ) : null}
      </header>

      <section className="space-y-4" aria-label="Recent releases">
        <div>
          <h2 className="text-base font-semibold">Recent releases</h2>
          <p className="text-sm text-muted-foreground">
            Search and filters apply to the latest 100 loaded releases.
          </p>
        </div>

        {showFilters ? (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search loaded releases"
                className="pl-9"
              />
            </div>
            <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="Release status">
              {STATUS_FILTERS.map((filter) => (
                <Button
                  key={filter}
                  type="button"
                  size="xs"
                  variant={status === filter ? 'secondary' : 'ghost'}
                  onClick={() => onStatusChange(filter)}
                >
                  {filter === 'all' ? 'All' : STATUS_LABELS[filter]}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {state === 'loading' ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loading />
            Loading releases...
          </div>
        ) : null}
        {state === 'no_account' ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Select an account to view releases.
          </p>
        ) : null}
        {state === 'permission_denied' ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            You do not have permission to view releases for this account.
          </p>
        ) : null}
        {state === 'error' ? (
          <div className="py-12 text-center text-sm">
            <p className="font-medium">{errorCode ?? 'DEVELOPER_REQUEST_FAILED'}</p>
            <p className="mt-1 text-muted-foreground">Try again after checking your connection.</p>
          </div>
        ) : null}
        {state === 'empty' ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No releases found.</p>
        ) : null}
        {state === 'ready' ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Revision</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.map((release) => (
                <TableRow key={release.release_id}>
                  <TableCell>
                    <p className="font-medium">{release.item_name}</p>
                    <p className="text-xs text-muted-foreground">{release.module_id}</p>
                  </TableCell>
                  <TableCell>{release.module_version}</TableCell>
                  <TableCell>
                    <DeveloperModuleStatusBadge status={release.status} />
                  </TableCell>
                  <TableCell>{release.review_revision}</TableCell>
                  <TableCell>{dateLabel(release.updated_at)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => onOpenRelease(release.release_id)}
                    >
                      Open
                      <ArrowRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>
    </main>
  );
}

export function PublisherReleaseListPage() {
  const router = useRouter();
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const accountId = selectedAccountId ?? undefined;
  const readPermission = usePermission(accountId, 'account.read');
  const writePermission = usePermission(accountId, 'account.write');
  const releasesQuery = usePublisherModuleReleases(selectedAccountId, readPermission.allowed);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ReleaseStatusFilter>('all');

  const releases = useMemo(
    () => filterRecentReleases(releasesQuery.data?.releases ?? [], search, status),
    [releasesQuery.data?.releases, search, status],
  );

  let state: PublisherReleaseListState;
  if (!selectedAccountId) state = 'no_account';
  else if (readPermission.isLoading) state = 'loading';
  else if (readPermission.isError || !readPermission.allowed) state = 'permission_denied';
  else if (releasesQuery.isLoading) state = 'loading';
  else if (releasesQuery.isError) state = 'error';
  else if (releases.length === 0) state = 'empty';
  else state = 'ready';

  return (
    <PublisherReleaseListView
      state={state}
      releases={releases}
      search={search}
      status={status}
      canWrite={writePermission.allowed}
      errorCode={releasesQuery.error ? developerCenterErrorCode(releasesQuery.error) : null}
      onSearchChange={setSearch}
      onStatusChange={setStatus}
      onOpenRelease={(releaseId) =>
        router.push(`/developer/modules/${encodeURIComponent(releaseId)}`)
      }
      onSubmit={() => router.push('/developer/modules/submit')}
    />
  );
}
