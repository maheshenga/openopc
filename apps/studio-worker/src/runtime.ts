import os from 'node:os';
import {
  type StudioAdapterEnvironment,
  createS3StudioObjectStore,
  parseStudioAdapterEnvironment,
} from '@kortix/studio-adapters';
import {
  InMemoryStudioObjectStore,
  type StudioCredentialResolver,
  type StudioObjectStore,
  type StudioProviderAdapter,
  type StudioReferenceAssetResolver,
  createFakeStudioProvider,
  decryptProjectSecretEnvelope,
  studioMaintenanceLeaseName,
} from '@kortix/studio-runtime';
import postgres from 'postgres';
import { z } from 'zod';
import { createStudioCredentialResolver } from '../../api/src/studio/credentials';
import { createStudioReferenceAssetResolver } from '../../api/src/studio/storage';
import { PostgresStudioReferenceAssetLookup } from './asset-lookup';
import { createStudioSubmissionAuthorization } from './authorization';
import type { StudioWorkerRepository } from './contracts';
import { PostgresStudioCredentialLookup } from './credential-lookup';
import {
  STUDIO_ORPHAN_CLEANUP_DEFAULTS,
  StudioMaintenanceCoordinator,
  type StudioMaintenanceRepository,
} from './maintenance';
import {
  PostgresStudioMaintenanceRepository,
  PostgresStudioWorkerRepository,
  type StudioSqlClient,
  createPostgresStudioCredentialValidator,
  createPostgresStudioServiceAccountLoader,
  createPostgresStudioTokenLoader,
} from './postgres';
import { createStudioProviderRegistry } from './provider-registry';
import { StudioResultStager } from './result-stager';
import {
  type StudioProviderRegistry,
  type StudioSubmissionAuthorization,
  StudioWorker,
  type StudioWorkerDependencies,
  createObjectStoreAssetWriter,
  redactStudioDiagnostic,
} from './worker';

const EnabledEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    API_KEY_SECRET: z.string().min(1),
    STUDIO_WORKER_ID: z.string().min(1).optional(),
    STUDIO_FAKE_PROVIDER_ENABLED: z.enum(['true', 'false']).default('false'),
    STUDIO_OPENAI_COMPATIBLE_ENABLED: z.enum(['true', 'false']).default('false'),
    STUDIO_WORKER_IDLE_MS: z.coerce.number().int().nonnegative().max(60_000).default(1_000),
    STUDIO_WORKER_LEASE_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(15 * 60_000)
      .default(60_000),
    STUDIO_WORKER_POLL_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(15 * 60_000)
      .default(2_000),
    STUDIO_WORKER_MAINTENANCE_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(15 * 60_000)
      .default(20_000),
  })
  .passthrough();

export type StudioWorkerEnvironment =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      apiKeySecret: string;
      workerId: string;
      fakeProviderEnabled: boolean;
      openAiCompatibleEnabled: boolean;
      idleMs: number;
      leaseMs: number;
      pollMs: number;
      maintenanceMs: number;
    };

export type StudioWorkerAdapterRuntime =
  | { enabled: false }
  | {
      enabled: true;
      fakeProviderEnabled: boolean;
      openAiCompatibleEnabled: boolean;
      storageMode: 'memory' | 's3';
      privateProviderOrigins: readonly string[];
      allowInsecureLocalEndpoints: boolean;
      store: StudioObjectStore;
      assertReadyBeforeClaim(): Promise<void>;
      close(): Promise<void>;
    };

export type StudioWorkerRuntime =
  | { enabled: false }
  | {
      enabled: true;
      workerId: string;
      idleMs: number;
      maintenanceMs: number;
      fakeProviderEnabled: boolean;
      openAiCompatibleEnabled: boolean;
      storageMode: 'memory' | 's3';
      privateProviderOrigins: readonly string[];
      allowInsecureLocalEndpoints: boolean;
      store: StudioObjectStore;
      worker: StudioWorker;
      maintenance: Pick<StudioMaintenanceCoordinator, 'runOnce' | 'release'>;
      assertReadyBeforeClaim(): Promise<void>;
      close(): Promise<void>;
    };

export interface StudioWorkerDatabase {
  client: StudioSqlClient;
  close(): Promise<void>;
}

