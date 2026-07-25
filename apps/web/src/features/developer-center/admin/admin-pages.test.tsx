import { describe, expect, test } from 'bun:test';
import type {
  DeveloperModuleHumanReviewEvidence,
  DeveloperModuleRelease,
  DeveloperModuleReviewEvent,
  DeveloperModuleTrustView,
} from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { AdminDeveloperReviewDetailView } from './review-detail-page';
import { AdminDeveloperReviewQueueView } from './review-queue-page';

const RELEASE: DeveloperModuleRelease = {
  release_id: '14000000-0000-4000-a000-000000000001',
  account_id: '24000000-0000-4000-a000-000000000002',
  item_name: 'Recruiting workflow',
  publisher_id: 'openopc',
  module_id: 'openopc.recruiting',
  module_version: '1.0.0',
  manifest: { id: 'openopc.recruiting', permissions: { network: ['api.example.test'] } },
  manifest_digest: `sha256:${'a'.repeat(64)}`,
  artifact_id: '44000000-0000-4000-a000-000000000004',
  artifact_digest: `sha256:${'b'.repeat(64)}`,
  sbom_digest: null,
  trust_attestation_digest: null,
  verification_policy_digest: `sha256:${'c'.repeat(64)}`,
  review_requirements: ['manifest_review', 'human_review'],
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
};

const ELEVATED_RELEASE: DeveloperModuleRelease = {
  ...RELEASE,
  release_id: '14000000-0000-4000-a000-000000000002',
  item_name: 'Second workflow',
  module_id: 'openopc.second',
  review_requirements: ['permission_review', 'human_review'],
};

const EVENT: DeveloperModuleReviewEvent = {
  review_event_id: '15000000-0000-4000-a000-000000000001',
  release_id: RELEASE.release_id,
  account_id: RELEASE.account_id,
  sequence: 4,
  action: 'submit',
  from_status: 'validated',
  to_status: 'review_pending',
  actor_user_id: RELEASE.created_by,
  actor_kind: 'publisher',
  reason: null,
  evidence: [],
  created_at: '2026-07-24T05:30:00.000Z',
};

const COMPLETE_EVIDENCE: DeveloperModuleHumanReviewEvidence[] = (
  ['manifest_review', 'human_review'] as const
).map((requirement, index) => ({
  requirement,
  outcome: 'passed',
  method: 'manual',
  summary: `${requirement} checked`,
  observed_at: `2026-07-24T06:0${index}:00.000Z`,
}));

const RUNNING_TRUST: DeveloperModuleTrustView = {
  release_id: RELEASE.release_id,
  account_id: RELEASE.account_id,
  artifact: {
    artifact_id: '44000000-0000-4000-a000-000000000004',
    artifact_digest: `sha256:${'b'.repeat(64)}`,
    media_type: 'application/vnd.openopc.developer-module.v2+json',
    size_bytes: 2048,
    source_provenance: { repository: 'https://example.test/openopc/recruiting' },
    created_at: RELEASE.created_at,
  },
  attempts: [
    {
      run_id: '45000000-0000-4000-a000-000000000005',
      attempt: 1,
      state: 'running',
      policy_digest: `sha256:${'c'.repeat(64)}`,
      scanner_set_digest: `sha256:${'d'.repeat(64)}`,
      sandbox_profile_digest: `sha256:${'e'.repeat(64)}`,
      terminal_reason: null,
      sbom_digest: null,
      attestation_digest: null,
      started_at: '2026-07-24T05:31:00.000Z',
      finished_at: null,
      created_at: '2026-07-24T05:30:30.000Z',
      findings: [],
      attestation: null,
    },
  ],
};

const noop = () => undefined;

function buttonTag(html: string, testId: string): string {
  return html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
}

