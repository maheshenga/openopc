import type {
  OpenOpcImageAsset,
  OpenOpcImageJob,
  OpenOpcImageModel,
  OpenOpcModel,
} from '@openopc/developer-sdk';
import {
  Bot,
  Film,
  Images,
  ListChecks,
  RotateCcw,
  ScanSearch,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAssetPage,
  listImageJobPage,
  listImageModels,
  listTextModels,
  mergeImageAssets,
  mergeImageJobs,
  mergeLatestImageJobs,
  openOpcErrorMessage,
  resolveNextAssetCursor,
  resolveNextJobCursor,
} from './lib/openopc-image-service';
import { ACTIVE_JOB_REFRESH_MS, shouldAutoRefreshJobs } from './lib/job-polling';
import { useSessionState } from './lib/session-state';
import { AgentWorkspace } from './workspaces/agent-workspace';
import { AssetsWorkspace } from './workspaces/assets-workspace';
import { CreateWorkspace } from './workspaces/create-workspace';
import { GifWorkspace } from './workspaces/gif-workspace';
import { JobsWorkspace } from './workspaces/jobs-workspace';
import { ReversePromptWorkspace } from './workspaces/reverse-prompt-workspace';
import './styles.css';

export type WorkspaceMode = 'create' | 'agent' | 'reverse' | 'gif' | 'jobs' | 'assets';

