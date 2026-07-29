'use client';

import {
  type DeveloperModuleRelease,
  type DeveloperModuleReviewEvent,
  type DeveloperModuleTrustView,
  type ProjectModuleInstallation,
  type ProjectModuleInstallationEvent,
  type ProjectModuleInstallationTransition,
  createDeclarativeDeveloperModuleArtifact,
  getDeveloperModuleRelease,
  getDeveloperModuleReviewHistory,
  getDeveloperModuleTrust,
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
  type DeveloperModuleArtifactUploadState,
  createDeveloperModuleArtifactUploadController,
  defaultDeveloperModuleArtifactUploadDependencies,
} from '@/features/developer-center/publisher/artifact-upload-controller';
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
import {
  type DeveloperModuleSubmitMode,
  DeveloperModuleSubmitView,
} from '@/features/developer-center/publisher/submit-page';
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
const DEBUG_PROJECT_ID = '24000000-0000-4000-a000-000000000001';

type DebugMode =
  | 'publisher-list'
  | 'publisher-submit'
  | 'publisher-detail'
  | 'project-modules';

function modeFromSearch(): DebugMode {
  if (typeof window === 'undefined') return 'publisher-list';
  const value = new URLSearchParams(window.location.search).get('mode');
  return value === 'publisher-submit' ||
    value === 'publisher-detail' ||
    value === 'project-modules'
    ? value
    : 'publisher-list';
}

function releaseIdFromSearch(): string {
  if (typeof window === 'undefined') return DEBUG_PUBLISHER_RELEASE_ID;
  return new URLSearchParams(window.location.search).get('releaseId') ?? DEBUG_PUBLISHER_RELEASE_ID;
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
  const [submitMode, setSubmitMode] = useState<DeveloperModuleSubmitMode>('declarative');
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [packagePublisherId, setPackagePublisherId] = useState('');
  const [packageState, setPackageState] = useState<DeveloperModuleArtifactUploadState>({
    stage: 'idle',
    fileName: null,
    fileSize: 0,
    progress: 0,
    digest: null,
    uploadId: null,
    artifact: null,
    submission: null,
  });
  const [packageController] = useState(() =>
    createDeveloperModuleArtifactUploadController(
      defaultDeveloperModuleArtifactUploadDependencies,
      setPackageState,
    ),
  );

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
  const selectPackage = (file: File) => {
    setError(null);
    if (packageState.stage !== 'idle' && packageState.stage !== 'submitted') {
      try {
        packageController.reset();
      } catch {
        return;
      }
    }
    setPackageFile(file);
  };
  const submitPackage = async () => {
    if (!packageFile || !packagePublisherId.trim()) return;
    setError(null);
    try {
      const result = await packageController.start(packageFile, {
        accountId,
        publisherId: packagePublisherId.trim(),
      });
      if (result) onSubmitted(result.release.release_id);
    } catch (reason) {
      setError(developerCenterErrorCode(reason));
    }
  };

  return (
    <DeveloperModuleSubmitView
      mode={submitMode}
      stage={state.stage}
      text={state.text}
      item={state.parsedItem}
      issues={state.issues}
      inputErrorCode={state.inputErrorCode}
      canWrite={canWrite}
      pending={pending}
      validating={validating}
      errorCode={error}
      packageFileName={packageFile?.name ?? null}
      packagePublisherId={packagePublisherId}
      packageState={packageState}
      onModeChange={setSubmitMode}
      onTextChange={updateText}
      onValidate={validate}
      onConfirm={confirm}
      onPackagePublisherIdChange={setPackagePublisherId}
      onPackageFile={selectPackage}
      onStartPackage={submitPackage}
      onCancelPackage={() => packageController.cancel()}
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
  const [publisherReleases, setPublisherReleases] = useState<DeveloperModuleRelease[]>([]);
  const [publisherDetail, setPublisherDetail] = useState<DeveloperModuleRelease | null>(null);
  const [publisherHistory, setPublisherHistory] = useState<DeveloperModuleReviewEvent[]>([]);
  const [publisherTrust, setPublisherTrust] = useState<DeveloperModuleTrustView | null>(null);
  const [publisherSearch, setPublisherSearch] = useState('');
  const [publisherStatus, setPublisherStatus] = useState<ReleaseStatusFilter>('all');
  const [loading, setLoading] = useState(false);
  const [publisherPending, setPublisherPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [publisherReason, setPublisherReason] = useState('');
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
      try {
        if (mode === 'publisher-list') {
          const result = await listDeveloperModuleReleases({
            accountId,
            limit: 100,
          });
          if (!cancelled) setPublisherReleases(result.releases);
        } else if (mode === 'publisher-detail') {
          const [release, history, trust] = await Promise.all([
            getDeveloperModuleRelease(detailId, { accountId }),
            getDeveloperModuleReviewHistory(detailId, { accountId }),
            getDeveloperModuleTrust(detailId, { accountId }),
          ]);
          if (!cancelled) {
            setPublisherDetail(release);
            setPublisherHistory(history.history);
            setPublisherTrust(trust);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setRequestError(developerCenterErrorCode(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [accountId, detailId, mode, refreshNonce]);

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
    setDetailId(releaseId);
    setMode(nextMode);
    const query = new URLSearchParams({ mode: nextMode });
    if (nextMode === 'publisher-detail') {
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
          trust={publisherTrust}
          canWrite={canWrite}
          pending={publisherPending}
          errorCode={requestError}
          reason={publisherReason}
          onReasonChange={setPublisherReason}
          onRequestReview={(reason) => void submitReview(reason)}
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
