import type { StudioAsset, StudioErrorCode, StudioUpload } from '@kortix/api-contract';
import {
  StudioImageValidationError,
  type ValidatedStudioImage,
  createStudioImageThumbnail,
  validateStudioImage,
} from '@kortix/studio-adapters';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioObjectStoreError,
  type StudioReferenceAssetResolver,
  StudioStorageUnavailableError,
  type StudioStoredObject,
  createStudioSignedUploadRequest,
} from '@kortix/studio-runtime';
import type { StudioCreateUploadInput, StudioRepository } from './types';

const SIGNED_URL_TTL_SECONDS = 15 * 60;
const PENDING_UPLOAD_TTL_SECONDS = 30 * 60;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const THUMBNAIL_CACHE_MAX_AGE_SECONDS = SIGNED_URL_TTL_SECONDS;
const THUMBNAIL_PRESET_DIMENSIONS = {
  small: 256,
  medium: 512,
  large: 1024,
} as const;

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

export interface StudioDirectAssetInput {
  accountId: string;
  projectId: string;
  actorUserId: string | null;
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  metadata: Record<string, string>;
}

export interface StudioReadAssetResult {
  asset: StudioAsset;
  bytes: Uint8Array;
}

export type StudioAssetThumbnailPreset = keyof typeof THUMBNAIL_PRESET_DIMENSIONS;

export interface StudioAssetThumbnailUrl {
  asset_id: string;
  preset: StudioAssetThumbnailPreset;
  signed_download_url: string;
  mime_type: 'image/webp';
  width: number;
  height: number;
  size_bytes: number;
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

