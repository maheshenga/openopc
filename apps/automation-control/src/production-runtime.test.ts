import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { createBrowserApprovalResumeRuntime } from './dispatch/browser-approval-resume-runtime';
import type { BrowserWorkerConnection } from './dispatch/browser-dispatcher';
import type {
  BrowserWorkerConnectionState,
  ObservableBrowserWorkerConnection,
} from './dispatch/browser-worker-connection';
import { createBrowserWorkerRoutes } from './dispatch/browser-worker-routes';
import { createManagedBrowserWorkerConnection } from './dispatch/managed-browser-worker-connection';
import {
  type AutomationDispatchPollingRunner,
  composeAutomationDispatchPollingRunner,
} from './dispatch/poller';
import type { VerifiedWorkerPeer } from './dispatch/worker-auth';
import { createWorkerSecurityRuntime } from './dispatch/worker-security-runtime';
import {
  type AutomationControlProductionDependencies,
  type AutomationControlProductionObservation,
  startAutomationControlProductionRuntime,
} from './production-runtime';

const CONTROL_SHARED_SECRET = 'control-shared-secret-at-least-thirty-two-bytes';
const CONTROL_WORKER_SHARED_SECRET = 'control-worker-secret-at-least-thirty-two-bytes';
const RESUME_TOKEN_PEPPER = 'approval-resume-token-pepper-at-least-thirty-two-bytes';
const WORKER_SHARED_SECRET = 'worker-shared-secret-at-least-thirty-two-bytes';
const WORKER_TLS_SECRET = 'trusted-proxy-attestation-secret-at-least-thirty-two-bytes';
const WORKER_FINGERPRINT = 'AA:BB:CC:DD';
const NOW = new Date('2026-07-23T06:00:00.000Z');

const fullyEnabledEnvironment = {
  AUTOMATION_CONTROL_ENABLED: 'true',
  AUTOMATION_DESKTOP_COORDINATOR_ENABLED: 'true',
  AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
  AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
  AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
  DATABASE_URL: 'postgresql://db.example.test/automation',
  REDIS_URL: 'redis://redis.example.test:6379',
  AUTOMATION_CONTROL_SHARED_SECRET: CONTROL_SHARED_SECRET,
  AUTOMATION_BROWSER_WORKER_TRUST_JSON: JSON.stringify({
    'browser-worker-1': {
      fingerprints: [WORKER_FINGERPRINT],
      shared_secret: WORKER_SHARED_SECRET,
    },
  }),
  AUTOMATION_WORKER_TLS_ATTESTATION_SECRET: WORKER_TLS_SECRET,
  AUTOMATION_BROWSER_WORKER_URL: 'wss://browser-worker.example.test/',
  AUTOMATION_CONTROL_MTLS_CERT_PATH: 'C:\\certs\\control.crt',
  AUTOMATION_CONTROL_MTLS_KEY_PATH: 'C:\\certs\\control.key',
  AUTOMATION_CONTROL_MTLS_CA_PATH: 'C:\\certs\\worker-ca.crt',
  AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: 'AA:CONTROL',
  AUTOMATION_CONTROL_WORKER_SHARED_SECRET: CONTROL_WORKER_SHARED_SECRET,
  AUTOMATION_APPROVAL_RESUME_TOKEN_PEPPER: RESUME_TOKEN_PEPPER,
} as const;

class HarnessConnection implements ObservableBrowserWorkerConnection {
  readonly #listeners = new Set<(state: BrowserWorkerConnectionState) => void>();
  #state: BrowserWorkerConnectionState = 'ready';

  constructor(
    readonly peer: VerifiedWorkerPeer,
    private readonly onClose: () => void,
  ) {}

  state(): BrowserWorkerConnectionState {
    return this.#state;
  }

