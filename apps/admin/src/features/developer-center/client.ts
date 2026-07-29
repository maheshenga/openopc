import type {
  DeveloperModuleHumanReviewEvidence,
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewEvent,
  DeveloperModuleReviewTransition,
  DeveloperModuleTrustView,
  DeveloperModuleVerificationRun,
} from '@kortix/sdk';

import { backendApi } from '@/lib/api-client';

export interface AdminDeveloperReviewPage {
  releases: DeveloperModuleRelease[];
  next_cursor: string | null;
}

export interface AdminDeveloperDistributionEvent {
  distribution_event_id: string;
  release_id: string;
  account_id: string;
  sequence: number;
  action: 'sign' | 'publish' | 'revoke';
  from_status: DeveloperModuleReleaseStatus;
  to_status: DeveloperModuleReleaseStatus;
  actor_user_id: string;
  actor_kind: 'platform_admin';
  reason: string | null;
  created_at: string;
}

export type AdminDeveloperLifecycleEvent =
  | DeveloperModuleReviewEvent
  | AdminDeveloperDistributionEvent;

export interface AdminDeveloperReviewDetail {
  release: DeveloperModuleRelease;
  history: AdminDeveloperLifecycleEvent[];
}

export type AdminDeveloperReviewDecision = 'request_changes' | 'approve' | 'revoke';

export interface AdminDeveloperReviewDecisionBody {
  decision: AdminDeveloperReviewDecision;
  expected_status: DeveloperModuleReleaseStatus;
  expected_revision: number;
  reason?: string;
  evidence?: DeveloperModuleHumanReviewEvidence[];
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
  | 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE'
  | 'DEVELOPER_MODULE_SIGNATURE_INVALID'
  | 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE'
  | 'DEVELOPER_DISTRIBUTION_SELF_ACTION_DENIED'
  | 'DEVELOPER_DISTRIBUTION_CONFLICT'
  | 'DEVELOPER_TRUST_GATE_UNMET'
  | 'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED'
  | 'DEVELOPER_VERIFICATION_CONFLICT'
  | 'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED'
  | 'DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED'
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
  'DEVELOPER_MODULE_SIGNER_UNAVAILABLE',
  'DEVELOPER_MODULE_SIGNATURE_INVALID',
  'DEVELOPER_MODULE_NOT_DISTRIBUTABLE',
  'DEVELOPER_DISTRIBUTION_SELF_ACTION_DENIED',
  'DEVELOPER_DISTRIBUTION_CONFLICT',
  'DEVELOPER_TRUST_GATE_UNMET',
  'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED',
  'DEVELOPER_VERIFICATION_CONFLICT',
  'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED',
  'DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED',
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
      { adminReason: `Reviewing developer module release ${releaseId}` },
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
      {
        adminReason:
          body.reason?.trim() || `${body.decision} developer module release ${releaseId}`,
      },
    ),
  );
}

export async function getAdminDeveloperModuleTrust(
  releaseId: string,
): Promise<DeveloperModuleTrustView> {
  return unwrapAdmin(
    await backendApi.get<DeveloperModuleTrustView>(
      `/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/trust`,
      { adminReason: `Reviewing trust evidence for developer module release ${releaseId}` },
    ),
  );
}

export async function retryAdminDeveloperModuleVerification(
  releaseId: string,
): Promise<DeveloperModuleVerificationRun> {
  return unwrapAdmin(
    await backendApi.post<DeveloperModuleVerificationRun>(
      `/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/verification-retries`,
      {},
      { adminReason: `Retrying verification for developer module release ${releaseId}` },
    ),
  );
}

export async function cancelAdminDeveloperModuleVerification(
  releaseId: string,
): Promise<DeveloperModuleVerificationRun> {
  return unwrapAdmin(
    await backendApi.post<DeveloperModuleVerificationRun>(
      `/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/verification-cancellations`,
      {},
      { adminReason: `Cancelling verification for developer module release ${releaseId}` },
    ),
  );
}

export type AdminDeveloperDistributionAction = 'sign' | 'publish';

export type AdminDeveloperDistributionBody =
  | { expected_status: 'approved'; expected_revision: number }
  | { expected_status: 'signed'; expected_revision: number };

export async function signAdminDeveloperModuleRelease(
  releaseId: string,
  body: Extract<AdminDeveloperDistributionBody, { expected_status: 'approved' }>,
): Promise<DeveloperModuleReviewTransition & { event: AdminDeveloperDistributionEvent }> {
  return unwrapAdmin(
    await backendApi.post<
      DeveloperModuleReviewTransition & { event: AdminDeveloperDistributionEvent }
    >(`/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/sign`, body, {
      adminReason: `Signing developer module release ${releaseId}`,
    }),
  );
}

export async function publishAdminDeveloperModuleRelease(
  releaseId: string,
  body: Extract<AdminDeveloperDistributionBody, { expected_status: 'signed' }>,
): Promise<DeveloperModuleReviewTransition & { event: AdminDeveloperDistributionEvent }> {
  return unwrapAdmin(
    await backendApi.post<
      DeveloperModuleReviewTransition & { event: AdminDeveloperDistributionEvent }
    >(`/admin/developer/modules/releases/${encodeURIComponent(releaseId)}/publish`, body, {
      adminReason: `Publishing developer module release ${releaseId}`,
    }),
  );
}
