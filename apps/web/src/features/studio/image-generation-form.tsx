'use client';

import type { IntelligenceExecutionTarget, IntelligenceImageEstimate } from '@kortix/sdk';
import { ImagePlus, Minus, Plus, Sparkles, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import type { IntelligenceImageFormState } from './image-input';

export interface ImageStudioReference {
  assetId: string;
  previewUrl?: string;
}

export interface ImageGenerationFormLabels {
  prompt: string;
  promptPlaceholder: string;
  negativePrompt: string;
  negativePromptPlaceholder: string;
  provider: string;
  model: string;
  aspectRatio: string;
  quality: string;
  qualityStandard: string;
  qualityHigh: string;
  outputCount: string;
  decreaseOutputCount: string;
  increaseOutputCount: string;
  references: string;
  addReference: string;
  removeReference: string;
  uploadingReference: string;
  estimate: string;
  estimating: string;
  credits: string;
  generate: string;
  generating: string;
}

export interface ImageGenerationFormProps {
  targets: readonly IntelligenceExecutionTarget[];
  form: IntelligenceImageFormState;
  references: readonly ImageStudioReference[];
  estimate: IntelligenceImageEstimate | null;
  estimating: boolean;
  validationMessage: string | null;
  submitting: boolean;
  uploadingReference: boolean;
  labels: ImageGenerationFormLabels;
  onPromptChange(value: string): void;
  onNegativePromptChange(value: string): void;
  onProviderChange(providerConfigId: string): void;
  onModelChange(model: string): void;
  onAspectRatioChange(value: IntelligenceImageFormState['aspectRatio']): void;
  onQualityChange(value: IntelligenceImageFormState['quality']): void;
  onOutputCountChange(value: number): void;
  onReferenceFiles(files: readonly File[]): void;
  onRemoveReference(assetId: string): void;
  onGenerate(): void;
}

const ASPECT_RATIOS: readonly IntelligenceImageFormState['aspectRatio'][] = [
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
];

function compactProviderId(providerConfigId: string): string {
  if (providerConfigId.length <= 18) return providerConfigId;
  return `${providerConfigId.slice(0, 8)}...${providerConfigId.slice(-4)}`;
}

function SegmentedButton({
  active,
  disabled,
  children,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  children: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-kortix-base h-10 min-w-0 rounded-md px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-[0.6px] disabled:pointer-events-none disabled:opacity-50',
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

export function ImageGenerationForm({
  targets,
  form,
  references,
  estimate,
  estimating,
  validationMessage,
  submitting,
  uploadingReference,
  labels,
  onPromptChange,
  onNegativePromptChange,
  onProviderChange,
  onModelChange,
  onAspectRatioChange,
  onQualityChange,
  onOutputCountChange,
  onReferenceFiles,
  onRemoveReference,
  onGenerate,
}: ImageGenerationFormProps) {
  const providers = [...new Set(targets.map((target) => target.provider_config_id))];
  const models = targets.filter((target) => target.provider_config_id === form.providerConfigId);
  const controlsDisabled = submitting;
  const canGenerate = !validationMessage && !!estimate && !estimating && !submitting;

  return (
    <form
      className="border-border flex min-h-0 flex-col gap-5 overflow-y-auto border-b px-4 py-4 md:border-r md:border-b-0 md:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canGenerate) onGenerate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="image-studio-prompt">{labels.prompt}</Label>
        <Textarea
          id="image-studio-prompt"
          value={form.prompt}
          minHeight={116}
          maxHeight={240}
          maxLength={8000}
          placeholder={labels.promptPlaceholder}
          disabled={controlsDisabled}
          aria-invalid={validationMessage ? true : undefined}
          onChange={(event) => onPromptChange(event.target.value)}
        />
        {validationMessage ? (
          <p className="text-destructive text-xs" role="alert">
            {validationMessage}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="image-studio-negative-prompt">{labels.negativePrompt}</Label>
        <Textarea
          id="image-studio-negative-prompt"
          value={form.negativePrompt ?? ''}
          minHeight={68}
          maxHeight={160}
          maxLength={4000}
          placeholder={labels.negativePromptPlaceholder}
          disabled={controlsDisabled}
          onChange={(event) => onNegativePromptChange(event.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="image-studio-provider">{labels.provider}</Label>
          <select
            id="image-studio-provider"
            value={form.providerConfigId}
            disabled={controlsDisabled || providers.length === 0}
            onChange={(event) => onProviderChange(event.target.value)}
            className="border-border bg-input text-foreground focus:border-kortix-blue h-10 w-full min-w-0 rounded-md border px-2 text-sm outline-none disabled:opacity-50"
          >
            {providers.map((providerConfigId) => (
              <option key={providerConfigId} value={providerConfigId}>
                {compactProviderId(providerConfigId)}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="image-studio-model">{labels.model}</Label>
          <select
            id="image-studio-model"
            value={form.model}
            disabled={controlsDisabled || models.length === 0}
            onChange={(event) => onModelChange(event.target.value)}
            className="border-border bg-input text-foreground focus:border-kortix-blue h-10 w-full min-w-0 rounded-md border px-2 text-sm outline-none disabled:opacity-50"
          >
            {models.map((target) => (
              <option key={`${target.provider_config_id}:${target.model}`} value={target.model}>
                {target.model}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-muted-foreground text-sm font-medium">{labels.aspectRatio}</legend>
        <div className="bg-foreground/5 grid grid-cols-5 gap-0.5 rounded-md p-0.5">
          {ASPECT_RATIOS.map((ratio) => (
            <SegmentedButton
              key={ratio}
              active={form.aspectRatio === ratio}
              disabled={controlsDisabled}
              onClick={() => onAspectRatioChange(ratio)}
            >
              {ratio}
            </SegmentedButton>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3">
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-muted-foreground text-sm font-medium">{labels.quality}</legend>
          <div className="bg-foreground/5 grid grid-cols-2 gap-0.5 rounded-md p-0.5">
            <SegmentedButton
              active={form.quality === 'standard'}
              disabled={controlsDisabled}
              onClick={() => onQualityChange('standard')}
            >
              {labels.qualityStandard}
            </SegmentedButton>
            <SegmentedButton
              active={form.quality === 'high'}
              disabled={controlsDisabled}
              onClick={() => onQualityChange('high')}
            >
              {labels.qualityHigh}
            </SegmentedButton>
          </div>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="image-studio-output-count">{labels.outputCount}</Label>
          <div className="border-border grid h-10 grid-cols-[40px_1fr_40px] items-center rounded-md border">
            <Hint label={labels.decreaseOutputCount} side="top">
              <button
                type="button"
                aria-label={labels.decreaseOutputCount}
                disabled={controlsDisabled || form.outputCount <= 1}
                onClick={() => onOutputCountChange(form.outputCount - 1)}
                className="hover:bg-foreground/5 grid size-10 place-items-center rounded-l-md disabled:opacity-40"
              >
                <Minus className="size-3.5" aria-hidden="true" />
              </button>
            </Hint>
            <Input
              id="image-studio-output-count"
              type="number"
              min={1}
              max={8}
              value={form.outputCount}
              disabled={controlsDisabled}
              onChange={(event) => onOutputCountChange(Number(event.target.value))}
              className="h-9 [appearance:textfield] rounded-none border-0 px-1 text-center tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <Hint label={labels.increaseOutputCount} side="top">
              <button
                type="button"
                aria-label={labels.increaseOutputCount}
                disabled={controlsDisabled || form.outputCount >= 8}
                onClick={() => onOutputCountChange(form.outputCount + 1)}
                className="hover:bg-foreground/5 grid size-10 place-items-center rounded-r-md disabled:opacity-40"
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            </Hint>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex min-h-10 items-center justify-between gap-2">
          <Label>{labels.references}</Label>
          <Hint label={labels.addReference} side="top">
            <label
              className={cn(
                'border-border hover:bg-foreground/5 flex h-10 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium',
                (controlsDisabled || uploadingReference || references.length >= 8) &&
                  'pointer-events-none opacity-50',
              )}
            >
              {uploadingReference ? (
                <Loading className="size-3.5" />
              ) : (
                <ImagePlus className="size-3.5" aria-hidden="true" />
              )}
              <span>{uploadingReference ? labels.uploadingReference : labels.addReference}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="sr-only"
                aria-label={labels.addReference}
                disabled={controlsDisabled || uploadingReference || references.length >= 8}
                onChange={(event) => {
                  onReferenceFiles(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </label>
          </Hint>
        </div>
        {references.length > 0 ? (
          <div className="grid grid-cols-4 gap-2">
            {references.map((reference) => (
              <div
                key={reference.assetId}
                className="border-border bg-muted outline-foreground/10 relative aspect-square overflow-hidden rounded-md border outline outline-1 -outline-offset-1"
              >
                {reference.previewUrl ? (
                  // Signed preview URLs remain in component memory and are never persisted.
                  // eslint-disable-next-line @next/next/no-img-element -- Expiring signed URLs cannot use the configured Next image loader.
                  <img src={reference.previewUrl} alt="" className="size-full object-cover" />
                ) : (
                  <ImagePlus
                    className="text-muted-foreground absolute inset-0 m-auto size-5"
                    aria-hidden="true"
                  />
                )}
                <Hint label={labels.removeReference} side="top">
                  <button
                    type="button"
                    aria-label={labels.removeReference}
                    disabled={controlsDisabled}
                    onClick={() => onRemoveReference(reference.assetId)}
                    className="bg-background/85 hover:bg-background absolute top-1 right-1 grid size-10 place-items-center rounded-md shadow-sm backdrop-blur-sm"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </Hint>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-auto space-y-3 pt-1">
        <div className="border-border flex h-10 items-center justify-between gap-3 border-y text-sm">
          <span className="text-muted-foreground">{labels.estimate}</span>
          <span className="font-medium tabular-nums">
            {estimating ? (
              <span className="text-muted-foreground inline-flex items-center gap-1.5">
                <Loading className="size-3.5" />
                {labels.estimating}
              </span>
            ) : estimate ? (
              `${estimate.max_approved_credits} ${labels.credits}`
            ) : (
              '-'
            )}
          </span>
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={!canGenerate}>
          {submitting ? (
            <Loading className="size-4" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          {submitting ? labels.generating : labels.generate}
        </Button>
      </div>
    </form>
  );
}
