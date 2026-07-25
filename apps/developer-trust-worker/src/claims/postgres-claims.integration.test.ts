import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres, { type Sql } from 'postgres';

import { createPostgresVerificationClaims } from './postgres-claims';

const databaseUrl =
  process.env.MODULE_BETA_TEST_DATABASE_URL ?? process.env.DEVELOPER_TRUST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const schema = `trust_claims_${process.pid}_${Date.now()}`;
let sql: Sql | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 2, prepare: false });
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await sql.unsafe(`
    CREATE TABLE "${schema}".developer_module_artifacts (
      artifact_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      artifact_digest varchar(71) NOT NULL,
      storage_key text NOT NULL,
      size_bytes bigint NOT NULL
    );
    CREATE TABLE "${schema}".developer_module_releases (
      release_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      artifact_id uuid NOT NULL,
      module_id varchar(128) NOT NULL,
      module_version varchar(128) NOT NULL,
      manifest jsonb NOT NULL,
      runtime_descriptor_path varchar(512),
      runtime_kind varchar(32)
    );
    CREATE TABLE "${schema}".developer_module_verification_runs (
      run_id uuid PRIMARY KEY,
      release_id uuid NOT NULL,
      artifact_id uuid NOT NULL,
      account_id uuid NOT NULL,
      policy_digest varchar(71) NOT NULL,
      scanner_set_digest varchar(71) NOT NULL,
      sandbox_profile_digest varchar(71) NOT NULL,
      attempt integer NOT NULL,
      state text NOT NULL,
      lease_owner varchar(128),
      lease_token_hash varchar(71),
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      terminal_reason varchar(256),
      sbom_digest varchar(71),
      attestation_digest varchar(71),
      resource_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
});

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await sql.end({ timeout: 1 });
});

describe('PostgreSQL verification claims', () => {
  integrationTest('reclaim generation fences a stale worker', async () => {
    if (!sql) throw new Error('integration database is unavailable');
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    await sql.unsafe(
      `INSERT INTO "${schema}".developer_module_artifacts
        (artifact_id, account_id, artifact_digest, storage_key, size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        '40000000-0000-4000-a000-000000000004',
        '10000000-0000-4000-a000-000000000001',
        digest('a'),
        'developer-modules/artifacts/private/content',
        123,
      ],
    );
    await sql.unsafe(
      `INSERT INTO "${schema}".developer_module_releases
        (release_id, account_id, artifact_id, module_id, module_version, manifest)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        '30000000-0000-4000-a000-000000000003',
        '10000000-0000-4000-a000-000000000001',
        '40000000-0000-4000-a000-000000000004',
        'acme.clean',
        '1.0.0',
        {
          execution: { mode: 'server-adapter' },
          verification: { profile: 'server-conformance' },
        },
      ],
    );
    await sql.unsafe(
      `INSERT INTO "${schema}".developer_module_verification_runs
        (run_id, release_id, artifact_id, account_id, policy_digest, scanner_set_digest,
         sandbox_profile_digest, attempt, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'queued')`,
      [
        '50000000-0000-4000-a000-000000000005',
        '30000000-0000-4000-a000-000000000003',
        '40000000-0000-4000-a000-000000000004',
        '10000000-0000-4000-a000-000000000001',
        digest('b'),
        digest('c'),
        digest('d'),
      ],
    );
    const claims = createPostgresVerificationClaims({ sql, schema });

    const first = await claims.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    expect(first).not.toBeNull();
    if (!first) throw new Error('expected initial verification claim');
    await sql.unsafe(
      `UPDATE "${schema}".developer_module_verification_runs
       SET lease_expires_at = now() - interval '1 second'
       WHERE run_id = $1`,
      ['50000000-0000-4000-a000-000000000005'],
    );
    const second = await claims.claim({ workerId: 'worker-b', leaseMs: 30_000 });

    expect(second?.leaseGeneration).toBe((first?.leaseGeneration ?? 0) + 1);
    await expect(
      claims.heartbeat({
        runId: first.runId,
        workerId: 'worker-a',
        leaseToken: first.leaseToken,
        leaseGeneration: first.leaseGeneration,
        leaseMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: 'STALE_VERIFICATION_LEASE' });
  });
});
