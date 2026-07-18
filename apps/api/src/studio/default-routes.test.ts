import { describe, expect, mock, test } from 'bun:test';
import type { StudioRecoveryResponse } from '@kortix/api-contract';
import { InMemoryStudioObjectStore, type StudioObjectStore } from '@kortix/studio-runtime';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { createInMemoryStudioTelemetrySink, createStudioTelemetry } from './metrics';

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  KORTIX_MARKUP: 1.2,
  PLATFORM_FEE_MARKUP: 0.1,
  config: { API_KEY_SECRET: 'test-signing-secret' },
}));
mock.module('../shared/db', () => ({ db: {}, hasDatabase: false }));
mock.module('../projects/lib/access', () => ({
  loadProjectForUser: async (_context: unknown, projectId: string) => ({
    row: { accountId: ACCOUNT_ID, projectId },
    userId: USER_ID,
  }),
  assertProjectCapability: async () => {},
}));
mock.module('../iam/dispatcher', () => ({ assertAuthorized: async () => {} }));

const {
  buildStudioApiRuntime,
  closeDefaultStudioApiRuntime,
  createDefaultIntelligenceProjectRoutes,
  createDefaultStudioProjectRoutes,
  getDefaultStudioApiRuntime,
} = await import('./default-routes');
const { createMemoryStudioRepository } = await import('./repositories/memory');

const ACCOUNT_ID = '91000000-0000-4000-a000-000000000001';
const PROJECT_ID = '92000000-0000-4000-a000-000000000001';
const USER_ID = '93000000-0000-4000-a000-000000000001';
const JOB_ID = '94000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '95000000-0000-4000-a000-000000000001';
const RECOVERY_ID = '96000000-0000-4000-a000-000000000001';
const FAKE_PROVIDER_ID = '97000000-0000-4000-a000-000000000001';
const PRICE_ID = '99000000-0000-4000-a000-000000000001';

const imageInput = {
  capability: 'image.generate' as const,
  image: {
    prompt: 'A production runtime wiring test',
    reference_asset_ids: [],
    aspect_ratio: '1:1' as const,
    quality: 'standard' as const,
    output_count: 1,
  },
};

const fakeProvider = {
  provider_config_id: FAKE_PROVIDER_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  provider: 'fake' as const,
  display_name: 'Legacy fake provider',
  base_url: null,
  region: null,
  credential_binding: { kind: 'none' as const },
  capabilities: ['image.generate' as const],
  enabled: true,
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-17T00:00:00.000Z',
};

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

function enabledEnv(input: { fake: boolean; openai: boolean }) {
  return {
    NODE_ENV: 'test',
    STUDIO_ENABLED: 'true',
    STUDIO_FAKE_PROVIDER_ENABLED: String(input.fake),
    STUDIO_OPENAI_COMPATIBLE_ENABLED: String(input.openai),
    STUDIO_OBJECT_STORE_MODE: 'memory',
    STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
  };
}

function buildRuntimeWithObjectStore(
  env: Record<string, string>,
  store: StudioObjectStore,
  telemetry?: ReturnType<typeof createStudioTelemetry>,
) {
  const build = buildStudioApiRuntime as unknown as (
    input: Record<string, string>,
    options: {
      createObjectStore: () => StudioObjectStore;
      telemetry?: ReturnType<typeof createStudioTelemetry>;
    },
  ) => ReturnType<typeof buildStudioApiRuntime>;
  return build(env, {
    createObjectStore: () => store,
    ...(telemetry ? { telemetry } : {}),
  });
}

async function createOpenAiRepository(
  binding: { kind: 'secret'; identifier: string } | { kind: 'connector'; slug: string },
) {
  const repository = createMemoryStudioRepository({
    pricing: [
      {
        pricing_catalog_id: PRICE_ID,
        account_id: ACCOUNT_ID,
        provider: 'openai-compatible',
        model: 'gpt-image-1',
        unit: 'image',
        rate_data: { rate_credits: 2 },
        maximum_cost_rule: { max_provider_credits: 8 },
        markup_rule: { markup_credits: 0.25 },
        version: 1,
        active: true,
        created_by_user_id: USER_ID,
        created_at: '2026-07-17T00:00:00.000Z',
      },
    ],
  });
  const created = await repository.createProviderConfig(
    {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      provider: 'openai-compatible',
      display_name: 'Production OpenAI-compatible provider',
      base_url: 'https://images.example.test/v1',
      region: null,
      credential_binding: binding,
      capability_map: capabilityMap,
      enabled: true,
    },
    [{ pricing_catalog_id: PRICE_ID, provider: 'openai-compatible', model: 'gpt-image-1' }],
  );
  if (!created.ok) throw new Error('OpenAI-compatible fixture failed');
  return { repository, providerId: created.value.provider_config_id };
}

