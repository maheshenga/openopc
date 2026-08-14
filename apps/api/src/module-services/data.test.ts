import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

import { ModuleDataError, type ModuleDataStore, createModuleDataRoutes } from './data';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';

function claims(): Extract<ModuleServiceCapabilityClaimsV1, { service: 'data' }> {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '40000000-0000-4000-8000-000000000001',
    iat: '2026-08-11T00:00:00.000Z',
    exp: '2026-08-11T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 3,
    releaseId: '50000000-0000-4000-8000-000000000001',
    moduleId: 'openopc.infinite-canvas',
    moduleVersion: '1.0.0',
    consentId: '60000000-0000-4000-8000-000000000001',
    grantId: '70000000-0000-4000-8000-000000000001',
    service: 'data',
    operations: ['documents.list', 'documents.read', 'documents.write', 'documents.delete'],
  };
}

function appWith(storeOverrides: Partial<ModuleDataStore> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const store: ModuleDataStore = {
    async listDocuments(input) {
      calls.push({ kind: 'list', ...input });
      return {
        documents: [
          {
            key: 'canvas/main',
            revision: 2,
            value: { elements: [] },
            updatedAt: '2026-08-11T01:00:00.000Z',
          },
        ],
        nextCursor: null,
      };
    },
    async readDocument(input) {
      calls.push({ kind: 'read', ...input });
      return {
        key: input.key,
        revision: 2,
        value: { elements: [] },
        updatedAt: '2026-08-11T01:00:00.000Z',
      };
    },
    async writeDocument(input) {
      calls.push({ kind: 'write', ...input });
      return {
        key: input.key,
        revision: (input.expectedRevision ?? 0) + 1,
        value: input.value,
        updatedAt: '2026-08-11T01:01:00.000Z',
      };
    },
    async deleteDocument(input) {
      calls.push({ kind: 'delete', ...input });
    },
    ...storeOverrides,
  };
  const capabilityCalls: string[] = [];
  const app = createModuleDataRoutes({
    async requireCapability(authorization, operation) {
      expect(authorization).toBe('Bearer scoped');
      capabilityCalls.push(operation);
      return claims();
    },
    store,
  });
  return { app, calls, capabilityCalls };
}

describe('OpenOPC module data routes', () => {
  test('lists only capability-bound installation documents with bounded pagination', async () => {
    const { app, calls, capabilityCalls } = appWith();
    const response = await app.request('/documents?limit=25', {
      headers: { authorization: 'Bearer scoped' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          key: 'canvas/main',
          revision: 2,
          etag: '"rev-2"',
          value: { elements: [] },
          updated_at: '2026-08-11T01:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    expect(capabilityCalls).toEqual(['documents.list']);
    expect(calls).toEqual([
      {
        kind: 'list',
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        cursor: null,
        limit: 25,
      },
    ]);
  });

  test('reads, writes, and deletes a safe key with exact revision semantics', async () => {
    const { app, calls, capabilityCalls } = appWith();
    const path = '/document';

    const read = await app.request(`${path}?key=canvas%2Fmain`, {
      headers: { authorization: 'Bearer scoped' },
    });
    const write = await app.request(path, {
      method: 'PUT',
      headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'canvas/main',
        expected_revision: 2,
        value: { elements: [{ id: 'shape-1' }] },
      }),
    });
    const deleted = await app.request(path, {
      method: 'DELETE',
      headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'canvas/main', expected_revision: 3 }),
    });

    expect(read.status).toBe(200);
    expect(write.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(capabilityCalls).toEqual(['documents.read', 'documents.write', 'documents.delete']);
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'read', key: 'canvas/main' }),
      expect.objectContaining({
        kind: 'write',
        key: 'canvas/main',
        expectedRevision: 2,
        value: { elements: [{ id: 'shape-1' }] },
      }),
      expect.objectContaining({ kind: 'delete', key: 'canvas/main', expectedRevision: 3 }),
    ]);
  });

  test('fails closed on malformed input and maps storage conflicts without leaking details', async () => {
    const { app, calls } = appWith({
      async writeDocument() {
        throw new ModuleDataError('MODULE_SERVICE_CONFLICT', 409);
      },
    });

    const invalid = await app.request('/document', {
      method: 'PUT',
      headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'canvas/main',
        expected_revision: 0,
        value: {},
        account_id: ACCOUNT_ID,
      }),
    });
    const conflict = await app.request('/document', {
      method: 'PUT',
      headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'canvas/main',
        expected_revision: 4,
        value: { elements: [] },
      }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'MODULE_SERVICE_INPUT_INVALID' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'MODULE_SERVICE_CONFLICT' });
    expect(calls).toEqual([]);
  });
});
