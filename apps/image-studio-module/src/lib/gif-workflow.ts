export type GifLoopCount = 0 | 1 | 2 | 3 | 5;

export interface GifDraft {
  sourceAssetId: string | null;
  prompt: string;
  model: string;
  closedLoop: boolean;
  frameDelayMs: number;
  framePaddingPercent: number;
  loopCount: GifLoopCount;
}

export interface GifFrameSet {
  width: number;
  height: number;
  frames: Uint8ClampedArray[];
}

export const DEFAULT_GIF_DRAFT: GifDraft = {
  sourceAssetId: null,
  prompt: '',
  model: '',
  closedLoop: true,
  frameDelayMs: 160,
  framePaddingPercent: 1,
  loopCount: 0,
};

const GIF_LOOP_COUNTS = [0, 1, 2, 3, 5] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGifLoopCount(value: unknown): value is GifLoopCount {
  return typeof value === 'number' && GIF_LOOP_COUNTS.includes(value as GifLoopCount);
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isGifDraft(value: unknown): value is GifDraft {
  return isRecord(value)
    && (typeof value.sourceAssetId === 'string' || value.sourceAssetId === null)
    && typeof value.prompt === 'string'
    && typeof value.model === 'string'
    && typeof value.closedLoop === 'boolean'
    && isFiniteNumberInRange(value.frameDelayMs, 80, 800)
    && isFiniteNumberInRange(value.framePaddingPercent, 0, 5)
    && isGifLoopCount(value.loopCount);
}

export function normalizeGifDraft(value: unknown): GifDraft {
  const draft = isRecord(value) ? value : {};
  return {
    sourceAssetId: typeof draft.sourceAssetId === 'string' || draft.sourceAssetId === null
      ? draft.sourceAssetId
      : DEFAULT_GIF_DRAFT.sourceAssetId,
    prompt: typeof draft.prompt === 'string' ? draft.prompt : DEFAULT_GIF_DRAFT.prompt,
    model: typeof draft.model === 'string' ? draft.model : DEFAULT_GIF_DRAFT.model,
    closedLoop: typeof draft.closedLoop === 'boolean' ? draft.closedLoop : DEFAULT_GIF_DRAFT.closedLoop,
    frameDelayMs: typeof draft.frameDelayMs === 'number' && Number.isFinite(draft.frameDelayMs)
      ? clamp(draft.frameDelayMs, 80, 800)
      : DEFAULT_GIF_DRAFT.frameDelayMs,
    framePaddingPercent: typeof draft.framePaddingPercent === 'number' && Number.isFinite(draft.framePaddingPercent)
      ? clamp(draft.framePaddingPercent, 0, 5)
      : DEFAULT_GIF_DRAFT.framePaddingPercent,
    loopCount: isGifLoopCount(draft.loopCount) ? draft.loopCount : DEFAULT_GIF_DRAFT.loopCount,
  };
}

export function gifRepeatValue(closedLoop: boolean, loopCount: GifLoopCount): number {
  if (!closedLoop) return -1;
  return loopCount === 0 ? 0 : loopCount - 1;
}
