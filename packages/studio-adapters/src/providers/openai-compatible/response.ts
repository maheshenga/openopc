import { createHash } from 'node:crypto';
import {
  type StudioProviderAsset,
  StudioProviderCallError,
  type StudioProviderResult,
} from '@kortix/studio-runtime';
import type { Response } from 'undici/index.js';
import {
  type StudioImageMimeType,
  StudioImageValidationError,
  validateStudioImage,
} from '../../media/image';

export const OPENAI_COMPATIBLE_MAX_JSON_BYTES = 128 * 1024 * 1024;
export const OPENAI_COMPATIBLE_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const OPENAI_COMPATIBLE_MAX_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024;

export type OpenAiCompatibleOutputFetcher = (url: URL) => Promise<Response>;

export async function parseOpenAiCompatibleImageResponse(input: {
  response: Response;
  expectedOutputCount: number;
  fetchOutput?: OpenAiCompatibleOutputFetcher;
  now?: () => number;
}): Promise<StudioProviderResult> {
  const bytes = await readResponseBytes(input.response, OPENAI_COMPATIBLE_MAX_JSON_BYTES, 'json');
  const contentType = normalizedContentType(input.response.headers.get('content-type'));
  if (contentType !== 'application/json') throw terminalAssetError('STUDIO_ASSET_INVALID');

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.data)) {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  if (
    !Number.isInteger(input.expectedOutputCount) ||
    input.expectedOutputCount < 1 ||
    input.expectedOutputCount > 8 ||
    decoded.data.length !== input.expectedOutputCount
  ) {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }

  const assets: StudioProviderAsset[] = [];
  const sizes: number[] = [];
  const now = input.now ?? Date.now;
  for (const [index, item] of decoded.data.entries()) {
    if (!isRecord(item)) throw terminalAssetError('STUDIO_ASSET_INVALID');
    const encoded =
      typeof item.b64_json === 'string' && item.b64_json.length > 0 ? item.b64_json : null;
    const rawUrl = typeof item.url === 'string' && item.url.length > 0 ? item.url : null;
    if ((encoded === null) === (rawUrl === null)) {
      throw terminalAssetError('STUDIO_ASSET_INVALID');
    }

    const asset = encoded
      ? await createBase64Asset(encoded, index)
      : await createUrlAsset(rawUrl as string, index, input.fetchOutput, now);
    sizes.push(asset.size_bytes);
    assertOpenAiCompatibleOutputBudget(sizes);
    assets.push(asset);
  }
  return { assets };
}

export function assertOpenAiCompatibleOutputBudget(sizes: readonly number[]): void {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0) throw terminalAssetError('STUDIO_ASSET_INVALID');
    total += size;
    if (!Number.isSafeInteger(total) || total > OPENAI_COMPATIBLE_MAX_TOTAL_OUTPUT_BYTES) {
      throw terminalAssetError('STUDIO_ASSET_TOO_LARGE');
    }
  }
}

async function createBase64Asset(encoded: string, index: number): Promise<StudioProviderAsset> {
  const bytes = decodeStrictBase64(encoded);
  const media = await validateBytes(bytes);
  return {
    kind: 'image',
    filename: filename(index, media.mimeType),
    mime_type: media.mimeType,
    size_bytes: bytes.byteLength,
    replayable_within_attempt: true,
    async openBody() {
      return byteStream(bytes.slice());
    },
  };
}

async function createUrlAsset(
  rawUrl: string,
  index: number,
  fetchOutput: OpenAiCompatibleOutputFetcher | undefined,
  now: () => number,
): Promise<StudioProviderAsset> {
  if (!fetchOutput) throw terminalAssetError('STUDIO_ASSET_INVALID');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.hostname === ''
  ) {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  const expiresAt = outputExpiry(url);
  if (expiresAt === null || expiresAt <= now()) {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }

  const initial = await fetchAndValidateUrlAsset(url, fetchOutput, false);
  const initialMimeType = initial.mimeType;
  const initialSize = initial.bytes.byteLength;
  const initialHash = sha256(initial.bytes);
  return {
    kind: 'image',
    filename: filename(index, initialMimeType),
    mime_type: initialMimeType,
    size_bytes: initialSize,
    replayable_within_attempt: true,
    async openBody() {
      if (now() >= expiresAt) {
        throw new StudioProviderCallError('unknown_outcome', 'STUDIO_PROVIDER_OUTPUT_UNAVAILABLE');
      }
      const replay = await fetchAndValidateUrlAsset(url, fetchOutput, true);
      if (
        replay.mimeType !== initialMimeType ||
        replay.bytes.byteLength !== initialSize ||
        sha256(replay.bytes) !== initialHash
      ) {
        throw new StudioProviderCallError('unknown_outcome', 'STUDIO_PROVIDER_OUTPUT_CHANGED');
      }
      return byteStream(replay.bytes);
    },
  };
}

