import { describe, expect, test } from 'bun:test';
import type {
  DeveloperModuleRelease,
  DeveloperModuleReviewEvent,
  DeveloperModuleTrustView,
} from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { PublisherReleaseDetailView } from './release-detail-page';
import { PublisherReleaseListView } from './release-list-page';

const RELEASE: DeveloperModuleRelease = {
  release_id: '11000000-0000-4000-a000-000000000001',
  account_id: '12000000-0000-4000-a000-000000000001',
  item_name: 'Recruiting',
  publisher_id: 'acme',
  module_id: 'acme.recruiting',
  module_version: '1.0.0',
  manifest: { id: 'acme.recruiting', permissions: { network: ['https://api.example.test'] } },
  manifest_digest: `sha256:${'a'.repeat(64)}`,
  artifact_id: '15000000-0000-4000-a000-000000000001',
  artifact_digest: `sha256:${'b'.repeat(64)}`,
  sbom_digest: null,
  trust_attestation_digest: null,
  verification_policy_digest: `sha256:${'c'.repeat(64)}`,
  review_requirements: ['manifest_review', 'human_review'],
  status: 'validated',
  review_revision: 3,
  signature_algorithm: null,
  signature_key_id: null,
  signature: null,
  signature_payload_digest: null,
  signed_at: null,
  published_at: null,
  revoked_at: null,
  created_by: '13000000-0000-4000-a000-000000000001',
  created_at: '2026-07-24T00:00:00.000Z',
  updated_at: '2026-07-24T00:00:00.000Z',
};

const EVENT: DeveloperModuleReviewEvent = {
  review_event_id: '14000000-0000-4000-a000-000000000001',
  release_id: RELEASE.release_id,
  account_id: RELEASE.account_id,
  sequence: 1,
  action: 'submit',
  from_status: 'validated',
  to_status: 'review_pending',
  actor_user_id: RELEASE.created_by,
  actor_kind: 'publisher',
  reason: null,
  evidence: [],
  created_at: '2026-07-24T00:00:00.000Z',
};

const noop = () => undefined;

const RUNNING_TRUST: DeveloperModuleTrustView = {
  release_id: RELEASE.release_id,
  account_id: RELEASE.account_id,
  artifact: {
    artifact_id: '15000000-0000-4000-a000-000000000001',
    artifact_digest: `sha256:${'b'.repeat(64)}`,
    media_type: 'application/vnd.openopc.developer-module.v2+json',
    size_bytes: 2048,
    source_provenance: null,
    created_at: RELEASE.created_at,
  },
  attempts: [
    {
      run_id: '16000000-0000-4000-a000-000000000001',
      attempt: 1,
      state: 'running',
      policy_digest: `sha256:${'c'.repeat(64)}`,
      scanner_set_digest: `sha256:${'d'.repeat(64)}`,
      sandbox_profile_digest: `sha256:${'e'.repeat(64)}`,
      terminal_reason: null,
      sbom_digest: null,
      attestation_digest: null,
      started_at: '2026-07-24T00:01:00.000Z',
      finished_at: null,
      created_at: '2026-07-24T00:00:30.000Z',
      findings: [],
      attestation: null,
    },
  ],
};

