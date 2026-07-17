import { describe, expect, test } from 'bun:test';
import type { StudioEstimateRequest } from '@kortix/api-contract';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import { issueStudioEstimateToken, verifyStudioEstimateToken } from './estimate-token';
import { createStudioProjectRoutes } from './index';
import { createMemoryStudioRepository } from './repositories/memory';
import { StudioStorageService } from './storage';
import type { StudioRepository } from './types';

const ACCOUNT_ID = '71000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '71000000-0000-4000-a000-000000000002';
const PROJECT_ID = '72000000-0000-4000-a000-000000000001';
const USER_ID = '73000000-0000-4000-a000-000000000001';
const PRICE_ID = '74000000-0000-4000-a000-000000000001';
const PROVIDER_ID = '75000000-0000-4000-a000-000000000001';
const SECRET = 'studio-production-estimate-test-secret';

const capabilityMap = {
  definition_id: 'openai-compatible',
  capabilities: {
    'image.generate': {
      models: [
        {
          model: 'gpt-image-1',
          pricing_catalog_id: PRICE_ID,
          dialect_profile_id: 'openai-images-v1-generic',
          supports_reference_images: false,
          allowed_advanced_fields: [],
          size_map: {
            '1:1': '1024x1024',
            '4:3': '1536x1024',
            '3:4': '1024x1536',
            '16:9': '1536x864',
            '9:16': '864x1536',
          },
        },
      ],
    },
  },
};

const imageInput: StudioEstimateRequest['input'] = {
  capability: 'image.generate' as const,
  image: {
    prompt: 'A production estimate',
    reference_asset_ids: [],
    aspect_ratio: '1:1' as const,
    quality: 'standard' as const,
    output_count: 2,
  },
};

async function createProductionApp(
  pricingOverrides: Partial<{
    rateCredits: number;
    maxProviderCredits: number;
    markupCredits: number;
  }> = {},
) {
  const repository = createMemoryStudioRepository({
    pricing: [
      {
        pricing_catalog_id: PRICE_ID,
        account_id: ACCOUNT_ID,
        provider: 'openai-compatible',
        model: 'gpt-image-1',
        unit: 'image',
        rate_data: { rate_credits: pricingOverrides.rateCredits ?? 2 },
        maximum_cost_rule: {
          max_provider_credits: pricingOverrides.maxProviderCredits ?? 10,
        },
        markup_rule: { markup_credits: pricingOverrides.markupCredits ?? 0.25 },
        version: 3,
        active: true,
        created_by_user_id: USER_ID,
        created_at: '2026-07-17T00:00:00.000Z',
      },
    ],
    now: () => '2026-07-17T00:00:00.000Z',
  });
  const created = await repository.createProviderConfig(
    {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      provider: 'openai-compatible',
      display_name: 'Production images',
      base_url: 'https://images.example.test/v1',
      region: null,
      credential_binding: { kind: 'secret', identifier: 'studio-image-key' },
      capability_map: capabilityMap,
      enabled: true,
    },
    [
      {
        pricing_catalog_id: PRICE_ID,
        provider: 'openai-compatible',
        model: 'gpt-image-1',
      },
    ],
  );
  if (!created.ok) throw new Error('production provider fixture failed');

  const app = mountApp(repository);
  return { app, repository, provider: created.value };
}

function mountApp(
  repository: StudioRepository,
  credentialBindingExists: () => Promise<boolean> = async () => true,
) {
  const storageService = new StudioStorageService({
    repository,
    store: new InMemoryStudioObjectStore({ namespace: 'estimate-test', ready: true }),
  });
  const routes = createStudioProjectRoutes({
    repository,
    storageService,
    loadProjectForUser: async (_context, projectId) =>
      projectId === PROJECT_ID
        ? { row: { accountId: ACCOUNT_ID, projectId }, userId: USER_ID }
        : null,
    assertProjectCapability: async () => {},
    credentialBindingExists,
    estimateSigningSecret: SECRET,
  });
  const app = new Hono();
  app.route('/v1/projects', routes);
  return app;
}