function mountDefaultRoutes(input: Record<string, unknown>) {
  const routes = (
    createDefaultStudioProjectRoutes as unknown as (input: Record<string, unknown>) => Hono
  )(input);
  const app = new Hono();
  app.route('/v1/projects', routes);
  return app;
}

function mountDefaultIntelligenceRoutes(input: Record<string, unknown>) {
  const routes = (
    createDefaultIntelligenceProjectRoutes as unknown as (input: Record<string, unknown>) => Hono
  )(input);
  const app = new Hono();
  app.route('/v1/projects', routes);
  return app;
}

function defaultRouteInput(input: Record<string, unknown>) {
  return {
    loadProjectForUser: async (_context: unknown, projectId: string) => ({
      row: { accountId: ACCOUNT_ID, projectId },
      userId: USER_ID,
    }),
    assertProjectCapability: async () => {},
    assertAccountCapability: async () => {},
    ...input,
  };
}

async function estimate(app: Hono, providerConfigId: string) {
  return app.request(`/v1/projects/${PROJECT_ID}/studio/estimates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability: 'image.generate',
      provider_config_id: providerConfigId,
      model: providerConfigId === FAKE_PROVIDER_ID ? 'fake/image-v1' : 'gpt-image-1',
      input: imageInput,
    }),
  });
}

describe('Studio API runtime assembly', () => {
  test('keeps Studio disabled without adapter configuration', () => {
    const telemetry = new Proxy(
      {},
      {
        get() {
          throw new Error('disabled runtime must not inspect telemetry');
        },
      },
    );
    expect(
      buildStudioApiRuntime({
        STUDIO_ENABLED: 'false',
        STUDIO_OBJECT_STORE_MODE: 'broken',
        STUDIO_S3_SECRET_ACCESS_KEY: 'must-not-be-validated',
      }, { telemetry: telemetry as never }),
    ).toEqual({ enabled: false });
  });

  test('does not construct an object store while Studio is disabled', () => {
    let factoryCalls = 0;

    expect(
      buildStudioApiRuntime(
        { STUDIO_ENABLED: 'false' },
        {
          createObjectStore: () => {
            factoryCalls += 1;
            throw new Error('disabled Studio must not create an object store');
          },
        },
      ),
    ).toEqual({ enabled: false });
    expect(factoryCalls).toBe(0);
  });

  test('retains injected telemetry and records API storage readiness', async () => {
    const sink = createInMemoryStudioTelemetrySink();
    const telemetry = createStudioTelemetry(sink);
    const store = new InMemoryStudioObjectStore({ namespace: 'api-telemetry', ready: false });
    const runtime = buildRuntimeWithObjectStore(
      enabledEnv({ fake: true, openai: false }),
      store,
      telemetry,
    );

    expect(runtime).toMatchObject({ enabled: true, telemetry });
    if (!runtime.enabled) throw new Error('expected enabled Studio API runtime');
    await expect(runtime.assertReadyBeforeReservation()).rejects.toThrow();
    expect(sink.emissions).toContainEqual({
      kind: 'gauge',
      name: 'studio_storage_readiness',
      value: 0,
      labels: { role: 'api' },
    });
  });

  test('uses the same ephemeral storage policy as the worker runtime', () => {
    expect(
      buildStudioApiRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toMatchObject({ enabled: true, storageMode: 'memory', fakeProviderEnabled: true });

    expect(() =>
      buildStudioApiRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toThrow(/STUDIO_OPENAI_COMPATIBLE_ENABLED/);
  });

  test('owns an injected store and waits for exactly one close', async () => {
    const store = new InMemoryStudioObjectStore({
      namespace: 'api-runtime',
      ready: true,
    }) as InMemoryStudioObjectStore & { destroy(): Promise<void> };
    let destroyCalls = 0;
    let releaseDestroy: (() => void) | undefined;
    const destroyPending = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    store.destroy = () => {
      destroyCalls += 1;
      return destroyPending;
    };

    const runtime = buildRuntimeWithObjectStore(enabledEnv({ fake: true, openai: false }), store);

    expect(runtime).toMatchObject({ enabled: true, store });
    if (!runtime.enabled) throw new Error('expected enabled Studio API runtime');
    let closeSettled = false;
    const close = runtime.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect({ destroyCalls, closeSettled }).toEqual({ destroyCalls: 1, closeSettled: false });
    releaseDestroy?.();
    await close;
    await runtime.close();
    expect(destroyCalls).toBe(1);
  });

  test('retains the default store across route assembly and closes it once', async () => {
    const store = new InMemoryStudioObjectStore({
      namespace: 'api-default-runtime',
      ready: true,
    }) as InMemoryStudioObjectStore & { destroy(): Promise<void> };
    let factoryCalls = 0;
    let destroyCalls = 0;
    let releaseDestroy: (() => void) | undefined;
    const destroyPending = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    store.destroy = () => {
      destroyCalls += 1;
      return destroyPending;
    };

    const runtime = getDefaultStudioApiRuntime(enabledEnv({ fake: true, openai: false }), {
      createObjectStore: () => {
        factoryCalls += 1;
        return store;
      },
    });

    expect(runtime).toMatchObject({ enabled: true, store });
    expect(
      getDefaultStudioApiRuntime(enabledEnv({ fake: true, openai: false }), {
        createObjectStore: () => {
          factoryCalls += 1;
          return new InMemoryStudioObjectStore({ namespace: 'must-not-be-created', ready: true });
        },
      }),
    ).toBe(runtime);
    createDefaultStudioProjectRoutes();
    createDefaultStudioProjectRoutes();
    createDefaultIntelligenceProjectRoutes();
    expect(factoryCalls).toBe(1);

    const runtimeEnvKeys = [
      'STUDIO_ENABLED',
      'STUDIO_OBJECT_STORE_MODE',
      'STUDIO_ALLOW_EPHEMERAL_STORAGE',
    ] as const;
    const previousRuntimeEnv = Object.fromEntries(
      runtimeEnvKeys.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      STUDIO_ENABLED: 'true',
      STUDIO_OBJECT_STORE_MODE: 'broken',
      STUDIO_ALLOW_EPHEMERAL_STORAGE: 'false',
    });
    try {
      expect(() =>
        createDefaultIntelligenceProjectRoutes({
          capabilityRegistry: { list: async () => [] },
          taskExecutor: {
            create: async () => ({ taskId: JOB_ID, jobId: JOB_ID, created: true }),
          },
        }),
      ).not.toThrow();
    } finally {
      for (const key of runtimeEnvKeys) {
        const value = previousRuntimeEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(factoryCalls).toBe(1);

    let closeSettled = false;
    const close = closeDefaultStudioApiRuntime().then(() => {
      closeSettled = true;
    });
    const duplicateClose = closeDefaultStudioApiRuntime();
    await Promise.resolve();
    expect({ destroyCalls, closeSettled }).toEqual({ destroyCalls: 1, closeSettled: false });
    releaseDestroy?.();
    await Promise.all([close, duplicateClose]);
    expect(destroyCalls).toBe(1);
  });

  test('uses the injected unready store before executable capabilities or job creation', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    let createJobCalls = 0;
    const originalCreateJob = repository.createJob.bind(repository);
    repository.createJob = async (...args) => {
      createJobCalls += 1;
      return originalCreateJob(...args);
    };
    const store = new InMemoryStudioObjectStore({ namespace: 'api-unready', ready: false });
    const runtime = buildRuntimeWithObjectStore(enabledEnv({ fake: true, openai: false }), store);
    const app = mountDefaultRoutes(
      defaultRouteInput({
        env: enabledEnv({ fake: true, openai: false }),
        repository,
        runtime,
      }),
    );

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
    expect((await estimate(app, FAKE_PROVIDER_ID)).status).toBe(503);
    const job = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(job.status).toBe(503);
    expect(createJobCalls).toBe(0);
    if (runtime.enabled) await runtime.close();
  });

  test('keeps disabled routes empty or unavailable without touching provider configuration', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    let providerReads = 0;
    const originalListProviders = repository.listProviders.bind(repository);
    repository.listProviders = async (...args) => {
      providerReads += 1;
      return originalListProviders(...args);
    };
    const app = mountDefaultRoutes(
      defaultRouteInput({ env: { STUDIO_ENABLED: 'false' }, repository }),
    );

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
    expect((await estimate(app, FAKE_PROVIDER_ID)).status).toBe(503);
    expect(
      (
        await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/recovery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'confirm_not_created',
            idempotency_key: 'disabled-runtime-recovery-0001',
            reason: 'Provider confirms no upstream request was created.',
            evidence: {},
          }),
        })
      ).status,
    ).toBe(503);
    expect(providerReads).toBe(0);
  });

  test('keeps disabled intelligence discovery empty without reading providers', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    let providerReads = 0;
    const originalListProviders = repository.listProviders.bind(repository);
    repository.listProviders = async (...args) => {
      providerReads += 1;
      return originalListProviders(...args);
    };
    const app = mountDefaultIntelligenceRoutes({
      runtime: { enabled: false },
      repository,
      loadProjectForUser: async (_context: unknown, projectId: string) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: USER_ID,
      }),
      assertProjectCapability: async () => {},
    });

    const response = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
    });
    expect(providerReads).toBe(0);
  });

  test('keeps unready intelligence discovery empty without reading providers', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    let providerReads = 0;
    const originalListProviders = repository.listProviders.bind(repository);
    repository.listProviders = async (...args) => {
      providerReads += 1;
      return originalListProviders(...args);
    };
    const store = new InMemoryStudioObjectStore({
      namespace: 'intelligence-unready',
      ready: false,
    });
    const runtime = buildRuntimeWithObjectStore(enabledEnv({ fake: true, openai: false }), store);
    const app = mountDefaultIntelligenceRoutes({
      runtime,
      repository,
      loadProjectForUser: async (_context: unknown, projectId: string) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: USER_ID,
      }),
      assertProjectCapability: async () => {},
    });

    const response = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
    });
    expect(providerReads).toBe(0);
    if (runtime.enabled) await runtime.close();
  });

  test('assembles a stable Agent Card from ready fake Studio capabilities', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    const store = new InMemoryStudioObjectStore({ namespace: 'intelligence-ready', ready: true });
    const runtime = buildRuntimeWithObjectStore(enabledEnv({ fake: true, openai: false }), store);
    const app = mountDefaultIntelligenceRoutes({
      runtime,
      repository,
      loadProjectForUser: async (_context: unknown, projectId: string) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: USER_ID,
      }),
      assertProjectCapability: async () => {},
    });

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`);
    expect(capabilities.status).toBe(200);
    expect((await capabilities.json()).items).toMatchObject([
      { id: 'studio.image.generate', modality: 'image' },
    ]);

    const card = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/agent-card`);
    expect(card.status).toBe(200);
    const cardBody = await card.text();
    expect(JSON.parse(cardBody)).toMatchObject({
      id: 'kortix-studio',
      display_name: 'Kortix Studio',
      capabilities: ['studio.image.generate'],
      protocols: ['a2a', 'mcp'],
      trust_tier: 'project',
    });
    expect(cardBody).not.toContain('secret');
    expect(cardBody).not.toContain('base_url');
    expect(cardBody).not.toContain('signed_url');
    if (runtime.enabled) await runtime.close();
  });

  test('keeps default intelligence task execution unavailable without touching providers', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    let providerReads = 0;
    const originalListProviders = repository.listProviders.bind(repository);
    repository.listProviders = async (...args) => {
      providerReads += 1;
      return originalListProviders(...args);
    };
    const app = mountDefaultIntelligenceRoutes({
      runtime: { enabled: false },
      repository,
      loadProjectForUser: async (_context: unknown, projectId: string) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: USER_ID,
      }),
      assertProjectCapability: async () => {},
    });

    const task = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol_version: 'intelligence.v1',
        capability_id: 'studio.image.generate',
        agent_card_hash: '0'.repeat(64),
        provider_config_id: FAKE_PROVIDER_ID,
        model: 'fake/image-v1',
        input: imageInput,
        idempotency_key: 'default-intelligence-task-0001',
        parent_task_id: null,
        deadline_at: null,
      }),
    });
    expect(task.status).toBe(503);
    expect(await task.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
    });

    const events = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${JOB_ID}/events`,
    );
    expect(events.status).toBe(503);
    expect(await events.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
    });
    expect(providerReads).toBe(0);
  });

  test('filters persisted fake providers from capabilities, estimates, and jobs when fake is disabled', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    let createJobCalls = 0;
    const originalCreateJob = repository.createJob.bind(repository);
    repository.createJob = async (...args) => {
      createJobCalls += 1;
      return originalCreateJob(...args);
    };
    const enabledApp = mountDefaultRoutes(
      defaultRouteInput({ env: enabledEnv({ fake: true, openai: false }), repository }),
    );
    const enabledEstimate = await estimate(enabledApp, FAKE_PROVIDER_ID);
    expect(enabledEstimate.status).toBe(200);
    const estimateBody = (await enabledEstimate.json()) as Record<string, unknown>;

    const disabledApp = mountDefaultRoutes(
      defaultRouteInput({ env: enabledEnv({ fake: false, openai: true }), repository }),
    );
    const capabilities = await disabledApp.request(
      `/v1/projects/${PROJECT_ID}/studio/capabilities`,
    );
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
    expect((await estimate(disabledApp, FAKE_PROVIDER_ID)).status).toBe(404);

    const job = await disabledApp.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'image.generate',
        provider_config_id: FAKE_PROVIDER_ID,
        model: 'fake/image-v1',
        input: imageInput,
        estimate_id: estimateBody.estimate_id,
        estimate_token: estimateBody.estimate_token,
        idempotency_key: 'fake-disabled-job-request-0001',
        request_hash: estimateBody.input_hash,
      }),
    });
    expect(job.status).toBe(404);
    expect(createJobCalls).toBe(0);
  });

  test('filters persisted OpenAI-compatible providers when the production provider is disabled', async () => {
    const { repository, providerId } = await createOpenAiRepository({
      kind: 'secret',
      identifier: 'OPENAI_STUDIO_KEY',
    });
    let createJobCalls = 0;
    const originalCreateJob = repository.createJob.bind(repository);
    repository.createJob = async (...args) => {
      createJobCalls += 1;
      return originalCreateJob(...args);
    };
    const credentialBindingExists = async () => true;
    const enabledApp = mountDefaultRoutes(
      defaultRouteInput({
        env: enabledEnv({ fake: false, openai: true }),
        repository,
        credentialBindingExists,
      }),
    );
    const enabledEstimate = await estimate(enabledApp, providerId);
    expect(enabledEstimate.status).toBe(200);
    const estimateBody = (await enabledEstimate.json()) as Record<string, unknown>;

    const app = mountDefaultRoutes(
      defaultRouteInput({ env: enabledEnv({ fake: true, openai: false }), repository }),
    );

    const capabilities = await app.request(`/v1/projects/${PROJECT_ID}/studio/capabilities`);
    expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
    expect((await estimate(app, providerId)).status).toBe(404);

    const job = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'image.generate',
        provider_config_id: providerId,
        model: 'gpt-image-1',
        input: imageInput,
        estimate_id: estimateBody.estimate_id,
        estimate_token: estimateBody.estimate_token,
        idempotency_key: 'openai-disabled-job-request-0001',
        request_hash: estimateBody.input_hash,
      }),
    });
    expect(job.status).toBe(404);
    expect(createJobCalls).toBe(0);
  });

  test('checks Secret and Connector bindings by account and project without selecting ciphertext', async () => {
    for (const testCase of [
      {
        binding: { kind: 'secret' as const, identifier: 'OPENAI_STUDIO_KEY' },
        requiredSql: ['project_secrets', 'project.account_id', 'secret.project_id'],
      },
      {
        binding: { kind: 'connector' as const, slug: 'studio-images' },
        requiredSql: [
          'executor_connectors',
          'executor_connection_profiles',
          'executor_credentials',
        ],
      },
    ]) {
      const { repository, providerId } = await createOpenAiRepository(testCase.binding);
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const database = {
        execute: async (query: unknown) => {
          const compiled = new PgDialect().sqlToQuery(query as never);
          queries.push({ sql: compiled.sql.toLowerCase(), params: [...compiled.params] });
          return [{ credential_exists: true }];
        },
      };
      const app = mountDefaultRoutes(
        defaultRouteInput({
          env: enabledEnv({ fake: false, openai: true }),
          repository,
          database,
        }),
      );

      const response = await estimate(app, providerId);
      expect(response.status).toBe(200);
      expect(queries).toHaveLength(1);
      for (const fragment of testCase.requiredSql) expect(queries[0].sql).toContain(fragment);
      expect(queries[0].params).toContain(ACCOUNT_ID);
      expect(queries[0].params).toContain(PROJECT_ID);
      expect(queries[0].sql).not.toMatch(/select\s+(secret|credential)\.value_enc/);
    }
  });

  test('assembles recovery with the enabled runtime repository and object store', async () => {
    const repository = createMemoryStudioRepository({ providers: [fakeProvider] });
    const response: StudioRecoveryResponse = {
      recovery_id: RECOVERY_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      decision: 'confirm_not_created',
      job_status: 'failed',
      attempt_status: 'failed',
      reservation_status: 'released',
      hold_expires_at: null,
    };
    const recoveryCalls: unknown[] = [];
    const recoveryRepository = {
      recoverLocked: async (input: unknown) => {
        recoveryCalls.push(input);
        return response;
      },
    };
    const app = mountDefaultRoutes(
      defaultRouteInput({
        env: enabledEnv({ fake: true, openai: false }),
        repository,
        recoveryRepository,
      }),
    );

    const result = await app.request(`/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'confirm_not_created',
        idempotency_key: 'production-recovery-wiring-0001',
        reason: 'Provider confirms no upstream request was created.',
        evidence: {},
      }),
    });

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(response);
    expect(recoveryCalls).toHaveLength(1);
  });
});
