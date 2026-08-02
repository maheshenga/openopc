import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import {
  DeveloperApplicationService,
  createMemoryDeveloperApplicationRepository,
} from '../developer/applications';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import type { AdminDecisionAuthorizer, AdminDecisionRequirement } from './admin-authorization';
import { registerAdminDeveloperApplicationRoutes } from './developer-applications';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const APPLICANT_ID = '20000000-0000-4000-a000-000000000001';
const ADMIN_ID = '30000000-0000-4000-a000-000000000001';
const POLICIES = { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' } as const;

async function harness(
  aal: 'aal1' | 'aal2',
  role: 'admin' | 'super_admin' | 'member' = 'admin',
  input: { actorUserId?: string } = {},
) {
  const actorUserId = input.actorUserId ?? ADMIN_ID;
  const requirements: AdminDecisionRequirement[] = [];
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
    context.set('userId', actorUserId);
    context.set('userEmail', 'admin@example.com');
    context.set('mfaAal', aal);
    context.set('platformRole', role);
    (context as unknown as { set(key: string, value: unknown): void }).set('adminSession', {
      userId: actorUserId,
      permissions: role === 'member' ? [] : ['developer.application.review'],
      stepUpAt: aal === 'aal2' ? '2026-07-28T07:55:00.000Z' : null,
      stepUpExpiresAt: aal === 'aal2' ? '2099-07-28T08:05:00.000Z' : null,
    });
    await next();
  });
  const authorizeAdminDecision: AdminDecisionAuthorizer = async (context, requirement) => {
    requirements.push(structuredClone(requirement));
    if (role === 'member') throw new HTTPException(403, { message: 'Permission required' });
    if (requirement.stepUp && aal !== 'aal2') {
      throw new HTTPException(403, { message: 'Step-up authentication required' });
    }
    const reason = context.req.header('x-openopc-admin-reason');
    if (requirement.crossTenantAudit && !reason) {
      throw new HTTPException(400, { message: 'Admin reason required' });
    }
    return {
      actorUserId,
      permission: requirement.permission,
      scope: { kind: 'platform' },
      ...(reason ? { reason } : {}),
    };
  };
  registerAdminDeveloperApplicationRoutes(app, { applicationService: service, authorizeAdminDecision });
  return { app, application, repository, requirements };
}

describe('admin developer application routes', () => {
  test('lists applications with review permission and no AAL2 requirement', async () => {
    const { app, requirements } = await harness('aal1');
    const response = await app.request('/developer/applications?state=submitted&limit=25');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applications: [
        expect.objectContaining({
          application: expect.objectContaining({ state: 'submitted' }),
          organization: expect.objectContaining({ name: 'Acme Studio' }),
        }),
      ],
      next_cursor: null,
    });
    expect(requirements).toEqual([
      {
        permission: 'developer.application.review',
        stepUp: false,
        crossTenantAudit: false,
      },
    ]);
  });

  test('reads exact detail through a target-account authorization reason', async () => {
    const { app, application, requirements } = await harness('aal1');
    const response = await app.request(`/developer/applications/${application.application_id}`, {
      headers: { 'x-openopc-admin-reason': 'Reviewing developer application' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        application: expect.objectContaining({ application_id: application.application_id }),
        organization: expect.objectContaining({ account_id: ACCOUNT_ID }),
        policy_acceptances: expect.any(Array),
        history: expect.any(Array),
      }),
    );
    expect(requirements).toEqual([
      {
        permission: 'developer.application.review',
        stepUp: false,
        crossTenantAudit: false,
      },
      {
        permission: 'developer.application.review',
        stepUp: false,
        crossTenantAudit: true,
      },
    ]);
  });

  test('rejects missing permission, missing detail reason, malformed cursor, and unknown IDs', async () => {
    const missingPermission = await harness('aal1', 'member');
    const missingDetailReason = await harness('aal1');
    const malformedCursor = await harness('aal1');
    const unknown = await harness('aal1');

    const responses = await Promise.all([
      missingPermission.app.request('/developer/applications'),
      missingDetailReason.app.request(
        `/developer/applications/${missingDetailReason.application.application_id}`,
      ),
      malformedCursor.app.request('/developer/applications?cursor=not-a-cursor'),
      unknown.app.request('/developer/applications/90000000-0000-4000-a000-999999999999', {
        headers: { 'x-openopc-admin-reason': 'Reviewing developer application' },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 400, 400, 404]);
  });

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

  test('allows a platform owner to approve their own application and audits that actor', async () => {
    const { app, application, repository } = await harness('aal2', 'admin', {
      actorUserId: APPLICANT_ID,
    });
    const response = await app.request(`/developer/applications/${application.application_id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        expected_revision: 0,
        reason: 'Platform review complete',
      }),
    });

    expect(response.status).toBe(200);
    expect(await repository.getAuditHistory(application.application_id)).toEqual([
      expect.objectContaining({ action: 'developer_application.submitted' }),
      expect.objectContaining({
        action: 'developer_application.approved',
        actor_user_id: APPLICANT_ID,
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
