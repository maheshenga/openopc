import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  DeveloperModuleArtifactError,
  DeveloperModuleArtifactService,
  createMemoryDeveloperArtifactStore,
  createMemoryDeveloperModuleArtifactRepository,
  createUnavailableDeveloperArtifactStore,
  serializeDeveloperModuleArtifactPackage,
} from './artifacts';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const NOW = new Date('2026-07-25T12:00:00.000Z');

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function declarativeItem() {
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
    },
  };
}

function agentPackageBytes(source = 'export const agent = true;'): Uint8Array {
  return serializeDeveloperModuleArtifactPackage({
    item: {
      name: 'agent-workbench',
      type: 'registry:module',
      files: [{ path: 'agent/main.ts', type: 'registry:file', target: 'agent/main.ts' }],
      dependencies: ['zod@3.23.8'],
      module: {
        schemaVersion: 2,
        id: 'acme.agent-workbench',
        version: '2.0.0',
        publisher: { id: 'acme', displayName: 'Acme' },
        category: 'ai-application',
        locales: ['en'],
        compatibility: { platform: '^1.0.0' },
        execution: { mode: 'agent', entry: 'agent/main.ts' },
        verification: { profile: 'agent-project' },
      },
    },
    files: [
      {
        path: 'agent/main.ts',
        target: 'agent/main.ts',
        mediaType: 'text/typescript',
        bytes: new TextEncoder().encode(source),
      },
    ],
    lockGraph: {
      format: 'openopc-lock.v1',
      nodes: [
        {
          name: 'zod',
          version: '3.23.8',
          resolved: 'https://registry.npmjs.org/zod/-/zod-3.23.8.tgz',
          integrity: `sha512-${'a'.repeat(86)}`,
          dependencies: {},
        },
      ],
    },
  });
}

function fixture() {
  const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
  const memoryStore = createMemoryDeveloperArtifactStore();
  const service = new DeveloperModuleArtifactService({
    repository,
    store: memoryStore.store,
    now: () => NOW,
    codeModulesEnabled: true,
  });
  return { repository, memoryStore, service };
}

