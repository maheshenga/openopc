import { describe, expect, test } from 'bun:test';
import {
  type AutomationJob,
  type AutomationJobRequest,
  AutomationJobSchema,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type AutomationApiDependencies, createAutomationApiApp } from './index';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000099';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const TRACEPARENT = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
const APPROVAL_ID = '60000000-0000-4000-a000-000000000001';
const PROFILE_ID = '70000000-0000-4000-a000-000000000001';

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
  idempotency_key: 'api-route-idempotency-0001',
  deadline_at: '2030-07-22T11:00:00.000Z',
  traceparent: TRACEPARENT,
};

const JOB: AutomationJob = AutomationJobSchema.parse({
  job_id: JOB_ID,
  account_id: ACCOUNT_ID,
  actor_user_id: USER_ID,
  request: REQUEST,
  request_hash: `sha256:${'b'.repeat(64)}`,
  status: 'queued',
  policy_version: `sha256:${'c'.repeat(64)}`,
  kill_switch_generation: 0,
  created_at: '2026-07-22T10:00:00.000Z',
  updated_at: '2026-07-22T10:00:00.000Z',
  terminal_at: null,
});

function createTestApp(options?: {
  enabled?: boolean;
  denyProject?: boolean;
  projectMissing?: boolean;
  controlStatus?: number;
}) {
  const calls: unknown[] = [];
  const authenticate: MiddlewareHandler = async (context, next) => {
    if (context.req.header('authorization') !== 'Bearer valid') {
      return context.json({ error: 'Unauthorized' }, 401);
    }
    context.set('userId' as never, USER_ID as never);
    context.set('authType' as never, 'pat' as never);
    await next();
  };
  const dependencies: AutomationApiDependencies = {
    enabled: options?.enabled ?? true,
    authenticate,
    async loadProject(context, projectId, action) {
      if (options?.denyProject) throw new HTTPException(403, { message: 'Forbidden' });
      if (options?.projectMissing || projectId !== PROJECT_ID) return null;
      return {
        row: { projectId, accountId: ACCOUNT_ID },
        userId: context.get('userId') as string,
        accountRole: 'admin',
        projectRole: 'manager',
        effectiveRole: 'manager',
      };
    },
    controlClient: {
      async request(input) {
        calls.push(input);
        const status = options?.controlStatus ?? 201;
        if (input.path === '/v1/automation/approvals?status=pending') {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: {
              approvals: [
                {
                  approval_id: APPROVAL_ID,
                  job_id: JOB_ID,
                  step_id: STEP_ID,
                  project_id: PROJECT_ID,
                  action_hash: `sha256:${'a'.repeat(64)}`,
                  status: 'pending',
                  acting_user_id: null,
                  expires_at: '2030-07-22T11:00:00.000Z',
                  resolved_at: null,
                },
              ],
            },
          };
        }
        if (input.path === `/v1/automation/approvals/${APPROVAL_ID}/resolve`) {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: {
              approval_id: APPROVAL_ID,
              status: 'approved',
              token: `approval.v1.${'x'.repeat(43)}`,
              expires_at: '2030-07-22T11:00:00.000Z',
            },
          };
        }
        if (input.path === '/v1/automation/browser-profiles') {
          return {
            status: input.method === 'POST' ? 201 : 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body:
              input.method === 'POST'
                ? {
                    profile_id: PROFILE_ID,
                    project_id: PROJECT_ID,
                    state_hash: `sha256:${'c'.repeat(64)}`,
                    status: 'active',
                    created_by: USER_ID,
                    last_used_at: null,
                    expires_at: null,
                    revoked_at: null,
                    created_at: '2026-07-22T10:00:00.000Z',
                    updated_at: '2026-07-22T10:00:00.000Z',
                  }
                : { profiles: [] },
          };
        }
        if (input.path === '/v1/automation/policies') {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: {
              project_id: PROJECT_ID,
              allowed_origins: [],
              open_network_allowed: false,
              persistent_profiles_allowed: false,
              full_access_allowed: false,
              default_approval_policy: 'project-default',
              policy_version: '1',
              updated_by: USER_ID,
              updated_at: '2026-07-22T10:00:00.000Z',
            },
          };
        }
        if (input.path === '/v1/automation/kill-switch') {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: {
              generation: 2,
              audit_event_id: '80000000-0000-4000-a000-000000000001',
            },
          };
        }
        if (status >= 200 && status < 300 && input.path.startsWith('/v1/automation/jobs/')) {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JOB,
          };
        }
        return {
          status,
          headers: new Headers({ 'content-type': 'application/json' }),
          body:
            status === 404
              ? {
                  protocol_version: 'automation.v1',
                  code: 'AUTOMATION_NOT_FOUND',
                  message: 'Automation job was not found',
                  retryable: false,
                  approval_status: null,
                  audit_event_id: null,
                }
              : { job: JOB, created: true },
        };
      },
      async stream(input) {
        calls.push(input);
        return new Response(
          `id: 1\nevent: automation\ndata: ${JSON.stringify({
            protocol_version: 'automation.v1',
            event_id: '90000000-0000-4000-a000-000000000001',
            job_id: JOB_ID,
            sequence: 1,
            type: 'job_queued',
            status: 'queued',
            payload: { internal_error: 'private stack' },
            trace_id: null,
            created_at: '2026-07-22T10:00:00.000Z',
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
    traceparent: (context) => context.req.header('traceparent') ?? null,
  };
  const app = new Hono();
  app.route('/v1/automation', createAutomationApiApp(dependencies));
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message }, error.status);
    }
    return context.json({ error: 'Internal error' }, 500);
  });
  return { app, calls };
}

function createJob(app: Hono, body: unknown = REQUEST, token = 'valid') {
  return app.request('/v1/automation/jobs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      traceparent: TRACEPARENT,
    },
    body: JSON.stringify(body),
  });
}

describe('Kortix automation API adapter', () => {
  test('requires the existing Supabase or PAT authentication boundary', async () => {
    const { app, calls } = createTestApp();
    const response = await app.request('/v1/automation/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REQUEST),
    });

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('rejects callers outside the project before contacting the control service', async () => {
    const { app, calls } = createTestApp({ denyProject: true });
    const response = await createJob(app);

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test('returns a stable unavailable envelope while the feature is disabled', async () => {
    const { app, calls } = createTestApp({ enabled: false });
    const response = await createJob(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'AUTOMATION_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  test('makes one scoped internal call with actor, source run, and trace context', async () => {
    const { app, calls } = createTestApp();
    const response = await createJob(app);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ job: JOB, created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/automation/jobs',
      actor: {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        roles: ['project_admin', 'security_admin'],
        deviceId: null,
      },
      body: {
        tenant_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        source_run_id: null,
        traceparent: TRACEPARENT,
      },
    });
  });

  test('preserves not-found semantics for a job outside the authorized project scope', async () => {
    const { app } = createTestApp({ controlStatus: 404 });
    const response = await app.request(`/v1/automation/jobs/${JOB_ID}?project_id=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'AUTOMATION_NOT_FOUND' });

    const foreign = await app.request(
      `/v1/automation/jobs/${JOB_ID}?project_id=${OTHER_PROJECT_ID}`,
      { headers: { authorization: 'Bearer valid' } },
    );
    expect(foreign.status).toBe(404);
  });

  test('parses the control service bare job shape for reads and cancellation', async () => {
    const { app } = createTestApp();
    const read = await app.request(`/v1/automation/jobs/${JOB_ID}?project_id=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer valid' },
    });
    const cancelled = await app.request(
      `/v1/automation/jobs/${JOB_ID}/cancel?project_id=${PROJECT_ID}`,
      { method: 'POST', headers: { authorization: 'Bearer valid' } },
    );

    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(JOB);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual(JOB);
  });

  test('lists approvals and never returns the one-time resolution token', async () => {
    const { app } = createTestApp();
    const listed = await app.request(
      `/v1/automation/approvals?project_id=${PROJECT_ID}&status=pending`,
      { headers: { authorization: 'Bearer valid' } },
    );
    const resolved = await app.request(
      `/v1/automation/approvals/${APPROVAL_ID}/resolve?project_id=${PROJECT_ID}`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve',
          action_hash: `sha256:${'a'.repeat(64)}`,
        }),
      },
    );
    const resolvedBody = await resolved.text();

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ approvals: [{ approval_id: APPROVAL_ID }] });
    expect(resolved.status).toBe(200);
    expect(resolvedBody).not.toContain('approval.v1.');
    expect(JSON.parse(resolvedBody)).toEqual({
      approval_id: APPROVAL_ID,
      status: 'approved',
      expires_at: '2030-07-22T11:00:00.000Z',
    });
  });

  test('proxies profile, policy, and kill-switch commands without private profile state', async () => {
    const { app, calls } = createTestApp();
    const profile = await app.request(`/v1/automation/browser-profiles?project_id=${PROJECT_ID}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({
        encrypted_state_ref: 'sealed:vault/profile-1',
        state_hash: `sha256:${'c'.repeat(64)}`,
        expires_at: null,
      }),
    });
    const policy = await app.request(`/v1/automation/policies?project_id=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer valid' },
    });
    const killed = await app.request(`/v1/automation/kill-switch?project_id=${PROJECT_ID}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'project' } }),
    });

    expect(profile.status).toBe(201);
    expect(await profile.text()).not.toContain('sealed:');
    expect(policy.status).toBe(200);
    expect(killed.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  test('lists account tunnel devices only after project authorization', async () => {
    const { app } = createTestApp();
    const response = await app.request(`/v1/automation/devices?project_id=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ devices: [] });
  });

  test('projects internal automation SSE frames to the safe AG-UI subset', async () => {
    const { app } = createTestApp();
    const response = await app.request(
      `/v1/automation/jobs/${JOB_ID}/events?project_id=${PROJECT_ID}&cursor=0`,
      { headers: { authorization: 'Bearer valid', accept: 'text/event-stream' } },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: RUN_STARTED');
    expect(body).not.toContain('private stack');
  });
});
