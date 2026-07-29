import {
  type Database,
  accountMembers,
  auditEvents,
  developerApplications,
  developerOrganizations,
  policyAcceptances,
} from '@kortix/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type {
  DeveloperApplication,
  DeveloperApplicationAuditEvent,
  DeveloperApplicationMutationFailure,
  DeveloperApplicationRepository,
} from './applications';
import { serializeDeveloperOrganization } from './publishers.drizzle';

type ApplicationRow = typeof developerApplications.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function serializeDeveloperApplication(row: ApplicationRow): DeveloperApplication {
  return {
    application_id: row.applicationId,
    account_id: row.accountId,
    organization_id: row.organizationId,
    state: row.state,
    revision: row.revision,
    policy_versions: structuredClone(row.policyVersions),
    submitted_at: row.submittedAt,
    decided_at: row.decidedAt,
    suspended_at: row.suspendedAt,
    decision_reason: row.decisionReason,
    created_by: row.createdBy,
    updated_by: row.updatedBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

class RepositoryAbort extends Error {
  constructor(readonly reason: DeveloperApplicationMutationFailure) {
    super(reason);
  }
}

function abort(reason: DeveloperApplicationMutationFailure): never {
  throw new RepositoryAbort(reason);
}

function failure(reason: DeveloperApplicationMutationFailure) {
  return { ok: false, reason } as const;
}

function isConstraintFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof record.code === 'string' ? record.code : record.cause?.code;
  return code === '23503' || code === '23505' || code === '23514';
}

function applicationState(row: ApplicationRow) {
  return { state: row.state, revision: row.revision };
}

async function appendAudit(tx: Transaction, event: DeveloperApplicationAuditEvent): Promise<void> {
  await tx.insert(auditEvents).values({
    accountId: event.account_id,
    actorUserId: event.actor_user_id,
    action: event.action,
    resourceType: 'developer_application',
    resourceId: event.application_id,
    before: event.from_state,
    after: event.to_state,
    metadata: event.metadata,
    occurredAt: new Date(event.created_at),
  });
}

export function createDrizzleDeveloperApplicationRepository(
  database: Database,
): DeveloperApplicationRepository {
  const loadApplicationByAccount = async (accountId: string) => {
    const [row] = await database
      .select()
      .from(developerApplications)
      .where(eq(developerApplications.accountId, accountId))
      .limit(1);
    return row;
  };

  const repository: DeveloperApplicationRepository = {
    async submit(command) {
      try {
        return await database.transaction(async (tx) => {
          const [member] = await tx
            .select({ userId: accountMembers.userId })
            .from(accountMembers)
            .where(
              and(
                eq(accountMembers.accountId, command.accountId),
                eq(accountMembers.userId, command.userId),
              ),
            )
            .limit(1);
          if (!member) return failure('not_found');

          let [organization] = await tx
            .select()
            .from(developerOrganizations)
            .where(eq(developerOrganizations.accountId, command.accountId))
            .limit(1)
            .for('update');
          if (organization && organization.name !== command.organizationName) {
            return failure('conflict');
          }
          if (!organization) {
            [organization] = await tx
              .insert(developerOrganizations)
              .values({
                accountId: command.accountId,
                name: command.organizationName,
                verificationState: 'pending',
                verificationMetadata: {},
                verificationRevision: 0,
                createdBy: command.userId,
                createdAt: command.now,
                updatedAt: command.now,
              })
              .returning();
          }
          if (!organization) abort('conflict');

          const [existing] = await tx
            .select()
            .from(developerApplications)
            .where(eq(developerApplications.accountId, command.accountId))
            .limit(1)
            .for('update');
          if (existing) {
            if (
              ['submitted', 'under_review', 'approved'].includes(existing.state) &&
              existing.organizationId === organization.organizationId &&
              existing.policyVersions.moduleRules === command.policyVersions.moduleRules &&
              existing.policyVersions.acceptableUse === command.policyVersions.acceptableUse
            ) {
              return {
                ok: true,
                value: { application: serializeDeveloperApplication(existing), created: false },
              } as const;
            }
            return failure('conflict');
          }

          const [application] = await tx
            .insert(developerApplications)
            .values({
              accountId: command.accountId,
              organizationId: organization.organizationId,
              state: 'submitted',
              revision: 0,
              policyVersions: command.policyVersions,
              submittedAt: command.now,
              decidedAt: null,
              suspendedAt: null,
              decisionReason: null,
              createdBy: command.userId,
              updatedBy: null,
              createdAt: command.now,
              updatedAt: command.now,
            })
            .returning();
          if (!application) abort('conflict');

          await tx
            .insert(policyAcceptances)
            .values([
              {
                accountId: command.accountId,
                userId: command.userId,
                policy: 'acceptable_use',
                version: command.policyVersions.acceptableUse,
                source: 'developer_application',
                acceptedAt: command.now,
                metadata: { application_id: application.applicationId },
              },
              {
                accountId: command.accountId,
                userId: command.userId,
                policy: 'module_rules',
                version: command.policyVersions.moduleRules,
                source: 'developer_application',
                acceptedAt: command.now,
                metadata: { application_id: application.applicationId },
              },
            ])
            .onConflictDoNothing({
              target: [
                policyAcceptances.accountId,
                policyAcceptances.userId,
                policyAcceptances.policy,
                policyAcceptances.version,
              ],
            });
          await appendAudit(tx, {
            action: 'developer_application.submitted',
            account_id: application.accountId,
            application_id: application.applicationId,
            actor_user_id: command.userId,
            from_state: null,
            to_state: applicationState(application),
            metadata: { organization_id: application.organizationId },
            created_at: command.now,
          });
          return {
            ok: true,
            value: { application: serializeDeveloperApplication(application), created: true },
          } as const;
        });
      } catch (error) {
        if (error instanceof RepositoryAbort) return failure(error.reason);
        if (isConstraintFailure(error)) {
          const existing = await loadApplicationByAccount(command.accountId);
          if (
            existing &&
            ['submitted', 'under_review', 'approved'].includes(existing.state) &&
            existing.policyVersions.moduleRules === command.policyVersions.moduleRules &&
            existing.policyVersions.acceptableUse === command.policyVersions.acceptableUse
          ) {
            return {
              ok: true,
              value: { application: serializeDeveloperApplication(existing), created: false },
            };
          }
          return failure('conflict');
        }
        throw error;
      }
    },

    async current(command) {
      const [member] = await database
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(
          and(
            eq(accountMembers.accountId, command.accountId),
            eq(accountMembers.userId, command.userId),
          ),
        )
        .limit(1);
      if (!member) return failure('not_found');
      const application = await loadApplicationByAccount(command.accountId);
      return {
        ok: true,
        value: application ? serializeDeveloperApplication(application) : null,
      };
    },

    async decide(command) {
      try {
        return await database.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(developerApplications)
            .where(eq(developerApplications.applicationId, command.applicationId))
            .limit(1)
            .for('update');
          if (!current) return failure('not_found');
          if (
            current.revision !== command.expectedRevision ||
            !['submitted', 'under_review'].includes(current.state)
          ) {
            return failure('conflict');
          }
          const [organization] = await tx
            .select()
            .from(developerOrganizations)
            .where(
              and(
                eq(developerOrganizations.accountId, current.accountId),
                eq(developerOrganizations.organizationId, current.organizationId),
              ),
            )
            .limit(1)
            .for('update');
          if (!organization) return failure('not_found');
          if (organization.verificationState === 'suspended') return failure('conflict');

          const targetState = command.decision === 'approve' ? 'approved' : 'rejected';
          const targetVerification = command.decision === 'approve' ? 'verified' : 'rejected';
          const [updatedOrganization] = await tx
            .update(developerOrganizations)
            .set({
              verificationState: targetVerification,
              verificationRevision: organization.verificationRevision + 1,
              verificationChangedBy: command.actorUserId,
              verificationChangedAt: command.now,
              updatedAt: command.now,
            })
            .where(
              and(
                eq(developerOrganizations.accountId, current.accountId),
                eq(developerOrganizations.organizationId, current.organizationId),
                eq(developerOrganizations.verificationRevision, organization.verificationRevision),
              ),
            )
            .returning();
          if (!updatedOrganization) abort('conflict');

          const [updated] = await tx
            .update(developerApplications)
            .set({
              state: targetState,
              revision: command.expectedRevision + 1,
              decidedAt: command.now,
              suspendedAt: null,
              decisionReason: command.decision === 'reject' ? command.reason : null,
              updatedBy: command.actorUserId,
              updatedAt: command.now,
            })
            .where(
              and(
                eq(developerApplications.applicationId, command.applicationId),
                eq(developerApplications.revision, command.expectedRevision),
                inArray(developerApplications.state, ['submitted', 'under_review']),
              ),
            )
            .returning();
          if (!updated) abort('conflict');
          await appendAudit(tx, {
            action:
              command.decision === 'approve'
                ? 'developer_application.approved'
                : 'developer_application.rejected',
            account_id: updated.accountId,
            application_id: updated.applicationId,
            actor_user_id: command.actorUserId,
            from_state: applicationState(current),
            to_state: applicationState(updated),
            metadata: { reason: command.reason },
            created_at: command.now,
          });
          return { ok: true, value: serializeDeveloperApplication(updated) } as const;
        });
      } catch (error) {
        if (error instanceof RepositoryAbort) return failure(error.reason);
        if (isConstraintFailure(error)) return failure('conflict');
        throw error;
      }
    },

    async suspend(command) {
      try {
        return await database.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(developerApplications)
            .where(eq(developerApplications.applicationId, command.applicationId))
            .limit(1)
            .for('update');
          if (!current) return failure('not_found');
          if (current.revision !== command.expectedRevision || current.state !== 'approved') {
            return failure('conflict');
          }
          const [organization] = await tx
            .select()
            .from(developerOrganizations)
            .where(
              and(
                eq(developerOrganizations.accountId, current.accountId),
                eq(developerOrganizations.organizationId, current.organizationId),
              ),
            )
            .limit(1)
            .for('update');
          if (!organization) return failure('not_found');

          const [updatedOrganization] = await tx
            .update(developerOrganizations)
            .set({
              verificationState: 'suspended',
              verificationRevision: organization.verificationRevision + 1,
              verificationChangedBy: command.actorUserId,
              verificationChangedAt: command.now,
              updatedAt: command.now,
            })
            .where(
              and(
                eq(developerOrganizations.accountId, current.accountId),
                eq(developerOrganizations.organizationId, current.organizationId),
                eq(developerOrganizations.verificationRevision, organization.verificationRevision),
              ),
            )
            .returning();
          if (!updatedOrganization) abort('conflict');

          const [updated] = await tx
            .update(developerApplications)
            .set({
              state: 'suspended',
              revision: command.expectedRevision + 1,
              suspendedAt: command.now,
              decisionReason: command.reason,
              updatedBy: command.actorUserId,
              updatedAt: command.now,
            })
            .where(
              and(
                eq(developerApplications.applicationId, command.applicationId),
                eq(developerApplications.revision, command.expectedRevision),
                eq(developerApplications.state, 'approved'),
              ),
            )
            .returning();
          if (!updated) abort('conflict');
          await appendAudit(tx, {
            action: 'developer_application.suspended',
            account_id: updated.accountId,
            application_id: updated.applicationId,
            actor_user_id: command.actorUserId,
            from_state: applicationState(current),
            to_state: applicationState(updated),
            metadata: { reason: command.reason },
            created_at: command.now,
          });
          return { ok: true, value: serializeDeveloperApplication(updated) } as const;
        });
      } catch (error) {
        if (error instanceof RepositoryAbort) return failure(error.reason);
        if (isConstraintFailure(error)) return failure('conflict');
        throw error;
      }
    },

    async getOrganization(accountId, organizationId) {
      const [organization] = await database
        .select()
        .from(developerOrganizations)
        .where(
          and(
            eq(developerOrganizations.accountId, accountId),
            eq(developerOrganizations.organizationId, organizationId),
          ),
        )
        .limit(1);
      return organization ? serializeDeveloperOrganization(organization) : null;
    },

    async getAuditHistory(applicationId) {
      const rows = await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceType, 'developer_application'),
            eq(auditEvents.resourceId, applicationId),
            inArray(auditEvents.action, [
              'developer_application.submitted',
              'developer_application.approved',
              'developer_application.rejected',
              'developer_application.suspended',
            ]),
          ),
        )
        .orderBy(asc(auditEvents.occurredAt));
      return rows.map(
        (row) =>
          ({
            action: row.action,
            account_id: row.accountId ?? '',
            application_id: row.resourceId ?? '',
            actor_user_id: row.actorUserId ?? '',
            from_state: row.before as DeveloperApplicationAuditEvent['from_state'],
            to_state: row.after as DeveloperApplicationAuditEvent['to_state'],
            metadata: structuredClone(row.metadata ?? {}),
            created_at: row.occurredAt.toISOString(),
          }) as DeveloperApplicationAuditEvent,
      );
    },

    async listPolicyAcceptances(accountId, userId) {
      const rows = await database
        .select()
        .from(policyAcceptances)
        .where(
          and(
            eq(policyAcceptances.accountId, accountId),
            eq(policyAcceptances.userId, userId),
            eq(policyAcceptances.source, 'developer_application'),
            inArray(policyAcceptances.policy, ['acceptable_use', 'module_rules']),
          ),
        )
        .orderBy(asc(policyAcceptances.policy));
      return rows.map((row) => ({
        account_id: row.accountId,
        user_id: row.userId,
        policy: row.policy as 'acceptable_use' | 'module_rules',
        version: row.version,
        source: 'developer_application' as const,
        accepted_at: row.acceptedAt,
      }));
    },
  };
  return Object.freeze(repository);
}
