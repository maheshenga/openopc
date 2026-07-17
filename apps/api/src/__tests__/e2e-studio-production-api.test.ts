import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const USER_ID = '00000000-0000-4000-a000-000000000001';
const JOB_ID = '00000000-0000-4000-a000-000000000301';
const ATTEMPT_ID = '00000000-0000-4000-a000-000000000302';
const RECOVERY_ID = '00000000-0000-4000-a000-000000000303';

const projectActions: string[] = [];
const recoveryCalls: unknown[] = [];

const originalStudioEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  STUDIO_ENABLED: process.env.STUDIO_ENABLED,
  STUDIO_FAKE_PROVIDER_ENABLED: process.env.STUDIO_FAKE_PROVIDER_ENABLED,
  STUDIO_OPENAI_COMPATIBLE_ENABLED: process.env.STUDIO_OPENAI_COMPATIBLE_ENABLED,
  STUDIO_OBJECT_STORE_MODE: process.env.STUDIO_OBJECT_STORE_MODE,
  STUDIO_ALLOW_EPHEMERAL_STORAGE: process.env.STUDIO_ALLOW_EPHEMERAL_STORAGE,
};
Object.assign(process.env, {
  NODE_ENV: 'test',
  STUDIO_ENABLED: 'true',
  STUDIO_FAKE_PROVIDER_ENABLED: 'true',
  STUDIO_OPENAI_COMPATIBLE_ENABLED: 'false',
  STUDIO_OBJECT_STORE_MODE: 'memory',
  STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
});

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
  ) => {},
}));

const { createMemoryStudioRepository } = await import('../studio/repositories/memory');
const productionRepository = createMemoryStudioRepository();
mock.module('../studio/repositories/drizzle', () => ({
  createDrizzleStudioRepository: () => productionRepository,
  createDrizzleStudioRecoveryRepository: () => ({
    recoverLocked: async (input: unknown) => {
      recoveryCalls.push(input);
      return {
        recovery_id: RECOVERY_ID,
        job_id: JOB_ID,
        attempt_id: ATTEMPT_ID,
        decision: 'confirm_not_created',
        job_status: 'failed',
        attempt_status: 'failed',
        reservation_status: 'released',
        hold_expires_at: null,
      };
    },
  }),
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/studio');
await import('../projects/routes/intelligence');

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
  test('mounts an executable recovery service in the production projects app', async () => {
    projectActions.length = 0;
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

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recovery_id: RECOVERY_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      decision: 'confirm_not_created',
      job_status: 'failed',
      attempt_status: 'failed',
      reservation_status: 'released',
      hold_expires_at: null,
    });
    expect(projectActions).toEqual(['project.studio.jobs.cancel']);
    expect(recoveryCalls).toHaveLength(1);
  });

  test('mounts intelligence discovery beside the Studio routes', async () => {
    projectActions.length = 0;
    const app = createApp();
    const response = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
    });
    expect(projectActions).toEqual(['project.studio.providers.use']);
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalStudioEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
