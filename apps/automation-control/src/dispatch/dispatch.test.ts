import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AutomationEvent,
  AutomationEventSchema,
  type AutomationJob,
  type AutomationJobRequest,
  AutomationJobRequestSchema,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { createBrowserDispatcher } from './browser-dispatcher';
import { createDesktopDispatcher } from './desktop-dispatcher';
import { createHeartbeatProcessor } from './heartbeat';
import {
  createMemoryWorkerNonceStore,
  createWorkerServiceAuthenticator,
  createWorkerServiceSigner,
} from './worker-auth';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const RESUME_CURSOR_STEP_ID = '50000000-0000-4000-a000-000000000002';
const RESUME_STEP_ID = '50000000-0000-4000-a000-000000000003';
const LEASE_ID = '60000000-0000-4000-a000-000000000001';
const DEVICE_ID = '70000000-0000-4000-a000-000000000001';
const PERMISSION_ID = '80000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '81000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '82000000-0000-4000-a000-000000000001';
const APPROVAL_TOKEN = `approval.v1.${'A'.repeat(43)}`;
const APPROVAL_RESUME_TOKEN = `approval-resume.v1.${'B'.repeat(43)}`;
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
const RESUME_ACTION_HASH = `sha256:${'d'.repeat(64)}` as const;
const POLICY_HASH = `sha256:${'b'.repeat(64)}`;
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
// Keep schema-level "future" checks deterministic without letting this fixture expire.
const NOW = new Date('2099-07-22T08:00:00.000Z');

function requestHash(request: AutomationJobRequest): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(request))
    .digest('hex')}`;
}

function canonicalHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(value))
    .digest('hex')}`;
}

function browserRequest(): AutomationJobRequest {
  return AutomationJobRequestSchema.parse({
    protocol_version: 'automation.v1',
    tenant_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'browser',
    steps: [
      {
        step_id: STEP_ID,
        sequence: 1,
        action: 'browser.read',
        args: { selector: '#result' },
        risk: 'observe',
        action_hash: ACTION_HASH,
      },
    ],
    capability_requirements: [
      { capability: 'browser', methods: ['read'], scope: { project_id: PROJECT_ID } },
    ],
    approval_policy: 'project-default',
    browser_policy: {
      allowed_origins: ['https://example.com'],
      network_mode: 'allowlist',
      open_network_expires_at: null,
      context: { mode: 'temporary', profile_id: null },
    },
    desktop_policy: null,
    idempotency_key: 'dispatch-browser-0001',
    deadline_at: '2099-07-22T08:05:00.000Z',
    traceparent: TRACEPARENT,
  });
}

function resumeBrowserRequest(): AutomationJobRequest {
  return AutomationJobRequestSchema.parse({
    ...browserRequest(),
    steps: [
      ...browserRequest().steps,
      {
        step_id: RESUME_CURSOR_STEP_ID,
        sequence: 2,
        action: 'browser.wait',
        args: { milliseconds: 1 },
        risk: 'observe',
        action_hash: `sha256:${'c'.repeat(64)}`,
      },
      {
        step_id: RESUME_STEP_ID,
        sequence: 3,
        action: 'browser.click',
        args: { selector: '#approve' },
        risk: 'external_effect',
        action_hash: RESUME_ACTION_HASH,
      },
    ],
    idempotency_key: 'dispatch-browser-resume-0001',
  });
}

function desktopRequest(options?: {
  action?: string;
  risk?: string;
  approvalPolicy?: 'project-default' | 'full-access';
  fullAccessExpiresAt?: string | null;
}): AutomationJobRequest {
  return AutomationJobRequestSchema.parse({
    protocol_version: 'automation.v1',
    tenant_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'desktop',
    steps: [
      {
        step_id: STEP_ID,
        sequence: 1,
        action: options?.action ?? 'desktop.mouse',
        args: { method: 'desktop.cua.click', params: { x: 12, y: 24 } },
        risk: options?.risk ?? 'operate',
        action_hash: ACTION_HASH,
      },
    ],
    capability_requirements: [
      { capability: 'desktop', methods: ['mouse'], scope: { device_id: DEVICE_ID } },
    ],
    approval_policy: options?.approvalPolicy ?? 'project-default',
    browser_policy: null,
    desktop_policy: {
      device_id: DEVICE_ID,
      allowed_applications: ['chrome'],
      full_access_expires_at: options?.fullAccessExpiresAt ?? null,
      kill_switch_generation: 7,
    },
    idempotency_key: 'dispatch-desktop-001',
    deadline_at: '2099-07-22T08:05:00.000Z',
    traceparent: TRACEPARENT,
  });
}

function job(request: AutomationJobRequest): AutomationJob {
  return AutomationJobSchema.parse({
    job_id: JOB_ID,
    account_id: ACCOUNT_ID,
    actor_user_id: USER_ID,
    request,
    request_hash: requestHash(request),
    status: 'dispatched',
    policy_version: POLICY_HASH,
    kill_switch_generation: request.desktop_policy?.kill_switch_generation ?? 0,
    created_at: '2099-07-22T07:59:00.000Z',
    updated_at: '2099-07-22T07:59:30.000Z',
    terminal_at: null,
  });
}

function lease(request: AutomationJobRequest, permissionId: string | null = null): AutomationLease {
  return AutomationLeaseSchema.parse({
    lease_id: LEASE_ID,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    execution_domain: request.execution_domain,
    owner: `${request.execution_domain}-worker:session-1`,
    permission_id: permissionId,
    request_hash: requestHash(request),
    kill_switch_generation: request.desktop_policy?.kill_switch_generation ?? 0,
    issued_at: '2099-07-22T07:59:45.000Z',
    expires_at: '2099-07-22T08:01:00.000Z',
    signature: `hmac-sha256:${'c'.repeat(64)}`,
  });
}