describe('Publisher Developer Center pages', () => {
  test('renders recent releases and loaded-result filters without an all-time total', () => {
    const html = renderToStaticMarkup(
      <PublisherReleaseListView
        state="ready"
        releases={[RELEASE]}
        search="recruit"
        status="validated"
        canWrite
        errorCode={null}
        onSearchChange={noop}
        onStatusChange={noop}
        onOpenRelease={noop}
        onSubmit={noop}
      />,
    );

    expect(html).toContain('Recent releases');
    expect(html).toContain('Recruiting');
    expect(html).toContain('1.0.0');
    expect(html).not.toContain('total releases');
  });

  test('renders loading, empty, permission-denied, and recoverable-error states', () => {
    const loading = renderToStaticMarkup(
      <PublisherReleaseListView
        state="loading"
        releases={[]}
        search=""
        status="all"
        canWrite={false}
        errorCode={null}
        onSearchChange={noop}
        onStatusChange={noop}
        onOpenRelease={noop}
        onSubmit={noop}
      />,
    );
    const empty = renderToStaticMarkup(
      <PublisherReleaseListView
        state="empty"
        releases={[]}
        search=""
        status="all"
        canWrite
        errorCode={null}
        onSearchChange={noop}
        onStatusChange={noop}
        onOpenRelease={noop}
        onSubmit={noop}
      />,
    );
    const denied = renderToStaticMarkup(
      <PublisherReleaseListView
        state="permission_denied"
        releases={[]}
        search=""
        status="all"
        canWrite={false}
        errorCode={null}
        onSearchChange={noop}
        onStatusChange={noop}
        onOpenRelease={noop}
        onSubmit={noop}
      />,
    );
    const error = renderToStaticMarkup(
      <PublisherReleaseListView
        state="error"
        releases={[]}
        search=""
        status="all"
        canWrite={false}
        errorCode="DEVELOPER_REQUEST_FAILED"
        onSearchChange={noop}
        onStatusChange={noop}
        onOpenRelease={noop}
        onSubmit={noop}
      />,
    );

    expect(loading).toContain('Loading releases');
    expect(empty).toContain('No releases found');
    expect(denied).toContain('permission');
    expect(denied).not.toContain('Submit new version');
    expect(error).toContain('DEVELOPER_REQUEST_FAILED');
    expect(error).toContain('Try again');
  });

  test('renders only the legal request-review action for a validated release', () => {
    const html = renderToStaticMarkup(
      <PublisherReleaseDetailView
        state="ready"
        release={RELEASE}
        history={[EVENT]}
        canWrite
        pending={false}
        errorCode={null}
        reason=""
        onReasonChange={noop}
        onRequestReview={noop}
      />,
    );

    expect(html).toContain('Request review');
    expect(html).toContain('Recruiting');
    expect(html).toContain('Submitted for review');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Revoke');
  });

  test('renders resubmission and read-only lifecycle states', () => {
    const changesRequested = renderToStaticMarkup(
      <PublisherReleaseDetailView
        state="ready"
        release={{ ...RELEASE, status: 'changes_requested' }}
        history={[]}
        canWrite
        pending={false}
        errorCode={null}
        reason="Updated permissions"
        onReasonChange={noop}
        onRequestReview={noop}
      />,
    );
    const approvedReadOnly = renderToStaticMarkup(
      <PublisherReleaseDetailView
        state="ready"
        release={{ ...RELEASE, status: 'approved' }}
        history={[]}
        canWrite
        pending={false}
        errorCode={null}
        reason=""
        onReasonChange={noop}
        onRequestReview={noop}
      />,
    );

    expect(changesRequested).toContain('Resubmit for review');
    expect(changesRequested).toContain('Updated permissions');
    expect(approvedReadOnly).toContain('Read-only');
    expect(approvedReadOnly).not.toContain('Request review');
  });

  test('shows public signature verification details for a published release', () => {
    const html = renderToStaticMarkup(
      <PublisherReleaseDetailView
        state="ready"
        release={{
          ...RELEASE,
          status: 'published',
          signature_algorithm: 'ed25519',
          signature_key_id: 'openopc-2026',
          signature: `base64url:${'a'.repeat(86)}`,
          signature_payload_digest: `sha256:${'b'.repeat(64)}`,
          signed_at: '2026-07-24T07:00:00.000Z',
          published_at: '2026-07-24T07:05:00.000Z',
        }}
        history={[]}
        canWrite
        pending={false}
        errorCode={null}
        reason=""
        onReasonChange={noop}
        onRequestReview={noop}
      />,
    );

    expect(html).toContain('Signature verified');
    expect(html).toContain('openopc-2026');
    expect(html).toContain('2026-07-24T07:05:00.000Z');
    expect(html).not.toContain('Request review');
  });

  test('shows live automatic trust progress and bounded retry eligibility', () => {
    const running = renderToStaticMarkup(
      <PublisherReleaseDetailView
        state="ready"
        release={{
          ...RELEASE,
          review_requirements: ['source_scan', 'sandbox_test', 'human_review'],
        }}
        history={[]}
        trust={RUNNING_TRUST}
        canWrite
        pending={false}
        retryPending={false}
        errorCode={null}
        reason=""
        onReasonChange={noop}
        onRequestReview={noop}
        onRetryVerification={noop}
      />,
    );
    const failed = renderToStaticMarkup(
      <PublisherReleaseDetailView
        state="ready"
        release={{
          ...RELEASE,
          review_requirements: ['source_scan', 'sandbox_test', 'human_review'],
        }}
        history={[]}
        trust={{
          ...RUNNING_TRUST,
          attempts: [
            {
              ...RUNNING_TRUST.attempts[0],
              state: 'failed',
              terminal_reason: 'Sandbox policy denied the module.',
              finished_at: '2026-07-24T00:02:00.000Z',
            },
          ],
        }}
        canWrite
        pending={false}
        retryPending={false}
        errorCode={null}
        reason=""
        onReasonChange={noop}
        onRequestReview={noop}
        onRetryVerification={noop}
      />,
    );

    expect(running).toContain('Sandbox verification is still running');
    expect(running).not.toContain('Retry verification');
    expect(failed).toContain('Sandbox policy denied the module');
    expect(failed).toContain('Retry verification');
  });
});
