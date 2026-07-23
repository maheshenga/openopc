import { type Database, createDb } from '@kortix/db';
import { RedisClient } from 'bun';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createPostgresApprovalService } from './approval-service';
import { type AutomationControlConfig, loadAutomationControlConfig } from './config';
import {
  type BrowserApprovalResumeRuntimeDependencies,
  createBrowserApprovalResumeRuntime,
} from './dispatch/browser-approval-resume-runtime';
import {
  type BrowserApprovalResumeObservation,
  type BrowserApprovalResumeStore,
  createPostgresBrowserApprovalResumeStore,
} from './dispatch/browser-approval-resume-store';
import { createPostgresBrowserAuthorityStore } from './dispatch/browser-authority-store';
import { createBrowserDispatcher } from './dispatch/browser-dispatcher';
import type { ObservableBrowserWorkerConnection } from './dispatch/browser-worker-connection';
import { createBrowserWorkerRoutes } from './dispatch/browser-worker-routes';
import {
  type ManagedBrowserWorkerConnection,
  createManagedBrowserWorkerConnection,
} from './dispatch/managed-browser-worker-connection';
import {
  type AutomationDispatchPoller,
  type AutomationDispatchPollingRunner,
  composeAutomationDispatchPollingRunner,
  startAutomationDispatchPolling,
} from './dispatch/poller';
import { createPostgresHeartbeatEventSink } from './dispatch/postgres-heartbeat-sink';
import { createAutomationDesktopDispatchRuntime } from './dispatch/runtime';
import type { WorkerRedisCommandClient } from './dispatch/worker-auth';
import {
  type WorkerSecurityRuntime,
  createWorkerSecurityRuntime,
} from './dispatch/worker-security-runtime';
import type { InternalAutomationEnv } from './internal-auth';
import {
  createPostgresKillSwitchService,
  createRedisKillSwitchPublisher,
} from './kill-switch-service';
import { createPostgresLeaseManager, verifyAutomationLeaseSignature } from './lease-manager';
import { createPostgresAutomationRepository } from './repository';
import { createPostgresApprovalRouteStore } from './routes/approvals';
import { createPostgresAutomationEventReader } from './routes/events';
import { createAutomationRoutes } from './routes/index';
import { createPostgresAutomationPolicyStore } from './routes/policies';
import { createPostgresBrowserProfileStore } from './routes/profiles';
import { createAutomationControlApp } from './server';

type MaybePromise<T> = T | Promise<T>;
type AutomationControlApp = Hono<InternalAutomationEnv>;

type DatabaseResource = Readonly<{
  database: Database;
  check(): Promise<boolean>;
  close(): MaybePromise<void>;
}>;

type RedisResource = Readonly<{
  redis: WorkerRedisCommandClient;
  check(): Promise<boolean>;
  close(): MaybePromise<void>;
}>;

type HttpServer = Readonly<{
  port: number;
  stop(closeActiveConnections?: boolean): MaybePromise<void>;
}>;

type TlsBoundBrowserWorkerConnection = Readonly<{
  peer: ObservableBrowserWorkerConnection['peer'];
  connect(): ObservableBrowserWorkerConnection;
}>;

type ManagedConnectionFactoryInput = Parameters<typeof createManagedBrowserWorkerConnection>[0];

export type AutomationControlProductionObservation = Readonly<{
  event:
    | 'automation_control_started'
    | 'automation_browser_runtime_ready'
    | 'automation_browser_runtime_disconnected'
    | 'automation_control_shutdown'
    | 'automation_desktop_coordinator_poll_failed'
    | BrowserApprovalResumeObservation['type'];
  service_id: string;
  occurred_at: string;
  state?: 'ready' | 'disconnected' | 'shutdown';
  enabled?: boolean;
  desktop_coordinator_enabled?: boolean;
  browser_approval_resume_enabled?: boolean;
  port?: number;
  job_id?: string;
  step_id?: string;
  approval_id?: string;
  attempt_id?: string;
  trace_id?: string | null;
  error_code?: string;
}>;