function authentication() {
  const nonceStore = createMemoryWorkerNonceStore();
  const authenticator = createWorkerServiceAuthenticator({
    now: () => NOW,
    nonceStore,
    trustedPeers: {
      'browser-worker-1': {
        role: 'browser-worker',
        fingerprints: ['BB:WORKER'],
        sharedSecret: 'worker-shared-secret-with-at-least-32-bytes',
      },
    },
  });
  const workerPeer = authenticator.bindTlsPeer({
    authorized: true,
    serviceId: 'browser-worker-1',
    fingerprint256: 'BB:WORKER',
    validTo: '2099-07-23T08:00:00.000Z',
  });
  return { authenticator, workerPeer };
}

function controlSigner(nextNonce: () => number) {
  return createWorkerServiceSigner({
    serviceId: 'automation-control',
    certificateFingerprint256: 'AA:CONTROL',
    sharedSecret: 'control-worker-secret-with-at-least-32-bytes',
    nextNonce,
  });
}

describe('automation dispatch boundary', () => {
  test('dispatches a browser request only across mutually authenticated, signed service messages', async () => {
    const request = browserRequest();
    const currentJob = job(request);
    const currentLease = lease(request);
    const { authenticator, workerPeer } = authentication();
    let transportCalls = 0;
    let leaseChecks = 0;

    const dispatcher = createBrowserDispatcher({
      authenticator,
      signer: controlSigner(
        (() => {
          let nonce = 0;
          return () => ++nonce;
        })(),
      ),
      now: () => NOW,
      isLeaseCurrent: async (binding) => {
        leaseChecks += 1;
        return binding.leaseId === LEASE_ID && binding.owner === currentLease.owner;
      },
      isLeaseSignatureValid: async () => true,
    });

    const result = await dispatcher.dispatch({
      job: currentJob,
      lease: currentLease,
      connection: {
        peer: workerPeer,
        async send(message) {
          transportCalls += 1;
          expect(message.envelope.policy_version).toBe(POLICY_HASH);
          expect(message.envelope.resume_after_sequence).toBe(99);
          expect(message.proof).toMatchObject({ service_id: 'automation-control', nonce: 1 });
          const receipt = {
            protocol_version: 'automation.v1' as const,
            accepted: true,
            job_id: JOB_ID,
            lease_id: LEASE_ID,
            worker_id: 'browser-worker-1',
            dispatch_envelope_hash: canonicalHash(message.envelope),
            dispatch_proof_nonce: message.proof.nonce,
            received_at: NOW.toISOString(),
          };
          return {
            receipt,
            proof: authenticator.sign({
              serviceId: 'browser-worker-1',
              certificateFingerprint256: 'BB:WORKER',
              timestamp: NOW,
              nonce: 1,
              body: receipt,
            }),
          };
        },
      },
      resumeAfterSequence: 99,
    });

    expect(transportCalls).toBe(1);
    expect(leaseChecks).toBe(2);
    expect(result.worker_id).toBe('browser-worker-1');
    expect(result.lease_id).toBe(LEASE_ID);
  });

  test('dispatches a bound approval Resume only with the signed Worker capability', async () => {
    const request = resumeBrowserRequest();
    const currentJob = job(request);
    const currentLease = lease(request);
    const approval = {
      attemptId: ATTEMPT_ID,
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      stepId: RESUME_STEP_ID,
      actionHash: RESUME_ACTION_HASH,
      token: APPROVAL_RESUME_TOKEN,
      expiresAt: '2099-07-22T08:00:45.000Z',
      resumeAfterSequence: 2,
    } as const;
    const { authenticator, workerPeer } = authentication();
    let sentEnvelope: unknown;
    let leaseChecks = 0;
    const dispatcher = createBrowserDispatcher({
      authenticator,
      signer: controlSigner(() => 31),
      now: () => NOW,
      isLeaseCurrent: async () => {
        leaseChecks += 1;
        return true;
      },
      isLeaseSignatureValid: async () => true,
    });

    const receipt = await dispatcher.dispatchResume({
      job: currentJob,
      lease: currentLease,
      connection: {
        peer: workerPeer,
        async send(message) {
          sentEnvelope = message.envelope;
          expect(message.proof).toMatchObject({ service_id: 'automation-control', nonce: 31 });
          const workerReceipt = {
            protocol_version: 'automation.v1' as const,
            accepted: true,
            job_id: JOB_ID,
            lease_id: LEASE_ID,
            worker_id: 'browser-worker-1',
            dispatch_envelope_hash: canonicalHash(message.envelope),
            dispatch_proof_nonce: message.proof.nonce,
            received_at: NOW.toISOString(),
            capabilities: ['browser.approval-resume.v1' as const],
          };
          return {
            receipt: workerReceipt,
            proof: authenticator.sign({
              serviceId: 'browser-worker-1',
              certificateFingerprint256: 'BB:WORKER',
              timestamp: NOW,
              nonce: 32,
              body: workerReceipt,
            }),
          };
        },
      },
      resumeAfterSequence: 2,
      approval,
    });

    expect(receipt.capabilities).toContain('browser.approval-resume.v1');
    expect(sentEnvelope).toEqual(
      expect.objectContaining({
        dispatch_kind: 'browser.approval-resume.v1',
        resume_after_sequence: 2,
        approval_resume: expect.objectContaining({
          approval_id: APPROVAL_ID,
          attempt_id: ATTEMPT_ID,
          token: APPROVAL_RESUME_TOKEN,
        }),
      }),
    );
    expect(leaseChecks).toBe(2);
  });

  test('rejects inconsistent Resume credentials before contacting the Worker', async () => {
    const request = resumeBrowserRequest();
    const currentJob = job(request);
    const currentLease = lease(request);
    const validApproval = {
      attemptId: ATTEMPT_ID,
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      stepId: RESUME_STEP_ID,
      actionHash: RESUME_ACTION_HASH,
      token: APPROVAL_RESUME_TOKEN,
      expiresAt: '2099-07-22T08:00:45.000Z',
      resumeAfterSequence: 2,
    } as const;
    const cases = [
      { ...validApproval, approvalId: '' },
      { ...validApproval, jobId: '40000000-0000-4000-a000-000000000099' },
      { ...validApproval, stepId: '50000000-0000-4000-a000-000000000099' },
      { ...validApproval, actionHash: `sha256:${'f'.repeat(64)}` as const },
      { ...validApproval, resumeAfterSequence: 1 },
      { ...validApproval, expiresAt: '2099-07-22T08:01:01.000Z' },
    ];

    for (const approval of cases) {
      const { authenticator, workerPeer } = authentication();
      let sends = 0;
      const dispatcher = createBrowserDispatcher({
        authenticator,
        signer: controlSigner(() => 41),
        now: () => NOW,
        isLeaseCurrent: async () => true,
        isLeaseSignatureValid: async () => true,
      });
      await expect(
        dispatcher.dispatchResume({
          job: currentJob,
          lease: currentLease,
          connection: {
            peer: workerPeer,
            async send() {
              sends += 1;
              throw new Error('unexpected Resume transport');
            },
          },
          resumeAfterSequence: 2,
          approval,
        }),
      ).rejects.toThrow(/approval resume/i);
      expect(sends).toBe(0);
    }
  });

  test('rejects Resume receipts without capability and leases revoked during transport', async () => {
    for (const scenario of ['missing_capability', 'stale_lease'] as const) {
      const request = resumeBrowserRequest();
      const currentLease = lease(request);
      const { authenticator, workerPeer } = authentication();
      let leaseChecks = 0;
      const dispatcher = createBrowserDispatcher({
        authenticator,
        signer: controlSigner(() => 51),
        now: () => NOW,
        isLeaseCurrent: async () => {
          leaseChecks += 1;
          return scenario !== 'stale_lease' || leaseChecks === 1;
        },
        isLeaseSignatureValid: async () => true,
      });
      await expect(
        dispatcher.dispatchResume({
          job: job(request),
          lease: currentLease,
          connection: {
            peer: workerPeer,
            async send(message) {
              const workerReceipt = {
                protocol_version: 'automation.v1' as const,
                accepted: true,
                job_id: JOB_ID,
                lease_id: LEASE_ID,
                worker_id: 'browser-worker-1',
                dispatch_envelope_hash: canonicalHash(message.envelope),
                dispatch_proof_nonce: message.proof.nonce,
                received_at: NOW.toISOString(),
                ...(scenario === 'stale_lease'
                  ? { capabilities: ['browser.approval-resume.v1' as const] }
                  : {}),
              };
              return {
                receipt: workerReceipt,
                proof: authenticator.sign({
                  serviceId: 'browser-worker-1',
                  certificateFingerprint256: 'BB:WORKER',
                  timestamp: NOW,
                  nonce: 52,
                  body: workerReceipt,
                }),
              };
            },
          },
          resumeAfterSequence: 2,
          approval: {
            attemptId: ATTEMPT_ID,
            approvalId: APPROVAL_ID,
            jobId: JOB_ID,
            stepId: RESUME_STEP_ID,
            actionHash: RESUME_ACTION_HASH,
            token: APPROVAL_RESUME_TOKEN,
            expiresAt: '2099-07-22T08:00:45.000Z',
            resumeAfterSequence: 2,
          },
        }),
      ).rejects.toThrow(scenario === 'missing_capability' ? /capability/i : /lease.*current/i);
    }
  });

  test('does not contact the browser worker when async checks cross the job deadline', async () => {
    const request = browserRequest();
    const currentLease = AutomationLeaseSchema.parse({
      ...lease(request),
      expires_at: '2099-07-22T08:10:00.000Z',
    });
    const { authenticator, workerPeer } = authentication();
    let nowCalls = 0;
    let transportCalls = 0;
    const dispatcher = createBrowserDispatcher({
      authenticator,
      signer: controlSigner(() => 1),
      now: () => {
        nowCalls += 1;
        return nowCalls === 1 ? NOW : new Date('2099-07-22T08:05:01.000Z');
      },
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
    });

    await expect(
      dispatcher.dispatch({
        job: job(request),
        lease: currentLease,
        connection: {
          peer: workerPeer,
          async send() {
            transportCalls += 1;
            throw new Error('unexpected browser transport');
          },
        },
      }),
    ).rejects.toThrow(/deadline.*expired/i);
    expect(transportCalls).toBe(0);
  });

  test('rejects domain mismatch and an invalid worker receipt signature', async () => {
    const browser = browserRequest();
    const desktop = desktopRequest();
    const { authenticator, workerPeer } = authentication();
    let calls = 0;
    const dispatcher = createBrowserDispatcher({
      authenticator,
      signer: controlSigner(() => 1),
      now: () => NOW,
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
    });
    const connection = {
      peer: workerPeer,
      async send() {
        calls += 1;
        const receipt = {
          protocol_version: 'automation.v1' as const,
          accepted: true,
          job_id: JOB_ID,
          lease_id: LEASE_ID,
          worker_id: 'browser-worker-1',
          dispatch_envelope_hash: `sha256:${'d'.repeat(64)}` as const,
          dispatch_proof_nonce: 1,
          received_at: NOW.toISOString(),
        };
        return {
          receipt,
          proof: {
            service_id: 'browser-worker-1',
            timestamp: NOW.toISOString(),
            nonce: 1,
            signature: `hmac-sha256:${'0'.repeat(64)}`,
          },
        };
      },
    };

    await expect(
      dispatcher.dispatch({ job: job(desktop), lease: lease(desktop, PERMISSION_ID), connection }),
    ).rejects.toThrow(/browser execution domain/i);
    expect(calls).toBe(0);

    await expect(
      dispatcher.dispatch({ job: job(browser), lease: lease(browser), connection }),
    ).rejects.toThrow(/service signature/i);
    expect(calls).toBe(1);
  });

  test('rejects an untrusted TLS certificate and replayed service proof', async () => {
    const { authenticator, workerPeer } = authentication();
    expect(() =>
      authenticator.bindTlsPeer({
        authorized: true,
        serviceId: 'browser-worker-1',
        fingerprint256: 'CC:ATTACKER',
        validTo: '2099-07-23T08:00:00.000Z',
      }),
    ).toThrow(/certificate/i);

    const body = { heartbeat: true };
    const proof = authenticator.sign({
      serviceId: 'browser-worker-1',
      certificateFingerprint256: 'BB:WORKER',
      timestamp: NOW,
      nonce: 8,
      body,
    });
    await authenticator.verify({
      peer: workerPeer,
      expectedRole: 'browser-worker',
      proof,
      body,
    });
    await expect(
      authenticator.verify({
        peer: workerPeer,
        expectedRole: 'browser-worker',
        proof,
        body,
      }),
    ).rejects.toThrow(/replay/i);
  });

  test('rejects browser receipt envelope/proof mismatches and a lease revoked during transport', async () => {
    const scenarios = [
      { name: 'envelope hash', mutateHash: true, mutateNonce: false, revokeAfterSend: false },
      { name: 'proof nonce', mutateHash: false, mutateNonce: true, revokeAfterSend: false },
      { name: 'post-response lease', mutateHash: false, mutateNonce: false, revokeAfterSend: true },
    ] as const;

    for (const scenario of scenarios) {
      const request = browserRequest();
      const currentLease = lease(request);
      const { authenticator, workerPeer } = authentication();
      let leaseChecks = 0;
      const dispatcher = createBrowserDispatcher({
        authenticator,
        signer: controlSigner(() => 41),
        now: () => NOW,
        isLeaseCurrent: async () => {
          leaseChecks += 1;
          return !(scenario.revokeAfterSend && leaseChecks > 1);
        },
        isLeaseSignatureValid: async () => true,
      });

      await expect(
        dispatcher.dispatch({
          job: job(request),
          lease: currentLease,
          connection: {
            peer: workerPeer,
            async send(message) {
              const receipt = {
                protocol_version: 'automation.v1' as const,
                accepted: true,
                job_id: JOB_ID,
                lease_id: LEASE_ID,
                worker_id: 'browser-worker-1',
                dispatch_envelope_hash: scenario.mutateHash
                  ? (`sha256:${'e'.repeat(64)}` as const)
                  : canonicalHash(message.envelope),
                dispatch_proof_nonce: scenario.mutateNonce ? 42 : message.proof.nonce,
                received_at: NOW.toISOString(),
              };
              return {
                receipt,
                proof: authenticator.sign({
                  serviceId: 'browser-worker-1',
                  certificateFingerprint256: 'BB:WORKER',
                  timestamp: NOW,
                  nonce: 51,
                  body: receipt,
                }),
              };
            },
          },
        }),
      ).rejects.toThrow(scenario.revokeAfterSend ? /lease.*current/i : /receipt.*dispatch/i);
    }
  });

  test('routes a desktop action only through the existing Tunnel RPC adapter with full fencing', async () => {
    const request = desktopRequest();
    const currentJob = job(request);
    const currentLease = lease(request, PERMISSION_ID);
    const tunnelCalls: Array<Record<string, unknown>> = [];
    const consumed: Array<Record<string, unknown>> = [];
    const abortController = new AbortController();
    let leaseChecks = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => NOW,
      isLeaseCurrent: async (binding) => {
        leaseChecks += 1;
        return binding.leaseId === LEASE_ID && binding.killSwitchGeneration === 7;
      },
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => false,
      consumeStepApproval: async (binding) => {
        consumed.push(binding);
        return true;
      },
      executeTunnelRpc: async (input) => {
        tunnelCalls.push(input);
        return { ok: true, result: { clicked: true } };
      },
    });

    const result = await dispatcher.dispatchStep({
      job: currentJob,
      lease: currentLease,
      stepId: STEP_ID,
      tunnelId: DEVICE_ID,
      permissionId: PERMISSION_ID,
      approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      signal: abortController.signal,
    });

    expect(result).toEqual({ clicked: true });
    expect(tunnelCalls).toHaveLength(1);
    expect(leaseChecks).toBe(3);
    expect(consumed).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        stepId: STEP_ID,
        actionHash: ACTION_HASH,
        approvalId: APPROVAL_ID,
        token: APPROVAL_TOKEN,
        leaseId: LEASE_ID,
        killSwitchGeneration: 7,
        consumedAt: NOW,
      },
    ]);
    expect(tunnelCalls[0]).toEqual({
      tunnelId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      method: 'desktop.cua.click',
      requiredPermissionId: PERMISSION_ID,
      signal: abortController.signal,
      params: {
        x: 12,
        y: 24,
        permissionId: PERMISSION_ID,
        automation: {
          lease: currentLease,
          job_id: JOB_ID,
          project_id: PROJECT_ID,
          lease_id: LEASE_ID,
          lease_owner: currentLease.owner,
          action_hash: ACTION_HASH,
          policy_version: POLICY_HASH,
          kill_switch_generation: 7,
          traceparent: TRACEPARENT,
        },
      },
    });
    expect(JSON.stringify(tunnelCalls[0])).not.toContain(APPROVAL_ID);
    expect(JSON.stringify(tunnelCalls[0])).not.toContain(APPROVAL_TOKEN);
  });

  test('blocks stale desktop leases, permission substitution, and unconsumed external effects', async () => {
    let calls = 0;
    const base = {
      now: () => NOW,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => false,
      executeTunnelRpc: async () => {
        calls += 1;
        return { ok: true as const, result: null };
      },
    };
    const request = desktopRequest();
    await expect(
      createDesktopDispatcher({
        ...base,
        isLeaseCurrent: async () => false,
        consumeStepApproval: async () => true,
      }).dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/lease.*current/i);
    await expect(
      createDesktopDispatcher({
        ...base,
        isLeaseCurrent: async () => true,
        consumeStepApproval: async () => true,
      }).dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: '90000000-0000-4000-a000-000000000001',
      }),
    ).rejects.toThrow(/permission/i);

    const externalRequest = desktopRequest({ action: 'desktop.submit', risk: 'external_effect' });
    await expect(
      createDesktopDispatcher({
        ...base,
        isLeaseCurrent: async () => true,
        consumeStepApproval: async () => false,
      }).dispatchStep({
        job: job(externalRequest),
        lease: lease(externalRequest, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      }),
    ).rejects.toThrow(/approval/i);
    expect(calls).toBe(0);
  });

  test('atomically consumes required desktop approvals once and never forwards the credential', async () => {
    const request = desktopRequest({ action: 'desktop.submit', risk: 'external_effect' });
    const consumed = new Set<string>();
    const tunnelInputs: Array<Record<string, unknown>> = [];
    const dispatcher = createDesktopDispatcher({
      now: () => NOW,
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => false,
      consumeStepApproval: async (binding) => {
        const credential = `${binding.approvalId}:${binding.token}`;
        if (consumed.has(credential)) return false;
        consumed.add(credential);
        return true;
      },
      executeTunnelRpc: async (input) => {
        tunnelInputs.push(input);
        return { ok: true, result: 'submitted' };
      },
    });
    const dispatch = () =>
      dispatcher.dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      });

    expect(await dispatch()).toBe('submitted');
    await expect(dispatch()).rejects.toThrow(/approval/i);
    expect(tunnelInputs).toHaveLength(1);
    expect(JSON.stringify(tunnelInputs)).not.toContain(APPROVAL_ID);
    expect(JSON.stringify(tunnelInputs)).not.toContain(APPROVAL_TOKEN);
  });

  test('rejects malformed approval tokens before consumption or Tunnel transport', async () => {
    const request = desktopRequest({ action: 'desktop.submit', risk: 'external_effect' });
    let consumptions = 0;
    let tunnelCalls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => NOW,
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => false,
      consumeStepApproval: async () => {
        consumptions += 1;
        return true;
      },
      executeTunnelRpc: async () => {
        tunnelCalls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: 'x'.repeat(32) },
      }),
    ).rejects.toThrow(/valid approval credential/i);
    expect(consumptions).toBe(0);
    expect(tunnelCalls).toBe(0);
  });

  test('bypasses operate approval only for a current full-access grant with future signed expiry', async () => {
    let calls = 0;
    let grantChecks = 0;
    const create = (grantCurrent: boolean) =>
      createDesktopDispatcher({
        now: () => NOW,
        isLeaseCurrent: async () => true,
        isLeaseSignatureValid: async () => true,
        isFullAccessGrantCurrent: async () => {
          grantChecks += 1;
          return grantCurrent;
        },
        consumeStepApproval: async () => true,
        executeTunnelRpc: async () => {
          calls += 1;
          return { ok: true as const, result: null };
        },
      });
    const fullAccessWithoutExpiry = desktopRequest({ approvalPolicy: 'full-access' });
    await expect(
      create(true).dispatchStep({
        job: job(fullAccessWithoutExpiry),
        lease: lease(fullAccessWithoutExpiry, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/approval/i);

    const fullAccessOperate = desktopRequest({
      approvalPolicy: 'full-access',
      fullAccessExpiresAt: '2099-07-22T08:05:00.000Z',
    });
    await expect(
      create(false).dispatchStep({
        job: job(fullAccessOperate),
        lease: lease(fullAccessOperate, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/approval/i);

    await expect(
      create(true).dispatchStep({
        job: job(fullAccessOperate),
        lease: lease(fullAccessOperate, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      }),
    ).rejects.toThrow(/approval.*not required/i);
    await create(true).dispatchStep({
      job: job(fullAccessOperate),
      lease: lease(fullAccessOperate, PERMISSION_ID),
      stepId: STEP_ID,
      tunnelId: DEVICE_ID,
      permissionId: PERMISSION_ID,
    });

    const fullAccessExternal = desktopRequest({
      action: 'desktop.submit',
      risk: 'external_effect',
      approvalPolicy: 'full-access',
      fullAccessExpiresAt: '2099-07-22T08:05:00.000Z',
    });
    await expect(
      create(true).dispatchStep({
        job: job(fullAccessExternal),
        lease: lease(fullAccessExternal, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/approval/i);
    expect(calls).toBe(1);
    expect(grantChecks).toBe(4);
  });

  test('blocks transport when a full-access grant is revoked after the approval decision', async () => {
    const request = desktopRequest({
      approvalPolicy: 'full-access',
      fullAccessExpiresAt: '2099-07-22T08:05:00.000Z',
    });
    let grantChecks = 0;
    let tunnelCalls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => NOW,
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => {
        grantChecks += 1;
        return grantChecks === 1;
      },
      consumeStepApproval: async () => true,
      executeTunnelRpc: async () => {
        tunnelCalls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/full-access.*current/i);
    expect(grantChecks).toBe(2);
    expect(tunnelCalls).toBe(0);
  });

  test('blocks transport when a full-access grant expires after the approval decision', async () => {
    const request = desktopRequest({
      approvalPolicy: 'full-access',
      fullAccessExpiresAt: '2099-07-22T08:05:00.000Z',
    });
    let nowCalls = 0;
    let grantChecks = 0;
    let tunnelCalls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => {
        nowCalls += 1;
        return nowCalls === 1 ? NOW : new Date('2100-01-01T00:00:00.000Z');
      },
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => {
        grantChecks += 1;
        return true;
      },
      consumeStepApproval: async () => true,
      executeTunnelRpc: async () => {
        tunnelCalls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/full-access.*current/i);
    expect(grantChecks).toBe(1);
    expect(tunnelCalls).toBe(0);
  });

  test('blocks transport when full-access expires after its final repository check', async () => {
    const request = desktopRequest({
      approvalPolicy: 'full-access',
      fullAccessExpiresAt: '2099-07-22T08:04:00.000Z',
    });
    const currentLease = AutomationLeaseSchema.parse({
      ...lease(request, PERMISSION_ID),
      expires_at: '2099-07-22T08:10:00.000Z',
    });
    let nowCalls = 0;
    let tunnelCalls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => {
        nowCalls += 1;
        return nowCalls < 3 ? NOW : new Date('2099-07-22T08:04:01.000Z');
      },
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => true,
      consumeStepApproval: async () => true,
      executeTunnelRpc: async () => {
        tunnelCalls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: currentLease,
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/full-access.*current/i);
    expect(tunnelCalls).toBe(0);
  });

  test('blocks transport when the lease is revoked during the final full-access check', async () => {
    const request = desktopRequest({
      approvalPolicy: 'full-access',
      fullAccessExpiresAt: '2099-07-22T08:05:00.000Z',
    });
    let currentLease = true;
    let grantChecks = 0;
    let tunnelCalls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => NOW,
      isLeaseCurrent: async () => currentLease,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => {
        grantChecks += 1;
        if (grantChecks === 2) currentLease = false;
        return true;
      },
      consumeStepApproval: async () => true,
      executeTunnelRpc: async () => {
        tunnelCalls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
    ).rejects.toThrow(/lease.*current/i);
    expect(grantChecks).toBe(2);
    expect(tunnelCalls).toBe(0);
  });

  test('does not contact Tunnel when async checks cross the job deadline', async () => {
    const request = desktopRequest();
    const currentLease = AutomationLeaseSchema.parse({
      ...lease(request, PERMISSION_ID),
      expires_at: '2099-07-22T08:10:00.000Z',
    });
    let currentTime = NOW;
    let leaseChecks = 0;
    let tunnelCalls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => currentTime,
      isLeaseCurrent: async () => {
        leaseChecks += 1;
        if (leaseChecks === 2) currentTime = new Date('2099-07-22T08:05:01.000Z');
        return true;
      },
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => false,
      consumeStepApproval: async () => true,
      executeTunnelRpc: async () => {
        tunnelCalls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: currentLease,
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      }),
    ).rejects.toThrow(/deadline.*expired/i);
    expect(leaseChecks).toBe(2);
    expect(tunnelCalls).toBe(0);
  });

  test('validates desktop action methods and strict credential shape before consuming a token', async () => {
    const request = desktopRequest();
    const invalidMethodRequest: AutomationJobRequest = {
      ...request,
      steps: request.steps.map((step) => ({
        ...step,
        args: { method: 'desktop.cua.launch_app', params: { app: 'chrome' } },
      })),
    };
    let consumed = 0;
    let calls = 0;
    const dispatcher = createDesktopDispatcher({
      now: () => NOW,
      isLeaseCurrent: async () => true,
      isLeaseSignatureValid: async () => true,
      isFullAccessGrantCurrent: async () => false,
      consumeStepApproval: async () => {
        consumed += 1;
        return true;
      },
      executeTunnelRpc: async () => {
        calls += 1;
        return { ok: true, result: null };
      },
    });

    await expect(
      dispatcher.dispatchStep({
        job: job(invalidMethodRequest),
        lease: lease(invalidMethodRequest, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      }),
    ).rejects.toThrow(/method.*catalog/i);
    await expect(
      dispatcher.dispatchStep({
        job: job(request),
        lease: lease(request, PERMISSION_ID),
        stepId: STEP_ID,
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
        approvalCredential: {
          approvalId: APPROVAL_ID,
          token: APPROVAL_TOKEN,
          unexpected: true,
        } as never,
      }),
    ).rejects.toThrow(/credential/i);
    expect(consumed).toBe(0);
    expect(calls).toBe(0);
  });

  test('rejects desktop signature, generation, tunnel, and post-RPC lease failures', async () => {
    const request = desktopRequest();
    let calls = 0;
    const base = {
      now: () => NOW,
      isFullAccessGrantCurrent: async () => false,
      consumeStepApproval: async () => true,
      executeTunnelRpc: async () => {
        calls += 1;
        return { ok: true as const, result: null };
      },
    };
    const dispatch = (
      dispatcher: ReturnType<typeof createDesktopDispatcher>,
      currentLease = lease(request, PERMISSION_ID),
      tunnelId = DEVICE_ID,
    ) =>
      dispatcher.dispatchStep({
        job: job(request),
        lease: currentLease,
        stepId: STEP_ID,
        tunnelId,
        permissionId: PERMISSION_ID,
        approvalCredential: { approvalId: APPROVAL_ID, token: APPROVAL_TOKEN },
      });

    await expect(
      dispatch(
        createDesktopDispatcher({
          ...base,
          isLeaseCurrent: async () => true,
          isLeaseSignatureValid: async () => false,
        }),
      ),
    ).rejects.toThrow(/signature/i);
    await expect(
      dispatch(
        createDesktopDispatcher({
          ...base,
          isLeaseCurrent: async () => true,
          isLeaseSignatureValid: async () => true,
        }),
        AutomationLeaseSchema.parse({
          ...lease(request, PERMISSION_ID),
          kill_switch_generation: 8,
        }),
      ),
    ).rejects.toThrow(/authority/i);
    await expect(
      dispatch(
        createDesktopDispatcher({
          ...base,
          isLeaseCurrent: async () => true,
          isLeaseSignatureValid: async () => true,
        }),
        lease(request, PERMISSION_ID),
        '71000000-0000-4000-a000-000000000001',
      ),
    ).rejects.toThrow(/tunnel/i);

    let checks = 0;
    await expect(
      dispatch(
        createDesktopDispatcher({
          ...base,
          isLeaseCurrent: async () => {
            checks += 1;
            return checks < 3;
          },
          isLeaseSignatureValid: async () => true,
        }),
      ),
    ).rejects.toThrow(/lease.*current/i);
    expect(calls).toBe(1);
  });

  test('classifies a malformed heartbeat envelope as an invalid Worker payload', async () => {
    const processor = createHeartbeatProcessor({
      authenticator: {} as never,
      isLeaseBindingCurrent: async () => {
        throw new Error('malformed heartbeat must fail before the lease check');
      },
      eventSink: {
        async append() {
          throw new Error('malformed heartbeat must fail before persistence');
        },
      },
    });

    await expect(
      processor.handle({ peer: {} as never, proof: {} as never, heartbeat: {} as never }),
    ).rejects.toMatchObject({ name: 'WorkerHeartbeatError', reason: 'invalid_payload' });
  });

  test('authenticates heartbeat intent, checks the exact lease, and leaves durable sequencing to the sink', async () => {
    const { authenticator, workerPeer } = authentication();
    const currentLease = lease(browserRequest());
    let lastOrdinal = 0;
    const persisted: AutomationEvent[] = [];
    const processor = createHeartbeatProcessor({
      authenticator,
      now: () => NOW,
      isLeaseBindingCurrent: async (binding) =>
        binding.leaseId === LEASE_ID && binding.owner === currentLease.owner,
      eventSink: {
        async append(input) {
          if (input.workerOrdinal !== lastOrdinal + 1) throw new Error('worker ordinal replay');
          lastOrdinal = input.workerOrdinal;
          const event = AutomationEventSchema.parse({
            protocol_version: 'automation.v1',
            event_id: '90000000-0000-4000-a000-000000000001',
            job_id: JOB_ID,
            sequence: 42,
            type: input.event.type,
            status: null,
            payload: input.event.payload,
            trace_id: input.event.trace_id,
            created_at: NOW.toISOString(),
          });
          persisted.push(event);
          return { accepted: true as const, event };
        },
      },
    });
    const heartbeat = {
      protocol_version: 'automation.v1' as const,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: currentLease.owner,
      kill_switch_generation: 0,
      worker_id: 'browser-worker-1',
      ordinal: 1,
      observed_at: NOW.toISOString(),
      event: { type: 'heartbeat' as const, payload: { last_completed_step: 0 }, trace_id: null },
    };
    const proof = authenticator.sign({
      serviceId: 'browser-worker-1',
      certificateFingerprint256: 'BB:WORKER',
      timestamp: NOW,
      nonce: 20,
      body: heartbeat,
    });

    const event = await processor.handle({ peer: workerPeer, proof, heartbeat });

    expect(event.sequence).toBe(42);
    expect(persisted).toHaveLength(1);
  });

  test('rejects a stale heartbeat lease and a replayed worker ordinal before a second durable event', async () => {
    const { authenticator, workerPeer } = authentication();
    let current = false;
    let lastOrdinal = 0;
    let writes = 0;
    const processor = createHeartbeatProcessor({
      authenticator,
      now: () => NOW,
      isLeaseBindingCurrent: async () => current,
      eventSink: {
        async append(input) {
          if (input.workerOrdinal !== lastOrdinal + 1) {
            return { accepted: false as const, reason: 'replayed_ordinal' as const };
          }
          lastOrdinal = input.workerOrdinal;
          writes += 1;
          const event = AutomationEventSchema.parse({
            protocol_version: 'automation.v1',
            event_id: '90000000-0000-4000-a000-000000000002',
            job_id: JOB_ID,
            sequence: writes,
            type: input.event.type,
            status: null,
            payload: input.event.payload,
            trace_id: null,
            created_at: NOW.toISOString(),
          });
          return { accepted: true as const, event };
        },
      },
    });
    const heartbeat = {
      protocol_version: 'automation.v1' as const,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: 'browser-worker:session-1',
      kill_switch_generation: 0,
      worker_id: 'browser-worker-1',
      ordinal: 1,
      observed_at: NOW.toISOString(),
      event: { type: 'heartbeat' as const, payload: { last_completed_step: 0 }, trace_id: null },
    };
    const signed = (nonce: number) =>
      authenticator.sign({
        serviceId: 'browser-worker-1',
        certificateFingerprint256: 'BB:WORKER',
        timestamp: NOW,
        nonce,
        body: heartbeat,
      });

    await expect(
      processor.handle({ peer: workerPeer, proof: signed(30), heartbeat }),
    ).rejects.toThrow(/lease.*current/i);
    expect(writes).toBe(0);

    current = true;
    await processor.handle({ peer: workerPeer, proof: signed(31), heartbeat });
    await expect(
      processor.handle({ peer: workerPeer, proof: signed(32), heartbeat }),
    ).rejects.toThrow(/ordinal.*replay/i);
    expect(writes).toBe(1);
  });

  test('rejects a heartbeat when the atomic sink observes lease revocation after the precheck', async () => {
    const { authenticator, workerPeer } = authentication();
    let appendCalls = 0;
    const processor = createHeartbeatProcessor({
      authenticator,
      now: () => NOW,
      isLeaseBindingCurrent: async () => true,
      eventSink: {
        async append() {
          appendCalls += 1;
          return { accepted: false as const, reason: 'stale_lease' as const };
        },
      },
    });
    const heartbeat = {
      protocol_version: 'automation.v1' as const,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: 'browser-worker:session-1',
      kill_switch_generation: 0,
      worker_id: 'browser-worker-1',
      ordinal: 1,
      observed_at: NOW.toISOString(),
      event: { type: 'job_succeeded' as const, payload: {}, trace_id: null },
    };
    const proof = authenticator.sign({
      serviceId: 'browser-worker-1',
      certificateFingerprint256: 'BB:WORKER',
      timestamp: NOW,
      nonce: 40,
      body: heartbeat,
    });

    await expect(processor.handle({ peer: workerPeer, proof, heartbeat })).rejects.toThrow(
      /lease.*current.*durable/i,
    );
    expect(appendCalls).toBe(1);
  });

  test('accepts only current worker event payloads and rejects control-owned event types', async () => {
    const { authenticator, workerPeer } = authentication();
    let writes = 0;
    const processor = createHeartbeatProcessor({
      authenticator,
      now: () => NOW,
      isLeaseBindingCurrent: async () => true,
      eventSink: {
        async append(input) {
          writes += 1;
          const event = AutomationEventSchema.parse({
            protocol_version: 'automation.v1',
            event_id: '90000000-0000-4000-a000-000000000003',
            job_id: JOB_ID,
            sequence: writes,
            type: input.event.type,
            status: null,
            payload: input.event.payload,
            trace_id: input.event.trace_id,
            created_at: NOW.toISOString(),
          });
          return { accepted: true as const, event };
        },
      },
    });
    const heartbeatFor = (event: { type: string; payload: Record<string, unknown> }) => ({
      protocol_version: 'automation.v1' as const,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: 'browser-worker:session-1',
      kill_switch_generation: 0,
      worker_id: 'browser-worker-1',
      ordinal: writes + 1,
      observed_at: NOW.toISOString(),
      event: { ...event, trace_id: null },
    });
    let nonce = 60;
    const handle = (heartbeat: ReturnType<typeof heartbeatFor>) =>
      processor.handle({
        peer: workerPeer,
        proof: authenticator.sign({
          serviceId: 'browser-worker-1',
          certificateFingerprint256: 'BB:WORKER',
          timestamp: NOW,
          nonce: ++nonce,
          body: heartbeat,
        }),
        heartbeat: heartbeat as never,
      });

    for (const type of ['job_queued', 'job_dispatched']) {
      await expect(handle(heartbeatFor({ type, payload: {} }))).rejects.toThrow(/event.*worker/i);
    }
    await expect(handle(heartbeatFor({ type: 'step_started', payload: {} }))).rejects.toThrow(
      /payload/i,
    );
    await expect(
      handle(heartbeatFor({ type: 'step_completed', payload: { step_id: STEP_ID } })),
    ).rejects.toThrow(/payload/i);
    expect(writes).toBe(0);

    await handle(
      heartbeatFor({
        type: 'step_completed',
        payload: {
          step_id: STEP_ID,
          evidence_reference: 'evidence:90000000-0000-4000-a000-000000000004',
        },
      }),
    );
    expect(writes).toBe(1);

    await expect(
      handle(
        heartbeatFor({
          type: 'step_completed',
          payload: {
            step_id: STEP_ID,
            evidence_reference:
              'https://storage.example/evidence.png?X-Amz-Signature=private-signature',
          },
        }),
      ),
    ).rejects.toThrow(/payload/i);
    expect(writes).toBe(1);
  });

  test('rejects heartbeat secret and signed-URL field variants before persistence', async () => {
    const sensitiveKeys = [
      'access_token',
      'refresh_token',
      'client_secret',
      'session_cookie',
      'apiKey',
      'authorization',
      'cookies',
      'password',
      'secrets',
      'tokens',
      'signed_url',
      'presigned_url',
    ];

    for (const [index, key] of sensitiveKeys.entries()) {
      const { authenticator, workerPeer } = authentication();
      let writes = 0;
      const processor = createHeartbeatProcessor({
        authenticator,
        now: () => NOW,
        isLeaseBindingCurrent: async () => true,
        eventSink: {
          async append() {
            writes += 1;
            throw new Error('sensitive heartbeat reached persistence');
          },
        },
      });
      const heartbeat = {
        protocol_version: 'automation.v1' as const,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        job_id: JOB_ID,
        lease_id: LEASE_ID,
        lease_owner: 'browser-worker:session-1',
        kill_switch_generation: 0,
        worker_id: 'browser-worker-1',
        ordinal: 1,
        observed_at: NOW.toISOString(),
        event: {
          type: 'heartbeat' as const,
          payload: { last_completed_step: 0, nested: { [key]: `private-${index}` } },
          trace_id: null,
        },
      };
      const proof = authenticator.sign({
        serviceId: 'browser-worker-1',
        certificateFingerprint256: 'BB:WORKER',
        timestamp: NOW,
        nonce: 80 + index,
        body: heartbeat,
      });

      await expect(
        processor.handle({ peer: workerPeer, proof, heartbeat: heartbeat as never }),
      ).rejects.toThrow(/sensitive/i);
      expect(writes).toBe(0);
    }
  });
});
