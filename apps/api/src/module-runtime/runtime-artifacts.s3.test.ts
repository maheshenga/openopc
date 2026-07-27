import { expect, test } from 'bun:test';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioObjectStoreError,
  type StudioPutObjectInput,
  type StudioStoredObject,
} from '@kortix/studio-runtime';

import { createRuntimeArtifactS3Store } from './runtime-artifacts.s3';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const DIGEST = 'sha256:cd5d4935a48c0672cb06407bb443bc0087aff947c6b864bac886982c73b3027f' as const;
const CHECKSUM = DIGEST.slice('sha256:'.length);
const STORAGE_KEY =
  'module-runtime/artifacts/65/65acd151d3a0598b350d13d0390cc7c060c380345eeb2bea2ad603f474accd4f/cd/cd5d4935a48c0672cb06407bb443bc0087aff947c6b864bac886982c73b3027f.wasm';

async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class RecordingObjectStore implements StudioObjectStore {
  readonly namespace = 'runtime-artifacts-test';
  readonly required_server_side_encryption = 'AES256' as const;
  readonly required_sse_kms_key_id = null;
  readonly puts: StudioPutObjectInput[] = [];
  readyCalls = 0;
  conflict = false;
  existing: StudioObjectMetadata = this.metadata();

  metadata(overrides: Partial<StudioObjectMetadata> = {}): StudioObjectMetadata {
    return {
      namespace: this.namespace,
      key: STORAGE_KEY,
      content_type: 'application/wasm',
      size_bytes: 4,
      checksum_sha256: CHECKSUM,
      etag: 'etag-1',
      metadata: { purpose: 'module-runtime-artifact', artifact_digest: DIGEST },
      server_side_encryption: 'AES256',
      sse_kms_key_id: null,
      ...overrides,
    };
  }

  async assertReady(): Promise<void> {
    this.readyCalls += 1;
  }

  async putObject(input: StudioPutObjectInput): Promise<StudioObjectMetadata> {
    this.puts.push({ ...input, body: input.body });
    if (this.conflict) throw new StudioObjectStoreError('PRECONDITION_FAILED', 'exists');
    expect(await readBody(input.body)).toEqual(new Uint8Array([0, 97, 115, 109]));
    return this.metadata();
  }

  async headObject(): Promise<StudioObjectMetadata> {
    return this.existing;
  }

  async getObject(): Promise<StudioStoredObject> {
    return {
      ...this.existing,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 97, 115, 109]));
          controller.close();
        },
      }),
    };
  }

  listObjects(): never {
    throw new Error('unexpected list');
  }
  deleteObject(): never {
    throw new Error('unexpected delete');
  }
  createSignedUploadUrl(): never {
    throw new Error('unexpected signed upload');
  }
  createSignedDownloadUrl(): never {
    throw new Error('unexpected signed download');
  }
}

test('runtime artifact S3 store writes an encrypted content-addressed WASM object', async () => {
  const objectStore = new RecordingObjectStore();
  const store = createRuntimeArtifactS3Store(objectStore);

  await expect(
    store.write({
      accountId: ACCOUNT_ID,
      digest: DIGEST,
      bytes: new Uint8Array([0, 97, 115, 109]),
    }),
  ).resolves.toEqual({
    digest: DIGEST,
    bytes: 4,
    mediaType: 'application/wasm',
    storageKey: STORAGE_KEY,
  });

  expect(objectStore.readyCalls).toBe(1);
  expect(objectStore.puts).toHaveLength(1);
  expect(objectStore.puts[0]).toMatchObject({
    key: STORAGE_KEY,
    content_type: 'application/wasm',
    size_bytes: 4,
    checksum_sha256: CHECKSUM,
    metadata: { purpose: 'module-runtime-artifact', artifact_digest: DIGEST },
    if_none_match: '*',
  });
});

test('runtime artifact S3 store accepts an exact idempotent rewrite only', async () => {
  const matching = new RecordingObjectStore();
  matching.conflict = true;
  await expect(
    createRuntimeArtifactS3Store(matching).write({
      accountId: ACCOUNT_ID,
      digest: DIGEST,
      bytes: new Uint8Array([0, 97, 115, 109]),
    }),
  ).resolves.toMatchObject({ storageKey: STORAGE_KEY });

  for (const existing of [
    matching.metadata({ size_bytes: 5 }),
    matching.metadata({ checksum_sha256: '0'.repeat(64) }),
    matching.metadata({ content_type: 'application/octet-stream' }),
    matching.metadata({ server_side_encryption: undefined }),
  ]) {
    const mismatch = new RecordingObjectStore();
    mismatch.conflict = true;
    mismatch.existing = existing;
    await expect(
      createRuntimeArtifactS3Store(mismatch).write({
        accountId: ACCOUNT_ID,
        digest: DIGEST,
        bytes: new Uint8Array([0, 97, 115, 109]),
      }),
    ).rejects.toBeInstanceOf(Error);
  }
});
