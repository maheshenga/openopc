import { describe, expect, test } from 'bun:test';
import {
  type TaskEvent,
  TaskEventSchema,
  type WorkflowEvent,
  WorkflowEventSchema,
} from '@kortix/intelligence-contracts';
import { projectTaskEvent, projectWorkflowEvent } from './projector';

const RUN_ID = '71000000-0000-4000-a000-000000000001';
const NODE_ID = '71000000-0000-4000-a000-000000000002';
const TASK_ID = '72000000-0000-4000-a000-000000000001';
const ASSET_ID = '73000000-0000-4000-a000-000000000001';
const EVENT_ID = '74000000-0000-4000-a000-000000000001';
const CREATED_AT = '2026-07-21T10:00:00.000Z';

function workflowEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return WorkflowEventSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    event_id: EVENT_ID,
    run_id: RUN_ID,
    sequence: 1,
    type: 'run_started',
    status: 'running',
    graph_version: 1,
    node_id: null,
    task_id: null,
    progress: null,
    reason_code: null,
    asset_ids: [],
    route_reason_codes: [],
    evaluation_version: null,
    created_at: CREATED_AT,
    ...overrides,
  });
}

function taskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return TaskEventSchema.parse({
    protocol_version: 'intelligence.v1',
    event_id: EVENT_ID,
    task_id: TASK_ID,
    sequence: 1,
    type: 'created',
    status: 'queued',
    created_at: CREATED_AT,
    ...overrides,
  });
}

