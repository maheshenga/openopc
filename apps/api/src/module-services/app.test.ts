import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

import { PROJECT_ACTIONS } from '../iam/actions';
import { createModuleServiceProjectRoutes } from './app';
import {
  ModuleServiceCapabilityError,
  type ModuleServiceConsent,
  type ModuleServiceInstallationContext,
} from './capability-grants';
import {
  configureModuleServiceCapabilityBroker,
  createModuleServiceCapabilityRequirement,
  requireModuleServiceCapability,
} from './service-auth';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const USER_ID = '70000000-0000-4000-a000-000000000001';
const NOW = '2026-08-01T00:00:00.000Z';

function consent(): ModuleServiceConsent {
  return {
    consentId: CONSENT_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: RELEASE_ID,
    installRevision: 4,
    service: 'ai',
    operations: ['models.read', 'text.generate'],
    consentDigest: `sha256:${'a'.repeat(64)}`,
    acceptedBy: USER_ID,
    acceptedAt: NOW,
    revokedBy: null,
    revokedAt: null,
  };
}

function installation(): ModuleServiceInstallationContext {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.weather-station',
    moduleVersion: '1.2.3',
    installationStatus: 'active',
    releaseStatus: 'published',
    signatureAlgorithm: 'ed25519',
    signature: `base64url:${'b'.repeat(86)}`,
    signedAt: NOW,
    manifest: {
      schemaVersion: 3,
      id: 'example.weather-station',
      version: '1.2.3',
      publisher: { id: 'example-publisher' },
      locales: ['zh-CN'],
      compatibility: { platform: '>=1.0.0' },
      execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
      verification: { profile: 'sandboxed-web' },
      capabilities: [],
      openopc: {
        sdkApiVersion: 'v1',
        services: { ai: { operations: ['models.read', 'text.generate'] } },
      },
    },
  };
}

function appWith(input?: { brokerAvailable?: boolean }) {
  const calls: {
    capabilities: string[];
    grants: Array<Record<string, unknown>>;
    revokes: Array<Record<string, unknown>>;
    issues: Array<Record<string, unknown>>;
  } = { capabilities: [], grants: [], revokes: [], issues: [] };
  const app = createModuleServiceProjectRoutes({
    loadProjectForUser: async (_context, projectId) => ({
      row: { projectId, accountId: ACCOUNT_ID },
      userId: USER_ID,
    }),
    assertProjectCapability: async (_context, userId, accountId, projectId, action) => {
      expect(userId).toBe(USER_ID);
      expect(accountId).toBe(ACCOUNT_ID);
      expect(projectId).toBe(PROJECT_ID);
      calls.capabilities.push(action);
    },
    consentManager: {
      async currentInstallation(scope) {
        expect(scope).toEqual({
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
        });
        return installation();
      },
      async list() {
        return [consent()];
      },
      async grant(command) {
        calls.grants.push(command as unknown as Record<string, unknown>);
        return consent();
      },
      async revoke(command) {
        calls.revokes.push(command as unknown as Record<string, unknown>);
        return {
          consent: { ...consent(), revokedBy: USER_ID, revokedAt: NOW },
          revokedGrantCount: 1,
        };
      },
    },
    capabilityBroker:
      input?.brokerAvailable === false
        ? null
        : {
            async issue(command) {
              calls.issues.push(command as unknown as Record<string, unknown>);
              return {
                token: 'v4.public.redacted',
                grant: {
                  grantId: GRANT_ID,
                  accountId: ACCOUNT_ID,
                  projectId: PROJECT_ID,
                  installationId: INSTALLATION_ID,
                  releaseId: RELEASE_ID,
                  consentId: CONSENT_ID,
                  service: 'ai',
                  operations: ['models.read'],
                  tokenHash: `sha256:${'c'.repeat(64)}`,
                  expiresAt: '2026-08-01T00:05:00.000Z',
                  revokedAt: null,
                  createdAt: NOW,
                },
              };
            },
          },
  });
  return { app, calls };
}