export type AutomationControlProductionDependencies = Readonly<{
  now?: () => Date;
  nextNonce?: () => number;
  createDatabase?: (config: AutomationControlConfig) => MaybePromise<DatabaseResource>;
  createRedis?: (config: AutomationControlConfig) => MaybePromise<RedisResource>;
  createWorkerSecurity?: typeof createWorkerSecurityRuntime;
  createWorkerRoutes?: typeof createBrowserWorkerRoutes;
  createTlsBoundBrowserWorkerConnection?: (input: {
    config: AutomationControlConfig;
    security: WorkerSecurityRuntime;
  }) => MaybePromise<TlsBoundBrowserWorkerConnection>;
  createManagedBrowserWorkerConnection?: (
    input: ManagedConnectionFactoryInput,
  ) => ManagedBrowserWorkerConnection;
  createBrowserApprovalResumeRuntime?: (
    input: BrowserApprovalResumeRuntimeDependencies,
  ) => AutomationDispatchPollingRunner | null;
  composePollingRunner?: typeof composeAutomationDispatchPollingRunner;
  startPoller?: typeof startAutomationDispatchPolling;
  serve?: (app: AutomationControlApp, port: number) => HttpServer;
  scheduleReconnect?: (callback: () => void, delayMs: number) => unknown;
  cancelReconnect?: (handle: unknown) => void;
  observe?: (event: AutomationControlProductionObservation) => void;
}>;

export type AutomationControlProductionRuntime = Readonly<{
  app: AutomationControlApp;
  port: number;
  close(): Promise<void>;
}>;

export type StartAutomationControlProductionRuntimeInput = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: AutomationControlProductionDependencies;
}>;

const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

function defaultNonceSource(): () => number {
  let nonce = Date.now() * 1_000;
  return () => ++nonce;
}

function defaultDatabase(config: AutomationControlConfig): DatabaseResource {
  const database = createDb(config.databaseUrl);
  return {
    database,
    async check() {
      await database.execute(sql`select 1`);
      return true;
    },
    close: () => database.$client.end({ timeout: 5 }),
  };
}

function defaultRedis(config: AutomationControlConfig): RedisResource {
  const client = new RedisClient(config.redisUrl);
  const redis: WorkerRedisCommandClient = {
    send: (command, args) => client.send(command, args),
  };
  return {
    redis,
    async check() {
      if (!client.connected) await client.connect();
      return (await client.ping()) === 'PONG';
    },
    close: () => client.close(),
  };
}

function defaultServe(app: AutomationControlApp, port: number): HttpServer {
  const server = Bun.serve({ hostname: '0.0.0.0', port, fetch: app.fetch });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error('Automation Control HTTP server did not bind a port');
  }
  return { port: server.port, stop: (force) => server.stop(force) };
}

async function boundedCleanup(action: () => MaybePromise<void>): Promise<void> {
  const operation = Promise.resolve()
    .then(action)
    .catch(() => undefined);
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, SHUTDOWN_STEP_TIMEOUT_MS);
    void operation.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function observeResumeEvent(
  event: BrowserApprovalResumeObservation,
  config: AutomationControlConfig,
  emit: (event: AutomationControlProductionObservation) => void,
): void {
  emit({
    event: event.type,
    service_id: config.serviceId,
    occurred_at: event.occurredAt,
    job_id: event.jobId,
    step_id: event.stepId,
    approval_id: event.approvalId,
    attempt_id: event.attemptId,
    trace_id: event.traceId,
    ...(event.reason === undefined ? {} : { error_code: event.reason }),
  });
}

function observableConnection(
  source: ObservableBrowserWorkerConnection,
  onState: (ready: boolean) => void,
): ObservableBrowserWorkerConnection {
  return Object.freeze({
    peer: source.peer,
    state: () => source.state(),
    subscribe(listener: Parameters<ObservableBrowserWorkerConnection['subscribe']>[0]) {
      return source.subscribe((state) => {
        onState(state === 'ready');
        listener(state);
      });
    },
    send: (input: Parameters<ObservableBrowserWorkerConnection['send']>[0]) => source.send(input),
    close: (reason?: string) => source.close(reason),
  });
}

