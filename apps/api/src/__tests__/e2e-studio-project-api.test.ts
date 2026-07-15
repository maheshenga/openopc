import { beforeEach, describe, expect, test } from 'bun:test';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createStudioProjectRoutes, createMemoryStudioRepository } from '../studio';
import { PROJECT_ACTIONS } from '../iam/actions';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const OTHER_PROJECT_ID = '00000000-0000-4000-a000-000000000202';
const USER_ID = '00000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '00000000-0000-4000-a000-000000000301';

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

function createApp() {
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
  const assertedActions: string[] = [];
  const routes = createStudioProjectRoutes({
    repository,
    loadProjectForUser: async (_c, projectId) =>
      projectId === PROJECT_ID || projectId === OTHER_PROJECT_ID
        ? {
            row: { accountId: ACCOUNT_ID, projectId },
            userId: USER_ID,
          }
        : null,
    assertProjectCapability: async (_c, _userId, _accountId, _projectId, action) => {
      assertedActions.push(action);
    },
  });
  const app = new Hono();
  app.route('/v1/projects', routes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return { app, assertedActions };
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
    const capabilityBody = await capabilities.json();
    expect(capabilityBody.items.map((item: any) => item.capability)).toEqual(['image.generate']);

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
    expect(estimate.estimate_token).toStartWith('studio-estimate-');
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
    expect((await list.json()).items.map((item: any) => item.job_id)).toEqual([job.job_id]);

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

    const cancelled = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs/${job.job_id}/cancel`, {
      method: 'POST',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ job_id: job.job_id, status: 'cancelled' });
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN);
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ);
    expect(assertedActions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_CANCEL);
  });
});
