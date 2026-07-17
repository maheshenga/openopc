import { createHash } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type StudioDeleteObjectInput,
  type StudioObjectMetadata,
  type StudioObjectRef,
  type StudioObjectStore,
  type StudioListObjectsInput,
  type StudioListObjectsResult,
  StudioObjectStoreError,
  type StudioPutObjectInput,
  type StudioSignedDownloadInput,
  type StudioSignedUploadInput,
  StudioStorageUnavailableError,
  type StudioStoredObject,
  assertStudioListObjectsInput,
} from '@kortix/studio-runtime';
import type { StudioS3StorageConfig } from '../config';
import { createCachedStudioReadinessProbe } from './readiness';

const CHECKSUM_METADATA_KEY = 'studio-checksum-sha256';
const REQUIRED_SSE_METADATA_KEY = 'studio-required-sse';
const REQUIRED_KMS_KEY_METADATA_KEY = 'studio-required-kms-key-id';
const RESERVED_METADATA_KEYS = new Set([
  CHECKSUM_METADATA_KEY,
  REQUIRED_SSE_METADATA_KEY,
  REQUIRED_KMS_KEY_METADATA_KEY,
]);
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 900;
const REDACTING_S3_LOGGER = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

type StudioS3Command =
  | PutObjectCommand
  | HeadObjectCommand
  | GetObjectCommand
  | ListObjectsV2Command
  | DeleteObjectCommand;

