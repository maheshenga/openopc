import type {
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewRequirement,
} from '@kortix/sdk';

export const DEVELOPER_MODULE_INPUT_MAX_BYTES = 1_048_576;

export type PublisherReviewAction = 'request_review' | 'resubmit';
export type ReleaseStatusFilter = DeveloperModuleReleaseStatus | 'all';

type DeveloperCenterErrorCode =
  | 'DEVELOPER_MODULE_INVALID'
  | 'DEVELOPER_PUBLISHER_MISMATCH'
  | 'DEVELOPER_PUBLISHER_CONFLICT'
  | 'DEVELOPER_MODULE_VERSION_CONFLICT'
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'DEVELOPER_REVIEW_REASON_REQUIRED'
  | 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE'
  | 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED'
  | 'DEVELOPER_REVIEW_TRANSITION_INVALID'
  | 'DEVELOPER_REVIEW_CONFLICT'
  | 'DEVELOPER_REQUEST_FAILED';

const KNOWN_DEVELOPER_CENTER_ERROR_CODES = new Set<DeveloperCenterErrorCode>([
  'DEVELOPER_MODULE_INVALID',
  'DEVELOPER_PUBLISHER_MISMATCH',
  'DEVELOPER_PUBLISHER_CONFLICT',
  'DEVELOPER_MODULE_VERSION_CONFLICT',
  'DEVELOPER_RELEASE_NOT_FOUND',
  'DEVELOPER_REVIEW_REASON_REQUIRED',
  'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE',
  'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED',
  'DEVELOPER_REVIEW_TRANSITION_INVALID',
  'DEVELOPER_REVIEW_CONFLICT',
  'DEVELOPER_REQUEST_FAILED',
]);

export function publisherActionFor(
  status: DeveloperModuleReleaseStatus,
): PublisherReviewAction | null {
  if (status === 'validated') return 'request_review';
  if (status === 'changes_requested') return 'resubmit';
  return null;
}

export function parseDeveloperModuleInput(
  text: string,
):
  | { ok: true; item: Record<string, unknown> }
  | {
      ok: false;
      code: 'EMPTY_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_ROOT';
    } {
  if (!text.trim()) return { ok: false, code: 'EMPTY_INPUT' };
  if (new TextEncoder().encode(text).byteLength > DEVELOPER_MODULE_INPUT_MAX_BYTES) {
    return { ok: false, code: 'INPUT_TOO_LARGE' };
  }

  try {
    const item: unknown = JSON.parse(text);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, code: 'INVALID_ROOT' };
    }
    return { ok: true, item: item as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }
}

export function filterRecentReleases(
  releases: readonly DeveloperModuleRelease[],
  query: string,
  status: ReleaseStatusFilter,
): DeveloperModuleRelease[] {
  const needle = query.trim().toLowerCase();

  return releases.filter((release) => {
    if (status !== 'all' && release.status !== status) return false;
    if (!needle) return true;

    return [release.item_name, release.module_id, release.publisher_id, release.module_version].some(
      (value) => value.toLowerCase().includes(needle),
    );
  });
}

export function requirementComplexity(
  requirements: readonly DeveloperModuleReviewRequirement[],
): 'standard' | 'elevated' {
  return requirements.includes('desktop_security_review') ||
    requirements.includes('permission_review')
    ? 'elevated'
    : 'standard';
}

function knownDeveloperCenterErrorCode(value: unknown): DeveloperCenterErrorCode | null {
  if (typeof value !== 'string') return null;
  return KNOWN_DEVELOPER_CENTER_ERROR_CODES.has(value as DeveloperCenterErrorCode)
    ? (value as DeveloperCenterErrorCode)
    : null;
}

export function developerCenterErrorCode(error: unknown): DeveloperCenterErrorCode {
  if (!error || typeof error !== 'object') return 'DEVELOPER_REQUEST_FAILED';

  const record = error as { code?: unknown; body?: unknown };
  const directCode = knownDeveloperCenterErrorCode(record.code);
  if (directCode) return directCode;

  if (record.body && typeof record.body === 'object') {
    const bodyCode = knownDeveloperCenterErrorCode((record.body as { error?: unknown }).error);
    if (bodyCode) return bodyCode;
  }

  return 'DEVELOPER_REQUEST_FAILED';
}
