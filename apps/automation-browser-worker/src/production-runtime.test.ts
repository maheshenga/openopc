import { expect, test } from 'bun:test';

const fullyEnabledEnvironment = {
  AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
  AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
  AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
  AUTOMATION_CONTROL_SERVICE_ID: 'automation-control',
  AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: 'control-fingerprint',
  AUTOMATION_CONTROL_WORKER_SHARED_SECRET: 'c'.repeat(32),
  AUTOMATION_BROWSER_SERVICE_ID: 'automation-browser',
  AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256: 'browser-fingerprint',
  AUTOMATION_BROWSER_WORKER_SHARED_SECRET: 'b'.repeat(32),
  AUTOMATION_BROWSER_TLS_ATTESTATION_SECRET: 't'.repeat(32),
};

function responseServer(input: { ready: () => boolean; closed: string[]; label: string }) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const ready = input.ready();
      if (new URL(request.url).pathname === '/ready') {
        return Response.json(
          { status: ready ? 'ready' : 'waiting' },
          { status: ready ? 200 : 503 },
        );
      }
      return Response.json({ status: 'waiting' }, { status: 503 });
    },
  });
  return {
    server,
    close: async () => {
      input.closed.push(input.label);
      server.stop(true);
    },
  };
}

function runtimeHarness() {
  const created: string[] = [];
  const closed: string[] = [];
  const observations: Array<{ event: string }> = [];
  let authenticated = false;
  let transition: ((ready: boolean) => void) | undefined;
  const dispatchSource = {
    source: {
      next: (signal: AbortSignal) =>
        new Promise<null>((resolve) => {
          const onAbort = () => {
            closed.push('worker-loop');
            resolve(null);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      acknowledge: async () => undefined,
      reject: async () => undefined,
    },
    isReady: () => authenticated,
    connectAuthenticatedControl() {
      authenticated = true;
      transition?.(true);
    },
    disconnectControl() {
      authenticated = false;
      transition?.(false);
    },
    close: () => {
      closed.push('dispatch-source');
    },
  };
  const dependencies = {
    startDisabledServer: () => {
      created.push('fail-closed-server');
      return responseServer({ ready: () => false, closed, label: 'server' });
    },
    createResources: async (
      _config: unknown,
      input: { onReadinessChange: (ready: boolean) => void },
    ) => {
      created.push('resources');
      transition = input.onReadinessChange;
      return {
        dispatchSource,
        objectStore: {
          assertReady: async () => undefined,
          close: async () => {
            closed.push('object-store');
          },
        },
        isolation: { attest: async () => true },
        dependenciesReady: () => true,
        execute: async () => undefined,
      };
    },
    startDispatchServer: (input: { isExecutionReady: () => boolean }) => {
      created.push('server');
      return responseServer({
        ready: () => dispatchSource.isReady() && input.isExecutionReady(),
        closed,
        label: 'server',
      });
    },
    observe: (event: { event: string }) => observations.push(event),
  };
  return { created, closed, observations, dispatchSource, dependencies };
}

test('starts fail closed by default', async () => {
  const module = await import('./production-runtime').catch(() => ({}));
  const runtimeModule = module as {
    startBrowserWorkerProductionRuntime?: (input: unknown) => Promise<{
      origin: string;
      close(): Promise<void>;
    }>;
  };
  expect(typeof runtimeModule.startBrowserWorkerProductionRuntime).toBe('function');
  if (typeof runtimeModule.startBrowserWorkerProductionRuntime !== 'function') return;

  const harness = runtimeHarness();
  const disabled = await runtimeModule.startBrowserWorkerProductionRuntime({
    environment: {},
    dependencies: harness.dependencies,
  });
  try {
    expect((await fetch(`${disabled.origin}/ready`)).status).toBe(503);
    expect(harness.created).toEqual(['fail-closed-server']);
  } finally {
    await disabled.close();
  }
});

test('becomes ready only for an authenticated control session and shuts down idempotently', async () => {
  const module = await import('./production-runtime').catch(() => ({}));
  const runtimeModule = module as {
    startBrowserWorkerProductionRuntime?: (input: unknown) => Promise<{
      origin: string;
      close(): Promise<void>;
    }>;
  };
  expect(typeof runtimeModule.startBrowserWorkerProductionRuntime).toBe('function');
  if (typeof runtimeModule.startBrowserWorkerProductionRuntime !== 'function') return;

  const harness = runtimeHarness();
  const enabled = await runtimeModule.startBrowserWorkerProductionRuntime({
    environment: fullyEnabledEnvironment,
    dependencies: harness.dependencies,
  });
  expect((await fetch(`${enabled.origin}/ready`)).status).toBe(503);
  harness.dispatchSource.connectAuthenticatedControl();
  expect((await fetch(`${enabled.origin}/ready`)).status).toBe(200);
  harness.dispatchSource.disconnectControl();
  expect((await fetch(`${enabled.origin}/ready`)).status).toBe(503);
  await enabled.close();
  await enabled.close();
  expect(harness.closed).toEqual(['worker-loop', 'dispatch-source', 'server', 'object-store']);
  expect(harness.observations.map((event) => event.event)).toEqual([
    'automation_browser_worker_started',
    'automation_browser_worker_ready',
    'automation_browser_worker_disconnected',
    'automation_browser_worker_shutdown',
  ]);
  expect(JSON.stringify(harness.observations)).not.toMatch(/secret|token|signature|authorization/i);
});
