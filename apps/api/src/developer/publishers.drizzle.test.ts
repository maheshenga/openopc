import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type Database,
  developerOrganizations,
  developerPublisherMembers,
  developerPublishers,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  createDrizzleDeveloperPublisherRepository,
  serializeDeveloperInvitation,
  serializeDeveloperOrganization,
  serializeDeveloperPublisher,
  serializeDeveloperPublisherAuditEvent,
  serializeDeveloperPublisherMember,
} from './publishers.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000002';
const USER_ID = '30000000-0000-4000-a000-000000000003';
const NOW = '2026-07-26T02:00:00.000Z';

const organizationRow = {
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  name: 'Acme Studio',
  verificationState: 'verified' as const,
  verificationMetadata: { source: 'manual' },
  verificationRevision: 1,
  verificationChangedBy: USER_ID,
  verificationChangedAt: NOW,
  createdBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

const publisherRow = {
  publisherId: 'acme',
  accountId: ACCOUNT_ID,
  organizationId: ORGANIZATION_ID,
  slug: 'acme',
  displayName: 'Acme',
  status: 'active' as const,
  authorityRevision: 0,
  suspendedReason: null,
  suspendedBy: null,
  suspendedAt: null,
  createdBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

const memberRow = {
  memberId: '40000000-0000-4000-a000-000000000004',
  accountId: ACCOUNT_ID,
  publisherId: 'acme',
  userId: USER_ID,
  role: 'owner' as const,
  revision: 0,
  createdBy: USER_ID,
  createdAt: NOW,
  updatedBy: null,
  updatedAt: NOW,
};

function conditionParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('developer Publisher Drizzle repository', () => {
  test('serializes authority records without exposing invitation token hashes', () => {
    const invitation = serializeDeveloperInvitation({
      invitationId: '50000000-0000-4000-a000-000000000005',
      accountId: ACCOUNT_ID,
      organizationId: ORGANIZATION_ID,
      email: 'developer@example.com',
      tokenHash: 'a'.repeat(64),
      state: 'pending',
      expiresAt: '2026-08-02T02:00:00.000Z',
      acceptedBy: null,
      acceptedAt: null,
      revokedBy: null,
      revokedAt: null,
      createdBy: USER_ID,
      createdAt: NOW,
    });
    const organization = serializeDeveloperOrganization(organizationRow);
    const publisher = serializeDeveloperPublisher(publisherRow);
    const member = serializeDeveloperPublisherMember(memberRow);
    const audit = serializeDeveloperPublisherAuditEvent({
      eventId: '60000000-0000-4000-a000-000000000006',
      accountId: ACCOUNT_ID,
      organizationId: ORGANIZATION_ID,
      publisherId: 'acme',
      invitationId: null,
      action: 'publisher_created',
      actorUserId: USER_ID,
      subjectUserId: USER_ID,
      fromState: null,
      toState: { status: 'active' },
      metadata: {},
      createdAt: NOW,
    });

    expect(invitation).not.toHaveProperty('token_hash');
    expect(organization).toEqual(expect.objectContaining({ verification_revision: 1 }));
    expect(publisher).toEqual(expect.objectContaining({ slug: 'acme', authority_revision: 0 }));
    expect(member).toEqual(expect.objectContaining({ role: 'owner', revision: 0 }));
    expect(audit).toEqual(expect.objectContaining({ action: 'publisher_created' }));
  });

  test('loads authority with account, Publisher, organization, and actor membership fences', async () => {
    const records: Array<{ kind: 'inner' | 'left' | 'where'; condition: unknown }> = [];
    const database = {
      select() {
        return {
          from(table: unknown) {
            expect(table).toBe(developerPublishers);
            return {
              innerJoin(table: unknown, condition: unknown) {
                expect(table).toBe(developerOrganizations);
                records.push({ kind: 'inner', condition });
                return {
                  leftJoin(memberTable: unknown, memberCondition: unknown) {
                    expect(memberTable).toBe(developerPublisherMembers);
                    records.push({ kind: 'left', condition: memberCondition });
                    return {
                      where(whereCondition: unknown) {
                        records.push({ kind: 'where', condition: whereCondition });
                        return {
                          async limit() {
                            return [
                              {
                                publisher: publisherRow,
                                organization: organizationRow,
                                member: memberRow,
                              },
                            ];
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperPublisherRepository(database);

    await expect(
      repository.getAuthority({ accountId: ACCOUNT_ID, publisherId: 'acme', userId: USER_ID }),
    ).resolves.toEqual({
      publisher: expect.objectContaining({ account_id: ACCOUNT_ID, publisher_id: 'acme' }),
      organization: expect.objectContaining({ organization_id: ORGANIZATION_ID }),
      member: expect.objectContaining({ user_id: USER_ID, role: 'owner' }),
    });

    const parameters = records.flatMap((record) => conditionParams(record.condition));
    expect(parameters).toEqual(expect.arrayContaining([ACCOUNT_ID, 'acme', USER_ID]));
  });

  test('keeps every authority transition transactional, revision-fenced, and audit-appending', () => {
    const source = readFileSync(new URL('./publishers.drizzle.ts', import.meta.url), 'utf8');

    expect(source.match(/db\.transaction/g)?.length).toBeGreaterThanOrEqual(5);
    expect(source).toContain('developerOrganizations.verificationRevision');
    expect(source).toContain('developerPublisherMembers.revision');
    expect(source).toContain('developerPublishers.authorityRevision');
    expect(source).toContain('appendAudit(tx');
    expect(source).toContain('eq(developerPublishers.accountId, command.accountId)');
  });
});
