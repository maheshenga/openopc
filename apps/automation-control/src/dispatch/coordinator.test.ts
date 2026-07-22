import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AutomationEvent,
  type AutomationJob,
  AutomationJobRequestSchema,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { materializeAutomationEvent } from '../event-store';
import type { AppendAutomationEventInput, AutomationRepository } from '../repository';
import { transitionAutomationJob } from '../state-machine';
import {
  createAutomationDispatchCoordinator,
  resolveDeclaredDesktopPermission,
} from './coordinator';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const LEASE_ID = '60000000-0000-4000-a000-000000000001';
const DEVICE_ID = '70000000-0000-4000-a000-000000000001';
const PERMISSION_ID = '80000000-0000-4000-a000-000000000001';
const NOW = new Date('2099-07-22T08:00:00.000Z');

function desktopRequest() {
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
        action: 'desktop.read_screen',
        args: { method: 'desktop.cua.get_screen_size', params: {} },
        risk: 'observe',
        action_hash: `sha256:${'a'.repeat(64)}`,
      },
    ],
    capability_requirements: [
      {
        capability: 'desktop',
        methods: ['read_screen'],
        scope: { device_id: DEVICE_ID, permission_id: PERMISSION_ID },
      },
    ],
    approval_policy: 'project-default',
    browser_policy: null,
    desktop_policy: {
      device_id: DEVICE_ID,
      allowed_applications: ['desktop'],
      full_access_expires_at: null,
      kill_switch_generation: 0,
    },
    idempotency_key: 'coordinator-desktop-0001',
    deadline_at: '2099-07-22T08:05:00.000Z',
    traceparent: null,
  });
}

