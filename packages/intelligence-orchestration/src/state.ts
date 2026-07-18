import type { WorkflowNodeStatus, WorkflowRunStatus } from '@kortix/intelligence-contracts';

const RUN_TRANSITIONS: Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>> = {
  draft: new Set(['running', 'cancelled']),
  running: new Set(['waiting_approval', 'succeeded', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const NODE_TRANSITIONS: Record<WorkflowNodeStatus, ReadonlySet<WorkflowNodeStatus>> = {
  pending: new Set(['ready', 'skipped', 'cancelled']),
  ready: new Set(['running', 'cancelled']),
  running: new Set(['ready', 'waiting_approval', 'succeeded', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
};

export class WorkflowStateTransitionError extends Error {
  readonly code = 'WORKFLOW_INVALID_STATE_TRANSITION' as const;

  constructor() {
    super('invalid workflow state transition');
    this.name = 'WorkflowStateTransitionError';
  }
}

export function assertWorkflowRunTransition(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): WorkflowRunStatus {
  if (from === to || RUN_TRANSITIONS[from].has(to)) return to;
  throw new WorkflowStateTransitionError();
}

export function assertWorkflowNodeTransition(
  from: WorkflowNodeStatus,
  to: WorkflowNodeStatus,
): WorkflowNodeStatus {
  if (from === to || NODE_TRANSITIONS[from].has(to)) return to;
  throw new WorkflowStateTransitionError();
}
