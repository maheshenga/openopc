import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AutomationJobRequestSchema,
  AutomationJobSchema,
  AutomationLeaseSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { createBrowserApprovalResumeCoordinator } from './browser-approval-resume-coordinator';
import type {
  BrowserApprovalResumeCandidate,
  BrowserApprovalResumeObservation,
  IssuedBrowserApprovalResume,
} from './browser-approval-resume-store';
import type { BrowserWorkerConnection } from './browser-dispatcher';

const NOW = new Date('2099-07-23T12:00:00.000Z');
const CONTROL_ID = 'automation-control';
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const STEP_ID = '40000000-0000-4000-a000-000000000003';
const APPROVAL_ID = '50000000-0000-4000-a000-000000000001';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;

const REQUEST = AutomationJobRequestSchema.parse({
  protocol_version: 'automation.v1',
  tenant_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  source_run_id: null,
  execution_domain: 'browser',
  steps: [
    {
      step_id: '40000000-0000-4000-a000-000000000001',
      sequence: 1,
      action: 'browser.wait',
      args: { milliseconds: 1 },
      risk: 'observe',
      action_hash: `sha256:${'8'.repeat(64)}`,
    },
    {
      step_id: '40000000-0000-4000-a000-000000000002',
      sequence: 2,
      action: 'browser.wait',
      args: { milliseconds: 1 },
      risk: 'observe',
      action_hash: `sha256:${'9'.repeat(64)}`,
    },
    {
      step_id: STEP_ID,
      sequence: 3,
      action: 'browser.payment',
      args: { selector: '#pay' },
      risk: 'external_effect',
      action_hash: ACTION_HASH,
    },
  ],
  capability_requirements: [{ capability: 'browser.page', methods: ['click'], scope: {} }],
  approval_policy: 'project-default',
  browser_policy: {
    allowed_origins: ['https://example.test'],
    network_mode: 'allowlist',
    open_network_expires_at: null,
    context: { mode: 'temporary', profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'browser-resume-coordinator-0001',
  deadline_at: '2099-07-23T13:00:00.000Z',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
});

const REQUEST_HASH = `sha256:${createHash('sha256')
  .update(canonicalAutomationRequestJson(REQUEST))
  .digest('hex')}` as const;

const JOB = AutomationJobSchema.parse({
  job_id: JOB_ID,
  account_id: ACCOUNT_ID,
  actor_user_id: '80000000-0000-4000-a000-000000000001',
  request: REQUEST,
  request_hash: REQUEST_HASH,
  status: 'dispatched',
  policy_version: 'policy-v1',
  kill_switch_generation: 7,
  created_at: '2099-07-23T11:55:00.000Z',
  updated_at: '2099-07-23T11:59:00.000Z',
  terminal_at: null,
});

const CANDIDATE: BrowserApprovalResumeCandidate = {
  job: JOB,
  approvalId: APPROVAL_ID,
  stepId: STEP_ID,
  actionHash: ACTION_HASH,
  resumeAfterSequence: 2,
  approvalExpiresAt: '2099-07-23T12:20:00.000Z',
};

function lease(id: string, issuedAt: string, expiresAt: string) {
  return AutomationLeaseSchema.parse({
    lease_id: id,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    execution_domain: 'browser',
    owner: `${CONTROL_ID}:${id}`,
    permission_id: null,
    request_hash: REQUEST_HASH,
    kill_switch_generation: 7,
    issued_at: issuedAt,
    expires_at: expiresAt,
    signature: `hmac-sha256:${'b'.repeat(64)}`,
  });
}

const LEASE_1 = lease(
  '60000000-0000-4000-a000-000000000001',
  NOW.toISOString(),
  '2099-07-23T12:00:30.000Z',
);
const LEASE_2 = lease(
  '60000000-0000-4000-a000-000000000002',
  LEASE_1.expires_at,
  '2099-07-23T12:01:00.000Z',
);

function attempt(id: string, tokenCharacter: string, currentLease: typeof LEASE_1) {
  return {
    attemptId: id,
    approvalId: APPROVAL_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    token: `approval-resume.v1.${tokenCharacter.repeat(43)}`,
    expiresAt: currentLease.expires_at,
    resumeAfterSequence: 2,
  } satisfies IssuedBrowserApprovalResume;
}

const ATTEMPT_1 = attempt('70000000-0000-4000-a000-000000000001', 'A', LEASE_1);
const ATTEMPT_2 = attempt('70000000-0000-4000-a000-000000000002', 'B', LEASE_2);

const connection = {
  peer: {
    serviceId: 'browser-worker-1',
    role: 'browser-worker' as const,
    certificateFingerprint256: 'AA:BB:CC:DD',
    certificateExpiresAt: '2099-07-24T00:00:00.000Z',
  },
  async send() {
    throw new Error('coordinator test does not use the raw connection');
  },
} satisfies BrowserWorkerConnection;

function createHarness(options?: {
  candidates?: readonly BrowserApprovalResumeCandidate[];
  dispatchFailure?: 'unavailable' | 'unknown_result';
  issueFailure?: 'throw' | 'null';
  abortAfterClaim?: boolean;
}) {
  let currentNow = NOW;
  let activeLease: typeof LEASE_1 | typeof LEASE_2 | null = null;
  let leaseIndex = 0;
  const controller = new AbortController();
  const claimInputs: unknown[] = [];
  const releaseInputs: unknown[] = [];
  const listInputs: unknown[] = [];
  const issueInputs: Array<Record<string, unknown>> = [];
  const dispatchInputs: Array<Record<string, unknown>> = [];
  const observations: BrowserApprovalResumeObservation[] = [];
  const leases = [LEASE_1, LEASE_2] as const;
  const attempts = [ATTEMPT_1, ATTEMPT_2] as const;
  const leaseManager = {
    claimInputs,
    releaseInputs,
    async claim(jobId: string, owner: string, now: Date, ttlMs: number) {
      claimInputs.push({ jobId, owner, now, ttlMs });
      if (activeLease !== null && Date.parse(activeLease.expires_at) > now.getTime()) return null;
      const next = leases[leaseIndex] ?? null;
      leaseIndex += 1;
      activeLease = next;
      if (options?.abortAfterClaim) controller.abort('after claim');
      return next;
    },
    async release(jobId: string, owner: string, now: Date) {
      releaseInputs.push({ jobId, owner, now });
      if (activeLease?.owner === owner) activeLease = null;
    },
  };
  const store = {
    listInputs,
    issueInputs,
    async listCandidates(input: { now: Date; limit: number }) {
      listInputs.push(input);
      return options?.candidates ?? [CANDIDATE];
    },
    async issue(input: {
      candidate: BrowserApprovalResumeCandidate;
      lease: typeof LEASE_1;
      now: Date;
    }) {
      issueInputs.push(input);
      if (options?.issueFailure === 'throw') throw new Error('private issuance failure');
      if (options?.issueFailure === 'null') return null;
      return attempts.find((candidate) => candidate.expiresAt === input.lease.expires_at) ?? null;
    },
  };
  const dispatcher = {
    inputs: dispatchInputs,
    async dispatchResume(input: Record<string, unknown>) {
      dispatchInputs.push(input);
      if (options?.dispatchFailure !== undefined) {
        throw new Error(`private ${options.dispatchFailure} token ${ATTEMPT_1.token}`);
      }
      return {
        protocol_version: 'automation.v1' as const,
        accepted: true,
        job_id: JOB_ID,
        lease_id: (input.lease as typeof LEASE_1).lease_id,
        worker_id: 'browser-worker-1',
        dispatch_envelope_hash: `sha256:${'c'.repeat(64)}` as const,
        dispatch_proof_nonce: 1,
        received_at: currentNow.toISOString(),
        capabilities: ['browser.approval-resume.v1' as const],
      };
    },
  };
  const coordinator = createBrowserApprovalResumeCoordinator({
    store,
    leaseManager,
    dispatcher,
    connection,
    owner: CONTROL_ID,
    leaseMs: 30_000,
    maxClaimsPerRun: 4,
    now: () => currentNow,
    observe: (event) => observations.push(event),
  });
  return {
    coordinator,
    controller,
    dispatcher,
    leaseManager,
    observations,
    setNow(value: Date) {
      currentNow = value;
    },
    store,
  };
}

describe('Browser approval resume coordinator', () => {
  test('claims a fresh Browser lease, issues one Attempt, and dispatches it', async () => {
    const harness = createHarness();
    expect(await harness.coordinator.runOnce()).toEqual({
      candidates: 1,
      claimed: 1,
      issued: 1,
      dispatched: 1,
      failed: 0,
      skipped: 0,
    });
    expect(harness.leaseManager.claimInputs).toEqual([
      { jobId: JOB_ID, owner: CONTROL_ID, now: NOW, ttlMs: 30_000 },
    ]);
    expect(harness.store.issueInputs).toEqual([{ candidate: CANDIDATE, lease: LEASE_1, now: NOW }]);
    expect(harness.dispatcher.inputs).toEqual([
      {
        job: CANDIDATE.job,
        lease: LEASE_1,
        connection,
        resumeAfterSequence: CANDIDATE.resumeAfterSequence,
        approval: ATTEMPT_1,
      },
    ]);
    expect(harness.leaseManager.releaseInputs).toHaveLength(0);
    expect(JSON.stringify(harness.observations)).not.toContain(ATTEMPT_1.token);
  });

  test('fences an unavailable or unknown dispatch until lease expiry', async () => {
    for (const reason of ['unavailable', 'unknown_result'] as const) {
      const harness = createHarness({ dispatchFailure: reason });
      expect((await harness.coordinator.runOnce()).failed).toBe(1);
      expect(harness.leaseManager.releaseInputs).toHaveLength(0);

      harness.setNow(new Date(LEASE_1.expires_at));
      expect((await harness.coordinator.runOnce()).issued).toBe(1);
      expect(harness.store.issueInputs.at(-1)?.lease).toMatchObject({ lease_id: LEASE_2.lease_id });
      expect(
        (harness.dispatcher.inputs.at(-1)?.approval as IssuedBrowserApprovalResume).attemptId,
      ).toBe(ATTEMPT_2.attemptId);
      expect(harness.leaseManager.releaseInputs).toHaveLength(0);
      expect(JSON.stringify(harness.observations)).not.toContain(ATTEMPT_1.token);
      expect(JSON.stringify(harness.observations)).not.toContain(ATTEMPT_2.token);
    }
  });

  test('never claims or replays a candidate whose target Step is running', async () => {
    const harness = createHarness({ candidates: [] });
    expect(await harness.coordinator.runOnce()).toEqual({
      candidates: 0,
      claimed: 0,
      issued: 0,
      dispatched: 0,
      failed: 0,
      skipped: 0,
    });
    expect(harness.leaseManager.claimInputs).toHaveLength(0);
    expect(harness.dispatcher.inputs).toHaveLength(0);
  });

  test('does no work after a pre-claim abort and releases an abort immediately after claim', async () => {
    const before = createHarness();
    before.controller.abort('before claim');
    expect(await before.coordinator.runOnce({ signal: before.controller.signal })).toEqual({
      candidates: 0,
      claimed: 0,
      issued: 0,
      dispatched: 0,
      failed: 0,
      skipped: 0,
    });
    expect(before.store.listInputs).toHaveLength(0);

    const after = createHarness({ abortAfterClaim: true });
    expect((await after.coordinator.runOnce({ signal: after.controller.signal })).claimed).toBe(1);
    expect(after.store.issueInputs).toHaveLength(0);
    expect(after.leaseManager.releaseInputs).toHaveLength(1);
  });

  test('releases issuance failures but never releases after a successful issue', async () => {
    for (const issueFailure of ['throw', 'null'] as const) {
      const harness = createHarness({ issueFailure });
      const result = await harness.coordinator.runOnce();
      expect(result[issueFailure === 'throw' ? 'failed' : 'skipped']).toBe(1);
      expect(harness.leaseManager.releaseInputs).toHaveLength(1);
    }

    const dispatched = createHarness({ dispatchFailure: 'unknown_result' });
    expect((await dispatched.coordinator.runOnce()).issued).toBe(1);
    expect(dispatched.leaseManager.releaseInputs).toHaveLength(0);
  });
});
