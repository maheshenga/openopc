import { lookup } from 'node:dns/promises';
import {
  createS3StudioObjectStore,
  parseStudioAdapterEnvironment,
  type StudioAdapterEnvironment,
} from '@kortix/studio-adapters';
import { InMemoryStudioObjectStore, type StudioObjectStore } from '@kortix/studio-runtime';
import { config } from '../config';
import { deriveRequestContext } from '../iam/cache';
import { assertAuthorized } from '../iam/dispatcher';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { createStudioProjectRoutes } from './index';
import { StudioProviderConfigService, createStudioProviderOriginValidator } from './providers';
import { createDrizzleStudioRepository } from './repositories/drizzle';
import { StudioStorageService } from './storage';

export type StudioApiRuntime =
  | { enabled: false }
  | {
      enabled: true;
      fakeProviderEnabled: boolean;
      openAiCompatibleEnabled: boolean;
      storageMode: 'memory' | 's3';
      store: StudioObjectStore;
      assertReadyBeforeReservation(): Promise<void>;
      close(): Promise<void>;
      privateProviderOrigins: readonly string[];
      allowInsecureLocalEndpoints: boolean;
    };

export function buildStudioApiRuntime(
  env: Record<string, string | undefined> = process.env,
): StudioApiRuntime {
  const adapter = parseStudioAdapterEnvironment(env, { test: env.NODE_ENV === 'test' });
  if (!adapter.enabled) return { enabled: false };
  const store = createStudioObjectStore(adapter, 'api');
  return {
    enabled: true,
    fakeProviderEnabled: adapter.fakeProviderEnabled,
    openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
    storageMode: adapter.storage.mode,
    store,
    assertReadyBeforeReservation: () => store.assertReady(),
    async close() {
      if ('destroy' in store && typeof store.destroy === 'function') store.destroy();
    },
    privateProviderOrigins: adapter.privateProviderOrigins,
    allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
  };
}

export function createDefaultStudioProjectRoutes() {
  const runtime = buildStudioApiRuntime();
  const repository = createDrizzleStudioRepository(db);
  const providerOriginValidator = createStudioProviderOriginValidator({
    resolve: async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((answer) => ({
        address: answer.address,
        family: answer.family === 6 ? 6 : 4,
      })),
    allowPrivateOrigins: new Set(runtime.enabled ? runtime.privateProviderOrigins : []),
    allowInsecureLocalEndpoints: runtime.enabled && runtime.allowInsecureLocalEndpoints,
  });
  return createStudioProjectRoutes({
    repository,
    providerConfigService: new StudioProviderConfigService(repository, {
      validateOrigin: providerOriginValidator,
    }),
    storageService: runtime.enabled
      ? new StudioStorageService({ repository, store: runtime.store })
      : undefined,
    loadProjectForUser,
    assertProjectCapability,
    assertAccountCapability: async (c, userId, accountId, action) => {
      await assertAuthorized(
        userId,
        accountId,
        action,
        undefined,
        c.get('iamTokenId') ?? undefined,
        deriveRequestContext(c),
      );
    },
    estimateSigningSecret: config.API_KEY_SECRET,
  });
}

function createStudioObjectStore(
  adapter: Extract<StudioAdapterEnvironment, { enabled: true }>,
  role: 'api' | 'worker',
): StudioObjectStore {
  if (adapter.storage.mode === 'memory') {
    return new InMemoryStudioObjectStore({ namespace: adapter.storage.namespace, ready: true });
  }
  return createS3StudioObjectStore({ config: adapter.storage, role });
}
