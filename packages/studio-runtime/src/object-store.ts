import { StudioSignedUploadHeadersSchema } from '@kortix/api-contract';

export interface StudioObjectRef {
  key: string;
}

export interface StudioObjectMetadata extends StudioObjectRef {
  namespace: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  etag: string | null;
  metadata: Record<string, string>;
  server_side_encryption?: 'AES256' | 'aws:kms';
  sse_kms_key_id?: string | null;
  last_modified?: string;
}

export interface StudioPutObjectInput extends StudioObjectRef {
  body: ReadableStream<Uint8Array>;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  metadata: Record<string, string>;
  if_none_match?: '*';
}

export interface StudioStoredObject extends StudioObjectMetadata {
  body: ReadableStream<Uint8Array>;
}

export interface StudioDeleteObjectInput extends StudioObjectRef {
  if_match?: string;
}

export interface StudioListObjectsInput {
  prefix: string;
  cursor?: string;
  limit: number;
}

export interface StudioListedObject extends StudioObjectRef {
  namespace: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  etag: string;
  last_modified: string;
}

export interface StudioListObjectsResult {
  objects: StudioListedObject[];
  next_cursor: string | null;
}

export interface StudioSignedUploadInput extends StudioObjectRef {
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  expires_in_seconds: number;
}

export interface StudioSignedUploadRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export interface StudioSignedDownloadInput extends StudioObjectRef {
  filename: string;
  expires_in_seconds: number;
}

export interface StudioObjectStore {
  readonly namespace: string;
  readonly required_server_side_encryption?: 'AES256' | 'aws:kms';
  readonly required_sse_kms_key_id?: string | null;
  assertReady(): Promise<void>;
  putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata>;
  headObject(ref: StudioObjectRef): Promise<StudioObjectMetadata>;
  getObject(ref: StudioObjectRef): Promise<StudioStoredObject>;
  listObjects(input: StudioListObjectsInput): Promise<StudioListObjectsResult>;
  deleteObject(input: StudioDeleteObjectInput): Promise<void>;
  createSignedUploadUrl(input: StudioSignedUploadInput): Promise<StudioSignedUploadRequest>;
  createSignedDownloadUrl(input: StudioSignedDownloadInput): Promise<string>;
}

export class StudioStorageUnavailableError extends Error {
  readonly code = 'STUDIO_STORAGE_UNAVAILABLE';

  constructor() {
    super('STUDIO_STORAGE_UNAVAILABLE');
    this.name = 'StudioStorageUnavailableError';
  }
}

export function createStudioSignedUploadRequest(
  url: string,
  headers: Readonly<Record<string, string>>,
): StudioSignedUploadRequest {
  const parsedHeaders = StudioSignedUploadHeadersSchema.safeParse({ ...headers });
  if (!url || !parsedHeaders.success) throw new StudioStorageUnavailableError();
  return { url, headers: parsedHeaders.data };
}

export type StudioObjectStoreErrorCode =
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH';

export class StudioObjectStoreError extends Error {
  constructor(
    readonly code: StudioObjectStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StudioObjectStoreError';
  }
}

interface StoredBytes {
  bytes: Uint8Array;
  metadata: StudioObjectMetadata;
  lastModified: string;
}

export class InMemoryStudioObjectStore implements StudioObjectStore {
  readonly namespace: string;
  readonly required_server_side_encryption = 'AES256' as const;
  readonly required_sse_kms_key_id = null;
  private readonly objects = new Map<string, StoredBytes>();

  constructor(private readonly options: { namespace: string; ready: boolean; now?: () => Date }) {
    this.namespace = options.namespace;
  }

  async assertReady(): Promise<void> {
    if (!this.options.ready) {
      throw new StudioStorageUnavailableError();
    }
  }

  async putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata> {
    const bytes = await readStream(input.body);
    if (bytes.byteLength !== input.size_bytes) {
      throw new StudioObjectStoreError(
        'SIZE_MISMATCH',
        `Studio object size mismatch: expected ${input.size_bytes}, got ${bytes.byteLength}`,
      );
    }
    const checksumSha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (checksumSha256 !== input.checksum_sha256) {
      throw new StudioObjectStoreError(
        'CHECKSUM_MISMATCH',
        `Studio object checksum did not match: ${input.key}`,
      );
    }
    if (input.if_none_match === '*' && this.objects.has(input.key)) {
      throw new StudioObjectStoreError(
        'PRECONDITION_FAILED',
        `Studio object already exists: ${input.key}`,
      );
    }
    const lastModified = (this.options.now ?? (() => new Date()))().toISOString();
    const metadata: StudioObjectMetadata = {
      namespace: this.namespace,
      key: input.key,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256,
      etag: input.checksum_sha256,
      metadata: { ...input.metadata },
      server_side_encryption: this.required_server_side_encryption,
      sse_kms_key_id: this.required_sse_kms_key_id,
      last_modified: lastModified,
    };
    this.objects.set(input.key, {
      bytes,
      metadata,
      lastModified,
    });
    return cloneMetadata(metadata);
  }

