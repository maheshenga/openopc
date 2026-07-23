import { lookup } from 'node:dns/promises';
import type { Database } from '@kortix/db';
import {
  type StudioAdapterEnvironment,
  createS3StudioObjectStore,
  parseStudioAdapterEnvironment,
} from '@kortix/studio-adapters';
import { InMemoryStudioObjectStore, type StudioObjectStore } from '@kortix/studio-runtime';
import { config } from '../config';
import type { ExecutorPrincipal } from '../executor/router';
import { deriveRequestContext } from '../iam/cache';
import { assertAuthorized } from '../iam/dispatcher';
import { buildProjectAgentCard } from '../intelligence/agent-cards';
import {
  type CatalogExecutorSource,
  type ProjectCapabilityCatalogPort,
  createExecutorCatalogSource,
  createProjectCapabilityCatalog,
} from '../intelligence/capability-catalog';
import { createProjectCapabilityRegistry } from '../intelligence/capability-registry';
import {
  type AgentTrustSource,
  type IntelligenceCapabilityRegistry,
  type IntelligenceProjectRouteDeps,
  type IntelligenceTaskEventReader,
  type StudioTaskExecutor,
  createIntelligenceProjectRoutes,
} from '../intelligence/project-routes';
import {
  IntelligenceTaskService,
  createDrizzleIntelligenceTaskStore,
  createStudioJobBridge,
} from '../intelligence/task-service';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { db, hasDatabase } from '../shared/db';
import { createStudioCredentialBindingExists } from './credential-existence';
import {
  type StudioCredentialBindingExists,
  type StudioProjectRouteDeps,
  createStudioProjectRoutes,
} from './index';
import {
  type StudioTelemetry,
  applicationStudioTelemetry,
  instrumentStudioObjectStore,
} from './metrics';
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
      telemetry?: StudioTelemetry;
      assertReadyBeforeReservation(): Promise<void>;
      close(): Promise<void>;
      privateProviderOrigins: readonly string[];
      allowInsecureLocalEndpoints: boolean;
    };

export type StudioApiRuntimeOptions = {
  telemetry?: StudioTelemetry;
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
  const rawStore = (options.createObjectStore ?? createStudioObjectStore)(adapter, 'api');
  const store = options.telemetry
    ? instrumentStudioObjectStore(rawStore, 'api', options.telemetry)
    : rawStore;
  return {
    enabled: true,
    fakeProviderEnabled: adapter.fakeProviderEnabled,
    openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
    storageMode: adapter.storage.mode,
    store,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    assertReadyBeforeReservation: () => store.assertReady(),
    close: createIdempotentClose(() => closeStudioObjectStore(rawStore)),
    privateProviderOrigins: adapter.privateProviderOrigins,
    allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
  };
}

export function getDefaultStudioApiRuntime(
  env: Record<string, string | undefined> = process.env,
  options: StudioApiRuntimeOptions = {},
): StudioApiRuntime {
  defaultStudioApiRuntime ??= buildStudioApiRuntime(env, {
    ...options,
    telemetry: options.telemetry ?? applicationStudioTelemetry,
  });
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
  telemetry?: StudioTelemetry;
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

export type DefaultIntelligenceProjectRoutesInput = {
  env?: Record<string, string | undefined>;
  telemetry?: StudioTelemetry;
  runtime?: StudioApiRuntime;
  database?: Database;
  repository?: StudioRepository;
  credentialBindingExists?: StudioCredentialBindingExists;
  loadProjectForUser?: IntelligenceProjectRouteDeps['loadProjectForUser'];
  assertProjectCapability?: IntelligenceProjectRouteDeps['assertProjectCapability'];
  capabilityRegistry?: IntelligenceCapabilityRegistry;
  executorCatalogSource?: CatalogExecutorSource;
  capabilityCatalog?: ProjectCapabilityCatalogPort;
  getAgentCard?: IntelligenceProjectRouteDeps['getAgentCard'];
  taskExecutor?: StudioTaskExecutor;
  taskEventReader?: IntelligenceTaskEventReader;
  taskService?: IntelligenceTaskService;
  agentTrustSource?: AgentTrustSource;
};

type DefaultStudioFoundationInput = {
  env?: Record<string, string | undefined>;
  telemetry?: StudioTelemetry;
  runtime?: StudioApiRuntime;
  database?: Database;
  repository?: StudioRepository;
};

export function createDefaultStudioProjectRoutes(input: DefaultStudioProjectRoutesInput = {}) {
  const { runtime, database, defaultRepository, repository } = assembleStudioRouteFoundation(input);
  const telemetry = runtime.enabled ? (runtime.telemetry ?? input.telemetry) : input.telemetry;
  const store =
    runtime.enabled && telemetry && !runtime.telemetry
      ? instrumentStudioObjectStore(runtime.store, 'api', telemetry)
      : runtime.enabled
        ? runtime.store
        : null;
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
    storageService: store
      ? new StudioStorageService({
          repository: defaultRepository,
          store,
        })
      : undefined,
    recoveryService:
      store && recoveryRepository
        ? new StudioRecoveryService({
            repository: recoveryRepository,
            store,
            ...(telemetry ? { telemetry } : {}),
          })
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
    ...(telemetry ? { telemetry } : {}),
  });
}

