import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createDrizzleDeveloperArtifactRetentionRepository } from './artifacts.drizzle';

const RUN_ID = '70000000-0000-4000-a000-000000000007';
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '80000000-0000-4000-a000-000000000008';
const ACCEPTANCE_RUN_ID = 'module-beta:42.1';
const OWNER_ID = 'retention-worker-1';
const NOW = '2026-07-26T12:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-07-26T12:01:00.000Z';

const statusRow = {
  runId: RUN_ID,
  acceptanceRunId: ACCEPTANCE_RUN_ID,
  state: 'queued' as const,
  attempts: 0,
  availableAt: NOW,
  cursor: null,
  lastError: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  finishedAt: null,
};

type RecordedQuery = { sql: string; params: unknown[] };

function databaseFixture(results: unknown[][]) {
  const pending = [...results];
  const queries: RecordedQuery[] = [];
  const executor = {
    async execute(query: unknown) {
      queries.push(new PgDialect().sqlToQuery(query as never));
      return pending.shift() ?? [];
    },
  };
  const database = {
    ...executor,
    async transaction<T>(run: (tx: typeof executor) => Promise<T>): Promise<T> {
      return run(executor);
    },
  } as unknown as Database;
  return { database, queries };
}

describe('developer artifact retention Drizzle repository', () => {
  test('enqueues acceptance runs idempotently and returns the exact stored status', async () => {
    const inserted = databaseFixture([[statusRow]]);
    const insertedRepository = createDrizzleDeveloperArtifactRetentionRepository(inserted.database);

    await expect(
      insertedRepository.enqueueRun({
        acceptanceRunId: ACCEPTANCE_RUN_ID,
        delayMs: 0,
      }),
    ).resolves.toEqual(statusRow);
    expect(inserted.queries[0]?.sql).toContain('ON CONFLICT');
    expect(inserted.queries[0]?.sql).toContain('DO NOTHING');
    expect(inserted.queries[0]?.sql).toMatch(
      /available_at[\s\S]*CURRENT_TIMESTAMP \+ \(\$\d+ \* INTERVAL '1 millisecond'\)/,
    );
    expect(inserted.queries[0]?.params).toContain(ACCEPTANCE_RUN_ID);
    expect(inserted.queries[0]?.params).not.toContain(NOW);

    const replayed = databaseFixture([[], [statusRow]]);
    const replayedRepository = createDrizzleDeveloperArtifactRetentionRepository(replayed.database);
    await expect(
      replayedRepository.enqueueRun({
        acceptanceRunId: ACCEPTANCE_RUN_ID,
        delayMs: 0,
      }),
    ).resolves.toEqual(statusRow);
    expect(replayed.queries[1]?.sql).toContain('acceptance_run_id');
  });

  test('coalesces repeated scheduled enqueue calls while one null-bound run is active', async () => {
    const scheduled = { ...statusRow, acceptanceRunId: null };
    const fixture = databaseFixture([[], [scheduled]]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(
      repository.enqueueRun({ acceptanceRunId: null, delayMs: 0 }),
    ).resolves.toEqual(scheduled);
    expect(fixture.queries[0]?.sql).toContain('ON CONFLICT');
    expect(fixture.queries[1]?.sql).toMatch(/acceptance_run_id IS NULL[\s\S]*queued[\s\S]*running/);
  });

  test('normalizes postgres-js Date timestamps to ISO strings', async () => {
    const fixture = databaseFixture([[
      {
        ...statusRow,
        availableAt: new Date(NOW),
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      },
    ]]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(repository.getRunByAcceptanceRunId(ACCEPTANCE_RUN_ID)).resolves.toEqual(statusRow);
  });

  test('normalizes nullable postgres-js Date timestamps to ISO strings', async () => {
    const fixture = databaseFixture([[
      {
        ...statusRow,
        state: 'succeeded',
        finishedAt: new Date(LEASE_EXPIRES_AT),
      },
    ]]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(repository.getRunByAcceptanceRunId(ACCEPTANCE_RUN_ID)).resolves.toEqual({
      ...statusRow,
      state: 'succeeded',
      finishedAt: LEASE_EXPIRES_AT,
    });
  });

  test('atomically claims queued work or reclaims an expired lease', async () => {
    const fixture = databaseFixture([
      [
        {
          runId: RUN_ID,
          acceptanceRunId: ACCEPTANCE_RUN_ID,
          state: 'running',
          attempts: 1,
          cursor: 'opaque-cursor',
          leaseOwner: OWNER_ID,
          leaseExpiresAt: new Date(LEASE_EXPIRES_AT),
          claimedAt: new Date(NOW),
        },
      ],
    ]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(
      repository.claimRun({
        ownerId: OWNER_ID,
        leaseMs: 60_000,
      }),
    ).resolves.toEqual({
      runId: RUN_ID,
      acceptanceRunId: ACCEPTANCE_RUN_ID,
      state: 'running',
      attempts: 1,
      cursor: 'opaque-cursor',
      leaseOwner: OWNER_ID,
      leaseExpiresAt: LEASE_EXPIRES_AT,
      claimedAt: NOW,
    });
    expect(fixture.queries[0]?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(fixture.queries[0]?.sql).toMatch(/state = 'queued'[\s\S]*state = 'running'/);
    expect(fixture.queries[0]?.sql).toContain('attempts = run.attempts + 1');
    expect(fixture.queries[0]?.sql).toContain('CURRENT_TIMESTAMP AS "claimedAt"');
    expect(fixture.queries[0]?.sql).toContain('lease_expires_at <=');
    expect(fixture.queries[0]?.sql).toContain('CURRENT_TIMESTAMP');
    expect(fixture.queries[0]?.sql).toContain('INTERVAL');
    expect(fixture.queries[0]?.params).toContain(60_000);
  });

  test('renews an owned live lease and its claimed upload tokens with database time', async () => {
    const fixture = databaseFixture([[
      { valid: true, now: new Date(NOW) },
    ]]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(
      repository.renewRunLease({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        leaseMs: 45_000,
      }),
    ).resolves.toEqual({ valid: true, now: NOW });

    expect(fixture.queries[0]?.sql).toContain('FOR UPDATE');
    expect(fixture.queries[0]?.sql).toContain('lease_owner =');
    expect(fixture.queries[0]?.sql).toMatch(/lease_expires_at > CURRENT_TIMESTAMP/);
    expect(fixture.queries[0]?.sql).toContain('previous_lease_expires_at');
    expect(fixture.queries[0]?.sql).toMatch(
      /cleanup_next_attempt_at = owned_run\.renewed_lease_expires_at/,
    );
    expect(fixture.queries[0]?.params).toContain(45_000);
    expect(fixture.queries[0]?.params).toContain(OWNER_ID);
  });

  test('claims bounded due upload rows under the active run lease', async () => {
    const fixture = databaseFixture([
      [{ runId: RUN_ID }],
      [
        {
          accountId: ACCOUNT_ID,
          uploadId: UPLOAD_ID,
          state: 'finalized',
          storageKey: `developer-modules/staging/${'a'.repeat(64)}/${UPLOAD_ID}`,
          cleanupAttempts: 2,
        },
      ],
    ]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(
      repository.claimUploadCandidates({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        accountId: ACCOUNT_ID,
        uploadId: UPLOAD_ID,
        state: 'finalized',
        storageKey: `developer-modules/staging/${'a'.repeat(64)}/${UPLOAD_ID}`,
        cleanupAttempts: 2,
      },
    ]);
    expect(fixture.queries[0]?.sql).toContain('FOR UPDATE');
    expect(fixture.queries[0]?.sql).toContain('lease_expires_at >');
    expect(fixture.queries[0]?.sql).toContain('CURRENT_TIMESTAMP');
    expect(fixture.queries[1]?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(fixture.queries[1]?.sql).toMatch(
      /cleanup_next_attempt_at <= CURRENT_TIMESTAMP/,
    );
    expect(fixture.queries[1]?.sql).toMatch(/expires_at <= CURRENT_TIMESTAMP/);
    expect(fixture.queries[1]?.sql).toMatch(/updated_at = CURRENT_TIMESTAMP/);
    expect(fixture.queries[1]?.params).not.toContain(NOW);
  });

  test('fences deletion, retry, reschedule, completion, and terminal failure by lease owner', async () => {
    const fixture = databaseFixture([
      [{ uploadId: UPLOAD_ID }],
      [{ uploadId: UPLOAD_ID }],
      [{ leaseValid: true, referenced: true }],
      [{ runId: RUN_ID }],
      [{ runId: RUN_ID }],
      [{ runId: RUN_ID }],
    ]);
    const repository = createDrizzleDeveloperArtifactRetentionRepository(fixture.database);

    await expect(
      repository.markUploadDeleted({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        accountId: ACCOUNT_ID,
        uploadId: UPLOAD_ID,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.recordUploadFailure({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        accountId: ACCOUNT_ID,
        uploadId: UPLOAD_ID,
        errorCode: 'RETENTION_OBJECT_STORE_FAILED',
        delayMs: 30_000,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.isStagingKeyReferenced({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        storageKey: `developer-modules/staging/${'b'.repeat(64)}/${UPLOAD_ID}`,
      }),
    ).resolves.toEqual({ leaseValid: true, referenced: true });
    await expect(
      repository.rescheduleRun({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        cursor: 'opaque-cursor',
        delayMs: 0,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.completeRun({ runId: RUN_ID, ownerId: OWNER_ID }),
    ).resolves.toBe(true);
    await expect(
      repository.retryRun({
        runId: RUN_ID,
        ownerId: OWNER_ID,
        errorCode: 'RETENTION_REPOSITORY_FAILED',
        delayMs: 60_000,
        terminal: true,
      }),
    ).resolves.toBe(true);

    for (const query of [fixture.queries[0], fixture.queries[1], ...fixture.queries.slice(3)]) {
      expect(query?.sql).toContain('lease_owner =');
      expect(query?.sql).toContain('lease_expires_at >');
      expect(query?.sql).toContain('CURRENT_TIMESTAMP');
      expect(query?.params).toContain(OWNER_ID);
      expect(query?.params).not.toContain(NOW);
    }
    expect(fixture.queries[1]?.sql).toContain('cleanup_attempts + 1');
    expect(fixture.queries[1]?.sql).toMatch(
      /cleanup_next_attempt_at = CURRENT_TIMESTAMP[\s\S]*INTERVAL/,
    );
    expect(fixture.queries[1]?.sql).toMatch(/updated_at = CURRENT_TIMESTAMP/);
    expect(fixture.queries[1]?.params).toContain(30_000);
    expect(fixture.queries[0]?.sql).toMatch(/staging_deleted_at = CURRENT_TIMESTAMP/);
    expect(fixture.queries[0]?.sql).toMatch(/updated_at = CURRENT_TIMESTAMP/);
    expect(fixture.queries[2]?.sql).toContain('CURRENT_TIMESTAMP');
    expect(fixture.queries[2]?.sql).toContain('lease_owner =');
    expect(fixture.queries[3]?.sql).toMatch(
      /available_at = CURRENT_TIMESTAMP[\s\S]*INTERVAL '1 millisecond'/,
    );
    expect(fixture.queries[4]?.sql).toContain("state = 'succeeded'");
    expect(fixture.queries[4]?.sql).toMatch(/finished_at = CURRENT_TIMESTAMP/);
    expect(fixture.queries[5]?.sql).toContain("state = 'failed'");
    expect(fixture.queries[5]?.sql).toMatch(
      /available_at = CURRENT_TIMESTAMP[\s\S]*INTERVAL '1 millisecond'/,
    );
    // The claim already consumed the attempt; a retry must never double count it.
    expect(fixture.queries[5]?.sql).not.toContain('attempts = attempts + 1');
    expect(fixture.queries[5]?.params).toContain(60_000);
  });
});
