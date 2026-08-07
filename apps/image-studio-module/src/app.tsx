import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Film,
  Images,
  RotateCcw,
  ScanSearch,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import type { OpenOpcImageAsset, OpenOpcImageModel, OpenOpcModel } from '@openopc/developer-sdk';
import {
  listAssetPage,
  listImageModels,
  listTextModels,
  mergeImageAssets,
  openOpcErrorMessage,
  resolveNextAssetCursor,
} from './lib/openopc-image-service';
import { useSessionState } from './lib/session-state';
import { AgentWorkspace } from './workspaces/agent-workspace';
import { AssetsWorkspace } from './workspaces/assets-workspace';
import { CreateWorkspace } from './workspaces/create-workspace';
import { GifWorkspace } from './workspaces/gif-workspace';
import { ReversePromptWorkspace } from './workspaces/reverse-prompt-workspace';
import './styles.css';

export type WorkspaceMode = 'create' | 'agent' | 'reverse' | 'gif' | 'assets';

const MODES: Array<{ id: WorkspaceMode; label: string; icon: typeof Sparkles }> = [
  { id: 'create', label: '生图', icon: Sparkles },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'reverse', label: '反推提示词', icon: ScanSearch },
  { id: 'gif', label: '动图', icon: Film },
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
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [textModelError, setTextModelError] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [createPrompt, setCreatePrompt] = useSessionState('image-studio.create.prompt', '');
  const [createReferenceAssetIds, setCreateReferenceAssetIds] = useSessionState<string[]>(
    'image-studio.create.references',
    [],
    isStringArray,
  );
  const [promptFocusVersion, setPromptFocusVersion] = useState(0);
  const assetRequestVersionRef = useRef(0);
  const requestedAssetCursorsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void Promise.allSettled([listImageModels(), listTextModels(), listAssetPage()]).then((settled) => {
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
    }).finally(() => {
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

  const usePrompt = (prompt: string) => {
    setCreatePrompt(prompt);
    setMode('create');
    setPromptFocusVersion((version) => version + 1);
  };

  const useAssetAsReference = (assetId: string) => {
    setCreateReferenceAssetIds((current) => [
      assetId,
      ...current.filter((id) => id !== assetId),
    ].slice(0, 8));
    setMode('create');
    setPromptFocusVersion((version) => version + 1);
  };

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div className="brand-lockup">
          <div className="brand-mark"><WandSparkles size={17} /></div>
          <div>
            <p className="eyebrow">OpenOPC module</p>
            <h1>Image Studio</h1>
          </div>
        </div>
        <div className="header-status">
          <span className={`status-dot ${loading ? 'is-loading' : startupError ? 'is-error' : ''}`} />
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
            <RotateCcw size={15} />重试
          </button>
        </section>
      ) : null}
      {mode !== 'assets' && (textModelError || assetError) ? (
        <section className="notice info-notice">
          <p>{textModelError ?? assetError}</p>
        </section>
      ) : null}

      <div id="panel-create" role="tabpanel" aria-labelledby="tab-create" hidden={mode !== 'create'}>
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
        />
      </div>
      <div id="panel-agent" role="tabpanel" aria-labelledby="tab-agent" hidden={mode !== 'agent'}>
        <AgentWorkspace
          imageModels={imageModels}
          textModels={textModels}
          modelsReady={!loading}
          onAssetsChanged={refreshAssets}
          onUsePrompt={usePrompt}
          onUseAsReference={useAssetAsReference}
        />
      </div>
      <div id="panel-reverse" role="tabpanel" aria-labelledby="tab-reverse" hidden={mode !== 'reverse'}>
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
        />
      </div>
      <div id="panel-assets" role="tabpanel" aria-labelledby="tab-assets" hidden={mode !== 'assets'}>
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
