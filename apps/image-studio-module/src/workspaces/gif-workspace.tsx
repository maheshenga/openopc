import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Download,
  Film,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { OpenOpcImageEstimate, OpenOpcImageJob, OpenOpcImageModel } from '@openopc/developer-sdk';
import { buildGifPrompt } from '../lib/gif-prompt';
import {
  downloadBlob,
  encodeGifFrames,
  extractGridFrames,
  type EncodeGifOptions,
} from '../lib/gif-encoder';
import type { GifDraft, GifFrameSet, GifLoopCount } from '../lib/gif-workflow';
import { DEFAULT_GIF_DRAFT, gifRepeatValue, isGifDraft } from '../lib/gif-workflow';
import { GenerationStatus } from '../components/generation-status';
import { useSessionState } from '../lib/session-state';
import {
  cancelImageJob,
  createGifTemplateFile,
  downloadAsset,
  generateImage,
  isAbortError,
  openOpcErrorMessage,
} from '../lib/openopc-image-service';
import { selectImageModelWhenReady } from '../lib/text-workflows';

interface GifWorkspaceProps {
  models: OpenOpcImageModel[];
  modelsReady: boolean;
  onAssetsChanged: () => Promise<void>;
  onJobUpdated?: (job: OpenOpcImageJob) => void;
}

interface FrameCanvasProps {
  frame: Uint8ClampedArray;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}

function FrameCanvas({ frame, width, height, className, style }: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    canvas.width = width;
    canvas.height = height;
    const imageData = context.createImageData(width, height);
    imageData.data.set(frame);
    context.putImageData(imageData, 0, 0);
  }, [frame, height, width]);

  return <canvas ref={canvasRef} className={className} width={width} height={height} style={style} />;
}

const loopOptions: Array<{ value: GifLoopCount; label: string }> = [
  { value: 0, label: 'Infinite' },
  { value: 1, label: '1 loop' },
  { value: 2, label: '2 loops' },
  { value: 3, label: '3 loops' },
  { value: 5, label: '5 loops' },
];

function draftWithDefaults(draft: GifDraft): GifDraft {
  return {
    ...DEFAULT_GIF_DRAFT,
    prompt: draft.prompt,
    model: draft.model,
    sourceAssetId: draft.sourceAssetId,
  };
}

