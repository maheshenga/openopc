import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { ModuleDataError } from './data';
import { createDrizzleModuleDataStore } from './data.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';

function fixture(results: unknown[]) {
  const pending = [...results];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const executor = {
    async execute(query: unknown) {
      const compiled = new PgDialect().sqlToQuery(query as never);
      queries.push({ sql: compiled.sql, params: compiled.params });
      return pending.shift() ?? [];
    },
  };
  const database = {
    ...executor,
    async transaction<T>(run: (tx: typeof executor) => Promise<T>) {
      return run(executor);
    },
  } as unknown as Database;
  return { database, queries };
}

const scope = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, installationId: INSTALLATION_ID };

describe('module data Drizzle repository', () => {
  test('lists and reads only the requested installation scope', async () => {
    const fixtureState = fixture([
      [
        {
          key: 'canvas/main',
          revision: 2,
          value: { elements: [] },
          updatedAt: '2026-08-11 01:00:00+00',
        },
        {
          key: 'canvas/secondary',
          revision: 1,
          value: { elements: [1] },
          updatedAt: '2026-08-11 00:01:00+00',
        },
      ],
      [
        {
          key: 'canvas/main',
          revision: 2,
          value: { elements: [] },
          updatedAt: '2026-08-11 01:00:00+00',
        },
      ],
    ]);
    const store = createDrizzleModuleDataStore(fixtureState.database);

    await expect(store.listDocuments({ ...scope, cursor: null, limit: 1 })).resolves.toMatchObject({
      documents: [expect.objectContaining({ key: 'canvas/main', revision: 2 })],
      nextCursor: expect.any(String),
    });
    await expect(store.readDocument({ ...scope, key: 'canvas/main' })).resolves.toMatchObject({
      key: 'canvas/main',
      revision: 2,
    });

    expect(fixtureState.queries[0]?.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID, 2]),
    );
    expect(fixtureState.queries[1]?.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID, 'canvas/main']),
    );
  });

  test('uses conditional revision writes and maps an empty update to a conflict', async () => {
    const conflictState = fixture([[]]);
    const store = createDrizzleModuleDataStore(conflictState.database);

    await expect(
      store.writeDocument({
        ...scope,
        key: 'canvas/main',
        expectedRevision: 4,
        value: { elements: [] },
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_CONFLICT', status: 409 });
    expect(conflictState.queries[0]?.sql).toMatch(/UPDATE[\s\S]*project_module_documents/);
    expect(conflictState.queries[0]?.sql).toMatch(/revision/);
    expect(conflictState.queries[0]?.params).not.toContain('v4.public.secret');
  });

  test('maps missing reads to a stable not-found error and deletes by expected revision', async () => {
    const state = fixture([[], [{ documentId: '90000000-0000-4000-a000-000000000001' }]]);
    const store = createDrizzleModuleDataStore(state.database);
    await expect(store.readDocument({ ...scope, key: 'canvas/missing' })).resolves.toBeNull();
    await expect(
      store.deleteDocument({ ...scope, key: 'canvas/main', expectedRevision: 2 }),
    ).resolves.toBeUndefined();
    expect(state.queries[1]?.sql).toMatch(/DELETE[\s\S]*project_module_documents/);
    expect(state.queries[1]?.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID, 'canvas/main', 2]),
    );
    expect(ModuleDataError).toBeDefined();
  });
});