export function createDefaultIntelligenceProjectRoutes(
  input: DefaultIntelligenceProjectRoutesInput = {},
) {
  const { runtime, database, repository } = assembleStudioRouteFoundation(input, {
    preferDefaultRuntime: true,
  });
  const credentialBindingExists = runtime.enabled
    ? (input.credentialBindingExists ?? createStudioCredentialBindingExists(database))
    : undefined;
  const capabilityRegistry =
    input.capabilityRegistry ??
    createProjectCapabilityRegistry({
      repository,
      isStorageReady: async () => {
        if (!runtime.enabled) return false;
        try {
          await runtime.assertReadyBeforeReservation();
          return true;
        } catch {
          return false;
        }
      },
      credentialBindingExists,
    });
  const executorCatalogSource = input.executorCatalogSource ?? createDefaultExecutorCatalogSource();
  const capabilityCatalog =
    input.capabilityCatalog ??
    createProjectCapabilityCatalog({ capabilityRegistry, executorSource: executorCatalogSource });

  let taskExecutor = input.taskExecutor;
  let taskEventReader = input.taskEventReader;
  if (!taskExecutor && !taskEventReader && input.taskService) {
    taskExecutor = {
      replay: input.taskService.replay.bind(input.taskService),
      create: input.taskService.create.bind(input.taskService),
    };
    taskEventReader = {
      findByJob: input.taskService.findByJob.bind(input.taskService),
      read: input.taskService.events.bind(input.taskService),
    };
  } else if (
    !taskExecutor &&
    !taskEventReader &&
    runtime.enabled &&
    (input.database !== undefined || hasDatabase) &&
    isDatabaseLike(database)
  ) {
    const service = new IntelligenceTaskService({
      store: createDrizzleIntelligenceTaskStore(database),
      createStudioJob: createStudioJobBridge({
        repository,
        assertReadyBeforeReservation: runtime.assertReadyBeforeReservation,
        credentialBindingExists,
        estimateSigningSecret: config.API_KEY_SECRET,
      }),
      readStudioEvents: async ({ projectId, jobId, cursor }) =>
        repository.listEvents(projectId, jobId, cursor),
    });
    taskExecutor = {
      replay: service.replay.bind(service),
      create: service.create.bind(service),
    };
    taskEventReader = {
      findByJob: service.findByJob.bind(service),
      read: service.events.bind(service),
    };
  }

  return createIntelligenceProjectRoutes({
    capabilityRegistry,
    capabilityCatalog,
    getAgentCard:
      input.getAgentCard ??
      (async ({ projectId, capabilities }) =>
        buildProjectAgentCard({
          projectId,
          agentId: 'kortix-studio',
          displayName: 'Kortix Studio',
          capabilities,
          protocols: ['mcp', 'a2a'],
          authKind: 'kortix-project-token',
          trustTier: 'project',
        })),
    loadProjectForUser: input.loadProjectForUser ?? loadProjectForUser,
    assertProjectCapability: input.assertProjectCapability ?? assertProjectCapability,
    ...(taskExecutor ? { taskExecutor } : {}),
    ...(taskEventReader ? { taskEventReader } : {}),
    ...(input.agentTrustSource ? { agentTrustSource: input.agentTrustSource } : {}),
  });
}

function createDefaultExecutorCatalogSource(): CatalogExecutorSource {
  let source: CatalogExecutorSource | null = null;
  return {
    async list(projectId, actor, _requestContext) {
      if (!source) {
        const [{ dbExecutorRouterDeps }, { resolveShareSubject }] = await Promise.all([
          import('../executor/db-deps'),
          import('../executor/share'),
        ]);
        source = createExecutorCatalogSource<ExecutorPrincipal>({
          // The intelligence project route already resolved the project and IAM scope.
          // Passing raw Hono context here would confuse an IdP login session with an
          // Executor project session and hide otherwise usable connectors.
          async resolveProjectPrincipal(catalogActor, scopedProjectId) {
            return {
              accountId: catalogActor.accountId,
              userId: catalogActor.userId,
              projectId: scopedProjectId,
              sessionId: catalogActor.sessionId ?? null,
              subject: await resolveShareSubject(catalogActor.userId),
              agentGrant: catalogActor.agentGrant ?? null,
            };
          },
          listCatalog: dbExecutorRouterDeps.listCatalog,
        });
      }
      return source.list(projectId, actor);
    },
  };
}

function isDatabaseLike(value: unknown): value is Database {
  if (!value || typeof value !== 'object') return false;
  try {
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.insert === 'function' &&
      typeof candidate.select === 'function' &&
      typeof candidate.transaction === 'function'
    );
  } catch {
    return false;
  }
}

function assembleStudioRouteFoundation(
  input: DefaultStudioFoundationInput,
  options: { preferDefaultRuntime?: boolean } = {},
) {
  const useDefaultRuntime = options.preferDefaultRuntime
    ? input.runtime === undefined && input.env === undefined && input.telemetry === undefined
    : Object.keys(input).length === 0;
  const runtime =
    input.runtime ??
    (useDefaultRuntime
      ? getDefaultStudioApiRuntime()
      : buildStudioApiRuntime(input.env, { telemetry: input.telemetry }));
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
  return { runtime, database, defaultRepository, repository };
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
