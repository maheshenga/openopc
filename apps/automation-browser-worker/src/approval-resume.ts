import type { ApprovalBinding, ConsumedApprovalBinding } from './action-runner';
import {
  type BrowserApprovalResumeClient,
  BrowserApprovalResumeClientError,
} from './approval-resume-client';
import type { BrowserDispatchWorkItem } from './dispatch-source';

export function createDispatchApprovalConsumer(input: {
  workItem: BrowserDispatchWorkItem;
  client: BrowserApprovalResumeClient;
  now?: () => Date;
}): (binding: ApprovalBinding) => Promise<ConsumedApprovalBinding | null> {
  const envelope = input.workItem.envelope;
  const now = input.now ?? (() => new Date());

  return async (binding) => {
    if (!('dispatch_kind' in envelope)) return null;
    const resume = envelope.approval_resume;
    if (
      binding.actionHash !== resume.action_hash ||
      binding.jobId !== envelope.lease.job_id ||
      binding.projectId !== envelope.request.project_id ||
      binding.stepId !== resume.step_id
    ) {
      return null;
    }
    const accepted = await input.client.consume({
      account_id: envelope.request.tenant_id,
      project_id: envelope.request.project_id,
      job_id: envelope.lease.job_id,
      approval_id: resume.approval_id,
      attempt_id: resume.attempt_id,
      step_id: resume.step_id,
      action_hash: resume.action_hash,
      lease_id: envelope.lease.lease_id,
      lease_owner: envelope.lease.owner,
      kill_switch_generation: envelope.lease.kill_switch_generation,
      resume_after_sequence: envelope.resume_after_sequence,
      token: resume.token,
      requested_at: now().toISOString(),
    });
    if (
      accepted.approvalId !== resume.approval_id ||
      accepted.attemptId !== resume.attempt_id ||
      accepted.jobId !== envelope.lease.job_id ||
      accepted.stepId !== resume.step_id
    ) {
      throw new BrowserApprovalResumeClientError(
        'protocol',
        'Browser approval resume response is invalid',
      );
    }
    return {
      ...binding,
      approvalId: accepted.approvalId,
      attemptId: accepted.attemptId,
      leaseId: envelope.lease.lease_id,
      killSwitchGeneration: envelope.lease.kill_switch_generation,
      resumeAfterSequence: envelope.resume_after_sequence,
      stepStartedAtomically: true,
    };
  };
}
