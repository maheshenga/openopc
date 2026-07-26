import { describe, expect, test } from 'bun:test';

import { createModuleBetaAcceptanceController } from './controller';
import type { PostgresModuleBetaAcceptanceRepository } from './postgres';
import type { S3ModuleBetaAcceptanceStore } from './s3';

const acceptanceRunId = 'gha:12345:1';
const accountId = '10000000-0000-4000-a000-000000000001';
const artifactId = '20000000-0000-4000-a000-000000000002';
const runId = '30000000-0000-4000-a000-000000000003';
const uploadId = '40000000-0000-4000-a000-000000000004';
const releaseId = '50000000-0000-4000-a000-000000000005';
const registrationId = '60000000-0000-4000-a000-000000000006';
const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`;
const signedScannerIdentity = `gitleaks@8.28.0#sha256:${'3'.repeat(64)}`;
const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;

const attestationPayload = Buffer.from(
  JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
    subject: [{ name: 'fixture', digest: { sha256: 'a'.repeat(64) } }],
    predicate: {
      scannerIdentities: [signedScannerIdentity],
      scannerIdentityVerified: true,
    },
  }),
).toString('base64');

function fixture() {
  const calls: string[] = [];
  let retentionState: 'queued' | 'running' | 'succeeded' | 'failed' = 'queued';
  let retentionEnqueued = false;
  const retentionRunId = '70000000-0000-4000-a000-000000000007';
  const retentionStatus = () => ({
    runId: retentionRunId,
    acceptanceRunId,
    state: retentionState,
    attempts: retentionState === 'queued' ? 0 : 1,
    availableAt: '2026-07-26T12:00:05.000Z',
    cursor: retentionState === 'running' ? 'opaque-s3-cursor' : null,
    lastError: retentionState === 'failed' ? 'RETENTION_OBJECT_STORE_FAILED' : null,
    leaseOwner: retentionState === 'running' ? 'api-retention-1' : null,
    leaseExpiresAt: retentionState === 'running' ? '2026-07-26T12:00:30.000Z' : null,
    createdAt: '2026-07-26T12:00:00.000Z',
    updatedAt: '2026-07-26T12:00:06.000Z',
    finishedAt:
      retentionState === 'succeeded' || retentionState === 'failed'
        ? '2026-07-26T12:00:06.000Z'
        : null,
  });
  const plan = {
    schemaVersion: 1 as const,
    registrationId,
    acceptanceRunId,
    scenario: 'clean-wasi' as const,
    accountId,
    artifactId,
    artifactDigest: digest('a'),
    issuedAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-07-26T12:10:00.000Z',
    controllerIdentity,
  };
  const repository: PostgresModuleBetaAcceptanceRepository = {
    async assertReady() {
      calls.push('database-ready');
    },
    async getArtifact() {
      calls.push('artifact-binding');
      return {
        accountId,
        artifactId,
        artifactDigest: digest('a'),
        contentDigest: digest('b'),
        storageKey: 'developer-modules/artifacts/partition/object',
        sizeBytes: 128,
      };
    },
    async getRunEvidence() {
      calls.push('evidence-binding');
      return {
        acceptanceRunId,
        runId,
        accountId,
        artifactId,
        artifactDigest: digest('a'),
        artifactContentDigest: digest('b'),
        artifactStorageKey: 'developer-modules/artifacts/partition/object',
        artifactSizeBytes: 128,
        sbomDigest: digest('c'),
        sbomStorageKey: 'developer-trust/evidence/accounts/partition/run/sbom.cdx.json',
        sbomSizeBytes: 64,
        attestationDigest: digest('d'),
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: attestationPayload,
          signatures: [{ keyid: 'openopc-attestation-staging-2026-07', sig: 'AA==' }],
        },
      };
    },
    async getCleanupBinding() {
      calls.push('cleanup-binding');
      return {
        cancelledUploadStorageKey: 'developer-modules/staging/partition/cancelled',
        verificationRuns: [{ runId, artifactId, artifactDigest: digest('a') }],
      };
    },
    async assertAttemptsPreserved() {
      calls.push('attempts-preserved');
    },
    async prepareExpiredRetentionProbe() {
      calls.push('expired-probe-bound');
    },
    async enqueueRetentionRun(input) {
      calls.push(`retention-enqueued:${input.delayMs}`);
      retentionEnqueued = true;
      return retentionStatus();
    },
    async readRetentionRun() {
      if (!retentionEnqueued) return null;
      calls.push('retention-read');
      return retentionStatus();
    },
    async assertExpiredRetentionProbeDeleted() {
      calls.push('expired-marker-deleted');
    },
  };
  const store: S3ModuleBetaAcceptanceStore = {
    async assertReady() {
      calls.push('s3-ready');
    },
    async assertObjectAbsent() {
      calls.push('staging-absent');
    },
    async registerPlan() {
      calls.push('plan-registered');
      return plan;
    },
    async verifyConsumption() {
      calls.push('consumption-verified');
      return plan;
    },
    async verifyAndPresignGet(input) {
      calls.push(`presigned:${input.expectedContentType}`);
      return input.expectedContentType === 'application/vnd.cyclonedx+json'
        ? 'https://minio.staging.openopc.example/sbom?X-Amz-Signature=opaque'
        : 'https://minio.staging.openopc.example/artifact?X-Amz-Signature=opaque';
    },
    async deleteAcceptanceObjects() {
      calls.push('acceptance-deleted');
    },
    async prepareCleanupProbes() {
      calls.push('cleanup-probes-prepared');
      return {
        expiredRetention: {
          uploadId: '80000000-0000-4000-a000-000000000008',
          storageKey: 'developer-modules/staging/acceptance-probes/run/expired-retention.v1.json',
          contentDigest: digest('e'),
          sizeBytes: 128,
        },
        orphanObject: {
          storageKey: 'developer-modules/staging/acceptance-probes/run/orphan.v1.json',
          contentDigest: digest('f'),
          sizeBytes: 64,
        },
      };
    },
    async assertCleanupProbesAbsent() {
      calls.push('cleanup-probes-absent');
    },
  };
  const controller = createModuleBetaAcceptanceController({
    controllerIdentity,
    repository,
    store,
  });
  return {
    calls,
    controller,
    plan,
    repository,
    store,
    setRetentionState(state: typeof retentionState) {
      retentionState = state;
    },
  };
}

