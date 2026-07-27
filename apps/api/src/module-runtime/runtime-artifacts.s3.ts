import { createHash } from 'node:crypto';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioObjectStoreError,
} from '@kortix/studio-runtime';
import {
  type Sha256Digest,
  WASI_RUNTIME_ARTIFACT_MAX_BYTES,
  sha256Digest,
} from '@openopc/module-runtime-contracts';

import {
  type RuntimeArtifactStore,
  RuntimeArtifactStoreError,
  type StoredRuntimeArtifact,
} from './runtime-artifacts';

const MEDIA_TYPE = 'application/wasm' as const;
const STORAGE_PREFIX = 'module-runtime/artifacts/';

function accountPartition(accountId: string): string {
  return createHash('sha256')
    .update(`openopc-module-runtime-artifacts\0${accountId}`)
    .digest('hex');
}

function storageKey(accountId: string, digest: Sha256Digest): string {
  const account = accountPartition(accountId);
  const checksum = digest.slice('sha256:'.length);
  return `${STORAGE_PREFIX}${account.slice(0, 2)}/${account}/${checksum.slice(0, 2)}/${checksum}.wasm`;
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const stored = new Uint8Array(bytes);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(stored);
      controller.close();
    },
  });
}

function assertEncrypted(store: StudioObjectStore, metadata: StudioObjectMetadata): void {
  if (
    store.required_server_side_encryption !== undefined &&
    metadata.server_side_encryption !== store.required_server_side_encryption
  ) {
    throw new RuntimeArtifactStoreError();
  }
  if (
    store.required_server_side_encryption === 'aws:kms' &&
    store.required_sse_kms_key_id &&
    metadata.sse_kms_key_id !== store.required_sse_kms_key_id
  ) {
    throw new RuntimeArtifactStoreError();
  }
}

function metadataMatches(
  store: StudioObjectStore,
  metadata: StudioObjectMetadata,
  input: { key: string; checksum: string; bytes: number },
): boolean {
  assertEncrypted(store, metadata);
  return (
    metadata.key === input.key &&
    metadata.content_type === MEDIA_TYPE &&
    metadata.size_bytes === input.bytes &&
    metadata.checksum_sha256 === input.checksum
  );
}

function storedArtifact(digest: Sha256Digest, bytes: number, key: string): StoredRuntimeArtifact {
  return { digest, bytes, mediaType: MEDIA_TYPE, storageKey: key };
}

function assertStorageKey(key: string): void {
  if (
    !key.startsWith(STORAGE_PREFIX) ||
    key.includes('\\') ||
    key.split('/').some((segment) => segment === '..')
  ) {
    throw new RuntimeArtifactStoreError();
  }
}

export function createRuntimeArtifactS3Store(objectStore: StudioObjectStore): RuntimeArtifactStore {
  return {
    async write(input) {
      if (
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > WASI_RUNTIME_ARTIFACT_MAX_BYTES ||
        (await sha256Digest(input.bytes)) !== input.digest
      ) {
        throw new RuntimeArtifactStoreError();
      }
      await objectStore.assertReady();
      const key = storageKey(input.accountId, input.digest);
      const checksum = input.digest.slice('sha256:'.length);
      const expected = { key, checksum, bytes: input.bytes.byteLength };
      try {
        const metadata = await objectStore.putObject({
          key,
          body: body(input.bytes),
          content_type: MEDIA_TYPE,
          size_bytes: input.bytes.byteLength,
          checksum_sha256: checksum,
          metadata: {
            purpose: 'module-runtime-artifact',
            artifact_digest: input.digest,
          },
          if_none_match: '*',
        });
        if (!metadataMatches(objectStore, metadata, expected))
          throw new RuntimeArtifactStoreError();
      } catch (error) {
        if (!(error instanceof StudioObjectStoreError) || error.code !== 'PRECONDITION_FAILED') {
          throw error;
        }
        const existing = await objectStore.headObject({ key });
        if (!metadataMatches(objectStore, existing, expected))
          throw new RuntimeArtifactStoreError();
      }
      return storedArtifact(input.digest, input.bytes.byteLength, key);
    },

    async *read(key, maxBytes) {
      assertStorageKey(key);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RuntimeArtifactStoreError();
      await objectStore.assertReady();
      const stored = await objectStore.getObject({ key });
      assertEncrypted(objectStore, stored);
      if (
        stored.key !== key ||
        stored.content_type !== MEDIA_TYPE ||
        stored.size_bytes < 1 ||
        stored.size_bytes > maxBytes ||
        stored.size_bytes > WASI_RUNTIME_ARTIFACT_MAX_BYTES ||
        !/^[0-9a-f]{64}$/.test(stored.checksum_sha256)
      ) {
        throw new RuntimeArtifactStoreError();
      }
      const hasher = createHash('sha256');
      const reader = stored.body.getReader();
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > stored.size_bytes || total > maxBytes) throw new RuntimeArtifactStoreError();
          hasher.update(next.value);
          yield new Uint8Array(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (total !== stored.size_bytes || hasher.digest('hex') !== stored.checksum_sha256) {
        throw new RuntimeArtifactStoreError();
      }
    },
  };
}
