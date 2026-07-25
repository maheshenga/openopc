import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  DeveloperModuleDistributionService,
  createMemoryDeveloperModuleDistributionRepository,
} from './distribution';
import {
  ProjectModuleInstallationError,
  ProjectModuleInstallationService,
  createMemoryProjectModuleInstallationRepository,
} from './installations';
import { createEd25519ModuleSigningPort } from './module-signing';
import { type DeveloperModuleRelease, canonicalDeveloperModuleManifestDigest } from './releases';

const PUBLISHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000003';
const USER_ID = '30000000-0000-4000-a000-000000000003';
const RELEASE_V1 = '40000000-0000-4000-a000-000000000001';
const RELEASE_V2 = '40000000-0000-4000-a000-000000000002';
const RELEASE_NEVER_INSTALLED = '40000000-0000-4000-a000-000000000003';
const MODULE_ID = 'acme.recruiting';
const NOW = new Date('2026-07-24T16:00:00.000Z');
const INSTALLATION_ACTIONS = ['install', 'update', 'rollback'] as const;
const TRUST_DIGEST_FIELDS = [
  'artifact_digest',
  'sbom_digest',
  'trust_attestation_digest',
  'verification_policy_digest',
] as const;

function manifest(
  version: string,
  compatibility: { platform: string; registry?: string } = { platform: '^1.0.0' },
) {
  return {
    schemaVersion: 2 as const,
    id: MODULE_ID,
    version,
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'industry' as const,
    locales: ['en'],
    compatibility,
    execution: { mode: 'declarative' as const },
    capabilities: [{ id: 'acme.recruiting.score', kind: 'task' as const }],
  };
}

function baseRelease(
  releaseId: string,
  version: string,
  overrides: Partial<DeveloperModuleRelease> = {},
): DeveloperModuleRelease {
  const itemManifest = manifest(version);
  return {
    release_id: releaseId,
    account_id: PUBLISHER_ACCOUNT_ID,
    item_name: 'recruiting-workbench',
    publisher_id: 'acme',
    module_id: MODULE_ID,
    module_version: version,
    manifest: itemManifest,
    manifest_digest: canonicalDeveloperModuleManifestDigest(itemManifest),
    artifact_id: '50000000-0000-4000-a000-000000000005',
    artifact_digest: `sha256:${'c'.repeat(64)}`,
    sbom_digest: `sha256:${'d'.repeat(64)}`,
    trust_attestation_digest: `sha256:${'e'.repeat(64)}`,
    verification_policy_digest: `sha256:${'f'.repeat(64)}`,
    review_requirements: ['manifest_review', 'source_scan', 'human_review'],
    status: 'approved',
    review_revision: 2,
    signature_algorithm: null,
    signature_key_id: null,
    signature: null,
    signature_payload_digest: null,
    signed_at: null,
    published_at: null,
    revoked_at: null,
    created_by: USER_ID,
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T12:00:00.000Z',
    ...overrides,
  };
}

