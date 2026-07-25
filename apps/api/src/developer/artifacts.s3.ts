import { createHash } from 'node:crypto';
import { DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE } from '@kortix/registry';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioObjectStoreError,
} from '@kortix/studio-runtime';

import type { DeveloperArtifactStore } from './artifacts';

const UPLOAD_TTL_SECONDS = 300;

function accountPartition(accountId: string): string {
  return createHash('sha256').update(`openopc-developer-artifacts\0${accountId}`).digest('hex');
}

function stagingKey(accountId: string, uploadId: string): string {
  return `developer-modules/staging/${accountPartition(accountId)}/${uploadId}`;
}

function artifactKey(accountId: string, artifactDigest: `sha256:${string}`): string {
  return `developer-modules/artifacts/${accountPartition(accountId)}/${artifactDigest.slice('sha256:'.length)}`;
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function assertEncrypted(store: StudioObjectStore, metadata: StudioObjectMetadata): void {
  if (
    store.required_server_side_encryption !== undefined &&
    metadata.server_side_encryption !== store.required_server_side_encryption
  ) {
    throw new Error('Developer artifact object encryption mismatch');
  }
  if (
    store.required_server_side_encryption === 'aws:kms' &&
    store.required_sse_kms_key_id &&
    metadata.sse_kms_key_id !== store.required_sse_kms_key_id
  ) {
    throw new Error('Developer artifact object KMS key mismatch');
  }
}

async function existingMatches(
  store: StudioObjectStore,
  key: string,
  size: number,
  checksum: string,
): Promise<boolean> {
  const existing = await store.headObject({ key });
  assertEncrypted(store, existing);
  return existing.size_bytes === size && existing.checksum_sha256 === checksum;
}

export function createDeveloperModuleS3ArtifactStore(
  objectStore: StudioObjectStore,
): DeveloperArtifactStore {
  return {
    async createUpload(input) {
      await objectStore.assertReady();
      if (input.expiresAt.getTime() <= Date.now())
        throw new Error('Developer artifact upload expired');
      const key = stagingKey(input.accountId, input.uploadId);
      const signed = await objectStore.createSignedUploadUrl({
        key,
        content_type: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
        size_bytes: input.expectedSize,
        checksum_sha256: input.expectedDigest.slice('sha256:'.length),
        expires_in_seconds: UPLOAD_TTL_SECONDS,
      });
      return { storageKey: key, uploadUrl: signed.url, headers: { ...signed.headers } };
    },

    async headStaging(key) {
      const metadata = await objectStore.headObject({ key });
      assertEncrypted(objectStore, metadata);
      if (metadata.content_type !== DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE) {
        throw new Error('Developer artifact content type mismatch');
      }
      return {
        size: metadata.size_bytes,
        digest: `sha256:${metadata.checksum_sha256}`,
      };
    },

    async *readStaging(key, limits) {
      const stored = await objectStore.getObject({ key });
      assertEncrypted(objectStore, stored);
      const reader = stored.body.getReader();
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > limits.maxBytes)
            throw new Error('Developer artifact staging object too large');
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    },

    async *readCanonical(key, limits) {
      const stored = await objectStore.getObject({ key });
      assertEncrypted(objectStore, stored);
      if (stored.content_type !== DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE) {
        throw new Error('Developer artifact content type mismatch');
      }
      const reader = stored.body.getReader();
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > limits.maxBytes) throw new Error('Developer canonical artifact too large');
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    },

    async commit(input) {
      const stored = await objectStore.getObject({ key: input.stagingKey });
      assertEncrypted(objectStore, stored);
      const key = artifactKey(input.accountId, input.artifactDigest);
      try {
        await objectStore.putObject({
          key,
          body: stored.body,
          content_type: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
          size_bytes: stored.size_bytes,
          checksum_sha256: stored.checksum_sha256,
          metadata: {
            purpose: 'developer-module-artifact',
            artifact_digest: input.artifactDigest,
          },
          if_none_match: '*',
        });
      } catch (error) {
        if (
          !(error instanceof StudioObjectStoreError) ||
          error.code !== 'PRECONDITION_FAILED' ||
          !(await existingMatches(objectStore, key, stored.size_bytes, stored.checksum_sha256))
        ) {
          throw error;
        }
      }
      return key;
    },

    async writeCanonical(input) {
      const key = artifactKey(input.accountId, input.artifactDigest);
      const checksum = input.digest.slice('sha256:'.length);
      try {
        await objectStore.putObject({
          key,
          body: body(input.bytes),
          content_type: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
          size_bytes: input.bytes.byteLength,
          checksum_sha256: checksum,
          metadata: {
            purpose: 'developer-module-artifact',
            artifact_digest: input.artifactDigest,
          },
          if_none_match: '*',
        });
      } catch (error) {
        if (
          !(error instanceof StudioObjectStoreError) ||
          error.code !== 'PRECONDITION_FAILED' ||
          !(await existingMatches(objectStore, key, input.bytes.byteLength, checksum))
        ) {
          throw error;
        }
      }
      return key;
    },

    async deleteStaging(key) {
      try {
        await objectStore.deleteObject({ key });
      } catch (error) {
        if (!(error instanceof StudioObjectStoreError) || error.code !== 'NOT_FOUND') throw error;
      }
    },
  };
}
