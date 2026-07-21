import { describe, expect, test } from 'bun:test';
import type { AutomationJobRequest } from '@kortix/intelligence-contracts';
import {
  type AutomationActor,
  AutomationEventStatusMismatchError,
  AutomationEventTransitionMismatchError,
  AutomationIdempotencyConflictError,
  AutomationLeaseExpiredError,
  canonicalAutomationRequestHash,
  createMemoryAutomationRepository,
} from './repository';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_TIME = new Date('2026-07-22T01:00:00.000Z');

const ACTOR: AutomationActor = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  userId: USER_ID,
  roles: ['member'],
  deviceId: null,
};

const REQUEST: AutomationJobRequest = {
  protocol_version: 'automation.v1',
  tenant_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  source_run_id: null,
  execution_domain: 'browser',
  steps: [
    {
      step_id: '40000000-0000-4000-a000-000000000001',
      sequence: 1,
      action: 'browser.read',
      args: { selector: '#result', includeText: true },
      risk: 'observe',
      action_hash: `sha256:${'a'.repeat(64)}`,
    },
  ],
  capability_requirements: [
    {
      capability: 'browser.page',
      methods: ['read'],
      scope: { origin: 'https://example.com' },
    },
  ],
  approval_policy: 'project-default',
  browser_policy: {
    allowed_origins: ['https://example.com'],
    network_mode: 'allowlist',
    open_network_expires_at: null,
    context: { mode: 'temporary', profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'automation-request-0001',
  deadline_at: '2030-07-22T02:00:00.000Z',
  traceparent: null,
};

function createRepository() {
  return createMemoryAutomationRepository({ now: () => new Date(JOB_TIME) });
}

describe('automation repository', () => {
  test('hashes semantically identical requests canonically', () => {
    const reordered: AutomationJobRequest = {
      ...REQUEST,
      steps: [
        {
          ...REQUEST.steps[0],
          args: { includeText: true, selector: '#result' },
        },
      ],
    };

    expect(canonicalAutomationRequestHash(reordered)).toBe(canonicalAutomationRequestHash(REQUEST));
  });

  test('returns the original job for a matching project idempotency key and request hash', async () => {
    const repository = createRepository();

    const first = await repository.createJob(REQUEST, ACTOR);
    const replay = await repository.createJob(REQUEST, ACTOR);

    expect(first.created).toBeTrue();
    expect(replay.created).toBeFalse();
    expect(replay.job.job_id).toBe(first.job.job_id);
    expect(replay.job.request_hash).toBe(first.job.request_hash);
  });

  test('rejects reuse of an idempotency key for a different request hash', async () => {
    const repository = createRepository();
    await repository.createJob(REQUEST, ACTOR);
    const changedRequest: AutomationJobRequest = {
      ...REQUEST,
      steps: [
        {
          ...REQUEST.steps[0],
          args: { selector: '#different-result', includeText: true },
        },
      ],
    };

    const conflict = repository.createJob(changedRequest, ACTOR);

    await expect(conflict).rejects.toBeInstanceOf(AutomationIdempotencyConflictError);
    await expect(conflict).rejects.toMatchObject({ code: 'AUTOMATION_CONFLICT' });
  });

  test('appends monotonic events and leaves state unchanged when an event transaction fails', async () => {
    const repository = createRepository();
    const { job } = await repository.createJob(REQUEST, ACTOR);
    const common = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: job.job_id,
      leaseOwner: null,
      killSwitchGeneration: 0,
      occurredAt: new Date('2026-07-22T01:01:00.000Z'),
    } as const;

    const approvalRequired = await repository.appendEvent({
      ...common,
      event: {
        protocol_version: 'automation.v1',
        type: 'approval_required',
        status: 'awaiting_approval',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'approval_required' },
    });
    const dispatched = await repository.appendEvent({
      ...common,
      event: {
        protocol_version: 'automation.v1',
        type: 'job_dispatched',
        status: 'dispatched',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'approval_granted' },
    });

    expect(approvalRequired.sequence).toBe(2);
    expect(dispatched.sequence).toBe(3);

    const invalidEvent = repository.appendEvent({
      ...common,
      event: {
        protocol_version: 'automation.v1',
        type: 'job_cancelled',
        status: 'failed',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'cancelled' },
    });
    await expect(invalidEvent).rejects.toBeInstanceOf(AutomationEventStatusMismatchError);

    const unchanged = await repository.getJobForProject(ACCOUNT_ID, PROJECT_ID, job.job_id);
    expect(unchanged?.status).toBe('dispatched');

    const cancelled = await repository.appendEvent({
      ...common,
      event: {
        protocol_version: 'automation.v1',
        type: 'job_cancelled',
        status: 'cancelled',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'cancelled' },
    });
    expect(cancelled.sequence).toBe(4);
    expect((await repository.getJobForProject(ACCOUNT_ID, PROJECT_ID, job.job_id))?.status).toBe(
      'cancelled',
    );
  });

  test('requires a current worker lease for execution events', async () => {
    const repository = createRepository();
    const { job } = await repository.createJob(REQUEST, ACTOR);
    const common = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: job.job_id,
      leaseOwner: null,
      killSwitchGeneration: 0,
      occurredAt: new Date('2026-07-22T01:01:00.000Z'),
    } as const;
    await repository.appendEvent({
      ...common,
      event: {
        protocol_version: 'automation.v1',
        type: 'job_dispatched',
        status: 'dispatched',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'dispatched' },
    });

    const bypass = repository.appendEvent({
      ...common,
      event: {
        protocol_version: 'automation.v1',
        type: 'job_started',
        status: 'running',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'started' },
    });

    await expect(bypass).rejects.toBeInstanceOf(AutomationLeaseExpiredError);
    expect((await repository.getJobForProject(ACCOUNT_ID, PROJECT_ID, job.job_id))?.status).toBe(
      'dispatched',
    );
  });

  test('rejects an audit event type that does not describe its state transition', async () => {
    const repository = createRepository();
    const { job } = await repository.createJob(REQUEST, ACTOR);

    const invalidEvent = repository.appendEvent({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: job.job_id,
      leaseOwner: null,
      killSwitchGeneration: 0,
      event: {
        protocol_version: 'automation.v1',
        type: 'job_cancelled',
        status: 'awaiting_approval',
        payload: {},
        trace_id: null,
      },
      transition: { type: 'approval_required' },
      occurredAt: new Date('2026-07-22T01:01:00.000Z'),
    });

    await expect(invalidEvent).rejects.toBeInstanceOf(AutomationEventTransitionMismatchError);
    expect((await repository.getJobForProject(ACCOUNT_ID, PROJECT_ID, job.job_id))?.status).toBe(
      'queued',
    );
  });

  test('keeps reads project-scoped and makes cancellation idempotent', async () => {
    const repository = createRepository();
    const { job } = await repository.createJob(REQUEST, ACTOR);

    expect(
      await repository.getJobForProject(
        '10000000-0000-4000-a000-000000000099',
        PROJECT_ID,
        job.job_id,
      ),
    ).toBeNull();

    const cancelled = await repository.requestCancellation(
      ACCOUNT_ID,
      PROJECT_ID,
      job.job_id,
      USER_ID,
    );
    const replay = await repository.requestCancellation(
      ACCOUNT_ID,
      PROJECT_ID,
      job.job_id,
      USER_ID,
    );

    expect(cancelled.status).toBe('cancelled');
    expect(replay).toEqual(cancelled);
  });
});
