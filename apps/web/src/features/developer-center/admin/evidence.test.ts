import { describe, expect, test } from 'bun:test';

import {
  buildAdminDecisionBody,
  createEvidenceDrafts,
  isApprovalEvidenceComplete,
  isReviewReasonValid,
} from './evidence';

import type {
  DeveloperModuleHumanReviewEvidence,
  DeveloperModuleHumanReviewRequirement,
  DeveloperModuleRelease,
} from '@kortix/sdk';

const REQUIREMENTS: DeveloperModuleHumanReviewRequirement[] = ['manifest_review', 'human_review'];
const RELEASE = {
  release_id: '14000000-0000-4000-a000-000000000001',
  account_id: '24000000-0000-4000-a000-000000000002',
  item_name: 'registry:module:recruitment',
  publisher_id: 'openopc',
  module_id: 'recruitment',
  module_version: '1.0.0',
  manifest: {},
  manifest_digest: `sha256:${'b'.repeat(64)}`,
  artifact_id: '44000000-0000-4000-a000-000000000004',
  artifact_digest: `sha256:${'c'.repeat(64)}`,
  sbom_digest: null,
  trust_attestation_digest: null,
  verification_policy_digest: `sha256:${'d'.repeat(64)}`,
  review_requirements: REQUIREMENTS,
  status: 'review_pending',
  review_revision: 4,
  signature_algorithm: null,
  signature_key_id: null,
  signature: null,
  signature_payload_digest: null,
  signed_at: null,
  published_at: null,
  revoked_at: null,
  created_by: '34000000-0000-4000-a000-000000000003',
  created_at: '2026-07-24T05:00:00.000Z',
  updated_at: '2026-07-24T05:30:00.000Z',
} satisfies DeveloperModuleRelease;

const COMPLETE_EVIDENCE: DeveloperModuleHumanReviewEvidence[] = REQUIREMENTS.map(
  (requirement, index) => ({
    requirement,
    outcome: 'passed',
    method: 'manual',
    summary: `${requirement} completed manually`,
    observed_at: `2026-07-24T06:0${index}:00.000Z`,
  }),
);

describe('Admin review evidence model', () => {
  test('creates one fixed manual/passed draft per declared requirement', () => {
    expect(createEvidenceDrafts(REQUIREMENTS, '2026-07-24T06:00:00.000Z')).toEqual([
      {
        requirement: 'manifest_review',
        outcome: 'passed',
        method: 'manual',
        summary: '',
        observed_at: '2026-07-24T06:00:00.000Z',
      },
      {
        requirement: 'human_review',
        outcome: 'passed',
        method: 'manual',
        summary: '',
        observed_at: '2026-07-24T06:00:00.000Z',
      },
    ]);
  });

  test('requires exactly one complete entry for every declared requirement', () => {
    expect(isApprovalEvidenceComplete(REQUIREMENTS, COMPLETE_EVIDENCE)).toBe(true);
    expect(isApprovalEvidenceComplete(REQUIREMENTS, COMPLETE_EVIDENCE.slice(0, 1))).toBe(false);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [COMPLETE_EVIDENCE[0], COMPLETE_EVIDENCE[0]]),
    ).toBe(false);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [
        ...COMPLETE_EVIDENCE,
        { ...COMPLETE_EVIDENCE[0], requirement: 'source_scan' },
      ]),
    ).toBe(false);
  });

  test('enforces fixed outcome/method and bounded summaries', () => {
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [
        { ...COMPLETE_EVIDENCE[0], outcome: 'failed' as never },
        COMPLETE_EVIDENCE[1],
      ]),
    ).toBe(false);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [
        { ...COMPLETE_EVIDENCE[0], method: 'automated' as never },
        COMPLETE_EVIDENCE[1],
      ]),
    ).toBe(false);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [
        { ...COMPLETE_EVIDENCE[0], summary: 'x'.repeat(1_001) },
        COMPLETE_EVIDENCE[1],
      ]),
    ).toBe(false);
  });

  test('rejects legacy metadata fields that the strict API request schema does not accept', () => {
    expect(isApprovalEvidenceComplete(REQUIREMENTS, COMPLETE_EVIDENCE)).toBe(true);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [
        {
          ...COMPLETE_EVIDENCE[0],
          tool: 'openopc-review-console',
        },
        COMPLETE_EVIDENCE[1],
      ]),
    ).toBe(false);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, [
        { ...COMPLETE_EVIDENCE[0], evidence_digest: `sha256:${'a'.repeat(64)}` },
        COMPLETE_EVIDENCE[1],
      ]),
    ).toBe(false);
  });

  test('rejects reason text that exceeds the server UTF-8 byte budget', () => {
    const longUnicodeReason = '审'.repeat(3_000);
    expect(isReviewReasonValid(longUnicodeReason)).toBe(false);
    expect(() =>
      buildAdminDecisionBody(RELEASE, 'request_changes', { reason: longUnicodeReason }),
    ).toThrow('REASON_INVALID');
    expect(() =>
      buildAdminDecisionBody(RELEASE, 'approve', {
        reason: longUnicodeReason,
        evidence: COMPLETE_EVIDENCE,
      }),
    ).toThrow('REASON_INVALID');
  });

  test('rejects evidence observed before release creation or after the review clock', () => {
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, COMPLETE_EVIDENCE, {
        releaseCreatedAt: '2026-07-24T07:00:00.000Z',
        now: new Date('2026-07-24T08:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      isApprovalEvidenceComplete(REQUIREMENTS, COMPLETE_EVIDENCE, {
        releaseCreatedAt: '2026-07-24T05:00:00.000Z',
        now: new Date('2026-07-24T05:30:00.000Z'),
      }),
    ).toBe(false);
  });

  test('builds approval from the current status/revision and complete evidence', () => {
    expect(buildAdminDecisionBody(RELEASE, 'approve', { evidence: COMPLETE_EVIDENCE })).toEqual({
      decision: 'approve',
      expected_status: 'review_pending',
      expected_revision: 4,
      evidence: COMPLETE_EVIDENCE,
    });
    expect(() =>
      buildAdminDecisionBody(RELEASE, 'approve', {
        evidence: COMPLETE_EVIDENCE.slice(0, 1),
      }),
    ).toThrow('EVIDENCE_INCOMPLETE');
  });

  test('requires a reason and omits evidence for request changes and revoke', () => {
    expect(() => buildAdminDecisionBody(RELEASE, 'request_changes', { reason: ' ' })).toThrow(
      'REASON_REQUIRED',
    );
    expect(() =>
      buildAdminDecisionBody({ ...RELEASE, status: 'approved' }, 'revoke', { reason: ' ' }),
    ).toThrow('REASON_REQUIRED');

    expect(
      buildAdminDecisionBody(RELEASE, 'request_changes', {
        reason: '  Add a complete source review.  ',
        evidence: COMPLETE_EVIDENCE,
      }),
    ).toEqual({
      decision: 'request_changes',
      expected_status: 'review_pending',
      expected_revision: 4,
      reason: 'Add a complete source review.',
    });
  });
});
