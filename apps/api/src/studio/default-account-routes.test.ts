import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import { createDefaultStudioAccountRoutes } from './default-account-routes';
import { createMemoryStudioRepository } from './repositories/memory';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const USER_ID = '20000000-0000-4000-a000-000000000001';
const IAM_TOKEN_ID = '30000000-0000-4000-a000-000000000001';

describe('default Studio account route wiring', () => {
  test('forwards the acting token and MFA/IP request context to account authorization', async () => {
    const authorizationCalls: unknown[][] = [];
    const routes = createDefaultStudioAccountRoutes({
      repository: createMemoryStudioRepository(),
      authorize: async (...args) => {
        authorizationCalls.push(args);
      },
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', USER_ID);
      c.set('iamTokenId', IAM_TOKEN_ID);
      (c as unknown as { set(key: string, value: unknown): void }).set('mfaAal', 'aal2');
      await next();
    });
    app.route('/v1/accounts', routes);

    const response = await app.request(`/v1/accounts/${ACCOUNT_ID}/studio/pricing-catalog`, {
      headers: { 'x-forwarded-for': ' 203.0.113.7, 198.51.100.2 ' },
    });

    expect(response.status).toBe(200);
    expect(authorizationCalls).toEqual([
      [
        USER_ID,
        ACCOUNT_ID,
        ACCOUNT_ACTIONS.BILLING_READ,
        undefined,
        IAM_TOKEN_ID,
        { ip: '203.0.113.7', mfaAal: 'aal2' },
      ],
    ]);
  });
});
