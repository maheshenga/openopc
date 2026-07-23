import { createHash } from 'node:crypto';
import {
  AutomationBrowserApprovalResumeDispatchEnvelopeSchema,
  type AutomationJob,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  type AutomationBrowserDispatchEnvelope as BrowserDispatchEnvelope,
  type AutomationBrowserDispatchReceipt as BrowserDispatchReceipt,
  AutomationBrowserDispatchReceiptSchema as BrowserDispatchReceiptSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type { IssuedBrowserApprovalResume } from './browser-approval-resume-store';
import type {
  VerifiedWorkerPeer,
  WorkerServiceAuthenticator,
  WorkerServiceProof,
  WorkerServiceSigner,
} from './worker-auth';

export type { BrowserDispatchEnvelope, BrowserDispatchReceipt };

export type DispatchLeaseBinding = Readonly<{
  accountId: string;
  projectId: string;
  jobId: string;
  leaseId: string;
  owner: string;
  killSwitchGeneration: number;
}>;

export interface BrowserWorkerConnection {
  readonly peer: VerifiedWorkerPeer;
  send(input: {
    envelope: BrowserDispatchEnvelope;
    proof: WorkerServiceProof;
  }): Promise<{ receipt: BrowserDispatchReceipt; proof: WorkerServiceProof }>;
}

export class BrowserDispatchError extends Error {
  override readonly name = 'BrowserDispatchError';
}

function canonicalRequestHash(job: AutomationJob): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(job.request))
    .digest('hex')}`;
}

function canonicalEnvelopeHash(envelope: BrowserDispatchEnvelope): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(envelope))
    .digest('hex')}`;
}

function assertDispatchBinding(job: AutomationJob, lease: AutomationLease, now: Date): void {
  if (job.request.execution_domain !== 'browser' || lease.execution_domain !== 'browser') {
    throw new BrowserDispatchError('browser execution domain is required');
  }
  if (job.status !== 'dispatched' && job.status !== 'running') {
    throw new BrowserDispatchError('browser job is not dispatchable');
  }
  if (
    canonicalRequestHash(job) !== job.request_hash ||
    lease.request_hash !== job.request_hash ||
    lease.job_id !== job.job_id ||
    lease.project_id !== job.request.project_id ||
    lease.kill_switch_generation !== job.kill_switch_generation
  ) {
    throw new BrowserDispatchError('browser lease does not match the job authority');
  }
  if (
    Date.parse(lease.expires_at) <= now.getTime() ||
    Date.parse(job.request.deadline_at) <= now.getTime()
  ) {
    throw new BrowserDispatchError('browser lease or request deadline is expired');
  }
}

