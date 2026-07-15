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
}

export interface StudioPutObjectInput extends StudioObjectRef {
  body: ReadableStream<Uint8Array>;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  metadata: Record<string, string>;
}

export interface StudioStoredObject extends StudioObjectMetadata {
  body: ReadableStream<Uint8Array>;
}

export interface StudioDeleteObjectInput extends StudioObjectRef {
  if_match?: string;
}

export interface StudioSignedUploadInput extends StudioObjectRef {
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  expires_in_seconds: number;
}

export interface StudioSignedDownloadInput extends StudioObjectRef {
  filename: string;
  expires_in_seconds: number;
}

export interface StudioObjectStore {
  readonly namespace: string;
  assertReady(): Promise<void>;
  putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata>;
  headObject(ref: StudioObjectRef): Promise<StudioObjectMetadata>;
  getObject(ref: StudioObjectRef): Promise<StudioStoredObject>;
  deleteObject(input: StudioDeleteObjectInput): Promise<void>;
  createSignedUploadUrl(input: StudioSignedUploadInput): Promise<string>;
  createSignedDownloadUrl(input: StudioSignedDownloadInput): Promise<string>;
}

export class StudioStorageUnavailableError extends Error {
  readonly code = 'STUDIO_STORAGE_UNAVAILABLE';

  constructor() {
    super('STUDIO_STORAGE_UNAVAILABLE');
    this.name = 'StudioStorageUnavailableError';
  }
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
}

export class InMemoryStudioObjectStore implements StudioObjectStore {
  readonly namespace: string;
  private readonly objects = new Map<string, StoredBytes>();

  constructor(private readonly options: { namespace: string; ready: boolean }) {
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
    const metadata: StudioObjectMetadata = {
      namespace: this.namespace,
      key: input.key,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256,
      etag: input.checksum_sha256,
      metadata: { ...input.metadata },
    };
    this.objects.set(input.key, { bytes, metadata });
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

  async createSignedUploadUrl(input: StudioSignedUploadInput): Promise<string> {
    const query = new URLSearchParams({
      content_type: input.content_type,
      size_bytes: String(input.size_bytes),
      checksum_sha256: input.checksum_sha256,
      ttl: String(input.expires_in_seconds),
    });
    return `memory-upload://${encodeURIComponent(this.namespace)}/${encodeObjectKey(input.key)}?${query}`;
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
