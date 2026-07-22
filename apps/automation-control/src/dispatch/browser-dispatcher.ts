import { createHash } from 'node:crypto';
import {
  type AutomationJob,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  type AutomationBrowserDispatchEnvelope as BrowserDispatchEnvelope,
  type AutomationBrowserDispatchReceipt as BrowserDispatchReceipt,
  AutomationBrowserDispatchReceiptSchema as BrowserDispatchReceiptSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type {
  VerifiedWorkerPeer,
  WorkerServiceAuthenticator,
  WorkerServiceProof,
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
  localServiceId: string;
  localCertificateFingerprint256: string;
  nextNonce: () => number;
  now?: () => Date;
  isLeaseSignatureValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (binding: DispatchLeaseBinding) => Promise<boolean>;
}) {
  const now = input.now ?? (() => new Date());
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
      input.authenticator.assertPeer(raw.connection.peer, 'browser-worker');
      if (!(await input.isLeaseSignatureValid(lease))) {
        throw new BrowserDispatchError('browser lease signature is invalid');
      }
      const binding: DispatchLeaseBinding = {
        accountId: job.account_id,
        projectId: job.request.project_id,
        jobId: job.job_id,
        leaseId: lease.lease_id,
        owner: lease.owner,
        killSwitchGeneration: lease.kill_switch_generation,
      };
      if (!(await input.isLeaseCurrent(binding))) {
        throw new BrowserDispatchError('browser lease is not current');
      }
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
      const proof = input.authenticator.sign({
        serviceId: input.localServiceId,
        certificateFingerprint256: input.localCertificateFingerprint256,
        timestamp: dispatchedAt,
        nonce: input.nextNonce(),
        body: envelope,
      });
      assertDispatchBinding(job, lease, now());
      const response = await raw.connection.send({ envelope, proof });
      const receipt = BrowserDispatchReceiptSchema.parse(response.receipt);
      await input.authenticator.verify({
        peer: raw.connection.peer,
        expectedRole: 'browser-worker',
        proof: response.proof,
        body: receipt,
      });
      if (
        !receipt.accepted ||
        receipt.job_id !== job.job_id ||
        receipt.lease_id !== lease.lease_id ||
        receipt.worker_id !== raw.connection.peer.serviceId ||
        receipt.dispatch_envelope_hash !== canonicalEnvelopeHash(envelope) ||
        receipt.dispatch_proof_nonce !== proof.nonce
      ) {
        throw new BrowserDispatchError('browser worker receipt does not match the dispatch');
      }
      if (!(await input.isLeaseCurrent(binding))) {
        throw new BrowserDispatchError('browser lease is not current after dispatch');
      }
      return receipt;
    },
  };
}
