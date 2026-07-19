import type {
  WorkflowReviewActorType,
  WorkflowReviewAdapter,
  WorkflowReviewProjectionRecord,
  WorkflowReviewVerdict,
} from '../intelligence/workflows/review-adapter';
import { parseWorkflowReviewMetadata } from '../intelligence/workflows/review-adapter';
import type { ReviewItemRow } from './review-items';

export type ReviewVerdictDispatchInput = {
  reviewItem: Pick<ReviewItemRow, 'metadata'>;
  reviewItemId: string;
  accountId: string;
  projectId: string;
  actorUserId: string;
  actorType: WorkflowReviewActorType;
  actingTokenId: string | null;
  verdict: WorkflowReviewVerdict;
  feedback: string | null;
};

export type ReviewVerdictDispatchDependencies = {
  getWorkflowReviewAdapter: () => Pick<WorkflowReviewAdapter, 'resolve'> | null;
  applyVerdict: (
    reviewItemId: string,
    projectId: string,
    input: {
      verdict: WorkflowReviewVerdict;
      feedback: string | null;
      actingUserId: string;
    },
  ) => Promise<ReviewItemRow | null>;
};

export type ReviewVerdictDispatchResult =
  | { kind: 'workflow'; row: WorkflowReviewProjectionRecord | null }
  | { kind: 'native'; row: ReviewItemRow | null }
  | { kind: 'workflow_unavailable'; row: null };

export async function dispatchReviewVerdict(
  input: ReviewVerdictDispatchInput,
  dependencies: ReviewVerdictDispatchDependencies,
): Promise<ReviewVerdictDispatchResult> {
  if (parseWorkflowReviewMetadata(input.reviewItem.metadata)) {
    const workflowReview = dependencies.getWorkflowReviewAdapter();
    if (!workflowReview) return { kind: 'workflow_unavailable', row: null };
    const resolved = await workflowReview.resolve({
      reviewItemId: input.reviewItemId,
      accountId: input.accountId,
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      actorType: input.actorType,
      actingTokenId: input.actingTokenId,
      verdict: input.verdict,
      feedback: input.feedback,
    });
    return { kind: 'workflow', row: resolved?.projection ?? null };
  }
  const row = await dependencies.applyVerdict(input.reviewItemId, input.projectId, {
    verdict: input.verdict,
    feedback: input.feedback,
    actingUserId: input.actorUserId,
  });
  return { kind: 'native', row };
}
