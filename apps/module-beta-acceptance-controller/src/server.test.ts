import { describe, expect, test } from 'bun:test';

import type { ModuleBetaAcceptanceController } from './controller';
import { createModuleBetaAcceptanceServerHandler } from './server';

const token = 'acceptance-control-token-for-staging';
const acceptanceRunId = 'gha:12345:1';
const accountId = '10000000-0000-4000-a000-000000000001';
const artifactId = '20000000-0000-4000-a000-000000000002';
const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`;
const artifactDigest = `sha256:${'a'.repeat(64)}` as const;

describe('module beta acceptance server handler', () => {
  test('keeps business routes absent and readiness false while disabled', async () => {
    const handler = createModuleBetaAcceptanceServerHandler({ enabled: false });

    const health = await handler(new Request('http://controller.internal/healthz'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const readiness = await handler(new Request('http://controller.internal/readyz'));
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({ enabled: false, ready: false, reason: 'disabled' });

    const business = await handler(
      new Request('http://controller.internal/module-beta/trust/registrations', {
        method: 'POST',
      }),
    );
    expect(business.status).toBe(404);
  });

  test('reports dependency readiness and delegates authenticated business requests', async () => {
    let ready = true;
    let readinessCalls = 0;
    const controller: ModuleBetaAcceptanceController = {
      async assertReady() {
        readinessCalls += 1;
        if (!ready) throw new Error('database password must not escape');
      },
      async registerArtifact(input) {
        return {
          schemaVersion: 1,
          acceptanceRunId: input.acceptanceRunId,
          scenario: input.scenario,
          registered: true,
          faultArmed: false,
          registrationId: '60000000-0000-4000-a000-000000000006',
          artifactId: input.artifactId,
          artifactDigest: input.artifactDigest,
          expiresAt: '2026-07-26T12:10:00.000Z',
          dependencyIdentity: controllerIdentity,
        };
      },
      async inspect() {
        return null;
      },
      async cleanup(input) {
        return {
          schemaVersion: 1,
          acceptanceRunId: input.acceptanceRunId,
          dependencyIdentity: controllerIdentity,
          retention: { expiredProbeDeleted: true, immutableAttemptsPreserved: true },
          orphanCleanup: { cancelledUploadAbsent: true, orphanProbeDeleted: true },
        };
      },
    };
    const handler = createModuleBetaAcceptanceServerHandler({
      enabled: true,
      token,
      controllerIdentity,
      controller,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    });

    const readiness = await handler(new Request('http://controller.internal/readyz'));
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({
      enabled: true,
      ready: true,
      identity: controllerIdentity,
      checkedAt: '2026-07-26T12:00:00.000Z',
    });

    const registration = await handler(
      new Request('http://controller.internal/module-beta/trust/registrations', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-openopc-module-beta-run-id': acceptanceRunId,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          acceptanceRunId,
          scenario: 'clean-wasi',
          accountId,
          artifactId,
          artifactDigest,
        }),
      }),
    );
    expect(registration.status).toBe(201);

    ready = false;
    const unavailable = await handler(new Request('http://controller.internal/readyz'));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      enabled: true,
      ready: false,
      identity: controllerIdentity,
      reason: 'dependency_unavailable',
      checkedAt: '2026-07-26T12:00:00.000Z',
    });
    expect(readinessCalls).toBe(2);
  });
});
