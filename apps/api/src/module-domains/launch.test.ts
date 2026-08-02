import { expect, test } from 'bun:test';

import type { RegistryModuleManifest } from '@kortix/registry';

import {
  type ProjectModuleLaunchCandidate,
  ProjectModuleLaunchError,
  ProjectModuleLaunchService,
  createMemoryProjectModuleLaunchRepository,
} from './launch';
import { parseModuleAppHostConfiguration } from './platform-host-config';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000003';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';

function sandboxedWebManifest(): RegistryModuleManifest {
  return {
    schemaVersion: 3,
    id: 'developer.example.app',
    version: '1.0.0',
    publisher: { id: 'developer-example' },
    locales: ['en'],
    compatibility: { platform: '>=1.0.0', registry: '>=3.0.0' },
    execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
    verification: { profile: 'sandboxed-web' },
    openopc: { sdkApiVersion: 'v1' },
  };
}

function launchCandidate(
  overrides: Partial<ProjectModuleLaunchCandidate> = {},
): ProjectModuleLaunchCandidate {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 7,
    installationStatus: 'active',
    activeReleaseId: RELEASE_ID,
    activeVersion: '1.0.0',
    moduleId: 'developer.example.app',
    releaseId: RELEASE_ID,
    releaseStatus: 'published',
    releaseModuleId: 'developer.example.app',
    releaseModuleVersion: '1.0.0',
    manifest: sandboxedWebManifest(),
    signatureAlgorithm: 'ed25519',
    signatureKeyId: 'module-key-2026',
    signature: `base64url:${'a'.repeat(86)}`,
    signaturePayloadDigest: `sha256:${'b'.repeat(64)}`,
    signedAt: '2026-08-02T08:00:00.000Z',
    publishedAt: '2026-08-02T08:01:00.000Z',
    revokedAt: null,
    artifactId: '50000000-0000-4000-a000-000000000005',
    storageKey: 'developer-modules/artifacts/launch-test',
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    artifactSize: 1024,
    ...overrides,
  };
}

function schemaV2Manifest(): RegistryModuleManifest {
  return {
    schemaVersion: 2,
    id: 'developer.example.app',
    version: '1.0.0',
    publisher: { id: 'developer-example' },
    category: 'automation',
    locales: ['en'],
    compatibility: { platform: '>=1.0.0', registry: '>=2.0.0' },
    execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
    verification: { profile: 'sandboxed-web' },
  };
}

async function expectLaunchError(input: {
  candidate?: ProjectModuleLaunchCandidate;
  current?: (candidate: ProjectModuleLaunchCandidate) => boolean;
  hostAvailable?: boolean;
  scope?: { accountId: string; projectId: string; installationId: string };
  code:
    | 'PROJECT_MODULE_NOT_FOUND'
    | 'PROJECT_MODULE_INACTIVE'
    | 'PROJECT_MODULE_NOT_LAUNCHABLE'
    | 'PROJECT_MODULE_LAUNCH_STALE'
    | 'PROJECT_MODULE_HOST_UNAVAILABLE';
  status: 404 | 409 | 503;
}) {
  const repository = createMemoryProjectModuleLaunchRepository({
    candidates: input.candidate ? [input.candidate] : [],
    current: input.current,
  });
  const service = new ProjectModuleLaunchService({
    repository,
    hostConfiguration:
      input.hostAvailable === false
        ? null
        : parseModuleAppHostConfiguration('modules.openopc.example'),
  });

  await expect(
    service.resolve(
      input.scope ?? {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
      },
    ),
  ).rejects.toMatchObject({ code: input.code, status: input.status });
}

