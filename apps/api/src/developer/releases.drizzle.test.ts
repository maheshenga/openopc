import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import {
  developerModuleReleases,
  developerModuleVerificationRuns,
  developerPublishers,
  moduleRuntimeArtifacts,
  moduleRuntimeDescriptors,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import { DeveloperModuleReleaseError, type DeveloperModuleReleaseInsert } from './releases';
import { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const DESCRIPTOR_ID = '50000000-0000-4000-a000-000000000005';
const RUNTIME_ARTIFACT_ID = '60000000-0000-4000-a000-000000000006';
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
  runtimeDescriptor: null,
  runtimeArtifact: null,
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
  runtimeDescriptorDigest: null,
  runtimeDescriptorPath: null,
  runtimeKind: null,
  reviewRequirements: submission.reviewRequirements,
  status: 'validated' as const,
  reviewRevision: 0,
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const wasiRuntimeDescriptor = {
  descriptor: {
    descriptorVersion: 1 as const,
    runtime: {
      kind: 'wasi-component' as const,
      component: 'runtime/adapter.wasm',
      world: 'openopc:adapter/runtime@1.0.0',
      operation: 'run',
      imports: ['openopc:module/input', 'openopc:module/output'],
      limits: {
        cpuMillis: 1000,
        fuel: 1_000_000,
        memoryMiB: 64,
        outputBytes: 1_048_576,
        pids: 8,
        wallTimeMs: 5000,
      },
    },
  },
  descriptorDigest:
    'sha256:48c5ceaedc0107897ab95f38d92c6be879fdb89dc6df86a46619010c2185fb30' as const,
  entryPath: 'runtime/openopc.runtime.json',
  runtimeKind: 'wasi-component' as const,
};

const storedRuntimeArtifact = {
  digest: `sha256:${'2'.repeat(64)}` as const,
  bytes: 4,
  mediaType: 'application/wasm' as const,
  storageKey: 'module-runtime/artifacts/internal/component.wasm',
};

const wasiSubmission: DeveloperModuleReleaseInsert = {
  ...submission,
  manifest: {
    ...submission.manifest,
    execution: { mode: 'server-adapter', entry: wasiRuntimeDescriptor.entryPath },
    verification: { profile: 'server-conformance' },
  },
  runtimeDescriptor: wasiRuntimeDescriptor,
  runtimeArtifact: storedRuntimeArtifact,
};

const wasiReleaseRow = {
  ...releaseRow,
  manifest: wasiSubmission.manifest,
  runtimeDescriptorDigest: wasiRuntimeDescriptor.descriptorDigest,
  runtimeDescriptorPath: wasiRuntimeDescriptor.entryPath,
  runtimeKind: wasiRuntimeDescriptor.runtimeKind,
};

const runtimeDescriptorRow = {
  descriptorId: DESCRIPTOR_ID,
  accountId: ACCOUNT_ID,
  releaseId: RELEASE_ID,
  runtimeKind: wasiRuntimeDescriptor.runtimeKind,
  descriptorDigest: wasiRuntimeDescriptor.descriptorDigest,
  descriptor: wasiRuntimeDescriptor.descriptor,
  createdAt: CREATED_AT,
};

const runtimeArtifactRow = {
  runtimeArtifactId: RUNTIME_ARTIFACT_ID,
  accountId: ACCOUNT_ID,
  releaseId: RELEASE_ID,
  runtimeDescriptorId: DESCRIPTOR_ID,
  artifactDigest: storedRuntimeArtifact.digest,
  artifactBytes: storedRuntimeArtifact.bytes,
  mediaType: storedRuntimeArtifact.mediaType,
  storageKey: storedRuntimeArtifact.storageKey,
  createdAt: CREATED_AT,
};

type FixtureInput = {
  releaseInserts?: unknown[][];
  descriptorInserts?: unknown[][];
  runtimeArtifactInserts?: unknown[][];
  runInserts?: unknown[][];
  selects?: unknown[][];
};

function databaseFixture(input: FixtureInput = {}) {
  const releaseInserts = [...(input.releaseInserts ?? [])];
  const descriptorInserts = [...(input.descriptorInserts ?? [])];
  const runtimeArtifactInserts = [...(input.runtimeArtifactInserts ?? [])];
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
            table === developerModuleReleases
              ? (releaseInserts.shift() ?? [])
              : table === moduleRuntimeDescriptors
                ? (descriptorInserts.shift() ?? [])
                : table === moduleRuntimeArtifacts
                  ? (runtimeArtifactInserts.shift() ?? [])
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

function insertedTableName(table: unknown): string {
  if (table === developerModuleReleases) return 'release';
  if (table === moduleRuntimeDescriptors) return 'descriptor';
  if (table === moduleRuntimeArtifacts) return 'runtime-artifact';
  if (table === developerModuleVerificationRuns) return 'verification-run';
  return 'unknown';
}

describe('developer module release Drizzle repository', () => {
  test('persists release, descriptor, runtime artifact, and verification in one ordered transaction', async () => {
    const { database, insertedValues } = databaseFixture({
      selects: [[{ publisherId: 'acme' }]],
      releaseInserts: [[wasiReleaseRow]],
      descriptorInserts: [[runtimeDescriptorRow]],
      runtimeArtifactInserts: [[runtimeArtifactRow]],
      runInserts: [[{ runId: '70000000-0000-4000-a000-000000000007' }]],
    });

    const result =
      await createDrizzleDeveloperModuleReleaseRepository(database).submit(wasiSubmission);

    expect(insertedValues.map((entry) => insertedTableName(entry.table))).toEqual([
      'release',
      'descriptor',
      'runtime-artifact',
      'verification-run',
    ]);
    expect(insertedValues[1]?.value).toEqual({
      accountId: ACCOUNT_ID,
      releaseId: RELEASE_ID,
      runtimeKind: 'wasi-component',
      descriptorDigest: wasiRuntimeDescriptor.descriptorDigest,
      descriptor: wasiRuntimeDescriptor.descriptor,
    });
    expect(insertedValues[2]?.value).toEqual({
      accountId: ACCOUNT_ID,
      releaseId: RELEASE_ID,
      runtimeDescriptorId: DESCRIPTOR_ID,
      artifactDigest: storedRuntimeArtifact.digest,
      artifactBytes: 4,
      mediaType: 'application/wasm',
      storageKey: storedRuntimeArtifact.storageKey,
    });
    expect(result.release).not.toHaveProperty('storage_key');
    expect(JSON.stringify(result.release)).not.toContain(storedRuntimeArtifact.storageKey);
  });

  test('accepts only an exact idempotent WASI metadata replay', async () => {
    const exact = databaseFixture({
      releaseInserts: [[]],
      selects: [
        [{ publisherId: 'acme' }],
        [wasiReleaseRow],
        [runtimeDescriptorRow],
        [runtimeArtifactRow],
      ],
    });
    await expect(
      createDrizzleDeveloperModuleReleaseRepository(exact.database).submit(wasiSubmission),
    ).resolves.toMatchObject({ created: false });

    for (const artifactRows of [
      [],
      [{ ...runtimeArtifactRow, artifactDigest: `sha256:${'9'.repeat(64)}` }],
      [{ ...runtimeArtifactRow, artifactBytes: 5 }],
      [{ ...runtimeArtifactRow, mediaType: 'application/octet-stream' }],
    ]) {
      const mismatch = databaseFixture({
        releaseInserts: [[]],
        selects: [
          [{ publisherId: 'acme' }],
          [wasiReleaseRow],
          [runtimeDescriptorRow],
          artifactRows,
        ],
      });
      await expect(
        createDrizzleDeveloperModuleReleaseRepository(mismatch.database).submit(wasiSubmission),
      ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_VERSION_CONFLICT', status: 409 });
    }
  });

  test('persists artifact-derived server runtime evidence on the release row', async () => {
    const runtimeDescriptor = {
      descriptor: {
        descriptorVersion: 1 as const,
        runtime: {
          kind: 'oci-image' as const,
          image: `sha256:${'f'.repeat(64)}` as const,
          command: ['openopc-adapter'],
          args: [],
          profile: 'server-adapter',
          limits: {
            cpuMillis: 1000,
            fuel: 1_000_000,
            memoryMiB: 64,
            outputBytes: 1_048_576,
            pids: 8,
            wallTimeMs: 5000,
          },
        },
      },
      descriptorDigest: `sha256:${'1'.repeat(64)}` as const,
      entryPath: 'runtime/openopc.runtime.json',
      runtimeKind: 'oci-image' as const,
    };
    const serverSubmission: DeveloperModuleReleaseInsert = {
      ...submission,
      manifest: {
        ...submission.manifest,
        execution: { mode: 'server-adapter', entry: runtimeDescriptor.entryPath },
        verification: { profile: 'server-conformance' },
      },
      runtimeDescriptor,
      runtimeArtifact: null,
    };
    const serverRow = {
      ...releaseRow,
      manifest: serverSubmission.manifest,
      runtimeDescriptorDigest: runtimeDescriptor.descriptorDigest,
      runtimeDescriptorPath: runtimeDescriptor.entryPath,
      runtimeKind: runtimeDescriptor.runtimeKind,
    };
    const { database, insertedValues } = databaseFixture({
      selects: [[{ publisherId: 'acme' }]],
      releaseInserts: [[serverRow]],
      descriptorInserts: [
        [
          {
            descriptorId: DESCRIPTOR_ID,
            accountId: ACCOUNT_ID,
            releaseId: RELEASE_ID,
            runtimeKind: runtimeDescriptor.runtimeKind,
            descriptorDigest: runtimeDescriptor.descriptorDigest,
            descriptor: runtimeDescriptor.descriptor,
            createdAt: CREATED_AT,
          },
        ],
      ],
      runInserts: [[{ runId: '70000000-0000-4000-a000-000000000007' }]],
    });

    const result =
      await createDrizzleDeveloperModuleReleaseRepository(database).submit(serverSubmission);

    expect(insertedValues.find((entry) => entry.table === developerModuleReleases)?.value).toEqual(
      expect.objectContaining({
        runtimeDescriptorDigest: runtimeDescriptor.descriptorDigest,
        runtimeDescriptorPath: runtimeDescriptor.entryPath,
        runtimeKind: runtimeDescriptor.runtimeKind,
      }),
    );
    expect(result.release).toMatchObject({
      runtime_descriptor_digest: runtimeDescriptor.descriptorDigest,
      runtime_descriptor_path: runtimeDescriptor.entryPath,
      runtime_kind: runtimeDescriptor.runtimeKind,
    });
  });

  test('requires an existing Publisher and inserts one immutable release transactionally', async () => {
    const { database, insertedValues } = databaseFixture({
      selects: [[{ publisherId: 'acme' }]],
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
    expect(insertedValues.some((entry) => entry.table === developerPublishers)).toBe(false);
  });

  test('returns an existing same-digest version but rejects a missing Publisher', async () => {
    const idempotent = databaseFixture({
      releaseInserts: [[]],
      selects: [[{ publisherId: 'acme' }], [releaseRow]],
    });
    const repository = createDrizzleDeveloperModuleReleaseRepository(idempotent.database);

    await expect(repository.submit(submission)).resolves.toEqual(
      expect.objectContaining({ created: false }),
    );

    const conflict = databaseFixture({
      selects: [[]],
    });
    await expect(
      createDrizzleDeveloperModuleReleaseRepository(conflict.database).submit(submission),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_PUBLISHER_CONFLICT', status: 409 }),
    );
  });

  test('rejects a reused module version with a different digest', async () => {
    const { database } = databaseFixture({
      releaseInserts: [[]],
      selects: [
        [{ publisherId: 'acme' }],
        [{ ...releaseRow, manifestDigest: `sha256:${'b'.repeat(64)}` }],
      ],
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
