import { createS3StudioObjectStore } from '@kortix/studio-adapters';
import { createBrowserApprovalResumeClient } from './approval-resume-client';
import { createBrowserAuthorityClient } from './authority-client';
import {
  type BrowserWorkerDispatchConfig,
  browserWorkerConfig,
  loadBrowserWorkerDispatchConfig,
  loadBrowserWorkerEvidenceConfig,
  loadBrowserWorkerHeartbeatConfig,
} from './config';
import {
  type BrowserDispatchWorkItem,
  createBrowserWorkerDispatchSource,
  startBrowserWorkerDispatchServer,
} from './dispatch-source';
import { createStudioBrowserEvidenceStore } from './evidence-store';
import { executeBrowserDispatchWorkItem } from './execution-bindings';
import {
  createBrowserWorkerHeartbeatClient,
  createBrowserWorkerMtlsHeartbeatTransport,
} from './heartbeat-client';
import { createRuntimeIsolationAttestor } from './runtime-isolation';
import { runBrowserWorkerLoop, startFailClosedWorkerServer } from './worker';
import {
  createWorkerControlClient,
  createWorkerControlMtlsTransport,
  createWorkerProofNonceSource,
} from './worker-control-client';

type RuntimeServer = Readonly<{
  server: Readonly<{ url: string | URL }>;
  close(): Promise<void>;
}>;

type WorkerProductionResources = Readonly<{
  dispatchSource: ReturnType<typeof createBrowserWorkerDispatchSource>;
  objectStore: Readonly<{ assertReady(): Promise<void>; close(): Promise<void> }>;
  isolation: Readonly<{ attest(): Promise<boolean> }>;
  dependenciesReady(): boolean;
  onDependenciesChanged?(listener: () => void): void;
  execute(workItem: BrowserDispatchWorkItem): Promise<unknown>;
}>;

export type BrowserWorkerProductionObservation = Readonly<{
  event:
    | 'automation_browser_worker_started'
    | 'automation_browser_worker_ready'
    | 'automation_browser_worker_disconnected'
    | 'automation_browser_worker_shutdown';
}>;

export type BrowserWorkerProductionDependencies = Readonly<{
  startDisabledServer(): RuntimeServer;
  createResources(
    config: Extract<BrowserWorkerDispatchConfig, { enabled: true }>,
    input: Readonly<{
      dispatchReceiptNonce: () => number;
      heartbeatNonce: () => number;
      controlRequestNonce: () => number;
      onReadinessChange: (ready: boolean) => void;
    }>,
  ): Promise<WorkerProductionResources>;
  startDispatchServer(input: {
    config: Extract<BrowserWorkerDispatchConfig, { enabled: true }>;
    runtime: ReturnType<typeof createBrowserWorkerDispatchSource>;
    isExecutionReady: () => boolean;
  }): RuntimeServer;
  observe(event: BrowserWorkerProductionObservation): void;
}>;

export type BrowserWorkerProductionRuntime = Readonly<{
  origin: string;
  close(): Promise<void>;
}>;

export type StartBrowserWorkerProductionRuntimeInput = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: BrowserWorkerProductionDependencies;
}>;

function closeObjectStore(store: { destroy?: () => void }): Promise<void> {
  return Promise.resolve().then(() => store.destroy?.());
}

async function closeEnabledResources(input: {
  controller?: AbortController;
  loop?: Promise<void>;
  resources: WorkerProductionResources;
  server?: RuntimeServer;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void> | void): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  input.controller?.abort('Browser Worker shutting down');
  if (input.loop !== undefined) await attempt(() => input.loop?.then(() => undefined));
  await attempt(() => input.resources.dispatchSource.close('Browser Worker shutting down'));
  if (input.server !== undefined) await attempt(() => input.server?.close());
  await attempt(() => input.resources.objectStore.close());
  return failures;
}

