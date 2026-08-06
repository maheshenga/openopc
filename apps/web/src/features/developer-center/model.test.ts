import type { DeveloperModuleTrustView } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  DEVELOPER_MODULE_INPUT_MAX_BYTES,
  developerCenterErrorCode,
  developerModuleTrustGateStatus,
  filterRecentReleases,
  humanReviewRequirements,
  parseDeveloperModuleInput,
  publisherActionFor,
  requirementComplexity,
} from './model';

describe('Developer Center model', () => {
  test('exposes only legal publisher actions', () => {
    expect(publisherActionFor('validated')).toBe('request_review');
    expect(publisherActionFor('changes_requested')).toBe('resubmit');
    expect(publisherActionFor('review_pending')).toBeNull();
    expect(publisherActionFor('approved')).toBeNull();
    expect(publisherActionFor('revoked')).toBeNull();
  });

  test('rejects malformed and over-limit JSON before an API call', () => {
    expect(parseDeveloperModuleInput('{')).toEqual({ ok: false, code: 'INVALID_JSON' });
    expect(parseDeveloperModuleInput('x'.repeat(DEVELOPER_MODULE_INPUT_MAX_BYTES + 1))).toEqual({
      ok: false,
      code: 'INPUT_TOO_LARGE',
    });
    expect(parseDeveloperModuleInput('{"type":"registry:module"}')).toEqual({
      ok: true,
      item: { type: 'registry:module' },
    });
  });

  test('filters only loaded recent rows without claiming a total', () => {
    const rows = [
      {
        module_id: 'acme.recruiting',
        item_name: 'Recruiting',
        publisher_id: 'acme',
        module_version: '1.0.0',
        status: 'review_pending',
      },
      {
        module_id: 'city.listings',
        item_name: 'Listings',
        publisher_id: 'city',
        module_version: '2.0.0',
        status: 'approved',
      },
    ] as never[];
    expect(filterRecentReleases(rows, 'recruit', 'review_pending')).toHaveLength(1);
    expect(filterRecentReleases(rows, '', 'all')).toHaveLength(2);
  });

  test('maps unknown errors to a stable non-secret code', () => {
    expect(developerCenterErrorCode({ message: 'Bearer private-token' })).toBe(
      'DEVELOPER_REQUEST_FAILED',
    );
    expect(
      developerCenterErrorCode({ status: 409, body: { error: 'DEVELOPER_REVIEW_CONFLICT' } }),
    ).toBe('DEVELOPER_REVIEW_CONFLICT');
    expect(developerCenterErrorCode({ code: 'DEVELOPER_INTERNAL_SECRET' })).toBe(
      'DEVELOPER_REQUEST_FAILED',
    );
    expect(
      developerCenterErrorCode({ body: { error: 'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED' } }),
    ).toBe('DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED');

    for (const code of [
      'DEVELOPER_INPUT_INVALID',
      'DEVELOPER_ORGANIZATION_NOT_FOUND',
      'DEVELOPER_PUBLISHER_FORBIDDEN',
      'DEVELOPER_VERIFICATION_REQUIRED',
      'DEVELOPER_APPLICATION_APPROVAL_REQUIRED',
      'DEVELOPER_AUTHORITY_CONFLICT',
    ] as const) {
      expect(developerCenterErrorCode({ body: { error: code } })).toBe(code);
    }
  });

  test('derives complexity only from declared requirements', () => {
    expect(requirementComplexity(['manifest_review', 'human_review'])).toBe('standard');
    expect(requirementComplexity(['desktop_security_review', 'human_review'])).toBe('elevated');
  });

  test('keeps automatic requirements out of human review evidence', () => {
    expect(
      humanReviewRequirements([
        'manifest_review',
        'source_scan',
        'sandbox_test',
        'sdk_contract_test',
        'permission_review',
      ]),
    ).toEqual(['manifest_review', 'permission_review']);
  });

  test('derives the server trust gate reason from immutable evidence', () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
    const release = {
      artifact_id: 'artifact-1',
      artifact_digest: digest('a'),
      sbom_digest: null,
      trust_attestation_digest: null,
      verification_policy_digest: digest('b'),
      review_requirements: ['source_scan', 'sandbox_test'] as const,
    };
    const trust: DeveloperModuleTrustView = {
      release_id: 'release-1',
      account_id: 'account-1',
      artifact: {
        artifact_id: 'artifact-1',
        artifact_digest: digest('a'),
        media_type: 'application/vnd.openopc.developer-module.v2+json',
        size_bytes: 12,
        source_provenance: null,
        created_at: '2026-07-25T12:00:00.000Z',
      },
      attempts: [
        {
          run_id: 'run-1',
          attempt: 1,
          state: 'running',
          policy_digest: digest('b'),
          scanner_set_digest: digest('c'),
          sandbox_profile_digest: digest('d'),
          terminal_reason: null,
          sbom_digest: null,
          attestation_digest: null,
          started_at: '2026-07-25T12:01:00.000Z',
          finished_at: null,
          created_at: '2026-07-25T12:00:30.000Z',
          findings: [],
          attestation: null,
        },
      ],
    };

    expect(developerModuleTrustGateStatus(release, trust)).toEqual({
      ready: false,
      code: 'DEVELOPER_TRUST_PENDING',
      message: 'Sandbox verification is still running.',
    });

    const passed: DeveloperModuleTrustView = structuredClone(trust);
    passed.attempts[0] = {
      ...passed.attempts[0],
      state: 'passed',
      sbom_digest: digest('e'),
      attestation_digest: digest('f'),
      finished_at: '2026-07-25T12:02:00.000Z',
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
    };
    expect(
      developerModuleTrustGateStatus(
        {
          ...release,
          sbom_digest: digest('e'),
          trust_attestation_digest: digest('f'),
        },
        passed,
      ),
    ).toEqual({ ready: true, code: null, message: 'Automatic trust checks passed.' });
  });
});
