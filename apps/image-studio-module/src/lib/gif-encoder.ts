import { GIFEncoder, applyPalette, quantize } from 'gifenc';

const GRID_COLS = 4;
const GRID_ROWS = 3;

export interface EncodeGifOptions {
  frameDelayMs: number;
  repeat: number;
  framePaddingPercent?: number;
}

interface FrameSource {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load the generated sprite sheet.'));
    image.src = src;
  });
}

function frameSources(width: number, height: number, paddingPercent: number): {
  sources: FrameSource[];
  cellWidth: number;
  cellHeight: number;
} {
  const baseWidth = Math.floor(width / GRID_COLS);
  const baseHeight = Math.floor(height / GRID_ROWS);
  if (baseWidth <= 0 || baseHeight <= 0) throw new Error('The sprite sheet is too small.');
  const padding = Math.max(0, Math.min(5, paddingPercent));
  const insetX = Math.round((baseWidth * padding) / 100);
  const insetY = Math.round((baseHeight * padding) / 100);
  const cellWidth = Math.max(8, baseWidth - insetX * 2);
  const cellHeight = Math.max(8, baseHeight - insetY * 2);
  const sources: FrameSource[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      sources.push({
        sx: col * baseWidth + insetX,
        sy: row * baseHeight + insetY,
        sw: cellWidth,
        sh: cellHeight,
      });
    }
  }
  return { sources, cellWidth, cellHeight };
}

function encodeFrames(frames: Uint8ClampedArray[], width: number, height: number, options: EncodeGifOptions): Blob {
  if (frames.length === 0) throw new Error('No frames are available.');
  const pixelsPerFrame = width * height * 4;
  const merged = new Uint8ClampedArray(pixelsPerFrame * frames.length);
  frames.forEach((frame, index) => merged.set(frame, index * pixelsPerFrame));
  const palette = quantize(merged, 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  frames.forEach((frame, index) => {
    const indexed = applyPalette(frame, palette);
    gif.writeFrame(indexed, width, height, {
      ...(index === 0 ? { palette, repeat: options.repeat } : {}),
      delay: options.frameDelayMs,
      dispose: 2,
    });
  });
  gif.finish();
  return new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
}

export async function encodeGifFromGrid(
  gridImageUrl: string,
  options: EncodeGifOptions,
): Promise<Blob> {
  const image = await loadImageElement(gridImageUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const { sources, cellWidth, cellHeight } = frameSources(
    width,
    height,
    options.framePaddingPercent ?? 0,
  );
  const canvas = document.createElement('canvas');
  canvas.width = cellWidth;
  canvas.height = cellHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable.');
  const frames = sources.map((source) => {
    context.clearRect(0, 0, cellWidth, cellHeight);
    context.drawImage(image, source.sx, source.sy, source.sw, source.sh, 0, 0, cellWidth, cellHeight);
    return context.getImageData(0, 0, cellWidth, cellHeight).data;
  });
  return encodeFrames(frames, cellWidth, cellHeight, options);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