describe('Admin Developer Center pages', () => {
  test('renders the review_pending queue, loaded search, and deterministic complexity labels', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperReviewQueueView
        state="ready"
        status="review_pending"
        releases={[RELEASE, ELEVATED_RELEASE]}
        search="second"
        nextCursor="cursor"
        errorCode={null}
        onSearchChange={noop}
        onStatusChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenRelease={noop}
      />,
    );

    expect(html).toContain('Review queue');
    expect(html).toContain('Second workflow');
    expect(html).not.toContain('Recruiting workflow');
    expect(html).toContain('Standard review');
    expect(html).toContain('Elevated review');
    expect(html).toContain('Next page');
  });

  test('shows no next action without a cursor and offers reset for malformed cursors', () => {
    const ready = renderToStaticMarkup(
      <AdminDeveloperReviewQueueView
        state="ready"
        status="review_pending"
        releases={[RELEASE]}
        search=""
        nextCursor={null}
        errorCode={null}
        onSearchChange={noop}
        onStatusChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenRelease={noop}
      />,
    );
    const error = renderToStaticMarkup(
      <AdminDeveloperReviewQueueView
        state="error"
        status="review_pending"
        releases={[]}
        search=""
        nextCursor={null}
        errorCode="DEVELOPER_REVIEW_INPUT_INVALID"
        onSearchChange={noop}
        onStatusChange={noop}
        onNextPage={noop}
        onResetCursor={noop}
        onOpenRelease={noop}
      />,
    );

    expect(ready).not.toContain('Next page');
    expect(error).toContain('cursor is invalid');
    expect(error).not.toContain('DEVELOPER_REVIEW_INPUT_INVALID');
    expect(error).toContain('Reset to first page');
  });

  test('enables approval only for complete evidence and gates reasoned decisions', () => {
    const complete = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={RELEASE}
        history={[EVENT]}
        evidence={COMPLETE_EVIDENCE}
        reason="Need an emergency rollback"
        pending={false}
        conflict={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );
    const incomplete = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={RELEASE}
        history={[]}
        evidence={COMPLETE_EVIDENCE.slice(0, 1)}
        reason=""
        pending={false}
        conflict={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );
    const approvedWithoutReason = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={{ ...RELEASE, status: 'approved' }}
        history={[]}
        evidence={COMPLETE_EVIDENCE}
        reason=""
        pending={false}
        conflict={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );
    const evidenceBeforeRelease = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={RELEASE}
        history={[]}
        evidence={COMPLETE_EVIDENCE.map((entry) => ({
          ...entry,
          observed_at: '2026-07-24T04:00:00.000Z',
        }))}
        reason=""
        pending={false}
        conflict={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );

    expect(buttonTag(complete, 'approve-decision')).not.toContain('disabled=""');
    expect(complete).toContain('>Request changes</button>');
    expect(complete).toContain('>Emergency revoke</button>');
    expect(buttonTag(incomplete, 'approve-decision')).toContain('disabled=""');
    expect(buttonTag(incomplete, 'request-changes-decision')).toContain('disabled=""');
    expect(buttonTag(incomplete, 'revoke-decision')).toContain('disabled=""');
    expect(buttonTag(approvedWithoutReason, 'revoke-decision')).toContain('disabled=""');
    expect(buttonTag(evidenceBeforeRelease, 'approve-decision')).toContain('disabled=""');
  });

  test('revoke confirmation names the module and version', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={{ ...RELEASE, status: 'approved' }}
        history={[]}
        evidence={COMPLETE_EVIDENCE}
        reason="Emergency rollback"
        pending={false}
        conflict={false}
        revokeOpen
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );

    expect(html).toContain('openopc.recruiting');
    expect(html).toContain('1.0.0');
    expect(html).toContain('Confirm emergency revoke');
  });

  test('renders conflict recovery without replaying the old decision', () => {
    const html = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={RELEASE}
        history={[]}
        evidence={COMPLETE_EVIDENCE}
        reason=""
        pending={false}
        conflict
        reloadPending
        revokeOpen={false}
        errorCode="DEVELOPER_REVIEW_CONFLICT"
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );

    expect(html).toContain('changed');
    expect(html).toContain('Reload latest release');
    expect(html).toMatch(/Reload latest release[^<]*<\/button>/);
    expect(html).not.toContain('Retry decision');
  });

  test('keeps Admin transport out of publisher feature imports', async () => {
    const publisherSource = await Bun.file(
      new URL('../publisher/query.ts', import.meta.url),
    ).text();
    expect(publisherSource).not.toContain('/admin/developer');
    expect(publisherSource).not.toContain('../admin');
  });

  test('shows only the legal distribution action for each release state', () => {
    const approved = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={{ ...RELEASE, status: 'approved' }}
        history={[]}
        evidence={COMPLETE_EVIDENCE}
        reason=""
        pending={false}
        conflict={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onDistributionAction={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );
    const signed = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={{
          ...RELEASE,
          status: 'signed',
          signature_algorithm: 'ed25519',
          signature_key_id: 'openopc-2026',
          signature: `base64url:${'a'.repeat(86)}`,
          signature_payload_digest: `sha256:${'b'.repeat(64)}`,
          signed_at: '2026-07-24T07:00:00.000Z',
        }}
        history={[]}
        evidence={COMPLETE_EVIDENCE}
        reason=""
        pending={false}
        conflict={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onDistributionAction={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );

    expect(approved).toContain('data-testid="sign-release"');
    expect(approved).not.toContain('data-testid="publish-release"');
    expect(signed).toContain('data-testid="publish-release"');
    expect(signed).not.toContain('data-testid="sign-release"');
  });

  test('renders public signature metadata and no mutation for published or revoked releases', () => {
    const publishedRelease: DeveloperModuleRelease = {
      ...RELEASE,
      status: 'published',
      signature_algorithm: 'ed25519',
      signature_key_id: 'openopc-2026',
      signature: `base64url:${'a'.repeat(86)}`,
      signature_payload_digest: `sha256:${'b'.repeat(64)}`,
      signed_at: '2026-07-24T07:00:00.000Z',
      published_at: '2026-07-24T07:05:00.000Z',
    };
    const render = (release: DeveloperModuleRelease) =>
      renderToStaticMarkup(
        <AdminDeveloperReviewDetailView
          state="ready"
          release={release}
          history={[]}
          evidence={COMPLETE_EVIDENCE}
          reason=""
          pending={false}
          conflict={false}
          revokeOpen={false}
          errorCode={null}
          onReasonChange={noop}
          onEvidenceChange={noop}
          onDecision={noop}
          onDistributionAction={noop}
          onReload={noop}
          onRevokeOpenChange={noop}
        />,
      );

    const published = render(publishedRelease);
    const revoked = render({
      ...publishedRelease,
      status: 'revoked',
      revoked_at: '2026-07-24T08:00:00.000Z',
    });

    expect(published).toContain('Signature verified');
    expect(published).toContain('openopc-2026');
    expect(published).toContain('2026-07-24T07:05:00.000Z');
    expect(published).not.toContain('data-testid="sign-release"');
    expect(published).not.toContain('data-testid="publish-release"');
    expect(revoked).toContain('No distribution actions available');
    expect(revoked).not.toContain('data-testid="sign-release"');
    expect(revoked).not.toContain('data-testid="publish-release"');
  });

  test('disables approval and signing with the current server trust reason', () => {
    const release: DeveloperModuleRelease = {
      ...RELEASE,
      review_requirements: ['source_scan', 'sandbox_test', 'human_review'],
    };
    const reviewPending = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={release}
        history={[]}
        trust={RUNNING_TRUST}
        evidence={[
          {
            requirement: 'human_review',
            outcome: 'passed',
            method: 'manual',
            summary: 'Independent review completed.',
            observed_at: '2026-07-24T06:00:00.000Z',
          },
        ]}
        reason=""
        pending={false}
        conflict={false}
        verificationPending={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onRetryVerification={noop}
        onCancelVerification={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );
    const approved = renderToStaticMarkup(
      <AdminDeveloperReviewDetailView
        state="ready"
        release={{ ...release, status: 'approved' }}
        history={[]}
        trust={RUNNING_TRUST}
        evidence={[]}
        reason=""
        pending={false}
        conflict={false}
        verificationPending={false}
        revokeOpen={false}
        errorCode={null}
        onReasonChange={noop}
        onEvidenceChange={noop}
        onDecision={noop}
        onDistributionAction={noop}
        onRetryVerification={noop}
        onCancelVerification={noop}
        onReload={noop}
        onRevokeOpenChange={noop}
      />,
    );

    expect(reviewPending).toContain('Sandbox verification is still running');
    expect(buttonTag(reviewPending, 'approve-decision')).toContain('disabled=""');
    expect(reviewPending).not.toContain('source_scan evidence summary');
    expect(buttonTag(approved, 'sign-release')).toContain('disabled=""');
    expect(approved).toContain('Cancel verification');
  });
});
