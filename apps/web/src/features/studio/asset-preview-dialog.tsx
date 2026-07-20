'use client';

import type { IntelligenceStudioAsset } from '@kortix/sdk';
import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { ErrorState } from '@/features/layout/section/error-state';

export interface AssetPreviewLabels {
  imageAsset: string;
  previewTitle: string;
  previewDescription: string;
  previewLoading: string;
  previewErrorTitle: string;
  retry: string;
  close: string;
  download: string;
  downloading: string;
}

export function AssetPreviewContent({
  asset,
  previewUrl,
  loading,
  error,
  labels,
  onRetry,
  onImageError,
}: {
  asset: IntelligenceStudioAsset;
  previewUrl: string | null;
  loading: boolean;
  error: string | null;
  labels: AssetPreviewLabels;
  onRetry: () => void;
  onImageError?: () => void;
}) {
  return (
    <div className="bg-muted/30 relative mx-auto grid aspect-square max-h-[70vh] w-full max-w-[70vh] place-items-center overflow-hidden rounded-md">
      {loading ? (
        <output className="text-muted-foreground flex flex-col items-center gap-3 text-sm">
          <Loading className="size-5 shrink-0" />
          <span>{labels.previewLoading}</span>
        </output>
      ) : error ? (
        <ErrorState
          size="sm"
          title={labels.previewErrorTitle}
          description={error}
          action={
            <Button type="button" variant="outline" size="lg" onClick={onRetry}>
              {labels.retry}
            </Button>
          }
        />
      ) : previewUrl ? (
        // The signed URL bypasses the persistent Next image optimizer cache.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt={labels.imageAsset}
          referrerPolicy="no-referrer"
          decoding="async"
          draggable={false}
          onError={onImageError}
          className="h-full w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      ) : null}
      <span className="sr-only">{asset.asset_id}</span>
    </div>
  );
}

export function AssetPreviewDialog({
  asset,
  previewUrl,
  loading,
  error,
  downloading,
  labels,
  onOpenChange,
  onRetry,
  onDownload,
  onImageError,
}: {
  asset: IntelligenceStudioAsset | null;
  previewUrl: string | null;
  loading: boolean;
  error: string | null;
  downloading: boolean;
  labels: AssetPreviewLabels;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onDownload: () => void;
  onImageError: () => void;
}) {
  return (
    <Modal open={asset !== null} onOpenChange={onOpenChange}>
      {asset ? (
        <ModalContent className="lg:max-w-3xl">
          <ModalHeader>
            <ModalTitle>{labels.previewTitle}</ModalTitle>
            <ModalDescription>{labels.previewDescription}</ModalDescription>
          </ModalHeader>
          <ModalBody>
            <AssetPreviewContent
              asset={asset}
              previewUrl={previewUrl}
              loading={loading}
              error={error}
              labels={labels}
              onRetry={onRetry}
              onImageError={onImageError}
            />
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="lg"
              className="transition-transform duration-150 ease-out active:scale-[0.96]"
              onClick={() => onOpenChange(false)}
            >
              {labels.close}
            </Button>
            <Button
              type="button"
              size="lg"
              className="transition-transform duration-150 ease-out active:scale-[0.96]"
              onClick={onDownload}
              disabled={downloading}
            >
              {downloading ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <Download className="size-4 shrink-0" aria-hidden="true" />
              )}
              {downloading ? labels.downloading : labels.download}
            </Button>
          </ModalFooter>
        </ModalContent>
      ) : null}
    </Modal>
  );
}
