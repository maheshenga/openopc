import type {
  DeveloperModuleRelease,
  DeveloperModuleReviewEvidence,
  DeveloperModuleReviewRequirement,
} from '@kortix/sdk';

import type { AdminDeveloperReviewDecision, AdminDeveloperReviewDecisionBody } from './client';

const SUMMARY_MAX_CHARS = 1_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_KEYS = new Set([
  'requirement',
  'outcome',
  'method',
  'summary',
  'observed_at',
  'tool',
  'tool_version',
  'evidence_digest',
]);

export function createEvidenceDrafts(
  requirements: readonly DeveloperModuleReviewRequirement[],
  observedAt = new Date().toISOString(),
): DeveloperModuleReviewEvidence[] {
  return requirements.map((requirement) => ({
    requirement,
    outcome: 'passed',
    method: 'manual',
    summary: '',
    observed_at: observedAt,
  }));
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isEvidenceEntry(value: unknown): value is DeveloperModuleReviewEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !EVIDENCE_KEYS.has(key))) return false;
  if (
    typeof record.requirement !== 'string' ||
    record.outcome !== 'passed' ||
    record.method !== 'manual' ||
    typeof record.summary !== 'string' ||
    !record.summary.trim() ||
    record.summary.length > SUMMARY_MAX_CHARS ||
    !canonicalIsoTimestamp(record.observed_at)
  ) {
    return false;
  }
  if (
    record.tool !== undefined &&
    (typeof record.tool !== 'string' || !IDENTIFIER.test(record.tool))
  ) {
    return false;
  }
  if (
    record.tool_version !== undefined &&
    (record.tool === undefined ||
      typeof record.tool_version !== 'string' ||
      !TOOL_VERSION.test(record.tool_version))
  ) {
    return false;
  }
  if (
    record.evidence_digest !== undefined &&
    (typeof record.evidence_digest !== 'string' || !SHA256.test(record.evidence_digest))
  ) {
    return false;
  }
  return true;
}

export function isApprovalEvidenceComplete(
  requirements: readonly DeveloperModuleReviewRequirement[],
  evidence: readonly DeveloperModuleReviewEvidence[] | unknown,
): evidence is DeveloperModuleReviewEvidence[] {
  if (!Array.isArray(evidence) || evidence.length !== requirements.length) return false;
  const declared = new Set(requirements);
  const seen = new Set<DeveloperModuleReviewRequirement>();

  for (const entry of evidence) {
    if (!isEvidenceEntry(entry)) return false;
    const requirement = entry.requirement as DeveloperModuleReviewRequirement;
    if (!declared.has(requirement) || seen.has(requirement)) return false;
    seen.add(requirement);
  }
  return seen.size === declared.size;
}

export function buildAdminDecisionBody(
  release: Pick<DeveloperModuleRelease, 'status' | 'review_revision' | 'review_requirements'>,
  decision: AdminDeveloperReviewDecision,
  input: {
    reason?: string;
    evidence?: readonly DeveloperModuleReviewEvidence[];
  } = {},
): AdminDeveloperReviewDecisionBody {
  const body: AdminDeveloperReviewDecisionBody = {
    decision,
    expected_status: release.status,
    expected_revision: release.review_revision,
  };

  if (decision === 'approve') {
    if (!isApprovalEvidenceComplete(release.review_requirements, input.evidence)) {
      throw new Error('EVIDENCE_INCOMPLETE');
    }
    if (input.reason?.trim()) body.reason = input.reason.trim();
    body.evidence = [...input.evidence];
    return body;
  }

  const reason = input.reason?.trim();
  if (!reason) throw new Error('REASON_REQUIRED');
  body.reason = reason;
  return body;
}
