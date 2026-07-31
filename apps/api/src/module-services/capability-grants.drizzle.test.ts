import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import type {
  ModuleServiceCapabilityGrant,
  ModuleServiceConsent,
  ModuleServiceInstallationContext,
} from './capability-grants';
import { createDrizzleModuleServiceCapabilityRepository } from './capability-grants.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const EVENT_ID = '70000000-0000-4000-8000-000000000001';
const REQUEST_ID = '80000000-0000-4000-8000-000000000001';
const USER_ID = '90000000-0000-4000-a000-000000000001';
const NOW = '2026-08-01T00:00:00.000Z';
const EXPIRES_AT = '2026-08-01T00:05:00.000Z';
const TOKEN_HASH = `sha256:${'a'.repeat(64)}` as const;

const manifest: ModuleServiceInstallationContext['manifest'] = {
  schemaVersion: 3,
  id: 'example.weather-station',
  version: '1.2.3',
  publisher: { id: 'example-publisher' },
  locales: ['zh-CN'],
  compatibility: { platform: '>=1.0.0', registry: '>=3.0.0' },
  execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
  verification: { profile: 'sandboxed-web' },
  capabilities: [{ id: 'example.weather-station.forecast', kind: 'ui' }],
  openopc: {
    sdkApiVersion: 'v1',
    services: { ai: { operations: ['models.read', 'text.generate'] } },
  },
};

function databaseFixture(results: unknown[]) {
  const pending = [...results];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const executor = {
    async execute(query: unknown) {
      const compiled = new PgDialect().sqlToQuery(query as never);
      queries.push({ sql: compiled.sql, params: compiled.params });
      return pending.shift() ?? [];
    },
  };
  const database = {
    ...executor,
    async transaction<T>(run: (tx: typeof executor) => Promise<T>) {
      return run(executor);
    },
  } as unknown as Database;
  return { database, queries };
}

const installationRow: ModuleServiceInstallationContext = {
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
  manifest,
};

const grantRow: ModuleServiceCapabilityGrant = {
  grantId: GRANT_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  installationId: INSTALLATION_ID,
  releaseId: RELEASE_ID,
  consentId: CONSENT_ID,
  service: 'ai',
  operations: ['models.read'],
  tokenHash: TOKEN_HASH,
  expiresAt: EXPIRES_AT,
  revokedAt: null,
  createdAt: NOW,
};

describe('module service capability Drizzle repository', () => {
  test('resolves the active release only through the exact tenant installation identity', async () => {
    const fixture = databaseFixture([[installationRow]]);
    const repository = createDrizzleModuleServiceCapabilityRepository(fixture.database);

    await expect(
      repository.resolveInstallation({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
      }),
    ).resolves.toEqual(installationRow);

    expect(fixture.queries).toHaveLength(1);
    expect(fixture.queries[0]?.sql).toMatch(
      /project_module_installations[\s\S]*developer_module_releases/,
    );
    expect(fixture.queries[0]?.params).toEqual([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID]);
  });

  test('locks current consent then stores one hash-only grant and issued audit atomically', async () => {
    const fixture = databaseFixture([[{ consentId: CONSENT_ID }], [grantRow], []]);
    const repository = createDrizzleModuleServiceCapabilityRepository(fixture.database);

    await expect(
      repository.storeGrant({
        grantId: GRANT_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        releaseId: RELEASE_ID,
        consentId: CONSENT_ID,
        service: 'ai',
        operations: ['models.read'],
        tokenHash: TOKEN_HASH,
        expiresAt: EXPIRES_AT,
        createdAt: NOW,
        audit: {
          eventId: EVENT_ID,
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          releaseId: RELEASE_ID,
          grantId: GRANT_ID,
          service: 'ai',
          operation: null,
          outcome: 'issued',
          code: null,
          requestId: REQUEST_ID,
          createdAt: NOW,
        },
      }),
    ).resolves.toEqual(grantRow);

    expect(fixture.queries).toHaveLength(3);
    expect(fixture.queries[0]?.sql).toMatch(/FOR UPDATE/);
    expect(fixture.queries[1]?.sql).toContain('module_service_capability_grants');
    expect(fixture.queries[2]?.sql).toContain('module_service_audit_events');
    const allParams = fixture.queries.flatMap((query) => query.params);
    expect(allParams).toEqual(
      expect.arrayContaining([
        ACCOUNT_ID,
        PROJECT_ID,
        INSTALLATION_ID,
        RELEASE_ID,
        CONSENT_ID,
        GRANT_ID,
        TOKEN_HASH,
      ]),
    );
    expect(allParams.some((value) => String(value).startsWith('v4.public.'))).toBe(false);
  });

  test('revokes the consent and every live grant before appending one audit event', async () => {
    const revokedConsent: ModuleServiceConsent = {
      consentId: CONSENT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: RELEASE_ID,
      installRevision: 4,
      service: 'ai',
      operations: ['models.read'],
      consentDigest: `sha256:${'c'.repeat(64)}`,
      acceptedBy: USER_ID,
      acceptedAt: NOW,
      revokedBy: USER_ID,
      revokedAt: NOW,
    };
    const fixture = databaseFixture([
      [{ ...revokedConsent, revokedBy: null, revokedAt: null }],
      [revokedConsent],
      [{ grantId: GRANT_ID }],
      [],
    ]);
    const repository = createDrizzleModuleServiceCapabilityRepository(fixture.database);

    await expect(
      repository.revokeByConsent({
        consentId: CONSENT_ID,
        actorUserId: USER_ID,
        revokedAt: NOW,
        auditEventId: EVENT_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ consent: revokedConsent, revokedGrantCount: 1 });

    expect(fixture.queries.map((query) => query.sql)).toEqual([
      expect.stringMatching(/FOR UPDATE/),
      expect.stringContaining('project_module_service_consents'),
      expect.stringContaining('module_service_capability_grants'),
      expect.stringContaining('module_service_audit_events'),
    ]);
  });
});