describe('developer module artifact service', () => {
  test('synthesizes and persists a canonical declarative artifact', async () => {
    const { service } = fixture();

    const artifact = await service.createDeclarative({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: declarativeItem(),
    });

    expect(artifact).toEqual(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        publisher_id: 'acme',
        media_type: 'application/vnd.openopc.developer-module.v2+json',
        item_snapshot: expect.objectContaining({ name: 'recruiting-workbench' }),
      }),
    );
    expect(artifact.artifact_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.envelope_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact).not.toHaveProperty('storage_key');
  });

  test('finalizes a bounded package and hides it across account boundaries', async () => {
    const { memoryStore, service } = fixture();
    const bytes = agentPackageBytes();
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);

    const artifact = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      uploadId: upload.upload_id,
      actorUserId: USER_ID,
    });

    expect(artifact).toEqual(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        publisher_id: 'acme',
        item_snapshot: expect.objectContaining({ name: 'agent-workbench' }),
      }),
    );
    await expect(
      service.getArtifact({ accountId: OTHER_ACCOUNT_ID, artifactId: artifact.artifact_id }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_NOT_FOUND', status: 404 }),
    );
  });

  test('idempotently returns the original artifact for a repeated finalization', async () => {
    const { memoryStore, service } = fixture();
    const bytes = agentPackageBytes();
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);

    const first = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      uploadId: upload.upload_id,
      actorUserId: USER_ID,
    });
    const second = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      uploadId: upload.upload_id,
      actorUserId: USER_ID,
    });

    expect(second.artifact_id).toBe(first.artifact_id);
  });

  test('reports whether finalization created the artifact or reused the original', async () => {
    const { memoryStore, service } = fixture();
    const bytes = agentPackageBytes();
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);

    const first = await service.finalizeUploadResult({
      accountId: ACCOUNT_ID,
      uploadId: upload.upload_id,
      actorUserId: USER_ID,
    });
    const second = await service.finalizeUploadResult({
      accountId: ACCOUNT_ID,
      uploadId: upload.upload_id,
      actorUserId: USER_ID,
    });

    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({
      created: false,
      artifact: { artifact_id: first.artifact.artifact_id },
    });
  });

  test('deletes staging data and never inserts an artifact when checksum validation fails', async () => {
    const { memoryStore, repository, service } = fixture();
    const bytes = agentPackageBytes();
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: `sha256:${'f'.repeat(64)}`,
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers, { skipChecksum: true });

    await expect(
      service.finalizeUpload({
        accountId: ACCOUNT_ID,
        uploadId: upload.upload_id,
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH', status: 400 }),
    );
    expect(await repository.listArtifacts(ACCOUNT_ID)).toEqual([]);
    expect(memoryStore.hasUpload(upload.upload_url)).toBe(false);
  });

  test('recomputes the digest from staging bytes instead of trusting object metadata', async () => {
    const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const memoryStore = createMemoryDeveloperArtifactStore();
    const expectedBytes = agentPackageBytes();
    const tamperedBytes = agentPackageBytes('export const agent = null;');
    expect(tamperedBytes.byteLength).toBe(expectedBytes.byteLength);
    const expectedDigest = digest(expectedBytes);
    const service = new DeveloperModuleArtifactService({
      repository,
      store: {
        ...memoryStore.store,
        async headStaging() {
          return { size: expectedBytes.byteLength, digest: expectedDigest };
        },
      },
      now: () => NOW,
      codeModulesEnabled: true,
    });
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: expectedBytes.byteLength,
      expectedDigest,
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, tamperedBytes, upload.headers, {
      skipChecksum: true,
    });

    await expect(
      service.finalizeUpload({
        accountId: ACCOUNT_ID,
        uploadId: upload.upload_id,
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH', status: 400 }),
    );
    expect(await repository.listArtifacts(ACCOUNT_ID)).toEqual([]);
    expect(memoryStore.hasUpload(upload.upload_url)).toBe(false);
  });

  test('maps staging read failures to unavailable without destroying retryable state', async () => {
    const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const memoryStore = createMemoryDeveloperArtifactStore();
    const bytes = agentPackageBytes();
    const service = new DeveloperModuleArtifactService({
      repository,
      store: {
        ...memoryStore.store,
        readStaging() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  throw new Error('object store read failed');
                },
              };
            },
          };
        },
      },
      now: () => NOW,
      codeModulesEnabled: true,
    });
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);

    await expect(
      service.finalizeUpload({
        accountId: ACCOUNT_ID,
        uploadId: upload.upload_id,
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_STORE_UNAVAILABLE', status: 503 }),
    );
    expect(memoryStore.hasUpload(upload.upload_url)).toBe(true);
  });

  test('rejects expired uploads without revealing another account upload', async () => {
    const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const memoryStore = createMemoryDeveloperArtifactStore();
    let currentTime = NOW;
    const service = new DeveloperModuleArtifactService({
      repository,
      store: memoryStore.store,
      now: () => currentTime,
      codeModulesEnabled: true,
    });
    const bytes = agentPackageBytes();
    const upload = await service.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      actorUserId: USER_ID,
    });
    currentTime = new Date(NOW.getTime() + 6 * 60_000);

    await expect(
      service.finalizeUpload({
        accountId: OTHER_ACCOUNT_ID,
        uploadId: upload.upload_id,
        actorUserId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(DeveloperModuleArtifactError);
    await expect(
      service.finalizeUpload({
        accountId: ACCOUNT_ID,
        uploadId: upload.upload_id,
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_UPLOAD_EXPIRED', status: 409 }),
    );
  });

  test('fails closed when the deployment has no artifact object store', async () => {
    const service = new DeveloperModuleArtifactService({
      repository: createMemoryDeveloperModuleArtifactRepository(),
      store: createUnavailableDeveloperArtifactStore(),
      now: () => NOW,
      codeModulesEnabled: true,
    });

    await expect(
      service.createDeclarative({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        item: declarativeItem(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_STORE_UNAVAILABLE', status: 503 }),
    );
    await expect(
      service.createUpload({
        accountId: ACCOUNT_ID,
        publisherId: 'acme',
        expectedSize: 1,
        expectedDigest: `sha256:${'a'.repeat(64)}`,
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_STORE_UNAVAILABLE', status: 503 }),
    );
  });

  test('keeps package upload and finalization disabled unless explicitly enabled', async () => {
    const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const memoryStore = createMemoryDeveloperArtifactStore();
    const disabled = new DeveloperModuleArtifactService({
      repository,
      store: memoryStore.store,
      now: () => NOW,
    });
    const bytes = agentPackageBytes();

    await expect(
      disabled.createUpload({
        accountId: ACCOUNT_ID,
        publisherId: 'acme',
        expectedSize: bytes.byteLength,
        expectedDigest: digest(bytes),
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED', status: 503 }),
    );

    const enabled = new DeveloperModuleArtifactService({
      repository,
      store: memoryStore.store,
      now: () => NOW,
      codeModulesEnabled: true,
    });
    const upload = await enabled.createUpload({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      actorUserId: USER_ID,
    });
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);
    await expect(
      disabled.finalizeUpload({
        accountId: ACCOUNT_ID,
        uploadId: upload.upload_id,
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED', status: 503 }),
    );
    expect(memoryStore.hasUpload(upload.upload_url)).toBe(true);
  });

  test('claims a publisher before persistence and rejects cross-account namespace reuse', async () => {
    const repository = createMemoryDeveloperModuleArtifactRepository({ now: () => NOW });
    const memoryStore = createMemoryDeveloperArtifactStore();
    const service = new DeveloperModuleArtifactService({
      repository,
      store: memoryStore.store,
      now: () => NOW,
    });

    await service.createDeclarative({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: declarativeItem(),
    });
    await expect(
      service.createDeclarative({
        accountId: OTHER_ACCOUNT_ID,
        actorUserId: USER_ID,
        item: declarativeItem(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT', status: 409 }),
    );
  });
});
