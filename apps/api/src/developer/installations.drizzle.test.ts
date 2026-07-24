import { describe, expect, test } from 'bun:test';
import {
  type Database,
  projectModuleInstallationEvents,
  projectModuleInstallations,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { ProjectModuleInstallationError } from './installations';
import { createDrizzleProjectModuleInstallationRepository } from './installations.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000003';
const EVENT_ID = '40000000-0000-4000-a000-000000000004';
const USER_ID = '50000000-0000-4000-a000-000000000005';
const RELEASE_V1 = '60000000-0000-4000-a000-000000000001';
const RELEASE_V2 = '60000000-0000-4000-a000-000000000002';
const MODULE_ID = 'acme.recruiting';
const CREATED_AT = '2026-07-24T16:00:00.000Z';

const installationRow = {
  installationId: INSTALLATION_ID,
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  moduleId: MODULE_ID,
  activeReleaseId: RELEASE_V1,
  activeVersion: '1.0.0',
  installRevision: 1,
  status: 'active' as const,
  installedBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const eventRow = {
  installationEventId: EVENT_ID,
  installationId: INSTALLATION_ID,
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  sequence: 1,
  action: 'install' as const,
  fromReleaseId: null,
  toReleaseId: RELEASE_V1,
  expectedRevision: 0,
  resultingRevision: 1,
  idempotencyKey: 'install-v1',
  actorUserId: USER_ID,
  createdAt: CREATED_AT,
};

type SelectFixture = { table: unknown; rows: unknown[] };
type FixtureInput = {
  selects?: SelectFixture[];
  inserts?: unknown[][];
  updates?: unknown[][];
  insertErrors?: unknown[];
};

function databaseFixture(input: FixtureInput = {}) {
  const selects = [...(input.selects ?? [])];
  const inserts = [...(input.inserts ?? [])];
  const updates = [...(input.updates ?? [])];
  const insertErrors = [...(input.insertErrors ?? [])];
  const selectRecords: Array<{
    table: unknown;
    condition?: unknown;
    joins: Array<{ table: unknown; condition: unknown }>;
    orderBy?: unknown[];
    limit?: number;
  }> = [];
  const insertRecords: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const updateRecords: Array<{
    table: unknown;
    values: Record<string, unknown>;
    condition: unknown;
  }> = [];
  const operations: string[] = [];

  const query = {
    select(_projection?: unknown) {
      return {
        from(table: unknown) {
          const fixture = selects.shift();
          if (!fixture || fixture.table !== table) throw new Error('Unexpected select table');
          const record = { table, joins: [] } as (typeof selectRecords)[number];
          selectRecords.push(record);
          const terminal = {
            leftJoin(joinTable: unknown, condition: unknown) {
              record.joins.push({ table: joinTable, condition });
              return terminal;
            },
            where(condition: unknown) {
              record.condition = condition;
              return terminal;
            },
            orderBy(...orderBy: unknown[]) {
              record.orderBy = orderBy;
              return terminal;
            },
            limit(limit: number) {
              record.limit = limit;
              return terminal;
            },
            // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are PromiseLike.
            then<TResult1 = unknown[], TResult2 = never>(
              onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              return Promise.resolve(fixture.rows).then(onfulfilled, onrejected);
            },
          };
          return terminal;
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          insertRecords.push({ table, values });
          operations.push(
            table === projectModuleInstallations ? 'insert-installation' : 'insert-event',
          );
          return {
            async returning() {
              const error = insertErrors.shift();
              if (error) throw error;
              return inserts.shift() ?? [];
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              updateRecords.push({ table, values, condition });
              operations.push('update-installation');
              return {
                async returning() {
                  return updates.shift() ?? [];
                },
              };
            },
          };
        },
      };
    },
  };

  const database = {
    ...query,
    async transaction(run: (tx: typeof query) => Promise<unknown>) {
      return run(query);
    },
  } as unknown as Database;

  return { database, selectRecords, insertRecords, updateRecords, operations };
}

function conditionParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('project module installation Drizzle repository', () => {
  test('scopes reads to one account/project and marks revoked active pointers blocked', async () => {
    const fixture = databaseFixture({
      selects: [
        {
          table: projectModuleInstallations,
          rows: [{ installation: installationRow, releaseStatus: 'revoked' }],
        },
        {
          table: projectModuleInstallations,
          rows: [{ installation: installationRow, releaseStatus: 'published' }],
        },
        { table: projectModuleInstallationEvents, rows: [{ installationEventId: EVENT_ID }] },
      ],
    });
    const repository = createDrizzleProjectModuleInstallationRepository(fixture.database);

    await expect(repository.list(ACCOUNT_ID, PROJECT_ID)).resolves.toEqual([
      expect.objectContaining({ status: 'blocked', active_release_id: RELEASE_V1 }),
    ]);
    await expect(repository.get(ACCOUNT_ID, PROJECT_ID, MODULE_ID)).resolves.toEqual(
      expect.objectContaining({ status: 'active' }),
    );
    await expect(repository.hasHistoricalTarget(INSTALLATION_ID, RELEASE_V1)).resolves.toBe(true);

    expect(conditionParams(fixture.selectRecords[0]?.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID]),
    );
    expect(conditionParams(fixture.selectRecords[1]?.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, MODULE_ID]),
    );
    expect(conditionParams(fixture.selectRecords[2]?.condition)).toEqual(
      expect.arrayContaining([INSTALLATION_ID, RELEASE_V1]),
    );
  });

  test('inserts one project pointer and immutable install event in one transaction', async () => {
    const fixture = databaseFixture({ inserts: [[installationRow], [eventRow]] });
    const repository = createDrizzleProjectModuleInstallationRepository(fixture.database);

    const result = await repository.install({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
      idempotencyKey: 'install-v1',
      moduleId: MODULE_ID,
      moduleVersion: '1.0.0',
    });

    expect(fixture.operations).toEqual(['insert-installation', 'insert-event']);
    expect(fixture.insertRecords[0]?.values).toEqual(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        moduleId: MODULE_ID,
        activeReleaseId: RELEASE_V1,
        activeVersion: '1.0.0',
        installRevision: 1,
      }),
    );
    expect(fixture.insertRecords[1]?.values).toEqual(
      expect.objectContaining({
        action: 'install',
        sequence: 1,
        idempotencyKey: 'install-v1',
      }),
    );
    expect(result.event.action).toBe('install');
  });

  test('fences a move and appends its exact revision event atomically', async () => {
    const updatedRow = {
      ...installationRow,
      activeReleaseId: RELEASE_V2,
      activeVersion: '2.0.0',
      installRevision: 2,
    };
    const updateEvent = {
      ...eventRow,
      sequence: 2,
      action: 'update' as const,
      fromReleaseId: RELEASE_V1,
      toReleaseId: RELEASE_V2,
      expectedRevision: 1,
      resultingRevision: 2,
      idempotencyKey: 'update-v2',
    };
    const fixture = databaseFixture({ updates: [[updatedRow]], inserts: [[updateEvent]] });
    const repository = createDrizzleProjectModuleInstallationRepository(fixture.database);

    const result = await repository.move({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      moduleId: MODULE_ID,
      actorUserId: USER_ID,
      releaseId: RELEASE_V2,
      moduleVersion: '2.0.0',
      fromReleaseId: RELEASE_V1,
      action: 'update',
      expectedInstallRevision: 1,
      idempotencyKey: 'update-v2',
    });

    expect(fixture.operations).toEqual(['update-installation', 'insert-event']);
    expect(conditionParams(fixture.updateRecords[0]?.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, MODULE_ID, 1, RELEASE_V1, RELEASE_V2]),
    );
    expect(fixture.insertRecords[0]?.values).toEqual(
      expect.objectContaining({
        fromReleaseId: RELEASE_V1,
        toReleaseId: RELEASE_V2,
        expectedRevision: 1,
        resultingRevision: 2,
      }),
    );
    expect(result.installation.install_revision).toBe(2);
  });

  test('classifies a zero-row move as not-found or conflict without inserting an event', async () => {
    const missing = databaseFixture({
      updates: [[]],
      selects: [{ table: projectModuleInstallations, rows: [] }],
    });
    await expect(
      createDrizzleProjectModuleInstallationRepository(missing.database).move({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        moduleId: MODULE_ID,
        actorUserId: USER_ID,
        releaseId: RELEASE_V2,
        moduleVersion: '2.0.0',
        fromReleaseId: RELEASE_V1,
        action: 'update',
        expectedInstallRevision: 1,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'PROJECT_MODULE_NOT_FOUND', status: 404 }));
    expect(missing.operations).toEqual(['update-installation']);

    const stale = databaseFixture({
      updates: [[]],
      selects: [{ table: projectModuleInstallations, rows: [installationRow] }],
    });
    await expect(
      createDrizzleProjectModuleInstallationRepository(stale.database).move({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        moduleId: MODULE_ID,
        actorUserId: USER_ID,
        releaseId: RELEASE_V2,
        moduleVersion: '2.0.0',
        fromReleaseId: RELEASE_V1,
        action: 'update',
        expectedInstallRevision: 0,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'PROJECT_MODULE_INSTALL_CONFLICT', status: 409 }),
    );
    expect(stale.operations).toEqual(['update-installation']);
  });

  test('recovers the committed result by project-scoped idempotency key', async () => {
    const fixture = databaseFixture({
      selects: [
        {
          table: projectModuleInstallationEvents,
          rows: [
            {
              event: eventRow,
              installation: installationRow,
              releaseVersion: '1.0.0',
              releaseStatus: 'published',
            },
          ],
        },
      ],
    });
    const repository = createDrizzleProjectModuleInstallationRepository(fixture.database);

    await expect(
      repository.findIdempotentResult({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        idempotencyKey: 'install-v1',
        action: 'update',
        releaseId: RELEASE_V2,
      }),
    ).resolves.toEqual({
      installation: expect.objectContaining({ active_release_id: RELEASE_V1, install_revision: 1 }),
      event: expect.objectContaining({ action: 'install', to_release_id: RELEASE_V1 }),
    });
    expect(conditionParams(fixture.selectRecords[0]?.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, 'install-v1']),
    );
  });

  test('does not hide an event failure after a fenced pointer mutation', async () => {
    const error = new Error('event insert failed');
    const fixture = databaseFixture({
      updates: [[{ ...installationRow, installRevision: 2 }]],
      insertErrors: [error],
    });
    const repository = createDrizzleProjectModuleInstallationRepository(fixture.database);

    await expect(
      repository.move({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        moduleId: MODULE_ID,
        actorUserId: USER_ID,
        releaseId: RELEASE_V2,
        moduleVersion: '2.0.0',
        fromReleaseId: RELEASE_V1,
        action: 'update',
        expectedInstallRevision: 1,
      }),
    ).rejects.toBe(error);
    expect(fixture.operations).toEqual(['update-installation', 'insert-event']);
  });

  test('maps database uniqueness races to the stable installation conflict', async () => {
    const unique = Object.assign(new Error('duplicate key'), { code: '23505' });
    const fixture = databaseFixture({ insertErrors: [unique] });
    const repository = createDrizzleProjectModuleInstallationRepository(fixture.database);

    await expect(
      repository.install({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        releaseId: RELEASE_V1,
        expectedInstallRevision: 0,
        moduleId: MODULE_ID,
        moduleVersion: '1.0.0',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MODULE_INSTALL_CONFLICT', status: 409 });
  });
});

test('exposes stable Drizzle conflict errors', () => {
  const error = new ProjectModuleInstallationError('PROJECT_MODULE_INSTALL_CONFLICT', 409);
  expect(error.status).toBe(409);
});
