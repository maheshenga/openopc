import { describe, expect, test } from 'bun:test';
import {
  type Database,
  accountMembers,
  developerModuleReleaseReviewEvents,
  developerModuleReleases,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { DeveloperModuleReviewError, type DeveloperModuleReviewEvidence } from './reviews';
import { createDrizzleDeveloperModuleReviewRepository } from './reviews.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const EVENT_ID = '40000000-0000-4000-a000-000000000004';
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const UPDATED_AT = '2026-07-24T14:00:00.000Z';

const releaseRow = {
  releaseId: RELEASE_ID,
  accountId: ACCOUNT_ID,
  publisherId: 'acme',
  itemName: 'recruiting-workbench',
  moduleId: 'acme.recruiting',
  moduleVersion: '1.0.0',
  manifest: {
    schemaVersion: 2,
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
  status: 'review_pending' as const,
  reviewRevision: 1,
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const evidence = [
  {
    requirement: 'manifest_review',
    outcome: 'passed',
    method: 'manual',
    summary: 'Manifest review passed',
    observed_at: '2026-07-24T13:00:00.000Z',
  },
  {
    requirement: 'source_scan',
    outcome: 'passed',
    method: 'system_attestation',
    run_id: '60000000-0000-4000-a000-000000000006',
    evidence_digest: `sha256:${'e'.repeat(64)}`,
    policy_digest: `sha256:${'f'.repeat(64)}`,
  },
  {
    requirement: 'human_review',
    outcome: 'passed',
    method: 'manual',
    summary: 'Human review passed',
    observed_at: '2026-07-24T13:00:00.000Z',
  },
] satisfies DeveloperModuleReviewEvidence[];

const eventRow = {
  reviewEventId: EVENT_ID,
  releaseId: RELEASE_ID,
  accountId: ACCOUNT_ID,
  sequence: 2,
  action: 'approve' as const,
  fromStatus: 'review_pending' as const,
  toStatus: 'approved' as const,
  actorUserId: USER_ID,
  actorKind: 'platform_admin' as const,
  reason: null,
  evidence,
  createdAt: UPDATED_AT,
};

type SelectFixture = { table: unknown; rows: unknown[] };
type FixtureInput = {
  selects?: SelectFixture[];
  updates?: unknown[][];
  inserts?: unknown[][];
};

function databaseFixture(input: FixtureInput = {}) {
  const selects = [...(input.selects ?? [])];
  const updates = [...(input.updates ?? [])];
  const inserts = [...(input.inserts ?? [])];
  const selectRecords: Array<{
    table: unknown;
    condition?: unknown;
    limit?: number;
    orderBy?: unknown[];
  }> = [];
  const updateRecords: Array<{ values: Record<string, unknown>; condition: unknown }> = [];
  const insertRecords: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const operations: string[] = [];
  let transactions = 0;

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
              return Promise.resolve(rows);
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
              return {
                ...terminal,
                orderBy(...orderBy: unknown[]) {
                  record.orderBy = orderBy;
                  return terminal;
                },
              };
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
      return {
        values(values: Record<string, unknown>) {
          insertRecords.push({ table, values });
          operations.push('insert');
          return {
            async returning() {
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
      transactions += 1;
      return run(query);
    },
  } as unknown as Database;

  return {
    database,
    selectRecords,
    updateRecords,
    insertRecords,
    operations,
    transactions: () => transactions,
  };
}

function conditionParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('developer module review Drizzle repository', () => {
  test('keeps publisher reads and history account scoped while admin reads remain separate', async () => {
    const fixture = databaseFixture({
      selects: [
        { table: developerModuleReleases, rows: [releaseRow] },
        { table: developerModuleReleaseReviewEvents, rows: [eventRow] },
        { table: developerModuleReleases, rows: [releaseRow] },
        { table: accountMembers, rows: [{ userId: USER_ID }] },
      ],
    });
    const repository = createDrizzleDeveloperModuleReviewRepository(fixture.database);

    await expect(repository.getPublisher(ACCOUNT_ID, RELEASE_ID)).resolves.toEqual(
      expect.objectContaining({ account_id: ACCOUNT_ID, release_id: RELEASE_ID }),
    );
    await expect(repository.history(ACCOUNT_ID, RELEASE_ID)).resolves.toHaveLength(1);
    await expect(repository.getAdmin(RELEASE_ID)).resolves.toEqual(
      expect.objectContaining({ release_id: RELEASE_ID }),
    );
    await expect(repository.isPublisherAccountMember(ACCOUNT_ID, USER_ID)).resolves.toBe(true);

    const [publisherSelect, historySelect, adminSelect, membershipSelect] = fixture.selectRecords;
    if (!publisherSelect || !historySelect || !adminSelect || !membershipSelect) {
      throw new Error('Expected publisher, history, admin, and membership selects');
    }
    expect(conditionParams(publisherSelect.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, RELEASE_ID]),
    );
    expect(conditionParams(historySelect.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, RELEASE_ID]),
    );
    expect(conditionParams(adminSelect.condition)).toEqual([RELEASE_ID]);
    expect(conditionParams(membershipSelect.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, USER_ID]),
    );
  });

  test('commits a fenced update and immutable event append in one transaction', async () => {
    const updatedRelease = {
      ...releaseRow,
      status: 'approved' as const,
      reviewRevision: 2,
      updatedAt: UPDATED_AT,
    };
    const fixture = databaseFixture({ updates: [[updatedRelease]], inserts: [[eventRow]] });
    const repository = createDrizzleDeveloperModuleReviewRepository(fixture.database);

    const result = await repository.transition({
      accountId: ACCOUNT_ID,
      releaseId: RELEASE_ID,
      expectedStatus: 'review_pending',
      expectedRevision: 1,
      action: 'approve',
      toStatus: 'approved',
      actorUserId: USER_ID,
      actorKind: 'platform_admin',
      reason: null,
      evidence,
    });

    expect(fixture.transactions()).toBe(1);
    expect(fixture.operations).toEqual(['update', 'insert']);
    const [updateRecord] = fixture.updateRecords;
    const [insertRecord] = fixture.insertRecords;
    if (!updateRecord || !insertRecord) throw new Error('Expected review update and event insert');
    expect(conditionParams(updateRecord.condition)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, RELEASE_ID, 'review_pending', 1]),
    );
    expect(updateRecord.values.status).toBe('approved');
    expect(insertRecord).toEqual(
      expect.objectContaining({
        table: developerModuleReleaseReviewEvents,
        values: expect.objectContaining({
          releaseId: RELEASE_ID,
          accountId: ACCOUNT_ID,
          sequence: 2,
          action: 'approve',
          evidence,
        }),
      }),
    );
    expect(insertRecord.values.evidence).not.toBe(evidence);
    expect(result).toEqual({
      release: expect.objectContaining({ status: 'approved', review_revision: 2 }),
      event: expect.objectContaining({ sequence: 2, action: 'approve' }),
    });
  });

  test('maps a zero-row fenced update to not-found or conflict using a scoped follow-up read', async () => {
    const missing = databaseFixture({
      updates: [[]],
      selects: [{ table: developerModuleReleases, rows: [] }],
    });
    await expect(
      createDrizzleDeveloperModuleReviewRepository(missing.database).transition({
        accountId: OTHER_ACCOUNT_ID,
        releaseId: RELEASE_ID,
        expectedStatus: 'review_pending',
        expectedRevision: 1,
        action: 'request_changes',
        toStatus: 'changes_requested',
        actorUserId: USER_ID,
        actorKind: 'platform_admin',
        reason: 'More detail is required.',
        evidence: [],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 }),
    );
    const [missingSelect] = missing.selectRecords;
    if (!missingSelect) throw new Error('Expected scoped release lookup');
    expect(conditionParams(missingSelect.condition)).toEqual(
      expect.arrayContaining([OTHER_ACCOUNT_ID, RELEASE_ID]),
    );

    const stale = databaseFixture({
      updates: [[]],
      selects: [{ table: developerModuleReleases, rows: [releaseRow] }],
    });
    await expect(
      createDrizzleDeveloperModuleReviewRepository(stale.database).transition({
        accountId: ACCOUNT_ID,
        releaseId: RELEASE_ID,
        expectedStatus: 'review_pending',
        expectedRevision: 0,
        action: 'request_changes',
        toStatus: 'changes_requested',
        actorUserId: USER_ID,
        actorKind: 'platform_admin',
        reason: 'More detail is required.',
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(DeveloperModuleReviewError);
    await expect(
      createDrizzleDeveloperModuleReviewRepository(
        databaseFixture({
          updates: [[]],
          selects: [{ table: developerModuleReleases, rows: [releaseRow] }],
        }).database,
      ).transition({
        accountId: ACCOUNT_ID,
        releaseId: RELEASE_ID,
        expectedStatus: 'review_pending',
        expectedRevision: 0,
        action: 'request_changes',
        toStatus: 'changes_requested',
        actorUserId: USER_ID,
        actorKind: 'platform_admin',
        reason: 'More detail is required.',
        evidence: [],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'DEVELOPER_REVIEW_CONFLICT', status: 409 }));
  });

  test('uses bounded keyset pagination for the global admin queue', async () => {
    const older = {
      ...releaseRow,
      releaseId: '30000000-0000-4000-a000-000000000001',
      updatedAt: '2026-07-24T11:00:00.000Z',
    };
    const middle = {
      ...releaseRow,
      releaseId: '30000000-0000-4000-a000-000000000002',
      updatedAt: '2026-07-24T12:00:00.000Z',
    };
    const fixture = databaseFixture({
      selects: [
        { table: developerModuleReleases, rows: [releaseRow, middle, older] },
        { table: developerModuleReleases, rows: [older] },
      ],
    });
    const repository = createDrizzleDeveloperModuleReviewRepository(fixture.database);

    const first = await repository.adminList({ status: 'review_pending', limit: 2 });
    expect(first.releases).toHaveLength(2);
    expect(first.next_cursor).toBeString();
    await repository.adminList({
      status: 'review_pending',
      limit: 500,
      cursor: first.next_cursor,
    });

    const [firstPageSelect, secondPageSelect] = fixture.selectRecords;
    if (!firstPageSelect || !secondPageSelect) throw new Error('Expected two admin queue selects');
    expect(firstPageSelect.limit).toBe(3);
    expect(secondPageSelect.limit).toBe(101);
    expect(conditionParams(secondPageSelect.condition)).toEqual(
      expect.arrayContaining(['review_pending', middle.updatedAt, middle.releaseId]),
    );
  });
});
