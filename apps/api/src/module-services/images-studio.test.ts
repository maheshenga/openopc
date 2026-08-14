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
const OTHER_INSTALLATION_ID = '30000000-0000-4000-a000-000000000009';
const OTHER_USER_ID = '70000000-0000-4000-a000-000000000009';
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

function scope(
  grantId = GRANT_ID,
  overrides: { installationId?: string; actorUserId?: string } = {},
): ModuleImageScope {
  return {
    claims: {
      ...claims(grantId),
      installationId: overrides.installationId ?? INSTALLATION_ID,
    } as Extract<ModuleServiceCapabilityClaimsV1, { service: 'ai' }>,
    actorUserId: overrides.actorUserId ?? USER_ID,
  };
}

function authorizationForGrant(
  grantId: string,
  overrides: { installationId?: string; acceptedBy?: string } = {},
) {
  const installationId = overrides.installationId ?? INSTALLATION_ID;
  const acceptedBy = overrides.acceptedBy ?? USER_ID;
  return {
    grant: {
      grantId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId,
      releaseId: RELEASE_ID,
      consentId: CONSENT_ID,
      service: 'ai' as const,
      operations: ['image.generate' as const],
      tokenHash: `sha256:${'c'.repeat(64)}` as `sha256:${string}`,
      expiresAt: '2026-08-08T08:04:00.000Z',
      revokedAt: null,
      createdAt: '2026-08-08T07:59:00.000Z',
    },
    consent: {
      consentId: CONSENT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId,
      releaseId: RELEASE_ID,
      installRevision: 4,
      service: 'ai' as const,
      operations: ['image.generate' as const],
      consentDigest: `sha256:${'d'.repeat(64)}` as `sha256:${string}`,
      acceptedBy,
      acceptedAt: '2026-08-08T07:00:00.000Z',
      revokedBy: null,
      revokedAt: null,
    },
    installation: {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId,
      installRevision: 4,
      releaseId: RELEASE_ID,
      moduleId: 'example.image-studio',
      moduleVersion: '1.2.3',
      installationStatus: 'active' as const,
      releaseStatus: 'published',
      signatureAlgorithm: 'ed25519',
      signature: `base64url:${'e'.repeat(86)}`,
      signedAt: '2026-08-08T07:00:00.000Z',
      manifest: {} as never,
    },
  };
}

