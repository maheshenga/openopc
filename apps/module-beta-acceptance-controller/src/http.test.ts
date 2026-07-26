import { describe, expect, test } from 'bun:test';

import type {
  ModuleBetaArtifactRegistrationRequestV1,
  ModuleBetaArtifactRegistrationResponseV1,
  ModuleBetaCleanupRequestV1,
  ModuleBetaCleanupResponseV1,
  ModuleBetaInspectorEvidenceV1,
} from '@openopc/module-runtime-contracts';

import { createModuleBetaAcceptanceHandler } from './http';

const token = 'acceptance-control-token-for-staging';
const acceptanceRunId = 'gha:12345:1';
const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`;
const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const accountId = '10000000-0000-4000-a000-000000000001';
const artifactId = '20000000-0000-4000-a000-000000000002';
const runId = '30000000-0000-4000-a000-000000000003';

function request(
  path: string,
  input?: { method?: string; body?: unknown; token?: string; run?: string },
) {
  return new Request(`https://acceptance.staging.openopc.example${path}`, {
    method: input?.method ?? 'GET',
    headers: {
      ...(input?.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input?.run ? { 'x-openopc-module-beta-run-id': input.run } : {}),
      ...(input?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input?.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

function fixture() {
  const calls = { registrations: 0, evidence: 0, cleanup: 0 };
  let cleanupState: 'queued' | 'succeeded' = 'queued';
  const port = {
    async registerArtifact(
      input: ModuleBetaArtifactRegistrationRequestV1,
    ): Promise<ModuleBetaArtifactRegistrationResponseV1> {
      calls.registrations += 1;
      return {
        schemaVersion: 1,
        acceptanceRunId: input.acceptanceRunId,
        scenario: input.scenario,
        registered: true,
        faultArmed: input.scenario === 'scanner-crash',
        registrationId: '60000000-0000-4000-a000-000000000006',
        artifactId: input.artifactId,
        artifactDigest: input.artifactDigest,
        expiresAt: '2026-07-26T12:05:00.000Z',
        dependencyIdentity: controllerIdentity,
      };
    },
    async inspect(input: {
      acceptanceRunId: string;
      runId: string;
    }): Promise<ModuleBetaInspectorEvidenceV1 | null> {
      calls.evidence += 1;
      if (input.acceptanceRunId !== acceptanceRunId || input.runId !== runId) return null;
      return {
        schemaVersion: 1,
        acceptanceRunId,
        controllerIdentity,
        runId,
        artifact: {
          storage: 'minio',
          url: 'https://minio.staging.openopc.example/artifact?signature=redacted',
          contentDigest: digest('a'),
          sizeBytes: 128,
          artifactDigest: digest('b'),
        },
        sbom: {
          storage: 'minio',
          url: 'https://minio.staging.openopc.example/sbom?signature=redacted',
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
        scannerIdentities: [`gitleaks@8.24.2#${digest('e')}`],
      };
    },
    async cleanup(input: ModuleBetaCleanupRequestV1): Promise<
      | ModuleBetaCleanupResponseV1
      | {
          schemaVersion: 1;
          acceptanceRunId: string;
          dependencyIdentity: string;
          retentionRunId: string;
          state: 'queued';
        }
    > {
      calls.cleanup += 1;
      if (cleanupState === 'queued') {
        return {
          schemaVersion: 1,
          acceptanceRunId: input.acceptanceRunId,
          dependencyIdentity: controllerIdentity,
          retentionRunId: '70000000-0000-4000-a000-000000000007',
          state: 'queued',
        };
      }
      return {
        schemaVersion: 1,
        acceptanceRunId: input.acceptanceRunId,
        dependencyIdentity: controllerIdentity,
        retention: { expiredProbeDeleted: true, immutableAttemptsPreserved: true },
        orphanCleanup: { cancelledUploadAbsent: true, orphanProbeDeleted: true },
      };
    },
  };
  return {
    calls,
    port,
    completeCleanup() {
      cleanupState = 'succeeded';
    },
  };
}

describe('module beta acceptance HTTP boundary', () => {
  test('is absent when the staging controller is disabled', async () => {
    const { calls, port } = fixture();
    const handler = createModuleBetaAcceptanceHandler({ enabled: false, port });

    const response = await handler(
      request('/module-beta/trust/registrations', {
        method: 'POST',
        token,
        run: acceptanceRunId,
        body: {},
      }),
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual({ registrations: 0, evidence: 0, cleanup: 0 });
  });

  test('returns an opaque 404 without the exact control token and run binding', async () => {
    const { calls, port } = fixture();
    const handler = createModuleBetaAcceptanceHandler({
      enabled: true,
      token,
      controllerIdentity,
      port,
    });

    for (const candidate of [
      request(`/module-beta/trust/runs/${runId}/evidence`, { run: acceptanceRunId }),
      request(`/module-beta/trust/runs/${runId}/evidence`, { token, run: 'gha:other:1' }),
    ]) {
      const response = await handler(candidate);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
    }
    expect(calls.evidence).toBe(1);
  });

  test('returns an opaque 404 for a noncanonical uppercase verification run id', async () => {
    const { calls, port } = fixture();
    const handler = createModuleBetaAcceptanceHandler({
      enabled: true,
      token,
      controllerIdentity,
      port,
    });

    const response = await handler(
      request(`/module-beta/trust/runs/${runId.toUpperCase()}/evidence`, {
        token,
        run: acceptanceRunId,
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
    expect(calls.evidence).toBe(0);
  });

  test('registers only a strict artifact-bound acceptance scenario', async () => {
    const { calls, port } = fixture();
    const handler = createModuleBetaAcceptanceHandler({
      enabled: true,
      token,
      controllerIdentity,
      port,
    });
    const body = {
      schemaVersion: 1,
      acceptanceRunId,
      scenario: 'scanner-crash',
      accountId,
      artifactId,
      artifactDigest: digest('a'),
    };

    const response = await handler(
      request('/module-beta/trust/registrations', {
        method: 'POST',
        token,
        run: acceptanceRunId,
        body,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      acceptanceRunId,
      scenario: 'scanner-crash',
      registered: true,
      faultArmed: true,
      artifactId,
      artifactDigest: digest('a'),
      dependencyIdentity: controllerIdentity,
    });
    expect(calls.registrations).toBe(1);

    const invalid = await handler(
      request('/module-beta/trust/registrations', {
        method: 'POST',
        token,
        run: acceptanceRunId,
        body: { ...body, unexpected: true },
      }),
    );
    expect(invalid.status).toBe(400);
    expect(calls.registrations).toBe(1);
  });

  test('rejects a chunked oversized request before buffering the complete body', async () => {
    const { calls, port } = fixture();
    const handler = createModuleBetaAcceptanceHandler({
      enabled: true,
      token,
      controllerIdentity,
      port,
    });
    let pulls = 0;
    let cancelled = false;
    const chunks = 16;
    const oversized = new Request(
      'https://acceptance.staging.openopc.example/module-beta/trust/registrations',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-openopc-module-beta-run-id': acceptanceRunId,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > chunks) return controller.close();
            controller.enqueue(new Uint8Array(128 * 1024).fill(0x61));
          },
          cancel() {
            cancelled = true;
          },
        }),
      },
    );

    const response = await handler(oversized);

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(chunks);
    expect(calls.registrations).toBe(0);
  });

  test('serves bound evidence and never reports cleanup success before retention completes', async () => {
    const { calls, port, completeCleanup } = fixture();
    const handler = createModuleBetaAcceptanceHandler({
      enabled: true,
      token,
      controllerIdentity,
      port,
    });

    const evidence = await handler(
      request(`/module-beta/trust/runs/${runId}/evidence`, {
        token,
        run: acceptanceRunId,
      }),
    );
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({ runId, acceptanceRunId, controllerIdentity });

    const cleanupBody = {
      schemaVersion: 1,
      acceptanceRunId,
      accountId,
      cancelledUploadId: '40000000-0000-4000-a000-000000000004',
      artifactIds: [artifactId],
      releaseIds: ['50000000-0000-4000-a000-000000000005'],
      verificationRunIds: [runId],
      createExpiredRetentionProbe: true,
      createOrphanObjectProbe: true,
    };
    const pending = await handler(
      request('/module-beta/trust/cleanup', {
        method: 'POST',
        token,
        run: acceptanceRunId,
        body: cleanupBody,
      }),
    );
    expect(pending.status).toBe(202);
    expect(pending.headers.get('retry-after')).toBe('1');
    expect(await pending.json()).toEqual({
      acceptanceRunId,
      dependencyIdentity: controllerIdentity,
      retentionRunId: '70000000-0000-4000-a000-000000000007',
      schemaVersion: 1,
      state: 'queued',
    });
    completeCleanup();
    const cleanup = await handler(
      request('/module-beta/trust/cleanup', {
        method: 'POST',
        token,
        run: acceptanceRunId,
        body: cleanupBody,
      }),
    );
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toMatchObject({
      acceptanceRunId,
      dependencyIdentity: controllerIdentity,
    });
    expect(calls).toEqual({ registrations: 0, evidence: 1, cleanup: 2 });
  });
});