export interface StudioWorkerRuntimeFactories {
  createObjectStore(
    adapter: Extract<StudioAdapterEnvironment, { enabled: true }>,
    role: 'worker',
  ): StudioObjectStore;
  createDatabase(databaseUrl: string): Promise<StudioWorkerDatabase>;
  createWorkerRepository(client: StudioSqlClient): StudioWorkerRepository;
  createMaintenanceRepository(client: StudioSqlClient): StudioMaintenanceRepository;
  createAuthorization(client: StudioSqlClient): Promise<StudioSubmissionAuthorization>;
  createCredentialResolver(client: StudioSqlClient, apiKeySecret: string): StudioCredentialResolver;
  createProviderRegistry(input: {
    fakeProviderEnabled: boolean;
    openAiCompatibleEnabled: boolean;
    privateProviderOrigins: readonly string[];
    allowInsecureLocalEndpoints: boolean;
  }): Pick<StudioProviderRegistry, 'resolve'>;
  createFakeProvider(): StudioProviderAdapter;
  createReferenceAssetResolver(
    client: StudioSqlClient,
    store: StudioObjectStore,
  ): StudioReferenceAssetResolver;
  createWorker(input: StudioWorkerDependencies): StudioWorker;
  createMaintenance(input: {
    repository: StudioMaintenanceRepository;
    objectStore: StudioObjectStore;
    ownerId: string;
    lockKey: string;
    ttlMs: number;
  }): Pick<StudioMaintenanceCoordinator, 'runOnce' | 'release'>;
}

