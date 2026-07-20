import {
  type OpenOpcAgUiEvent,
  OpenOpcAgUiEventSchema,
  type TaskEvent,
  TaskEventSchema,
  type WorkflowEvent,
  WorkflowEventSchema,
} from '@kortix/intelligence-contracts';

/**
 * Projects already-redacted durable Intelligence events to the AG-UI subset.
 * It has no persistence or sequencing state; cursor ordering remains owned by
 * the workflow replay and streaming layers.
 */
export function projectWorkflowEvent(event: WorkflowEvent): OpenOpcAgUiEvent[] {
  const parsed = WorkflowEventSchema.safeParse(event);
  if (!parsed.success) return [];
  const value = parsed.data;

  switch (value.type) {
    case 'run_started':
      return safeEvents([{ type: 'RUN_STARTED', threadId: value.run_id, runId: value.run_id }]);
    case 'node_started':
      return value.node_id ? safeEvents([{ type: 'STEP_STARTED', stepName: value.node_id }]) : [];
    case 'task_attached':
      return value.task_id
        ? safeEvents([
            { type: 'TOOL_CALL_START', toolCallId: value.task_id, toolCallName: 'workflow-task' },
          ])
        : [];
    case 'route_selected':
      return safeEvents([
        { type: 'TOOL_CALL_START', toolCallId: value.event_id, toolCallName: 'route-selection' },
        {
          type: 'TOOL_CALL_RESULT',
          toolCallId: value.event_id,
          content: JSON.stringify({ route_reason_codes: value.route_reason_codes }),
        },
      ]);
    case 'node_succeeded':
      return projectWorkflowNodeFinished(value, true);
    case 'node_failed':
    case 'node_skipped':
      return projectWorkflowNodeFinished(value, false);
    case 'node_waiting_approval':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: workflowSnapshot(value, 'workflow.approval.required', 'required'),
        },
      ]);
    case 'approval_resolved':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: workflowSnapshot(value, 'workflow.approval.resolved', 'resolved'),
        },
      ]);
    case 'run_succeeded':
      return safeEvents([
        {
          type: 'RUN_FINISHED',
          ...(value.asset_ids.length > 0 ? { result: { asset_ids: value.asset_ids } } : {}),
        },
      ]);
    case 'run_failed':
      return safeEvents([
        {
          type: 'RUN_ERROR',
          message: 'Workflow failed',
          code: value.reason_code ?? 'WORKFLOW_RUN_FAILED',
        },
      ]);
    case 'run_cancelled':
      return safeEvents([
        {
          type: 'RUN_ERROR',
          message: 'Workflow cancelled',
          code: value.reason_code ?? 'WORKFLOW_RUN_CANCELLED',
        },
      ]);
    default:
      return [];
  }
}

export function projectTaskEvent(event: TaskEvent): OpenOpcAgUiEvent[] {
  const parsed = TaskEventSchema.safeParse(event);
  if (!parsed.success) return [];
  const value = parsed.data;
  const stepName = `task:${value.task_id}`;

  switch (value.type) {
    case 'created':
      return safeEvents([{ type: 'RUN_STARTED', threadId: value.task_id, runId: value.task_id }]);
    case 'queued':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: { stage: 'task.queued', task_id: value.task_id, status: value.status },
        },
      ]);
    case 'running':
      return safeEvents([
        { type: 'STEP_STARTED', stepName },
        { type: 'TOOL_CALL_START', toolCallId: value.task_id, toolCallName: 'intelligence-task' },
      ]);
    case 'progress':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: {
            stage: 'task.progress',
            task_id: value.task_id,
            status: value.status,
            ...(value.progress === undefined ? {} : { progress: value.progress }),
          },
        },
      ]);
    case 'asset_created':
      return safeEvents([
        {
          type: 'TOOL_CALL_RESULT',
          toolCallId: value.task_id,
          content: JSON.stringify({ asset_ids: value.asset_ids ?? [] }),
        },
      ]);
    case 'approval_required':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: {
            stage: 'task.approval.required',
            task_id: value.task_id,
            status: value.status,
            approval: 'required',
            ...(value.error_code === undefined ? {} : { reason_code: value.error_code }),
          },
        },
      ]);
    case 'succeeded':
      return safeEvents([
        { type: 'STEP_FINISHED', stepName },
        {
          type: 'RUN_FINISHED',
          ...(value.asset_ids?.length ? { result: { asset_ids: value.asset_ids } } : {}),
        },
      ]);
    case 'failed':
      return safeEvents([
        { type: 'STEP_FINISHED', stepName },
        {
          type: 'RUN_ERROR',
          message: 'Task failed',
          code: value.error_code ?? 'INTELLIGENCE_TASK_FAILED',
        },
      ]);
    case 'cancelled':
      return safeEvents([
        { type: 'STEP_FINISHED', stepName },
        {
          type: 'RUN_ERROR',
          message: 'Task cancelled',
          code: value.error_code ?? 'INTELLIGENCE_TASK_CANCELLED',
        },
      ]);
  }
}

function projectWorkflowNodeFinished(
  event: WorkflowEvent,
  includeResult: boolean,
): OpenOpcAgUiEvent[] {
  if (!event.node_id) return [];
  const events: unknown[] = [];
  if (includeResult && event.task_id) {
    events.push({
      type: 'TOOL_CALL_RESULT',
      toolCallId: event.task_id,
      content: JSON.stringify({ asset_ids: event.asset_ids }),
    });
  }
  events.push({ type: 'STEP_FINISHED', stepName: event.node_id });
  return safeEvents(events);
}

function workflowSnapshot(
  event: WorkflowEvent,
  stage: 'workflow.approval.required' | 'workflow.approval.resolved',
  approval: 'required' | 'resolved',
) {
  return {
    stage,
    run_id: event.run_id,
    ...(event.node_id ? { node_id: event.node_id } : {}),
    ...(event.task_id ? { task_id: event.task_id } : {}),
    status: event.status,
    approval,
    ...(event.reason_code ? { reason_code: event.reason_code } : {}),
  };
}

function safeEvents(events: unknown[]): OpenOpcAgUiEvent[] {
  const parsed = OpenOpcAgUiEventSchema.array().safeParse(events);
  return parsed.success ? parsed.data : [];
}