describe('AG-UI projector', () => {
  test('projects workflow run and node lifecycle events in deterministic order', () => {
    expect(projectWorkflowEvent(workflowEvent())).toEqual([
      { type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID },
    ]);

    expect(
      projectWorkflowEvent(
        workflowEvent({ type: 'node_started', node_id: NODE_ID, task_id: TASK_ID }),
      ),
    ).toEqual([{ type: 'STEP_STARTED', stepName: NODE_ID }]);

    expect(
      projectWorkflowEvent(
        workflowEvent({
          type: 'node_succeeded',
          node_id: NODE_ID,
          task_id: TASK_ID,
          asset_ids: [ASSET_ID],
        }),
      ),
    ).toEqual([
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: JSON.stringify({ asset_ids: [ASSET_ID] }),
      },
      { type: 'STEP_FINISHED', stepName: NODE_ID },
    ]);

    expect(
      projectWorkflowEvent(
        workflowEvent({
          type: 'node_failed',
          node_id: NODE_ID,
          task_id: TASK_ID,
          reason_code: 'WORKFLOW_EXECUTION_FAILED',
        }),
      ),
    ).toEqual([{ type: 'STEP_FINISHED', stepName: NODE_ID }]);
  });

  test('projects route selection and approvals through bounded tool and state events', () => {
    expect(
      projectWorkflowEvent(
        workflowEvent({
          type: 'route_selected',
          node_id: NODE_ID,
          route_reason_codes: ['WORKFLOW_ROUTE_SELECTED'],
        }),
      ),
    ).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: EVENT_ID, toolCallName: 'route-selection' },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: EVENT_ID,
        content: JSON.stringify({ route_reason_codes: ['WORKFLOW_ROUTE_SELECTED'] }),
      },
    ]);

    expect(
      projectWorkflowEvent(
        workflowEvent({
          type: 'node_waiting_approval',
          status: 'waiting_approval',
          node_id: NODE_ID,
          task_id: TASK_ID,
          reason_code: 'WORKFLOW_APPROVAL_REQUIRED',
        }),
      ),
    ).toEqual([
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          stage: 'workflow.approval.required',
          run_id: RUN_ID,
          node_id: NODE_ID,
          task_id: TASK_ID,
          status: 'waiting_approval',
          approval: 'required',
          reason_code: 'WORKFLOW_APPROVAL_REQUIRED',
        },
      },
    ]);
  });

  test('projects workflow terminal states without private data', () => {
    expect(
      projectWorkflowEvent(
        workflowEvent({ type: 'run_succeeded', status: 'succeeded', asset_ids: [ASSET_ID] }),
      ),
    ).toEqual([{ type: 'RUN_FINISHED', result: { asset_ids: [ASSET_ID] } }]);

    expect(
      projectWorkflowEvent(
        workflowEvent({
          type: 'run_failed',
          status: 'failed',
          reason_code: 'WORKFLOW_EXECUTION_FAILED',
        }),
      ),
    ).toEqual([
      {
        type: 'RUN_ERROR',
        message: 'Workflow failed',
        code: 'WORKFLOW_EXECUTION_FAILED',
      },
    ]);

    expect(
      projectWorkflowEvent(
        workflowEvent({
          type: 'run_cancelled',
          status: 'cancelled',
          reason_code: 'WORKFLOW_CANCELLED_BY_USER',
        }),
      ),
    ).toEqual([
      {
        type: 'RUN_ERROR',
        message: 'Workflow cancelled',
        code: 'WORKFLOW_CANCELLED_BY_USER',
      },
    ]);
  });

  test('projects task progress, assets, and terminal states', () => {
    expect(projectTaskEvent(taskEvent())).toEqual([
      { type: 'RUN_STARTED', threadId: TASK_ID, runId: TASK_ID },
    ]);

    expect(projectTaskEvent(taskEvent({ type: 'running', status: 'running' }))).toEqual([
      { type: 'STEP_STARTED', stepName: `task:${TASK_ID}` },
      { type: 'TOOL_CALL_START', toolCallId: TASK_ID, toolCallName: 'intelligence-task' },
    ]);

    expect(
      projectTaskEvent(taskEvent({ type: 'progress', status: 'running', progress: 0.5 })),
    ).toEqual([
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { stage: 'task.progress', task_id: TASK_ID, status: 'running', progress: 0.5 },
      },
    ]);

    expect(
      projectTaskEvent(
        taskEvent({ type: 'asset_created', status: 'running', asset_ids: [ASSET_ID] }),
      ),
    ).toEqual([
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: JSON.stringify({ asset_ids: [ASSET_ID] }),
      },
    ]);

    expect(
      projectTaskEvent(
        taskEvent({ type: 'succeeded', status: 'succeeded', asset_ids: [ASSET_ID] }),
      ),
    ).toEqual([
      { type: 'STEP_FINISHED', stepName: `task:${TASK_ID}` },
      { type: 'RUN_FINISHED', result: { asset_ids: [ASSET_ID] } },
    ]);

    expect(
      projectTaskEvent(
        taskEvent({
          type: 'failed',
          status: 'failed',
          error_code: 'INTELLIGENCE_TASK_FAILED',
        }),
      ),
    ).toEqual([
      { type: 'STEP_FINISHED', stepName: `task:${TASK_ID}` },
      { type: 'RUN_ERROR', message: 'Task failed', code: 'INTELLIGENCE_TASK_FAILED' },
    ]);

    expect(
      projectTaskEvent(
        taskEvent({
          type: 'cancelled',
          status: 'cancelled',
          error_code: 'INTELLIGENCE_TASK_CANCELLED',
        }),
      ),
    ).toEqual([
      { type: 'STEP_FINISHED', stepName: `task:${TASK_ID}` },
      { type: 'RUN_ERROR', message: 'Task cancelled', code: 'INTELLIGENCE_TASK_CANCELLED' },
    ]);
  });

  test('ignores internal graph events and rejects unsafe or non-monotonic source shapes', () => {
    expect(projectWorkflowEvent(workflowEvent({ type: 'graph_sealed' }))).toEqual([]);

    const unsafe = {
      ...workflowEvent(),
      sequence: 0,
      prompt: 'never expose this',
      provider_url: 'https://provider.example.test',
    } as unknown as WorkflowEvent;
    expect(projectWorkflowEvent(unsafe)).toEqual([]);

    const event = Object.freeze(workflowEvent({ type: 'node_started', node_id: NODE_ID }));
    expect(projectWorkflowEvent(event)).toEqual(projectWorkflowEvent(event));
  });
});
