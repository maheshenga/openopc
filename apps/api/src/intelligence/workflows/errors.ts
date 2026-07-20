export type WorkflowStoreErrorCode =
  | 'WORKFLOW_IDEMPOTENCY_MISMATCH'
  | 'WORKFLOW_GRAPH_CONFLICT'
  | 'WORKFLOW_GRAPH_VERSION_CONFLICT'
  | 'WORKFLOW_LEASE_CONFLICT'
  | 'WORKFLOW_BUDGET_RESERVATION_CONFLICT'
  | 'WORKFLOW_TASK_ATTACHMENT_CONFLICT'
  | 'WORKFLOW_APPROVAL_CONFLICT'
  | 'WORKFLOW_EVENT_CURSOR_CONFLICT';

export class WorkflowStoreError extends Error {
  constructor(readonly code: WorkflowStoreErrorCode) {
    super(code);
    this.name = 'WorkflowStoreError';
  }
}