  subscribe(listener: (state: BrowserWorkerConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(
    _input: Parameters<BrowserWorkerConnection['send']>[0],
  ): ReturnType<BrowserWorkerConnection['send']> {
    return Promise.reject(new Error('dispatch is outside this lifecycle test'));
  }

  disconnect(): void {
    this.#state = 'unusable';
    for (const listener of this.#listeners) listener(this.#state);
  }

  close(): void {
    this.onClose();
    this.disconnect();
  }
}

function createHarness(options: { serverCloseThrows?: boolean } = {}) {
  const created: string[] = [];
  const closed: string[] = [];
  const observations: AutomationControlProductionObservation[] = [];
  const compositeInputs: Array<{
    desktop: AutomationDispatchPollingRunner | null;
    browserApprovalResume: AutomationDispatchPollingRunner | null;
  }> = [];
  const pollerInputs: Array<
    Parameters<NonNullable<AutomationControlProductionDependencies['startPoller']>>[0]
  > = [];
  let connection: HarnessConnection | null = null;

  const dependencies = {
    now: () => NOW,
    nextNonce: (() => {
      let nonce = 100;
      return () => ++nonce;
    })(),
    createDatabase: () => {
      created.push('database');
      return {
        database: {} as Database,
        check: async () => true,
        close: async () => {
          closed.push('database');
        },
      };
    },
    createRedis: () => {
      created.push('redis');
      return {
        redis: { send: async () => 1 },
        check: async () => true,
        close: () => {
          closed.push('redis');
        },
      };
    },
    createWorkerSecurity: (input) => {
      created.push('security');
      return createWorkerSecurityRuntime(input);
    },
    createWorkerRoutes: (input) => {
      created.push('worker-routes');
      return createBrowserWorkerRoutes(input);
    },
    createTlsBoundBrowserWorkerConnection: ({ security }) => {
      const peer = security.authenticator.bindTlsPeer({
        authorized: true,
        serviceId: 'browser-worker-1',
        fingerprint256: WORKER_FINGERPRINT,
        validTo: '2099-07-24T06:00:00.000Z',
      });
      return {
        peer,
        connect: () => {
          connection = new HarnessConnection(peer, () => closed.push('connection'));
          return connection;
        },
      };
    },
    createManagedBrowserWorkerConnection: (input) => {
      created.push('managed-connection');
      return createManagedBrowserWorkerConnection(input);
    },
    createBrowserApprovalResumeRuntime: (input) => {
      created.push('browser-resume');
      return createBrowserApprovalResumeRuntime(input);
    },
    composePollingRunner: (input) => {
      compositeInputs.push(input);
      return composeAutomationDispatchPollingRunner(input);
    },
    startPoller: (input) => {
      created.push('poller');
      pollerInputs.push(input);
      return {
        async stop() {
          closed.push('poller');
        },
      };
    },
    serve: (_app, port) => {
      created.push('http-server');
      return {
        port,
        stop() {
          closed.push('http-server');
          if (options.serverCloseThrows) throw new Error('server close failed with a secret');
        },
      };
    },
    scheduleReconnect: () => ({ pending: true }),
    cancelReconnect: () => undefined,
    observe: (event) => observations.push(event),
  } satisfies AutomationControlProductionDependencies;

  return {
    created,
    closed,
    observations,
    compositeInputs,
    pollerInputs,
    dependencies,
    disconnect: () => connection?.disconnect(),
  };
}

describe('Automation Control production runtime', () => {
  test('keeps default startup disabled and opens only the HTTP server', async () => {
    const harness = createHarness();
    const disabled = await startAutomationControlProductionRuntime({
      environment: {},
      dependencies: harness.dependencies,
    });

    expect(harness.created).toEqual(['http-server']);
    expect((await disabled.app.request('/health')).status).toBe(200);
    expect((await disabled.app.request('/ready')).status).toBe(503);

    await disabled.close();
    await disabled.close();

    expect(harness.closed).toEqual(['http-server']);
  });

  test('composes both coordinators into one poller and tracks Browser readiness', async () => {
    const harness = createHarness({ serverCloseThrows: true });
    const enabled = await startAutomationControlProductionRuntime({
      environment: fullyEnabledEnvironment,
      dependencies: harness.dependencies,
    });

    expect(harness.created).toEqual([
      'database',
      'redis',
      'security',
      'worker-routes',
      'managed-connection',
      'browser-resume',
      'poller',
      'http-server',
    ]);
    expect(harness.compositeInputs).toHaveLength(1);
    expect(harness.compositeInputs[0]?.desktop).not.toBeNull();
    expect(harness.compositeInputs[0]?.browserApprovalResume).not.toBeNull();
    expect((await enabled.app.request('/ready')).status).toBe(200);

    harness.disconnect();

    const health = await enabled.app.request('/health');
    const readiness = await enabled.app.request('/ready');
    expect(health.status).toBe(200);
    expect(await health.json()).not.toHaveProperty('dependencies.browser_dispatch');
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      status: 'not_ready',
      dependencies: { browser_dispatch: 'unavailable' },
    });

    await enabled.close();
    await enabled.close();

    expect(harness.closed).toEqual(['poller', 'connection', 'http-server', 'redis', 'database']);
    expect(harness.observations.map((event) => event.event)).toEqual([
      'automation_control_started',
      'automation_browser_runtime_ready',
      'automation_browser_runtime_disconnected',
      'automation_control_shutdown',
    ]);
    expect(JSON.stringify(harness.observations)).not.toContain(CONTROL_WORKER_SHARED_SECRET);
    expect(JSON.stringify(harness.observations)).not.toContain(RESUME_TOKEN_PEPPER);
    expect(JSON.stringify(harness.observations)).not.toContain('server close failed');
  });

  test('rejects partial activation before creating resources', async () => {
    const harness = createHarness();

    await expect(
      startAutomationControlProductionRuntime({
        environment: {
          AUTOMATION_CONTROL_ENABLED: 'true',
          AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
          DATABASE_URL: fullyEnabledEnvironment.DATABASE_URL,
          REDIS_URL: fullyEnabledEnvironment.REDIS_URL,
          AUTOMATION_CONTROL_SHARED_SECRET: CONTROL_SHARED_SECRET,
        },
        dependencies: harness.dependencies,
      }),
    ).rejects.toThrow();
    expect(harness.created).toEqual([]);
  });

  test('fails full activation without a TLS-bound Worker peer adapter', async () => {
    const harness = createHarness();
    const { createTlsBoundBrowserWorkerConnection: _, ...withoutTlsAdapter } = harness.dependencies;

    await expect(
      startAutomationControlProductionRuntime({
        environment: fullyEnabledEnvironment,
        dependencies: withoutTlsAdapter,
      }),
    ).rejects.toThrow(/TLS-bound.*Worker peer/i);
    expect(harness.created).toEqual([]);
  });

  test('fails startup when the enabled Browser coordinator is not composed', async () => {
    const harness = createHarness();

    await expect(
      startAutomationControlProductionRuntime({
        environment: fullyEnabledEnvironment,
        dependencies: {
          ...harness.dependencies,
          createBrowserApprovalResumeRuntime: () => null,
        },
      }),
    ).rejects.toThrow(/Browser.*coordinator/i);

    expect(harness.created).not.toContain('poller');
    expect(harness.created).not.toContain('http-server');
    expect(harness.closed).toEqual(['connection', 'redis', 'database']);
  });

  test('reports poll failures with a stable event and no dependency error', async () => {
    const harness = createHarness();
    const runtime = await startAutomationControlProductionRuntime({
      environment: fullyEnabledEnvironment,
      dependencies: harness.dependencies,
    });

    harness.pollerInputs[0]?.onError?.({
      event: 'automation_desktop_coordinator_poll_failed',
    });

    expect(harness.observations.at(-1)).toMatchObject({
      event: 'automation_desktop_coordinator_poll_failed',
      error_code: 'poll_failed',
    });
    expect(JSON.stringify(harness.observations)).not.toContain(CONTROL_WORKER_SHARED_SECRET);
    await runtime.close();
  });
});