export function parseStudioWorkerEnvironment(
  env: Record<string, string | undefined> = process.env,
): StudioWorkerEnvironment {
  if (env.STUDIO_ENABLED !== 'true') return { enabled: false };
  const parsed = EnabledEnvironmentSchema.parse(env);
  return {
    enabled: true,
    databaseUrl: parsed.DATABASE_URL,
    apiKeySecret: parsed.API_KEY_SECRET,
    workerId:
      parsed.STUDIO_WORKER_ID ??
      `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    fakeProviderEnabled: parsed.STUDIO_FAKE_PROVIDER_ENABLED === 'true',
    openAiCompatibleEnabled: parsed.STUDIO_OPENAI_COMPATIBLE_ENABLED === 'true',
    idleMs: parsed.STUDIO_WORKER_IDLE_MS,
    leaseMs: parsed.STUDIO_WORKER_LEASE_MS,
    pollMs: parsed.STUDIO_WORKER_POLL_MS,
    maintenanceMs: parsed.STUDIO_WORKER_MAINTENANCE_MS,
  };
}

export async function buildStudioWorkerRuntime(
  env: Record<string, string | undefined> = process.env,
  options: {
    signal?: AbortSignal;
    factories?: Partial<StudioWorkerRuntimeFactories>;
  } = {},
): Promise<StudioWorkerRuntime> {
  const adapter = parseStudioAdapterEnvironment(env, { test: env.NODE_ENV === 'test' });
  if (!adapter.enabled) return { enabled: false };
  const workerEnvironment = parseStudioWorkerEnvironment(env);
  if (!workerEnvironment.enabled) return { enabled: false };
  const factories: StudioWorkerRuntimeFactories = {
    ...defaultStudioWorkerRuntimeFactories,
    ...options.factories,
  };

  let store: StudioObjectStore | null = null;
  let database: StudioWorkerDatabase | null = null;
  let maintenance: Pick<StudioMaintenanceCoordinator, 'runOnce' | 'release'> | null = null;
  try {
    store = factories.createObjectStore(adapter, 'worker');
    database = await factories.createDatabase(workerEnvironment.databaseUrl);
    const repository = factories.createWorkerRepository(database.client);
    const maintenanceRepository = factories.createMaintenanceRepository(database.client);
    const authorization = await factories.createAuthorization(database.client);
    const credentialResolver = factories.createCredentialResolver(
      database.client,
      workerEnvironment.apiKeySecret,
    );
    const providerRegistry = factories.createProviderRegistry({
      fakeProviderEnabled: adapter.fakeProviderEnabled,
      openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
      privateProviderOrigins: adapter.privateProviderOrigins,
      allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
    });
    const fakeProvider = factories.createFakeProvider();
    const referenceAssets = factories.createReferenceAssetResolver(database.client, store);
    maintenance = factories.createMaintenance({
      repository: maintenanceRepository,
      objectStore: store,
      ownerId: workerEnvironment.workerId,
      lockKey: studioMaintenanceLeaseName(),
      ttlMs: Math.max(60_000, workerEnvironment.maintenanceMs * 3),
    });
    const worker = factories.createWorker({
      config: {
        workerId: workerEnvironment.workerId,
        leaseMs: workerEnvironment.leaseMs,
        pollIntervalMs: workerEnvironment.pollMs,
        unknownOutcomeTimeoutMs: 15 * 60_000,
      },
      repository,
      providers: {
        get: (job) => (job.provider === 'fake' ? fakeProvider : null),
        resolve: providerRegistry.resolve,
      },
      credentialResolver,
      referenceAssets,
      authorization,
      assets: createObjectStoreAssetWriter(store),
      stager: new StudioResultStager(store),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const close = createIdempotentWorkerClose({
      releaseMaintenance: () => maintenance?.release() ?? Promise.resolve(),
      closeDatabase: () => database?.close() ?? Promise.resolve(),
      closeStorage: () => closeStudioObjectStore(store),
    });
    return {
      enabled: true,
      workerId: workerEnvironment.workerId,
      idleMs: workerEnvironment.idleMs,
      maintenanceMs: workerEnvironment.maintenanceMs,
      fakeProviderEnabled: adapter.fakeProviderEnabled,
      openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
      storageMode: adapter.storage.mode,
      privateProviderOrigins: adapter.privateProviderOrigins,
      allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
      store,
      worker,
      maintenance,
      assertReadyBeforeClaim: () => store?.assertReady() ?? Promise.reject(new Error('closed')),
      close,
    };
  } catch (startupError) {
    let cleanupError: unknown = null;
    try {
      await closeStudioWorkerResources({
        releaseMaintenance: () => maintenance?.release() ?? Promise.resolve(),
        closeDatabase: () => database?.close() ?? Promise.resolve(),
        closeStorage: () => closeStudioObjectStore(store),
      });
    } catch (error) {
      cleanupError = error;
    }
    const startup = new Error(
      `Studio worker startup failed: ${redactStudioStartupDiagnostic(errorMessage(startupError))}`,
    );
    if (cleanupError) {
      throw new AggregateError(
        [startup, sanitizeStudioError(cleanupError)],
        `Studio worker startup and cleanup failed: ${redactStudioStartupDiagnostic(errorMessage(startupError))}`,
      );
    }
    throw startup;
  }
}

export function buildStudioWorkerAdapterRuntime(
  env: Record<string, string | undefined> = process.env,
): StudioWorkerAdapterRuntime {
  const adapter = parseStudioAdapterEnvironment(env, { test: env.NODE_ENV === 'test' });
  if (!adapter.enabled) return { enabled: false };
  const store = createStudioObjectStore(adapter, 'worker');
  const close = createIdempotentClose(() => closeStudioObjectStore(store));
  return {
    enabled: true,
    fakeProviderEnabled: adapter.fakeProviderEnabled,
    openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
    storageMode: adapter.storage.mode,
    privateProviderOrigins: adapter.privateProviderOrigins,
    allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
    store,
    assertReadyBeforeClaim: () => store.assertReady(),
    close,
  };
}

export function assembleProductionStudioWorkerProcess(input: {
  worker: Omit<StudioWorkerDependencies, 'assets' | 'stager'>;
  objectStore: StudioObjectStore;
  releaseMaintenance: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  closeStorage: () => Promise<void>;
}): { worker: StudioWorker; close(): Promise<void> } {
  const worker = new StudioWorker({
    ...input.worker,
    assets: createObjectStoreAssetWriter(input.objectStore),
    stager: new StudioResultStager(input.objectStore),
  });
  return { worker, close: createIdempotentWorkerClose(input) };
}

export function createProductionStudioMaintenanceCoordinator(input: {
  repository: StudioMaintenanceRepository;
  objectStore: StudioObjectStore;
  ownerId: string;
  lockKey: string;
  ttlMs: number;
  now?: () => Date;
}): StudioMaintenanceCoordinator {
  return new StudioMaintenanceCoordinator({
    repository: input.repository,
    objectStore: input.objectStore,
    ownerId: input.ownerId,
    lockKey: input.lockKey,
    ttlMs: input.ttlMs,
    ...(input.now ? { now: input.now } : {}),
    orphanRetentionMs: STUDIO_ORPHAN_CLEANUP_DEFAULTS.retentionMs,
    orphanCandidatePageLimit: STUDIO_ORPHAN_CLEANUP_DEFAULTS.candidatePageLimit,
    orphanObjectPageLimit: STUDIO_ORPHAN_CLEANUP_DEFAULTS.objectPageLimit,
    orphanCandidateBudget: STUDIO_ORPHAN_CLEANUP_DEFAULTS.candidateBudget,
    orphanPageBudget: STUDIO_ORPHAN_CLEANUP_DEFAULTS.pageBudget,
    orphanObjectBudget: STUDIO_ORPHAN_CLEANUP_DEFAULTS.objectBudget,
  });
}

export function createProductionStudioWorker(
  input: Omit<StudioWorkerDependencies, 'assets' | 'stager'> & {
    objectStore: StudioObjectStore;
  },
): StudioWorker {
  const { objectStore, ...dependencies } = input;
  return new StudioWorker({
    ...dependencies,
    assets: createObjectStoreAssetWriter(objectStore),
    stager: new StudioResultStager(objectStore),
  });
}

export async function closeStudioWorkerResources(input: {
  releaseMaintenance: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  closeStorage: () => Promise<void>;
}): Promise<void> {
  const results: PromiseSettledResult<void>[] = [];
  results.push(...(await Promise.allSettled([Promise.resolve().then(input.releaseMaintenance)])));
  results.push(
    ...(await Promise.allSettled([
      Promise.resolve().then(input.closeDatabase),
      Promise.resolve().then(input.closeStorage),
    ])),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    const sanitizedFailures = failures.map(sanitizeStudioError);
    const messages = sanitizedFailures.map((failure) => failure.message);
    throw new AggregateError(
      sanitizedFailures,
      `Studio worker shutdown failed: ${messages.join('; ')}`,
    );
  }
}

export function createStudioObjectStore(
  adapter: Extract<StudioAdapterEnvironment, { enabled: true }>,
  role: 'api' | 'worker',
): StudioObjectStore {
  if (adapter.storage.mode === 'memory') {
    return new InMemoryStudioObjectStore({
      namespace: adapter.storage.namespace,
      ready: true,
    });
  }
  return createS3StudioObjectStore({ config: adapter.storage, role });
}

const defaultStudioWorkerRuntimeFactories: StudioWorkerRuntimeFactories = {
  createObjectStore: (adapter, role) => createStudioObjectStore(adapter, role),
  async createDatabase(databaseUrl) {
    const raw = postgres(databaseUrl, {
      prepare: false,
      max: 4,
      idle_timeout: 30,
      connect_timeout: 10,
      connection: { statement_timeout: 25_000 },
    });
    return {
      client: {
        async unsafe(text, values = []) {
          const rows = await raw.unsafe(text, values as never[]);
          return Array.from(rows) as Record<string, unknown>[];
        },
      },
      close: () => raw.end({ timeout: 5 }),
    };
  },
  createWorkerRepository: (client) => new PostgresStudioWorkerRepository(client),
  createMaintenanceRepository: (client) => new PostgresStudioMaintenanceRepository(client),
  async createAuthorization(client) {
    const [{ authorize }, { invalidateIamCacheForUsers }] = await Promise.all([
      import('../../api/src/iam/dispatcher'),
      import('../../api/src/iam/cache-invalidation'),
    ]);
    return createStudioSubmissionAuthorization({
      loadToken: createPostgresStudioTokenLoader(client),
      loadServiceAccount: createPostgresStudioServiceAccountLoader(client),
      validateCredentialBinding: createPostgresStudioCredentialValidator(client),
      async invalidateAuthorizationCache(principalIds) {
        invalidateIamCacheForUsers(principalIds);
      },
      async authorizeProjectAction(input) {
        const result = await authorize(
          input.userId,
          input.accountId,
          input.action,
          { type: 'project', id: input.projectId },
          input.actingTokenId,
        );
        return result.allowed;
      },
    });
  },
  createCredentialResolver(client, apiKeySecret) {
    return createStudioCredentialResolver({
      lookup: new PostgresStudioCredentialLookup(client),
      decrypt: (projectId, valueEnc) =>
        decryptProjectSecretEnvelope(apiKeySecret, projectId, valueEnc),
    });
  },
  createProviderRegistry: (input) => createStudioProviderRegistry(input),
  createFakeProvider: () => createFakeStudioProvider(),
  createReferenceAssetResolver(client, store) {
    return createStudioReferenceAssetResolver(
      new PostgresStudioReferenceAssetLookup(client),
      store,
    );
  },
  createWorker: (input) => new StudioWorker(input),
  createMaintenance: (input) => createProductionStudioMaintenanceCoordinator(input),
};

function createIdempotentWorkerClose(input: {
  releaseMaintenance: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  closeStorage: () => Promise<void>;
}): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= closeStudioWorkerResources(input);
    return closing;
  };
}

function createIdempotentClose(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= Promise.resolve().then(close);
    return closing;
  };
}

async function closeStudioObjectStore(store: StudioObjectStore | null): Promise<void> {
  if (store && 'destroy' in store && typeof store.destroy === 'function') {
    await store.destroy();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactStudioStartupDiagnostic(value: string): string {
  return redactStudioDiagnostic(value).replace(
    /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi,
    '[REDACTED_DATABASE_URL]',
  );
}

function sanitizeStudioError(error: unknown): Error {
  const message = redactStudioStartupDiagnostic(errorMessage(error));
  if (error instanceof AggregateError) {
    const sanitized = new AggregateError(Array.from(error.errors, sanitizeStudioError), message);
    sanitized.name = error.name;
    return sanitized;
  }
  const sanitized = new Error(message);
  if (error instanceof Error) sanitized.name = error.name;
  return sanitized;
}
