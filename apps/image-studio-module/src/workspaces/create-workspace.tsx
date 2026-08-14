import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ImagePlus,
  LoaderCircle,
  Sparkles,
  Square,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import type {
  OpenOpcImageEstimate,
  OpenOpcImageJob,
  OpenOpcImageModel,
  OpenOpcModel,
} from '@openopc/developer-sdk';
import { GenerationStatus } from '../components/generation-status';
import { ResultPanel, useGeneratedImageUrls } from '../components/generated-results';
import { parseOptionalSeed } from '../lib/image-input';
import { useSessionState } from '../lib/session-state';
import {
  cancelImageJob,
  copyImageBlob,
  generateImage,
  isAbortError,
  openOpcErrorMessage,
  retainedImageRetryKey,
  type GenerateImageInput,
  streamText,
  type GeneratedImage,
} from '../lib/openopc-image-service';
import { buildPromptOptimizationMessages, selectTextModel } from '../lib/text-workflows';

type Ratio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
type Quality = 'standard' | 'high';

const RATIOS: Ratio[] = ['1:1', '4:3', '3:4', '16:9', '9:16'];

type RetryableGenerateInput = Omit<
  GenerateImageInput,
  | 'idempotencyKey'
  | 'onIdempotencyKey'
  | 'onEstimate'
  | 'onProgress'
  | 'onStatus'
  | 'signal'
>;

interface ImageRetryRecord {
  input: RetryableGenerateInput;
  idempotencyKey?: string;
  reconcileWithRetainedKey: boolean;
}

function isRatio(value: unknown): value is Ratio {
  return typeof value === 'string' && RATIOS.includes(value as Ratio);
}

function isQuality(value: unknown): value is Quality {
  return value === 'standard' || value === 'high';
}

interface CreateWorkspaceProps {
  models: OpenOpcImageModel[];
  modelsReady: boolean;
  textModels: OpenOpcModel[];
  prompt: string;
  setPrompt: (prompt: string) => void;
  promptFocusVersion: number;
  referenceAssetIds: string[];
  setReferenceAssetIds: React.Dispatch<React.SetStateAction<string[]>>;
  onAssetsChanged: () => Promise<void>;
  onJobUpdated?: (job: OpenOpcImageJob) => void;
}

