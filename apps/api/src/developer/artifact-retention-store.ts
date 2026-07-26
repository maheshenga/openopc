import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioObjectStoreError,
  StudioStorageUnavailableError,
} from '@kortix/studio-runtime';

import type {
  DeveloperArtifactRetentionObject,
  DeveloperArtifactRetentionStore,
} from './artifact-retention-spec';

export const DEVELOPER_ARTIFACT_STAGING_PREFIX = 'developer-modules/staging/';

const MAX_STORAGE_KEY_BYTES = 1_024;
const MAX_CURSOR_BYTES = 2_048;
const MAX_ETAG_BYTES = 1_024;
const MAX_LIST_LIMIT = 100;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function createDeveloperArtifactRetentionStore(
  objectStore: StudioObjectStore,
): DeveloperArtifactRetentionStore {
  const head = async (storageKey: string): Promise<DeveloperArtifactRetentionObject | null> => {
    assertStagingKey(storageKey);
    let metadata: StudioObjectMetadata;
    try {
      metadata = await objectStore.headObject({ key: storageKey });
    } catch (error) {
      if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
    return retentionObject(objectStore, storageKey, metadata);
  };

  return {
    head,

    async delete(storageKey, etag) {
      assertStagingKey(storageKey);
      assertEtag(etag);
      try {
        await objectStore.deleteObject({ key: storageKey, if_match: etag });
      } catch (error) {
        if (!(error instanceof StudioObjectStoreError) || error.code !== 'NOT_FOUND') throw error;
      }
    },

    async listStaging(input) {
      assertListInput(input);
      const listed = await objectStore.listObjects({
        prefix: DEVELOPER_ARTIFACT_STAGING_PREFIX,
        limit: input.limit,
        ...(input.cursor === null ? {} : { cursor: input.cursor }),
      });
      if (listed.objects.length > input.limit) throw new StudioStorageUnavailableError();

      const objects: DeveloperArtifactRetentionObject[] = [];
      const seen = new Set<string>();
      for (const listedObject of listed.objects) {
        assertStagingKey(listedObject.key);
        if (seen.has(listedObject.key)) throw new StudioStorageUnavailableError();
        seen.add(listedObject.key);
        const trusted = await head(listedObject.key);
        if (trusted) objects.push(trusted);
      }

      const nextCursor = listed.next_cursor;
      if (nextCursor !== null) {
        assertCursor(nextCursor);
        if (nextCursor === input.cursor) throw new StudioStorageUnavailableError();
      }
      return { objects, nextCursor };
    },
  };
}

export const createDeveloperArtifactRetentionObjectStore =
  createDeveloperArtifactRetentionStore;

function retentionObject(
  store: StudioObjectStore,
  storageKey: string,
  metadata: StudioObjectMetadata,
): DeveloperArtifactRetentionObject {
  if (metadata.key !== storageKey) throw new StudioStorageUnavailableError();
  assertEncrypted(store, metadata);
  if (metadata.etag === null || metadata.last_modified === undefined) {
    throw new Error('Developer artifact retention object metadata is incomplete');
  }
  assertEtag(metadata.etag);
  if (!Number.isFinite(Date.parse(metadata.last_modified))) {
    throw new Error('Developer artifact retention object metadata is invalid');
  }
  return {
    key: storageKey,
    etag: metadata.etag,
    lastModified: metadata.last_modified,
  };
}

function assertEncrypted(store: StudioObjectStore, metadata: StudioObjectMetadata): void {
  const requiredEncryption = store.required_server_side_encryption;
  if (
    (requiredEncryption !== 'AES256' && requiredEncryption !== 'aws:kms') ||
    metadata.server_side_encryption !== requiredEncryption
  ) {
    throw new Error('Developer artifact retention object encryption mismatch');
  }
  if (requiredEncryption === 'aws:kms' && (
    !store.required_sse_kms_key_id ||
    metadata.sse_kms_key_id !== store.required_sse_kms_key_id
  )) {
    throw new Error('Developer artifact retention object KMS key mismatch');
  }
}

function assertListInput(input: { cursor: string | null; limit: number }): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIST_LIMIT) {
    throw new Error('Invalid developer artifact retention list limit');
  }
  if (input.cursor !== null) assertCursor(input.cursor);
}

function assertCursor(cursor: string): void {
  if (
    cursor.length === 0 ||
    Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES ||
    cursor.includes('\0')
  ) {
    throw new Error('Invalid developer artifact retention list cursor');
  }
}

function assertStagingKey(storageKey: string): void {
  const suffix = storageKey.slice(DEVELOPER_ARTIFACT_STAGING_PREFIX.length);
  if (
    !storageKey.startsWith(DEVELOPER_ARTIFACT_STAGING_PREFIX) ||
    Buffer.byteLength(storageKey, 'utf8') > MAX_STORAGE_KEY_BYTES ||
    suffix.length === 0 ||
    storageKey.includes('\\') ||
    CONTROL_CHARACTER.test(storageKey) ||
    suffix
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid developer artifact retention storage key');
  }
}

function assertEtag(etag: string): void {
  if (
    etag.length === 0 ||
    Buffer.byteLength(etag, 'utf8') > MAX_ETAG_BYTES ||
    etag.trim() !== etag ||
    CONTROL_CHARACTER.test(etag)
  ) {
    throw new Error('Invalid developer artifact retention object ETag');
  }
}
