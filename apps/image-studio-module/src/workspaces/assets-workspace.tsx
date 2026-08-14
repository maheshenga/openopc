import type { OpenOpcImageAsset } from '@openopc/developer-sdk';
import { Download, ImagePlus, Images, LoaderCircle, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadBlob } from '../lib/gif-encoder';
import {
  type ImageAssetFilter,
  downloadAsset,
  filterImageAssets,
  isAbortError,
  openOpcErrorMessage,
} from '../lib/openopc-image-service';

const ASSET_FILTERS: Array<{ id: ImageAssetFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'generated', label: '生成' },
  { id: 'uploaded', label: '上传' },
];

interface AssetsWorkspaceProps {
  assets: OpenOpcImageAsset[];
  assetError: string | null;
  onRefresh: () => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onUseAsReference: (assetId: string) => void;
}

function AssetThumbnail({ asset }: { asset: OpenOpcImageAsset }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let loadedUrl: string | null = null;
    let observer: IntersectionObserver | null = null;
    let started = false;
    const controller = new AbortController();

    const load = async () => {
      if (started) return;
      started = true;
      setLoading(true);
      try {
        const blob = await downloadAsset(asset.asset_id, { signal: controller.signal });
        if (!active) return;
        loadedUrl = URL.createObjectURL(blob);
        setUrl(loadedUrl);
      } catch (reason) {
        if (active && !isAbortError(reason)) setFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    };

    const host = hostRef.current;
    if (retryRevision > 0 || !host || typeof IntersectionObserver === 'undefined') {
      void load();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            void load();
            observer?.disconnect();
          }
        },
        { rootMargin: '160px' },
      );
      observer.observe(host);
    }

    return () => {
      active = false;
      controller.abort();
      observer?.disconnect();
      if (loadedUrl) URL.revokeObjectURL(loadedUrl);
    };
  }, [asset.asset_id, retryRevision]);

  const retry = () => {
    setFailed(false);
    setRetryRevision((current) => current + 1);
  };

  return (
    <span ref={hostRef} className="asset-thumbnail">
      {url ? <img src={url} alt="素材缩略图" loading="lazy" /> : null}
      {!url && loading ? <LoaderCircle size={17} className="spin" /> : null}
      {!url && !loading && failed ? (
        <button
          type="button"
          className="asset-thumbnail-retry"
          onClick={retry}
          aria-label="重新加载缩略图"
          title="重新加载缩略图"
        >
          <RotateCcw size={16} />
        </button>
      ) : null}
      {!url && !loading && !failed ? <ImagePlus size={19} /> : null}
    </span>
  );
}

function formatCreatedAt(value: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(
      new Date(value),
    );
  } catch {
    return '';
  }
}

export function AssetsWorkspace({
  assets,
  assetError,
  onRefresh,
  hasMore,
  loadingMore,
  onLoadMore,
  onUseAsReference,
}: AssetsWorkspaceProps) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ImageAssetFilter>('all');
  const visibleAssets = useMemo(() => filterImageAssets(assets, filter), [assets, filter]);

  const download = async (asset: OpenOpcImageAsset) => {
    setDownloading(asset.asset_id);
    setError(null);
    try {
      const blob = await downloadAsset(asset.asset_id);
      const extension = asset.mime_type.split('/')[1] ?? 'png';
      downloadBlob(blob, `asset-${asset.asset_id.slice(0, 8)}.${extension}`);
    } catch (reason) {
      if (!isAbortError(reason)) setError(openOpcErrorMessage(reason, '下载素材失败'));
    } finally {
      setDownloading(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (reason) {
      setError(openOpcErrorMessage(reason, '刷新素材失败'));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="single-panel assets-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Assets</p>
          <h2>我的素材</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="刷新"
          title="刷新"
        >
          <RotateCcw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>
      {assets.length > 0 ? (
        <div className="assets-toolbar">
          <div className="segmented" aria-label="素材筛选">
            {ASSET_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={filter === item.id ? 'segment is-active' : 'segment'}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="assets-count">
            {visibleAssets.length} / {assets.length}
          </span>
        </div>
      ) : null}
      {assetError || error ? (
        <p className="inline-error" role="alert">
          {assetError ?? error}
        </p>
      ) : null}
      {assets.length === 0 ? (
        <div className="empty-state">
          <Images size={30} />
          <p>还没有保存的素材</p>
          <span>生成结果会自动出现在这里</span>
        </div>
      ) : visibleAssets.length === 0 ? (
        <div className="empty-state compact">
          <Images size={30} />
          <p>当前筛选下没有素材</p>
          <span>切换筛选查看其他来源</span>
        </div>
      ) : (
        <div className="asset-grid">
          {visibleAssets.map((asset) => (
            <article className="asset-card" key={asset.asset_id}>
              <AssetThumbnail asset={asset} />
              <div className="asset-meta">
                <strong>{asset.asset_id.slice(0, 8)}</strong>
                <small>
                  {asset.source.job_id ? '生成' : '上传'} ·{' '}
                  {asset.width && asset.height
                    ? `${asset.width} × ${asset.height}`
                    : asset.mime_type}
                  {formatCreatedAt(asset.created_at)
                    ? ` · ${formatCreatedAt(asset.created_at)}`
                    : ''}
                </small>
              </div>
              <div className="asset-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onUseAsReference(asset.asset_id)}
                  aria-label="用于生图参考图"
                  title="用于生图参考图"
                >
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void download(asset)}
                  disabled={downloading === asset.asset_id}
                  aria-label="下载素材"
                  title="下载素材"
                >
                  {downloading === asset.asset_id ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Download size={15} />
                  )}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {assets.length > 0 && hasMore ? (
        <div className="asset-pagination">
          <button
            type="button"
            className="button subtle"
            onClick={() => void onLoadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
            {loadingMore ? '加载中' : '加载更多'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
