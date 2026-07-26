import os from 'node:os';

import { createDbFromClient, type Database } from '@kortix/db';
import postgres from 'postgres';

import {
  DeveloperArtifactRetentionConfigSchema,
  type DeveloperArtifactRetentionConfig,
} from './artifact-retention-spec';
import { createDeveloperArtifactRetentionWorker } from './artifact-retention';
import {
  createDeveloperArtifactRetentionLifecycle,
  createDeveloperArtifactRetentionRuntime,
  type DeveloperArtifactRetentionLifecycle,
  type DeveloperArtifactRetentionRuntime,
} from './artifact-retention-runtime';

export interface DeveloperArtifactRetentionBootstrapConfig {
  enabled: boolean;
  intervalMs: number;
  retryIntervalMs: number;
  worker: DeveloperArtifactRetentionConfig;
}

export interface DeveloperArtifactRetentionBootstrap {
  start(): void;
  stop(): Promise<void>;
  settled(): Promise<void>;
}

type RetentionEnvironment = Record<string, string | undefined>;

type RetentionSqlClient = ReturnType<typeof postgres>;
type RetentionSqlClientFactory = (
  databaseUrl: string,
  options: postgres.Options<{}>,
) => RetentionSqlClient;

export interface DeveloperArtifactRetentionDatabasePool {
  db: Database;
  assertReady(): Promise<void>;
  close(): Promise<void>;
}

const RETENTION_DATABASE_ROLE = 'developer_artifact_retention_worker';
// Keep this explicit because postgres.js replaces the whole connection object.
// It must stay aligned with packages/db/src/client.ts's production default.
const RETENTION_STATEMENT_TIMEOUT_MS = 25_000;
const RETENTION_POOL_MAX = 2;
const RETENTION_FORBIDDEN_DATABASE_URL_PARAMETERS = new Set([
  'options',
  'role',
  'statement_timeout',
]);

const DEFAULTS = {
  // Scheduled run creation is hourly; queue polling stays fast so durable
  // acceptance-triggered runs are picked up within seconds.
  intervalMs: 60 * 60_000,
  retryIntervalMs: 5_000,
  leaseMs: 60_000,
  uploadBatchSize: 50,
  objectBatchSize: 50,
  orphanGraceMs: 24 * 60 * 60_000,
  maxAttempts: 8,
  retryBaseMs: 1_000,
  retryMaxMs: 60 * 60_000,
} as const;

export function createDeveloperArtifactRetentionDatabasePool(input: {
  databaseUrl: string;
  createClient?: RetentionSqlClientFactory;
  createDatabase?: (client: RetentionSqlClient) => Database;
}): DeveloperArtifactRetentionDatabasePool {
  assertRetentionDatabaseUrlCannotOverrideStartupSettings(input.databaseUrl);
  const createClient =
    input.createClient ??
    ((databaseUrl, options) => postgres(databaseUrl, options));
  const client = createClient(input.databaseUrl, {
    prepare: false,
    max: RETENTION_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    connection: {
      role: RETENTION_DATABASE_ROLE,
      statement_timeout: RETENTION_STATEMENT_TIMEOUT_MS,
    },
  });
  const db = (input.createDatabase ?? createDbFromClient)(client);
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= client.end({ timeout: 5 });
    return closing;
  };

  return {
    db,
    async assertReady() {
      // postgres.js connects lazily. Force the startup packet now so a missing
      // role membership is handled by bootstrap retry rather than the run loop.
      try {
        await client.unsafe('SELECT 1');
      } catch (error) {
        await close().catch(() => undefined);
        throw isRetentionRoleMembershipError(error)
          ? createRetentionRoleMembershipError(input.databaseUrl, error)
          : error;
      }
    },
    close,
  };
}

function isRetentionRoleMembershipError(
  error: unknown,
): error is Error & { code: '42501' } {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === '42501' &&
    error.message === `permission denied to set role "${RETENTION_DATABASE_ROLE}"`
  );
}

