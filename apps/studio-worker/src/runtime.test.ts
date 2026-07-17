import { describe, expect, test } from 'bun:test';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { createMemoryStudioWorkerRepository } from './memory-repository';
import {
  assembleProductionStudioWorkerProcess,
  buildStudioWorkerAdapterRuntime,
  buildStudioWorkerRuntime,
} from './runtime';

function errorTreeText(value: unknown, seen = new Set<unknown>()): string {
  if (seen.has(value)) return '';
  seen.add(value);
  if (!(value instanceof Error)) return String(value);
  const parts = [value.name, value.message];
  if ('cause' in value && value.cause !== undefined) {
    parts.push(errorTreeText(value.cause, seen));
  }
  if (value instanceof AggregateError) {
    for (const nested of value.errors) parts.push(errorTreeText(nested, seen));
  }
  return parts.join('\n');
}

describe('Studio worker runtime assembly', () => {
  test('returns a disabled full runtime without reading production factories', async () => {
    let factoryReads = 0;
    const factories = new Proxy(
      {},
      {
        ownKeys() {
          factoryReads += 1;
          throw new Error('disabled runtime must not inspect production factories');
        },
      },
    );

    await expect(
      buildStudioWorkerRuntime({ STUDIO_ENABLED: 'false' }, { factories: factories as never }),
    ).resolves.toEqual({ enabled: false });
    expect(factoryReads).toBe(0);
  });

  test('leaves Studio disabled without requiring storage or provider configuration', () => {
    expect(buildStudioWorkerAdapterRuntime({ STUDIO_ENABLED: 'false' })).toEqual({
      enabled: false,
    });
  });

  test('allows explicitly ephemeral fake storage and rejects production memory with OpenAI', () => {
    expect(
      buildStudioWorkerAdapterRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toMatchObject({ enabled: true, storageMode: 'memory', fakeProviderEnabled: true });

    expect(() =>
      buildStudioWorkerAdapterRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toThrow(/STUDIO_OPENAI_COMPATIBLE_ENABLED/);
  });

  test('preserves the shared provider network policy for registry assembly', () => {
    expect(
      buildStudioWorkerAdapterRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
        STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST: 'https://images.internal.test',
      }),
    ).toMatchObject({
      enabled: true,
      privateProviderOrigins: ['https://images.internal.test'],
      allowInsecureLocalEndpoints: false,
    });
  });

  test('uses the shared S3 adapter configuration and redacts static credential failures', () => {
    const secret = 'worker-static-secret';
    expect(() =>
      buildStudioWorkerAdapterRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 's3',
        STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
        STUDIO_OBJECT_STORE_PREFIX: 'studio',
        STUDIO_S3_ENDPOINT: 'https://storage.example.test',
        STUDIO_S3_REGION: 'cn-hangzhou',
        STUDIO_S3_CREDENTIAL_MODE: 'static',
        STUDIO_S3_ACCESS_KEY_ID: 'worker-access-key',
        STUDIO_S3_SECRET_ACCESS_KEY: secret,
        STUDIO_S3_SSE: 'aws:kms',
      }),
    ).toThrow(/STUDIO_S3_KMS_KEY_ID/);
    try {
      buildStudioWorkerAdapterRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 's3',
        STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
        STUDIO_OBJECT_STORE_PREFIX: 'studio',
        STUDIO_S3_ENDPOINT: 'https://storage.example.test',
        STUDIO_S3_REGION: 'cn-hangzhou',
        STUDIO_S3_CREDENTIAL_MODE: 'static',
        STUDIO_S3_ACCESS_KEY_ID: 'worker-access-key',
        STUDIO_S3_SECRET_ACCESS_KEY: secret,
        STUDIO_S3_SSE: 'aws:kms',
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test('accepts fake and OpenAI-compatible S3 runtimes', () => {
    const s3 = {
      STUDIO_ENABLED: 'true',
      STUDIO_OBJECT_STORE_MODE: 's3',
      STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
      STUDIO_OBJECT_STORE_PREFIX: 'studio',
      STUDIO_S3_ENDPOINT: 'https://storage.example.test',
      STUDIO_S3_REGION: 'cn-hangzhou',
      STUDIO_S3_CREDENTIAL_MODE: 'default-chain',
      STUDIO_S3_SSE: 'AES256',
    } as const;
    expect(
      buildStudioWorkerAdapterRuntime({ ...s3, STUDIO_FAKE_PROVIDER_ENABLED: 'true' }),
    ).toMatchObject({
      enabled: true,
      storageMode: 's3',
    });
    expect(
      buildStudioWorkerAdapterRuntime({
        ...s3,
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
      }),
    ).toMatchObject({ enabled: true, storageMode: 's3', openAiCompatibleEnabled: true });
  });

  test('fails closed for incomplete static credentials', () => {
    const base = {
      STUDIO_ENABLED: 'true',
      STUDIO_FAKE_PROVIDER_ENABLED: 'true',
      STUDIO_OBJECT_STORE_MODE: 's3',
      STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
      STUDIO_OBJECT_STORE_PREFIX: 'studio',
      STUDIO_S3_ENDPOINT: 'https://storage.example.test',
      STUDIO_S3_REGION: 'cn-hangzhou',
      STUDIO_S3_CREDENTIAL_MODE: 'static',
      STUDIO_S3_SSE: 'AES256',
    } as const;
    expect(() =>
      buildStudioWorkerAdapterRuntime({ ...base, STUDIO_S3_ACCESS_KEY_ID: 'only-key' }),
    ).toThrow(/STUDIO_S3_SECRET_ACCESS_KEY/);
  });

  test('assembles durable staging and closes owned production resources exactly once', async () => {
    const now = new Date('2026-07-15T10:00:00.000Z');
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 2,
        markup_credits: 0.25,
      },
      reservedCredits: 2.25,
    });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const adapter = {
      id: 'fake',
      submit: async (ctx: { submissionKey: string }) => ({
        kind: 'completed' as const,
        provider: 'fake',
        submission_key: ctx.submissionKey,
        result: {
          assets: [
            {
              kind: 'image' as const,
              filename: 'production-result.png',
              mime_type: 'image/png',
              size_bytes: png.byteLength,
              replayable_within_attempt: true,
              openBody: async () => new Blob([png]).stream(),
            },
          ],
        },
      }),
      poll: async () => ({ status: 'succeeded' as const }),
      cancel: async () => {},
      fetchResult: async () => ({ assets: [] }),
    };
    const objectStore = new InMemoryStudioObjectStore({
      namespace: 'studio-production',
      ready: true,
    });
    const closes = { maintenance: 0, database: 0, storage: 0 };
    const process = assembleProductionStudioWorkerProcess({
      worker: {
        config: {
          workerId: 'production-worker',
          leaseMs: 30_000,
          pollIntervalMs: 0,
          unknownOutcomeTimeoutMs: 15 * 60_000,
        },
        repository,
        providers: { get: () => adapter, resolve: async () => adapter },
        credentialResolver: { resolve: async () => null },
        referenceAssets: { resolve: async () => [] },
        authorization: { revalidate: async () => ({ authorized: true }) },
        now: () => now,
        random: () => 0,
      },
      objectStore,
      releaseMaintenance: async () => {
        closes.maintenance += 1;
      },
      closeDatabase: async () => {
        closes.database += 1;
      },
      closeStorage: async () => {
        closes.storage += 1;
      },
    });

    await expect(process.worker.runOnce()).resolves.toMatchObject({
      kind: 'processed',
      jobId: job.jobId,
      status: 'succeeded',
    });
    expect(repository.getAttempts(job.jobId)[0]?.stagingManifestKey).toContain('/manifest.json');
    await process.close();
    await process.close();
    expect(closes).toEqual({ maintenance: 1, database: 1, storage: 1 });
  });

  test('builds the production worker graph with one injected SQL client and object store', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-production', ready: true });
    const client = { unsafe: async () => [] };
    const worker = { runOnce: async () => ({ kind: 'idle' as const }) };
    const maintenance = {
      runOnce: async () => ({ acquired: true, tasksRun: 0 }),
      release: async () => {},
    };
    const referenceAssets = { resolve: async () => [] };
    const createdWithClients: unknown[] = [];
    let workerInput: Record<string, unknown> | null = null;
    const build = buildStudioWorkerRuntime as unknown as (
      env: Record<string, string>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const runtime = await build(
      {
        NODE_ENV: 'test',
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
        DATABASE_URL: 'postgres://studio-worker',
        API_KEY_SECRET: 'test-master-secret',
        STUDIO_WORKER_ID: 'production-worker',
      },
      {
        signal: new AbortController().signal,
        factories: {
          createObjectStore: () => store,
          createDatabase: async () => ({ client, close: async () => {} }),
          createWorkerRepository(input: unknown) {
            createdWithClients.push(input);
            return repository;
          },
          createMaintenanceRepository(input: unknown) {
            createdWithClients.push(input);
            return {};
          },
          async createAuthorization(input: unknown) {
            createdWithClients.push(input);
            return { revalidate: async () => ({ authorized: true }) };
          },
          createCredentialResolver(input: unknown) {
            createdWithClients.push(input);
            return { resolve: async () => null };
          },
          createProviderRegistry: () => ({ resolve: async () => null }),
          createFakeProvider: () => ({ id: 'fake' }),
          createReferenceAssetResolver(input: unknown, objectStore: unknown) {
            createdWithClients.push(input);
            expect(objectStore).toBe(store);
            return referenceAssets;
          },
          createWorker(input: Record<string, unknown>) {
            workerInput = input;
            return worker;
          },
          createMaintenance: () => maintenance,
        },
      },
    );

    expect(runtime).toMatchObject({
      enabled: true,
      worker,
      maintenance,
      store,
      workerId: 'production-worker',
    });
    expect(createdWithClients).toEqual([client, client, client, client, client]);
    expect(workerInput).toMatchObject({
      repository,
      referenceAssets,
      signal: expect.any(AbortSignal),
      stager: expect.anything(),
      assets: expect.anything(),
    });
  });

  test('releases an assembled maintenance owner before database and storage on startup failure', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const store = new InMemoryStudioObjectStore({
      namespace: 'studio-production',
      ready: true,
    }) as InMemoryStudioObjectStore & { destroy(): void };
    const calls: string[] = [];
    store.destroy = () => {
      calls.push('storage');
      throw new Error(`storage close failed output=${signedUrl}`);
    };
    const databaseUrl = 'postgres://db-user:db-password@db.internal.test/studio';
    const apiKeySecret = 'worker-master-secret';
    const signedUrl = 'https://storage.internal.test/signed?token=storage-secret';
    let thrown: unknown;

    try {
      await buildStudioWorkerRuntime(
        {
          NODE_ENV: 'test',
          STUDIO_ENABLED: 'true',
          STUDIO_FAKE_PROVIDER_ENABLED: 'true',
          STUDIO_OBJECT_STORE_MODE: 'memory',
          STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
          DATABASE_URL: databaseUrl,
          API_KEY_SECRET: apiKeySecret,
          STUDIO_WORKER_ID: 'production-worker',
        },
        {
          factories: {
            createObjectStore: () => store,
            createDatabase: async () => ({
              client: { unsafe: async () => [] },
              close: async () => {
                calls.push('database');
                throw new Error(`database close failed database=${databaseUrl}`);
              },
            }),
            createWorkerRepository: () => repository,
            createMaintenanceRepository: () => ({}) as never,
            createAuthorization: async () => ({
              revalidate: async () => ({ authorized: true }),
            }),
            createCredentialResolver: () => ({ resolve: async () => null }),
            createProviderRegistry: () => ({ resolve: async () => null }),
            createFakeProvider: () => ({ id: 'fake' }) as never,
            createReferenceAssetResolver: () => ({ resolve: async () => [] }),
            createMaintenance: () => ({
              runOnce: async () => ({ acquired: true, tasksRun: 0 }),
              release: async () => {
                calls.push('maintenance');
                throw new Error(`maintenance release failed api_key=${apiKeySecret}`);
              },
            }),
            createWorker: () => {
              throw new Error(
                `worker assembly failed database=${databaseUrl} api_key=${apiKeySecret} output=${signedUrl}`,
              );
            },
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(['maintenance', 'database', 'storage']);
    const errorGraph = errorTreeText(thrown);
    expect(errorGraph).toContain('Studio worker startup and cleanup failed');
    expect(errorGraph).not.toContain(databaseUrl);
    expect(errorGraph).not.toContain(apiKeySecret);
    expect(errorGraph).not.toContain(signedUrl);
  });
});
