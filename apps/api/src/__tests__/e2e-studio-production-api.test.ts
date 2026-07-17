import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const USER_ID = '00000000-0000-4000-a000-000000000001';
const JOB_ID = '00000000-0000-4000-a000-000000000301';

const projectActions: string[] = [];

mock.module('../shared/db', () => ({ db: {} }));
mock.module('../config', () => ({
  config: {
    API_KEY_SECRET: 'studio-production-api-secret',
  },
}));
mock.module('../projects/lib/access', () => ({
  loadProjectForUser: async (_c: unknown, projectId: string) =>
    projectId === PROJECT_ID
      ? {
          row: { accountId: ACCOUNT_ID, projectId },
          userId: USER_ID,
        }
      : null,
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    projectActions.push(action);
  },
}));
mock.module('../iam/dispatcher', () => ({
  assertAuthorized: async (
    userId: string,
    accountId: string,
    action: string,
    _resource: unknown,
    tokenId: string | undefined,
    _context: unknown,
  ) => {
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/studio');

function createApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const context = c as unknown as { set(key: string, value: unknown): void };
    context.set('authType', 'pat');
    context.set('iamTokenId', 'iam-token-001');
    context.set('agentGrant', { agent: 'operator-reviewer' });
    await next();
  });
  app.route('/v1/projects', projectsApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    throw err;
  });
  return app;
}

describe('Studio production API contract', () => {
  test('mounts the recovery route in the production projects app but keeps it disabled until runtime assembly lands', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'confirm_not_created',
        idempotency_key: 'production-recovery-contract-key',
        reason: 'The provider confirms no upstream request was created.',
        evidence: {
          provider_request_id: 'provider-request-001',
        },
      }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: 'Studio recovery unavailable',
      code: 'STUDIO_INTERNAL_ERROR',
    });
    expect(projectActions).toEqual(['project.studio.jobs.cancel']);
  });
});
