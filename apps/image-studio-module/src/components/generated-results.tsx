import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Eye, ImagePlus, Images, RotateCcw, X } from 'lucide-react';
import {
  imageFileExtension,
  isImageClipboardAvailable,
  type GeneratedImage,
} from '../lib/openopc-image-service';

export async function invokeResultAction(
  result: GeneratedImage,
  action?: (selected: GeneratedImage) => void | Promise<void>,
): Promise<void> {
  await action?.(result);
}

interface ResultPreviewUrlApi {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

export function acquireResultPreviewUrl(
  result: GeneratedImage,
  urlApi: ResultPreviewUrlApi = URL,
): { url: string; release: () => void } {
  if (result.url) return { url: result.url, release: () => undefined };
  const url = urlApi.createObjectURL(result.blob);
  let released = false;
  return {
    url,
    release: () => {
      if (released) return;
      released = true;
      urlApi.revokeObjectURL(url);
    },
  };
}

export function useGeneratedImageUrls(results: readonly GeneratedImage[]): void {
  useEffect(
    () => () => {
      results.forEach((result) => URL.revokeObjectURL(result.url));
    },
    [results],
  );
}

function isSafeObjectUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'blob:';
  } catch {
    return false;
  }
}

export function useFilePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return undefined;
    }
    const nextUrl = URL.createObjectURL(file);
    setUrl(isSafeObjectUrl(nextUrl) ? nextUrl : null);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);
  return url;
}

export function ResultPanel({
  results,
  emptyLabel,
  onUseAsReference,
  onPreview,
  onCopy,
  onRetry,
}: {
  results: readonly GeneratedImage[];
  emptyLabel: string;
  onUseAsReference?: (assetId: string) => void;
  onPreview?: (result: GeneratedImage) => void;
  onCopy?: (result: GeneratedImage) => Promise<void>;
  onRetry?: () => Promise<void>;
}) {
  return (
    <section className="result-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Output</p>
          <h2>结果</h2>
        </div>
        <Images size={19} />
      </div>
      {results.length === 0 && !onRetry ? (
        <div className="empty-state">
          <ImagePlus size={30} />
          <p>{emptyLabel}</p>
          <span>平台会自动保存生成素材</span>
        </div>
      ) : (
        <ResultGrid
          results={results}
          alt="生成结果"
          downloadPrefix="image"
          onUseAsReference={onUseAsReference}
          onPreview={onPreview}
          onCopy={onCopy}
          onRetry={onRetry}
        />
      )}
    </section>
  );
}

