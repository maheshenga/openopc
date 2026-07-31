import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeveloperModuleManifestView } from './module-manifest-view';
import { DeveloperModuleRequirements } from './module-requirements';
import { DeveloperModuleStatusBadge } from './module-status-badge';
import { DeveloperModuleReviewTimeline } from './review-timeline';
import { DeveloperModuleTrustSummary } from './trust-summary';

describe('Developer Center shared views', () => {
  test('renders stable status and requirement labels', () => {
    const html = renderToStaticMarkup(
      <>
        <DeveloperModuleStatusBadge status="draft" />
        <DeveloperModuleStatusBadge status="uploaded" />
        <DeveloperModuleStatusBadge status="verifying" />
        <DeveloperModuleStatusBadge status="review_pending" />
        <DeveloperModuleRequirements
          requirements={[
            'manifest_review',
            'sdk_contract_test',
            'ai_service_review',
            'payment_service_review',
            'human_review',
          ]}
        />
      </>,
    );

    expect(html).toContain('Draft');
    expect(html).toContain('Uploaded');
    expect(html).toContain('Verifying');
    expect(html).toContain('Review pending');
    expect(html).toContain('Manifest review');
    expect(html).toContain('SDK contract test');
    expect(html).toContain('AI service review');
    expect(html).toContain('Payment service review');
    expect(html).toContain('Human review');
  });

  test('renders structured permissions and escaped raw JSON', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleManifestView
        manifest={{
          id: 'acme.module',
          permissions: { network: ['https://api.example.test'] },
          unsafe: '<script>',
        }}
      />,
    );

    expect(html).toContain('acme.module');
    expect(html).toContain('https://api.example.test');
    expect(html).not.toContain('<script>');
  });

  test('renders declared SDK services without provider configuration', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleManifestView
        manifest={{
          id: 'acme.weather',
          openopc: {
            sdkApiVersion: 'v1',
            services: { ai: { operations: ['models.read', 'text.generate'] } },
            providerUrl: 'https://newapi.example.test',
          },
        }}
      />,
    );

    expect(html).toContain('SDK API version');
    expect(html).toContain('v1');
    expect(html).toContain('AI service');
    expect(html).toContain('models.read, text.generate');
    expect(html).not.toContain('newapi.example.test');
  });

  test('renders immutable events without privileged actions', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleReviewTimeline
        events={[
          {
            review_event_id: '1',
            action: 'submit',
            from_status: 'validated',
            to_status: 'review_pending',
            actor_kind: 'publisher',
            actor_user_id: 'user',
            reason: null,
            evidence: [],
            created_at: '2026-07-24T00:00:00.000Z',
            release_id: 'release',
            account_id: 'account',
            sequence: 1,
          } as never,
        ]}
      />,
    );

    expect(html).toContain('Submitted for review');
    expect(html).toContain('Publisher');
    expect(html).not.toContain('Approve');
  });

  test('groups sanitized findings and renders immutable SBOM and attestation metadata', () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
    const html = renderToStaticMarkup(
      <DeveloperModuleTrustSummary
        trust={{
          release_id: 'release-1',
          account_id: 'account-1',
          artifact: {
            artifact_id: 'artifact-1',
            artifact_digest: digest('a'),
            media_type: 'application/vnd.openopc.developer-module.v2+json',
            size_bytes: 2048,
            source_provenance: {
              repository: 'https://example.test/acme/module',
              commit: 'abc123',
            },
            created_at: '2026-07-25T12:00:00.000Z',
          },
          attempts: [
            {
              run_id: 'run-1',
              attempt: 1,
              state: 'passed',
              policy_digest: digest('b'),
              scanner_set_digest: digest('c'),
              sandbox_profile_digest: digest('d'),
              terminal_reason: 'Verification completed.',
              sbom_digest: digest('e'),
              attestation_digest: digest('f'),
              started_at: '2026-07-25T12:01:00.000Z',
              finished_at: '2026-07-25T12:02:00.000Z',
              created_at: '2026-07-25T12:00:30.000Z',
              findings: [
                {
                  finding_id: 'finding-1',
                  fingerprint: digest('1'),
                  scanner: 'semgrep',
                  rule_id: 'network.dynamic-endpoint',
                  severity: 'high',
                  path: 'src/index.ts',
                  location: { line: 14 },
                  summary: 'Dynamic endpoint requires review.',
                  disposition: 'observed',
                  created_at: '2026-07-25T12:01:30.000Z',
                },
                {
                  finding_id: 'finding-2',
                  fingerprint: digest('2'),
                  scanner: 'sandbox',
                  rule_id: 'filesystem.observed',
                  severity: 'low',
                  path: null,
                  location: null,
                  summary: 'Temporary file was contained.',
                  disposition: 'observed',
                  created_at: '2026-07-25T12:01:40.000Z',
                },
              ],
              attestation: {
                attestation_digest: digest('f'),
                subject_artifact_digest: digest('a'),
                predicate_type: 'https://openopc.dev/attestation/module-trust/v1',
                policy_digest: digest('b'),
                result: 'passed',
                sbom_digest: digest('e'),
                issuer: 'openopc-developer-trust-worker',
                created_at: '2026-07-25T12:02:00.000Z',
              },
            },
          ],
        }}
        gateStatus={{ ready: true, code: null, message: 'Automatic trust checks passed.' }}
        requirements={['source_scan', 'sandbox_test']}
        showProvenance
      />,
    );

    expect(html).toContain('Automatic trust checks passed');
    expect(html).toContain('Source scan');
    expect(html).toContain('Sandbox test');
    expect(html).toContain('High findings');
    expect(html).toContain('Low findings');
    expect(html).toContain('Dynamic endpoint requires review');
    expect(html).toContain('SBOM digest');
    expect(html).toContain('openopc-developer-trust-worker');
    expect(html).toContain('Source provenance');
    expect(html).toContain('Attempt 1');
    expect(html).not.toContain('storage_key');
    expect(html).not.toContain('lease_owner');
  });

  test('shows bounded retry only for a terminal attempt', () => {
    const base = {
      release_id: 'release-1',
      account_id: 'account-1',
      artifact: {
        artifact_id: 'artifact-1',
        artifact_digest: `sha256:${'a'.repeat(64)}` as const,
        media_type: 'application/vnd.openopc.developer-module.v2+json',
        size_bytes: 10,
        source_provenance: null,
        created_at: '2026-07-25T12:00:00.000Z',
      },
      attempts: [
        {
          run_id: 'run-1',
          attempt: 1,
          state: 'failed' as const,
          policy_digest: `sha256:${'b'.repeat(64)}` as const,
          scanner_set_digest: `sha256:${'c'.repeat(64)}` as const,
          sandbox_profile_digest: `sha256:${'d'.repeat(64)}` as const,
          terminal_reason: 'Sandbox policy denied the module.',
          sbom_digest: null,
          attestation_digest: null,
          started_at: null,
          finished_at: '2026-07-25T12:02:00.000Z',
          created_at: '2026-07-25T12:00:30.000Z',
          findings: [],
          attestation: null,
        },
      ],
    };
    const failed = renderToStaticMarkup(
      <DeveloperModuleTrustSummary
        trust={base}
        gateStatus={{
          ready: false,
          code: 'DEVELOPER_TRUST_NOT_PASSED',
          message: 'Sandbox verification did not pass.',
        }}
        requirements={['sandbox_test']}
        canRetry
        onRetry={() => undefined}
      />,
    );
    const running = renderToStaticMarkup(
      <DeveloperModuleTrustSummary
        trust={{ ...base, attempts: [{ ...base.attempts[0], state: 'running' }] }}
        gateStatus={{
          ready: false,
          code: 'DEVELOPER_TRUST_PENDING',
          message: 'Sandbox verification is still running.',
        }}
        requirements={['sandbox_test']}
        canRetry
        onRetry={() => undefined}
      />,
    );

    expect(failed).toContain('Retry verification');
    expect(failed).toContain('Sandbox policy denied the module');
    expect(running).toContain('Sandbox verification is still running');
    expect(running).not.toContain('Retry verification');
  });
});
