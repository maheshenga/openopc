import {
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  type IntelligenceExecutionTarget,
} from '@kortix/api-contract';
import type { TaskEvent, WorkflowNode, WorkflowRun } from '@kortix/intelligence-contracts';
import type {
  IntelligenceTaskCreateInput,
  IntelligenceTaskCreateResult,
  IntelligenceTaskService,
} from '../task-service';

const MAX_TASK_EVENT_PAGES = 10;

export type WorkflowTaskBridgeErrorCode =
  | 'WORKFLOW_TASK_REQUEST_INVALID'
  | 'WORKFLOW_TASK_TARGET_UNAVAILABLE';

export class WorkflowTaskBridgeError extends Error {
  constructor(readonly code: WorkflowTaskBridgeErrorCode) {
    super(code);
    this.name = 'WorkflowTaskBridgeError';
  }
}

export type WorkflowTaskReconciliation =
  | { status: 'running'; assetIds: string[]; reasonCode: null }
  | { status: 'succeeded'; assetIds: string[]; reasonCode: null }
  | { status: 'failed' | 'cancelled'; assetIds: string[]; reasonCode: string };

export type WorkflowImageTaskBridge = {
  createOrReplay(input: {
    run: WorkflowRun;
    node: WorkflowNode;
    request: unknown;
    parentTaskId: string | null;
    actingTokenId: string | null;
    sessionId: string | null;
  }): Promise<IntelligenceTaskCreateResult>;
  reconcile(input: {
    run: WorkflowRun;
    node: WorkflowNode;
    taskId: string;
  }): Promise<WorkflowTaskReconciliation>;
};

export function createWorkflowImageTaskBridge(input: {
  taskService: Pick<IntelligenceTaskService, 'create' | 'replay' | 'events'>;
  listExecutionTargets(scope: {
    accountId: string;
    projectId: string;
    capabilityId: 'studio.image.generate';
  }): Promise<readonly IntelligenceExecutionTarget[]>;
}): WorkflowImageTaskBridge {
  return {
    async createOrReplay(command) {
      assertExecutableNode(command.run, command.node);
      const parsed = IntelligenceCreateTaskRequestSchema.safeParse(command.request);
      if (!parsed.success) {
        throw new WorkflowTaskBridgeError('WORKFLOW_TASK_REQUEST_INVALID');
      }
      const request = normalizeRequest(command, parsed.data);
      const targets = await input.listExecutionTargets({
        accountId: command.run.account_id,
        projectId: command.run.project_id,
        capabilityId: 'studio.image.generate',
      });
      if (
        !targets.some(
          (target) =>
            target.capability_id === request.capability_id &&
            target.provider_config_id === request.provider_config_id &&
            target.model === request.model,
        )
      ) {
        throw new WorkflowTaskBridgeError('WORKFLOW_TASK_TARGET_UNAVAILABLE');
      }

      const scope = {
        accountId: command.run.account_id,
        projectId: command.run.project_id,
        request,
      };
      const replay = await input.taskService.replay(scope);
      if (replay) return replay;
      return input.taskService.create(taskInput(command, request));
    },

    async reconcile(command) {
      if (command.node.run_id !== command.run.run_id || command.node.task_id !== command.taskId) {
        throw new WorkflowTaskBridgeError('WORKFLOW_TASK_REQUEST_INVALID');
      }
      const events: TaskEvent[] = [];
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < MAX_TASK_EVENT_PAGES; pageIndex += 1) {
        const page = await input.taskService.events({
          accountId: command.run.account_id,
          projectId: command.run.project_id,
          taskId: command.taskId,
          cursor,
        });
        if (
          !page ||
          page.items.length > 100 ||
          page.items.some((event) => event.task_id !== command.taskId)
        ) {
          throw new WorkflowTaskBridgeError('WORKFLOW_TASK_REQUEST_INVALID');
        }
        events.push(...page.items);
        if (!page.nextCursor) break;
        if (page.nextCursor === cursor) {
          throw new WorkflowTaskBridgeError('WORKFLOW_TASK_REQUEST_INVALID');
        }
        cursor = page.nextCursor;
      }
      const assetIds = [...new Set(events.flatMap((event) => event.asset_ids ?? []))];
      const terminal = [...events]
        .sort((left, right) => right.sequence - left.sequence)
        .find(isTerminalTaskEvent);
      if (!terminal) return { status: 'running', assetIds, reasonCode: null };
      if (terminal.status === 'succeeded') {
        return { status: 'succeeded', assetIds, reasonCode: null };
      }
      return {
        status: terminal.status,
        assetIds,
        reasonCode:
          terminal.error_code ??
          (terminal.status === 'cancelled'
            ? 'INTELLIGENCE_TASK_CANCELLED'
            : 'INTELLIGENCE_TASK_FAILED'),
      };
    },
  };
}

function isTerminalTaskEvent(
  event: TaskEvent,
): event is TaskEvent & { status: 'succeeded' | 'failed' | 'cancelled' } {
  return event.status === 'succeeded' || event.status === 'failed' || event.status === 'cancelled';
}

function assertExecutableNode(run: WorkflowRun, node: WorkflowNode): void {
  if (
    node.run_id !== run.run_id ||
    node.kind !== 'capability' ||
    node.role !== 'executor' ||
    node.capability_id !== 'studio.image.generate' ||
    node.capability_version !== '1.0.0' ||
    node.agent_name === null ||
    node.agent_card_hash === null
  ) {
    throw new WorkflowTaskBridgeError('WORKFLOW_TASK_REQUEST_INVALID');
  }
}

function normalizeRequest(
  command: Parameters<WorkflowImageTaskBridge['createOrReplay']>[0],
  request: IntelligenceCreateTaskRequest,
): IntelligenceCreateTaskRequest {
  return IntelligenceCreateTaskRequestSchema.parse({
    ...request,
    capability_id: command.node.capability_id,
    agent_card_hash: command.node.agent_card_hash,
    idempotency_key: `workflow-node-${command.node.node_id}`,
    parent_task_id: command.parentTaskId,
    deadline_at: earliestDeadline(
      request.deadline_at ?? null,
      command.run.deadline_at,
      command.node.deadline_at,
    ),
  });
}

function taskInput(
  command: Parameters<WorkflowImageTaskBridge['createOrReplay']>[0],
  request: IntelligenceCreateTaskRequest,
): IntelligenceTaskCreateInput {
  return {
    accountId: command.run.account_id,
    projectId: command.run.project_id,
    actorUserId: command.run.actor_id,
    actorType: command.run.actor_type,
    actingTokenId: command.actingTokenId,
    agentName: command.node.agent_name,
    sessionId: command.sessionId,
    request,
  };
}

function earliestDeadline(...values: Array<string | null>): string | null {
  const deadlines = values.filter((value): value is string => value !== null);
  if (deadlines.length === 0) return null;
  return deadlines.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest,
  );
}
