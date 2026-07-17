import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, studioAssetUploads, studioAssets, studioProviderConfigs } from '@kortix/db';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { StudioPricingService } from './pricing';
import { StudioProviderConfigService, createStudioProviderOriginValidator } from './providers';
import { createDrizzleStudioRepository } from './repositories/drizzle';
import { StudioStorageService } from './storage';

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
if (integrationEnabled && !dockerAvailable) {
  throw new Error('STUDIO_POSTGRES_INTEGRATION=1 requires an available Docker daemon');
}
const container = `kortix-studio-management-${crypto.randomUUID().slice(0, 8)}`;
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const ACTOR_USER_ID = '30000000-0000-4000-a000-000000000001';
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const PNG_CHECKSUM = new Bun.CryptoHasher('sha256').update(PNG).digest('hex');

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

async function dockerPsqlScalar(query: string): Promise<string> {
  const proc = Bun.spawn(
    [
      'docker',
      'exec',
      container,
      'psql',
      '-X',
      '-A',
      '-t',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-c',
      query,
    ],
    { env: dockerEnvironment, stdout: 'pipe', stderr: 'pipe' },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`${stdout}${stderr}`);
  }
  return stdout.trim();
}

async function waitForPostgresCount(query: string, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (Number(await dockerPsqlScalar(query)) >= minimum) return;
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the expected PostgreSQL lock state');
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
      CREATE TABLE kortix.studio_assets (
        asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
        project_id uuid NOT NULL REFERENCES kortix.projects(project_id),
        creator_user_id uuid,
        source_job_id uuid,
        kind text NOT NULL,
        mime_type text NOT NULL,
        bucket text NOT NULL,
        object_key text NOT NULL,
        checksum_sha256 text NOT NULL,
        size_bytes bigint NOT NULL,
        width integer,
        height integer,
        duration_ms integer,
        frame_rate numeric(8,3),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        version_parent_asset_id uuid,
        visibility text NOT NULL DEFAULT 'project',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (bucket, object_key)
      );
      CREATE TABLE kortix.studio_asset_uploads (
        upload_id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
        project_id uuid NOT NULL REFERENCES kortix.projects(project_id),
        actor_user_id uuid,
        object_key text NOT NULL,
        declared_mime_type text NOT NULL,
        expected_size_bytes bigint NOT NULL,
        expected_checksum_sha256 text NOT NULL,
        expires_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        finalized_asset_id uuid REFERENCES kortix.studio_assets(asset_id),
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

  test('keeps failed finalize decisions tenant-scoped and side-effect free', async () => {
    if (!database) throw new Error('database fixture is unavailable');
    const repository = createDrizzleStudioRepository(database);
    const pendingUploadId = '50000000-0000-4000-a000-000000000086';
    const expiredUploadId = '50000000-0000-4000-a000-000000000087';
    const crossScopeUploadId = '50000000-0000-4000-a000-000000000085';
    const objectKey =
      `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}` + `/uploads/${pendingUploadId}/source.png`;
    const expiredObjectKey =
      `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}` + `/uploads/${expiredUploadId}/source.png`;
    let crossScopeError: unknown = null;
    try {
      await repository.createPendingUpload({
        account_id: OTHER_ACCOUNT_ID,
        project_id: PROJECT_ID,
        actor_user_id: ACTOR_USER_ID,
        upload_id: crossScopeUploadId,
        object_key:
          `accounts/${OTHER_ACCOUNT_ID}/projects/${PROJECT_ID}` +
          `/uploads/${crossScopeUploadId}/source.png`,
        declared_mime_type: 'image/png',
        expected_size_bytes: PNG.byteLength,
        expected_checksum_sha256: PNG_CHECKSUM,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    } catch (error) {
      crossScopeError = error;
    }
    expect(crossScopeError).toBeInstanceOf(Error);
    expect(
      await database
        .select({ uploadId: studioAssetUploads.uploadId })
        .from(studioAssetUploads)
        .where(eq(studioAssetUploads.uploadId, crossScopeUploadId)),
    ).toEqual([]);

    await repository.createPendingUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      upload_id: pendingUploadId,
      object_key: objectKey,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await repository.createPendingUpload({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      upload_id: expiredUploadId,
      object_key: expiredObjectKey,
      declared_mime_type: 'image/png',
      expected_size_bytes: PNG.byteLength,
      expected_checksum_sha256: PNG_CHECKSUM,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const finalizeInput = {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      upload_id: pendingUploadId,
      object_key: objectKey,
      bucket: 'private-studio',
      mime_type: 'image/png' as const,
      checksum_sha256: PNG_CHECKSUM,
      size_bytes: PNG.byteLength,
      width: 1,
      height: 1,
      metadata: {},
    };

    const crossAccount = await repository.finalizeUploadRecord({
      ...finalizeInput,
      account_id: OTHER_ACCOUNT_ID,
    });
    expect(crossAccount).toEqual({ outcome: 'not_found' });
    const crossProject = await repository.finalizeUploadRecord({
      ...finalizeInput,
      project_id: OTHER_PROJECT_ID,
    });
    expect(crossProject).toEqual({ outcome: 'not_found' });
    const mismatch = await repository.finalizeUploadRecord({
      ...finalizeInput,
      size_bytes: PNG.byteLength + 1,
    });
    expect(mismatch).toEqual({ outcome: 'mismatch' });
    const expired = await repository.finalizeUploadRecord({
      ...finalizeInput,
      upload_id: expiredUploadId,
      object_key: expiredObjectKey,
    });
    expect(expired).toEqual({ outcome: 'expired' });

    const persistedAssets = await database.select().from(studioAssets);
    const failedUploads = await database
      .select({ uploadId: studioAssetUploads.uploadId, status: studioAssetUploads.status })
      .from(studioAssetUploads)
      .where(
        sql`${studioAssetUploads.uploadId} IN (${pendingUploadId}::uuid, ${expiredUploadId}::uuid)`,
      )
      .orderBy(studioAssetUploads.uploadId);
    expect(persistedAssets).toEqual([]);
    expect(failedUploads).toEqual([
      { uploadId: pendingUploadId, status: 'pending' },
      { uploadId: expiredUploadId, status: 'pending' },
    ]);
  }, 30_000);

  test('finalizes one real upload atomically under concurrent replay', async () => {
    if (!database) throw new Error('database fixture is unavailable');
    const db = database;
    const repository = createDrizzleStudioRepository(db);
    const store = new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true });
    const uploadId = '50000000-0000-4000-a000-000000000088';
    const service = new StudioStorageService({
      repository,
      store,
      now: () => new Date(),
      randomUUID: () => uploadId,
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
      metadata: { project_id: PROJECT_ID },
    });

    const advisoryLock = 6_106_088;
    dockerPsql(`
      CREATE OR REPLACE FUNCTION kortix.test_block_studio_asset_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryLock});
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_block_studio_asset_insert
      BEFORE INSERT ON kortix.studio_assets
      FOR EACH ROW EXECUTE FUNCTION kortix.test_block_studio_asset_insert();
    `);

    let releaseBlocker = () => {};
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let markBlockerReady = () => {};
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryLock})`);
      markBlockerReady();
      await blockerRelease;
    });
    await blockerReady;

    const firstFinalize = service.finalizeUpload({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      uploadId,
    });
    let replayFinalize: ReturnType<typeof service.finalizeUpload> | null = null;
    let lockObservationError: unknown = null;
    try {
      await waitForPostgresCount(
        `SELECT count(*)
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND wait_event = 'advisory'
           AND query LIKE '%INSERT INTO kortix.studio_assets%'`,
        1,
      );
      replayFinalize = service.finalizeUpload({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        uploadId,
      });
      await waitForPostgresCount(
        `SELECT count(*)
         FROM pg_stat_activity waiting
         JOIN pg_stat_activity blocking
           ON blocking.pid = ANY(pg_blocking_pids(waiting.pid))
         WHERE waiting.datname = current_database()
           AND waiting.wait_event_type = 'Lock'
           AND waiting.query LIKE '%FOR UPDATE OF upload%'
           AND blocking.wait_event = 'advisory'`,
        1,
      );
    } catch (error) {
      lockObservationError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    if (lockObservationError) {
      await Promise.allSettled([firstFinalize, ...(replayFinalize ? [replayFinalize] : [])]);
      throw lockObservationError;
    }
    if (!replayFinalize) throw new Error('expected the replay finalize call to start');

    const [first, replay] = await Promise.all([firstFinalize, replayFinalize]);
    if (!first || !replay) throw new Error('expected both finalize calls to return an asset');
    const persistedAssets = await db.select().from(studioAssets);
    const [persistedUpload] = await db
      .select()
      .from(studioAssetUploads)
      .where(eq(studioAssetUploads.uploadId, uploadId));

    expect(replay.asset_id).toBe(first.asset_id);
    expect(persistedAssets).toHaveLength(1);
    expect(persistedAssets[0]).toMatchObject({
      assetId: first.asset_id,
      bucket: 'private-studio',
      width: 1,
      height: 1,
    });
    expect(persistedUpload).toMatchObject({
      status: 'finalized',
      finalizedAssetId: first.asset_id,
    });
  }, 30_000);
});
