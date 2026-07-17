import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type {
  StudioCreateProviderConfigRequest,
  StudioUpdateProviderConfigRequest,
} from '@kortix/api-contract';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PROJECT_ACTIONS } from '../iam/actions';
import { createStudioProjectRoutes } from './index';
import { StudioPricingService } from './pricing';
import { StudioProviderConfigService, createStudioProviderOriginValidator } from './providers';
import { createDrizzleStudioRepository } from './repositories/drizzle';
import { createMemoryStudioRepository } from './repositories/memory';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const ACTOR_USER_ID = '30000000-0000-4000-a000-000000000001';

function capabilityMap(pricingCatalogId: string) {
  return {
    definition_id: 'openai-compatible',
    capabilities: {
      'image.generate': {
        models: [
          {
            model: 'gpt-image-1',
            pricing_catalog_id: pricingCatalogId,
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
}

function providerRequest(
  pricingCatalogId: string,
  overrides: Partial<StudioCreateProviderConfigRequest> = {},
): StudioCreateProviderConfigRequest {
  return {
    provider: 'openai-compatible',
    display_name: 'Production image provider',
    base_url: 'https://api.example.com',
    region: null,
    credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
    capability_map: capabilityMap(pricingCatalogId),
    enabled: true,
    ...overrides,
  };
}

async function createPricing(repository: ReturnType<typeof createMemoryStudioRepository>) {
  const result = await new StudioPricingService(repository).create({
    accountId: ACCOUNT_ID,
    actorUserId: ACTOR_USER_ID,
    request: {
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      unit: 'image',
      rate_data: { rate_credits: 1 },
      maximum_cost_rule: { max_provider_credits: 8 },
      markup_rule: { markup_credits: 0.25 },
    },
  });
  if (!result.ok) throw new Error('expected pricing creation to succeed');
  return result.value;
}

function originValidator() {
  return createStudioProviderOriginValidator({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    allowPrivateOrigins: new Set(),
    allowInsecureLocalEndpoints: false,
  });
}

describe('Studio provider configuration service', () => {
  test('creates a production config only after shared parsing, origin, and pricing fences pass', async () => {
    const repository = createMemoryStudioRepository();
    const pricing = await createPricing(repository);
    const service = new StudioProviderConfigService(repository, {
      validateOrigin: originValidator(),
    });

    const result = await service.create({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      request: providerRequest(pricing.pricing_catalog_id),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        provider: 'openai-compatible',
        capabilities: ['image.generate'],
        credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
      },
    });
  });

  test('creates a database config in one statement that locks active pricing and returns canonical version', async () => {
    const pricingCatalogId = '40000000-0000-4000-a000-000000000001';
    const providerConfigId = '50000000-0000-4000-a000-000000000001';
    let executeCalls = 0;
    const db = {
      execute: async () => {
        executeCalls += 1;
        return [
          {
            mutation_code: 'ok',
            version_token: 'canonical-db-version',
            provider_row: {
              provider_config_id: providerConfigId,
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              provider: 'openai-compatible',
              display_name: 'Production image provider',
              base_url: 'https://api.example.com/',
              region: null,
              credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
              capability_map: capabilityMap(pricingCatalogId),
              enabled: true,
              created_at: '2026-07-17T00:00:00.000Z',
              updated_at: '2026-07-17T00:00:00.000Z',
            },
          },
        ];
      },
      select: () => {
        throw new Error('provider creation must not use a TOCTOU SELECT');
      },
      insert: () => {
        throw new Error('provider creation must stay in the pricing-locked statement');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    await expect(
      repository.createProviderConfig(
        {
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'openai-compatible',
          display_name: 'Production image provider',
          base_url: 'https://api.example.com/',
          region: null,
          credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
          capability_map: capabilityMap(pricingCatalogId),
          enabled: true,
        },
        [
          {
            pricing_catalog_id: pricingCatalogId,
            provider: 'openai-compatible',
            model: 'gpt-image-1',
          },
        ],
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { provider_config_id: providerConfigId, version_token: 'canonical-db-version' },
    });
    expect(executeCalls).toBe(1);
    const source = readFileSync(new URL('./repositories/drizzle.ts', import.meta.url), 'utf8');
    expect(source).toContain('FOR UPDATE OF price');
    expect(source).toContain('canonicalProviderVersionSql');
  });

  test('loads, updates, and idempotently disables database configs through scoped atomic statements', async () => {
    const pricingCatalogId = '40000000-0000-4000-a000-000000000001';
    const providerConfigId = '50000000-0000-4000-a000-000000000001';
    const baseRow = {
      provider_config_id: providerConfigId,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      provider: 'openai-compatible',
      display_name: 'Production image provider',
      base_url: 'https://api.example.com/',
      region: null,
      credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
      capability_map: capabilityMap(pricingCatalogId),
      enabled: true,
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
    };
    const responses = [
      [{ provider_row: baseRow, version_token: 'canonical-v1' }],
      [
        {
          mutation_code: 'ok',
          provider_row: { ...baseRow, display_name: 'Patched' },
          version_token: 'canonical-v1',
        },
      ],
      [
        {
          mutation_code: 'ok',
          provider_row: { ...baseRow, display_name: 'Patched', enabled: false },
          version_token: 'canonical-v3',
        },
      ],
      [
        {
          mutation_code: 'ok',
          provider_row: { ...baseRow, display_name: 'Patched', enabled: false },
          version_token: 'canonical-v3',
        },
      ],
    ];
    let executeCalls = 0;
    const db = {
      execute: async () => responses[executeCalls++] ?? [],
      select: () => {
        throw new Error('provider management must remain in scoped SQL statements');
      },
      update: () => {
        throw new Error('provider mutation must not bypass version/pricing fences');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);
    const loaded = await repository.getProviderConfigRecord(
      ACCOUNT_ID,
      PROJECT_ID,
      providerConfigId,
    );
    if (!loaded) throw new Error('expected provider row');
    expect(loaded.version_token).toBe('canonical-v1');
    const { version_token: versionToken, updated_at: _updatedAt, ...candidate } = loaded;

    const updated = await repository.updateProviderConfig(
      { ...candidate, display_name: 'Patched' },
      versionToken,
      [
        {
          pricing_catalog_id: pricingCatalogId,
          provider: 'openai-compatible',
          model: 'gpt-image-1',
        },
      ],
      { display_name: 'Patched' },
    );
    expect(updated).toMatchObject({
      ok: true,
      value: { display_name: 'Patched', version_token: 'canonical-v1' },
    });
    const disabled = await repository.disableProviderConfig(
      ACCOUNT_ID,
      PROJECT_ID,
      providerConfigId,
    );
    const replay = await repository.disableProviderConfig(ACCOUNT_ID, PROJECT_ID, providerConfigId);
    expect(disabled).toMatchObject({ ok: true, value: { enabled: false } });
    expect(replay).toEqual(disabled);
    expect(executeCalls).toBe(4);
    const source = readFileSync(new URL('./repositories/drizzle.ts', import.meta.url), 'utf8');
    expect(source).toContain('WHEN ${patch.display_name !== undefined}');
  });

  test('derives public capabilities from the registered production definition without exposing raw maps', async () => {
    const pricingCatalogId = '40000000-0000-4000-a000-000000000001';
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              providerConfigId: '50000000-0000-4000-a000-000000000001',
              accountId: ACCOUNT_ID,
              projectId: PROJECT_ID,
              provider: 'openai-compatible',
              displayName: 'Production image provider',
              baseUrl: 'https://api.example.com/',
              region: null,
              credentialBinding: {
                kind: 'connector',
                slug: 'openai-images',
                plaintext: 'must-not-leak',
              },
              capabilityMap: capabilityMap(pricingCatalogId),
              enabled: true,
              createdAt: '2026-07-17T00:00:00.000Z',
              updatedAt: '2026-07-17T00:00:00.000Z',
            },
          ],
        }),
      }),
    };
    const repository = createDrizzleStudioRepository(db as never);

    const providers = await repository.listProviders(PROJECT_ID);

    expect(providers).toEqual([
      {
        provider_config_id: '50000000-0000-4000-a000-000000000001',
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        provider: 'openai-compatible',
        display_name: 'Production image provider',
        base_url: 'https://api.example.com/',
        region: null,
        credential_binding: { kind: 'connector', slug: 'openai-images' },
        capabilities: ['image.generate'],
        enabled: true,
        created_at: '2026-07-17T00:00:00.000Z',
        updated_at: '2026-07-17T00:00:00.000Z',
      },
    ]);
  });

  test('rejects production credential, origin, profile, and pricing-authority overrides before writes', async () => {
    const repository = createMemoryStudioRepository();
    const pricing = await createPricing(repository);
    let writes = 0;
    const createProviderConfig = repository.createProviderConfig.bind(repository);
    repository.createProviderConfig = async (...input) => {
      writes += 1;
      return createProviderConfig(...input);
    };
    let originChecks = 0;
    const validateOrigin = originValidator();
    const service = new StudioProviderConfigService(repository, {
      validateOrigin: async (url) => {
        originChecks += 1;
        return validateOrigin(url);
      },
    });
    const priceId = pricing.pricing_catalog_id;
    const unknownProfile = capabilityMap(priceId);
    const unknownProfileModel = unknownProfile.capabilities['image.generate'].models[0];
    if (!unknownProfileModel) throw new Error('expected profile fixture model');
    unknownProfileModel.dialect_profile_id =
      'user-claimed-replay-profile' as 'openai-images-v1-generic';
    const semanticOverride = {
      ...capabilityMap(priceId),
      submit_replay: true,
      reconciliation: true,
    };

    const invalidCases: Array<{
      request: StudioCreateProviderConfigRequest;
      code: 'invalid_config' | 'invalid_origin';
    }> = [
      {
        request: providerRequest(priceId, { credential_binding: { kind: 'none' } }),
        code: 'invalid_config',
      },
      {
        request: providerRequest(priceId, { base_url: 'https://127.0.0.1' }),
        code: 'invalid_origin',
      },
      {
        request: providerRequest(priceId, { capability_map: unknownProfile }),
        code: 'invalid_config',
      },
      {
        request: providerRequest(priceId, { capability_map: semanticOverride }),
        code: 'invalid_config',
      },
      {
        request: {
          ...providerRequest(priceId),
          rate_data: { rate_credits: 0 },
          markup_rule: { markup_credits: 0 },
        } as unknown as StudioCreateProviderConfigRequest,
        code: 'invalid_config',
      },
    ];

    for (const invalid of invalidCases) {
      await expect(
        service.create({ accountId: ACCOUNT_ID, projectId: PROJECT_ID, request: invalid.request }),
      ).resolves.toEqual({ ok: false, code: invalid.code });
    }
    expect(writes).toBe(0);
    expect(originChecks).toBe(1);
  });

  test('rejects missing, inactive, cross-account, provider-mismatched, and model-mismatched prices', async () => {
    const cases: Array<{
      price?: { accountId?: string; provider?: string; model?: string; deactivate?: boolean };
      referenceId?: string;
    }> = [
      { referenceId: '40000000-0000-4000-a000-000000000099' },
      { price: { deactivate: true } },
      { price: { accountId: OTHER_ACCOUNT_ID } },
      { price: { provider: 'different-provider' } },
      { price: { model: 'different-model' } },
    ];

    for (const scenario of cases) {
      const repository = createMemoryStudioRepository();
      let pricingCatalogId = scenario.referenceId;
      if (scenario.price) {
        const pricingResult = await new StudioPricingService(repository).create({
          accountId: scenario.price.accountId ?? ACCOUNT_ID,
          actorUserId: ACTOR_USER_ID,
          request: {
            provider: scenario.price.provider ?? 'openai-compatible',
            model: scenario.price.model ?? 'gpt-image-1',
            unit: 'image',
            rate_data: { rate_credits: 1 },
            maximum_cost_rule: { max_provider_credits: 8 },
            markup_rule: { markup_credits: 0.25 },
          },
        });
        if (!pricingResult.ok) throw new Error('expected fixture pricing to be created');
        pricingCatalogId = pricingResult.value.pricing_catalog_id;
        if (scenario.price.deactivate) {
          await new StudioPricingService(repository).deactivate({
            accountId: ACCOUNT_ID,
            pricingCatalogId,
          });
        }
      }
      if (!pricingCatalogId) throw new Error('expected pricing catalog fixture');

      const service = new StudioProviderConfigService(repository, {
        validateOrigin: originValidator(),
      });
      await expect(
        service.create({
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          request: providerRequest(pricingCatalogId),
        }),
      ).resolves.toEqual({ ok: false, code: 'pricing_invalid' });
    }
  });

  test('validates the full merged PATCH candidate and soft-disables without cross-project disclosure', async () => {
    const repository = createMemoryStudioRepository();
    const pricing = await createPricing(repository);
    const service = new StudioProviderConfigService(repository, {
      validateOrigin: originValidator(),
    });
    const created = await service.create({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      request: providerRequest(pricing.pricing_catalog_id),
    });
    if (!created.ok) throw new Error('expected provider creation to succeed');

    await expect(
      service.update({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        providerConfigId: created.value.provider_config_id,
        request: { display_name: 'Rotated provider name' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        display_name: 'Rotated provider name',
        capabilities: ['image.generate'],
        credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
      },
    });

    const missingPricePatch: StudioUpdateProviderConfigRequest = {
      capability_map: capabilityMap('40000000-0000-4000-a000-000000000099'),
    };
    await expect(
      service.update({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        providerConfigId: created.value.provider_config_id,
        request: missingPricePatch,
      }),
    ).resolves.toEqual({ ok: false, code: 'pricing_invalid' });

    await expect(
      service.disable({
        accountId: ACCOUNT_ID,
        projectId: '20000000-0000-4000-a000-000000000099',
        providerConfigId: created.value.provider_config_id,
      }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });
    const disabled = await service.disable({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      providerConfigId: created.value.provider_config_id,
    });
    const replay = await service.disable({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      providerConfigId: created.value.provider_config_id,
    });
    expect(disabled).toMatchObject({ ok: true, value: { enabled: false } });
    expect(replay).toEqual(disabled);
  });
});

describe('Studio provider management routes', () => {
  async function createApp(denyManage = false) {
    const repository = createMemoryStudioRepository();
    const pricing = await createPricing(repository);
    let writes = 0;
    const createProviderConfig = repository.createProviderConfig.bind(repository);
    repository.createProviderConfig = async (...input) => {
      writes += 1;
      return createProviderConfig(...input);
    };
    let originChecks = 0;
    const validateOrigin = originValidator();
    const service = new StudioProviderConfigService(repository, {
      validateOrigin: async (url) => {
        originChecks += 1;
        return validateOrigin(url);
      },
    });
    const assertedActions: string[] = [];
    const routes = createStudioProjectRoutes({
      repository,
      providerConfigService: service,
      loadProjectForUser: async (_c, projectId) =>
        projectId === PROJECT_ID
          ? { row: { accountId: ACCOUNT_ID, projectId }, userId: ACTOR_USER_ID }
          : null,
      assertProjectCapability: async (_c, _userId, _accountId, _projectId, action) => {
        assertedActions.push(action);
        if (denyManage && action === PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE) {
          throw new HTTPException(403, { message: 'denied' });
        }
      },
      estimateSigningSecret: 'studio-provider-route-test-secret',
    });
    const app = new Hono();
    app.route('/v1/projects', routes);
    app.onError((error, c) =>
      error instanceof HTTPException
        ? c.json({ error: error.message }, error.status)
        : c.json({ error: 'internal' }, 500),
    );
    return {
      app,
      pricingCatalogId: pricing.pricing_catalog_id,
      assertedActions,
      writes: () => writes,
      originChecks: () => originChecks,
    };
  }

  test('requires providers.manage for create, patch, and soft delete', async () => {
    const { app, pricingCatalogId, assertedActions } = await createApp();
    const create = await app.request(`/v1/projects/${PROJECT_ID}/studio/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerRequest(pricingCatalogId)),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      provider_config_id: string;
      account_id?: string;
      capability_map?: unknown;
    };
    expect(created.account_id).toBeUndefined();
    expect(created.capability_map).toBeUndefined();

    const list = await app.request(`/v1/projects/${PROJECT_ID}/studio/providers`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [
        {
          provider_config_id: created.provider_config_id,
          capabilities: ['image.generate'],
        },
      ],
    });

    const patch = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/providers/${created.provider_config_id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Patched provider' }),
      },
    );
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ display_name: 'Patched provider' });

    const disabled = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/providers/${created.provider_config_id}`,
      { method: 'DELETE' },
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: false });
    expect(assertedActions).toEqual([
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE,
    ]);
  });

  test('performs no origin, pricing, or provider write after providers.manage denial', async () => {
    const { app, pricingCatalogId, writes, originChecks } = await createApp(true);
    const response = await app.request(`/v1/projects/${PROJECT_ID}/studio/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerRequest(pricingCatalogId)),
    });
    expect(response.status).toBe(403);
    expect(originChecks()).toBe(0);
    expect(writes()).toBe(0);
  });

  test('assembles provider policy once and mounts pricing inside the authenticated account router', () => {
    const defaultRoutes = readFileSync(new URL('./default-routes.ts', import.meta.url), 'utf8');
    expect(defaultRoutes).toContain('createStudioProviderOriginValidator');
    expect(defaultRoutes).toContain('new StudioProviderConfigService');
    expect(defaultRoutes).toContain('providerConfigService');

    const defaultAccountRoutes = readFileSync(
      new URL('./default-account-routes.ts', import.meta.url),
      'utf8',
    );
    expect(defaultAccountRoutes).toContain('createDefaultStudioAccountRoutes');
    expect(defaultAccountRoutes).not.toContain("from '../config'");
    expect(defaultAccountRoutes).not.toContain('@kortix/studio-adapters');

    const accountsIndex = readFileSync(new URL('../accounts/index.ts', import.meta.url), 'utf8');
    expect(accountsIndex).not.toContain('../studio/default-routes');
    const studioMount = accountsIndex.indexOf('createDefaultStudioAccountRoutes()');
    const parameterizedRoutes = accountsIndex.indexOf('registerAccountRoutes()');
    expect(studioMount).toBeGreaterThan(-1);
    expect(studioMount).toBeLessThan(parameterizedRoutes);
  });
});
