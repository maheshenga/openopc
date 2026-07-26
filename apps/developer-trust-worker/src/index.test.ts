import { describe, expect, test } from 'bun:test';
import type { ModuleBetaAcceptancePlanV1 } from '@openopc/module-runtime-contracts';

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
    artifactStorageKey: 'developer-artifacts/acme.clean/1.0.0/module.tar.zst',
    artifactSizeBytes: 1_024,
    runtimeDescriptorPath: 'openopc.runtime.json',
    runtimeKind: 'wasi-component',
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
  const sbomBytes = new TextEncoder().encode('{"bomFormat":"CycloneDX","specVersion":"1.6"}');
  return {
    state: 'passed',
    terminalReason: 'verification completed',
    sbomDigest: digest('e'),
    sbom: {
      document: { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: [] },
      bytes: sbomBytes,
      digest: digest('e'),
    },
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

function evidenceStore(events?: string[]) {
  return {
    async putSbom(input: {
      accountId: string;
      runId: string;
      digest: `sha256:${string}`;
      bytes: Uint8Array;
    }) {
      events?.push('persist');
      return {
        kind: 'sbom' as const,
        bucket: 'developer-trust',
        storageKey: `developer-trust/evidence/accounts/${input.accountId}/runs/${input.runId}/sbom/sha256/${input.digest.slice(7)}.cdx.json`,
        digest: input.digest,
        sizeBytes: input.bytes.byteLength,
        mediaType: 'application/vnd.cyclonedx+json' as const,
      };
    },
  };
}

function acceptancePlan(item: DeveloperTrustWorkItem): ModuleBetaAcceptancePlanV1 {
  return {
    schemaVersion: 1,
    registrationId: '60000000-0000-4000-a000-000000000006',
    acceptanceRunId: 'module-beta-run-1',
    scenario: 'clean-wasi',
    accountId: item.accountId,
    artifactId: item.artifactId,
    artifactDigest: item.artifactDigest,
    issuedAt: '2026-07-25T00:00:00.000Z',
    expiresAt: '2026-07-25T00:15:00.000Z',
    controllerIdentity: `acceptance-controller@1.0.0#${digest('9')}`,
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
    const probe = async () => {
      probes += 1;
    };

    const readiness = createReadiness({
      enabled: false,
      components: Object.fromEntries(
        developerTrustWorkerModule.DEVELOPER_TRUST_READINESS_COMPONENTS.map((name) => [
          name,
          { probe },
        ]),
      ),
    });
    const disabledComponents = Object.fromEntries(
      developerTrustWorkerModule.DEVELOPER_TRUST_READINESS_COMPONENTS.map((name) => [
        name,
        { ready: false, reason: 'disabled' },
      ]),
    );

    await expect(readiness.check()).resolves.toEqual({
      enabled: false,
      ready: false,
      components: disabledComponents,
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
    const readyProbe = async () => undefined;

    const degraded = createReadiness({
      enabled: true,
      components: {
        objectStorage: { probe: readyProbe },
        postgresClaims: { probe: readyProbe },
        policy: {
          probe: async () => {
            throw new Error('invalid policy fixture');
          },
          unavailableReason: 'invalid',
        },
        gitleaks: { probe: readyProbe },
        syft: {
          probe: async () => ({ ready: false, reason: 'identity_mismatch' }),
        },
        osv: { probe: readyProbe },
        semgrep: {
          probe: async () => {
            throw new Error('scanner unavailable fixture');
          },
        },
        licensePolicy: { probe: readyProbe },
        attestationSigner: { probe: readyProbe },
        sandboxControl: {
          probe: async () => {
            throw new Error('sandbox unavailable fixture');
          },
        },
      },
    });

    await expect(degraded.check()).resolves.toMatchObject({
      enabled: true,
      ready: false,
      components: {
        objectStorage: { ready: true, reason: 'ready' },
        postgresClaims: { ready: true, reason: 'ready' },
        policy: { ready: false, reason: 'invalid' },
        syft: { ready: false, reason: 'identity_mismatch' },
        semgrep: { ready: false, reason: 'unavailable' },
        sandboxControl: { ready: false, reason: 'unavailable' },
      },
    });

    const ready = createReadiness({
      enabled: true,
      components: Object.fromEntries(
        developerTrustWorkerModule.DEVELOPER_TRUST_READINESS_COMPONENTS.map((name) => [
          name,
          { probe: readyProbe },
        ]),
      ),
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
    const events: string[] = [];
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
          events.push('finalize');
          finalized.push(input);
        },
      },
      artifactProvider: { prepare: async () => item },
      pipeline: { run: async () => pipelineResult() },
      evidenceStore: evidenceStore(events),
    });

    await expect(worker.runOnce()).resolves.toEqual({ kind: 'processed', runId: item.runId });
    expect(heartbeats).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(['persist', 'finalize']);
    expect(finalized).toEqual([
      expect.objectContaining({
        runId: item.runId,
        workerId: 'worker-a',
        leaseToken: item.leaseToken,
        artifactDigest: item.artifactDigest,
        state: 'passed',
        sbomStorageKey: `developer-trust/evidence/accounts/${item.accountId}/runs/${item.runId}/sbom/sha256/${digest('e').slice(7)}.cdx.json`,
        sbomSizeBytes: pipelineResult().sbom.bytes.byteLength,
      }),
    ]);
  });

  test('consumes an optional acceptance plan after preparation and enriches the pipeline item', async () => {
    const item = workItem();
    const events: string[] = [];
    const pipelineItems: DeveloperTrustWorkItem[] = [];
    const consumeInputs: unknown[] = [];
    const worker = createDeveloperTrustWorker({
      workerId: 'worker-a',
      leaseMs: 30_000,
      control: {
        claim: async () => item,
        heartbeat: async () => undefined,
        finalize: async () => {
          events.push('finalize');
        },
      },
      artifactProvider: {
        prepare: async () => {
          events.push('prepare');
          return item;
        },
        release: async () => {
          events.push('release');
        },
      },
      acceptancePlanConsumer: {
        consume: async (input) => {
          events.push('consume');
          consumeInputs.push(input);
          return acceptancePlan(item);
        },
      },
      pipeline: {
        run: async (pipelineItem) => {
          events.push('pipeline');
          pipelineItems.push(pipelineItem);
          return pipelineResult();
        },
      },
      evidenceStore: evidenceStore(events),
    });

    await expect(worker.runOnce()).resolves.toEqual({ kind: 'processed', runId: item.runId });
    expect(consumeInputs).toEqual([
      {
        accountId: item.accountId,
        artifactId: item.artifactId,
        artifactDigest: item.artifactDigest,
        runId: item.runId,
      },
    ]);
    expect(pipelineItems).toEqual([
      {
        ...item,
        acceptanceRunId: 'module-beta-run-1',
        registrationId: '60000000-0000-4000-a000-000000000006',
        scenario: 'clean-wasi',
      },
    ]);
    expect(events).toEqual(['prepare', 'consume', 'pipeline', 'persist', 'finalize', 'release']);
  });

  test('fails closed when acceptance plan consumption fails', async () => {
    const item = workItem();
    const events: string[] = [];
    let pipelineRuns = 0;
    let evidenceWrites = 0;
    let finalizations = 0;
    const worker = createDeveloperTrustWorker({
      workerId: 'worker-a',
      leaseMs: 30_000,
      control: {
        claim: async () => item,
        heartbeat: async () => undefined,
        finalize: async () => {
          finalizations += 1;
        },
      },
      artifactProvider: {
        prepare: async () => {
          events.push('prepare');
          return item;
        },
        release: async () => {
          events.push('release');
        },
      },
      acceptancePlanConsumer: {
        consume: async () => {
          events.push('consume');
          throw new Error('fixture acceptance credential must not leak');
        },
      },
      pipeline: {
        run: async () => {
          pipelineRuns += 1;
          return pipelineResult();
        },
      },
      evidenceStore: {
        putSbom: async () => {
          evidenceWrites += 1;
          return { storageKey: 'unreachable', sizeBytes: 1 };
        },
      },
    });

    await expect(worker.runOnce()).rejects.toMatchObject({
      code: 'DEVELOPER_TRUST_WORKER_OPERATION_FAILED',
      message: 'DEVELOPER_TRUST_WORKER_OPERATION_FAILED',
    });
    expect(events).toEqual(['prepare', 'consume', 'release']);
    expect(pipelineRuns).toBe(0);
    expect(evidenceWrites).toBe(0);
    expect(finalizations).toBe(0);
  });

  test.each(['claim', 'prepared'] as const)(
    'rejects acceptance context injected by the %s without a consumer',
    async (source) => {
      const item = workItem();
      const injected = {
        ...item,
        acceptanceRunId: 'module-beta-run-1',
        registrationId: '60000000-0000-4000-a000-000000000006',
        scenario: 'clean-wasi' as const,
      };
      let pipelineRuns = 0;
      let evidenceWrites = 0;
      let finalizations = 0;
      const worker = createDeveloperTrustWorker({
        workerId: 'worker-a',
        leaseMs: 30_000,
        control: {
          claim: async () => (source === 'claim' ? injected : item),
          heartbeat: async () => undefined,
          finalize: async () => {
            finalizations += 1;
          },
        },
        artifactProvider: {
          prepare: async () => (source === 'prepared' ? injected : item),
        },
        pipeline: {
          run: async () => {
            pipelineRuns += 1;
            return pipelineResult();
          },
        },
        evidenceStore: {
          putSbom: async () => {
            evidenceWrites += 1;
            return { storageKey: 'unreachable', sizeBytes: 1 };
          },
        },
      });

      await expect(worker.runOnce()).rejects.toMatchObject({
        code: 'DEVELOPER_TRUST_WORK_ITEM_ACCEPTANCE_CONTEXT_FORBIDDEN',
      });
      expect(pipelineRuns).toBe(0);
      expect(evidenceWrites).toBe(0);
      expect(finalizations).toBe(0);
    },
  );

  test('does not finalize when persisting the SBOM fails', async () => {
    const item = workItem();
    let finalizations = 0;
    let releases = 0;
    const worker = createDeveloperTrustWorker({
      workerId: 'worker-a',
      leaseMs: 30_000,
      control: {
        claim: async () => item,
        heartbeat: async () => undefined,
        finalize: async () => {
          finalizations += 1;
        },
      },
      artifactProvider: {
        prepare: async () => item,
        release: async () => {
          releases += 1;
        },
      },
      pipeline: { run: async () => pipelineResult() },
      evidenceStore: {
        putSbom: async () => {
          throw new Error('object storage unavailable');
        },
      },
    });

    await expect(worker.runOnce()).rejects.toMatchObject({
      code: 'DEVELOPER_TRUST_WORKER_OPERATION_FAILED',
    });
    expect(finalizations).toBe(0);
    expect(releases).toBe(1);
  });

  test.each([
    ['artifact storage key', { artifactStorageKey: 'developer-artifacts/tampered.tar.zst' }],
    ['artifact size', { artifactSizeBytes: 2_048 }],
    ['runtime descriptor path', { runtimeDescriptorPath: 'tampered.runtime.json' }],
    ['runtime kind', { runtimeKind: 'oci-image' }],
  ] satisfies ReadonlyArray<readonly [string, Partial<DeveloperTrustWorkItem>]>)(
    'rejects a prepared work item with a changed %s',
    async (_label, override) => {
      const item = workItem();
      let pipelineRuns = 0;
      let finalizations = 0;
      let releases = 0;
      const worker = createDeveloperTrustWorker({
        workerId: 'worker-a',
        leaseMs: 30_000,
        control: {
          claim: async () => item,
          heartbeat: async () => undefined,
          finalize: async () => {
            finalizations += 1;
          },
        },
        artifactProvider: {
          prepare: async () => ({ ...item, ...override }),
          release: async () => {
            releases += 1;
          },
        },
        pipeline: {
          run: async () => {
            pipelineRuns += 1;
            return pipelineResult();
          },
        },
        evidenceStore: evidenceStore(),
      });

      await expect(worker.runOnce()).rejects.toMatchObject({
        code: 'DEVELOPER_TRUST_WORK_ITEM_IDENTITY_MISMATCH',
      });
      expect(pipelineRuns).toBe(0);
      expect(finalizations).toBe(0);
      expect(releases).toBe(1);
    },
  );

  test('disabled config needs no secrets while enabled config is strict and redacted', () => {
    expect(loadDeveloperTrustWorkerConfig({ DEVELOPER_TRUST_ENABLED: 'false' })).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(() => loadDeveloperTrustWorkerConfig({ DEVELOPER_TRUST_ENABLED: 'true' })).toThrow(
      'DEVELOPER_TRUST_CONFIG_INVALID',
    );
  });
});
