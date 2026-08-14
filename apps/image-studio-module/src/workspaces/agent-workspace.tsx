import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  MessageSquareText,
  Send,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  OpenOpcImageEstimate,
  OpenOpcImageJob,
  OpenOpcImageModel,
  OpenOpcModel,
} from '@openopc/developer-sdk';
import { GenerationStatus } from '../components/generation-status';
import { ResultGrid, useGeneratedImageUrls } from '../components/generated-results';
import {
  cancelImageJob,
  copyImageBlob,
  fileAsDataUrl,
  generateImage,
  isAbortError,
  openOpcErrorMessage,
  retainedImageRetryKey,
  streamText,
  type GenerateImageInput,
  type GeneratedImage,
} from '../lib/openopc-image-service';
import {
  buildAgentMessages,
  selectImageModelWhenReady,
  selectTextModel,
  type StudioConversationMessage,
} from '../lib/text-workflows';
import { useSessionState } from '../lib/session-state';

interface AgentWorkspaceProps {
  imageModels: OpenOpcImageModel[];
  textModels: OpenOpcModel[];
  modelsReady: boolean;
  onAssetsChanged: () => Promise<void>;
  onJobUpdated?: (job: OpenOpcImageJob) => void;
  onUsePrompt: (prompt: string) => void;
  onUseAsReference: (assetId: string) => void;
}

const MAX_AGENT_VISION_REFERENCES = 4;

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

function isConversation(value: unknown): value is StudioConversationMessage[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (message) =>
        Boolean(message) &&
        typeof message === 'object' &&
        ((message as StudioConversationMessage).role === 'user' ||
          (message as StudioConversationMessage).role === 'assistant') &&
        typeof (message as StudioConversationMessage).content === 'string',
    )
  );
}

