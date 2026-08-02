import { expect, test } from 'bun:test';
import {
  type Database,
  developerModuleArtifacts,
  developerModuleReleases,
  projectModuleInstallations,
} from '@kortix/db';
import type { RegistryModuleManifest } from '@kortix/registry';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createDrizzleProjectModuleLaunchRepository } from './launch.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000003';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const ARTIFACT_ID = '50000000-0000-4000-a000-000000000005';
const PUBLISHER_ACCOUNT_ID = '90000000-0000-4000-a000-000000000009';

const installation = {
  installationId: INSTALLATION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  moduleId: 'developer.example.app',
  activeReleaseId: RELEASE_ID,
  activeVersion: '1.0.0',
  installRevision: 7,
  status: 'active' as const,
  installedBy: ACCOUNT_ID,
  createdAt: '2026-08-02T08:00:00.000Z',
  updatedAt: '2026-08-02T08:00:00.000Z',
};

const manifest: RegistryModuleManifest = {
  schemaVersion: 3,
  id: 'developer.example.app',
  version: '1.0.0',
  publisher: { id: 'developer-example' },
  locales: ['en'],
  compatibility: { platform: '>=1.0.0', registry: '>=3.0.0' },
  execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
  verification: { profile: 'sandboxed-web' },
  openopc: { sdkApiVersion: 'v1' },
};

const release = {
  releaseId: RELEASE_ID,
  accountId: PUBLISHER_ACCOUNT_ID,
  moduleId: 'developer.example.app',
  moduleVersion: '1.0.0',
  manifest,
  status: 'published',
  signatureAlgorithm: 'ed25519',
  signatureKeyId: 'module-key-2026',
  signature: `base64url:${'a'.repeat(86)}`,
  signaturePayloadDigest: `sha256:${'b'.repeat(64)}`,
  signedAt: '2026-08-02T08:00:00.000Z',
  publishedAt: '2026-08-02T08:01:00.000Z',
  revokedAt: null,
  artifactId: ARTIFACT_ID,
};

const artifact = {
  artifactId: ARTIFACT_ID,
  storageKey: 'developer-modules/artifacts/launch-test',
  artifactDigest: `sha256:${'c'.repeat(64)}`,
  sizeBytes: 1024,
};

type SelectFixture = { table: unknown; rows: unknown[] };