function fixture() {
  const repository = createMemoryStudioRepository({
    providers: [fakeProvider],
    moduleServiceGrantInstallations: {
      [GRANT_ID]: INSTALLATION_ID,
      [OTHER_GRANT_ID]: INSTALLATION_ID,
    },
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
    loadModuleServiceAuthorization: async (grantId) =>
      grantId === GRANT_ID || grantId === OTHER_GRANT_ID
        ? {
            ...authorizationForGrant(grantId),
            grant: {
              ...authorizationForGrant(grantId).grant,
              installationId: grantId === GRANT_ID ? INSTALLATION_ID : INSTALLATION_ID,
            },
          }
        : null,
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

    await expect(
      backend.createJob(scope(OTHER_GRANT_ID), {
        model: model.id,
        input,
        estimate_id: estimate.estimate_id,
        estimate_token: estimate.estimate_token,
        idempotency_key: 'module-image-job-idempotency-0001',
      }),
    ).resolves.toMatchObject({ created: false, job: { job_id: created.job.job_id } });

    const existingJob = await repository.getJob(PROJECT_ID, created.job.job_id);
    if (!existingJob) throw new Error('expected the idempotent job to be stored');
    const originalFindJobByIdempotency = repository.findJobByIdempotency.bind(repository);
    const originalCreateJob = repository.createJob.bind(repository);
    repository.findJobByIdempotency = async () => null;
    repository.createJob = async (...args) => {
      const result = await originalCreateJob(...args);
      return result.mismatch ? { created: false, job: existingJob } : result;
    };
    await expect(
      backend.createJob(scope(OTHER_GRANT_ID), {
        model: model.id,
        input,
        estimate_id: estimate.estimate_id,
        estimate_token: estimate.estimate_token,
        idempotency_key: 'module-image-job-idempotency-0001',
      }),
    ).resolves.toMatchObject({ created: false, job: { job_id: created.job.job_id } });
    repository.findJobByIdempotency = originalFindJobByIdempotency;
    repository.createJob = originalCreateJob;

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

    await expect(backend.getJob(scope(OTHER_GRANT_ID), created.job.job_id)).resolves.toMatchObject({
      job_id: created.job.job_id,
    });
    await expect(
      backend.getJob(
        scope(OTHER_GRANT_ID, {
          installationId: OTHER_INSTALLATION_ID,
          actorUserId: OTHER_USER_ID,
        }),
        created.job.job_id,
      ),
    ).rejects.toMatchObject({ code: 'OPENOPC_IMAGE_JOB_NOT_FOUND' });
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
    ).resolves.toMatchObject({
      items: [{ asset_id: created.asset_id, metadata: { purpose: 'reference' } }],
    });
    const collaborator = scope(OTHER_GRANT_ID, {
      installationId: OTHER_INSTALLATION_ID,
      actorUserId: OTHER_USER_ID,
    });
    await expect(
      backend.listAssets(collaborator, { cursor: null, limit: 100 }),
    ).resolves.toMatchObject({
      items: [
        {
          asset_id: created.asset_id,
          metadata: {},
          retention: { deletable: false },
        },
      ],
    });

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

    await expect(backend.downloadAsset(collaborator, created.asset_id)).resolves.toMatchObject({
      mimeType: 'image/png',
    });

    await expect(
      backend.setAssetRetention(collaborator, created.asset_id, 'temporary'),
    ).rejects.toMatchObject({ code: 'OPENOPC_IMAGE_ASSET_NOT_FOUND' });
    await expect(
      backend.setAssetRetention(scope(OTHER_GRANT_ID), created.asset_id, 'temporary'),
    ).resolves.toMatchObject({ retention: { policy: 'temporary', deletable: true } });
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
    const listJobAssets = repository.listJobAssets;
    const rawUploaded = await repository.getAsset(PROJECT_ID, uploaded.asset_id);
    if (!rawUploaded) throw new Error('expected raw uploaded asset');
    repository.listJobAssets = async (projectId, jobId, role, limit, cursor) => {
      expect({ projectId, jobId, role, limit, cursor }).toEqual({
        projectId: PROJECT_ID,
        jobId: created.job.job_id,
        role: 'output',
        limit: 100,
        cursor: null,
      });
      return {
        items: [{ ...rawUploaded, source_job_id: created.job.job_id }],
        next_cursor: null,
      };
    };
    repository.listAssets = async () => {
      throw new Error('jobs.outputs must use studio_job_assets');
    };
    await expect(
      backend.listJobOutputs(scope(), created.job.job_id, { cursor: null, limit: 100 }),
    ).resolves.toMatchObject({
      items: [{ asset_id: uploaded.asset_id, source: { job_id: created.job.job_id } }],
    });
    repository.listJobAssets = listJobAssets;
  });

  test('lists only module jobs for the current project, actor, installation, and capability', async () => {
    const { backend, repository } = fixture();
    const model = (await backend.listModels(scope())).data[0];
    if (!model) throw new Error('expected a module image model');
    const input = {
      prompt: 'Filter this module image job',
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
      idempotency_key: 'module-image-job-list-filter-0001',
    });
    const original = repository.listJobs.bind(repository);
    repository.listJobs = async (projectId, limit, cursor, filter) => {
      expect({ projectId, limit, cursor, filter }).toEqual({
        projectId: PROJECT_ID,
        limit: 25,
        cursor: null,
        filter: {
          account_id: ACCOUNT_ID,
          actor_user_id: USER_ID,
          actor_type: 'module',
          capability: 'image.generate',
          module_installation_id: INSTALLATION_ID,
          status: 'queued',
          created_after: '2026-08-08T07:59:00.000Z',
          created_before: '2026-08-08T08:01:00.000Z',
        },
      });
      return original(projectId, limit, cursor, filter);
    };
    await expect(
      backend.listJobs(scope(), {
        cursor: null,
        limit: 25,
        status: 'queued',
        created_after: '2026-08-08T07:59:00.000Z',
        created_before: '2026-08-08T08:01:00.000Z',
      }),
    ).resolves.toMatchObject({ items: [{ job_id: created.job.job_id }], next_cursor: null });
    repository.listJobs = original;
    await expect(
      backend.listJobs(scope(), {
        cursor: null,
        limit: 25,
        status: 'queued',
        created_after: '2026-08-08T00:00:00-08:00',
        created_before: '2026-08-08T01:00:00-08:00',
      }),
    ).resolves.toMatchObject({ items: [{ job_id: created.job.job_id }], next_cursor: null });
    await expect(
      backend.listJobs(scope(), {
        cursor: null,
        limit: 25,
        status: 'running',
        created_after: '2026-08-08T07:59:00.000Z',
        created_before: '2026-08-08T08:01:00.000Z',
      }),
    ).resolves.toEqual({ items: [], next_cursor: null });
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
