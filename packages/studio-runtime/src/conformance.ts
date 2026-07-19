import { describe, expect, test } from 'bun:test';
import type { StudioObjectStore } from './object-store';

const PNG = new Uint8Array([137, 80, 78, 71]);
const SHA256 = new Bun.CryptoHasher('sha256').update(PNG).digest('hex');
const KEY = 'accounts/a/projects/p/file.png';

export function runStudioObjectStoreConformance(
  name: string,
  createStore: () => StudioObjectStore | Promise<StudioObjectStore>,
): void {
  describe(`${name} Studio object store conformance`, () => {
    test('binds a namespace and preserves metadata across put, head, and get', async () => {
      const store = await createStore();

      await expect(store.assertReady()).resolves.toBeUndefined();
      const written = await putPng(store);

      expect(written).toMatchObject({
        namespace: store.namespace,
        key: KEY,
        content_type: 'image/png',
        size_bytes: PNG.byteLength,
        checksum_sha256: SHA256,
        metadata: { project_id: 'p' },
      });
      expect(written.etag).toBeString();
      expect(await store.headObject({ key: KEY })).toMatchObject(written);
      const object = await store.getObject({ key: KEY });
      expect(await readAll(object.body)).toEqual(PNG);
      expect(object).toMatchObject(written);

      const mutable = await store.getObject({ key: KEY });
      const firstChunk = await mutable.body.getReader().read();
      if (firstChunk.done) throw new Error('stored object body was empty');
      firstChunk.value[0] = 0;
      expect(await readAll((await store.getObject({ key: KEY })).body)).toEqual(PNG);
    });

    test('creates upload and download URLs from constrained inputs', async () => {
      const store = await createStore();

      const upload = await store.createSignedUploadUrl({
        key: KEY,
        content_type: 'image/png',
        size_bytes: PNG.byteLength,
        checksum_sha256: SHA256,
        expires_in_seconds: 60,
      });
      const download = await store.createSignedDownloadUrl({
        key: KEY,
        filename: 'safe file.png',
        expires_in_seconds: 60,
      });
      const uploadVariants = await Promise.all([
        store.createSignedUploadUrl({
          key: KEY,
          content_type: 'application/octet-stream',
          size_bytes: PNG.byteLength,
          checksum_sha256: SHA256,
          expires_in_seconds: 60,
        }),
        store.createSignedUploadUrl({
          key: KEY,
          content_type: 'image/png',
          size_bytes: PNG.byteLength + 1,
          checksum_sha256: SHA256,
          expires_in_seconds: 60,
        }),
        store.createSignedUploadUrl({
          key: KEY,
          content_type: 'image/png',
          size_bytes: PNG.byteLength,
          checksum_sha256: 'different-checksum',
          expires_in_seconds: 60,
        }),
        store.createSignedUploadUrl({
          key: KEY,
          content_type: 'image/png',
          size_bytes: PNG.byteLength,
          checksum_sha256: SHA256,
          expires_in_seconds: 120,
        }),
      ]);
      const downloadVariants = await Promise.all([
        store.createSignedDownloadUrl({
          key: KEY,
          filename: 'different.png',
          expires_in_seconds: 60,
        }),
        store.createSignedDownloadUrl({
          key: KEY,
          filename: 'safe file.png',
          expires_in_seconds: 120,
        }),
      ]);
      const specialKeyUpload = await store.createSignedUploadUrl({
        key: 'accounts/a/projects/p/file ?#%.png',
        content_type: 'image/png',
        size_bytes: PNG.byteLength,
        checksum_sha256: SHA256,
        expires_in_seconds: 60,
      });
      const specialKeyDownload = await store.createSignedDownloadUrl({
        key: 'accounts/a/projects/p/file ?#%.png',
        filename: 'safe file.png',
        expires_in_seconds: 60,
      });

      expect(upload.url).toContain('file.png');
      expect(upload.headers['content-type']).toBe('image/png');
      expect(upload.headers).not.toHaveProperty('content-length');
      expect(download).toContain('file.png');
      expect(upload.url).not.toBe(download);
      expect(new Set([upload.url, ...uploadVariants.map((variant) => variant.url)]).size).toBe(5);
      expect(new Set([download, ...downloadVariants]).size).toBe(3);
      expect(specialKeyUpload.url).toContain('file%20%3F%23%25.png');
      expect(specialKeyDownload).toContain('file%20%3F%23%25.png');
    });

    test('rejects checksum mismatches before publishing metadata', async () => {
      const store = await createStore();

      await expect(
        store.putObject({
          key: KEY,
          body: new Blob([PNG]).stream(),
          content_type: 'image/png',
          size_bytes: PNG.byteLength,
          checksum_sha256: '0'.repeat(64),
          metadata: { project_id: 'p' },
        }),
      ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
      await expect(store.headObject({ key: KEY })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('rejects size mismatches before publishing metadata', async () => {
      const store = await createStore();

      await expect(
        store.putObject({
          key: KEY,
          body: new Blob([PNG]).stream(),
          content_type: 'image/png',
          size_bytes: PNG.byteLength + 1,
          checksum_sha256: SHA256,
          metadata: { project_id: 'p' },
        }),
      ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
      await expect(store.headObject({ key: KEY })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('conditionally creates without overwriting an existing object', async () => {
      const store = await createStore();
      const written = await putPng(store);
      const replacement = new Uint8Array([1, 2, 3, 4]);
      const replacementChecksum = new Bun.CryptoHasher('sha256').update(replacement).digest('hex');

      await expect(
        store.putObject({
          key: KEY,
          body: new Blob([replacement]).stream(),
          content_type: 'application/octet-stream',
          size_bytes: replacement.byteLength,
          checksum_sha256: replacementChecksum,
          metadata: { project_id: 'replacement' },
          if_none_match: '*',
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      expect(await store.headObject({ key: KEY })).toMatchObject(written);
      expect(await readAll((await store.getObject({ key: KEY })).body)).toEqual(PNG);
    });

    test('deletes conditionally with typed errors and never invokes readiness from CRUD', async () => {
      const store = await createStore();
      let readinessCalls = 0;
      store.assertReady = async () => {
        readinessCalls += 1;
        throw new Error('CRUD must not invoke readiness');
      };

      const written = await putPng(store);
      await expect(store.getObject({ key: KEY })).resolves.toMatchObject({ key: KEY });
      await expect(
        store.createSignedUploadUrl({
          key: KEY,
          content_type: 'image/png',
          size_bytes: PNG.byteLength,
          checksum_sha256: SHA256,
          expires_in_seconds: 60,
        }),
      ).resolves.toMatchObject({
        url: expect.any(String),
        headers: expect.any(Object),
      });
      await expect(
        store.createSignedDownloadUrl({
          key: KEY,
          filename: 'safe file.png',
          expires_in_seconds: 60,
        }),
      ).resolves.toBeString();
      await expect(store.deleteObject({ key: KEY, if_match: 'wrong-etag' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      await expect(store.headObject({ key: KEY })).resolves.toMatchObject({ etag: written.etag });

      await store.deleteObject({ key: KEY, if_match: written.etag ?? undefined });
      await expect(store.headObject({ key: KEY })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(readinessCalls).toBe(0);
    });

    test('lists only an exact bounded prefix with stable cursor pagination and trusted metadata', async () => {
      const store = await createStore();
      const prefix = 'accounts/a/projects/p/jobs/j/attempts/t/submissions/h/';
      for (const [index, suffix] of ['a.png', 'b.png', 'nested/c.png'].entries()) {
        await store.putObject({
          key: `${prefix}${suffix}`,
          body: new Blob([PNG]).stream(),
          content_type: 'image/png',
          size_bytes: PNG.byteLength,
          checksum_sha256: SHA256,
          metadata: { index: String(index) },
        });
      }
      await store.putObject({
        key: `${prefix.slice(0, -1)}-other/ignored.png`,
        body: new Blob([PNG]).stream(),
        content_type: 'image/png',
        size_bytes: PNG.byteLength,
        checksum_sha256: SHA256,
        metadata: {},
      });

      const first = await store.listObjects({ prefix, limit: 2 });
      expect(first.objects).toHaveLength(2);
      expect(first.next_cursor).toBeString();
      expect(first.objects.map((object) => object.key)).toEqual([
        `${prefix}a.png`,
        `${prefix}b.png`,
      ]);
      for (const object of first.objects) {
        expect(object).toMatchObject({
          namespace: store.namespace,
          etag: expect.any(String),
          checksum_sha256: SHA256,
          size_bytes: PNG.byteLength,
        });
        expect(Number.isFinite(Date.parse(object.last_modified))).toBe(true);
      }

      const second = await store.listObjects({
        prefix,
        cursor: first.next_cursor ?? undefined,
        limit: 2,
      });
      expect(second).toMatchObject({
        objects: [{ key: `${prefix}nested/c.png` }],
        next_cursor: null,
      });
      await expect(store.listObjects({ prefix: prefix.slice(0, -1), limit: 2 })).rejects.toThrow(
        /prefix/i,
      );
      await expect(store.listObjects({ prefix, limit: 0 })).rejects.toThrow(/limit/i);
      await expect(store.listObjects({ prefix, limit: 101 })).rejects.toThrow(/limit/i);
      await expect(store.listObjects({ prefix, cursor: '', limit: 2 })).rejects.toThrow(/cursor/i);
    });
  });
}

async function putPng(store: StudioObjectStore) {
  return store.putObject({
    key: KEY,
    body: new Blob([PNG]).stream(),
    content_type: 'image/png',
    size_bytes: PNG.byteLength,
    checksum_sha256: SHA256,
    metadata: { project_id: 'p' },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
