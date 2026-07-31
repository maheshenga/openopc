import { describe, expect, test } from 'bun:test';
import { generateKeys } from 'paseto-ts/v4';

import type { RegistryModuleManifest } from '@kortix/registry';

import {
  ModuleServiceCapabilityBroker,
  type ModuleServiceCapabilityGrant,
  type ModuleServiceCapabilityRepository,
  type ModuleServiceConsent,
  ModuleServiceConsentManager,
  type ModuleServiceInstallationContext,
  hashModuleServiceCapabilityToken,
} from './capability-grants';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000009';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const OTHER_INSTALLATION_ID = '30000000-0000-4000-a000-000000000009';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const OTHER_RELEASE_ID = '40000000-0000-4000-a000-000000000009';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const OTHER_CONSENT_ID = '50000000-0000-4000-a000-000000000009';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const JTI = '70000000-0000-4000-8000-000000000001';
const USER_ID = '80000000-0000-4000-a000-000000000001';
const NOW = '2026-08-01T00:00:00.000Z';

function manifest(): RegistryModuleManifest {
  return {
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
      services: {
        ai: { operations: ['models.read', 'text.generate', 'text.stream'] },
      },
    },
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
    signature: `base64url:${'a'.repeat(86)}`,
    signedAt: NOW,
    manifest: manifest(),
  };
}

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
    consentDigest: `sha256:${'b'.repeat(64)}`,
    acceptedBy: USER_ID,
    acceptedAt: NOW,
    revokedBy: null,
    revokedAt: null,
  };
}

function fixture() {
  const state: {
    installation: ModuleServiceInstallationContext;
    consent: ModuleServiceConsent;
    grant: ModuleServiceCapabilityGrant | null;
    audits: Array<Record<string, unknown>>;
  } = {
    installation: installation(),
    consent: consent(),
    grant: null,
    audits: [],
  };

  const repository: ModuleServiceCapabilityRepository = {
    async resolveInstallation(input) {
      const current = state.installation;
      return input.accountId === current.accountId &&
        input.projectId === current.projectId &&
        input.installationId === current.installationId
        ? structuredClone(current)
        : null;
    },
    async listConsents() {
      return [structuredClone(state.consent)];
    },
    async findActiveConsent(input) {
      const current = state.consent;
      return input.accountId === current.accountId &&
        input.projectId === current.projectId &&
        input.installationId === current.installationId &&
        input.releaseId === current.releaseId &&
        input.installRevision === current.installRevision &&
        input.service === current.service &&
        current.revokedAt === null
        ? structuredClone(current)
        : null;
    },
    async createConsent(input) {
      state.consent = structuredClone(input.consent);
      state.audits.push(structuredClone(input.audit) as unknown as Record<string, unknown>);
      return structuredClone(state.consent);
    },
    async storeGrant(input) {
      const currentConsent = state.consent;
      const currentInstallation = state.installation;
      if (
        currentConsent.revokedAt !== null ||
        currentInstallation.installRevision !== input.installRevision ||
        currentInstallation.releaseId !== input.releaseId
      ) {
        throw new Error('grant state changed');
      }
      state.grant = {
        grantId: input.grantId,
        accountId: input.accountId,
        projectId: input.projectId,
        installationId: input.installationId,
        releaseId: input.releaseId,
        consentId: input.consentId,
        service: input.service,
        operations: [...input.operations],
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: NOW,
      };
      state.audits.push(structuredClone(input.audit) as unknown as Record<string, unknown>);
      return structuredClone(state.grant);
    },
    async getAuthorization(grantId) {
      if (!state.grant || state.grant.grantId !== grantId) return null;
      return {
        grant: structuredClone(state.grant),
        consent: structuredClone(state.consent),
        installation: structuredClone(state.installation),
      };
    },
    async revokeByConsent(input) {
      if (input.consentId !== state.consent.consentId || state.consent.revokedAt) return null;
      state.consent.revokedBy = input.actorUserId;
      state.consent.revokedAt = input.revokedAt;
      if (state.grant) state.grant.revokedAt = input.revokedAt;
      state.audits.push({
        eventId: input.auditEventId,
        accountId: state.consent.accountId,
        projectId: state.consent.projectId,
        installationId: state.consent.installationId,
        releaseId: state.consent.releaseId,
        grantId: null,
        service: state.consent.service,
        operation: null,
        outcome: 'revoked',
        code: null,
        requestId: input.requestId,
        createdAt: input.revokedAt,
      });
      return { consent: structuredClone(state.consent), revokedGrantCount: state.grant ? 1 : 0 };
    },
    async appendAudit(input) {
      state.audits.push(structuredClone(input) as unknown as Record<string, unknown>);
    },
  };

  const keys = generateKeys('public');
  let observedAt = NOW;
  const broker = new ModuleServiceCapabilityBroker({
    repository,
    secretKey: keys.secretKey,
    publicKey: keys.publicKey,
    keyId: 'openopc-module-service-staging-2026-08',
    now: () => new Date(observedAt),
    createGrantId: () => GRANT_ID,
    createJti: () => JTI,
  });
  return {
    broker,
    repository,
    state,
    setNow(value: string) {
      observedAt = value;
    },
  };
}

