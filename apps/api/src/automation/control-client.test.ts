import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  type InternalAutomationEnv,
  createInternalAuthMiddleware,
} from '../../../automation-control/src/internal-auth';
import { createAutomationControlClient } from './control-client';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-22T10:00:00.000Z');
const SHARED_SECRET = 'test-shared-secret-at-least-thirty-two-characters';

describe('automation control client signing', () => {
  test('matches the control service timestamp, actor, path, and body signature contract', async () => {
    const control = new Hono<InternalAutomationEnv>();
    control.use(
      '/v1/automation/*',
      createInternalAuthMiddleware({
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['kortix-api'],
        now: () => NOW,
      }),
    );
    control.post('/v1/automation/jobs', async (context) =>
      context.json({ actor: context.get('automationActor'), body: await context.req.json() }),
    );
    const requestFetch = ((input: string | URL | Request, init?: RequestInit) =>
      control.fetch(new Request(input, init))) as typeof fetch;
    const client = createAutomationControlClient({
      baseUrl: 'http://automation.local',
      sharedSecret: SHARED_SECRET,
      now: () => NOW,
      fetch: requestFetch,
    });

    const response = await client.request({
      method: 'POST',
      path: '/v1/automation/jobs',
      actor: {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        roles: ['project_admin'],
        deviceId: null,
      },
      body: { project_id: PROJECT_ID },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      actor: {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        roles: ['project_admin'],
        deviceId: null,
      },
      body: { project_id: PROJECT_ID },
    });
  });
});
