import { expect, test } from 'bun:test';
import type { TaskEvent } from '@kortix/sdk';
import { emptyImageTaskState, reduceTaskEvents } from './task-state';

const TASK_ID = '13000000-0000-4000-a000-000000000001';
const ASSET_ID = '27000000-0000-4000-a000-000000000001';

function event(
  sequence: number,
  type: TaskEvent['type'],
  status: TaskEvent['status'],
  extra: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    protocol_version: 'intelligence.v1',
    event_id: `25000000-0000-4000-a000-${String(sequence).padStart(12, '0')}`,
    task_id: TASK_ID,
    sequence,
    type,
    status,
    created_at: `2026-07-20T12:0${sequence}:00.000Z`,
    ...extra,
  };
}

test('reduces replayed events into one terminal result set', () => {
  const created = event(1, 'created', 'queued');
  const running = event(2, 'progress', 'running', { progress: 0.5 });
  const asset = event(3, 'asset_created', 'running', { asset_ids: [ASSET_ID] });
  const succeeded = event(4, 'succeeded', 'succeeded', {
    progress: 1,
    asset_ids: [ASSET_ID],
  });

  expect(reduceTaskEvents([succeeded, asset, running, asset, created])).toMatchObject({
    taskId: TASK_ID,
    status: 'succeeded',
    progress: 1,
    assetIds: [ASSET_ID],
    terminal: true,
    lastSequence: 4,
  });
});

test('advances across event pages without replaying assets or regressing a terminal state', () => {
  const firstPage = reduceTaskEvents([
    event(1, 'created', 'queued'),
    event(2, 'asset_created', 'running', { asset_ids: [ASSET_ID] }),
  ]);
  const terminal = reduceTaskEvents(
    [
      event(2, 'asset_created', 'running', { asset_ids: [ASSET_ID] }),
      event(3, 'succeeded', 'succeeded', { asset_ids: [ASSET_ID] }),
    ],
    firstPage,
  );
  const afterTerminal = reduceTaskEvents(
    [event(4, 'progress', 'running', { progress: 0.5 })],
    terminal,
  );

  expect(terminal).toMatchObject({
    status: 'succeeded',
    assetIds: [ASSET_ID],
    lastSequence: 3,
    terminal: true,
  });
  expect(afterTerminal).toEqual(terminal);
});

test('keeps malformed error codes out of the UI state', () => {
  const malformed = event(1, 'failed', 'failed', {
    error_code: 'private provider body' as TaskEvent['error_code'],
  });
  expect(reduceTaskEvents([malformed], emptyImageTaskState(TASK_ID)).errorCode).toBeNull();
});