function createRetentionRoleMembershipError(databaseUrl: string, cause: unknown): Error {
  const loginRole = retentionLoginRole(databaseUrl);
  const error = new Error(
    `Developer artifact retention database login is not a member of "${RETENTION_DATABASE_ROLE}". ` +
      `Ask a DBA to run: GRANT ${RETENTION_DATABASE_ROLE} TO ${loginRole};`,
  ) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function retentionLoginRole(databaseUrl: string): string {
  const encodedUsername = new URL(databaseUrl).username;
  if (!encodedUsername) return '<runtime_login_role>';
  let username: string;
  try {
    username = decodeURIComponent(encodedUsername);
  } catch {
    return '<runtime_login_role>';
  }
  return /^[a-z_][a-z0-9_$]*$/.test(username)
    ? username
    : `"${username.replaceAll('"', '""')}"`;
}

function assertRetentionDatabaseUrlCannotOverrideStartupSettings(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const override = [...url.searchParams.keys()].find((parameter) =>
    RETENTION_FORBIDDEN_DATABASE_URL_PARAMETERS.has(parameter.toLowerCase()),
  );
  if (override) {
    throw new Error(
      `Developer artifact retention database URL cannot override pinned startup setting: ${override}`,
    );
  }
}

export function bindDeveloperArtifactRetentionDatabasePool(input: {
  runtime: DeveloperArtifactRetentionRuntime;
  pool: DeveloperArtifactRetentionDatabasePool;
}): DeveloperArtifactRetentionRuntime {
  let stopping: Promise<void> | null = null;
  return {
    start() {
      input.runtime.start();
    },
    stop() {
      stopping ??= (async () => {
        try {
          await input.runtime.stop();
        } finally {
          await input.pool.close();
        }
      })();
      return stopping;
    },
  };
}

export function resolveDeveloperArtifactRetentionBootstrapConfig(
  environment: RetentionEnvironment,
  ownerId: string,
): DeveloperArtifactRetentionBootstrapConfig {
  const enabled = parseBoolean(
    environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ENABLED,
    false,
  );
  const fallbackWorker = DeveloperArtifactRetentionConfigSchema.safeParse({
    ownerId,
    leaseMs: DEFAULTS.leaseMs,
    uploadBatchSize: DEFAULTS.uploadBatchSize,
    objectBatchSize: DEFAULTS.objectBatchSize,
    orphanGraceMs: DEFAULTS.orphanGraceMs,
    maxAttempts: DEFAULTS.maxAttempts,
    retryBaseMs: DEFAULTS.retryBaseMs,
    retryMaxMs: DEFAULTS.retryMaxMs,
  });
  if (!fallbackWorker.success) {
    throw new Error('Invalid developer artifact retention worker configuration');
  }
  if (!enabled) {
    // Disabled retention must never parse tuning fields: a malformed knob on a
    // replica that keeps retention off cannot break the other singleton workers.
    return {
      enabled: false,
      intervalMs: DEFAULTS.intervalMs,
      retryIntervalMs: DEFAULTS.retryIntervalMs,
      worker: fallbackWorker.data,
    };
  }

  const intervalMs = parseInteger(
    environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_INTERVAL_MS,
    DEFAULTS.intervalMs,
  );
  const retryIntervalMs = parseInteger(
    environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_INTERVAL_MS,
    DEFAULTS.retryIntervalMs,
  );
  assertRuntimeInterval(intervalMs, 'interval');
  assertRuntimeInterval(retryIntervalMs, 'retry interval');

  const worker = DeveloperArtifactRetentionConfigSchema.safeParse({
    ownerId,
    leaseMs: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_LEASE_MS,
      DEFAULTS.leaseMs,
    ),
    uploadBatchSize: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_UPLOAD_BATCH_SIZE,
      DEFAULTS.uploadBatchSize,
    ),
    objectBatchSize: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_OBJECT_BATCH_SIZE,
      DEFAULTS.objectBatchSize,
    ),
    orphanGraceMs: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ORPHAN_GRACE_MS,
      DEFAULTS.orphanGraceMs,
    ),
    maxAttempts: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_MAX_ATTEMPTS,
      DEFAULTS.maxAttempts,
    ),
    retryBaseMs: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_BASE_MS,
      DEFAULTS.retryBaseMs,
    ),
    retryMaxMs: parseInteger(
      environment.OPENOPC_DEVELOPER_ARTIFACT_RETENTION_RETRY_MAX_MS,
      DEFAULTS.retryMaxMs,
    ),
  });
  if (!worker.success) {
    throw new Error('Invalid developer artifact retention worker configuration');
  }

  return { enabled, intervalMs, retryIntervalMs, worker: worker.data };
}

