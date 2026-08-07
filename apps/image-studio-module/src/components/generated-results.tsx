import { useEffect, useState } from 'react';
import { Download, ImagePlus, Images } from 'lucide-react';
import type { GeneratedImage } from '../lib/openopc-image-service';

export function useGeneratedImageUrls(results: readonly GeneratedImage[]): void {
  useEffect(
    () => () => {
      results.forEach((result) => URL.revokeObjectURL(result.url));
    },
    [results],
  );
}

export function useFilePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return undefined;
    }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);
  return url;
}

export function ResultPanel({
  results,
  emptyLabel,
  onUseAsReference,
}: {
  results: readonly GeneratedImage[];
  emptyLabel: string;
  onUseAsReference?: (assetId: string) => void;
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
      {results.length === 0 ? (
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
}: {
  results: readonly GeneratedImage[];
  alt: string;
  downloadPrefix: string;
  onUseAsReference?: (assetId: string) => void;
}) {
  return (
    <div className="result-grid">
      {results.map((result) => (
        <figure className="result-card" key={result.assetId}>
          <img src={result.url} alt={alt} />
          <figcaption>
            <span>{result.assetId.slice(0, 8)}</span>
            <span className="result-actions">
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
                download={`${downloadPrefix}-${result.assetId.slice(0, 8)}.png`}
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
  );
}
