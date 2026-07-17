import { beforeEach, describe, expect, test } from 'bun:test';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import { PROJECT_ACTIONS } from '../iam/actions';
import { createMemoryStudioRepository, createStudioProjectRoutes } from '../studio';
import { StudioStorageService } from '../studio/storage';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const OTHER_PROJECT_ID = '00000000-0000-4000-a000-000000000202';
const USER_ID = '00000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '00000000-0000-4000-a000-000000000301';
const OTHER_PROVIDER_CONFIG_ID = '00000000-0000-4000-a000-000000000302';
const ESTIMATE_SIGNING_SECRET = 'studio-test-estimate-signing-secret';
const ACCOUNT_TOKEN_ID = '00000000-0000-4000-a000-000000000501';
const SERVICE_ACCOUNT_ID = '00000000-0000-4000-a000-000000000502';
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const PNG_CHECKSUM = new Bun.CryptoHasher('sha256').update(PNG).digest('hex');

const imageInput = {
  capability: 'image.generate' as const,
  image: {
    prompt: 'A precise studio smoke image',
    reference_asset_ids: [],
    aspect_ratio: '1:1' as const,
    quality: 'standard' as const,
    output_count: 1,
  },
};

type TestAuthContext = {
  authType?: 'supabase' | 'pat' | 'apiKey' | 'service_account';
  userId?: string;
  iamTokenId?: string;
  sessionId?: string;
  agentGrant?: { agent: string } | null;
  createJobError?: Error;
};

function createApp(auth: TestAuthContext = {}) {
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
        created_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    ],
  });
  let capturedCreateInput: Parameters<typeof repository.createJob>[0] | null = null;
  const createJob = repository.createJob.bind(repository);
  repository.createJob = async (...args) => {
    capturedCreateInput = args[0];
    if (auth.createJobError) throw auth.createJobError;
    return createJob(...args);
  };
  const assertedActions: string[] = [];
  const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
  const storageService = new StudioStorageService({ repository, store });
  const routes = createStudioProjectRoutes({
    repository,
    storageService,
    loadProjectForUser: async (_c, projectId) =>
      projectId === PROJECT_ID || projectId === OTHER_PROJECT_ID
        ? {
            row: { accountId: ACCOUNT_ID, projectId },
            userId: auth.userId ?? USER_ID,
          }
        : null,
    assertProjectCapability: async (_c, _userId, _accountId, _projectId, action) => {
      assertedActions.push(action);
    },
    estimateSigningSecret: ESTIMATE_SIGNING_SECRET,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    const context = c as unknown as { set(key: string, value: unknown): void };
    if (auth.authType) context.set('authType', auth.authType);
    if (auth.iamTokenId) context.set('iamTokenId', auth.iamTokenId);
    if (auth.sessionId) context.set('sessionId', auth.sessionId);
    if (auth.agentGrant !== undefined) context.set('agentGrant', auth.agentGrant);
    await next();
  });
  app.route('/v1/projects', routes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return { app, assertedActions, store, getCapturedCreateInput: () => capturedCreateInput };
}

