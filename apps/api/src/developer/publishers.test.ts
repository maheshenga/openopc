import { describe, expect, test } from 'bun:test';

import type { DeveloperApplicationState } from './applications';
import {
  type DeveloperOrganization,
  type DeveloperPublisher,
  type DeveloperPublisherActor,
  DeveloperPublisherError,
  type DeveloperPublisherMember,
  DeveloperPublisherService,
  createMemoryDeveloperPublisherRepository,
} from './publishers';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000001';
const OWNER_ID = '30000000-0000-4000-a000-000000000001';
const DEVELOPER_ID = '30000000-0000-4000-a000-000000000002';
const ADMIN_ID = '30000000-0000-4000-a000-000000000003';
const NOW = new Date('2026-07-26T02:00:00.000Z');

function organization(
  verificationState: DeveloperOrganization['verification_state'] = 'verified',
): DeveloperOrganization {
  return {
    organization_id: ORGANIZATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Acme Studio',
    verification_state: verificationState,
    verification_metadata: {},
    verification_revision: verificationState === 'pending' ? 0 : 1,
    verification_changed_by: verificationState === 'pending' ? null : ADMIN_ID,
    verification_changed_at: verificationState === 'pending' ? null : NOW.toISOString(),
    created_by: OWNER_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function publisher(status: DeveloperPublisher['status'] = 'active'): DeveloperPublisher {
  return {
    publisher_id: 'acme',
    account_id: ACCOUNT_ID,
    organization_id: ORGANIZATION_ID,
    slug: 'acme',
    display_name: 'Acme',
    status,
    authority_revision: status === 'active' ? 0 : 1,
    suspended_reason: status === 'suspended' ? 'Policy investigation' : null,
    suspended_by: status === 'suspended' ? ADMIN_ID : null,
    suspended_at: status === 'suspended' ? NOW.toISOString() : null,
    created_by: OWNER_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function member(
  userId: string,
  role: DeveloperPublisherMember['role'],
  revision = 0,
): DeveloperPublisherMember {
  return {
    member_id: `40000000-0000-4000-a000-${String(userId === OWNER_ID ? 1 : 2).padStart(12, '0')}`,
    account_id: ACCOUNT_ID,
    publisher_id: 'acme',
    user_id: userId,
    role,
    revision,
    created_by: OWNER_ID,
    created_at: NOW.toISOString(),
    updated_by: null,
    updated_at: NOW.toISOString(),
  };
}

function actor(
  userId = OWNER_ID,
  overrides: Partial<DeveloperPublisherActor> = {},
): DeveloperPublisherActor {
  return {
    accountId: ACCOUNT_ID,
    userId,
    email: `${userId}@example.com`,
    ...overrides,
  };
}

function harness(input?: {
  verificationState?: DeveloperOrganization['verification_state'];
  applicationState?: DeveloperApplicationState;
  publisherStatus?: DeveloperPublisher['status'];
  members?: DeveloperPublisherMember[];
}) {
  let id = 10;
  const repository = createMemoryDeveloperPublisherRepository({
    organizations: [organization(input?.verificationState)],
    applicationStates: [
      {
        accountId: ACCOUNT_ID,
        organizationId: ORGANIZATION_ID,
        state: input?.applicationState ?? 'approved',
      },
    ],
    publishers: [publisher(input?.publisherStatus)],
    members: input?.members ?? [member(OWNER_ID, 'owner')],
    createId: () => `90000000-0000-4000-a000-${String(++id).padStart(12, '0')}`,
  });
  return {
    repository,
    service: new DeveloperPublisherService({
      repository,
      now: () => NOW,
      createToken: () => 'one-time-invitation-token',
    }),
  };
}

describe('DeveloperPublisherService', () => {
  test('hashes one-time invitations and accepts only the invited account identity', async () => {
    const repository = createMemoryDeveloperPublisherRepository({
      createId: (() => {
        let id = 0;
        return () => `90000000-0000-4000-a000-${String(++id).padStart(12, '0')}`;
      })(),
    });
    const service = new DeveloperPublisherService({
      repository,
      now: () => NOW,
      createToken: () => 'one-time-invitation-token',
    });
    const admin = actor(ADMIN_ID, { platformAdmin: true });
    const invited = await service.invite({
      actor: admin,
      accountId: ACCOUNT_ID,
      organizationName: 'Acme Studio',
      email: 'Developer@Example.com',
    });

    expect(invited.token).toBe('one-time-invitation-token');
    expect(invited.invitation).toEqual(
      expect.objectContaining({ email: 'developer@example.com', state: 'pending' }),
    );
    expect(JSON.stringify(invited.invitation)).not.toMatch(/token_hash|one-time-invitation-token/);

    await expect(
      service.acceptInvitation(invited.token, actor(DEVELOPER_ID, { email: 'other@example.com' })),
    ).rejects.toMatchObject({ code: 'DEVELOPER_INVITATION_INVALID', status: 404 });
    await expect(
      service.acceptInvitation(
        invited.token,
        actor(DEVELOPER_ID, { email: 'developer@example.com' }),
      ),
    ).resolves.toEqual(expect.objectContaining({ state: 'accepted', accepted_by: DEVELOPER_ID }));
  });

  test('unverified organization cannot create a Publisher or upload', async () => {
    const { service } = harness({ verificationState: 'pending' });

    await expect(
      service.createPublisher({
        actor: actor(),
        organizationId: ORGANIZATION_ID,
        slug: 'new-publisher',
        displayName: 'New Publisher',
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_REQUIRED', status: 403 });
    await expect(service.requirePermission('acme', actor(), 'upload')).rejects.toMatchObject({
      code: 'DEVELOPER_VERIFICATION_REQUIRED',
      status: 403,
    });
  });

  test('verified organization cannot create a Publisher before its application is approved', async () => {
    const { service } = harness({ applicationState: 'submitted' });

    await expect(
      service.createPublisher({
        actor: actor(),
        organizationId: ORGANIZATION_ID,
        slug: 'new-publisher',
        displayName: 'New Publisher',
      }),
    ).rejects.toMatchObject({
      code: 'DEVELOPER_APPLICATION_APPROVAL_REQUIRED',
      status: 403,
    });
  });

  test('creates a verified Publisher with its first owner and immutable audit history', async () => {
    const repository = createMemoryDeveloperPublisherRepository({
      organizations: [organization()],
      applicationStates: [
        { accountId: ACCOUNT_ID, organizationId: ORGANIZATION_ID, state: 'approved' },
      ],
    });
    const service = new DeveloperPublisherService({ repository, now: () => NOW });

    const authority = await service.createPublisher({
      actor: actor(),
      organizationId: ORGANIZATION_ID,
      slug: 'ACME-LABS',
      displayName: 'Acme Labs',
    });

    expect(authority).toEqual({
      publisher: expect.objectContaining({ publisher_id: 'acme-labs', authority_revision: 0 }),
      organization: expect.objectContaining({ verification_state: 'verified' }),
      member: expect.objectContaining({ user_id: OWNER_ID, role: 'owner', revision: 0 }),
    });
    await expect(
      service.auditHistory({ actor: actor(), publisherId: 'acme-labs' }),
    ).resolves.toEqual([
      expect.objectContaining({ action: 'publisher_created', actor_user_id: OWNER_ID }),
    ]);
  });

  test('enforces the owner, developer, release, finance, and support role matrix', async () => {
    const financeId = '30000000-0000-4000-a000-000000000004';
    const supportId = '30000000-0000-4000-a000-000000000005';
    const releaseId = '30000000-0000-4000-a000-000000000006';
    const { service } = harness({
      members: [
        member(OWNER_ID, 'owner'),
        member(DEVELOPER_ID, 'developer'),
        member(financeId, 'finance_viewer'),
        member(supportId, 'support_viewer'),
        member(releaseId, 'release_manager'),
      ],
    });

    await expect(
      service.requirePermission('acme', actor(DEVELOPER_ID), 'upload'),
    ).resolves.toBeDefined();
    await expect(
      service.requirePermission('acme', actor(DEVELOPER_ID), 'release'),
    ).rejects.toMatchObject({
      code: 'DEVELOPER_PUBLISHER_FORBIDDEN',
    });
    await expect(
      service.requirePermission('acme', actor(releaseId), 'release'),
    ).resolves.toBeDefined();
    await expect(
      service.requirePermission('acme', actor(financeId), 'finance'),
    ).resolves.toBeDefined();
    await expect(
      service.requirePermission('acme', actor(supportId), 'support'),
    ).resolves.toBeDefined();
    await expect(
      service.requirePermission('acme', actor(OWNER_ID), 'finance'),
    ).resolves.toBeDefined();
  });

  test('uses member revisions and never permits demotion of the sole owner', async () => {
    const { service } = harness();

    await expect(
      service.setMemberRole({
        actor: actor(),
        publisherId: 'acme',
        userId: DEVELOPER_ID,
        role: 'developer',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_AUTHORITY_CONFLICT', status: 409 });
    await expect(
      service.setMemberRole({
        actor: actor(),
        publisherId: 'acme',
        userId: DEVELOPER_ID,
        role: 'developer',
        expectedRevision: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ revision: 0, role: 'developer' }));
    await expect(
      service.setMemberRole({
        actor: actor(),
        publisherId: 'acme',
        userId: OWNER_ID,
        role: 'developer',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_AUTHORITY_CONFLICT', status: 409 });
  });

  test('suspension blocks new actions while preserving historical reads', async () => {
    const { service } = harness();
    const admin = actor(ADMIN_ID, { platformAdmin: true });

    await service.suspend({
      actor: admin,
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      reason: 'Policy investigation',
      expectedRevision: 0,
    });

    await expect(service.requirePermission('acme', actor(), 'release')).rejects.toMatchObject({
      code: 'DEVELOPER_PUBLISHER_SUSPENDED',
      status: 409,
    });
    expect(await service.auditHistory({ actor: actor(), publisherId: 'acme' })).not.toHaveLength(0);
    await expect(
      service.reinstate({
        actor: admin,
        accountId: ACCOUNT_ID,
        publisherId: 'acme',
        expectedRevision: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'active', authority_revision: 2 }));
  });

  test('allows a platform administrator to review their own Publisher and denies a non-admin member', async () => {
    const { service } = harness();

    await expect(
      service.requirePermission(
        'acme',
        actor(OWNER_ID, { platformAdmin: true }),
        'platform_review',
      ),
    ).resolves.toMatchObject({
      member: expect.objectContaining({ user_id: OWNER_ID, role: 'owner' }),
    });
    await expect(
      service.requirePermission('acme', actor(OWNER_ID), 'platform_review'),
    ).rejects.toMatchObject({
      code: 'DEVELOPER_PUBLISHER_FORBIDDEN',
      status: 403,
    });
  });

  test('cross-tenant authority probes remain opaque', async () => {
    const { service } = harness();

    await expect(
      service.requirePermission('acme', actor(OWNER_ID, { accountId: OTHER_ACCOUNT_ID }), 'upload'),
    ).rejects.toBeInstanceOf(DeveloperPublisherError);
    await expect(
      service.requirePermission('acme', actor(OWNER_ID, { accountId: OTHER_ACCOUNT_ID }), 'upload'),
    ).rejects.toMatchObject({ code: 'DEVELOPER_PUBLISHER_NOT_FOUND', status: 404 });
  });
});