export function CreateWorkspace({
  models,
  modelsReady,
  textModels,
  prompt,
  setPrompt,
  promptFocusVersion,
  referenceAssetIds,
  setReferenceAssetIds,
  onAssetsChanged,
  onJobUpdated,
}: CreateWorkspaceProps) {
  const [negativePrompt, setNegativePrompt] = useSessionState(
    'image-studio.create.negative-prompt',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [model, setModel] = useSessionState(
    'image-studio.create.model',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [ratio, setRatio] = useSessionState<Ratio>('image-studio.create.ratio', '1:1', isRatio);
  const [quality, setQuality] = useSessionState<Quality>(
    'image-studio.create.quality',
    'standard',
    isQuality,
  );
  const [count, setCount] = useSessionState(
    'image-studio.create.count',
    1,
    (value): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8,
  );
  const [seed, setSeed] = useSessionState(
    'image-studio.create.seed',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [references, setReferences] = useState<File[]>([]);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [estimate, setEstimate] = useState<OpenOpcImageEstimate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [job, setJob] = useState<OpenOpcImageJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizedPrompt, setOptimizedPrompt] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const optimizationControllerRef = useRef<AbortController | null>(null);
  const latestRetryRef = useRef<ImageRetryRecord | null>(null);

  useGeneratedImageUrls(results);

  useEffect(() => {
    if (!modelsReady) return;
    const nextModel = models.some((item) => item.id === model) ? model : (models[0]?.id ?? '');
    if (nextModel !== model) setModel(nextModel);
  }, [model, models, modelsReady, setModel]);

  useEffect(() => {
    if (promptFocusVersion > 0) promptRef.current?.focus();
  }, [promptFocusVersion]);

  useEffect(
    () => () => {
      generationControllerRef.current?.abort();
      optimizationControllerRef.current?.abort();
    },
    [],
  );

  const selectedModel = models.find((item) => item.id === model);
  const maxReferences = selectedModel?.capabilities.reference_images.max_images ?? 8;
  const supportsReferences = maxReferences > 0;
  const supportsNegativePrompt =
    (selectedModel?.capabilities.prompt.max_negative_prompt_characters ?? 1) > 0;
  const supportsSeed = true;
  const availableRatios = selectedModel?.capabilities.output.aspect_ratios ?? RATIOS;
  const availableQualities = selectedModel?.capabilities.output.qualities ?? ['standard', 'high'];
  const maxOutputCount = Math.min(8, selectedModel?.capabilities.output.max_images ?? 8);
  const parsedSeed = parseOptionalSeed(seed);
  const referenceCount = referenceAssetIds.length + references.length;
  const remainingFileSlots = supportsReferences
    ? Math.max(0, maxReferences - referenceAssetIds.length)
    : 0;
  const hasUnsupportedReferences = referenceCount > 0 && !supportsReferences;
  const canGenerate = Boolean(
    model &&
      prompt.trim() &&
      !busy &&
      parsedSeed !== null &&
      !hasUnsupportedReferences &&
      referenceCount <= maxReferences,
  );

  useEffect(() => {
    if (!availableRatios.includes(ratio)) setRatio(availableRatios[0] ?? '1:1');
    if (!availableQualities.includes(quality)) setQuality(availableQualities[0] ?? 'standard');
    if (count > maxOutputCount) setCount(maxOutputCount);
  }, [
    availableQualities,
    availableRatios,
    count,
    maxOutputCount,
    quality,
    ratio,
    setCount,
    setQuality,
    setRatio,
  ]);

  useEffect(() => {
    if (!supportsReferences) return;
    if (referenceAssetIds.length > maxReferences) {
      setReferenceAssetIds((current) => current.slice(0, maxReferences));
      return;
    }
    const allowedFiles = Math.max(0, maxReferences - referenceAssetIds.length);
    if (references.length > allowedFiles) {
      setReferences((current) => current.slice(0, allowedFiles));
    }
  }, [
    maxReferences,
    referenceAssetIds.length,
    references.length,
    setReferenceAssetIds,
    supportsReferences,
  ]);

  const runGeneration = async (
    input: RetryableGenerateInput,
    idempotencyKey?: string,
    reconciliationAttempted = false,
  ) => {
    const controller = new AbortController();
    generationControllerRef.current?.abort();
    generationControllerRef.current = controller;
    let submittedKey = idempotencyKey;
    latestRetryRef.current = {
      input,
      idempotencyKey,
      reconcileWithRetainedKey: false,
    };
    setBusy(true);
    setRetryAvailable(false);
    setError(null);
    setEstimate(null);
    setProgress(null);
    setJob(null);
    setResults([]);
    try {
      const generated = await generateImage({
        ...input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        onIdempotencyKey: (key) => {
          submittedKey = key;
          latestRetryRef.current = {
            input,
            idempotencyKey: key,
            reconcileWithRetainedKey: false,
          };
        },
        onEstimate: setEstimate,
        onProgress: setProgress,
        onStatus: (nextJob) => {
          setJob(nextJob);
          onJobUpdated?.(nextJob);
        },
        signal: controller.signal,
      });
      setResults(generated);
      await onAssetsChanged();
    } catch (reason) {
      if (!isAbortError(reason)) {
        const retainedKey = retainedImageRetryKey(
          reason,
          submittedKey,
          reconciliationAttempted,
        );
        latestRetryRef.current = {
          input,
          idempotencyKey: retainedKey,
          reconcileWithRetainedKey: Boolean(retainedKey),
        };
        setRetryAvailable(true);
        setError(openOpcErrorMessage(reason, '生成失败'));
      }
    } finally {
      if (generationControllerRef.current === controller) generationControllerRef.current = null;
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canGenerate) return;
    const input: RetryableGenerateInput = {
      model,
      prompt: prompt.trim(),
      ...(supportsNegativePrompt && negativePrompt.trim()
        ? { negative_prompt: negativePrompt.trim() }
        : {}),
      reference_asset_ids: supportsReferences ? [...referenceAssetIds] : [],
      referenceFiles: supportsReferences ? [...references] : [],
      aspect_ratio: ratio,
      quality,
      output_count: count,
      ...(supportsSeed && parsedSeed !== undefined && parsedSeed !== null
        ? { seed: parsedSeed }
        : {}),
    };
    await runGeneration(input);
  };

  const retryLatest = async () => {
    const retry = latestRetryRef.current;
    if (!retry || busy) return;
    await runGeneration(
      retry.input,
      retry.reconcileWithRetainedKey ? retry.idempotencyKey : undefined,
      retry.reconcileWithRetainedKey,
    );
  };

  const copyResult = async (result: GeneratedImage) => {
    if (!(await copyImageBlob(result.blob))) throw new Error('Image clipboard unavailable.');
  };

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      if (job?.cancellable) {
        const cancelledJob = await cancelImageJob(job.job_id);
        setJob(cancelledJob);
        onJobUpdated?.(cancelledJob);
      }
    } catch (reason) {
      setError(openOpcErrorMessage(reason, '取消任务失败'));
    } finally {
      generationControllerRef.current?.abort();
      setCancelling(false);
    }
  };

  const optimizePrompt = async () => {
    const textModel = selectTextModel(textModels, '');
    if (!prompt.trim() || !textModel || optimizing) return;
    const controller = new AbortController();
    optimizationControllerRef.current?.abort();
    optimizationControllerRef.current = controller;
    setOptimizing(true);
    setOptimizedPrompt('');
    setError(null);
    let answer = '';
    try {
      await streamText(
        textModel,
        buildPromptOptimizationMessages(prompt),
        (delta) => {
          answer += delta;
          setOptimizedPrompt(answer);
        },
        { signal: controller.signal },
      );
      if (!answer.trim()) throw new Error('提示词优化没有返回内容');
    } catch (reason) {
      if (!isAbortError(reason)) setError(openOpcErrorMessage(reason, '提示词优化失败'));
    } finally {
      if (optimizationControllerRef.current === controller) optimizationControllerRef.current = null;
      setOptimizing(false);
    }
  };

  const stopOptimization = () => optimizationControllerRef.current?.abort();
  const acceptOptimization = () => {
    if (!optimizedPrompt?.trim()) return;
    setPrompt(optimizedPrompt.trim());
    setOptimizedPrompt(null);
    promptRef.current?.focus();
  };

  return (
    <section className="workspace-grid">
      <form className="control-panel" onSubmit={submit}>
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Create</p>
            <h2>把想法变成图像</h2>
          </div>
          <Sparkles size={19} />
        </div>

        <div className="field-row prompt-label-row">
          <label className="field-label" htmlFor="create-prompt">提示词</label>
          <button
            type="button"
            className="text-command"
            onClick={() => void optimizePrompt()}
            disabled={!prompt.trim() || textModels.length === 0 || optimizing}
          >
            {optimizing ? <LoaderCircle size={13} className="spin" /> : <WandSparkles size={13} />}
            优化
          </button>
        </div>
        <textarea
          ref={promptRef}
          id="create-prompt"
          className="prompt-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述主体、氛围、镜头和材质…"
          maxLength={8000}
        />

        {optimizedPrompt !== null ? (
          <div className="prompt-suggestion" aria-live="polite">
            <div className="suggestion-heading">
              <span>优化建议</span>
              <button
                type="button"
                className="icon-button compact-icon"
                onClick={() => {
                  stopOptimization();
                  setOptimizedPrompt(null);
                }}
                aria-label="关闭优化建议"
                title="关闭"
              >
                <X size={13} />
              </button>
            </div>
            <p>{optimizedPrompt || '正在整理提示词…'}</p>
            <div className="suggestion-actions">
              {optimizing ? (
                <button type="button" className="button subtle compact-button" onClick={stopOptimization}>
                  <Square size={12} />停止
                </button>
              ) : null}
              <button
                type="button"
                className="button primary compact-button"
                onClick={acceptOptimization}
                disabled={optimizing || !optimizedPrompt.trim()}
              >
                <Check size={13} />采用
              </button>
            </div>
          </div>
        ) : null}

        <div className="field-row">
          <span className="field-label">反向提示词</span>
          <span className="field-hint">{supportsNegativePrompt ? '可选' : '当前模型不支持'}</span>
        </div>
        <input
          className="text-input"
          value={negativePrompt}
          disabled={!supportsNegativePrompt}
          onChange={(event) => setNegativePrompt(event.target.value)}
          placeholder="不希望出现的内容"
          maxLength={4000}
        />

        <div className="field-grid">
          <label>
            <span className="field-label">模型</span>
            <select className="select-input" value={model} onChange={(event) => setModel(event.target.value)}>
              {models.length === 0 ? <option value="">暂无可用模型</option> : null}
              {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">质量</span>
            <select className="select-input" value={quality} onChange={(event) => setQuality(event.target.value as Quality)}>
              {availableQualities.map((value) => (
                <option key={value} value={value}>{value === 'high' ? '高质量' : '标准'}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-row ratio-row">
          <span className="field-label">画幅</span>
          <div className="segmented">
            {availableRatios.map((value) => (
              <button
                key={value}
                type="button"
                className={ratio === value ? 'segment is-active' : 'segment'}
                onClick={() => setRatio(value)}
                aria-pressed={ratio === value}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <label className="field-label" htmlFor="output-count">数量</label>
          <input
            id="output-count"
            className="range-input"
            type="range"
            min={1}
            max={maxOutputCount}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          />
          <span className="range-value">{count}</span>
        </div>

        {supportsSeed ? (
          <label>
            <span className="field-label">Seed <span className="field-hint">留空为随机</span></span>
            <input
              className="text-input"
              type="text"
              inputMode="numeric"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
              placeholder="随机"
              aria-invalid={parsedSeed === null}
            />
          </label>
        ) : null}

        <label
          className={`upload-zone ${supportsReferences && remainingFileSlots > 0 ? '' : 'is-disabled'}`}
          htmlFor="create-reference"
        >
          <Upload size={17} />
          <span>
            {!supportsReferences
              ? '当前模型不支持参考图'
              : referenceCount
                ? `${referenceCount} / ${maxReferences} 张参考图`
                : '添加参考图（可选）'}
          </span>
          <input
            id="create-reference"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            disabled={!supportsReferences || remainingFileSlots === 0}
            onChange={(event) => {
              setReferences(Array.from(event.target.files ?? []).slice(0, remainingFileSlots));
              event.currentTarget.value = '';
            }}
          />
        </label>

        {referenceAssetIds.length > 0 || references.length > 0 ? (
          <div className="file-chips" aria-label="参考图">
            {referenceAssetIds.map((assetId) => (
              <span className="file-chip" key={assetId}>
                <ImagePlus size={12} />素材 {assetId.slice(0, 8)}
                <button
                  type="button"
                  onClick={() => setReferenceAssetIds((current) => current.filter((id) => id !== assetId))}
                  aria-label={`移除素材 ${assetId.slice(0, 8)}`}
                  title="移除"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
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

        {parsedSeed === null ? <p className="inline-error">Seed 必须是非负整数</p> : null}
        {hasUnsupportedReferences ? <p className="inline-error">请选择支持参考图的模型，或移除已选参考图</p> : null}
        {referenceCount > maxReferences ? <p className="inline-error">参考图数量超过当前模型上限</p> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}

        <button className="button primary full-width" type="submit" disabled={!canGenerate}>
          {busy ? <><LoaderCircle size={16} className="spin" />生成中</> : <><Sparkles size={16} />开始生成</>}
        </button>
        <GenerationStatus
          busy={busy}
          job={job}
          estimate={estimate}
          progress={progress}
          cancelling={cancelling}
          onCancel={() => void cancel()}
        />
      </form>
      <ResultPanel
        results={results}
        emptyLabel="生成结果会出现在这里"
        onCopy={copyResult}
        onRetry={retryAvailable ? retryLatest : undefined}
        onUseAsReference={(assetId) => {
          setReferenceAssetIds((current) => [
            assetId,
            ...current.filter((id) => id !== assetId),
          ].slice(0, 8));
        }}
      />
    </section>
  );
}
