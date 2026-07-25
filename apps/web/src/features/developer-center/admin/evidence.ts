import type {
  DeveloperModuleHumanReviewEvidence,
  DeveloperModuleHumanReviewRequirement,
  DeveloperModuleRelease,
  DeveloperModuleReviewRequirement,
} from '@kortix/sdk';

import { humanReviewRequirements } from '../model';
import type { AdminDeveloperReviewDecision, AdminDeveloperReviewDecisionBody } from './client';

const SUMMARY_MAX_CHARS = 1_000;
const EVIDENCE_KEYS = new Set(['requirement', 'outcome', 'method', 'summary', 'observed_at']);

const REASON_MAX_CHARS = 4_000;
const REASON_MAX_BYTES = 8_192;

export function isReviewReasonValid(reason: string | undefined): boolean {
  if (!reason?.trim()) return false;
  const normalized = reason.trim();
  return (
    normalized.length <= REASON_MAX_CHARS &&
    new TextEncoder().encode(normalized).byteLength <= REASON_MAX_BYTES
  );
}

export function createEvidenceDrafts(
  requirements: readonly DeveloperModuleReviewRequirement[],
  observedAt = new Date().toISOString(),
): DeveloperModuleHumanReviewEvidence[] {
  return humanReviewRequirements(requirements).map((requirement) => ({
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

function isEvidenceEntry(value: unknown): value is DeveloperModuleHumanReviewEvidence {
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
  return true;
}

export function isApprovalEvidenceComplete(
  requirements: readonly DeveloperModuleReviewRequirement[],
  evidence: readonly DeveloperModuleHumanReviewEvidence[] | unknown,
  bounds: { releaseCreatedAt?: string; now?: Date } = {},
): evidence is DeveloperModuleHumanReviewEvidence[] {
  const manualRequirements = humanReviewRequirements(requirements);
  if (!Array.isArray(evidence) || evidence.length !== manualRequirements.length) return false;
  const declared = new Set(manualRequirements);
  const seen = new Set<DeveloperModuleHumanReviewRequirement>();
  const releaseCreatedAt = bounds.releaseCreatedAt ? Date.parse(bounds.releaseCreatedAt) : null;
  const now = bounds.now?.getTime() ?? Date.now();

  if (releaseCreatedAt !== null && !Number.isFinite(releaseCreatedAt)) return false;

  for (const entry of evidence) {
    if (!isEvidenceEntry(entry)) return false;
    const observedAt = Date.parse(entry.observed_at);
    if ((releaseCreatedAt !== null && observedAt < releaseCreatedAt) || observedAt > now) {
      return false;
    }
    const requirement = entry.requirement;
    if (!declared.has(requirement) || seen.has(requirement)) return false;
    seen.add(requirement);
  }
  return seen.size === manualRequirements.length;
}

export function buildAdminDecisionBody(
  release: Pick<DeveloperModuleRelease, 'status' | 'review_revision' | 'review_requirements'> &
    Partial<Pick<DeveloperModuleRelease, 'created_at'>>,
  decision: AdminDeveloperReviewDecision,
  input: {
    reason?: string;
    evidence?: readonly DeveloperModuleHumanReviewEvidence[];
  } = {},
): AdminDeveloperReviewDecisionBody {
  const body: AdminDeveloperReviewDecisionBody = {
    decision,
    expected_status: release.status,
    expected_revision: release.review_revision,
  };

  if (decision === 'approve') {
    if (
      !isApprovalEvidenceComplete(release.review_requirements, input.evidence, {
        releaseCreatedAt: release.created_at,
      })
    ) {
      throw new Error('EVIDENCE_INCOMPLETE');
    }
    if (input.reason?.trim()) {
      if (!isReviewReasonValid(input.reason)) throw new Error('REASON_INVALID');
      body.reason = input.reason.trim();
    }
    body.evidence = [...input.evidence];
    return body;
  }

  const reason = input.reason?.trim();
  if (!reason) throw new Error('REASON_REQUIRED');
  if (!isReviewReasonValid(reason)) throw new Error('REASON_INVALID');
  body.reason = reason;
  return body;
}
