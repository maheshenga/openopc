import {
  Bot,
  Cloud,
  CloudOff,
  Download,
  FolderOpen,
  Menu,
  PanelRight,
  Redo2,
  Save,
  Settings2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import { AssistantPanel } from './assistant-panel';
import type { AssistantAction } from './assistant';
import { CanvasWorkspace, type DirectorCapture } from './canvas-workspace';
import { Inspector } from './inspector';
import { composeGenerationInput } from './generation';
import { DEFAULT_PROMPTS, DEFAULT_WORKFLOWS, cloneDefaults } from './library';
import {
  type LocalAsset,
  deleteLocalAsset,
  deleteLocalPrompt,
  deleteLocalProject,
  deleteLocalWorkflow,
  listLocalAssets,
  listLocalPrompts,
  listLocalProjects,
  listLocalWorkflows,
  readLocalAsset,
  readLocalProject,
  writeLocalAsset,
  writeLocalPrompt,
  writeLocalProject,
  writeLocalWorkflow,
} from './persistence';
import { type PlatformBridge, createPlatformBridge } from './platform';
import {
  createEditorState,
  createNode,
  createProject,
  editorReducer,
  isCanvasProject,
  migrateImportedProject,
  normalizeCanvasProject,
} from './project-state';
import { type DisplayAsset, Sidebar } from './sidebar';
import { encodeCanvasZip, readCanvasZip } from './transfer';
import type {
  AssistantImage,
  AssistantReference,
  CanvasBackground,
  CanvasNode,
  CanvasProject,
  GenerationRecord,
  NodeKind,
  PromptRecord,
  WorkflowRecord,
} from './types';

const LOCAL_PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
const ALLOWED_ASSET_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

function persistableProject(project: CanvasProject): CanvasProject {
  const normalized = normalizeCanvasProject(project);
  return {
    ...normalized,
    nodes: normalized.nodes.map((node) => ({
      ...node,
      assetUrl: undefined,
    })),
    chatSessions: normalized.chatSessions.map((session) => ({
      ...session,
      messages: session.messages.map((message) => ({
        ...message,
        references: message.references?.map((reference) => ({
          ...reference,
          assetUrl: undefined,
        })),
        images: message.images?.map((image) => ({
          ...image,
          assetUrl: undefined,
        })),
      })),
    })),
  };
}

function hydrateAssetUrls(project: CanvasProject, assets: readonly DisplayAsset[]): CanvasProject {
  const urls = new Map(assets.map((asset) => [asset.id, asset.url]));
  const normalized = normalizeCanvasProject(project);
  return {
    ...normalized,
    nodes: normalized.nodes.map((node) =>
      node.assetId && urls.has(node.assetId) ? { ...node, assetUrl: urls.get(node.assetId) } : node,
    ),
    chatSessions: normalized.chatSessions.map((session) => ({
      ...session,
      messages: session.messages.map((message) => ({
        ...message,
        references: message.references?.map((reference) =>
          reference.assetId && urls.has(reference.assetId)
            ? { ...reference, assetUrl: urls.get(reference.assetId) }
            : reference,
        ),
        images: message.images?.map((image) =>
          image.assetId && urls.has(image.assetId)
            ? { ...image, assetUrl: urls.get(image.assetId) }
            : image,
        ),
      })),
    })),
  };
}

function assetKind(mimeType: string): NodeKind {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function downloadUrl(name: string, url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function resolveReferenceBlobs(
  references: readonly AssistantReference[] | undefined,
  namespace: string,
  signal: AbortSignal,
): Promise<readonly { blob: Blob; filename: string }[]> {
  const resolved: { blob: Blob; filename: string }[] = [];
  for (const reference of references ?? []) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!reference.assetId || resolved.length >= 8) continue;
    const asset = await readLocalAsset(reference.assetId, namespace);
    if (!asset || !asset.mimeType.startsWith('image/') || asset.blob.size <= 0) continue;
    resolved.push({ blob: asset.blob, filename: asset.name });
  }
  return resolved;
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 80) || 'infinite-canvas'
  );
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const result = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片尺寸'));
    };
    image.src = url;
  });
}

function isStrictPanorama(dimensions: { width: number; height: number }): boolean {
  return dimensions.height > 0 && Math.abs(dimensions.width / dimensions.height - 2) <= 0.005;
}

function importedProjectBundle(value: unknown): CanvasProject[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { schemaVersion?: unknown; projects?: unknown };
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.projects) ||
    record.projects.length > 200
  ) {
    return null;
  }
  const migrated = record.projects.flatMap((project) => {
    const next = migrateImportedProject(project);
    return next ? [next] : [];
  });
  return migrated.length === record.projects.length ? migrated : null;
}

function renderProjectImage(project: CanvasProject): Blob {
  const nodes = project.nodes;
  const minX = nodes.length ? Math.min(...nodes.map((node) => node.x)) : 0;
  const minY = nodes.length ? Math.min(...nodes.map((node) => node.y)) : 0;
  const maxX = nodes.length ? Math.max(...nodes.map((node) => node.x + node.width)) : 1200;
  const maxY = nodes.length ? Math.max(...nodes.map((node) => node.y + node.height)) : 800;
  const padding = 80;
  const scale = Math.min(1, 4096 / Math.max(maxX - minX + padding * 2, maxY - minY + padding * 2));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(640, Math.round((maxX - minX + padding * 2) * scale));
  canvas.height = Math.max(480, Math.round((maxY - minY + padding * 2) * scale));
  const context = canvas.getContext('2d');
  if (!context) return new Blob([], { type: 'image/png' });
  context.fillStyle = '#f4f5f7';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(scale, scale);
  context.translate(-minX + padding, -minY + padding);
  context.strokeStyle = '#aeb4bd';
  context.lineWidth = 2;
  for (const connection of project.connections) {
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target) continue;
    context.beginPath();
    context.moveTo(source.x + source.width, source.y + source.height / 2);
    context.lineTo(target.x, target.y + target.height / 2);
    context.stroke();
  }
  for (const node of nodes) {
    context.fillStyle = '#ffffff';
    context.strokeStyle = '#262a30';
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(node.x, node.y, node.width, node.height, 8);
    context.fill();
    context.stroke();
    context.fillStyle = '#17191d';
    context.font = '600 18px sans-serif';
    context.fillText(node.title, node.x + 18, node.y + 32, node.width - 36);
    context.fillStyle = '#626973';
    context.font = '14px sans-serif';
    const text = node.content || node.prompt || node.assetName || node.kind;
    context.fillText(text.slice(0, 120), node.x + 18, node.y + 64, node.width - 36);
  }
  context.restore();
  const data = canvas.toDataURL('image/png').split(',')[1] ?? '';
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

