import type { WorkflowRun } from '@kortix/intelligence-contracts';
import type { WorkflowPort, WorkflowRunRef } from '@kortix/intelligence-orchestration';

export type TemporalWorkflowSnapshot = {
  status: WorkflowRun['status'];
};

export type TemporalWorkflowApproval = WorkflowRunRef & {
  approvalId: string;
  actingUserId: string;
  decision: 'approve' | 'reject' | 'changes_requested';
  feedbackHash: string | null;
};

export type TemporalWorkflowCancellation = WorkflowRunRef & {
  reasonCode: string;
};

export type TemporalWorkflowActivities = {
  pump(input: WorkflowRunRef): Promise<TemporalWorkflowSnapshot>;
  resolveApproval(input: TemporalWorkflowApproval): Promise<TemporalWorkflowSnapshot>;
  cancelRun(input: TemporalWorkflowCancellation): Promise<TemporalWorkflowSnapshot>;
};

type TemporalWorkflowCommandPort = Pick<WorkflowPort, 'getRun'> &
  Partial<Pick<WorkflowPort, 'resolveApproval' | 'cancelRun'>>;

export function createTemporalWorkflowActivities(input: {
  workflow: TemporalWorkflowCommandPort;
  runScheduler(scope: WorkflowRunRef): Promise<void>;
  now(): string;
}): TemporalWorkflowActivities {
  return {
    async pump(scope) {
      await input.runScheduler(scope);
      const run = await input.workflow.getRun(scope);
      return snapshot(run, scope);
    },

    async resolveApproval(command) {
      const resolveApproval = input.workflow.resolveApproval;
      if (!resolveApproval) throw new Error('TEMPORAL_WORKFLOW_ACTIVITY_UNAVAILABLE');
      const result = await resolveApproval({
        accountId: command.accountId,
        projectId: command.projectId,
        runId: command.runId,
        approvalId: command.approvalId,
        actingUserId: command.actingUserId,
        decision: command.decision,
        feedbackHash: command.feedbackHash,
        resolvedAt: input.now(),
      });
      return snapshot(result?.run ?? null, command);
    },

    async cancelRun(command) {
      const cancelRun = input.workflow.cancelRun;
      if (!cancelRun) throw new Error('TEMPORAL_WORKFLOW_ACTIVITY_UNAVAILABLE');
      const run = await cancelRun({
        accountId: command.accountId,
        projectId: command.projectId,
        runId: command.runId,
        reasonCode: command.reasonCode,
        cancelledAt: input.now(),
      });
      return snapshot(run, command);
    },
  };
}

function snapshot(run: WorkflowRun | null, scope: WorkflowRunRef): TemporalWorkflowSnapshot {
  if (!run) throw new Error('TEMPORAL_WORKFLOW_RUN_NOT_FOUND');
  if (
    run.account_id !== scope.accountId ||
    run.project_id !== scope.projectId ||
    run.run_id !== scope.runId
  ) {
    throw new Error('TEMPORAL_WORKFLOW_SCOPE_VIOLATION');
  }
  return { status: run.status };
}