function requestHash(request: ReturnType<typeof desktopRequest>): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(request))
    .digest('hex')}`;
}

function desktopJob(): AutomationJob {
  const request = desktopRequest();
  return AutomationJobSchema.parse({
    job_id: JOB_ID,
    account_id: ACCOUNT_ID,
    actor_user_id: USER_ID,
    request,
    request_hash: requestHash(request),
    // The lease claim atomically moves a durable job to dispatched before the
    // coordinator writes the worker-owned started event.
    status: 'dispatched',
    policy_version: '1',
    kill_switch_generation: 0,
    created_at: '2099-07-22T07:59:00.000Z',
    updated_at: '2099-07-22T07:59:00.000Z',
    terminal_at: null,
  });
}

function desktopLease(job: AutomationJob): AutomationLease {
  return AutomationLeaseSchema.parse({
    lease_id: LEASE_ID,
    job_id: job.job_id,
    project_id: job.request.project_id,
    execution_domain: 'desktop',
    owner: 'automation-control:lease-1',
    permission_id: PERMISSION_ID,
    request_hash: job.request_hash,
    kill_switch_generation: job.kill_switch_generation,
    issued_at: '2099-07-22T07:59:30.000Z',
    expires_at: '2099-07-22T08:01:00.000Z',
    signature: `hmac-sha256:${'b'.repeat(64)}`,
  });
}

function createRepository(job: AutomationJob) {
  let current = structuredClone(job);
  const appended: AppendAutomationEventInput[] = [];
  const repository: AutomationRepository = {
    async createJob() {
      throw new Error('not used');
    },
    async getJobForProject(accountId, projectId, jobId) {
      if (accountId !== ACCOUNT_ID || projectId !== PROJECT_ID || jobId !== JOB_ID) {
        return null;
      }
      return structuredClone(current);
    },
    async listDispatchCandidates() {
      return [];
    },
    async appendEvent(input) {
      appended.push(input);
      if (input.transition !== null) {
        const nextStatus = transitionAutomationJob(current.status, input.transition);
        current = {
          ...current,
          status: nextStatus,
          updated_at: input.occurredAt.toISOString(),
          terminal_at: ['succeeded', 'failed', 'cancelled', 'expired'].includes(nextStatus)
            ? input.occurredAt.toISOString()
            : null,
        };
      }
      return materializeAutomationEvent(input, appended.length);
    },
    async requestCancellation() {
      throw new Error('not used');
    },
  };
  return {
    repository,
    appended,
    getCurrent: () => structuredClone(current),
    setStatus: (status: AutomationJob['status']) => {
      current = { ...current, status };
    },
  };
}

function createLeaseManager(lease: AutomationLease, current = true, onClaim?: () => void) {
  const calls = {
    claim: [] as unknown[],
    isCurrent: 0,
    release: 0,
  };
  let leaseCurrent = current;
  return {
    calls,
    setCurrent(value: boolean) {
      leaseCurrent = value;
    },
    manager: {
      async claim(...args: unknown[]) {
        calls.claim.push(args);
        onClaim?.();
        return lease;
      },
      async heartbeat() {
        return leaseCurrent;
      },
      async release() {
        calls.release += 1;
      },
      async isCurrent() {
        calls.isCurrent += 1;
        return leaseCurrent;
      },
    },
  };
}

describe('automation dispatch coordinator', () => {
  test('resolves only the permission explicitly declared by the signed desktop job', async () => {
    const job = desktopJob();

    expect(
      await resolveDeclaredDesktopPermission({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        method: 'desktop.cua.get_screen_size',
        job,
        now: NOW,
      }),
    ).toEqual({ tunnelId: DEVICE_ID, permissionId: PERMISSION_ID });
    expect(
      await resolveDeclaredDesktopPermission({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        deviceId: '70000000-0000-4000-a000-000000000099',
        method: 'desktop.cua.get_screen_size',
        job,
        now: NOW,
      }),
    ).toBeNull();
  });

  test('claims a permission-bound lease, persists lifecycle events, and dispatches the observe step', async () => {
    const job = desktopJob();
    const lease = desktopLease(job);
    const { repository, appended, getCurrent, setStatus } = createRepository(job);
    const leaseState = createLeaseManager(lease, true, () => setStatus('dispatched'));
    const dispatched: unknown[] = [];
    const coordinator = createAutomationDispatchCoordinator({
      repository,
      leaseManager: leaseState.manager,
      now: () => NOW,
      leaseMs: 30_000,
      resolveDesktopPermission: async () => ({
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
      desktopDispatcher: {
        async dispatchStep(input) {
          dispatched.push(input);
          return { width: 1920, height: 1080 };
        },
      },
    });

    const result = await coordinator.dispatchDesktopStep({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      owner: 'automation-control',
    });

    expect(result).toEqual({
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      status: 'succeeded',
      result: { width: 1920, height: 1080 },
    });
    expect(leaseState.calls.claim).toEqual([
      [JOB_ID, 'automation-control', NOW, 30_000, PERMISSION_ID],
    ]);
    expect(appended.map((event) => event.event.type)).toEqual([
      'job_started',
      'step_started',
      'step_completed',
      'job_succeeded',
    ]);
    expect(appended.every((event) => event.leaseOwner === lease.owner)).toBeTrue();
    expect((dispatched[0] as { job: AutomationJob }).job.status).toBe('running');
    expect((dispatched[0] as { permissionId: string }).permissionId).toBe(PERMISSION_ID);
    expect(getCurrent().status).toBe('succeeded');
    expect(leaseState.calls.release).toBe(1);
  });

  test('does not invoke the desktop dispatcher when the claimed lease is no longer current', async () => {
    const job = desktopJob();
    const lease = desktopLease(job);
    const { repository, appended } = createRepository(job);
    const leaseState = createLeaseManager(lease, false);
    let dispatchCalls = 0;
    const coordinator = createAutomationDispatchCoordinator({
      repository,
      leaseManager: leaseState.manager,
      now: () => NOW,
      leaseMs: 30_000,
      resolveDesktopPermission: async () => ({
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
      desktopDispatcher: {
        async dispatchStep() {
          dispatchCalls += 1;
          return null;
        },
      },
    });

    await expect(
      coordinator.dispatchDesktopStep({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        stepId: STEP_ID,
        owner: 'automation-control',
      }),
    ).rejects.toThrow(/lease/i);
    expect(dispatchCalls).toBe(0);
    expect(appended).toHaveLength(0);
  });

  test('marks the result unknown once execution crosses the dispatcher boundary', async () => {
    const job = desktopJob();
    const lease = desktopLease(job);
    const { repository, appended, setStatus } = createRepository(job);
    const leaseState = createLeaseManager(lease, true, () => setStatus('dispatched'));
    const coordinator = createAutomationDispatchCoordinator({
      repository,
      leaseManager: leaseState.manager,
      now: () => NOW,
      leaseMs: 30_000,
      resolveDesktopPermission: async () => ({
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
      desktopDispatcher: {
        async dispatchStep() {
          throw new Error('private provider response');
        },
      },
    });

    await expect(
      coordinator.dispatchDesktopStep({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        stepId: STEP_ID,
        owner: 'automation-control',
      }),
    ).rejects.toThrow('private provider response');

    const failed = appended.find((event) => event.event.type === 'job_failed');
    expect(failed?.event.payload).toMatchObject({
      result_unknown: true,
      external_effect_committed: false,
    });
    expect(JSON.stringify(failed)).not.toContain('private provider response');
  });

  test('discovers and claims one bounded desktop observe candidate in runOnce', async () => {
    const candidate = AutomationJobSchema.parse({ ...desktopJob(), status: 'queued' });
    const lease = desktopLease(candidate);
    const { repository, getCurrent, setStatus } = createRepository(candidate);
    const leaseState = createLeaseManager(lease, true, () => setStatus('dispatched'));
    let dispatchCalls = 0;
    let dispatchSignal: AbortSignal | undefined;
    const abortController = new AbortController();
    const coordinator = createAutomationDispatchCoordinator({
      repository,
      leaseManager: leaseState.manager,
      now: () => NOW,
      leaseMs: 30_000,
      owner: 'automation-control',
      maxClaimsPerRun: 4,
      listDesktopCandidates: async (input) => {
        expect(input).toEqual({ now: NOW, limit: 4 });
        return [candidate];
      },
      resolveDesktopPermission: async () => ({
        tunnelId: DEVICE_ID,
        permissionId: PERMISSION_ID,
      }),
      desktopDispatcher: {
        async dispatchStep(input) {
          dispatchCalls += 1;
          dispatchSignal = input.signal;
          return { width: 1920, height: 1080 };
        },
      },
    });

    expect(await coordinator.runOnce({ signal: abortController.signal })).toEqual({
      candidates: 1,
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(dispatchCalls).toBe(1);
    expect(dispatchSignal).toBe(abortController.signal);
    expect(getCurrent().status).toBe('succeeded');
  });
});