export async function startAutomationControlProductionRuntime(
  input: StartAutomationControlProductionRuntimeInput = {},
): Promise<AutomationControlProductionRuntime> {
  const config = loadAutomationControlConfig(input.environment);
  const dependencies = input.dependencies ?? {};
  if (
    config.browserApprovalResumeEnabled &&
    dependencies.createTlsBoundBrowserWorkerConnection === undefined
  ) {
    throw new Error(
      'Browser Approval Resume requires a TLS-bound Browser Worker peer adapter; Bun WebSocket certificate metadata is unavailable',
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const emit = (event: AutomationControlProductionObservation): void => {
    try {
      dependencies.observe?.(event);
    } catch {
      // Diagnostics cannot change startup, dispatch, or shutdown semantics.
    }
  };
  const observeResume = (event: BrowserApprovalResumeObservation): void =>
    observeResumeEvent(event, config, emit);

  let databaseResource: DatabaseResource | null = null;
  let redisResource: RedisResource | null = null;
  let managedConnection: ManagedBrowserWorkerConnection | null = null;
  let poller: AutomationDispatchPoller | null = null;
  let server: HttpServer | null = null;
  let shuttingDown = false;
  let lastBrowserReady: boolean | null = null;

  const observeBrowserState = (ready: boolean): void => {
    if (!config.browserApprovalResumeEnabled || ready === lastBrowserReady) return;
    const previous = lastBrowserReady;
    lastBrowserReady = ready;
    if (ready) {
      emit({
        event: 'automation_browser_runtime_ready',
        service_id: config.serviceId,
        occurred_at: now().toISOString(),
        state: 'ready',
      });
    } else if (previous === true && !shuttingDown) {
      emit({
        event: 'automation_browser_runtime_disconnected',
        service_id: config.serviceId,
        occurred_at: now().toISOString(),
        state: 'disconnected',
      });
    }
  };

  const cleanup = async (): Promise<void> => {
    shuttingDown = true;
    await boundedCleanup(() => poller?.stop());
    await boundedCleanup(() => managedConnection?.close());
    await boundedCleanup(() => server?.stop(true));
    await boundedCleanup(() => redisResource?.close());
    await boundedCleanup(() => databaseResource?.close());
  };

  try {
    let routes: ReturnType<typeof createAutomationRoutes> | undefined;
    let workerRoutes: ReturnType<typeof createBrowserWorkerRoutes> | undefined;
    let desktopRuntime: AutomationDispatchPollingRunner | null = null;
    let browserResumeRuntime: AutomationDispatchPollingRunner | null = null;

    if (config.enabled) {
      databaseResource = await (dependencies.createDatabase ?? defaultDatabase)(config);
      redisResource = await (dependencies.createRedis ?? defaultRedis)(config);
      const database = databaseResource.database;
      const redis = redisResource.redis;
      const repository = createPostgresAutomationRepository(database);
      const leaseManager = createPostgresLeaseManager(database, config.sharedSecret);
      const killSwitchService = createPostgresKillSwitchService(database, {
        publishers: [createRedisKillSwitchPublisher(redis)],
      });
      const approvalService = createPostgresApprovalService(database, {
        currentGeneration: ({ accountId, projectId }) =>
          killSwitchService.current({ kind: 'project', accountId, projectId }),
      });
      routes = createAutomationRoutes({
        auth: { sharedSecret: config.sharedSecret, allowedServiceIds: ['kortix-api'] },
        repository,
        eventReader: createPostgresAutomationEventReader(database),
        approvalStore: createPostgresApprovalRouteStore(database, approvalService),
        profileStore: createPostgresBrowserProfileStore(database),
        policyStore: createPostgresAutomationPolicyStore(database),
        killSwitchService,
      });

      let security: WorkerSecurityRuntime | null = null;
      let approvalResumeStore: BrowserApprovalResumeStore | null = null;
      if (config.browserHeartbeatEnabled) {
        security = (dependencies.createWorkerSecurity ?? createWorkerSecurityRuntime)({
          config,
          redis,
          nextNonce: dependencies.nextNonce ?? defaultNonceSource(),
          now,
        });
        if (config.browserApprovalResumeEnabled) {
          approvalResumeStore = createPostgresBrowserApprovalResumeStore(database, {
            tokenPepper: config.browserApprovalResumeTokenPepper ?? '',
            observe: observeResume,
          });
        }
        workerRoutes = (dependencies.createWorkerRoutes ?? createBrowserWorkerRoutes)({
          config,
          security,
          leaseManager,
          heartbeatEventSink: createPostgresHeartbeatEventSink(database),
          authorityStore: createPostgresBrowserAuthorityStore(database),
          approvalResumeStore:
            approvalResumeStore ??
            ({
              async consumeAndStart() {
                return { accepted: false, reason: 'credential_invalid' as const };
              },
            } satisfies Pick<BrowserApprovalResumeStore, 'consumeAndStart'>),
          now,
        });
      }

      if (config.browserApprovalResumeEnabled) {
        if (security === null || approvalResumeStore === null) {
          throw new Error('Browser Approval Resume production resources are incomplete');
        }
        const tlsBound = await dependencies.createTlsBoundBrowserWorkerConnection?.({
          config,
          security,
        });
        if (tlsBound === undefined) {
          throw new Error('TLS-bound Browser Worker peer adapter did not create a connection');
        }
        security.authenticator.assertPeer(tlsBound.peer, 'browser-worker');
        const createManaged =
          dependencies.createManagedBrowserWorkerConnection ?? createManagedBrowserWorkerConnection;
        managedConnection = createManaged({
          peer: tlsBound.peer,
          connect: () => observableConnection(tlsBound.connect(), observeBrowserState),
          schedule:
            dependencies.scheduleReconnect ??
            ((callback, delayMs) => setTimeout(callback, delayMs)),
          cancel:
            dependencies.cancelReconnect ??
            ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
          initialBackoffMs: 250,
          maxBackoffMs: 5_000,
        });
        const dispatcher = createBrowserDispatcher({
          authenticator: security.authenticator,
          signer: security.signer,
          now,
          isLeaseSignatureValid: async (lease) =>
            verifyAutomationLeaseSignature(lease, config.sharedSecret),
          isLeaseCurrent: (binding) => leaseManager.isCurrent(binding.jobId, binding.owner, now()),
        });
        browserResumeRuntime = (
          dependencies.createBrowserApprovalResumeRuntime ?? createBrowserApprovalResumeRuntime
        )({
          config,
          store: approvalResumeStore,
          leaseManager,
          dispatcher,
          connection: managedConnection,
          now,
          observe: observeResume,
        });
        if (browserResumeRuntime === null) {
          throw new Error('Enabled Browser Approval Resume coordinator was not composed');
        }
      }

      desktopRuntime = createAutomationDesktopDispatchRuntime({
        config,
        repository,
        leaseManager,
        now,
      });
      const runners = (dependencies.composePollingRunner ?? composeAutomationDispatchPollingRunner)(
        {
          desktop: desktopRuntime,
          browserApprovalResume: browserResumeRuntime,
        },
      );
      poller = runners
        ? (dependencies.startPoller ?? startAutomationDispatchPolling)({
            coordinator: runners,
            intervalMs: config.coordinatorPollMs,
            onError: (failure) =>
              emit({
                event: failure.event,
                service_id: config.serviceId,
                occurred_at: now().toISOString(),
                error_code: 'poll_failed',
              }),
          })
        : null;
    }

    const app = createAutomationControlApp({
      config,
      checkDatabase: () => databaseResource?.check() ?? Promise.resolve(false),
      checkRedis: () => redisResource?.check() ?? Promise.resolve(false),
      checkBrowserRuntime: async () => {
        const ready = !shuttingDown && poller !== null && (managedConnection?.isReady() ?? false);
        observeBrowserState(ready);
        return ready;
      },
      routes,
      workerRoutes,
    });
    server = (dependencies.serve ?? defaultServe)(app, config.port);
    emit({
      event: 'automation_control_started',
      service_id: config.serviceId,
      occurred_at: now().toISOString(),
      enabled: config.enabled,
      desktop_coordinator_enabled: config.desktopCoordinatorEnabled,
      browser_approval_resume_enabled: config.browserApprovalResumeEnabled,
      port: server.port,
    });
    if (config.browserApprovalResumeEnabled) {
      observeBrowserState(managedConnection?.isReady() ?? false);
    }

    let closePromise: Promise<void> | null = null;
    return Object.freeze({
      app,
      port: server.port,
      close(): Promise<void> {
        closePromise ??= (async () => {
          await cleanup();
          emit({
            event: 'automation_control_shutdown',
            service_id: config.serviceId,
            occurred_at: now().toISOString(),
            state: 'shutdown',
          });
        })();
        return closePromise;
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
