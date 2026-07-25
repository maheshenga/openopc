import { describe, expect, test } from 'bun:test';

import { loadDeveloperTrustWorkerConfig } from './config';
import { createDeveloperTrustWorker } from './index';
import type { DeveloperTrustPipelineResult, DeveloperTrustWorkItem } from './pipeline';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function workItem(): DeveloperTrustWorkItem {
  return {
    runId: '50000000-0000-4000-a000-000000000005',
    releaseId: '30000000-0000-4000-a000-000000000003',
    accountId: '10000000-0000-4000-a000-000000000001',
    artifactId: '40000000-0000-4000-a000-000000000004',
    artifactDigest: digest('a'),
    policyDigest: digest('b'),
    scannerSetDigest: digest('c'),
    sandboxProfileDigest: digest('d'),
    attempt: 1,
    leaseToken: 'A'.repeat(43),
    leaseExpiresAt: '2026-07-25T00:05:00.000Z',
    verificationProfile: 'desktop-package',
    moduleId: 'acme.clean',
    moduleVersion: '1.0.0',
    workspacePath: '/tmp/openopc-clean',
    lockGraph: null,
    dependencyLicenses: [],
  };
}

function pipelineResult(): DeveloperTrustPipelineResult {
  return {
    state: 'passed',
    terminalReason: 'verification completed',
    sbomDigest: digest('e'),
    attestationDigest: digest('f'),
    resourceSummary: { scanner_count: 5 },
    findings: [],
    evidenceDigests: [digest('1')],
    attestation: {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'e30=',
      signatures: [{ keyid: 'worker', sig: 'c2ln' }],
    },
    attestationRecord: {
      attestationDigest: digest('f'),
      subjectArtifactDigest: digest('a'),
      predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
      policyDigest: digest('b'),
      result: 'passed',
      sbomDigest: digest('e'),
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: 'e30=',
        signatures: [{ keyid: 'worker', sig: 'c2ln' }],
      },
      issuer: 'openopc-developer-trust-worker',
    },
  };
}

describe('developer trust worker assembly', () => {
  test('claims, heartbeats, runs, and finalizes through injected control ports', async () => {
    const item = workItem();
    const finalized: unknown[] = [];
    let heartbeats = 0;
    const worker = createDeveloperTrustWorker({
      workerId: 'worker-a',
      leaseMs: 30_000,
      control: {
        claim: async () => item,
        heartbeat: async () => {
          heartbeats += 1;
        },
        finalize: async (input) => {
          finalized.push(input);
        },
      },
      artifactProvider: { prepare: async () => item },
      pipeline: { run: async () => pipelineResult() },
    });

    await expect(worker.runOnce()).resolves.toEqual({ kind: 'processed', runId: item.runId });
    expect(heartbeats).toBeGreaterThanOrEqual(1);
    expect(finalized).toEqual([
      expect.objectContaining({
        runId: item.runId,
        workerId: 'worker-a',
        leaseToken: item.leaseToken,
        artifactDigest: item.artifactDigest,
        state: 'passed',
      }),
    ]);
  });

  test('disabled config needs no secrets while enabled config is strict and redacted', () => {
    expect(loadDeveloperTrustWorkerConfig({ DEVELOPER_TRUST_ENABLED: 'false' })).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(() => loadDeveloperTrustWorkerConfig({ DEVELOPER_TRUST_ENABLED: 'true' })).toThrow(
      'DEVELOPER_TRUST_CONFIG_INVALID',
    );
  });
});