export interface StudioS3Client {
  send(command: StudioS3Command, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export type StudioS3Presigner = (
  client: unknown,
  command: PutObjectCommand | GetObjectCommand,
  options: {
    expiresIn: number;
    signableHeaders?: Set<string>;
    unhoistableHeaders?: Set<string>;
  },
) => Promise<string>;

export interface S3StudioObjectStoreInput {
  config: StudioS3StorageConfig;
  client: StudioS3Client;
  signingClient: unknown;
  presign: StudioS3Presigner;
  readiness: () => Promise<void>;
  dispose?: () => void;
}

export function createS3StudioObjectStore(input: {
  config: StudioS3StorageConfig;
  role: 'api' | 'worker';
}): S3StudioObjectStore {
  assertValidFactoryConfig(input.config);
  const client = createClient(input.config, input.config.endpoint);
  const signingClient = input.config.publicEndpoint
    ? createClient(input.config, input.config.publicEndpoint)
    : client;
  let readiness: () => Promise<void> = async () => {
    throw new StudioStorageUnavailableError();
  };
  const store = new S3StudioObjectStore({
    config: input.config,
    client: client as unknown as StudioS3Client,
    signingClient,
    presign: getSignedUrl as unknown as StudioS3Presigner,
    readiness: () => readiness(),
    dispose: () => {
      client.destroy();
      if (signingClient !== client) signingClient.destroy();
    },
  });
  readiness = createCachedStudioReadinessProbe({ store, role: input.role });
  return store;
}

export class S3StudioObjectStore implements StudioObjectStore {
  readonly namespace: string;
  readonly required_server_side_encryption: 'AES256' | 'aws:kms';
  readonly required_sse_kms_key_id: string | null;
  private readonly prefix: string;
  private destroyed = false;

  constructor(private readonly input: S3StudioObjectStoreInput) {
    this.namespace = input.config.bucket;
    this.required_server_side_encryption = input.config.sse;
    this.required_sse_kms_key_id = input.config.kmsKeyId;
    this.prefix = validatedPath(input.config.prefix, 'prefix');
  }

  async assertReady(): Promise<void> {
    await this.input.readiness();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.input.dispose?.();
  }

  async putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata> {
    const metadata = customMetadata(input.metadata);
    const abortController = new AbortController();
    const body = createIntegrityCheckedBody(input, () => abortController.abort());
    const command = new PutObjectCommand({
      Bucket: this.namespace,
      Key: this.objectKey(input.key),
      Body: body,
      ContentType: input.content_type,
      ContentLength: input.size_bytes,
      ChecksumSHA256: hexChecksumToBase64(input.checksum_sha256),
      Metadata: {
        ...metadata,
        [CHECKSUM_METADATA_KEY]: input.checksum_sha256,
      },
      ...this.encryptionInput(),
      ...this.expectedOwnerInput(),
    });
    let output: PutObjectCommandOutput;
    try {
      output = await this.send<PutObjectCommandOutput>(this.input.client, command, {
        abortSignal: abortController.signal,
      });
    } catch (error) {
      if (body.integrityError) throw body.integrityError;
      if (body.sourceFailed) throw new StudioStorageUnavailableError();
      throw error;
    }
    if (body.integrityError) throw body.integrityError;
    if (body.sourceFailed) throw new StudioStorageUnavailableError();

    return {
      namespace: this.namespace,
      key: input.key,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256,
      etag: output.ETag ?? null,
      metadata,
      server_side_encryption: this.required_server_side_encryption,
      sse_kms_key_id: this.required_sse_kms_key_id,
    };
  }

  async headObject(ref: StudioObjectRef): Promise<StudioObjectMetadata> {
    const command = new HeadObjectCommand({
      Bucket: this.namespace,
      Key: this.objectKey(ref.key),
      ChecksumMode: 'ENABLED',
      ...this.expectedOwnerInput(),
    });
    const output = await this.send<HeadObjectCommandOutput>(this.input.client, command);
    return this.normalizeMetadata(ref.key, output);
  }

  async getObject(ref: StudioObjectRef): Promise<StudioStoredObject> {
    const command = new GetObjectCommand({
      Bucket: this.namespace,
      Key: this.objectKey(ref.key),
      ChecksumMode: 'ENABLED',
      ...this.expectedOwnerInput(),
    });
    const output = await this.send<GetObjectCommandOutput>(this.input.client, command);
    if (!output.Body) throw new StudioStorageUnavailableError();

    return {
      ...this.normalizeMetadata(ref.key, output),
      body: toWebReadableStream(output.Body),
    };
  }

  async listObjects(input: StudioListObjectsInput): Promise<StudioListObjectsResult> {
    assertStudioListObjectsInput(input);
    const storagePrefix = this.objectListPrefix(input.prefix);
    const output = await this.send<ListObjectsV2CommandOutput>(
      this.input.client,
      new ListObjectsV2Command({
        Bucket: this.namespace,
        Prefix: storagePrefix,
        MaxKeys: input.limit,
        ...(input.cursor === undefined ? {} : { ContinuationToken: input.cursor }),
        ...this.expectedOwnerInput(),
      }),
    );
    const contents = output.Contents ?? [];
    if (
      contents.length > input.limit ||
      (output.IsTruncated === true && !output.NextContinuationToken)
    ) {
      throw new StudioStorageUnavailableError();
    }
    const objects = await Promise.all(
      contents.map(async (listed) => {
        if (
          !listed.Key ||
          !listed.Key.startsWith(storagePrefix) ||
          !listed.ETag ||
          listed.Size === undefined ||
          listed.Size < 0 ||
          !listed.LastModified
        ) {
          throw new StudioStorageUnavailableError();
        }
        const key = this.logicalKey(listed.Key);
        if (!key.startsWith(input.prefix)) throw new StudioStorageUnavailableError();
        const head = await this.headObject({ key });
        const listedLastModified = listed.LastModified.toISOString();
        if (
          !head.etag ||
          !head.last_modified ||
          head.etag !== listed.ETag ||
          head.size_bytes !== listed.Size ||
          head.last_modified !== listedLastModified
        ) {
          throw new StudioStorageUnavailableError();
        }
        return {
          namespace: head.namespace,
          key: head.key,
          content_type: head.content_type,
          size_bytes: head.size_bytes,
          checksum_sha256: head.checksum_sha256,
          etag: head.etag,
          last_modified: head.last_modified,
        };
      }),
    );
    return {
      objects,
      next_cursor: output.IsTruncated ? (output.NextContinuationToken ?? null) : null,
    };
  }

  async deleteObject(input: StudioDeleteObjectInput): Promise<void> {
    if (input.if_match !== undefined) {
      await this.send(
        this.input.client,
        new HeadObjectCommand({
          Bucket: this.namespace,
          Key: this.objectKey(input.key),
          IfMatch: input.if_match,
          ...this.expectedOwnerInput(),
        }),
      );
    }
    const command = new DeleteObjectCommand({
      Bucket: this.namespace,
      Key: this.objectKey(input.key),
      IfMatch: input.if_match,
      ...this.expectedOwnerInput(),
    });
    await this.send(this.input.client, command);
  }

  async createSignedUploadUrl(input: StudioSignedUploadInput): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.namespace,
      Key: this.objectKey(input.key),
      ContentType: input.content_type,
      ContentLength: input.size_bytes,
      ChecksumSHA256: hexChecksumToBase64(input.checksum_sha256),
      Metadata: {
        [CHECKSUM_METADATA_KEY]: input.checksum_sha256,
        [REQUIRED_SSE_METADATA_KEY]: this.input.config.sse,
        ...(this.input.config.sse === 'aws:kms' && this.input.config.kmsKeyId
          ? { [REQUIRED_KMS_KEY_METADATA_KEY]: this.input.config.kmsKeyId }
          : {}),
      },
      ...this.encryptionInput(),
      ...this.expectedOwnerInput(),
    });
    return this.presign(command, input.expires_in_seconds);
  }

  async createSignedDownloadUrl(input: StudioSignedDownloadInput): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.namespace,
      Key: this.objectKey(input.key),
      ResponseContentDisposition: attachmentContentDisposition(input.filename),
      ...this.expectedOwnerInput(),
    });
    return this.presign(command, input.expires_in_seconds);
  }

  private async presign(
    command: PutObjectCommand | GetObjectCommand,
    expiresInSeconds: number,
  ): Promise<string> {
    try {
      return await this.input.presign(this.input.signingClient, command, {
        expiresIn: clampSignedUrlTtl(expiresInSeconds),
        ...(command instanceof PutObjectCommand
          ? {
              signableHeaders: new Set(['content-type']),
              unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
            }
          : {}),
      });
    } catch {
      throw new StudioStorageUnavailableError();
    }
  }

  private async send<T>(
    client: StudioS3Client,
    command: StudioS3Command,
    options?: { abortSignal?: AbortSignal },
  ): Promise<T> {
    try {
      return (await client.send(command, options)) as T;
    } catch (error) {
      throw mapS3Error(error);
    }
  }

  private objectKey(key: string): string {
    return `${this.prefix}/${validatedPath(key, 'key')}`;
  }

  private objectListPrefix(prefix: string): string {
    return `${this.prefix}/${validatedPath(prefix, 'key')}/`;
  }

  private logicalKey(storageKey: string): string {
    const root = `${this.prefix}/`;
    if (!storageKey.startsWith(root)) throw new StudioStorageUnavailableError();
    return validatedPath(storageKey.slice(root.length), 'key');
  }

  private encryptionInput(): {
    ServerSideEncryption: 'AES256' | 'aws:kms';
    SSEKMSKeyId?: string;
  } {
    return {
      ServerSideEncryption: this.input.config.sse,
      ...(this.input.config.sse === 'aws:kms' && this.input.config.kmsKeyId
        ? { SSEKMSKeyId: this.input.config.kmsKeyId }
        : {}),
    };
  }

  private expectedOwnerInput(): { ExpectedBucketOwner?: string } {
    return this.input.config.expectedBucketOwner
      ? { ExpectedBucketOwner: this.input.config.expectedBucketOwner }
      : {};
  }

  private normalizeMetadata(
    key: string,
    output: Pick<
      HeadObjectCommandOutput,
      | 'ContentType'
      | 'ContentLength'
      | 'ChecksumSHA256'
      | 'ETag'
      | 'Metadata'
      | 'ServerSideEncryption'
      | 'SSEKMSKeyId'
      | 'LastModified'
    >,
  ): StudioObjectMetadata {
    const metadata = output.Metadata ?? {};
    const metadataChecksum = findMetadataValue(metadata, CHECKSUM_METADATA_KEY)?.toLowerCase();
    const nativeChecksum = base64ChecksumToHex(output.ChecksumSHA256);
    if (metadataChecksum && nativeChecksum && metadataChecksum !== nativeChecksum) {
      throw new StudioStorageUnavailableError();
    }
    const checksum = metadataChecksum ?? nativeChecksum;
    if (!checksum) throw new StudioStorageUnavailableError();
    return {
      namespace: this.namespace,
      key,
      content_type: output.ContentType ?? 'application/octet-stream',
      size_bytes: output.ContentLength ?? 0,
      checksum_sha256: checksum,
      etag: output.ETag ?? null,
      metadata: customMetadata(metadata),
      ...(output.ServerSideEncryption === 'AES256' || output.ServerSideEncryption === 'aws:kms'
        ? { server_side_encryption: output.ServerSideEncryption }
        : {}),
      sse_kms_key_id: output.SSEKMSKeyId ?? null,
      ...(output.LastModified ? { last_modified: output.LastModified.toISOString() } : {}),
    };
  }
}

