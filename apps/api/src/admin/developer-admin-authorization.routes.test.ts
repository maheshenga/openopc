import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { registerAdminDeveloperDistributionRoutes } from './developer-distribution';
import { registerAdminDeveloperPublisherRoutes } from './developer-publishers';
import { registerAdminDeveloperReviewRoutes } from './developer-reviews';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const ADMIN_ID = '20000000-0000-4000-a000-000000000002';

function adminApp() {
  const app = makeOpenApiApp<AppEnv>();
  app.onError((error, context) => {
    if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
    return context.json({ error: 'unexpected' }, 500);
  });
  app.use('*', async (context, next) => {
    context.set('userId', ADMIN_ID);
    (context as unknown as { set(key: string, value: unknown): void }).set('adminSession', {
      userId: ADMIN_ID,
      permissions: [
        'developer.module.review',
        'developer.module.distribute',
        'developer.publisher.manage',
      ],
      stepUpAt: new Date(Date.now() - 60_000).toISOString(),
      stepUpExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await next();
  });
  return app;
}

function denyingAuthorizer(calls: Array<{ permission: string; stepUp: boolean; crossTenantAudit: boolean }>) {
  return async (_context: unknown, requirement: { permission: string; stepUp: boolean; crossTenantAudit: boolean }) => {
    calls.push(requirement);
    if (requirement.crossTenantAudit) {
      throw new HTTPException(400, { message: 'Cross-tenant reason required' });
    }
  };
}

describe('Developer Admin routes use the central decision authorizer', () => {
  test('guards module distribution before signing', async () => {
    const calls: Array<{ permission: string; stepUp: boolean; crossTenantAudit: boolean }> = [];
    const app = adminApp();
    registerAdminDeveloperDistributionRoutes(app, {
      distributionService: {
        getAdminRelease: async () => ({ account_id: ACCOUNT_ID }) as never,
        sign: async () => {
          throw new Error('service must not run before authorization');
        },
        publish: async () => {
          throw new Error('service must not run before authorization');
        },
      } as never,
      enabled: true,
      recordAuditEvent: async () => undefined,
      authorizeAdminDecision: denyingAuthorizer(calls),
    } as never);

    const response = await app.request(`/developer/modules/releases/${RELEASE_ID}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_status: 'approved', expected_revision: 2 }),
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual([
      { permission: 'developer.module.distribute', stepUp: true, crossTenantAudit: true },
    ]);
  });

  test('guards publisher mutations before changing organization state', async () => {
    const calls: Array<{ permission: string; stepUp: boolean; crossTenantAudit: boolean }> = [];
    const app = adminApp();
    registerAdminDeveloperPublisherRoutes(app, {
      publisherService: {
        invite: async () => {
          throw new Error('service must not run before authorization');
        },
        setVerification: async () => {
          throw new Error('service must not run before authorization');
        },
        suspend: async () => {
          throw new Error('service must not run before authorization');
        },
        reinstate: async () => {
          throw new Error('service must not run before authorization');
        },
      } as never,
      authorizeAdminDecision: denyingAuthorizer(calls),
    } as never);

    const response = await app.request('/developer/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        organization_name: 'Acme',
        email: 'developer@example.com',
      }),
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual([
      { permission: 'developer.publisher.manage', stepUp: true, crossTenantAudit: true },
    ]);
  });

  test('guards review decisions before applying a release transition', async () => {
    const calls: Array<{ permission: string; stepUp: boolean; crossTenantAudit: boolean }> = [];
    const app = adminApp();
    registerAdminDeveloperReviewRoutes(app, {
      reviewService: {
        adminGet: async () => ({ release: { account_id: ACCOUNT_ID } }) as never,
        adminList: async () => ({ releases: [], next_cursor: null }),
        decide: async () => {
          throw new Error('service must not run before authorization');
        },
      } as never,
      distributionService: { revoke: async () => { throw new Error('service must not run before authorization'); } } as never,
      distributionEnabled: true,
      verificationService: {
        getAdminTrustView: async () => ({ account_id: ACCOUNT_ID }) as never,
        retryAdmin: async () => { throw new Error('service must not run before authorization'); },
        cancelAdmin: async () => { throw new Error('service must not run before authorization'); },
      } as never,
      recordAuditEvent: async () => undefined,
      authorizeAdminDecision: denyingAuthorizer(calls),
    } as never);

    const response = await app.request(
      `/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'request_changes',
          expected_status: 'review_pending',
          expected_revision: 1,
          reason: 'Needs clarification',
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([
      { permission: 'developer.module.review', stepUp: true, crossTenantAudit: false },
      { permission: 'developer.module.review', stepUp: true, crossTenantAudit: true },
    ]);
  });
});