function databaseFixture(selects: SelectFixture[]) {
  const queued = [...selects];
  const selectRecords: Array<{
    table: unknown;
    condition?: unknown;
    joins: Array<{ table: unknown; condition: unknown }>;
    limit?: number;
  }> = [];

  const database = {
    select(_projection?: unknown) {
      return {
        from(table: unknown) {
          const fixture = queued.shift();
          if (!fixture || fixture.table !== table) throw new Error('Unexpected select table');
          const record = { table, joins: [] } as (typeof selectRecords)[number];
          selectRecords.push(record);
          const terminal = {
            leftJoin(joinTable: unknown, condition: unknown) {
              record.joins.push({ table: joinTable, condition });
              return terminal;
            },
            innerJoin(joinTable: unknown, condition: unknown) {
              record.joins.push({ table: joinTable, condition });
              return terminal;
            },
            where(condition: unknown) {
              record.condition = condition;
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
  } as unknown as Database;

  return { database, selectRecords };
}

function assertColumnBinding(input: {
  condition: unknown;
  table: string;
  column: string;
  value: unknown;
}): void {
  const query = new PgDialect().sqlToQuery(input.condition as never);
  const placeholder = new RegExp(`"${input.table}"\\."${input.column}"\\s*=\\s*\\$(\\d+)`).exec(
    query.sql,
  );
  if (!placeholder) {
    throw new Error(`Missing bound predicate for ${input.table}.${input.column}`);
  }
  expect(query.params[Number(placeholder[1]) - 1]).toBe(input.value);
}

function conditionSql(condition: unknown): string {
  return new PgDialect().sqlToQuery(condition as never).sql;
}

function assertColumnJoin(input: {
  condition: unknown;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
}): void {
  const sql = conditionSql(input.condition);
  const qualifiedColumn = (table: string, column: string) =>
    `(?:"[^"]+"\\.)?"${table}"\\."${column}"`;
  expect(sql).toMatch(
    new RegExp(
      `${qualifiedColumn(input.leftTable, input.leftColumn)}\\s*=\\s*${qualifiedColumn(
        input.rightTable,
        input.rightColumn,
      )}`,
    ),
  );
}

test('maps a cross-publisher candidate and binds its installation scope to the request', async () => {
  const fixture = databaseFixture([
    {
      table: projectModuleInstallations,
      rows: [{ installation, release, artifact }],
    },
  ]);
  const repository = createDrizzleProjectModuleLaunchRepository(fixture.database);

  await expect(
    repository.loadCandidate({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
    }),
  ).resolves.toEqual({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 7,
    installationStatus: 'active',
    activeReleaseId: RELEASE_ID,
    activeVersion: '1.0.0',
    moduleId: 'developer.example.app',
    releaseId: RELEASE_ID,
    releaseModuleId: 'developer.example.app',
    releaseModuleVersion: '1.0.0',
    releaseStatus: 'published',
    signatureAlgorithm: 'ed25519',
    signatureKeyId: 'module-key-2026',
    signature: `base64url:${'a'.repeat(86)}`,
    signaturePayloadDigest: `sha256:${'b'.repeat(64)}`,
    signedAt: '2026-08-02T08:00:00.000Z',
    publishedAt: '2026-08-02T08:01:00.000Z',
    revokedAt: null,
    artifactId: ARTIFACT_ID,
    storageKey: 'developer-modules/artifacts/launch-test',
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    artifactSize: 1024,
    manifest: release.manifest,
  });

  const select = fixture.selectRecords[0];
  assertColumnBinding({
    condition: select?.condition,
    table: 'project_module_installations',
    column: 'account_id',
    value: ACCOUNT_ID,
  });
  assertColumnBinding({
    condition: select?.condition,
    table: 'project_module_installations',
    column: 'project_id',
    value: PROJECT_ID,
  });
  assertColumnBinding({
    condition: select?.condition,
    table: 'project_module_installations',
    column: 'installation_id',
    value: INSTALLATION_ID,
  });
  expect(select?.joins.map((join) => join.table)).toEqual([
    developerModuleReleases,
    developerModuleArtifacts,
  ]);
  assertColumnJoin({
    condition: select?.joins[0]?.condition,
    leftTable: 'developer_module_releases',
    leftColumn: 'release_id',
    rightTable: 'project_module_installations',
    rightColumn: 'active_release_id',
  });
  assertColumnJoin({
    condition: select?.joins[1]?.condition,
    leftTable: 'developer_module_artifacts',
    leftColumn: 'artifact_id',
    rightTable: 'developer_module_releases',
    rightColumn: 'artifact_id',
  });
  assertColumnJoin({
    condition: select?.joins[1]?.condition,
    leftTable: 'developer_module_artifacts',
    leftColumn: 'account_id',
    rightTable: 'developer_module_releases',
    rightColumn: 'account_id',
  });
});

test('uses an active exact published and published-at pointer as the final currentness fence', async () => {
  const fixture = databaseFixture([
    { table: projectModuleInstallations, rows: [{ installationId: INSTALLATION_ID }] },
  ]);
  const repository = createDrizzleProjectModuleLaunchRepository(fixture.database);
  const input = {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: RELEASE_ID,
    installRevision: 7,
  };

  await expect(repository.isCurrent(input)).resolves.toBe(true);

  const condition = fixture.selectRecords[0]?.condition;
  assertColumnBinding({
    condition,
    table: 'project_module_installations',
    column: 'account_id',
    value: ACCOUNT_ID,
  });
  assertColumnBinding({
    condition,
    table: 'project_module_installations',
    column: 'project_id',
    value: PROJECT_ID,
  });
  assertColumnBinding({
    condition,
    table: 'project_module_installations',
    column: 'installation_id',
    value: INSTALLATION_ID,
  });
  assertColumnBinding({
    condition,
    table: 'project_module_installations',
    column: 'active_release_id',
    value: RELEASE_ID,
  });
  assertColumnBinding({
    condition,
    table: 'project_module_installations',
    column: 'install_revision',
    value: 7,
  });
  assertColumnBinding({
    condition,
    table: 'project_module_installations',
    column: 'status',
    value: 'active',
  });
  assertColumnBinding({
    condition,
    table: 'developer_module_releases',
    column: 'status',
    value: 'published',
  });
  assertColumnJoin({
    condition: fixture.selectRecords[0]?.joins[0]?.condition,
    leftTable: 'developer_module_releases',
    leftColumn: 'release_id',
    rightTable: 'project_module_installations',
    rightColumn: 'active_release_id',
  });
  const currentSql = conditionSql(condition).replaceAll(/\s+/g, '');
  expect(currentSql).toContain('"developer_module_releases"."revoked_at"isnull');
  expect(currentSql).toContain('"developer_module_releases"."published_at"isnotnull');
});