async function setup(
  input: {
    releases?: DeveloperModuleRelease[];
    platformVersion?: string;
    registryVersion?: string;
  } = {},
) {
  const keyPair = generateKeyPairSync('ed25519');
  const signingPort = createEd25519ModuleSigningPort({
    keyId: 'module-key-2026',
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  });
  const releases = (
    input.releases ?? [
      baseRelease(RELEASE_V1, '1.0.0'),
      baseRelease(RELEASE_V2, '2.0.0'),
      baseRelease(RELEASE_NEVER_INSTALLED, '3.0.0'),
    ]
  ).map((release) => ({
    ...release,
    manifest_digest: canonicalDeveloperModuleManifestDigest(release.manifest),
  }));
  const distributionRepository = createMemoryDeveloperModuleDistributionRepository({
    releases,
    now: () => NOW,
    createId: (() => {
      let value = 0;
      return () => `50000000-0000-4000-a000-${String(++value).padStart(12, '0')}`;
    })(),
  });
  const distributionService = new DeveloperModuleDistributionService({
    repository: distributionRepository,
    signer: signingPort,
    verifiers: [signingPort],
    trustGate: {
      evaluate: async (candidate) => {
        if (
          !candidate.artifact_digest ||
          !candidate.sbom_digest ||
          !candidate.trust_attestation_digest ||
          !candidate.verification_policy_digest
        ) {
          throw new Error('Trusted installation fixture requires complete digests');
        }
        return {
          ok: true as const,
          evidence: {
            run_id: '70000000-0000-4000-a000-000000000007',
            artifact_digest: candidate.artifact_digest,
            sbom_digest: candidate.sbom_digest,
            attestation_digest: candidate.trust_attestation_digest,
            policy_digest: candidate.verification_policy_digest,
          },
        };
      },
    },
    now: () => NOW,
  });
  for (const release of releases) {
    if (release.status === 'approved') {
      await distributionService.sign({
        releaseId: release.release_id,
        actorUserId: USER_ID,
        expectedStatus: 'approved',
        expectedRevision: release.review_revision,
      });
      await distributionService.publish({
        releaseId: release.release_id,
        actorUserId: USER_ID,
        expectedStatus: 'signed',
        expectedRevision: release.review_revision + 1,
      });
    }
  }
  const repository = createMemoryProjectModuleInstallationRepository({
    now: () => NOW,
    createId: (() => {
      let value = 0;
      return () => `60000000-0000-4000-a000-${String(++value).padStart(12, '0')}`;
    })(),
  });
  return {
    repository,
    signingPort,
    distributionService,
    service: new ProjectModuleInstallationService({
      repository,
      releaseService: distributionService,
      verifiers: [signingPort],
      platformVersion: input.platformVersion ?? '1.0.0',
      registryVersion: input.registryVersion ?? '1.0.0',
    }),
  };
}

const projectInput = {
  accountId: PROJECT_ACCOUNT_ID,
  projectId: PROJECT_ID,
  actorUserId: USER_ID,
};

