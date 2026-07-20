import { describe, expect, test } from 'bun:test';
import { type OpenOpcAgUiEvent, OpenOpcAgUiEventSchema } from './ag-ui';

const RUN_ID = '71000000-0000-4000-a000-000000000001';
const TASK_ID = '72000000-0000-4000-a000-000000000001';
const ASSET_ID = '73000000-0000-4000-a000-000000000001';

describe('OpenOPC AG-UI wire contract', () => {
  test('accepts the bounded AG-UI events emitted by the projector', () => {
    const events: OpenOpcAgUiEvent[] = [
      { type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID },
      { type: 'STEP_STARTED', stepName: `task:${TASK_ID}` },
      { type: 'STEP_FINISHED', stepName: `task:${TASK_ID}` },
      { type: 'TOOL_CALL_START', toolCallId: TASK_ID, toolCallName: 'workflow-task' },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: JSON.stringify({ asset_ids: [ASSET_ID] }),
      },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          stage: 'task.progress',
          task_id: TASK_ID,
          status: 'running',
          progress: 0.5,
        },
      },
      { type: 'RUN_FINISHED', result: { asset_ids: [ASSET_ID] } },
      { type: 'RUN_ERROR', message: 'Task failed', code: 'INTELLIGENCE_TASK_FAILED' },
    ];

    expect(events.map((event) => OpenOpcAgUiEventSchema.parse(event))).toEqual(events);
  });

  test('rejects unknown event fields and unsafe public text', () => {
    const unsafeEvents = [
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { stage: 'task.progress', task_id: TASK_ID, prompt: 'private prompt' },
      },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          stage: 'task.progress',
          task_id: TASK_ID,
          payload_ref: 'payload://private',
        },
      },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          stage: 'task.progress',
          task_id: TASK_ID,
          provider_url: 'https://provider.example.test',
        },
      },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { stage: 'task.progress', task_id: TASK_ID, raw_provider_body: '{}' },
      },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { stage: 'task.progress', task_id: TASK_ID, secret: 'not-public' },
      },
      { type: 'RUN_ERROR', message: 'See https://provider.example.test/logs' },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: 'sk-proj-012345678901234567890123456789',
      },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: 'ghp_0123456789012345678901234567890123456789',
      },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: 'AKIA0123456789ABCDEF',
      },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: TASK_ID,
        content: 'eyJabcdefgh.abcdefgh.abcdefgh',
      },
      { type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID, reasoning: 'private' },
      { type: 'NOT_AN_AG_UI_EVENT' },
    ];

    for (const event of unsafeEvents) {
      expect(OpenOpcAgUiEventSchema.safeParse(event).success).toBeFalse();
    }
  });
});
