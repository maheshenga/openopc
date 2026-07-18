import { describe, expect, test } from 'bun:test';
import type { WorkflowRun } from '@kortix/intelligence-contracts';
import type { WorkflowPayloadStore, WorkflowPort } from './contracts';
import { canonicalWorkflowHash } from './hash';

export type WorkflowPortConformanceFixture = {
  createPort: () => WorkflowPort | Promise<WorkflowPort>;
  run: () => WorkflowRun;
};

export function runWorkflowPortConformance(
  name: string,
  fixture: WorkflowPortConformanceFixture,
): void {
  describe(`${name} WorkflowPort conformance`, () => {
    test('replays one project-scoped run idempotently', async () => {
      const port = await fixture.createPort();
      const run = fixture.run();

      const created = await port.startRun({ run });
      const replayed = await port.startRun({ run });

      expect(created).toEqual({ run, created: true });
      expect(replayed).toEqual({ run, created: false });
    });
  });
}

export function runWorkflowPayloadStoreConformance(
  name: string,
  createStore: () => WorkflowPayloadStore | Promise<WorkflowPayloadStore>,
): void {
  describe(`${name} WorkflowPayloadStore conformance`, () => {
    test('seals, reads, and deletes an opaque hash-bound payload', async () => {
      const store = await createStore();
      const content = new TextEncoder().encode('{"private":true}');
      const contentHash = canonicalWorkflowHash({ private: true });
      const scope = {
        accountId: '63000000-0000-4000-a000-000000000001',
        projectId: '64000000-0000-4000-a000-000000000001',
        runId: '61000000-0000-4000-a000-000000000001',
      };
      const sealed = await store.seal({
        ...scope,
        nodeKey: 'render-primary',
        content,
        contentHash,
      });

      expect(sealed.payloadRef).toMatch(/^sealed:[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/);
      await expect(
        store.read({
          ...scope,
          nodeId: '62000000-0000-4000-a000-000000000001',
          payloadRef: sealed.payloadRef,
          expectedHash: contentHash,
        }),
      ).resolves.toEqual(content);
      await store.delete({ ...scope, payloadRef: sealed.payloadRef, expectedHash: contentHash });
      await expect(
        store.read({
          ...scope,
          nodeId: '62000000-0000-4000-a000-000000000001',
          payloadRef: sealed.payloadRef,
          expectedHash: contentHash,
        }),
      ).resolves.toBeNull();
    });
  });
}
