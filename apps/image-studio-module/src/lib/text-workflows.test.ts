import { describe, expect, test } from 'bun:test';
import type { OpenOpcModel } from '@openopc/developer-sdk';
import {
  buildAgentMessages,
  buildPromptOptimizationMessages,
  buildReversePromptMessages,
  selectImageModelWhenReady,
  selectTextModel,
  selectTextModelWhenReady,
} from './text-workflows';

const models: OpenOpcModel[] = [
  { id: 'text-only', object: 'model', owned_by: 'openopc' },
  { id: 'vision', object: 'model', owned_by: 'openopc', attachment: true },
];

describe('selectTextModel', () => {
  test('keeps an eligible current model and falls back deterministically', () => {
    expect(selectTextModel(models, 'text-only')).toBe('text-only');
    expect(selectTextModel(models, 'missing')).toBe('text-only');
    expect(selectTextModel(models, 'text-only', { requireAttachment: true })).toBe('vision');
    expect(selectTextModel(models.slice(0, 1), '', { requireAttachment: true })).toBe('');
  });

  test('does not replace a persisted selection before models finish loading', () => {
    expect(selectTextModelWhenReady([], 'vision', false, { requireAttachment: true })).toBe('vision');
    expect(selectTextModelWhenReady([], 'vision', true, { requireAttachment: true })).toBe('');
  });

  test('keeps image model selection until the image model list is ready', () => {
    const models = [{ id: 'image-a' }, { id: 'image-b' }];
    expect(selectImageModelWhenReady([], 'image-b', false)).toBe('image-b');
    expect(selectImageModelWhenReady(models, 'image-b', true)).toBe('image-b');
    expect(selectImageModelWhenReady(models, 'missing', true)).toBe('image-a');
    expect(selectImageModelWhenReady([], 'image-b', true)).toBe('');
  });
});

describe('text workflow messages', () => {
  test('adds image references only to the latest user turn', () => {
    const messages = buildAgentMessages(
      [
        { role: 'user', content: 'first idea' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'refine it' },
      ],
      ['data:image/png;base64,AAAA'],
    );

    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toBe('first idea');
    expect(messages[3]?.content).toEqual([
      { type: 'text', text: 'refine it' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  test('builds focused optimizer and reverse-image requests', () => {
    const optimizer = buildPromptOptimizationMessages('  quiet library  ');
    const reverse = buildReversePromptMessages('data:image/webp;base64,BBBB');

    expect(optimizer[1]).toEqual({ role: 'user', content: 'quiet library' });
    expect(reverse[1]?.content).toEqual([
      { type: 'text', text: 'Analyze this image and reconstruct the prompt.' },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,BBBB' } },
    ]);
  });
});