describe('project module installation service', () => {
  test('installs, updates, and rolls back an exact published release across publisher accounts', async () => {
    const { service } = await setup();

    const installed = await service.install({
      ...projectInput,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
      idempotencyKey: 'install-v1',
    });
    const updated = await service.update({
      ...projectInput,
      moduleId: MODULE_ID,
      releaseId: RELEASE_V2,
      expectedInstallRevision: 1,
      idempotencyKey: 'update-v2',
    });
    const rolledBack = await service.rollback({
      ...projectInput,
      moduleId: MODULE_ID,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 2,
      idempotencyKey: 'rollback-v1',
    });

    expect(installed.installation).toEqual(
      expect.objectContaining({
        account_id: PROJECT_ACCOUNT_ID,
        project_id: PROJECT_ID,
        active_release_id: RELEASE_V1,
        active_version: '1.0.0',
        install_revision: 1,
        status: 'active',
      }),
    );
    expect(installed.event.action).toBe('install');
    expect(updated.event.action).toBe('update');
    expect(rolledBack.event.action).toBe('rollback');
    expect(rolledBack.installation.active_release_id).toBe(RELEASE_V1);
    expect(rolledBack.installation.install_revision).toBe(3);
  });

  test('reads immutable installation history with project and account scoping', async () => {
    const { service } = await setup();
    await service.install({
      ...projectInput,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
    });
    await service.update({
      ...projectInput,
      moduleId: MODULE_ID,
      releaseId: RELEASE_V2,
      expectedInstallRevision: 1,
    });

    const history = await service.history({
      accountId: PROJECT_ACCOUNT_ID,
      projectId: PROJECT_ID,
      moduleId: MODULE_ID,
    });
    expect(history.map((event) => event.action)).toEqual(['install', 'update']);
    expect(history.map((event) => event.sequence)).toEqual([1, 2]);
    await expect(
      service.history({
        accountId: PROJECT_ACCOUNT_ID,
        projectId: OTHER_PROJECT_ID,
        moduleId: MODULE_ID,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MODULE_NOT_FOUND', status: 404 });
  });

  test('replays the same idempotency key and rejects a changed target', async () => {
    const { service } = await setup();
    const command = {
      ...projectInput,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0 as const,
      idempotencyKey: 'install-replay',
    };
    const first = await service.install(command);
    const replay = await service.install(command);

    await expect(service.install({ ...command, releaseId: RELEASE_V2 })).rejects.toMatchObject({
      code: 'PROJECT_MODULE_INSTALL_CONFLICT',
      status: 409,
    });
    expect(replay).toEqual(first);
  });

  test('rejects stale revisions, duplicate module installs, and cross-project reads', async () => {
    const { service } = await setup();
    await service.install({
      ...projectInput,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
    });

    await expect(
      service.install({ ...projectInput, releaseId: RELEASE_V2, expectedInstallRevision: 0 }),
    ).rejects.toMatchObject({ code: 'PROJECT_MODULE_INSTALL_CONFLICT', status: 409 });
    await expect(
      service.update({
        ...projectInput,
        moduleId: MODULE_ID,
        releaseId: RELEASE_V2,
        expectedInstallRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MODULE_INSTALL_CONFLICT', status: 409 });
    await expect(
      service.list({ accountId: PROJECT_ACCOUNT_ID, projectId: OTHER_PROJECT_ID }),
    ).resolves.toEqual([]);
  });

  test('limits rollback to historical published releases and rejects revoked targets', async () => {
    const { service, distributionService } = await setup();
    await service.install({ ...projectInput, releaseId: RELEASE_V1, expectedInstallRevision: 0 });
    await service.update({
      ...projectInput,
      moduleId: MODULE_ID,
      releaseId: RELEASE_V2,
      expectedInstallRevision: 1,
    });

    await expect(
      service.rollback({
        ...projectInput,
        moduleId: MODULE_ID,
        releaseId: RELEASE_NEVER_INSTALLED,
        expectedInstallRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID', status: 409 });

    await distributionService.revoke({
      releaseId: RELEASE_V1,
      actorUserId: USER_ID,
      expectedStatus: 'published',
      expectedRevision: 4,
      reason: 'Emergency withdrawal.',
    });
    await expect(
      service.rollback({
        ...projectInput,
        moduleId: MODULE_ID,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID', status: 409 });
  });

  test('fails closed for tampered signatures and incompatible or invalid ranges', async () => {
    const tampered = baseRelease(RELEASE_V1, '1.0.0', {
      status: 'published',
      review_revision: 4,
      signature_algorithm: 'ed25519',
      signature_key_id: 'module-key-2026',
      signature: `base64url:${'a'.repeat(86)}`,
      signature_payload_digest: `sha256:${'b'.repeat(64)}`,
      signed_at: NOW.toISOString(),
      published_at: NOW.toISOString(),
    });
    const { service } = await setup({
      releases: [tampered],
    });
    await expect(
      service.install({ ...projectInput, releaseId: RELEASE_V1, expectedInstallRevision: 0 }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_SIGNATURE_INVALID', status: 409 });

    const incompatible = baseRelease(RELEASE_V1, '1.0.0', {
      manifest: manifest('1.0.0', { platform: '^2.0.0' }),
    });
    const incompatibleSetup = await setup({ releases: [incompatible] });
    await expect(
      incompatibleSetup.service.install({
        ...projectInput,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE', status: 409 });

    const invalidRange = baseRelease(RELEASE_V1, '1.0.0', {
      manifest: manifest('1.0.0', { platform: 'not-a-range' }),
    });
    const invalidSetup = await setup({ releases: [invalidRange] });
    await expect(
      invalidSetup.service.install({
        ...projectInput,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE', status: 409 });
  });

  test.each(
    INSTALLATION_ACTIONS.flatMap((action) =>
      TRUST_DIGEST_FIELDS.map((digestField) => [action, digestField] as const),
    ),
  )('blocks %s after %s is tampered', async (action, digestField) => {
    const { repository, signingPort, distributionService, service } = await setup();
    const tamperedService = new ProjectModuleInstallationService({
      repository,
      releaseService: {
        async getPublished(input) {
          const published = await distributionService.getPublished(input);
          published[digestField] = `sha256:${'0'.repeat(64)}`;
          return published;
        },
      },
      verifiers: [signingPort],
      platformVersion: '1.0.0',
      registryVersion: '1.0.0',
    });

    if (action !== 'install') {
      await service.install({
        ...projectInput,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
      });
    }
    if (action === 'rollback') {
      await service.update({
        ...projectInput,
        moduleId: MODULE_ID,
        releaseId: RELEASE_V2,
        expectedInstallRevision: 1,
      });
    }

    const operation =
      action === 'install'
        ? tamperedService.install({
            ...projectInput,
            releaseId: RELEASE_V1,
            expectedInstallRevision: 0,
          })
        : action === 'update'
          ? tamperedService.update({
              ...projectInput,
              moduleId: MODULE_ID,
              releaseId: RELEASE_V2,
              expectedInstallRevision: 1,
            })
          : tamperedService.rollback({
              ...projectInput,
              moduleId: MODULE_ID,
              releaseId: RELEASE_V1,
              expectedInstallRevision: 2,
            });

    await expect(operation).rejects.toMatchObject({
      code: 'DEVELOPER_MODULE_SIGNATURE_INVALID',
      status: 409,
    });
  });

  test('rejects signed, revoked, and unknown-key releases before mutating project state', async () => {
    const signed = baseRelease(RELEASE_V1, '1.0.0', {
      status: 'signed',
      review_revision: 3,
      signature_algorithm: 'ed25519',
      signature_key_id: 'module-key-2026',
      signature: `base64url:${'a'.repeat(86)}`,
      signature_payload_digest: `sha256:${'b'.repeat(64)}`,
      signed_at: NOW.toISOString(),
    });
    const signedSetup = await setup({ releases: [signed] });
    await expect(
      signedSetup.service.install({
        ...projectInput,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_NOT_PUBLISHED', status: 409 });

    const revoked = baseRelease(RELEASE_V1, '1.0.0', {
      ...signed,
      status: 'revoked',
      review_revision: 5,
      published_at: NOW.toISOString(),
      revoked_at: NOW.toISOString(),
    });
    const revokedSetup = await setup({ releases: [revoked] });
    await expect(
      revokedSetup.service.install({
        ...projectInput,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_REVOKED', status: 409 });

    const unknownKey = baseRelease(RELEASE_V1, '1.0.0', {
      ...signed,
      status: 'published',
      review_revision: 4,
      signature_key_id: 'retired-key',
      published_at: NOW.toISOString(),
    });
    const unknownKeySetup = await setup({ releases: [unknownKey] });
    await expect(
      unknownKeySetup.service.install({
        ...projectInput,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE', status: 503 });
  });

  test('returns mutation-proof installation snapshots and serializes a revoked pointer as blocked', async () => {
    const { service, repository, distributionService } = await setup();
    const installed = await service.install({
      ...projectInput,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
    });
    installed.installation.status = 'blocked';
    expect((await repository.get(PROJECT_ACCOUNT_ID, PROJECT_ID, MODULE_ID))?.status).toBe(
      'active',
    );

    await distributionService.revoke({
      releaseId: RELEASE_V1,
      actorUserId: USER_ID,
      expectedStatus: 'published',
      expectedRevision: 4,
      reason: 'Emergency withdrawal.',
    });
    await expect(
      service.list({ accountId: PROJECT_ACCOUNT_ID, projectId: PROJECT_ID }),
    ).resolves.toEqual([
      expect.objectContaining({ active_release_id: RELEASE_V1, status: 'blocked' }),
    ]);
  });

  test('allows only one concurrent move at a fenced revision', async () => {
    const { service } = await setup();
    await service.install({ ...projectInput, releaseId: RELEASE_V1, expectedInstallRevision: 0 });
    const results = await Promise.allSettled([
      service.update({
        ...projectInput,
        moduleId: MODULE_ID,
        releaseId: RELEASE_V2,
        expectedInstallRevision: 1,
      }),
      service.update({
        ...projectInput,
        moduleId: MODULE_ID,
        releaseId: RELEASE_NEVER_INSTALLED,
        expectedInstallRevision: 1,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toEqual(expect.objectContaining({ code: 'PROJECT_MODULE_INSTALL_CONFLICT', status: 409 }));
  });
});

test('uses stable error types for installation conflicts', () => {
  const error = new ProjectModuleInstallationError('PROJECT_MODULE_NOT_FOUND', 404);
  expect(error).toMatchObject({ code: 'PROJECT_MODULE_NOT_FOUND', status: 404 });
});