function defaultDependencies(
  environment: Readonly<Record<string, string | undefined>>,
): BrowserWorkerProductionDependencies {
  return {
    startDisabledServer() {
      const server = startFailClosedWorkerServer();
      return {
        server,
        close: async () => {
          server.stop(true);
        },
      };
    },
    async createResources(config, input) {
      const evidenceConfig = loadBrowserWorkerEvidenceConfig(environment);
      const heartbeatConfig = loadBrowserWorkerHeartbeatConfig(environment);
      if (!evidenceConfig.enabled || !heartbeatConfig.enabled) {
        throw new Error('Browser Worker production dependencies are disabled');
      }
      const rawStore = createS3StudioObjectStore({
        config: evidenceConfig.storage,
        role: 'worker',
      });
      const isolation = createRuntimeIsolationAttestor({
        expectedCpuSeconds: browserWorkerConfig.maxCpuSeconds,
        expectedMemoryMb: browserWorkerConfig.maxMemoryMb,
      });
      const dispatchSource = createBrowserWorkerDispatchSource({
        config,
        nextNonce: input.dispatchReceiptNonce,
        onReadinessChange: input.onReadinessChange,
      });
      const heartbeat = createBrowserWorkerHeartbeatClient({
        controlUrl: heartbeatConfig.controlUrl,
        serviceId: heartbeatConfig.serviceId,
        certificateFingerprint256: heartbeatConfig.certificateFingerprint256,
        sharedSecret: heartbeatConfig.sharedSecret,
        intervalMs: heartbeatConfig.intervalMs,
        requestTimeoutMs: heartbeatConfig.requestTimeoutMs,
        transport: createBrowserWorkerMtlsHeartbeatTransport(heartbeatConfig),
        nextNonce: input.heartbeatNonce,
      });
      const control = createWorkerControlClient({
        controlUrl: heartbeatConfig.controlUrl,
        serviceId: heartbeatConfig.serviceId,
        certificateFingerprint256: heartbeatConfig.certificateFingerprint256,
        sharedSecret: heartbeatConfig.sharedSecret,
        requestTimeoutMs: heartbeatConfig.requestTimeoutMs,
        transport: createWorkerControlMtlsTransport(heartbeatConfig),
        nextNonce: input.controlRequestNonce,
      });
      const authority = createBrowserAuthorityClient({ client: control });
      const approvalClient = createBrowserApprovalResumeClient({
        controlUrl: heartbeatConfig.controlUrl,
        serviceId: heartbeatConfig.serviceId,
        certificateFingerprint256: heartbeatConfig.certificateFingerprint256,
        sharedSecret: heartbeatConfig.sharedSecret,
        requestTimeoutMs: heartbeatConfig.requestTimeoutMs,
        transport: createWorkerControlMtlsTransport(heartbeatConfig),
        nextNonce: input.controlRequestNonce,
      });
      return {
        dispatchSource,
        objectStore: {
          assertReady: () => rawStore.assertReady(),
          close: () => closeObjectStore(rawStore),
        },
        isolation,
        dependenciesReady: () => true,
        execute: (workItem) =>
          executeBrowserDispatchWorkItem({
            workItem,
            authority,
            isolation,
            approvalClient,
            evidenceStore: createStudioBrowserEvidenceStore(rawStore),
            eventEmitter: heartbeat,
            heartbeat,
          }),
      };
    },
    startDispatchServer(input) {
      return startBrowserWorkerDispatchServer({
        port: browserWorkerConfig.port,
        config: input.config,
        runtime: input.runtime,
        isExecutionReady: input.isExecutionReady,
      });
    },
    observe() {},
  };
}

function disabledRuntime(
  dependencies: BrowserWorkerProductionDependencies,
): BrowserWorkerProductionRuntime {
  const server = dependencies.startDisabledServer();
  let closePromise: Promise<void> | undefined;
  return {
    origin: server.server.url.toString(),
    close() {
      closePromise ??= server.close();
      return closePromise;
    },
  };
}

export async function startBrowserWorkerProductionRuntime(
  input: StartBrowserWorkerProductionRuntimeInput = {},
): Promise<BrowserWorkerProductionRuntime> {
  const environment = input.environment ?? process.env;
  const config = loadBrowserWorkerDispatchConfig(environment);
  const dependencies = input.dependencies ?? defaultDependencies(environment);
  if (!config.enabled) return disabledRuntime(dependencies);

  const nextNonce = createWorkerProofNonceSource();
  let loopReady = true;
  let observedReady = false;
  let resources: WorkerProductionResources | undefined;
  const observeReadiness = (): void => {
    const ready =
      resources?.dispatchSource.isReady() === true && loopReady && resources.dependenciesReady();
    if (ready === observedReady) return;
    observedReady = ready;
    dependencies.observe({
      event: ready ? 'automation_browser_worker_ready' : 'automation_browser_worker_disconnected',
    });
  };
  resources = await dependencies.createResources(config, {
    dispatchReceiptNonce: nextNonce,
    heartbeatNonce: nextNonce,
    controlRequestNonce: nextNonce,
    onReadinessChange: observeReadiness,
  });
  resources.onDependenciesChanged?.(observeReadiness);
  try {
    await resources.objectStore.assertReady();
    if (!(await resources.isolation.attest()))
      throw new Error('Browser runtime isolation is invalid');
  } catch (error) {
    await closeEnabledResources({ resources });
    throw error;
  }
  const controller = new AbortController();
  const loop = runBrowserWorkerLoop({
    source: resources.dispatchSource.source,
    signal: controller.signal,
    execute: (workItem) => resources.execute(workItem).then(() => undefined),
  }).catch((error) => {
    loopReady = false;
    observeReadiness();
    resources.dispatchSource.close('Browser execution loop failed');
    throw error;
  });
  void loop.catch(() => undefined);
  let server: RuntimeServer;
  try {
    server = dependencies.startDispatchServer({
      config,
      runtime: resources.dispatchSource,
      isExecutionReady: () => loopReady && resources.dependenciesReady(),
    });
  } catch (error) {
    await closeEnabledResources({ controller, loop, resources });
    throw error;
  }
  dependencies.observe({ event: 'automation_browser_worker_started' });

  let closePromise: Promise<void> | undefined;
  return {
    origin: server.server.url.toString(),
    close() {
      closePromise ??= (async () => {
        const failures = await closeEnabledResources({ controller, loop, resources, server });
        dependencies.observe({ event: 'automation_browser_worker_shutdown' });
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, 'Browser Worker shutdown failed');
      })();
      return closePromise;
    },
  };
}
