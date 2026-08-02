import { describe, expect, mock, test } from 'bun:test';
import type { ProjectModuleLaunchDescriptor } from '@kortix/sdk';

import { attachProjectModuleHostBridge } from './project-module-host';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = '20000000-0000-4000-8000-000000000002';
const RELEASE_ID = '30000000-0000-4000-8000-000000000003';
const ORIGIN = 'https://modules.openopc.example';

const DESCRIPTOR: ProjectModuleLaunchDescriptor = {
  installation_id: INSTALLATION_ID,
  release_id: RELEASE_ID,
  install_revision: 7,
  module_id: 'openopc.recruiting',
  module_version: '2.0.0',
  execution_mode: 'sandboxed-web',
  url: `${ORIGIN}/releases/${RELEASE_ID}/index.html`,
  origin: ORIGIN,
};

const MANIFEST = {
  schemaVersion: 3,
  id: DESCRIPTOR.module_id,
  version: DESCRIPTOR.module_version,
  execution: { mode: 'sandboxed-web', entry: 'web/index.html' },
  openopc: {
    sdkApiVersion: 'v1',
    services: {
      ai: { operations: ['models.read'] },
      payment: { operations: ['orders.create'] },
    },
  },
};

type Posted = { message: unknown; targetOrigin: string };

function request(source: unknown, overrides: Record<string, unknown> = {}): MessageEvent {
  return {
    origin: ORIGIN,
    source,
    data: {
      type: 'openopc.module-service.token.request',
      requestId: '40000000-0000-4000-8000-000000000004',
      service: 'ai',
      operation: 'models.read',
      ...overrides,
    },
  } as MessageEvent;
}

function createEventTarget() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    target: {
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.add(listener as (event: MessageEvent) => void);
      },
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.delete(listener as (event: MessageEvent) => void);
      },
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    dispatch(event: MessageEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

async function flushBridge(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(
  overrides: {
    descriptor?: ProjectModuleLaunchDescriptor;
    manifest?: unknown;
    resolveLaunch?: () => Promise<ProjectModuleLaunchDescriptor>;
    issueCapability?: (
      projectId: string,
      installationId: string,
      input: { service: 'ai' | 'payment'; operations: string[] },
    ) => Promise<{ token: string; expires_at: string; grant_id: string }>;
  } = {},
) {
  const eventTarget = createEventTarget();
  const posted: Posted[] = [];
  const moduleSource = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
  } as unknown as Window;
  const resolveLaunch = mock(
    overrides.resolveLaunch ?? (async () => overrides.descriptor ?? DESCRIPTOR),
  );
  const issueCapability = mock(
    overrides.issueCapability ??
      (async () => ({
        token: 'v4.public.short-lived',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        grant_id: '50000000-0000-4000-8000-000000000005',
      })),
  );
  const cleanup = attachProjectModuleHostBridge({
    eventTarget: eventTarget.target,
    moduleSource,
    projectId: PROJECT_ID,
    descriptor: overrides.descriptor ?? DESCRIPTOR,
    manifest: overrides.manifest ?? MANIFEST,
    issueCapability: issueCapability as never,
    resolveLaunch,
  });
  return { cleanup, eventTarget, issueCapability, moduleSource, posted, resolveLaunch };
}

describe('project module production host bridge', () => {
  test('issues one-operation capabilities to the exact reviewed iframe and cleans up', async () => {
    const harness = createHarness();

    harness.eventTarget.dispatch(request(harness.moduleSource));
    await flushBridge();

    expect(harness.issueCapability).toHaveBeenCalledWith(PROJECT_ID, INSTALLATION_ID, {
      service: 'ai',
      operations: ['models.read'],
    });
    expect(harness.resolveLaunch).toHaveBeenCalledTimes(1);
    expect(harness.posted[0]?.targetOrigin).toBe(DESCRIPTOR.origin);

    harness.cleanup();
    harness.eventTarget.dispatch(
      request(harness.moduleSource, { requestId: '40000000-0000-4000-8000-000000000006' }),
    );
    await flushBridge();
    expect(harness.issueCapability).toHaveBeenCalledTimes(1);
  });

  test('rejects catalog identity mismatch and undeclared operations before issuance', async () => {
    const mismatch = createHarness({ manifest: { ...MANIFEST, id: 'openopc.other' } });
    mismatch.eventTarget.dispatch(request(mismatch.moduleSource));

    const undeclared = createHarness();
    undeclared.eventTarget.dispatch(
      request(undeclared.moduleSource, {
        requestId: '40000000-0000-4000-8000-000000000007',
        operation: 'text.generate',
      }),
    );
    await flushBridge();

    expect(mismatch.issueCapability).not.toHaveBeenCalled();
    expect(undeclared.issueCapability).not.toHaveBeenCalled();
  });

  test('rejects stale launch state, foreign origins, and a different window', async () => {
    const stale = createHarness({
      resolveLaunch: async () => ({
        ...DESCRIPTOR,
        release_id: '30000000-0000-4000-8000-000000000008',
        install_revision: 8,
      }),
    });
    stale.eventTarget.dispatch(request(stale.moduleSource));

    const foreign = createHarness();
    foreign.eventTarget.dispatch({
      ...request(foreign.moduleSource),
      origin: 'https://attacker.example',
    } as MessageEvent);

    const otherWindow = createHarness();
    otherWindow.eventTarget.dispatch(request({ postMessage: () => undefined }));
    await flushBridge();

    expect(stale.issueCapability).not.toHaveBeenCalled();
    expect(foreign.issueCapability).not.toHaveBeenCalled();
    expect(otherWindow.issueCapability).not.toHaveBeenCalled();
  });

  test('posts no response and does not retry when consent is absent or revoked', async () => {
    for (const code of ['MODULE_SERVICE_CONSENT_REQUIRED', 'MODULE_SERVICE_CONSENT_REVOKED']) {
      const error = Object.assign(new Error(code), { code });
      const harness = createHarness({
        issueCapability: async () => Promise.reject(error),
      });

      harness.eventTarget.dispatch(request(harness.moduleSource));
      await flushBridge();

      expect(harness.issueCapability).toHaveBeenCalledTimes(1);
      expect(harness.posted).toEqual([]);
    }
  });
});