describe('module service project routes', () => {
  test('lists consent views through the project customize-read gate without identity leakage', async () => {
    const { app, calls } = appWith();

    const response = await app.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-consents`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      consents: [
        {
          consent_id: CONSENT_ID,
          installation_id: INSTALLATION_ID,
          release_id: RELEASE_ID,
          install_revision: 4,
          service: 'ai',
          operations: ['models.read', 'text.generate'],
          consent_digest: `sha256:${'a'.repeat(64)}`,
          accepted_at: NOW,
          revoked_at: null,
        },
      ],
    });
    expect(calls.capabilities).toEqual([PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]);
  });

  test('grants exact declared operations through the write gate using server-owned identities', async () => {
    const { app, calls } = appWith();

    const response = await app.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-consents/ai`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operations: ['models.read', 'text.generate'],
          expected_install_revision: 4,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls.capabilities).toEqual([PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE]);
    expect(calls.grants).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        service: 'ai',
        operations: ['models.read', 'text.generate'],
        actorUserId: USER_ID,
      },
    ]);
  });

  test('rejects client account injection and cross-service operations before calling the manager', async () => {
    const { app, calls } = appWith();
    const path = `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-consents/ai`;

    const injected = await app.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: OTHER_ACCOUNT_ID,
        operations: ['models.read'],
        expected_install_revision: 4,
      }),
    });
    const crossed = await app.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operations: ['orders.create'], expected_install_revision: 4 }),
    });

    expect(injected.status).toBe(400);
    expect(crossed.status).toBe(400);
    expect(calls.grants).toEqual([]);
  });

  test('revokes only the matching revision and maps stable service errors', async () => {
    const { app, calls } = appWith();
    const response = await app.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-consents/ai`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_install_revision: 4 }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.revokes).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        service: 'ai',
        actorUserId: USER_ID,
      },
    ]);
  });

  test('issues a capability from the current server-side revision and returns no durable hash', async () => {
    const { app, calls } = appWith();
    const response = await app.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-capabilities`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: 'ai', operations: ['models.read'] }),
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      token: 'v4.public.redacted',
      expires_at: '2026-08-01T00:05:00.000Z',
      grant_id: GRANT_ID,
    });
    expect(calls.issues).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        service: 'ai',
        operations: ['models.read'],
        actorUserId: USER_ID,
      },
    ]);
  });

  test('fails closed when capability signing is not configured', async () => {
    const { app } = appWith({ brokerAvailable: false });
    const response = await app.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-capabilities`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: 'ai', operations: ['models.read'] }),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_UNAVAILABLE' });
  });

  test('maps manager errors without exposing internal details', async () => {
    const { app } = appWith();
    const errorApp = createModuleServiceProjectRoutes({
      loadProjectForUser: async () => ({
        row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID },
        userId: USER_ID,
      }),
      assertProjectCapability: async () => undefined,
      consentManager: {
        currentInstallation: async () => installation(),
        list: async () => {
          throw new ModuleServiceCapabilityError('MODULE_SERVICE_INSTALLATION_STALE', 409);
        },
        grant: async () => consent(),
        revoke: async () => ({ consent: consent(), revokedGrantCount: 0 }),
      },
      capabilityBroker: null,
    });
    const response = await errorApp.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/service-consents`,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_INSTALLATION_STALE' });
    expect(app).toBeDefined();
  });
});

describe('module service authorization header', () => {
  test('passes exactly one bounded Bearer token and request scope to the broker', async () => {
    const expectedClaims: ModuleServiceCapabilityClaimsV1 = {
      schemaVersion: 1,
      iss: 'openopc-control-plane',
      aud: 'openopc:module-service',
      jti: '80000000-0000-4000-8000-000000000001',
      iat: NOW,
      exp: '2026-08-01T00:05:00.000Z',
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      installRevision: 4,
      releaseId: RELEASE_ID,
      moduleId: 'example.weather-station',
      moduleVersion: '1.2.3',
      consentId: CONSENT_ID,
      grantId: GRANT_ID,
      service: 'ai',
      operations: ['models.read'],
    };
    const calls: unknown[] = [];
    const requirement = createModuleServiceCapabilityRequirement({
      async verify(token, scope) {
        calls.push({ token, scope });
        return expectedClaims;
      },
    });

    await expect(
      requirement('Bearer v4.public.redacted', {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        releaseId: RELEASE_ID,
        service: 'ai',
        operation: 'models.read',
      }),
    ).resolves.toEqual(expectedClaims);
    expect(calls).toEqual([
      {
        token: 'v4.public.redacted',
        scope: {
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          installRevision: 4,
          releaseId: RELEASE_ID,
          service: 'ai',
          operation: 'models.read',
        },
      },
    ]);
  });

  test('rejects missing, malformed, and repeated authorization credentials', async () => {
    const requirement = createModuleServiceCapabilityRequirement({
      async verify() {
        throw new Error('must not be called');
      },
    });
    const scope = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      installRevision: 4,
      releaseId: RELEASE_ID,
      service: 'ai' as const,
      operation: 'models.read' as const,
    };

    for (const authorization of [
      undefined,
      '',
      'Basic abc',
      'Bearer',
      'Bearer one Bearer two',
      `Bearer ${'x'.repeat(16_385)}`,
    ]) {
      await expect(requirement(authorization, scope)).rejects.toMatchObject({
        code: 'MODULE_SERVICE_CAPABILITY_INVALID',
      });
    }
  });

  test('the public requirement fails closed until the runtime broker is configured', async () => {
    configureModuleServiceCapabilityBroker(null);
    await expect(
      requireModuleServiceCapability('Bearer v4.public.redacted', {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        releaseId: RELEASE_ID,
        service: 'ai',
        operation: 'models.read',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_UNAVAILABLE' });
  });
});
