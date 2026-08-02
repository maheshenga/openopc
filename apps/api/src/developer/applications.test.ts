import { describe, expect, test } from 'bun:test';

import {
  DEVELOPER_APPLICATION_REVIEW_PERMISSION,
  type DeveloperApplication,
  DeveloperApplicationError,
  DeveloperApplicationService,
  createMemoryDeveloperApplicationRepository,
} from './applications';
import type { DeveloperOrganization } from './publishers';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000001';
const APPLICANT_ID = '30000000-0000-4000-a000-000000000001';
const ADMIN_ID = '30000000-0000-4000-a000-000000000002';
const NOW = new Date('2026-07-28T08:00:00.000Z');
const POLICIES = { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' } as const;

function invitedOrganization(): DeveloperOrganization {
  return {
    organization_id: ORGANIZATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Acme Studio',
    verification_state: 'pending',
    verification_metadata: {},
    verification_revision: 0,
    verification_changed_by: null,
    verification_changed_at: null,
    created_by: ADMIN_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function harness(input?: { organizations?: DeveloperOrganization[] }) {
  let id = 0;
  const repository = createMemoryDeveloperApplicationRepository({
    members: [
      { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      { accountId: OTHER_ACCOUNT_ID, userId: APPLICANT_ID },
    ],
    organizations: input?.organizations,
    createId: () => `90000000-0000-4000-a000-${String(++id).padStart(12, '0')}`,
  });
  return {
    repository,
    service: new DeveloperApplicationService({
      repository,
      currentPolicyVersions: POLICIES,
      now: () => NOW,
    }),
  };
}

function adminReadHarness() {
  const olderOrganization: DeveloperOrganization = {
    ...invitedOrganization(),
    name: 'Older Studio',
    updated_at: '2026-08-03T07:00:00.000Z',
  };
  const newerOrganization: DeveloperOrganization = {
    ...invitedOrganization(),
    organization_id: '20000000-0000-4000-a000-000000000002',
    account_id: OTHER_ACCOUNT_ID,
    name: 'Newest Studio',
    updated_at: '2026-08-03T08:00:00.000Z',
  };
  const application = (
    applicationId: string,
    accountId: string,
    organizationId: string,
    updatedAt: string,
  ): DeveloperApplication => ({
    application_id: applicationId,
    account_id: accountId,
    organization_id: organizationId,
    state: 'submitted',
    revision: 0,
    policy_versions: POLICIES,
    submitted_at: updatedAt,
    decided_at: null,
    suspended_at: null,
    decision_reason: null,
    created_by: APPLICANT_ID,
    updated_by: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  });
  const repository = createMemoryDeveloperApplicationRepository({
    organizations: [olderOrganization, newerOrganization],
    applications: [
      application(
        '40000000-0000-4000-a000-000000000001',
        ACCOUNT_ID,
        olderOrganization.organization_id,
        '2026-08-03T07:00:00.000Z',
      ),
      application(
        '40000000-0000-4000-a000-000000000002',
        OTHER_ACCOUNT_ID,
        newerOrganization.organization_id,
        '2026-08-03T08:00:00.000Z',
      ),
    ],
  });
  return {
    repository,
    service: new DeveloperApplicationService({
      repository,
      currentPolicyVersions: POLICIES,
      now: () => NOW,
    }),
  };
}

describe('DeveloperApplicationService', () => {
  test('lists the submitted Admin queue with an opaque deterministic cursor', async () => {
    const { service } = adminReadHarness();

    const first = await service.adminList({ state: 'submitted', limit: 1 });
    expect(first.applications).toHaveLength(1);
    expect(first.applications[0]).toEqual({
      application: expect.objectContaining({ state: 'submitted' }),
      organization: expect.objectContaining({ name: 'Newest Studio' }),
    });
    expect(first.next_cursor).toBeString();

    const second = await service.adminList({
      state: 'submitted',
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(second.applications[0]?.organization.name).toBe('Older Studio');
    expect(second.next_cursor).toBeNull();

    await expect(service.adminList({ cursor: 'not-a-valid-cursor' })).rejects.toMatchObject({
      code: 'DEVELOPER_APPLICATION_INPUT_INVALID',
      status: 400,
    });
  });

  test('assembles one Admin detail with policy acceptance and audit history', async () => {
    const { service } = harness({ organizations: [invitedOrganization()] });
    const submitted = await service.submit({
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Acme Studio',
      policyVersions: POLICIES,
    });

    await expect(
      service.adminGet({ applicationId: submitted.application.application_id }),
    ).resolves.toEqual({
      application: submitted.application,
      organization: expect.objectContaining({ name: 'Acme Studio' }),
      policy_acceptances: expect.arrayContaining([
        expect.objectContaining({ policy: 'acceptable_use' }),
        expect.objectContaining({ policy: 'module_rules' }),
      ]),
      history: [expect.objectContaining({ action: 'developer_application.submitted' })],
    });
    await expect(
      service.adminGet({ applicationId: '90000000-0000-4000-a000-999999999999' }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_APPLICATION_NOT_FOUND', status: 404 });
  });

  test('allows the submitting platform administrator to approve their own application', async () => {
    const { service } = harness();
    const { application } = await service.submit({
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Owner Studio',
      policyVersions: POLICIES,
    });

    await expect(
      service.decide({
        actorUserId: APPLICANT_ID,
        applicationId: application.application_id,
        decision: 'approve',
        expectedRevision: 0,
        reason: 'Platform owner verified the application',
      }),
    ).resolves.toMatchObject({ state: 'approved', revision: 1 });
  });

  test('submits against the invitation organization and stores exact policy acceptances', async () => {
    const { repository, service } = harness({ organizations: [invitedOrganization()] });

    const submitted = await service.submit({
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Acme Studio',
      policyVersions: POLICIES,
    });

    expect(submitted).toEqual({
      application: expect.objectContaining({
        account_id: ACCOUNT_ID,
        organization_id: ORGANIZATION_ID,
        state: 'submitted',
        revision: 0,
        submitted_at: NOW.toISOString(),
        policy_versions: POLICIES,
      }),
      created: true,
    });
    expect(await repository.listPolicyAcceptances(ACCOUNT_ID, APPLICANT_ID)).toEqual([
      expect.objectContaining({
        policy: 'acceptable_use',
        version: POLICIES.acceptableUse,
        source: 'developer_application',
      }),
      expect.objectContaining({
        policy: 'module_rules',
        version: POLICIES.moduleRules,
        source: 'developer_application',
      }),
    ]);
    expect(await repository.getAuditHistory(submitted.application.application_id)).toEqual([
      expect.objectContaining({
        action: 'developer_application.submitted',
        actor_user_id: APPLICANT_ID,
        from_state: null,
        to_state: { state: 'submitted', revision: 0 },
      }),
    ]);
  });

  test('keeps an identical submission idempotent and rejects stale policy versions', async () => {
    const { repository, service } = harness();
    const input = {
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Acme Studio',
      policyVersions: POLICIES,
    } as const;

    const first = await service.submit(input);
    const replay = await service.submit(input);

    expect(replay).toEqual({ application: first.application, created: false });
    expect(await repository.getAuditHistory(first.application.application_id)).toHaveLength(1);
    await expect(
      service.submit({
        ...input,
        policyVersions: { ...POLICIES, moduleRules: '2026-07-27' },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'DEVELOPER_APPLICATION_POLICY_STALE',
        status: 409,
      }),
    );
  });

  test('revision-fences approval and updates the shared organization verification record', async () => {
    const { repository, service } = harness({ organizations: [invitedOrganization()] });
    const { application } = await service.submit({
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Acme Studio',
      policyVersions: POLICIES,
    });

    const approved = await service.decide({
      actorUserId: ADMIN_ID,
      applicationId: application.application_id,
      decision: 'approve',
      expectedRevision: 0,
      reason: 'Organization identity verified',
    });

    expect(approved).toEqual(
      expect.objectContaining({ state: 'approved', revision: 1, decision_reason: null }),
    );
    expect(await repository.getOrganization(ACCOUNT_ID, ORGANIZATION_ID)).toEqual(
      expect.objectContaining({
        verification_state: 'verified',
        verification_revision: 1,
        verification_changed_by: ADMIN_ID,
      }),
    );
    expect(await repository.getAuditHistory(application.application_id)).toEqual([
      expect.objectContaining({ action: 'developer_application.submitted' }),
      expect.objectContaining({
        action: 'developer_application.approved',
        actor_user_id: ADMIN_ID,
        from_state: { state: 'submitted', revision: 0 },
        to_state: { state: 'approved', revision: 1 },
        metadata: { reason: 'Organization identity verified' },
      }),
    ]);
    await expect(
      service.decide({
        actorUserId: ADMIN_ID,
        applicationId: application.application_id,
        decision: 'reject',
        expectedRevision: 0,
        reason: 'Stale reviewer tab',
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_APPLICATION_CONFLICT', status: 409 });
  });

  test('revision-fences rejection and suspension without disclosing a foreign application', async () => {
    const rejectedHarness = harness();
    const rejectedSubmission = await rejectedHarness.service.submit({
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Rejected Studio',
      policyVersions: POLICIES,
    });
    const rejected = await rejectedHarness.service.decide({
      actorUserId: ADMIN_ID,
      applicationId: rejectedSubmission.application.application_id,
      decision: 'reject',
      expectedRevision: 0,
      reason: 'Verification evidence did not match',
    });
    expect(rejected).toEqual(
      expect.objectContaining({
        state: 'rejected',
        revision: 1,
        decision_reason: 'Verification evidence did not match',
      }),
    );

    await expect(
      rejectedHarness.service.suspend({
        actorUserId: ADMIN_ID,
        applicationId: rejected.application_id,
        expectedRevision: 1,
        reason: 'Not an approved application',
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_APPLICATION_CONFLICT', status: 409 });
    await expect(
      rejectedHarness.service.decide({
        actorUserId: ADMIN_ID,
        applicationId: '90000000-0000-4000-a000-999999999999',
        decision: 'approve',
        expectedRevision: 0,
        reason: 'Should remain opaque',
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_APPLICATION_NOT_FOUND', status: 404 }),
    );

    const approvedHarness = harness();
    const approvedSubmission = await approvedHarness.service.submit({
      actor: { accountId: ACCOUNT_ID, userId: APPLICANT_ID },
      organizationName: 'Approved Studio',
      policyVersions: POLICIES,
    });
    const approved = await approvedHarness.service.decide({
      actorUserId: ADMIN_ID,
      applicationId: approvedSubmission.application.application_id,
      decision: 'approve',
      expectedRevision: 0,
      reason: 'Verified',
    });
    const suspended = await approvedHarness.service.suspend({
      actorUserId: ADMIN_ID,
      applicationId: approved.application_id,
      expectedRevision: 1,
      reason: 'Policy investigation',
    });
    expect(suspended).toEqual(
      expect.objectContaining({
        state: 'suspended',
        revision: 2,
        decision_reason: 'Policy investigation',
      }),
    );
    expect(
      await approvedHarness.repository.getOrganization(
        suspended.account_id,
        suspended.organization_id,
      ),
    ).toEqual(expect.objectContaining({ verification_state: 'suspended' }));
  });

  test('uses a distinct review permission and rejects invalid applicant identity', async () => {
    expect(DEVELOPER_APPLICATION_REVIEW_PERMISSION).toBe('developer.application.review');
    const { service } = harness();
    await expect(
      service.submit({
        actor: { accountId: ACCOUNT_ID, userId: ADMIN_ID },
        organizationName: 'Acme Studio',
        policyVersions: POLICIES,
      }),
    ).rejects.toBeInstanceOf(DeveloperApplicationError);
    await expect(
      service.submit({
        actor: { accountId: ACCOUNT_ID, userId: ADMIN_ID },
        organizationName: 'Acme Studio',
        policyVersions: POLICIES,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_APPLICATION_NOT_FOUND', status: 404 });
  });
});
