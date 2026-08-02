import { describe, expect, mock, test } from 'bun:test';

import {
  type ModuleServiceBridgeMessage,
  type ModuleServiceBridgeOptions,
  type ModuleServiceTokenIssueInput,
  type ModuleServiceTokenRequest,
  attachModuleServiceBridge,
  createModuleServiceBridge,
  createSandboxModuleServiceTokenAdapter,
} from './module-service-bridge';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = '20000000-0000-4000-8000-000000000002';
const RELEASE_ID = '30000000-0000-4000-8000-000000000003';
const MODULE_ORIGIN = 'https://modules.openopc.example';

function request(
  source: ModuleServiceBridgeMessage['source'],
  overrides: Partial<ModuleServiceTokenRequest> = {},
): ModuleServiceBridgeMessage {
  return {
    origin: MODULE_ORIGIN,
    source,
    data: {
      type: 'openopc.module-service.token.request',
      requestId: '40000000-0000-4000-8000-000000000004',
      service: 'ai',
      operation: 'models.read',
      ...overrides,
    },
  };
}

function createHarness(
  overrides: Partial<
    Pick<ModuleServiceBridgeOptions, 'issueToken' | 'maxRequestsPerMinute' | 'resolveCurrentState'>
  > = {},
) {
  const calls: ModuleServiceTokenIssueInput[] = [];
  const responses: unknown[] = [];
  const source = { postMessage: (payload: unknown) => responses.push(payload) };
  let currentState = {
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: RELEASE_ID,
    installRevision: 7,
  };
  const bridge = createModuleServiceBridge({
    moduleOrigin: MODULE_ORIGIN,
    moduleSource: source,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: RELEASE_ID,
    installRevision: 7,
    declaredServices: {
      ai: ['models.read', 'text.generate'],
      payment: ['orders.create'],
    },
    resolveCurrentState: overrides.resolveCurrentState ?? (async () => currentState),
    issueToken:
      overrides.issueToken ??
      (async (input) => {
        calls.push(input);
        return { token: 'v4.public.short-lived', expiresAt: '2026-08-01T00:05:00.000Z' };
      }),
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    maxRequestsPerMinute: overrides.maxRequestsPerMinute,
  });
  return {
    bridge,
    calls,
    responses,
    source,
    setCurrentState: (next: typeof currentState) => {
      currentState = next;
    },
  };
}