export function createBrowserDispatcher(input: {
  authenticator: WorkerServiceAuthenticator;
  signer: WorkerServiceSigner;
  now?: () => Date;
  isLeaseSignatureValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (binding: DispatchLeaseBinding) => Promise<boolean>;
}) {
  const now = input.now ?? (() => new Date());
  const dispatchEnvelope = async (raw: {
    job: AutomationJob;
    lease: AutomationLease;
    connection: BrowserWorkerConnection;
    envelope: BrowserDispatchEnvelope;
    dispatchedAt: Date;
    requireApprovalResumeCapability: boolean;
  }): Promise<BrowserDispatchReceipt> => {
    input.authenticator.assertPeer(raw.connection.peer, 'browser-worker');
    if (!(await input.isLeaseSignatureValid(raw.lease))) {
      throw new BrowserDispatchError('browser lease signature is invalid');
    }
    const binding: DispatchLeaseBinding = {
      accountId: raw.job.account_id,
      projectId: raw.job.request.project_id,
      jobId: raw.job.job_id,
      leaseId: raw.lease.lease_id,
      owner: raw.lease.owner,
      killSwitchGeneration: raw.lease.kill_switch_generation,
    };
    if (!(await input.isLeaseCurrent(binding))) {
      throw new BrowserDispatchError('browser lease is not current');
    }
    const proof = input.signer.sign(raw.envelope, raw.dispatchedAt);
    assertDispatchBinding(raw.job, raw.lease, now());
    const response = await raw.connection.send({ envelope: raw.envelope, proof });
    const receipt = BrowserDispatchReceiptSchema.parse(response.receipt);
    await input.authenticator.verify({
      peer: raw.connection.peer,
      expectedRole: 'browser-worker',
      proof: response.proof,
      body: receipt,
    });
    if (
      !receipt.accepted ||
      receipt.job_id !== raw.job.job_id ||
      receipt.lease_id !== raw.lease.lease_id ||
      receipt.worker_id !== raw.connection.peer.serviceId ||
      receipt.dispatch_envelope_hash !== canonicalEnvelopeHash(raw.envelope) ||
      receipt.dispatch_proof_nonce !== proof.nonce
    ) {
      throw new BrowserDispatchError('browser worker receipt does not match the dispatch');
    }
    if (
      raw.requireApprovalResumeCapability &&
      receipt.capabilities?.includes('browser.approval-resume.v1') !== true
    ) {
      throw new BrowserDispatchError('browser worker approval resume capability is missing');
    }
    if (!(await input.isLeaseCurrent(binding))) {
      throw new BrowserDispatchError('browser lease is not current after dispatch');
    }
    return receipt;
  };

  return {
    async dispatch(raw: {
      job: AutomationJob;
      lease: AutomationLease;
      connection: BrowserWorkerConnection;
      resumeAfterSequence?: number;
    }): Promise<BrowserDispatchReceipt> {
      const job = AutomationJobSchema.parse(raw.job);
      const lease = AutomationLeaseSchema.parse(raw.lease);
      const dispatchedAt = now();
      assertDispatchBinding(job, lease, dispatchedAt);
      const resumeAfterSequence = raw.resumeAfterSequence ?? 0;
      if (!Number.isSafeInteger(resumeAfterSequence) || resumeAfterSequence < 0) {
        throw new BrowserDispatchError('browser resume cursor is invalid');
      }
      const envelope: BrowserDispatchEnvelope = Object.freeze({
        protocol_version: 'automation.v1',
        request: job.request,
        lease,
        policy_version: job.policy_version,
        resume_after_sequence: resumeAfterSequence,
        dispatched_at: dispatchedAt.toISOString(),
      });
      return dispatchEnvelope({
        job,
        lease,
        connection: raw.connection,
        envelope,
        dispatchedAt,
        requireApprovalResumeCapability: false,
      });
    },
    async dispatchResume(raw: {
      job: AutomationJob;
      lease: AutomationLease;
      connection: BrowserWorkerConnection;
      resumeAfterSequence: number;
      approval: IssuedBrowserApprovalResume;
    }): Promise<BrowserDispatchReceipt> {
      const job = AutomationJobSchema.parse(raw.job);
      const lease = AutomationLeaseSchema.parse(raw.lease);
      const dispatchedAt = now();
      assertDispatchBinding(job, lease, dispatchedAt);
      if (!Number.isSafeInteger(raw.resumeAfterSequence) || raw.resumeAfterSequence < 0) {
        throw new BrowserDispatchError('browser approval resume cursor is invalid');
      }
      const targetStep = [...job.request.steps]
        .sort((left, right) => left.sequence - right.sequence)
        .find((step) => step.sequence > raw.resumeAfterSequence);
      const expiresAt = Date.parse(raw.approval.expiresAt);
      if (
        raw.approval.jobId !== job.job_id ||
        raw.approval.approvalId.length === 0 ||
        targetStep === undefined ||
        raw.approval.stepId !== targetStep.step_id ||
        raw.approval.actionHash !== targetStep.action_hash ||
        raw.approval.resumeAfterSequence !== raw.resumeAfterSequence ||
        !Number.isFinite(expiresAt) ||
        expiresAt > Date.parse(lease.expires_at)
      ) {
        throw new BrowserDispatchError('browser approval resume binding is invalid');
      }
      const envelope = AutomationBrowserApprovalResumeDispatchEnvelopeSchema.parse({
        protocol_version: 'automation.v1',
        dispatch_kind: 'browser.approval-resume.v1',
        request: job.request,
        lease,
        policy_version: job.policy_version,
        resume_after_sequence: raw.resumeAfterSequence,
        dispatched_at: dispatchedAt.toISOString(),
        approval_resume: {
          approval_id: raw.approval.approvalId,
          attempt_id: raw.approval.attemptId,
          step_id: raw.approval.stepId,
          action_hash: raw.approval.actionHash,
          token: raw.approval.token,
          expires_at: raw.approval.expiresAt,
        },
      });
      return dispatchEnvelope({
        job,
        lease,
        connection: raw.connection,
        envelope,
        dispatchedAt,
        requireApprovalResumeCapability: true,
      });
    },
  };
}
