import { describe, expect, test } from 'bun:test';
import { buildGifPrompt } from './gif-prompt';

describe('buildGifPrompt', () => {
  test('preserves the upstream 4x3 sprite-sheet contract', () => {
    const prompt = buildGifPrompt({
      userPrompt: '  a character waves  ',
      refImageCount: 2,
      closedLoop: true,
    });

    expect(prompt).toContain('exactly 3264x2448 pixels');
    expect(prompt).toContain('exactly 4 columns and 3 rows, 12 panels total');
    expect(prompt).toContain('remaining uploaded images only as visual references');
    expect(prompt).toContain('Make a seamless closed loop');
    expect(prompt).toContain('User intent: a character waves');
  });

  test('can omit the layout and reference instructions for text-only generation', () => {
    const prompt = buildGifPrompt({
      userPrompt: 'a slow turn',
      refImageCount: 0,
      closedLoop: false,
      hasLayoutTemplate: false,
    });

    expect(prompt).not.toContain('layout template only');
    expect(prompt).not.toContain('remaining uploaded images');
    expect(prompt).toContain('linear 12-frame storyboard');
  });
});