describe('module service host bridge', () => {
  test('refuses undeclared services and operations before minting a token', async () => {
    const { bridge, calls, source } = createHarness();

    await expect(
      bridge.handleMessage(
        request(source, {
          service: 'payment',
          operation: 'refunds.create',
          requestId: '40000000-0000-4000-8000-000000000005',
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      bridge.handleMessage(request(source, { service: 'ai', operation: 'text.stream' })),
    ).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(source).toBeDefined();
  });

  test('binds token issuance to host-owned project, installation, release, and revision state', async () => {
    const { bridge, calls, responses, source } = createHarness();

    await expect(bridge.handleMessage(request(source))).resolves.toBe(true);

    expect(calls).toEqual([
      {
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        releaseId: RELEASE_ID,
        installRevision: 7,
        service: 'ai',
        operation: 'models.read',
      },
    ]);
    expect(responses).toEqual([
      {
        type: 'openopc.module-service.token.response',
        requestId: '40000000-0000-4000-8000-000000000004',
        token: 'v4.public.short-lived',
        expiresAt: '2026-08-01T00:05:00.000Z',
      },
    ]);
    expect(JSON.stringify(responses)).not.toContain(PROJECT_ID);
    expect(JSON.stringify(responses)).not.toMatch(/account|provider|credential|new-api|z-pay/i);
  });

  test('rejects foreign origins, invalid request ids, and requests beyond the per-installation limit', async () => {
    const { bridge, calls, source } = createHarness({ maxRequestsPerMinute: 2 });

    await expect(
      bridge.handleMessage({ ...request(source), origin: 'https://attacker.example' }),
    ).resolves.toBe(false);
    await expect(bridge.handleMessage(request(source, { requestId: 'not-a-uuid' }))).resolves.toBe(
      false,
    );
    await expect(
      bridge.handleMessage({
        ...request(source, { requestId: '40000000-0000-4000-8000-000000000006' }),
      }),
    ).resolves.toBe(true);
    await expect(
      bridge.handleMessage({
        ...request(source, { requestId: '40000000-0000-4000-8000-000000000007' }),
      }),
    ).resolves.toBe(true);
    await expect(
      bridge.handleMessage({
        ...request(source, { requestId: '40000000-0000-4000-8000-000000000008' }),
      }),
    ).resolves.toBe(false);

    expect(calls).toHaveLength(2);
  });

  test('rejects a different window even when it shares the reviewed module origin', async () => {
    const { bridge, calls, source } = createHarness();
    const otherWindow = { postMessage: () => undefined };

    await expect(bridge.handleMessage(request(otherWindow))).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(source).not.toBe(otherWindow);
  });

  test('refuses a stale iframe after update or rollback changes release state', async () => {
    const { bridge, calls, responses, source, setCurrentState } = createHarness();
    setCurrentState({
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: '30000000-0000-4000-8000-000000000009',
      installRevision: 8,
    });

    await expect(bridge.handleMessage(request(source))).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(responses).toEqual([]);
  });

  test('enforces the default 30 request per minute limit', async () => {
    const { bridge, calls, source } = createHarness();

    for (let index = 1; index <= 31; index += 1) {
      await bridge.handleMessage(
        request(source, {
          requestId: `40000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        }),
      );
    }

    expect(calls).toHaveLength(30);
  });

  test('rejects requests when current launch state cannot be resolved', async () => {
    const { bridge, calls, responses, source } = createHarness({
      resolveCurrentState: async () => Promise.reject(new Error('launch unavailable')),
    });

    await expect(bridge.handleMessage(request(source))).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(responses).toEqual([]);
  });

  test('posts no structured response when consent is absent or revoked', async () => {
    for (const code of ['MODULE_SERVICE_CONSENT_REQUIRED', 'MODULE_SERVICE_CONSENT_REVOKED']) {
      const issueToken = mock(async () => Promise.reject(Object.assign(new Error(code), { code })));
      const { bridge, responses, source } = createHarness({ issueToken });

      await expect(bridge.handleMessage(request(source))).resolves.toBe(false);
      expect(issueToken).toHaveBeenCalledTimes(1);
      expect(responses).toEqual([]);
    }
  });

  test('rejects expired and overlong issued token lifetimes', async () => {
    for (const expiresAt of ['2026-08-01T00:00:00.000Z', '2026-08-01T00:05:00.001Z']) {
      const { bridge, responses, source } = createHarness({
        issueToken: async () => ({ token: 'v4.public.short-lived', expiresAt }),
      });

      await expect(bridge.handleMessage(request(source))).resolves.toBe(false);
      expect(responses).toEqual([]);
    }
  });

  test('removes the host message listener during cleanup', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const source = { postMessage: () => undefined };
    const issueToken = mock(async () => ({
      token: 'v4.public.short-lived',
      expiresAt: '2026-08-01T00:05:00.000Z',
    }));
    const target = {
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.add(listener as (event: MessageEvent) => void);
      },
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.delete(listener as (event: MessageEvent) => void);
      },
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const cleanup = attachModuleServiceBridge(target, {
      moduleOrigin: MODULE_ORIGIN,
      moduleSource: source,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: RELEASE_ID,
      installRevision: 7,
      declaredServices: { ai: ['models.read'] },
      issueToken,
      resolveCurrentState: async () => ({
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        releaseId: RELEASE_ID,
        installRevision: 7,
      }),
      now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    });

    cleanup();
    for (const listener of listeners) listener(request(source) as unknown as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issueToken).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  test('provides the module SDK a strict postMessage getCapabilityToken adapter', async () => {
    type AdapterEvent = { origin: string; source: unknown; data: unknown };
    const listeners = new Set<(event: AdapterEvent) => void>();
    const requests: unknown[] = [];
    const hostWindow = {
      postMessage(message: unknown, targetOrigin: string) {
        requests.push({ message, targetOrigin });
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              origin: 'https://app.openopc.example',
              source: hostWindow,
              data: {
                type: 'openopc.module-service.token.response',
                requestId: '50000000-0000-4000-8000-000000000005',
                token: 'v4.public.short-lived',
                expiresAt: '2026-08-01T00:05:00.000Z',
              },
            });
          }
        });
      },
    };
    const eventTarget = {
      addEventListener(_type: 'message', listener: (event: AdapterEvent) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: 'message', listener: (event: AdapterEvent) => void) {
        listeners.delete(listener);
      },
    };
    const getCapabilityToken = createSandboxModuleServiceTokenAdapter({
      hostOrigin: 'https://app.openopc.example',
      hostWindow,
      eventTarget,
      requestId: () => '50000000-0000-4000-8000-000000000005',
      timeoutMs: 100,
    });

    await expect(getCapabilityToken({ service: 'ai', operation: 'models.read' })).resolves.toBe(
      'v4.public.short-lived',
    );
    expect(requests).toEqual([
      {
        message: {
          type: 'openopc.module-service.token.request',
          requestId: '50000000-0000-4000-8000-000000000005',
          service: 'ai',
          operation: 'models.read',
        },
        targetOrigin: 'https://app.openopc.example',
      },
    ]);
  });
});
