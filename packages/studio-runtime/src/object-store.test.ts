import { expect, test } from 'bun:test';
import { runStudioObjectStoreConformance } from '@kortix/studio-runtime/conformance';
import { InMemoryStudioObjectStore } from './object-store';

runStudioObjectStoreConformance(
  'InMemoryStudioObjectStore',
  () => new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true }),
);

test('InMemoryStudioObjectStore reports failed readiness without blocking direct CRUD', async () => {
  const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: false });

  await expect(store.assertReady()).rejects.toThrow('STUDIO_STORAGE_UNAVAILABLE');
});

test('InMemoryStudioObjectStore exposes required and observed server-side encryption', async () => {
  const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
  const bytes = new TextEncoder().encode('encrypted studio object');
  const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  await store.putObject({
    key: 'objects/encrypted.bin',
    body: new Blob([bytes]).stream(),
    content_type: 'application/octet-stream',
    size_bytes: bytes.byteLength,
    checksum_sha256: checksum,
    metadata: {},
  });

  const head = (await store.headObject({ key: 'objects/encrypted.bin' })) as unknown as Record<
    string,
    unknown
  >;
  const advertised = store as unknown as Record<string, unknown>;
  expect(advertised.required_server_side_encryption).toBe('AES256');
  expect(advertised.required_sse_kms_key_id).toBeNull();
  expect(head.server_side_encryption).toBe('AES256');
  expect(head.sse_kms_key_id).toBeNull();
});

test('InMemoryStudioObjectStore returns a browser-executable signed upload request', async () => {
  const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
  const checksum = 'a'.repeat(64);

  const request = await store.createSignedUploadUrl({
    key: 'objects/reference.png',
    content_type: 'image/png',
    size_bytes: 128,
    checksum_sha256: checksum,
    expires_in_seconds: 60,
  });

  expect(request.url).toStartWith('memory-upload://studio-test/objects/reference.png?');
  expect(request.headers).toEqual({
    'content-type': 'image/png',
    'x-amz-checksum-sha256': Buffer.from(checksum, 'hex').toString('base64'),
    'x-amz-meta-studio-checksum-sha256': checksum,
    'x-amz-meta-studio-required-sse': 'AES256',
    'x-amz-server-side-encryption': 'AES256',
  });
});

test('InMemoryStudioObjectStore rejects an exclusive cursor outside the exact prefix', async () => {
  const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
  await expect(
    store.listObjects({
      prefix: 'accounts/a/submissions/hash/',
      cursor: 'accounts/a/submissions/hash-other/object.png',
      limit: 1,
    }),
  ).rejects.toThrow(/cursor/i);
});
