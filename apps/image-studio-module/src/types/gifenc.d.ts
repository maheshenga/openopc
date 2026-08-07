declare module 'gifenc' {
  export interface GIFEncoderInstance {
    finish(): void;
    bytes(): Uint8Array;
    writeFrame(
      indexedPixels: Uint8Array | Uint8ClampedArray,
      width: number,
      height: number,
      options?: {
        palette?: number[][] | null;
        repeat?: number;
        delay?: number;
        dispose?: number;
      },
    ): void;
  }

  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GIFEncoderInstance;
  export function quantize(
    data: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' },
  ): number[][];
  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
