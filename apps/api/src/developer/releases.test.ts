import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { RegistryItem } from '@kortix/registry';

import {
  type DeveloperModuleArtifactRepository,
  DeveloperModuleArtifactService,
  createMemoryDeveloperArtifactStore,
  createMemoryDeveloperModuleArtifactRepository,
  serializeDeveloperModuleArtifactPackage,
} from './artifacts';
import { DeveloperPublisherError } from './publishers';
import {
  DeveloperModuleReleaseError,
  DeveloperModuleReleaseService,
  createMemoryDeveloperModuleReleaseRepository,
} from './releases';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const NOW = new Date('2026-07-24T12:00:00.000Z');

function validModuleItem() {
  return {
    name: 'recruiting-workbench',
    type: 'registry:module' as const,
    module: {
      schemaVersion: 2 as const,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry' as const,
      locales: ['en', 'zh-CN'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' as const },
      capabilities: [{ id: 'acme.recruiting.score', kind: 'task' as const }],
      permissions: {
        secrets: ['RECRUITING_MODEL_API_KEY'],
        network: ['https://api.example.com'],
      },
    },
  };
}

function serverAdapterPackageBytes(): Uint8Array {
  const descriptor = new TextEncoder().encode(
    `{"descriptorVersion":1,"runtime":{"args":[],"command":["openopc-adapter"],"image":"sha256:${'a'.repeat(64)}","kind":"oci-image","limits":{"cpuMillis":1000,"fuel":1000000,"memoryMiB":64,"outputBytes":1048576,"pids":8,"wallTimeMs":5000},"profile":"server-adapter"}}`,
  );
  return serializeDeveloperModuleArtifactPackage({
    item: {
      name: 'server-adapter',
      type: 'registry:module',
      files: [
        {
          path: 'runtime/openopc.runtime.json',
          target: 'runtime/openopc.runtime.json',
          type: 'registry:file',
        },
      ],
      module: {
        schemaVersion: 2,
        id: 'acme.server-adapter',
        version: '1.0.0',
        publisher: { id: 'acme', displayName: 'Acme' },
        category: 'automation',
        locales: ['en'],
        compatibility: { platform: '^1.0.0' },
        execution: { mode: 'server-adapter', entry: 'runtime/openopc.runtime.json' },
        verification: { profile: 'server-conformance' },
      },
    },
    files: [
      {
        path: 'runtime/openopc.runtime.json',
        target: 'runtime/openopc.runtime.json',
        mediaType: 'application/json',
        bytes: descriptor,
      },
    ],
    lockGraph: { format: 'openopc-lock.v1', nodes: [] },
  });
}

function fixture() {
  const artifacts = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
  return {
    artifacts,
    service: new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
      artifacts,
    }),
  };
}

