import { useEffect, useRef, useState } from 'react';
import { Download, Film, LoaderCircle, Trash2, Upload } from 'lucide-react';
import type { OpenOpcImageEstimate, OpenOpcImageJob, OpenOpcImageModel } from '@openopc/developer-sdk';
import { buildGifPrompt } from '../lib/gif-prompt';
import { downloadBlob, encodeGifFromGrid } from '../lib/gif-encoder';
import { GenerationStatus } from '../components/generation-status';
import { useSessionState } from '../lib/session-state';
import {
  cancelImageJob,
  createGifTemplateFile,
  generateImage,
  isAbortError,
  openOpcErrorMessage,
} from '../lib/openopc-image-service';
import { selectImageModelWhenReady } from '../lib/text-workflows';

interface GifWorkspaceProps {
  models: OpenOpcImageModel[];
  modelsReady: boolean;
  onAssetsChanged: () => Promise<void>;
}

export function GifWorkspace({ models, modelsReady, onAssetsChanged }: GifWorkspaceProps) {
  const [prompt, setPrompt] = useSessionState(
    'image-studio.gif.prompt',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [model, setModel] = useSessionState(
    'image-studio.gif.model',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [references, setReferences] = useState<File[]>([]);
  const [closedLoop, setClosedLoop] = useSessionState(
    'image-studio.gif.closed-loop',
    true,
    (value): value is boolean => typeof value === 'boolean',
  );
  const [delay, setDelay] = useSessionState(
    'image-studio.gif.delay',
    160,
    (value): value is number => Number.isInteger(value) && Number(value) >= 80 && Number(value) <= 800,
  );
  const [framePadding, setFramePadding] = useSessionState(
    'image-studio.gif.frame-padding',
    1,
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5,
  );
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifBlob, setGifBlob] = useState<Blob | null>(null);
  const [estimate, setEstimate] = useState<OpenOpcImageEstimate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [job, setJob] = useState<OpenOpcImageJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const nextModel = selectImageModelWhenReady(models, model, modelsReady);
    if (nextModel !== model) setModel(nextModel);
  }, [model, models, modelsReady, setModel]);

  const selectedModel = models.find((item) => item.id === model);
  const maxReferences = selectedModel?.capabilities.max_reference_images ?? 0;
  const supportsReferences = selectedModel?.capabilities.reference_images === true && maxReferences > 0;
  const supportsGridRatio = selectedModel?.capabilities.aspect_ratios.includes('4:3') === true;
  const userReferenceLimit = supportsReferences ? Math.max(0, maxReferences - 1) : 0;

  useEffect(() => {
    if (references.length > userReferenceLimit) {
      setReferences((current) => current.slice(0, userReferenceLimit));
    }
  }, [references.length, userReferenceLimit]);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    if (gifUrl) URL.revokeObjectURL(gifUrl);
  }, [gifUrl]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !model || busy || !supportsGridRatio) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setEncoding(false);
    setError(null);
    setEstimate(null);
    setProgress(null);
    setJob(null);
    setGifUrl(null);
    setGifBlob(null);
    try {
      const template = supportsReferences ? await createGifTemplateFile() : null;
      const generated = await generateImage({
        model,
        prompt: buildGifPrompt({
          userPrompt: prompt,
          refImageCount: references.length,
          closedLoop,
          hasLayoutTemplate: Boolean(template),
        }),
        reference_asset_ids: [],
        referenceFiles: template ? [template, ...references] : [],
        aspect_ratio: '4:3',
        quality: 'standard',
        output_count: 1,
        onEstimate: setEstimate,
        onProgress: setProgress,
        onStatus: setJob,
        signal: controller.signal,
      });
      const first = generated[0];
      if (!first) throw new Error('图片任务没有返回动画图板');
      try {
        setEncoding(true);
        const gif = await encodeGifFromGrid(first.url, {
          frameDelayMs: delay,
          repeat: closedLoop ? 0 : -1,
          framePaddingPercent: framePadding,
        });
        setGifBlob(gif);
        setGifUrl(URL.createObjectURL(gif));
      } finally {
        setEncoding(false);
        generated.forEach((result) => URL.revokeObjectURL(result.url));
      }
      await onAssetsChanged();
    } catch (reason) {
      if (!isAbortError(reason)) setError(openOpcErrorMessage(reason, '动图生成失败'));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      if (job?.cancellable) setJob(await cancelImageJob(job.job_id));
    } catch (reason) {
      setError(openOpcErrorMessage(reason, '取消动图任务失败'));
    } finally {
      controllerRef.current?.abort();
      setCancelling(false);
    }
  };

  return (
    <section className="workspace-grid">
      <form className="control-panel" onSubmit={submit}>
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Animation</p>
            <h2>生成 12 帧动图</h2>
          </div>
          <Film size={19} />
        </div>

        <label className="field-label" htmlFor="gif-prompt">动作描述</label>
        <textarea
          id="gif-prompt"
          className="prompt-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：角色抬手、风吹动衣角…"
          maxLength={8000}
        />

        <label>
          <span className="field-label">模型</span>
          <select className="select-input" value={model} onChange={(event) => setModel(event.target.value)}>
            {models.length === 0 ? <option value="">暂无可用模型</option> : null}
            {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <p className="field-hint">
          {supportsGridRatio
            ? supportsReferences
              ? '使用 4×3 布局参考生成动画图板'
              : '当前模型将仅依据提示词生成图板'
            : '当前模型不支持 4:3 画幅'}
        </p>

        <label className="toggle-row">
          <input type="checkbox" checked={closedLoop} onChange={(event) => setClosedLoop(event.target.checked)} />
          <span>无缝循环</span>
        </label>

        <div className="field-row">
          <label className="field-label" htmlFor="gif-delay">帧间隔</label>
          <input
            id="gif-delay"
            className="range-input"
            type="range"
            min={80}
            max={800}
            step={10}
            value={delay}
            onChange={(event) => setDelay(Number(event.target.value))}
          />
          <span className="range-value">{delay}ms</span>
        </div>

        <div className="field-row">
          <label className="field-label" htmlFor="gif-padding">边缘裁切</label>
          <input
            id="gif-padding"
            className="range-input"
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={framePadding}
            onChange={(event) => setFramePadding(Number(event.target.value))}
          />
          <span className="range-value">{framePadding}%</span>
        </div>

        <label
          className={`upload-zone ${supportsReferences && userReferenceLimit > 0 ? '' : 'is-disabled'}`}
          htmlFor="gif-reference"
        >
          <Upload size={17} />
          <span>
            {!supportsReferences
              ? '当前模型不支持参考图'
              : userReferenceLimit === 0
                ? '仅使用布局模板'
                : references.length
                  ? `${references.length} / ${userReferenceLimit} 张角色参考图`
                  : '添加角色参考图（可选）'}
          </span>
          <input
            id="gif-reference"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            disabled={!supportsReferences || userReferenceLimit === 0}
            onChange={(event) => {
              setReferences(Array.from(event.target.files ?? []).slice(0, userReferenceLimit));
              event.currentTarget.value = '';
            }}
          />
        </label>

        {references.length > 0 ? (
          <div className="file-chips">
            {references.map((file) => (
              <span className="file-chip" key={`${file.name}-${file.lastModified}`}>
                {file.name}
                <button
                  type="button"
                  onClick={() => setReferences((current) => current.filter((item) => item !== file))}
                  aria-label={`移除 ${file.name}`}
                  title="移除"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <button
          className="button primary full-width"
          type="submit"
          disabled={busy || !prompt.trim() || !model || !supportsGridRatio}
        >
          {busy
            ? <><LoaderCircle size={16} className="spin" />处理中</>
            : <><Film size={16} />生成动图</>}
        </button>
        <GenerationStatus
          busy={busy}
          job={job}
          estimate={estimate}
          progress={progress}
          cancelling={cancelling}
          label={encoding ? '正在编码 GIF' : undefined}
          onCancel={encoding ? undefined : () => void cancel()}
        />
      </form>

      <section className="result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">GIF</p>
            <h2>预览</h2>
          </div>
          <Film size={19} />
        </div>
        {gifUrl && gifBlob ? (
          <div className="gif-preview">
            <img src={gifUrl} alt="动图结果" />
            <button
              className="button subtle"
              type="button"
              onClick={() => downloadBlob(gifBlob, 'animation.gif')}
            >
              <Download size={15} />下载 GIF
            </button>
          </div>
        ) : (
          <div className="empty-state">
            <Film size={30} />
            <p>动图预览会出现在这里</p>
            <span>生成一张 4×3 动画图板后自动编码</span>
          </div>
        )}
      </section>
    </section>
  );
}
