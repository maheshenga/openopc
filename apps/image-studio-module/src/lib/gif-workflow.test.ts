import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GIF_DRAFT,
  gifRepeatValue,
  isGifDraft,
  normalizeGifDraft,
} from './gif-workflow';

describe('GIF draft helpers', () => {
  test('rejects malformed draft values', () => {
    expect(isGifDraft(null)).toBeFalse();
    expect(isGifDraft({ ...DEFAULT_GIF_DRAFT, sourceAssetId: 1 })).toBeFalse();
    expect(isGifDraft({ ...DEFAULT_GIF_DRAFT, frameDelayMs: 79 })).toBeFalse();
    expect(isGifDraft({ ...DEFAULT_GIF_DRAFT, framePaddingPercent: 5.1 })).toBeFalse();
    expect(isGifDraft({ ...DEFAULT_GIF_DRAFT, loopCount: 4 })).toBeFalse();
  });

  test('normalizes draft values without retaining unknown fields', () => {
    const normalized = normalizeGifDraft({
      sourceAssetId: 'asset-1',
      prompt: 'orbiting object',
      model: 'model-1',
      closedLoop: false,
      frameDelayMs: 40,
      framePaddingPercent: 8,
      loopCount: 4,
      ignored: 'discard me',
    });

    expect(normalized).toEqual({
      sourceAssetId: 'asset-1',
      prompt: 'orbiting object',
      model: 'model-1',
      closedLoop: false,
      frameDelayMs: 80,
      framePaddingPercent: 5,
      loopCount: 0,
    });
    expect(normalized).not.toBe(DEFAULT_GIF_DRAFT);
    expect('ignored' in normalized).toBeFalse();
  });

  test('clamps the upper draft bounds and preserves only allowed loop counts', () => {
    const normalized = normalizeGifDraft({
      ...DEFAULT_GIF_DRAFT,
      frameDelayMs: 900,
      framePaddingPercent: -1,
      loopCount: 5,
    });

    expect(normalized.frameDelayMs).toBe(800);
    expect(normalized.framePaddingPercent).toBe(0);
    expect(normalized.loopCount).toBe(5);
  });

  test('uses defaults for malformed fields and returns a fresh object', () => {
    const normalized = normalizeGifDraft({
      sourceAssetId: 3,
      prompt: false,
      model: null,
      closedLoop: 'yes',
      frameDelayMs: Number.NaN,
      framePaddingPercent: Number.POSITIVE_INFINITY,
      loopCount: 4,
    });

    expect(normalized).toEqual(DEFAULT_GIF_DRAFT);
    expect(normalized).not.toBe(DEFAULT_GIF_DRAFT);
  });

  test('maps looping modes to gif repeat values', () => {
    expect(gifRepeatValue(true, 0)).toBe(0);
    expect(gifRepeatValue(true, 1)).toBe(0);
    expect(gifRepeatValue(true, 3)).toBe(2);
    expect(gifRepeatValue(false, 5)).toBe(-1);
  });

  test('accepts a persisted source asset as a restore candidate', () => {
    const persisted = { ...DEFAULT_GIF_DRAFT, sourceAssetId: 'asset-123' };

    expect(isGifDraft(persisted)).toBeTrue();
    expect(normalizeGifDraft(persisted).sourceAssetId).toBe('asset-123');
  });

  test('resets frame settings while retaining prompt, model, and source asset', () => {
    const draft = {
      ...DEFAULT_GIF_DRAFT,
      sourceAssetId: 'asset-123',
      prompt: 'a wave',
      model: 'model-1',
      closedLoop: false,
      frameDelayMs: 800,
      framePaddingPercent: 5,
      loopCount: 5 as const,
    };
    const reset = {
      ...DEFAULT_GIF_DRAFT,
      prompt: draft.prompt,
      model: draft.model,
      sourceAssetId: draft.sourceAssetId,
    };

    expect(reset).toEqual({
      ...DEFAULT_GIF_DRAFT,
      sourceAssetId: 'asset-123',
      prompt: 'a wave',
      model: 'model-1',
    });
    expect(gifRepeatValue(reset.closedLoop, reset.loopCount)).toBe(0);
  });
});
