import { describe, expect, test } from 'bun:test';
import type {
  AutomationApproval,
  AutomationEvent,
  AutomationJobRequest,
} from '@kortix/intelligence-contracts';
import { type InternalAutomationActor, createInternalServiceHeaders } from '../internal-auth';
import { createMemoryAutomationRepository } from '../repository';
import { createAutomationRoutes } from './index';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000099';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const STEP_ID = '40000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '50000000-0000-4000-a000-000000000001';
const PROFILE_ID = '70000000-0000-4000-a000-000000000001';
const SERVICE_ID = 'kortix-api';
const SHARED_SECRET = 'test-shared-secret-at-least-thirty-two-characters';
const NOW = new Date('2026-07-22T10:00:00.000Z');

const ACTOR: InternalAutomationActor = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  userId: USER_ID,
  roles: ['project_admin'],
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
      step_id: STEP_ID,
      sequence: 1,
      action: 'browser.read',
      args: {},
      risk: 'observe',
      action_hash: `sha256:${'a'.repeat(64)}`,
    },
  ],
  capability_requirements: [{ capability: 'browser.page', methods: ['read'], scope: {} }],
  approval_policy: 'project-default',
  browser_policy: {
    allowed_origins: ['https://app.example.com'],
    network_mode: 'allowlist',
    open_network_expires_at: null,
    context: { mode: 'temporary', profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'automation-route-idempotency-0001',
  deadline_at: '2030-07-22T11:00:00.000Z',
  traceparent: null,
};

function signedRequest(
  path: string,
  init: RequestInit = {},
  input?: { actor?: InternalAutomationActor; timestamp?: Date; secret?: string },
): Request {
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? init.body : '';
  const headers = createInternalServiceHeaders({
    serviceId: SERVICE_ID,
    sharedSecret: input?.secret ?? SHARED_SECRET,
    timestamp: input?.timestamp ?? NOW,
    method,
    path,
    body,
    actor: input?.actor ?? ACTOR,
  });
  return new Request(`http://automation.local${path}`, {
    ...init,
    method,
    body: body || undefined,
    headers: { 'content-type': 'application/json', ...headers, ...init.headers },
  });
}

function createTestApp(
  events: readonly AutomationEvent[] = [],
  options?: {
    eventReader?: {
      listAfter(input: {
        accountId: string;
        projectId: string;
        jobId: string;
        cursor: number;
        limit: number;
      }): Promise<readonly AutomationEvent[]>;
    };
    eventStream?: Record<string, unknown>;
    approvalResolveError?: Error & { code?: string };
  },
) {
  const repository = createMemoryAutomationRepository();
  const approvals: AutomationApproval[] = [
    {
      approval_id: APPROVAL_ID,
      job_id: '60000000-0000-4000-a000-000000000001',
      step_id: STEP_ID,
      project_id: PROJECT_ID,
      action_hash: `sha256:${'a'.repeat(64)}`,
      status: 'pending',
      acting_user_id: null,
      expires_at: '2030-07-22T11:00:00.000Z',
      resolved_at: null,
    },
  ];
  const profiles: Array<{
    profile_id: string;
    project_id: string;
    encrypted_state_ref: string;
    state_hash: string;
    status: 'active' | 'revoked' | 'expired';
    created_by: string;
    last_used_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
    updated_at: string;
  }> = [
    {
      profile_id: PROFILE_ID,
      project_id: PROJECT_ID,
      encrypted_state_ref: 'sealed:vault/profile-1',
      state_hash: `sha256:${'b'.repeat(64)}`,
      status: 'active',
      created_by: USER_ID,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  ];
  let policy = {
    project_id: PROJECT_ID,
    allowed_origins: ['https://app.example.com'],
    open_network_allowed: false,
    persistent_profiles_allowed: false,
    full_access_allowed: false,
    default_approval_policy: 'project-default' as const,
    policy_version: '1',
    updated_by: USER_ID,
    updated_at: NOW.toISOString(),
  };
  const killSwitchCalls: unknown[] = [];
  const dependencies = {
    auth: {
      sharedSecret: SHARED_SECRET,
      allowedServiceIds: [SERVICE_ID],
      now: () => NOW,
    },
    repository,
    eventReader: options?.eventReader ?? {
      async listAfter(input: { jobId: string; cursor: number; limit: number }) {
        return events
          .filter((event) => event.job_id === input.jobId && event.sequence > input.cursor)
          .slice(0, input.limit);
      },
    },
    eventStream: options?.eventStream,
    approvalStore: {
      async list(input: { accountId: string; projectId: string; status: string }) {
        return input.accountId === ACCOUNT_ID && input.projectId === PROJECT_ID
          ? approvals.filter((approval) => approval.status === input.status)
          : [];
      },
      async resolve(input: Record<string, unknown>) {
        if (options?.approvalResolveError) throw options.approvalResolveError;
        const approval = approvals.find((entry) => entry.approval_id === input.approvalId);
        if (!approval || input.accountId !== ACCOUNT_ID || input.projectId !== PROJECT_ID) {
          const error = new Error('Approval was not found') as Error & { code: string };
          error.code = 'AUTOMATION_NOT_FOUND';
          throw error;
        }
        approval.status = input.decision === 'approve' ? 'approved' : 'rejected';
        approval.acting_user_id = String(input.actorUserId);
        approval.resolved_at = NOW.toISOString();
        return input.decision === 'approve'
          ? {
              token: `approval.v1.${'a'.repeat(43)}`,
              approvalId: approval.approval_id,
              projectId: PROJECT_ID,
              actionHash: approval.action_hash,
              expiresAt: approval.expires_at,
            }
          : null;
      },
    },
    profileStore: {
      async list(input: { accountId: string; projectId: string }) {
        return input.accountId === ACCOUNT_ID && input.projectId === PROJECT_ID ? profiles : [];
      },
      async create(input: Record<string, unknown>) {
        const profile = {
          ...profiles[0],
          profile_id: PROFILE_ID,
          encrypted_state_ref: input.encryptedStateRef as string,
          state_hash: input.stateHash as `sha256:${string}`,
          created_by: input.actorUserId as string,
        };
        profiles.splice(0, profiles.length, profile);
        return profile;
      },
      async revoke(input: { accountId: string; projectId: string; profileId: string }) {
        const profile = profiles.find((entry) => entry.profile_id === input.profileId);
        if (!profile || input.accountId !== ACCOUNT_ID || input.projectId !== PROJECT_ID)
          return null;
        profile.status = 'revoked';
        profile.revoked_at = NOW.toISOString();
        return profile;
      },
    },
    policyStore: {
      async get(input: { accountId: string; projectId: string }) {
        return input.accountId === ACCOUNT_ID && input.projectId === PROJECT_ID ? policy : null;
      },
      async put(input: Record<string, unknown>) {
        policy = {
          ...policy,
          ...(input.value as typeof policy),
          project_id: PROJECT_ID,
          policy_version: '2',
          updated_by: USER_ID,
        };
        return policy;
      },
    },
    killSwitchService: {
      async activate(scope: unknown, actor: unknown) {
        killSwitchCalls.push({ scope, actor });
        return {
          generation: 4,
          auditEventId: '80000000-0000-4000-a000-000000000001',
        };
      },
      async current() {
        return 4;
      },
    },
  };
  const app = createAutomationRoutes(
    dependencies as unknown as Parameters<typeof createAutomationRoutes>[0],
  );
  return { app, repository, approvals, profiles, getPolicy: () => policy, killSwitchCalls };
}

describe('internal automation routes', () => {
  test('rejects missing, invalid, and expired service signatures', async () => {
    const { app } = createTestApp();
    const path = '/v1/automation/jobs';

    expect((await app.request(path)).status).toBe(401);
    expect(
      (
        await app.fetch(
          signedRequest(path, {}, { secret: 'wrong-secret-that-is-still-long-enough-for-tests' }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          signedRequest(path, {}, { timestamp: new Date('2026-07-22T09:58:59.000Z') }),
        )
      ).status,
    ).toBe(401);
  });

  test('rejects a signed job body that does not satisfy the wire schema', async () => {
    const { app } = createTestApp();
    const path = '/v1/automation/jobs';
    const response = await app.fetch(
      signedRequest(path, { method: 'POST', body: JSON.stringify({ project_id: PROJECT_ID }) }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'AUTOMATION_INVALID_REQUEST' });
  });

  test('returns the original job for an identical project idempotency request', async () => {
    const { app } = createTestApp();
    const path = '/v1/automation/jobs';
    const body = JSON.stringify(REQUEST);

    const first = await app.fetch(signedRequest(path, { method: 'POST', body }));
    const second = await app.fetch(signedRequest(path, { method: 'POST', body }));
    const firstPayload = (await first.json()) as { job: { job_id: string }; created: boolean };
    const secondPayload = (await second.json()) as { job: { job_id: string }; created: boolean };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(firstPayload.created).toBe(true);
    expect(secondPayload).toEqual({ job: firstPayload.job, created: false });
  });

  test('returns not found instead of leaking a job across project scope', async () => {
    const { app } = createTestApp();
    const body = JSON.stringify(REQUEST);
    const created = await app.fetch(signedRequest('/v1/automation/jobs', { method: 'POST', body }));
    const payload = (await created.json()) as { job: { job_id: string } };
    const otherActor = { ...ACTOR, projectId: OTHER_PROJECT_ID };

    const response = await app.fetch(
      signedRequest(`/v1/automation/jobs/${payload.job.job_id}`, {}, { actor: otherActor }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'AUTOMATION_NOT_FOUND' });
  });

  test('streams events after the cursor in sequence without private payloads', async () => {
    const events: AutomationEvent[] = [];
    const { app, repository } = createTestApp(events);
    const { job } = await repository.createJob(
      { ...REQUEST, idempotency_key: 'automation-route-events-0001' },
      ACTOR,
    );
    events.push(
      {
        protocol_version: 'automation.v1',
        event_id: '60000000-0000-4000-a000-000000000003',
        job_id: job.job_id,
        sequence: 3,
        type: 'job_succeeded',
        status: 'succeeded',
        payload: { result_ref: 'asset:public-result' },
        trace_id: null,
        created_at: '2026-07-22T10:00:03.000Z',
      },
      {
        protocol_version: 'automation.v1',
        event_id: '60000000-0000-4000-a000-000000000002',
        job_id: job.job_id,
        sequence: 2,
        type: 'step_started',
        status: 'running',
        payload: {
          worker_url: 'https://worker.internal/private',
          credential_ref: 'credential-ref:00000000-0000-4000-8000-000000000123',
          internal_error: { stack: 'private stack' },
        },
        trace_id: null,
        created_at: '2026-07-22T10:00:02.000Z',
      },
    );

    const response = await app.fetch(
      signedRequest(`/v1/automation/jobs/${job.job_id}/events?cursor=1`),
    );
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.indexOf('id: 2')).toBeLessThan(stream.indexOf('id: 3'));
    expect(stream).toContain('asset:public-result');
    expect(stream).not.toContain('worker.internal');
    expect(stream).not.toContain('credential-ref:');
    expect(stream).not.toContain('private stack');
  });

  test('polls for later events and closes the stream after a terminal event', async () => {
    let polls = 0;
    let jobId = '';
    let clock = NOW.getTime();
    const terminalEvent = (): AutomationEvent => ({
      protocol_version: 'automation.v1',
      event_id: '60000000-0000-4000-a000-000000000010',
      job_id: jobId,
      sequence: 2,
      type: 'job_succeeded',
      status: 'succeeded',
      payload: { result_ref: 'asset:later-result' },
      trace_id: null,
      created_at: '2026-07-22T10:00:02.000Z',
    });
    const { app, repository } = createTestApp([], {
      eventReader: {
        async listAfter() {
          polls += 1;
          return polls === 1 ? [] : [terminalEvent()];
        },
      },
      eventStream: {
        pollIntervalMs: 1,
        heartbeatIntervalMs: 1,
        maxStreamMs: 100,
        now: () => clock,
        sleep: async (duration: number) => {
          clock += duration;
        },
      },
    });
    const created = await repository.createJob(
      { ...REQUEST, idempotency_key: 'automation-route-events-later-0001' },
      ACTOR,
    );
    jobId = created.job.job_id;

    const response = await app.fetch(signedRequest(`/v1/automation/jobs/${jobId}/events?cursor=1`));
    const stream = await response.text();

    expect(polls).toBe(2);
    expect(stream).toContain('asset:later-result');
    expect(stream).toContain('id: 2');
  });

  test('lists and resolves only approvals in the signed project scope', async () => {
    const { app, approvals } = createTestApp();
    const listed = await app.fetch(signedRequest('/v1/automation/approvals?status=pending'));
    const listedPayload = await listed.json();
    const pendingSnapshot = structuredClone(approvals);
    const resolved = await app.fetch(
      signedRequest(`/v1/automation/approvals/${APPROVAL_ID}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approve',
          action_hash: `sha256:${'a'.repeat(64)}`,
        }),
      }),
    );
    const resolvedPayload = await resolved.json();

    expect(listed.status).toBe(200);
    expect(listedPayload).toEqual({ approvals: pendingSnapshot });
    expect(resolved.status).toBe(200);
    expect(resolvedPayload).toMatchObject({
      approval_id: APPROVAL_ID,
      status: 'approved',
      token: expect.stringMatching(/^approval\.v1\.[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(resolvedPayload)).not.toContain('approval-resume.v1.');
    expect(resolvedPayload).not.toHaveProperty('approval_resume');
    expect(JSON.stringify(listedPayload)).not.toContain('approval-resume.v1.');
  });

  test('normalizes unknown service errors without leaking internal details', async () => {
    const error = new Error('private database host and stack') as Error & { code: string };
    error.code = 'AUTOMATION_PRIVATE_DATABASE_FAILURE';
    const { app } = createTestApp([], { approvalResolveError: error });
    const response = await app.fetch(
      signedRequest(`/v1/automation/approvals/${APPROVAL_ID}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approve',
          action_hash: `sha256:${'a'.repeat(64)}`,
        }),
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain('private database');
    expect(JSON.parse(body)).toMatchObject({ code: 'AUTOMATION_INTERNAL' });
  });

  test('creates browser profiles without returning encrypted state references', async () => {
    const { app } = createTestApp();
    const response = await app.fetch(
      signedRequest('/v1/automation/browser-profiles', {
        method: 'POST',
        body: JSON.stringify({
          encrypted_state_ref: 'sealed:vault/new-profile',
          state_hash: `sha256:${'c'.repeat(64)}`,
          expires_at: null,
        }),
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(201);
    expect(body).not.toContain('sealed:');
    expect(JSON.parse(body)).toMatchObject({ profile_id: PROFILE_ID, status: 'active' });
  });

  test('reads and updates project-scoped automation policy', async () => {
    const { app } = createTestApp();
    const read = await app.fetch(signedRequest('/v1/automation/policies'));
    const updated = await app.fetch(
      signedRequest('/v1/automation/policies', {
        method: 'PUT',
        body: JSON.stringify({
          allowed_origins: ['https://console.example.com'],
          open_network_allowed: false,
          persistent_profiles_allowed: true,
          full_access_allowed: false,
          default_approval_policy: 'project-default',
          expected_policy_version: '1',
        }),
      }),
    );

    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ project_id: PROJECT_ID, policy_version: '1' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      project_id: PROJECT_ID,
      persistent_profiles_allowed: true,
      policy_version: '2',
    });
  });

  test('binds a project kill switch to the signed actor scope', async () => {
    const { app, killSwitchCalls } = createTestApp();
    const response = await app.fetch(
      signedRequest('/v1/automation/kill-switch', {
        method: 'POST',
        body: JSON.stringify({ scope: { kind: 'project' } }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generation: 4,
      audit_event_id: '80000000-0000-4000-a000-000000000001',
    });
    expect(killSwitchCalls).toEqual([
      {
        scope: { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_ID },
        actor: ACTOR,
      },
    ]);
  });
});
