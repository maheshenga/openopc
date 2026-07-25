import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import {
  developerModuleReleases,
  developerModuleVerificationRuns,
  developerPublishers,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { DeveloperModuleReleaseError, type DeveloperModuleReleaseInsert } from './releases';
import { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const CREATED_AT = '2026-07-24T12:00:00.000Z';

const submission: DeveloperModuleReleaseInsert = {
  accountId: ACCOUNT_ID,
  actorUserId: USER_ID,
  itemName: 'recruiting-workbench',
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
  artifactId: '40000000-0000-4000-a000-000000000004',
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  verification: {
    policyDigest: `sha256:${'c'.repeat(64)}`,
    scannerSetDigest: `sha256:${'d'.repeat(64)}`,
    sandboxProfileDigest: `sha256:${'e'.repeat(64)}`,
  },
  reviewRequirements: ['manifest_review', 'source_scan', 'human_review'],
};

const publisherRow = {
  publisherId: 'acme',
  accountId: ACCOUNT_ID,
  displayName: 'Acme',
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const releaseRow = {
  releaseId: RELEASE_ID,
  accountId: ACCOUNT_ID,
  publisherId: 'acme',
  itemName: 'recruiting-workbench',
  moduleId: 'acme.recruiting',
  moduleVersion: '1.0.0',
  manifest: submission.manifest,
  manifestDigest: submission.manifestDigest,
  artifactId: submission.artifactId,
  artifactDigest: submission.artifactDigest,
  sbomDigest: null,
  trustAttestationDigest: null,
  verificationPolicyDigest: null,
  reviewRequirements: submission.reviewRequirements,
  status: 'validated' as const,
  reviewRevision: 0,
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

type FixtureInput = {
  publisherInserts?: unknown[][];
  releaseInserts?: unknown[][];
  runInserts?: unknown[][];
  selects?: unknown[][];
};

function databaseFixture(input: FixtureInput = {}) {
  const publisherInserts = [...(input.publisherInserts ?? [])];
  const releaseInserts = [...(input.releaseInserts ?? [])];
  const runInserts = [...(input.runInserts ?? [])];
  const selects = [...(input.selects ?? [])];
  const whereClauses: unknown[] = [];
  const insertedValues: Array<{ table: unknown; value: unknown }> = [];

  const query = {
    insert(table: unknown) {
      return {
        values(value: unknown) {
          insertedValues.push({ table, value });
          const rows = () =>
            table === developerPublishers
              ? (publisherInserts.shift() ?? [])
              : table === developerModuleReleases
                ? (releaseInserts.shift() ?? [])
                : (runInserts.shift() ?? []);
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  return rows();
                },
              };
            },
            async returning() {
              return rows();
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              whereClauses.push(condition);
              return {
                async limit() {
                  return selects.shift() ?? [];
                },
                orderBy() {
                  return {
                    async limit() {
                      return selects.shift() ?? [];
                    },
                  };
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

  return { database, whereClauses, insertedValues };
}

function conditionParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('developer module release Drizzle repository', () => {
  test('claims the publisher and inserts one immutable release transactionally', async () => {
    const { database, insertedValues } = databaseFixture({
      publisherInserts: [[publisherRow]],
      releaseInserts: [[releaseRow]],
      runInserts: [[{ runId: '50000000-0000-4000-a000-000000000005' }]],
    });
    const repository = createDrizzleDeveloperModuleReleaseRepository(database);

    const result = await repository.submit(submission);

    expect(result.created).toBe(true);
    expect(result.release).toEqual(
      expect.objectContaining({
        release_id: RELEASE_ID,
        account_id: ACCOUNT_ID,
        manifest_digest: submission.manifestDigest,
        artifact_id: submission.artifactId,
        artifact_digest: submission.artifactDigest,
        status: 'validated',
        review_revision: 0,
      }),
    );
    expect(
      insertedValues.find((entry) => entry.table === developerModuleVerificationRuns)?.value,
    ).toEqual(
      expect.objectContaining({
        releaseId: RELEASE_ID,
        artifactId: submission.artifactId,
        accountId: ACCOUNT_ID,
        policyDigest: submission.verification.policyDigest,
        state: 'queued',
        attempt: 1,
      }),
    );
  });

  test('returns an existing same-digest version but rejects a publisher owned elsewhere', async () => {
    const idempotent = databaseFixture({
      publisherInserts: [[]],
      releaseInserts: [[]],
      selects: [[publisherRow], [releaseRow]],
    });
    const repository = createDrizzleDeveloperModuleReleaseRepository(idempotent.database);

    await expect(repository.submit(submission)).resolves.toEqual(
      expect.objectContaining({ created: false }),
    );

    const conflict = databaseFixture({
      publisherInserts: [[]],
      selects: [[{ ...publisherRow, accountId: OTHER_ACCOUNT_ID }]],
    });
    await expect(
      createDrizzleDeveloperModuleReleaseRepository(conflict.database).submit(submission),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_PUBLISHER_CONFLICT', status: 409 }),
    );
  });

  test('rejects a reused module version with a different digest', async () => {
    const { database } = databaseFixture({
      publisherInserts: [[]],
      releaseInserts: [[]],
      selects: [[publisherRow], [{ ...releaseRow, manifestDigest: `sha256:${'b'.repeat(64)}` }]],
    });

    await expect(
      createDrizzleDeveloperModuleReleaseRepository(database).submit(submission),
    ).rejects.toBeInstanceOf(DeveloperModuleReleaseError);
  });

  test('adds account predicates to list and get queries', async () => {
    const fixture = databaseFixture({ selects: [[releaseRow], [releaseRow]] });
    const repository = createDrizzleDeveloperModuleReleaseRepository(fixture.database);

    await expect(repository.list(ACCOUNT_ID, 20)).resolves.toHaveLength(1);
    await expect(repository.get(ACCOUNT_ID, RELEASE_ID)).resolves.toEqual(
      expect.objectContaining({ release_id: RELEASE_ID }),
    );

    expect(conditionParams(fixture.whereClauses[0])).toContain(ACCOUNT_ID);
    expect(conditionParams(fixture.whereClauses[1])).toEqual(
      expect.arrayContaining([ACCOUNT_ID, RELEASE_ID]),
    );
  });
});
