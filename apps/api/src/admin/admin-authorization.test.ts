import { describe, expect, test } from 'bun:test';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';

const authorizationModule = await import('./admin-authorization').catch(
  () => ({}) as Record<string, unknown>,
);

const ADMIN_ID = '20000000-0000-4000-a000-000000000002';
const TARGET_ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-28T10:00:00.000Z');

interface TestAdminSession {
  userId: string;
  permissions: string[];
  stepUpAt: string | null;
  stepUpExpiresAt: string | null;
}

interface AdminDecisionContext {
  actorUserId: string;
  permission: string;
  scope: { kind: 'platform' } | { kind: 'account'; accountId: string };
  reason?: string;
  stepUpAt?: string;
}

type AdminRequirement = {
  permission: string;
  stepUp: boolean;
  crossTenantAudit: boolean;
};

type Authorize = (
  context: Context,
  requirement: AdminRequirement,
) => Promise<AdminDecisionContext>;

type TargetAuthorize = (
  context: Context,
  accountId: string,
  requirement: AdminRequirement,
  authorize?: Authorize,
) => Promise<AdminDecisionContext>;

type AuthorizerFactory = (dependencies: {
  now: () => Date;
  recordAuditEvent: (event: AuditEventInput) => Promise<unknown>;
  accountTargetExists?: (accountId: string) => Promise<boolean>;
}) => Authorize;

type AdminSessionMiddlewareFactory = (dependencies: {
  now: () => Date;
  stepUpTtlMs: number;
  verifyAccessToken: (token: string) => Promise<{
    userId: string;
    email: string;
    aal: 'aal1' | 'aal2';
    issuedAt: string;
  } | null>;
  getPlatformRole: (userId: string) => Promise<'user' | 'admin' | 'super_admin'>;
}) => (context: Context, next: () => Promise<void>) => Promise<void>;

type AdminRequestAuthorizationMiddlewareFactory = (dependencies: {
  now: () => Date;
  recordAuditEvent: (event: AuditEventInput) => Promise<unknown>;
  accountTargetExists?: (accountId: string) => Promise<boolean>;
}) => (context: Context, next: () => Promise<void>) => Promise<void>;

function authorizerFactory(): AuthorizerFactory {
  expect(authorizationModule.createAdminDecisionAuthorizer).toBeFunction();
  return authorizationModule.createAdminDecisionAuthorizer as AuthorizerFactory;
}

function targetAuthorizerFactory(): TargetAuthorize {
  expect(authorizationModule.authorizeAdminTarget).toBeFunction();
  return authorizationModule.authorizeAdminTarget as TargetAuthorize;
}

function sessionMiddlewareFactory(): AdminSessionMiddlewareFactory {
  expect(authorizationModule.createAdminSessionMiddleware).toBeFunction();
  return authorizationModule.createAdminSessionMiddleware as AdminSessionMiddlewareFactory;
}

function sessionRouteRegistrar(): (app: Hono<AppEnv>) => void {
  expect(authorizationModule.registerAdminSessionRoute).toBeFunction();
  return authorizationModule.registerAdminSessionRoute as (app: Hono<AppEnv>) => void;
}

function requestAuthorizationMiddlewareFactory(): AdminRequestAuthorizationMiddlewareFactory {
  expect(authorizationModule.createAdminRequestAuthorizationMiddleware).toBeFunction();
  return authorizationModule.createAdminRequestAuthorizationMiddleware as AdminRequestAuthorizationMiddlewareFactory;
}

function harness(session: TestAdminSession) {
  const audits: AuditEventInput[] = [];
  const authorize = authorizerFactory()({
    now: () => NOW,
    recordAuditEvent: async (event) => {
      audits.push(structuredClone(event));
    },
  });
  const app = new Hono<AppEnv>();
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  });
  app.use('*', async (context, next) => {
    context.set('userId', session.userId);
    context.set('platformRole', 'admin');
    (context as unknown as { set(key: string, value: unknown): void }).set(
      'adminSession',
      session,
    );
    await next();
  });
  app.get('/platform', async (context) => {
    const decision = await authorize(context, {
      permission: 'developer.application.review',
      stepUp: false,
      crossTenantAudit: false,
    });
    return context.json(decision);
  });
  app.post('/accounts/:accountId', async (context) => {
    const decision = await authorize(context, {
      permission: 'account.read',
      stepUp: true,
      crossTenantAudit: true,
    });
    return context.json(decision);
  });
  return { app, audits };
}

