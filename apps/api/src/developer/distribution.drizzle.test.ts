import { describe, expect, test } from 'bun:test';
import {
  type Database,
  accountMembers,
  developerModuleReleaseDistributionEvents,
  developerModuleReleases,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { DeveloperModuleDistributionError } from './distribution';
import { createDrizzleDeveloperModuleDistributionRepository } from './distribution.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const EVENT_ID = '40000000-0000-4000-a000-000000000004';
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const SIGNED_AT = '2026-07-24T13:00:00.000Z';
const PUBLISHED_AT = '2026-07-24T14:00:00.000Z';

const releaseRow = {
  releaseId: RELEASE_ID,
  accountId: ACCOUNT_ID,
  publisherId: 'acme',
  itemName: 'recruiting-workbench',
  moduleId: 'acme.recruiting',
  moduleVersion: '1.0.0',
  manifest: {
    schemaVersion: 1,
    id: 'acme.recruiting',
    version: '1.0.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'industry',
    locales: ['en'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode: 'declarative' },
  },
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  reviewRequirements: ['manifest_review', 'source_scan', 'human_review'],
  status: 'approved' as const,
  reviewRevision: 2,
  signatureAlgorithm: null,
  signatureKeyId: null,
  signature: null,
  signaturePayloadDigest: null,
  signedAt: null,
  publishedAt: null,
  revokedAt: null,
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const signedRow = {
  ...releaseRow,
  status: 'signed' as const,
  reviewRevision: 3,
  signatureAlgorithm: 'ed25519' as const,
  signatureKeyId: 'module-key-2026',
  signature: `base64url:${'a'.repeat(86)}`,
  signaturePayloadDigest: `sha256:${'b'.repeat(64)}`,
  signedAt: SIGNED_AT,
  updatedAt: SIGNED_AT,
};

const publishedRow = {
  ...signedRow,
  status: 'published' as const,
  reviewRevision: 4,
  publishedAt: PUBLISHED_AT,
  updatedAt: PUBLISHED_AT,
};

const distributionEventRow = {
  distributionEventId: EVENT_ID,
  releaseId: RELEASE_ID,
  accountId: ACCOUNT_ID,
  sequence: 3,
  action: 'sign' as const,
  fromStatus: 'approved' as const,
  toStatus: 'signed' as const,
  actorUserId: USER_ID,
  actorKind: 'platform_admin' as const,
  reason: null,
  createdAt: SIGNED_AT,
};

type SelectFixture = { table: unknown; rows: unknown[] };
type FixtureInput = {
  selects?: SelectFixture[];
  updates?: unknown[][];
  inserts?: unknown[][];
  insertErrors?: unknown[];
};

function databaseFixture(input: FixtureInput = {}) {
  const selects = [...(input.selects ?? [])];
  const updates = [...(input.updates ?? [])];
  const inserts = [...(input.inserts ?? [])];
  const insertErrors = [...(input.insertErrors ?? [])];
  const selectRecords: Array<{
    table: unknown;
    condition?: unknown;
    limit?: number;
    offset?: number;
    orderBy?: unknown[];
  }> = [];
  const updateRecords: Array<{ values: Record<string, unknown>; condition: unknown }> = [];
  const insertRecords: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const operations: string[] = [];

  const query = {
    select() {
      return {
        from(table: unknown) {
          const fixture = selects.shift();
          if (!fixture || fixture.table !== table) throw new Error('Unexpected select table');
          const record = { table } as (typeof selectRecords)[number];
          selectRecords.push(record);
          const rows = fixture.rows;
          const terminal = {
            limit(limit: number) {
              record.limit = limit;
              return terminal;
            },
            offset(offset: number) {
              record.offset = offset;
              return terminal;
            },
            orderBy(...orderBy: unknown[]) {
              record.orderBy = orderBy;
              return terminal;
            },
            // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are PromiseLike.
            then<TResult1 = unknown[], TResult2 = never>(
              onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              return Promise.resolve(rows).then(onfulfilled, onrejected);
            },
          };
          return {
            where(condition: unknown) {
              record.condition = condition;
              return terminal;
            },
          };
        },
      };
    },
    update(table: unknown) {
      if (table !== developerModuleReleases) throw new Error('Unexpected update table');
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              updateRecords.push({ values, condition });
              operations.push('update');
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
    insert(table: unknown) {
      if (table !== developerModuleReleaseDistributionEvents) {
        throw new Error('Unexpected insert table');
      }
      return {
        values(values: Record<string, unknown>) {
          insertRecords.push({ table, values });
          operations.push('insert');
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
  };

  const database = {
    ...query,
    async transaction(run: (tx: typeof query) => Promise<unknown>) {
      return run(query);
    },
  } as unknown as Database;

  return { database, selectRecords, updateRecords, insertRecords, operations };
}

function conditionParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('developer module distribution Drizzle repository', () => {
  test('keeps account membership and history scoped while public reads require published status', async () => {
    const fixture = databaseFixture({
      selects: [
        { table: developerModuleReleases, rows: [releaseRow] },
        { table: accountMembers, rows: [{ userId: USER_ID }] },
        { table: developerModuleReleaseDistributionEvents, rows: [distributionEventRow] },
        { table: developerModuleReleases, rows: [publishedRow] },
        { table: developerModuleReleases, rows: [{ total: 1 }] },
        { table: developerModuleReleases, rows: [publishedRow] },
      ],
    });
    const repository = createDrizzleDeveloperModuleDistributionRepository(fixture.database);

    await expect(repository.getAdmin(RELEASE_ID)).resolves.toEqual(
      expect.objectContaining({ release_id: RELEASE_ID }),
    );
    await expect(repository.isPublisherAccountMember(ACCOUNT_ID, USER_ID)).resolves.toBe(true);
    await expect(repository.history(ACCOUNT_ID, RELEASE_ID)).resolves.toHaveLength(1);
    await expect(repository.getPublished(RELEASE_ID)).resolves.toEqual(
      expect.objectContaining({ status: 'published' }),
    );
    await expect(
      repository.listPublished({ query: 'Acme', limit: 10, offset: 2 }),
    ).resolves.toEqual(expect.objectContaining({ total: 1 }));

    const [adminSelect, memberSelect, historySelect, publishedSelect, listCountSelect, listSelect] =
      fixture.selectRecords;
    if (
      !adminSelect ||
      !memberSelect ||
      !historySelect ||
      !publishedSelect ||
      !listCountSelect ||
      !listSelect
    ) {
      throw new Error('Expected all distribution reads');
    }
    expect(conditionParams(adminSelect.condition)).toEqual([RELEASE_ID]);
    expect(conditionParams(memberSelect.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, USER_ID]),
    );
    expect(conditionParams(historySelect.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, RELEASE_ID]),
    );
    expect(conditionParams(publishedSelect.condition)).toEqual(
      expect.arrayContaining([RELEASE_ID, 'published']),
    );
    expect(conditionParams(listCountSelect.condition)).toEqual(
      expect.arrayContaining(['published']),
    );
    expect(conditionParams(listSelect.condition)).toEqual(expect.arrayContaining(['published']));
    expect(listSelect.orderBy).toHaveLength(2);
    expect(listSelect.limit).toBe(10);
    expect(listSelect.offset).toBe(2);
  });

  test('fences sign and appends exactly one immutable event in one transaction', async () => {
    const updated = { ...signedRow };
    const fixture = databaseFixture({ updates: [[updated]], inserts: [[distributionEventRow]] });
    const repository = createDrizzleDeveloperModuleDistributionRepository(fixture.database);

    const result = await repository.sign({
      releaseId: RELEASE_ID,
      actorUserId: USER_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
      signature: {
        algorithm: 'ed25519',
        key_id: 'module-key-2026',
        signature: `base64url:${'a'.repeat(86)}`,
        payload_digest: `sha256:${'b'.repeat(64)}`,
        signed_at: SIGNED_AT,
      },
    });

    expect(fixture.operations).toEqual(['update', 'insert']);
    const [updateRecord] = fixture.updateRecords;
    const [insertRecord] = fixture.insertRecords;
    if (!updateRecord || !insertRecord) throw new Error('Expected fenced update and event insert');
    expect(conditionParams(updateRecord.condition)).toEqual(
      expect.arrayContaining([RELEASE_ID, 'approved', 2]),
    );
    expect(updateRecord.values).toEqual(
      expect.objectContaining({
        status: 'signed',
        signatureAlgorithm: 'ed25519',
        signatureKeyId: 'module-key-2026',
        signature: `base64url:${'a'.repeat(86)}`,
        signaturePayloadDigest: `sha256:${'b'.repeat(64)}`,
        signedAt: SIGNED_AT,
      }),
    );
    expect(insertRecord.values).toEqual(
      expect.objectContaining({
        releaseId: RELEASE_ID,
        accountId: ACCOUNT_ID,
        sequence: 3,
        action: 'sign',
        fromStatus: 'approved',
        toStatus: 'signed',
        actorKind: 'platform_admin',
      }),
    );
    expect(result).toEqual({
      release: expect.objectContaining({ status: 'signed', review_revision: 3 }),
      event: expect.objectContaining({ action: 'sign', sequence: 3 }),
    });
  });

  test('publishes and revokes with lifecycle timestamps and fenced event sequences', async () => {
    const published = { ...publishedRow };
    const revoked = { ...publishedRow, status: 'revoked' as const, reviewRevision: 5 };
    const publishEvent = {
      ...distributionEventRow,
      sequence: 4,
      action: 'publish' as const,
      fromStatus: 'signed' as const,
      toStatus: 'published' as const,
      createdAt: PUBLISHED_AT,
    };
    const revokeEvent = {
      ...distributionEventRow,
      sequence: 5,
      action: 'revoke' as const,
      fromStatus: 'published' as const,
      toStatus: 'revoked' as const,
      reason: 'Emergency withdrawal.',
      createdAt: '2026-07-24T15:00:00.000Z',
    };
    const fixture = databaseFixture({
      updates: [[published], [revoked]],
      inserts: [[publishEvent], [revokeEvent]],
    });
    const repository = createDrizzleDeveloperModuleDistributionRepository(fixture.database);

    await repository.transition({
      releaseId: RELEASE_ID,
      actorUserId: USER_ID,
      action: 'publish',
      expectedStatus: 'signed',
      expectedRevision: 3,
      reason: null,
    });
    await repository.transition({
      releaseId: RELEASE_ID,
      actorUserId: USER_ID,
      action: 'revoke',
      expectedStatus: 'published',
      expectedRevision: 4,
      reason: 'Emergency withdrawal.',
    });

    expect(fixture.operations).toEqual(['update', 'insert', 'update', 'insert']);
    expect(fixture.updateRecords[0]?.values).toEqual(
      expect.objectContaining({ status: 'published' }),
    );
    expect(fixture.updateRecords[0]?.values.publishedAt).toBeDefined();
    expect(fixture.updateRecords[1]?.values).toEqual(
      expect.objectContaining({ status: 'revoked' }),
    );
    expect(fixture.updateRecords[1]?.values.revokedAt).toBeDefined();
    expect(fixture.insertRecords[1]?.values).toEqual(
      expect.objectContaining({ sequence: 5, action: 'revoke', reason: 'Emergency withdrawal.' }),
    );
  });

  test('classifies a zero-row fenced update as not-found or conflict without inserting an event', async () => {
    const missing = databaseFixture({
      updates: [[]],
      selects: [{ table: developerModuleReleases, rows: [] }],
    });
    await expect(
      createDrizzleDeveloperModuleDistributionRepository(missing.database).transition({
        releaseId: RELEASE_ID,
        actorUserId: USER_ID,
        action: 'publish',
        expectedStatus: 'signed',
        expectedRevision: 3,
        reason: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 }),
    );
    expect(missing.operations).toEqual(['update']);

    const stale = databaseFixture({
      updates: [[]],
      selects: [{ table: developerModuleReleases, rows: [signedRow] }],
    });
    await expect(
      createDrizzleDeveloperModuleDistributionRepository(stale.database).sign({
        releaseId: RELEASE_ID,
        actorUserId: USER_ID,
        expectedStatus: 'approved',
        expectedRevision: 2,
        signature: {
          algorithm: 'ed25519',
          key_id: 'module-key-2026',
          signature: `base64url:${'a'.repeat(86)}`,
          payload_digest: `sha256:${'b'.repeat(64)}`,
          signed_at: SIGNED_AT,
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_DISTRIBUTION_CONFLICT', status: 409 }),
    );
    expect(stale.operations).toEqual(['update']);
  });

  test('does not hide an event insert failure or claim a partial publication', async () => {
    const databaseError = new Error('event insert failed');
    const fixture = databaseFixture({ updates: [[publishedRow]], insertErrors: [databaseError] });
    const repository = createDrizzleDeveloperModuleDistributionRepository(fixture.database);

    await expect(
      repository.transition({
        releaseId: RELEASE_ID,
        actorUserId: USER_ID,
        action: 'publish',
        expectedStatus: 'signed',
        expectedRevision: 3,
        reason: null,
      }),
    ).rejects.toBe(databaseError);
    expect(fixture.operations).toEqual(['update', 'insert']);
    expect(fixture.insertRecords).toHaveLength(1);
  });
});