test('returns a server-authoritative immutable launch descriptor', async () => {
  const repository = createMemoryProjectModuleLaunchRepository({
    candidates: [launchCandidate()],
  });
  const service = new ProjectModuleLaunchService({
    repository,
    hostConfiguration: parseModuleAppHostConfiguration('modules.openopc.example'),
  });

  const descriptor = await service.resolve({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
  });

  expect(descriptor).toEqual({
    installation_id: INSTALLATION_ID,
    release_id: RELEASE_ID,
    install_revision: 7,
    module_id: 'developer.example.app',
    module_version: '1.0.0',
    execution_mode: 'sandboxed-web',
    url: `https://r-${RELEASE_ID}.modules.openopc.example/`,
    origin: `https://r-${RELEASE_ID}.modules.openopc.example`,
  });
  const serialized = JSON.stringify(descriptor);
  expect(serialized).not.toContain(ACCOUNT_ID);
  expect(serialized).not.toContain(PROJECT_ID);
  expect(serialized).not.toMatch(/token|credential|[?#]/i);
});

test('keeps missing and cross-project installations opaque', async () => {
  await expectLaunchError({
    code: 'PROJECT_MODULE_NOT_FOUND',
    status: 404,
  });
  await expectLaunchError({
    candidate: launchCandidate(),
    scope: {
      accountId: ACCOUNT_ID,
      projectId: '20000000-0000-4000-a000-000000000099',
      installationId: INSTALLATION_ID,
    },
    code: 'PROJECT_MODULE_NOT_FOUND',
    status: 404,
  });
});

test.each([
  ['account', launchCandidate({ accountId: '10000000-0000-4000-a000-000000000099' })],
  ['project', launchCandidate({ projectId: '20000000-0000-4000-a000-000000000099' })],
  ['installation', launchCandidate({ installationId: '30000000-0000-4000-a000-000000000099' })],
] as const)('keeps a repository scope mismatch opaque: %s', async (_scope, candidate) => {
  let currentChecks = 0;
  const service = new ProjectModuleLaunchService({
    repository: {
      async loadCandidate() {
        return candidate;
      },
      async isCurrent() {
        currentChecks += 1;
        return true;
      },
    },
    hostConfiguration: parseModuleAppHostConfiguration('modules.openopc.example'),
  });

  await expect(
    service.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_MODULE_NOT_FOUND', status: 404 });
  expect(currentChecks).toBe(0);
});

test.each([
  ['blocked installation', launchCandidate({ installationStatus: 'blocked' })],
  [
    'revoked release',
    launchCandidate({
      releaseStatus: 'revoked',
      revokedAt: '2026-08-02T09:00:00.000Z',
    }),
  ],
  ['deprecated release', launchCandidate({ releaseStatus: 'deprecated' })],
  ['unpublished release', launchCandidate({ releaseStatus: 'signed', publishedAt: null })],
] as const)('rejects an inactive launch candidate: %s', async (_name, candidate) => {
  await expectLaunchError({
    candidate,
    code: 'PROJECT_MODULE_INACTIVE',
    status: 409,
  });
});

test.each([
  [
    'unsupported execution mode',
    launchCandidate({
      manifest: {
        ...sandboxedWebManifest(),
        execution: {
          mode: 'declarative',
          entry: 'dist/index.html',
        } as unknown as RegistryModuleManifest['execution'],
      },
    }),
  ],
  [
    'unsupported verification profile',
    launchCandidate({
      manifest: {
        ...sandboxedWebManifest(),
        verification: { profile: 'declarative' },
      },
    }),
  ],
  ['schema-v2 manifest', launchCandidate({ manifest: schemaV2Manifest() })],
  [
    'missing web entry',
    launchCandidate({
      manifest: { ...sandboxedWebManifest(), execution: { mode: 'sandboxed-web' } },
    }),
  ],
  ['missing artifact id', launchCandidate({ artifactId: null })],
  ['missing artifact storage key', launchCandidate({ storageKey: null })],
  ['missing artifact digest', launchCandidate({ artifactDigest: null })],
  ['invalid artifact size', launchCandidate({ artifactSize: 0 })],
  ['missing signature algorithm', launchCandidate({ signatureAlgorithm: null })],
  ['unsupported signature algorithm', launchCandidate({ signatureAlgorithm: 'rsa' })],
  ['missing signature key id', launchCandidate({ signatureKeyId: null })],
  ['missing signature', launchCandidate({ signature: null })],
  ['missing signature payload digest', launchCandidate({ signaturePayloadDigest: null })],
  ['missing signed timestamp', launchCandidate({ signedAt: null })],
] as const)('rejects a non-launchable candidate: %s', async (_name, candidate) => {
  await expectLaunchError({
    candidate,
    code: 'PROJECT_MODULE_NOT_LAUNCHABLE',
    status: 409,
  });
});

test.each([
  ['release pointer', launchCandidate({ activeReleaseId: '40000000-0000-4000-a000-000000000099' })],
  ['module id', launchCandidate({ releaseModuleId: 'developer.other.app' })],
  ['release version', launchCandidate({ releaseModuleVersion: '2.0.0' })],
  ['active version', launchCandidate({ activeVersion: '2.0.0' })],
  [
    'manifest id',
    launchCandidate({ manifest: { ...sandboxedWebManifest(), id: 'developer.other.app' } }),
  ],
  [
    'manifest version',
    launchCandidate({ manifest: { ...sandboxedWebManifest(), version: '2.0.0' } }),
  ],
  ['install revision', launchCandidate({ installRevision: 0 })],
] as const)('rejects stale launch identity: %s', async (_name, candidate) => {
  await expectLaunchError({
    candidate,
    code: 'PROJECT_MODULE_LAUNCH_STALE',
    status: 409,
  });
});

test('fails the final fence when the installation revision changes', async () => {
  await expectLaunchError({
    candidate: launchCandidate(),
    current: () => false,
    code: 'PROJECT_MODULE_LAUNCH_STALE',
    status: 409,
  });
});

test('fails closed when the platform module host is unavailable', async () => {
  await expectLaunchError({
    candidate: launchCandidate(),
    hostAvailable: false,
    code: 'PROJECT_MODULE_HOST_UNAVAILABLE',
    status: 503,
  });
});

test('does not reach the final fence before candidate validation succeeds', async () => {
  let currentChecks = 0;
  const repository = {
    async loadCandidate() {
      return launchCandidate({ artifactId: null });
    },
    async isCurrent() {
      currentChecks += 1;
      return true;
    },
  };
  const service = new ProjectModuleLaunchService({
    repository,
    hostConfiguration: parseModuleAppHostConfiguration('modules.openopc.example'),
  });

  await expect(
    service.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
    }),
  ).rejects.toBeInstanceOf(ProjectModuleLaunchError);
  expect(currentChecks).toBe(0);
});
