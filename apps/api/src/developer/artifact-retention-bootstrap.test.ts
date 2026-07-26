import { describe, expect, test } from 'bun:test';

import {
  assertDeveloperArtifactRetentionProductionStorage,
  createDeveloperArtifactRetentionBootstrap,
  resolveDeveloperArtifactRetentionBootstrapConfig,
} from './artifact-retention-bootstrap';
import * as artifactRetentionBootstrapModule from './artifact-retention-bootstrap';

const OWNER_ID = 'api-retention-test';

type FakeDatabasePool = {
  db: unknown;
  assertReady(): Promise<void>;
  close(): Promise<void>;
};

function productionDatabaseHelpers(): {
  createDeveloperArtifactRetentionDatabasePool(input: {
    databaseUrl: string;
    createClient(databaseUrl: string, options: Record<string, unknown>): unknown;
    createDatabase(client: unknown): unknown;
  }): FakeDatabasePool;
  bindDeveloperArtifactRetentionDatabasePool(input: {
    runtime: { start(): void; stop(): Promise<void> };
    pool: FakeDatabasePool;
  }): { start(): void; stop(): Promise<void> };
} {
  const helpers = artifactRetentionBootstrapModule as unknown as {
    createDeveloperArtifactRetentionDatabasePool?: unknown;
    bindDeveloperArtifactRetentionDatabasePool?: unknown;
  };
  expect(typeof helpers.createDeveloperArtifactRetentionDatabasePool).toBe('function');
  expect(typeof helpers.bindDeveloperArtifactRetentionDatabasePool).toBe('function');
  return helpers as ReturnType<typeof productionDatabaseHelpers>;
}

describe('developer artifact retention bootstrap config', () => {
  test('is disabled by default with bounded production defaults', () => {
    expect(resolveDeveloperArtifactRetentionBootstrapConfig({}, OWNER_ID)).toEqual({
      enabled: false,
      intervalMs: 60 * 60_000,
      retryIntervalMs: 5_000,
      worker: {
        ownerId: OWNER_ID,
        leaseMs: 60_000,
        uploadBatchSize: 50,
        objectBatchSize: 50,
        orphanGraceMs: 24 * 60 * 60_000,
        maxAttempts: 8,
        retryBaseMs: 1_000,
        retryMaxMs: 60 * 60_000,
      },
    });
  });

  test('accepts explicit OpenOPC overrides and preserves exact worker bounds', () => {
    expect(
      resolveDeveloperArtifactRetentionBootstrapConfig(
        {
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_INTERVAL_MS: '120000',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_INTERVAL_MS: '2500',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_LEASE_MS: '90000',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_UPLOAD_BATCH_SIZE: '25',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_OBJECT_BATCH_SIZE: '30',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ORPHAN_GRACE_MS: '300000',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_MAX_ATTEMPTS: '6',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_BASE_MS: '500',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_MAX_MS: '30000',
        },
        OWNER_ID,
      ),
    ).toEqual({
      enabled: true,
      intervalMs: 120_000,
      retryIntervalMs: 2_500,
      worker: {
        ownerId: OWNER_ID,
        leaseMs: 90_000,
        uploadBatchSize: 25,
        objectBatchSize: 30,
        orphanGraceMs: 300_000,
        maxAttempts: 6,
        retryBaseMs: 500,
        retryMaxMs: 30_000,
      },
    });
  });

  test('rejects malformed, unbounded, or internally inconsistent settings', () => {
    for (const environment of [
      {
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true',
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_INTERVAL_MS: '0',
      },
      {
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true',
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_LEASE_MS: '4999',
      },
      {
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true',
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_UPLOAD_BATCH_SIZE: '101',
      },
      {
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true',
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_BASE_MS: '2000',
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_MAX_MS: '1000',
      },
    ]) {
      expect(() =>
        resolveDeveloperArtifactRetentionBootstrapConfig(environment, OWNER_ID),
      ).toThrow(/retention/i);
    }
  });

  test('does not parse malformed tuning fields while retention is disabled', () => {
    expect(
      resolveDeveloperArtifactRetentionBootstrapConfig(
        {
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'false',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_INTERVAL_MS: 'not-a-number',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_INTERVAL_MS: '-1',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_LEASE_MS: 'broken',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_UPLOAD_BATCH_SIZE: '999999',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_BASE_MS: '2000',
          OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_MAX_MS: '1000',
        },
        OWNER_ID,
      ),
    ).toMatchObject({
      enabled: false,
      intervalMs: 60 * 60_000,
      retryIntervalMs: 5_000,
      worker: { ownerId: OWNER_ID },
    });
  });
});

