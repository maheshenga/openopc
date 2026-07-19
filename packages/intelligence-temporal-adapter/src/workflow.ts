import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type {
  TemporalWorkflowActivities,
  TemporalWorkflowApproval,
  TemporalWorkflowCancellation,
  TemporalWorkflowSnapshot,
} from './activities';

export type TemporalWorkflowInput = {
  accountId: string;
  projectId: string;
  runId: string;
  pollIntervalMs: number;
};

type TemporalApprovalCommand = Omit<
  TemporalWorkflowApproval,
  'accountId' | 'projectId' | 'runId'
>;
type TemporalCancellationCommand = Omit<
  TemporalWorkflowCancellation,
  'accountId' | 'projectId' | 'runId'
>;

export const temporalWorkflowApprovalSignal = defineSignal<[
  TemporalApprovalCommand,
]>('workflow-approval');
export const temporalWorkflowCancellationSignal = defineSignal<[
  TemporalCancellationCommand,
]>('workflow-cancel');

const activities = proxyActivities<TemporalWorkflowActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '10 seconds',
    maximumAttempts: 3,
  },
});

export async function coordinateWorkflow(
  input: TemporalWorkflowInput,
): Promise<TemporalWorkflowSnapshot> {
  assertInput(input);
  const scope = {
    accountId: input.accountId,
    projectId: input.projectId,
    runId: input.runId,
  };
  let approval: TemporalApprovalCommand | null = null;
  let cancellation: TemporalCancellationCommand | null = null;
  const currentApproval = (): TemporalApprovalCommand | null => approval;
  const currentCancellation = (): TemporalCancellationCommand | null => cancellation;

  setHandler(temporalWorkflowApprovalSignal, (command) => {
    approval = command;
  });
  setHandler(temporalWorkflowCancellationSignal, (command) => {
    cancellation = command;
  });

  while (true) {
    const cancellationCommand = currentCancellation();
    if (cancellationCommand !== null) {
      return activities.cancelRun({
        accountId: scope.accountId,
        projectId: scope.projectId,
        runId: scope.runId,
        reasonCode: cancellationCommand.reasonCode,
      });
    }
    const snapshot = await activities.pump(scope);
    if (isTerminal(snapshot.status)) return snapshot;
    if (snapshot.status === 'waiting_approval') {
      await condition(() => approval !== null || cancellation !== null);
      if (currentCancellation() !== null) continue;
      const approvalCommand = currentApproval();
      if (approvalCommand !== null) {
        approval = null;
        await activities.resolveApproval({
          accountId: scope.accountId,
          projectId: scope.projectId,
          runId: scope.runId,
          approvalId: approvalCommand.approvalId,
          actingUserId: approvalCommand.actingUserId,
          decision: approvalCommand.decision,
          feedbackHash: approvalCommand.feedbackHash,
        });
      }
      continue;
    }
    await sleep(input.pollIntervalMs);
  }
}

function assertInput(input: TemporalWorkflowInput): void {
  if (
    !UUID.test(input.accountId) ||
    !UUID.test(input.projectId) ||
    !UUID.test(input.runId) ||
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 1_000 ||
    input.pollIntervalMs > 60_000
  ) {
    throw new Error('TEMPORAL_WORKFLOW_INPUT_INVALID');
  }
}

function isTerminal(status: TemporalWorkflowSnapshot['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
