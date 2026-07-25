import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { RegistryItem } from '@kortix/registry';

import {
  type DeveloperModuleArtifactRepository,
  DeveloperModuleArtifactService,
  createMemoryDeveloperArtifactStore,
  createMemoryDeveloperModuleArtifactRepository,
} from './artifacts';
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
