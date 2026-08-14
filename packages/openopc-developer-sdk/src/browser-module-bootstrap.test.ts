import { expect, spyOn, test } from 'bun:test';

import {
  OpenOpcBrowserModuleBootstrapProtocolError,
  type OpenOpcBrowserModuleClientOptions,
  type OpenOpcBrowserModuleWindow,
  createOpenOpcBrowserModuleClient,
} from './browser-module-bootstrap';

const PLATFORM_ORIGIN = 'https://app.openopc.example';
const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const MODULE_CONTEXT = {
  projectId: '20000000-0000-4000-8000-000000000002',
  installationId: '30000000-0000-4000-8000-000000000003',
  releaseId: '40000000-0000-4000-8000-000000000004',
  installRevision: 7,
} as const;

test('discovers the parent origin and uses it for token and HTTP requests', async () => {
  const requests: Array<{ message: unknown; targetOrigin: string }> = [];
  const fetches: string[] = [];
  const browser = createFakeChildWindow((message, targetOrigin, child) => {
    requests.push({ message, targetOrigin });
    queueMicrotask(() => {
      child.dispatch({
        origin: PLATFORM_ORIGIN,
        source: child.parent,
        data: {
          type: 'openopc.module.bootstrap.response',
          requestId: REQUEST_ID,
          sdkApiVersion: 'v1',
          context: MODULE_CONTEXT,
        },
      });
    });
  });

  const client = await createOpenOpcBrowserModuleClient({
    window: browser,
    requestId: sequentialIds(REQUEST_ID, '10000000-0000-4000-8000-000000000002'),
    fetch: async (input) => {
      fetches.push(String(input));
      return Response.json({ data: [] });
    },
  });

  browser.answerNextToken('v4.public.test-token');
  await client.ai.models.list();

  expect(client.context).toEqual(MODULE_CONTEXT);

  expect(requests[0]).toEqual({
    targetOrigin: '*',
    message: {
      type: 'openopc.module.bootstrap.request',
      requestId: REQUEST_ID,
      sdkApiVersion: 'v1',
    },
  });
  expect(fetches).toEqual(['https://app.openopc.example/v1/module-services/ai/models']);
});

test('ignores spoofed responses and cleans up after the exact response', async () => {
  const browser = createFakeChildWindow();
  const pending = createOpenOpcBrowserModuleClient({
    window: browser,
    requestId: () => REQUEST_ID,
  });

  browser.dispatch({
    origin: 'https://attacker.example',
    source: {},
    data: {
      type: 'openopc.module.bootstrap.response',
      requestId: REQUEST_ID,
      sdkApiVersion: 'v1',
      context: MODULE_CONTEXT,
    },
  });
  expect(browser.listenerCount()).toBe(1);

  browser.dispatch({
    origin: PLATFORM_ORIGIN,
    source: browser.parent,
    data: {
      type: 'openopc.module.bootstrap.response',
      requestId: REQUEST_ID,
      sdkApiVersion: 'v1',
      context: MODULE_CONTEXT,
    },
  });
  await pending;
  expect(browser.listenerCount()).toBe(0);
});

test('clears the bootstrap timer exactly once on success', async () => {
  const clearTimer = spyOn(globalThis, 'clearTimeout');
  try {
    const browser = createFakeChildWindow((_message, _targetOrigin, child) => {
      queueMicrotask(() => {
        child.dispatch({
          origin: PLATFORM_ORIGIN,
          source: child.parent,
          data: {
            type: 'openopc.module.bootstrap.response',
            requestId: REQUEST_ID,
            sdkApiVersion: 'v1',
            context: MODULE_CONTEXT,
          },
        });
      });
    });
    await createOpenOpcBrowserModuleClient({
      window: browser,
      requestId: () => REQUEST_ID,
    });
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(browser.listenerCount()).toBe(0);
  } finally {
    clearTimer.mockRestore();
  }
});