async function fetchAndValidateUrlAsset(
  url: URL,
  fetchOutput: OpenAiCompatibleOutputFetcher,
  replay: boolean,
): Promise<{ bytes: Uint8Array; mimeType: StudioImageMimeType }> {
  let response: Response;
  try {
    response = await fetchOutput(url);
  } catch {
    throw new StudioProviderCallError('unknown_outcome', 'STUDIO_PROVIDER_OUTPUT_UNAVAILABLE');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new StudioProviderCallError('unknown_outcome', 'STUDIO_PROVIDER_OUTPUT_UNAVAILABLE');
  }
  try {
    const bytes = await readResponseBytes(response, OPENAI_COMPATIBLE_MAX_IMAGE_BYTES, 'image');
    const mimeType = normalizedContentType(response.headers.get('content-type'));
    if (!isStudioImageMimeType(mimeType))
      throw new StudioImageValidationError('STUDIO_ASSET_INVALID');
    const media = await validateStudioImage({ bytes, mimeType });
    return { bytes, mimeType: media.mimeType };
  } catch (error) {
    if (replay) {
      throw new StudioProviderCallError('unknown_outcome', 'STUDIO_PROVIDER_OUTPUT_UNAVAILABLE');
    }
    if (error instanceof StudioProviderCallError) throw error;
    if (error instanceof StudioImageValidationError) throw terminalAssetError(error.code);
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
}

function decodeStrictBase64(encoded: string): Uint8Array {
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength > OPENAI_COMPATIBLE_MAX_IMAGE_BYTES) {
    throw terminalAssetError('STUDIO_ASSET_TOO_LARGE');
  }
  const contentLength = encoded.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = encoded.charCodeAt(index);
    const base64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!base64Character) throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  for (let index = contentLength; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 0x3d) throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (bytes.byteLength !== decodedLength || Buffer.from(bytes).toString('base64') !== encoded) {
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
  return bytes;
}

async function validateBytes(
  bytes: Uint8Array,
): Promise<{ mimeType: StudioImageMimeType; sizeBytes: number }> {
  const mimeType = detectMimeType(bytes);
  if (!mimeType) throw terminalAssetError('STUDIO_ASSET_INVALID');
  try {
    return await validateStudioImage({ bytes, mimeType });
  } catch (error) {
    if (error instanceof StudioImageValidationError) throw terminalAssetError(error.code);
    throw terminalAssetError('STUDIO_ASSET_INVALID');
  }
}

async function readResponseBytes(
  response: Response,
  maximum: number,
  kind: 'json' | 'image',
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw terminalAssetError('STUDIO_ASSET_INVALID');
    }
    if (declared > maximum) throw terminalAssetError('STUDIO_ASSET_TOO_LARGE');
  }
  if (!response.body) throw terminalAssetError('STUDIO_ASSET_INVALID');

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw terminalAssetError('STUDIO_ASSET_TOO_LARGE');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof StudioProviderCallError) throw error;
    throw new StudioProviderCallError(
      kind === 'image' ? 'unknown_outcome' : 'terminal',
      kind === 'image' ? 'STUDIO_PROVIDER_OUTPUT_UNAVAILABLE' : 'STUDIO_ASSET_INVALID',
    );
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function outputExpiry(url: URL): number | null {
  const parameters = new Map<string, string>();
  for (const [key, value] of url.searchParams) parameters.set(key.toLowerCase(), value);
  const candidates: number[] = [];
  for (const key of ['expires', 'exp']) {
    const value = parameters.get(key);
    if (value && /^\d{1,16}$/.test(value)) {
      const numeric = Number(value);
      if (Number.isSafeInteger(numeric)) candidates.push(numeric > 1e12 ? numeric : numeric * 1000);
    }
  }
  const signedEnd = parameters.get('se');
  if (signedEnd) {
    const parsed = Date.parse(signedEnd);
    if (!Number.isNaN(parsed)) candidates.push(parsed);
  }
  for (const prefix of ['x-amz', 'x-goog']) {
    const signedAt = parameters.get(`${prefix}-date`);
    const validFor = parameters.get(`${prefix}-expires`);
    const parsedAt = signedAt ? parseBasicIsoDate(signedAt) : null;
    if (parsedAt !== null && validFor && /^\d{1,7}$/.test(validFor)) {
      const seconds = Number(validFor);
      if (Number.isSafeInteger(seconds)) candidates.push(parsedAt + seconds * 1000);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function parseBasicIsoDate(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const parsed = Date.UTC(
    parts[0] as number,
    (parts[1] as number) - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5],
  );
  return Number.isNaN(parsed) ? null : parsed;
}

function detectMimeType(bytes: Uint8Array): StudioImageMimeType | null {
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
  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function normalizedContentType(value: string | null): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isStudioImageMimeType(value: string): value is StudioImageMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

function filename(index: number, mimeType: StudioImageMimeType): string {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  return `studio-image-${index + 1}.${extension}`;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function terminalAssetError(
  code: 'STUDIO_ASSET_INVALID' | 'STUDIO_ASSET_TOO_LARGE',
): StudioProviderCallError {
  return new StudioProviderCallError('terminal', code);
}