export function AgentWorkspace({
  imageModels,
  textModels,
  modelsReady,
  onAssetsChanged,
  onJobUpdated,
  onUsePrompt,
  onUseAsReference,
}: AgentWorkspaceProps) {
  const [messages, setMessages] = useSessionState<StudioConversationMessage[]>(
    'image-studio.agent.messages',
    [],
    isConversation,
  );
  const [input, setInput] = useSessionState('image-studio.agent.draft', '', (value): value is string => typeof value === 'string');
  const [textModel, setTextModel] = useSessionState(
    'image-studio.agent.text-model',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [imageModel, setImageModel] = useSessionState(
    'image-studio.agent.image-model',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [references, setReferences] = useState<File[]>([]);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [generationEstimate, setGenerationEstimate] = useState<OpenOpcImageEstimate | null>(null);
  const [generationProgress, setGenerationProgress] = useState<number | null>(null);
  const [generationJob, setGenerationJob] = useState<OpenOpcImageJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [cancellingGeneration, setCancellingGeneration] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatControllerRef = useRef<AbortController | null>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const latestRetryRef = useRef<ImageRetryRecord | null>(null);

  useGeneratedImageUrls(results);

  useEffect(() => {
    if (!modelsReady) return;
    const nextModel = selectTextModel(textModels, textModel);
    if (nextModel !== textModel) setTextModel(nextModel);
  }, [modelsReady, setTextModel, textModel, textModels]);

  useEffect(() => {
    const nextModel = selectImageModelWhenReady(imageModels, imageModel, modelsReady);
    if (nextModel !== imageModel) setImageModel(nextModel);
  }, [imageModel, imageModels, modelsReady, setImageModel]);

  useEffect(
    () => () => {
      chatControllerRef.current?.abort();
      generationControllerRef.current?.abort();
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: The DOM scroll must run after each conversation update.
  useEffect(() => {
    const chatLog = chatLogRef.current;
    if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
  }, [messages.length]);

  const selectedTextModel = textModels.find((item) => item.id === textModel);
  const selectedImageModel = imageModels.find((item) => item.id === imageModel);
  const maxReferences = selectedImageModel?.capabilities.reference_images.max_images ?? 0;
  const supportsReferences = maxReferences > 0;
  const supportsVision = selectedTextModel?.attachment === true;
  const referenceLimit = supportsReferences
    ? Math.min(maxReferences, 8)
    : supportsVision
      ? MAX_AGENT_VISION_REFERENCES
      : 0;
  const canUploadReferences = referenceLimit > 0;

  useEffect(() => {
    if (references.length > referenceLimit) {
      setReferences((current) => current.slice(0, referenceLimit));
    }
  }, [referenceLimit, references.length]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || !textModel) return;

    const controller = new AbortController();
    chatControllerRef.current?.abort();
    chatControllerRef.current = controller;
    const next = [...messages, { role: 'user' as const, content: text }];
    setInput('');
    setError(null);
    setMessages(next);
    setBusy(true);
    let answer = '';
    try {
      const referenceDataUrls = supportsVision
        ? await Promise.all(references.map((file) => fileAsDataUrl(file)))
        : [];
      setMessages([...next, { role: 'assistant', content: '' }]);
      await streamText(
        textModel,
        buildAgentMessages(next, referenceDataUrls),
        (delta) => {
          answer += delta;
          setMessages([...next, { role: 'assistant', content: answer }]);
        },
        { signal: controller.signal },
      );
      if (!answer.trim()) throw new Error('Agent 没有返回内容');
    } catch (reason) {
      if (isAbortError(reason)) {
        if (!answer) setMessages(next);
      } else {
        setError(openOpcErrorMessage(reason, 'Agent 请求失败'));
      }
    } finally {
      if (chatControllerRef.current === controller) chatControllerRef.current = null;
      setBusy(false);
    }
  };

  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')
    ?.content.trim() ?? '';

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
    setGenerating(true);
    setRetryAvailable(false);
    setGenerationEstimate(null);
    setGenerationProgress(null);
    setGenerationJob(null);
    setError(null);
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
        onEstimate: setGenerationEstimate,
        onProgress: setGenerationProgress,
        onStatus: (nextJob) => {
          setGenerationJob(nextJob);
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
        setError(openOpcErrorMessage(reason, 'Agent 生图失败'));
      }
    } finally {
      if (generationControllerRef.current === controller) generationControllerRef.current = null;
      setGenerating(false);
    }
  };

  const generateFromAnswer = async () => {
    if (!lastAssistant || !imageModel || generating) return;
    await runGeneration({
      model: imageModel,
      prompt: lastAssistant,
      reference_asset_ids: [],
      referenceFiles: supportsReferences ? references.slice(0, referenceLimit) : [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    });
  };

  const retryLatest = async () => {
    const retry = latestRetryRef.current;
    if (!retry || generating) return;
    await runGeneration(
      retry.input,
      retry.reconcileWithRetainedKey ? retry.idempotencyKey : undefined,
      retry.reconcileWithRetainedKey,
    );
  };

  const copyResult = async (result: GeneratedImage) => {
    if (!(await copyImageBlob(result.blob))) throw new Error('Image clipboard unavailable.');
  };

  const cancelGeneration = async () => {
    if (cancellingGeneration) return;
    setCancellingGeneration(true);
    try {
      if (generationJob?.cancellable) {
        const cancelledJob = await cancelImageJob(generationJob.job_id);
        setGenerationJob(cancelledJob);
        onJobUpdated?.(cancelledJob);
      }
    } catch (reason) {
      setError(openOpcErrorMessage(reason, '取消生图失败'));
    } finally {
      generationControllerRef.current?.abort();
      setCancellingGeneration(false);
    }
  };

  return (
    <section className="single-panel agent-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Agent</p>
          <h2>一起完善创意</h2>
        </div>
        <div className="heading-actions">
          {messages.length > 0 ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => setMessages([])}
              disabled={busy}
              aria-label="清空对话"
              title="清空对话"
            >
              <Trash2 size={15} />
            </button>
          ) : null}
          <Bot size={19} />
        </div>
      </div>

      <div className="agent-options">
        <label>
          <span className="field-label">对话模型</span>
          <select
            className="select-input"
            value={textModel}
            onChange={(event) => setTextModel(event.target.value)}
            disabled={textModels.length === 0}
          >
            {textModels.length === 0 ? <option value="">暂无可用模型</option> : null}
            {textModels.map((item) => (
              <option key={item.id} value={item.id}>{item.name ?? item.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">生图模型</span>
          <select
            className="select-input"
            value={imageModel}
            onChange={(event) => setImageModel(event.target.value)}
            disabled={imageModels.length === 0}
          >
            {imageModels.length === 0 ? <option value="">暂无可用模型</option> : null}
            {imageModels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label
          className={`upload-zone compact-upload ${canUploadReferences ? '' : 'is-disabled'}`}
          htmlFor="agent-reference"
        >
          <Upload size={15} />
          <span>
            {canUploadReferences
              ? references.length
                ? `${references.length} / ${referenceLimit} 张参考图`
                : '添加参考图'
              : supportsVision ? '添加视觉参考图' : '生图模型不支持参考图'}
          </span>
          <input
            id="agent-reference"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            disabled={!canUploadReferences}
            onChange={(event) => {
              setReferences(Array.from(event.target.files ?? []).slice(0, referenceLimit));
              event.currentTarget.value = '';
            }}
          />
        </label>
      </div>

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
          <span className="field-hint">
            {supportsVision && supportsReferences
              ? '对话和生图都会使用'
              : supportsVision
                ? '仅用于视觉对话'
                : '仅用于后续生图'}
          </span>
        </div>
      ) : null}

      <div ref={chatLogRef} className="chat-log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-state compact">
            <MessageSquareText size={26} />
            <p>告诉 Agent 你想做什么</p>
            <span>它会帮你整理成可直接生图的方案</span>
          </div>
        ) : (
          messages.map((message, index) => (
            <div className={`chat-bubble ${message.role}`} key={`${message.role}-${index}`}>
              <span className="bubble-role">{message.role === 'user' ? '你' : 'Agent'}</span>
              <p>{message.content || '…'}</p>
            </div>
          ))
        )}
      </div>

      {lastAssistant ? (
        <div className="agent-actions">
          <button type="button" className="button subtle" onClick={() => onUsePrompt(lastAssistant)}>
            <Check size={15} />带回生图工作区
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void generateFromAnswer()}
            disabled={!imageModel || generating}
          >
            <Sparkles size={15} />{generating ? '生成中' : '直接生成图片'}
          </button>
        </div>
      ) : null}

      {results.length > 0 || retryAvailable ? (
        <div className="agent-results">
          <ResultGrid
            results={results}
            alt="Agent 生成结果"
            downloadPrefix="agent"
            onCopy={copyResult}
            onRetry={retryAvailable ? retryLatest : undefined}
            onUseAsReference={onUseAsReference}
          />
        </div>
      ) : null}

      <GenerationStatus
        busy={generating}
        job={generationJob}
        estimate={generationEstimate}
        progress={generationProgress}
        cancelling={cancellingGeneration}
        onCancel={() => void cancelGeneration()}
      />

      <form className="chat-composer" onSubmit={send}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder="例如：把这个想法变成一张电影感海报…"
          rows={2}
          maxLength={8000}
        />
        {busy ? (
          <button
            className="button subtle icon-only"
            type="button"
            onClick={() => chatControllerRef.current?.abort()}
            aria-label="停止回答"
            title="停止回答"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            className="button primary icon-only"
            type="submit"
            disabled={!input.trim() || !textModel}
            aria-label="发送"
            title="发送"
          >
            <Send size={17} />
          </button>
        )}
      </form>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
