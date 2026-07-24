import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import {
  DeveloperModuleDistributionService,
  createMemoryDeveloperModuleDistributionRepository,
} from '../developer/distribution';
import type { DeveloperModuleRelease } from '../developer/releases';
import {
  type DeveloperModuleReviewEvidence,
  DeveloperModuleReviewService,
  createMemoryDeveloperModuleReviewRepository,
} from '../developer/reviews';
import { makeOpenApiApp } from '../openapi';
import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';
import { registerAdminDeveloperReviewRoutes } from './developer-reviews';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const CREATOR_ID = '20000000-0000-4000-a000-000000000002';
const ADMIN_ID = '20000000-0000-4000-a000-000000000004';
const MEMBER_ADMIN_ID = '20000000-0000-4000-a000-000000000005';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const NOW = new Date('2026-07-24T15:00:00.000Z');

function release(
  status: DeveloperModuleRelease['status'] = 'validated',
  reviewRevision = 0,
): DeveloperModuleRelease {
  return {
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    item_name: 'recruiting-workbench',
    publisher_id: 'acme',
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    manifest: {
      schemaVersion: 1,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
    },
    manifest_digest: `sha256:${'a'.repeat(64)}`,
    review_requirements: ['manifest_review', 'source_scan', 'human_review'],
    status,
    review_revision: reviewRevision,
    signature_algorithm: null,
    signature_key_id: null,
    signature: null,
    signature_payload_digest: null,
    signed_at: null,
    published_at: null,
    revoked_at: null,
    created_by: CREATOR_ID,
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T12:00:00.000Z',
  };
}

function completeEvidence(): DeveloperModuleReviewEvidence[] {
  return release().review_requirements.map((requirement, index) => ({
    requirement,
    outcome: 'passed',
    method: 'manual',
    summary: `Manual check ${index + 1} passed`,
    observed_at: '2026-07-24T14:00:00.000Z',
  }));
}

async function pendingService(input?: { members?: string[] }) {
  const repository = createMemoryDeveloperModuleReviewRepository({
    releases: [release()],
    publisherAccountMembers: (input?.members ?? []).map((userId) => ({
      accountId: ACCOUNT_ID,
      userId,
    })),
    now: () => NOW,
    createId: (() => {
      let value = 0;
      return () => `40000000-0000-4000-a000-${String(++value).padStart(12, '0')}`;
    })(),
  });
  const service = new DeveloperModuleReviewService({ repository, now: () => NOW });
  await service.requestReview({
    accountId: ACCOUNT_ID,
    releaseId: RELEASE_ID,
    actorUserId: CREATOR_ID,
    expectedStatus: 'validated',
    expectedRevision: 0,
  });
  return service;
}

function appHarness(input: {
  service: DeveloperModuleReviewService;
  distributionService?: DeveloperModuleDistributionService;
  recordAuditEvent?: (event: AuditEventInput) => Promise<unknown>;
}) {
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', async (context, next) => {
    const userId = context.req.header('x-test-user-id');
    if (!userId) throw new HTTPException(401, { message: 'Authentication required' });
    context.set('userId', userId);
    context.set('userEmail', 'admin@example.com');
    await next();
  });
  app.use('*', async (context, next) => {
    const role = context.req.header('x-test-platform-role');
    if (role !== 'admin' && role !== 'super_admin') {
      throw new HTTPException(403, { message: 'Admin access required' });
    }
    await next();
  });
  registerAdminDeveloperReviewRoutes(app, {
    reviewService: input.service,
    distributionService:
      input.distributionService ??
      new DeveloperModuleDistributionService({
        repository: createMemoryDeveloperModuleDistributionRepository(),
      }),
    distributionEnabled: true,
    recordAuditEvent: input.recordAuditEvent ?? (async () => undefined),
  });
  return app;
}

const adminHeaders = {
  'x-test-user-id': ADMIN_ID,
  'x-test-platform-role': 'admin',
};

