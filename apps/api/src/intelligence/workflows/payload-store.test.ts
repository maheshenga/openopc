import { describe, expect, test } from 'bun:test';
import { runWorkflowPayloadStoreConformance } from '@kortix/intelligence-orchestration/conformance';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import {
  cleanupStudioWorkflowPayloadOrphans,
  createStudioWorkflowPayloadStore,
} from './payload-store';

const ACCOUNT_ID = '63000000-0000-4000-a000-000000000001';
const PROJECT_ID = '64000000-0000-4000-a000-000000000001';
const RUN_ID = '61000000-0000-4000-a000-000000000001';
const CONTENT = new TextEncoder().encode('{"prompt":"private"}');
const HASH = `sha256:${new Bun.CryptoHasher('sha256').update(CONTENT).digest('hex')}`;

describe('Studio workflow payload store', () => {
  test('seals opaque private JSON bytes and verifies metadata on read', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const payloads = createStudioWorkflowPayloadStore(store, {
      randomUUID: () => '71000000-0000-4000-a000-000000000001',
    });

    const sealed = await payloads.seal({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeKey: 'render-primary',
      content: CONTENT,
      contentHash: HASH,
    });

    expect(sealed).toMatchObject({
      payloadRef: 'sealed:71000000-0000-4000-a000-000000000001',
      contentHash: HASH,
      byteLength: CONTENT.byteLength,
      contentType: 'application/json',
    });
    expect(
      await payloads.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: '62000000-0000-4000-a000-000000000001',
        payloadRef: sealed.payloadRef,
        expectedHash: HASH,
      }),
    ).toEqual(CONTENT);
  });

  test('does not return bytes when the expected hash or object metadata is changed', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const payloads = createStudioWorkflowPayloadStore(store, {
      randomUUID: () => '71000000-0000-4000-a000-000000000002',
    });
    const sealed = await payloads.seal({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeKey: 'render-primary',
      content: CONTENT,
      contentHash: HASH,
    });

    await expect(
      payloads.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: '62000000-0000-4000-a000-000000000001',
        payloadRef: sealed.payloadRef,
        expectedHash: `sha256:${'b'.repeat(64)}`,
      }),
    ).resolves.toBeNull();
    await expect(
      payloads.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: '62000000-0000-4000-a000-000000000001',
        payloadRef: 'sealed:not-a-valid-token!',
        expectedHash: HASH,
      }),
    ).resolves.toBeNull();
  });

  test('deletes with a conditional ETag and treats missing payloads as already cleaned', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const payloads = createStudioWorkflowPayloadStore(store, {
      randomUUID: () => '71000000-0000-4000-a000-000000000003',
    });
    const sealed = await payloads.seal({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeKey: 'render-primary',
      content: CONTENT,
      contentHash: HASH,
    });

    await payloads.delete({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      payloadRef: sealed.payloadRef,
      expectedHash: HASH,
    });
    await expect(
      payloads.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: '62000000-0000-4000-a000-000000000001',
        payloadRef: sealed.payloadRef,
        expectedHash: HASH,
      }),
    ).resolves.toBeNull();
    await expect(
      payloads.delete({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        payloadRef: sealed.payloadRef,
        expectedHash: HASH,
      }),
    ).resolves.toBeUndefined();
  });

  test('cleans only bounded unreferenced payload objects', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const payloads = createStudioWorkflowPayloadStore(store, {
      randomUUID: () => '71000000-0000-4000-a000-000000000004',
    });
    const sealed = await payloads.seal({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeKey: 'render-primary',
      content: CONTENT,
      contentHash: HASH,
    });
    const orphan = await createStudioWorkflowPayloadStore(store, {
      randomUUID: () => '71000000-0000-4000-a000-000000000005',
    }).seal({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeKey: 'render-secondary',
      content: CONTENT,
      contentHash: HASH,
    });

    await expect(
      cleanupStudioWorkflowPayloadOrphans(store, {
        referencedPayloadRefs: new Set([sealed.payloadRef]),
        limit: 2,
      }),
    ).resolves.toBe(1);
    await expect(
      payloads.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: '62000000-0000-4000-a000-000000000001',
        payloadRef: sealed.payloadRef,
        expectedHash: HASH,
      }),
    ).resolves.toEqual(CONTENT);
    await expect(
      payloads.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: '62000000-0000-4000-a000-000000000001',
        payloadRef: orphan.payloadRef,
        expectedHash: HASH,
      }),
    ).resolves.toBeNull();
  });
});

runWorkflowPayloadStoreConformance('StudioWorkflowPayloadStore', () =>
  createStudioWorkflowPayloadStore(
    new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true }),
  ),
);
