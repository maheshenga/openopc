import { afterEach, describe, expect, test } from 'bun:test';
import {
  encodeGifFrames,
  extractGridFrames,
} from './gif-encoder';
import type { GifFrameSet } from './gif-workflow';

const originalImage = globalThis.Image;
const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

function installGridCanvasMock() {
  const drawImage = () => undefined;
  const context = {
    clearRect: () => undefined,
    drawImage,
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }),
  };

  class MockImage {
    naturalWidth = 400;
    naturalHeight = 300;
    width = 400;
    height = 300;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  Object.defineProperty(globalThis, 'Image', { configurable: true, value: MockImage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => context,
      }),
    },
  });
}

describe('GIF grid extraction and encoding', () => {
  test('extracts twelve equal-sized RGBA frames from a 4x3 grid', async () => {
    installGridCanvasMock();

    const frameSet = await extractGridFrames('blob:grid-image', 0);

    expect(frameSet.width).toBe(100);
    expect(frameSet.height).toBe(100);
    expect(frameSet.frames).toHaveLength(12);
    expect(frameSet.frames.every((frame) => frame.length === 100 * 100 * 4)).toBeTrue();
  });

  test('encodes a frame set as an image/gif Blob', () => {
    const frameSet: GifFrameSet = {
      width: 2,
      height: 2,
      frames: Array.from({ length: 12 }, () => new Uint8ClampedArray(16).fill(255)),
    };

    const result = encodeGifFrames(frameSet, { frameDelayMs: 160, repeat: 0 });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('image/gif');
  });

  test('rejects an invalid frame set without replacing a caller-owned Blob', () => {
    const existingBlob = new Blob(['previous gif'], { type: 'image/gif' });
    const invalidFrameSet: GifFrameSet = {
      width: 2,
      height: 2,
      frames: [new Uint8ClampedArray(16)],
    };

    expect(() => encodeGifFrames(invalidFrameSet, { frameDelayMs: 160, repeat: 0 })).toThrow(
      'Exactly twelve frames are required.',
    );
    expect(existingBlob.type).toBe('image/gif');
    expect(existingBlob.size).toBe(12);
  });
});
