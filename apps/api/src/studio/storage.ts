import type { StudioAsset, StudioErrorCode, StudioUpload } from '@kortix/api-contract';
import {
  StudioImageValidationError,
  type ValidatedStudioImage,
  validateStudioImage,
} from '@kortix/studio-adapters';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  type StudioReferenceAssetResolver,
  StudioStorageUnavailableError,
  type StudioStoredObject,
  createStudioSignedUploadRequest,
} from '@kortix/studio-runtime';
import type { StudioCreateUploadInput, StudioRepository } from './types';

const SIGNED_URL_TTL_SECONDS = 15 * 60;
const PENDING_UPLOAD_TTL_SECONDS = 30 * 60;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

type StudioStorageErrorCode = Extract<
  StudioErrorCode,
  'STUDIO_ASSET_INVALID' | 'STUDIO_ASSET_TOO_LARGE' | 'STUDIO_UPLOAD_EXPIRED'
>;

export class StudioStorageServiceError extends Error {
  constructor(readonly code: StudioStorageErrorCode) {
    super(code);
    this.name = 'StudioStorageServiceError';
  }
}

export interface StudioSignedDownload {
  asset_id: string;
  signed_download_url: string;
  expires_at: string;
}

export function createStudioReferenceAssetResolver(
  repository: Pick<StudioRepository, 'getAsset'>,
  store: StudioObjectStore,
): StudioReferenceAssetResolver {
  return {
    async resolve(input) {
      const references = [];
      for (const assetId of input.assetIds) {
        const asset = await repository.getAsset(input.projectId, assetId);
        const extension = asset ? IMAGE_EXTENSIONS[asset.mime_type] : undefined;
        const keyPrefix = asset ? `accounts/${asset.account_id}/projects/${input.projectId}/` : '';
        if (
          !asset ||
          asset.kind !== 'image' ||
          !extension ||
          asset.bucket !== store.namespace ||
          !isSafeProjectObjectKey(asset.object_key, keyPrefix) ||
          !Number.isSafeInteger(asset.size_bytes) ||
          asset.size_bytes <= 0 ||
          asset.size_bytes > MAX_IMAGE_BYTES ||
          !/^[a-f0-9]{64}$/.test(asset.checksum_sha256)
        ) {
          throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
        }
        references.push({
          kind: 'image' as const,
          filename: `${asset.asset_id}.${extension}`,
          mime_type: asset.mime_type,
          size_bytes: asset.size_bytes,
          replayable_within_attempt: true,
          openBody: async () => {
            await store.assertReady();
            let stored: StudioStoredObject;
            try {
              stored = await store.getObject({ key: asset.object_key });
            } catch (error) {
              if (error instanceof StudioStorageUnavailableError) throw error;
              throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
            }
            if (
              stored.namespace !== store.namespace ||
              stored.key !== asset.object_key ||
              stored.content_type !== asset.mime_type ||
              stored.size_bytes !== asset.size_bytes ||
              stored.checksum_sha256 !== asset.checksum_sha256
            ) {
              throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
            }
            const bytes = await readObjectBody(stored.body, MAX_IMAGE_BYTES);
            const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
            if (bytes.byteLength !== asset.size_bytes || checksum !== asset.checksum_sha256) {
              throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
            }
            return byteStream(bytes);
          },
        });
      }
      return references;
    },
  };
}

export class StudioStorageService {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(
    private readonly input: {
      repository: StudioRepository;
      store: StudioObjectStore;
      now?: () => Date;
      randomUUID?: () => string;
    },
  ) {
    this.now = input.now ?? (() => new Date());
    this.randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  }

  async isReady(): Promise<boolean> {
    try {
      await this.input.store.assertReady();
      return true;
    } catch {
      return false;
    }
  }

