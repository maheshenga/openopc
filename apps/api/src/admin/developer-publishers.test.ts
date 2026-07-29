import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import {
  type DeveloperOrganization,
  type DeveloperPublisher,
  type DeveloperPublisherMember,
  DeveloperPublisherService,
  createMemoryDeveloperPublisherRepository,
} from '../developer/publishers';
import { makeOpenApiApp } from '../openapi';
import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';
import { createAdminDecisionAuthorizer } from './admin-authorization';
import { registerAdminDeveloperPublisherRoutes } from './developer-publishers';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000001';
const OWNER_ID = '30000000-0000-4000-a000-000000000001';
const ADMIN_ID = '30000000-0000-4000-a000-000000000002';
const NOW = new Date('2026-07-26T03:00:00.000Z');

function organization(state: DeveloperOrganization['verification_state']): DeveloperOrganization {
  return {
    organization_id: ORGANIZATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Acme Studio',
    verification_state: state,
    verification_metadata: {},
    verification_revision: state === 'pending' ? 0 : 1,
    verification_changed_by: state === 'pending' ? null : ADMIN_ID,
    verification_changed_at: state === 'pending' ? null : NOW.toISOString(),
    created_by: OWNER_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const publisher: DeveloperPublisher = {
  publisher_id: 'acme',
  account_id: ACCOUNT_ID,
  organization_id: ORGANIZATION_ID,
  slug: 'acme',
  display_name: 'Acme',
  status: 'active',
  authority_revision: 0,
  suspended_reason: null,
  suspended_by: null,
  suspended_at: null,
  created_by: OWNER_ID,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const owner: DeveloperPublisherMember = {
  member_id: '40000000-0000-4000-a000-000000000001',
  account_id: ACCOUNT_ID,
  publisher_id: 'acme',
  user_id: OWNER_ID,
  role: 'owner',
  revision: 0,
  created_by: OWNER_ID,
  created_at: NOW.toISOString(),
  updated_by: null,
  updated_at: NOW.toISOString(),
};

function appHarness(input?: {
  organizations?: DeveloperOrganization[];
  publishers?: DeveloperPublisher[];
  members?: DeveloperPublisherMember[];
  authorizationAudits?: AuditEventInput[];
}) {
  const repository = createMemoryDeveloperPublisherRepository({
    organizations: input?.organizations,
    publishers: input?.publishers,
    members: input?.members,
    createId: (() => {
      let id = 0;
      return () => `90000000-0000-4000-a000-${String(++id).padStart(12, '0')}`;
    })(),
  });
  const service = new DeveloperPublisherService({
    repository,
    now: () => NOW,
    createToken: () => 'admin-created-one-time-token',
  });
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', async (context, next) => {
    const userId = context.req.header('x-test-user-id');
    if (!userId) throw new HTTPException(401, { message: 'Authentication required' });
    context.set('userId', userId);
    context.set('userEmail', 'admin@example.com');
    const permissions = context.req.header('x-test-permissions');
    const stepUp = context.req.header('x-test-step-up') !== 'missing';
    (context as unknown as { set(key: string, value: unknown): void }).set('adminSession', {
      userId,
      permissions:
        permissions === undefined
          ? ['developer.publisher.manage']
          : permissions.split(',').filter(Boolean),
      stepUpAt: stepUp ? '2026-07-26T02:55:00.000Z' : null,
      stepUpExpiresAt: stepUp ? '2026-07-26T03:05:00.000Z' : null,
    });
    await next();
  });
  app.use('*', async (context, next) => {
    const role = context.req.header('x-test-platform-role');
    if (role !== 'admin' && role !== 'super_admin') {
      throw new HTTPException(403, { message: 'Admin access required' });
    }
    await next();
  });
  registerAdminDeveloperPublisherRoutes(app, {
    publisherService: service,
    authorizeAdminDecision: createAdminDecisionAuthorizer({
      now: () => NOW,
      recordAuditEvent: async (event) => input?.authorizationAudits?.push(structuredClone(event)),
    }),
  });
  return { app, service };
}

const adminHeaders = {
  'content-type': 'application/json',
  'x-test-user-id': ADMIN_ID,
  'x-test-platform-role': 'admin',
  'x-openopc-admin-reason': 'Managing a verified developer organization',
};

describe('admin developer Publisher API', () => {
  test('stays behind authentication and platform-admin authority', async () => {
    const { app } = appHarness();

    const anonymous = await app.request('/developer/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const nonAdmin = await app.request('/developer/invitations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': ADMIN_ID,
        'x-test-platform-role': 'member',
      },
      body: '{}',
    });

    expect(anonymous.status).toBe(401);
    expect(nonAdmin.status).toBe(403);
  });

  test('creates an organization-bound invitation and returns its token only once', async () => {
    const { app } = appHarness();

    const response = await app.request('/developer/invitations', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        organization_name: 'Acme Studio',
        email: 'developer@example.com',
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      invitation: expect.objectContaining({ account_id: ACCOUNT_ID, state: 'pending' }),
      token: 'admin-created-one-time-token',
    });
  });

  test('revision-fences organization verification without leaking another account', async () => {
    const { app } = appHarness({ organizations: [organization('pending')] });
    const path = `/developer/organizations/${ORGANIZATION_ID}/verification`;

    const verified = await app.request(path, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        state: 'verified',
        metadata: { reviewer: 'internal-beta' },
        expected_revision: 0,
      }),
    });
    const stale = await app.request(path, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        state: 'rejected',
        expected_revision: 0,
      }),
    });
    const otherAccount = await app.request(path, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        account_id: OTHER_ACCOUNT_ID,
        state: 'rejected',
        expected_revision: 1,
      }),
    });

    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual(
      expect.objectContaining({ verification_state: 'verified', verification_revision: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'DEVELOPER_AUTHORITY_CONFLICT' });
    expect(otherAccount.status).toBe(404);
    expect(await otherAccount.json()).toEqual({ error: 'DEVELOPER_ORGANIZATION_NOT_FOUND' });
  });

  test('suspends and reinstates with monotonic authority revisions', async () => {
    const { app } = appHarness({
      organizations: [organization('verified')],
      publishers: [publisher],
      members: [owner],
    });
    const base = '/developer/publishers/acme';

    const suspended = await app.request(`${base}/suspensions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        reason: 'Policy investigation',
        expected_revision: 0,
      }),
    });
    const reinstated = await app.request(`${base}/reinstatements`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ account_id: ACCOUNT_ID, expected_revision: 1 }),
    });

    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual(
      expect.objectContaining({ status: 'suspended', authority_revision: 1 }),
    );
    expect(reinstated.status).toBe(200);
    expect(await reinstated.json()).toEqual(
      expect.objectContaining({ status: 'active', authority_revision: 2 }),
    );
  });
});
