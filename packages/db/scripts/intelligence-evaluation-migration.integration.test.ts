import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718160000000_intelligence_evaluations.sql',
);

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-intelligence-evaluation-migration-${crypto.randomUUID().slice(0, 8)}`;

function dockerPsql(sql: string, allowFailure = false) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

const ACCOUNT_A = '31000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '31000000-0000-4000-a000-000000000002';
const PROJECT_A = '32000000-0000-4000-a000-000000000001';
const PROJECT_B = '32000000-0000-4000-a000-000000000002';
const SUITE_A = '33000000-0000-4000-a000-000000000001';
const RUN_A = '34000000-0000-4000-a000-000000000001';
const SNAPSHOT_A = '35000000-0000-4000-a000-000000000001';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

const PRE_SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA kortix;
  CREATE TABLE kortix.accounts(account_id uuid PRIMARY KEY);
  CREATE TABLE kortix.projects(
    project_id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id)
  );
  INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_A}'), ('${ACCOUNT_B}');
  INSERT INTO kortix.projects(project_id, account_id)
    VALUES ('${PROJECT_A}', '${ACCOUNT_A}'), ('${PROJECT_B}', '${ACCOUNT_B}');
`;

const SCORERS = JSON.stringify([
  { scorer_id: 'image.schema_validity', version: '1.0.0' },
  { scorer_id: 'system.latency', version: '1.0.0' },
]);
const THRESHOLDS = JSON.stringify({
  minimum_schema_valid_rate_ppm: 1_000_000,
  minimum_integrity_rate_ppm: 990_000,
  minimum_safety_rate_ppm: 1_000_000,
  minimum_human_approval_rate_ppm: 800_000,
  maximum_failure_rate_ppm: 10_000,
});
const CONFIDENCE = JSON.stringify({
  method: 'wilson',
  level_bps: 9_500,
  lower_bound_ppm: 900_000,
  upper_bound_ppm: 990_000,
});
const METRICS = JSON.stringify({
  schema_valid_rate_ppm: 1_000_000,
  integrity_rate_ppm: 990_000,
  safety_rate_ppm: 1_000_000,
  availability_rate_ppm: 980_000,
  failure_rate_ppm: 20_000,
  retry_rate_ppm: 50_000,
  human_approval_rate_ppm: 900_000,
  latency_p50_ms: 1_200,
  latency_p95_ms: 2_500,
  mean_cost_micredits: 42_000,
  total_cost_micredits: 4_200_000,
});

function insertSnapshotSql(): string {
  return `
    INSERT INTO kortix.intelligence_model_evaluation_snapshots(
      snapshot_id, snapshot_version, evaluation_run_id, suite_id, account_id, project_id,
      suite_version, candidate_hash, capability_id, capability_version, sample_count,
      minimum_sample_count, meets_minimum_samples, confidence, metrics, scorer_versions,
      published_at
    ) VALUES (
      '${SNAPSHOT_A}', 'image-golden-v1.fake-image-v1.1', '${RUN_A}', '${SUITE_A}',
      '${ACCOUNT_A}', '${PROJECT_A}', 'image-golden-v1', '${HASH_A}',
      'studio.image.generate', '1.0.0', 100, 30, true,
      '${CONFIDENCE}'::jsonb, '${METRICS}'::jsonb, '${SCORERS}'::jsonb, now()
    );
  `;
}

