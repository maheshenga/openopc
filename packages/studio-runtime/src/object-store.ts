export interface StudioObjectRef {
  bucket: string;
  key: string;
}

export interface StudioPutObjectInput extends StudioObjectRef {
  body: ReadableStream<Uint8Array>;
  content_type: string;
  size_bytes: number;
}

export interface StudioStoredObject extends StudioObjectRef {
  body: ReadableStream<Uint8Array>;
  content_type: string;
  size_bytes: number;
}

export interface StudioSignedUrlInput extends StudioObjectRef {
  expires_in_seconds: number;
}

export interface StudioObjectStore {
  assertReady(): Promise<void>;
  putObject(input: StudioPutObjectInput): Promise<void>;
  getObject(ref: StudioObjectRef): Promise<StudioStoredObject>;
  createSignedDownloadUrl(input: StudioSignedUrlInput): Promise<string>;
  createSignedUploadUrl(input: StudioSignedUrlInput): Promise<string>;
}

export class StudioStorageUnavailableError extends Error {
  readonly code = 'STUDIO_STORAGE_UNAVAILABLE';

  constructor() {
    super('STUDIO_STORAGE_UNAVAILABLE');
    this.name = 'StudioStorageUnavailableError';
  }
}

interface StoredBytes {
  bytes: Uint8Array;
  content_type: string;
}

export class InMemoryStudioObjectStore implements StudioObjectStore {
  private readonly objects = new Map<string, StoredBytes>();

  constructor(private readonly options: { ready: boolean }) {}

  async assertReady(): Promise<void> {
    if (!this.options.ready) {
      throw new StudioStorageUnavailableError();
    }
  }

  async putObject(input: StudioPutObjectInput): Promise<void> {
    await this.assertReady();
    const bytes = await readStream(input.body);
    if (bytes.byteLength !== input.size_bytes) {
      throw new Error(
        `Studio object size mismatch: expected ${input.size_bytes}, got ${bytes.byteLength}`,
      );
    }
    this.objects.set(objectId(input), {
      bytes,
      content_type: input.content_type,
    });
  }

  async getObject(ref: StudioObjectRef): Promise<StudioStoredObject> {
    await this.assertReady();
    const object = this.objects.get(objectId(ref));
    if (!object) {
      throw new Error(`Studio object not found: ${ref.bucket}/${ref.key}`);
    }
    return {
      ...ref,
      body: byteStream(object.bytes),
      content_type: object.content_type,
      size_bytes: object.bytes.byteLength,
    };
  }

  async createSignedDownloadUrl(input: StudioSignedUrlInput): Promise<string> {
    await this.assertReady();
    return `memory://${input.bucket}/${input.key}?ttl=${input.expires_in_seconds}`;
  }

  async createSignedUploadUrl(input: StudioSignedUrlInput): Promise<string> {
    await this.assertReady();
    return `memory-upload://${input.bucket}/${input.key}?ttl=${input.expires_in_seconds}`;
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function objectId(ref: StudioObjectRef): string {
  return `${ref.bucket}/${ref.key}`;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
