import {
  type Database,
  developerApplications,
  developerInvitations,
  developerOrganizations,
  developerPublisherAuditEvents,
  developerPublisherMembers,
  developerPublishers,
} from '@kortix/db';
import { and, asc, eq } from 'drizzle-orm';

import type {
  DeveloperAccess,
  DeveloperInvitation,
  DeveloperOrganization,
  DeveloperPublisher,
  DeveloperPublisherAuditEvent,
  DeveloperPublisherAuthority,
  DeveloperPublisherMember,
  DeveloperPublisherMutation,
  DeveloperPublisherMutationFailure,
  DeveloperPublisherRepository,
} from './publishers';

type InvitationRow = typeof developerInvitations.$inferSelect;
type OrganizationRow = typeof developerOrganizations.$inferSelect;
type PublisherRow = typeof developerPublishers.$inferSelect;
type MemberRow = typeof developerPublisherMembers.$inferSelect;
type AuditRow = typeof developerPublisherAuditEvents.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function serializeDeveloperInvitation(row: InvitationRow): DeveloperInvitation {
  return {
    invitation_id: row.invitationId,
    account_id: row.accountId,
    organization_id: row.organizationId,
    email: row.email,
    state: row.state,
    expires_at: row.expiresAt,
    accepted_by: row.acceptedBy,
    accepted_at: row.acceptedAt,
    revoked_by: row.revokedBy,
    revoked_at: row.revokedAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

export function serializeDeveloperOrganization(row: OrganizationRow): DeveloperOrganization {
  return {
    organization_id: row.organizationId,
    account_id: row.accountId,
    name: row.name,
    verification_state: row.verificationState,
    verification_metadata: structuredClone(row.verificationMetadata),
    verification_revision: row.verificationRevision,
    verification_changed_by: row.verificationChangedBy,
    verification_changed_at: row.verificationChangedAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeDeveloperPublisher(row: PublisherRow): DeveloperPublisher {
  return {
    publisher_id: row.publisherId,
    account_id: row.accountId,
    organization_id: row.organizationId,
    slug: row.slug,
    display_name: row.displayName,
    status: row.status,
    authority_revision: row.authorityRevision,
    suspended_reason: row.suspendedReason,
    suspended_by: row.suspendedBy,
    suspended_at: row.suspendedAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeDeveloperPublisherMember(row: MemberRow): DeveloperPublisherMember {
  return {
    member_id: row.memberId,
    account_id: row.accountId,
    publisher_id: row.publisherId,
    user_id: row.userId,
    role: row.role,
    revision: row.revision,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_by: row.updatedBy,
    updated_at: row.updatedAt,
  };
}

export function serializeDeveloperPublisherAuditEvent(row: AuditRow): DeveloperPublisherAuditEvent {
  return {
    event_id: row.eventId,
    account_id: row.accountId,
    organization_id: row.organizationId,
    publisher_id: row.publisherId,
    invitation_id: row.invitationId,
    action: row.action,
    actor_user_id: row.actorUserId,
    subject_user_id: row.subjectUserId,
    from_state: row.fromState ? structuredClone(row.fromState) : null,
    to_state: row.toState ? structuredClone(row.toState) : null,
    metadata: structuredClone(row.metadata),
    created_at: row.createdAt,
  };
}

function failure<T>(reason: DeveloperPublisherMutationFailure): DeveloperPublisherMutation<T> {
  return { ok: false, reason };
}

function isConstraintFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  const code = candidate.code ?? candidate.cause?.code;
  return code === '23505' || code === '23514' || code === '23503';
}

async function appendAudit(
  tx: Transaction,
  input: Omit<typeof developerPublisherAuditEvents.$inferInsert, 'eventId' | 'createdAt'> & {
    createdAt: string;
  },
): Promise<void> {
  await tx.insert(developerPublisherAuditEvents).values(input);
}

async function findOrganization(
  tx: Transaction,
  accountId: string,
  organizationId?: string,
): Promise<OrganizationRow | null> {
  const conditions = [eq(developerOrganizations.accountId, accountId)];
  if (organizationId) conditions.push(eq(developerOrganizations.organizationId, organizationId));
  const [row] = await tx
    .select()
    .from(developerOrganizations)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

export function createDrizzleDeveloperPublisherRepository(
  db: Database,
): DeveloperPublisherRepository {
  return {
    async getAccess({ accountId, userId, email }): Promise<DeveloperAccess> {
      const [organizationRows, invitationRows, publisherRows] = await Promise.all([
        db
          .select()
          .from(developerOrganizations)
          .where(eq(developerOrganizations.accountId, accountId))
          .limit(1),
        email
          ? db
              .select()
              .from(developerInvitations)
              .where(
                and(
                  eq(developerInvitations.accountId, accountId),
                  eq(developerInvitations.email, email),
                  eq(developerInvitations.state, 'pending'),
                ),
              )
              .orderBy(asc(developerInvitations.createdAt))
          : Promise.resolve([] as InvitationRow[]),
        db
          .select({ publisher: developerPublishers, member: developerPublisherMembers })
          .from(developerPublishers)
          .leftJoin(
            developerPublisherMembers,
            and(
              eq(developerPublisherMembers.accountId, developerPublishers.accountId),
              eq(developerPublisherMembers.publisherId, developerPublishers.publisherId),
              eq(developerPublisherMembers.userId, userId),
            ),
          )
          .where(eq(developerPublishers.accountId, accountId))
          .orderBy(asc(developerPublishers.slug)),
      ]);
      return {
        account_id: accountId,
        user_id: userId,
        organization: organizationRows[0]
          ? serializeDeveloperOrganization(organizationRows[0])
          : null,
        invitations: invitationRows.map(serializeDeveloperInvitation),
        publishers: publisherRows.map((row) => ({
          publisher: serializeDeveloperPublisher(row.publisher),
          membership: row.member ? serializeDeveloperPublisherMember(row.member) : null,
        })),
      };
    },

    async createInvitation(command) {
      try {
        return await db.transaction(async (tx) => {
          let organization = await findOrganization(tx, command.accountId, command.organizationId);
          if (!organization && command.organizationId) return failure('not_found');
          if (!organization) {
            const [created] = await tx
              .insert(developerOrganizations)
              .values({
                accountId: command.accountId,
                name: command.organizationName,
                verificationState: 'pending',
                verificationMetadata: {},
                verificationRevision: 0,
                createdBy: command.actorUserId,
                createdAt: command.now,
                updatedAt: command.now,
              })
              .returning();
            if (!created) return failure('conflict');
            organization = created;
            await appendAudit(tx, {
              accountId: command.accountId,
              organizationId: created.organizationId,
              publisherId: null,
              invitationId: null,
              action: 'organization_created',
              actorUserId: command.actorUserId,
              subjectUserId: null,
              fromState: null,
              toState: { verification_state: 'pending', verification_revision: 0 },
              metadata: {},
              createdAt: command.now,
            });
          }
          const [invitation] = await tx
            .insert(developerInvitations)
            .values({
              accountId: command.accountId,
              organizationId: organization.organizationId,
              email: command.email,
              tokenHash: command.tokenHash,
              state: 'pending',
              expiresAt: command.expiresAt,
              createdBy: command.actorUserId,
              createdAt: command.now,
            })
            .returning();
          if (!invitation) return failure('conflict');
          await appendAudit(tx, {
            accountId: command.accountId,
            organizationId: organization.organizationId,
            publisherId: null,
            invitationId: invitation.invitationId,
            action: 'invitation_created',
            actorUserId: command.actorUserId,
            subjectUserId: null,
            fromState: null,
            toState: { state: 'pending' },
            metadata: { email: command.email },
            createdAt: command.now,
          });
          return { ok: true, value: serializeDeveloperInvitation(invitation) } as const;
        });
      } catch (error) {
        if (isConstraintFailure(error)) return failure('conflict');
        throw error;
      }
    },

    async acceptInvitation(command) {
      return db.transaction(async (tx) => {
        const [invitation] = await tx
          .select()
          .from(developerInvitations)
          .where(
            and(
              eq(developerInvitations.accountId, command.accountId),
              eq(developerInvitations.tokenHash, command.tokenHash),
            ),
          )
          .limit(1)
          .for('update');
        if (!invitation) return failure('not_found');
        if (invitation.email !== command.email) return failure('email_mismatch');
        if (invitation.state === 'accepted' && invitation.acceptedBy === command.userId) {
          return { ok: true, value: serializeDeveloperInvitation(invitation) } as const;
        }
        if (invitation.state !== 'pending') return failure('conflict');
        if (Date.parse(invitation.expiresAt) <= Date.parse(command.now)) {
          await tx
            .update(developerInvitations)
            .set({ state: 'expired' })
            .where(
              and(
                eq(developerInvitations.invitationId, invitation.invitationId),
                eq(developerInvitations.state, 'pending'),
              ),
            );
          await appendAudit(tx, {
            accountId: invitation.accountId,
            organizationId: invitation.organizationId,
            publisherId: null,
            invitationId: invitation.invitationId,
            action: 'invitation_expired',
            actorUserId: command.userId,
            subjectUserId: command.userId,
            fromState: { state: 'pending' },
            toState: { state: 'expired' },
            metadata: {},
            createdAt: command.now,
          });
          return failure('expired');
        }
        const [accepted] = await tx
          .update(developerInvitations)
          .set({ state: 'accepted', acceptedBy: command.userId, acceptedAt: command.now })
          .where(
            and(
              eq(developerInvitations.invitationId, invitation.invitationId),
              eq(developerInvitations.accountId, command.accountId),
              eq(developerInvitations.state, 'pending'),
            ),
          )
          .returning();
        if (!accepted) return failure('conflict');
        await appendAudit(tx, {
          accountId: accepted.accountId,
          organizationId: accepted.organizationId,
          publisherId: null,
          invitationId: accepted.invitationId,
          action: 'invitation_accepted',
          actorUserId: command.userId,
          subjectUserId: command.userId,
          fromState: { state: 'pending' },
          toState: { state: 'accepted' },
          metadata: {},
          createdAt: command.now,
        });
        return { ok: true, value: serializeDeveloperInvitation(accepted) } as const;
      });
    },

    async setVerification(command) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(developerOrganizations)
          .where(
            and(
              eq(developerOrganizations.accountId, command.accountId),
              eq(developerOrganizations.organizationId, command.organizationId),
            ),
          )
          .limit(1);
        if (!current) return failure('not_found');
        const [updated] = await tx
          .update(developerOrganizations)
          .set({
            verificationState: command.state,
            verificationMetadata: command.metadata,
            verificationRevision: command.expectedRevision + 1,
            verificationChangedBy: command.actorUserId,
            verificationChangedAt: command.now,
            updatedAt: command.now,
          })
          .where(
            and(
              eq(developerOrganizations.accountId, command.accountId),
              eq(developerOrganizations.organizationId, command.organizationId),
              eq(developerOrganizations.verificationRevision, command.expectedRevision),
            ),
          )
          .returning();
        if (!updated) return failure('conflict');
        await appendAudit(tx, {
          accountId: command.accountId,
          organizationId: command.organizationId,
          publisherId: null,
          invitationId: null,
          action: 'organization_verification_changed',
          actorUserId: command.actorUserId,
          subjectUserId: null,
          fromState: {
            verification_state: current.verificationState,
            verification_revision: current.verificationRevision,
          },
          toState: {
            verification_state: updated.verificationState,
            verification_revision: updated.verificationRevision,
          },
          metadata: command.metadata,
          createdAt: command.now,
        });
        return { ok: true, value: serializeDeveloperOrganization(updated) } as const;
      });
    },

    async createPublisher(command) {
      try {
        return await db.transaction(async (tx) => {
          const organization = await findOrganization(
            tx,
            command.accountId,
            command.organizationId,
          );
          if (!organization) return failure('not_found');
          if (organization.verificationState !== 'verified') {
            return failure('verification_required');
          }
          const [application] = await tx
            .select({ applicationId: developerApplications.applicationId })
            .from(developerApplications)
            .where(
              and(
                eq(developerApplications.accountId, command.accountId),
                eq(developerApplications.organizationId, command.organizationId),
                eq(developerApplications.state, 'approved'),
              ),
            )
            .limit(1);
          if (!application) return failure('application_required');
          const [publisher] = await tx
            .insert(developerPublishers)
            .values({
              publisherId: command.slug,
              accountId: command.accountId,
              organizationId: command.organizationId,
              slug: command.slug,
              displayName: command.displayName,
              status: 'active',
              authorityRevision: 0,
              createdBy: command.actorUserId,
              createdAt: command.now,
              updatedAt: command.now,
            })
            .returning();
          if (!publisher) return failure('conflict');
          const [member] = await tx
            .insert(developerPublisherMembers)
            .values({
              accountId: command.accountId,
              publisherId: publisher.publisherId,
              userId: command.actorUserId,
              role: 'owner',
              revision: 0,
              createdBy: command.actorUserId,
              createdAt: command.now,
              updatedAt: command.now,
            })
            .returning();
          if (!member) return failure('conflict');
          await appendAudit(tx, {
            accountId: command.accountId,
            organizationId: command.organizationId,
            publisherId: publisher.publisherId,
            invitationId: null,
            action: 'publisher_created',
            actorUserId: command.actorUserId,
            subjectUserId: command.actorUserId,
            fromState: null,
            toState: { status: 'active', authority_revision: 0, owner: command.actorUserId },
            metadata: {},
            createdAt: command.now,
          });
          return {
            ok: true,
            value: {
              publisher: serializeDeveloperPublisher(publisher),
              organization: serializeDeveloperOrganization(organization),
              member: serializeDeveloperPublisherMember(member),
            },
          } as const;
        });
      } catch (error) {
        if (isConstraintFailure(error)) return failure('conflict');
        throw error;
      }
    },

    async listPublishers(accountId) {
      const rows = await db
        .select()
        .from(developerPublishers)
        .where(eq(developerPublishers.accountId, accountId))
        .orderBy(asc(developerPublishers.slug));
      return rows.map(serializeDeveloperPublisher);
    },

    async getAuthority({ accountId, publisherId, userId }) {
      const [row] = await db
        .select({
          publisher: developerPublishers,
          organization: developerOrganizations,
          member: developerPublisherMembers,
        })
        .from(developerPublishers)
        .innerJoin(
          developerOrganizations,
          and(
            eq(developerOrganizations.accountId, developerPublishers.accountId),
            eq(developerOrganizations.organizationId, developerPublishers.organizationId),
          ),
        )
        .leftJoin(
          developerPublisherMembers,
          and(
            eq(developerPublisherMembers.accountId, developerPublishers.accountId),
            eq(developerPublisherMembers.publisherId, developerPublishers.publisherId),
            eq(developerPublisherMembers.userId, userId),
          ),
        )
        .where(
          and(
            eq(developerPublishers.accountId, accountId),
            eq(developerPublishers.publisherId, publisherId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        publisher: serializeDeveloperPublisher(row.publisher),
        organization: serializeDeveloperOrganization(row.organization),
        member: row.member ? serializeDeveloperPublisherMember(row.member) : null,
      } satisfies DeveloperPublisherAuthority;
    },

    async setMemberRole(command) {
      try {
        return await db.transaction(async (tx) => {
          const [publisher] = await tx
            .select()
            .from(developerPublishers)
            .where(
              and(
                eq(developerPublishers.accountId, command.accountId),
                eq(developerPublishers.publisherId, command.publisherId),
              ),
            )
            .limit(1);
          if (!publisher) return failure('not_found');
          const [actorMember] = await tx
            .select()
            .from(developerPublisherMembers)
            .where(
              and(
                eq(developerPublisherMembers.accountId, command.accountId),
                eq(developerPublisherMembers.publisherId, command.publisherId),
                eq(developerPublisherMembers.userId, command.actorUserId),
                eq(developerPublisherMembers.role, 'owner'),
              ),
            )
            .limit(1);
          if (!actorMember) return failure('forbidden');
          const [current] = await tx
            .select()
            .from(developerPublisherMembers)
            .where(
              and(
                eq(developerPublisherMembers.accountId, command.accountId),
                eq(developerPublisherMembers.publisherId, command.publisherId),
                eq(developerPublisherMembers.userId, command.userId),
              ),
            )
            .limit(1);
          let member: MemberRow | undefined;
          if (current) {
            if (current.revision !== command.expectedRevision) return failure('conflict');
            if (current.role === 'owner' && command.role !== 'owner') {
              const owners = await tx
                .select({ memberId: developerPublisherMembers.memberId })
                .from(developerPublisherMembers)
                .where(
                  and(
                    eq(developerPublisherMembers.accountId, command.accountId),
                    eq(developerPublisherMembers.publisherId, command.publisherId),
                    eq(developerPublisherMembers.role, 'owner'),
                  ),
                );
              if (owners.length <= 1) return failure('conflict');
            }
            [member] = await tx
              .update(developerPublisherMembers)
              .set({
                role: command.role,
                revision: command.expectedRevision + 1,
                updatedBy: command.actorUserId,
                updatedAt: command.now,
              })
              .where(
                and(
                  eq(developerPublisherMembers.memberId, current.memberId),
                  eq(developerPublisherMembers.accountId, command.accountId),
                  eq(developerPublisherMembers.revision, command.expectedRevision),
                ),
              )
              .returning();
          } else {
            if (command.expectedRevision !== null) return failure('conflict');
            [member] = await tx
              .insert(developerPublisherMembers)
              .values({
                accountId: command.accountId,
                publisherId: command.publisherId,
                userId: command.userId,
                role: command.role,
                revision: 0,
                createdBy: command.actorUserId,
                createdAt: command.now,
                updatedAt: command.now,
              })
              .returning();
          }
          if (!member) return failure('conflict');
          await appendAudit(tx, {
            accountId: command.accountId,
            organizationId: publisher.organizationId,
            publisherId: command.publisherId,
            invitationId: null,
            action: current ? 'publisher_member_role_changed' : 'publisher_member_added',
            actorUserId: command.actorUserId,
            subjectUserId: command.userId,
            fromState: current ? { role: current.role, revision: current.revision } : null,
            toState: { role: member.role, revision: member.revision },
            metadata: {},
            createdAt: command.now,
          });
          return { ok: true, value: serializeDeveloperPublisherMember(member) } as const;
        });
      } catch (error) {
        if (isConstraintFailure(error)) return failure('conflict');
        throw error;
      }
    },

    async setPublisherStatus(command) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(developerPublishers)
          .where(
            and(
              eq(developerPublishers.accountId, command.accountId),
              eq(developerPublishers.publisherId, command.publisherId),
            ),
          )
          .limit(1);
        if (!current) return failure('not_found');
        const [updated] = await tx
          .update(developerPublishers)
          .set({
            status: command.status,
            authorityRevision: command.expectedRevision + 1,
            suspendedReason: command.status === 'suspended' ? command.reason : null,
            suspendedBy: command.status === 'suspended' ? command.actorUserId : null,
            suspendedAt: command.status === 'suspended' ? command.now : null,
            updatedAt: command.now,
          })
          .where(
            and(
              eq(developerPublishers.accountId, command.accountId),
              eq(developerPublishers.publisherId, command.publisherId),
              eq(developerPublishers.authorityRevision, command.expectedRevision),
            ),
          )
          .returning();
        if (!updated) return failure('conflict');
        await appendAudit(tx, {
          accountId: command.accountId,
          organizationId: updated.organizationId,
          publisherId: updated.publisherId,
          invitationId: null,
          action: command.status === 'suspended' ? 'publisher_suspended' : 'publisher_reinstated',
          actorUserId: command.actorUserId,
          subjectUserId: null,
          fromState: { status: current.status, authority_revision: current.authorityRevision },
          toState: { status: updated.status, authority_revision: updated.authorityRevision },
          metadata: command.reason ? { reason: command.reason } : {},
          createdAt: command.now,
        });
        return { ok: true, value: serializeDeveloperPublisher(updated) } as const;
      });
    },

    async getAuditHistory(accountId, publisherId) {
      const rows = await db
        .select()
        .from(developerPublisherAuditEvents)
        .where(
          and(
            eq(developerPublisherAuditEvents.accountId, accountId),
            eq(developerPublisherAuditEvents.publisherId, publisherId),
          ),
        )
        .orderBy(asc(developerPublisherAuditEvents.createdAt));
      return rows.map(serializeDeveloperPublisherAuditEvent);
    },
  };
}
