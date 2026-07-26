import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';

import { createPostgresModuleBetaAcceptanceRepository } from './postgres';

const acceptanceRunId = 'gha:12345:1';
const accountId = '10000000-0000-4000-a000-000000000001';
const artifactId = '20000000-0000-4000-a000-000000000002';
const runId = '30000000-0000-4000-a000-000000000003';
const uploadId = '40000000-0000-4000-a000-000000000004';
const releaseId = '50000000-0000-4000-a000-000000000005';
const retentionRunId = '70000000-0000-4000-a000-000000000007';
const retentionProbeUploadId = '80000000-0000-4000-a000-000000000008';
const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;

function sqlWith(...results: unknown[]) {
  let index = 0;
  return {
    async unsafe() {
      const result = results[index];
      index += 1;
      return structuredClone(result);
    },
  } as unknown as Sql;
}

function recordingSql(...results: unknown[]) {
  let index = 0;
  const queries: string[] = [];
  const parameters: unknown[][] = [];
  const sql = {
    async unsafe(query: string, values: unknown[] = []) {
      queries.push(query);
      parameters.push(values);
      const result = results[index];
      index += 1;
      return structuredClone(result);
    },
  } as unknown as Sql;
  return { parameters, queries, sql };
}

describe('module beta acceptance PostgreSQL repository', () => {
  test('requires every table used by registration, evidence, and cleanup', async () => {
    const checked: string[] = [];
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: {
        async unsafe(_query: string, parameters: unknown[]) {
          const tableName = String(parameters[0]);
          checked.push(tableName);
          return [{ table_name: tableName }];
        },
      } as unknown as Sql,
    });

    await expect(repository.assertReady()).resolves.toBeUndefined();
    expect(checked).toEqual([
      'kortix.developer_module_artifacts',
      'kortix.developer_module_artifact_uploads',
      'kortix.developer_artifact_retention_runs',
      'kortix.developer_module_verification_runs',
      'kortix.developer_module_trust_attestations',
    ]);
  });

  test('reads an artifact only with its account, semantic digest, and uploaded content binding', async () => {
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith([
        {
          account_id: accountId,
          artifact_id: artifactId,
          artifact_digest: digest('a'),
          content_digest: digest('b'),
          storage_key: 'developer-modules/artifacts/partition/object',
          size_bytes: '128',
        },
      ]),
    });

    await expect(
      repository.getArtifact({ accountId, artifactId, artifactDigest: digest('a') }),
    ).resolves.toEqual({
      accountId,
      artifactId,
      artifactDigest: digest('a'),
      contentDigest: digest('b'),
      storageKey: 'developer-modules/artifacts/partition/object',
      sizeBytes: 128,
    });
  });

  test('fails closed on malformed object coordinates returned by PostgreSQL', async () => {
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith([
        {
          account_id: accountId,
          artifact_id: artifactId,
          artifact_digest: digest('a'),
          content_digest: digest('b'),
          storage_key: '../other-tenant/object',
          size_bytes: '128',
        },
      ]),
    });

    await expect(
      repository.getArtifact({ accountId, artifactId, artifactDigest: digest('a') }),
    ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_DATABASE_INVALID');
  });

  test('reads terminal evidence only when the run carries the acceptance binding', async () => {
    const envelope = {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'e30=',
      signatures: [{ keyid: 'openopc-attestation-staging-2026-07', sig: 'AA==' }],
    };
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith([
        {
          acceptance_run_id: acceptanceRunId,
          run_id: runId,
          account_id: accountId,
          artifact_id: artifactId,
          artifact_digest: digest('a'),
          content_digest: digest('b'),
          artifact_storage_key: 'developer-modules/artifacts/partition/object',
          artifact_size_bytes: '128',
          sbom_digest: digest('c'),
          sbom_storage_key: `developer-trust/evidence/accounts/${accountId}/runs/${runId}/sbom/sha256/${'c'.repeat(64)}.cdx.json`,
          sbom_size_bytes: '64',
          attestation_digest: digest('d'),
          dsse_envelope: envelope,
        },
      ]),
    });

    await expect(repository.getRunEvidence({ acceptanceRunId, runId })).resolves.toEqual({
      acceptanceRunId,
      runId,
      accountId,
      artifactId,
      artifactDigest: digest('a'),
      artifactContentDigest: digest('b'),
      artifactStorageKey: 'developer-modules/artifacts/partition/object',
      artifactSizeBytes: 128,
      sbomDigest: digest('c'),
      sbomStorageKey: `developer-trust/evidence/accounts/${accountId}/runs/${runId}/sbom/sha256/${'c'.repeat(64)}.cdx.json`,
      sbomSizeBytes: 64,
      attestationDigest: digest('d'),
      dsseEnvelope: envelope,
    });
  });

  test('enumerates every nested acceptance run before enforcing cleanup state', async () => {
    const { queries, sql } = recordingSql(
      [],
      [
        {
          upload_id: uploadId,
          account_id: accountId,
          state: 'cancelled',
          staging_storage_key: 'developer-modules/staging/partition/upload',
        },
      ],
      [],
    );
    const repository = createPostgresModuleBetaAcceptanceRepository({ sql });
    const cleanup = {
      acceptanceRunId,
      accountId,
      cancelledUploadId: uploadId,
      artifactIds: [artifactId],
      releaseIds: [releaseId],
      verificationRunIds: [runId],
    };

    await expect(repository.getRunEvidence({ acceptanceRunId, runId })).resolves.toBeNull();
    await expect(repository.getCleanupBinding(cleanup)).rejects.toThrow(
      'MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID',
    );

    const evidenceQuery = queries[0] ?? '';
    const cleanupQuery = queries[2] ?? '';
    for (const query of [evidenceQuery, cleanupQuery]) {
      expect(query).toContain("resource_summary #>> '{acceptance,acceptanceRunId}'");
      expect(query).not.toContain("resource_summary->>'acceptance_run_id'");
    }
    expect(cleanupQuery).not.toContain('jsonb_array_elements_text');
    expect(cleanupQuery).not.toContain(
      "run.state IN ('passed', 'failed', 'inconclusive', 'cancelled')",
    );
    for (const column of [
      'run.lease_owner IS NULL',
      'run.lease_token_hash IS NULL',
      'run.lease_expires_at IS NULL',
      'run.heartbeat_at IS NULL',
    ]) {
      expect(cleanupQuery).not.toContain(column);
    }
  });

  test('binds cleanup to the exact cancelled upload and immutable attempt sets', async () => {
    const runRows = [
      {
        acceptance_run_id: acceptanceRunId,
        run_id: runId,
        release_id: releaseId,
        artifact_id: artifactId,
        artifact_digest: digest('a'),
        state: 'passed',
        lease_owner: null,
        lease_token_hash: null,
        lease_expires_at: null,
        heartbeat_at: null,
      },
    ];
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith(
        [
          {
            upload_id: uploadId,
            account_id: accountId,
            state: 'cancelled',
            staging_storage_key: 'developer-modules/staging/partition/upload',
          },
        ],
        runRows,
        runRows,
      ),
    });
    const request = {
      acceptanceRunId,
      accountId,
      cancelledUploadId: uploadId,
      artifactIds: [artifactId],
      releaseIds: [releaseId],
      verificationRunIds: [runId],
    };

    await expect(repository.getCleanupBinding(request)).resolves.toEqual({
      cancelledUploadStorageKey: 'developer-modules/staging/partition/upload',
      verificationRuns: [
        {
          runId,
          artifactId,
          artifactDigest: digest('a'),
        },
      ],
    });
    await expect(repository.assertAttemptsPreserved(request)).resolves.toBeUndefined();
  });

  test('durably prepares an expired upload probe from the bound cancelled upload', async () => {
    const { queries, sql } = recordingSql([
      {
        upload_id: retentionProbeUploadId,
        account_id: accountId,
        state: 'expired',
        staging_storage_key:
          'developer-modules/staging/acceptance-probes/run/expired-retention.v1.json',
        staging_deleted_at: null,
      },
    ]);
    const repository = createPostgresModuleBetaAcceptanceRepository({ sql });

    await expect(
      repository.prepareExpiredRetentionProbe({
        acceptanceRunId,
        accountId,
        cancelledUploadId: uploadId,
        uploadId: retentionProbeUploadId,
        storageKey: 'developer-modules/staging/acceptance-probes/run/expired-retention.v1.json',
        contentDigest: digest('e'),
        sizeBytes: 128,
        createdAt: '2026-07-26T12:00:00.000Z',
        expiresAt: '2026-07-26T12:00:01.000Z',
      }),
    ).resolves.toBeUndefined();
    expect(queries[0]).toContain('INSERT INTO');
    expect(queries[0]).toContain('developer_module_artifact_uploads');
    expect(queries[0]).toContain("'expired'");
    expect(queries[0]).toContain('ON CONFLICT (upload_id) DO NOTHING');
  });

  test('enqueues once per acceptance run and rereads an opaque worker cursor', async () => {
    const queued = {
      run_id: retentionRunId,
      acceptance_run_id: acceptanceRunId,
      state: 'queued',
      attempts: 0,
      available_at: '2026-07-26T12:00:05.000Z',
      cursor: null,
      last_error: null,
      lease_owner: null,
      lease_expires_at: null,
      created_at: '2026-07-26T12:00:00.000Z',
      updated_at: '2026-07-26T12:00:00.000Z',
      finished_at: null,
    };
    const running = {
      ...queued,
      state: 'running',
      attempts: 1,
      cursor: 'opaque+s3/cursor==',
      lease_owner: 'api-retention-1',
      lease_expires_at: '2026-07-26T12:00:30.000Z',
      updated_at: '2026-07-26T12:00:06.000Z',
    };
    const { parameters, queries, sql } = recordingSql([queued], [running]);
    const repository = createPostgresModuleBetaAcceptanceRepository({ sql });

    await expect(
      repository.enqueueRetentionRun({
        acceptanceRunId,
        delayMs: 5_000,
      }),
    ).resolves.toMatchObject({
      runId: retentionRunId,
      acceptanceRunId,
      state: 'queued',
      cursor: null,
    });
    await expect(repository.readRetentionRun({ acceptanceRunId })).resolves.toMatchObject({
      runId: retentionRunId,
      acceptanceRunId,
      state: 'running',
      cursor: 'opaque+s3/cursor==',
    });
    expect(queries[0]).toContain('developer_artifact_retention_runs');
    expect(queries[0]).toContain('ON CONFLICT DO NOTHING');
    expect(queries[0]).toContain("CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond')");
    expect(parameters[0]).toEqual([acceptanceRunId, 5_000]);
    expect(queries[1]).toContain('acceptance_run_id = $1');
  });

  test('keeps cursors opaque while rejecting control characters and noncanonical success', async () => {
    const base = {
      run_id: retentionRunId,
      acceptance_run_id: acceptanceRunId,
      state: 'running',
      attempts: 1,
      available_at: '2026-07-26T12:00:05.000Z',
      cursor: 'opaque\tcursor',
      last_error: null,
      lease_owner: 'api-retention-1',
      lease_expires_at: '2026-07-26T12:00:30.000Z',
      created_at: '2026-07-26T12:00:00.000Z',
      updated_at: '2026-07-26T12:00:06.000Z',
      finished_at: null,
    };
    const controlCursor = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith([base]),
    });
    await expect(controlCursor.readRetentionRun({ acceptanceRunId })).rejects.toThrow(
      'MODULE_BETA_ACCEPTANCE_RETENTION_INVALID',
    );

    const staleSuccessCursor = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith([
        {
          ...base,
          state: 'succeeded',
          cursor: 'opaque-valid-cursor',
          lease_owner: null,
          lease_expires_at: null,
          finished_at: '2026-07-26T12:00:06.000Z',
        },
      ]),
    });
    await expect(staleSuccessCursor.readRetentionRun({ acceptanceRunId })).rejects.toThrow(
      'MODULE_BETA_ACCEPTANCE_RETENTION_INVALID',
    );
  });

  test('requires the production worker deletion marker for the expired probe', async () => {
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith([
        {
          upload_id: retentionProbeUploadId,
          account_id: accountId,
          state: 'expired',
          staging_storage_key:
            'developer-modules/staging/acceptance-probes/run/expired-retention.v1.json',
          staging_deleted_at: '2026-07-26T12:00:06.000Z',
        },
      ]),
    });

    await expect(
      repository.assertExpiredRetentionProbeDeleted({
        accountId,
        uploadId: retentionProbeUploadId,
        storageKey: 'developer-modules/staging/acceptance-probes/run/expired-retention.v1.json',
      }),
    ).resolves.toBeUndefined();
  });

  test('rejects cleanup when any requested resource is outside the acceptance run', async () => {
    const repository = createPostgresModuleBetaAcceptanceRepository({
      sql: sqlWith(
        [
          {
            upload_id: uploadId,
            account_id: accountId,
            state: 'cancelled',
            staging_storage_key: 'developer-modules/staging/partition/upload',
          },
        ],
        [
          {
            acceptance_run_id: acceptanceRunId,
            run_id: runId,
            release_id: '50000000-0000-4000-a000-000000000099',
            artifact_id: artifactId,
            artifact_digest: digest('a'),
            state: 'passed',
            lease_owner: null,
            lease_token_hash: null,
            lease_expires_at: null,
            heartbeat_at: null,
          },
        ],
      ),
    });

    await expect(
      repository.getCleanupBinding({
        acceptanceRunId,
        accountId,
        cancelledUploadId: uploadId,
        artifactIds: [artifactId],
        releaseIds: [releaseId],
        verificationRunIds: [runId],
      }),
    ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
  });

  test('rejects cleanup when the request omits a resource owned by the acceptance run', async () => {
    const otherRunId = '30000000-0000-4000-a000-000000000099';
    const otherReleaseId = '50000000-0000-4000-a000-000000000099';
    const otherArtifactId = '20000000-0000-4000-a000-000000000099';
    const baseRow = {
      acceptance_run_id: acceptanceRunId,
      run_id: runId,
      release_id: releaseId,
      artifact_id: artifactId,
      artifact_digest: digest('a'),
      state: 'passed',
      lease_owner: null,
      lease_token_hash: null,
      lease_expires_at: null,
      heartbeat_at: null,
    };
    const sql = {
      async unsafe(query: string) {
        if (query.includes('developer_module_artifact_uploads')) {
          return [
            {
              upload_id: uploadId,
              account_id: accountId,
              state: 'cancelled',
              staging_storage_key: 'developer-modules/staging/partition/upload',
            },
          ];
        }
        if (query.includes('jsonb_array_elements_text')) return [baseRow];
        return [
          baseRow,
          {
            ...baseRow,
            run_id: otherRunId,
            release_id: otherReleaseId,
            artifact_id: otherArtifactId,
          },
        ];
      },
    } as unknown as Sql;
    const repository = createPostgresModuleBetaAcceptanceRepository({ sql });

    await expect(
      repository.getCleanupBinding({
        acceptanceRunId,
        accountId,
        cancelledUploadId: uploadId,
        artifactIds: [artifactId],
        releaseIds: [releaseId],
        verificationRunIds: [runId],
      }),
    ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
  });

  test('rejects cleanup while a verification run is nonterminal or still leased', async () => {
    const baseRow = {
      acceptance_run_id: acceptanceRunId,
      run_id: runId,
      release_id: releaseId,
      artifact_id: artifactId,
      artifact_digest: digest('a'),
      state: 'passed',
      lease_owner: null,
      lease_token_hash: null,
      lease_expires_at: null,
      heartbeat_at: null,
    };
    for (const row of [
      { ...baseRow, state: 'running' },
      { ...baseRow, lease_owner: 'trust-worker-acceptance' },
      { ...baseRow, lease_token_hash: digest('f') },
      { ...baseRow, lease_expires_at: '2026-07-26T12:01:00.000Z' },
      { ...baseRow, heartbeat_at: '2026-07-26T12:00:30.000Z' },
    ]) {
      const repository = createPostgresModuleBetaAcceptanceRepository({
        sql: sqlWith(
          [
            {
              upload_id: uploadId,
              account_id: accountId,
              state: 'cancelled',
              staging_storage_key: 'developer-modules/staging/partition/upload',
            },
          ],
          [row],
        ),
      });

      await expect(
        repository.getCleanupBinding({
          acceptanceRunId,
          accountId,
          cancelledUploadId: uploadId,
          artifactIds: [artifactId],
          releaseIds: [releaseId],
          verificationRunIds: [runId],
        }),
      ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_DATABASE_BINDING_INVALID');
    }
  });
});