describe.skipIf(!dockerAvailable)('Intelligence evaluation migration - real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    const readinessDeadline = Date.now() + 90_000;
    while (Date.now() < readinessDeadline) {
      const logs = Bun.spawnSync(['docker', 'logs', container], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const initComplete = `${logs.stdout.toString()}${logs.stderr.toString()}`.includes(
        'PostgreSQL init process complete; ready for start up.',
      );
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'testdb'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (initComplete && probe.exitCode === 0) {
        const migration = await Bun.file(migrationPath).text();
        dockerPsql(`BEGIN;\n${PRE_SCHEMA}\n${migration}\nCOMMIT;`);
        dockerPsql(`BEGIN;\n${migration}\nCOMMIT;`);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 120_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  }, 30_000);

  test('adds the three private evaluation tables without exposing raw model inputs', () => {
    const tables = dockerPsql(`
      SELECT string_agg(table_name, ',' ORDER BY table_name)
      FROM information_schema.tables
      WHERE table_schema = 'kortix' AND table_name LIKE 'intelligence_%evaluation%';
    `).output.trim();
    expect(tables).toBe(
      [
        'intelligence_evaluation_runs',
        'intelligence_evaluation_suites',
        'intelligence_model_evaluation_snapshots',
      ].join(','),
    );

    const forbiddenColumns = dockerPsql(`
      SELECT count(*)
      FROM information_schema.columns
      WHERE table_schema = 'kortix'
        AND table_name LIKE 'intelligence_%evaluation%'
        AND column_name IN (
          'prompt', 'asset_id', 'provider', 'provider_config_id', 'model', 'raw_response', 'reasoning'
        );
    `).output.trim();
    expect(forbiddenColumns).toBe('0');
  });

  test('fences suites, runs, and snapshots to one exact project scope', () => {
    dockerPsql(`
      INSERT INTO kortix.intelligence_evaluation_suites(
        suite_id, account_id, project_id, suite_version, capability_id, capability_version,
        dataset_manifest_hash, dataset_ref, scorer_versions, thresholds,
        minimum_sample_count, confidence_level_bps, status, published_at
      ) VALUES (
        '${SUITE_A}', '${ACCOUNT_A}', '${PROJECT_A}', 'image-golden-v1',
        'studio.image.generate', '1.0.0', '${HASH_A}', 'sealed:dataset-image-golden-v1',
        '${SCORERS}'::jsonb, '${THRESHOLDS}'::jsonb, 30, 9500, 'published', now()
      );
      INSERT INTO kortix.intelligence_evaluation_runs(
        evaluation_run_id, suite_id, account_id, project_id, suite_version,
        idempotency_key, request_hash, status, budget_micredits, max_samples
      ) VALUES (
        '${RUN_A}', '${SUITE_A}', '${ACCOUNT_A}', '${PROJECT_A}', 'image-golden-v1',
        'evaluation-run-project-a-0001', '${HASH_B}', 'queued', 5000000, 100
      );
    `);

    const prematureSnapshot = dockerPsql(`BEGIN;\n${insertSnapshotSql()}\nROLLBACK;`, true);
    expect(prematureSnapshot.exitCode).not.toBe(0);

    dockerPsql(`
      UPDATE kortix.intelligence_evaluation_runs
      SET status = 'succeeded', processed_samples = 100, spent_micredits = 4200000,
          started_at = now() - interval '1 minute', completed_at = now()
      WHERE evaluation_run_id = '${RUN_A}';
      ${insertSnapshotSql()}
    `);

    const crossTenantRun = dockerPsql(
      `
        INSERT INTO kortix.intelligence_evaluation_runs(
          suite_id, account_id, project_id, suite_version, idempotency_key,
          request_hash, status, budget_micredits, max_samples
        ) VALUES (
          '${SUITE_A}', '${ACCOUNT_A}', '${PROJECT_B}', 'image-golden-v1',
          'evaluation-run-cross-tenant-0001', '${HASH_A}', 'queued', 1000, 1
        );
      `,
      true,
    );
    expect(crossTenantRun.exitCode).not.toBe(0);
  });

  test('keeps published suites content-immutable and snapshots insert-only', () => {
    expect(
      dockerPsql(
        `UPDATE kortix.intelligence_evaluation_suites
         SET dataset_manifest_hash = '${HASH_B}' WHERE suite_id = '${SUITE_A}';`,
        true,
      ).exitCode,
    ).not.toBe(0);
    expect(
      dockerPsql(
        `UPDATE kortix.intelligence_model_evaluation_snapshots
         SET sample_count = 99 WHERE snapshot_id = '${SNAPSHOT_A}';`,
        true,
      ).exitCode,
    ).not.toBe(0);
    expect(
      dockerPsql(
        `DELETE FROM kortix.intelligence_model_evaluation_snapshots
         WHERE snapshot_id = '${SNAPSHOT_A}';`,
        true,
      ).exitCode,
    ).not.toBe(0);
  });

  test('grants only the minimum evaluation operations to service_role', () => {
    const grants = dockerPsql(`
      SELECT
        has_table_privilege('service_role', 'kortix.intelligence_evaluation_suites', 'SELECT, INSERT, UPDATE'),
        NOT has_table_privilege('service_role', 'kortix.intelligence_evaluation_suites', 'DELETE'),
        has_table_privilege('service_role', 'kortix.intelligence_evaluation_runs', 'SELECT, INSERT, UPDATE'),
        NOT has_table_privilege('service_role', 'kortix.intelligence_evaluation_runs', 'DELETE'),
        has_table_privilege('service_role', 'kortix.intelligence_model_evaluation_snapshots', 'SELECT, INSERT'),
        NOT has_table_privilege(
          'service_role', 'kortix.intelligence_model_evaluation_snapshots', 'UPDATE, DELETE'
        ),
        NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'kortix'
            AND table_name LIKE 'intelligence_%evaluation%'
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')
        );
    `).output.trim();
    expect(grants).toBe('t|t|t|t|t|t|t');
  });
});
