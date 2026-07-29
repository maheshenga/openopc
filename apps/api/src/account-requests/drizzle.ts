import {
  type Database,
  accountMembers,
  accountRequests,
  projectModuleInstallations,
} from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { AccountRequestRecord, AccountRequestRepository } from './service';

type AccountRequestRow = typeof accountRequests.$inferSelect;

function mapRow(row: AccountRequestRow): AccountRequestRecord {
  return {
    requestId: row.requestId,
    accountId: row.accountId,
    requestedBy: row.requestedBy,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    moduleInstallationId: row.moduleInstallationId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    requestedAt: row.requestedAt,
    notBeforeAt: row.notBeforeAt,
    processingStartedAt: row.processingStartedAt,
    terminalAt: row.terminalAt,
    expiresAt: row.expiresAt,
    resultMetadata: (row.resultMetadata ?? {}) as Record<string, unknown>,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleAccountRequestRepository(
  database: Database,
): AccountRequestRepository {
  const repository: AccountRequestRepository = {
    async isMember(accountId, userId) {
      const [member] = await database
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
        .limit(1);
      return Boolean(member);
    },

    async moduleInstallationBelongsToAccount(accountId, installationId) {
      const [installation] = await database
        .select({ installationId: projectModuleInstallations.installationId })
        .from(projectModuleInstallations)
        .where(
          and(
            eq(projectModuleInstallations.accountId, accountId),
            eq(projectModuleInstallations.installationId, installationId),
          ),
        )
        .limit(1);
      return Boolean(installation);
    },

    async createIdempotent(record) {
      const [inserted] = await database
        .insert(accountRequests)
        .values(record)
        .onConflictDoNothing({
          target: [
            accountRequests.accountId,
            accountRequests.requestedBy,
            accountRequests.idempotencyKey,
          ],
        })
        .returning();
      if (inserted) return { record: mapRow(inserted), created: true };

      const [existing] = await database
        .select()
        .from(accountRequests)
        .where(
          and(
            eq(accountRequests.accountId, record.accountId),
            eq(accountRequests.requestedBy, record.requestedBy),
            eq(accountRequests.idempotencyKey, record.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) throw new Error('ACCOUNT_REQUEST_IDEMPOTENCY_LOOKUP_FAILED');
      return { record: mapRow(existing), created: false };
    },

    async listOwned(accountId, userId) {
      const rows = await database
        .select()
        .from(accountRequests)
        .where(
          and(eq(accountRequests.accountId, accountId), eq(accountRequests.requestedBy, userId)),
        )
        .orderBy(desc(accountRequests.requestedAt), desc(accountRequests.requestId));
      return rows.map(mapRow);
    },

    async cancelOwned(input) {
      const [cancelled] = await database
        .update(accountRequests)
        .set({
          status: 'cancelled',
          terminalAt: input.cancelledAt,
          updatedAt: input.cancelledAt,
        })
        .where(
          and(
            eq(accountRequests.requestId, input.requestId),
            eq(accountRequests.accountId, input.accountId),
            eq(accountRequests.requestedBy, input.userId),
            inArray(accountRequests.status, ['pending', 'cooling_off']),
          ),
        )
        .returning();
      if (cancelled) return { kind: 'cancelled' as const, record: mapRow(cancelled) };

      const [existing] = await database
        .select({ requestId: accountRequests.requestId })
        .from(accountRequests)
        .where(
          and(
            eq(accountRequests.requestId, input.requestId),
            eq(accountRequests.accountId, input.accountId),
            eq(accountRequests.requestedBy, input.userId),
          ),
        )
        .limit(1);
      return existing ? { kind: 'not_cancellable' as const } : { kind: 'not_found' as const };
    },
  };
  return Object.freeze(repository);
}
