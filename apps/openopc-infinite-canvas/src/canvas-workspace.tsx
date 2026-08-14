import {
  Box,
  Boxes,
  CirclePlus,
  FileText,
  Globe2,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Map as MapIcon,
  Maximize2,
  Music2,
  Square,
  SlidersHorizontal,
  Sparkles,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type EditorAction, createNode } from './project-state';
import { PanoramaViewer } from './panorama-viewer';
import type { CanvasNode, CanvasProject, EditorState, NodeKind } from './types';

const NODE_ICONS = {
  text: FileText,
  image: ImageIcon,
  video: Video,
  audio: Music2,
  panorama: Globe2,
  director: Box,
  config: SlidersHorizontal,
  group: Boxes,
} satisfies Record<NodeKind, typeof FileText>;

const ADD_LABELS: Record<NodeKind, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  panorama: '全景',
  director: '3D 导演台',
  config: '配置',
  group: '分组',
};

interface WorkspaceProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  snapSize: number;
  compact: boolean;
  onGenerate(node: CanvasNode): void;
  onCancel(nodeId: string): void;
  onUpload(nodeId?: string): void;
  onDropFiles(files: readonly File[], position: { x: number; y: number }): void;
  onNotice(message: string): void;
  onDirectorCaptures(node: CanvasNode, captures: readonly DirectorCapture[]): void;
}

export interface DirectorCapture {
  dataUrl: string;
  fileName: string;
}

