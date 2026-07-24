import {
  type Database,
  accountMembers,
  developerModuleReleaseReviewEvents,
  developerModuleReleases,
} from '@kortix/db';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';

import { serializeDeveloperModuleReleaseRow } from './releases.drizzle';
import {
  DeveloperModuleReviewError,
  type DeveloperModuleReviewEvent,
  type DeveloperModuleReviewEvidence,
  type DeveloperModuleReviewRepository,
} from './reviews';

type DeveloperModuleReviewEventRow = typeof developerModuleReleaseReviewEvents.$inferSelect;

type ReviewCursor = {
  updatedAt: string;
  releaseId: string;
};

function serializeReviewEvent(row: DeveloperModuleReviewEventRow): DeveloperModuleReviewEvent {
  return {
    review_event_id: row.reviewEventId,
    release_id: row.releaseId,
    account_id: row.accountId,
    sequence: row.sequence,
    action: row.action,
    from_status: row.fromStatus,
    to_status: row.toStatus,
    actor_user_id: row.actorUserId,
    actor_kind: row.actorKind,
    reason: row.reason,
    evidence: structuredClone(row.evidence) as unknown as DeveloperModuleReviewEvidence[],
    created_at: row.createdAt,
  };
}

function encodeCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): ReviewCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('invalid cursor');
    }
    const record = value as Record<string, unknown>;
    const updatedAt = record.updatedAt;
    const releaseId = record.releaseId;
    if (
      Object.keys(record).length !== 2 ||
      typeof updatedAt !== 'string' ||
      typeof releaseId !== 'string'
    ) {
      throw new Error('invalid cursor');
    }
    return {
      updatedAt,
      releaseId,
    };
  } catch {
    throw new DeveloperModuleReviewError('DEVELOPER_REVIEW_INPUT_INVALID', 400);
  }
}

export function createDrizzleDeveloperModuleReviewRepository(
  db: Database,
): DeveloperModuleReviewRepository {
  return {
    async getPublisher(accountId, releaseId) {
      const [row] = await db
        .select()
        .from(developerModuleReleases)
        .where(
          and(
            eq(developerModuleReleases.accountId, accountId),
            eq(developerModuleReleases.releaseId, releaseId),
          ),
        )
        .limit(1);
      return row ? serializeDeveloperModuleReleaseRow(row) : null;
    },

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

    async transition(command) {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(developerModuleReleases)
          .set({
            status: command.toStatus,
            reviewRevision: sql`${developerModuleReleases.reviewRevision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(developerModuleReleases.accountId, command.accountId),
              eq(developerModuleReleases.releaseId, command.releaseId),
              eq(developerModuleReleases.status, command.expectedStatus),
              eq(developerModuleReleases.reviewRevision, command.expectedRevision),
            ),
          )
          .returning();

        if (!updated) {
          const [existing] = await tx
            .select({ releaseId: developerModuleReleases.releaseId })
            .from(developerModuleReleases)
            .where(
              and(
                eq(developerModuleReleases.accountId, command.accountId),
                eq(developerModuleReleases.releaseId, command.releaseId),
              ),
            )
            .limit(1);
          throw existing
            ? new DeveloperModuleReviewError('DEVELOPER_REVIEW_CONFLICT', 409)
            : new DeveloperModuleReviewError('DEVELOPER_RELEASE_NOT_FOUND', 404);
        }

        const clonedEvidence = structuredClone(command.evidence) as DeveloperModuleReviewEvidence[];
        const [event] = await tx
          .insert(developerModuleReleaseReviewEvents)
          .values({
            releaseId: updated.releaseId,
            accountId: updated.accountId,
            sequence: updated.reviewRevision,
            action: command.action,
            fromStatus: command.expectedStatus,
            toStatus: command.toStatus,
            actorUserId: command.actorUserId,
            actorKind: command.actorKind,
            reason: command.reason,
            evidence: clonedEvidence as unknown as Record<string, unknown>[],
          })
          .returning();
        if (!event) throw new Error('Developer module review event insert returned no row');

        return {
          release: serializeDeveloperModuleReleaseRow(updated),
          event: serializeReviewEvent(event),
        };
      });
    },

    async history(accountId, releaseId) {
      const rows = await db
        .select()
        .from(developerModuleReleaseReviewEvents)
        .where(
          and(
            eq(developerModuleReleaseReviewEvents.accountId, accountId),
            eq(developerModuleReleaseReviewEvents.releaseId, releaseId),
          ),
        )
        .orderBy(asc(developerModuleReleaseReviewEvents.sequence));
      return rows.map(serializeReviewEvent);
    },

    async adminList({ status, limit, cursor }) {
      const decoded = decodeCursor(cursor);
      const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const conditions = [eq(developerModuleReleases.status, status)];
      if (decoded) {
        const cursorCondition = or(
          lt(developerModuleReleases.updatedAt, decoded.updatedAt),
          and(
            eq(developerModuleReleases.updatedAt, decoded.updatedAt),
            lt(developerModuleReleases.releaseId, decoded.releaseId),
          ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }
      const rows = await db
        .select()
        .from(developerModuleReleases)
        .where(and(...conditions))
        .orderBy(desc(developerModuleReleases.updatedAt), desc(developerModuleReleases.releaseId))
        .limit(boundedLimit + 1);
      const page = rows.slice(0, boundedLimit);
      const last = page.at(-1);
      return {
        releases: page.map(serializeDeveloperModuleReleaseRow),
        next_cursor:
          rows.length > boundedLimit && last
            ? encodeCursor({ updatedAt: last.updatedAt, releaseId: last.releaseId })
            : null,
      };
    },
  };
}
