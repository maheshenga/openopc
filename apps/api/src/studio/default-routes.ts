import { lookup } from 'node:dns/promises';
import type { Database } from '@kortix/db';
import {
  type StudioAdapterEnvironment,
  createS3StudioObjectStore,
  parseStudioAdapterEnvironment,
} from '@kortix/studio-adapters';
import { InMemoryStudioObjectStore, type StudioObjectStore } from '@kortix/studio-runtime';
import { config } from '../config';
import { deriveRequestContext } from '../iam/cache';
import { assertAuthorized } from '../iam/dispatcher';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { createStudioCredentialBindingExists } from './credential-existence';
import {
  type StudioCredentialBindingExists,
  type StudioProjectRouteDeps,
  createStudioProjectRoutes,
} from './index';
import { StudioProviderConfigService, createStudioProviderOriginValidator } from './providers';
import { type StudioRecoveryRepository, StudioRecoveryService } from './recovery';
import {
  createDrizzleStudioRecoveryRepository,
  createDrizzleStudioRepository,
} from './repositories/drizzle';
import { StudioStorageService } from './storage';
import { type StudioRepository, StudioRepositoryError } from './types';

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

export type StudioApiRuntimeOptions = {
  createObjectStore?: (
    adapter: Extract<StudioAdapterEnvironment, { enabled: true }>,
    role: 'api',
  ) => StudioObjectStore;
};

let defaultStudioApiRuntime: StudioApiRuntime | null = null;

export function buildStudioApiRuntime(
  env: Record<string, string | undefined> = process.env,
  options: StudioApiRuntimeOptions = {},
): StudioApiRuntime {
  const adapter = parseStudioAdapterEnvironment(env, { test: env.NODE_ENV === 'test' });
  if (!adapter.enabled) return { enabled: false };
  const store = (options.createObjectStore ?? createStudioObjectStore)(adapter, 'api');
  return {
    enabled: true,
    fakeProviderEnabled: adapter.fakeProviderEnabled,
    openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
    storageMode: adapter.storage.mode,
    store,
    assertReadyBeforeReservation: () => store.assertReady(),
    close: createIdempotentClose(() => closeStudioObjectStore(store)),
    privateProviderOrigins: adapter.privateProviderOrigins,
    allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
  };
}

export function getDefaultStudioApiRuntime(
  env: Record<string, string | undefined> = process.env,
  options: StudioApiRuntimeOptions = {},
): StudioApiRuntime {
  defaultStudioApiRuntime ??= buildStudioApiRuntime(env, options);
  return defaultStudioApiRuntime;
}

export async function closeDefaultStudioApiRuntime(): Promise<void> {
  if (defaultStudioApiRuntime?.enabled) await defaultStudioApiRuntime.close();
}

type StudioProviderEnablement = {
  fakeProviderEnabled: boolean;
  openAiCompatibleEnabled: boolean;
};

export type DefaultStudioProjectRoutesInput = {
  env?: Record<string, string | undefined>;
  runtime?: StudioApiRuntime;
  database?: Database;
  repository?: StudioRepository;
  recoveryRepository?: StudioRecoveryRepository;
  credentialBindingExists?: StudioCredentialBindingExists;
  loadProjectForUser?: NonNullable<StudioProjectRouteDeps['loadProjectForUser']>;
  assertProjectCapability?: NonNullable<StudioProjectRouteDeps['assertProjectCapability']>;
  assertAccountCapability?: NonNullable<StudioProjectRouteDeps['assertAccountCapability']>;
  resolveProviderHostname?: (
    hostname: string,
  ) => Promise<readonly { address: string; family: 4 | 6 }[]>;
};