  async createUpload(input: StudioCreateUploadInput): Promise<StudioUpload> {
    const extension = IMAGE_EXTENSIONS[input.declared_mime_type];
    if (
      !extension ||
      !Number.isSafeInteger(input.expected_size_bytes) ||
      input.expected_size_bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(input.expected_checksum_sha256)
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    if (input.expected_size_bytes > MAX_IMAGE_BYTES) {
      throw new StudioStorageServiceError('STUDIO_ASSET_TOO_LARGE');
    }
    await this.input.store.assertReady();
    const uploadId = this.randomUUID();
    const objectKey =
      `accounts/${input.account_id}/projects/${input.project_id}` +
      `/uploads/${uploadId}/source.${extension}`;
    const expiresAt = new Date(
      this.now().getTime() + PENDING_UPLOAD_TTL_SECONDS * 1_000,
    ).toISOString();
    const signedUpload = await runStorageDriverOperation(async () => {
      const request = await this.input.store.createSignedUploadUrl({
        key: objectKey,
        content_type: input.declared_mime_type,
        size_bytes: input.expected_size_bytes,
        checksum_sha256: input.expected_checksum_sha256,
        expires_in_seconds: SIGNED_URL_TTL_SECONDS,
      });
      return createStudioSignedUploadRequest(request.url, request.headers);
    });
    const { metadata: _metadata, ...pendingInput } = input;
    const record = await this.input.repository.createPendingUpload({
      ...pendingInput,
      upload_id: uploadId,
      object_key: objectKey,
      expires_at: expiresAt,
    });
    const { account_id: _accountId, actor_user_id: _actorUserId, ...wire } = record;
    return {
      ...wire,
      signed_upload_url: signedUpload.url,
      signed_upload_headers: { ...signedUpload.headers },
    };
  }

  async finalizeUpload(input: {
    accountId: string;
    projectId: string;
    uploadId: string;
  }): Promise<StudioAsset | null> {
    const upload = await this.input.repository.getUploadRecord(
      input.accountId,
      input.projectId,
      input.uploadId,
    );
    if (!upload) return null;
    if (upload.status === 'finalized' && upload.asset_id) {
      return this.input.repository.getAsset(input.projectId, upload.asset_id);
    }
    if (upload.status !== 'pending') return null;
    if (Date.parse(upload.expires_at) <= this.now().getTime()) {
      throw new StudioStorageServiceError('STUDIO_UPLOAD_EXPIRED');
    }

    await this.input.store.assertReady();
    const expectedExtension = IMAGE_EXTENSIONS[upload.declared_mime_type];
    const expectedKey = expectedExtension
      ? `accounts/${input.accountId}/projects/${input.projectId}` +
        `/uploads/${input.uploadId}/source.${expectedExtension}`
      : null;
    if (!expectedKey || upload.object_key !== expectedKey) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }

    let head: StudioObjectMetadata;
    let stored: StudioStoredObject;
    try {
      head = await this.input.store.headObject({ key: upload.object_key });
      stored = await this.input.store.getObject({ key: upload.object_key });
    } catch (error) {
      if (error instanceof StudioStorageUnavailableError) throw error;
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    if (
      head.namespace !== this.input.store.namespace ||
      stored.namespace !== this.input.store.namespace ||
      head.key !== upload.object_key ||
      stored.key !== upload.object_key ||
      head.content_type !== upload.declared_mime_type ||
      stored.content_type !== upload.declared_mime_type ||
      head.size_bytes !== upload.expected_size_bytes ||
      stored.size_bytes !== upload.expected_size_bytes ||
      head.checksum_sha256 !== upload.expected_checksum_sha256 ||
      stored.checksum_sha256 !== upload.expected_checksum_sha256
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }

    const bytes = await readObjectBody(stored.body, MAX_IMAGE_BYTES);
    const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (
      bytes.byteLength !== upload.expected_size_bytes ||
      checksum !== upload.expected_checksum_sha256
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    let image: ValidatedStudioImage;
    try {
      image = await validateStudioImage({ bytes, mimeType: stored.content_type });
    } catch (error) {
      if (error instanceof StudioImageValidationError) {
        throw new StudioStorageServiceError(error.code);
      }
      throw error;
    }

    const result = await this.input.repository.finalizeUploadRecord({
      account_id: input.accountId,
      project_id: input.projectId,
      upload_id: input.uploadId,
      object_key: upload.object_key,
      bucket: this.input.store.namespace,
      mime_type: image.mimeType,
      checksum_sha256: checksum,
      size_bytes: bytes.byteLength,
      width: image.width,
      height: image.height,
      metadata: stored.metadata,
    });
    if (result.outcome === 'finalized') return result.asset;
    if (result.outcome === 'expired') {
      throw new StudioStorageServiceError('STUDIO_UPLOAD_EXPIRED');
    }
    if (result.outcome === 'mismatch') {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    return null;
  }

  async createDownloadUrl(input: {
    accountId: string;
    projectId: string;
    assetId: string;
  }): Promise<StudioSignedDownload | null> {
    const asset = await this.input.repository.getAsset(input.projectId, input.assetId);
    const keyPrefix = `accounts/${input.accountId}/projects/${input.projectId}/`;
    if (
      !asset ||
      asset.account_id !== input.accountId ||
      asset.bucket !== this.input.store.namespace ||
      !isSafeProjectObjectKey(asset.object_key, keyPrefix)
    ) {
      return null;
    }
    await this.input.store.assertReady();
    const signedDownloadUrl = await runStorageDriverOperation(() =>
      this.input.store.createSignedDownloadUrl({
        key: asset.object_key,
        filename: attachmentFilename(asset),
        expires_in_seconds: SIGNED_URL_TTL_SECONDS,
      }),
    );
    return {
      asset_id: asset.asset_id,
      signed_download_url: signedDownloadUrl,
      expires_at: new Date(this.now().getTime() + SIGNED_URL_TTL_SECONDS * 1_000).toISOString(),
    };
  }
}

function attachmentFilename(asset: StudioAsset): string {
  const metadataName = typeof asset.metadata.filename === 'string' ? asset.metadata.filename : '';
  const basename = metadataName.replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  const sanitized = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || character === '"' || character === ';'
      ? '_'
      : character;
  })
    .slice(0, 180)
    .join('');
  if (sanitized) return sanitized;
  const extension = IMAGE_EXTENSIONS[asset.mime_type] ?? 'bin';
  return `${asset.asset_id}.${extension}`;
}

function isSafeProjectObjectKey(key: string, expectedPrefix: string): boolean {
  if (!key.startsWith(expectedPrefix)) return false;
  const suffix = key.slice(expectedPrefix.length);
  return (
    suffix.length > 0 &&
    !suffix.includes('\\') &&
    !suffix.includes('\0') &&
    suffix.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

async function readObjectBody(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  try {
    return await readBounded(stream, maximumBytes);
  } catch (error) {
    if (
      error instanceof StudioStorageServiceError ||
      error instanceof StudioStorageUnavailableError
    ) {
      throw error;
    }
    throw new StudioStorageUnavailableError();
  }
}

async function runStorageDriverOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StudioStorageUnavailableError) throw error;
    throw new StudioStorageUnavailableError();
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new StudioStorageServiceError('STUDIO_ASSET_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}
