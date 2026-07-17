import { describe, expect, test } from 'bun:test';
import { InMemoryStudioObjectStore, StudioStorageUnavailableError } from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { type StudioProjectRouteDeps, createStudioProjectRoutes } from './index';
import { createMemoryStudioRepository } from './repositories/memory';
import { StudioStorageService, createStudioReferenceAssetResolver } from './storage';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const ACTOR_USER_ID = '30000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '40000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '50000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-17T08:00:00.000Z');
const CHECKSUM = 'a'.repeat(64);
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const PNG_CHECKSUM = new Bun.CryptoHasher('sha256').update(PNG).digest('hex');

describe('Studio storage service', () => {
  test('creates a tenant-scoped 30-minute upload with a driver URL bound for 15 minutes', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    let readinessChecks = 0;
    const assertReady = store.assertReady.bind(store);
    store.assertReady = async () => {
      readinessChecks += 1;
      await assertReady();
    };
    const service = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });

    const upload = await service.createUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: 128,
      expected_checksum_sha256: CHECKSUM,
      metadata: { source: 'user-upload' },
    });

    const expectedKey = `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/source.png`;
    expect(upload).toMatchObject({
      upload_id: UPLOAD_ID,
      project_id: PROJECT_ID,
      asset_id: null,
      object_key: expectedKey,
      declared_mime_type: 'image/png',
      expected_size_bytes: 128,
      expected_checksum_sha256: CHECKSUM,
      expires_at: '2026-07-17T08:30:00.000Z',
      status: 'pending',
    });
    expect(upload.signed_upload_url).toStartWith('memory-upload://private-studio/');
    const signedUrl = new URL(upload.signed_upload_url);
    expect(decodeURIComponent(signedUrl.pathname.slice(1))).toBe(expectedKey);
    expect(Object.fromEntries(signedUrl.searchParams)).toEqual({
      content_type: 'image/png',
      size_bytes: '128',
      checksum_sha256: CHECKSUM,
      ttl: '900',
    });
    expect(readinessChecks).toBe(1);
    expect(await repository.getUploadRecord(ACCOUNT_ID, PROJECT_ID, UPLOAD_ID)).not.toHaveProperty(
      'metadata',
    );
  });

  test('rejects unsupported upload declarations before readiness, presign, or persistence', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    let persistenceWrites = 0;
    const createPendingUpload = repository.createPendingUpload.bind(repository);
    repository.createPendingUpload = async (input) => {
      persistenceWrites += 1;
      return createPendingUpload(input);
    };
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    let readinessChecks = 0;
    let uploadPresigns = 0;
    store.assertReady = async () => {
      readinessChecks += 1;
    };
    store.createSignedUploadUrl = async () => {
      uploadPresigns += 1;
      return 'https://uploads.example.test/signed';
    };
    const service = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const base = {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: 128,
      expected_checksum_sha256: CHECKSUM,
      metadata: {},
    };

    await expect(
      service.createUpload({ ...base, declared_mime_type: 'application/octet-stream' }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_INVALID' });
    await expect(
      service.createUpload({ ...base, expected_checksum_sha256: 'A'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_INVALID' });
    await expect(
      service.createUpload({ ...base, expected_size_bytes: 32 * 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_TOO_LARGE' });
    expect({ readinessChecks, uploadPresigns, persistenceWrites }).toEqual({
      readinessChecks: 0,
      uploadPresigns: 0,
      persistenceWrites: 0,
    });
  });

  test('uses the platform UUID generator without losing its receiver', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const service = new StudioStorageService({ repository, store, now: () => NOW });

    const upload = await service.createUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: 128,
      expected_checksum_sha256: CHECKSUM,
      metadata: {},
    });

    expect(upload.upload_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('finalizes from actual object metadata and image bytes idempotently', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const service = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const upload = await service.createUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: { account_id: ACCOUNT_ID, project_id: PROJECT_ID },
    });

    const first = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      uploadId: upload.upload_id,
    });
    const replay = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      uploadId: upload.upload_id,
    });

    expect(first).toMatchObject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      kind: 'image',
      mime_type: 'image/png',
      bucket: 'private-studio',
      object_key: upload.object_key,
      checksum_sha256: PNG_CHECKSUM,
      size_bytes: PNG.byteLength,
      width: 1,
      height: 1,
      metadata: { account_id: ACCOUNT_ID, project_id: PROJECT_ID },
    });
    expect(replay).toEqual(first);
  });

  test('rejects stored size, checksum, MIME, magic, and dimension violations', async () => {
    const markup = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const oversizedDimensions = jpegWithDimensions(16_385, 1);
    const scenarios = [
      {
        name: 'size',
        declaredMimeType: 'image/png' as const,
        expectedSize: PNG.byteLength + 1,
        expectedChecksum: PNG_CHECKSUM,
        objectMimeType: 'image/png',
        objectBytes: PNG,
        expectedCode: 'STUDIO_ASSET_INVALID',
      },
      {
        name: 'checksum',
        declaredMimeType: 'image/png' as const,
        expectedSize: PNG.byteLength,
        expectedChecksum: 'b'.repeat(64),
        objectMimeType: 'image/png',
        objectBytes: PNG,
        expectedCode: 'STUDIO_ASSET_INVALID',
      },
      {
        name: 'MIME',
        declaredMimeType: 'image/png' as const,
        expectedSize: PNG.byteLength,
        expectedChecksum: PNG_CHECKSUM,
        objectMimeType: 'image/jpeg',
        objectBytes: PNG,
        expectedCode: 'STUDIO_ASSET_INVALID',
      },
      {
        name: 'magic',
        declaredMimeType: 'image/png' as const,
        expectedSize: markup.byteLength,
        expectedChecksum: sha256(markup),
        objectMimeType: 'image/png',
        objectBytes: markup,
        expectedCode: 'STUDIO_ASSET_INVALID',
      },
      {
        name: 'dimensions',
        declaredMimeType: 'image/jpeg' as const,
        expectedSize: oversizedDimensions.byteLength,
        expectedChecksum: sha256(oversizedDimensions),
        objectMimeType: 'image/jpeg',
        objectBytes: oversizedDimensions,
        expectedCode: 'STUDIO_ASSET_TOO_LARGE',
      },
    ];

    for (const scenario of scenarios) {
      const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
      const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
      const service = new StudioStorageService({
        repository,
        store,
        now: () => NOW,
        randomUUID: () => UPLOAD_ID,
      });
      const upload = await service.createUpload({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        actor_user_id: ACTOR_USER_ID,
        declared_mime_type: scenario.declaredMimeType,
        expected_size_bytes: scenario.expectedSize,
        expected_checksum_sha256: scenario.expectedChecksum,
        metadata: {},
      });
      const objectBytes = Uint8Array.from(scenario.objectBytes);
      const objectChecksum = sha256(objectBytes);
      await store.putObject({
        key: upload.object_key,
        body: new Blob([objectBytes]).stream(),
        content_type: scenario.objectMimeType,
        size_bytes: objectBytes.byteLength,
        checksum_sha256: objectChecksum,
        metadata: { scenario: scenario.name },
      });

      await expect(
        service.finalizeUpload({
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          uploadId: upload.upload_id,
        }),
      ).rejects.toMatchObject({ code: scenario.expectedCode });
      expect((await repository.listAssets(PROJECT_ID, 10)).items).toEqual([]);
    }
  });

  test('fails as expired when the pending upload expires during object verification', async () => {
    let currentTime = NOW;
    const repository = createMemoryStudioRepository({ now: () => currentTime.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const service = new StudioStorageService({
      repository,
      store,
      now: () => currentTime,
      randomUUID: () => UPLOAD_ID,
    });
    const upload = await service.createUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    const getObject = store.getObject.bind(store);
    store.getObject = async (input) => {
      const stored = await getObject(input);
      currentTime = new Date(NOW.getTime() + 31 * 60_000);
      return stored;
    };

    await expect(
      service.finalizeUpload({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        uploadId: upload.upload_id,
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_UPLOAD_EXPIRED' });
    expect((await repository.listAssets(PROJECT_ID, 10)).items).toEqual([]);
  });

  test('creates a short-lived driver download only for the owning account and project', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    let downloadPresigns = 0;
    const createSignedDownloadUrl = store.createSignedDownloadUrl.bind(store);
    store.createSignedDownloadUrl = async (input) => {
      downloadPresigns += 1;
      return createSignedDownloadUrl(input);
    };
    const service = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const upload = await service.createUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: { filename: '../portrait.png' },
    });
    const asset = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      uploadId: upload.upload_id,
    });
    if (!asset) throw new Error('expected upload finalization to succeed');

    const missing = await service.createDownloadUrl({
      accountId: ACCOUNT_ID,
      projectId: '20000000-0000-4000-a000-000000000099',
      assetId: asset.asset_id,
    });
    const download = await service.createDownloadUrl({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      assetId: asset.asset_id,
    });

    expect(missing).toBeNull();
    expect(download).toMatchObject({
      asset_id: asset.asset_id,
      expires_at: '2026-07-17T08:15:00.000Z',
    });
    if (!download) throw new Error('expected signed download');
    const signedUrl = new URL(download.signed_download_url);
    expect(signedUrl.protocol).toBe('memory:');
    expect(signedUrl.searchParams.get('filename')).toBe('portrait.png');
    expect(signedUrl.searchParams.get('ttl')).toBe('900');
    expect(downloadPresigns).toBe(1);
  });

  test('resolves only finalized project-owned reference assets with replayable bodies', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    let objectReads = 0;
    const getObject = store.getObject.bind(store);
    store.getObject = async (input) => {
      objectReads += 1;
      return getObject(input);
    };
    const service = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const upload = await service.createUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    const asset = await service.finalizeUpload({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      uploadId: upload.upload_id,
    });
    if (!asset) throw new Error('expected finalized reference asset');
    objectReads = 0;
    const resolver = createStudioReferenceAssetResolver(repository, store);

    await expect(
      resolver.resolve({
        projectId: '20000000-0000-4000-a000-000000000099',
        assetIds: [asset.asset_id],
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_INVALID' });
    expect(objectReads).toBe(0);
    const [reference] = await resolver.resolve({
      projectId: PROJECT_ID,
      assetIds: [asset.asset_id],
    });
    if (!reference) throw new Error('expected resolved reference');
    expect(reference).toMatchObject({
      kind: 'image',
      filename: `${asset.asset_id}.png`,
      mime_type: 'image/png',
      size_bytes: PNG.byteLength,
      replayable_within_attempt: true,
    });
    const bytes = new Uint8Array(await new Response(await reference.openBody()).arrayBuffer());
    const replayBytes = new Uint8Array(
      await new Response(await reference.openBody()).arrayBuffer(),
    );
    expect(bytes).toEqual(PNG);
    expect(replayBytes).toEqual(PNG);
    expect(objectReads).toBe(2);

    const getAsset = repository.getAsset.bind(repository);
    repository.getAsset = async (projectId, assetId) => {
      const found = await getAsset(projectId, assetId);
      return found
        ? {
            ...found,
            object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/../other-project/reference.png`,
          }
        : null;
    };
    await expect(
      resolver.resolve({ projectId: PROJECT_ID, assetIds: [asset.asset_id] }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_INVALID' });
    expect(objectReads).toBe(2);
    repository.getAsset = getAsset;

    store.getObject = async () => {
      throw new StudioStorageUnavailableError();
    };
    await expect(reference.openBody()).rejects.toMatchObject({
      code: 'STUDIO_STORAGE_UNAVAILABLE',
    });
  });
});

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function jpegWithDimensions(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x11,
    0x03,
    0x11,
    0x00,
    0x3f,
    0x00,
    0x00,
    0xff,
    0xd9,
  ]);
}

describe('Studio storage routes', () => {
  test('returns 503 before estimate or job creation when storage becomes unready', async () => {
    const repository = createMemoryStudioRepository({
      providers: [
        {
          provider_config_id: PROVIDER_CONFIG_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'fake',
          display_name: 'Fake image provider',
          base_url: null,
          region: null,
          credential_binding: { kind: 'none' },
          capabilities: ['image.generate'],
          enabled: true,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
    });
    let jobWrites = 0;
    const createJob = repository.createJob.bind(repository);
    repository.createJob = async (...args) => {
      jobWrites += 1;
      return createJob(...args);
    };
    const storeOptions = { namespace: 'private-studio', ready: true };
    const storageService = new StudioStorageService({
      repository,
      store: new InMemoryStudioObjectStore(storeOptions),
      now: () => NOW,
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-storage-job-gate-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);
    const imageInput = {
      capability: 'image.generate',
      image: {
        prompt: 'Storage readiness gate',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    };
    const estimateRequest = {
      capability: 'image.generate',
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
      input: imageInput,
    };
    const estimateResponse = await app.request(`/v1/projects/${PROJECT_ID}/studio/estimates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(estimateRequest),
    });
    expect(estimateResponse.status).toBe(200);
    const estimate = await estimateResponse.json();
    storeOptions.ready = false;

    const blockedEstimate = await app.request(`/v1/projects/${PROJECT_ID}/studio/estimates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(estimateRequest),
    });
    const blockedJob = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...estimateRequest,
        estimate_id: estimate.estimate_id,
        estimate_token: estimate.estimate_token,
        idempotency_key: 'studio-storage-readiness-job-key',
        request_hash: estimate.input_hash,
      }),
    });

    expect(blockedEstimate.status).toBe(503);
    expect(await blockedEstimate.json()).toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
    expect(blockedJob.status).toBe(503);
    expect(await blockedJob.json()).toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
    expect(jobWrites).toBe(0);
  });

  test('does not advertise execution when storage is ready but no registered provider exists', async () => {
    const repository = createMemoryStudioRepository();
    const storageService = new StudioStorageService({
      repository,
      store: new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true }),
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-no-provider-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);

    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
  });

  test('does not advertise execution for a malformed production credential binding', async () => {
    const repository = createMemoryStudioRepository({
      providers: [
        {
          provider_config_id: PROVIDER_CONFIG_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'openai-compatible',
          display_name: 'Malformed provider',
          base_url: 'https://images.example.test/v1',
          region: null,
          credential_binding: { kind: 'secret', identifier: '   ' },
          capabilities: ['image.generate'],
          enabled: true,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
    });
    const storageService = new StudioStorageService({
      repository,
      store: new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true }),
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-malformed-binding-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);

    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
  });

  test('advertises a production provider only after its credential binding is found', async () => {
    const repository = createMemoryStudioRepository({
      providers: [
        {
          provider_config_id: PROVIDER_CONFIG_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'openai-compatible',
          display_name: 'Configured provider',
          base_url: 'https://images.example.test/v1',
          region: null,
          credential_binding: { kind: 'secret', identifier: 'studio-provider-key' },
          capabilities: ['image.generate'],
          enabled: true,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
    });
    const storageService = new StudioStorageService({
      repository,
      store: new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true }),
    });
    const routeDeps: StudioProjectRouteDeps = {
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-binding-existence-test-secret',
    };
    const unavailableApp = new Hono();
    unavailableApp.route('/v1/projects', createStudioProjectRoutes(routeDeps));
    const unavailable = await unavailableApp.request(
      `/v1/projects/${PROJECT_ID}/studio/capabilities`,
    );
    expect(await unavailable.json()).toEqual({ items: [], next_cursor: null });

    const checks: unknown[] = [];
    const availableApp = new Hono();
    availableApp.route(
      '/v1/projects',
      createStudioProjectRoutes({
        ...routeDeps,
        credentialBindingExists: async (input) => {
          checks.push(input);
          return true;
        },
      }),
    );
    const available = await availableApp.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);
    expect((await available.json()).items).toHaveLength(1);
    expect(checks).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        binding: { kind: 'secret', identifier: 'studio-provider-key' },
      },
    ]);
  });

  test('maps an object body stream failure to storage unavailable', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const storageService = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-stream-failure-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);
    const uploadResponse = await app.request(`/v1/projects/${PROJECT_ID}/studio/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        declared_mime_type: 'image/png',
        expected_size_bytes: PNG.byteLength,
        expected_checksum_sha256: PNG_CHECKSUM,
      }),
    });
    const upload = (await uploadResponse.json()) as { upload_id: string; object_key: string };
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: {},
    });
    const getObject = store.getObject.bind(store);
    store.getObject = async (input) => {
      const stored = await getObject(input);
      return {
        ...stored,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('simulated object stream failure'));
          },
        }),
      };
    };

    const finalize = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/uploads/${upload.upload_id}/finalize`,
      { method: 'POST' },
    );

    expect(finalize.status).toBe(503);
    expect(await finalize.json()).toEqual({
      error: 'Studio storage unavailable',
      code: 'STUDIO_STORAGE_UNAVAILABLE',
    });
  });

  test('uses the injected object store for upload, finalize, and download', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const storeOptions = { namespace: 'private-studio', ready: true };
    const store = new InMemoryStudioObjectStore(storeOptions);
    const storageService = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) =>
        projectId === PROJECT_ID
          ? { row: { accountId: ACCOUNT_ID, projectId }, userId: ACTOR_USER_ID }
          : null,
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-storage-route-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        declared_mime_type: 'image/png',
        expected_size_bytes: PNG.byteLength,
        expected_checksum_sha256: PNG_CHECKSUM,
      }),
    });

    expect(response.status).toBe(201);
    const upload = (await response.json()) as {
      upload_id: string;
      object_key: string;
      signed_upload_url: string;
    };
    expect(upload.signed_upload_url).toStartWith('memory-upload://private-studio/');
    expect(upload.signed_upload_url).not.toContain('studio.local');
    const missingObject = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/uploads/${upload.upload_id}/finalize`,
      { method: 'POST' },
    );
    expect(missingObject.status).toBe(400);
    expect(await missingObject.json()).toMatchObject({ code: 'STUDIO_ASSET_INVALID' });
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: { filename: 'route.png' },
    });

    const finalized = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/uploads/${upload.upload_id}/finalize`,
      { method: 'POST' },
    );
    expect(finalized.status).toBe(200);
    const asset = (await finalized.json()) as {
      asset_id: string;
      bucket: string;
      width: number | null;
      height: number | null;
    };
    expect(asset).toMatchObject({ bucket: 'private-studio', width: 1, height: 1 });

    const download = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/assets/${asset.asset_id}/download-url`,
      { method: 'POST' },
    );
    expect(download.status).toBe(200);
    const signedDownload = (await download.json()) as { signed_download_url: string };
    expect(signedDownload.signed_download_url).toStartWith('memory://private-studio/');
    expect(signedDownload.signed_download_url).not.toContain('studio.local');

    storeOptions.ready = false;
    const unavailableDownload = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/assets/${asset.asset_id}/download-url`,
      { method: 'POST' },
    );
    expect(unavailableDownload.status).toBe(503);
    expect(await unavailableDownload.json()).toMatchObject({
      code: 'STUDIO_STORAGE_UNAVAILABLE',
    });
  });

  test('maps an unready store to 503 before creating a pending upload', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    let writes = 0;
    const createPendingUpload = repository.createPendingUpload.bind(repository);
    repository.createPendingUpload = async (input) => {
      writes += 1;
      return createPendingUpload(input);
    };
    const storageService = new StudioStorageService({
      repository,
      store: new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: false }),
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-storage-unready-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        declared_mime_type: 'image/png',
        expected_size_bytes: 128,
        expected_checksum_sha256: CHECKSUM,
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
    expect(writes).toBe(0);
  });

  test('maps a signed-upload driver failure to 503 without persisting a pending row', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    let writes = 0;
    const createPendingUpload = repository.createPendingUpload.bind(repository);
    repository.createPendingUpload = async (input) => {
      writes += 1;
      return createPendingUpload(input);
    };
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    store.createSignedUploadUrl = async () => {
      throw new Error('simulated presigner failure');
    };
    const storageService = new StudioStorageService({
      repository,
      store,
      now: () => NOW,
      randomUUID: () => UPLOAD_ID,
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-presigner-failure-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        declared_mime_type: 'image/png',
        expected_size_bytes: PNG.byteLength,
        expected_checksum_sha256: PNG_CHECKSUM,
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
    expect(writes).toBe(0);
  });

  test('maps an expired finalize to 410 without creating an asset', async () => {
    const repository = createMemoryStudioRepository({ now: () => NOW.toISOString() });
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    let currentTime = NOW;
    const storageService = new StudioStorageService({
      repository,
      store,
      now: () => currentTime,
      randomUUID: () => UPLOAD_ID,
    });
    const routes = createStudioProjectRoutes({
      repository,
      storageService,
      loadProjectForUser: async (_c, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: ACTOR_USER_ID,
      }),
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-storage-expiry-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);
    const uploadResponse = await app.request(`/v1/projects/${PROJECT_ID}/studio/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        declared_mime_type: 'image/png',
        expected_size_bytes: PNG.byteLength,
        expected_checksum_sha256: PNG_CHECKSUM,
      }),
    });
    const upload = (await uploadResponse.json()) as { upload_id: string };
    currentTime = new Date(NOW.getTime() + 31 * 60_000);

    const finalize = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/uploads/${upload.upload_id}/finalize`,
      { method: 'POST' },
    );

    expect(finalize.status).toBe(410);
    expect(await finalize.json()).toMatchObject({ code: 'STUDIO_UPLOAD_EXPIRED' });
    expect((await repository.listAssets(PROJECT_ID, 10)).items).toEqual([]);
  });
});