async function requestEstimate(
  app: Hono,
  providerConfigId: string,
  overrides: Partial<{
    model: string;
    input: typeof imageInput;
  }> = {},
) {
  return app.request(`/v1/projects/${PROJECT_ID}/studio/estimates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability: 'image.generate',
      provider_config_id: providerConfigId,
      model: overrides.model ?? 'gpt-image-1',
      input: overrides.input ?? imageInput,
    }),
  });
}

function jobRequest(input: {
  providerConfigId: string;
  estimate: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const request = {
    capability: 'image.generate' as const,
    provider_config_id: input.providerConfigId,
    model: 'gpt-image-1',
    input: imageInput,
  };
  return {
    ...request,
    estimate_id: input.estimate.estimate_id,
    estimate_token: input.estimate.estimate_token,
    idempotency_key: input.idempotencyKey,
    request_hash: canonicalStudioRequestHash(request),
  };
}

describe('Studio production estimates', () => {
  test('uses the registered definition and immutable pricing in a v2 token', async () => {
    const { app, provider } = await createProductionApp();

    const response = await requestEstimate(app, provider.provider_config_id);

    expect(response.status).toBe(200);
    const estimate = (await response.json()) as Record<string, unknown>;
    expect(estimate).toMatchObject({
      provider_cost_credits: 4,
      platform_cost_credits: 0.5,
      max_approved_credits: 10.5,
      line_items: [
        { label: 'Provider image generation', credits: 4 },
        { label: 'Studio platform fee', credits: 0.5 },
      ],
    });
    expect(estimate.estimate_token).toBeString();
    expect(estimate.estimate_token as string).toStartWith('studio-estimate-v2.');
    const verified = verifyStudioEstimateToken({
      token: estimate.estimate_token as string,
      secret: SECRET,
    });
    expect(verified.valid).toBe(true);
    if (!verified.valid || verified.claims.version !== 2) throw new Error('expected v2 claims');
    expect(verified.claims).toMatchObject({
      provider_config_version: provider.version_token,
      pricing_catalog_id: PRICE_ID,
      pricing_version: 3,
    });
  });

  test('persists a job only while the signed provider and pricing versions are current', async () => {
    const { app, provider } = await createProductionApp();
    const estimateResponse = await requestEstimate(app, provider.provider_config_id);
    const estimate = (await estimateResponse.json()) as Record<string, unknown>;

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        jobRequest({
          providerConfigId: provider.provider_config_id,
          estimate,
          idempotencyKey: 'production-versioned-job-0001',
        }),
      ),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      reserved_credits: 10.5,
    });
  });

  test('rejects provider configuration changes made after an estimate', async () => {
    const { app, repository, provider } = await createProductionApp();
    const estimateResponse = await requestEstimate(app, provider.provider_config_id);
    const estimate = (await estimateResponse.json()) as Record<string, unknown>;
    const updated = await repository.updateProviderConfig(
      { ...provider, base_url: 'https://rotated.example.test/v1' },
      provider.version_token,
      [
        {
          pricing_catalog_id: PRICE_ID,
          provider: 'openai-compatible',
          model: 'gpt-image-1',
        },
      ],
      { base_url: 'https://rotated.example.test/v1' },
    );
    expect(updated.ok).toBe(true);

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        jobRequest({
          providerConfigId: provider.provider_config_id,
          estimate,
          idempotencyKey: 'production-stale-provider-0001',
        }),
      ),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_PROVIDER_CONFIG_STALE' });
  });

  test('rejects pricing deactivated after an estimate', async () => {
    const { app, repository, provider } = await createProductionApp();
    const estimateResponse = await requestEstimate(app, provider.provider_config_id);
    const estimate = (await estimateResponse.json()) as Record<string, unknown>;
    await repository.deactivatePricing(ACCOUNT_ID, PRICE_ID);

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        jobRequest({
          providerConfigId: provider.provider_config_id,
          estimate,
          idempotencyKey: 'production-stale-pricing-0001',
        }),
      ),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_PRICING_STALE' });
  });

  test('rejects legacy v1 tokens for production providers', async () => {
    const { app, provider } = await createProductionApp();
    const estimateResponse = await requestEstimate(app, provider.provider_config_id);
    const estimate = (await estimateResponse.json()) as Record<string, unknown>;
    const { estimate_token: _token, ...unsigned } = estimate;
    const legacyToken = issueStudioEstimateToken({
      secret: SECRET,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      estimate: unsigned as never,
    });

    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        jobRequest({
          providerConfigId: provider.provider_config_id,
          estimate: { ...estimate, estimate_token: legacyToken },
          idempotencyKey: 'production-v1-token-rejected-0001',
        }),
      ),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_ESTIMATE_EXPIRED' });
  });

  test('fails closed for unsupported models and reference-image input', async () => {
    const { app, provider } = await createProductionApp();
    const unsupported = await requestEstimate(app, provider.provider_config_id, {
      model: 'unregistered-image-model',
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: 'STUDIO_MODEL_UNSUPPORTED' });

    const referenceInput = {
      ...imageInput,
      image: {
        ...imageInput.image,
        reference_asset_ids: ['77000000-0000-4000-a000-000000000001'],
      },
    };
    const invalid = await requestEstimate(app, provider.provider_config_id, {
      input: referenceInput,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'STUDIO_VALIDATION_ERROR' });

    const advanced = await requestEstimate(app, provider.provider_config_id, {
      input: {
        ...imageInput,
        image: { ...imageInput.image, advanced: { undocumented: true } },
      },
    });
    expect(advanced.status).toBe(400);
    expect(await advanced.json()).toMatchObject({ code: 'STUDIO_VALIDATION_ERROR' });
  });

  test('fails closed when a pricing repository returns a cross-account row', async () => {
    const { app, repository, provider } = await createProductionApp();
    const getActivePricing = repository.getActivePricing.bind(repository);
    repository.getActivePricing = async (accountId, pricingCatalogId) => {
      const price = await getActivePricing(accountId, pricingCatalogId);
      return price ? { ...price, account_id: OTHER_ACCOUNT_ID } : null;
    };

    const response = await requestEstimate(app, provider.provider_config_id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_PRICING_STALE' });
  });

  test('fails closed with a stable error for a malformed production capability map', async () => {
    const repository = createMemoryStudioRepository();
    const created = await repository.createProviderConfig(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        provider: 'openai-compatible',
        display_name: 'Malformed provider',
        base_url: 'https://images.example.test/v1',
        region: null,
        credential_binding: { kind: 'secret', identifier: 'studio-image-key' },
        capability_map: { malformed: true },
        enabled: true,
      },
      [],
    );
    if (!created.ok) throw new Error('malformed fixture creation failed');
    const app = mountApp(repository);

    const response = await requestEstimate(app, created.value.provider_config_id);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_PROVIDER_CONFIG_INVALID' });
  });

  test('supports an immutable all-zero pricing catalog without inventing a reservation', async () => {
    const { app, provider } = await createProductionApp({
      rateCredits: 0,
      maxProviderCredits: 0,
      markupCredits: 0,
    });

    const response = await requestEstimate(app, provider.provider_config_id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider_cost_credits: 0,
      platform_cost_credits: 0,
      max_approved_credits: 0,
      line_items: [{ label: 'Provider image generation', credits: 0 }],
    });
  });

  test('never treats a credential-bound fake row as a production fallback', async () => {
    const fakeProviderId = '78000000-0000-4000-a000-000000000001';
    const repository = createMemoryStudioRepository({
      providers: [
        {
          provider_config_id: fakeProviderId,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'fake',
          display_name: 'Invalid fake binding',
          base_url: null,
          region: null,
          credential_binding: { kind: 'secret', identifier: 'must-not-be-used' },
          capabilities: ['image.generate'],
          enabled: true,
          created_at: '2026-07-17T00:00:00.000Z',
          updated_at: '2026-07-17T00:00:00.000Z',
        },
      ],
    });
    const app = mountApp(repository);

    const response = await requestEstimate(app, fakeProviderId, { model: 'fake/image-v1' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_PROVIDER_CONFIG_INVALID' });
  });

  test('does not estimate a production provider whose credential binding no longer exists', async () => {
    const { repository, provider } = await createProductionApp();
    const app = mountApp(repository, async () => false);

    const response = await requestEstimate(app, provider.provider_config_id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_CREDENTIAL_UNAVAILABLE' });
  });

  test('replays an already-created job before consulting mutable provider pricing', async () => {
    const { app, repository, provider } = await createProductionApp();
    const estimateResponse = await requestEstimate(app, provider.provider_config_id);
    const estimate = (await estimateResponse.json()) as Record<string, unknown>;
    const body = jobRequest({
      providerConfigId: provider.provider_config_id,
      estimate,
      idempotencyKey: 'production-replay-before-pricing-0001',
    });
    const first = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { job_id: string };
    await repository.deactivatePricing(ACCOUNT_ID, PRICE_ID);

    const replay = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ job_id: created.job_id });
  });
});