describe('admin developer module review API', () => {
  test('stays behind the global authentication and platform-admin boundary', async () => {
    const app = appHarness({ service: await pendingService() });

    const anonymous = await app.request('/developer/modules/reviews');
    const nonAdmin = await app.request('/developer/modules/reviews', {
      headers: { 'x-test-user-id': ADMIN_ID, 'x-test-platform-role': 'member' },
    });

    expect(anonymous.status).toBe(401);
    expect(nonAdmin.status).toBe(403);
  });

  test('lists the bounded global queue and returns chronological detail', async () => {
    const app = appHarness({ service: await pendingService() });
    const list = await app.request('/developer/modules/reviews?status=review_pending&limit=20', {
      headers: adminHeaders,
    });
    const detail = await app.request(`/developer/modules/releases/${RELEASE_ID}/review`, {
      headers: adminHeaders,
    });
    const accountFilter = await app.request(
      `/developer/modules/reviews?status=review_pending&account_id=${ACCOUNT_ID}`,
      { headers: adminHeaders },
    );

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      releases: [expect.objectContaining({ release_id: RELEASE_ID, account_id: ACCOUNT_ID })],
      next_cursor: null,
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({
      release: expect.objectContaining({ release_id: RELEASE_ID, review_revision: 1 }),
      history: [expect.objectContaining({ action: 'submit', sequence: 1 })],
    });
    expect(accountFilter.status).toBe(400);
  });

  test('records a request-changes decision and a bounded supplemental audit event', async () => {
    const audits: AuditEventInput[] = [];
    const service = await pendingService();
    const app = appHarness({
      service,
      recordAuditEvent: async (event) => {
        audits.push(structuredClone(event));
      },
    });

    const response = await app.request(
      `/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'content-type': 'application/json',
          'user-agent': 'review-test',
        },
        body: JSON.stringify({
          decision: 'request_changes',
          expected_status: 'review_pending',
          expected_revision: 1,
          reason: 'Clarify the retention policy.',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      release: expect.objectContaining({ status: 'changes_requested', review_revision: 2 }),
      event: expect.objectContaining({ action: 'request_changes', sequence: 2 }),
    });
    expect(audits).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        action: 'developer.module.review.changes_requested',
        resourceType: 'developer_module_release',
        resourceId: RELEASE_ID,
        before: { status: 'review_pending', review_revision: 1 },
        after: { status: 'changes_requested', review_revision: 2 },
        userAgent: 'review-test',
      }),
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/retention|manifest|evidence/i);
  });

  test('approves only with complete manual evidence and denies publisher-account members', async () => {
    const service = await pendingService({ members: [MEMBER_ADMIN_ID] });
    const app = appHarness({ service });
    const body = {
      decision: 'approve',
      expected_status: 'review_pending',
      expected_revision: 1,
      evidence: completeEvidence(),
    };

    const selfApproval = await app.request(
      `/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': MEMBER_ADMIN_ID,
          'x-test-platform-role': 'admin',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    const approval = await app.request(
      `/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    expect(selfApproval.status).toBe(403);
    expect(await selfApproval.json()).toEqual({
      error: 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED',
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toEqual({
      release: expect.objectContaining({ status: 'approved', review_revision: 2 }),
      event: expect.objectContaining({ action: 'approve', evidence: completeEvidence() }),
    });
  });

  test('returns code-only not-found, stale, reason, and evidence failures', async () => {
    const service = await pendingService();
    const app = appHarness({ service });
    const path = `/developer/modules/releases/${RELEASE_ID}/review-decisions`;
    const request = (body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const missing = await app.request(
      '/developer/modules/releases/30000000-0000-4000-a000-000000000099/review',
      { headers: adminHeaders },
    );
    const stale = await request({
      decision: 'request_changes',
      expected_status: 'review_pending',
      expected_revision: 99,
      reason: 'do-not-echo-stale-reason',
    });
    const noReason = await request({
      decision: 'request_changes',
      expected_status: 'review_pending',
      expected_revision: 1,
    });
    const incomplete = await request({
      decision: 'approve',
      expected_status: 'review_pending',
      expected_revision: 1,
      evidence: completeEvidence().slice(0, 1),
    });
    const staleText = await stale.clone().text();

    expect(missing.status).toBe(404);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'DEVELOPER_REVIEW_CONFLICT' });
    expect(noReason.status).toBe(400);
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toEqual({ error: 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE' });
    expect(staleText).not.toContain('do-not-echo-stale-reason');
  });

  test('does not undo a committed decision when supplemental audit recording fails', async () => {
    const service = await pendingService();
    const app = appHarness({
      service,
      recordAuditEvent: async () => {
        throw new Error('audit unavailable');
      },
    });

    const response = await app.request(
      `/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'request_changes',
          expected_status: 'review_pending',
          expected_revision: 1,
          reason: 'Clarify the retention policy.',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect((await service.adminGet({ releaseId: RELEASE_ID })).release).toEqual(
      expect.objectContaining({ status: 'changes_requested', review_revision: 2 }),
    );
  });

  test('reuses review-decisions to revoke signed releases through the distribution service', async () => {
    const audits: AuditEventInput[] = [];
    const distributionService = new DeveloperModuleDistributionService({
      repository: createMemoryDeveloperModuleDistributionRepository({
        releases: [release('signed', 3)],
        now: () => NOW,
        createId: () => '40000000-0000-4000-a000-000000000099',
      }),
    });
    const app = appHarness({
      service: await pendingService(),
      distributionService,
      recordAuditEvent: async (event) => {
        audits.push(structuredClone(event));
      },
    });

    const response = await app.request(
      `/developer/modules/releases/${RELEASE_ID}/review-decisions`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'revoke',
          expected_status: 'signed',
          expected_revision: 3,
          reason: 'Emergency withdrawal.',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      release: expect.objectContaining({ status: 'revoked', review_revision: 4 }),
      event: expect.objectContaining({ action: 'revoke', sequence: 4 }),
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'developer.module.distribution.revoked',
        before: { status: 'signed', review_revision: 3 },
        after: { status: 'revoked', review_revision: 4 },
      }),
    ]);
  });

  test('keeps approved revocation on the existing review service path', async () => {
    const service = await pendingService();
    const app = appHarness({
      service,
      distributionService: new DeveloperModuleDistributionService({
        repository: createMemoryDeveloperModuleDistributionRepository(),
      }),
    });
    const path = `/developer/modules/releases/${RELEASE_ID}/review-decisions`;

    const approved = await app.request(path, {
      method: 'POST',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approve',
        expected_status: 'review_pending',
        expected_revision: 1,
        evidence: completeEvidence(),
      }),
    });
    const revoked = await app.request(path, {
      method: 'POST',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'revoke',
        expected_status: 'approved',
        expected_revision: 2,
        reason: 'Withdraw before signing.',
      }),
    });

    expect(approved.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      release: expect.objectContaining({ status: 'revoked', review_revision: 3 }),
      event: expect.objectContaining({ action: 'revoke', sequence: 3 }),
    });
  });
});
