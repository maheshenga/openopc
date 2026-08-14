import {
  Boxes,
  Camera,
  Copy,
  Crop,
  Download,
  FileJson,
  Link2,
  Lock,
  RotateCw,
  Trash2,
  Unlock,
  Upload,
  X,
} from 'lucide-react';
import type { Dispatch } from 'react';

import type { EditorAction } from './project-state';
import type { CanvasNode, EditorState } from './types';

interface InspectorProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  open: boolean;
  showMediaInfo: boolean;
  onClose(): void;
  onUpload(nodeId: string): void;
  onDownload(node: CanvasNode): void;
  onCreateImageVariant(node: CanvasNode, operation: 'crop' | 'flip-x' | 'flip-y'): void;
}

function numberValue(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function Inspector({
  state,
  dispatch,
  open,
  showMediaInfo,
  onClose,
  onUpload,
  onDownload,
  onCreateImageVariant,
}: InspectorProps) {
  const selectedNodes = state.project.nodes.filter((node) => state.selectedIds.includes(node.id));
  const selected =
    state.selectedIds.length === 1
      ? (state.project.nodes.find((node) => node.id === state.selectedIds[0]) ?? null)
      : null;
  const patch = (node: CanvasNode, next: Partial<CanvasNode>) =>
    dispatch({ type: 'patch-node', id: node.id, patch: next });

  return (
    <aside className={`side-panel right-panel${open ? ' is-open' : ''}`} aria-label="画布检查器">
      <div className="panel-header">
        <div>
          <strong>{selected ? '节点检查器' : '画布设置'}</strong>
          <span>{selected ? selected.title : '背景与选择'}</span>
        </div>
        <button
          type="button"
          className="icon-button mobile-only"
          aria-label="关闭检查器"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="panel-scroll inspector-fields">
        {selected ? (
          <>
            <label>
              标题
              <input
                type="text"
                defaultValue={selected.title}
                key={`title-${selected.id}:${selected.title}`}
                maxLength={80}
                onBlur={(event) =>
                  patch(selected, { title: event.currentTarget.value.trim() || selected.title })
                }
              />
            </label>
            <div className="field-grid">
              <label>
                X
                <input
                  type="number"
                  defaultValue={Math.round(selected.x)}
                  key={`x-${selected.id}:${selected.x}`}
                  onBlur={(event) =>
                    patch(selected, {
                      x: numberValue(event.currentTarget.value, selected.x, -100_000, 100_000),
                    })
                  }
                />
              </label>
              <label>
                Y
                <input
                  type="number"
                  defaultValue={Math.round(selected.y)}
                  key={`y-${selected.id}:${selected.y}`}
                  onBlur={(event) =>
                    patch(selected, {
                      y: numberValue(event.currentTarget.value, selected.y, -100_000, 100_000),
                    })
                  }
                />
              </label>
              <label>
                宽度
                <input
                  type="number"
                  min="220"
                  max="1200"
                  defaultValue={Math.round(selected.width)}
                  key={`width-${selected.id}:${selected.width}`}
                  onBlur={(event) =>
                    patch(selected, {
                      width: numberValue(event.currentTarget.value, selected.width, 220, 1200),
                    })
                  }
                />
              </label>
              <label>
                高度
                <input
                  type="number"
                  min="180"
                  max="900"
                  defaultValue={Math.round(selected.height)}
                  key={`height-${selected.id}:${selected.height}`}
                  onBlur={(event) =>
                    patch(selected, {
                      height: numberValue(event.currentTarget.value, selected.height, 180, 900),
                    })
                  }
                />
              </label>
              <label>
                旋转
                <input
                  type="number"
                  min="-180"
                  max="180"
                  defaultValue={selected.rotation ?? 0}
                  key={`rotation-${selected.id}:${selected.rotation}`}
                  onBlur={(event) =>
                    patch(selected, {
                      rotation: numberValue(
                        event.currentTarget.value,
                        selected.rotation ?? 0,
                        -180,
                        180,
                      ),
                    })
                  }
                />
              </label>
              <label>
                缩放
                <input
                  type="number"
                  min="0.25"
                  max="4"
                  step="0.05"
                  defaultValue={selected.scaleX ?? 1}
                  key={`scale-${selected.id}:${selected.scaleX}`}
                  onBlur={(event) => {
                    const scale = numberValue(
                      event.currentTarget.value,
                      selected.scaleX ?? 1,
                      0.25,
                      4,
                    );
                    patch(selected, { scaleX: scale, scaleY: scale });
                  }}
                />
              </label>
            </div>
            <div className="segmented inspector-segmented">
              <button
                type="button"
                aria-pressed={(selected.scaleX ?? 1) < 0}
                onClick={() => patch(selected, { scaleX: -(selected.scaleX || 1) })}
              >
                水平翻转
              </button>
              <button
                type="button"
                aria-pressed={(selected.scaleY ?? 1) < 0}
                onClick={() => patch(selected, { scaleY: -(selected.scaleY || 1) })}
              >
                垂直翻转
              </button>
            </div>
            {['image', 'video', 'audio', 'panorama', 'config'].includes(selected.kind) ? (
              <fieldset>
                <legend>生成参数</legend>
                {selected.kind === 'config' ? (
                  <label>
                    生成类型
                    <select
                      value={selected.generationMode ?? 'image'}
                      onChange={(event) =>
                        patch(selected, {
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
                ) : null}
                <div className="field-grid">
                  {selected.kind !== 'text' && selected.kind !== 'audio' ? (
                    <label>
                      尺寸/比例
                      <input
                        type="text"
                        value={selected.size ?? (selected.kind === 'panorama' ? '2048x1024' : '')}
                        placeholder="继承后台设置"
                        maxLength={64}
                        onChange={(event) => patch(selected, { size: event.currentTarget.value })}
                      />
                    </label>
                  ) : null}
                  {selected.kind === 'image' ||
                  selected.kind === 'panorama' ||
                  selected.kind === 'config' ? (
                    <label>
                      质量
                      <select
                        value={selected.quality ?? 'standard'}
                        onChange={(event) =>
                          patch(selected, { quality: event.currentTarget.value })
                        }
                      >
                        <option value="standard">标准</option>
                        <option value="high">高质量</option>
                      </select>
                    </label>
                  ) : null}
                  <label>
                    生成数量
                    <input
                      type="number"
                      min="1"
                      max="15"
                      value={selected.count ?? 1}
                      onChange={(event) =>
                        patch(selected, {
                          count: numberValue(event.currentTarget.value, selected.count ?? 1, 1, 15),
                        })
                      }
                    />
                  </label>
                  {selected.kind === 'video' ? (
                    <label>
                      时长（秒）
                      <input
                        type="number"
                        min="4"
                        max="30"
                        value={selected.seconds ?? 5}
                        onChange={(event) =>
                          patch(selected, {
                            seconds: numberValue(
                              event.currentTarget.value,
                              selected.seconds ?? 5,
                              4,
                              30,
                            ),
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {selected.kind === 'audio' ? (
                    <>
                      <label>
                        声音
                        <input
                          type="text"
                          value={selected.audioVoice ?? 'alloy'}
                          maxLength={80}
                          onChange={(event) =>
                            patch(selected, { audioVoice: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        格式
                        <select
                          value={selected.audioFormat ?? 'mp3'}
                          onChange={(event) =>
                            patch(selected, { audioFormat: event.currentTarget.value })
                          }
                        >
                          <option value="mp3">MP3</option>
                          <option value="wav">WAV</option>
                          <option value="ogg">OGG</option>
                        </select>
                      </label>
                    </>
                  ) : null}
                </div>
                {selected.kind === 'video' ? (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={selected.generateAudio ?? true}
                      onChange={(event) =>
                        patch(selected, { generateAudio: event.currentTarget.checked })
                      }
                    />
                    同时生成声音
                  </label>
                ) : null}
                <p className="panel-note">
                  模型和 provider 由 OpenOPC 后台选择；节点仅保存非敏感参数。
                </p>
              </fieldset>
            ) : null}
            {selected.kind === 'image' ||
            selected.kind === 'video' ||
            selected.kind === 'config' ? (
              <fieldset>
                <legend>
                  <Camera aria-hidden="true" /> 摄像机
                </legend>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={selected.cameraControl?.enabled ?? false}
                    onChange={(event) =>
                      patch(selected, {
                        cameraControl: {
                          enabled: event.currentTarget.checked,
                          camera: selected.cameraControl?.camera ?? 'cinema',
                          lens: selected.cameraControl?.lens ?? 'standard',
                          focalLength: selected.cameraControl?.focalLength ?? 50,
                          aperture: selected.cameraControl?.aperture ?? 2.8,
                        },
                      })
                    }
                  />
                  启用摄像机提示词
                </label>
                {selected.cameraControl?.enabled ? (
                  <div className="field-grid">
                    <label>
                      相机
                      <select
                        value={selected.cameraControl.camera}
                        onChange={(event) =>
                          patch(selected, {
                            cameraControl: {
                              ...selected.cameraControl!,
                              camera: event.currentTarget.value,
                            },
                          })
                        }
                      >
                        <option value="cinema">电影机</option>
                        <option value="dslr">单反</option>
                        <option value="phone">手机</option>
                        <option value="drone">无人机</option>
                      </select>
                    </label>
                    <label>
                      镜头
                      <select
                        value={selected.cameraControl.lens}
                        onChange={(event) =>
                          patch(selected, {
                            cameraControl: {
                              ...selected.cameraControl!,
                              lens: event.currentTarget.value,
                            },
                          })
                        }
                      >
                        <option value="wide">广角</option>
                        <option value="standard">标准</option>
                        <option value="telephoto">长焦</option>
                        <option value="macro">微距</option>
                      </select>
                    </label>
                    <label>
                      焦距
                      <input
                        type="number"
                        min="8"
                        max="600"
                        value={selected.cameraControl.focalLength}
                        onChange={(event) =>
                          patch(selected, {
                            cameraControl: {
                              ...selected.cameraControl!,
                              focalLength: numberValue(event.currentTarget.value, 50, 8, 600),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      光圈
                      <input
                        type="number"
                        min="0.7"
                        max="32"
                        step="0.1"
                        value={selected.cameraControl.aperture}
                        onChange={(event) =>
                          patch(selected, {
                            cameraControl: {
                              ...selected.cameraControl!,
                              aperture: numberValue(event.currentTarget.value, 2.8, 0.7, 32),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </fieldset>
            ) : null}
            {selected.kind === 'image' || selected.kind === 'panorama' ? (
              <fieldset>
                <legend>
                  <Crop aria-hidden="true" /> 裁剪百分比
                </legend>
                <div className="field-grid crop-grid">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <label key={field}>
                      {field.toUpperCase()}
                      <input
                        type="number"
                        min="0"
                        max="100"
                        defaultValue={
                          selected.crop?.[field] ??
                          (field === 'width' || field === 'height' ? 100 : 0)
                        }
                        onBlur={(event) => {
                          const crop = {
                            x: selected.crop?.x ?? 0,
                            y: selected.crop?.y ?? 0,
                            width: selected.crop?.width ?? 100,
                            height: selected.crop?.height ?? 100,
                            [field]: numberValue(
                              event.currentTarget.value,
                              selected.crop?.[field] ??
                                (field === 'width' || field === 'height' ? 100 : 0),
                              0,
                              100,
                            ),
                          };
                          crop.width = Math.max(1, Math.min(crop.width, 100 - crop.x));
                          crop.height = Math.max(1, Math.min(crop.height, 100 - crop.y));
                          patch(selected, { crop });
                        }}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <div className="inspector-section">
              <span>连接</span>
              <p>
                <Link2 aria-hidden="true" />
                {
                  state.project.connections.filter(
                    (connection) =>
                      connection.source === selected.id || connection.target === selected.id,
                  ).length
                }{' '}
                条
              </p>
            </div>
            {selected.assetUrl && showMediaInfo ? (
              <div className="inspector-section">
                <span>媒体信息</span>
                <p>{selected.mimeType ?? '未知类型'}</p>
                {selected.naturalWidth && selected.naturalHeight ? (
                  <p>
                    {selected.naturalWidth} × {selected.naturalHeight}
                  </p>
                ) : null}
                {selected.bytes ? <p>{(selected.bytes / 1024 / 1024).toFixed(2)} MB</p> : null}
              </div>
            ) : null}
            <details className="node-json">
              <summary>
                <FileJson aria-hidden="true" /> 查看节点 JSON
              </summary>
              <pre>
                {JSON.stringify(
                  { ...selected, assetUrl: selected.assetUrl ? '[local asset URL]' : undefined },
                  null,
                  2,
                )}
              </pre>
            </details>
            <div className="inspector-actions">
              {['image', 'video', 'audio', 'panorama'].includes(selected.kind) ? (
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => onUpload(selected.id)}
                >
                  <Upload aria-hidden="true" />
                  替换
                </button>
              ) : null}
              {selected.assetUrl ? (
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => onDownload(selected)}
                >
                  <Download aria-hidden="true" />
                  下载
                </button>
              ) : null}
              {selected.assetUrl && (selected.kind === 'image' || selected.kind === 'panorama') ? (
                <>
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => onCreateImageVariant(selected, 'crop')}
                  >
                    <Crop aria-hidden="true" />
                    生成裁剪节点
                  </button>
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => onCreateImageVariant(selected, 'flip-x')}
                  >
                    水平翻转
                  </button>
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => onCreateImageVariant(selected, 'flip-y')}
                  >
                    垂直翻转
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="button button-outline"
                onClick={() => patch(selected, { rotation: ((selected.rotation ?? 0) + 90) % 360 })}
              >
                <RotateCw aria-hidden="true" />
                旋转
              </button>
              <button
                type="button"
                className="button button-outline"
                onClick={() => patch(selected, { locked: !selected.locked })}
              >
                {selected.locked ? <Unlock aria-hidden="true" /> : <Lock aria-hidden="true" />}
                {selected.locked ? '解锁' : '锁定'}
              </button>
              <button
                type="button"
                className="button button-outline"
                onClick={() => dispatch({ type: 'duplicate-selected' })}
              >
                <Copy aria-hidden="true" />
                复制
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => dispatch({ type: 'delete-selected' })}
              >
                <Trash2 aria-hidden="true" />
                删除
              </button>
            </div>
          </>
        ) : selectedNodes.length > 1 ? (
          <>
            <div className="inspector-section">
              <span>多选</span>
              <p>{selectedNodes.length} 个节点</p>
            </div>
            <button
              type="button"
              className="button button-outline"
              onClick={() => dispatch({ type: 'duplicate-selected' })}
            >
              <Copy aria-hidden="true" />
              复制所选
            </button>
            <button
              type="button"
              className="button button-outline"
              onClick={() => dispatch({ type: 'group-selected' })}
            >
              <Boxes aria-hidden="true" />
              创建分组
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => dispatch({ type: 'delete-selected' })}
            >
              <Trash2 aria-hidden="true" />
              删除所选
            </button>
          </>
        ) : (
          <>
            <fieldset>
              <legend>画布背景</legend>
              <div className="segmented vertical-mobile">
                {(['dots', 'lines', 'plain'] as const).map((background) => (
                  <button
                    type="button"
                    key={background}
                    aria-pressed={state.project.background === background}
                    onClick={() => dispatch({ type: 'set-background', background })}
                  >
                    {background === 'dots' ? '点阵' : background === 'lines' ? '网格' : '纯色'}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="inspector-section">
              <span>画布统计</span>
              <p>{state.project.nodes.length} 个节点</p>
              <p>{state.project.connections.length} 条连接</p>
            </div>
            <p className="panel-note">选择节点后可编辑位置、尺寸和连接信息。</p>
          </>
        )}
      </div>
    </aside>
  );
}
