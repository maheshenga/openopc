import {
  Clock3,
  Download,
  FileText,
  FolderKanban,
  Image as ImageIcon,
  Layers3,
  Music2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  Video,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { LocalAsset } from './persistence';
import type { CanvasProject, GenerationRecord, PromptRecord, WorkflowRecord } from './types';

export interface DisplayAsset extends Omit<LocalAsset, 'blob'> {
  url: string;
  bytes: number;
}

interface SidebarProps {
  assets: readonly DisplayAsset[];
  projects: readonly CanvasProject[];
  prompts: readonly PromptRecord[];
  workflows: readonly WorkflowRecord[];
  generationHistory: readonly GenerationRecord[];
  activeProjectId: string;
  open: boolean;
  onClose(): void;
  onUpload(): void;
  onInsertAsset(asset: DisplayAsset): void;
  onUpdateAsset(asset: DisplayAsset, patch: Partial<DisplayAsset>): void;
  onDeleteAsset(asset: DisplayAsset): void;
  onApplyWorkflow(workflow: WorkflowRecord): void;
  onSaveWorkflow(): void;
  onDeleteWorkflow(workflow: WorkflowRecord): void;
  onInsertPrompt(prompt: string): void;
  onSavePrompt(prompt: PromptRecord): void;
  onDeletePrompt(prompt: PromptRecord): void;
  onCreateProject(): void;
  onSelectProject(projectId: string): void;
  onDeleteProject(projectId: string): void;
  onDeleteProjects(projectIds: readonly string[]): void;
  onExportProjects(projectIds?: readonly string[]): void;
  onRetryGeneration(record: GenerationRecord): void;
}

type SidebarTab = 'projects' | 'assets' | 'workflows' | 'prompts' | 'history';
type AssetFilter = 'all' | 'image' | 'video' | 'audio';

function assetIcon(mimeType: string) {
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music2;
  return ImageIcon;
}

function kindLabel(kind: GenerationRecord['kind']): string {
  return kind === 'text'
    ? '文本'
    : kind === 'image'
      ? '图片'
      : kind === 'video'
        ? '视频'
        : kind === 'audio'
          ? '音频'
          : kind === 'panorama'
            ? '全景'
            : kind;
}

export function Sidebar({
  assets,
  projects,
  prompts,
  workflows,
  generationHistory,
  activeProjectId,
  open,
  onClose,
  onUpload,
  onInsertAsset,
  onUpdateAsset,
  onDeleteAsset,
  onApplyWorkflow,
  onSaveWorkflow,
  onDeleteWorkflow,
  onInsertPrompt,
  onSavePrompt,
  onDeletePrompt,
  onCreateProject,
  onSelectProject,
  onDeleteProject,
  onDeleteProjects,
  onExportProjects,
  onRetryGeneration,
}: SidebarProps) {
  const [tab, setTab] = useState<SidebarTab>('projects');
  const [query, setQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<PromptRecord | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);

  const filteredAssets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const matchesFilter = assetFilter === 'all' || asset.mimeType.startsWith(`${assetFilter}/`);
      const matchesQuery =
        !needle ||
        [asset.name, asset.tags?.join(' '), asset.source, asset.note]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [assetFilter, assets, query]);

  const filteredPrompts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prompts.filter(
      (prompt) =>
        !needle ||
        [prompt.title, prompt.content, prompt.tags.join(' '), prompt.source]
          .join(' ')
          .toLowerCase()
          .includes(needle),
    );
  }, [prompts, query]);

  const closeAnd = (callback: () => void) => {
    callback();
    onClose();
  };

  return (
    <aside className={`side-panel left-panel${open ? ' is-open' : ''}`} aria-label="素材与工作流">
      <div className="panel-header">
        <div>
          <strong>创作资源</strong>
          <span>项目、素材、工作流、提示词与历史</span>
        </div>
        <button
          type="button"
          className="icon-button mobile-only"
          aria-label="关闭资源面板"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="segmented sidebar-tabs" role="tablist" aria-label="资源视图">
        {(
          [
            ['projects', '画布'],
            ['assets', '素材'],
            ['workflows', '工作流'],
            ['prompts', '提示词'],
            ['history', '历史'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            role="tab"
            key={value}
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setQuery('');
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="panel-scroll">
        {tab === 'projects' ? (
          <>
            <button
              type="button"
              className="button button-outline panel-command"
              onClick={onCreateProject}
            >
              <Plus aria-hidden="true" />
              新建画布
            </button>
            <button
              type="button"
              className="button button-outline panel-command"
              onClick={() => onExportProjects()}
            >
              <Download aria-hidden="true" />
              导出全部画布
            </button>
            {selectedProjectIds.length ? (
              <div className="project-bulk-actions">
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => onExportProjects(selectedProjectIds)}
                >
                  <Download aria-hidden="true" />
                  导出选中 ({selectedProjectIds.length})
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => {
                    if (window.confirm(`确定删除选中的 ${selectedProjectIds.length} 个画布吗？`)) {
                      onDeleteProjects(selectedProjectIds);
                      setSelectedProjectIds([]);
                    }
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  删除选中
                </button>
              </div>
            ) : null}
            <div className="project-list">
              {projects.map((project) => (
                <div
                  className={`project-item${project.id === activeProjectId ? ' is-active' : ''}`}
                  key={`project-${project.id}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`选择${project.title}`}
                    checked={selectedProjectIds.includes(project.id)}
                    onChange={() =>
                      setSelectedProjectIds((current) =>
                        current.includes(project.id)
                          ? current.filter((id) => id !== project.id)
                          : [...current, project.id],
                      )
                    }
                  />
                  <button type="button" onClick={() => onSelectProject(project.id)}>
                    <FolderKanban aria-hidden="true" />
                    <span>
                      <strong>{project.title}</strong>
                      <small>
                        {project.nodes.length} 个节点 · {project.chatSessions.length} 个会话 ·{' '}
                        {new Date(project.updatedAt).toLocaleDateString()}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="project-delete"
                    title="删除画布"
                    aria-label={`删除${project.title}`}
                    onClick={() => {
                      if (window.confirm(`确定删除画布“${project.title}”吗？`)) {
                        onDeleteProject(project.id);
                      }
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {tab === 'assets' ? (
          <>
            <div className="library-search">
              <Search aria-hidden="true" />
              <input
                aria-label="搜索本地素材"
                value={query}
                placeholder="搜索标题、标签或来源"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            <div className="segmented library-filter" role="group" aria-label="素材类型">
              {(
                [
                  ['all', '全部'],
                  ['image', '图片'],
                  ['video', '视频'],
                  ['audio', '音频'],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={assetFilter === value}
                  onClick={() => setAssetFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="button button-outline panel-command"
              onClick={onUpload}
            >
              <Upload aria-hidden="true" />
              上传图片、视频或音频
            </button>
            <p className="panel-note">
              素材保存在当前模块命名空间的浏览器存储中，平台不接触文件内容。
            </p>
            {filteredAssets.length === 0 ? (
              <div className="panel-empty">
                <Layers3 aria-hidden="true" />
                <strong>{assets.length ? '没有匹配素材' : '素材库为空'}</strong>
                <span>上传文件后可重复插入画布。</span>
              </div>
            ) : (
              <div className="asset-grid">
                {filteredAssets.map((asset) => {
                  const Icon = assetIcon(asset.mimeType);
                  const editing = editingAssetId === asset.id;
                  return (
                    <div className="asset-item" key={`asset-${asset.id}`}>
                      <button
                        type="button"
                        className="asset-insert"
                        aria-label={`插入${asset.name}`}
                        onClick={() => onInsertAsset(asset)}
                      >
                        {asset.mimeType.startsWith('image/') ? (
                          <img src={asset.url} alt="" />
                        ) : (
                          <Icon aria-hidden="true" />
                        )}
                        {editing ? (
                          <input
                            aria-label="素材标题"
                            className="asset-title-input"
                            autoFocus
                            defaultValue={asset.name}
                            onClick={(event) => event.stopPropagation()}
                            onBlur={(event) => {
                              onUpdateAsset(asset, {
                                name: event.currentTarget.value.trim() || asset.name,
                              });
                              setEditingAssetId(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                            }}
                          />
                        ) : (
                          <span>{asset.name}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="asset-edit"
                        title="重命名素材"
                        aria-label={`重命名${asset.name}`}
                        onClick={() => setEditingAssetId(asset.id)}
                      >
                        <FileText aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="asset-delete"
                        title="删除素材"
                        aria-label={`删除${asset.name}`}
                        onClick={() => onDeleteAsset(asset)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : null}

        {tab === 'workflows' ? (
          <>
            <button
              type="button"
              className="button button-outline panel-command"
              onClick={onSaveWorkflow}
            >
              <Plus aria-hidden="true" />
              保存当前画布为工作流
            </button>
            <p className="panel-note">工作流只保存节点类型、标题和提示词，不保存媒体 Blob。</p>
            <div className="resource-list">
              {workflows.map((workflow) => (
                <div className="resource-row" key={workflow.id}>
                  <button type="button" onClick={() => closeAnd(() => onApplyWorkflow(workflow))}>
                    <span className="resource-icon">
                      <WorkflowIcon aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{workflow.title}</strong>
                      <small>{workflow.description || `${workflow.steps.length} 个步骤`}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="resource-delete"
                    title="删除工作流"
                    aria-label={`删除${workflow.title}`}
                    onClick={() => onDeleteWorkflow(workflow)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {tab === 'prompts' ? (
          <>
            <div className="library-search">
              <Search aria-hidden="true" />
              <input
                aria-label="搜索提示词"
                value={query}
                placeholder="搜索标题、内容、标签"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            <button
              type="button"
              className="button button-outline panel-command"
              onClick={() =>
                setEditingPrompt({
                  id: `prompt-${crypto.randomUUID()}`,
                  title: '',
                  content: '',
                  tags: [],
                  source: '本地',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                })
              }
            >
              <Plus aria-hidden="true" />
              新增提示词
            </button>
            {editingPrompt ? (
              <form
                className="prompt-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!editingPrompt.title.trim() || !editingPrompt.content.trim()) return;
                  onSavePrompt({
                    ...editingPrompt,
                    title: editingPrompt.title.trim().slice(0, 120),
                    content: editingPrompt.content.trim().slice(0, 50_000),
                    updatedAt: new Date().toISOString(),
                  });
                  setEditingPrompt(null);
                }}
              >
                <input
                  aria-label="提示词标题"
                  placeholder="标题"
                  value={editingPrompt.title}
                  maxLength={120}
                  onChange={(event) =>
                    setEditingPrompt({ ...editingPrompt, title: event.currentTarget.value })
                  }
                />
                <textarea
                  aria-label="提示词内容"
                  placeholder="提示词内容"
                  value={editingPrompt.content}
                  maxLength={50_000}
                  onChange={(event) =>
                    setEditingPrompt({ ...editingPrompt, content: event.currentTarget.value })
                  }
                />
                <input
                  aria-label="提示词标签"
                  placeholder="标签，用逗号分隔"
                  value={editingPrompt.tags.join(', ')}
                  onChange={(event) =>
                    setEditingPrompt({
                      ...editingPrompt,
                      tags: event.currentTarget.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                        .slice(0, 20),
                    })
                  }
                />
                <div className="prompt-editor-actions">
                  <button type="submit" className="button button-primary button-small">
                    保存
                  </button>
                  <button
                    type="button"
                    className="button button-outline button-small"
                    onClick={() => setEditingPrompt(null)}
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : null}
            <div className="resource-list prompt-list">
              {filteredPrompts.map((prompt) => (
                <div className="resource-row" key={prompt.id}>
                  <button type="button" onClick={() => onInsertPrompt(prompt.content)}>
                    <span>
                      <strong>{prompt.title}</strong>
                      <small>{prompt.content}</small>
                      <em>{[prompt.source, ...prompt.tags].filter(Boolean).join(' · ')}</em>
                    </span>
                    <Plus aria-hidden="true" />
                  </button>
                  <div className="resource-row-actions">
                    <button
                      type="button"
                      title="编辑提示词"
                      aria-label={`编辑${prompt.title}`}
                      onClick={() => setEditingPrompt(prompt)}
                    >
                      <FileText aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title="删除提示词"
                      aria-label={`删除${prompt.title}`}
                      onClick={() => onDeletePrompt(prompt)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {tab === 'history' ? (
          <div className="history-list">
            {generationHistory.length === 0 ? (
              <div className="panel-empty">
                <Clock3 aria-hidden="true" />
                <strong>暂无生成记录</strong>
                <span>画布节点的生成、失败和能力降级会显示在这里。</span>
              </div>
            ) : (
              generationHistory.map((record) => (
                <article className="history-item" key={record.id}>
                  <div>
                    <strong>{kindLabel(record.kind)}</strong>
                    <small>{new Date(record.updatedAt).toLocaleString()}</small>
                  </div>
                  <p>{record.prompt || '无提示词'}</p>
                  <span className={`history-status status-${record.status}`}>{record.status}</span>
                  {record.error ? <small className="history-error">{record.error}</small> : null}
                  {record.status === 'failed' || record.status === 'unavailable' ? (
                    <button
                      type="button"
                      className="button button-outline button-small"
                      onClick={() => onRetryGeneration(record)}
                    >
                      <RotateCcw aria-hidden="true" />
                      重试
                    </button>
                  ) : null}
                </article>
              ))
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
