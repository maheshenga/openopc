import { expect, test } from 'bun:test';
import type {
  StudioDeleteObjectInput,
  StudioObjectMetadata,
  StudioObjectRef,
  StudioObjectStore,
  StudioPutObjectInput,
  StudioSignedDownloadInput,
  StudioSignedUploadInput,
  StudioSignedUploadRequest,
  StudioStoredObject,
  StudioListObjectsInput,
  StudioListObjectsResult,
} from '@kortix/studio-runtime';
import { createCachedStudioReadinessProbe } from './readiness';

const PROBE_BYTE = new Uint8Array([1]);
const PROBE_CHECKSUM = new Bun.CryptoHasher('sha256').update(PROBE_BYTE).digest('hex');

test('performs a one-byte worker roundtrip and caches success for 60 seconds', async () => {
  let now = 1_000;
  const store = new RecordingStore();
  const probe = createCachedStudioReadinessProbe({ store, role: 'worker', now: () => now });

  await probe();
  const firstKey = store.calls[0]?.key;
  expect(store.calls.map((call) => call.operation)).toEqual(['put', 'head', 'get', 'delete']);
  expect(firstKey).toMatch(/^_studio-readiness\/worker\/[0-9a-f-]+$/);
  expect(store.calls.every((call) => call.key === firstKey)).toBeTrue();
  expect(store.puts[0]).toMatchObject({
    key: firstKey,
    bytes: PROBE_BYTE,
    content_type: 'application/octet-stream',
    size_bytes: 1,
    checksum_sha256: PROBE_CHECKSUM,
    metadata: {},
  });
  expect(store.assertReadyCalls).toBe(0);

  now += 59_999;
  await probe();
  expect(store.calls).toHaveLength(4);

  now += 1;
  await probe();
  expect(store.calls.map((call) => call.operation)).toEqual([
    'put',
    'head',
    'get',
    'delete',
    'put',
    'head',
    'get',
    'delete',
  ]);
  expect(store.calls[4]?.key).not.toBe(firstKey);
});

test('does not extend the cache after failure and performs best-effort cleanup', async () => {
  let now = 10_000;
  let getFailures = 0;
  const store = new RecordingStore({
    beforeOperation: async (operation) => {
      if (operation === 'get' && getFailures > 0) {
        getFailures -= 1;
        throw new Error(
          'https://private.example.test/file?X-Amz-Signature=leak&token=session-leak',
        );
      }
    },
  });
  const probe = createCachedStudioReadinessProbe({ store, role: 'api', now: () => now });

  await probe();
  now += 60_000;
  getFailures = 1;

  let caught: unknown;
  try {
    await probe();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
  expect(String(caught)).toBe('StudioStorageUnavailableError: STUDIO_STORAGE_UNAVAILABLE');
  expect(store.calls.slice(-4).map((call) => call.operation)).toEqual([
    'put',
    'head',
    'get',
    'delete',
  ]);

  const callsAfterFailure = store.calls.length;
  await probe();
  expect(store.calls).toHaveLength(callsAfterFailure + 4);
});

test.each([
  {
    name: 'head metadata',
    configure: (store: RecordingStore) => {
      store.transformHead = (metadata) => ({ ...metadata, size_bytes: 2 });
    },
  },
  {
    name: 'downloaded byte',
    configure: (store: RecordingStore) => {
      store.transformGet = (object) => ({
        ...object,
        body: new Blob([new Uint8Array([2])]).stream(),
      });
    },
  },
])('rejects corrupt $name and removes the probe object', async ({ configure }) => {
  const store = new RecordingStore();
  configure(store);
  const probe = createCachedStudioReadinessProbe({ store, role: 'api' });

  await expect(probe()).rejects.toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
  expect(store.calls.map((call) => call.operation).at(-1)).toBe('delete');
  expect(store.objectCount).toBe(0);
});

test('deduplicates concurrent uncached probes', async () => {
  let releasePut = () => {};
  const putReleased = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let markPutStarted = () => {};
  const putStarted = new Promise<void>((resolve) => {
    markPutStarted = resolve;
  });
  const store = new RecordingStore({
    beforeOperation: async (operation) => {
      if (operation === 'put') {
        markPutStarted();
        await putReleased;
      }
    },
  });
  const probe = createCachedStudioReadinessProbe({ store, role: 'api' });

  const first = probe();
  await putStarted;
  const second = probe();
  releasePut();
  await Promise.all([first, second]);

  expect(store.calls.filter((call) => call.operation === 'put')).toHaveLength(1);
  expect(store.calls.filter((call) => call.operation === 'delete')).toHaveLength(1);
});

type Operation = 'put' | 'head' | 'get' | 'delete';

class RecordingStore implements StudioObjectStore {
  readonly namespace = 'readiness-test';
  readonly calls: Array<{ operation: Operation; key: string }> = [];
  readonly puts: Array<Omit<StudioPutObjectInput, 'body'> & { bytes: Uint8Array }> = [];
  readonly objects = new Map<string, { metadata: StudioObjectMetadata; bytes: Uint8Array }>();
  assertReadyCalls = 0;
  transformHead: (metadata: StudioObjectMetadata) => StudioObjectMetadata = (metadata) => metadata;
  transformGet: (object: StudioStoredObject) => StudioStoredObject = (object) => object;

  constructor(
    private readonly options: {
      beforeOperation?: (operation: Operation, key: string) => Promise<void>;
    } = {},
  ) {}

  get objectCount(): number {
    return this.objects.size;
  }

  async assertReady(): Promise<void> {
    this.assertReadyCalls += 1;
  }

  async putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata> {
    await this.record('put', input.key);
    const bytes = await readAll(input.body);
    this.puts.push({ ...input, bytes });
    const metadata: StudioObjectMetadata = {
      namespace: this.namespace,
      key: input.key,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256,
      etag: input.checksum_sha256,
      metadata: { ...input.metadata },
    };
    this.objects.set(input.key, { metadata, bytes });
    return metadata;
  }

  async headObject(ref: StudioObjectRef): Promise<StudioObjectMetadata> {
    await this.record('head', ref.key);
    return this.transformHead({ ...this.requireObject(ref.key).metadata });
  }

  async getObject(ref: StudioObjectRef): Promise<StudioStoredObject> {
    await this.record('get', ref.key);
    const object = this.requireObject(ref.key);
    return this.transformGet({
      ...object.metadata,
      body: new Blob([object.bytes]).stream(),
    });
  }

  async deleteObject(input: StudioDeleteObjectInput): Promise<void> {
    await this.record('delete', input.key);
    this.objects.delete(input.key);
  }

  async listObjects(_input: StudioListObjectsInput): Promise<StudioListObjectsResult> {
    return { objects: [], next_cursor: null };
  }

  async createSignedUploadUrl(_input: StudioSignedUploadInput): Promise<StudioSignedUploadRequest> {
    throw new Error('not implemented');
  }

  async createSignedDownloadUrl(_input: StudioSignedDownloadInput): Promise<string> {
    throw new Error('not implemented');
  }

  private async record(operation: Operation, key: string): Promise<void> {
    this.calls.push({ operation, key });
    await this.options.beforeOperation?.(operation, key);
  }

  private requireObject(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error('missing object');
    return object;
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