describe('developer artifact retention bootstrap lifecycle', () => {
  test('never initializes storage or workers while disabled', async () => {
    let initializeCalls = 0;
    const bootstrap = createDeveloperArtifactRetentionBootstrap({
      environment: {},
      ownerId: OWNER_ID,
      async initialize() {
        initializeCalls += 1;
        return { start() {}, async stop() {} };
      },
    });

    bootstrap.start();
    await bootstrap.settled();
    await bootstrap.stop();

    expect(initializeCalls).toBe(0);
  });

  test('contains malformed enabled configuration without affecting other singleton workers', async () => {
    let initializeCalls = 0;
    const errors: string[] = [];
    const bootstrap = createDeveloperArtifactRetentionBootstrap({
      environment: {
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true',
        OPENOPC_DEVELOPER_ARTIFACT_RETENTION_INTERVAL_MS: 'invalid',
      },
      ownerId: OWNER_ID,
      async initialize() {
        initializeCalls += 1;
        return { start() {}, async stop() {} };
      },
      onError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    bootstrap.start();
    await bootstrap.settled();
    await bootstrap.stop();

    expect(initializeCalls).toBe(0);
    expect(errors).toEqual(['Invalid developer artifact retention integer setting']);
  });

  test('pins a dedicated production pool to the least-privilege role with bounded settings', async () => {
    const helpers = productionDatabaseHelpers();
    const database = {};
    const observed: {
      databaseUrl?: string;
      options?: Record<string, unknown>;
      readyQueries: string[];
    } = { readyQueries: [] };
    const client = {
      async unsafe(query: string) {
        observed.readyQueries.push(query);
        return [];
      },
      async end() {},
    };

    const pool = helpers.createDeveloperArtifactRetentionDatabasePool({
      databaseUrl: 'postgres://retention.test/kortix',
      createClient(databaseUrl, options) {
        observed.databaseUrl = databaseUrl;
        observed.options = options;
        return client;
      },
      createDatabase(actualClient) {
        expect(actualClient).toBe(client);
        return database;
      },
    });
    await pool.assertReady();

    expect(pool.db).toBe(database);
    expect(observed.databaseUrl).toBe('postgres://retention.test/kortix');
    expect(observed.options).toMatchObject({
      max: 2,
      connection: {
        role: 'developer_artifact_retention_worker',
        statement_timeout: 25_000,
      },
    });
    expect(observed.readyQueries).toEqual(['SELECT 1']);
  });

  test('rejects database URL parameters that could override the pinned startup settings', () => {
    const helpers = productionDatabaseHelpers();
    let createClientCalls = 0;

    for (const databaseUrl of [
      'postgres://retention.test/kortix?role=postgres',
      'postgres://retention.test/kortix?statement_timeout=0',
      'postgres://retention.test/kortix?options=-c%20role%3Dpostgres',
    ]) {
      expect(() =>
        helpers.createDeveloperArtifactRetentionDatabasePool({
          databaseUrl,
          createClient() {
            createClientCalls += 1;
            return { async unsafe() { return []; }, async end() {} };
          },
          createDatabase() {
            return {};
          },
        }),
      ).toThrow(/database url.*startup setting/i);
    }

    expect(createClientCalls).toBe(0);
  });

  test('closes the dedicated pool exactly once before bootstrap stop resolves', async () => {
    const helpers = productionDatabaseHelpers();
    const events: string[] = [];
    let endCalls = 0;
    const bootstrap = createDeveloperArtifactRetentionBootstrap({
      environment: { OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true' },
      ownerId: OWNER_ID,
      async initialize() {
        const pool = helpers.createDeveloperArtifactRetentionDatabasePool({
          databaseUrl: 'postgres://retention.test/kortix',
          createClient() {
            return {
              async unsafe() {
                return [];
              },
              async end() {
                endCalls += 1;
                events.push('pool.end');
              },
            };
          },
          createDatabase() {
            return {};
          },
        });
        await pool.assertReady();
        return helpers.bindDeveloperArtifactRetentionDatabasePool({
          runtime: {
            start() {},
            async stop() {
              events.push('runtime.stop');
            },
          },
          pool,
        });
      },
    });

    bootstrap.start();
    await bootstrap.settled();
    await Promise.all([bootstrap.stop(), bootstrap.stop()]);

    expect(events).toEqual(['runtime.stop', 'pool.end']);
    expect(endCalls).toBe(1);
  });

  test('reports actionable grant guidance for missing role membership and closes without propagating', async () => {
    const helpers = productionDatabaseHelpers();
    const errors: string[] = [];
    let endCalls = 0;
    const bootstrap = createDeveloperArtifactRetentionBootstrap({
      environment: { OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true' },
      ownerId: OWNER_ID,
      async initialize() {
        const pool = helpers.createDeveloperArtifactRetentionDatabasePool({
          databaseUrl: 'postgres://retention_app_login@retention.test/kortix',
          createClient() {
            return {
              async unsafe() {
                throw Object.assign(
                  new Error(
                    'permission denied to set role "developer_artifact_retention_worker"',
                  ),
                  { code: '42501' },
                );
              },
              async end() {
                endCalls += 1;
              },
            };
          },
          createDatabase() {
            return {};
          },
        });
        await pool.assertReady();
        return helpers.bindDeveloperArtifactRetentionDatabasePool({
          runtime: { start() {}, async stop() {} },
          pool,
        });
      },
      onError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    expect(() => bootstrap.start()).not.toThrow();
    await bootstrap.settled();
    await bootstrap.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('developer_artifact_retention_worker');
    expect(errors[0]).toContain(
      'GRANT developer_artifact_retention_worker TO retention_app_login;',
    );
    expect(endCalls).toBe(1);
  });

  test('does not misdiagnose unrelated PostgreSQL permission failures as role membership', async () => {
    const helpers = productionDatabaseHelpers();
    const errors: string[] = [];
    let endCalls = 0;
    const bootstrap = createDeveloperArtifactRetentionBootstrap({
      environment: { OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED: 'true' },
      ownerId: OWNER_ID,
      async initialize() {
        const pool = helpers.createDeveloperArtifactRetentionDatabasePool({
          databaseUrl: 'postgres://retention_app_login@retention.test/kortix',
          createClient() {
            return {
              async unsafe() {
                throw Object.assign(new Error('permission denied for table accounts'), {
                  code: '42501',
                });
              },
              async end() {
                endCalls += 1;
              },
            };
          },
          createDatabase() {
            return {};
          },
        });
        await pool.assertReady();
        return helpers.bindDeveloperArtifactRetentionDatabasePool({
          runtime: { start() {}, async stop() {} },
          pool,
        });
      },
      onError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    expect(() => bootstrap.start()).not.toThrow();
    await bootstrap.settled();
    await bootstrap.stop();

    expect(errors).toEqual(['permission denied for table accounts']);
    expect(endCalls).toBe(1);
  });
});

describe('developer artifact retention production storage', () => {
  test('rejects disabled and memory-backed storage but accepts durable S3', () => {
    expect(() => assertDeveloperArtifactRetentionProductionStorage({ enabled: false })).toThrow(
      /disabled/i,
    );
    expect(() =>
      assertDeveloperArtifactRetentionProductionStorage({ enabled: true, storageMode: 'memory' }),
    ).toThrow(/s3/i);
    expect(() =>
      assertDeveloperArtifactRetentionProductionStorage({ enabled: true, storageMode: 's3' }),
    ).not.toThrow();
  });
});