export function createDefaultStudioProjectRoutes(input: DefaultStudioProjectRoutesInput = {}) {
  const runtime =
    input.runtime ??
    (Object.keys(input).length === 0
      ? getDefaultStudioApiRuntime()
      : buildStudioApiRuntime(input.env));
  const database = input.database ?? db;
  const defaultRepository = input.repository
    ? input.repository
    : Object.assign(
        createDrizzleStudioRepository(database),
        createDrizzleStudioRecoveryRepository(database),
      );
  const repository = createProviderEnabledRepository(defaultRepository, {
    fakeProviderEnabled: runtime.enabled && runtime.fakeProviderEnabled,
    openAiCompatibleEnabled: runtime.enabled && runtime.openAiCompatibleEnabled,
  });
  const recoveryRepository = input.recoveryRepository ?? recoveryRepositoryFrom(defaultRepository);
  const providerOriginValidator = createStudioProviderOriginValidator({
    resolve:
      input.resolveProviderHostname ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map((answer) => ({
          address: answer.address,
          family: answer.family === 6 ? 6 : 4,
        }))),
    allowPrivateOrigins: new Set(runtime.enabled ? runtime.privateProviderOrigins : []),
    allowInsecureLocalEndpoints: runtime.enabled && runtime.allowInsecureLocalEndpoints,
  });
  return createStudioProjectRoutes({
    repository,
    providerConfigService: runtime.enabled
      ? new StudioProviderConfigService(defaultRepository, {
          validateOrigin: providerOriginValidator,
        })
      : undefined,
    storageService: runtime.enabled
      ? new StudioStorageService({ repository: defaultRepository, store: runtime.store })
      : undefined,
    recoveryService:
      runtime.enabled && recoveryRepository
        ? new StudioRecoveryService({ repository: recoveryRepository, store: runtime.store })
        : undefined,
    credentialBindingExists: runtime.enabled
      ? (input.credentialBindingExists ?? createStudioCredentialBindingExists(database))
      : undefined,
    loadProjectForUser: input.loadProjectForUser ?? loadProjectForUser,
    assertProjectCapability: input.assertProjectCapability ?? assertProjectCapability,
    assertAccountCapability:
      input.assertAccountCapability ??
      (async (c, userId, accountId, action) => {
        await assertAuthorized(
          userId,
          accountId,
          action,
          undefined,
          c.get('iamTokenId') ?? undefined,
          deriveRequestContext(c),
        );
      }),
    estimateSigningSecret: config.API_KEY_SECRET,
  });
}

function recoveryRepositoryFrom(repository: StudioRepository): StudioRecoveryRepository | null {
  const candidate = repository as StudioRepository & Partial<StudioRecoveryRepository>;
  return typeof candidate.recoverLocked === 'function'
    ? (candidate as StudioRepository & StudioRecoveryRepository)
    : null;
}

function providerIsEnabled(provider: string, enablement: StudioProviderEnablement): boolean {
  if (provider === 'fake') return enablement.fakeProviderEnabled;
  if (provider === 'openai-compatible') return enablement.openAiCompatibleEnabled;
  return false;
}

function createProviderEnabledRepository(
  repository: StudioRepository,
  enablement: StudioProviderEnablement,
): StudioRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'listProviders') {
        return async (projectId: string) =>
          (await target.listProviders(projectId)).filter((provider) =>
            providerIsEnabled(provider.provider, enablement),
          );
      }
      if (property === 'getProvider') {
        return async (projectId: string, providerConfigId: string) => {
          const provider = await target.getProvider(projectId, providerConfigId);
          return provider && providerIsEnabled(provider.provider, enablement) ? provider : null;
        };
      }
      if (property === 'getProviderConfigRecord') {
        return async (accountId: string, projectId: string, providerConfigId: string) => {
          const provider = await target.getProviderConfigRecord(
            accountId,
            projectId,
            providerConfigId,
          );
          return provider && providerIsEnabled(provider.provider, enablement) ? provider : null;
        };
      }
      if (property === 'createJob') {
        return async (...args: Parameters<StudioRepository['createJob']>) => {
          if (!providerIsEnabled(args[1].provider, enablement)) {
            throw new StudioRepositoryError(
              'STUDIO_PROVIDER_CONFIG_STALE',
              409,
              'Studio provider configuration is stale',
            );
          }
          return target.createJob(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
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

function createIdempotentClose(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= Promise.resolve().then(close);
    return closing;
  };
}

async function closeStudioObjectStore(store: StudioObjectStore): Promise<void> {
  if ('destroy' in store && typeof store.destroy === 'function') {
    await store.destroy();
  }
}
