import type {
  IntelligenceCreateUploadRequest,
  IntelligenceStudioAsset,
  IntelligenceStudioUpload,
} from '@kortix/sdk';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface ReferenceImageFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadReferenceImageInput {
  file: ReferenceImageFile;
  createUpload(input: IntelligenceCreateUploadRequest): Promise<IntelligenceStudioUpload>;
  finalizeUpload(uploadId: string): Promise<IntelligenceStudioAsset>;
  fetch?: typeof fetch;
}

export async function uploadReferenceImage(
  input: UploadReferenceImageInput,
): Promise<IntelligenceStudioAsset> {
  const { file } = input;
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) throw new Error('REFERENCE_IMAGE_TYPE_UNSUPPORTED');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    throw new Error('REFERENCE_IMAGE_SIZE_INVALID');
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error('REFERENCE_IMAGE_SIZE_INVALID');
  const checksum = await sha256Hex(bytes);
  const request = await input.createUpload({
    declared_mime_type: file.type,
    expected_size_bytes: bytes.byteLength,
    expected_checksum_sha256: checksum,
    metadata: { filename: safeFilename(file.name) },
  });

  const response = await (input.fetch ?? globalThis.fetch)(request.signed_upload_url, {
    method: 'PUT',
    headers: request.signed_upload_headers,
    body: bytes,
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`REFERENCE_UPLOAD_FAILED_${response.status}`);
  return input.finalizeUpload(request.upload_id);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeFilename(value: string): string {
  const basename = value.replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  const sanitized = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? '_' : character;
  })
    .slice(0, 180)
    .join('');
  return sanitized || 'reference-image';
}
