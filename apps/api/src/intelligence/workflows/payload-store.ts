import { createHash, randomUUID as cryptoRandomUUID } from 'node:crypto';
import type { WorkflowPayloadStore } from '@kortix/intelligence-orchestration';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioObjectStoreError,
  StudioStorageUnavailableError,
  type StudioStoredObject,
} from '@kortix/studio-runtime';

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const CONTENT_TYPE = 'application/json' as const;
const PAYLOAD_REF_PATTERN = /^sealed:[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;

export type WorkflowPayloadStoreErrorCode =
  | 'WORKFLOW_PAYLOAD_INVALID'
  | 'WORKFLOW_PAYLOAD_INTEGRITY_CONFLICT';

export class WorkflowPayloadStoreError extends Error {
  constructor(readonly code: WorkflowPayloadStoreErrorCode) {
    super(code);
    this.name = 'WorkflowPayloadStoreError';
  }
}

export function createStudioWorkflowPayloadStore(
  store: StudioObjectStore,
  options: { randomUUID?: () => string } = {},
): WorkflowPayloadStore {
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;

  return {
    async seal(input) {
      assertScope(input.accountId, input.projectId, input.runId, input.nodeKey);
      assertHash(input.contentHash);
      if (input.content.byteLength < 1 || input.content.byteLength > MAX_PAYLOAD_BYTES) {
        throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INVALID');
      }
      const checksum = sha256(input.content);
      if (`sha256:${checksum}` !== input.contentHash) {
        throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INTEGRITY_CONFLICT');
      }

      const payloadRef = `sealed:${randomUUID()}`;
      if (!PAYLOAD_REF_PATTERN.test(payloadRef)) {
        throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INVALID');
      }
      const key = objectKey(payloadRef);
      await store.assertReady();
      const metadata = await store.putObject({
        key,
        body: byteStream(input.content),
        content_type: CONTENT_TYPE,
        size_bytes: input.content.byteLength,
        checksum_sha256: checksum,
        metadata: {
          workflow_payload_ref: payloadRef,
          workflow_account_id: input.accountId,
          workflow_project_id: input.projectId,
          workflow_run_id: input.runId,
          workflow_node_key: input.nodeKey,
        },
        if_none_match: '*',
      });
      if (!matchesMetadata(metadata, store.namespace, key, input.content.byteLength, checksum)) {
        throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INTEGRITY_CONFLICT');
      }
      return {
        payloadRef,
        contentHash: input.contentHash,
        byteLength: input.content.byteLength,
        contentType: CONTENT_TYPE,
      };
    },

    async read(input) {
      const key = validKey(input.payloadRef);
      if (!key || !isHash(input.expectedHash)) return null;
      await store.assertReady();
      let object: StudioStoredObject;
      try {
        object = await store.getObject({ key });
      } catch (error) {
        if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return null;
        if (error instanceof StudioStorageUnavailableError) throw error;
        return null;
      }
      if (
        object.namespace !== store.namespace ||
        object.key !== key ||
        object.content_type !== CONTENT_TYPE ||
        object.metadata.workflow_payload_ref !== input.payloadRef ||
        object.metadata.workflow_account_id !== input.accountId ||
        object.metadata.workflow_project_id !== input.projectId ||
        object.metadata.workflow_run_id !== input.runId ||
        object.checksum_sha256 !== input.expectedHash.slice(7) ||
        object.size_bytes < 1 ||
        object.size_bytes > MAX_PAYLOAD_BYTES
      ) {
        return null;
      }
      const bytes = await readBytes(object.body, MAX_PAYLOAD_BYTES);
      return bytes &&
        bytes.byteLength === object.size_bytes &&
        `sha256:${sha256(bytes)}` === input.expectedHash
        ? bytes
        : null;
    },

    async delete(input) {
      const key = validKey(input.payloadRef);
      if (!key || !isHash(input.expectedHash)) {
        throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INVALID');
      }
      await store.assertReady();
      let metadata: StudioObjectMetadata;
      try {
        metadata = await store.headObject({ key });
      } catch (error) {
        if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return;
        throw error;
      }
      if (
        !matchesMetadata(
          metadata,
          store.namespace,
          key,
          metadata.size_bytes,
          input.expectedHash.slice(7),
        ) ||
        metadata.metadata.workflow_payload_ref !== input.payloadRef ||
        metadata.metadata.workflow_account_id !== input.accountId ||
        metadata.metadata.workflow_project_id !== input.projectId ||
        metadata.metadata.workflow_run_id !== input.runId
      ) {
        throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INTEGRITY_CONFLICT');
      }
      try {
        await store.deleteObject({ key, if_match: metadata.etag ?? undefined });
      } catch (error) {
        if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return;
        throw error;
      }
    },
  };
}

export async function cleanupStudioWorkflowPayloadOrphans(
  store: StudioObjectStore,
  input: { referencedPayloadRefs: ReadonlySet<string>; limit: number },
): Promise<number> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INVALID');
  }
  await store.assertReady();
  const page = await store.listObjects({ prefix: 'workflows/payloads/', limit: input.limit });
  let deleted = 0;
  for (const object of page.objects) {
    const token = object.key.startsWith('workflows/payloads/')
      ? object.key.slice('workflows/payloads/'.length).replace(/\.json$/, '')
      : '';
    const payloadRef = `sealed:${token}`;
    if (!PAYLOAD_REF_PATTERN.test(payloadRef) || input.referencedPayloadRefs.has(payloadRef)) {
      continue;
    }
    try {
      await store.deleteObject({ key: object.key, if_match: object.etag });
      deleted += 1;
    } catch (error) {
      if (!(error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND')) throw error;
    }
  }
  return deleted;
}

function assertScope(...values: string[]): void {
  if (values.some((value) => value.trim() === '')) {
    throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INVALID');
  }
}

function assertHash(value: string): void {
  if (!isHash(value)) throw new WorkflowPayloadStoreError('WORKFLOW_PAYLOAD_INVALID');
}

function isHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function validKey(payloadRef: string): string | null {
  return PAYLOAD_REF_PATTERN.test(payloadRef) ? objectKey(payloadRef) : null;
}

function objectKey(payloadRef: string): string {
  return `workflows/payloads/${payloadRef.slice('sealed:'.length)}.json`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function matchesMetadata(
  metadata: StudioObjectMetadata,
  namespace: string,
  key: string,
  size: number,
  checksum: string,
): boolean {
  return (
    metadata.namespace === namespace &&
    metadata.key === key &&
    metadata.content_type === CONTENT_TYPE &&
    metadata.size_bytes === size &&
    metadata.checksum_sha256 === checksum
  );
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

async function readBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) return null;
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
