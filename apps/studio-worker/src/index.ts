import os from 'node:os';
import {
  InMemoryStudioObjectStore,
  createFakeStudioProvider,
  studioMaintenanceLeaseName,
} from '@kortix/studio-runtime';
import postgres from 'postgres';
import { z } from 'zod';
import { createStudioSubmissionAuthorization } from './authorization';
import { StudioMaintenanceCoordinator } from './maintenance';
import {
  PostgresStudioMaintenanceRepository,
  PostgresStudioWorkerRepository,
  type StudioSqlClient,
  createPostgresStudioCredentialValidator,
  createPostgresStudioServiceAccountLoader,
  createPostgresStudioTokenLoader,
} from './postgres';
import { StudioWorker, createObjectStoreAssetWriter } from './worker';

const EnabledEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    STUDIO_WORKER_ID: z.string().min(1).optional(),
    STUDIO_FAKE_PROVIDER_ENABLED: z.enum(['true', 'false']).default('false'),
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
      workerId: string;
      fakeProviderEnabled: boolean;
      idleMs: number;
      leaseMs: number;
      pollMs: number;
      maintenanceMs: number;
    };

export function parseStudioWorkerEnvironment(
  env: Record<string, string | undefined> = process.env,
): StudioWorkerEnvironment {
  if (env.STUDIO_ENABLED !== 'true') return { enabled: false };
  const parsed = EnabledEnvironmentSchema.parse(env);
  return {
    enabled: true,
    databaseUrl: parsed.DATABASE_URL,
    workerId:
      parsed.STUDIO_WORKER_ID ??
      `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    fakeProviderEnabled: parsed.STUDIO_FAKE_PROVIDER_ENABLED === 'true',
    idleMs: parsed.STUDIO_WORKER_IDLE_MS,
    leaseMs: parsed.STUDIO_WORKER_LEASE_MS,
    pollMs: parsed.STUDIO_WORKER_POLL_MS,
    maintenanceMs: parsed.STUDIO_WORKER_MAINTENANCE_MS,
  };
}

export async function runStudioWorkerLoop(input: {
  signal: AbortSignal;
  idleMs: number;
  tick: () => Promise<void>;
}): Promise<void> {
  while (!input.signal.aborted) {
    await input.tick();
    if (input.signal.aborted) break;
    await abortableDelay(input.idleMs, input.signal);
  }
}

export async function runStudioMaintenanceOnce(input: {
  runOnce: () => Promise<void>;
  logError?: (message: string, details: Record<string, unknown>) => void;
}): Promise<boolean> {
  try {
    await input.runOnce();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (input.logError ?? console.error)('[studio-worker] maintenance failed', { error: message });
    return false;
  }
}

async function main(): Promise<void> {
  const env = parseStudioWorkerEnvironment();
  if (!env.enabled) {
    console.info('[studio-worker] STUDIO_ENABLED is not true; worker remains disabled');
    return;
  }
  if (!env.fakeProviderEnabled) {
    throw new Error(
      'Studio worker has no storage/provider driver. Set STUDIO_FAKE_PROVIDER_ENABLED=true for the Task 8 development path; Task 9 wires production storage and OpenAI-compatible providers.',
    );
  }

  const raw = postgres(env.databaseUrl, {
    prepare: false,
    max: 4,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { statement_timeout: 25_000 },
  });
  const client: StudioSqlClient = {
    async unsafe(text, values = []) {
      const rows = await raw.unsafe(text, values as never[]);
      return Array.from(rows) as Record<string, unknown>[];
    },
  };
  const repository = new PostgresStudioWorkerRepository(client);
  const maintenanceRepository = new PostgresStudioMaintenanceRepository(client);
  const [{ authorize }, { invalidateIamCacheForUsers }] = await Promise.all([
    import('../../api/src/iam/dispatcher'),
    import('../../api/src/iam/cache-invalidation'),
  ]);
  const authorization = createStudioSubmissionAuthorization({
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
  const fakeProvider = createFakeStudioProvider();
  const objectStore = new InMemoryStudioObjectStore({
    namespace: 'studio-fake-ephemeral',
    ready: true,
  });
  const worker = new StudioWorker({
    config: {
      workerId: env.workerId,
      leaseMs: env.leaseMs,
      pollIntervalMs: env.pollMs,
      unknownOutcomeTimeoutMs: 15 * 60_000,
    },
    repository,
    providers: { get: (job) => (job.provider === 'fake' ? fakeProvider : null) },
    authorization,
    assets: createObjectStoreAssetWriter(objectStore),
  });
  const maintenance = new StudioMaintenanceCoordinator({
    repository: maintenanceRepository,
    ownerId: env.workerId,
    lockKey: studioMaintenanceLeaseName(),
    ttlMs: Math.max(60_000, env.maintenanceMs * 3),
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let nextMaintenanceAt = 0;
  console.info('[studio-worker] started', { workerId: env.workerId, provider: 'fake' });
  try {
    await runStudioWorkerLoop({
      signal: controller.signal,
      idleMs: env.idleMs,
      async tick() {
        const result = await worker.runOnce();
        if (result.kind === 'error') {
          console.error('[studio-worker] tick failed', {
            code: result.code,
            jobId: result.jobId,
          });
        }
        const now = Date.now();
        if (now >= nextMaintenanceAt) {
          await runStudioMaintenanceOnce({
            async runOnce() {
              await maintenance.runOnce();
            },
          });
          nextMaintenanceAt = now + env.maintenanceMs;
        }
      },
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await maintenance.release().catch(() => {});
    await raw.end({ timeout: 5 });
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[studio-worker] fatal', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
