import { expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import * as runtimeArtifactsDrizzle from './runtime-artifacts.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const RELEASE_ID = '20000000-0000-4000-a000-000000000002';
const DESCRIPTOR_ID = '30000000-0000-4000-a000-000000000003';
const ARTIFACT_ID = '40000000-0000-4000-a000-000000000004';
const DIGEST = 'sha256:cd5d4935a48c0672cb06407bb443bc0087aff947c6b864bac886982c73b3027f';

function databaseFixture(row: Record<string, unknown> | undefined) {
  let whereClause: unknown;
  const database = {
    select() {
      const query = {
        from: () => query,
        where(condition: unknown) {
          whereClause = condition;
          return query;
        },
        limit: async () => (row ? [row] : []),
      };
      return query;
    },
  } as unknown as Database;
  return { database, whereClause: () => whereClause };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    runtimeArtifactId: ARTIFACT_ID,
    accountId: ACCOUNT_ID,
    releaseId: RELEASE_ID,
    runtimeDescriptorId: DESCRIPTOR_ID,
    artifactDigest: DIGEST,
    artifactBytes: 4,
    mediaType: 'application/wasm',
    storageKey: 'module-runtime/artifacts/internal/component.wasm',
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

test('Drizzle runtime artifact metadata lookup is tenant-qualified and normalized', async () => {
  const fixture = databaseFixture(row());
  const store = runtimeArtifactsDrizzle.createDrizzleRuntimeArtifactMetadataStore(fixture.database);

  await expect(store.get(ACCOUNT_ID, RELEASE_ID, DESCRIPTOR_ID)).resolves.toEqual({
    runtimeArtifactId: ARTIFACT_ID,
    accountId: ACCOUNT_ID,
    releaseId: RELEASE_ID,
    runtimeDescriptorId: DESCRIPTOR_ID,
    digest: DIGEST,
    bytes: 4,
    mediaType: 'application/wasm',
    storageKey: 'module-runtime/artifacts/internal/component.wasm',
  });
  const params = new PgDialect().sqlToQuery(fixture.whereClause() as never).params;
  expect(params).toEqual(expect.arrayContaining([ACCOUNT_ID, RELEASE_ID, DESCRIPTOR_ID]));
});

test('Drizzle runtime artifact metadata lookup fails closed on invalid trusted fields', async () => {
  for (const invalid of [
    row({ artifactDigest: `sha256:${'A'.repeat(64)}` }),
    row({ artifactBytes: 0 }),
    row({ artifactBytes: 33_554_433 }),
    row({ mediaType: 'application/octet-stream' }),
  ]) {
    const fixture = databaseFixture(invalid);
    await expect(
      runtimeArtifactsDrizzle.createDrizzleRuntimeArtifactMetadataStore(fixture.database).get(
        ACCOUNT_ID,
        RELEASE_ID,
        DESCRIPTOR_ID,
      ),
    ).resolves.toBeNull();
  }
});

test('Drizzle lease-bound artifact lookup emits one tenant and lease qualified query', async () => {
  const createLeaseStore = (
    runtimeArtifactsDrizzle as typeof runtimeArtifactsDrizzle & {
      createDrizzleRuntimeArtifactLeaseStore(database: Database): {
        getForLease(input: Record<string, unknown>): Promise<unknown>;
      };
    }
  ).createDrizzleRuntimeArtifactLeaseStore;
  expect(typeof createLeaseStore).toBe('function');
  const statements: unknown[] = [];
  const database = {
    async execute(statement: unknown) {
      statements.push(statement);
      return [
        {
          runtimeArtifactId: ARTIFACT_ID,
          accountId: ACCOUNT_ID,
          releaseId: RELEASE_ID,
          runtimeDescriptorId: DESCRIPTOR_ID,
          artifactDigest: DIGEST,
          artifactBytes: 4,
          mediaType: 'application/wasm',
          storageKey: 'module-runtime/artifacts/internal/component.wasm',
        },
      ];
    },
  } as unknown as Database;
  const coordinates = {
    accountId: ACCOUNT_ID,
    projectId: '50000000-0000-4000-a000-000000000005',
    executionId: '60000000-0000-4000-a000-000000000006',
    leaseId: '70000000-0000-4000-a000-000000000007',
    generation: 3,
    runnerId: '80000000-0000-4000-a000-000000000008',
  };

  await expect(createLeaseStore(database).getForLease(coordinates)).resolves.toMatchObject({
    runtimeArtifactId: ARTIFACT_ID,
    digest: DIGEST,
    bytes: 4,
  });
  expect(statements).toHaveLength(1);
  const query = new PgDialect().sqlToQuery(statements[0] as never);
  const normalizedSql = query.sql.toLowerCase();
  expect(normalizedSql).toContain('module_executions');
  expect(normalizedSql).toContain('module_execution_leases');
  expect(normalizedSql).toContain('module_runtime_descriptors');
  expect(normalizedSql).toContain('module_runtime_artifacts');
  expect(normalizedSql).toContain('module_runners');
  expect(normalizedSql).toContain('developer_module_releases');
  expect(normalizedSql).toContain('released_at is null');
  expect(normalizedSql).toContain('clock_timestamp()');
  expect(normalizedSql).toContain("state in ('leased', 'running')");
  expect(query.params).toEqual(expect.arrayContaining(Object.values(coordinates)));
});