function connectionPath(source: CanvasNode, target: CanvasNode): string {
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const bend = Math.max(90, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function NodeMedia({ node }: { node: CanvasNode }) {
  if (!node.assetUrl) {
    const Icon = NODE_ICONS[node.kind];
    return (
      <output className="node-empty">
        <Icon aria-hidden="true" />
        <span>{node.kind === 'text' ? '输入内容或生成文本' : '上传素材或使用平台生成'}</span>
      </output>
    );
  }
  if (node.kind === 'video') {
    // biome-ignore lint/a11y/useMediaCaption: User-provided media may not include a captions track.
    return <video className="node-media" src={node.assetUrl} controls preload="metadata" />;
  }
  if (node.kind === 'audio') {
    // biome-ignore lint/a11y/useMediaCaption: User-provided media may not include a captions track.
    return <audio className="node-audio" src={node.assetUrl} controls preload="metadata" />;
  }
  if (node.kind === 'panorama') {
    return <PanoramaViewer src={node.assetUrl} alt={node.assetName || node.title} />;
  }
  const crop = node.crop;
  return (
    <img
      className="node-media"
      src={node.assetUrl}
      alt={node.assetName || node.title}
      style={
        crop
          ? {
              objectPosition: `${crop.x + crop.width / 2}% ${crop.y + crop.height / 2}%`,
              transform: `scale(${100 / Math.max(1, crop.width)}, ${100 / Math.max(1, crop.height)})`,
            }
          : undefined
      }
    />
  );
}

function DirectorFrame({
  node,
  project,
  dispatch,
  onCaptures,
  onNotice,
}: {
  node: CanvasNode;
  project: CanvasProject;
  dispatch: Dispatch<EditorAction>;
  onCaptures(node: CanvasNode, captures: readonly DirectorCapture[]): void;
  onNotice(message: string): void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const post = useCallback((type: string, payload: unknown) => {
    iframeRef.current?.contentWindow?.postMessage({ type, payload }, window.location.origin);
  }, []);
  const panoramas = useMemo(
    () =>
      project.connections.flatMap((connection) => {
        if (connection.target !== node.id) return [];
        const source = project.nodes.find(
          (candidate) => candidate.id === connection.source && candidate.kind === 'panorama',
        );
        if (!source?.assetUrl) return [];
        return [
          {
            edgeId: connection.id,
            sourceNodeId: source.id,
            imageUrl: source.assetUrl,
            fileName: source.assetName || source.title,
            projectionMode: 'equirectangular' as const,
          },
        ];
      }),
    [node.id, project.connections, project.nodes],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== iframeRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== 'object'
      ) {
        return;
      }
      const message = event.data as { type?: unknown; payload?: unknown };
      if (message.type === 'storyai:director-ready') {
        ready.current = true;
        post('storyai:director-session', {
          instanceId: node.id,
          theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
          project: node.directorProject ?? null,
        });
        post('storyai:director-panoramas', { panoramas });
        return;
      }
      if (message.type === 'storyai:director-close') {
        onNotice('导演台已请求关闭；节点仍保留在画布中');
        return;
      }
      if (message.type === 'storyai:director-project-changed') {
        const next = (message.payload as { project?: unknown } | null)?.project;
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          dispatch({
            type: 'patch-node',
            id: node.id,
            patch: { directorProject: next as Record<string, unknown> },
          });
        }
        return;
      }
      if (message.type === 'storyai:director-panorama-removed') {
        const edgeId = (message.payload as { edgeId?: unknown } | null)?.edgeId;
        if (typeof edgeId === 'string') dispatch({ type: 'remove-connection', id: edgeId });
        return;
      }
      if (message.type === 'storyai:director-captures-sent') {
        const raw = (message.payload as { captures?: unknown } | null)?.captures;
        if (!Array.isArray(raw)) return;
        const captures = raw.flatMap((value, index) => {
          if (!value || typeof value !== 'object') return [];
          const capture = value as { dataUrl?: unknown; fileName?: unknown };
          if (
            typeof capture.dataUrl !== 'string' ||
            !capture.dataUrl.startsWith('data:image/') ||
            capture.dataUrl.length > 45_000_000
          ) {
            return [];
          }
          return [
            {
              dataUrl: capture.dataUrl,
              fileName:
                typeof capture.fileName === 'string' && capture.fileName.trim()
                  ? capture.fileName.trim()
                  : `导演台截图-${index + 1}.png`,
            },
          ];
        });
        if (captures.length) onCaptures(node, captures);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [dispatch, node, onCaptures, onNotice, panoramas, post]);

  useEffect(() => {
    if (ready.current) post('storyai:director-panoramas', { panoramas });
  }, [panoramas, post]);

  return (
    <iframe
      ref={iframeRef}
      className="director-frame"
      src="./director/index.html"
      title="3D 导演台"
      sandbox="allow-scripts allow-downloads allow-same-origin allow-forms allow-modals allow-pointer-lock"
    />
  );
}

interface NodeCardProps {
  node: CanvasNode;
  selected: boolean;
  selectedIds: readonly string[];
  connectionSource: string | null;
  dispatch: Dispatch<EditorAction>;
  project: CanvasProject;
  snapSize: number;
  compact: boolean;
  onGenerate(node: CanvasNode): void;
  onCancel(nodeId: string): void;
  onUpload(nodeId?: string): void;
  onDirectorCaptures(node: CanvasNode, captures: readonly DirectorCapture[]): void;
  onNotice(message: string): void;
}

function NodeCard({
  node,
  selected,
  selectedIds,
  connectionSource,
  dispatch,
  project,
  snapSize,
  compact,
  onGenerate,
  onCancel,
  onUpload,
  onDirectorCaptures,
  onNotice,
}: NodeCardProps) {
  const Icon = NODE_ICONS[node.kind];
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    positions: Map<string, { x: number; y: number }>;
    previous: CanvasProject;
  } | null>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
    previous: CanvasProject;
  } | null>(null);
  const editBaseline = useRef<CanvasProject | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (node.locked) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const nextSelected = selected
      ? [...selectedIds]
      : additive
        ? [...selectedIds, node.id]
        : [node.id];
    dispatch({ type: 'select', ids: nextSelected });
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      positions: new Map(
        project.nodes
          .filter((candidate) => nextSelected.includes(candidate.id) && !candidate.locked)
          .map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]),
      ),
      previous: structuredClone(project),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - current.startX) / project.viewport.scale;
    const deltaY = (event.clientY - current.startY) / project.viewport.scale;
    dispatch({
      type: 'patch-nodes',
      patches: [...current.positions].map(([id, position]) => ({
        id,
        patch: {
          x: Math.round((position.x + deltaX) / snapSize) * snapSize,
          y: Math.round((position.y + deltaY) / snapSize) * snapSize,
        },
      })),
      transient: true,
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dispatch({ type: 'commit-transient', previous: current.previous });
  };

  const patchOnChange = (patch: Partial<CanvasNode>) => {
    editBaseline.current ??= structuredClone(project);
    dispatch({ type: 'patch-node', id: node.id, patch, transient: true });
  };

  const patchOnBlur = (patch: Partial<CanvasNode>) =>
    dispatch({ type: 'patch-node', id: node.id, patch });

  const commitEdit = (patch?: Partial<CanvasNode>) => {
    if (patch) dispatch({ type: 'patch-node', id: node.id, patch, transient: true });
    const previous = editBaseline.current;
    editBaseline.current = null;
    if (previous) dispatch({ type: 'commit-transient', previous });
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || node.locked) return;
    event.preventDefault();
    event.stopPropagation();
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: node.width,
      height: node.height,
      previous: structuredClone(project),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = resize.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const width = Math.max(
      220,
      Math.min(1400, current.width + (event.clientX - current.startX) / project.viewport.scale),
    );
    const height = Math.max(
      180,
      Math.min(1000, current.height + (event.clientY - current.startY) / project.viewport.scale),
    );
    dispatch({
      type: 'patch-node',
      id: node.id,
      patch: {
        width: Math.round(width / snapSize) * snapSize,
        height: Math.round(height / snapSize) * snapSize,
      },
      transient: true,
    });
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = resize.current;
    if (!current || current.pointerId !== event.pointerId) return;
    resize.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dispatch({ type: 'commit-transient', previous: current.previous });
  };

  return (
    <article
      className={`canvas-node node-${node.kind}${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`}
      style={{
        width: node.width,
        height: node.height,
        transform: `translate(${node.x}px, ${node.y}px) rotate(${node.rotation ?? 0}deg) scale(${node.scaleX ?? 1}, ${node.scaleY ?? 1})`,
      }}
      data-node-id={node.id}
      onPointerDown={(event) => {
        event.stopPropagation();
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        dispatch({
          type: 'select',
          ids: additive
            ? selected
              ? selectedIds.filter((id) => id !== node.id)
              : [...selectedIds, node.id]
            : [node.id],
        });
      }}
    >
      <div
        className="node-header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="node-kind-icon">
          <Icon aria-hidden="true" />
        </span>
        <input
          aria-label="节点标题"
          className="node-title"
          value={node.title}
          maxLength={80}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => patchOnChange({ title: event.currentTarget.value })}
          onBlur={(event) => commitEdit({ title: event.currentTarget.value.trim() || node.title })}
        />
        <span className={`node-status status-${node.status}`}>
          {node.status === 'working' ? <LoaderCircle className="spin" aria-label="处理中" /> : null}
          {node.status === 'error' ? '失败' : node.status === 'ready' ? '完成' : ''}
        </span>
      </div>

      <div className="node-content">
        {node.kind === 'director' ? (
          <DirectorFrame
            node={node}
            project={project}
            dispatch={dispatch}
            onCaptures={onDirectorCaptures}
            onNotice={onNotice}
          />
        ) : node.kind === 'text' ? (
          <textarea
            aria-label="文本内容"
            className="node-text-output"
            defaultValue={node.content}
            key={`content-${node.id}:${node.content}`}
            placeholder="文本生成结果"
            onBlur={(event) => patchOnBlur({ content: event.currentTarget.value })}
          />
        ) : node.kind === 'config' ? (
          <div className="config-preview">
            <label>
              生成类型
              <select
                value={node.generationMode ?? 'image'}
                aria-label="生成类型"
                onChange={(event) =>
                  patchOnBlur({
                    generationMode: event.currentTarget.value as CanvasNode['generationMode'],
                  })
                }
              >
                <option value="text">文本</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
                <option value="audio">音频</option>
              </select>
            </label>
            <p>读取所有直接上游文本和参考图；模型、额度和 provider 由平台管理。</p>
          </div>
        ) : node.kind === 'group' ? (
          <div className="group-preview">拖动分组框可整体编排关联节点</div>
        ) : (
          <NodeMedia node={node} />
        )}

        {node.kind !== 'director' && node.kind !== 'group' ? (
          <textarea
            aria-label={`${node.title}提示词`}
            className="node-prompt"
            defaultValue={node.prompt}
            key={`prompt-${node.id}:${node.prompt}`}
            placeholder="描述你想要的内容"
            onBlur={(event) => patchOnBlur({ prompt: event.currentTarget.value })}
          />
        ) : null}
        {node.error ? <p className="node-error">{node.error}</p> : null}
      </div>

      <div className="node-actions">
        {node.status === 'working' ? (
          <button
            type="button"
            className="button button-outline button-small"
            onClick={() => onCancel(node.id)}
          >
            <Square aria-hidden="true" />
            停止
          </button>
        ) : null}
        {node.kind !== 'director' && node.kind !== 'group' ? (
          <button
            type="button"
            className="button button-primary button-small"
            disabled={node.status === 'working' || node.prompt.trim().length === 0}
            onClick={() => onGenerate(node)}
          >
            <Sparkles aria-hidden="true" />
            生成
          </button>
        ) : null}
        {['image', 'video', 'audio', 'panorama'].includes(node.kind) ? (
          <button
            type="button"
            className="icon-button"
            title="上传素材"
            aria-label="上传素材"
            onClick={() => onUpload(node.id)}
          >
            <CirclePlus aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className={`connection-handle connection-input${connectionSource ? ' is-available' : ''}`}
        aria-label={`连接到${node.title}`}
        title="连接输入"
        onClick={(event) => {
          event.stopPropagation();
          dispatch({ type: 'finish-connection', id: node.id });
        }}
      >
        <Link2 aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`connection-handle connection-output${connectionSource === node.id ? ' is-active' : ''}`}
        aria-label={`从${node.title}创建连接`}
        title="创建连接"
        onClick={(event) => {
          event.stopPropagation();
          dispatch({ type: 'start-connection', id: connectionSource === node.id ? null : node.id });
        }}
      >
        <Link2 aria-hidden="true" />
      </button>
      {selected && !node.locked ? (
        <button
          type="button"
          className="node-resize-handle"
          aria-label={`调整${node.title}大小`}
          title="拖动调整节点大小"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ) : null}
    </article>
  );
}