const MODES: Array<{ id: WorkspaceMode; label: string; icon: typeof Sparkles }> = [
  { id: 'create', label: '生图', icon: Sparkles },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'reverse', label: '反推提示词', icon: ScanSearch },
  { id: 'gif', label: '动图', icon: Film },
  { id: 'jobs', label: '任务', icon: ListChecks },
  { id: 'assets', label: '素材', icon: Images },
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function ImageStudioApp() {
  const [mode, setMode] = useState<WorkspaceMode>('create');
  const [imageModels, setImageModels] = useState<OpenOpcImageModel[]>([]);
  const [textModels, setTextModels] = useState<OpenOpcModel[]>([]);
  const [assets, setAssets] = useState<OpenOpcImageAsset[]>([]);
  const [assetCursor, setAssetCursor] = useState<string | null>(null);
  const [loadingMoreAssets, setLoadingMoreAssets] = useState(false);
  const [jobs, setJobs] = useState<OpenOpcImageJob[]>([]);
  const [jobCursor, setJobCursor] = useState<string | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingMoreJobs, setLoadingMoreJobs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [textModelError, setTextModelError] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [createPrompt, setCreatePrompt] = useSessionState('image-studio.create.prompt', '');
  const [createReferenceAssetIds, setCreateReferenceAssetIds] = useSessionState<string[]>(
    'image-studio.create.references',
    [],
    isStringArray,
  );
  const [promptFocusVersion, setPromptFocusVersion] = useState(0);
  const assetRequestVersionRef = useRef(0);
  const requestedAssetCursorsRef = useRef<Set<string>>(new Set());
  const jobRequestVersionRef = useRef(0);
  const jobRefreshInFlightRef = useRef(false);
  const requestedJobCursorsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void Promise.allSettled([listImageModels(), listTextModels(), listAssetPage()])
      .then((settled) => {
        if (!active) return;
        const [imageResult, textResult, assetResult] = settled;
        if (imageResult?.status === 'fulfilled') {
          setImageModels(imageResult.value);
        } else {
          setStartupError(openOpcErrorMessage(imageResult?.reason, '无法连接 OpenOPC 生图服务'));
        }
        if (textResult?.status === 'fulfilled') {
          setTextModels(textResult.value);
        } else {
          setTextModelError(openOpcErrorMessage(textResult?.reason, '文本模型暂不可用'));
        }
        if (assetResult?.status === 'fulfilled' && assetRequestVersionRef.current === 0) {
          requestedAssetCursorsRef.current = new Set();
          setAssets(assetResult.value.items);
          setAssetCursor(assetResult.value.nextCursor);
        } else if (assetResult?.status === 'rejected' && assetRequestVersionRef.current === 0) {
          setAssetError(openOpcErrorMessage(assetResult?.reason, '素材列表暂不可用'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshAssets = async () => {
    const requestVersion = ++assetRequestVersionRef.current;
    setLoadingMoreAssets(false);
    try {
      setAssetError(null);
      const page = await listAssetPage();
      if (requestVersion !== assetRequestVersionRef.current) return;
      requestedAssetCursorsRef.current = new Set();
      setAssets(page.items);
      setAssetCursor(page.nextCursor);
    } catch (reason) {
      if (requestVersion !== assetRequestVersionRef.current) return;
      setAssetError(openOpcErrorMessage(reason, '刷新素材失败'));
    }
  };

  const loadMoreAssets = async () => {
    if (!assetCursor || loadingMoreAssets) return;
    const requestVersion = assetRequestVersionRef.current;
    const cursor = assetCursor;
    if (requestedAssetCursorsRef.current.has(cursor)) {
      setAssetCursor(null);
      return;
    }
    setLoadingMoreAssets(true);
    try {
      setAssetError(null);
      const page = await listAssetPage(cursor);
      if (requestVersion !== assetRequestVersionRef.current) return;
      const requestedCursors = new Set(requestedAssetCursorsRef.current);
      requestedCursors.add(cursor);
      requestedAssetCursorsRef.current = requestedCursors;
      setAssets((current) => mergeImageAssets(current, page.items));
      setAssetCursor(resolveNextAssetCursor(page.nextCursor, requestedCursors));
    } catch (reason) {
      if (requestVersion !== assetRequestVersionRef.current) return;
      setAssetError(openOpcErrorMessage(reason, '加载更多素材失败'));
    } finally {
      if (requestVersion === assetRequestVersionRef.current) setLoadingMoreAssets(false);
    }
  };

  const refreshJobs = useCallback(async (silent = false) => {
    if (jobRefreshInFlightRef.current) return;
    jobRefreshInFlightRef.current = true;
    const requestVersion = ++jobRequestVersionRef.current;
    setLoadingMoreJobs(false);
    if (!silent) setLoadingJobs(true);
    try {
      setJobError(null);
      const page = await listImageJobPage();
      if (requestVersion !== jobRequestVersionRef.current) return;
      if (silent) {
        setJobs((current) => mergeLatestImageJobs(current, page.items));
      } else {
        requestedJobCursorsRef.current = new Set();
        setJobs(page.items);
        setJobCursor(page.nextCursor);
      }
    } catch (reason) {
      if (requestVersion !== jobRequestVersionRef.current) return;
      setJobError(openOpcErrorMessage(reason, '读取任务失败'));
    } finally {
      jobRefreshInFlightRef.current = false;
      if (!silent) setLoadingJobs(false);
    }
  }, []);

  const loadMoreJobs = async () => {
    if (!jobCursor || loadingMoreJobs) return;
    const requestVersion = jobRequestVersionRef.current;
    const cursor = jobCursor;
    if (requestedJobCursorsRef.current.has(cursor)) {
      setJobCursor(null);
      return;
    }
    setLoadingMoreJobs(true);
    try {
      setJobError(null);
      const page = await listImageJobPage(cursor);
      if (requestVersion !== jobRequestVersionRef.current) return;
      const requestedCursors = new Set(requestedJobCursorsRef.current);
      requestedCursors.add(cursor);
      requestedJobCursorsRef.current = requestedCursors;
      setJobs((current) => mergeImageJobs(current, page.items));
      setJobCursor(resolveNextJobCursor(page.nextCursor, requestedCursors));
    } catch (reason) {
      if (requestVersion !== jobRequestVersionRef.current) return;
      setJobError(openOpcErrorMessage(reason, '加载更多任务失败'));
    } finally {
      if (requestVersion === jobRequestVersionRef.current) setLoadingMoreJobs(false);
    }
  };

  useEffect(() => {
    if (mode === 'jobs') void refreshJobs();
  }, [mode, refreshJobs]);

  const hasActiveJobs = jobs.some((job) => job.status === 'queued' || job.status === 'running');

  useEffect(() => {
    if (mode !== 'jobs' || !hasActiveJobs || typeof document === 'undefined') return undefined;
    const refreshIfVisible = () => {
      if (shouldAutoRefreshJobs(true, true, document.visibilityState)) void refreshJobs(true);
    };
    const timer = window.setInterval(refreshIfVisible, ACTIVE_JOB_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [hasActiveJobs, mode, refreshJobs]);

  const updateJob = (updatedJob: OpenOpcImageJob) => {
    setJobs((current) => {
      const exists = current.some((job) => job.job_id === updatedJob.job_id);
      return exists
        ? current.map((job) => (job.job_id === updatedJob.job_id ? updatedJob : job))
        : [updatedJob, ...current];
    });
  };

  const usePrompt = (prompt: string) => {
    setCreatePrompt(prompt);
    setMode('create');
    setPromptFocusVersion((version) => version + 1);
  };

  const useAssetAsReference = (assetId: string) => {
    setCreateReferenceAssetIds((current) =>
      [assetId, ...current.filter((id) => id !== assetId)].slice(0, 8),
    );
    setMode('create');
    setPromptFocusVersion((version) => version + 1);
  };

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <WandSparkles size={17} />
          </div>
          <div>
            <p className="eyebrow">OpenOPC module</p>
            <h1>Image Studio</h1>
          </div>
        </div>
        <div className="header-status">
          <span
            className={`status-dot ${loading ? 'is-loading' : startupError ? 'is-error' : ''}`}
          />
          {loading ? '连接中' : startupError ? '生图服务不可用' : `${imageModels.length} 个模型`}
        </div>
      </header>

      <nav className="mode-tabs" aria-label="工作区" role="tablist">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            id={`tab-${id}`}
            type="button"
            role="tab"
            aria-selected={mode === id}
            aria-controls={`panel-${id}`}
            className={mode === id ? 'mode-tab is-active' : 'mode-tab'}
            onClick={() => setMode(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {startupError ? (
        <section className="notice error-notice" role="alert">
          <p>{startupError}</p>
          <button type="button" className="button subtle" onClick={() => window.location.reload()}>
            <RotateCcw size={15} />
            重试
          </button>
        </section>
      ) : null}
      {mode !== 'assets' && mode !== 'jobs' && (textModelError || assetError) ? (
        <section className="notice info-notice">
          <p>{textModelError ?? assetError}</p>
        </section>
      ) : null}

      <div
        id="panel-create"
        role="tabpanel"
        aria-labelledby="tab-create"
        hidden={mode !== 'create'}
      >
        <CreateWorkspace
          models={imageModels}
          modelsReady={!loading}
          textModels={textModels}
          prompt={createPrompt}
          setPrompt={setCreatePrompt}
          promptFocusVersion={promptFocusVersion}
          referenceAssetIds={createReferenceAssetIds}
          setReferenceAssetIds={setCreateReferenceAssetIds}
          onAssetsChanged={refreshAssets}
          onJobUpdated={updateJob}
        />
      </div>
      <div id="panel-agent" role="tabpanel" aria-labelledby="tab-agent" hidden={mode !== 'agent'}>
        <AgentWorkspace
          imageModels={imageModels}
          textModels={textModels}
          modelsReady={!loading}
          onAssetsChanged={refreshAssets}
          onJobUpdated={updateJob}
          onUsePrompt={usePrompt}
          onUseAsReference={useAssetAsReference}
        />
      </div>
      <div
        id="panel-reverse"
        role="tabpanel"
        aria-labelledby="tab-reverse"
        hidden={mode !== 'reverse'}
      >
        <ReversePromptWorkspace
          textModels={textModels}
          modelsReady={!loading}
          onUsePrompt={usePrompt}
        />
      </div>
      <div id="panel-gif" role="tabpanel" aria-labelledby="tab-gif" hidden={mode !== 'gif'}>
        <GifWorkspace
          models={imageModels}
          modelsReady={!loading}
          onAssetsChanged={refreshAssets}
          onJobUpdated={updateJob}
        />
      </div>
      <div id="panel-jobs" role="tabpanel" aria-labelledby="tab-jobs" hidden={mode !== 'jobs'}>
        <JobsWorkspace
          jobs={jobs}
          jobError={jobError}
          loading={loadingJobs && jobs.length === 0}
          refreshing={loadingJobs && jobs.length > 0}
          hasMore={jobCursor !== null}
          loadingMore={loadingMoreJobs}
          onRefresh={refreshJobs}
          onLoadMore={loadMoreJobs}
          onJobUpdated={updateJob}
          onUsePrompt={usePrompt}
        />
      </div>
      <div
        id="panel-assets"
        role="tabpanel"
        aria-labelledby="tab-assets"
        hidden={mode !== 'assets'}
      >
        <AssetsWorkspace
          assets={assets}
          assetError={assetError}
          onRefresh={refreshAssets}
          hasMore={assetCursor !== null}
          loadingMore={loadingMoreAssets}
          onLoadMore={loadMoreAssets}
          onUseAsReference={useAssetAsReference}
        />
      </div>
    </main>
  );
}
