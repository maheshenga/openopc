import { describe, expect, test } from 'bun:test';

import type { DeveloperModuleRelease, DeveloperModuleReviewRequirement } from './releases';
import {
  DeveloperModuleReviewError,
  type DeveloperModuleReviewEvidence,
  DeveloperModuleReviewService,
  createMemoryDeveloperModuleReviewRepository,
} from './reviews';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const CREATOR_ID = '20000000-0000-4000-a000-000000000002';
const PUBLISHER_ID = '20000000-0000-4000-a000-000000000003';
const REVIEWER_ID = '20000000-0000-4000-a000-000000000004';
const MEMBER_REVIEWER_ID = '20000000-0000-4000-a000-000000000005';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const NOW = new Date('2026-07-24T15:00:00.000Z');
const CREATED_AT = '2026-07-24T12:00:00.000Z';

function release(
  status: DeveloperModuleRelease['status'] = 'validated',
  reviewRevision = 0,
  requirements: DeveloperModuleReviewRequirement[] = [
    'manifest_review',
    'source_scan',
    'human_review',
  ],
): DeveloperModuleRelease {
  return {
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    item_name: 'recruiting-workbench',
    publisher_id: 'acme',
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    manifest: {
      schemaVersion: 2,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
    },
    manifest_digest: `sha256:${'a'.repeat(64)}`,
    artifact_id: '50000000-0000-4000-a000-000000000005',
    artifact_digest: `sha256:${'c'.repeat(64)}`,
    sbom_digest: null,
    trust_attestation_digest: null,
    verification_policy_digest: null,
    review_requirements: requirements,
    status,
    review_revision: reviewRevision,
    signature_algorithm: null,
    signature_key_id: null,
    signature: null,
    signature_payload_digest: null,
    signed_at: null,
    published_at: null,
    revoked_at: null,
    created_by: CREATOR_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function harness(initialRelease = release()) {
  let ordinal = 0;
  const repository = createMemoryDeveloperModuleReviewRepository({
    releases: [initialRelease],
    publisherAccountMembers: [
      { accountId: ACCOUNT_ID, userId: CREATOR_ID },
      { accountId: ACCOUNT_ID, userId: PUBLISHER_ID },
      { accountId: ACCOUNT_ID, userId: MEMBER_REVIEWER_ID },
    ],
    now: () => NOW,
    createId: () => `40000000-0000-4000-a000-${String(++ordinal).padStart(12, '0')}`,
  });
  return {
    repository,
    service: new DeveloperModuleReviewService({ repository, now: () => NOW }),
  };
}

function completeEvidence(
  requirements = release().review_requirements,
): DeveloperModuleReviewEvidence[] {
  return requirements.map((requirement, index) => ({
    requirement,
    outcome: 'passed' as const,
    method: 'manual' as const,
    summary: `Manual check ${index + 1} passed`,
    observed_at: '2026-07-24T14:00:00.000Z',
    tool: 'openopc-review-console',
    tool_version: '1.0.0',
    evidence_digest: `sha256:${String(index + 1).repeat(64)}`,
  }));
}

function firstCompleteEvidence(): DeveloperModuleReviewEvidence {
  const [evidence] = completeEvidence();
  if (!evidence) throw new Error('Expected complete review evidence');
  return evidence;
}

async function pendingHarness() {
  const result = harness();
  await result.service.requestReview({
    accountId: ACCOUNT_ID,
    releaseId: RELEASE_ID,
    actorUserId: PUBLISHER_ID,
    expectedStatus: 'validated',
    expectedRevision: 0,
    reason: 'Ready for review',
  });
  return result;
}

describe('developer module review service', () => {
  test('submits a validated release and appends immutable sequence one', async () => {
    const { service } = harness();

    const result = await service.requestReview({
      accountId: ACCOUNT_ID,
      releaseId: RELEASE_ID,
      actorUserId: PUBLISHER_ID,
      expectedStatus: 'validated',
      expectedRevision: 0,
      reason: ' Ready for platform review ',
    });

    expect(result.release).toMatchObject({ status: 'review_pending', review_revision: 1 });
    expect(result.event).toMatchObject({
      release_id: RELEASE_ID,
      account_id: ACCOUNT_ID,
      sequence: 1,
      action: 'submit',
      from_status: 'validated',
      to_status: 'review_pending',
      actor_user_id: PUBLISHER_ID,
      actor_kind: 'publisher',
      reason: 'Ready for platform review',
      evidence: [],
      created_at: NOW.toISOString(),
    });

    result.event.evidence.push(firstCompleteEvidence());
    const history = await service.history({ accountId: ACCOUNT_ID, releaseId: RELEASE_ID });
    expect(history).toHaveLength(1);
    expect(history[0]?.evidence).toEqual([]);
  });

  test('fails closed across accounts and rejects stale status or revision', async () => {
    const { service } = harness();

    await expect(
      service.requestReview({
        accountId: OTHER_ACCOUNT_ID,
        releaseId: RELEASE_ID,
        actorUserId: PUBLISHER_ID,
        expectedStatus: 'validated',
        expectedRevision: 0,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 }),
    );

    await expect(
      service.requestReview({
        accountId: ACCOUNT_ID,
        releaseId: RELEASE_ID,
        actorUserId: PUBLISHER_ID,
        expectedStatus: 'validated',
        expectedRevision: 4,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'DEVELOPER_REVIEW_CONFLICT', status: 409 }));
  });

  test('requires a bounded publisher response before resubmitting requested changes', async () => {
    const { service } = harness(release('changes_requested', 2));

    await expect(
      service.requestReview({
        accountId: ACCOUNT_ID,
        releaseId: RELEASE_ID,
        actorUserId: PUBLISHER_ID,
        expectedStatus: 'changes_requested',
        expectedRevision: 2,
        reason: '   ',
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_REVIEW_REASON_REQUIRED', status: 400 }),
    );

    const result = await service.requestReview({
      accountId: ACCOUNT_ID,
      releaseId: RELEASE_ID,
      actorUserId: PUBLISHER_ID,
      expectedStatus: 'changes_requested',
      expectedRevision: 2,
      reason: 'Added the requested external evidence.',
    });
    expect(result.event).toMatchObject({
      action: 'resubmit',
      from_status: 'changes_requested',
      to_status: 'review_pending',
      sequence: 3,
    });
  });

  test('platform admin can request changes only with a reason', async () => {
    const { service } = await pendingHarness();

    await expect(
      service.decide({
        releaseId: RELEASE_ID,
        actorUserId: REVIEWER_ID,
        decision: 'request_changes',
        expectedStatus: 'review_pending',
        expectedRevision: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_REVIEW_REASON_REQUIRED', status: 400 }),
    );

    const result = await service.decide({
      releaseId: RELEASE_ID,
      actorUserId: REVIEWER_ID,
      decision: 'request_changes',
      expectedStatus: 'review_pending',
      expectedRevision: 1,
      reason: 'Clarify the network data retention policy.',
    });
    expect(result.release).toMatchObject({ status: 'changes_requested', review_revision: 2 });
    expect(result.event).toMatchObject({
      action: 'request_changes',
      actor_kind: 'platform_admin',
      sequence: 2,
    });
  });

  test('approves only with a complete manual evidence snapshot', async () => {
    const { service } = await pendingHarness();
    const evidence = completeEvidence();

    const result = await service.decide({
      releaseId: RELEASE_ID,
      actorUserId: REVIEWER_ID,
      decision: 'approve',
      expectedStatus: 'review_pending',
      expectedRevision: 1,
      reason: 'All declared checks were manually attested.',
      evidence,
    });

    expect(result.release).toMatchObject({ status: 'approved', review_revision: 2 });
    expect(result.event).toMatchObject({
      action: 'approve',
      from_status: 'review_pending',
      to_status: 'approved',
      actor_kind: 'platform_admin',
      evidence,
    });
  });

  test('rejects incomplete, duplicate, undeclared, or automated approval evidence', async () => {
    const invalidEvidence = [
      completeEvidence().slice(0, 2),
      [...completeEvidence(), firstCompleteEvidence()],
      [
        ...completeEvidence(),
        {
          ...firstCompleteEvidence(),
          requirement: 'sandbox_test',
        },
      ],
      completeEvidence().map((entry) => ({ ...entry, method: 'automated' })),
    ];

    for (const evidence of invalidEvidence) {
      const { service } = await pendingHarness();
      await expect(
        service.decide({
          releaseId: RELEASE_ID,
          actorUserId: REVIEWER_ID,
          decision: 'approve',
          expectedStatus: 'review_pending',
          expectedRevision: 1,
          evidence,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE',
          status: 400,
        }),
      );
    }
  });

  test('validates strict evidence fields, timestamps, identifiers, digests, and safe text', async () => {
    const mutations: Array<(evidence: ReturnType<typeof completeEvidence>) => unknown> = [
      (evidence) => evidence.map((entry, index) => (index ? entry : { ...entry, extra: 'nope' })),
      (evidence) =>
        evidence.map((entry, index) =>
          index ? entry : { ...entry, observed_at: '2026-07-24T16:00:00.000Z' },
        ),
      (evidence) =>
        evidence.map((entry, index) =>
          index ? entry : { ...entry, observed_at: '2026-07-24T11:00:00.000Z' },
        ),
      (evidence) =>
        evidence.map((entry, index) => (index ? entry : { ...entry, tool: 'bad tool name' })),
      (evidence) =>
        evidence.map((entry, index) =>
          index ? entry : { ...entry, evidence_digest: 'sha256:not-a-digest' },
        ),
      (evidence) =>
        evidence.map((entry, index) =>
          index ? entry : { ...entry, summary: 'token=sk-live-super-secret-value' },
        ),
      (evidence) =>
        evidence.map((entry, index) => (index ? entry : { ...entry, summary: 'bad\u0001control' })),
    ];

    for (const mutate of mutations) {
      const { service } = await pendingHarness();
      await expect(
        service.decide({
          releaseId: RELEASE_ID,
          actorUserId: REVIEWER_ID,
          decision: 'approve',
          expectedStatus: 'review_pending',
          expectedRevision: 1,
          evidence: mutate(completeEvidence()),
        }),
      ).rejects.toBeInstanceOf(DeveloperModuleReviewError);
    }
  });

  test('denies approval by the release creator or any current publisher-account member', async () => {
    for (const actorUserId of [CREATOR_ID, MEMBER_REVIEWER_ID]) {
      const { service } = await pendingHarness();
      await expect(
        service.decide({
          releaseId: RELEASE_ID,
          actorUserId,
          decision: 'approve',
          expectedStatus: 'review_pending',
          expectedRevision: 1,
          evidence: completeEvidence(),
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED',
          status: 403,
        }),
      );
    }
  });

  test('revokes an approved release only with an emergency reason', async () => {
    const { service } = harness(release('approved', 4));

    await expect(
      service.decide({
        releaseId: RELEASE_ID,
        actorUserId: REVIEWER_ID,
        decision: 'revoke',
        expectedStatus: 'approved',
        expectedRevision: 4,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_REVIEW_REASON_REQUIRED', status: 400 }),
    );

    const result = await service.decide({
      releaseId: RELEASE_ID,
      actorUserId: REVIEWER_ID,
      decision: 'revoke',
      expectedStatus: 'approved',
      expectedRevision: 4,
      reason: 'Emergency takedown after a verified security report.',
    });
    expect(result.release).toMatchObject({ status: 'revoked', review_revision: 5 });
    expect(result.event).toMatchObject({ action: 'revoke', sequence: 5 });
  });

  test('rejects reserved and otherwise invalid lifecycle transitions', async () => {
    const cases: Array<{
      initial: DeveloperModuleRelease;
      decision: 'approve' | 'request_changes' | 'revoke';
      evidence?: unknown;
      reason?: string;
    }> = [
      { initial: release('validated', 0), decision: 'approve', evidence: completeEvidence() },
      { initial: release('approved', 2), decision: 'approve', evidence: completeEvidence() },
      { initial: release('signed', 3), decision: 'revoke', reason: 'Not allowed here' },
      { initial: release('published', 4), decision: 'revoke', reason: 'Not allowed here' },
      { initial: release('deprecated', 5), decision: 'revoke', reason: 'Not allowed here' },
    ];

    for (const entry of cases) {
      const { service } = harness(entry.initial);
      await expect(
        service.decide({
          releaseId: RELEASE_ID,
          actorUserId: REVIEWER_ID,
          decision: entry.decision,
          expectedStatus: entry.initial.status,
          expectedRevision: entry.initial.review_revision,
          evidence: entry.evidence,
          reason: entry.reason,
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: 'DEVELOPER_REVIEW_TRANSITION_INVALID', status: 409 }),
      );
    }
  });

  test('keeps history account-scoped, chronological, and mutation safe', async () => {
    const { service } = await pendingHarness();
    await service.decide({
      releaseId: RELEASE_ID,
      actorUserId: REVIEWER_ID,
      decision: 'request_changes',
      expectedStatus: 'review_pending',
      expectedRevision: 1,
      reason: 'Add retention details.',
    });

    const history = await service.history({ accountId: ACCOUNT_ID, releaseId: RELEASE_ID });
    expect(history.map((event) => event.sequence)).toEqual([1, 2]);
    const [firstEvent] = history;
    if (!firstEvent) throw new Error('Expected review history event');
    firstEvent.reason = 'Tampered';
    expect(
      (await service.history({ accountId: ACCOUNT_ID, releaseId: RELEASE_ID }))[0]?.reason,
    ).toBe('Ready for review');
    await expect(
      service.history({ accountId: OTHER_ACCOUNT_ID, releaseId: RELEASE_ID }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 }),
    );
  });

  test('lists the bounded global admin queue and returns full admin detail', async () => {
    const { service } = await pendingHarness();

    const page = await service.adminList({ status: 'review_pending', limit: 20 });
    expect(page.releases).toHaveLength(1);
    expect(page.releases[0]).toMatchObject({ release_id: RELEASE_ID, account_id: ACCOUNT_ID });
    expect(page.next_cursor).toBeNull();

    const detail = await service.adminGet({ releaseId: RELEASE_ID });
    expect(detail.release.review_revision).toBe(1);
    expect(detail.history.map((event) => event.sequence)).toEqual([1]);
  });

  test('uses code-only errors and never echoes rejected review text', async () => {
    const { service } = harness(release('changes_requested', 1));
    const secret = 'password=do-not-echo-this';

    try {
      await service.requestReview({
        accountId: ACCOUNT_ID,
        releaseId: RELEASE_ID,
        actorUserId: PUBLISHER_ID,
        expectedStatus: 'changes_requested',
        expectedRevision: 1,
        reason: secret,
      });
      throw new Error('Expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DeveloperModuleReviewError);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
