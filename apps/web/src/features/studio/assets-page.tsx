'use client';

import type { IntelligenceAssetDownload, IntelligenceStudioAsset } from '@kortix/sdk';
import { useIntelligenceAssetDownload, useIntelligenceAssets } from '@kortix/sdk/react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  Filter,
  Image as ImageIcon,
  ImagePlus,
  Images,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';

import { AssetPreviewDialog, type AssetPreviewLabels } from './asset-preview-dialog';

const SAFE_ERROR_CODE_PATTERN = /^(?:STUDIO|INTELLIGENCE)_[A-Z0-9_.-]{1,118}$/;
const ASSET_SKELETON_KEYS = [
  'asset-skeleton-1',
  'asset-skeleton-2',
  'asset-skeleton-3',
  'asset-skeleton-4',
  'asset-skeleton-5',
  'asset-skeleton-6',
] as const;

export type AssetMimeFilter = 'all' | 'png' | 'jpeg' | 'webp' | 'other';
export type AssetSourceFilter = 'all' | 'generated' | 'uploaded';

export interface AssetsPageLabels extends AssetPreviewLabels {
  title: string;
  description: string;
  formatFilter: string;
  sourceFilter: string;
  allFormats: string;
  png: string;
  jpeg: string;
  webp: string;
  otherFormats: string;
  allSources: string;
  generated: string;
  uploaded: string;
  loading: string;
  errorTitle: string;
  downloadError: string;
  emptyTitle: string;
  emptyDescription: string;
  noMatchesTitle: string;
  noMatchesDescription: string;
  unknownDimensions: string;
  preview: string;
  reuse: string;
  sourceJob: string;
  previousPage: string;
  nextPage: string;
  page: string;
}

interface AssetDownloadControllerDependencies {
  createDownloadUrl: (assetId: string) => Promise<IntelligenceAssetDownload>;
  openUrl: (url: string) => void | Promise<void>;
}

export function createAssetDownloadController({
  createDownloadUrl,
  openUrl,
}: AssetDownloadControllerDependencies) {
  return Object.freeze({
    async download(assetId: string): Promise<void> {
      const result = await createDownloadUrl(assetId);
      await openUrl(result.signed_download_url);
    },
  });
}

export function studioAssetsErrorCode(error: unknown): string {
  const source = error as { status?: unknown; code?: unknown } | null;
  if (source && source.status === 403) return 'STUDIO_PERMISSION_DENIED';
  if (source && source.status === 404) return 'STUDIO_ASSET_NOT_FOUND';
  if (source && typeof source.code === 'string' && SAFE_ERROR_CODE_PATTERN.test(source.code)) {
    return source.code;
  }
  return 'STUDIO_ASSETS_REQUEST_FAILED';
}

function mimeFamily(mimeType: string): Exclude<AssetMimeFilter, 'all'> {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpeg';
  if (normalized === 'image/webp') return 'webp';
  return 'other';
}

