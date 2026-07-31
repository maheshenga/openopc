import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';
import type { AuthedPrincipal } from '@kortix/llm-gateway';

const hooksModule = await import('./hooks');

const CLAIMS: ModuleServiceCapabilityClaimsV1 = {
  schemaVersion: 1,
  iss: 'openopc-control-plane',
  aud: 'openopc:module-service',
  jti: '00000000-0000-4000-8000-000000000001',
  iat: '2026-08-01T00:00:00.000Z',
  exp: '2026-08-01T00:05:00.000Z',
  accountId: '10000000-0000-4000-a000-000000000001',
  projectId: '20000000-0000-4000-a000-000000000001',
  installationId: '30000000-0000-4000-a000-000000000001',
  installRevision: 4,
  releaseId: '40000000-0000-4000-a000-000000000001',
  moduleId: 'example.weather-station',
  moduleVersion: '1.2.3',
  consentId: '50000000-0000-4000-a000-000000000001',
  grantId: '60000000-0000-4000-8000-000000000001',
  service: 'ai',
  operations: ['text.generate'],
};

describe('module service gateway principal', () => {
  test('uses the grant as a machine actor and enriches the immutable account/project scope', async () => {
    const createPrincipal = (
      hooksModule as typeof hooksModule & {
        createModuleServiceGatewayPrincipal?: (
          claims: ModuleServiceCapabilityClaimsV1,
          enrich: (principal: AuthedPrincipal) => Promise<AuthedPrincipal>,
        ) => Promise<AuthedPrincipal>;
      }
    ).createModuleServiceGatewayPrincipal;

    expect(typeof createPrincipal).toBe('function');
    if (!createPrincipal) return;
    const seen: AuthedPrincipal[] = [];
    const principal = await createPrincipal(CLAIMS, async (candidate) => {
      seen.push(candidate);
      return { ...candidate, tier: 'pro', freeModelsOnly: false };
    });

    const basePrincipal = {
      userId: CLAIMS.grantId,
      accountId: CLAIMS.accountId,
      projectId: CLAIMS.projectId,
      sessionId: `module:${CLAIMS.installationId}`,
      keyId: `module:${CLAIMS.grantId}`,
    };
    expect(seen).toEqual([basePrincipal]);
    expect(principal).toEqual({ ...basePrincipal, tier: 'pro', freeModelsOnly: false });
  });
});