export function assertDeveloperArtifactRetentionProductionStorage(runtime: {
  enabled: boolean;
  storageMode?: 'memory' | 's3';
}): void {
  if (!runtime.enabled) {
    throw new Error('Developer artifact retention object storage is disabled');
  }
  if (runtime.storageMode !== 's3') {
    throw new Error('Developer artifact retention requires durable s3 object storage');
  }
}

export function createDeveloperArtifactRetentionBootstrap(input: {
  environment: RetentionEnvironment;
  ownerId: string;
  initialize(
    config: DeveloperArtifactRetentionBootstrapConfig,
  ): Promise<DeveloperArtifactRetentionRuntime>;
  onError?: (error: unknown) => void;
}): DeveloperArtifactRetentionBootstrap {
  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // A telemetry callback must never escape API boot or leader release.
    }
  };

  // Resolve configuration lazily inside start() so a malformed retention
  // environment surfaces as a contained onError instead of failing the whole
  // leader-worker bootstrap alongside the unrelated Kortix singletons.
  let lifecycle: DeveloperArtifactRetentionLifecycle | null = null;

  return {
    start() {
      let config: DeveloperArtifactRetentionBootstrapConfig;
      try {
        config = resolveDeveloperArtifactRetentionBootstrapConfig(
          input.environment,
          input.ownerId,
        );
      } catch (error) {
        reportError(error);
        return;
      }
      if (!config.enabled) return;
      lifecycle ??= createDeveloperArtifactRetentionLifecycle({
        initialize: () => input.initialize(config),
        onError: input.onError,
      });
      lifecycle.start();
    },
    stop() {
      return lifecycle?.stop() ?? Promise.resolve();
    },
    settled() {
      return lifecycle?.settled() ?? Promise.resolve();
    },
  };
}

let productionBootstrap: DeveloperArtifactRetentionBootstrap | null = null;

export function startDeveloperArtifactRetentionWorker(): void {
  productionBootstrap ??= createDeveloperArtifactRetentionBootstrap({
    environment: process.env,
    ownerId: productionOwnerId(),
    initialize: initializeProductionRuntime,
    onError: reportProductionError,
  });
  productionBootstrap.start();
}

export function stopDeveloperArtifactRetentionWorker(): Promise<void> {
  return productionBootstrap?.stop() ?? Promise.resolve();
}

async function initializeProductionRuntime(
  config: DeveloperArtifactRetentionBootstrapConfig,
): Promise<DeveloperArtifactRetentionRuntime> {
  const [configModule, runtimeModule, repositoryModule, storeModule] = await Promise.all([
    import('../config'),
    import('../studio/default-routes'),
    import('./artifacts.drizzle'),
    import('./artifact-retention-store'),
  ]);
  const studioRuntime = runtimeModule.getDefaultStudioApiRuntime();
  assertDeveloperArtifactRetentionProductionStorage(studioRuntime);
  if (!studioRuntime.enabled) {
    throw new Error('Developer artifact retention object storage is disabled');
  }
  await studioRuntime.store.assertReady();

  const pool = createDeveloperArtifactRetentionDatabasePool({
    databaseUrl: configModule.config.DATABASE_URL,
  });
  try {
    await pool.assertReady();
    const repository = repositoryModule.createDrizzleDeveloperArtifactRetentionRepository(
      pool.db,
    );
    const worker = createDeveloperArtifactRetentionWorker({
      config: config.worker,
      repository,
      store: storeModule.createDeveloperArtifactRetentionStore(studioRuntime.store),
    });
    const runtime = createDeveloperArtifactRetentionRuntime({
      repository,
      worker,
      intervalMs: config.intervalMs,
      retryIntervalMs: config.retryIntervalMs,
      onError: reportProductionError,
    });
    return bindDeveloperArtifactRetentionDatabasePool({ runtime, pool });
  } catch (error) {
    await pool.close().catch(reportProductionError);
    throw error;
  }
}

function productionOwnerId(): string {
  return `${os.hostname()}-${process.pid}-developer-artifact-retention`.slice(0, 128);
}

function reportProductionError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn('[developer-artifact-retention] worker unavailable', { error: message });
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error('Invalid developer artifact retention enabled setting');
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error('Invalid developer artifact retention integer setting');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Invalid developer artifact retention integer setting');
  }
  return parsed;
}

function assertRuntimeInterval(value: number, label: string): void {
  if (value < 1 || value > 24 * 60 * 60_000) {
    throw new Error(`Invalid developer artifact retention ${label}`);
  }
}
