'use client';

import {
  type DeveloperModuleHumanReviewEvidence,
  type DeveloperModuleRelease,
  type DeveloperModuleReleaseStatus,
  type DeveloperModuleReviewEvent,
  type ProjectModuleInstallation,
  type ProjectModuleInstallationEvent,
  type ProjectModuleInstallationTransition,
  createDeclarativeDeveloperModuleArtifact,
  getDeveloperModuleRelease,
  getDeveloperModuleReviewHistory,
  listDeveloperModuleReleases,
  requestDeveloperModuleReview,
  submitDeveloperModuleRelease,
  validateDeveloperModule,
} from '@kortix/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { invalidateTokenCache, setBootstrapAuthToken } from '@/lib/auth-token';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import {
  type AdminDeveloperReviewDecision,
  type AdminDeveloperReviewDetail,
  adminDeveloperReviewErrorCode,
  decideAdminDeveloperReview,
  getAdminDeveloperReview,
  listAdminDeveloperReviews,
} from '@/features/developer-center/admin/client';
import {
  buildAdminDecisionBody,
  createEvidenceDrafts,
} from '@/features/developer-center/admin/evidence';
import {
  AdminDeveloperReviewDetailView,
  type AdminDeveloperReviewDetailViewProps,
} from '@/features/developer-center/admin/review-detail-page';
import {
  AdminDeveloperReviewQueueView,
  type AdminReviewQueueState,
} from '@/features/developer-center/admin/review-queue-page';
import {
  type ReleaseStatusFilter,
  developerCenterErrorCode,
  filterRecentReleases,
} from '@/features/developer-center/model';
import {
  PublisherReleaseDetailView,
  type PublisherReleaseDetailViewProps,
} from '@/features/developer-center/publisher/release-detail-page';
import {
  PublisherReleaseListView,
  type PublisherReleaseListViewProps,
} from '@/features/developer-center/publisher/release-list-page';
import { createDeveloperModuleSubmitController } from '@/features/developer-center/publisher/submit-controller';
import { DeveloperModuleSubmitView } from '@/features/developer-center/publisher/submit-page';
import {
  installPublishedProjectModule,
  listInstalledProjectModules,
  listProjectModuleHistory,
  listPublishedProjectModuleReleases,
  rollbackPublishedProjectModule,
  updatePublishedProjectModule,
} from '@/features/project-modules/client';
import {
  type ProjectModulesPageState,
  ProjectModulesView,
} from '@/features/project-modules/project-modules-page';
import { projectModuleErrorCode } from '@/features/project-modules/query';

const DEBUG_ACCOUNT_ID = '21000000-0000-4000-a000-000000000001';
const DEBUG_TEAM_ACCOUNT_ID = '21000000-0000-4000-a000-000000000002';
const DEBUG_PUBLISHER_RELEASE_ID = '22000000-0000-4000-a000-000000000003';
const DEBUG_ADMIN_RELEASE_ID = '22000000-0000-4000-a000-000000000001';
const DEBUG_PROJECT_ID = '24000000-0000-4000-a000-000000000001';

type DebugMode =
  | 'publisher-list'
  | 'publisher-submit'
  | 'publisher-detail'
  | 'admin-queue'
  | 'admin-detail'
  | 'project-modules';

function modeFromSearch(): DebugMode {
  if (typeof window === 'undefined') return 'publisher-list';
  const value = new URLSearchParams(window.location.search).get('mode');
  return value === 'publisher-submit' ||
    value === 'publisher-detail' ||
    value === 'admin-queue' ||
    value === 'admin-detail' ||
    value === 'project-modules'
    ? value
    : 'publisher-list';
}

function releaseIdFromSearch(): string {
  if (typeof window === 'undefined') return DEBUG_PUBLISHER_RELEASE_ID;
  const search = new URLSearchParams(window.location.search);
  return (
    search.get('releaseId') ??
    (search.get('mode') === 'admin-detail' ? DEBUG_ADMIN_RELEASE_ID : DEBUG_PUBLISHER_RELEASE_ID)
  );
}

