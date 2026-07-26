import { describe, expect, test } from 'bun:test';

import type {
  ModuleBetaArtifactRegistrationResponseV1,
  ModuleBetaCleanupRequestV1,
  ModuleBetaCleanupResponseV1,
  ModuleBetaInspectorEvidenceV1,
} from './module-beta-acceptance';
import {
  parseModuleBetaArtifactRegistrationRequest,
  parseModuleBetaArtifactRegistrationResponse,
  parseModuleBetaCleanupRequest,
  parseModuleBetaCleanupResponse,
  parseModuleBetaInspectorEvidence,
} from './module-beta-acceptance';

const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;

describe('module beta acceptance contract v1', () => {
  test('registers clean and malicious verification artifacts under one acceptance run', () => {
    const base = {
      schemaVersion: 1,
      acceptanceRunId: 'gha:12345:1',
      accountId: '10000000-0000-4000-a000-000000000001',
      artifactId: '20000000-0000-4000-a000-000000000002',
      artifactDigest: digest('a'),
    } as const;

    expect(
      parseModuleBetaArtifactRegistrationRequest({ ...base, scenario: 'clean-wasi' }),
    ).toMatchObject({ scenario: 'clean-wasi' });
    expect(() =>
      parseModuleBetaArtifactRegistrationRequest({ ...base, scenario: 'traversal' }),
    ).toThrow('MODULE_BETA_ARTIFACT_REGISTRATION_INVALID');
    expect(() =>
      parseModuleBetaArtifactRegistrationRequest({
        ...base,
        artifactId: base.artifactId.toUpperCase(),
      }),
    ).toThrow('MODULE_BETA_ARTIFACT_REGISTRATION_INVALID');

    const response: ModuleBetaArtifactRegistrationResponseV1 = {
      schemaVersion: 1,
      acceptanceRunId: 'gha:12345:1',
      scenario: 'clean-wasi',
      registered: true,
      faultArmed: false,
      registrationId: '60000000-0000-4000-a000-000000000006',
      artifactId: '20000000-0000-4000-a000-000000000002',
      artifactDigest: digest('a'),
      expiresAt: '2026-07-26T12:05:00.000Z',
      dependencyIdentity: `module-beta-controller@1.0.0#${digest('1')}`,
    };
    expect(parseModuleBetaArtifactRegistrationResponse(response)).toEqual(response);
    expect(() =>
      parseModuleBetaArtifactRegistrationResponse({ ...response, faultArmed: true }),
    ).toThrow('MODULE_BETA_ARTIFACT_REGISTRATION_RESPONSE_INVALID');
    expect(() =>
      parseModuleBetaArtifactRegistrationResponse({
        ...response,
        dependencyIdentity: response.dependencyIdentity.replace('#sha256:', '#SHA256:'),
      }),
    ).toThrow('MODULE_BETA_ARTIFACT_REGISTRATION_RESPONSE_INVALID');
  });

  test('accepts inspector evidence without trusting a response-supplied public key', () => {
    const evidence: ModuleBetaInspectorEvidenceV1 = {
      schemaVersion: 1,
      acceptanceRunId: 'gha:12345:1',
      controllerIdentity: `module-beta-controller@1.0.0#${digest('1')}`,
      runId: '30000000-0000-4000-a000-000000000003',
      artifact: {
        storage: 'minio',
        url: 'https://minio.staging.openopc.example/artifacts/a?signature=redacted',
        contentDigest: digest('a'),
        sizeBytes: 128,
        artifactDigest: digest('b'),
      },
      sbom: {
        storage: 'minio',
        url: 'https://minio.staging.openopc.example/evidence/sbom?signature=redacted',
        contentDigest: digest('c'),
        sizeBytes: 64,
      },
      attestation: {
        digest: digest('d'),
        keyId: 'openopc-attestation-staging-2026-07',
        envelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: 'e30=',
          signatures: [{ keyid: 'openopc-attestation-staging-2026-07', sig: 'AA==' }],
        },
      },
      scannerIdentities: [`gitleaks@8.24.2#${digest('e')}`, `syft@1.28.0#${digest('f')}`],
    };

    expect(parseModuleBetaInspectorEvidence(evidence)).toEqual(evidence);
    expect(() =>
      parseModuleBetaInspectorEvidence({
        ...evidence,
        attestation: { ...evidence.attestation, publicKeySpkiBase64: 'untrusted' },
      }),
    ).toThrow('MODULE_BETA_INSPECTOR_EVIDENCE_INVALID');
  });

  test('cleanup is bounded to resources created by one acceptance run', () => {
    const request: ModuleBetaCleanupRequestV1 = {
      schemaVersion: 1,
      acceptanceRunId: 'gha:12345:1',
      accountId: '10000000-0000-4000-a000-000000000001',
      cancelledUploadId: '40000000-0000-4000-a000-000000000004',
      artifactIds: ['20000000-0000-4000-a000-000000000002'],
      releaseIds: ['50000000-0000-4000-a000-000000000005'],
      verificationRunIds: ['30000000-0000-4000-a000-000000000003'],
      createExpiredRetentionProbe: true,
      createOrphanObjectProbe: true,
    };

    expect(parseModuleBetaCleanupRequest(request)).toEqual(request);
    expect(() =>
      parseModuleBetaCleanupRequest({
        ...request,
        verificationRunIds: [request.verificationRunIds[0].toUpperCase()],
      }),
    ).toThrow('MODULE_BETA_CLEANUP_REQUEST_INVALID');
    expect(() =>
      parseModuleBetaCleanupRequest({
        ...request,
        verificationRunIds: [...request.verificationRunIds, request.verificationRunIds[0]],
      }),
    ).toThrow('MODULE_BETA_CLEANUP_REQUEST_INVALID');
    for (const field of ['artifactIds', 'releaseIds', 'verificationRunIds'] as const) {
      expect(() => parseModuleBetaCleanupRequest({ ...request, [field]: [] })).toThrow(
        'MODULE_BETA_CLEANUP_REQUEST_INVALID',
      );
    }
  });

  test('accepts only a fully bound cleanup receipt', () => {
    const response: ModuleBetaCleanupResponseV1 = {
      schemaVersion: 1,
      acceptanceRunId: 'gha:12345:1',
      dependencyIdentity: `module-beta-controller@1.0.0#${digest('1')}`,
      retention: {
        expiredProbeDeleted: true,
        immutableAttemptsPreserved: true,
      },
      orphanCleanup: {
        cancelledUploadAbsent: true,
        orphanProbeDeleted: true,
      },
    };

    expect(parseModuleBetaCleanupResponse(response)).toEqual(response);
    expect(() =>
      parseModuleBetaCleanupResponse({
        ...response,
        retention: { ...response.retention, immutableAttemptsPreserved: false },
      }),
    ).toThrow('MODULE_BETA_CLEANUP_RESPONSE_INVALID');
  });
});
