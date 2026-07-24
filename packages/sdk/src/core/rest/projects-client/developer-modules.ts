import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface DeveloperModuleValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface DeveloperModuleValidationResult {
  valid: boolean;
  issues: DeveloperModuleValidationIssue[];
}

export type DeveloperModuleReleaseStatus =
  | 'validated'
  | 'review_pending'
  | 'changes_requested'
  | 'approved'
  | 'signed'
  | 'published'
  | 'revoked'
  | 'deprecated';

export type DeveloperModuleReviewRequirement =
  | 'manifest_review'
  | 'source_scan'
  | 'sandbox_test'
  | 'permission_review'
  | 'desktop_security_review'
  | 'human_review';

export interface DeveloperModuleRelease {
  release_id: string;
  account_id: string;
  item_name: string;
  publisher_id: string;
  module_id: string;
  module_version: string;
  manifest: Record<string, unknown>;
  manifest_digest: string;
  review_requirements: DeveloperModuleReviewRequirement[];
  status: DeveloperModuleReleaseStatus;
  review_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeveloperModuleReleaseSubmission {
  created: boolean;
  release: DeveloperModuleRelease;
}

export interface DeveloperModuleReleaseList {
  releases: DeveloperModuleRelease[];
}

export type DeveloperModuleReviewAction =
  | 'submit'
  | 'resubmit'
  | 'request_changes'
  | 'approve'
  | 'revoke';

export type DeveloperModuleReviewActorKind = 'publisher' | 'platform_admin';

export interface DeveloperModuleReviewEvidence {
  requirement: DeveloperModuleReviewRequirement;
  outcome: 'passed';
  method: 'manual';
  summary: string;
  observed_at: string;
  tool?: string;
  tool_version?: string;
  evidence_digest?: `sha256:${string}`;
}

export interface DeveloperModuleReviewEvent {
  review_event_id: string;
  release_id: string;
  account_id: string;
  sequence: number;
  action: DeveloperModuleReviewAction;
  from_status: DeveloperModuleReleaseStatus;
  to_status: DeveloperModuleReleaseStatus;
  actor_user_id: string;
  actor_kind: DeveloperModuleReviewActorKind;
  reason: string | null;
  evidence: DeveloperModuleReviewEvidence[];
  created_at: string;
}

export interface DeveloperModuleReviewTransition {
  release: DeveloperModuleRelease;
  event: DeveloperModuleReviewEvent;
}

export interface DeveloperModuleReviewHistory {
  history: DeveloperModuleReviewEvent[];
}

export interface RequestDeveloperModuleReviewInput extends DeveloperModuleReleaseAccountOptions {
  expectedStatus: 'validated' | 'changes_requested';
  expectedRevision: number;
  reason?: string;
}

export interface DeveloperModuleReleaseAccountOptions {
  accountId?: string;
}

export interface ListDeveloperModuleReleasesOptions extends DeveloperModuleReleaseAccountOptions {
  limit?: number;
}

/** Validate one registry:module item without publishing or persisting it. */
export async function validateDeveloperModule(
  item: Record<string, unknown>,
): Promise<DeveloperModuleValidationResult> {
  return unwrap(
    await backendApi.post<DeveloperModuleValidationResult>('/developer/modules/validate', item),
    'Failed to validate developer module',
  );
}

function releaseQuery(options?: ListDeveloperModuleReleasesOptions): string {
  const search = new URLSearchParams();
  if (options?.accountId) search.set('account_id', options.accountId);
  if (options?.limit !== undefined) search.set('limit', String(options.limit));
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Persist one validated, immutable release metadata record without publishing it. */
export async function submitDeveloperModuleRelease(
  item: Record<string, unknown>,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleReleaseSubmission> {
  return unwrap(
    await backendApi.post<DeveloperModuleReleaseSubmission>('/developer/modules/releases', {
      ...(options?.accountId ? { account_id: options.accountId } : {}),
      item,
    }),
    'Failed to submit developer module release',
  );
}

/** List validated and later-lifecycle releases visible to one account. */
export async function listDeveloperModuleReleases(
  options?: ListDeveloperModuleReleasesOptions,
): Promise<DeveloperModuleReleaseList> {
  return unwrap(
    await backendApi.get<DeveloperModuleReleaseList>(
      `/developer/modules/releases${releaseQuery(options)}`,
    ),
    'Failed to list developer module releases',
  );
}

/** Read one release through the same account isolation boundary as list. */
export async function getDeveloperModuleRelease(
  releaseId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleRelease> {
  return unwrap(
    await backendApi.get<DeveloperModuleRelease>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}${releaseQuery(options)}`,
    ),
    'Failed to read developer module release',
  );
}

/** Request initial review or resubmit a changes-requested release. */
export async function requestDeveloperModuleReview(
  releaseId: string,
  input: RequestDeveloperModuleReviewInput,
): Promise<DeveloperModuleReviewTransition> {
  return unwrap(
    await backendApi.post<DeveloperModuleReviewTransition>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}/review-requests`,
      {
        ...(input.accountId ? { account_id: input.accountId } : {}),
        expected_status: input.expectedStatus,
        expected_revision: input.expectedRevision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    ),
    'Failed to request developer module review',
  );
}

/** Read chronological immutable review history through the publisher account boundary. */
export async function getDeveloperModuleReviewHistory(
  releaseId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleReviewHistory> {
  return unwrap(
    await backendApi.get<DeveloperModuleReviewHistory>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}/review-history${releaseQuery(options)}`,
    ),
    'Failed to read developer module review history',
  );
}
