import {
  type Database,
  accountMembers,
  developerModuleReleaseDistributionEvents,
  developerModuleReleases,
} from '@kortix/db';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import {
  DeveloperModuleDistributionError,
  type DeveloperModuleDistributionEvent,
  type DeveloperModuleDistributionRepository,
  type DeveloperModuleDistributionTransition,
} from './distribution';
import { serializeDeveloperModuleReleaseRow } from './releases.drizzle';

type DeveloperModuleDistributionEventRow =
  typeof developerModuleReleaseDistributionEvents.$inferSelect;

function serializeDistributionEvent(
  row: DeveloperModuleDistributionEventRow,
): DeveloperModuleDistributionEvent {
  return {
    distribution_event_id: row.distributionEventId,
    release_id: row.releaseId,
    account_id: row.accountId,
    sequence: row.sequence,
    action: row.action,
    from_status: row.fromStatus,
    to_status: row.toStatus,
    actor_user_id: row.actorUserId,
    actor_kind: 'platform_admin',
    reason: row.reason,
    created_at: row.createdAt,
  };
}

async function classifyFenceFailure(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  releaseId: string,
): Promise<never> {
  const [existing] = await tx
    .select({ releaseId: developerModuleReleases.releaseId })
    .from(developerModuleReleases)
    .where(eq(developerModuleReleases.releaseId, releaseId))
    .limit(1);
  throw existing
    ? new DeveloperModuleDistributionError('DEVELOPER_DISTRIBUTION_CONFLICT', 409)
    : new DeveloperModuleDistributionError('DEVELOPER_RELEASE_NOT_FOUND', 404);
}

async function appendEvent(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  input: {
    releaseId: string;
    accountId: string;
    sequence: number;
    action: 'sign' | 'publish' | 'revoke';
    fromStatus: 'approved' | 'signed' | 'published';
    toStatus: 'signed' | 'published' | 'revoked';
    actorUserId: string;
    reason: string | null;
  },
): Promise<DeveloperModuleDistributionEvent> {
  const [event] = await tx
    .insert(developerModuleReleaseDistributionEvents)
    .values({
      releaseId: input.releaseId,
      accountId: input.accountId,
      sequence: input.sequence,
      action: input.action,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorUserId: input.actorUserId,
      actorKind: 'platform_admin',
      reason: input.reason,
    })
    .returning();
  if (!event) throw new Error('Developer module distribution event insert returned no row');
  return serializeDistributionEvent(event);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function createDrizzleDeveloperModuleDistributionRepository(
  db: Database,
): DeveloperModuleDistributionRepository {
  return {
    async getAdmin(releaseId) {
      const [row] = await db
        .select()
        .from(developerModuleReleases)
        .where(eq(developerModuleReleases.releaseId, releaseId))
        .limit(1);
      return row ? serializeDeveloperModuleReleaseRow(row) : null;
    },

    async isPublisherAccountMember(accountId, userId) {
      const [row] = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
        .limit(1);
      return Boolean(row);
    },

    async sign(command) {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(developerModuleReleases)
          .set({
            status: 'signed',
            reviewRevision: sql`${developerModuleReleases.reviewRevision} + 1`,
            signatureAlgorithm: command.signature.algorithm,
            signatureKeyId: command.signature.key_id,
            signature: command.signature.signature,
            signaturePayloadDigest: command.signature.payload_digest,
            signedAt: command.signature.signed_at,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(developerModuleReleases.releaseId, command.releaseId),
              eq(developerModuleReleases.status, command.expectedStatus),
              eq(developerModuleReleases.reviewRevision, command.expectedRevision),
            ),
          )
          .returning();
        if (!updated) return classifyFenceFailure(tx, command.releaseId);

        const event = await appendEvent(tx, {
          releaseId: updated.releaseId,
          accountId: updated.accountId,
          sequence: updated.reviewRevision,
          action: 'sign',
          fromStatus: command.expectedStatus,
          toStatus: 'signed',
          actorUserId: command.actorUserId,
          reason: null,
        });
        return { release: serializeDeveloperModuleReleaseRow(updated), event };
      });
    },

    async transition(command) {
      return db.transaction(async (tx): Promise<DeveloperModuleDistributionTransition> => {
        const toStatus = command.action === 'publish' ? 'published' : 'revoked';
        const [updated] = await tx
          .update(developerModuleReleases)
          .set({
            status: toStatus,
            reviewRevision: sql`${developerModuleReleases.reviewRevision} + 1`,
            ...(command.action === 'publish' ? { publishedAt: sql`now()` } : {}),
            ...(command.action === 'revoke' ? { revokedAt: sql`now()` } : {}),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(developerModuleReleases.releaseId, command.releaseId),
              eq(developerModuleReleases.status, command.expectedStatus),
              eq(developerModuleReleases.reviewRevision, command.expectedRevision),
            ),
          )
          .returning();
        if (!updated) return classifyFenceFailure(tx, command.releaseId);

        const event = await appendEvent(tx, {
          releaseId: updated.releaseId,
          accountId: updated.accountId,
          sequence: updated.reviewRevision,
          action: command.action,
          fromStatus: command.expectedStatus,
          toStatus,
          actorUserId: command.actorUserId,
          reason: command.reason,
        });
        return { release: serializeDeveloperModuleReleaseRow(updated), event };
      });
    },

    async listPublished({ query, limit, offset, serverAdapterRuntimeKinds }) {
      const normalizedQuery = query?.trim();
      const searchPattern = normalizedQuery ? `%${escapeLikePattern(normalizedQuery)}%` : null;
      const searchCondition = searchPattern
        ? or(
            ilike(developerModuleReleases.itemName, searchPattern),
            ilike(developerModuleReleases.moduleId, searchPattern),
            ilike(developerModuleReleases.publisherId, searchPattern),
          )
        : undefined;
      const runtimeCondition = serverAdapterRuntimeKinds
        ? or(
            sql`coalesce(${developerModuleReleases.manifest}->'execution'->>'mode', '') <> 'server-adapter'`,
            inArray(developerModuleReleases.runtimeKind, serverAdapterRuntimeKinds),
          )
        : undefined;
      const condition = and(
        eq(developerModuleReleases.status, 'published'),
        searchCondition,
        runtimeCondition,
      );
      const [totalRow] = await db
        .select({ total: count() })
        .from(developerModuleReleases)
        .where(condition);
      const rows = await db
        .select()
        .from(developerModuleReleases)
        .where(condition)
        .orderBy(desc(developerModuleReleases.publishedAt), desc(developerModuleReleases.releaseId))
        .limit(limit)
        .offset(offset);
      return {
        releases: rows.map(serializeDeveloperModuleReleaseRow),
        total: totalRow?.total ?? 0,
      };
    },

    async getPublished(releaseId) {
      const [row] = await db
        .select()
        .from(developerModuleReleases)
        .where(
          and(
            eq(developerModuleReleases.releaseId, releaseId),
            eq(developerModuleReleases.status, 'published'),
          ),
        )
        .limit(1);
      return row ? serializeDeveloperModuleReleaseRow(row) : null;
    },

    async history(accountId, releaseId) {
      const rows = await db
        .select()
        .from(developerModuleReleaseDistributionEvents)
        .where(
          and(
            eq(developerModuleReleaseDistributionEvents.accountId, accountId),
            eq(developerModuleReleaseDistributionEvents.releaseId, releaseId),
          ),
        )
        .orderBy(asc(developerModuleReleaseDistributionEvents.sequence));
      return rows.map(serializeDistributionEvent);
    },
  };
}