function settingNumber(bridge: PlatformBridge | null, key: string, fallback: number): number {
  const value = bridge?.settings?.values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function settingBoolean(bridge: PlatformBridge | null, key: string, fallback: boolean): boolean {
  const value = bridge?.settings?.values[key];
  return typeof value === 'boolean' ? value : fallback;
}

function settingBackground(bridge: PlatformBridge): CanvasBackground {
  const value = bridge.settings?.values['canvas.background'];
  return value === 'lines' || value === 'plain' ? value : 'dots';
}

export function App() {
  const initialProject = useMemo(() => createProject(new Date(), LOCAL_PROJECT_ID), []);
  const [state, dispatch] = useReducer(editorReducer, createEditorState(initialProject));
  const [bridge, setBridge] = useState<PlatformBridge | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [assets, setAssets] = useState<DisplayAsset[]>([]);
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [prompts, setPrompts] = useState<PromptRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | undefined>(undefined);
  const revision = useRef<number | null>(null);
  const generationControllers = useRef(new Map<string, AbortController>());
  const assetUrls = useRef(new Map<string, string>());
  const currentProject = useRef(state.project);
  const currentState = useRef(state);
  const clipboardIds = useRef<string[]>([]);
  currentProject.current = state.project;
  currentState.current = state;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4200);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void createPlatformBridge(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setBridge(next);
          if (next.errorMessage) showNotice(next.errorMessage);
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [showNotice]);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const projectId = bridge.context ? `project-${bridge.context.projectId}` : initialProject.id;
    const emptyProject = {
      ...createProject(new Date(), projectId),
      background: settingBackground(bridge),
    };
    void Promise.all([
      readLocalProject(projectId, bridge.namespace),
      listLocalAssets(bridge.namespace),
      listLocalProjects(bridge.namespace),
      listLocalPrompts(bridge.namespace),
      listLocalWorkflows(bridge.namespace),
      bridge.listProjects().catch(() => []),
    ])
      .then(
        ([
          localProject,
          localAssets,
          localProjects,
          localPrompts,
          localWorkflows,
          remoteProjects,
        ]) => {
          if (cancelled) return;
          const safeLocalAssets = Array.isArray(localAssets) ? localAssets : [];
          const safeLocalProjects = Array.isArray(localProjects) ? localProjects : [];
          const safeLocalPrompts = Array.isArray(localPrompts) ? localPrompts : [];
          const safeLocalWorkflows = Array.isArray(localWorkflows) ? localWorkflows : [];
          const safeRemoteProjects = Array.isArray(remoteProjects) ? remoteProjects : [];
          const displayAssets = safeLocalAssets.map((asset) => {
            const url = URL.createObjectURL(asset.blob);
            assetUrls.current.set(asset.id, url);
            return { ...asset, url, bytes: asset.blob.size };
          });
          setAssets(displayAssets);
          const nextPrompts = safeLocalPrompts.length
            ? safeLocalPrompts
            : cloneDefaults(DEFAULT_PROMPTS);
          const nextWorkflows = safeLocalWorkflows.length
            ? safeLocalWorkflows
            : cloneDefaults(DEFAULT_WORKFLOWS);
          setPrompts(nextPrompts);
          setWorkflows(nextWorkflows);
          if (safeLocalPrompts.length === 0) {
            void Promise.all(
              nextPrompts.map((prompt) => writeLocalPrompt(prompt, bridge.namespace)),
            );
          }
          if (safeLocalWorkflows.length === 0) {
            void Promise.all(
              nextWorkflows.map((workflow) => writeLocalWorkflow(workflow, bridge.namespace)),
            );
          }
          const remoteActive = safeRemoteProjects.find(({ project }) => project.id === projectId);
          if (!localProject && remoteActive) revision.current = remoteActive.revision;
          const active =
            localProject && isCanvasProject(localProject)
              ? localProject
              : (remoteActive?.project ?? emptyProject);
          dispatch({ type: 'hydrate', project: hydrateAssetUrls(active, displayAssets) });
          setProjects(
            [active, ...safeLocalProjects, ...safeRemoteProjects.map(({ project }) => project)]
              .filter(
                (project, index, all) => all.findIndex((item) => item.id === project.id) === index,
              )
              .filter(isCanvasProject)
              .map((project) => normalizeCanvasProject(project))
              .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
          );
          setHydrated(true);
        },
      )
      .catch((error) => {
        if (cancelled) return;
        dispatch({ type: 'hydrate', project: emptyProject });
        setAssets([]);
        setPrompts(cloneDefaults(DEFAULT_PROMPTS));
        setWorkflows(cloneDefaults(DEFAULT_WORKFLOWS));
        setProjects([emptyProject]);
        setHydrated(true);
        showNotice(
          error instanceof Error ? `本地画布恢复失败：${error.message}` : '本地画布恢复失败',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, initialProject.id, showNotice]);

  useEffect(() => {
    if (!hydrated || bridge?.status !== 'ready') return;
    const controller = new AbortController();
    void bridge
      .readProject(state.project.id, { signal: controller.signal })
      .then((remote) => {
        if (!remote || controller.signal.aborted) return;
        revision.current = remote.revision;
        if (Date.parse(remote.project.updatedAt) > Date.parse(currentProject.current.updatedAt)) {
          dispatch({ type: 'hydrate', project: hydrateAssetUrls(remote.project, assets) });
          showNotice('已加载平台中的较新画布版本');
        }
      })
      .catch((error) => showNotice(error instanceof Error ? error.message : '平台同步读取失败'));
    return () => controller.abort();
  }, [assets, bridge, hydrated, showNotice, state.project.id]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const project = persistableProject(state.project);
      void writeLocalProject(project, bridge?.namespace ?? 'local');
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      if (bridge?.status === 'ready' && settingBoolean(bridge, 'canvas.autosave', true)) {
        void bridge
          .writeProject(project, revision.current, { signal: controller.signal })
          .then((document) => {
            if (document) revision.current = document.revision;
          })
          .catch(async (error) => {
            if (controller.signal.aborted) return;
            if (error instanceof Error && error.message.includes('MODULE_SERVICE_CONFLICT')) {
              const remote = await bridge
                .readProject(project.id, { signal: controller.signal })
                .catch(() => null);
              if (remote) {
                revision.current = remote.revision;
                dispatch({ type: 'hydrate', project: hydrateAssetUrls(remote.project, assets) });
                showNotice('检测到其他设备的更新，已加载平台版本以避免覆盖');
                return;
              }
            }
            showNotice(error instanceof Error ? error.message : '平台自动保存失败');
          });
      }
    }, 650);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [assets, bridge, hydrated, showNotice, state.project]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && key === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if (command && key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (command && key === 'a') {
        event.preventDefault();
        dispatch({
          type: 'select',
          ids: currentState.current.project.nodes.map((node) => node.id),
        });
      } else if (command && key === 'c') {
        event.preventDefault();
        clipboardIds.current = [...currentState.current.selectedIds];
      } else if (command && key === 'x') {
        event.preventDefault();
        clipboardIds.current = [...currentState.current.selectedIds];
        dispatch({ type: 'delete-selected' });
      } else if (command && key === 'v') {
        event.preventDefault();
        dispatch({ type: 'select', ids: clipboardIds.current });
        dispatch({ type: 'duplicate-selected' });
      } else if (command && key === 'd') {
        event.preventDefault();
        dispatch({ type: 'duplicate-selected' });
      } else if (command && key === 'g') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'ungroup-selected' : 'group-selected' });
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        dispatch({ type: 'delete-selected' });
      } else if (event.key === 'Escape') {
        dispatch({ type: 'select', ids: [] });
        dispatch({ type: 'start-connection', id: null });
        setImportOpen(false);
        setLeftOpen(false);
        setRightOpen(false);
        setAssistantOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const currentBridge = bridge;
    return () => currentBridge?.dispose();
  }, [bridge]);

  useEffect(
    () => () => {
      for (const controller of generationControllers.current.values()) controller.abort();
      generationControllers.current.clear();
      for (const url of assetUrls.current.values()) URL.revokeObjectURL(url);
      assetUrls.current.clear();
    },
    [],
  );

  const addAsset = useCallback(
    async (file: Blob, name: string): Promise<DisplayAsset> => {
      const record: LocalAsset = {
        id: `asset-${crypto.randomUUID()}`,
        name,
        mimeType: file.type,
        blob: file,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        source: '本地上传',
      };
      await writeLocalAsset(record, bridge?.namespace ?? 'local');
      const url = URL.createObjectURL(file);
      assetUrls.current.set(record.id, url);
      const display = { ...record, url, bytes: file.size };
      setAssets((current) => [display, ...current]);
      return display;
    },
    [bridge?.namespace],
  );

  const insertAsset = useCallback(
    (
      asset: DisplayAsset,
      targetId?: string,
      kindOverride?: NodeKind,
      position = { x: 160, y: 120 },
      dimensions?: { width: number; height: number },
    ) => {
      if (targetId) {
        dispatch({
          type: 'patch-node',
          id: targetId,
          patch: {
            assetId: asset.id,
            assetUrl: asset.url,
            assetName: asset.name,
            mimeType: asset.mimeType,
            bytes: asset.bytes,
            naturalWidth: dimensions?.width,
            naturalHeight: dimensions?.height,
            panoramaProjection:
              currentProject.current.nodes.find((node) => node.id === targetId)?.kind === 'panorama'
                ? 'equirectangular'
                : undefined,
            status: 'ready',
            error: undefined,
          },
        });
        return;
      }
      const kind = kindOverride ?? assetKind(asset.mimeType);
      dispatch({
        type: 'add',
        node: {
          ...createNode(kind, position.x, position.y),
          title: asset.name,
          assetId: asset.id,
          assetUrl: asset.url,
          assetName: asset.name,
          mimeType: asset.mimeType,
          bytes: asset.bytes,
          naturalWidth: dimensions?.width,
          naturalHeight: dimensions?.height,
          panoramaProjection: kind === 'panorama' ? 'equirectangular' : undefined,
          status: 'ready',
        },
      });
    },
    [],
  );

  const createImageVariant = useCallback(
    async (node: CanvasNode, operation: 'crop' | 'flip-x' | 'flip-y') => {
      if (!node.assetUrl || !node.mimeType?.startsWith('image/')) return;
      try {
        const response = await fetch(node.assetUrl);
        if (!response.ok) throw new Error('无法读取原始图片');
        const sourceBlob = await response.blob();
        if (sourceBlob.size > MAX_ASSET_BYTES) throw new Error('原始图片超过 100 MB');
        if (typeof createImageBitmap !== 'function') {
          throw new Error('当前浏览器不支持本地图片变换');
        }
        const bitmap = await createImageBitmap(sourceBlob);
        const crop = node.crop ?? { x: 0, y: 0, width: 100, height: 100 };
        const sourceX = Math.round((bitmap.width * crop.x) / 100);
        const sourceY = Math.round((bitmap.height * crop.y) / 100);
        const sourceWidth = Math.max(1, Math.round((bitmap.width * crop.width) / 100));
        const sourceHeight = Math.max(1, Math.round((bitmap.height * crop.height) / 100));
        const canvas = document.createElement('canvas');
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        const context = canvas.getContext('2d');
        if (!context) {
          bitmap.close();
          throw new Error('当前浏览器无法创建图片画布');
        }
        context.save();
        if (operation === 'flip-x') {
          context.translate(sourceWidth, 0);
          context.scale(-1, 1);
        } else if (operation === 'flip-y') {
          context.translate(0, sourceHeight);
          context.scale(1, -1);
        }
        context.drawImage(
          bitmap,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          sourceWidth,
          sourceHeight,
        );
        context.restore();
        bitmap.close();
        const output = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (result) => (result ? resolve(result) : reject(new Error('图片变换失败'))),
            'image/png',
            0.95,
          );
        });
        const asset = await addAsset(
          output,
          `${safeFileName(node.assetName ?? node.title)}-${operation}.png`,
        );
        const kind = operation === 'crop' && node.kind === 'panorama' ? 'image' : node.kind;
        dispatch({
          type: 'add',
          node: {
            ...createNode(kind, node.x + 48, node.y + 48),
            title: `${node.title} · ${operation === 'crop' ? '裁剪' : operation === 'flip-x' ? '水平翻转' : '垂直翻转'}`,
            assetId: asset.id,
            assetUrl: asset.url,
            assetName: asset.name,
            mimeType: asset.mimeType,
            bytes: asset.bytes,
            naturalWidth: sourceWidth,
            naturalHeight: sourceHeight,
            panoramaProjection: kind === 'panorama' ? 'equirectangular' : undefined,
            status: 'ready',
          },
        });
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '图片变换失败');
      }
    },
    [addAsset, showNotice],
  );

  const importAssetFile = useCallback(
    async (file: File, targetId?: string, position?: { x: number; y: number }) => {
      if (!ALLOWED_ASSET_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_ASSET_BYTES) {
        throw new Error('仅支持 100 MB 以内的常用图片、MP4/WebM 视频和 MP3/OGG/WAV 音频');
      }
      const target = targetId
        ? currentProject.current.nodes.find((node) => node.id === targetId)
        : undefined;
      const sourceKind = assetKind(file.type);
      if (
        target &&
        !((target.kind === 'panorama' && sourceKind === 'image') || target.kind === sourceKind)
      ) {
        throw new Error(`该文件不能替换${target.title}；请选择匹配的媒体类型`);
      }
      const dimensions = file.type.startsWith('image/') ? await imageDimensions(file) : undefined;
      if (target?.kind === 'panorama' && dimensions && !isStrictPanorama(dimensions)) {
        throw new Error('全景图必须是严格 2:1 比例');
      }
      const kindOverride =
        !target && dimensions && isStrictPanorama(dimensions) ? ('panorama' as const) : undefined;
      const asset = await addAsset(file, file.name);
      insertAsset(asset, targetId, kindOverride, position, dimensions);
      if (kindOverride === 'panorama') showNotice('检测到严格 2:1 图片，已作为全景图导入');
    },
    [addAsset, insertAsset, showNotice],
  );

  const createCanvasProject = useCallback(() => {
    const project = {
      ...createProject(),
      background: bridge ? settingBackground(bridge) : ('dots' as const),
    };
    revision.current = null;
    dispatch({ type: 'hydrate', project });
    setProjects((current) => [project, ...current]);
    setLeftOpen(false);
  }, [bridge]);

  const selectCanvasProject = useCallback(
    async (projectId: string) => {
      const local = await readLocalProject(projectId, bridge?.namespace ?? 'local');
      const remote =
        !local && bridge?.status === 'ready'
          ? await bridge.readProject(projectId).catch(() => null)
          : null;
      const project =
        local && isCanvasProject(local)
          ? local
          : (remote?.project ?? projects.find((item) => item.id === projectId));
      if (remote) revision.current = remote.revision;
      if (!project) return;
      revision.current = null;
      dispatch({ type: 'hydrate', project: hydrateAssetUrls(project, assets) });
      setLeftOpen(false);
    },
    [assets, bridge, projects],
  );

  const removeCanvasProject = useCallback(
    async (projectId: string) => {
      if (projects.length <= 1) {
        showNotice('至少保留一个画布');
        return;
      }
      try {
        if (bridge?.status === 'ready') {
          await bridge.deleteProject(projectId);
        }
        await deleteLocalProject(projectId, bridge?.namespace ?? 'local');
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '删除画布失败');
        return;
      }
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      if (state.project.id === projectId && remaining[0]) {
        revision.current = null;
        dispatch({ type: 'hydrate', project: hydrateAssetUrls(remaining[0], assets) });
      }
    },
    [assets, bridge, projects, showNotice, state.project.id],
  );

  const removeCanvasProjects = useCallback(
    async (projectIds: readonly string[]) => {
      const requested = [...new Set(projectIds)].filter((id) =>
        projects.some((project) => project.id === id),
      );
      if (!requested.length) return;
      const results = await Promise.allSettled(
        requested.map(async (projectId) => {
          if (bridge?.status === 'ready') await bridge.deleteProject(projectId);
          await deleteLocalProject(projectId, bridge?.namespace ?? 'local');
          return projectId;
        }),
      );
      const removed = new Set(
        results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
      );
      if (!removed.size) {
        showNotice('未能删除选中的画布');
        return;
      }
      let remaining = projects.filter((project) => !removed.has(project.id));
      if (!remaining.length) {
        remaining = [
          {
            ...createProject(),
            background: bridge ? settingBackground(bridge) : ('dots' as const),
          },
        ];
      }
      setProjects(remaining);
      if (removed.has(state.project.id)) {
        revision.current = null;
        dispatch({ type: 'hydrate', project: hydrateAssetUrls(remaining[0]!, assets) });
      }
      const failed = requested.length - removed.size;
      showNotice(
        failed
          ? `已删除 ${removed.size} 个画布，${failed} 个删除失败`
          : `已删除 ${removed.size} 个画布`,
      );
    },
    [assets, bridge, projects, showNotice, state.project.id],
  );

  const handleUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!file) return;
      try {
        await importAssetFile(file, uploadTarget.current);
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '本地素材存储不可用');
      } finally {
        uploadTarget.current = undefined;
      }
    },
    [importAssetFile, showNotice],
  );

  const cancelGeneration = useCallback((nodeId: string) => {
    generationControllers.current.get(nodeId)?.abort();
    dispatch({
      type: 'patch-node',
      id: nodeId,
      patch: { status: 'idle', error: undefined, progress: undefined },
      transient: true,
    });
  }, []);

  const onGenerate = useCallback(
    async (node: CanvasNode) => {
      generationControllers.current.get(node.id)?.abort();
      const controller = new AbortController();
      generationControllers.current.set(node.id, controller);
      const recordId = `generation-${crypto.randomUUID()}`;
      const timestamp = new Date().toISOString();
      dispatch({
        type: 'add-generation-record',
        record: {
          id: recordId,
          nodeId: node.id,
          kind: node.kind,
          prompt: node.prompt,
          status: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
      dispatch({
        type: 'patch-node',
        id: node.id,
        patch: { status: 'working', error: undefined },
        transient: true,
      });
      try {
        if (!bridge || bridge.status !== 'ready')
          throw new Error('请在 OpenOPC 平台中打开模块后使用生成能力');
        const composed = composeGenerationInput(currentProject.current, node);
        if (!composed.prompt.trim()) throw new Error('请输入提示词或连接包含内容的上游节点');
        if (composed.capabilityGap) throw new Error(composed.capabilityGap);
        if (composed.mode === 'text') {
          const content = await bridge.generateText(composed.prompt, { signal: controller.signal });
          dispatch({ type: 'patch-node', id: node.id, patch: { content, status: 'ready' } });
        } else if (composed.mode === 'image') {
          const referenceBlobs = (
            await Promise.all(
              composed.referenceAssetIds.map(async (assetId) => {
                const asset = await readLocalAsset(assetId, bridge.namespace);
                return asset && asset.mimeType.startsWith('image/')
                  ? { blob: asset.blob, filename: asset.name }
                  : null;
              }),
            )
          ).filter(
            (reference): reference is { blob: Blob; filename: string } => reference !== null,
          );
          const aspectRatio = ['1:1', '4:3', '3:4', '16:9', '9:16'].includes(composed.size ?? '')
            ? (composed.size as '1:1' | '4:3' | '3:4' | '16:9' | '9:16')
            : undefined;
          const generatedItems = await bridge.generateImage(
            composed.prompt,
            { signal: controller.signal },
            {
              negativePrompt: composed.negativePrompt,
              referenceBlobs,
              aspectRatio,
              quality: composed.quality === 'high' ? 'high' : undefined,
              outputCount: composed.outputCount,
              advanced: composed.advanced,
            },
          );
          const childIds: string[] = [];
          for (const [index, generated] of generatedItems.entries()) {
            const asset = generated.blob
              ? await addAsset(generated.blob, `generated-${Date.now()}-${index + 1}.png`)
              : null;
            const patch = asset
              ? {
                  assetId: asset.id,
                  platformAssetId: generated.assetId,
                  assetUrl: asset.url,
                  assetName: asset.name,
                  status: 'ready' as const,
                }
              : {
                  assetUrl: generated.url,
                  platformAssetId: generated.assetId,
                  assetName: '平台生成图片',
                  status: 'ready' as const,
                };
            if (index === 0) {
              dispatch({
                type: 'patch-node',
                id: node.id,
                patch: {
                  ...patch,
                  isBatchRoot: generatedItems.length > 1,
                  imageBatchExpanded: false,
                },
              });
            } else {
              const child = {
                ...createNode('image', node.x + index * 36, node.y + index * 36),
                title: `${node.title} ${index + 1}`,
                prompt: composed.prompt,
                batchRootId: node.id,
                ...patch,
              };
              childIds.push(child.id);
              dispatch({
                type: 'add',
                node: child,
              });
            }
          }
          if (childIds.length) {
            dispatch({
              type: 'patch-node',
              id: node.id,
              patch: { batchChildIds: childIds, primaryImageId: node.id },
            });
          }
        } else {
          throw new Error('平台 SDK 尚未公开视频或音频生成契约；已保留上传、播放和画布编排能力');
        }
        dispatch({
          type: 'patch-generation-record',
          id: recordId,
          patch: { status: 'succeeded', updatedAt: new Date().toISOString() },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          dispatch({
            type: 'patch-generation-record',
            id: recordId,
            patch: { status: 'cancelled', updatedAt: new Date().toISOString() },
          });
          return;
        }
        const message = error instanceof Error ? error.message : '生成失败';
        dispatch({ type: 'patch-node', id: node.id, patch: { status: 'error', error: message } });
        dispatch({
          type: 'patch-generation-record',
          id: recordId,
          patch: {
            status: /SDK 尚未公开|契约未提供|未公开/.test(message) ? 'unavailable' : 'failed',
            error: message,
            updatedAt: new Date().toISOString(),
          },
        });
        showNotice(message);
      } finally {
        if (generationControllers.current.get(node.id) === controller) {
          generationControllers.current.delete(node.id);
        }
      }
    },
    [addAsset, bridge, showNotice],
  );

  const generateAssistantImage = useCallback(
    async (
      prompt: string,
      signal: AbortSignal,
      references?: readonly AssistantReference[],
    ): Promise<AssistantImage[]> => {
      if (!bridge || bridge.status !== 'ready') {
        throw new Error('请在 OpenOPC 平台中打开模块后使用生图助手');
      }
      const referenceBlobs = await resolveReferenceBlobs(references, bridge.namespace, signal);
      const generatedItems = await bridge.generateImage(prompt, { signal }, { referenceBlobs });
      const images: AssistantImage[] = [];
      for (const [index, generated] of generatedItems.entries()) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const asset = generated.blob
          ? await addAsset(generated.blob, `assistant-${Date.now()}-${index + 1}.png`)
          : null;
        const image: AssistantImage = {
          id: `assistant-image-${crypto.randomUUID()}`,
          assetId: asset?.id,
          assetUrl: asset?.url ?? generated.url,
          prompt,
        };
        images.push(image);
        dispatch({
          type: 'add',
          node: {
            ...createNode('image', 180 + index * 44, 140 + index * 44),
            title: `Agent 图片 ${index + 1}`,
            prompt,
            assetId: asset?.id,
            assetUrl: image.assetUrl,
            assetName: asset?.name ?? '平台生成图片',
            status: 'ready',
          },
        });
      }
      return images;
    },
    [addAsset, bridge],
  );

  const executeAssistantActions = useCallback(
    async (actions: readonly AssistantAction[]): Promise<string[]> => {
      const messages: string[] = [];
      for (const action of actions) {
        const args = action.arguments;
        if (action.name === 'create_text_node') {
          const node = {
            ...createNode('text', 180 + messages.length * 32, 140 + messages.length * 32),
            title:
              typeof args.title === 'string' && args.title.trim()
                ? args.title.trim().slice(0, 80)
                : 'Agent 文本',
            content: typeof args.content === 'string' ? args.content : '',
            status: 'ready' as const,
          };
          dispatch({ type: 'add', node });
          messages.push(`已创建文本节点“${node.title}”。`);
          continue;
        }
        if (action.name === 'update_text_node') {
          const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
          const node = currentProject.current.nodes.find(
            (candidate) => candidate.id === nodeId && candidate.kind === 'text',
          );
          if (!node) {
            messages.push('跳过了不存在的文本节点。');
            continue;
          }
          dispatch({
            type: 'patch-node',
            id: node.id,
            patch: {
              ...(typeof args.title === 'string' && args.title.trim()
                ? { title: args.title.trim().slice(0, 80) }
                : {}),
              ...(typeof args.content === 'string' ? { content: args.content } : {}),
            },
          });
          messages.push(`已更新文本节点“${node.title}”。`);
          continue;
        }
        if (action.name === 'create_connection') {
          const source = typeof args.fromNodeId === 'string' ? args.fromNodeId : '';
          const target = typeof args.toNodeId === 'string' ? args.toNodeId : '';
          dispatch({ type: 'add-connection', source, target });
          messages.push('已尝试创建节点连线。');
          continue;
        }
        if (action.name === 'create_group') {
          const nodeIds = Array.isArray(args.nodeIds)
            ? args.nodeIds.filter((value): value is string => typeof value === 'string')
            : [];
          const validIds = nodeIds.filter((nodeId) =>
            currentProject.current.nodes.some((node) => node.id === nodeId),
          );
          if (validIds.length >= 2) {
            dispatch({ type: 'select', ids: validIds });
            dispatch({ type: 'group-selected' });
            messages.push(`已将 ${validIds.length} 个节点分组。`);
          }
          continue;
        }
        if (action.name === 'arrange_nodes') {
          const requested = Array.isArray(args.nodeIds)
            ? new Set(args.nodeIds.filter((value): value is string => typeof value === 'string'))
            : null;
          const candidates = currentProject.current.nodes.filter(
            (node) => !requested || requested.size === 0 || requested.has(node.id),
          );
          dispatch({
            type: 'patch-nodes',
            patches: candidates.map((node, index) => ({
              id: node.id,
              patch: { x: 80 + (index % 3) * 410, y: 100 + Math.floor(index / 3) * 380 },
            })),
          });
          messages.push(`已整理 ${candidates.length} 个节点。`);
          continue;
        }
        if (action.name === 'generate_image') {
          const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
          if (!prompt) continue;
          const node = {
            ...createNode('image', 180 + messages.length * 32, 140 + messages.length * 32),
            title:
              typeof args.title === 'string' && args.title.trim()
                ? args.title.trim().slice(0, 80)
                : 'Agent 生图',
            prompt,
          };
          dispatch({ type: 'add', node });
          await onGenerate(node);
          messages.push(`已执行图片节点“${node.title}”。`);
        }
      }
      return messages;
    },
    [onGenerate],
  );

  const handleDirectorCaptures = useCallback(
    async (director: CanvasNode, captures: readonly DirectorCapture[]) => {
      try {
        for (const [index, capture] of captures.entries()) {
          const response = await fetch(capture.dataUrl);
          const blob = await response.blob();
          if (!blob.type.startsWith('image/') || blob.size <= 0 || blob.size > MAX_ASSET_BYTES) {
            throw new Error('导演台截图格式或大小无效');
          }
          const asset = await addAsset(blob, capture.fileName);
          const node = {
            ...createNode('image', director.x + director.width + 72, director.y + index * 64),
            title: capture.fileName,
            assetId: asset.id,
            assetUrl: asset.url,
            assetName: asset.name,
            status: 'ready' as const,
          };
          dispatch({ type: 'add', node });
          dispatch({ type: 'add-connection', source: director.id, target: node.id });
        }
        showNotice(`已将 ${captures.length} 张导演台截图加入画布`);
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '无法导入导演台截图');
      }
    },
    [addAsset, showNotice],
  );

  const applyWorkflow = useCallback((workflow: WorkflowRecord) => {
    const variables = new Map(
      workflow.variables.map((variable) => [variable.key, variable.defaultValue]),
    );
    const resolvePrompt = (prompt: string) =>
      prompt.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, key: string) => variables.get(key) ?? key);
    const nodes = workflow.steps.map((step, index) => ({
      ...createNode(step.kind, 80 + (index % 3) * 410, 110 + Math.floor(index / 3) * 380),
      title: step.title,
      prompt: resolvePrompt(step.prompt),
      generationMode:
        step.kind === 'text' ||
        step.kind === 'image' ||
        step.kind === 'video' ||
        step.kind === 'audio'
          ? step.kind
          : undefined,
    }));
    for (const node of nodes) dispatch({ type: 'add', node });
    for (let index = 1; index < nodes.length; index += 1) {
      const source = nodes[index - 1];
      const target = nodes[index];
      if (source && target)
        dispatch({ type: 'add-connection', source: source.id, target: target.id });
    }
    dispatch({
      type: 'record-workflow-run',
      workflowId: workflow.id,
      nodeIds: nodes.map((node) => node.id),
    });
    setLeftOpen(false);
  }, []);

  const saveCurrentWorkflow = useCallback(() => {
    const now = new Date().toISOString();
    const workflow: WorkflowRecord = {
      id: `workflow-${crypto.randomUUID()}`,
      title: `${state.project.title} 模板`,
      description: `${state.project.nodes.length} 个节点的本地工作流`,
      variables: [],
      steps: state.project.nodes
        .filter((node) => node.kind !== 'group' && node.kind !== 'director')
        .slice(0, 100)
        .map((node) => ({
          id: `step-${crypto.randomUUID()}`,
          kind: node.kind,
          title: node.title,
          prompt: node.prompt || node.content,
        })),
      createdAt: now,
      updatedAt: now,
    };
    if (workflow.steps.length === 0) {
      showNotice('当前画布没有可保存的工作流节点');
      return;
    }
    setWorkflows((current) => [workflow, ...current]);
    void writeLocalWorkflow(workflow, bridge?.namespace ?? 'local');
    showNotice('已保存当前画布为工作流');
  }, [bridge?.namespace, showNotice, state.project.nodes, state.project.title]);

  const insertPrompt = useCallback(
    (prompt: string) => {
      const selected = state.selectedIds.length === 1 ? state.selectedIds[0] : undefined;
      if (selected) {
        dispatch({ type: 'patch-node', id: selected, patch: { prompt } });
      } else {
        dispatch({ type: 'add', node: { ...createNode('text', 160, 120), prompt } });
      }
      setLeftOpen(false);
    },
    [state.selectedIds],
  );

  const savePrompt = useCallback(
    (prompt: PromptRecord) => {
      setPrompts((current) => [prompt, ...current.filter((item) => item.id !== prompt.id)]);
      void writeLocalPrompt(prompt, bridge?.namespace ?? 'local');
      showNotice('提示词已保存');
    },
    [bridge?.namespace, showNotice],
  );

  const removePrompt = useCallback(
    (prompt: PromptRecord) => {
      setPrompts((current) => current.filter((item) => item.id !== prompt.id));
      void deleteLocalPrompt(prompt.id, bridge?.namespace ?? 'local');
    },
    [bridge?.namespace],
  );

  const updateAsset = useCallback(
    async (asset: DisplayAsset, patch: Partial<DisplayAsset>) => {
      setAssets((current) =>
        current.map((item) => (item.id === asset.id ? { ...item, ...patch } : item)),
      );
      const stored = await readLocalAsset(asset.id, bridge?.namespace ?? 'local');
      if (!stored) return;
      await writeLocalAsset(
        {
          ...stored,
          ...patch,
          id: stored.id,
          blob: stored.blob,
          updatedAt: new Date().toISOString(),
        },
        bridge?.namespace ?? 'local',
      );
    },
    [bridge?.namespace],
  );

  const removeWorkflow = useCallback(
    (workflow: WorkflowRecord) => {
      setWorkflows((current) => current.filter((item) => item.id !== workflow.id));
      void deleteLocalWorkflow(workflow.id, bridge?.namespace ?? 'local');
    },
    [bridge?.namespace],
  );

  const retryGeneration = useCallback(
    (record: GenerationRecord) => {
      const existing = currentProject.current.nodes.find((node) => node.id === record.nodeId);
      if (existing) {
        void onGenerate({ ...existing, prompt: record.prompt });
        return;
      }
      if (!['text', 'image', 'video', 'audio', 'panorama'].includes(record.kind)) {
        showNotice('该记录不支持直接重试');
        return;
      }
      const node = {
        ...createNode(record.kind, 180, 140),
        prompt: record.prompt,
      };
      dispatch({ type: 'add', node });
      void onGenerate(node);
    },
    [onGenerate, showNotice],
  );

  const handleImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!file) return;
      const zipInput = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
      const maxBytes = zipInput ? 500 * 1024 * 1024 : 10 * 1024 * 1024;
      if (file.size <= 0 || file.size > maxBytes) {
        showNotice(zipInput ? '画布压缩包不能超过 500 MB' : '画布 JSON 不能超过 10 MB');
        return;
      }
      try {
        if (zipInput) {
          const archive = await readCanvasZip(file);
          const assetIdByStorageKey = new Map<string, string>();
          const importedAssets: DisplayAsset[] = [];
          for (const entry of archive.data.projects) {
            for (const item of entry.files) {
              if (assetIdByStorageKey.has(item.storageKey)) continue;
              const blob = archive.files.get(item.path);
              if (!blob || !ALLOWED_ASSET_TYPES.has(blob.type) || blob.size > MAX_ASSET_BYTES) {
                throw new Error(`不支持压缩包中的媒体：${item.path}`);
              }
              const name = item.path.split('/').at(-1) ?? 'imported-media';
              const asset = await addAsset(blob, name);
              importedAssets.push(asset);
              assetIdByStorageKey.set(item.storageKey, asset.id);
            }
          }
          const imported = archive.data.projects.flatMap((entry) => {
            const project = migrateImportedProject(entry.project, { assetIdByStorageKey });
            return project ? [project] : [];
          });
          if (imported.length !== archive.data.projects.length || imported.length === 0) {
            throw new Error('画布压缩包中的项目结构无效');
          }
          await Promise.all(
            imported.map((project) =>
              writeLocalProject(persistableProject(project), bridge?.namespace ?? 'local'),
            ),
          );
          revision.current = null;
          setProjects((current) => [
            ...imported,
            ...current.filter((project) => !imported.some((item) => item.id === project.id)),
          ]);
          dispatch({
            type: 'replace-project',
            project: hydrateAssetUrls(imported[0] as CanvasProject, [...importedAssets, ...assets]),
          });
          setImportOpen(false);
          showNotice(`已导入 ${imported.length} 个画布及 ${importedAssets.length} 个媒体文件`);
          return;
        }

        const parsed = JSON.parse(await file.text()) as unknown;
        const bundle = importedProjectBundle(parsed);
        if (bundle) {
          const imported = bundle.map((project) => ({
            ...project,
            updatedAt: new Date().toISOString(),
          }));
          await Promise.all(
            imported.map((project) => writeLocalProject(project, bridge?.namespace ?? 'local')),
          );
          const active = imported[0];
          if (!active) throw new Error('画布包为空');
          revision.current = null;
          setProjects((current) => [
            ...imported,
            ...current.filter((project) => !imported.some((item) => item.id === project.id)),
          ]);
          dispatch({ type: 'replace-project', project: hydrateAssetUrls(active, assets) });
        } else {
          const next = migrateImportedProject(parsed, { projectId: state.project.id });
          if (!next) throw new Error('画布结构无效');
          dispatch({ type: 'replace-project', project: hydrateAssetUrls(next, assets) });
        }
        setImportOpen(false);
        showNotice(bundle ? `已导入 ${bundle.length} 个画布` : '画布已导入');
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '无法导入画布');
      }
    },
    [addAsset, assets, bridge?.namespace, showNotice, state.project.id],
  );

  const exportProjects = useCallback(
    async (projectIds?: readonly string[]) => {
      try {
        const localAssets = await Promise.all(
          assets.map((asset) => readLocalAsset(asset.id, bridge?.namespace ?? 'local')),
        );
        const transferAssets = new Map(
          localAssets
            .filter((asset): asset is LocalAsset => asset !== null)
            .map((asset) => [asset.id, asset]),
        );
        const selectedProjects = projectIds?.length
          ? projects.filter((project) => projectIds.includes(project.id))
          : projects;
        const archive = await encodeCanvasZip(
          selectedProjects.map(persistableProject),
          transferAssets,
        );
        download(`${safeFileName(state.project.title)}-projects.zip`, archive);
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '无法导出画布压缩包');
      }
    },
    [assets, bridge?.namespace, projects, showNotice, state.project.title],
  );

  const snapSize = Math.max(1, Math.min(64, settingNumber(bridge, 'canvas.snap_size', 8)));
  const compact = settingBoolean(bridge, 'workspace.compact_mode', false);
  const showMediaInfo = settingBoolean(bridge, 'workspace.show_image_info', false);
  const statusLabel = bridge?.status === 'ready' ? '平台已连接' : bridge ? '本地模式' : '正在连接';

  if (!hydrated) {
    return (
      <main className="app-loading">
        <div className="loading-mark" aria-hidden="true" />
        <strong>Infinite Canvas</strong>
        <span>正在加载本地画布</span>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label="打开资源面板"
            onClick={() => setLeftOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="brand-mark" aria-hidden="true">
            IC
          </div>
          <div>
            <strong>Infinite Canvas</strong>
            <input
              aria-label="画布名称"
              defaultValue={state.project.title}
              key={state.project.title}
              maxLength={120}
              onBlur={(event) => dispatch({ type: 'rename', title: event.currentTarget.value })}
            />
          </div>
        </div>

        <div className="header-actions" role="toolbar" aria-label="画布命令">
          <span
            className={`platform-status status-${bridge?.status ?? 'connecting'}`}
            title={bridge?.errorMessage ?? statusLabel}
          >
            {bridge?.status === 'ready' ? (
              <Cloud aria-hidden="true" />
            ) : (
              <CloudOff aria-hidden="true" />
            )}
            {statusLabel}
          </span>
          <button
            type="button"
            className="icon-button"
            title="撤销"
            aria-label="撤销"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <Undo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="重做"
            aria-label="重做"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
          >
            <Redo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button desktop-command"
            title="导入画布 JSON/ZIP"
            aria-label="导入画布 JSON/ZIP"
            onClick={() => importInput.current?.click()}
          >
            <Upload aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button desktop-command"
            title="导出 JSON"
            aria-label="导出 JSON"
            onClick={() =>
              download(
                `${safeFileName(state.project.title)}.json`,
                new Blob([JSON.stringify(persistableProject(state.project), null, 2)], {
                  type: 'application/json',
                }),
              )
            }
          >
            <Save aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button desktop-command"
            title="导出 PNG"
            aria-label="导出 PNG"
            onClick={() =>
              download(
                `${safeFileName(state.project.title)}.png`,
                renderProjectImage(state.project),
              )
            }
          >
            <Download aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button mobile-only"
            title="更多导入导出"
            aria-label="更多导入导出"
            onClick={() => setImportOpen((value) => !value)}
          >
            <FolderOpen aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="打开画布助手"
            aria-label="打开画布助手"
            onClick={() => setAssistantOpen(true)}
          >
            <Bot aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="打开检查器"
            aria-label="打开检查器"
            onClick={() => setRightOpen(true)}
          >
            <PanelRight aria-hidden="true" />
          </button>
        </div>
      </header>

      {importOpen ? (
        <div className="mobile-command-menu">
          <button type="button" onClick={() => importInput.current?.click()}>
            <Upload aria-hidden="true" />
            导入 JSON/ZIP
          </button>
          <button
            type="button"
            onClick={() =>
              download(
                `${safeFileName(state.project.title)}.json`,
                new Blob([JSON.stringify(persistableProject(state.project), null, 2)], {
                  type: 'application/json',
                }),
              )
            }
          >
            <Save aria-hidden="true" />
            导出 JSON
          </button>
          <button
            type="button"
            onClick={() =>
              download(
                `${safeFileName(state.project.title)}.png`,
                renderProjectImage(state.project),
              )
            }
          >
            <Download aria-hidden="true" />
            导出 PNG
          </button>
          <button type="button" aria-label="关闭命令菜单" onClick={() => setImportOpen(false)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="editor-layout">
        <Sidebar
          assets={assets}
          projects={projects}
          prompts={prompts}
          workflows={workflows}
          generationHistory={state.project.generationHistory}
          activeProjectId={state.project.id}
          open={leftOpen}
          onClose={() => setLeftOpen(false)}
          onUpload={() => {
            uploadTarget.current = undefined;
            uploadInput.current?.click();
          }}
          onInsertAsset={(asset) => insertAsset(asset)}
          onUpdateAsset={(asset, patch) => void updateAsset(asset, patch)}
          onDeleteAsset={(asset) => {
            void deleteLocalAsset(asset.id, bridge?.namespace ?? 'local');
            const url = assetUrls.current.get(asset.id);
            if (url) URL.revokeObjectURL(url);
            assetUrls.current.delete(asset.id);
            setAssets((current) => current.filter((candidate) => candidate.id !== asset.id));
          }}
          onApplyWorkflow={applyWorkflow}
          onSaveWorkflow={saveCurrentWorkflow}
          onDeleteWorkflow={removeWorkflow}
          onInsertPrompt={insertPrompt}
          onSavePrompt={savePrompt}
          onDeletePrompt={removePrompt}
          onCreateProject={createCanvasProject}
          onSelectProject={(projectId) => void selectCanvasProject(projectId)}
          onDeleteProject={(projectId) => void removeCanvasProject(projectId)}
          onDeleteProjects={(projectIds) => void removeCanvasProjects(projectIds)}
          onExportProjects={exportProjects}
          onRetryGeneration={retryGeneration}
        />
        <CanvasWorkspace
          state={state}
          dispatch={dispatch}
          snapSize={snapSize}
          compact={compact}
          onGenerate={(node) => void onGenerate(node)}
          onCancel={cancelGeneration}
          onUpload={(nodeId) => {
            uploadTarget.current = nodeId;
            uploadInput.current?.click();
          }}
          onDropFiles={(files, position) => {
            void (async () => {
              for (const [index, file] of files.slice(0, 20).entries()) {
                try {
                  await importAssetFile(file, undefined, {
                    x: position.x + index * 28,
                    y: position.y + index * 28,
                  });
                } catch (error) {
                  showNotice(error instanceof Error ? error.message : '无法导入拖入的文件');
                }
              }
            })();
          }}
          onNotice={showNotice}
          onDirectorCaptures={(node, captures) => void handleDirectorCaptures(node, captures)}
        />
        <Inspector
          state={state}
          dispatch={dispatch}
          open={rightOpen}
          showMediaInfo={showMediaInfo}
          onClose={() => setRightOpen(false)}
          onUpload={(nodeId) => {
            uploadTarget.current = nodeId;
            uploadInput.current?.click();
          }}
          onDownload={(node) => {
            if (node.assetUrl)
              downloadUrl(node.assetName ?? `${safeFileName(node.title)}.bin`, node.assetUrl);
          }}
          onCreateImageVariant={(node, operation) => void createImageVariant(node, operation)}
        />
      </div>

      <AssistantPanel
        open={assistantOpen}
        project={state.project}
        selectedIds={state.selectedIds}
        platformReady={bridge?.status === 'ready'}
        onClose={() => setAssistantOpen(false)}
        onUpsertSession={(session) => dispatch({ type: 'upsert-chat-session', session })}
        onDeleteSession={(id) => dispatch({ type: 'delete-chat-session', id })}
        onSetActiveSession={(id) => dispatch({ type: 'set-active-chat', id })}
        onGenerateText={async (prompt, signal, references) => {
          if (!bridge || bridge.status !== 'ready') {
            throw new Error('请在 OpenOPC 平台中打开模块后使用助手');
          }
          const referenceBlobs = await resolveReferenceBlobs(references, bridge.namespace, signal);
          return bridge.generateText(
            prompt,
            { signal },
            { referenceBlobs: referenceBlobs.map((reference) => reference.blob) },
          );
        }}
        onGenerateImage={generateAssistantImage}
        onPasteImage={async (file) => {
          if (!file.type.startsWith('image/') || file.size <= 0 || file.size > MAX_ASSET_BYTES) {
            throw new Error('粘贴图片必须是 100 MB 以内的图片');
          }
          const asset = await addAsset(file, file.name || `pasted-${Date.now()}.png`);
          insertAsset(asset);
          return {
            id: `assistant-reference-${crypto.randomUUID()}`,
            kind: 'image' as const,
            title: asset.name,
            assetId: asset.id,
            assetUrl: asset.url,
          };
        }}
        onExecuteActions={executeAssistantActions}
        onNotice={showNotice}
      />

      {leftOpen || rightOpen ? (
        <button
          type="button"
          className="mobile-scrim mobile-only"
          aria-label="关闭面板"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
        />
      ) : null}

      <input
        ref={uploadInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/mpeg,audio/ogg,audio/wav"
        onChange={(event) => void handleUpload(event)}
      />
      <input
        ref={importInput}
        type="file"
        hidden
        accept="application/json,.json,application/zip,.zip"
        onChange={(event) => void handleImport(event)}
      />
      {notice ? <output className="toast">{notice}</output> : null}
      <button
        type="button"
        className="mobile-settings-fab mobile-only"
        aria-label="打开画布检查器"
        onClick={() => setRightOpen(true)}
      >
        <Settings2 aria-hidden="true" />
      </button>
    </main>
  );
}
