import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { RuntimeReleaseProfile } from '../release-profile/runtime';
import {
  FUTURE_OCI_RUNTIME_TEST_PROFILE,
  FUTURE_WASI_RUNTIME_TEST_PROFILE,
  NON_READY_RUNTIME_TEST_PROFILE,
  RESTRICTED_RUNTIME_TEST_PROFILE,
} from '../release-profile/test-fixtures';
import {
  DeveloperModuleDistributionService,
  createMemoryDeveloperModuleDistributionRepository,
} from './distribution';
import {
  type ProjectModuleInstallation,
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

test('release profile rejection happens before installation repository or verification access', async () => {
  let calls = 0;
  const service = new ProjectModuleInstallationService({
    runtime: NON_READY_RUNTIME_TEST_PROFILE,
    repository: {
      async findReplay() {
        calls += 1;
        return null;
      },
    } as never,
    releaseService: {
      async getPublished() {
        calls += 1;
        throw new Error('unexpected release lookup');
      },
    },
  });
  await expect(
    service.install({
      accountId: PROJECT_ACCOUNT_ID,
      projectId: PROJECT_ID,
      releaseId: RELEASE_V1,
      actorUserId: USER_ID,
      expectedInstallRevision: 0,
      idempotencyKey: 'profile-rejection',
    }),
  ).rejects.toMatchObject({ code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE' });
  expect(calls).toBe(0);
});
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
    runtime_descriptor_digest: null,
    runtime_descriptor_path: null,
    runtime_kind: null,
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

function serverAdapterRelease(
  releaseId: string,
  version: string,
  runtimeKind: DeveloperModuleRelease['runtime_kind'],
  overrides: Partial<DeveloperModuleRelease> = {},
): DeveloperModuleRelease {
  const itemManifest = {
    ...manifest(version),
    execution: {
      mode: 'server-adapter' as const,
      entry: 'runtime/openopc.runtime.json',
    },
    verification: { profile: 'server-conformance' as const },
  };
  return baseRelease(releaseId, version, {
    manifest: itemManifest,
    runtime_kind: runtimeKind,
    ...(runtimeKind === null
      ? { runtime_descriptor_digest: null, runtime_descriptor_path: null }
      : {
          runtime_descriptor_digest: `sha256:${'1'.repeat(64)}`,
          runtime_descriptor_path: 'runtime/openopc.runtime.json',
        }),
    ...overrides,
  });
}

async function setup(
  input: {
    releases?: DeveloperModuleRelease[];
    platformVersion?: string;
    registryVersion?: string;
    runtime?: RuntimeReleaseProfile;
  } = {},
) {
  const runtime = input.runtime ?? RESTRICTED_RUNTIME_TEST_PROFILE;
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
    runtime,
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
            runtime_descriptor_digest: candidate.runtime_descriptor_digest,
            runtime_kind: candidate.runtime_kind,
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
    distributionRepository,
    distributionService,
    service: new ProjectModuleInstallationService({
      runtime,
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

const EXISTING_INSTALLATION: ProjectModuleInstallation = {
  installation_id: '60000000-0000-4000-a000-000000000099',
  project_id: PROJECT_ID,
  account_id: PROJECT_ACCOUNT_ID,
  module_id: MODULE_ID,
  active_release_id: RELEASE_V1,
  active_version: '1.0.0',
  install_revision: 1,
  status: 'active',
  installed_by: USER_ID,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

test.each(
  (
    [
      ['OCI', 'oci-image'],
      ['old-null', null],
    ] as const
  ).flatMap(([label, runtimeKind]) =>
    (['install', 'update', 'rollback'] as const).map(
      (action) => [label, action, runtimeKind] as const,
    ),
  ),
)(
  'restricted profile rejects %s server-adapter %s before replay or installation side effects',
  async (_label, action, runtimeKind) => {
    const target = serverAdapterRelease(RELEASE_V2, '2.0.0', runtimeKind, {
      status: 'published',
      review_revision: 4,
      published_at: NOW.toISOString(),
    });
    const distributionService = new DeveloperModuleDistributionService({
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: createMemoryDeveloperModuleDistributionRepository({ releases: [target] }),
    });
    const repositoryCalls: string[] = [];
    const repository = {
      async list() {
        repositoryCalls.push('list');
        return [];
      },
      async get() {
        repositoryCalls.push('get');
        return null;
      },
      async install() {
        repositoryCalls.push('install');
        throw new Error('unexpected install transition');
      },
      async move() {
        repositoryCalls.push('move');
        throw new Error('unexpected move transition');
      },
      async history() {
        repositoryCalls.push('history');
        return [];
      },
      async hasHistoricalTarget() {
        repositoryCalls.push('hasHistoricalTarget');
        return true;
      },
      async findIdempotentResult() {
        repositoryCalls.push('findIdempotentResult');
        throw new Error('idempotent replay bypassed target validation');
      },
    } as never;
    const service = new ProjectModuleInstallationService({
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository,
      releaseService: distributionService,
    });
    const operation =
      action === 'install'
        ? service.install({
            ...projectInput,
            releaseId: RELEASE_V2,
            expectedInstallRevision: 0,
            idempotencyKey: 'restricted-target-replay',
          })
        : action === 'update'
          ? service.update({
              ...projectInput,
              moduleId: MODULE_ID,
              releaseId: RELEASE_V2,
              expectedInstallRevision: 1,
              idempotencyKey: 'restricted-target-replay',
            })
          : service.rollback({
              ...projectInput,
              moduleId: MODULE_ID,
              releaseId: RELEASE_V2,
              expectedInstallRevision: 1,
              idempotencyKey: 'restricted-target-replay',
            });

    await expect(operation).rejects.toMatchObject({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.oci.execute',
    });
    expect(repositoryCalls).toEqual([]);
  },
);

test('restricted profile lists an existing OCI installation as blocked without transitions', async () => {
  const oci = serverAdapterRelease(RELEASE_V1, '1.0.0', 'oci-image', {
    status: 'published',
    review_revision: 4,
    published_at: NOW.toISOString(),
  });
  const distributionRepository = createMemoryDeveloperModuleDistributionRepository({
    releases: [oci],
  });
  const installationRepository = createMemoryProjectModuleInstallationRepository({
    installations: [EXISTING_INSTALLATION],
  });
  const service = new ProjectModuleInstallationService({
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository: installationRepository,
    releaseService: new DeveloperModuleDistributionService({
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: distributionRepository,
    }),
  });

  await expect(
    service.list({ accountId: PROJECT_ACCOUNT_ID, projectId: PROJECT_ID }),
  ).resolves.toEqual([
    expect.objectContaining({ active_release_id: RELEASE_V1, status: 'blocked' }),
  ]);
  expect(await installationRepository.history(EXISTING_INSTALLATION.installation_id)).toEqual([]);
  expect(await distributionRepository.history(PUBLISHER_ACCOUNT_ID, RELEASE_V1)).toEqual([]);
});

test('module.oci.execute is the specific installation authorization delta for the same OCI target', async () => {
  const ociSetup = await setup({
    runtime: FUTURE_OCI_RUNTIME_TEST_PROFILE,
    releases: [serverAdapterRelease(RELEASE_V1, '1.0.0', 'oci-image')],
  });
  const deniedInstallationRepository = createMemoryProjectModuleInstallationRepository();
  const deniedService = new ProjectModuleInstallationService({
    runtime: FUTURE_WASI_RUNTIME_TEST_PROFILE,
    repository: deniedInstallationRepository,
    releaseService: new DeveloperModuleDistributionService({
      runtime: FUTURE_WASI_RUNTIME_TEST_PROFILE,
      repository: ociSetup.distributionRepository,
    }),
  });

  await expect(
    deniedService.install({
      ...projectInput,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
      idempotencyKey: 'future-oci-denied-install',
    }),
  ).rejects.toMatchObject({
    code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
    capability: 'module.oci.execute',
  });
  expect(await deniedInstallationRepository.list(PROJECT_ACCOUNT_ID, PROJECT_ID)).toEqual([]);

  const installed = await ociSetup.service.install({
    ...projectInput,
    releaseId: RELEASE_V1,
    expectedInstallRevision: 0,
    idempotencyKey: 'future-oci-install',
  });
  expect(installed.event.action).toBe('install');
  expect(installed.installation).toMatchObject({
    active_release_id: RELEASE_V1,
    active_version: '1.0.0',
    status: 'active',
  });
});

test.each([
  ['without module.oci.execute', FUTURE_WASI_RUNTIME_TEST_PROFILE],
  ['with module.oci.execute', FUTURE_OCI_RUNTIME_TEST_PROFILE],
] as const)(
  'future profile %s rejects null metadata without installation transitions',
  async (_label, runtime) => {
    const oldNull = serverAdapterRelease(RELEASE_V2, '2.0.0', null, {
      status: 'published',
      review_revision: 4,
      published_at: NOW.toISOString(),
    });
    const nullDistribution = new DeveloperModuleDistributionService({
      runtime,
      repository: createMemoryDeveloperModuleDistributionRepository({ releases: [oldNull] }),
    });
    let installTransitions = 0;
    const nullRepository = {
      ...createMemoryProjectModuleInstallationRepository(),
      async install() {
        installTransitions += 1;
        throw new Error('unexpected null-metadata install');
      },
    };
    const nullService = new ProjectModuleInstallationService({
      runtime,
      repository: nullRepository,
      releaseService: nullDistribution,
    });
    await expect(
      nullService.install({
        ...projectInput,
        releaseId: RELEASE_V2,
        expectedInstallRevision: 0,
        idempotencyKey: 'future-null-install',
      }),
    ).rejects.toMatchObject({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.oci.execute',
    });
    expect(installTransitions).toBe(0);
  },
);

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
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
