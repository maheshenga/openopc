import type { TaskEvent } from '@kortix/sdk';

export type ImageTaskStatus = TaskEvent['status'] | 'unknown';

export interface ImageTaskViewState {
  taskId: string | null;
  status: ImageTaskStatus;
  progress: number;
  assetIds: string[];
  errorCode: string | null;
  terminal: boolean;
  lastSequence: number;
  lastUpdatedAt: string | null;
}

const TERMINAL_STATUSES = new Set<TaskEvent['status']>(['succeeded', 'failed', 'cancelled']);

export function emptyImageTaskState(taskId: string | null = null): ImageTaskViewState {
  return {
    taskId,
    status: 'unknown',
    progress: 0,
    assetIds: [],
    errorCode: null,
    terminal: false,
    lastSequence: 0,
    lastUpdatedAt: null,
  };
}

export function reduceTaskEvents(
  events: readonly TaskEvent[],
  initial: ImageTaskViewState = emptyImageTaskState(),
): ImageTaskViewState {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  let state = { ...initial, assetIds: [...initial.assetIds] };
  const seenEventIds = new Set<string>();
  const assetIds = new Set(state.assetIds);

  for (const event of ordered) {
    if (state.terminal) break;
    if (seenEventIds.has(event.event_id) || event.sequence <= state.lastSequence) continue;
    seenEventIds.add(event.event_id);
    if (state.taskId !== null && state.taskId !== event.task_id) {
      throw new Error('INTELLIGENCE_TASK_SCOPE_MISMATCH');
    }
    for (const assetId of event.asset_ids ?? []) assetIds.add(assetId);
    const terminal = TERMINAL_STATUSES.has(event.status);
    state = {
      taskId: event.task_id,
      status: event.status,
      progress:
        event.status === 'succeeded'
          ? 1
          : event.progress === undefined
            ? state.progress
            : Math.max(state.progress, event.progress),
      assetIds: [...assetIds],
      errorCode: safeErrorCode(event.error_code) ?? state.errorCode,
      terminal,
      lastSequence: event.sequence,
      lastUpdatedAt: event.created_at,
    };
  }
  return state;
}

function safeErrorCode(value: string | undefined): string | null {
  return value && /^[A-Z][A-Z0-9_.-]{0,127}$/.test(value) ? value : null;
}
