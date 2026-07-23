import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import { createDefaultStudioAccountRoutes } from './default-account-routes';
import { createMemoryStudioRepository } from './repositories/memory';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const USER_ID = '20000000-0000-4000-a000-000000000001';
const IAM_TOKEN_ID = '30000000-0000-4000-a000-000000000001';
const INCIDENT_ID = '40000000-0000-4000-a000-000000000001';

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

  test('wires the billing incident service into the default account route', async () => {
    const authorizationCalls: unknown[][] = [];
    const resolutionCalls: unknown[] = [];
    const routes = createDefaultStudioAccountRoutes({
      repository: createMemoryStudioRepository(),
      billingIncidentService: {
        async resolve(input) {
          resolutionCalls.push(input);
          return {
            incident_id: INCIDENT_ID,
            account_id: ACCOUNT_ID,
            project_id: '50000000-0000-4000-a000-000000000001',
            job_id: '60000000-0000-4000-a000-000000000001',
            attempt_id: '70000000-0000-4000-a000-000000000001',
            status: 'resolved',
            decision: input.request.decision,
            evidence_reference: input.request.evidence_reference,
            verified_cost_credits: 0,
            potential_liability_credits: 4,
            provider_liability_credits: 0,
            resolved_at: '2026-07-24T00:00:00.000Z',
            resolved_by_user_id: input.actorUserId,
          };
        },
      },
      authorize: async (...args) => {
        authorizationCalls.push(args);
      },
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', USER_ID);
      c.set('iamTokenId', IAM_TOKEN_ID);
      await next();
    });
    app.route('/v1/accounts', routes);

    const response = await app.request(
      `/v1/accounts/${ACCOUNT_ID}/studio/billing-incidents/${INCIDENT_ID}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'confirm_not_created',
          idempotency_key: 'incident-resolution-key-0004',
          reason: 'Provider evidence confirms that no request was created.',
          evidence_reference: 'evidence:provider-case-0004',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(authorizationCalls[0]?.[2]).toBe(ACCOUNT_ACTIONS.BILLING_WRITE);
    expect(resolutionCalls).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        incidentId: INCIDENT_ID,
        actorUserId: USER_ID,
        actingTokenId: IAM_TOKEN_ID,
      }),
    ]);
  });
});