function createIntegrityCheckedBody(
  input: StudioPutObjectInput,
  onFailure: () => void,
): IntegrityCheckedUploadStream {
  return new IntegrityCheckedUploadStream(input, onFailure);
}

class IntegrityCheckedUploadStream extends Transform {
  integrityError: StudioObjectStoreError | null = null;
  sourceFailed = false;
  private readonly hasher = createHash('sha256');
  private receivedBytes = 0;
  private source: Readable | null = null;
  private started = false;

  constructor(
    private readonly input: StudioPutObjectInput,
    private readonly onFailure: () => void,
  ) {
    super();
  }

  override _read(size: number): void {
    if (!this.started) {
      this.started = true;
      this.source = Readable.fromWeb(
        deferredWebStream(this.input.body, () => this.failSource()) as never,
      );
      this.source.once('error', () => this.failSource());
      this.source.pipe(this);
    }
    super._read(size);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const nextSize = this.receivedBytes + chunk.byteLength;
    if (nextSize > this.input.size_bytes) {
      this.failIntegrity(
        new StudioObjectStoreError(
          'SIZE_MISMATCH',
          `Studio object size exceeded the declared ${this.input.size_bytes} bytes`,
        ),
        callback,
      );
      return;
    }
    this.receivedBytes = nextSize;
    this.hasher.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.receivedBytes !== this.input.size_bytes) {
      this.failIntegrity(
        new StudioObjectStoreError(
          'SIZE_MISMATCH',
          `Studio object size mismatch: expected ${this.input.size_bytes}, got ${this.receivedBytes}`,
        ),
        callback,
      );
      return;
    }
    if (this.hasher.digest('hex') !== this.input.checksum_sha256.toLowerCase()) {
      this.failIntegrity(
        new StudioObjectStoreError('CHECKSUM_MISMATCH', 'Studio object checksum did not match'),
        callback,
      );
      return;
    }
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.source?.destroy();
    callback(error);
  }

  private failIntegrity(error: StudioObjectStoreError, callback: TransformCallback): void {
    this.integrityError = error;
    this.onFailure();
    callback();
    this.destroy();
  }

  private failSource(): void {
    if (this.sourceFailed) return;
    this.sourceFailed = true;
    this.onFailure();
    this.destroy();
  }
}

