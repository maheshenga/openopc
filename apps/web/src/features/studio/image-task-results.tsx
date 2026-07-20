'use client';

import { Ban, Download, Image as ImageIcon, RefreshCw, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Progress } from '@/components/ui/progress';

import type { ImageTaskViewState } from './task-state';

export interface ImageTaskResult {
  assetId: string;
  previewUrl?: string;
}

export interface ImageTaskResultsLabels {
  results: string;
  noResults: string;
  statusUnknown: string;
  statusQueued: string;
  statusRunning: string;
  statusProgress: string;
  statusWaitingApproval: string;
  statusSucceeded: string;
  statusFailed: string;
  statusCancelled: string;
  cancel: string;
  retry: string;
  download: string;
  reuseReference: string;
  resultAlt: string;
}

export interface ImageTaskResultsProps {
  state: ImageTaskViewState;
  results: readonly ImageTaskResult[];
  operationErrorCode: string | null;
  operationErrorMessage: string | null;
  canCancel: boolean;
  cancelling: boolean;
  labels: ImageTaskResultsLabels;
  onCancel(): void;
  onRetry(): void;
  onDownload(assetId: string): void;
  onReuseReference(assetId: string): void;
}

function taskStatusLabel(state: ImageTaskViewState, labels: ImageTaskResultsLabels): string | null {
  switch (state.status) {
    case 'queued':
      return labels.statusQueued;
    case 'running':
      return state.progress > 0
        ? `${labels.statusProgress} ${Math.round(state.progress * 100)}%`
        : labels.statusRunning;
    case 'waiting_approval':
      return labels.statusWaitingApproval;
    case 'succeeded':
      return labels.statusSucceeded;
    case 'failed':
      return labels.statusFailed;
    case 'cancelled':
      return labels.statusCancelled;
    case 'unknown':
      return state.taskId ? labels.statusUnknown : null;
  }
}

export function ImageTaskResults({
  state,
  results,
  operationErrorCode,
  operationErrorMessage,
  canCancel,
  cancelling,
  labels,
  onCancel,
  onRetry,
  onDownload,
  onReuseReference,
}: ImageTaskResultsProps) {
  const statusLabel = taskStatusLabel(state, labels);
  const active =
    state.status === 'queued' || state.status === 'running' || state.status === 'waiting_approval';
  const recovering = state.status === 'unknown' && state.taskId !== null;
  const failed = state.status === 'failed' || operationErrorCode !== null;
  const errorCode = state.errorCode ?? operationErrorCode;

  return (
    <section
      className="flex min-h-[360px] min-w-0 flex-col overflow-hidden"
      aria-label={labels.results}
    >
      <header className="border-border flex h-11 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold">{labels.results}</h1>
          {statusLabel ? (
            <output className="text-muted-foreground truncate text-xs">{statusLabel}</output>
          ) : null}
        </div>
        {canCancel && active ? (
          <Hint label={labels.cancel} side="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={labels.cancel}
              disabled={cancelling}
              onClick={onCancel}
            >
              {cancelling ? (
                <Loading className="size-4" />
              ) : (
                <Square className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </Hint>
        ) : null}
      </header>

      {active ? (
        <Progress
          value={state.status === 'queued' ? 0 : state.progress * 100}
          aria-label={statusLabel ?? labels.statusRunning}
          className="h-0.5 shrink-0 rounded-none"
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {failed ? (
          <div className="grid min-h-64 place-items-center text-center">
            <div className="max-w-sm space-y-3">
              <Ban className="text-destructive mx-auto size-6" aria-hidden="true" />
              <p className="text-sm font-medium">{operationErrorMessage ?? labels.statusFailed}</p>
              {errorCode ? (
                <code className="text-muted-foreground block text-xs">{errorCode}</code>
              ) : null}
              <Button type="button" variant="outline" size="lg" onClick={onRetry}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {labels.retry}
              </Button>
            </div>
          </div>
        ) : results.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {results.map((result, index) => (
              <article
                key={result.assetId}
                className="border-border bg-muted outline-foreground/10 group relative aspect-square min-w-0 overflow-hidden rounded-md border outline outline-1 -outline-offset-1"
              >
                {result.previewUrl ? (
                  // The URL is short lived and held only in the connected page's memory.
                  // eslint-disable-next-line @next/next/no-img-element -- Expiring signed URLs cannot use the configured Next image loader.
                  <img
                    src={result.previewUrl}
                    alt={`${labels.resultAlt} ${index + 1}`}
                    className="size-full object-cover"
                  />
                ) : (
                  <div className="text-muted-foreground grid size-full place-items-center">
                    <Loading className="size-5" />
                  </div>
                )}
                <div className="bg-background/90 absolute right-2 bottom-2 flex h-10 items-center gap-1 rounded-md p-0.5 shadow-sm backdrop-blur-sm">
                  <Hint label={labels.download} side="top">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      aria-label={labels.download}
                      onClick={() => onDownload(result.assetId)}
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                    </Button>
                  </Hint>
                  <Hint label={labels.reuseReference} side="top">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      aria-label={labels.reuseReference}
                      onClick={() => onReuseReference(result.assetId)}
                    >
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                    </Button>
                  </Hint>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground grid min-h-64 place-items-center text-center text-sm">
            <div className="space-y-3">
              {active || recovering ? (
                <Loading className="mx-auto size-6" />
              ) : (
                <ImageIcon className="mx-auto size-6" aria-hidden="true" />
              )}
              <p>{statusLabel ?? labels.noResults}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
