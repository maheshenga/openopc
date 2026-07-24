import type {
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewEvidence,
  DeveloperModuleReviewTransition,
} from '@kortix/sdk';

import { backendApi } from '@/lib/api-client';

export interface AdminDeveloperReviewPage {
  releases: DeveloperModuleRelease[];
  next_cursor: string | null;
}

export interface AdminDeveloperReviewDetail {
  release: DeveloperModuleRelease;
  history: DeveloperModuleReviewTransition['event'][];
}

export type AdminDeveloperReviewDecision = 'request_changes' | 'approve' | 'revoke';

export interface AdminDeveloperReviewDecisionBody {
  decision: AdminDeveloperReviewDecision;
  expected_status: DeveloperModuleReleaseStatus;
  expected_revision: number;
  reason?: string;
  evidence?: DeveloperModuleReviewEvidence[];
}

export type AdminDeveloperReviewErrorCode =
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'DEVELOPER_REVIEW_CONFLICT'
  | 'DEVELOPER_REVIEW_TRANSITION_INVALID'
  | 'DEVELOPER_REVIEW_REASON_REQUIRED'
  | 'DEVELOPER_REVIEW_REASON_INVALID'
  | 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE'
  | 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED'
  | 'DEVELOPER_REVIEW_INPUT_INVALID'
  | 'DEVELOPER_REQUEST_FAILED';

const STABLE_ERROR_CODES = new Set<AdminDeveloperReviewErrorCode>([
  'DEVELOPER_RELEASE_NOT_FOUND',
  'DEVELOPER_REVIEW_CONFLICT',
  'DEVELOPER_REVIEW_TRANSITION_INVALID',
  'DEVELOPER_REVIEW_REASON_REQUIRED',
  'DEVELOPER_REVIEW_REASON_INVALID',
  'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE',
  'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED',
  'DEVELOPER_REVIEW_INPUT_INVALID',
]);

export class AdminDeveloperReviewError extends Error {
  constructor(readonly code: AdminDeveloperReviewErrorCode) {
    super(code);
    this.name = 'AdminDeveloperReviewError';
  }
}

function stableCode(value: unknown): AdminDeveloperReviewErrorCode | null {
  return typeof value === 'string' && STABLE_ERROR_CODES.has(value as AdminDeveloperReviewErrorCode)
    ? (value as AdminDeveloperReviewErrorCode)
    : null;
}

/** Extract only codes emitted by the review API; arbitrary provider text is discarded. */
export function adminDeveloperReviewErrorCode(error: unknown): AdminDeveloperReviewErrorCode {
  const visited = new Set<object>();

  const visit = (value: unknown): AdminDeveloperReviewErrorCode | null => {
    const direct = stableCode(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object') return null;
    if (visited.has(value)) return null;
    visited.add(value);

    const record = value as Record<string, unknown>;
    for (const key of ['code', 'error', 'error_code', 'message']) {
      const found = stableCode(record[key]);
      if (found) return found;
    }
    for (const key of ['details', 'data', 'detail', 'body', 'response']) {
      const found = visit(record[key]);
      if (found) return found;
    }
    return null;
  };

  return visit(error) ?? 'DEVELOPER_REQUEST_FAILED';
}

function unwrapAdmin<T>(response: { data?: T; success: boolean; error?: unknown }): T {
  if (!response.success || response.data === undefined) {
    const code = adminDeveloperReviewErrorCode(response.error);
    throw new AdminDeveloperReviewError(code);
  }
  return response.data;
}

export async function listAdminDeveloperReviews(input: {
  status: DeveloperModuleReleaseStatus;
  limit?: number;
  cursor?: string | null;
}): Promise<AdminDeveloperReviewPage> {
  const query = new URLSearchParams({
    status: input.status,
    limit: String(input.limit ?? 50),
  });
  if (input.cursor) query.set('cursor', input.cursor);
  return unwrapAdmin(
    await backendApi.get<AdminDeveloperReviewPage>(
      `/admin/developer/modules/reviews?${query.toString()}`,
    ),
  );
}

export async function getAdminDeveloperReview(
  releaseId: string,
): Promise<AdminDeveloperReviewDetail> {
  return unwrapAdmin(
    await backendApi.get<AdminDeveloperReviewDetail>(
      `/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/review`,
    ),
  );
}

export async function decideAdminDeveloperReview(
  releaseId: string,
  body: AdminDeveloperReviewDecisionBody,
): Promise<DeveloperModuleReviewTransition> {
  return unwrapAdmin(
    await backendApi.post<DeveloperModuleReviewTransition>(
      `/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/review-decisions`,
      body,
    ),
  );
}