function itemDigest(item: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}`;
}

async function seedArtifact(
  artifacts: DeveloperModuleArtifactRepository,
  item: unknown,
  accountId = ACCOUNT_ID,
) {
  const snapshot = item as RegistryItem;
  const digest = itemDigest(item);
  return artifacts.createArtifact({
    artifact_id: randomUUID(),
    account_id: accountId,
    publisher_id: snapshot.module?.publisher.id ?? 'invalid',
    artifact_digest: digest,
    envelope_digest: digest,
    storage_key: `test/${accountId}/${digest.slice('sha256:'.length)}`,
    media_type: 'application/vnd.openopc.developer-module.v2+json',
    size_bytes: JSON.stringify(item).length,
    item_snapshot: structuredClone(snapshot),
    source_provenance: null,
    created_by: USER_ID,
    created_at: NOW.toISOString(),
  });
}

async function submitItem(
  service: DeveloperModuleReleaseService,
  artifacts: DeveloperModuleArtifactRepository,
  item: unknown,
  accountId = ACCOUNT_ID,
) {
  const artifact = await seedArtifact(artifacts, item, accountId);
  return service.submit({ accountId, actorUserId: USER_ID, artifactId: artifact.artifact_id });
}

describe('developer module release service', () => {
  test('derives and persists server runtime evidence from canonical artifact bytes', async () => {
    const artifacts = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const memoryStore = createMemoryDeveloperArtifactStore();
    const artifactService = new DeveloperModuleArtifactService({
      repository: artifacts,
      store: memoryStore.store,
      now: () => NOW,
      codeModulesEnabled: true,
      trustInfrastructureReady: () => true,
    });
    const bytes = serverAdapterPackageBytes();
    const upload = await artifactService.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);
    const artifact = await artifactService.finalizeUpload({
      accountId: ACCOUNT_ID,
      uploadId: upload.upload_id,
      actorUserId: USER_ID,
    });
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
      artifacts,
      artifactStore: memoryStore.store,
    });

    const result = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      artifactId: artifact.artifact_id,
    });

    expect(result.release).toMatchObject({
      runtime_descriptor_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      runtime_descriptor_path: 'runtime/openopc.runtime.json',
      runtime_kind: 'oci-image',
    });
  });

  test('checks Publisher release authority before creating a release', async () => {
    const artifacts = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const artifact = await seedArtifact(artifacts, validModuleItem());
    const calls: unknown[][] = [];
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
      artifacts,
      permissions: {
        async requirePermission(...args) {
          calls.push(args);
          throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
        },
      },
    });

    await expect(
      service.submit({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        artifactId: artifact.artifact_id,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_PUBLISHER_FORBIDDEN', status: 403 });
    expect(calls).toEqual([['acme', { accountId: ACCOUNT_ID, userId: USER_ID }, 'release']]);
  });

  test('submits a release only from a finalized artifact in the same account', async () => {
    const artifacts = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const artifactService = new DeveloperModuleArtifactService({
      repository: artifacts,
      store: createMemoryDeveloperArtifactStore().store,
      now: () => NOW,
    });
    const artifact = await artifactService.createDeclarative({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
      artifacts,
    });

    await expect(
      service.submit({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        artifactId: artifact.artifact_id,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        created: true,
        release: expect.objectContaining({
          artifact_id: artifact.artifact_id,
          artifact_digest: artifact.artifact_digest,
        }),
      }),
    );
    await expect(
      service.submit({
        accountId: OTHER_ACCOUNT_ID,
        actorUserId: USER_ID,
        artifactId: artifact.artifact_id,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_NOT_FOUND', status: 404 }),
    );
  });

  test('submits a valid artifact as immutable validated release metadata', async () => {
    const { artifacts, service } = fixture();
    const result = await submitItem(service, artifacts, validModuleItem());

    expect(result.created).toBe(true);
    expect(result.release).toEqual(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        module_id: 'acme.recruiting',
        module_version: '1.0.0',
        publisher_id: 'acme',
        artifact_id: expect.any(String),
        artifact_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        sbom_digest: null,
        trust_attestation_digest: null,
        verification_policy_digest: null,
        status: 'validated',
        review_revision: 0,
        signature_algorithm: null,
        created_by: USER_ID,
        created_at: NOW.toISOString(),
      }),
    );
    expect(result.release.review_requirements).toEqual([
      'manifest_review',
      'source_scan',
      'permission_review',
      'human_review',
    ]);
  });

  test('revalidates artifact snapshots without echoing submitted credentials', async () => {
    const { artifacts, service } = fixture();
    const item = validModuleItem();
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];

    await expect(submitItem(service, artifacts, item)).rejects.toEqual(
      expect.objectContaining({
        code: 'DEVELOPER_MODULE_INVALID',
        status: 400,
        message: 'DEVELOPER_MODULE_INVALID',
      }),
    );
    expect(JSON.stringify(await service.list({ accountId: ACCOUNT_ID }))).not.toContain(
      'sk-live-super-secret',
    );
  });

  test('requires the module id to belong to the declared publisher namespace', async () => {
    const { artifacts, service } = fixture();
    const item = validModuleItem();
    item.module.id = 'other.recruiting';
    item.module.capabilities = [{ id: 'other.recruiting.score', kind: 'task' }];

    await expect(submitItem(service, artifacts, item)).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_PUBLISHER_MISMATCH', status: 400 }),
    );
  });

  test('returns the original release for an idempotent artifact resubmission', async () => {
    const { artifacts, service } = fixture();
    const artifact = await seedArtifact(artifacts, validModuleItem());
    const first = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      artifactId: artifact.artifact_id,
    });
    const second = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      artifactId: artifact.artifact_id,
    });

    expect(second.created).toBe(false);
    expect(second.release.release_id).toBe(first.release.release_id);
  });

  test('rejects reuse of a module version for a different artifact', async () => {
    const { artifacts, service } = fixture();
    await submitItem(service, artifacts, validModuleItem());
    const changed = validModuleItem();
    changed.module.locales = ['en'];

    await expect(submitItem(service, artifacts, changed)).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_MODULE_VERSION_CONFLICT', status: 409 }),
    );
  });

  test('rejects a publisher id already owned by another account', async () => {
    const { artifacts, service } = fixture();
    await submitItem(service, artifacts, validModuleItem());
    const anotherModule = validModuleItem();
    anotherModule.name = 'sales-workbench';
    anotherModule.module.id = 'acme.sales';
    anotherModule.module.version = '2.0.0';
    anotherModule.module.capabilities = [{ id: 'acme.sales.score', kind: 'task' }];

    await expect(submitItem(service, artifacts, anotherModule, OTHER_ACCOUNT_ID)).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_PUBLISHER_CONFLICT', status: 409 }),
    );
  });

  test('scopes list and get to the owning account and protects stored content from mutation', async () => {
    const { artifacts, service } = fixture();
    const submitted = await submitItem(service, artifacts, validModuleItem());
    submitted.release.manifest.publisher.displayName = 'Tampered';

    expect(await service.list({ accountId: OTHER_ACCOUNT_ID })).toEqual([]);
    await expect(
      service.get({ accountId: OTHER_ACCOUNT_ID, releaseId: submitted.release.release_id }),
    ).rejects.toBeInstanceOf(DeveloperModuleReleaseError);
    const stored = await service.get({
      accountId: ACCOUNT_ID,
      releaseId: submitted.release.release_id,
    });
    expect(stored.manifest.publisher.displayName).toBe('Acme');
  });

  test('derives sandbox and desktop review requirements from executable surfaces', async () => {
    const { artifacts, service } = fixture();
    const item = {
      ...validModuleItem(),
      files: [{ path: 'desktop/main.js', type: 'registry:file' as const }],
      module: {
        ...validModuleItem().module,
        execution: { mode: 'desktop-native' as const, entry: 'desktop/main.js' },
        verification: { profile: 'desktop-package' as const },
        permissions: {
          ...validModuleItem().module.permissions,
          desktop: ['filesystem.read'],
        },
      },
    };

    const result = await submitItem(service, artifacts, item);

    expect(result.release.review_requirements).toEqual([
      'manifest_review',
      'source_scan',
      'sandbox_test',
      'permission_review',
      'desktop_security_review',
      'human_review',
    ]);
  });
});