export function ResultGrid({
  results,
  alt,
  downloadPrefix,
  onUseAsReference,
  onPreview,
  onCopy,
  onRetry,
}: {
  results: readonly GeneratedImage[];
  alt: string;
  downloadPrefix: string;
  onUseAsReference?: (assetId: string) => void;
  onPreview?: (result: GeneratedImage) => void;
  onCopy?: (result: GeneratedImage) => Promise<void>;
  onRetry?: () => Promise<void>;
}) {
  const [previewResult, setPreviewResult] = useState<GeneratedImage | null>(null);
  const [ownedPreviewUrl, setOwnedPreviewUrl] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{
    assetId: string;
    message: string;
    unavailable?: boolean;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const clipboardAvailable = isImageClipboardAvailable();

  useEffect(() => {
    if (!previewResult) {
      setOwnedPreviewUrl(null);
      return undefined;
    }
    const previewUrl = acquireResultPreviewUrl(previewResult);
    setOwnedPreviewUrl(previewResult.url ? null : previewUrl.url);
    return previewUrl.release;
  }, [previewResult]);

  useEffect(() => {
    if (!previewResult) return undefined;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewResult(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      activeElement?.focus();
    };
  }, [previewResult]);

  const preview = (result: GeneratedImage) => {
    setPreviewResult(result);
    onPreview?.(result);
  };

  const copy = async (result: GeneratedImage) => {
    if (!clipboardAvailable || !onCopy) {
      setCopyStatus({
        assetId: result.assetId,
        message: '当前浏览器不支持复制图片',
        unavailable: true,
      });
      return;
    }
    try {
      await invokeResultAction(result, onCopy);
      setCopyStatus({ assetId: result.assetId, message: '图片已复制' });
    } catch {
      setCopyStatus({ assetId: result.assetId, message: '复制失败，请重试' });
    }
  };

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const previewUrl = previewResult?.url || ownedPreviewUrl;

  return (
    <>
      {onRetry ? (
        <div className="result-retry">
          <span>上次生成未完成</span>
          <button
            type="button"
            className="button subtle compact-button"
            onClick={() => void retry()}
            disabled={retrying}
          >
            <RotateCcw size={13} />{retrying ? '重试中' : '重试'}
          </button>
        </div>
      ) : null}
      <div className="result-grid">
        {results.map((result) => (
          <figure className="result-card" key={result.assetId}>
            <button
              type="button"
              className="result-preview-trigger"
              onClick={() => preview(result)}
              aria-label={`预览图片 ${result.assetId.slice(0, 8)}`}
            >
              <img src={result.url} alt={alt} />
            </button>
            <figcaption>
              <span>{result.assetId.slice(0, 8)}</span>
              <span className="result-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => preview(result)}
                  aria-label="预览"
                  title="预览"
                >
                  <Eye size={15} />
                </button>
                {onCopy ? (
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => void copy(result)}
                    disabled={!clipboardAvailable}
                    aria-label="复制图片"
                    title={clipboardAvailable ? '复制图片' : '当前浏览器不支持复制图片'}
                  >
                    <Copy size={15} />
                  </button>
                ) : null}
                {onUseAsReference ? (
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => onUseAsReference(result.assetId)}
                    aria-label="用作参考图"
                    title="用作参考图"
                  >
                    <ImagePlus size={15} />
                  </button>
                ) : null}
                <a
                  className="icon-button"
                  href={result.url}
                  download={`${downloadPrefix}-${result.assetId.slice(0, 8)}.${imageFileExtension(result.blob.type)}`}
                  aria-label="下载"
                  title="下载"
                >
                  <Download size={15} />
                </a>
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
      {onCopy && !clipboardAvailable ? (
        <p className="result-action-status is-unavailable" role="status">
          当前浏览器不支持复制图片
        </p>
      ) : copyStatus ? (
        <p
          className={`result-action-status ${copyStatus.unavailable ? 'is-unavailable' : ''}`}
          role="status"
        >
          {copyStatus.message}
        </p>
      ) : null}
      {previewResult && previewUrl ? (
        <div
          className="result-preview-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewResult(null);
          }}
        >
          <section
            ref={dialogRef}
            className="result-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="result-preview-title"
            tabIndex={-1}
          >
            <div className="result-preview-heading">
              <div>
                <p className="eyebrow">Preview</p>
                <h2 id="result-preview-title">生成结果</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPreviewResult(null)}
                aria-label="关闭预览"
                title="关闭预览"
              >
                <X size={17} />
              </button>
            </div>
            <img className="result-preview-image" src={previewUrl} alt={alt} />
            <div className="result-preview-footer">
              <span className="result-preview-id">素材 {previewResult.assetId}</span>
              <span className="result-preview-actions">
                {onCopy ? (
                  <button
                    type="button"
                    className="button subtle compact-button"
                    onClick={() => void copy(previewResult)}
                    disabled={!clipboardAvailable}
                  >
                    <Copy size={13} />复制
                  </button>
                ) : null}
                {onUseAsReference ? (
                  <button
                    type="button"
                    className="button subtle compact-button"
                    onClick={() => onUseAsReference(previewResult.assetId)}
                  >
                    <ImagePlus size={13} />用作参考图
                  </button>
                ) : null}
                <a
                  className="button primary compact-button"
                  href={previewUrl}
                  download={`${downloadPrefix}-${previewResult.assetId.slice(0, 8)}.${imageFileExtension(previewResult.blob.type)}`}
                >
                  <Download size={13} />下载
                </a>
              </span>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
