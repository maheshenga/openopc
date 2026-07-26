import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  InMemoryStudioObjectStore,
  type StudioObjectStore,
} from '@kortix/studio-runtime';

import { createDeveloperArtifactRetentionStore } from './artifact-retention-store';

const STAGING_PREFIX = 'developer-modules/staging/';
const STAGING_A = `${STAGING_PREFIX}${'a'.repeat(64)}/upload-a`;
const STAGING_B = `${STAGING_PREFIX}${'b'.repeat(64)}/upload-b`;
const OUTSIDE = 'developer-modules/artifacts/canonical';

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function put(store: InMemoryStudioObjectStore, key: string, bytes: Uint8Array): Promise<void> {
  await store.putObject({
    key,
    body: stream(bytes),
    content_type: 'application/octet-stream',
    size_bytes: bytes.byteLength,
    checksum_sha256: checksum(bytes),
    metadata: { purpose: 'developer-module-staging' },
  });
}

function delegateStore(
  store: InMemoryStudioObjectStore,
  overrides: Partial<StudioObjectStore>,
): StudioObjectStore {
  return {
    namespace: store.namespace,
    required_server_side_encryption: store.required_server_side_encryption,
    required_sse_kms_key_id: store.required_sse_kms_key_id,
    assertReady: () => store.assertReady(),
    putObject: (input) => store.putObject(input),
    headObject: (input) => store.headObject(input),
    getObject: (input) => store.getObject(input),
    listObjects: (input) => store.listObjects(input),
    deleteObject: (input) => store.deleteObject(input),
    createSignedUploadUrl: (input) => store.createSignedUploadUrl(input),
    createSignedDownloadUrl: (input) => store.createSignedDownloadUrl(input),
    ...overrides,
  };
}

describe('developer artifact retention object store', () => {
  test('lists only staging objects and returns trusted key, etag, and modification time', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    await put(objectStore, STAGING_A, new TextEncoder().encode('a'));
    await put(objectStore, STAGING_B, new TextEncoder().encode('b'));
    await put(objectStore, OUTSIDE, new TextEncoder().encode('outside'));

    const store = createDeveloperArtifactRetentionStore(objectStore);
    const first = await store.listStaging({ cursor: null, limit: 1 });

    expect(first.objects).toEqual([
      {
        key: STAGING_A,
        etag: checksum(new TextEncoder().encode('a')),
        lastModified: '2026-07-26T12:00:00.000Z',
      },
    ]);
    expect(first.nextCursor).toBe(STAGING_A);

    await expect(
      store.listStaging({ cursor: first.nextCursor, limit: 10 }),
    ).resolves.toEqual({
      objects: [
        {
          key: STAGING_B,
          etag: checksum(new TextEncoder().encode('b')),
          lastModified: '2026-07-26T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  test('heads staging metadata and treats a missing object as an idempotent result', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const bytes = new TextEncoder().encode('head');
    await put(objectStore, STAGING_A, bytes);
    const store = createDeveloperArtifactRetentionStore(objectStore);

    await expect(store.head(STAGING_A)).resolves.toEqual({
      key: STAGING_A,
      etag: checksum(bytes),
      lastModified: '2026-07-26T12:00:00.000Z',
    });
    await expect(store.head(STAGING_B)).resolves.toBeNull();
  });

  test('deletes only with the supplied ETag and remains idempotent after deletion', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    const bytes = new TextEncoder().encode('delete');
    await put(objectStore, STAGING_A, bytes);
    const store = createDeveloperArtifactRetentionStore(objectStore);

    await expect(store.delete(STAGING_A, 'stale-etag')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(objectStore.headObject({ key: STAGING_A })).resolves.toBeDefined();

    await expect(store.delete(STAGING_A, checksum(bytes))).resolves.toBeUndefined();
    await expect(store.delete(STAGING_A, checksum(bytes))).resolves.toBeUndefined();
    await expect(objectStore.headObject({ key: STAGING_A })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('rejects unbounded listing, opaque cursor, key, and ETag inputs before storage access', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    const store = createDeveloperArtifactRetentionStore(objectStore);

    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await expect(store.listStaging({ cursor: null, limit })).rejects.toThrow(/limit/i);
    }
    for (const cursor of ['', 'opaque\0cursor', 'x'.repeat(2_049)]) {
      await expect(store.listStaging({ cursor, limit: 1 })).rejects.toThrow(/cursor/i);
    }
    for (const key of [
      STAGING_PREFIX,
      OUTSIDE,
      `${STAGING_PREFIX}partition/../artifact`,
      `${STAGING_PREFIX}partition\\artifact`,
      `${STAGING_PREFIX}partition//artifact`,
      `${STAGING_PREFIX}${'x'.repeat(2_049)}`,
    ]) {
      await expect(store.head(key)).rejects.toThrow(/key/i);
      await expect(store.delete(key, 'etag')).rejects.toThrow(/key/i);
    }
    await expect(store.delete(STAGING_A, '')).rejects.toThrow(/etag/i);
    await expect(store.delete(STAGING_A, 'opaque\netag')).rejects.toThrow(/etag/i);
  });

  test('fails closed when HEAD or listing cannot prove required server-side encryption', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    await put(objectStore, STAGING_A, new TextEncoder().encode('encrypted'));
    const mismatched = delegateStore(objectStore, {
      headObject: async (input) => ({
        ...(await objectStore.headObject(input)),
        server_side_encryption: 'aws:kms',
      }),
    });
    const store = createDeveloperArtifactRetentionStore(mismatched);

    await expect(store.head(STAGING_A)).rejects.toThrow(/encryption/i);
    await expect(store.listStaging({ cursor: null, limit: 10 })).rejects.toThrow(/encryption/i);
  });

  test('fails closed when the store omits its encryption policy or the KMS key differs', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    await put(objectStore, STAGING_A, new TextEncoder().encode('kms'));
    const undeclared = delegateStore(objectStore, {
      required_server_side_encryption: undefined,
      required_sse_kms_key_id: undefined,
      headObject: async (input) => ({
        ...(await objectStore.headObject(input)),
        server_side_encryption: undefined,
      }),
    });
    const wrongKmsKey = delegateStore(objectStore, {
      required_server_side_encryption: 'aws:kms',
      required_sse_kms_key_id: 'expected-key',
      headObject: async (input) => ({
        ...(await objectStore.headObject(input)),
        server_side_encryption: 'aws:kms',
        sse_kms_key_id: 'different-key',
      }),
    });

    await expect(createDeveloperArtifactRetentionStore(undeclared).head(STAGING_A)).rejects.toThrow(
      /encryption/i,
    );
    await expect(createDeveloperArtifactRetentionStore(wrongKmsKey).head(STAGING_A)).rejects.toThrow(
      /KMS/i,
    );
  });

  test('fails closed when HEAD does not provide an ETag or modification time', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    await put(objectStore, STAGING_A, new TextEncoder().encode('metadata'));
    const incomplete = delegateStore(objectStore, {
      headObject: async (input) => {
        const metadata = await objectStore.headObject(input);
        return { ...metadata, etag: null, last_modified: undefined };
      },
    });

    await expect(createDeveloperArtifactRetentionStore(incomplete).head(STAGING_A)).rejects.toThrow(
      /metadata/i,
    );
  });
});
