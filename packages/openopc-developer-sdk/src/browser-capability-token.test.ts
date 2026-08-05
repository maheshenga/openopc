import { describe, expect, test } from 'bun:test';

import {
  OpenOpcBrowserCapabilityTokenProtocolError,
  createOpenOpcBrowserCapabilityTokenAdapter,
} from './index';

type AdapterEvent = { origin: string; source: unknown; data: unknown };

function harness() {
  const listeners = new Set<(event: AdapterEvent) => void>();
  const requests: unknown[] = [];
  const hostWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      requests.push({ message, targetOrigin });
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
  return { listeners, requests, hostWindow, eventTarget };
}

describe('OpenOPC browser capability-token adapter', () => {
  test('sends the exact request and accepts only the matching host response', async () => {
    const h = harness();
    const adapter = createOpenOpcBrowserCapabilityTokenAdapter({
      hostOrigin: 'https://app.openopc.example/',
      hostWindow: h.hostWindow,
      eventTarget: h.eventTarget,
      requestId: () => '50000000-0000-4000-8000-000000000005',
      timeoutMs: 100,
    });
    const pending = adapter({ service: 'ai', operation: 'models.read' });
    expect(h.requests).toEqual([
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
    for (const event of [
      {
        origin: 'https://attacker.example',
        source: h.hostWindow,
        data: {
          type: 'openopc.module-service.token.response',
          requestId: '50000000-0000-4000-8000-000000000005',
          token: 'v4.public.bad-origin',
          expiresAt: '2026-08-01T00:05:00.000Z',
        },
      },
      {
        origin: 'https://app.openopc.example',
        source: {},
        data: {
          type: 'openopc.module-service.token.response',
          requestId: '50000000-0000-4000-8000-000000000005',
          token: 'v4.public.bad-source',
          expiresAt: '2026-08-01T00:05:00.000Z',
        },
      },
    ]) {
      for (const listener of h.listeners) listener(event);
    }
    queueMicrotask(() => {
      for (const listener of h.listeners) {
        listener({
          origin: 'https://app.openopc.example',
          source: h.hostWindow,
          data: {
            type: 'openopc.module-service.token.response',
            requestId: '50000000-0000-4000-8000-000000000005',
            token: 'v4.public.good-token',
            expiresAt: '2026-08-01T00:05:00.000Z',
          },
        });
      }
    });
    await expect(pending).resolves.toBe('v4.public.good-token');
    expect(h.listeners.size).toBe(0);
  });

  test('keeps concurrent requests correlated by request id', async () => {
    const h = harness();
    let next = 0;
    const adapter = createOpenOpcBrowserCapabilityTokenAdapter({
      hostOrigin: 'https://app.openopc.example',
      hostWindow: h.hostWindow,
      eventTarget: h.eventTarget,
      requestId: () => `50000000-0000-4000-8000-00000000000${++next}`,
      timeoutMs: 100,
    });
    const first = adapter({ service: 'ai', operation: 'models.read' });
    const second = adapter({ service: 'payment', operation: 'orders.read' });
    const responses = [
      ['50000000-0000-4000-8000-000000000002', 'v4.public.second'],
      ['50000000-0000-4000-8000-000000000001', 'v4.public.first'],
    ] as const;
    for (const [requestId, token] of responses) {
      for (const listener of h.listeners) {
        listener({
          origin: 'https://app.openopc.example',
          source: h.hostWindow,
          data: {
            type: 'openopc.module-service.token.response',
            requestId,
            token,
            expiresAt: '2026-08-01T00:05:00.000Z',
          },
        });
      }
    }
    await expect(first).resolves.toBe('v4.public.first');
    await expect(second).resolves.toBe('v4.public.second');
  });

  test('cleans up on timeout, postMessage failure, and invalid inputs', async () => {
    const h = harness();
    const adapter = createOpenOpcBrowserCapabilityTokenAdapter({
      hostOrigin: 'https://app.openopc.example',
      hostWindow: h.hostWindow,
      eventTarget: h.eventTarget,
      requestId: () => '50000000-0000-4000-8000-000000000005',
      timeoutMs: 5,
    });
    await expect(adapter({ service: 'ai', operation: 'models.read' })).rejects.toThrow('timed out');
    expect(h.listeners.size).toBe(0);
    expect(() =>
      createOpenOpcBrowserCapabilityTokenAdapter({
        hostOrigin: 'http://app.openopc.example',
        hostWindow: h.hostWindow,
        eventTarget: h.eventTarget,
      }),
    ).toThrow(OpenOpcBrowserCapabilityTokenProtocolError);
    await expect(
      adapter({ service: 'payment', operation: 'text.stream' as never }),
    ).rejects.toThrow('operation is invalid');
    const failing = createOpenOpcBrowserCapabilityTokenAdapter({
      hostOrigin: 'https://app.openopc.example',
      hostWindow: {
        postMessage() {
          throw new Error('transport detail');
        },
      },
      eventTarget: h.eventTarget,
      requestId: () => '50000000-0000-4000-8000-000000000006',
    });
    await expect(failing({ service: 'ai', operation: 'models.read' })).rejects.toThrow(
      'request failed',
    );
    expect(h.listeners.size).toBe(0);
  });

  test('cancels a pending token request when the module aborts it', async () => {
    const h = harness();
    const controller = new AbortController();
    const adapter = createOpenOpcBrowserCapabilityTokenAdapter({
      hostOrigin: 'https://app.openopc.example',
      hostWindow: h.hostWindow,
      eventTarget: h.eventTarget,
      timeoutMs: 100,
    });

    const pending = adapter(
      {
        service: 'ai',
        operation: 'models.read',
      },
      { signal: controller.signal },
    );
    expect(h.listeners.size).toBe(1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_ABORTED',
    });
    expect(h.listeners.size).toBe(0);
  });
});