  async headObject(ref: StudioObjectRef): Promise<StudioObjectMetadata> {
    return cloneMetadata(this.requireObject(ref).metadata);
  }

  async getObject(ref: StudioObjectRef): Promise<StudioStoredObject> {
    const object = this.requireObject(ref);
    return {
      ...cloneMetadata(object.metadata),
      body: byteStream(object.bytes),
    };
  }

  async listObjects(input: StudioListObjectsInput): Promise<StudioListObjectsResult> {
    assertListInput(input);
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(input.prefix))
      .sort((left, right) => left.localeCompare(right));
    let start = 0;
    const cursor = input.cursor;
    if (cursor !== undefined) {
      if (!safeListedKey(cursor, input.prefix)) {
        throw new Error('Invalid Studio object list cursor');
      }
      const nextIndex = keys.findIndex((key) => key.localeCompare(cursor) > 0);
      start = nextIndex < 0 ? keys.length : nextIndex;
    }
    const pageKeys = keys.slice(start, start + input.limit);
    const hasMore = start + pageKeys.length < keys.length;
    return {
      objects: pageKeys.map((key) => {
        const object = this.objects.get(key);
        if (!object?.metadata.etag) throw new StudioStorageUnavailableError();
        return {
          namespace: this.namespace,
          key,
          content_type: object.metadata.content_type,
          size_bytes: object.metadata.size_bytes,
          checksum_sha256: object.metadata.checksum_sha256,
          etag: object.metadata.etag,
          last_modified: object.lastModified,
        };
      }),
      next_cursor: hasMore ? (pageKeys.at(-1) ?? null) : null,
    };
  }

  async deleteObject(input: StudioDeleteObjectInput): Promise<void> {
    const object = this.requireObject(input);
    if (input.if_match !== undefined && object.metadata.etag !== input.if_match) {
      throw new StudioObjectStoreError(
        'PRECONDITION_FAILED',
        `Studio object ETag did not match: ${input.key}`,
      );
    }
    this.objects.delete(input.key);
  }

  async createSignedUploadUrl(input: StudioSignedUploadInput): Promise<StudioSignedUploadRequest> {
    const query = new URLSearchParams({
      content_type: input.content_type,
      size_bytes: String(input.size_bytes),
      checksum_sha256: input.checksum_sha256,
      ttl: String(input.expires_in_seconds),
    });
    return createStudioSignedUploadRequest(
      `memory-upload://${encodeURIComponent(this.namespace)}/${encodeObjectKey(input.key)}?${query}`,
      {
        'content-type': input.content_type,
        'x-amz-checksum-sha256': Buffer.from(input.checksum_sha256, 'hex').toString('base64'),
        'x-amz-meta-studio-checksum-sha256': input.checksum_sha256,
        'x-amz-meta-studio-required-sse': this.required_server_side_encryption,
        'x-amz-server-side-encryption': this.required_server_side_encryption,
      },
    );
  }

  async createSignedDownloadUrl(input: StudioSignedDownloadInput): Promise<string> {
    const query = new URLSearchParams({
      filename: input.filename,
      ttl: String(input.expires_in_seconds),
    });
    return `memory://${encodeURIComponent(this.namespace)}/${encodeObjectKey(input.key)}?${query}`;
  }

  private requireObject(ref: StudioObjectRef): StoredBytes {
    const object = this.objects.get(ref.key);
    if (!object) {
      throw new StudioObjectStoreError('NOT_FOUND', `Studio object not found: ${ref.key}`);
    }
    return object;
  }
}

function cloneMetadata(metadata: StudioObjectMetadata): StudioObjectMetadata {
  return { ...metadata, metadata: { ...metadata.metadata } };
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function assertStudioListObjectsInput(input: StudioListObjectsInput): void {
  assertListInput(input);
}

function assertListInput(input: StudioListObjectsInput): void {
  const prefix = input.prefix;
  if (
    prefix.length < 2 ||
    prefix.length > 1024 ||
    !prefix.endsWith('/') ||
    prefix.startsWith('/') ||
    prefix.includes('\\') ||
    prefix.includes('\0') ||
    prefix
      .slice(0, -1)
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid Studio object list prefix');
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('Invalid Studio object list limit');
  }
  if (
    input.cursor !== undefined &&
    (input.cursor.length < 1 || input.cursor.length > 2048 || input.cursor.includes('\0'))
  ) {
    throw new Error('Invalid Studio object list cursor');
  }
}

function safeListedKey(key: string, prefix: string): boolean {
  return (
    key.startsWith(prefix) &&
    key.length > prefix.length &&
    !key.includes('\\') &&
    !key.includes('\0') &&
    key.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}