export function GifWorkspace({ models, modelsReady, onAssetsChanged, onJobUpdated }: GifWorkspaceProps) {
  const [draft, setDraft] = useSessionState<GifDraft>(
    'image-studio.gif.draft',
    { ...DEFAULT_GIF_DRAFT },
    isGifDraft,
  );
  const [references, setReferences] = useState<File[]>([]);
  const [gridUrl, setGridUrl] = useState<string | null>(null);
  const [frameSet, setFrameSet] = useState<GifFrameSet | null>(null);
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [restoreCandidate, setRestoreCandidate] = useState<GifDraft | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifBlob, setGifBlob] = useState<Blob | null>(null);
  const [estimate, setEstimate] = useState<OpenOpcImageEstimate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [job, setJob] = useState<OpenOpcImageJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const restoreControllerRef = useRef<AbortController | null>(null);
  const playbackCyclesRef = useRef(0);

  const { prompt, model, closedLoop, frameDelayMs, framePaddingPercent, loopCount } = draft;

  useEffect(() => {
    const nextModel = selectImageModelWhenReady(models, model, modelsReady);
    if (nextModel !== model) setDraft((current) => ({ ...current, model: nextModel }));
  }, [model, models, modelsReady, setDraft]);

  const selectedModel = models.find((item) => item.id === model);
  const maxReferences = selectedModel?.capabilities.reference_images.max_images ?? 0;
  const supportsReferences = maxReferences > 0;
  const supportsGridRatio = selectedModel?.capabilities.output.aspect_ratios.includes('4:3') === true;
  const userReferenceLimit = supportsReferences ? Math.max(0, maxReferences - 1) : 0;

  useEffect(() => {
    if (references.length > userReferenceLimit) {
      setReferences((current) => current.slice(0, userReferenceLimit));
    }
  }, [references.length, userReferenceLimit]);

  useEffect(() => {
    if (draft.sourceAssetId && !gifUrl && !gridUrl) setRestoreCandidate(draft);
  }, [draft, gifUrl, gridUrl]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    restoreControllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    if (gifUrl) URL.revokeObjectURL(gifUrl);
  }, [gifUrl]);

  useEffect(() => () => {
    if (gridUrl) URL.revokeObjectURL(gridUrl);
  }, [gridUrl]);

  useEffect(() => {
    if (!playing || encoding || !frameSet) return;
    const timer = window.setInterval(() => {
      setSelectedFrame((current) => {
        const next = (current + 1) % frameSet.frames.length;
        if (next === 0) {
          playbackCyclesRef.current += 1;
          const maxCycles = !closedLoop ? 1 : loopCount === 0 ? Number.POSITIVE_INFINITY : loopCount;
          if (playbackCyclesRef.current >= maxCycles) {
            setPlaying(false);
            return 0;
          }
        }
        return next;
      });
    }, frameDelayMs);
    return () => window.clearInterval(timer);
  }, [closedLoop, encoding, frameDelayMs, frameSet, loopCount, playing]);

  const replaceGifPreview = (nextBlob: Blob) => {
    const nextUrl = URL.createObjectURL(nextBlob);
    setGifBlob(nextBlob);
    setGifUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return nextUrl;
    });
  };

  const encodeFrameSet = async (nextFrameSet: GifFrameSet, nextDraft: GifDraft) => {
    setPlaying(false);
    setEncoding(true);
    try {
      const options: EncodeGifOptions = {
        frameDelayMs: nextDraft.frameDelayMs,
        repeat: gifRepeatValue(nextDraft.closedLoop, nextDraft.loopCount),
      };
      const nextBlob = encodeGifFrames(nextFrameSet, options);
      replaceGifPreview(nextBlob);
      setFrameSet(nextFrameSet);
      setSelectedFrame(0);
    } finally {
      setEncoding(false);
    }
  };

  const encodeGrid = async (sourceUrl: string, nextDraft: GifDraft) => {
    setPlaying(false);
    setEncoding(true);
    try {
      const nextFrameSet = await extractGridFrames(sourceUrl, nextDraft.framePaddingPercent);
      const options: EncodeGifOptions = {
        frameDelayMs: nextDraft.frameDelayMs,
        repeat: gifRepeatValue(nextDraft.closedLoop, nextDraft.loopCount),
      };
      const nextBlob = encodeGifFrames(nextFrameSet, options);
      replaceGifPreview(nextBlob);
      setFrameSet(nextFrameSet);
      setSelectedFrame(0);
    } finally {
      setEncoding(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !model || busy || restoring || !supportsGridRatio) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setRestoreError(null);
    setEstimate(null);
    setProgress(null);
    setJob(null);
    let generated: Awaited<ReturnType<typeof generateImage>> = [];
    let retainedGridUrl: string | null = null;
    try {
      const template = supportsReferences ? await createGifTemplateFile() : null;
      generated = await generateImage({
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
        onStatus: (nextJob) => {
          setJob(nextJob);
          onJobUpdated?.(nextJob);
        },
        signal: controller.signal,
      });
      const first = generated[0];
      if (!first) throw new Error('The image task returned no animation storyboard.');
      const nextDraft = { ...draft, sourceAssetId: first.assetId };
      await encodeGrid(first.url, nextDraft);
      setDraft(nextDraft);
      retainedGridUrl = first.url;
      setGridUrl(first.url);
      setRestoreCandidate(null);
      await onAssetsChanged();
    } catch (reason) {
      if (!isAbortError(reason)) setError(openOpcErrorMessage(reason, 'Animation generation failed'));
    } finally {
      generated.forEach((result) => {
        if (result.url !== retainedGridUrl) URL.revokeObjectURL(result.url);
      });
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!restoreCandidate || busy || restoring) return;
    const controller = new AbortController();
    restoreControllerRef.current?.abort();
    restoreControllerRef.current = controller;
    setRestoring(true);
    setRestoreError(null);
    setPlaying(false);
    let temporaryUrl: string | null = null;
    let retained = false;
    try {
      const blob = await downloadAsset(restoreCandidate.sourceAssetId as string, { signal: controller.signal });
      temporaryUrl = URL.createObjectURL(blob);
      await encodeGrid(temporaryUrl, draft);
      retained = true;
      setGridUrl(temporaryUrl);
      setRestoreCandidate(null);
      setSelectedFrame(0);
    } catch (reason) {
      if (!isAbortError(reason)) setRestoreError(openOpcErrorMessage(reason, 'Unable to restore the last GIF'));
    } finally {
      if (temporaryUrl && !retained) URL.revokeObjectURL(temporaryUrl);
      if (restoreControllerRef.current === controller) restoreControllerRef.current = null;
      setRestoring(false);
    }
  };

  const reencode = async (nextDraft = draft) => {
    if (encoding || busy || restoring) return;
    setError(null);
    try {
      if (gridUrl) await encodeGrid(gridUrl, nextDraft);
      else if (frameSet) await encodeFrameSet(frameSet, nextDraft);
    } catch (reason) {
      if (!isAbortError(reason)) setError(openOpcErrorMessage(reason, 'GIF encoding failed'));
    }
  };

  const reset = () => {
    const nextDraft = draftWithDefaults(draft);
    setDraft(nextDraft);
    void reencode(nextDraft);
  };

  const togglePlayback = () => {
    if (encoding || !frameSet) return;
    if (!playing) playbackCyclesRef.current = 0;
    setPlaying((current) => !current);
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
      setError(openOpcErrorMessage(reason, 'Unable to cancel the animation task'));
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
            <h2>Generate 12-frame GIF</h2>
          </div>
          <Film size={19} />
        </div>

        <label className="field-label" htmlFor="gif-prompt">Action description</label>
        <textarea
          id="gif-prompt"
          className="prompt-input"
          value={prompt}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
          placeholder="e.g. a character waves"
          maxLength={8000}
        />

        <label>
          <span className="field-label">Model</span>
          <select
            className="select-input"
            value={model}
            onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
          >
            {models.length === 0 ? <option value="">No models available</option> : null}
            {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <p className="field-hint">
          {supportsGridRatio
            ? supportsReferences
              ? 'Uses the 4:3 layout reference for a 12-frame storyboard.'
              : 'This model will use the prompt to create the storyboard.'
            : 'This model does not support the required 4:3 ratio.'}
        </p>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={closedLoop}
            onChange={(event) => setDraft((current) => ({ ...current, closedLoop: event.target.checked }))}
          />
          <span>Closed loop</span>
        </label>

        <label>
          <span className="field-label">Loop count</span>
          <select
            className="select-input"
            value={loopCount}
            onChange={(event) => {
              const value = event.target.value === '0' ? 0 : Number(event.target.value) as GifLoopCount;
              setDraft((current) => ({ ...current, loopCount: value }));
            }}
          >
            {loopOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>

        <div className="field-row">
          <label className="field-label" htmlFor="gif-delay">Frame delay</label>
          <input
            id="gif-delay"
            className="range-input"
            type="range"
            min={80}
            max={800}
            step={10}
            value={frameDelayMs}
            onChange={(event) => setDraft((current) => ({ ...current, frameDelayMs: Number(event.target.value) }))}
          />
          <span className="range-value">{frameDelayMs}ms</span>
        </div>

        <div className="field-row">
          <label className="field-label" htmlFor="gif-padding">Frame padding</label>
          <input
            id="gif-padding"
            className="range-input"
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={framePaddingPercent}
            onChange={(event) => setDraft((current) => ({ ...current, framePaddingPercent: Number(event.target.value) }))}
          />
          <span className="range-value">{framePaddingPercent}%</span>
        </div>

        <label
          className={`upload-zone ${supportsReferences && userReferenceLimit > 0 ? '' : 'is-disabled'}`}
          htmlFor="gif-reference"
        >
          <Upload size={17} />
          <span>
            {!supportsReferences
              ? 'This model does not support reference images.'
              : userReferenceLimit === 0
                ? 'Using the layout template only.'
                : references.length
                  ? `${references.length} / ${userReferenceLimit} reference images`
                  : 'Add optional reference images'}
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
                  aria-label={`Remove ${file.name}`}
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {restoreCandidate && !gifUrl ? (
          <div className="gif-restore">
            <span>Resume the last generated GIF?</span>
            <button className="button subtle" type="button" disabled={restoring} onClick={() => void restore()}>
              {restoring ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
              Restore
            </button>
            {restoreError ? <p className="inline-error" role="alert">{restoreError}</p> : null}
          </div>
        ) : null}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <button
          className="button primary full-width"
          type="submit"
          disabled={busy || restoring || !prompt.trim() || !model || !supportsGridRatio}
        >
          {busy
            ? <><LoaderCircle size={16} className="spin" />Processing</>
            : <><Film size={16} />Generate GIF</>}
        </button>
        <GenerationStatus
          busy={busy}
          job={job}
          estimate={estimate}
          progress={progress}
          cancelling={cancelling}
          label={encoding ? 'Encoding GIF' : undefined}
          onCancel={encoding ? undefined : () => void cancel()}
        />
      </form>

      <section className="result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">GIF review</p>
            <h2>Preview</h2>
          </div>
          <Film size={19} />
        </div>
        {gifUrl && gifBlob && frameSet ? (
          <div className="gif-review">
            <div className="gif-preview-stage">
              <img src={gifUrl} alt="Animated GIF result" className="gif-output-preview" />
              <div className="gif-selected-preview">
                <FrameCanvas
                  frame={frameSet.frames[selectedFrame] ?? frameSet.frames[0]}
                  width={frameSet.width}
                  height={frameSet.height}
                  className="gif-frame-focus"
                />
                <span>Frame {selectedFrame + 1} of {frameSet.frames.length}</span>
              </div>
            </div>
            <div className="gif-frame-grid" aria-label="GIF frames">
              {frameSet.frames.map((frame, index) => (
                <button
                  className={`gif-frame-button ${index === selectedFrame ? 'is-selected' : ''}`}
                  type="button"
                  key={index}
                  aria-label={`Select frame ${index + 1}`}
                  aria-pressed={index === selectedFrame}
                  onClick={() => {
                    setPlaying(false);
                    setSelectedFrame(index);
                  }}
                >
                  <FrameCanvas frame={frame} width={frameSet.width} height={frameSet.height} />
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>
            <div className="gif-review-controls">
              <button
                className="button subtle"
                type="button"
                disabled={encoding}
                onClick={togglePlayback}
                aria-label={playing ? 'Pause GIF playback' : 'Play GIF playback'}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause size={15} /> : <Play size={15} />}
                {playing ? 'Pause' : 'Play'}
              </button>
              <button className="button subtle" type="button" disabled={encoding} onClick={reset} title="Reset frame settings">
                <RotateCcw size={15} />Reset
              </button>
              <button
                className="button subtle"
                type="button"
                disabled={encoding || busy || restoring}
                onClick={() => void reencode()}
                title="Re-encode GIF"
              >
                <RefreshCw size={15} />Re-encode
              </button>
              <button className="button subtle" type="button" onClick={() => downloadBlob(gifBlob, 'animation.gif')} title="Download GIF">
                <Download size={15} />Download
              </button>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <Film size={30} />
            <p>GIF preview will appear here</p>
            <span>Generate a 4:3 storyboard to review its frames.</span>
          </div>
        )}
      </section>
    </section>
  );
}