test('fails fast at top level and reports abort, timeout, and send failure', async () => {
  await expect(
    createOpenOpcBrowserModuleClient({ window: createFakeTopLevelWindow() }),
  ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);

  const controller = new AbortController();
  controller.abort();
  await expect(
    createOpenOpcBrowserModuleClient({
      window: createFakeChildWindow(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: 'OPENOPC_MODULE_REQUEST_ABORTED' });

  await expect(
    createOpenOpcBrowserModuleClient({
      window: createFakeChildWindow(),
      bootstrapTimeoutMs: 1,
    }),
  ).rejects.toMatchObject({ code: 'OPENOPC_MODULE_REQUEST_TIMEOUT' });

  await expect(
    createOpenOpcBrowserModuleClient({ window: createThrowingChildWindow() }),
  ).rejects.toMatchObject({ code: 'OPENOPC_MODULE_REQUEST_FAILED' });
});

test('ignores unrelated messages but rejects a matching malformed response', async () => {
  const browser = createFakeChildWindow();
  const pending = createOpenOpcBrowserModuleClient({
    window: browser,
    requestId: () => REQUEST_ID,
  });

  browser.dispatch({
    origin: PLATFORM_ORIGIN,
    source: browser.parent,
    data: {
      type: 'openopc.module.bootstrap.response',
      requestId: '10000000-0000-4000-8000-000000000009',
      sdkApiVersion: 'v1',
    },
  });
  browser.dispatch({
    origin: PLATFORM_ORIGIN,
    source: browser.parent,
    data: { type: 'unrelated.message', requestId: REQUEST_ID },
  });
  expect(browser.listenerCount()).toBe(1);

  browser.dispatch({
    origin: PLATFORM_ORIGIN,
    source: browser.parent,
    data: {
      type: 'openopc.module.bootstrap.response',
      requestId: REQUEST_ID,
      sdkApiVersion: 'v2',
    },
  });
  await expect(pending).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
  expect(browser.listenerCount()).toBe(0);
});

test('rejects exact-key and HTTPS violations that claim the active request', async () => {
  for (const event of [
    {
      origin: PLATFORM_ORIGIN,
      data: {
        type: 'openopc.module.bootstrap.response',
        requestId: REQUEST_ID,
        sdkApiVersion: 'v1',
        platformOrigin: 'https://attacker.example',
      },
    },
    {
      origin: 'http://app.openopc.example',
      data: {
        type: 'openopc.module.bootstrap.response',
        requestId: REQUEST_ID,
        sdkApiVersion: 'v1',
      },
    },
  ]) {
    const browser = createFakeChildWindow();
    const pending = createOpenOpcBrowserModuleClient({
      window: browser,
      requestId: () => REQUEST_ID,
    });
    browser.dispatch({ ...event, source: browser.parent });
    await expect(pending).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
    expect(browser.listenerCount()).toBe(0);
  }
});

test('cleans listeners and the timer on abort, timeout, and send failure', async () => {
  const abortController = new AbortController();
  const aborting = createFakeChildWindow();
  const pendingAbort = createOpenOpcBrowserModuleClient({
    window: aborting,
    signal: abortController.signal,
    requestId: () => REQUEST_ID,
  });
  expect(aborting.listenerCount()).toBe(1);
  abortController.abort();
  await expect(pendingAbort).rejects.toMatchObject({
    code: 'OPENOPC_MODULE_REQUEST_ABORTED',
  });
  expect(aborting.listenerCount()).toBe(0);

  const timingOut = createFakeChildWindow();
  const pendingTimeout = createOpenOpcBrowserModuleClient({
    window: timingOut,
    bootstrapTimeoutMs: 1,
    requestId: () => REQUEST_ID,
  });
  await expect(pendingTimeout).rejects.toMatchObject({
    code: 'OPENOPC_MODULE_REQUEST_TIMEOUT',
  });
  expect(timingOut.listenerCount()).toBe(0);

  const sending = createThrowingChildWindow();
  const pendingSend = createOpenOpcBrowserModuleClient({
    window: sending,
    requestId: () => REQUEST_ID,
  });
  await expect(pendingSend).rejects.toMatchObject({
    code: 'OPENOPC_MODULE_REQUEST_FAILED',
  });
  expect(sending.listenerCount()).toBe(0);
});

test('rejects unknown options, invalid timeout, and invalid request IDs before sending', async () => {
  const browser = createFakeChildWindow();
  await expect(
    createOpenOpcBrowserModuleClient({
      window: browser,
      platformOrigin: PLATFORM_ORIGIN,
    } as never),
  ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
  await expect(
    createOpenOpcBrowserModuleClient({
      window: browser,
      bootstrapTimeoutMs: 0,
    }),
  ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
  await expect(
    createOpenOpcBrowserModuleClient({
      window: browser,
      requestId: () => '10000000-0000-4000-A000-000000000001',
    }),
  ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
  expect(browser.parentPosts()).toHaveLength(0);
  expect(browser.listenerCount()).toBe(0);
});

test('keeps origin overrides out of the public options type', () => {
  const options: OpenOpcBrowserModuleClientOptions = {
    // @ts-expect-error platformOrigin is intentionally not public.
    platformOrigin: PLATFORM_ORIGIN,
  };
  expect(options).toBeDefined();
});

interface FakeMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

interface FakeChildWindow extends OpenOpcBrowserModuleWindow {
  dispatch(event: FakeMessageEvent): void;
  listenerCount(): number;
  parentPosts(): Array<{ message: unknown; targetOrigin: string }>;
  answerNextToken(token: string): void;
}

function sequentialIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index++];
    if (!id) throw new Error('No fake request ID remains');
    return id;
  };
}

function createFakeChildWindow(
  onPost?: (message: unknown, targetOrigin: string, child: FakeChildWindow) => void,
): FakeChildWindow {
  const listeners = new Set<(event: FakeMessageEvent) => void>();
  const parentPosts: Array<{ message: unknown; targetOrigin: string }> = [];
  let queuedToken: string | null = null;
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      parentPosts.push({ message, targetOrigin });
      const record = message as Record<string, unknown>;
      if (record.type === 'openopc.module-service.token.request' && queuedToken) {
        const token = queuedToken;
        queuedToken = null;
        queueMicrotask(() => {
          child.dispatch({
            origin: PLATFORM_ORIGIN,
            source: parent,
            data: {
              type: 'openopc.module-service.token.response',
              requestId: record.requestId,
              token,
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            },
          });
        });
        return;
      }
      onPost?.(message, targetOrigin, child);
    },
  };
  const child: FakeChildWindow = {
    parent,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    dispatch(event) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
    parentPosts: () => [...parentPosts],
    answerNextToken(token) {
      queuedToken = token;
    },
  };
  return child;
}

function createFakeTopLevelWindow(): FakeChildWindow {
  const child = createFakeChildWindow();
  Object.defineProperty(child, 'parent', { value: child });
  return child;
}

function createThrowingChildWindow(): FakeChildWindow {
  const child = createFakeChildWindow();
  Object.defineProperty(child, 'parent', {
    value: {
      postMessage() {
        throw new Error('send failed');
      },
    },
  });
  return child;
}
