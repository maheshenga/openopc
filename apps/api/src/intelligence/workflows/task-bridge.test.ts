import { describe, expect, test } from 'bun:test';
import type { IntelligenceCreateTaskRequest } from '@kortix/api-contract';
import {
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import {
  IntelligenceTaskService,
  IntelligenceTaskServiceError,
  createInMemoryIntelligenceTaskStore,
} from '../task-service';
import { WorkflowStoreError } from './errors';
import { createWorkflowImageTaskBridge } from './task-bridge';

const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const TASK_ID = '15000000-0000-4000-a000-000000000001';
const JOB_ID = '16000000-0000-4000-a000-000000000001';
const ASSET_ID = '17000000-0000-4000-a000-000000000001';
const TOKEN_ID = '18000000-0000-4000-a000-000000000001';
const reserveNodeBudget = async () => ({
  status: 'reserved' as const,
  reservedCredits: 0,
  remainingCredits: 0,
});

function request(): IntelligenceCreateTaskRequest {
  return {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: 'a'.repeat(64),
    provider_config_id: PROVIDER_CONFIG_ID,
    model: 'fake/image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'A private workflow image prompt',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    idempotency_key: 'untrusted-payload-idempotency',
    parent_task_id: null,
    deadline_at: null,
  };
}

describe('workflow image task bridge', () => {
  test('creates one governed image task with workflow-derived identity', async () => {
    const createCalls: unknown[] = [];
    const run = workflowRunFixture({ deadline_at: '2026-07-18T10:05:00.000Z' });
    const node = workflowNodeFixture({ deadline_at: '2026-07-18T10:04:00.000Z' });
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async (input) => {
          createCalls.push(input);
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        events: async () => null,
      },
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget,
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: TOKEN_ID,
        sessionId: 'workflow-session',
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).resolves.toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: true });
    expect(createCalls).toEqual([
      {
        accountId: run.account_id,
        projectId: run.project_id,
        actorUserId: run.actor_id,
        actorType: run.actor_type,
        actingTokenId: TOKEN_ID,
        agentName: node.agent_name,
        sessionId: 'workflow-session',
        estimateMode: 'trusted_internal',
        executionOrigin: 'workflow',
        trustedMaxApprovedCredits: run.max_approved_credits,
        reserveTrustedCredits: expect.any(Function),
        request: {
          ...request(),
          idempotency_key: `workflow-node-${node.node_id}`,
          parent_task_id: null,
          deadline_at: node.deadline_at,
        },
      },
    ]);
  });

  test('replays a bound task before requiring a currently available execution target', async () => {
    const run = workflowRunFixture({ actor_type: 'user', agent_name: null });
    const node = workflowNodeFixture();
    let targetLookups = 0;
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => ({ taskId: TASK_ID, jobId: JOB_ID, created: false }),
        create: async () => {
          throw new Error('must not create after replay');
        },
        events: async () => null,
      },
      listExecutionTargets: async () => {
        targetLookups += 1;
        return [];
      },
      reserveNodeBudget,
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: TOKEN_ID,
        sessionId: 'workflow-session',
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).resolves.toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: false });
    expect(targetLookups).toBe(0);
  });

  test('maps replay provenance conflicts to a stable non-retryable request error', async () => {
    const run = workflowRunFixture();
    const node = workflowNodeFixture();
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
        },
        create: async () => {
          throw new Error('must not create after replay conflict');
        },
        events: async () => null,
      },
      listExecutionTargets: async () => [],
      reserveNodeBudget,
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: null,
        sessionId: null,
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TASK_REQUEST_INVALID' });
  });

  test('allows a user-owned workflow to use its trusted internal estimate path', async () => {
    const run = workflowRunFixture({ actor_type: 'user', agent_name: null });
    const node = workflowNodeFixture();
    const taskService = new IntelligenceTaskService({
      store: createInMemoryIntelligenceTaskStore({ taskId: TASK_ID }),
      createStudioJob: async () => ({ jobId: JOB_ID, created: true }),
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });
    const bridge = createWorkflowImageTaskBridge({
      taskService,
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget,
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: TOKEN_ID,
        sessionId: 'workflow-session',
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).resolves.toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: true });
  });

  test('binds resolved credits to the leased workflow node budget', async () => {
    const run = workflowRunFixture({ max_approved_credits: 10 });
    const node = workflowNodeFixture();
    const reservations: unknown[] = [];
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async (input) => {
          expect(await input.reserveTrustedCredits?.(6)).toBe(true);
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        events: async () => null,
      },
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget: async (input) => {
        reservations.push(input);
        return { status: 'reserved', reservedCredits: 6, remainingCredits: 4 };
      },
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: TOKEN_ID,
        sessionId: 'workflow-session',
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).resolves.toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: true });
    expect(reservations).toEqual([
      {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
        maxApprovedCredits: 6,
      },
    ]);
  });

  test('maps a rejected workflow budget reservation to a non-retryable bridge error', async () => {
    const run = workflowRunFixture();
    const node = workflowNodeFixture();
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async () => {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED', 409);
        },
        events: async () => null,
      },
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget,
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: null,
        sessionId: null,
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_BUDGET_EXCEEDED' });
  });

  test('maps a reservation conflict to a non-retryable bridge error', async () => {
    const run = workflowRunFixture();
    const node = workflowNodeFixture();
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async (input) => {
          await input.reserveTrustedCredits?.(1);
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        events: async () => null,
      },
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget: async () => {
        throw new WorkflowStoreError('WORKFLOW_BUDGET_RESERVATION_CONFLICT');
      },
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: null,
        sessionId: null,
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_BUDGET_EXCEEDED' });
  });

  test('maps an unexpected reservation failure to a stable execution error', async () => {
    const run = workflowRunFixture();
    const node = workflowNodeFixture();
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async (input) => {
          await input.reserveTrustedCredits?.(1);
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        events: async () => null,
      },
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget: async () => {
        throw new Error('workflow budget store unavailable');
      },
    });

    await expect(
      bridge.createOrReplay({
        run,
        node,
        request: request(),
        parentTaskId: null,
        actingTokenId: null,
        sessionId: null,
        workerId: 'workflow-worker-1',
        now: '2026-07-18T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TASK_EXECUTION_FAILED' });
  });

  test('replays through the public task service without creating a second Studio job', async () => {
    const run = workflowRunFixture();
    const node = workflowNodeFixture();
    const studioJobCalls: unknown[] = [];
    const taskService = new IntelligenceTaskService({
      store: createInMemoryIntelligenceTaskStore({ taskId: TASK_ID }),
      createStudioJob: async (input) => {
        studioJobCalls.push(input);
        return { jobId: JOB_ID, created: true };
      },
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });
    const bridge = createWorkflowImageTaskBridge({
      taskService,
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget,
    });
    const command = {
      run,
      node,
      request: request(),
      parentTaskId: null,
      actingTokenId: null,
      sessionId: null,
      workerId: 'workflow-worker-1',
      now: '2026-07-18T10:00:00.000Z',
    };

    await expect(bridge.createOrReplay(command)).resolves.toEqual({
      taskId: TASK_ID,
      jobId: JOB_ID,
      created: true,
    });
    await expect(bridge.createOrReplay(command)).resolves.toEqual({
      taskId: TASK_ID,
      jobId: JOB_ID,
      created: false,
    });
    expect(studioJobCalls).toHaveLength(1);
  });

  test('reconciles an attached task from public terminal events without creating work', async () => {
    let createCalls = 0;
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', task_id: TASK_ID });
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async () => {
          createCalls += 1;
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        events: async () => ({
          items: [
            {
              protocol_version: 'intelligence.v1',
              event_id: '19000000-0000-4000-a000-000000000001',
              task_id: TASK_ID,
              sequence: 1,
              type: 'asset_created',
              status: 'running',
              asset_ids: [ASSET_ID],
              created_at: '2026-07-18T10:01:00.000Z',
            },
            {
              protocol_version: 'intelligence.v1',
              event_id: '19000000-0000-4000-a000-000000000002',
              task_id: TASK_ID,
              sequence: 2,
              type: 'succeeded',
              status: 'succeeded',
              created_at: '2026-07-18T10:02:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      },
      listExecutionTargets: async () => [],
      reserveNodeBudget,
    });

    await expect(bridge.reconcile({ run, node, taskId: TASK_ID })).resolves.toEqual({
      status: 'succeeded',
      assetIds: [ASSET_ID],
      reasonCode: null,
    });
    expect(createCalls).toBe(0);
  });

  test('follows bounded public cursors until the attached task becomes terminal', async () => {
    const cursors: Array<string | null> = [];
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', task_id: TASK_ID });
    const bridge = createWorkflowImageTaskBridge({
      taskService: {
        replay: async () => null,
        create: async () => {
          throw new Error('must not run');
        },
        events: async ({ cursor }) => {
          cursors.push(cursor);
          return cursor === null
            ? {
                items: [
                  {
                    protocol_version: 'intelligence.v1',
                    event_id: '19000000-0000-4000-a000-000000000010',
                    task_id: TASK_ID,
                    sequence: 1,
                    type: 'running',
                    status: 'running',
                    created_at: '2026-07-18T10:01:00.000Z',
                  },
                ],
                nextCursor: '1',
              }
            : {
                items: [
                  {
                    protocol_version: 'intelligence.v1',
                    event_id: '19000000-0000-4000-a000-000000000011',
                    task_id: TASK_ID,
                    sequence: 2,
                    type: 'succeeded',
                    status: 'succeeded',
                    created_at: '2026-07-18T10:02:00.000Z',
                  },
                ],
                nextCursor: null,
              };
        },
      },
      listExecutionTargets: async () => [],
      reserveNodeBudget,
    });

    await expect(bridge.reconcile({ run, node, taskId: TASK_ID })).resolves.toEqual({
      status: 'succeeded',
      assetIds: [],
      reasonCode: null,
    });
    expect(cursors).toEqual([null, '1']);
  });
});
