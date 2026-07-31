import type {
  DeveloperModuleHumanReviewRequirement,
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewRequirement,
  DeveloperModuleTrustView,
} from '@kortix/sdk';

export const DEVELOPER_MODULE_INPUT_MAX_BYTES = 1_048_576;

export type PublisherReviewAction = 'request_review' | 'resubmit';
export type ReleaseStatusFilter = DeveloperModuleReleaseStatus | 'all';

type DeveloperCenterErrorCode =
  | 'DEVELOPER_MODULE_INVALID'
  | 'DEVELOPER_RELEASE_ARTIFACT_REQUIRED'
  | 'DEVELOPER_ARTIFACT_INVALID'
  | 'DEVELOPER_ARTIFACT_PUBLISHER_MISMATCH'
  | 'DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT'
  | 'DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND'
  | 'DEVELOPER_ARTIFACT_UPLOAD_EXPIRED'
  | 'DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID'
  | 'DEVELOPER_ARTIFACT_SIZE_MISMATCH'
  | 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH'
  | 'DEVELOPER_ARTIFACT_NOT_FOUND'
  | 'DEVELOPER_ARTIFACT_STORE_UNAVAILABLE'
  | 'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED'
  | 'DEVELOPER_PUBLISHER_MISMATCH'
  | 'DEVELOPER_PUBLISHER_CONFLICT'
  | 'DEVELOPER_MODULE_VERSION_CONFLICT'
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'DEVELOPER_REVIEW_REASON_REQUIRED'
  | 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE'
  | 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED'
  | 'DEVELOPER_REVIEW_TRANSITION_INVALID'
  | 'DEVELOPER_REVIEW_CONFLICT'
  | 'DEVELOPER_VERIFICATION_CONFLICT'
  | 'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED'
  | 'DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED'
  | 'DEVELOPER_TRUST_GATE_UNMET'
  | 'DEVELOPER_REQUEST_FAILED';

const KNOWN_DEVELOPER_CENTER_ERROR_CODES = new Set<DeveloperCenterErrorCode>([
  'DEVELOPER_MODULE_INVALID',
  'DEVELOPER_RELEASE_ARTIFACT_REQUIRED',
  'DEVELOPER_ARTIFACT_INVALID',
  'DEVELOPER_ARTIFACT_PUBLISHER_MISMATCH',
  'DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT',
  'DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND',
  'DEVELOPER_ARTIFACT_UPLOAD_EXPIRED',
  'DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID',
  'DEVELOPER_ARTIFACT_SIZE_MISMATCH',
  'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH',
  'DEVELOPER_ARTIFACT_NOT_FOUND',
  'DEVELOPER_ARTIFACT_STORE_UNAVAILABLE',
  'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED',
  'DEVELOPER_PUBLISHER_MISMATCH',
  'DEVELOPER_PUBLISHER_CONFLICT',
  'DEVELOPER_MODULE_VERSION_CONFLICT',
  'DEVELOPER_RELEASE_NOT_FOUND',
  'DEVELOPER_REVIEW_REASON_REQUIRED',
  'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE',
  'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED',
  'DEVELOPER_REVIEW_TRANSITION_INVALID',
  'DEVELOPER_REVIEW_CONFLICT',
  'DEVELOPER_VERIFICATION_CONFLICT',
  'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED',
  'DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED',
  'DEVELOPER_TRUST_GATE_UNMET',
  'DEVELOPER_REQUEST_FAILED',
]);

export type DeveloperModuleTrustGateFailureCode =
  | 'DEVELOPER_TRUST_EVIDENCE_MISSING'
  | 'DEVELOPER_TRUST_PENDING'
  | 'DEVELOPER_TRUST_NOT_PASSED'
  | 'DEVELOPER_TRUST_POLICY_STALE'
  | 'DEVELOPER_TRUST_ARTIFACT_MISMATCH'
  | 'DEVELOPER_TRUST_EVIDENCE_MISMATCH'
  | 'DEVELOPER_TRUST_ATTESTATION_SUBJECT_MISMATCH'
  | 'DEVELOPER_TRUST_BLOCKING_FINDINGS';

export type DeveloperModuleTrustGateStatus =
  | { ready: true; code: null; message: string }
  | { ready: false; code: DeveloperModuleTrustGateFailureCode; message: string };

export function publisherActionFor(
  status: DeveloperModuleReleaseStatus,
): PublisherReviewAction | null {
  if (status === 'validated') return 'request_review';
  if (status === 'changes_requested') return 'resubmit';
  return null;
}

