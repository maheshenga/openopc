import { describe, expect, test } from 'bun:test';
import type { WorkflowPort } from '@kortix/intelligence-orchestration';
import {
  workflowApprovalFixture,
  workflowDependencyFixture,
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import { createMemoryWorkflowStore } from './memory-store';

async function createTwoNodeDraft(store: WorkflowPort) {
  const run = workflowRunFixture();
  const parent = workflowNodeFixture({
    node_id: '62000000-0000-4000-a000-000000000002',
    run_id: run.run_id,
    node_key: 'planner-root',
    role: 'planner',
    kind: 'agent',
    capability_id: null,
    capability_version: null,
  });
  const child = workflowNodeFixture({ run_id: run.run_id });
  await store.startRun({ run });
  await store.appendNode({
    accountId: run.account_id,
    projectId: run.project_id,
    runId: run.run_id,
    expectedGraphVersion: 0,
    idempotencyKey: 'workflow-node-planner-root-0001',
    requestHash: parent.input_hash,
    node: parent,
  });
  await store.appendNode({
    accountId: run.account_id,
    projectId: run.project_id,
    runId: run.run_id,
    expectedGraphVersion: 1,
    idempotencyKey: 'workflow-node-render-primary-0001',
    requestHash: child.input_hash,
    node: child,
  });
  return { run, parent, child };
}

async function createSealedTwoNodeGraph(store: WorkflowPort) {
  const graph = await createTwoNodeDraft(store);
  await store.addDependency({
    accountId: graph.run.account_id,
    projectId: graph.run.project_id,
    runId: graph.run.run_id,
    expectedGraphVersion: 2,
    dependency: workflowDependencyFixture({
      run_id: graph.run.run_id,
      node_id: graph.child.node_id,
      depends_on_node_id: graph.parent.node_id,
    }),
  });
  await store.sealGraph({
    accountId: graph.run.account_id,
    projectId: graph.run.project_id,
    runId: graph.run.run_id,
    expectedGraphVersion: 3,
    updatedAt: '2026-07-18T10:01:00.000Z',
  });
  return graph;
}

async function createClaimedCapabilityNode(store: WorkflowPort) {
  const run = workflowRunFixture();
  const node = workflowNodeFixture({ run_id: run.run_id });
  await store.startRun({ run });
  await store.appendNode({
    accountId: run.account_id,
    projectId: run.project_id,
    runId: run.run_id,
    expectedGraphVersion: 0,
    idempotencyKey: 'workflow-node-render-primary-0001',
    requestHash: node.input_hash,
    node,
  });
  await store.sealGraph({
    accountId: run.account_id,
    projectId: run.project_id,
    runId: run.run_id,
    expectedGraphVersion: 1,
    updatedAt: '2026-07-18T10:01:00.000Z',
  });
  await store.claimReadyNode({
    accountId: run.account_id,
    projectId: run.project_id,
    workerId: 'workflow-worker-a',
    now: '2026-07-18T10:02:00.000Z',
    leaseMs: 60_000,
  });
  return { run, node };
}

async function createPausedCapabilityNode(store: WorkflowPort) {
  const { run, node } = await createClaimedCapabilityNode(store);
  const approval = workflowApprovalFixture({
    run_id: run.run_id,
    node_id: node.node_id,
    requested_at: '2026-07-18T10:02:30.000Z',
  });
  await store.pauseForApproval({
    accountId: run.account_id,
    projectId: run.project_id,
    runId: run.run_id,
    nodeId: node.node_id,
    workerId: 'workflow-worker-a',
    approval,
  });
  return { run, node, approval };
}

export function runWorkflowStoreConformance(
  name: string,
  createStore: () => WorkflowPort | Promise<WorkflowPort>,
): void {
  describe(`${name} WorkflowPort conformance`, () => {
    test('rejects a mismatched project-scoped run replay', async () => {
      const store = await createStore();
      const run = workflowRunFixture();

      await store.startRun({ run });

      await expect(
        store.startRun({
          run: {
            ...run,
            run_id: '61000000-0000-4000-a000-000000000099',
            request_hash: `sha256:${'b'.repeat(64)}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_IDEMPOTENCY_MISMATCH' });
    });

    test('returns opaque null for a foreign project run read', async () => {
      const store = await createStore();
      const run = workflowRunFixture();
      await store.startRun({ run });

      await expect(
        store.getRun({
          accountId: run.account_id,
          projectId: '64000000-0000-4000-a000-000000000099',
          runId: run.run_id,
        }),
      ).resolves.toBeNull();
      await expect(
        store.getRun({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
        }),
      ).resolves.toEqual(run);
    });

    test('appends a node idempotently and increments graph version once', async () => {
      const store = await createStore();
      const run = workflowRunFixture();
      const node = workflowNodeFixture({ run_id: run.run_id });
      await store.startRun({ run });

      const input = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        requestHash: node.input_hash,
        node,
      };

      await expect(store.appendNode(input)).resolves.toEqual({
        node,
        created: true,
        graphVersion: 1,
      });
      await expect(store.appendNode(input)).resolves.toEqual({
        node,
        created: false,
        graphVersion: 1,
      });
      await expect(
        store.appendNode({
          ...input,
          requestHash: `sha256:${'b'.repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_IDEMPOTENCY_MISMATCH' });
    });

    test('adds one dependency idempotently and increments graph version once', async () => {
      const store = await createStore();
      const { run, parent, child } = await createTwoNodeDraft(store);
      const dependency = workflowDependencyFixture({
        run_id: run.run_id,
        node_id: child.node_id,
        depends_on_node_id: parent.node_id,
      });

      const input = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 2,
        dependency,
      };
      await expect(store.addDependency(input)).resolves.toEqual({
        dependency,
        created: true,
        graphVersion: 3,
      });
      await expect(store.addDependency(input)).resolves.toEqual({
        dependency,
        created: false,
        graphVersion: 3,
      });
    });

    test('rejects a prospective cycle without advancing the graph version', async () => {
      const store = await createStore();
      const { run, parent, child } = await createTwoNodeDraft(store);
      const dependency = workflowDependencyFixture({
        run_id: run.run_id,
        node_id: child.node_id,
        depends_on_node_id: parent.node_id,
      });
      await store.addDependency({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 2,
        dependency,
      });

      await expect(
        store.addDependency({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 3,
          dependency: workflowDependencyFixture({
            dependency_id: '66000000-0000-4000-a000-000000000002',
            run_id: run.run_id,
            node_id: parent.node_id,
            depends_on_node_id: child.node_id,
          }),
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_CYCLE' });
      await expect(
        store.addDependency({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 2,
          dependency,
        }),
      ).resolves.toMatchObject({ created: false, graphVersion: 3 });
    });

    test('seals a draft graph without changing its graph version', async () => {
      const store = await createStore();
      const { run, parent, child } = await createTwoNodeDraft(store);
      await store.addDependency({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 2,
        dependency: workflowDependencyFixture({
          run_id: run.run_id,
          node_id: child.node_id,
          depends_on_node_id: parent.node_id,
        }),
      });

      await expect(
        store.sealGraph({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 3,
          updatedAt: '2026-07-18T10:01:00.000Z',
        }),
      ).resolves.toEqual({
        ...run,
        status: 'running',
        graph_version: 3,
        updated_at: '2026-07-18T10:01:00.000Z',
      });
    });

    test('claims only the deterministic ready root while its lease is live', async () => {
      const store = await createStore();
      const { run, parent } = await createSealedTwoNodeGraph(store);

      const claim = {
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      };
      await expect(store.claimReadyNode(claim)).resolves.toMatchObject({
        node: {
          node_id: parent.node_id,
          node_key: parent.node_key,
          status: 'running',
          attempt_count: 1,
        },
      });
      await expect(store.claimReadyNode(claim)).resolves.toBeNull();
    });

    test('reclaims a node when its previous lease expires', async () => {
      const store = await createStore();
      const { run, node } = await createClaimedCapabilityNode(store);

      await expect(
        store.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:03:00.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toMatchObject({
        node: { node_id: node.node_id, status: 'running', attempt_count: 2 },
      });
      await expect(
        store.heartbeatNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: node.node_id,
          workerId: 'workflow-worker-a',
          now: '2026-07-18T10:03:01.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toBe(false);
    });

    test('heartbeats only a live lease owned by the requesting worker', async () => {
      const store = await createStore();
      const { run, parent } = await createSealedTwoNodeGraph(store);
      await store.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      });
      const heartbeat = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: parent.node_id,
        leaseMs: 60_000,
      };

      await expect(
        store.heartbeatNode({
          ...heartbeat,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:02:30.000Z',
        }),
      ).resolves.toBe(false);
      await expect(
        store.heartbeatNode({
          ...heartbeat,
          workerId: 'workflow-worker-a',
          now: '2026-07-18T10:02:30.000Z',
        }),
      ).resolves.toBe(true);
      await expect(
        store.heartbeatNode({
          ...heartbeat,
          workerId: 'workflow-worker-a',
          now: '2026-07-18T10:04:00.000Z',
        }),
      ).resolves.toBe(false);
    });

    test('attaches exactly one immutable task to a leased capability node', async () => {
      const store = await createStore();
      const { run, node } = await createClaimedCapabilityNode(store);
      const attachment = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        taskId: '69000000-0000-4000-a000-000000000001',
        updatedAt: '2026-07-18T10:02:30.000Z',
      };

      await expect(store.attachTask(attachment)).resolves.toMatchObject({
        node_id: node.node_id,
        task_id: attachment.taskId,
      });
      await expect(store.attachTask(attachment)).resolves.toMatchObject({
        task_id: attachment.taskId,
      });
      await expect(
        store.attachTask({
          ...attachment,
          taskId: '69000000-0000-4000-a000-000000000002',
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_TASK_ATTACHMENT_CONFLICT' });
    });

    test('completes nodes in dependency order and terminates the run monotonically', async () => {
      const store = await createStore();
      const { run, parent, child } = await createSealedTwoNodeGraph(store);
      await store.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      });

      await expect(
        store.completeNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: parent.node_id,
          workerId: 'workflow-worker-a',
          assetIds: [],
          evaluationVersion: null,
          completedAt: '2026-07-18T10:02:30.000Z',
        }),
      ).resolves.toMatchObject({
        run: { status: 'running', terminal_at: null },
        node: { node_id: parent.node_id, status: 'succeeded' },
      });

      await expect(
        store.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:03:00.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toMatchObject({ node: { node_id: child.node_id, status: 'running' } });

      await expect(
        store.completeNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: child.node_id,
          workerId: 'workflow-worker-b',
          assetIds: ['6a000000-0000-4000-a000-000000000001'],
          evaluationVersion: 'image-eval-v1',
          completedAt: '2026-07-18T10:03:30.000Z',
        }),
      ).resolves.toMatchObject({
        run: { status: 'succeeded', terminal_at: '2026-07-18T10:03:30.000Z' },
        node: {
          node_id: child.node_id,
          status: 'succeeded',
          evaluation_version: 'image-eval-v1',
        },
      });
    });

    test('reclaims retryable failures and terminates on a non-retryable failure', async () => {
      const store = await createStore();
      const run = workflowRunFixture();
      const node = workflowNodeFixture({ run_id: run.run_id });
      await store.startRun({ run });
      await store.appendNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        requestHash: node.input_hash,
        node,
      });
      await store.sealGraph({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 1,
        updatedAt: '2026-07-18T10:01:00.000Z',
      });
      await store.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      });

      await expect(
        store.failNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: node.node_id,
          workerId: 'workflow-worker-a',
          reasonCode: 'WORKFLOW_RETRYABLE_EXECUTION',
          retryable: true,
          failedAt: '2026-07-18T10:02:30.000Z',
        }),
      ).resolves.toMatchObject({
        run: { status: 'running' },
        node: { status: 'ready', terminal_at: null },
      });
      await expect(
        store.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:03:00.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toMatchObject({ node: { attempt_count: 2, status: 'running' } });
      await expect(
        store.failNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: node.node_id,
          workerId: 'workflow-worker-b',
          reasonCode: 'WORKFLOW_EXECUTION_FAILED',
          retryable: false,
          failedAt: '2026-07-18T10:03:30.000Z',
        }),
      ).resolves.toMatchObject({
        run: { status: 'failed', terminal_at: '2026-07-18T10:03:30.000Z' },
        node: { status: 'failed', terminal_at: '2026-07-18T10:03:30.000Z' },
      });
      const events = await store.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 100,
      });
      expect(events.items.slice(-5).map((event) => event.type)).toEqual([
        'node_failed',
        'node_ready',
        'node_started',
        'node_failed',
        'run_failed',
      ]);
      expect(events.items.at(-2)).toMatchObject({
        type: 'node_failed',
        reason_code: 'WORKFLOW_EXECUTION_FAILED',
      });
      expect(events.items.at(-1)).toMatchObject({
        type: 'run_failed',
        status: 'failed',
        reason_code: 'WORKFLOW_EXECUTION_FAILED',
      });
    });

    test('pauses a leased node for one idempotent approval', async () => {
      const store = await createStore();
      const { run, node, approval } = await createPausedCapabilityNode(store);
      const input = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: node.node_id,
        workerId: 'workflow-worker-a',
        approval,
      };

      await expect(store.pauseForApproval(input)).resolves.toMatchObject({
        run: { status: 'waiting_approval', updated_at: approval.requested_at },
        node: { status: 'waiting_approval', updated_at: approval.requested_at },
        approval,
      });
      await expect(
        store.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:03:00.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toBeNull();
    });

    test('resolves an approval idempotently before resuming the paused run', async () => {
      const store = await createStore();
      const { run, node, approval } = await createPausedCapabilityNode(store);
      const resolution = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        approvalId: approval.approval_id,
        actingUserId: '65000000-0000-4000-a000-000000000099',
        decision: 'approve' as const,
        feedbackHash: null,
        resolvedAt: '2026-07-18T10:03:00.000Z',
      };

      await expect(store.resolveApproval(resolution)).resolves.toMatchObject({
        run: { status: 'waiting_approval', updated_at: resolution.resolvedAt },
        node: { status: 'running', updated_at: resolution.resolvedAt },
        approval: {
          approval_id: approval.approval_id,
          status: 'approved',
          acting_user_id: resolution.actingUserId,
          decision: 'approve',
          feedback_hash: null,
          resolved_at: resolution.resolvedAt,
        },
      });
      await expect(store.resolveApproval(resolution)).resolves.toMatchObject({
        node: { status: 'running' },
        approval: { status: 'approved', decision: 'approve' },
      });
      await expect(
        store.resumeRun({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          updatedAt: '2026-07-18T10:03:30.000Z',
        }),
      ).resolves.toMatchObject({ status: 'running', updated_at: '2026-07-18T10:03:30.000Z' });
      await expect(
        store.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:04:00.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toMatchObject({
        node: { node_id: node.node_id, status: 'running', attempt_count: 2 },
      });
    });

    test('cancels a running workflow once and prevents future claims', async () => {
      const store = await createStore();
      const { run } = await createSealedTwoNodeGraph(store);
      await store.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      });
      const cancellation = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
        cancelledAt: '2026-07-18T10:02:30.000Z',
      };

      await expect(store.cancelRun(cancellation)).resolves.toMatchObject({
        status: 'cancelled',
        updated_at: cancellation.cancelledAt,
        terminal_at: cancellation.cancelledAt,
      });
      await expect(store.cancelRun(cancellation)).resolves.toMatchObject({
        status: 'cancelled',
        terminal_at: cancellation.cancelledAt,
      });
      await expect(
        store.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:03:00.000Z',
          leaseMs: 60_000,
        }),
      ).resolves.toBeNull();
    });

    test('reads bounded public events with a monotonic run-scoped cursor', async () => {
      const store = await createStore();
      const run = workflowRunFixture();
      const node = workflowNodeFixture({ run_id: run.run_id });
      await store.startRun({ run });
      await store.appendNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        requestHash: node.input_hash,
        node,
      });

      const first = await store.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).toMatchObject({
        run_id: run.run_id,
        sequence: 1,
        type: 'run_created',
        status: 'draft',
        graph_version: 0,
        node_id: null,
        asset_ids: [],
        route_reason_codes: [],
      });
      expect(first.nextCursor).toBe('1');

      const second = await store.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: Number(first.nextCursor),
        limit: 100,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]).toMatchObject({
        sequence: 2,
        type: 'node_appended',
        graph_version: 1,
        node_id: node.node_id,
      });
      expect(second.nextCursor).toBeNull();
      expect(JSON.stringify([...first.items, ...second.items])).not.toMatch(
        /request_hash|input_hash|idempotency|payload|provider|credential/i,
      );
    });

    test('emits ordered public events for graph execution and terminal success', async () => {
      const store = await createStore();
      const { run, parent, child } = await createSealedTwoNodeGraph(store);
      await store.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      });
      await store.completeNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: parent.node_id,
        workerId: 'workflow-worker-a',
        assetIds: [],
        evaluationVersion: null,
        completedAt: '2026-07-18T10:02:30.000Z',
      });
      await store.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-b',
        now: '2026-07-18T10:03:00.000Z',
        leaseMs: 60_000,
      });
      const taskId = '69000000-0000-4000-a000-000000000001';
      await store.attachTask({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: child.node_id,
        workerId: 'workflow-worker-b',
        taskId,
        updatedAt: '2026-07-18T10:03:15.000Z',
      });
      await store.completeNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: child.node_id,
        workerId: 'workflow-worker-b',
        assetIds: ['6a000000-0000-4000-a000-000000000001'],
        evaluationVersion: 'image-eval-v1',
        completedAt: '2026-07-18T10:03:30.000Z',
      });

      const page = await store.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 100,
      });
      expect(page.items.map((event) => event.type)).toEqual([
        'run_created',
        'node_appended',
        'node_appended',
        'dependency_added',
        'graph_sealed',
        'run_started',
        'node_ready',
        'node_started',
        'node_succeeded',
        'node_ready',
        'node_started',
        'task_attached',
        'node_succeeded',
        'run_succeeded',
      ]);
      expect(page.items.map((event) => event.sequence)).toEqual(
        Array.from({ length: page.items.length }, (_, index) => index + 1),
      );
      expect(page.items.find((event) => event.type === 'task_attached')).toMatchObject({
        node_id: child.node_id,
        task_id: taskId,
      });
      expect(page.items.at(-2)).toMatchObject({
        type: 'node_succeeded',
        asset_ids: ['6a000000-0000-4000-a000-000000000001'],
        evaluation_version: 'image-eval-v1',
      });
      expect(page.items.at(-1)).toMatchObject({
        type: 'run_succeeded',
        status: 'succeeded',
      });
    });

    test('emits approval, resume, and cancellation events exactly once', async () => {
      const store = await createStore();
      const { run, node, approval } = await createPausedCapabilityNode(store);
      const resolution = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        approvalId: approval.approval_id,
        actingUserId: '65000000-0000-4000-a000-000000000099',
        decision: 'approve' as const,
        feedbackHash: null,
        resolvedAt: '2026-07-18T10:03:00.000Z',
      };
      await store.resolveApproval(resolution);
      await store.resolveApproval(resolution);
      const resume = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        updatedAt: '2026-07-18T10:03:30.000Z',
      };
      await store.resumeRun(resume);
      await store.resumeRun(resume);
      const cancellation = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
        cancelledAt: '2026-07-18T10:04:00.000Z',
      };
      await store.cancelRun(cancellation);
      await store.cancelRun(cancellation);

      const page = await store.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 100,
      });
      expect(page.items.map((event) => event.type)).toEqual([
        'run_created',
        'node_appended',
        'graph_sealed',
        'run_started',
        'node_ready',
        'node_started',
        'node_waiting_approval',
        'approval_resolved',
        'run_started',
        'run_cancelled',
      ]);
      expect(page.items.at(-4)).toMatchObject({
        type: 'node_waiting_approval',
        node_id: node.node_id,
        reason_code: approval.reason_code,
      });
      expect(page.items.at(-1)).toMatchObject({
        type: 'run_cancelled',
        status: 'cancelled',
        reason_code: cancellation.reasonCode,
      });
    });

    test('terminates a rejected approval monotonically and rejects a changed replay', async () => {
      const store = await createStore();
      const { run, node, approval } = await createPausedCapabilityNode(store);
      const resolution = {
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        approvalId: approval.approval_id,
        actingUserId: '65000000-0000-4000-a000-000000000099',
        decision: 'changes_requested' as const,
        feedbackHash: `sha256:${'b'.repeat(64)}`,
        resolvedAt: '2026-07-18T10:03:00.000Z',
      };

      await expect(store.resolveApproval(resolution)).resolves.toMatchObject({
        run: { status: 'failed', terminal_at: resolution.resolvedAt },
        node: { status: 'failed', terminal_at: resolution.resolvedAt },
        approval: {
          status: 'rejected',
          decision: 'changes_requested',
          feedback_hash: resolution.feedbackHash,
        },
      });
      await expect(store.resolveApproval(resolution)).resolves.toMatchObject({
        run: { status: 'failed' },
        approval: { status: 'rejected' },
      });
      await expect(
        store.resolveApproval({ ...resolution, decision: 'reject' }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_APPROVAL_CONFLICT' });

      const events = await store.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 100,
      });
      expect(events.items.slice(-3).map((event) => event.type)).toEqual([
        'approval_resolved',
        'node_failed',
        'run_failed',
      ]);
      expect(events.items.at(-1)).toMatchObject({
        status: 'failed',
        reason_code: approval.reason_code,
      });
    });
  });
}

runWorkflowStoreConformance('memory', createMemoryWorkflowStore);