describe('module beta acceptance controller', () => {
  test('registers only an artifact with an exact database binding', async () => {
    const { calls, controller } = fixture();

    await expect(
      controller.registerArtifact({
        schemaVersion: 1,
        acceptanceRunId,
        scenario: 'clean-wasi',
        accountId,
        artifactId,
        artifactDigest: digest('a'),
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      acceptanceRunId,
      scenario: 'clean-wasi',
      registered: true,
      faultArmed: false,
      registrationId,
      artifactId,
      artifactDigest: digest('a'),
      expiresAt: '2026-07-26T12:10:00.000Z',
      dependencyIdentity: controllerIdentity,
    });
    expect(calls).toEqual(['artifact-binding', 'plan-registered']);
  });

  test('returns evidence only after consumption and stored object identity verification', async () => {
    const { calls, controller } = fixture();

    await expect(controller.inspect({ acceptanceRunId, runId })).resolves.toEqual({
      schemaVersion: 1,
      acceptanceRunId,
      controllerIdentity,
      runId,
      artifact: {
        storage: 'minio',
        url: 'https://minio.staging.openopc.example/artifact?X-Amz-Signature=opaque',
        contentDigest: digest('b'),
        sizeBytes: 128,
        artifactDigest: digest('a'),
      },
      sbom: {
        storage: 'minio',
        url: 'https://minio.staging.openopc.example/sbom?X-Amz-Signature=opaque',
        contentDigest: digest('c'),
        sizeBytes: 64,
      },
      attestation: {
        digest: digest('d'),
        keyId: 'openopc-attestation-staging-2026-07',
        envelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: attestationPayload,
          signatures: [{ keyid: 'openopc-attestation-staging-2026-07', sig: 'AA==' }],
        },
      },
      scannerIdentities: [signedScannerIdentity],
    });
    expect(calls).toEqual([
      'evidence-binding',
      'consumption-verified',
      'presigned:application/vnd.openopc.developer-module.v2+json',
      'presigned:application/vnd.cyclonedx+json',
    ]);
  });

  test('does not claim cleanup success until the production retention run succeeds', async () => {
    const { calls, controller, setRetentionState } = fixture();
    const request = {
      schemaVersion: 1 as const,
      acceptanceRunId,
      accountId,
      cancelledUploadId: uploadId,
      artifactIds: [artifactId],
      releaseIds: [releaseId],
      verificationRunIds: [runId],
      createExpiredRetentionProbe: true as const,
      createOrphanObjectProbe: true as const,
    };

    await expect(controller.cleanup(request)).resolves.toEqual({
      schemaVersion: 1,
      acceptanceRunId,
      dependencyIdentity: controllerIdentity,
      retentionRunId: '70000000-0000-4000-a000-000000000007',
      state: 'queued',
    });
    expect(calls).toEqual([
      'cleanup-binding',
      'staging-absent',
      'consumption-verified',
      'acceptance-deleted',
      'cleanup-probes-prepared',
      'expired-probe-bound',
      'retention-enqueued:6000',
    ]);
    expect(calls).not.toContain('attempts-preserved');

    calls.length = 0;
    setRetentionState('running');
    await expect(controller.cleanup(request)).resolves.toMatchObject({ state: 'running' });
    expect(calls).toEqual(['cleanup-binding', 'retention-read']);

    calls.length = 0;
    setRetentionState('succeeded');
    await expect(controller.cleanup(request)).resolves.toEqual({
      schemaVersion: 1,
      acceptanceRunId,
      dependencyIdentity: controllerIdentity,
      retention: { expiredProbeDeleted: true, immutableAttemptsPreserved: true },
      orphanCleanup: { cancelledUploadAbsent: true, orphanProbeDeleted: true },
    });
    expect(calls).toEqual([
      'cleanup-binding',
      'retention-read',
      'expired-marker-deleted',
      'cleanup-probes-absent',
      'attempts-preserved',
    ]);
  });

  test('requires both PostgreSQL and S3 readiness', async () => {
    const { calls, controller } = fixture();

    await expect(controller.assertReady()).resolves.toBeUndefined();
    expect(calls.sort()).toEqual(['database-ready', 's3-ready']);
  });
});
