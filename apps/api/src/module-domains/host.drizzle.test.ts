import { describe, expect, test } from 'bun:test';

import {
  type Database,
  developerModuleArtifacts,
  developerModuleReleases,
  moduleCustomDomainBindings,
  projectModuleInstallations,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createDrizzleModulePlatformHostRepository } from './host.drizzle';

const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}` as const;

const publishedRow = {
  releaseId: RELEASE_ID,
  storageKey: 'artifacts/example/weather',
  artifactDigest: ARTIFACT_DIGEST,
  artifactSize: 4096,
  manifest: {
    schemaVersion: 3,
    execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
  },
};

function databaseFixture(rows: unknown[]) {
  const record: {
    selection?: Record<string, unknown>;
    from?: unknown;
    joins: Array<{ table: unknown; condition: unknown }>;
    condition?: unknown;
    limit?: number;
  } = { joins: [] };
  const database = {
    select(selection: Record<string, unknown>) {
      record.selection = selection;
      const terminal = {
        innerJoin(table: unknown, condition: unknown) {
          record.joins.push({ table, condition });
          return terminal;
        },
        where(condition: unknown) {
          record.condition = condition;
          return terminal;
        },
        async limit(limit: number) {
          record.limit = limit;
          return rows;
        },
      };
      return {
        from(table: unknown) {
          record.from = table;
          return terminal;
        },
      };
    },
  } as unknown as Database;
  return { database, record };
}

function compiled(condition: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition as never);
}

describe('module platform host Drizzle repository', () => {
  test('loads a complete immutable release from the release and artifact tables only', async () => {
    const fixture = databaseFixture([publishedRow]);
    const repository = createDrizzleModulePlatformHostRepository(fixture.database);

    await expect(
      repository.loadPublishedSandboxedWebRelease({ releaseId: RELEASE_ID }),
    ).resolves.toEqual({
      releaseId: RELEASE_ID,
      storageKey: 'artifacts/example/weather',
      artifactDigest: ARTIFACT_DIGEST,
      artifactSize: 4096,
      entryPath: 'dist/index.html',
    });

    expect(fixture.record.from).toBe(developerModuleReleases);
    expect(fixture.record.joins.map((join) => join.table)).toEqual([developerModuleArtifacts]);
    expect(fixture.record.joins.map((join) => join.table)).not.toContain(
      moduleCustomDomainBindings,
    );
    expect(fixture.record.joins.map((join) => join.table)).not.toContain(
      projectModuleInstallations,
    );
    expect(fixture.record.limit).toBe(1);

    const query = compiled(fixture.record.condition);
    expect(query.params).toEqual(
      expect.arrayContaining([RELEASE_ID, 'published', 'ed25519', '3', 'sandboxed-web']),
    );
    for (const column of [
      'revoked_at',
      'artifact_id',
      'signature_key_id',
      'signature',
      'signature_payload_digest',
      'signed_at',
      'published_at',
      'storage_key',
      'artifact_digest',
      'size_bytes',
    ]) {
      expect(query.sql).toContain(column);
    }
  });

  test('rejects rows whose manifest is not schema-v3 sandboxed web with a non-empty entry', async () => {
    for (const manifest of [
      { schemaVersion: 2, execution: { mode: 'sandboxed-web', entry: 'dist/index.html' } },
      { schemaVersion: 3, execution: { mode: 'declarative', entry: 'dist/index.html' } },
      { schemaVersion: 3, execution: { mode: 'sandboxed-web', entry: '' } },
    ]) {
      const fixture = databaseFixture([{ ...publishedRow, manifest }]);
      const repository = createDrizzleModulePlatformHostRepository(fixture.database);

      await expect(
        repository.loadPublishedSandboxedWebRelease({ releaseId: RELEASE_ID }),
      ).resolves.toBeNull();
    }
  });
});