export function filterStudioAssets(
  assets: readonly IntelligenceStudioAsset[],
  mimeFilter: AssetMimeFilter,
  sourceFilter: AssetSourceFilter,
): IntelligenceStudioAsset[] {
  return assets.filter((asset) => {
    const matchesMime = mimeFilter === 'all' || mimeFamily(asset.mime_type) === mimeFilter;
    const source = asset.source_job_id ? 'generated' : 'uploaded';
    const matchesSource = sourceFilter === 'all' || source === sourceFilter;
    return matchesMime && matchesSource;
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function openSignedUrl(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.referrerPolicy = 'no-referrer';
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function AssetCard({
  projectId,
  asset,
  downloading,
  labels,
  onPreview,
  onDownload,
}: {
  projectId: string;
  asset: IntelligenceStudioAsset;
  downloading: boolean;
  labels: AssetsPageLabels;
  onPreview: (asset: IntelligenceStudioAsset) => void;
  onDownload: (asset: IntelligenceStudioAsset) => void;
}) {
  const dimensions =
    asset.width && asset.height ? `${asset.width} x ${asset.height}` : labels.unknownDimensions;
  const sourceLabel = asset.source_job_id ? labels.generated : labels.uploaded;
  const imageHref = `/projects/${projectId}/studio/image`;

  return (
    <article
      data-asset-id={asset.asset_id}
      className="bg-popover outline-foreground/10 overflow-hidden rounded-md border outline outline-1 -outline-offset-1"
    >
      <div className="bg-muted/30 relative grid aspect-square place-items-center overflow-hidden">
        <ImageIcon
          className="text-muted-foreground/50 size-10"
          strokeWidth={1.25}
          aria-hidden="true"
        />
        <Badge variant="outline" size="xs" className="bg-background/90 absolute top-2 left-2">
          {mimeFamily(asset.mime_type).toUpperCase()}
        </Badge>
      </div>

      <div className="flex min-h-28 flex-col gap-3 px-3 py-3">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate font-mono text-xs font-medium" title={asset.asset_id}>
            {asset.asset_id.slice(0, 8)}
          </h3>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums">
            <span>{dimensions}</span>
            <span aria-hidden="true">&bull;</span>
            <span>{formatBytes(asset.size_bytes)}</span>
            <span aria-hidden="true">&bull;</span>
            <span>{sourceLabel}</span>
          </p>
        </div>

        <div className="mt-auto flex items-center justify-end gap-1">
          {asset.source_job_id ? (
            <Hint label={labels.sourceJob} side="top">
              <Button
                asChild
                variant="ghost"
                size="icon-lg"
                className="transition-transform duration-150 ease-out active:scale-[0.96]"
              >
                <Link
                  href={`${imageHref}?job=${asset.source_job_id}`}
                  aria-label={labels.sourceJob}
                >
                  <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                </Link>
              </Button>
            </Hint>
          ) : null}
          <Hint label={labels.reuse} side="top">
            <Button
              asChild
              variant="ghost"
              size="icon-lg"
              className="transition-transform duration-150 ease-out active:scale-[0.96]"
            >
              <Link href={`${imageHref}?reference=${asset.asset_id}`} aria-label={labels.reuse}>
                <ImagePlus className="size-4 shrink-0" aria-hidden="true" />
              </Link>
            </Button>
          </Hint>
          <Hint label={labels.preview} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="transition-transform duration-150 ease-out active:scale-[0.96]"
              aria-label={labels.preview}
              onClick={() => onPreview(asset)}
            >
              <Eye className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          </Hint>
          <Hint label={downloading ? labels.downloading : labels.download} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="transition-transform duration-150 ease-out active:scale-[0.96]"
              aria-label={downloading ? labels.downloading : labels.download}
              disabled={downloading}
              onClick={() => onDownload(asset)}
            >
              {downloading ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <Download className="size-4 shrink-0" aria-hidden="true" />
              )}
            </Button>
          </Hint>
        </div>
      </div>
    </article>
  );
}

export function AssetsPageView({
  projectId,
  assets,
  loading,
  error,
  mimeFilter,
  sourceFilter,
  nextCursor,
  hasPreviousPage,
  downloadingAssetId,
  labels,
  onMimeFilterChange,
  onSourceFilterChange,
  onPreview,
  onDownload,
  onRetry,
  onNextPage,
  onPreviousPage,
}: {
  projectId: string;
  assets: readonly IntelligenceStudioAsset[];
  loading: boolean;
  error: string | null;
  mimeFilter: AssetMimeFilter;
  sourceFilter: AssetSourceFilter;
  nextCursor: string | null;
  hasPreviousPage: boolean;
  downloadingAssetId: string | null;
  labels: AssetsPageLabels;
  onMimeFilterChange: (value: AssetMimeFilter) => void;
  onSourceFilterChange: (value: AssetSourceFilter) => void;
  onPreview: (asset: IntelligenceStudioAsset) => void;
  onDownload: (asset: IntelligenceStudioAsset) => void;
  onRetry: () => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
}) {
  const filteredAssets = filterStudioAssets(assets, mimeFilter, sourceFilter);

  return (
    <CustomizeSectionWrapper
      title={labels.title}
      description={labels.description}
      className="max-w-6xl"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Filter
            className="text-muted-foreground hidden size-4 shrink-0 sm:block"
            aria-hidden="true"
          />
          <label className="min-w-0">
            <span className="sr-only">{labels.formatFilter}</span>
            <select
              aria-label={labels.formatFilter}
              value={mimeFilter}
              onChange={(event) => onMimeFilterChange(event.target.value as AssetMimeFilter)}
              className="border-border bg-popover text-foreground focus-visible:ring-kortix-base h-10 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-[0.6px] sm:w-40"
            >
              <option value="all">{labels.allFormats}</option>
              <option value="png">{labels.png}</option>
              <option value="jpeg">{labels.jpeg}</option>
              <option value="webp">{labels.webp}</option>
              <option value="other">{labels.otherFormats}</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">{labels.sourceFilter}</span>
            <select
              aria-label={labels.sourceFilter}
              value={sourceFilter}
              onChange={(event) => onSourceFilterChange(event.target.value as AssetSourceFilter)}
              className="border-border bg-popover text-foreground focus-visible:ring-kortix-base h-10 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-[0.6px] sm:w-40"
            >
              <option value="all">{labels.allSources}</option>
              <option value="generated">{labels.generated}</option>
              <option value="uploaded">{labels.uploaded}</option>
            </select>
          </label>
        </div>

        {loading ? (
          <output
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-label={labels.loading}
          >
            {ASSET_SKELETON_KEYS.map((key) => (
              <div key={key} className="overflow-hidden rounded-md border">
                <Skeleton className="aspect-square rounded-none py-0" />
                <div className="space-y-2 px-3 py-3">
                  <Skeleton className="h-3 w-24 py-0" />
                  <Skeleton className="h-3 w-36 py-0" />
                </div>
              </div>
            ))}
          </output>
        ) : error ? (
          <ErrorState
            size="sm"
            title={labels.errorTitle}
            description={error}
            action={
              <Button type="button" variant="outline" size="lg" onClick={onRetry}>
                {labels.retry}
              </Button>
            }
          />
        ) : assets.length === 0 ? (
          <EmptyState
            icon={Images}
            size="sm"
            title={labels.emptyTitle}
            description={labels.emptyDescription}
          />
        ) : filteredAssets.length === 0 ? (
          <EmptyState
            icon={Filter}
            size="sm"
            title={labels.noMatchesTitle}
            description={labels.noMatchesDescription}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredAssets.map((asset) => (
              <AssetCard
                key={asset.asset_id}
                projectId={projectId}
                asset={asset}
                downloading={downloadingAssetId === asset.asset_id}
                labels={labels}
                onPreview={onPreview}
                onDownload={onDownload}
              />
            ))}
          </div>
        )}

        {!loading && !error && (hasPreviousPage || nextCursor !== null) ? (
          <nav className="flex items-center justify-end gap-2" aria-label={labels.page}>
            <span className="text-muted-foreground mr-1 text-xs tabular-nums">{labels.page}</span>
            <Hint label={labels.previousPage} side="top">
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                className="transition-transform duration-150 ease-out active:scale-[0.96]"
                aria-label={labels.previousPage}
                disabled={!hasPreviousPage}
                onClick={onPreviousPage}
              >
                <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
              </Button>
            </Hint>
            <Hint label={labels.nextPage} side="top">
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                className="transition-transform duration-150 ease-out active:scale-[0.96]"
                aria-label={labels.nextPage}
                disabled={nextCursor === null}
                onClick={onNextPage}
              >
                <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
              </Button>
            </Hint>
          </nav>
        ) : null}
      </div>
    </CustomizeSectionWrapper>
  );
}

export function AssetsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('studio');
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [mimeFilter, setMimeFilter] = useState<AssetMimeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<AssetSourceFilter>('all');
  const [selectedAsset, setSelectedAsset] = useState<IntelligenceStudioAsset | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const previewRequest = useRef(0);

  const assetsQuery = useIntelligenceAssets(projectId, cursor);
  const {
    mutateAsync: requestPreviewUrl,
    reset: resetPreviewRequest,
    isPending: previewPending,
  } = useIntelligenceAssetDownload(projectId);
  const { mutateAsync: requestDownloadUrl, reset: resetDownloadRequest } =
    useIntelligenceAssetDownload(projectId);

  const labels: AssetsPageLabels = {
    title: t('assetsPage.title'),
    description: t('assetsPage.description'),
    formatFilter: t('assetsPage.filters.format'),
    sourceFilter: t('assetsPage.filters.source'),
    allFormats: t('assetsPage.filters.allFormats'),
    png: t('assetsPage.filters.png'),
    jpeg: t('assetsPage.filters.jpeg'),
    webp: t('assetsPage.filters.webp'),
    otherFormats: t('assetsPage.filters.other'),
    allSources: t('assetsPage.filters.allSources'),
    generated: t('assetsPage.filters.generated'),
    uploaded: t('assetsPage.filters.uploaded'),
    loading: t('assetsPage.loading'),
    errorTitle: t('assetsPage.errorTitle'),
    downloadError: t('assetsPage.downloadError'),
    retry: t('assetsPage.retry'),
    emptyTitle: t('assetsPage.emptyTitle'),
    emptyDescription: t('assetsPage.emptyDescription'),
    noMatchesTitle: t('assetsPage.noMatchesTitle'),
    noMatchesDescription: t('assetsPage.noMatchesDescription'),
    imageAsset: t('assetsPage.imageAsset'),
    unknownDimensions: t('assetsPage.unknownDimensions'),
    preview: t('assetsPage.preview'),
    download: t('assetsPage.download'),
    downloading: t('assetsPage.downloading'),
    reuse: t('assetsPage.reuse'),
    sourceJob: t('assetsPage.sourceJob'),
    previousPage: t('assetsPage.previousPage'),
    nextPage: t('assetsPage.nextPage'),
    page: t('assetsPage.page', { page: cursorHistory.length + 1 }),
    previewTitle: t('assetsPage.previewTitle'),
    previewDescription: t('assetsPage.previewDescription'),
    previewLoading: t('assetsPage.previewLoading'),
    previewErrorTitle: t('assetsPage.previewErrorTitle'),
    close: t('assetsPage.close'),
  };

  const downloadController = useMemo(
    () =>
      createAssetDownloadController({
        createDownloadUrl: requestDownloadUrl,
        openUrl: openSignedUrl,
      }),
    [requestDownloadUrl],
  );

  const requestPreview = useCallback(
    async (asset: IntelligenceStudioAsset) => {
      const requestId = ++previewRequest.current;
      setSelectedAsset(asset);
      setPreviewUrl(null);
      setPreviewError(null);
      resetPreviewRequest();
      try {
        const result = await requestPreviewUrl(asset.asset_id);
        if (previewRequest.current === requestId) setPreviewUrl(result.signed_download_url);
      } catch (error) {
        if (previewRequest.current === requestId) {
          setPreviewError(studioAssetsErrorCode(error));
        }
      }
    },
    [requestPreviewUrl, resetPreviewRequest],
  );

  const closePreview = useCallback(() => {
    previewRequest.current += 1;
    setSelectedAsset(null);
    setPreviewUrl(null);
    setPreviewError(null);
    resetPreviewRequest();
  }, [resetPreviewRequest]);

  const downloadAsset = useCallback(
    async (asset: IntelligenceStudioAsset) => {
      setDownloadingAssetId(asset.asset_id);
      try {
        await downloadController.download(asset.asset_id);
      } catch {
        errorToast(labels.downloadError);
      } finally {
        resetDownloadRequest();
        setDownloadingAssetId(null);
      }
    },
    [downloadController, labels.downloadError, resetDownloadRequest],
  );

  const goToNextPage = useCallback(() => {
    const nextCursor = assetsQuery.data?.next_cursor;
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
  }, [assetsQuery.data?.next_cursor, cursor]);

  const goToPreviousPage = useCallback(() => {
    setCursorHistory((history) => {
      if (history.length === 0) return history;
      const previousCursor = history[history.length - 1] ?? null;
      setCursor(previousCursor);
      return history.slice(0, -1);
    });
  }, []);

  return (
    <>
      <AssetsPageView
        projectId={projectId}
        assets={assetsQuery.data?.items ?? []}
        loading={assetsQuery.isLoading}
        error={assetsQuery.isError ? studioAssetsErrorCode(assetsQuery.error) : null}
        mimeFilter={mimeFilter}
        sourceFilter={sourceFilter}
        nextCursor={assetsQuery.data?.next_cursor ?? null}
        hasPreviousPage={cursorHistory.length > 0}
        downloadingAssetId={downloadingAssetId}
        labels={labels}
        onMimeFilterChange={setMimeFilter}
        onSourceFilterChange={setSourceFilter}
        onPreview={(asset) => void requestPreview(asset)}
        onDownload={(asset) => void downloadAsset(asset)}
        onRetry={() => void assetsQuery.refetch()}
        onNextPage={goToNextPage}
        onPreviousPage={goToPreviousPage}
      />
      <AssetPreviewDialog
        asset={selectedAsset}
        previewUrl={previewUrl}
        loading={previewPending}
        error={previewError}
        downloading={downloadingAssetId === selectedAsset?.asset_id}
        labels={labels}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
        onRetry={() => {
          if (selectedAsset) void requestPreview(selectedAsset);
        }}
        onDownload={() => {
          if (selectedAsset) void downloadAsset(selectedAsset);
        }}
        onImageError={() => {
          setPreviewUrl(null);
          setPreviewError(labels.previewErrorTitle);
          resetPreviewRequest();
        }}
      />
    </>
  );
}
