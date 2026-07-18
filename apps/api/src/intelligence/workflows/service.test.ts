import { describe, expect, test } from 'bun:test';
import type { WorkflowNode } from '@kortix/intelligence-contracts';
import type { WorkflowPayloadStore } from '@kortix/intelligence-orchestration';
import {
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { createMemoryWorkflowStore } from './memory-store';
import { createStudioWorkflowPayloadStore } from './payload-store';
import { createWorkflowService } from './service';

const NOW = '2026-07-18T10:00:00.000Z';

class RecordingPayloadStore implements WorkflowPayloadStore {
  private tokenCounter = 10;
  readonly inner = createStudioWorkflowPayloadStore(
    new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true }),
    {
      randomUUID: () => `71000000-0000-4000-a000-${String(this.tokenCounter++).padStart(12, '0')}`,
    },
  );
  sealed: string[] = [];
  deleted: string[] = [];
  reads = 0;

  async seal(input: Parameters<WorkflowPayloadStore['seal']>[0]) {
    const result = await this.inner.seal(input);
    this.sealed.push(result.payloadRef);
    return result;
  }

  async read(input: Parameters<WorkflowPayloadStore['read']>[0]) {
    this.reads += 1;
    return this.inner.read(input);
  }

  async delete(input: Parameters<WorkflowPayloadStore['delete']>[0]) {
    this.deleted.push(input.payloadRef);
    return this.inner.delete(input);
  }
}

function serviceFixture(
  options: {
    payloads?: WorkflowPayloadStore;
    authorizePayloadRead?: Parameters<typeof createWorkflowService>[0]['authorizePayloadRead'];
  } = {},
) {
  return createWorkflowService({
    port: createMemoryWorkflowStore(),
    payloads: options.payloads ?? new RecordingPayloadStore(),
    now: () => NOW,
    authorizePayloadRead: options.authorizePayloadRead,
  });
}

describe('workflow service', () => {
  test('computes canonical run hashes without exposing private payload references', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({ payloads });
    const run = workflowRunFixture();

    const started = await service.startRunFromRequest({
      run,
      request: { z: 1, a: 'same' },
    });
    const node = workflowNodeFixture({ run_id: run.run_id });
    const appended = await service.appendNodeWithPayload({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-render-primary-0001',
      node,
      payload: { prompt: 'private', order: 1 },
    });

    expect(started.run.request_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(appended.node.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify({ started, appended })).not.toContain('sealed:');
    expect(payloads.sealed).toHaveLength(1);
  });

  test('writes payload before graph mutation and cleans it after a failed or replayed append', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({ payloads });
    const run = workflowRunFixture();
    await service.startRun({ run });
    const node = workflowNodeFixture({ run_id: run.run_id });

    await service.appendNodeWithPayload({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-render-primary-0001',
      node,
      payload: { prompt: 'first' },
    });
    await expect(
      service.appendNodeWithPayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        node,
        payload: { prompt: 'replay' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_IDEMPOTENCY_MISMATCH' });
    expect(payloads.sealed).toHaveLength(2);
    expect(payloads.deleted).toHaveLength(1);
  });

  test('authorizes project and Agent context before reading private payload bytes', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({
      payloads,
      authorizePayloadRead: async () => false,
    });
    const run = workflowRunFixture();
    await service.startRun({ run });
    const node = workflowNodeFixture({ run_id: run.run_id });
    await service.appendNodeWithPayload({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-render-primary-0001',
      node,
      payload: { prompt: 'private' },
    });

    await expect(
      service.readNodePayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: node.node_id,
        payloadRef: payloads.sealed[0] ?? 'sealed:missing',
        expectedHash: node.input_hash,
        workerId: 'workflow-worker-a',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_PAYLOAD_AUTHORIZATION_REQUIRED' });
    expect(payloads.reads).toBe(0);
  });

  test('rejects expired or terminal graph side effects before writing a payload', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({ payloads });
    const run = workflowRunFixture();
    await service.startRun({ run });
    const expiredNode: WorkflowNode = workflowNodeFixture({
      run_id: run.run_id,
      deadline_at: '2026-07-18T09:59:00.000Z',
    });

    await expect(
      service.appendNodeWithPayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        node: expiredNode,
        payload: { prompt: 'expired' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_DEADLINE_EXCEEDED' });
    expect(payloads.sealed).toHaveLength(0);

    await service.cancelRun({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
      cancelledAt: NOW,
    });
    await expect(
      service.appendNodeWithPayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        node: workflowNodeFixture({ run_id: run.run_id }),
        payload: { prompt: 'terminal' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TERMINAL' });
    expect(payloads.sealed).toHaveLength(0);
  });

  test('delegates event cursors, resume, cancel, and immutable task behavior to the port', async () => {
    const service = serviceFixture();
    const run = workflowRunFixture();
    await service.startRun({ run });
    await service.cancelRun({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
      cancelledAt: NOW,
    });
    const events = await service.readEvents({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      afterSequence: 0,
      limit: 100,
    });
    expect(events.items.map((event) => event.type)).toEqual(['run_created', 'run_cancelled']);
    expect(JSON.stringify(events)).not.toMatch(/payload_ref|input_hash|credential|provider/i);
    await expect(
      service.resumeRun({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        updatedAt: NOW,
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });
});
