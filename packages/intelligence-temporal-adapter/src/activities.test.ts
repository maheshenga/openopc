import { describe, expect, test } from 'bun:test';
import type { WorkflowPort } from '@kortix/intelligence-orchestration';
import { workflowRunFixture } from '@kortix/intelligence-orchestration/fixtures';
import { createTemporalWorkflowActivities } from './activities';

const SCOPE = {
  accountId: '91000000-0000-4000-a000-000000000001',
  projectId: '92000000-0000-4000-a000-000000000001',
  runId: '93000000-0000-4000-a000-000000000001',
};

describe('Temporal workflow activities', () => {
  test('pumps one exact project scope through an injected Kortix scheduler boundary', async () => {
    const run = workflowRunFixture({
      account_id: SCOPE.accountId,
      project_id: SCOPE.projectId,
      run_id: SCOPE.runId,
      status: 'running',
    });
    const calls: string[] = [];
    const activities = createTemporalWorkflowActivities({
      workflow: {
        getRun: async (scope) => {
          calls.push(`read:${scope.projectId}`);
          return run;
        },
      } as Pick<WorkflowPort, 'getRun'>,
      runScheduler: async (scope) => {
        calls.push(`pump:${scope.projectId}`);
      },
      now: () => '2026-07-20T10:00:00.000Z',
    });

    await expect(activities.pump(SCOPE)).resolves.toEqual({ status: 'running' });
    expect(calls).toEqual([`pump:${SCOPE.projectId}`, `read:${SCOPE.projectId}`]);
  });

  test('rejects a foreign run returned by an injected workflow port', async () => {
    const foreignRun = workflowRunFixture({
      account_id: '91000000-0000-4000-a000-000000000099',
      project_id: SCOPE.projectId,
      run_id: SCOPE.runId,
    });
    const activities = createTemporalWorkflowActivities({
      workflow: {
        getRun: async () => foreignRun,
      } as Pick<WorkflowPort, 'getRun'>,
      runScheduler: async () => {},
      now: () => '2026-07-20T10:00:00.000Z',
    });

    await expect(activities.pump(SCOPE)).rejects.toThrow('TEMPORAL_WORKFLOW_SCOPE_VIOLATION');
  });

  test('resolves an approval through the exact Kortix scope with the activity timestamp', async () => {
    const run = workflowRunFixture({
      account_id: SCOPE.accountId,
      project_id: SCOPE.projectId,
      run_id: SCOPE.runId,
      status: 'waiting_approval',
    });
    const received: Array<Parameters<WorkflowPort['resolveApproval']>[0]> = [];
    const activities = createTemporalWorkflowActivities({
      workflow: {
        getRun: async () => null,
        resolveApproval: async (input) => {
          received.push(input);
          return { run } as Awaited<ReturnType<WorkflowPort['resolveApproval']>>;
        },
      } as Pick<WorkflowPort, 'getRun' | 'resolveApproval'>,
      runScheduler: async () => {},
      now: () => '2026-07-20T10:01:00.000Z',
    });

    await expect(
      activities.resolveApproval({
        ...SCOPE,
        approvalId: '94000000-0000-4000-a000-000000000001',
        actingUserId: '95000000-0000-4000-a000-000000000001',
        decision: 'approve',
        feedbackHash: null,
      }),
    ).resolves.toEqual({ status: 'waiting_approval' });
    expect(received).toEqual([
      {
        ...SCOPE,
        approvalId: '94000000-0000-4000-a000-000000000001',
        actingUserId: '95000000-0000-4000-a000-000000000001',
        decision: 'approve',
        feedbackHash: null,
        resolvedAt: '2026-07-20T10:01:00.000Z',
      },
    ]);
  });

  test('cancels only the exact workflow scope', async () => {
    const run = workflowRunFixture({
      account_id: SCOPE.accountId,
      project_id: SCOPE.projectId,
      run_id: SCOPE.runId,
      status: 'cancelled',
    });
    const received: Array<Parameters<WorkflowPort['cancelRun']>[0]> = [];
    const activities = createTemporalWorkflowActivities({
      workflow: {
        getRun: async () => null,
        cancelRun: async (input) => {
          received.push(input);
          return run;
        },
      } as Pick<WorkflowPort, 'getRun' | 'cancelRun'>,
      runScheduler: async () => {},
      now: () => '2026-07-20T10:02:00.000Z',
    });

    await expect(
      activities.cancelRun({ ...SCOPE, reasonCode: 'WORKFLOW_CANCELLED_BY_USER' }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(received).toEqual([
      {
        ...SCOPE,
        reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
        cancelledAt: '2026-07-20T10:02:00.000Z',
      },
    ]);
  });

  test('rejects a foreign project run returned by a cancellation command', async () => {
    const foreignRun = workflowRunFixture({
      account_id: SCOPE.accountId,
      project_id: '92000000-0000-4000-a000-000000000099',
      run_id: SCOPE.runId,
      status: 'cancelled',
    });
    const activities = createTemporalWorkflowActivities({
      workflow: {
        getRun: async () => null,
        cancelRun: async () => foreignRun,
      } as Pick<WorkflowPort, 'getRun' | 'cancelRun'>,
      runScheduler: async () => {},
      now: () => '2026-07-20T10:02:00.000Z',
    });

    await expect(
      activities.cancelRun({ ...SCOPE, reasonCode: 'WORKFLOW_CANCELLED_BY_USER' }),
    ).rejects.toThrow('TEMPORAL_WORKFLOW_SCOPE_VIOLATION');
  });

  test('fails closed when approval and cancellation command ports are unavailable', async () => {
    const activities = createTemporalWorkflowActivities({
      workflow: {
        getRun: async () => null,
      } as Pick<WorkflowPort, 'getRun'>,
      runScheduler: async () => {},
      now: () => '2026-07-20T10:03:00.000Z',
    });

    await expect(
      activities.resolveApproval({
        ...SCOPE,
        approvalId: '94000000-0000-4000-a000-000000000001',
        actingUserId: '95000000-0000-4000-a000-000000000001',
        decision: 'reject',
        feedbackHash: null,
      }),
    ).rejects.toThrow('TEMPORAL_WORKFLOW_ACTIVITY_UNAVAILABLE');
    await expect(
      activities.cancelRun({ ...SCOPE, reasonCode: 'WORKFLOW_CANCELLED_BY_USER' }),
    ).rejects.toThrow('TEMPORAL_WORKFLOW_ACTIVITY_UNAVAILABLE');
  });
});