function PublisherSubmitHarness({
  accountId,
  canWrite,
  onSubmitted,
}: {
  accountId: string;
  canWrite: boolean;
  onSubmitted: (releaseId: string) => void;
}) {
  const controllerRef = useRef(
    createDeveloperModuleSubmitController({
      validate: (item) => validateDeveloperModule(item),
      submit: async (item, selectedAccountId) => {
        const artifact = await createDeclarativeDeveloperModuleArtifact(item, {
          accountId: selectedAccountId,
        });
        return submitDeveloperModuleRelease({
          artifactId: artifact.artifact_id,
          accountId: selectedAccountId,
        });
      },
    }),
  );
  const controller = controllerRef.current;
  const [state, setState] = useState(controller.getState());
  const [pending, setPending] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateText = (text: string) => {
    setError(null);
    setState(controller.setText(text));
  };
  const validate = async () => {
    setError(null);
    setValidating(true);
    try {
      setState(await controller.validate());
    } finally {
      setValidating(false);
    }
  };
  const confirm = async () => {
    setPending(true);
    setError(null);
    setState(controller.getState());
    try {
      const result = await controller.confirm(accountId);
      setState(controller.getState());
      onSubmitted(result.release.release_id);
    } catch (reason) {
      setState(controller.getState());
      setError(developerCenterErrorCode(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <DeveloperModuleSubmitView
      stage={state.stage}
      text={state.text}
      item={state.parsedItem}
      issues={state.issues}
      inputErrorCode={state.inputErrorCode}
      canWrite={canWrite}
      pending={pending}
      validating={validating}
      errorCode={error}
      onTextChange={updateText}
      onValidate={validate}
      onConfirm={confirm}
    />
  );
}

function ProjectModulesDebugHarness({ canWrite }: { canWrite: boolean }) {
  const [modules, setModules] = useState<ProjectModuleInstallation[]>([]);
  const [releases, setReleases] = useState<
    Awaited<ReturnType<typeof listPublishedProjectModuleReleases>>
  >([]);
  const [historyByInstallation, setHistoryByInstallation] = useState<
    Readonly<Record<string, readonly ProjectModuleInstallationEvent[]>>
  >({});
  const [state, setState] = useState<ProjectModulesPageState>('loading');
  const [pendingModuleId, setPendingModuleId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setState('loading');
    setErrorCode(null);
    try {
      const [nextModules, nextReleases] = await Promise.all([
        listInstalledProjectModules(DEBUG_PROJECT_ID),
        listPublishedProjectModuleReleases(),
      ]);
      const histories = await Promise.all(
        nextModules.map(
          async (installation) =>
            [
              installation.installation_id,
              await listProjectModuleHistory(DEBUG_PROJECT_ID, installation.module_id),
            ] as const,
        ),
      );
      setModules(nextModules);
      setReleases(nextReleases);
      setHistoryByInstallation(Object.fromEntries(histories));
      setState(nextModules.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      setErrorCode(projectModuleErrorCode(error));
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recordTransition = (transition: ProjectModuleInstallationTransition) => {
    setModules((current) => {
      const next = current.filter(
        (installation) => installation.module_id !== transition.installation.module_id,
      );
      return [...next, transition.installation].sort((left, right) =>
        left.module_id.localeCompare(right.module_id),
      );
    });
    setHistoryByInstallation((current) => ({
      ...current,
      [transition.installation.installation_id]: [
        ...(current[transition.installation.installation_id] ?? []),
        transition.event,
      ],
    }));
    setState('ready');
  };

  const mutate = async (
    moduleId: string,
    operation: () => Promise<ProjectModuleInstallationTransition>,
  ) => {
    setPendingModuleId(moduleId);
    setErrorCode(null);
    try {
      recordTransition(await operation());
    } catch (error) {
      const code = projectModuleErrorCode(error);
      setErrorCode(code);
      if (code === 'PROJECT_MODULE_INSTALL_CONFLICT') await load(false);
      else setState('error');
    } finally {
      setPendingModuleId(null);
    }
  };

  return (
    <ProjectModulesView
      state={state}
      modules={modules}
      releases={releases}
      historyByInstallation={historyByInstallation}
      canWrite={canWrite}
      pendingModuleId={pendingModuleId}
      errorCode={errorCode}
      onInstall={(releaseId) =>
        void mutate('install', () =>
          installPublishedProjectModule(DEBUG_PROJECT_ID, releaseId, `debug-install:${releaseId}`),
        )
      }
      onUpdate={(moduleId, releaseId, revision) =>
        void mutate(moduleId, () =>
          updatePublishedProjectModule(
            DEBUG_PROJECT_ID,
            moduleId,
            releaseId,
            revision,
            `debug-update:${releaseId}:${revision}`,
          ),
        )
      }
      onRollback={(moduleId, releaseId, revision) =>
        void mutate(moduleId, () =>
          rollbackPublishedProjectModule(
            DEBUG_PROJECT_ID,
            moduleId,
            releaseId,
            revision,
            `debug-rollback:${releaseId}:${revision}`,
          ),
        )
      }
      onReload={() => void load()}
    />
  );
}

function DebugDeveloperCenterHarness() {
  const [mode, setMode] = useState<DebugMode>(modeFromSearch);
  const [accountId, setAccountId] = useState(DEBUG_ACCOUNT_ID);
  const [detailId, setDetailId] = useState(releaseIdFromSearch);
  const [status, setStatus] = useState<DeveloperModuleReleaseStatus>('review_pending');
  const [cursor, setCursor] = useState<string | null>(null);
  const [publisherReleases, setPublisherReleases] = useState<DeveloperModuleRelease[]>([]);
  const [publisherDetail, setPublisherDetail] = useState<DeveloperModuleRelease | null>(null);
  const [publisherHistory, setPublisherHistory] = useState<DeveloperModuleReviewEvent[]>([]);
  const [adminDetail, setAdminDetail] = useState<AdminDeveloperReviewDetail | null>(null);
  const [adminReleases, setAdminReleases] = useState<DeveloperModuleRelease[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [publisherSearch, setPublisherSearch] = useState('');
  const [publisherStatus, setPublisherStatus] = useState<ReleaseStatusFilter>('all');
  const [adminSearch, setAdminSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [publisherPending, setPublisherPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [adminDetailError, setAdminDetailError] = useState<string | null>(null);
  const [adminConflict, setAdminConflict] = useState(false);
  const [publisherReason, setPublisherReason] = useState('');
  const [adminReason, setAdminReason] = useState('');
  const [adminEvidence, setAdminEvidence] = useState<DeveloperModuleHumanReviewEvidence[]>([]);
  const [adminPending, setAdminPending] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const canRead = true;
  const canWrite = accountId === DEBUG_ACCOUNT_ID;
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);

  useEffect(() => {
    void refreshNonce;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setRequestError(null);
      if (mode === 'admin-detail') setAdminDetailError(null);
      try {
        if (mode === 'publisher-list') {
          const result = await listDeveloperModuleReleases({
            accountId,
            limit: 100,
          });
          if (!cancelled) setPublisherReleases(result.releases);
        } else if (mode === 'publisher-detail') {
          const [release, history] = await Promise.all([
            getDeveloperModuleRelease(detailId, { accountId }),
            getDeveloperModuleReviewHistory(detailId, { accountId }),
          ]);
          if (!cancelled) {
            setPublisherDetail(release);
            setPublisherHistory(history.history);
          }
        } else if (mode === 'admin-queue') {
          const result = await listAdminDeveloperReviews({ status, cursor });
          if (!cancelled) {
            setAdminReleases(result.releases);
            setNextCursor(result.next_cursor);
          }
        } else if (mode === 'admin-detail') {
          const result = await getAdminDeveloperReview(detailId);
          if (!cancelled) setAdminDetail(result);
        }
      } catch (error) {
        if (!cancelled) {
          const code =
            mode === 'admin-queue' || mode === 'admin-detail'
              ? adminDeveloperReviewErrorCode(error)
              : developerCenterErrorCode(error);
          setRequestError(code);
          if (mode === 'admin-detail') setAdminDetailError(code);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [accountId, cursor, detailId, mode, refreshNonce, status]);

  const adminDetailRelease = adminDetail?.release;
  useEffect(() => {
    if (!adminDetailRelease) return;
    setAdminEvidence(createEvidenceDrafts(adminDetailRelease.review_requirements));
    setAdminReason('');
    setAdminConflict(false);
    setRevokeOpen(false);
  }, [adminDetailRelease]);

  useEffect(() => {
    const restoreLocation = () => {
      setMode(modeFromSearch());
      setDetailId(releaseIdFromSearch());
    };
    window.addEventListener('popstate', restoreLocation);
    return () => window.removeEventListener('popstate', restoreLocation);
  }, []);

  const navigate = (nextMode: DebugMode, releaseId = detailId) => {
    setRequestError(null);
    if (nextMode !== 'admin-queue') setCursor(null);
    setDetailId(releaseId);
    setMode(nextMode);
    const query = new URLSearchParams({ mode: nextMode });
    if (nextMode === 'publisher-detail' || nextMode === 'admin-detail') {
      query.set('releaseId', releaseId);
    }
    window.history.pushState({}, '', `/debug/developer-center?${query.toString()}`);
  };

  const submitReview = async (reason?: string) => {
    if (!publisherDetail || publisherPending) return;
    setPublisherPending(true);
    setRequestError(null);
    try {
      await requestDeveloperModuleReview(publisherDetail.release_id, {
        accountId,
        expectedStatus: publisherDetail.status as 'validated' | 'changes_requested',
        expectedRevision: publisherDetail.review_revision,
        reason,
      });
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setRequestError(developerCenterErrorCode(error));
    } finally {
      setPublisherPending(false);
    }
  };

  const decide = async (
    decision: AdminDeveloperReviewDecision,
    input: {
      reason?: string;
      evidence?: readonly DeveloperModuleHumanReviewEvidence[];
    },
  ) => {
    if (!adminDetail) return;
    setAdminPending(true);
    try {
      await decideAdminDeveloperReview(
        adminDetail.release.release_id,
        buildAdminDecisionBody(adminDetail.release, decision, input),
      );
      setAdminConflict(false);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      const code = adminDeveloperReviewErrorCode(error);
      setRequestError(code);
      setAdminConflict(code === 'DEVELOPER_REVIEW_CONFLICT');
    } finally {
      setAdminPending(false);
    }
  };

  const filteredPublisherReleases = filterRecentReleases(
    publisherReleases,
    publisherSearch,
    publisherStatus,
  );
  const publisherListState: PublisherReleaseListViewProps['state'] = loading
    ? 'loading'
    : requestError
      ? 'error'
      : filteredPublisherReleases.length === 0
        ? 'empty'
        : 'ready';
  const publisherDetailState: PublisherReleaseDetailViewProps['state'] = loading
    ? 'loading'
    : requestError || !publisherDetail
      ? 'error'
      : 'ready';
  const adminQueueState: AdminReviewQueueState = loading
    ? 'loading'
    : requestError
      ? 'error'
      : adminReleases.length === 0
        ? 'empty'
        : 'ready';
  const adminDetailState: AdminDeveloperReviewDetailViewProps['state'] = loading
    ? 'loading'
    : adminDetailError || !adminDetail
      ? 'error'
      : 'ready';

  return (
    <main className="bg-background text-foreground min-h-svh">
      <header className="border-border bg-background/95 sticky top-0 z-10 border-b px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2">
          <span className="mr-2 text-sm font-semibold">Developer Center debug</span>
          <Button
            data-testid="debug-publisher-list"
            size="xs"
            variant={mode === 'publisher-list' ? 'secondary' : 'ghost'}
            onClick={() => navigate('publisher-list')}
          >
            Publisher list
          </Button>
          <Button
            data-testid="debug-publisher-submit"
            size="xs"
            variant={mode === 'publisher-submit' ? 'secondary' : 'ghost'}
            onClick={() => navigate('publisher-submit')}
          >
            Submit
          </Button>
          <Button
            data-testid="debug-publisher-detail"
            size="xs"
            variant={mode === 'publisher-detail' ? 'secondary' : 'ghost'}
            onClick={() => navigate('publisher-detail', DEBUG_PUBLISHER_RELEASE_ID)}
          >
            Publisher detail
          </Button>
          <Button
            data-testid="debug-admin-queue"
            size="xs"
            variant={mode === 'admin-queue' ? 'secondary' : 'ghost'}
            onClick={() => navigate('admin-queue')}
          >
            Admin queue
          </Button>
          <Button
            data-testid="debug-admin-detail"
            size="xs"
            variant={mode === 'admin-detail' ? 'secondary' : 'ghost'}
            onClick={() => navigate('admin-detail', DEBUG_ADMIN_RELEASE_ID)}
          >
            Admin detail
          </Button>
          <Button
            data-testid="debug-project-modules"
            size="xs"
            variant={mode === 'project-modules' ? 'secondary' : 'ghost'}
            onClick={() => navigate('project-modules')}
          >
            Project modules
          </Button>
          <span className="bg-border mx-1 h-5 w-px" />
          <Button
            data-testid="debug-account-a"
            size="xs"
            variant={accountId === DEBUG_ACCOUNT_ID ? 'secondary' : 'ghost'}
            onClick={() => {
              setAccountId(DEBUG_ACCOUNT_ID);
              useCurrentAccountStore.getState().setSelectedAccountId(DEBUG_ACCOUNT_ID);
              navigate('publisher-list');
            }}
          >
            Personal account
          </Button>
          <Button
            data-testid="debug-account-b"
            size="xs"
            variant={accountId === DEBUG_TEAM_ACCOUNT_ID ? 'secondary' : 'ghost'}
            onClick={() => {
              setAccountId(DEBUG_TEAM_ACCOUNT_ID);
              useCurrentAccountStore.getState().setSelectedAccountId(DEBUG_TEAM_ACCOUNT_ID);
              navigate('publisher-list');
            }}
          >
            Read-only team
          </Button>
          <Button
            data-testid="debug-admin-malformed-cursor"
            size="xs"
            variant="ghost"
            onClick={() => {
              setCursor('not-a-valid-cursor');
              navigate('admin-queue');
            }}
          >
            Malformed cursor
          </Button>
        </div>
        <div
          className="text-muted-foreground mx-auto mt-2 max-w-7xl text-xs"
          data-testid="debug-capabilities"
        >
          account.read: {canRead ? 'allowed' : 'denied'} · account.write:{' '}
          {canWrite ? 'allowed' : 'denied'} · account: {accountId}
        </div>
        <span className="sr-only" data-testid="debug-selected-account">
          {selectedAccountId ?? 'none'}
        </span>
      </header>

      {mode === 'publisher-list' ? (
        <PublisherReleaseListView
          state={publisherListState}
          releases={filteredPublisherReleases}
          search={publisherSearch}
          status={publisherStatus}
          canWrite={canWrite}
          errorCode={requestError}
          onSearchChange={setPublisherSearch}
          onStatusChange={setPublisherStatus}
          onOpenRelease={(releaseId) => navigate('publisher-detail', releaseId)}
          onSubmit={() => navigate('publisher-submit')}
        />
      ) : null}
      {mode === 'publisher-submit' ? (
        <PublisherSubmitHarness
          accountId={accountId}
          canWrite={canWrite}
          onSubmitted={(releaseId) => navigate('publisher-detail', releaseId)}
        />
      ) : null}
      {mode === 'publisher-detail' ? (
        <PublisherReleaseDetailView
          state={publisherDetailState}
          release={publisherDetail}
          history={publisherHistory}
          canWrite={canWrite}
          pending={publisherPending}
          errorCode={requestError}
          reason={publisherReason}
          onReasonChange={setPublisherReason}
          onRequestReview={(reason) => void submitReview(reason)}
        />
      ) : null}
      {mode === 'admin-queue' ? (
        <AdminDeveloperReviewQueueView
          state={adminQueueState}
          status={status}
          releases={adminReleases}
          search={adminSearch}
          nextCursor={nextCursor}
          errorCode={requestError}
          onSearchChange={setAdminSearch}
          onStatusChange={(nextStatus) => {
            setStatus(nextStatus);
            setCursor(null);
          }}
          onNextPage={() => {
            if (nextCursor) setCursor(nextCursor);
          }}
          onResetCursor={() => setCursor(null)}
          onOpenRelease={(releaseId) => navigate('admin-detail', releaseId)}
        />
      ) : null}
      {mode === 'admin-detail' ? (
        <AdminDeveloperReviewDetailView
          state={adminDetailState}
          release={adminDetail?.release ?? null}
          history={adminDetail?.history ?? []}
          evidence={adminEvidence}
          reason={adminReason}
          pending={adminPending}
          conflict={adminConflict}
          revokeOpen={revokeOpen}
          errorCode={requestError}
          onReasonChange={setAdminReason}
          onEvidenceChange={(index, patch) =>
            setAdminEvidence((current) =>
              current.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, ...patch } : entry,
              ),
            )
          }
          onDecision={(decision, input) => void decide(decision, input)}
          onReload={async () => {
            setAdminConflict(false);
            setRequestError(null);
            setAdminDetailError(null);
            setRefreshNonce((value) => value + 1);
          }}
          onRevokeOpenChange={setRevokeOpen}
        />
      ) : null}
      {mode === 'project-modules' ? <ProjectModulesDebugHarness canWrite={canWrite} /> : null}
    </main>
  );
}

export default function DebugDeveloperCenterPage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousAccountId = useCurrentAccountStore.getState().selectedAccountId;
    setBootstrapAuthToken('debug-developer-center-token');
    useCurrentAccountStore.getState().setSelectedAccountId(DEBUG_ACCOUNT_ID);
    setReady(true);
    return () => {
      setBootstrapAuthToken(null);
      invalidateTokenCache();
      useCurrentAccountStore.getState().setSelectedAccountId(previousAccountId);
    };
  }, []);

  if (!ready) return null;
  return <DebugDeveloperCenterHarness />;
}
