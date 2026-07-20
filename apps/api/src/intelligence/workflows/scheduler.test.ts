import { describe, expect, test } from 'bun:test';
import type { WorkflowPort } from '@kortix/intelligence-orchestration';
import {
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import { createWorkflowScheduler } from './scheduler';
import { type WorkflowImageTaskBridge, WorkflowTaskBridgeError } from './task-bridge';

const ACCOUNT_ID = '63000000-0000-4000-a000-000000000001';
const PROJECT_ID = '64000000-0000-4000-a000-000000000001';
const TASK_ID = '65000000-0000-4000-a000-000000000001';
const JOB_ID = '66000000-0000-4000-a000-000000000001';
const ASSET_ID = '67000000-0000-4000-a000-000000000001';
const NOW = '2026-07-18T10:00:00.000Z';

function workflowPort(overrides: Partial<WorkflowPort> = {}): WorkflowPort {
  return {
    startRun: async () => {
      throw new Error('unused');
    },
    appendNode: async () => {
      throw new Error('unused');
    },
    addDependency: async () => {
      throw new Error('unused');
    },
    sealGraph: async () => null,
    claimReadyNode: async () => null,
    heartbeatNode: async () => false,
    reserveNodeBudget: async () => null,
    attachTask: async () => null,
    completeNode: async () => null,
    failNode: async () => null,
    pauseForApproval: async () => null,
    resolveApproval: async () => null,
    resumeRun: async () => null,
    cancelRun: async () => null,
    getRun: async () => null,
    readEvents: async () => ({ items: [], nextCursor: null }),
    ...overrides,
  };
}

function taskBridge(overrides: Partial<WorkflowImageTaskBridge> = {}): WorkflowImageTaskBridge {
  return {
    createOrReplay: async () => {
      throw new Error('unused');
    },
    reconcile: async () => ({ status: 'running', assetIds: [], reasonCode: null }),
    ...overrides,
  };
}

describe('workflow scheduler', () => {
  test('checks readiness before enumerating scopes or claiming nodes', async () => {
    let scopeCalls = 0;
    let claimCalls = 0;
    let authorizationCalls = 0;
    let payloadCalls = 0;
    let bridgeCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claimCalls += 1;
          return null;
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          bridgeCalls += 1;
          throw new Error('must not run');
        },
      }),
      isReady: async () => false,
      listScopes: async () => {
        scopeCalls += 1;
        return [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }];
      },
      authorizeNode: async () => {
        authorizationCalls += 1;
        return null;
      },
      readNodeRequest: async () => {
        payloadCalls += 1;
        return null;
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      scopes: 0,
      claimed: 0,
      attached: 0,
      completed: 0,
      failed: 0,
      leaseLost: 0,
    });
    expect({ scopeCalls, claimCalls, authorizationCalls, payloadCalls, bridgeCalls }).toEqual({
      scopeCalls: 0,
      claimCalls: 0,
      authorizationCalls: 0,
      payloadCalls: 0,
      bridgeCalls: 0,
    });
  });

  test('fails a claimed node when authorization is revoked before payload or task side effects', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    const failCalls: unknown[] = [];
    let claims = 0;
    let payloadCalls = 0;
    let bridgeCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        failNode: async (input) => {
          failCalls.push(input);
          return { run, node: { ...node, status: 'failed' } };
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          bridgeCalls += 1;
          throw new Error('must not run');
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => null,
      readNodeRequest: async () => {
        payloadCalls += 1;
        return null;
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      scopes: 1,
      claimed: 1,
      attached: 0,
      completed: 0,
      failed: 1,
      leaseLost: 0,
    });
    expect(failCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        reasonCode: 'WORKFLOW_AUTHORIZATION_REVOKED',
        retryable: false,
        failedAt: NOW,
      },
    ]);
    expect({ payloadCalls, bridgeCalls }).toEqual({ payloadCalls: 0, bridgeCalls: 0 });
  });

  test('does not read a payload when the claimed lease is already lost', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    let claims = 0;
    let heartbeatCalls = 0;
    let payloadCalls = 0;
    let bridgeCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => {
          heartbeatCalls += 1;
          return false;
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          bridgeCalls += 1;
          throw new Error('must not run');
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => {
        payloadCalls += 1;
        return {};
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      leaseLost: 1,
    });
    expect({ heartbeatCalls, payloadCalls, bridgeCalls }).toEqual({
      heartbeatCalls: 1,
      payloadCalls: 0,
      bridgeCalls: 0,
    });
  });

  test('creates, attaches, and reconciles a fresh image task behind lease fences', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    const order: string[] = [];
    const attachCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    let claims = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => {
          order.push('heartbeat');
          return true;
        },
        attachTask: async (input) => {
          order.push('attach');
          attachCalls.push(input);
          return { ...node, task_id: TASK_ID };
        },
      }),
      bridge: taskBridge({
        createOrReplay: async (input) => {
          order.push('create');
          createCalls.push(input);
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        reconcile: async () => {
          order.push('reconcile');
          return { status: 'running', assetIds: [], reasonCode: null };
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => {
        order.push('authorize');
        return { actingTokenId: null, sessionId: null, parentTaskId: null };
      },
      readNodeRequest: async () => {
        order.push('payload');
        return { capability: 'image.generate' };
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      attached: 1,
      completed: 0,
      failed: 0,
      leaseLost: 0,
    });
    expect(order).toEqual([
      'authorize',
      'heartbeat',
      'payload',
      'heartbeat',
      'create',
      'attach',
      'heartbeat',
      'reconcile',
    ]);
    expect(attachCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        taskId: TASK_ID,
        updatedAt: NOW,
      },
    ]);
    expect(createCalls).toEqual([
      {
        run,
        node,
        request: { capability: 'image.generate' },
        parentTaskId: null,
        actingTokenId: null,
        sessionId: null,
        workerId: 'workflow-worker-a',
        now: NOW,
      },
    ]);
  });

  test('stops after task creation when the lease is lost before attachment', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    let claims = 0;
    let createCalls = 0;
    let reconcileCalls = 0;
    let completeCalls = 0;
    let failCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        attachTask: async () => null,
        completeNode: async () => {
          completeCalls += 1;
          return null;
        },
        failNode: async () => {
          failCalls += 1;
          return null;
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          createCalls += 1;
          return { taskId: TASK_ID, jobId: JOB_ID, created: true };
        },
        reconcile: async () => {
          reconcileCalls += 1;
          return { status: 'running', assetIds: [], reasonCode: null };
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => ({ capability: 'image.generate' }),
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      attached: 0,
      completed: 0,
      failed: 0,
      leaseLost: 1,
    });
    expect({ createCalls, reconcileCalls, completeCalls, failCalls }).toEqual({
      createCalls: 1,
      reconcileCalls: 0,
      completeCalls: 0,
      failCalls: 0,
    });
  });

  test('reconciles an attached task after restart without payload or create replay', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({
      status: 'running',
      attempt_count: 2,
      task_id: TASK_ID,
    });
    const order: string[] = [];
    let claims = 0;
    let payloadCalls = 0;
    let createCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => {
          order.push('heartbeat');
          return true;
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          createCalls += 1;
          throw new Error('must not run');
        },
        reconcile: async () => {
          order.push('reconcile');
          return { status: 'running', assetIds: [], reasonCode: null };
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => {
        order.push('authorize');
        return { actingTokenId: null, sessionId: null, parentTaskId: null };
      },
      readNodeRequest: async () => {
        payloadCalls += 1;
        return {};
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      attached: 0,
      completed: 0,
      failed: 0,
      leaseLost: 0,
    });
    expect(order).toEqual(['authorize', 'heartbeat', 'reconcile']);
    expect({ payloadCalls, createCalls }).toEqual({ payloadCalls: 0, createCalls: 0 });
  });

  test('completes an attached node from a succeeded task event', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({
      status: 'running',
      attempt_count: 2,
      task_id: TASK_ID,
      evaluation_version: 'evaluation-v1',
    });
    const completeCalls: unknown[] = [];
    let claims = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        completeNode: async (input) => {
          completeCalls.push(input);
          return { run: { ...run, status: 'succeeded' }, node: { ...node, status: 'succeeded' } };
        },
      }),
      bridge: taskBridge({
        reconcile: async () => ({
          status: 'succeeded',
          assetIds: [ASSET_ID],
          reasonCode: null,
        }),
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => {
        throw new Error('must not run');
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
      leaseLost: 0,
    });
    expect(completeCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        assetIds: [ASSET_ID],
        evaluationVersion: 'evaluation-v1',
        completedAt: NOW,
      },
    ]);
  });

  test('fails an attached node from a failed task event', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({
      status: 'running',
      attempt_count: 2,
      task_id: TASK_ID,
    });
    const failCalls: unknown[] = [];
    let claims = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        failNode: async (input) => {
          failCalls.push(input);
          return { run: { ...run, status: 'failed' }, node: { ...node, status: 'failed' } };
        },
      }),
      bridge: taskBridge({
        reconcile: async () => ({
          status: 'failed',
          assetIds: [],
          reasonCode: 'STUDIO_PROVIDER_FAILED',
        }),
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => {
        throw new Error('must not run');
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 1,
      leaseLost: 0,
    });
    expect(failCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        reasonCode: 'STUDIO_PROVIDER_FAILED',
        retryable: false,
        failedAt: NOW,
      },
    ]);
  });

  test('fails an attached node with the stable cancellation reason', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({
      status: 'running',
      attempt_count: 2,
      task_id: TASK_ID,
    });
    const failCalls: unknown[] = [];
    let claims = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        failNode: async (input) => {
          failCalls.push(input);
          return { run: { ...run, status: 'failed' }, node: { ...node, status: 'failed' } };
        },
      }),
      bridge: taskBridge({
        reconcile: async () => ({
          status: 'cancelled',
          assetIds: [],
          reasonCode: 'INTELLIGENCE_TASK_CANCELLED',
        }),
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => {
        throw new Error('must not run');
      },
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 1,
      leaseLost: 0,
    });
    expect(failCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        reasonCode: 'INTELLIGENCE_TASK_CANCELLED',
        retryable: false,
        failedAt: NOW,
      },
    ]);
  });

  test('fails a node with a missing private request before invoking the task bridge', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    const failCalls: unknown[] = [];
    let claims = 0;
    let bridgeCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        failNode: async (input) => {
          failCalls.push(input);
          return { run: { ...run, status: 'failed' }, node: { ...node, status: 'failed' } };
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          bridgeCalls += 1;
          throw new Error('must not run');
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect(bridgeCalls).toBe(0);
    expect(failCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        reasonCode: 'WORKFLOW_PAYLOAD_INVALID',
        retryable: false,
        failedAt: NOW,
      },
    ]);
  });

  test('maps an unavailable discovered target to a stable node failure', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    const failCalls: unknown[] = [];
    let claims = 0;
    let attachCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        attachTask: async () => {
          attachCalls += 1;
          return null;
        },
        failNode: async (input) => {
          failCalls.push(input);
          return { run: { ...run, status: 'failed' }, node: { ...node, status: 'failed' } };
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          throw new WorkflowTaskBridgeError('WORKFLOW_TASK_TARGET_UNAVAILABLE');
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => ({ capability: 'image.generate' }),
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect(attachCalls).toBe(0);
    expect(failCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        reasonCode: 'WORKFLOW_TASK_TARGET_UNAVAILABLE',
        retryable: false,
        failedAt: NOW,
      },
    ]);
  });

  test('fails a claimed node when task execution returns a stable bridge error', async () => {
    const run = workflowRunFixture({ status: 'running' });
    const node = workflowNodeFixture({ status: 'running', attempt_count: 1 });
    const failCalls: unknown[] = [];
    let claims = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort({
        claimReadyNode: async () => {
          claims += 1;
          return claims === 1 ? { run, node } : null;
        },
        heartbeatNode: async () => true,
        failNode: async (input) => {
          failCalls.push(input);
          return { run: { ...run, status: 'failed' }, node: { ...node, status: 'failed' } };
        },
      }),
      bridge: taskBridge({
        createOrReplay: async () => {
          throw new WorkflowTaskBridgeError('WORKFLOW_TASK_EXECUTION_FAILED');
        },
      }),
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () => ({
        actingTokenId: null,
        sessionId: null,
        parentTaskId: null,
      }),
      readNodeRequest: async () => ({ capability: 'image.generate' }),
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect(failCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        reasonCode: 'WORKFLOW_TASK_EXECUTION_FAILED',
        retryable: true,
        failedAt: NOW,
      },
    ]);
  });

  test('stops gracefully by waiting for the active tick without rearming', async () => {
    let resolveReady: ((value: boolean) => void) | undefined;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cancelled: unknown[] = [];
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort(),
      bridge: taskBridge(),
      isReady: () => ready,
      listScopes: async () => [],
      authorizeNode: async () => null,
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
      intervalMs: 1_000,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      cancelScheduled: (timer) => {
        cancelled.push(timer);
      },
    });

    scheduler.start();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([0]);
    scheduled[0]?.callback();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveReady?.(false);
    await stopping;

    expect(stopped).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(cancelled).toEqual([]);
  });

  test('runs at most one scheduled tick and rearms only after it settles', async () => {
    let resolveReady: ((value: boolean) => void) | undefined;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cancelled: unknown[] = [];
    let resolveRearmed: (() => void) | undefined;
    const rearmed = new Promise<void>((resolve) => {
      resolveRearmed = resolve;
    });
    let readyCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort(),
      bridge: taskBridge(),
      isReady: () => {
        readyCalls += 1;
        return ready;
      },
      listScopes: async () => [],
      authorizeNode: async () => null,
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
      intervalMs: 1_000,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        if (delayMs === 1_000) resolveRearmed?.();
        return scheduled.length;
      },
      cancelScheduled: (timer) => {
        cancelled.push(timer);
      },
    });

    scheduler.start();
    scheduled[0]?.callback();
    scheduled[0]?.callback();
    await Promise.resolve();
    expect(readyCalls).toBe(1);

    resolveReady?.(false);
    await rearmed;
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([0, 1_000]);

    await scheduler.stop();
    expect(cancelled).toEqual([2]);
  });

  test('ignores a cancelled timer callback that races with stop', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cancelled: unknown[] = [];
    let readyCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort(),
      bridge: taskBridge(),
      isReady: async () => {
        readyCalls += 1;
        return false;
      },
      listScopes: async () => [],
      authorizeNode: async () => null,
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      cancelScheduled: (timer) => {
        cancelled.push(timer);
      },
    });

    scheduler.start();
    await scheduler.stop();
    scheduled[0]?.callback();
    await Promise.resolve();

    expect(cancelled).toEqual([1]);
    expect(readyCalls).toBe(0);
  });

  test('fences a stale timer callback across stop and restart', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cancelled: unknown[] = [];
    let readyCalls = 0;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort(),
      bridge: taskBridge(),
      isReady: async () => {
        readyCalls += 1;
        return false;
      },
      listScopes: async () => [],
      authorizeNode: async () => null,
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      cancelScheduled: (timer) => {
        cancelled.push(timer);
      },
    });

    scheduler.start();
    await scheduler.stop();
    scheduler.start();
    scheduled[0]?.callback();
    await Promise.resolve();
    await scheduler.stop();

    expect(readyCalls).toBe(0);
    expect(cancelled).toEqual([1, 2]);
  });

  test('reports one bounded telemetry record for each scheduler pass', async () => {
    const records: unknown[] = [];
    let milliseconds = 1_000;
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort(),
      bridge: taskBridge(),
      isReady: async () => false,
      listScopes: async () => [],
      authorizeNode: async () => null,
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
      telemetry: {
        schedulerRun: (record) => records.push(record),
      },
      traceparent: () => '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      nowMilliseconds: () => {
        const current = milliseconds;
        milliseconds += 250;
        return current;
      },
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      scopes: 0,
      claimed: 0,
      attached: 0,
      completed: 0,
      failed: 0,
      leaseLost: 0,
    });
    expect(records).toEqual([
      {
        outcome: 'not_ready',
        durationSeconds: 0.25,
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        stats: {
          scopes: 0,
          claimed: 0,
          attached: 0,
          completed: 0,
          failed: 0,
          leaseLost: 0,
        },
      },
    ]);
  });

  test('never lets a telemetry sink change scheduler behavior', async () => {
    const scheduler = createWorkflowScheduler({
      workflow: workflowPort(),
      bridge: taskBridge(),
      isReady: async () => false,
      listScopes: async () => [],
      authorizeNode: async () => null,
      readNodeRequest: async () => null,
      workerId: 'workflow-worker-a',
      now: () => NOW,
      leaseMs: 30_000,
      maxClaimsPerRun: 4,
      telemetry: {
        schedulerRun: () => {
          throw new Error('telemetry unavailable');
        },
      },
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ scopes: 0, claimed: 0 });
  });
});
