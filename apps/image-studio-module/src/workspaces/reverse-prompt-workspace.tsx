import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ImagePlus,
  LoaderCircle,
  MessageSquareText,
  ScanSearch,
  Square,
} from 'lucide-react';
import type { OpenOpcModel } from '@openopc/developer-sdk';
import { useFilePreview } from '../components/generated-results';
import {
  fileAsDataUrl,
  isAbortError,
  openOpcErrorMessage,
  streamText,
} from '../lib/openopc-image-service';
import {
  buildReversePromptMessages,
  selectTextModelWhenReady,
} from '../lib/text-workflows';
import { useSessionState } from '../lib/session-state';

interface ReversePromptWorkspaceProps {
  textModels: OpenOpcModel[];
  modelsReady: boolean;
  onUsePrompt: (prompt: string) => void;
}

export function ReversePromptWorkspace({
  textModels,
  modelsReady,
  onUsePrompt,
}: ReversePromptWorkspaceProps) {
  const [model, setModel] = useSessionState(
    'image-studio.reverse.model',
    '',
    (value): value is string => typeof value === 'string',
  );
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const previewUrl = useFilePreview(file);
  const visionModels = textModels.filter((item) => item.attachment === true);

  useEffect(() => {
    const nextModel = selectTextModelWhenReady(textModels, model, modelsReady, {
      requireAttachment: true,
    });
    if (nextModel !== model) setModel(nextModel);
  }, [model, modelsReady, setModel, textModels]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const inspect = async () => {
    if (!file || !model || busy) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setResult('');
    let answer = '';
    try {
      const dataUrl = await fileAsDataUrl(file);
      await streamText(
        model,
        buildReversePromptMessages(dataUrl),
        (delta) => {
          answer += delta;
          setResult(answer);
        },
        { signal: controller.signal },
      );
      if (!answer.trim()) throw new Error('反推模型没有返回内容');
    } catch (reason) {
      if (!isAbortError(reason)) setError(openOpcErrorMessage(reason, '反推失败'));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  };

  return (
    <section className="workspace-grid reverse-grid">
      <div className="control-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Reverse prompt</p>
            <h2>从图片提炼提示词</h2>
          </div>
          <ScanSearch size={19} />
        </div>

        <label className={`upload-large ${previewUrl ? 'has-preview' : ''}`} htmlFor="reverse-image">
          {previewUrl ? <img className="upload-preview" src={previewUrl} alt="待分析图片" /> : <ImagePlus size={28} />}
          <span>{file ? file.name : '选择一张图片'}</span>
          <small>PNG、JPEG 或 WebP</small>
          <input
            id="reverse-image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setResult('');
              setError(null);
              event.currentTarget.value = '';
            }}
          />
        </label>

        <label>
          <span className="field-label">视觉模型</span>
          <select
            className="select-input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={visionModels.length === 0}
          >
            {visionModels.length === 0 ? <option value="">暂无视觉模型</option> : null}
            {visionModels.map((item) => (
              <option key={item.id} value={item.id}>{item.name ?? item.id}</option>
            ))}
          </select>
        </label>

        {busy ? (
          <button
            type="button"
            className="button subtle full-width"
            onClick={() => controllerRef.current?.abort()}
          >
            <Square size={15} />停止分析
          </button>
        ) : (
          <button
            type="button"
            className="button primary full-width"
            disabled={!file || !model}
            onClick={() => void inspect()}
          >
            <ScanSearch size={16} />开始反推
          </button>
        )}
        {busy ? <p className="field-hint"><LoaderCircle size={12} className="spin inline-spinner" />正在接收分析结果</p> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
      </div>

      <div className="result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Prompt</p>
            <h2>分析结果</h2>
          </div>
          <MessageSquareText size={19} />
        </div>
        {result || busy ? (
          <>
            <textarea
              className="prompt-output"
              value={result}
              onChange={(event) => setResult(event.target.value)}
              aria-label="反推提示词结果"
            />
            <button
              type="button"
              className="button subtle"
              onClick={() => onUsePrompt(result)}
              disabled={!result.trim()}
            >
              <Check size={15} />用于生图
            </button>
          </>
        ) : (
          <div className="empty-state">
            <ScanSearch size={30} />
            <p>上传图片后查看分析</p>
            <span>结果可直接带回生图工作区</span>
          </div>
        )}
      </div>
    </section>
  );
}
