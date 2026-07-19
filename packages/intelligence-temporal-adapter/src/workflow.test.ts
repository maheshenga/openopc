import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TestWorkflowEnvironment as TemporalTestWorkflowEnvironment } from '@temporalio/testing';

const SCOPE = {
  accountId: '91000000-0000-4000-a000-000000000001',
  projectId: '92000000-0000-4000-a000-000000000001',
  runId: '93000000-0000-4000-a000-000000000001',
};

describe('Temporal workflow coordinator', () => {
  let environment: TemporalTestWorkflowEnvironment | null = null;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    if (environment) await environment.teardown();
  });

  test('retries an idempotent pump and resumes after an approval signal', async () => {
    const testEnvironment = environment;
    if (!testEnvironment) throw new Error('Temporal test environment is not ready');
    let approved = false;
    let cancelled = false;
    let attempts = 0;
    const taskQueue = `kortix-intelligence-temporal-approval-${crypto.randomUUID()}`;
    const worker = await createWorker(testEnvironment, taskQueue, {
      pump: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('retry once');
        return { status: approved ? 'succeeded' : 'waiting_approval' };
      },
      resolveApproval: async () => {
        approved = true;
        return { status: 'running' };
      },
      cancelRun: async () => {
        cancelled = true;
        return { status: 'cancelled' };
      },
    });

    await expect(
      worker.runUntil(async () => {
        const handle = await testEnvironment.client.workflow.start('coordinateWorkflow', {
          taskQueue,
          workflowId: 'kortix-intelligence-temporal-approval-0001',
          args: [{ ...SCOPE, pollIntervalMs: 1_000 }],
        });
        await handle.signal('workflow-approval', {
          approvalId: '94000000-0000-4000-a000-000000000001',
          actingUserId: '95000000-0000-4000-a000-000000000001',
          decision: 'approve',
          feedbackHash: null,
        });
        return handle.result();
      }),
    ).resolves.toEqual({ status: 'succeeded' });
    expect(attempts).toBe(3);
    expect({ approved, cancelled }).toEqual({ approved: true, cancelled: false });
  }, 30_000);

  test('cancels a waiting workflow through a scoped signal without running approval activity', async () => {
    const testEnvironment = environment;
    if (!testEnvironment) throw new Error('Temporal test environment is not ready');
    let approved = false;
    let cancelled = false;
    const taskQueue = `kortix-intelligence-temporal-cancel-${crypto.randomUUID()}`;
    const worker = await createWorker(testEnvironment, taskQueue, {
      pump: async () => ({ status: 'waiting_approval' }),
      resolveApproval: async () => {
        approved = true;
        return { status: 'running' };
      },
      cancelRun: async () => {
        cancelled = true;
        return { status: 'cancelled' };
      },
    });

    await expect(
      worker.runUntil(async () => {
        const handle = await testEnvironment.client.workflow.start('coordinateWorkflow', {
          taskQueue,
          workflowId: 'kortix-intelligence-temporal-cancel-0001',
          args: [{ ...SCOPE, pollIntervalMs: 1_000 }],
        });
        await handle.signal('workflow-cancel', { reasonCode: 'WORKFLOW_CANCELLED' });
        return handle.result();
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect({ approved, cancelled }).toEqual({ approved: false, cancelled: true });
  }, 30_000);
});

async function createWorker(
  environment: TemporalTestWorkflowEnvironment,
  taskQueue: string,
  activities: {
    pump(): Promise<{ status: 'waiting_approval' | 'succeeded' }>;
    resolveApproval(): Promise<{ status: 'running' }>;
    cancelRun(): Promise<{ status: 'cancelled' }>;
  },
): Promise<Worker> {
  return Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflow.ts', import.meta.url)),
    activities,
  });
}