async function createEstimate(app: Hono) {
  const res = await app.request(`/v1/projects/${PROJECT_ID}/studio/estimates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability: 'image.generate',
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
      input: imageInput,
    }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('Studio project API', () => {
  beforeEach(() => {
    // Keep this test independent of previous route-factory instances.
  });

  test('exposes only Phase 1 image generation capabilities and project providers', async () => {
    const { app, assertedActions } = createApp();

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);
    expect(capabilities.status).toBe(200);
    const capabilityBody = (await capabilities.json()) as {
      items: Array<{ capability: string }>;
    };
    expect(capabilityBody.items.map((item) => item.capability)).toEqual(['image.generate']);

    const providers = await app.request(`/v1/projects/${PROJECT_ID}/studio/providers`);
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({
      items: [
        {
          provider_config_id: PROVIDER_CONFIG_ID,
          provider: 'fake',
          capabilities: ['image.generate'],
          credential_binding: { kind: 'none' },
        },
      ],
      next_cursor: null,
    });
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE);
  });

  test('estimates image generation with a stable request hash', async () => {
    const { app } = createApp();
    const estimate = await createEstimate(app);

    expect(estimate).toMatchObject({
      currency: 'credits',
      provider_cost_credits: 1,
      platform_cost_credits: 0,
      max_approved_credits: 1,
      input_hash: canonicalStudioRequestHash({
        capability: 'image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
        input: imageInput,
      }),
    });
    expect(estimate.estimate_token).toStartWith('studio-estimate-v2.');
  });

  test('rejects an estimate token reused for a more expensive request', async () => {
    const { app } = createApp();
    const estimate = await createEstimate(app);
    const expensiveInput = {
      ...imageInput,
      image: { ...imageInput.image, quality: 'high' as const, output_count: 8 },
    };

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
        input: expensiveInput,
        estimate_id: estimate.estimate_id,
        estimate_token: estimate.estimate_token,
        idempotency_key: 'studio-under-reservation-attempt',
        request_hash: canonicalStudioRequestHash({
          capability: 'image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
          input: expensiveInput,
        }),
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_ESTIMATE_EXPIRED' });
  });

  test('rejects an expired estimate token', async () => {
    const { app } = createApp();
    const estimate = await createEstimate(app);
    const originalNow = Date.now;
    Date.now = () => Date.parse(estimate.expires_at) + 1;
    try {
      const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: 'image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
          input: imageInput,
          estimate_id: estimate.estimate_id,
          estimate_token: estimate.estimate_token,
          idempotency_key: 'studio-expired-estimate-key',
          request_hash: estimate.input_hash,
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'STUDIO_ESTIMATE_EXPIRED' });
    } finally {
      Date.now = originalNow;
    }
  });

  test('accepts a signed estimate on a different API instance', async () => {
    const issuer = createApp().app;
    const estimate = await createEstimate(issuer);
    const verifier = createApp().app;

    const response = await verifier.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
        input: imageInput,
        estimate_id: estimate.estimate_id,
        estimate_token: estimate.estimate_token,
        idempotency_key: 'studio-cross-instance-estimate',
        request_hash: estimate.input_hash,
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ reserved_credits: 1, status: 'queued' });
  });

  test('persists only type-correct PAT, Agent session, and service-account identity context', async () => {
    const cases = [
      {
        name: 'supabase',
        auth: { authType: 'supabase' as const, sessionId: 'supabase-root-session' },
        expected: {
          actor_type: 'user',
          acting_token_id: null,
          agent_name: null,
          session_id: null,
        },
      },
      {
        name: 'service-account',
        auth: {
          authType: 'service_account' as const,
          userId: SERVICE_ACCOUNT_ID,
          iamTokenId: SERVICE_ACCOUNT_ID,
        },
        expected: {
          actor_type: 'system',
          acting_token_id: null,
          agent_name: null,
          session_id: null,
        },
      },
      {
        name: 'agent-pat',
        auth: {
          authType: 'pat' as const,
          iamTokenId: ACCOUNT_TOKEN_ID,
          sessionId: 'project-session-1',
          agentGrant: { agent: 'image-agent' },
        },
        expected: {
          actor_type: 'agent',
          acting_token_id: ACCOUNT_TOKEN_ID,
          agent_name: 'image-agent',
          session_id: 'project-session-1',
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const harness = createApp(testCase.auth);
      const estimate = await createEstimate(harness.app);
      const response = await harness.app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: 'image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
          input: imageInput,
          estimate_id: estimate.estimate_id,
          estimate_token: estimate.estimate_token,
          idempotency_key: `studio-auth-context-${testCase.name}-${index}`,
          request_hash: estimate.input_hash,
        }),
      });

      expect(response.status).toBe(201);
      expect(harness.getCapturedCreateInput()).toMatchObject(testCase.expected);
    }
  });

  test('maps insufficient reservation credits to the public 402 error contract', async () => {
    const error = Object.assign(new Error('Insufficient credits'), {
      studioCode: 'STUDIO_INSUFFICIENT_CREDITS',
      httpStatus: 402,
    });
    const { app } = createApp({ createJobError: error });
    const estimate = await createEstimate(app);

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
        input: imageInput,
        estimate_id: estimate.estimate_id,
        estimate_token: estimate.estimate_token,
        idempotency_key: 'studio-insufficient-credits',
        request_hash: estimate.input_hash,
      }),
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: 'STUDIO_INSUFFICIENT_CREDITS',
      error: 'Insufficient credits',
    });
  });

  test('creates jobs idempotently, lists events, and cancels queued jobs', async () => {
    const { app, assertedActions } = createApp();
    const estimate = await createEstimate(app);
    const createBody = {
      capability: 'image.generate',
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
      input: imageInput,
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      idempotency_key: 'studio-test-idempotency-key',
      request_hash: estimate.input_hash,
    };

    const created = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    const job = await created.json();
    expect(job).toMatchObject({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      actor_user_id: USER_ID,
      actor_type: 'user',
      capability: 'image.generate',
      provider: 'fake',
      status: 'queued',
      reserved_credits: 1,
      actual_credits: null,
    });

    const duplicate = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).job_id).toBe(job.job_id);

    const mismatch = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...createBody,
        request_hash: canonicalStudioRequestHash({ different: true }),
      }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: 'STUDIO_IDEMPOTENCY_MISMATCH' });

    const list = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`);
    expect(list.status).toBe(200);
    const listedJobs = (await list.json()) as { items: Array<{ job_id: string }> };
    expect(listedJobs.items.map((item) => item.job_id)).toEqual([job.job_id]);

    const read = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs/${job.job_id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).job_id).toBe(job.job_id);

    const hidden = await app.request(`/v1/projects/${OTHER_PROJECT_ID}/studio/jobs/${job.job_id}`);
    expect(hidden.status).toBe(404);

    const events = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs/${job.job_id}/events`);
    expect(events.status).toBe(200);
    expect((await events.json()).items).toEqual([
      expect.objectContaining({ job_id: job.job_id, cursor: '1', type: 'queued' }),
    ]);

    const cancelled = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/jobs/${job.job_id}/cancel`,
      {
        method: 'POST',
      },
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ job_id: job.job_id, status: 'cancelled' });
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN);
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ);
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_CANCEL);
  });

  test('creates uploads, finalizes assets, lists assets, and hides cross-project assets', async () => {
    const { app, assertedActions, store } = createApp();
    const uploadRequest = {
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      metadata: { label: 'reference' },
    };

    const uploadRes = await app.request(`/v1/projects/${PROJECT_ID}/studio/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadRequest),
    });
    expect(uploadRes.status).toBe(201);
    const upload = await uploadRes.json();
    expect(upload).toMatchObject({
      project_id: PROJECT_ID,
      asset_id: null,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      status: 'pending',
    });
    expect(upload.signed_upload_url).toStartWith('memory-upload://studio-test/');
    await store.putObject({
      key: upload.object_key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: PNG_CHECKSUM,
      metadata: { label: 'reference' },
    });

    const assetRes = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/uploads/${upload.upload_id}/finalize`,
      { method: 'POST' },
    );
    expect(assetRes.status).toBe(200);
    const asset = await assetRes.json();
    expect(asset).toMatchObject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      source_job_id: null,
      kind: 'image',
      mime_type: 'image/png',
      checksum_sha256: PNG_CHECKSUM,
      size_bytes: PNG.byteLength,
      width: 1,
      height: 1,
      metadata: { label: 'reference' },
    });

    const assets = await app.request(`/v1/projects/${PROJECT_ID}/studio/assets`);
    expect(assets.status).toBe(200);
    const listedAssets = (await assets.json()) as { items: Array<{ asset_id: string }> };
    expect(listedAssets.items.map((item) => item.asset_id)).toEqual([asset.asset_id]);

    const read = await app.request(`/v1/projects/${PROJECT_ID}/studio/assets/${asset.asset_id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).asset_id).toBe(asset.asset_id);

    const hidden = await app.request(
      `/v1/projects/${OTHER_PROJECT_ID}/studio/assets/${asset.asset_id}`,
    );
    expect(hidden.status).toBe(404);

    const download = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/assets/${asset.asset_id}/download-url`,
      {
        method: 'POST',
      },
    );
    expect(download.status).toBe(200);
    const downloadBody = await download.json();
    expect(downloadBody).toMatchObject({ asset_id: asset.asset_id });
    expect(downloadBody.signed_download_url).toStartWith('memory://studio-test/');

    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_WRITE);
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_READ);
  });

  test('does not disclose an existing job when an idempotency key crosses projects', async () => {
    const repository = createMemoryStudioRepository();
    const estimate = {
      estimate_id: '00000000-0000-4000-a000-000000000401',
      estimate_token: 'studio-estimate-token',
      expires_at: '2026-07-15T10:15:00.000Z',
      currency: 'credits' as const,
      input_hash: 'same-request-hash',
      provider_cost_credits: 1,
      platform_cost_credits: 0,
      max_approved_credits: 1,
      line_items: [],
    };
    const provider = (projectId: string, providerConfigId: string) => ({
      provider_config_id: providerConfigId,
      account_id: ACCOUNT_ID,
      project_id: projectId,
      provider: 'fake' as const,
      display_name: 'Fake',
      base_url: null,
      region: null,
      credential_binding: { kind: 'none' as const },
      capabilities: ['image.generate' as const],
      enabled: true,
      created_at: '2026-07-15T10:00:00.000Z',
      updated_at: '2026-07-15T10:00:00.000Z',
    });
    const jobInput = (projectId: string, providerConfigId: string) => ({
      account_id: ACCOUNT_ID,
      project_id: projectId,
      actor_user_id: USER_ID,
      actor_type: 'user' as const,
      acting_token_id: null,
      agent_name: null,
      session_id: null,
      parent_job_id: null,
      capability: 'image.generate' as const,
      provider_config_id: providerConfigId,
      model: 'fake/image-v1',
      input: imageInput,
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      idempotency_key: 'shared-account-idempotency-key',
      request_hash: 'same-request-hash',
    });

    await repository.createJob(
      jobInput(PROJECT_ID, PROVIDER_CONFIG_ID),
      provider(PROJECT_ID, PROVIDER_CONFIG_ID),
      estimate,
    );
    const collision = await repository.createJob(
      jobInput(OTHER_PROJECT_ID, OTHER_PROVIDER_CONFIG_ID),
      provider(OTHER_PROJECT_ID, OTHER_PROVIDER_CONFIG_ID),
      estimate,
    );

    expect(collision).toMatchObject({ created: false, mismatch: true });
    expect('job' in collision).toBe(false);
  });
});
