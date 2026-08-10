import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';
import { InMemoryStudioObjectStore, StudioStorageUnavailableError } from '@kortix/studio-runtime';

import { createMemoryStudioRepository } from '../studio/repositories/memory';
import { StudioStorageService } from '../studio/storage';
import type { ModuleImageScope } from './images';
import { ModuleImageError } from './images';
import { StudioModuleImageBackend } from './images-studio';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const OTHER_GRANT_ID = '60000000-0000-4000-8000-000000000009';
const USER_ID = '70000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '80000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-08-08T08:00:00.000Z');
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

const fakeProvider = {
  provider_config_id: PROVIDER_CONFIG_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  provider: 'fake' as const,
  display_name: 'Module image fake provider',
  base_url: null,
  region: null,
  credential_binding: { kind: 'none' as const },
  capabilities: ['image.generate' as const],
  enabled: true,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

function claims(grantId = GRANT_ID): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '01000000-0000-4000-8000-000000000001',
    iat: '2026-08-08T07:59:00.000Z',
    exp: '2026-08-08T08:04:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.image-studio',
    moduleVersion: '1.2.3',
    consentId: CONSENT_ID,
    grantId,
    service: 'ai',
    operations: ['image.generate'],
  };
}

function scope(grantId = GRANT_ID): ModuleImageScope {
  return {
    claims: claims(grantId) as Extract<ModuleServiceCapabilityClaimsV1, { service: 'ai' }>,
    actorUserId: USER_ID,
  };
}

function fixture() {
  const repository = createMemoryStudioRepository({
    providers: [fakeProvider],
    now: () => NOW.toISOString(),
  });
  const store = new InMemoryStudioObjectStore({
    namespace: 'module-images',
    ready: true,
    now: () => NOW,
  });
  store.createSignedDownloadUrl = async ({ key }) =>
    `https://assets.example.test/${encodeURIComponent(key)}?signature=redacted`;
  const storageService = new StudioStorageService({
    repository,
    store,
    now: () => NOW,
  });
  const backend = new StudioModuleImageBackend({
    repository,
    storageService,
    estimateSigningSecret: 'module-image-test-secret',
    credentialBindingExists: async () => true,
    now: () => NOW,
  });
  return { backend, repository, store };
}

