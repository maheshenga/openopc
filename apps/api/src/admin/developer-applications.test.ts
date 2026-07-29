import { describe, expect, test } from 'bun:test';

import {
  DeveloperApplicationService,
  createMemoryDeveloperApplicationRepository,
} from '../developer/applications';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { registerAdminDeveloperApplicationRoutes } from './developer-applications';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const APPLICANT_ID = '20000000-0000-4000-a000-000000000001';
const ADMIN_ID = '30000000-0000-4000-a000-000000000001';
const POLICIES = { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' } as const;

async function harness(aal: 'aal1' | 'aal2', role: 'admin' | 'super_admin' | 'member' = 'admin') {
  let id = 0;
  const repository = createMemoryDeveloperApplicationRepository({
    members: [{ accountId: ACCOUNT_ID, userId: APPLICANT_ID }],
    createId: () => `90000000-0000-4000-a000-${String(++id).padStart(12, '0')}`,
  });
  const service = new DeveloperApplicationService({
    repository,
    currentPolicyVersions: POLICIES,
    now: () => new Date('2026-07-28T08:00:00.000Z'),
  });
  const { application } = await service.submit({
    actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
    organizationName: 'Acme Studio',
    policyVersions: POLICIES,
  });
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', async (context, next) => {
    context.set('userId', ADMIN_ID);
    context.set('userEmail', 'admin@example.com');
    context.set('mfaAal', aal);
    context.set('platformRole', role);
    (context as unknown as { set(key: string, value: unknown): void }).set('adminSession', {
      userId: ADMIN_ID,
      permissions: role === 'member' ? [] : ['developer.application.review'],
      stepUpAt: aal === 'aal2' ? '2026-07-28T07:55:00.000Z' : null,
      stepUpExpiresAt: aal === 'aal2' ? '2099-07-28T08:05:00.000Z' : null,
    });
    await next();
  });
  registerAdminDeveloperApplicationRoutes(app, { applicationService: service });
  return { app, application, repository };
}

describe('admin developer application routes', () => {
  test('requires the exact review permission and AAL2 before a decision', async () => {
    const lowAal = await harness('aal1');
    const lowAalResponse = await lowAal.app.request(
      `/developer/applications/${lowAal.application.application_id}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve',
          expected_revision: 0,
          reason: 'Identity verified',
        }),
      },
    );
    const wrongRole = await harness('aal2', 'member');
    const wrongRoleResponse = await wrongRole.app.request(
      `/developer/applications/${wrongRole.application.application_id}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve',
          expected_revision: 0,
          reason: 'Identity verified',
        }),
      },
    );

    expect(lowAalResponse.status).toBe(403);
    expect(await lowAalResponse.json()).toEqual({
      error: 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED',
    });
    expect(wrongRoleResponse.status).toBe(403);
    expect(await wrongRoleResponse.json()).toEqual({
      error: 'DEVELOPER_APPLICATION_FORBIDDEN',
    });
  });

  test('approves, revision-fences, audits, and keeps foreign identifiers opaque', async () => {
    const { app, application, repository } = await harness('aal2');
    const path = `/developer/applications/${application.application_id}/decision`;
    const approved = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        expected_revision: 0,
        reason: 'Identity verified',
      }),
    });
    const stale = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'reject',
        expected_revision: 0,
        reason: 'Stale decision',
      }),
    });
    const foreign = await app.request(
      '/developer/applications/90000000-0000-4000-a000-999999999999/decision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve',
          expected_revision: 0,
          reason: 'Opaque lookup',
        }),
      },
    );

    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual(
      expect.objectContaining({ state: 'approved', revision: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'DEVELOPER_APPLICATION_CONFLICT' });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'DEVELOPER_APPLICATION_NOT_FOUND' });
    expect(await repository.getAuditHistory(application.application_id)).toEqual([
      expect.objectContaining({ action: 'developer_application.submitted' }),
      expect.objectContaining({
        action: 'developer_application.approved',
        metadata: { reason: 'Identity verified' },
      }),
    ]);
  });

  test('suspends only an approved revision and requires a bounded reason', async () => {
    const { app, application } = await harness('aal2', 'super_admin');
    await app.request(`/developer/applications/${application.application_id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        expected_revision: 0,
        reason: 'Identity verified',
      }),
    });
    const suspended = await app.request(
      `/developer/applications/${application.application_id}/suspend`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: 1, reason: 'Policy investigation' }),
      },
    );

    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual(
      expect.objectContaining({ state: 'suspended', revision: 2 }),
    );
  });
});