function deferredWebStream(
  source: ReadableStream<Uint8Array>,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        onError(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // The consumer receives the original stream error through the verifier.
      }
    },
  });
}

function toWebReadableStream(body: unknown): ReadableStream<Uint8Array> {
  if (isWebReadableStream(body)) return body;
  if (hasWebStreamTransform(body)) return body.transformToWebStream();
  if (body instanceof Readable) {
    return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
  }
  if (isAsyncIterable(body)) {
    return Readable.toWeb(Readable.from(body)) as unknown as ReadableStream<Uint8Array>;
  }
  throw new StudioStorageUnavailableError();
}

function isWebReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === 'object' && value !== null && 'getReader' in value;
}

function hasWebStreamTransform(
  value: unknown,
): value is { transformToWebStream(): ReadableStream<Uint8Array> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'transformToWebStream' in value &&
    typeof value.transformToWebStream === 'function'
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function mapS3Error(error: unknown): Error {
  if (error instanceof StudioObjectStoreError || error instanceof StudioStorageUnavailableError) {
    return error;
  }
  const statusCode = sdkHttpStatusCode(error);
  if (statusCode === 404) {
    return new StudioObjectStoreError('NOT_FOUND', 'Studio object not found');
  }
  if (statusCode === 412) {
    return new StudioObjectStoreError('PRECONDITION_FAILED', 'Studio object precondition failed');
  }
  return new StudioStorageUnavailableError();
}

function sdkHttpStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

function customMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_METADATA_KEYS.has(key.toLowerCase())),
  );
}

function findMetadataValue(
  metadata: Record<string, string>,
  expectedKey: string,
): string | undefined {
  return Object.entries(metadata).find(([key]) => key.toLowerCase() === expectedKey)?.[1];
}

function hexChecksumToBase64(checksum: string): string {
  return Buffer.from(checksum, 'hex').toString('base64');
}

function base64ChecksumToHex(checksum: string | undefined): string {
  return checksum ? Buffer.from(checksum, 'base64').toString('hex') : '';
}

function clampSignedUrlTtl(seconds: number): number {
  return Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.max(MIN_SIGNED_URL_TTL_SECONDS, seconds));
}

function attachmentContentDisposition(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1) ?? '';
  const safeUnicode = [...basename]
    .slice(0, 180)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 ||
        codePoint === 0x7f ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        ['"', ';', '\\', '/'].includes(character)
        ? '_'
        : character;
    })
    .join('')
    .trim();
  const finalName = safeUnicode || 'download';
  const asciiName = finalName.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(finalName)}`;
}

function validatedPath(value: string, kind: 'prefix' | 'key'): string {
  const path = value.replace(/^\/+|\/+$/g, '');
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid Studio object ${kind}`);
  }
  return path;
}

function createClient(config: StudioS3StorageConfig, endpoint: URL): S3Client {
  return new S3Client({
    endpoint: endpoint.toString(),
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    logger: REDACTING_S3_LOGGER,
    ...(config.credentialMode === 'static' && config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
          },
        }
      : {}),
  });
}

function assertValidFactoryConfig(config: StudioS3StorageConfig): void {
  if (config.credentialMode === 'static' && (!config.accessKeyId || !config.secretAccessKey)) {
    throw new Error('Invalid Studio S3 credential configuration');
  }
  if (
    (config.sse === 'aws:kms' && !config.kmsKeyId) ||
    (config.sse === 'AES256' && config.kmsKeyId !== null)
  ) {
    throw new Error('Invalid Studio S3 encryption configuration');
  }
}