  async createDirectAsset(input: StudioDirectAssetInput): Promise<StudioAsset> {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new StudioStorageServiceError('STUDIO_ASSET_TOO_LARGE');
    }
    let image: ValidatedStudioImage;
    try {
      image = await validateStudioImage({ bytes: input.bytes, mimeType: input.mimeType });
    } catch (error) {
      if (error instanceof StudioImageValidationError) {
        throw new StudioStorageServiceError(error.code);
      }
      throw error;
    }
    const extension = IMAGE_EXTENSIONS[image.mimeType];
    if (!extension) throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    await this.input.store.assertReady();
    const uploadId = this.randomUUID();
    const objectKey =
      `accounts/${input.accountId}/projects/${input.projectId}` +
      `/uploads/${uploadId}/source.${extension}`;
    const checksum = new Bun.CryptoHasher('sha256').update(input.bytes).digest('hex');
    const expiresAt = new Date(
      this.now().getTime() + PENDING_UPLOAD_TTL_SECONDS * 1_000,
    ).toISOString();
    await this.input.repository.createPendingUpload({
      account_id: input.accountId,
      project_id: input.projectId,
      actor_user_id: input.actorUserId,
      upload_id: uploadId,
      object_key: objectKey,
      declared_mime_type: image.mimeType,
      expected_size_bytes: input.bytes.byteLength,
      expected_checksum_sha256: checksum,
      expires_at: expiresAt,
    });
    try {
      await runStorageDriverOperation(() =>
        this.input.store.putObject({
          key: objectKey,
          body: byteStream(input.bytes),
          content_type: image.mimeType,
          size_bytes: input.bytes.byteLength,
          checksum_sha256: checksum,
          metadata: { ...input.metadata },
          if_none_match: '*',
        }),
      );
    } catch (error) {
      await this.input.store.deleteObject({ key: objectKey }).catch(() => undefined);
      throw error;
    }
    let result: Awaited<ReturnType<StudioRepository['finalizeUploadRecord']>>;
    try {
      result = await this.input.repository.finalizeUploadRecord({
        account_id: input.accountId,
        project_id: input.projectId,
        upload_id: uploadId,
        object_key: objectKey,
        bucket: this.input.store.namespace,
        mime_type: image.mimeType,
        checksum_sha256: checksum,
        size_bytes: input.bytes.byteLength,
        width: image.width,
        height: image.height,
        metadata: { ...input.metadata },
      });
    } catch (error) {
      await this.input.store.deleteObject({ key: objectKey }).catch(() => undefined);
      throw error;
    }
    if (result.outcome === 'finalized') return result.asset;
    await this.input.store.deleteObject({ key: objectKey }).catch(() => undefined);
    if (result.outcome === 'expired') {
      throw new StudioStorageServiceError('STUDIO_UPLOAD_EXPIRED');
    }
    throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
  }

  async readAsset(input: {
    accountId: string;
    projectId: string;
    assetId: string;
  }): Promise<StudioReadAssetResult | null> {
    const asset = await this.input.repository.getAsset(input.projectId, input.assetId);
    const keyPrefix = `accounts/${input.accountId}/projects/${input.projectId}/`;
    const extension = asset ? IMAGE_EXTENSIONS[asset.mime_type] : undefined;
    if (!asset || asset.account_id !== input.accountId) return null;
    if (
      asset.kind !== 'image' ||
      !extension ||
      asset.bucket !== this.input.store.namespace ||
      !isSafeProjectObjectKey(asset.object_key, keyPrefix) ||
      !Number.isSafeInteger(asset.size_bytes) ||
      asset.size_bytes <= 0 ||
      asset.size_bytes > MAX_IMAGE_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.checksum_sha256)
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    await this.input.store.assertReady();
    let stored: StudioStoredObject;
    try {
      stored = await this.input.store.getObject({ key: asset.object_key });
    } catch (error) {
      if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') {
        throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
      }
      if (error instanceof StudioStorageUnavailableError) throw error;
      throw new StudioStorageUnavailableError();
    }
    if (
      stored.namespace !== this.input.store.namespace ||
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
    let image: ValidatedStudioImage;
    try {
      image = await validateStudioImage({ bytes, mimeType: asset.mime_type });
    } catch (error) {
      if (error instanceof StudioImageValidationError) {
        throw new StudioStorageServiceError(error.code);
      }
      throw error;
    }
    if (image.width !== asset.width || image.height !== asset.height) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    return { asset, bytes };
  }

  async deleteAssetObject(input: {
    accountId: string;
    projectId: string;
    asset: StudioAsset;
  }): Promise<void> {
    const { asset } = input;
    const keyPrefix = `accounts/${input.accountId}/projects/${input.projectId}/`;
    if (
      asset.account_id !== input.accountId ||
      asset.project_id !== input.projectId ||
      asset.bucket !== this.input.store.namespace ||
      !isSafeProjectObjectKey(asset.object_key, keyPrefix) ||
      !Number.isSafeInteger(asset.size_bytes) ||
      asset.size_bytes <= 0 ||
      asset.size_bytes > MAX_IMAGE_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.checksum_sha256)
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    await this.input.store.assertReady();
    let stored: StudioObjectMetadata;
    try {
      stored = await this.input.store.headObject({ key: asset.object_key });
    } catch (error) {
      if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return;
      if (error instanceof StudioStorageUnavailableError) throw error;
      throw new StudioStorageUnavailableError();
    }
    if (
      stored.namespace !== this.input.store.namespace ||
      stored.key !== asset.object_key ||
      stored.content_type !== asset.mime_type ||
      stored.size_bytes !== asset.size_bytes ||
      stored.checksum_sha256 !== asset.checksum_sha256 ||
      !stored.etag
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }
    try {
      await this.input.store.deleteObject({ key: asset.object_key, if_match: stored.etag });
    } catch (error) {
      if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return;
      if (error instanceof StudioObjectStoreError && error.code === 'PRECONDITION_FAILED') {
        throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
      }
      if (error instanceof StudioStorageUnavailableError) throw error;
      throw new StudioStorageUnavailableError();
    }
  }

  async createThumbnailUrl(input: {
    accountId: string;
    projectId: string;
    assetId: string;
    preset: StudioAssetThumbnailPreset;
  }): Promise<StudioAssetThumbnailUrl | null> {
    const dimension = THUMBNAIL_PRESET_DIMENSIONS[input.preset];
    if (!dimension) throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    const asset = await this.input.repository.getAsset(input.projectId, input.assetId);
    const keyPrefix = `accounts/${input.accountId}/projects/${input.projectId}/`;
    const extension = asset ? IMAGE_EXTENSIONS[asset.mime_type] : undefined;
    if (!asset || asset.account_id !== input.accountId) return null;
    if (
      asset.kind !== 'image' ||
      !extension ||
      asset.bucket !== this.input.store.namespace ||
      !isSafeProjectObjectKey(asset.object_key, keyPrefix) ||
      !Number.isSafeInteger(asset.size_bytes) ||
      asset.size_bytes <= 0 ||
      asset.size_bytes > MAX_IMAGE_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.checksum_sha256)
    ) {
      throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');
    }

    await this.input.store.assertReady();
    const objectKey = thumbnailObjectKey(input, asset.checksum_sha256);
    const expectedMetadata = {
      'studio-thumbnail-source-checksum': asset.checksum_sha256,
      'studio-thumbnail-preset': input.preset,
    };
    let metadata = await this.readThumbnailMetadata(objectKey, expectedMetadata);
    if (!metadata) {
      const source = await this.readAsset({
        accountId: input.accountId,
        projectId: input.projectId,
        assetId: input.assetId,
      });
      if (!source) return null;
      const thumbnail = await createStudioImageThumbnail({
        bytes: source.bytes,
        mimeType: source.asset.mime_type as 'image/png' | 'image/jpeg' | 'image/webp',
        maxDimension: dimension,
      }).catch((error) => {
        if (error instanceof StudioImageValidationError) {
          throw new StudioStorageServiceError(error.code);
        }
        throw error;
      });
      const checksum = new Bun.CryptoHasher('sha256').update(thumbnail.bytes).digest('hex');
      const thumbnailMetadata = {
        ...expectedMetadata,
        'studio-thumbnail-width': String(thumbnail.width),
        'studio-thumbnail-height': String(thumbnail.height),
      };
      try {
        metadata = await runStorageDriverOperation(() =>
          this.input.store.putObject({
            key: objectKey,
            body: byteStream(thumbnail.bytes),
            content_type: thumbnail.mimeType,
            size_bytes: thumbnail.bytes.byteLength,
            checksum_sha256: checksum,
            metadata: thumbnailMetadata,
            if_none_match: '*',
          }),
        ).then((stored) => ({
          size_bytes: stored.size_bytes,
          checksum_sha256: stored.checksum_sha256,
          width: thumbnail.width,
          height: thumbnail.height,
        }));
      } catch (error) {
        if (!(error instanceof StudioStorageUnavailableError)) throw error;
        metadata = await this.readThumbnailMetadata(objectKey, expectedMetadata);
        if (!metadata) throw error;
      }
    }
    if (!metadata) throw new StudioStorageServiceError('STUDIO_ASSET_INVALID');

    const cacheControl = `private, max-age=${THUMBNAIL_CACHE_MAX_AGE_SECONDS}, immutable`;
    const signedDownloadUrl = await runStorageDriverOperation(() =>
      this.input.store.createSignedDownloadUrl({
        key: objectKey,
        filename: `${asset.asset_id}-${input.preset}.webp`,
        expires_in_seconds: SIGNED_URL_TTL_SECONDS,
        content_disposition: 'inline',
        content_type: 'image/webp',
        cache_control: cacheControl,
      }),
    );
    return {
      asset_id: asset.asset_id,
      preset: input.preset,
      signed_download_url: signedDownloadUrl,
      mime_type: 'image/webp',
      width: metadata.width,
      height: metadata.height,
      size_bytes: metadata.size_bytes,
      expires_at: new Date(this.now().getTime() + SIGNED_URL_TTL_SECONDS * 1_000).toISOString(),
    };
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

  private async readThumbnailMetadata(
    objectKey: string,
    expectedMetadata: Record<string, string>,
  ): Promise<{
    size_bytes: number;
    checksum_sha256: string;
    width: number;
    height: number;
  } | null> {
    let stored: StudioObjectMetadata;
    try {
      stored = await this.input.store.headObject({ key: objectKey });
    } catch (error) {
      if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return null;
      if (error instanceof StudioStorageUnavailableError) throw error;
      throw new StudioStorageUnavailableError();
    }
    if (
      stored.namespace !== this.input.store.namespace ||
      stored.key !== objectKey ||
      stored.content_type !== 'image/webp' ||
      stored.size_bytes <= 0 ||
      stored.size_bytes > MAX_IMAGE_BYTES ||
      !/^[a-f0-9]{64}$/.test(stored.checksum_sha256) ||
      Object.entries(expectedMetadata).some(([key, value]) => stored.metadata[key] !== value)
    ) {
      return null;
    }
    const width = Number(stored.metadata['studio-thumbnail-width']);
    const height = Number(stored.metadata['studio-thumbnail-height']);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024
    ) {
      return null;
    }
    return {
      size_bytes: stored.size_bytes,
      checksum_sha256: stored.checksum_sha256,
      width,
      height,
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

function thumbnailObjectKey(
  input: { accountId: string; projectId: string; assetId: string; preset: string },
  checksum: string,
): string {
  return (
    `accounts/${input.accountId}/projects/${input.projectId}` +
    `/thumbnails/${input.assetId}/${checksum}/${input.preset}.webp`
  );
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
