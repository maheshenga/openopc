import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, studioProviderConfigs } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { StudioPricingService } from './pricing';
import { StudioProviderConfigService, createStudioProviderOriginValidator } from './providers';
import { createDrizzleStudioRepository } from './repositories/drizzle';

const dockerEnvironment = { ...process.env };
if (dockerEnvironment.DOCKER_HOST?.startsWith('encrypted:')) {
  delete dockerEnvironment.DOCKER_HOST;
}
const integrationEnabled = process.env.STUDIO_POSTGRES_INTEGRATION === '1';
const dockerAvailable =
  integrationEnabled &&
  Bun.spawnSync(['docker', 'version'], {
    env: dockerEnvironment,
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;
const container = `kortix-studio-management-${crypto.randomUUID().slice(0, 8)}`;
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const ACTOR_USER_ID = '30000000-0000-4000-a000-000000000001';

let database: ReturnType<typeof createDb> | null = null;

function dockerPsql(sql: string) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { env: dockerEnvironment, stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`${result.stdout.toString()}${result.stderr.toString()}`);
  }
}

function removeContainer() {
  Bun.spawnSync(['docker', 'rm', '-f', container], {
    env: dockerEnvironment,
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

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

describe.skipIf(!dockerAvailable)('Studio management - real PostgreSQL', () => {
  beforeAll(async () => {
    try {
      const started = Bun.spawnSync(
        [
          'docker',
          'run',
          '-d',
          '--rm',
          '--name',
          container,
          '-e',
          'POSTGRES_PASSWORD=test',
          '-e',
          'POSTGRES_DB=testdb',
          '-p',
          '127.0.0.1::5432',
          'postgres:16-alpine',
        ],
        { env: dockerEnvironment, stdout: 'pipe', stderr: 'pipe' },
      );
      if (started.exitCode !== 0) throw new Error(started.stderr.toString());

      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const logs = Bun.spawnSync(['docker', 'logs', container], {
          env: dockerEnvironment,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const initComplete = `${logs.stdout.toString()}${logs.stderr.toString()}`.includes(
          'PostgreSQL init process complete; ready for start up',
        );
        if (!initComplete) {
          await Bun.sleep(250);
          continue;
        }
        const probe = Bun.spawnSync(
          [
            'docker',
            'exec',
            container,
            'psql',
            '-X',
            '-U',
            'postgres',
            '-d',
            'testdb',
            '-c',
            'SELECT 1',
          ],
          { env: dockerEnvironment, stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) {
          ready = true;
          break;
        }
        await Bun.sleep(250);
      }
      if (!ready) throw new Error('PostgreSQL management fixture did not become ready');

      dockerPsql(`
      CREATE SCHEMA kortix;
      CREATE TABLE kortix.accounts (account_id uuid PRIMARY KEY);
      CREATE TABLE kortix.projects (
        project_id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES kortix.accounts(account_id)
      );
      CREATE TABLE kortix.studio_pricing_catalog (
        pricing_catalog_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
        provider text NOT NULL,
        model text NOT NULL,
        unit text NOT NULL,
        rate_data jsonb NOT NULL,
        maximum_cost_rule jsonb NOT NULL,
        markup_rule jsonb NOT NULL,
        version integer NOT NULL,
        active boolean NOT NULL DEFAULT true,
        created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (account_id, provider, model, version)
      );
      CREATE TABLE kortix.studio_provider_configs (
        provider_config_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
        project_id uuid NOT NULL REFERENCES kortix.projects(project_id),
        provider text NOT NULL,
        display_name text NOT NULL,
        base_url text,
        region text,
        credential_binding jsonb NOT NULL DEFAULT '{}'::jsonb,
        capability_map jsonb NOT NULL DEFAULT '{}'::jsonb,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_ID}'), ('${OTHER_ACCOUNT_ID}');
      INSERT INTO kortix.projects(project_id, account_id)
      VALUES ('${PROJECT_ID}', '${ACCOUNT_ID}'), ('${OTHER_PROJECT_ID}', '${OTHER_ACCOUNT_ID}');
    `);

      const portResult = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
        env: dockerEnvironment,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const mappedPort = portResult.stdout
        .toString()
        .trim()
        .match(/:(\d+)$/)?.[1];
      if (!mappedPort) throw new Error('PostgreSQL management fixture has no mapped port');
      database = createDb(`postgres://postgres:test@127.0.0.1:${mappedPort}/testdb`, { max: 4 });
    } catch (error) {
      removeContainer();
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    try {
      const client = (
        database as unknown as {
          $client?: { end(options?: unknown): Promise<void> };
        }
      )?.$client;
      if (client) await client.end({ timeout: 1 });
    } finally {
      removeContainer();
    }
  }, 30_000);

  test('keeps pricing versions and provider mutations atomic and tenant-scoped', async () => {
    if (!database) throw new Error('database fixture is unavailable');
    const repository = createDrizzleStudioRepository(database);
    const pricingService = new StudioPricingService(repository);
    const pricingRequest = {
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      unit: 'image' as const,
      rate_data: { rate_credits: 1 },
      maximum_cost_rule: { max_provider_credits: 8 },
      markup_rule: { markup_credits: 0.25 },
    };
    const versions = await Promise.all([
      pricingService.create({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        request: pricingRequest,
      }),
      pricingService.create({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        request: pricingRequest,
      }),
    ]);
    expect(
      versions
        .map((result) => (result.ok ? result.value.version : -1))
        .sort((left, right) => left - right),
    ).toEqual([1, 2]);
    const activePrice = versions.find((result) => result.ok && result.value.version === 2);
    if (!activePrice?.ok) throw new Error('expected active pricing version');

    const providerService = new StudioProviderConfigService(repository, {
      validateOrigin: createStudioProviderOriginValidator({
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        allowPrivateOrigins: new Set(),
        allowInsecureLocalEndpoints: false,
      }),
    });
    const crossAccountProject = await repository.createProviderConfig(
      {
        account_id: ACCOUNT_ID,
        project_id: OTHER_PROJECT_ID,
        provider: 'openai-compatible',
        display_name: 'must-not-create',
        base_url: 'https://api.example.com/',
        region: null,
        credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
        capability_map: capabilityMap(activePrice.value.pricing_catalog_id),
        enabled: true,
      },
      [
        {
          pricing_catalog_id: activePrice.value.pricing_catalog_id,
          provider: 'openai-compatible',
          model: 'gpt-image-1',
        },
      ],
    );
    expect(crossAccountProject).toEqual({ ok: false, code: 'not_found' });

    const created = await providerService.create({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      request: {
        provider: 'openai-compatible',
        display_name: 'PostgreSQL provider',
        base_url: 'https://api.example.com',
        region: null,
        credential_binding: { kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' },
        capability_map: capabilityMap(activePrice.value.pricing_catalog_id),
        enabled: true,
      },
    });
    if (!created.ok) throw new Error(`provider create failed: ${created.code}`);
    const loaded = await repository.getProviderConfigRecord(
      ACCOUNT_ID,
      PROJECT_ID,
      created.value.provider_config_id,
    );
    if (!loaded) throw new Error('expected provider configuration to load');
    expect(loaded.version_token).toMatch(/^[0-9a-f]{32}$/);

    const updated = await providerService.update({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      providerConfigId: created.value.provider_config_id,
      request: { display_name: 'PostgreSQL provider v2' },
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { display_name: 'PostgreSQL provider v2' },
    });
    const renamed = await repository.getProviderConfigRecord(
      ACCOUNT_ID,
      PROJECT_ID,
      created.value.provider_config_id,
    );
    if (!renamed) throw new Error('expected renamed provider configuration to load');
    expect(renamed.version_token).toBe(loaded.version_token);
    const operationalUpdate = await repository.updateProviderConfig(
      {
        account_id: loaded.account_id,
        project_id: loaded.project_id,
        provider_config_id: loaded.provider_config_id,
        provider: loaded.provider,
        display_name: loaded.display_name,
        base_url: 'https://api-v2.example.com/',
        region: loaded.region,
        credential_binding: loaded.credential_binding,
        capability_map: loaded.capability_map,
        enabled: loaded.enabled,
        created_at: loaded.created_at,
      },
      loaded.version_token,
      [
        {
          pricing_catalog_id: activePrice.value.pricing_catalog_id,
          provider: 'openai-compatible',
          model: 'gpt-image-1',
        },
      ],
      { base_url: 'https://api-v2.example.com/' },
    );
    expect(operationalUpdate).toMatchObject({
      ok: true,
      value: {
        display_name: 'PostgreSQL provider v2',
        base_url: 'https://api-v2.example.com/',
      },
    });

    await pricingService.deactivate({
      accountId: ACCOUNT_ID,
      pricingCatalogId: activePrice.value.pricing_catalog_id,
    });
    const rejectedUpdate = await providerService.update({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      providerConfigId: created.value.provider_config_id,
      request: { display_name: 'must-not-commit' },
    });
    expect(rejectedUpdate).toEqual({ ok: false, code: 'pricing_invalid' });
    const unchanged = await repository.getProviderConfigRecord(
      ACCOUNT_ID,
      PROJECT_ID,
      created.value.provider_config_id,
    );
    expect(unchanged?.display_name).toBe('PostgreSQL provider v2');

    await expect(
      providerService.disable({
        accountId: OTHER_ACCOUNT_ID,
        projectId: OTHER_PROJECT_ID,
        providerConfigId: created.value.provider_config_id,
      }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });
    const disabled = await providerService.disable({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      providerConfigId: created.value.provider_config_id,
    });
    const replay = await providerService.disable({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      providerConfigId: created.value.provider_config_id,
    });
    expect(disabled).toMatchObject({ ok: true, value: { enabled: false } });
    expect(replay).toEqual(disabled);
  }, 30_000);

  test('fails closed without disabling legacy fake provider rows', async () => {
    if (!database) throw new Error('database fixture is unavailable');
    const providerConfigId = '50000000-0000-4000-a000-000000000099';
    await database.insert(studioProviderConfigs).values({
      providerConfigId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      provider: 'fake',
      displayName: 'Legacy fake provider',
      baseUrl: null,
      region: null,
      credentialBinding: { kind: 'none' },
      capabilityMap: { capabilities: ['image.generate'] },
      enabled: true,
    });

    const repository = createDrizzleStudioRepository(database);
    const providerService = new StudioProviderConfigService(repository, {
      validateOrigin: createStudioProviderOriginValidator({
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        allowPrivateOrigins: new Set(),
        allowInsecureLocalEndpoints: false,
      }),
    });

    await expect(
      providerService.disable({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        providerConfigId,
      }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });

    const [fakeProvider] = await database
      .select({ enabled: studioProviderConfigs.enabled })
      .from(studioProviderConfigs)
      .where(
        and(
          eq(studioProviderConfigs.accountId, ACCOUNT_ID),
          eq(studioProviderConfigs.projectId, PROJECT_ID),
          eq(studioProviderConfigs.providerConfigId, providerConfigId),
        ),
      );
    expect(fakeProvider).toEqual({ enabled: true });
  }, 30_000);
});
