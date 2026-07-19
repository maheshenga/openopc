import { type Database, reviewItems } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import {
  type WorkflowReviewProjectionPort,
  type WorkflowReviewProjectionRecord,
  parseWorkflowReviewMetadata,
} from '../intelligence/workflows/review-adapter';

type ReviewItemRow = typeof reviewItems.$inferSelect;

export function createWorkflowReviewProjectionStore(
  database: Database,
): WorkflowReviewProjectionPort {
  const load = async (input: { reviewItemId: string; accountId: string; projectId: string }) => {
    const [row] = await database
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.reviewItemId, input.reviewItemId),
          eq(reviewItems.accountId, input.accountId),
          eq(reviewItems.projectId, input.projectId),
        ),
      )
      .limit(1);
    return row ? toWorkflowReviewProjection(row) : null;
  };

  return {
    async upsert(input) {
      await database
        .insert(reviewItems)
        .values({
          reviewItemId: input.reviewItemId,
          accountId: input.accountId,
          projectId: input.projectId,
          originSessionId: input.originSessionId,
          kind: input.kind,
          status: input.status,
          risk: input.risk,
          source: input.source,
          title: input.title,
          summary: input.summary,
          detail: input.detail,
          agent: input.agent,
          createdBy: input.createdBy,
          metadata: input.metadata,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .onConflictDoNothing({ target: reviewItems.reviewItemId });
      const projection = await load(input);
      if (
        !projection ||
        projection.metadata.approval_id !== input.metadata.approval_id ||
        projection.metadata.run_id !== input.metadata.run_id ||
        projection.metadata.node_id !== input.metadata.node_id ||
        projection.createdBy !== input.createdBy ||
        projection.risk !== input.risk ||
        projection.title !== input.title ||
        projection.summary !== input.summary ||
        projection.agent !== input.agent
      ) {
        throw new Error('WORKFLOW_REVIEW_PROJECTION_CONFLICT');
      }
      return projection;
    },
    get: load,
    async reconcile(input) {
      const actedAt = input.approval.resolved_at ? new Date(input.approval.resolved_at) : null;
      const status =
        input.approval.decision === 'approve'
          ? 'approved'
          : input.approval.decision === 'changes_requested'
            ? 'changes_requested'
            : input.approval.status === 'rejected'
              ? 'rejected'
              : 'dismissed';
      const [row] = await database
        .update(reviewItems)
        .set({
          status,
          actedBy: input.approval.acting_user_id,
          actedAt,
          feedback: input.feedback,
          updatedAt: actedAt ?? new Date(),
        })
        .where(
          and(
            eq(reviewItems.reviewItemId, input.reviewItemId),
            eq(reviewItems.accountId, input.accountId),
            eq(reviewItems.projectId, input.projectId),
          ),
        )
        .returning();
      return row ? toWorkflowReviewProjection(row) : null;
    },
  };
}

function toWorkflowReviewProjection(row: ReviewItemRow): WorkflowReviewProjectionRecord | null {
  const metadata = parseWorkflowReviewMetadata(row.metadata);
  if (!metadata || row.kind !== 'decision' || row.source !== 'agent') return null;
  return {
    reviewItemId: row.reviewItemId,
    accountId: row.accountId,
    projectId: row.projectId,
    originSessionId: row.originSessionId,
    kind: 'decision',
    status: row.status,
    risk: row.risk,
    source: 'agent',
    title: row.title,
    summary: row.summary,
    detail: row.detail,
    agent: row.agent,
    createdBy: row.createdBy,
    metadata,
    createdAt: row.createdAt,
    actedBy: row.actedBy,
    actedAt: row.actedAt,
    feedback: row.feedback,
    updatedAt: row.updatedAt,
  };
}
