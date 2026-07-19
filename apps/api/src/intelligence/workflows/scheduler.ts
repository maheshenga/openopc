import type { WorkflowNode, WorkflowRun } from '@kortix/intelligence-contracts';
import type { WorkflowPort, WorkflowScope } from '@kortix/intelligence-orchestration';
import {
  type WorkflowImageTaskBridge,
  WorkflowTaskBridgeError,
  type WorkflowTaskReconciliation,
} from './task-bridge';

export type WorkflowNodeAuthorization = {
  actingTokenId: string | null;
  sessionId: string | null;
  parentTaskId: string | null;
};

export type WorkflowSchedulerStats = {
  scopes: number;
  claimed: number;
  attached: number;
  completed: number;
  failed: number;
  leaseLost: number;
};

export type WorkflowScheduler = {
  runOnce(): Promise<WorkflowSchedulerStats>;
  start(): void;
  stop(): Promise<void>;
};

export function createWorkflowScheduler(input: {
  workflow: WorkflowPort;
  bridge: WorkflowImageTaskBridge;
  isReady(): Promise<boolean>;
  listScopes(): Promise<readonly WorkflowScope[]>;
  authorizeNode(command: {
    run: WorkflowRun;
    node: WorkflowNode;
    workerId: string;
    now: string;
  }): Promise<WorkflowNodeAuthorization | null>;
  readNodeRequest(command: {
    run: WorkflowRun;
    node: WorkflowNode;
    workerId: string;
    now: string;
  }): Promise<unknown | null>;
  workerId: string;
  now(): string;
  leaseMs: number;
  maxClaimsPerRun: number;
  intervalMs?: number;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancelScheduled?(timer: unknown): void;
}): WorkflowScheduler {
  if (
    input.workerId.trim() === '' ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > 10 * 60 * 1_000 ||
    !Number.isSafeInteger(input.maxClaimsPerRun) ||
    input.maxClaimsPerRun < 1 ||
    input.maxClaimsPerRun > 100
  ) {
    throw new Error('WORKFLOW_SCHEDULER_CONFIG_INVALID');
  }

  const intervalMs = input.intervalMs ?? 1_000;
  const schedule =
    input.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelScheduled =
    input.cancelScheduled ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let started = false;
  let lifecycleGeneration = 0;
  let scheduledTimer: unknown | null = null;
  let activeTick: Promise<void> | null = null;

  const scheduler: WorkflowScheduler = {
    async runOnce() {
      if (!(await input.isReady())) return emptyStats();
      const scopes = await input.listScopes();
      if (scopes.length > 100) throw new Error('WORKFLOW_SCHEDULER_SCOPE_LIMIT_EXCEEDED');
      const stats = emptyStats();
      stats.scopes = scopes.length;
      for (const scope of scopes) {
        while (stats.claimed < input.maxClaimsPerRun) {
          const claimed = await input.workflow.claimReadyNode({
            ...scope,
            workerId: input.workerId,
            now: input.now(),
            leaseMs: input.leaseMs,
          });
          if (!claimed) break;
          stats.claimed += 1;
          let authorization: WorkflowNodeAuthorization | null = null;
          try {
            authorization = await input.authorizeNode({
              ...claimed,
              workerId: input.workerId,
              now: input.now(),
            });
          } catch {
            authorization = null;
          }
          if (!authorization) {
            const failed = await input.workflow.failNode({
              ...scope,
              runId: claimed.run.run_id,
              nodeId: claimed.node.node_id,
              workerId: input.workerId,
              reasonCode: 'WORKFLOW_AUTHORIZATION_REVOKED',
              retryable: false,
              failedAt: input.now(),
            });
            if (failed) stats.failed += 1;
            else stats.leaseLost += 1;
            continue;
          }
          const leaseAlive = await input.workflow.heartbeatNode({
            ...scope,
            runId: claimed.run.run_id,
            nodeId: claimed.node.node_id,
            workerId: input.workerId,
            now: input.now(),
            leaseMs: input.leaseMs,
          });
          if (!leaseAlive) {
            stats.leaseLost += 1;
            continue;
          }
          if (claimed.node.task_id !== null) {
            const reconciliation = await input.bridge.reconcile({
              run: claimed.run,
              node: claimed.node,
              taskId: claimed.node.task_id,
            });
            await settleReconciliation(
              input,
              scope,
              claimed.run,
              claimed.node,
              reconciliation,
              stats,
            );
            continue;
          }
          const request = await input.readNodeRequest({
            ...claimed,
            workerId: input.workerId,
            now: input.now(),
          });
          if (request === null) {
            const failed = await input.workflow.failNode({
              ...scope,
              runId: claimed.run.run_id,
              nodeId: claimed.node.node_id,
              workerId: input.workerId,
              reasonCode: 'WORKFLOW_PAYLOAD_INVALID',
              retryable: false,
              failedAt: input.now(),
            });
            if (failed) stats.failed += 1;
            else stats.leaseLost += 1;
            continue;
          }
          const createLeaseAlive = await input.workflow.heartbeatNode({
            ...scope,
            runId: claimed.run.run_id,
            nodeId: claimed.node.node_id,
            workerId: input.workerId,
            now: input.now(),
            leaseMs: input.leaseMs,
          });
          if (!createLeaseAlive) {
            stats.leaseLost += 1;
            continue;
          }
          let task: Awaited<ReturnType<WorkflowImageTaskBridge['createOrReplay']>>;
          try {
            task = await input.bridge.createOrReplay({
              run: claimed.run,
              node: claimed.node,
              request,
              parentTaskId: authorization.parentTaskId,
              actingTokenId: authorization.actingTokenId,
              sessionId: authorization.sessionId,
            });
          } catch (error) {
            if (!(error instanceof WorkflowTaskBridgeError)) throw error;
            const failed = await input.workflow.failNode({
              ...scope,
              runId: claimed.run.run_id,
              nodeId: claimed.node.node_id,
              workerId: input.workerId,
              reasonCode: error.code,
              retryable: false,
              failedAt: input.now(),
            });
            if (failed) stats.failed += 1;
            else stats.leaseLost += 1;
            continue;
          }
          const attached = await input.workflow.attachTask({
            ...scope,
            runId: claimed.run.run_id,
            nodeId: claimed.node.node_id,
            workerId: input.workerId,
            taskId: task.taskId,
            updatedAt: input.now(),
          });
          if (!attached) {
            stats.leaseLost += 1;
            continue;
          }
          stats.attached += 1;
          const reconcileLeaseAlive = await input.workflow.heartbeatNode({
            ...scope,
            runId: claimed.run.run_id,
            nodeId: claimed.node.node_id,
            workerId: input.workerId,
            now: input.now(),
            leaseMs: input.leaseMs,
          });
          if (!reconcileLeaseAlive) {
            stats.leaseLost += 1;
            continue;
          }
          const reconciliation = await input.bridge.reconcile({
            run: claimed.run,
            node: attached,
            taskId: task.taskId,
          });
          await settleReconciliation(input, scope, claimed.run, attached, reconciliation, stats);
        }
      }
      return stats;
    },
    start() {
      if (started) return;
      started = true;
      lifecycleGeneration += 1;
      armTick(0, lifecycleGeneration);
    },
    async stop() {
      started = false;
      lifecycleGeneration += 1;
      if (scheduledTimer !== null) {
        cancelScheduled(scheduledTimer);
        scheduledTimer = null;
      }
      await activeTick;
    },
  };

  function armTick(delayMs: number, generation: number): void {
    scheduledTimer = schedule(() => {
      if (!started || generation !== lifecycleGeneration || activeTick !== null) return;
      scheduledTimer = null;
      activeTick = scheduler.runOnce().then(
        () => undefined,
        () => undefined,
      );
      void activeTick.finally(() => {
        activeTick = null;
        if (started && generation === lifecycleGeneration) armTick(intervalMs, generation);
      });
    }, delayMs);
  }

  return scheduler;
}

