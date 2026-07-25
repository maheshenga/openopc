import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';

import { DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE } from '@kortix/registry';
import { createDeveloperModuleS3ArtifactStore } from './artifacts.s3';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '30000000-0000-4000-a000-000000000003';

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('developer module S3 artifact store', () => {
  test('creates a five-minute private fixed-checksum upload without exposing account identity', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    const store = createDeveloperModuleS3ArtifactStore(objectStore);
    const bytes = new TextEncoder().encode('{"artifact":true}');
    const expectedDigest = digest(bytes);

    const upload = await store.createUpload({
      accountId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      expectedSize: bytes.byteLength,
      expectedDigest,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });

    expect(upload.uploadUrl).toStartWith('memory-upload://developer-trust-private/');
    expect(upload.uploadUrl).not.toContain(ACCOUNT_ID);
    expect(upload.storageKey).not.toContain(ACCOUNT_ID);
    expect(upload.headers).toEqual(
      expect.objectContaining({
        'content-type': DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
        'x-amz-server-side-encryption': 'AES256',
      }),
    );
    expect(upload.uploadUrl).toContain('ttl=300');
  });

  test('reads, content-addresses, and removes staging bytes without public ACLs', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    const store = createDeveloperModuleS3ArtifactStore(objectStore);
    const bytes = new TextEncoder().encode('{"artifact":true}');
    const expectedDigest = digest(bytes);
    const upload = await store.createUpload({
      accountId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      expectedSize: bytes.byteLength,
      expectedDigest,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    await objectStore.putObject({
      key: upload.storageKey,
      body: stream(bytes),
      content_type: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
      size_bytes: bytes.byteLength,
      checksum_sha256: expectedDigest.slice('sha256:'.length),
      metadata: { purpose: 'developer-module-staging' },
    });

    await expect(store.headStaging(upload.storageKey)).resolves.toEqual({
      size: bytes.byteLength,
      digest: expectedDigest,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of store.readStaging(upload.storageKey, {
      maxBytes: bytes.byteLength,
    })) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);

    const finalKey = await store.commit({
      stagingKey: upload.storageKey,
      accountId: ACCOUNT_ID,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect(finalKey).not.toBe(upload.storageKey);
    expect((await objectStore.headObject({ key: finalKey })).metadata).toEqual(
      expect.objectContaining({ purpose: 'developer-module-artifact' }),
    );
    await store.deleteStaging(upload.storageKey);
    await expect(objectStore.headObject({ key: upload.storageKey })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('writes server-synthesized declarative packages idempotently', async () => {
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'developer-trust-private',
      ready: true,
    });
    const store = createDeveloperModuleS3ArtifactStore(objectStore);
    const bytes = new TextEncoder().encode('{"declarative":true}');
    const checksum = digest(bytes);
    const artifactDigest = `sha256:${'b'.repeat(64)}` as const;

    const first = await store.writeCanonical({
      accountId: ACCOUNT_ID,
      artifactDigest,
      bytes,
      digest: checksum,
    });
    const second = await store.writeCanonical({
      accountId: ACCOUNT_ID,
      artifactDigest,
      bytes,
      digest: checksum,
    });

    expect(second).toBe(first);
    expect((await objectStore.headObject({ key: first })).checksum_sha256).toBe(
      checksum.slice('sha256:'.length),
    );
  });
});