export function CanvasWorkspace({
  state,
  dispatch,
  snapSize,
  compact,
  onGenerate,
  onCancel,
  onUpload,
  onDropFiles,
  onNotice,
  onDirectorCaptures,
}: WorkspaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [selectionRect, setSelectionRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const boxSelect = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const pan = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    viewportX: number;
    viewportY: number;
    previous: CanvasProject;
  } | null>(null);
  const nodes = useMemo(
    () => new Map(state.project.nodes.map((node) => [node.id, node])),
    [state.project.nodes],
  );
  const viewport = state.project.viewport;
  const minimapBounds = useMemo(() => {
    if (!state.project.nodes.length) return null;
    const minX = Math.min(...state.project.nodes.map((node) => node.x));
    const minY = Math.min(...state.project.nodes.map((node) => node.y));
    const maxX = Math.max(...state.project.nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...state.project.nodes.map((node) => node.y + node.height));
    return {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }, [state.project.nodes]);

  const addNode = (kind: NodeKind) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const centerX = ((rect?.width ?? 900) / 2 - viewport.x) / viewport.scale;
    const centerY = ((rect?.height ?? 600) / 2 - viewport.y) / viewport.scale;
    dispatch({ type: 'add', node: createNode(kind, centerX - 150, centerY - 120) });
  };

  const fit = () => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || state.project.nodes.length === 0) {
      dispatch({ type: 'set-viewport', viewport: { x: 0, y: 0, scale: 1 } });
      return;
    }
    const minX = Math.min(...state.project.nodes.map((node) => node.x));
    const minY = Math.min(...state.project.nodes.map((node) => node.y));
    const maxX = Math.max(...state.project.nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...state.project.nodes.map((node) => node.y + node.height));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min(
      1,
      Math.max(0.2, Math.min((rect.width - 120) / width, (rect.height - 120) / height)),
    );
    dispatch({
      type: 'set-viewport',
      viewport: {
        scale,
        x: rect.width / 2 - (minX + width / 2) * scale,
        y: rect.height / 2 - (minY + height / 2) * scale,
      },
    });
  };

  return (
    <section className="canvas-workspace" aria-label="无限画布编辑器">
      <div
        ref={surfaceRef}
        className={`canvas-surface background-${state.project.background}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          if (event.shiftKey || event.ctrlKey || event.metaKey) {
            const rect = event.currentTarget.getBoundingClientRect();
            boxSelect.current = {
              pointerId: event.pointerId,
              startX: event.clientX - rect.left,
              startY: event.clientY - rect.top,
            };
            setSelectionRect({
              left: boxSelect.current.startX,
              top: boxSelect.current.startY,
              width: 0,
              height: 0,
            });
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          dispatch({ type: 'select', ids: [] });
          pan.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            viewportX: viewport.x,
            viewportY: viewport.y,
            previous: structuredClone(state.project),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const selecting = boxSelect.current;
          if (selecting?.pointerId === event.pointerId) {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            setSelectionRect({
              left: Math.min(selecting.startX, x),
              top: Math.min(selecting.startY, y),
              width: Math.abs(x - selecting.startX),
              height: Math.abs(y - selecting.startY),
            });
            return;
          }
          const current = pan.current;
          if (!current || current.pointerId !== event.pointerId) return;
          dispatch({
            type: 'set-viewport',
            viewport: {
              ...viewport,
              x: current.viewportX + event.clientX - current.startX,
              y: current.viewportY + event.clientY - current.startY,
            },
            transient: true,
          });
        }}
        onPointerUp={(event) => {
          const selecting = boxSelect.current;
          if (selecting?.pointerId === event.pointerId) {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const left = (Math.min(selecting.startX, x) - viewport.x) / viewport.scale;
            const top = (Math.min(selecting.startY, y) - viewport.y) / viewport.scale;
            const right = (Math.max(selecting.startX, x) - viewport.x) / viewport.scale;
            const bottom = (Math.max(selecting.startY, y) - viewport.y) / viewport.scale;
            dispatch({
              type: 'select',
              ids: state.project.nodes
                .filter(
                  (node) =>
                    node.x < right &&
                    node.x + node.width > left &&
                    node.y < bottom &&
                    node.y + node.height > top,
                )
                .map((node) => node.id),
            });
            boxSelect.current = null;
            setSelectionRect(null);
            event.currentTarget.releasePointerCapture(event.pointerId);
            return;
          }
          const current = pan.current;
          if (!current || current.pointerId !== event.pointerId) return;
          pan.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          dispatch({ type: 'commit-transient', previous: current.previous });
        }}
        onPointerCancel={(event) => {
          if (boxSelect.current?.pointerId === event.pointerId) {
            boxSelect.current = null;
            setSelectionRect(null);
          }
          if (pan.current?.pointerId === event.pointerId) pan.current = null;
        }}
        onWheel={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const pointerX = event.clientX - rect.left;
          const pointerY = event.clientY - rect.top;
          const scale = Math.min(
            2.5,
            Math.max(0.15, viewport.scale * Math.exp(-event.deltaY * 0.0012)),
          );
          const worldX = (pointerX - viewport.x) / viewport.scale;
          const worldY = (pointerY - viewport.y) / viewport.scale;
          dispatch({
            type: 'set-viewport',
            viewport: {
              scale,
              x: pointerX - worldX * scale,
              y: pointerY - worldY * scale,
            },
            transient: true,
          });
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onDropFiles(Array.from(event.dataTransfer.files), {
            x: (event.clientX - rect.left - viewport.x) / viewport.scale,
            y: (event.clientY - rect.top - viewport.y) / viewport.scale,
          });
        }}
      >
        <div
          className="canvas-world"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          <svg className="connections-layer" aria-hidden="true">
            {state.project.connections.map((connection) => {
              const source = nodes.get(connection.source);
              const target = nodes.get(connection.target);
              return source && target ? (
                <path key={`connection-${connection.id}`} d={connectionPath(source, target)} />
              ) : null;
            })}
          </svg>
          {state.project.nodes.map((node) => (
            <NodeCard
              key={`node-${node.id}`}
              node={node}
              selected={state.selectedIds.includes(node.id)}
              selectedIds={state.selectedIds}
              connectionSource={state.connectionSource}
              dispatch={dispatch}
              project={state.project}
              snapSize={snapSize}
              compact={compact}
              onGenerate={onGenerate}
              onCancel={onCancel}
              onUpload={onUpload}
              onDirectorCaptures={onDirectorCaptures}
              onNotice={onNotice}
            />
          ))}
        </div>

        {selectionRect ? <div className="selection-rect" style={selectionRect} /> : null}

        {state.project.nodes.length === 0 ? (
          <div className="canvas-empty">
            <ImageIcon aria-hidden="true" />
            <strong>从一个创意节点开始</strong>
            <span>添加文本、图片、视频、音频、全景或 3D 场景。</span>
            <button
              type="button"
              className="button button-primary"
              onClick={() => addNode('image')}
            >
              <CirclePlus aria-hidden="true" />
              添加图片节点
            </button>
          </div>
        ) : null}
      </div>

      {minimapOpen && minimapBounds ? (
        <div
          className="canvas-minimap"
          aria-label="画布小地图"
          role="button"
          tabIndex={0}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const worldX =
              minimapBounds.minX +
              ((event.clientX - rect.left) / Math.max(1, rect.width)) * minimapBounds.width;
            const worldY =
              minimapBounds.minY +
              ((event.clientY - rect.top) / Math.max(1, rect.height)) * minimapBounds.height;
            const surface = surfaceRef.current?.getBoundingClientRect();
            if (!surface) return;
            dispatch({
              type: 'set-viewport',
              viewport: {
                ...viewport,
                x: surface.width / 2 - worldX * viewport.scale,
                y: surface.height / 2 - worldY * viewport.scale,
              },
            });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') fit();
          }}
        >
          {state.project.nodes.map((node) => {
            return (
              <span
                key={`minimap-${node.id}`}
                className={state.selectedIds.includes(node.id) ? 'is-selected' : ''}
                style={{
                  left: `${((node.x - minimapBounds.minX) / minimapBounds.width) * 100}%`,
                  top: `${((node.y - minimapBounds.minY) / minimapBounds.height) * 100}%`,
                  width: `${Math.max(3, (node.width / minimapBounds.width) * 100)}%`,
                  height: `${Math.max(3, (node.height / minimapBounds.height) * 100)}%`,
                }}
              />
            );
          })}
        </div>
      ) : null}

      <div className="canvas-add-toolbar" role="toolbar" aria-label="添加画布节点">
        {(Object.keys(ADD_LABELS) as NodeKind[]).map((kind) => {
          const Icon = NODE_ICONS[kind];
          return (
            <button
              key={kind}
              type="button"
              className="tool-button"
              title={`添加${ADD_LABELS[kind]}节点`}
              aria-label={`添加${ADD_LABELS[kind]}节点`}
              onClick={() => addNode(kind)}
            >
              <Icon aria-hidden="true" />
              <span>{ADD_LABELS[kind]}</span>
            </button>
          );
        })}
      </div>

      <div className="canvas-zoom-toolbar" role="toolbar" aria-label="画布缩放">
        <button
          type="button"
          className="icon-button"
          title="缩小"
          aria-label="缩小"
          onClick={() =>
            dispatch({
              type: 'set-viewport',
              viewport: { ...viewport, scale: Math.max(0.15, viewport.scale - 0.1) },
            })
          }
        >
          <ZoomOut aria-hidden="true" />
        </button>
        <button
          type="button"
          className="zoom-value"
          title="重置缩放"
          onClick={() => dispatch({ type: 'set-viewport', viewport: { ...viewport, scale: 1 } })}
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <button
          type="button"
          className="icon-button"
          title="放大"
          aria-label="放大"
          onClick={() =>
            dispatch({
              type: 'set-viewport',
              viewport: { ...viewport, scale: Math.min(2.5, viewport.scale + 0.1) },
            })
          }
        >
          <ZoomIn aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="适应全部"
          aria-label="适应全部"
          onClick={fit}
        >
          <Maximize2 aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          title={minimapOpen ? '隐藏小地图' : '显示小地图'}
          aria-label={minimapOpen ? '隐藏小地图' : '显示小地图'}
          aria-pressed={minimapOpen}
          onClick={() => setMinimapOpen((current) => !current)}
        >
          <MapIcon aria-hidden="true" />
        </button>
      </div>

      {state.connectionSource ? (
        <button
          type="button"
          className="connection-banner"
          onClick={() => dispatch({ type: 'start-connection', id: null })}
        >
          选择目标节点以完成连接，或点此取消
        </button>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {state.connectionSource ? '正在创建节点连接' : ''}
      </span>
    </section>
  );
}
