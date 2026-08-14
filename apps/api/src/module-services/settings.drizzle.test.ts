import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { ModuleSettingsError } from './settings';
import { createDrizzleModuleSettingsRepository } from './settings.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const USER_ID = '40000000-0000-4000-a000-000000000001';

const manifest = {
  schemaVersion: 3,
  id: 'openopc.infinite-canvas',
  version: '1.0.0',
  publisher: { id: 'openopc' },
  locales: ['zh-CN'],
  compatibility: { platform: '>=1.0.0' },
  execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
  verification: { profile: 'sandboxed-web' },
  capabilities: [],
  openopc: {
    sdkApiVersion: 'v1',
    services: { settings: { operations: ['settings.read'] } },
    settings: {
      fields: [{ key: 'canvas.autosave', label: 'Autosave', type: 'boolean', default: true }],
    },
  },
} as const;

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

describe('module settings Drizzle repository', () => {
  test('loads only the signed release declaration and stored scalar values', async () => {
    const state = fixture([
      [{ manifest }],
      [{ revision: 4 }],
      [
        {
          revision: 4,
          settingKey: 'canvas.autosave',
          value: false,
        },
      ],
    ]);
    const repository = createDrizzleModuleSettingsRepository(state.database);
    await expect(repository.loadDefinition(scope)).resolves.toEqual({
      fields: [{ key: 'canvas.autosave', label: 'Autosave', type: 'boolean', default: true }],
    });
    await expect(repository.readValues(scope)).resolves.toEqual({
      revision: 4,
      values: { 'canvas.autosave': false },
    });
    expect(state.queries[0]?.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID]),
    );
    expect(state.queries.join('\n')).not.toMatch(/api_key|provider_url/i);
  });

  test('locks the aggregate revision and writes actor-bound values atomically', async () => {
    const state = fixture([
      [{ settingsId: '90000000-0000-4000-a000-000000000001', revision: 4 }],
      [],
      [],
      [{ revision: 5 }],
    ]);
    const repository = createDrizzleModuleSettingsRepository(state.database);
    await expect(
      repository.replaceValues({
        ...scope,
        actorUserId: USER_ID,
        expectedRevision: 4,
        values: { 'canvas.autosave': false },
      }),
    ).resolves.toEqual({ revision: 5, values: { 'canvas.autosave': false } });
    expect(state.queries[0]?.sql).toMatch(/project_module_settings[\s\S]*FOR UPDATE/);
    expect(state.queries[0]?.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID]),
    );
    expect(state.queries[3]?.params).toEqual(expect.arrayContaining([4]));
    expect(state.queries[2]?.params).toEqual(expect.arrayContaining([USER_ID]));
  });

  test('rejects an optimistic revision mismatch before any value write', async () => {
    const state = fixture([[{ settingsId: '90000000-0000-4000-a000-000000000001', revision: 5 }]]);
    const repository = createDrizzleModuleSettingsRepository(state.database);
    await expect(
      repository.replaceValues({
        ...scope,
        actorUserId: USER_ID,
        expectedRevision: 4,
        values: { 'canvas.autosave': true },
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SERVICE_CONFLICT', status: 409 });
    expect(state.queries).toHaveLength(1);
    expect(ModuleSettingsError).toBeDefined();
  });
});