async function settleReconciliation(
  input: Parameters<typeof createWorkflowScheduler>[0],
  scope: WorkflowScope,
  run: WorkflowRun,
  node: WorkflowNode,
  reconciliation: WorkflowTaskReconciliation,
  stats: WorkflowSchedulerStats,
): Promise<void> {
  if (reconciliation.status === 'running') return;
  if (reconciliation.status === 'succeeded') {
    const completed = await input.workflow.completeNode({
      ...scope,
      runId: run.run_id,
      nodeId: node.node_id,
      workerId: input.workerId,
      assetIds: reconciliation.assetIds,
      evaluationVersion: node.evaluation_version,
      completedAt: input.now(),
    });
    if (completed) stats.completed += 1;
    else stats.leaseLost += 1;
    return;
  }
  const failed = await input.workflow.failNode({
    ...scope,
    runId: run.run_id,
    nodeId: node.node_id,
    workerId: input.workerId,
    reasonCode: reconciliation.reasonCode,
    retryable: false,
    failedAt: input.now(),
  });
  if (failed) stats.failed += 1;
  else stats.leaseLost += 1;
}

function emptyStats(): WorkflowSchedulerStats {
  return {
    scopes: 0,
    claimed: 0,
    attached: 0,
    completed: 0,
    failed: 0,
    leaseLost: 0,
  };
}
