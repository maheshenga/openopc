import { describe, expect, test } from 'bun:test';

import {
  OpenOpcModuleProtocolError,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
  createOpenOpcModuleClient,
} from './index';

const TOKEN = `v4.public.${'a'.repeat(48)}`;

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenOPC data and settings clients', () => {
  test('requests the exact data capabilities and validates document responses', async () => {
    const capabilities: Array<[OpenOpcServiceName, OpenOpcServiceOperation]> = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      {
        data: [],
        next_cursor: null,
      },
      {
        key: 'canvas/project-1',
        revision: 1,
        etag: '"rev-1"',
        value: { nodes: [] },
        updated_at: '2026-08-11T00:00:00.000Z',
      },
      {
        key: 'canvas/project-1',
        revision: 2,
        etag: '"rev-2"',
        value: { nodes: [{ id: 'one' }] },
        updated_at: '2026-08-11T00:01:00.000Z',
      },
      { ok: true },
    ];
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken(input) {
        capabilities.push([input.service, input.operation]);
        return TOKEN;
      },
      async fetch(input, init) {
        requests.push({ url: String(input), init });
        return jsonResponse(responses.shift());
      },
    });

    await client.data.documents.list({ limit: 25 });
    await client.data.documents.read('canvas/project-1');
    await client.data.documents.write('canvas/project-1', {
      expected_revision: 1,
      value: { nodes: [{ id: 'one' }] },
    });
    await client.data.documents.delete('canvas/project-1', 2);

    expect(capabilities).toEqual([
      ['data', 'documents.list'],
      ['data', 'documents.read'],
      ['data', 'documents.write'],
      ['data', 'documents.delete'],
    ]);
    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ['GET', 'https://platform.example.com/v1/module-services/data/documents?limit=25'],
      [
        'GET',
        'https://platform.example.com/v1/module-services/data/document?key=canvas%2Fproject-1',
      ],
      ['PUT', 'https://platform.example.com/v1/module-services/data/document'],
      ['DELETE', 'https://platform.example.com/v1/module-services/data/document'],
    ]);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      key: 'canvas/project-1',
      expected_revision: 1,
      value: { nodes: [{ id: 'one' }] },
    });
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      key: 'canvas/project-1',
      expected_revision: 2,
    });
  });

  test('reads effective settings through the settings.read capability', async () => {
    const requested: Array<[OpenOpcServiceName, OpenOpcServiceOperation]> = [];
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken(input) {
        requested.push([input.service, input.operation]);
        return TOKEN;
      },
      async fetch() {
        return jsonResponse({
          schema_version: 1,
          revision: 3,
          values: { 'canvas.autosave': true, 'canvas.snap_size': 16 },
          loaded_at: '2026-08-11T00:00:00.000Z',
        });
      },
    });

    const settings = await client.settings.read();
    expect(settings.values).toEqual({ 'canvas.autosave': true, 'canvas.snap_size': 16 });
    expect(requested).toEqual([['settings', 'settings.read']]);
  });

  test('rejects unsafe document keys before requesting a capability', async () => {
    let capabilities = 0;
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken() {
        capabilities += 1;
        return TOKEN;
      },
      async fetch() {
        return jsonResponse({});
      },
    });

    expect(client.data.documents.read('../secret')).rejects.toBeInstanceOf(
      OpenOpcModuleProtocolError,
    );
    expect(capabilities).toBe(0);
  });

  test('forwards AbortSignal and removes its listener after settings completion', async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((
      ...args: Parameters<AbortSignal['addEventListener']>
    ) => {
      added += 1;
      return add(...args);
    }) as AbortSignal['addEventListener'];
    controller.signal.removeEventListener = ((
      ...args: Parameters<AbortSignal['removeEventListener']>
    ) => {
      removed += 1;
      return remove(...args);
    }) as AbortSignal['removeEventListener'];
    const client = createOpenOpcModuleClient({
      baseUrl: 'https://platform.example.com',
      async getCapabilityToken(_input, options) {
        expect(options?.signal).toBeDefined();
        return TOKEN;
      },
      async fetch(_input, init) {
        expect(init?.signal).toBeDefined();
        return jsonResponse({
          schema_version: 1,
          revision: 0,
          values: {},
          loaded_at: '2026-08-11T00:00:00.000Z',
        });
      },
    });

    await client.settings.read({ signal: controller.signal });
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});
