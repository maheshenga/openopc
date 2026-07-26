import { describe, expect, test } from 'bun:test';
import {
  type Database,
  developerModuleArtifactUploads,
  developerModuleArtifacts,
} from '@kortix/db';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';

import type {
  DeveloperModuleArtifactRecord,
  DeveloperModuleArtifactUploadRecord,
} from './artifacts';
import {
  createDrizzleDeveloperModuleArtifactRepository,
  serializeDeveloperModuleArtifactRow,
  serializeDeveloperModuleArtifactUploadRow,
} from './artifacts.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const UPLOAD_ID = '30000000-0000-4000-a000-000000000003';
const ARTIFACT_ID = '40000000-0000-4000-a000-000000000004';
const CREATED_AT = '2026-07-25T12:00:00.000Z';

const uploadRecord: DeveloperModuleArtifactUploadRecord = {
  upload_id: UPLOAD_ID,
  account_id: ACCOUNT_ID,
  publisher_id: 'acme',
  state: 'created',
  expected_digest: `sha256:${'a'.repeat(64)}`,
  expected_size: 128,
  staging_storage_key: 'developer-modules/staging/opaque/upload',
  artifact_id: null,
  expires_at: '2026-07-25T12:05:00.000Z',
  created_by: USER_ID,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const uploadRow = {
  uploadId: UPLOAD_ID,
  accountId: ACCOUNT_ID,
  publisherId: 'acme',
  state: 'created' as const,
  expectedDigest: uploadRecord.expected_digest,
  expectedSize: 128,
  stagingStorageKey: uploadRecord.staging_storage_key,
  artifactId: null,
  expiresAt: uploadRecord.expires_at,
  stagingDeletedAt: null,
  cleanupAttempts: 0,
  cleanupNextAttemptAt: null,
  cleanupLastError: null,
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const artifactRecord: DeveloperModuleArtifactRecord = {
  artifact_id: ARTIFACT_ID,
  account_id: ACCOUNT_ID,
  publisher_id: 'acme',
  artifact_digest: `sha256:${'b'.repeat(64)}`,
  envelope_digest: `sha256:${'c'.repeat(64)}`,
  storage_key: 'developer-modules/artifacts/opaque/artifact',
  media_type: 'application/vnd.openopc.developer-module.v2+json',
  size_bytes: 128,
  item_snapshot: {
    name: 'recruiting-workbench',
    type: 'registry:module',
    module: {
      schemaVersion: 2,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme' },
      category: 'industry',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
    },
  },
  source_provenance: null,
  created_by: USER_ID,
  created_at: CREATED_AT,
};

const artifactRow = {
  artifactId: ARTIFACT_ID,
  accountId: ACCOUNT_ID,
  publisherId: 'acme',
  artifactDigest: artifactRecord.artifact_digest,
  envelopeDigest: artifactRecord.envelope_digest,
  storageKey: artifactRecord.storage_key,
  mediaType: artifactRecord.media_type,
  sizeBytes: artifactRecord.size_bytes,
  itemSnapshot: artifactRecord.item_snapshot as unknown as Record<string, unknown>,
  sourceProvenance: null,
  createdBy: USER_ID,
  createdAt: CREATED_AT,
};

function databaseFixture(
  input: {
    selects?: unknown[][];
    inserts?: unknown[][];
    updates?: unknown[][];
  } = {},
) {
  const selects = [...(input.selects ?? [])];
  const inserts = [...(input.inserts ?? [])];
  const updates = [...(input.updates ?? [])];
  const conditions: unknown[] = [];
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];
  const locks: string[] = [];

  function result(rows: unknown[]) {
    const promise = Promise.resolve(rows) as Promise<unknown[]> & {
      for(mode: string): Promise<unknown[]>;
    };
    promise.for = async (mode) => {
      locks.push(mode);
      return rows;
    };
    return promise;
  }

  const query = {
    insert(_table: unknown) {
      return {
        values(value: unknown) {
          insertedValues.push(value);
          return {
            onConflictDoNothing() {
              return { returning: async () => inserts.shift() ?? [] };
            },
            returning: async () => inserts.shift() ?? [],
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              conditions.push(condition);
              return { limit: () => result(selects.shift() ?? []) };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(value: unknown) {
          updatedValues.push(value);
          return {
            where(condition: unknown) {
              conditions.push(condition);
              return { returning: async () => updates.shift() ?? [] };
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
  return { database, conditions, insertedValues, updatedValues, locks };
}

function params(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('developer module artifact Drizzle repository', () => {
  test('persists the finalized artifact link on each upload row', () => {
    expect(
      getTableConfig(developerModuleArtifactUploads).columns.map((column) => column.name),
    ).toContain('artifact_id');
  });

  test('serializes rows without losing immutable storage metadata', () => {
    expect(serializeDeveloperModuleArtifactUploadRow(uploadRow)).toEqual(uploadRecord);
    expect(serializeDeveloperModuleArtifactRow(artifactRow)).toEqual(artifactRecord);
  });

  test('requires an existing account-scoped Publisher without creating one implicitly', async () => {
    const claimedFixture = databaseFixture({ selects: [[{ publisherId: 'acme' }]] });
    const claimedRepository = createDrizzleDeveloperModuleArtifactRepository(
      claimedFixture.database,
    );
    await claimedRepository.claimPublisher({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      displayName: 'Acme',
      actorUserId: USER_ID,
    });
    expect(claimedFixture.insertedValues).toEqual([]);
    expect(params(claimedFixture.conditions[0])).toEqual(
      expect.arrayContaining([ACCOUNT_ID, 'acme']),
    );

    const conflictFixture = databaseFixture({ selects: [[]] });
    const conflictRepository = createDrizzleDeveloperModuleArtifactRepository(
      conflictFixture.database,
    );
    await expect(
      conflictRepository.claimPublisher({
        accountId: ACCOUNT_ID,
        publisherId: 'acme',
        displayName: 'Acme',
        actorUserId: USER_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT', status: 409 }),
    );
    expect(params(conflictFixture.conditions[0])).toEqual(
      expect.arrayContaining([ACCOUNT_ID, 'acme']),
    );
  });

  test('creates uploads and always qualifies reads by account', async () => {
    const fixture = databaseFixture({ inserts: [[uploadRow]], selects: [[uploadRow]] });
    const repository = createDrizzleDeveloperModuleArtifactRepository(fixture.database);

    await repository.createUpload(uploadRecord);
    await expect(repository.getUpload(ACCOUNT_ID, UPLOAD_ID)).resolves.toEqual(uploadRecord);

    expect(fixture.insertedValues[0]).toEqual(
      expect.objectContaining({ uploadId: UPLOAD_ID, accountId: ACCOUNT_ID, artifactId: null }),
    );
    expect(params(fixture.conditions[0])).toEqual(expect.arrayContaining([ACCOUNT_ID, UPLOAD_ID]));
  });

  test('finalizes under a row lock and compare-and-swap binds the exact artifact', async () => {
    const fixture = databaseFixture({
      selects: [[uploadRow]],
      inserts: [[artifactRow]],
      updates: [[{ uploadId: UPLOAD_ID }]],
    });
    const repository = createDrizzleDeveloperModuleArtifactRepository(fixture.database);

    await expect(
      repository.finalizeUpload({
        accountId: ACCOUNT_ID,
        uploadId: UPLOAD_ID,
        artifact: artifactRecord,
        updatedAt: CREATED_AT,
      }),
    ).resolves.toEqual(artifactRecord);

    expect(fixture.locks).toEqual(['update']);
    expect(fixture.updatedValues[0]).toEqual(
      expect.objectContaining({ state: 'finalized', artifactId: ARTIFACT_ID }),
    );
    expect(params(fixture.conditions.at(-1))).toEqual(
      expect.arrayContaining([ACCOUNT_ID, UPLOAD_ID, 'created', 'uploaded']),
    );
  });

  test('uses an account-scoped digest conflict target for idempotent artifacts', async () => {
    const fixture = databaseFixture({ inserts: [[]], selects: [[artifactRow]] });
    const repository = createDrizzleDeveloperModuleArtifactRepository(fixture.database);

    await expect(repository.createArtifact(artifactRecord)).resolves.toEqual(artifactRecord);
    expect(params(fixture.conditions[0])).toEqual(
      expect.arrayContaining([ACCOUNT_ID, artifactRecord.artifact_digest]),
    );
    expect(developerModuleArtifacts).toBeDefined();
  });
});