export function parseDeveloperModuleInput(text: string):
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

    return [
      release.item_name,
      release.module_id,
      release.publisher_id,
      release.module_version,
    ].some((value) => value.toLowerCase().includes(needle));
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

export function humanReviewRequirements(
  requirements: readonly DeveloperModuleReviewRequirement[],
): DeveloperModuleHumanReviewRequirement[] {
  return requirements.filter(
    (requirement): requirement is DeveloperModuleHumanReviewRequirement =>
      requirement !== 'source_scan' &&
      requirement !== 'sandbox_test' &&
      requirement !== 'sdk_contract_test',
  );
}

function automaticCheckName(requirements: readonly DeveloperModuleReviewRequirement[]): string {
  if (requirements.includes('sandbox_test')) return 'Sandbox verification';
  if (requirements.includes('source_scan')) return 'Source verification';
  return 'Automatic verification';
}

export function developerModuleTrustGateStatus(
  release: Pick<
    DeveloperModuleRelease,
    | 'artifact_id'
    | 'artifact_digest'
    | 'sbom_digest'
    | 'trust_attestation_digest'
    | 'verification_policy_digest'
  > & { review_requirements: readonly DeveloperModuleReviewRequirement[] },
  trust: DeveloperModuleTrustView | null | undefined,
): DeveloperModuleTrustGateStatus {
  const failure = (
    code: DeveloperModuleTrustGateFailureCode,
    message: string,
  ): DeveloperModuleTrustGateStatus => ({ ready: false, code, message });
  const checkName = automaticCheckName(release.review_requirements);

  if (!trust?.attempts.length) {
    return failure('DEVELOPER_TRUST_EVIDENCE_MISSING', `${checkName} has not produced evidence.`);
  }
  if (
    release.artifact_id !== trust.artifact.artifact_id ||
    release.artifact_digest !== trust.artifact.artifact_digest
  ) {
    return failure(
      'DEVELOPER_TRUST_ARTIFACT_MISMATCH',
      'Automatic evidence belongs to a different artifact.',
    );
  }

  const latest = trust.attempts.at(-1);
  if (!latest) {
    return failure('DEVELOPER_TRUST_EVIDENCE_MISSING', `${checkName} has not produced evidence.`);
  }
  if (
    !release.verification_policy_digest ||
    release.verification_policy_digest !== latest.policy_digest
  ) {
    return failure(
      'DEVELOPER_TRUST_POLICY_STALE',
      'Automatic verification uses a stale policy and must be retried.',
    );
  }
  if (latest.state === 'queued') {
    return failure('DEVELOPER_TRUST_PENDING', `${checkName} is queued.`);
  }
  if (latest.state === 'running') {
    return failure('DEVELOPER_TRUST_PENDING', `${checkName} is still running.`);
  }
  if (latest.state !== 'passed') {
    return failure('DEVELOPER_TRUST_NOT_PASSED', `${checkName} did not pass.`);
  }
  if (!latest.attestation) {
    return failure(
      'DEVELOPER_TRUST_EVIDENCE_MISSING',
      'The passing attempt has no trust attestation.',
    );
  }
  if (latest.attestation.subject_artifact_digest !== trust.artifact.artifact_digest) {
    return failure(
      'DEVELOPER_TRUST_ATTESTATION_SUBJECT_MISMATCH',
      'The trust attestation names a different artifact.',
    );
  }
  if (
    !latest.sbom_digest ||
    !latest.attestation_digest ||
    latest.sbom_digest !== release.sbom_digest ||
    latest.attestation_digest !== release.trust_attestation_digest ||
    latest.attestation.attestation_digest !== latest.attestation_digest ||
    latest.attestation.sbom_digest !== latest.sbom_digest ||
    latest.attestation.policy_digest !== latest.policy_digest ||
    latest.attestation.result !== 'passed'
  ) {
    return failure(
      'DEVELOPER_TRUST_EVIDENCE_MISMATCH',
      'Release trust digests do not match the latest verification attempt.',
    );
  }
  if (
    latest.findings.some(
      (finding) =>
        finding.disposition === 'blocking' &&
        (finding.severity === 'high' || finding.severity === 'critical'),
    )
  ) {
    return failure(
      'DEVELOPER_TRUST_BLOCKING_FINDINGS',
      'Automatic verification contains blocking high-severity findings.',
    );
  }
  return { ready: true, code: null, message: 'Automatic trust checks passed.' };
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
