'use client';

import type { DeveloperApplicationState } from '@kortix/sdk';
import { ClipboardList, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { SectionContainer, SectionHeader } from '@/app/_components/section-header';
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

import { adminDeveloperApplicationErrorCode, type AdminDeveloperApplicationListItem } from './client';
import { useAdminDeveloperApplicationQueue } from './query';

export type AdminApplicationQueueState = 'loading' | 'error' | 'empty' | 'ready';

const APPLICATION_STATES: readonly DeveloperApplicationState[] = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'suspended',
];

const STATE_LABELS: Record<DeveloperApplicationState, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

function dateLabel(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}

function matchesSearch(application: AdminDeveloperApplicationListItem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    application.organization.name,
    application.application.account_id,
    application.application.application_id,
  ].some((value) => value.toLowerCase().includes(needle));
}

function queueErrorMessage(errorCode: string | null): string {
  if (errorCode === 'DEVELOPER_APPLICATION_INPUT_INVALID') {
    return 'The application queue cursor is invalid. Reset to the first page and try again.';
  }
  if (errorCode === 'DEVELOPER_APPLICATION_REQUEST_FAILED') {
    return 'The application queue could not be loaded. Try again.';
  }
  return 'The application queue is temporarily unavailable. Reset the cursor or try again.';
}

function applicationStateVariant(state: DeveloperApplicationState) {
  if (state === 'approved') return 'success' as const;
  if (state === 'rejected') return 'destructive' as const;
  if (state === 'suspended') return 'muted' as const;
  if (state === 'under_review') return 'warning' as const;
  return 'secondary' as const;
}

export interface AdminDeveloperApplicationQueueViewProps {
  state: AdminApplicationQueueState;
  applicationState: DeveloperApplicationState;
  applications: readonly AdminDeveloperApplicationListItem[];
  search: string;
  nextCursor: string | null;
  errorCode: string | null;
  onSearchChange: (value: string) => void;
  onStateChange: (value: DeveloperApplicationState) => void;
  onNextPage: () => void;
  onResetCursor: () => void;
  onOpenApplication: (applicationId: string) => void;
}

export function AdminDeveloperApplicationQueueView({
  state,
  applicationState,
  applications,
  search,
  nextCursor,
  errorCode,
  onSearchChange,
  onStateChange,
  onNextPage,
  onResetCursor,
  onOpenApplication,
}: AdminDeveloperApplicationQueueViewProps) {
  const visibleApplications = useMemo(
    () => applications.filter((application) => matchesSearch(application, search)),
    [applications, search],
  );

  return (
    <SectionContainer>
      <SectionHeader
        icon={ClipboardList}
        title="Developer applications"
        description="Review publisher onboarding applications and their submitted policy acknowledgements."
      />

      <div className="flex flex-wrap gap-2" aria-label="Application state">
        {APPLICATION_STATES.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="xs"
            variant={applicationState === candidate ? 'secondary' : 'ghost'}
            className="min-h-10 min-w-24 justify-center"
            onClick={() => onStateChange(candidate)}
          >
            {STATE_LABELS[candidate]}
          </Button>
        ))}
      </div>

      <div className="relative max-w-md">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search loaded applications"
          className="pl-9"
        />
      </div>

      {state === 'loading' ? (
        <div className="text-muted-foreground flex min-h-48 items-center justify-center gap-2 text-sm">
          <Loading />
          Loading developer applications...
        </div>
      ) : null}
      {state === 'error' ? (
        <div className="border-destructive/30 bg-destructive/5 rounded-md border p-6 text-sm">
          <p className="font-medium">{queueErrorMessage(errorCode)}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4 min-h-10 min-w-36"
            onClick={onResetCursor}
          >
            Reset to first page
          </Button>
        </div>
      ) : null}
      {state === 'empty' ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          No developer applications are in this queue.
        </p>
      ) : null}
      {state === 'ready' && visibleApplications.length === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          No applications match your search.
        </p>
      ) : null}
      {state === 'ready' && visibleApplications.length > 0 ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Revision</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleApplications.map(({ application, organization }) => (
                <TableRow key={application.application_id}>
                  <TableCell>
                    <p className="font-medium">{organization.name}</p>
                    <p className="text-muted-foreground text-xs">{application.account_id}</p>
                  </TableCell>
                  <TableCell>
                    <Badge size="sm" variant={applicationStateVariant(application.state)}>
                      {STATE_LABELS[application.state]}
                    </Badge>
                  </TableCell>
                  <TableCell>Revision {application.revision}</TableCell>
                  <TableCell>{dateLabel(application.submitted_at)}</TableCell>
                  <TableCell>{dateLabel(application.updated_at)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="min-h-10"
                      onClick={() => onOpenApplication(application.application_id)}
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
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-10 min-w-24"
                onClick={onNextPage}
              >
                Next page
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </SectionContainer>
  );
}

export function AdminDeveloperApplicationQueuePage() {
  const router = useRouter();
  const [applicationState, setApplicationState] = useState<DeveloperApplicationState>('submitted');
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const queueQuery = useAdminDeveloperApplicationQueue(applicationState, cursor);
  const applications = queueQuery.data?.applications ?? [];

  let state: AdminApplicationQueueState;
  if (queueQuery.isLoading) state = 'loading';
  else if (queueQuery.isError) state = 'error';
  else if (applications.length === 0) state = 'empty';
  else state = 'ready';

  return (
    <AdminDeveloperApplicationQueueView
      state={state}
      applicationState={applicationState}
      applications={applications}
      search={search}
      nextCursor={queueQuery.data?.next_cursor ?? null}
      errorCode={queueQuery.error ? adminDeveloperApplicationErrorCode(queueQuery.error) : null}
      onSearchChange={setSearch}
      onStateChange={(nextState) => {
        setApplicationState(nextState);
        setCursor(null);
      }}
      onNextPage={() => {
        if (queueQuery.data?.next_cursor) setCursor(queueQuery.data.next_cursor);
      }}
      onResetCursor={() => setCursor(null)}
      onOpenApplication={(applicationId) =>
        router.push(`/developer-applications/${encodeURIComponent(applicationId)}`)
      }
    />
  );
}
