import {
  createS3StudioObjectStore,
  parseStudioAdapterEnvironment,
  type StudioAdapterEnvironment,
} from '@kortix/studio-adapters';
import { InMemoryStudioObjectStore, type StudioObjectStore } from '@kortix/studio-runtime';

export type StudioWorkerRuntime =
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

export function buildStudioWorkerRuntime(
  env: Record<string, string | undefined> = process.env,
): StudioWorkerRuntime {
  const adapter = parseStudioAdapterEnvironment(env, { test: env.NODE_ENV === 'test' });
  if (!adapter.enabled) return { enabled: false };
  const store = createStudioObjectStore(adapter, 'worker');
  return {
    enabled: true,
    fakeProviderEnabled: adapter.fakeProviderEnabled,
    openAiCompatibleEnabled: adapter.openAiCompatibleEnabled,
    storageMode: adapter.storage.mode,
    privateProviderOrigins: adapter.privateProviderOrigins,
    allowInsecureLocalEndpoints: adapter.allowInsecureLocalEndpoints,
    store,
    assertReadyBeforeClaim: () => store.assertReady(),
    async close() {
      if ('destroy' in store && typeof store.destroy === 'function') store.destroy();
    },
  };
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