describe('Studio-backed module image service', () => {
  test('discovers a provider-neutral model and binds created work to the module grant', async () => {
    const { backend, repository } = fixture();
    const models = await backend.listModels(scope());
    expect(models.data).toHaveLength(1);
    const model = models.data[0];
    expect(model).toMatchObject({
      object: 'image.model',
      owned_by: 'openopc',
      name: 'Module image fake provider / fake/image-v1',
      capabilities: {
        prompt: { max_characters: 8000, max_negative_prompt_characters: 4000 },
        reference_images: { max_images: 8 },
        output: { min_images: 1, max_images: 8 },
      },
    });
    expect(model?.id).toBe(`${PROVIDER_CONFIG_ID}:fake/image-v1`);
    if (!model) throw new Error('expected a module image model');

    const input = {
      prompt: 'A provider-neutral platform image',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    };
    const estimate = await backend.createEstimate(scope(), { model: model.id, input });
    expect(estimate).toMatchObject({
      currency: 'credits',
      max_approved_credits: 1,
      valid_for_ms: 15 * 60 * 1000,
      quota: { required_credits: 1, available_credits: null },
      settlement: {
        succeeded: 'settle-actual-usage',
        failed: 'settle-verified-usage',
        cancelled: 'settle-verified-usage',
      },
    });

    const created = await backend.createJob(scope(), {
      model: model.id,
      input,
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      idempotency_key: 'module-image-job-idempotency-0001',
    });
    expect(created.created).toBe(true);
    expect(created.job).toMatchObject({ model: model.id, status: 'queued', cancellable: true });
    const stored = await repository.getJob(PROJECT_ID, created.job.job_id);
    expect(stored).toMatchObject({
      actor_user_id: USER_ID,
      actor_type: 'module',
      module_service_grant_id: GRANT_ID,
    });
    expect(stored).not.toHaveProperty('acting_token_id', GRANT_ID);

    const events = await backend.listEvents(scope(), created.job.job_id, {
      cursor: null,
      limit: 100,
    });
    expect(events.items).toEqual([
      expect.objectContaining({
        job_id: created.job.job_id,
        type: 'queued',
      }),
    ]);
    expect(events.items[0]).not.toHaveProperty('payload');

    await expect(backend.getJob(scope(OTHER_GRANT_ID), created.job.job_id)).rejects.toMatchObject({
      code: 'OPENOPC_IMAGE_JOB_NOT_FOUND',
    });
  });

  test('manages the retention and retryable deletion lifecycle of grant-owned uploads', async () => {
    const { backend, repository, store } = fixture();
    const created = await backend.createAsset(scope(), {
      bytes: PNG,
      mimeType: 'image/png',
      filename: 'pixel.png',
      metadata: { purpose: 'reference' },
      retention: 'retained',
    });
    expect(created).toMatchObject({
      source: { job_id: null, prompt: null },
      mime_type: 'image/png',
      width: 1,
      height: 1,
      metadata: { purpose: 'reference' },
      retention: { policy: 'retained', expires_at: null, deletable: true },
    });

    const page = await backend.listAssets(scope(), { cursor: null, limit: 100 });
    expect(page).toEqual({ items: [created], next_cursor: null });
    await expect(
      backend.listAssets(scope(OTHER_GRANT_ID), { cursor: null, limit: 100 }),
    ).resolves.toEqual({ items: [], next_cursor: null });

    const preview = await backend.previewAsset(scope(), created.asset_id);
    expect(preview).toMatchObject({
      asset_id: created.asset_id,
      url: expect.stringContaining('https://assets.example.test/'),
      expires_at: '2026-08-08T08:15:00.000Z',
    });

    const downloaded = await backend.downloadAsset(scope(), created.asset_id);
    expect(downloaded.mimeType).toBe('image/png');
    expect(downloaded.filename).toBe('pixel.png');
    expect(downloaded.bytes).toEqual(PNG);

    await expect(
      backend.downloadAsset(scope(OTHER_GRANT_ID), created.asset_id),
    ).rejects.toBeInstanceOf(ModuleImageError);

    await expect(
      backend.setAssetRetention(scope(OTHER_GRANT_ID), created.asset_id, 'temporary'),
    ).rejects.toMatchObject({ code: 'OPENOPC_IMAGE_ASSET_NOT_FOUND' });
    await expect(
      backend.setAssetRetention(scope(), created.asset_id, 'temporary'),
    ).resolves.toMatchObject({
      retention: { policy: 'temporary', expires_at: null, deletable: true },
    });

    const deleteObject = store.deleteObject.bind(store);
    store.deleteObject = async () => {
      throw new StudioStorageUnavailableError();
    };
    await expect(backend.deleteAsset(scope(), created.asset_id)).rejects.toMatchObject({
      code: 'OPENOPC_IMAGE_STORAGE_UNAVAILABLE',
    });
    await expect(backend.listAssets(scope(), { cursor: null, limit: 100 })).resolves.toEqual({
      items: [],
      next_cursor: null,
    });

    store.deleteObject = deleteObject;
    await expect(backend.deleteAsset(scope(), created.asset_id)).resolves.toEqual({
      asset_id: created.asset_id,
      deleted: true,
    });
    await expect(repository.getAsset(PROJECT_ID, created.asset_id)).resolves.toBeNull();
    await expect(backend.downloadAsset(scope(), created.asset_id)).rejects.toMatchObject({
      code: 'OPENOPC_IMAGE_ASSET_NOT_FOUND',
    });
  });

  test('filters assets by origin, exposes job outputs, and caches bounded thumbnails', async () => {
    const { backend, repository, store } = fixture();
    const uploaded = await backend.createAsset(scope(), {
      bytes: PNG,
      mimeType: 'image/png',
      filename: 'thumbnail-source.png',
      metadata: {},
      retention: 'retained',
    });
    await expect(
      backend.listAssets(scope(), { cursor: null, limit: 100, source: 'uploaded' }),
    ).resolves.toMatchObject({ items: [uploaded] });
    await expect(
      backend.listAssets(scope(), { cursor: null, limit: 100, source: 'generated' }),
    ).resolves.toEqual({ items: [], next_cursor: null });

    let sourceReads = 0;
    const getObject = store.getObject.bind(store);
    store.getObject = async (input) => {
      sourceReads += 1;
      return getObject(input);
    };
    const firstThumbnail = await backend.thumbnailAsset(scope(), uploaded.asset_id, 'small');
    expect(firstThumbnail).toMatchObject({
      asset_id: uploaded.asset_id,
      preset: 'small',
      mime_type: 'image/webp',
      width: 1,
      height: 1,
      cache: { visibility: 'private', max_age_seconds: 900, immutable: true },
    });
    expect(sourceReads).toBe(1);
    await expect(backend.thumbnailAsset(scope(), uploaded.asset_id, 'small')).resolves.toEqual(
      firstThumbnail,
    );
    expect(sourceReads).toBe(1);

    const model = (await backend.listModels(scope())).data[0];
    if (!model) throw new Error('expected a module image model');
    const input = {
      prompt: 'output relation',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    };
    const estimate = await backend.createEstimate(scope(), { model: model.id, input });
    const created = await backend.createJob(scope(), {
      model: model.id,
      input,
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      idempotency_key: 'module-image-job-output-relation-0001',
    });
    const listAssets = repository.listAssets.bind(repository);
    const rawUploaded = await repository.getAsset(PROJECT_ID, uploaded.asset_id);
    if (!rawUploaded) throw new Error('expected raw uploaded asset');
    repository.listAssets = async (projectId, limit, cursor, filter) => {
      expect({ projectId, limit, cursor, filter }).toEqual({
        projectId: PROJECT_ID,
        limit: 100,
        cursor: null,
        filter: { source_job_id: created.job.job_id, source: 'generated' },
      });
      return {
        items: [{ ...rawUploaded, source_job_id: created.job.job_id }],
        next_cursor: null,
      };
    };
    await expect(
      backend.listJobOutputs(scope(), created.job.job_id, { cursor: null, limit: 100 }),
    ).resolves.toMatchObject({
      items: [{ asset_id: uploaded.asset_id, source: { job_id: created.job.job_id } }],
    });
    repository.listAssets = listAssets;
  });

  test('refuses to delete a direct asset while an active job references it', async () => {
    const { backend } = fixture();
    const asset = await backend.createAsset(scope(), {
      bytes: PNG,
      mimeType: 'image/png',
      filename: 'reference.png',
      metadata: {},
      retention: 'temporary',
    });
    const model = (await backend.listModels(scope())).data[0];
    if (!model) throw new Error('expected a module image model');
    const input = {
      prompt: 'Use the active reference asset',
      reference_asset_ids: [asset.asset_id],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    };
    const estimate = await backend.createEstimate(scope(), { model: model.id, input });
    await backend.createJob(scope(), {
      model: model.id,
      input,
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      idempotency_key: 'module-image-job-idempotency-asset-use-0001',
    });

    await expect(backend.deleteAsset(scope(), asset.asset_id)).rejects.toMatchObject({
      code: 'OPENOPC_IMAGE_ASSET_NOT_DELETABLE',
      status: 409,
    });
    await expect(backend.downloadAsset(scope(), asset.asset_id)).resolves.toMatchObject({
      mimeType: 'image/png',
    });
  });
});
