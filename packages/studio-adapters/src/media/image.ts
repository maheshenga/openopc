import sharp from 'sharp';

export type StudioImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type StudioImageValidationErrorCode = 'STUDIO_ASSET_INVALID' | 'STUDIO_ASSET_TOO_LARGE';

export interface ValidatedStudioImage {
  mimeType: StudioImageMimeType;
  width: number;
  height: number;
  sizeBytes: number;
}

export class StudioImageValidationError extends Error {
  constructor(readonly code: StudioImageValidationErrorCode) {
    super(code);
    this.name = 'StudioImageValidationError';
  }
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 100_000_000;

export async function validateStudioImage(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<ValidatedStudioImage> {
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new StudioImageValidationError('STUDIO_ASSET_TOO_LARGE');
  }
  if (input.bytes.byteLength === 0 || containsMarkupPrefix(input.bytes)) {
    throw new StudioImageValidationError('STUDIO_ASSET_INVALID');
  }

  const detectedMimeType = detectImageMimeType(input.bytes);
  if (!detectedMimeType || input.mimeType !== detectedMimeType) {
    throw new StudioImageValidationError('STUDIO_ASSET_INVALID');
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await sharp(input.bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch (error) {
    if (isPixelLimitError(error)) {
      throw new StudioImageValidationError('STUDIO_ASSET_TOO_LARGE');
    }
    throw new StudioImageValidationError('STUDIO_ASSET_INVALID');
  }

  const expectedFormat =
    detectedMimeType === 'image/png' ? 'png' : detectedMimeType === 'image/jpeg' ? 'jpeg' : 'webp';
  const width = metadata.width;
  const height = metadata.height;
  if (
    metadata.format !== expectedFormat ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    throw new StudioImageValidationError('STUDIO_ASSET_INVALID');
  }
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new StudioImageValidationError('STUDIO_ASSET_TOO_LARGE');
  }

  return {
    mimeType: detectedMimeType,
    width,
    height,
    sizeBytes: input.bytes.byteLength,
  };
}

function detectImageMimeType(bytes: Uint8Array): StudioImageMimeType | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function containsMarkupPrefix(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .trimStart()
    .toLowerCase();
  return (
    prefix.startsWith('<svg') ||
    prefix.startsWith('<?xml') ||
    prefix.startsWith('<!doctype html') ||
    prefix.startsWith('<html')
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit|too many pixels/i.test(error.message);
}