function issueInput() {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    service: 'ai' as const,
    operations: ['models.read', 'text.generate'] as const,
    actorUserId: USER_ID,
  };
}

function requireInput() {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    service: 'ai' as const,
    operation: 'models.read' as const,
  };
}

describe('module service capability broker', () => {
  test('issues a five-minute v4.public token and persists only its SHA-256 hash', async () => {
    const { broker, state } = fixture();

    const issued = await broker.issue(issueInput());

    expect(issued.token.startsWith('v4.public.')).toBe(true);
    expect(issued.grant).toMatchObject({
      grantId: GRANT_ID,
      consentId: CONSENT_ID,
      tokenHash: hashModuleServiceCapabilityToken(issued.token),
      expiresAt: '2026-08-01T00:05:00.000Z',
    });
    expect(JSON.stringify(issued.grant)).not.toContain(issued.token);
    expect(state.audits).toEqual([
      expect.objectContaining({ outcome: 'issued', grantId: GRANT_ID, operation: null }),
    ]);
  });

  test('verifies a token only for its exact request scope and operation', async () => {
    const { broker } = fixture();
    const issued = await broker.issue(issueInput());

    await expect(broker.verify(issued.token, requireInput())).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      installRevision: 4,
      releaseId: RELEASE_ID,
      consentId: CONSENT_ID,
      grantId: GRANT_ID,
      service: 'ai',
      operations: ['models.read', 'text.generate'],
    });
  });

  test.each([
    ['account', { accountId: OTHER_ACCOUNT_ID }],
    ['project', { projectId: OTHER_PROJECT_ID }],
    ['installation', { installationId: OTHER_INSTALLATION_ID }],
    ['release', { releaseId: OTHER_RELEASE_ID }],
  ])('rejects a %s scope mismatch', async (_label, change) => {
    const { broker } = fixture();
    const issued = await broker.issue(issueInput());

    await expect(
      broker.verify(issued.token, { ...requireInput(), ...change }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH' });
  });

  test('rejects a stale installation revision', async () => {
    const { broker } = fixture();
    const issued = await broker.issue(issueInput());

    await expect(
      broker.verify(issued.token, { ...requireInput(), installRevision: 5 }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_INSTALLATION_STALE' });
  });

  test('rejects an operation absent from the signed capability', async () => {
    const { broker } = fixture();
    const issued = await broker.issue(issueInput());

    await expect(
      broker.verify(issued.token, { ...requireInput(), operation: 'text.stream' }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_OPERATION_DENIED' });
  });

  test('rejects a grant whose durable consent identity no longer matches', async () => {
    const { broker, state } = fixture();
    const issued = await broker.issue(issueInput());
    state.consent.consentId = OTHER_CONSENT_ID;

    await expect(broker.verify(issued.token, requireInput())).rejects.toMatchObject({
      code: 'MODULE_SERVICE_CONSENT_REVOKED',
    });
  });

  test.each([
    [
      'account',
      (value: ModuleServiceConsent) => {
        value.accountId = OTHER_ACCOUNT_ID;
      },
    ],
    [
      'project',
      (value: ModuleServiceConsent) => {
        value.projectId = OTHER_PROJECT_ID;
      },
    ],
    [
      'installation',
      (value: ModuleServiceConsent) => {
        value.installationId = OTHER_INSTALLATION_ID;
      },
    ],
    [
      'release',
      (value: ModuleServiceConsent) => {
        value.releaseId = OTHER_RELEASE_ID;
      },
    ],
    [
      'revision',
      (value: ModuleServiceConsent) => {
        value.installRevision = 5;
      },
    ],
    [
      'operation set',
      (value: ModuleServiceConsent) => {
        value.operations = ['models.read'];
      },
    ],
  ])('rejects a consent whose durable %s summary no longer matches', async (_label, mutate) => {
    const { broker, state } = fixture();
    const issued = await broker.issue(issueInput());
    mutate(state.consent);

    await expect(broker.verify(issued.token, requireInput())).rejects.toMatchObject({
      code: 'MODULE_SERVICE_CONSENT_REVOKED',
    });
  });

  test('rejects a grant whose durable issue timestamps no longer match the token', async () => {
    const { broker, state } = fixture();
    const issued = await broker.issue(issueInput());
    if (!state.grant) throw new Error('grant was not persisted');
    state.grant.expiresAt = '2026-08-01T00:06:00.000Z';

    await expect(broker.verify(issued.token, requireInput())).rejects.toMatchObject({
      code: 'MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH',
    });
  });

  test('revocation invalidates the grant and records the actor without exposing the token', async () => {
    const { broker, state } = fixture();
    const issued = await broker.issue(issueInput());

    await broker.revokeByConsent(CONSENT_ID, USER_ID);

    await expect(broker.verify(issued.token, requireInput())).rejects.toMatchObject({
      code: 'MODULE_SERVICE_CAPABILITY_REVOKED',
    });
    expect(state.consent).toMatchObject({ revokedBy: USER_ID, revokedAt: NOW });
    expect(state.audits.at(-1)).toEqual(
      expect.objectContaining({ outcome: 'revoked', grantId: null }),
    );
  });

  test('rejects the token at its exact expiry boundary', async () => {
    const { broker, setNow } = fixture();
    const issued = await broker.issue(issueInput());
    setNow('2026-08-01T00:05:00.000Z');

    await expect(broker.verify(issued.token, requireInput())).rejects.toMatchObject({
      code: 'MODULE_SERVICE_CAPABILITY_EXPIRED',
    });
  });
});

describe('module service consent manager', () => {
  test('creates an immutable consent snapshot bound to the active installation revision', async () => {
    const { repository, state } = fixture();
    state.consent.revokedBy = USER_ID;
    state.consent.revokedAt = NOW;
    const manager = new ModuleServiceConsentManager({
      repository,
      now: () => new Date(NOW),
      createConsentId: () => CONSENT_ID,
      createAuditId: () => '90000000-0000-4000-8000-000000000001',
      createRequestId: () => '90000000-0000-4000-8000-000000000002',
    });

    const created = await manager.grant({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      installRevision: 4,
      service: 'ai',
      operations: ['models.read', 'text.generate'],
      actorUserId: USER_ID,
    });

    expect(created).toMatchObject({
      consentId: CONSENT_ID,
      releaseId: RELEASE_ID,
      installRevision: 4,
      service: 'ai',
      operations: ['models.read', 'text.generate'],
      consentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      revokedAt: null,
    });
    expect(state.audits.at(-1)).toEqual(
      expect.objectContaining({ outcome: 'consent_granted', grantId: null }),
    );
  });

  test('returns an identical active consent but rejects a silent operation-set replacement', async () => {
    const { repository } = fixture();
    const manager = new ModuleServiceConsentManager({ repository, now: () => new Date(NOW) });

    await expect(
      manager.grant({
        ...issueInput(),
        operations: ['models.read', 'text.generate'],
      }),
    ).resolves.toEqual(consent());
    await expect(
      manager.grant({
        ...issueInput(),
        operations: ['models.read'],
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_CONFLICT' });
  });

  test('rejects stale revisions and undeclared cross-service consent', async () => {
    const { repository } = fixture();
    const manager = new ModuleServiceConsentManager({ repository, now: () => new Date(NOW) });

    await expect(manager.grant({ ...issueInput(), installRevision: 5 })).rejects.toMatchObject({
      code: 'MODULE_SERVICE_INSTALLATION_STALE',
    });
    await expect(
      manager.grant({
        ...issueInput(),
        service: 'payment',
        operations: ['orders.create'],
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_NOT_DECLARED' });
  });

  test('revokes the current consent and all grants only at the matching revision', async () => {
    const { repository, state } = fixture();
    const manager = new ModuleServiceConsentManager({
      repository,
      now: () => new Date(NOW),
      createAuditId: () => '90000000-0000-4000-8000-000000000001',
      createRequestId: () => '90000000-0000-4000-8000-000000000002',
    });

    await expect(
      manager.revoke({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 5,
        service: 'ai',
        actorUserId: USER_ID,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_INSTALLATION_STALE' });
    await expect(
      manager.revoke({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        installRevision: 4,
        service: 'ai',
        actorUserId: USER_ID,
      }),
    ).resolves.toMatchObject({ revokedGrantCount: 0 });
    expect(state.consent).toMatchObject({ revokedBy: USER_ID, revokedAt: NOW });
  });
});
