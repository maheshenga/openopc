import { expect, test } from 'bun:test';

import {
  type ModuleBootstrapBridgeMessage,
  type ModuleBootstrapBridgeOptions,
  type ModuleBootstrapMessageSource,
  attachModuleBootstrapBridge,
  createModuleBootstrapBridge,
} from './module-bootstrap-bridge';

const MODULE_ORIGIN = 'https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example';
const REQUEST_ID = '10000000-0000-4000-8000-00000000000a';
const MODULE_CONTEXT = {
  projectId: '20000000-0000-4000-8000-000000000002',
  installationId: '30000000-0000-4000-8000-000000000003',
  releaseId: '40000000-0000-4000-8000-000000000004',
  installRevision: 7,
} as const;

function createBridgeHarness() {
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const source: ModuleBootstrapMessageSource = {
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  const options: ModuleBootstrapBridgeOptions = {
    moduleOrigin: MODULE_ORIGIN,
    moduleSource: source,
    sdkApiVersion: 'v1',
    context: MODULE_CONTEXT,
  };
  return {
    posted,
    source,
    options,
    bridge: createModuleBootstrapBridge(options),
  };
}

test('responds only to the exact module origin and source', () => {
  const harness = createBridgeHarness();
  expect(
    harness.bridge.handleMessage({
      origin: MODULE_ORIGIN,
      source: harness.source,
      data: {
        type: 'openopc.module.bootstrap.request',
        requestId: REQUEST_ID,
        sdkApiVersion: 'v1',
      },
    }),
  ).toBe(true);
  expect(harness.posted).toEqual([
    {
      targetOrigin: MODULE_ORIGIN,
      message: {
        type: 'openopc.module.bootstrap.response',
        requestId: REQUEST_ID,
        sdkApiVersion: 'v1',
        context: MODULE_CONTEXT,
      },
    },
  ]);
});

function hostileBootstrapMessages(
  source: ModuleBootstrapMessageSource,
): ModuleBootstrapBridgeMessage[] {
  const valid = {
    type: 'openopc.module.bootstrap.request',
    requestId: REQUEST_ID,
    sdkApiVersion: 'v1',
  };
  const foreignSource: ModuleBootstrapMessageSource = { postMessage() {} };
  return [
    { origin: MODULE_ORIGIN, source: foreignSource, data: valid },
    { origin: 'https://attacker.example', source, data: valid },
    { origin: MODULE_ORIGIN, source, data: { ...valid, extra: true } },
    {
      origin: MODULE_ORIGIN,
      source,
      data: { ...valid, requestId: valid.requestId.toUpperCase() },
    },
    { origin: MODULE_ORIGIN, source, data: { ...valid, sdkApiVersion: 'v2' } },
    { origin: MODULE_ORIGIN, source, data: { type: valid.type, requestId: valid.requestId } },
    { origin: MODULE_ORIGIN, source, data: { ...valid, type: 'unrelated.message' } },
    { origin: '*', source, data: valid },
    { origin: MODULE_ORIGIN, source, data: null },
  ];
}

test('rejects foreign windows, foreign origins, malformed keys, and versions', () => {
  const harness = createBridgeHarness();
  for (const message of hostileBootstrapMessages(harness.source)) {
    expect(harness.bridge.handleMessage(message)).toBe(false);
  }
  expect(harness.posted).toEqual([]);
});

function createEventTargetHarness(): Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  dispatch(event: MessageEvent): void;
  listenerCount(): number;
} {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
      listeners.delete(listener);
    },
    dispatch(event: MessageEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    dispatch(event: MessageEvent): void;
    listenerCount(): number;
  };
}

test('removes the exact listener during cleanup', () => {
  const harness = createBridgeHarness();
  const target = createEventTargetHarness();
  const cleanup = attachModuleBootstrapBridge(target, harness.options);
  expect(target.listenerCount()).toBe(1);
  cleanup();
  cleanup();
  expect(target.listenerCount()).toBe(0);
});

test('rejects invalid module origins before attaching a listener', () => {
  for (const moduleOrigin of [
    '*',
    'https://modules.openopc.example/path',
    'https://modules.openopc.example:8443',
    'http://modules.openopc.example',
  ]) {
    const target = createEventTargetHarness();
    expect(() =>
      attachModuleBootstrapBridge(target, {
        ...createBridgeHarness().options,
        moduleOrigin,
      }),
    ).toThrow();
    expect(target.listenerCount()).toBe(0);
  }

  const target = createEventTargetHarness();
  expect(() =>
    attachModuleBootstrapBridge(target, {
      ...createBridgeHarness().options,
      sdkApiVersion: 'v2',
    } as never),
  ).toThrow();
  expect(target.listenerCount()).toBe(0);
});
