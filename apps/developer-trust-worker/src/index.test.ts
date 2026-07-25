import { describe, expect, test } from 'bun:test';

import { loadDeveloperTrustWorkerConfig } from './config';
import * as developerTrustWorkerModule from './index';
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
  test('reports every component disabled without probing when the worker is disabled', async () => {
    const createReadiness = (
      developerTrustWorkerModule as unknown as {
        createDeveloperTrustReadiness?: (input: unknown) => { check(): Promise<unknown> };
      }
    ).createDeveloperTrustReadiness;
    expect(createReadiness).toBeFunction();
    if (!createReadiness) return;
    let probes = 0;

    const readiness = createReadiness({
      enabled: false,
      artifactStore: async () => {
        probes += 1;
      },
      policy: async () => {
        probes += 1;
      },
      scanners: {
        gitleaks: async () => {
          probes += 1;
          return 'ready';
        },
      },
      sandbox: async () => {
        probes += 1;
      },
      databaseClaims: async () => {
        probes += 1;
      },
    });

    await expect(readiness.check()).resolves.toEqual({
      enabled: false,
      ready: false,
      artifactStore: 'disabled',
      policy: 'disabled',
      scanners: { gitleaks: 'disabled' },
      sandbox: 'disabled',
      databaseClaims: 'disabled',
    });
    expect(probes).toBe(0);
  });

  test('reports component failures separately and only becomes ready when all probes pass', async () => {
    const createReadiness = (
      developerTrustWorkerModule as unknown as {
        createDeveloperTrustReadiness?: (input: unknown) => { check(): Promise<unknown> };
      }
    ).createDeveloperTrustReadiness;
    expect(createReadiness).toBeFunction();
    if (!createReadiness) return;

    const degraded = createReadiness({
      enabled: true,
      artifactStore: async () => undefined,
      policy: async () => {
        throw new Error('invalid policy fixture');
      },
      scanners: {
        gitleaks: async () => 'ready',
        syft: async () => 'identity_mismatch',
        semgrep: async () => {
          throw new Error('scanner unavailable fixture');
        },
      },
      sandbox: async () => {
        throw new Error('sandbox unavailable fixture');
      },
      databaseClaims: async () => undefined,
    });

    await expect(degraded.check()).resolves.toEqual({
      enabled: true,
      ready: false,
      artifactStore: 'ready',
      policy: 'invalid',
      scanners: {
        gitleaks: 'ready',
        syft: 'identity_mismatch',
        semgrep: 'unavailable',
      },
      sandbox: 'unavailable',
      databaseClaims: 'ready',
    });

    const ready = createReadiness({
      enabled: true,
      artifactStore: async () => undefined,
      policy: async () => undefined,
      scanners: {
        gitleaks: async () => 'ready',
        syft: async () => 'ready',
      },
      sandbox: async () => undefined,
      databaseClaims: async () => undefined,
    });
    await expect(ready.check()).resolves.toEqual(
      expect.objectContaining({ enabled: true, ready: true }),
    );
  });

  test('serves liveness separately from internal readiness without exposing other routes', async () => {
    const createHealthHandler = (
      developerTrustWorkerModule as unknown as {
        createDeveloperTrustHealthHandler?: (input: {
          check(): Promise<Record<string, unknown>>;
        }) => (request: Request) => Promise<Response>;
      }
    ).createDeveloperTrustHealthHandler;
    expect(createHealthHandler).toBeFunction();
    if (!createHealthHandler) return;
    const handler = createHealthHandler({
      check: async () => ({ enabled: true, ready: false, artifactStore: 'unavailable' }),
    });

    const health = await handler(new Request('http://worker.internal/healthz'));
    const readiness = await handler(new Request('http://worker.internal/readyz'));
    const hidden = await handler(new Request('http://worker.internal/scanners'));

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual(
      expect.objectContaining({ enabled: true, ready: false, artifactStore: 'unavailable' }),
    );
    expect(hidden.status).toBe(404);
  });

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