function session(input?: Partial<TestAdminSession>): TestAdminSession {
  return {
    userId: ADMIN_ID,
    permissions: ['developer.application.review', 'account.read'],
    stepUpAt: '2026-07-28T09:55:00.000Z',
    stepUpExpiresAt: '2026-07-28T10:05:00.000Z',
    ...input,
  };
}

describe('Admin decision authorization', () => {
  test('binds an explicit developer target before requiring exact scope authorization', async () => {
    const authorizeTarget = targetAuthorizerFactory();
    const audits: AuditEventInput[] = [];
    const authorize = authorizerFactory()({
      now: () => NOW,
      recordAuditEvent: async (event) => audits.push(structuredClone(event)),
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (context, next) => {
      context.set('userId', ADMIN_ID);
      (context as unknown as { set(key: string, value: unknown): void }).set(
        'adminSession',
        session({ permissions: ['developer.module.distribute'] }),
      );
      await next();
    });
    app.post('/developer', async (context) => {
      const decision = await authorizeTarget(context, TARGET_ACCOUNT_ID, {
        permission: 'developer.module.distribute',
        stepUp: false,
        crossTenantAudit: true,
      }, authorize);
      return context.json(decision);
    });

    const response = await app.request('/developer', {
      method: 'POST',
      headers: { 'x-openopc-admin-reason': 'Publishing a verified module release' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        scope: { kind: 'account', accountId: TARGET_ACCOUNT_ID },
        permission: 'developer.module.distribute',
      }),
    );
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'admin.cross_tenant.authorized',
        accountId: TARGET_ACCOUNT_ID,
      }),
    ]);
  });

  test('builds the authoritative Admin session from verified same-user tokens', async () => {
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      sessionMiddlewareFactory()({
        now: () => NOW,
        stepUpTtlMs: 10 * 60 * 1_000,
        verifyAccessToken: async (token) => {
          if (token === 'session-token') {
            return {
              userId: ADMIN_ID,
              email: 'admin@example.com',
              aal: 'aal1',
              issuedAt: '2026-07-28T09:00:00.000Z',
            };
          }
          if (token === 'step-token') {
            return {
              userId: ADMIN_ID,
              email: 'admin@example.com',
              aal: 'aal2',
              issuedAt: '2026-07-28T09:55:00.000Z',
            };
          }
          return null;
        },
        getPlatformRole: async () => 'admin',
      }),
    );
    sessionRouteRegistrar()(app);

    const response = await app.request('/session', {
      headers: {
        cookie:
          'openopc_admin_session=session-token; openopc_admin_step_up=step-token; consumer_permissions=*',
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as TestAdminSession;
    expect(body).toEqual({
      userId: ADMIN_ID,
      permissions: expect.arrayContaining(['account.read', 'developer.application.review']),
      stepUpAt: '2026-07-28T09:55:00.000Z',
      stepUpExpiresAt: '2026-07-28T10:05:00.000Z',
    });
    expect(body.permissions).not.toContain('*');
  });

  test('rejects a step-up token issued for a different user', async () => {
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      sessionMiddlewareFactory()({
        now: () => NOW,
        stepUpTtlMs: 10 * 60 * 1_000,
        verifyAccessToken: async (token) => ({
          userId:
            token === 'session-token'
              ? ADMIN_ID
              : '20000000-0000-4000-a000-000000000099',
          email: 'admin@example.com',
          aal: token === 'session-token' ? 'aal1' : 'aal2',
          issuedAt: '2026-07-28T09:55:00.000Z',
        }),
        getPlatformRole: async () => 'admin',
      }),
    );
    sessionRouteRegistrar()(app);

    const response = await app.request('/session', {
      headers: {
        cookie: 'openopc_admin_session=session-token; openopc_admin_step_up=foreign-step-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ stepUpAt: null, stepUpExpiresAt: null }),
    );
  });

  test('requires the exact server permission', async () => {
    const { app } = harness(
      session({ permissions: ['developer.application.*', 'account.read'] }),
    );

    const response = await app.request('/platform');

    expect(response.status).toBe(403);
  });

  test('rejects an expired step-up session', async () => {
    const { app } = harness(
      session({ stepUpExpiresAt: '2026-07-28T09:59:59.999Z' }),
    );

    const response = await app.request(`/accounts/${TARGET_ACCOUNT_ID}`, {
      method: 'POST',
      headers: { 'x-openopc-admin-reason': 'Investigating a support escalation' },
    });

    expect(response.status).toBe(403);
  });

  test('requires a bounded reason before cross-tenant access', async () => {
    const { app, audits } = harness(session());

    const response = await app.request(`/accounts/${TARGET_ACCOUNT_ID}`, {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(audits).toEqual([]);
  });

  test('returns an opaque 404 for an account target outside the exact permission scope', async () => {
    const { app } = harness(session({ permissions: ['developer.application.review'] }));

    const response = await app.request(`/accounts/${TARGET_ACCOUNT_ID}`, {
      method: 'POST',
      headers: { 'x-openopc-admin-reason': 'Investigating a support escalation' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  test('returns an opaque 404 when the authoritative account lookup finds no target', async () => {
    const audits: AuditEventInput[] = [];
    const authorize = authorizerFactory()({
      now: () => NOW,
      accountTargetExists: async () => false,
      recordAuditEvent: async (event) => audits.push(structuredClone(event)),
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (context, next) => {
      context.set('userId', ADMIN_ID);
      (context as unknown as { set(key: string, value: unknown): void }).set(
        'adminSession',
        session(),
      );
      await next();
    });
    app.post('/accounts/:accountId', async (context) => {
      await authorize(context, {
        permission: 'account.read',
        stepUp: true,
        crossTenantAudit: true,
      });
      return context.json({ reachedHandler: true });
    });

    const response = await app.request(`/accounts/${TARGET_ACCOUNT_ID}`, {
      method: 'POST',
      headers: { 'x-openopc-admin-reason': 'Investigating a support escalation' },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(audits).toEqual([]);
  });

  test('records the allowed target and decision without request secret values', async () => {
    const { app, audits } = harness(session());
    const secret = 'sk-live-must-never-enter-admin-audit';

    const response = await app.request(`/accounts/${TARGET_ACCOUNT_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openopc-admin-reason': 'Investigating a support escalation',
        authorization: `Bearer ${secret}`,
        cookie: `consumer_secret=${secret}`,
      },
      body: JSON.stringify({ provider_api_key: secret }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actorUserId: ADMIN_ID,
      permission: 'account.read',
      scope: { kind: 'account', accountId: TARGET_ACCOUNT_ID },
      reason: 'Investigating a support escalation',
      stepUpAt: '2026-07-28T09:55:00.000Z',
    });
    expect(audits).toEqual([
      {
        accountId: TARGET_ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        action: 'admin.cross_tenant.authorized',
        resourceType: 'account',
        resourceId: TARGET_ACCOUNT_ID,
        metadata: {
          permission: 'account.read',
          target: { kind: 'account', accountId: TARGET_ACCOUNT_ID },
          decision: 'allowed',
          reason: 'Investigating a support escalation',
        },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(secret);
  });

  test('guards an account-detail read at the real Admin route boundary', async () => {
    const audits: AuditEventInput[] = [];
    const app = new Hono<AppEnv>();
    app.use('*', async (context, next) => {
      context.set('userId', ADMIN_ID);
      (context as unknown as { set(key: string, value: unknown): void }).set(
        'adminSession',
        session(),
      );
      await next();
    });
    app.use(
      '*',
      requestAuthorizationMiddlewareFactory()({
        now: () => NOW,
        recordAuditEvent: async (event) => audits.push(structuredClone(event)),
      }),
    );
    app.get('/api/accounts/:accountId/users', (context) =>
      context.json({ reachedHandler: true }),
    );

    const withoutReason = await app.request(`/api/accounts/${TARGET_ACCOUNT_ID}/users`);
    const allowed = await app.request(`/api/accounts/${TARGET_ACCOUNT_ID}/users`, {
      headers: { 'x-openopc-admin-reason': 'Resolving an account support incident' },
    });

    expect(withoutReason.status).toBe(400);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ reachedHandler: true });
    expect(audits).toEqual([
      expect.objectContaining({
        accountId: TARGET_ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        action: 'admin.cross_tenant.authorized',
        metadata: expect.objectContaining({
          permission: 'account.read',
          decision: 'allowed',
        }),
      }),
    ]);
  });
});
