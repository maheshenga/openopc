import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';

import { createDrizzleModuleExecutionRepository } from '../../../apps/api/src/module-runtime/executions.drizzle';
import { createDbFromClient } from '../src/client';

const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260727150000000_module_runtime_control_plane.sql',
);
const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-module-runtime-${crypto.randomUUID().slice(0, 8)}`;
const DOCKER_TEST_TIMEOUT = 60_000;
const CONCURRENCY_TEST_TIMEOUT = 120_000;
let mappedPostgresPort = '';

const ACCOUNT_A = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '10000000-0000-4000-a000-000000000002';
const PROJECT_A = '20000000-0000-4000-a000-000000000001';
const PROJECT_B = '20000000-0000-4000-a000-000000000002';
const INSTALL_A = '30000000-0000-4000-a000-000000000001';
const RELEASE_A = '40000000-0000-4000-a000-000000000001';
const DESCRIPTOR_A = '50000000-0000-4000-a000-000000000001';
const RUNTIME_ARTIFACT_A = '50000000-0000-4000-a000-000000000002';
const CONSENT_A = '60000000-0000-4000-a000-000000000001';
const RUNNER_A = '70000000-0000-4000-a000-000000000001';
const EXECUTION_A = '80000000-0000-4000-a000-000000000001';
const EXECUTION_HEARTBEAT = '80000000-0000-4000-a000-000000000002';
const EXECUTION_DEADLINE_FENCE = '80000000-0000-4000-a000-000000000003';
const EXECUTION_EXPIRED_LEASE = '80000000-0000-4000-a000-000000000004';
const EXECUTION_RUNNER_KILL_SWITCH = '80000000-0000-4000-a000-000000000005';
const EXECUTION_REVOKED_RELEASE = '80000000-0000-4000-a000-000000000006';
const EXECUTION_STALE_KILL_SWITCH = '80000000-0000-4000-a000-000000000007';
const EXECUTION_CLAIM_DEADLINE = '80000000-0000-4000-a000-000000000008';
const EXECUTION_SERVICE_ROLE_CLAIM = '80000000-0000-4000-a000-000000000009';
const EXECUTION_SERVICE_ROLE_LEASED = '80000000-0000-4000-a000-000000000010';
const EXECUTION_APPEND_FIRST = '80000000-0000-4000-a000-000000000011';
const EXECUTION_FINALIZE_FIRST = '80000000-0000-4000-a000-000000000012';
const EXECUTION_LOCK_ORDER = '80000000-0000-4000-a000-000000000013';
const LEASE_A = '90000000-0000-4000-a000-000000000001';
const LEASE_HEARTBEAT = '90000000-0000-4000-a000-000000000002';
const LEASE_DEADLINE_FENCE = '90000000-0000-4000-a000-000000000003';
const LEASE_EXPIRED = '90000000-0000-4000-a000-000000000004';
const LEASE_RUNNER_KILL_SWITCH = '90000000-0000-4000-a000-000000000005';
const LEASE_REVOKED_RELEASE = '90000000-0000-4000-a000-000000000006';
const LEASE_STALE_KILL_SWITCH = '90000000-0000-4000-a000-000000000007';
const LEASE_CLAIM_DEADLINE = '90000000-0000-4000-a000-000000000008';
const LEASE_SERVICE_ROLE = '90000000-0000-4000-a000-000000000009';
const LEASE_SERVICE_ROLE_FORBIDDEN = '90000000-0000-4000-a000-000000000010';
const LEASE_APPEND_FIRST = '90000000-0000-4000-a000-000000000011';
const LEASE_FINALIZE_FIRST = '90000000-0000-4000-a000-000000000012';
const LEASE_LOCK_ORDER = '90000000-0000-4000-a000-000000000013';
const APPEND_GATE = 27_101;
const FINALIZE_GATE = 27_102;
const CANCEL_GATE = 27_103;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;

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

function postgresUrl(): string {
  if (!mappedPostgresPort) throw new Error('PostgreSQL host port is not mapped');
  return `postgres://postgres:test@127.0.0.1:${mappedPostgresPort}/testdb`;
}

function postgresSession(applicationName: string) {
  return postgres(postgresUrl(), {
    max: 1,
    prepare: false,
    connection: { application_name: applicationName, statement_timeout: 60_000 },
  });
}

function runtimeSession(applicationName: string) {
  const client = postgresSession(applicationName);
  return {
    client,
    repository: createDrizzleModuleExecutionRepository(createDbFromClient(client)),
  };
}

async function waitForLock(observer: Sql, applicationName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [activity] = await observer<{ waiting: boolean }[]>`
      SELECT wait_event_type = 'Lock' AS waiting
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
      ORDER BY backend_start DESC
      LIMIT 1
    `;
    if (activity?.waiting) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

function installConcurrencyTestGates() {
  dockerPsql(`
    CREATE OR REPLACE FUNCTION kortix.module_runtime_concurrency_test_gate()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      app_name text := current_setting('application_name', true);
    BEGIN
      IF TG_TABLE_NAME = 'module_execution_events'
         AND app_name = 'module-runtime-append-first' THEN
        PERFORM pg_advisory_xact_lock(${APPEND_GATE});
      ELSIF TG_TABLE_NAME = 'module_execution_evidence'
            AND app_name = 'module-runtime-finalize-first' THEN
        PERFORM pg_advisory_xact_lock(${FINALIZE_GATE});
      ELSIF TG_TABLE_NAME = 'module_executions'
            AND app_name = 'module-runtime-lock-order-cancel'
            AND NEW.execution_id = '${EXECUTION_LOCK_ORDER}'::uuid THEN
        PERFORM pg_advisory_xact_lock(${CANCEL_GATE});
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER module_runtime_events_concurrency_test_gate
    BEFORE INSERT ON kortix.module_execution_events
    FOR EACH ROW EXECUTE FUNCTION kortix.module_runtime_concurrency_test_gate();

    CREATE TRIGGER module_runtime_evidence_concurrency_test_gate
    BEFORE INSERT ON kortix.module_execution_evidence
    FOR EACH ROW EXECUTE FUNCTION kortix.module_runtime_concurrency_test_gate();

    CREATE TRIGGER module_runtime_execution_lock_order_test_gate
    AFTER UPDATE ON kortix.module_executions
    FOR EACH ROW EXECUTE FUNCTION kortix.module_runtime_concurrency_test_gate();
  `);
}

function seedLeasedExecution(input: {
  executionId: string;
  leaseId: string;
  idempotencyKey: string;
}) {
  dockerPsql(`
    INSERT INTO kortix.module_executions(
      execution_id, account_id, project_id, installation_id, release_id,
      consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
      state, idempotency_key,
      work_envelope_digest, kill_switch_generation, deadline_at
    )
    SELECT
      '${input.executionId}', account_id, project_id, installation_id, release_id,
      consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile, 'dispatchable',
      '${input.idempotencyKey}', work_envelope_digest, kill_switch_generation,
      now() + interval '10 minutes'
    FROM kortix.module_executions
    WHERE execution_id = '${EXECUTION_A}';

    SELECT * FROM kortix.claim_module_execution(
      '${ACCOUNT_A}', '${PROJECT_A}', '${input.executionId}', '${RUNNER_A}',
      '${input.leaseId}', 1, now() + interval '5 minutes'
    );
  `);
}

function seedControlPlaneRows() {
  dockerPsql(`
    INSERT INTO kortix.module_runtime_descriptors(
      descriptor_id, account_id, release_id, runtime_kind, descriptor_digest, descriptor
    ) VALUES (
      '${DESCRIPTOR_A}', '${ACCOUNT_A}', '${RELEASE_A}', 'wasi-component', '${DIGEST}',
      '{"descriptorVersion":1,"runtime":{"kind":"wasi-component"}}'::jsonb
    );

    INSERT INTO kortix.project_module_consent_revisions(
      consent_revision_id, account_id, project_id, installation_id, install_revision,
      release_id, permission_digest, permission_snapshot,
      resource_cpu_millis_ceiling, resource_memory_mib_ceiling,
      resource_wall_time_ms_ceiling, cost_ceiling_micro, accepted_by
    ) VALUES (
      '${CONSENT_A}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}', 1,
      '${RELEASE_A}', '${DIGEST}', '{"actions":[]}'::jsonb,
      1000, 256, 30000, 1000000, 'a0000000-0000-4000-a000-000000000001'
    );

    INSERT INTO kortix.module_runners(
      runner_id, account_id, node_identity, status, software_version,
      attestation_digest, certificate_thumbprint
    ) VALUES (
      '${RUNNER_A}', '${ACCOUNT_A}', 'runner-node-a', 'active', '1.0.0',
      '${DIGEST}', '${'c'.repeat(64)}'
    );

    INSERT INTO kortix.module_executions(
      execution_id, account_id, project_id, installation_id, release_id,
      consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
      state, idempotency_key,
      work_envelope_digest, kill_switch_generation, deadline_at
    ) VALUES (
      '${EXECUTION_A}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}', '${RELEASE_A}',
      '${CONSENT_A}', '${DESCRIPTOR_A}', 'wasi-component', 'openopc-wasi-v1',
      'dispatchable', 'idem-module-runtime-1',
      '${DIGEST}', 0, now() + interval '10 minutes'
    );
  `);
}

describe.skipIf(!dockerAvailable)('module runtime control-plane migration - real PostgreSQL', () => {
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
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    const readinessDeadline = Date.now() + 90_000;
    while (Date.now() < readinessDeadline) {
      const readiness = dockerPsql('SELECT current_database();', true);
      if (readiness.exitCode === 0 && readiness.output.trim() === 'testdb') {
        const mappedPort = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (mappedPort.exitCode !== 0) throw new Error(mappedPort.stderr.toString());
        const value = mappedPort.stdout
          .toString()
          .trim()
          .match(/:(\d+)$/)?.[1];
        if (!value) {
          throw new Error(`Could not resolve mapped PostgreSQL port: ${mappedPort.stdout}`);
        }
        mappedPostgresPort = value;
        const migration = await Bun.file(migrationPath).text();
        dockerPsql(`
          CREATE EXTENSION IF NOT EXISTS pgcrypto;
          CREATE ROLE anon;
          CREATE ROLE authenticated;
          CREATE ROLE service_role;
          DO $$ BEGIN CREATE ROLE developer_trust_worker NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          CREATE SCHEMA kortix;
          GRANT USAGE ON SCHEMA kortix TO service_role, developer_trust_worker;
          CREATE TABLE kortix.accounts(account_id uuid PRIMARY KEY);
          CREATE TABLE kortix.projects(
            project_id uuid PRIMARY KEY,
            account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
            UNIQUE (project_id, account_id)
          );
          CREATE TABLE kortix.developer_module_releases(
            release_id uuid PRIMARY KEY,
            account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
            status varchar(32) NOT NULL DEFAULT 'published',
            revoked_at timestamptz,
            signature_payload_digest varchar(71),
            verification_policy_digest varchar(71),
            runtime_descriptor_digest varchar(71),
            signature varchar(96),
            UNIQUE (release_id, account_id)
          );
          CREATE TABLE kortix.project_module_installations(
            installation_id uuid PRIMARY KEY,
            project_id uuid NOT NULL,
            account_id uuid NOT NULL,
            module_id varchar(128) NOT NULL,
            active_release_id uuid NOT NULL,
            active_version varchar(128) NOT NULL,
            install_revision integer NOT NULL DEFAULT 0,
            status varchar(32) NOT NULL DEFAULT 'active',
            UNIQUE (installation_id, project_id, account_id),
            UNIQUE (project_id, module_id)
          );
          INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_A}'), ('${ACCOUNT_B}');
          INSERT INTO kortix.projects(project_id, account_id)
            VALUES ('${PROJECT_A}', '${ACCOUNT_A}'), ('${PROJECT_B}', '${ACCOUNT_B}');
          INSERT INTO kortix.developer_module_releases(
            release_id, account_id, status, signature_payload_digest,
            verification_policy_digest, runtime_descriptor_digest, signature
          ) VALUES (
            '${RELEASE_A}', '${ACCOUNT_A}', 'published', '${DIGEST}', '${DIGEST}',
            '${DIGEST}', 'base64url:${'a'.repeat(86)}'
          );
          INSERT INTO kortix.project_module_installations(
            installation_id, project_id, account_id, module_id, active_release_id, active_version, install_revision
          ) VALUES (
            '${INSTALL_A}', '${PROJECT_A}', '${ACCOUNT_A}', 'acme.module', '${RELEASE_A}', '1.0.0', 1
          );
          ${migration}
          ${migration}
        `);
        installConcurrencyTestGates();
        seedControlPlaneRows();
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 180_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  }, DOCKER_TEST_TIMEOUT);

  test('applies idempotently with fencing functions and live-lease uniqueness', () => {
    const shape = dockerPsql(`
      SELECT
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'kortix'
            AND table_name IN (
              'module_runtime_descriptors',
              'module_runtime_artifacts',
              'project_module_consent_revisions',
              'module_runners',
              'module_runner_profiles',
              'module_executions',
              'module_execution_inputs',
              'module_execution_leases',
              'module_execution_heartbeats',
              'module_capability_grants',
              'module_capability_uses',
              'module_execution_events',
              'module_execution_outputs',
              'module_execution_evidence',
              'module_kill_switch_generations',
              'module_execution_outbox'
            )),
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'kortix'
            AND indexname = 'module_execution_leases_live_execution_unique'),
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'kortix'
            AND indexname = 'idx_module_executions_dispatchable_profile'),
        (SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kortix'
            AND p.proname IN (
              'claim_module_execution',
              'heartbeat_module_execution',
              'finalize_module_execution'
            )),
        (SELECT p.prosecdef
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kortix'
            AND p.proname = 'finalize_module_execution'),
        to_regprocedure(
          'kortix.heartbeat_module_execution(uuid,uuid,uuid,uuid,integer,uuid)'
        ) IS NOT NULL,
        to_regprocedure(
          'kortix.heartbeat_module_execution(uuid,uuid,uuid,uuid,integer,uuid,timestamptz)'
        ) IS NULL;
    `).output.trim();

    expect(shape).toBe('16|1|1|3|t|t|t');
  }, DOCKER_TEST_TIMEOUT);

  test('rejects invalid execution input and WASI runtime artifact boundaries', () => {
    const oversizedInput = dockerPsql(
      `INSERT INTO kortix.module_execution_inputs(
         execution_id, account_id, project_id, input_payload, input_digest
       ) VALUES (
         '${EXECUTION_A}', '${ACCOUNT_A}', '${PROJECT_A}',
         decode(repeat('00', 262145), 'hex'), '${DIGEST}'
       );`,
      true,
    );
    expect(oversizedInput.exitCode).not.toBe(0);
    expect(oversizedInput.output).toContain('module_execution_inputs_payload_size_check');

    const uppercaseDigest = dockerPsql(
      `INSERT INTO kortix.module_execution_inputs(
         execution_id, account_id, project_id, input_payload, input_digest
       ) VALUES (
         '${EXECUTION_A}', '${ACCOUNT_A}', '${PROJECT_A}', decode('7b7d', 'hex'),
         'sha256:${'A'.repeat(64)}'
       );`,
      true,
    );
    expect(uppercaseDigest.exitCode).not.toBe(0);
    expect(uppercaseDigest.output).toContain('module_execution_inputs_digest_check');

    for (const [label, artifactBytes, mediaType, constraint] of [
      ['zero-byte', 0, 'application/wasm', 'module_runtime_artifacts_bytes_check'],
      ['oversized', 33_554_433, 'application/wasm', 'module_runtime_artifacts_bytes_check'],
      ['non-WASM', 2, 'application/octet-stream', 'module_runtime_artifacts_media_type_check'],
    ] as const) {
      const invalid = dockerPsql(
        `INSERT INTO kortix.module_runtime_artifacts(
           runtime_artifact_id, account_id, release_id, runtime_descriptor_id,
           artifact_digest, artifact_bytes, media_type, storage_key
         ) VALUES (
           gen_random_uuid(), '${ACCOUNT_A}', '${RELEASE_A}', '${DESCRIPTOR_A}',
           '${DIGEST_B}', ${artifactBytes}, '${mediaType}', 'runtime-artifacts/${label}.wasm'
         );`,
        true,
      );
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.output).toContain(constraint);
    }
  }, DOCKER_TEST_TIMEOUT);

  test('makes execution inputs and runtime artifacts immutable', () => {
    dockerPsql(`
      INSERT INTO kortix.module_execution_inputs(
        execution_id, account_id, project_id, input_payload, input_digest
      ) VALUES (
        '${EXECUTION_A}', '${ACCOUNT_A}', '${PROJECT_A}', decode('7b7d', 'hex'), '${DIGEST}'
      );

      INSERT INTO kortix.module_runtime_artifacts(
        runtime_artifact_id, account_id, release_id, runtime_descriptor_id,
        artifact_digest, artifact_bytes, media_type, storage_key
      ) VALUES (
        '${RUNTIME_ARTIFACT_A}', '${ACCOUNT_A}', '${RELEASE_A}', '${DESCRIPTOR_A}',
        '${DIGEST_B}', 2, 'application/wasm',
        'runtime-artifacts/${ACCOUNT_A}/${RUNTIME_ARTIFACT_A}.wasm'
      );
    `);

    for (const sql of [
      `UPDATE kortix.module_execution_inputs SET input_digest = '${DIGEST_B}'
       WHERE execution_id = '${EXECUTION_A}';`,
      `DELETE FROM kortix.module_execution_inputs WHERE execution_id = '${EXECUTION_A}';`,
      `UPDATE kortix.module_runtime_artifacts SET storage_key = 'runtime-artifacts/replaced.wasm'
       WHERE runtime_artifact_id = '${RUNTIME_ARTIFACT_A}';`,
      `DELETE FROM kortix.module_runtime_artifacts
       WHERE runtime_artifact_id = '${RUNTIME_ARTIFACT_A}';`,
    ]) {
      const rejected = dockerPsql(sql, true);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toMatch(/append-only/i);
    }
  }, DOCKER_TEST_TIMEOUT);

  test('uses the dispatchable profile index without descriptor JSON parsing', () => {
    const plan = dockerPsql(`
      SET enable_seqscan = off;
      EXPLAIN (COSTS OFF)
      SELECT execution_id
      FROM kortix.module_executions
      WHERE account_id = '${ACCOUNT_A}'
        AND state = 'dispatchable'
        AND runtime_kind = 'wasi-component'
        AND runtime_profile = 'openopc-wasi-v1'
        AND deadline_at > now()
      ORDER BY deadline_at, created_at, execution_id
      LIMIT 1;
    `).output;

    expect(plan).toContain('idx_module_executions_dispatchable_profile');
    expect(plan).not.toMatch(/descriptor/i);
  }, DOCKER_TEST_TIMEOUT);

  test('allows only one live lease per dispatchable execution', () => {
    const claimed = dockerPsql(`
      SELECT lease_id, execution_id, generation, state
      FROM kortix.claim_module_execution(
        '${ACCOUNT_A}',
        '${PROJECT_A}',
        '${EXECUTION_A}',
        '${RUNNER_A}',
        '${LEASE_A}',
        1,
        now() + interval '5 minutes'
      );
    `).output.trim();

    expect(claimed).toBe(`${LEASE_A}|${EXECUTION_A}|1|leased`);

    const second = dockerPsql(
      `
        INSERT INTO kortix.module_execution_leases(
          lease_id, execution_id, account_id, project_id, runner_id, generation, deadline_at
        ) VALUES (
          '91000000-0000-4000-a000-000000000001',
          '${EXECUTION_A}', '${ACCOUNT_A}', '${PROJECT_A}', '${RUNNER_A}', 2,
          now() + interval '5 minutes'
        );
      `,
      true,
    );
    expect(second.exitCode).not.toBe(0);
    expect(second.output).toMatch(/module_execution_leases_live_execution_unique|unique/i);
  }, DOCKER_TEST_TIMEOUT);

  test('rejects a claim lease beyond the immutable execution deadline', () => {
    const claim = dockerPsql(
      `
        INSERT INTO kortix.module_executions(
          execution_id, account_id, project_id, installation_id, release_id,
          consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
          state, idempotency_key,
          work_envelope_digest, kill_switch_generation, deadline_at
        ) VALUES (
          '${EXECUTION_CLAIM_DEADLINE}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}',
          '${RELEASE_A}', '${CONSENT_A}', '${DESCRIPTOR_A}',
          'wasi-component', 'openopc-wasi-v1', 'dispatchable',
          'idem-module-runtime-claim-deadline', '${DIGEST}', 0, now() + interval '2 minutes'
        );
        SELECT * FROM kortix.claim_module_execution(
          '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_CLAIM_DEADLINE}', '${RUNNER_A}',
          '${LEASE_CLAIM_DEADLINE}', 1, now() + interval '5 minutes'
        );
      `,
      true,
    );

    expect(claim.exitCode).not.toBe(0);
    expect(claim.output).toMatch(/deadline|lease|execution/i);
    const persisted = dockerPsql(`
      SELECT
        execution.state,
        count(lease.lease_id)
      FROM kortix.module_executions AS execution
      LEFT JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_CLAIM_DEADLINE}'
      GROUP BY execution.state;
    `).output.trim();
    expect(persisted).toBe('dispatchable|0');
  }, DOCKER_TEST_TIMEOUT);

  test('runner kill switch blocks claim inside the database fence', () => {
    dockerPsql(`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key,
        work_envelope_digest, kill_switch_generation, deadline_at
      ) VALUES (
        '${EXECUTION_RUNNER_KILL_SWITCH}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}',
        '${RELEASE_A}', '${CONSENT_A}', '${DESCRIPTOR_A}',
        'wasi-component', 'openopc-wasi-v1', 'dispatchable',
        'idem-module-runtime-runner-kill', '${DIGEST}', 0, now() + interval '10 minutes'
      );
      INSERT INTO kortix.module_kill_switch_generations(
        account_id, runner_id, scope, generation, active
      ) VALUES ('${ACCOUNT_A}', '${RUNNER_A}', 'runner', 1, true);
    `);

    const claim = dockerPsql(
      `
        SELECT * FROM kortix.claim_module_execution(
          '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_RUNNER_KILL_SWITCH}', '${RUNNER_A}',
          '${LEASE_RUNNER_KILL_SWITCH}', 1, now() + interval '30 seconds'
        );
      `,
      true,
    );
    dockerPsql(`
      UPDATE kortix.module_kill_switch_generations
      SET active = false, released_at = now()
      WHERE account_id = '${ACCOUNT_A}' AND runner_id = '${RUNNER_A}' AND active;
    `);

    expect(claim.exitCode).not.toBe(0);
    expect(claim.output).toMatch(/kill|runner|execution|not found/i);
    const persisted = dockerPsql(`
      SELECT
        execution.state,
        count(lease.lease_id)
      FROM kortix.module_executions AS execution
      LEFT JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_RUNNER_KILL_SWITCH}'
      GROUP BY execution.state;
    `).output.trim();
    expect(persisted).toBe('dispatchable|0');
  }, DOCKER_TEST_TIMEOUT);

  test('revoked release blocks claim inside the database fence', () => {
    dockerPsql(`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key,
        work_envelope_digest, kill_switch_generation, deadline_at
      ) VALUES (
        '${EXECUTION_REVOKED_RELEASE}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}',
        '${RELEASE_A}', '${CONSENT_A}', '${DESCRIPTOR_A}',
        'wasi-component', 'openopc-wasi-v1', 'dispatchable',
        'idem-module-runtime-revoked-release', '${DIGEST}', 0, now() + interval '10 minutes'
      );
      UPDATE kortix.developer_module_releases
      SET status = 'revoked', revoked_at = now()
      WHERE release_id = '${RELEASE_A}';
    `);

    const claim = dockerPsql(
      `
        SELECT * FROM kortix.claim_module_execution(
          '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_REVOKED_RELEASE}', '${RUNNER_A}',
          '${LEASE_REVOKED_RELEASE}', 1, now() + interval '30 seconds'
        );
      `,
      true,
    );
    dockerPsql(`
      UPDATE kortix.developer_module_releases
      SET status = 'published', revoked_at = NULL
      WHERE release_id = '${RELEASE_A}';
    `);

    expect(claim.exitCode).not.toBe(0);
    expect(claim.output).toMatch(/release|execution|not found/i);
    const persisted = dockerPsql(`
      SELECT
        execution.state,
        count(lease.lease_id)
      FROM kortix.module_executions AS execution
      LEFT JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_REVOKED_RELEASE}'
      GROUP BY execution.state;
    `).output.trim();
    expect(persisted).toBe('dispatchable|0');
  }, DOCKER_TEST_TIMEOUT);

  test('advanced kill switch generation blocks an older execution binding', () => {
    dockerPsql(`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key,
        work_envelope_digest, kill_switch_generation, deadline_at
      ) VALUES (
        '${EXECUTION_STALE_KILL_SWITCH}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}',
        '${RELEASE_A}', '${CONSENT_A}', '${DESCRIPTOR_A}',
        'wasi-component', 'openopc-wasi-v1', 'dispatchable',
        'idem-module-runtime-stale-kill', '${DIGEST}', 0, now() + interval '10 minutes'
      );
      INSERT INTO kortix.module_kill_switch_generations(
        account_id, scope, generation, active, released_at
      ) VALUES ('${ACCOUNT_A}', 'account', 1, false, now());
    `);

    const claim = dockerPsql(
      `
        SELECT * FROM kortix.claim_module_execution(
          '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_STALE_KILL_SWITCH}', '${RUNNER_A}',
          '${LEASE_STALE_KILL_SWITCH}', 1, now() + interval '30 seconds'
        );
      `,
      true,
    );
    dockerPsql(`
      DELETE FROM kortix.module_kill_switch_generations
      WHERE account_id = '${ACCOUNT_A}' AND scope = 'account' AND generation = 1;
    `);

    expect(claim.exitCode).not.toBe(0);
    expect(claim.output).toMatch(/kill|execution|not found/i);
    const persisted = dockerPsql(`
      SELECT
        execution.state,
        count(lease.lease_id)
      FROM kortix.module_executions AS execution
      LEFT JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_STALE_KILL_SWITCH}'
      GROUP BY execution.state;
    `).output.trim();
    expect(persisted).toBe('dispatchable|0');
  }, DOCKER_TEST_TIMEOUT);

  test('heartbeats a live lease and transitions the execution to running', () => {
    dockerPsql(`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key,
        work_envelope_digest, kill_switch_generation, deadline_at
      ) VALUES (
        '${EXECUTION_HEARTBEAT}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}', '${RELEASE_A}',
        '${CONSENT_A}', '${DESCRIPTOR_A}', 'wasi-component', 'openopc-wasi-v1',
        'dispatchable', 'idem-module-runtime-heartbeat',
        '${DIGEST}', 0, now() + interval '10 minutes'
      );
    `);

    const claimed = dockerPsql(`
      SELECT lease_id, execution_id, generation, state
      FROM kortix.claim_module_execution(
        '${ACCOUNT_A}',
        '${PROJECT_A}',
        '${EXECUTION_HEARTBEAT}',
        '${RUNNER_A}',
        '${LEASE_HEARTBEAT}',
        1,
        now() + interval '5 minutes'
      );
    `).output.trim();
    expect(claimed).toBe(`${LEASE_HEARTBEAT}|${EXECUTION_HEARTBEAT}|1|leased`);

    const leased = dockerPsql(`
      SELECT state FROM kortix.module_executions
      WHERE execution_id = '${EXECUTION_HEARTBEAT}';
    `).output.trim();
    expect(leased).toBe('leased');

    const heartbeat = dockerPsql(`
      SELECT
        lease_id,
        execution_id,
        generation,
        deadline_at > clock_timestamp() + interval '25 seconds',
        deadline_at <= clock_timestamp() + interval '30 seconds',
        state
      FROM kortix.heartbeat_module_execution(
        '${ACCOUNT_A}',
        '${PROJECT_A}',
        '${EXECUTION_HEARTBEAT}',
        '${LEASE_HEARTBEAT}',
        1,
        '${RUNNER_A}'
      );
    `).output.trim();
    expect(heartbeat).toBe(`${LEASE_HEARTBEAT}|${EXECUTION_HEARTBEAT}|1|t|t|running`);

    const persisted = dockerPsql(`
      SELECT
        execution.state,
        count(heartbeat.heartbeat_id),
        lease.deadline_at > clock_timestamp() + interval '25 seconds',
        lease.deadline_at <= clock_timestamp() + interval '30 seconds'
      FROM kortix.module_executions AS execution
      JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      LEFT JOIN kortix.module_execution_heartbeats AS heartbeat
        ON heartbeat.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_HEARTBEAT}'
      GROUP BY execution.state, lease.deadline_at;
    `).output.trim();
    expect(persisted).toBe('running|1|t|t');
  }, DOCKER_TEST_TIMEOUT);

  test('caps a heartbeat lease at the execution deadline', () => {
    dockerPsql(`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key,
        work_envelope_digest, kill_switch_generation, deadline_at
      ) VALUES (
        '${EXECUTION_DEADLINE_FENCE}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}',
        '${RELEASE_A}', '${CONSENT_A}', '${DESCRIPTOR_A}',
        'wasi-component', 'openopc-wasi-v1', 'leased',
        'idem-module-runtime-deadline-fence', '${DIGEST}', 0, now() + interval '20 seconds'
      );
      INSERT INTO kortix.module_execution_leases(
        lease_id, execution_id, account_id, project_id, runner_id, generation, deadline_at
      ) VALUES (
        '${LEASE_DEADLINE_FENCE}', '${EXECUTION_DEADLINE_FENCE}', '${ACCOUNT_A}',
        '${PROJECT_A}', '${RUNNER_A}', 1, now() + interval '1 minute'
      );
    `);

    const heartbeat = dockerPsql(
      `SELECT heartbeat.lease_id, heartbeat.deadline_at = execution.deadline_at, heartbeat.state
       FROM kortix.heartbeat_module_execution(
         '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_DEADLINE_FENCE}',
         '${LEASE_DEADLINE_FENCE}', 1, '${RUNNER_A}'
       ) AS heartbeat
       JOIN kortix.module_executions AS execution
         ON execution.execution_id = heartbeat.execution_id;`,
      true,
    );

    expect(heartbeat.exitCode).toBe(0);
    expect(heartbeat.output.trim()).toBe(`${LEASE_DEADLINE_FENCE}|t|running`);

    const persisted = dockerPsql(`
      SELECT
        execution.state,
        lease.deadline_at = execution.deadline_at,
        count(heartbeat.heartbeat_id)
      FROM kortix.module_executions AS execution
      JOIN kortix.module_execution_leases AS lease
        ON lease.execution_id = execution.execution_id
      LEFT JOIN kortix.module_execution_heartbeats AS heartbeat
        ON heartbeat.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_DEADLINE_FENCE}'
      GROUP BY execution.state, execution.deadline_at, lease.deadline_at;
    `).output.trim();
    expect(persisted).toBe('running|t|1');
  }, DOCKER_TEST_TIMEOUT);

  test('rejects finalize from an expired lease', () => {
    const expired = dockerPsql(
      `
        INSERT INTO kortix.module_executions(
          execution_id, account_id, project_id, installation_id, release_id,
          consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
          state, idempotency_key,
          work_envelope_digest, kill_switch_generation, deadline_at
        ) VALUES (
          '${EXECUTION_EXPIRED_LEASE}', '${ACCOUNT_A}', '${PROJECT_A}', '${INSTALL_A}',
          '${RELEASE_A}', '${CONSENT_A}', '${DESCRIPTOR_A}',
          'wasi-component', 'openopc-wasi-v1', 'running',
          'idem-module-runtime-expired-lease', '${DIGEST}', 0, now() + interval '10 minutes'
        );
        INSERT INTO kortix.module_execution_leases(
          lease_id, execution_id, account_id, project_id, runner_id, generation, deadline_at
        ) VALUES (
          '${LEASE_EXPIRED}', '${EXECUTION_EXPIRED_LEASE}', '${ACCOUNT_A}',
          '${PROJECT_A}', '${RUNNER_A}', 1, now() - interval '1 second'
        );
        SELECT * FROM kortix.finalize_module_execution(
          '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_EXPIRED_LEASE}', '${LEASE_EXPIRED}',
          1, '${RUNNER_A}', 'succeeded', '${DIGEST}', '{"ok":true}'::jsonb,
          'execution:${EXECUTION_EXPIRED_LEASE}:terminal', '{"units":1}'::jsonb
        );
      `,
      true,
    );

    expect(expired.exitCode).not.toBe(0);
    expect(expired.output).toMatch(/deadline|expired|lease|stale/i);
    const persisted = dockerPsql(`
      SELECT
        execution.state,
        count(evidence.evidence_id),
        count(outbox.outbox_id)
      FROM kortix.module_executions AS execution
      LEFT JOIN kortix.module_execution_evidence AS evidence
        ON evidence.execution_id = execution.execution_id
      LEFT JOIN kortix.module_execution_outbox AS outbox
        ON outbox.execution_id = execution.execution_id
      WHERE execution.execution_id = '${EXECUTION_EXPIRED_LEASE}'
      GROUP BY execution.state;
    `).output.trim();
    expect(persisted).toBe('running|0|0');
  }, DOCKER_TEST_TIMEOUT);

  test('rejects finalize from a stale lease generation', () => {
    const stale = dockerPsql(
      `
        SELECT * FROM kortix.finalize_module_execution(
          '${ACCOUNT_A}',
          '${PROJECT_A}',
          '${EXECUTION_A}',
          '${LEASE_A}',
          0,
          '${RUNNER_A}',
          'succeeded',
          '${DIGEST_B}',
          '{"outcome":"succeeded"}'::jsonb,
          'outbox-stale-1',
          '{"usage":[]}'::jsonb
        );
      `,
      true,
    );
    expect(stale.exitCode).not.toBe(0);
    expect(stale.output).toMatch(/lease|generation|fence|stale/i);

    const stillLeased = dockerPsql(`
      SELECT state FROM kortix.module_executions WHERE execution_id = '${EXECUTION_A}';
    `).output.trim();
    expect(stillLeased).toBe('leased');
  }, DOCKER_TEST_TIMEOUT);

  test('makes non-terminal signed execution bindings immutable', () => {
    const mutateRuntimeProfile = dockerPsql(
      `UPDATE kortix.module_executions
       SET runtime_profile = 'openopc-wasi-v2'
       WHERE execution_id = '${EXECUTION_A}';`,
      true,
    );
    expect(mutateRuntimeProfile.exitCode).not.toBe(0);
    expect(mutateRuntimeProfile.output).toMatch(/identity|immutable/i);

    const mutateDeadline = dockerPsql(
      `UPDATE kortix.module_executions
       SET deadline_at = deadline_at + interval '1 minute'
       WHERE execution_id = '${EXECUTION_A}';`,
      true,
    );
    expect(mutateDeadline.exitCode).not.toBe(0);
    expect(mutateDeadline.output).toMatch(/identity|immutable/i);

    const mutateGeneration = dockerPsql(
      `UPDATE kortix.module_executions
       SET kill_switch_generation = kill_switch_generation + 1
       WHERE execution_id = '${EXECUTION_A}';`,
      true,
    );
    expect(mutateGeneration.exitCode).not.toBe(0);
    expect(mutateGeneration.output).toMatch(/identity|immutable/i);
  }, DOCKER_TEST_TIMEOUT);

  test('denies service_role direct access to the module runtime control plane', () => {
    dockerPsql(`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key,
        work_envelope_digest, kill_switch_generation, deadline_at
      )
      SELECT
        candidate.execution_id::uuid,
        execution.account_id,
        execution.project_id,
        execution.installation_id,
        execution.release_id,
        execution.consent_revision_id,
        execution.runtime_descriptor_id,
        execution.runtime_kind,
        execution.runtime_profile,
        'dispatchable',
        candidate.idempotency_key,
        execution.work_envelope_digest,
        execution.kill_switch_generation,
        now() + interval '10 minutes'
      FROM kortix.module_executions AS execution
      CROSS JOIN (VALUES
        ('${EXECUTION_SERVICE_ROLE_CLAIM}', 'idem-service-role-claim'),
        ('${EXECUTION_SERVICE_ROLE_LEASED}', 'idem-service-role-leased')
      ) AS candidate(execution_id, idempotency_key)
      WHERE execution.execution_id = '${EXECUTION_A}';

      SELECT * FROM kortix.claim_module_execution(
        '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_LEASED}', '${RUNNER_A}',
        '${LEASE_SERVICE_ROLE}', 1, now() + interval '30 seconds'
      );
    `);

    const attempts = [
      dockerPsql(
        `\\set VERBOSITY verbose
         BEGIN;
         SET LOCAL ROLE service_role;
         SELECT * FROM kortix.claim_module_execution(
           '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_CLAIM}', '${RUNNER_A}',
           '${LEASE_SERVICE_ROLE_FORBIDDEN}', 1, now() + interval '30 seconds'
         );
         ROLLBACK;`,
        true,
      ),
      dockerPsql(
        `\\set VERBOSITY verbose
         BEGIN;
         SET LOCAL ROLE service_role;
         SELECT * FROM kortix.heartbeat_module_execution(
           '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_LEASED}',
           '${LEASE_SERVICE_ROLE}', 1, '${RUNNER_A}'
         );
         ROLLBACK;`,
        true,
      ),
      dockerPsql(
        `\\set VERBOSITY verbose
         BEGIN;
         SET LOCAL ROLE service_role;
         SELECT * FROM kortix.finalize_module_execution(
           '${ACCOUNT_A}', '${PROJECT_A}', '${EXECUTION_SERVICE_ROLE_LEASED}',
           '${LEASE_SERVICE_ROLE}', 1, '${RUNNER_A}', 'succeeded', '${DIGEST_B}',
           '{"outcome":"succeeded"}'::jsonb, 'outbox-service-role-forbidden',
           '{"usage":[]}'::jsonb
         );
         ROLLBACK;`,
        true,
      ),
    ];

    for (const attempt of attempts) {
      expect(attempt.exitCode).not.toBe(0);
      expect(attempt.output).toMatch(/42501/);
      expect(attempt.output).toMatch(/permission denied for function/i);
      expect(attempt.output).not.toMatch(/not found|does not exist|missing lease/i);
    }

    const privileges = dockerPsql(`
      SELECT
        (SELECT count(*)
         FROM unnest(ARRAY[
           'module_runtime_descriptors',
           'module_runtime_artifacts',
           'project_module_consent_revisions',
           'module_runners',
           'module_runner_profiles',
           'module_executions',
           'module_execution_inputs',
           'module_execution_leases',
           'module_execution_heartbeats',
           'module_capability_grants',
           'module_capability_uses',
           'module_execution_events',
           'module_execution_outputs',
           'module_execution_evidence',
           'module_kill_switch_generations',
           'module_execution_outbox'
         ]) AS runtime_table(table_name)
         CROSS JOIN unnest(ARRAY[
           'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
         ]) AS requested(privilege)
         WHERE has_table_privilege(
           'service_role',
           format('kortix.%I', runtime_table.table_name),
           requested.privilege
         )),
        (SELECT count(*)
         FROM pg_proc AS procedure
         INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'kortix'
           AND procedure.proname IN (
             'claim_module_execution',
             'heartbeat_module_execution',
             'finalize_module_execution',
             'reject_module_runtime_append_only',
             'protect_module_execution',
             'protect_module_execution_outbox'
           )
           AND has_function_privilege('service_role', procedure.oid, 'EXECUTE'));
    `).output.trim();
    expect(privileges).toBe('0|0');
  }, DOCKER_TEST_TIMEOUT);

  test('serializes append-first progress before terminal finalize without deadlock', async () => {
    seedLeasedExecution({
      executionId: EXECUTION_APPEND_FIRST,
      leaseId: LEASE_APPEND_FIRST,
      idempotencyKey: 'idem-append-first',
    });
    const gate = postgresSession('module-runtime-append-first-gate');
    const observer = postgresSession('module-runtime-append-first-observer');
    const append = runtimeSession('module-runtime-append-first');
    const finalizer = runtimeSession('module-runtime-append-first-finalize');
    let gateHeld = false;

    try {
      await gate`SELECT pg_advisory_lock(${APPEND_GATE})`;
      gateHeld = true;
      const appendPromise = append.repository.appendEvidence({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        executionId: EXECUTION_APPEND_FIRST,
        leaseId: LEASE_APPEND_FIRST,
        runnerId: RUNNER_A,
        generation: 1,
        eventType: 'runner_progress',
        evidence: { completed: 1 },
      });
      await waitForLock(observer, 'module-runtime-append-first');

      const finalizePromise = finalizer.repository.finalize({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        executionId: EXECUTION_APPEND_FIRST,
        leaseId: LEASE_APPEND_FIRST,
        runnerId: RUNNER_A,
        generation: 1,
        outcome: 'succeeded',
        evidenceDigest: DIGEST_B,
        evidence: { outcome: 'succeeded' },
        usage: { units: [] },
      });
      await waitForLock(observer, 'module-runtime-append-first-finalize');

      await gate`SELECT pg_advisory_unlock(${APPEND_GATE})`;
      gateHeld = false;
      const [progress, finalized] = await Promise.all([appendPromise, finalizePromise]);
      expect(progress).toMatchObject({ eventType: 'runner_progress', sequence: 1 });
      expect(finalized.execution.state).toBe('succeeded');

      const persisted = dockerPsql(`
        SELECT
          execution.state,
          string_agg(event.event_type, ',' ORDER BY event.sequence),
          (SELECT count(*) FROM kortix.module_execution_evidence
            WHERE execution_id = execution.execution_id),
          (SELECT count(*) FROM kortix.module_execution_outbox
            WHERE execution_id = execution.execution_id)
        FROM kortix.module_executions AS execution
        INNER JOIN kortix.module_execution_events AS event
          ON event.execution_id = execution.execution_id
        WHERE execution.execution_id = '${EXECUTION_APPEND_FIRST}'
        GROUP BY execution.execution_id, execution.state;
      `).output.trim();
      expect(persisted).toBe('succeeded|runner_progress,execution_finalized|1|1');
    } finally {
      if (gateHeld) await gate`SELECT pg_advisory_unlock(${APPEND_GATE})`;
      await Promise.all([
        gate.end({ timeout: 5 }),
        observer.end({ timeout: 5 }),
        append.client.end({ timeout: 5 }),
        finalizer.client.end({ timeout: 5 }),
      ]);
    }
  }, CONCURRENCY_TEST_TIMEOUT);

  test('rejects finalize-first progress after waiting for terminal commit', async () => {
    seedLeasedExecution({
      executionId: EXECUTION_FINALIZE_FIRST,
      leaseId: LEASE_FINALIZE_FIRST,
      idempotencyKey: 'idem-finalize-first',
    });
    const gate = postgresSession('module-runtime-finalize-first-gate');
    const observer = postgresSession('module-runtime-finalize-first-observer');
    const finalizer = runtimeSession('module-runtime-finalize-first');
    const append = runtimeSession('module-runtime-finalize-first-append');
    let gateHeld = false;

    try {
      await gate`SELECT pg_advisory_lock(${FINALIZE_GATE})`;
      gateHeld = true;
      const finalizePromise = finalizer.repository.finalize({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        executionId: EXECUTION_FINALIZE_FIRST,
        leaseId: LEASE_FINALIZE_FIRST,
        runnerId: RUNNER_A,
        generation: 1,
        outcome: 'succeeded',
        evidenceDigest: DIGEST_B,
        evidence: { outcome: 'succeeded' },
        usage: { units: [] },
      });
      await waitForLock(observer, 'module-runtime-finalize-first');

      const appendOutcomePromise = append.repository
        .appendEvidence({
          accountId: ACCOUNT_A,
          projectId: PROJECT_A,
          executionId: EXECUTION_FINALIZE_FIRST,
          leaseId: LEASE_FINALIZE_FIRST,
          runnerId: RUNNER_A,
          generation: 1,
          eventType: 'runner_progress',
          evidence: { completed: 1 },
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await waitForLock(observer, 'module-runtime-finalize-first-append');

      await gate`SELECT pg_advisory_unlock(${FINALIZE_GATE})`;
      gateHeld = false;
      const [finalized, appendOutcome] = await Promise.all([
        finalizePromise,
        appendOutcomePromise,
      ]);
      expect(finalized.execution.state).toBe('succeeded');
      expect(appendOutcome.ok).toBe(false);
      if (appendOutcome.ok) throw new Error('Progress append unexpectedly succeeded');
      expect(appendOutcome.error).toMatchObject({
        code: 'MODULE_EXECUTION_LEASE_STALE',
        status: 409,
      });

      const persisted = dockerPsql(`
        SELECT
          execution.state,
          string_agg(event.event_type, ',' ORDER BY event.sequence),
          count(*) FILTER (WHERE event.event_type = 'runner_progress'),
          (SELECT count(*) FROM kortix.module_execution_evidence
            WHERE execution_id = execution.execution_id),
          (SELECT count(*) FROM kortix.module_execution_outbox
            WHERE execution_id = execution.execution_id)
        FROM kortix.module_executions AS execution
        INNER JOIN kortix.module_execution_events AS event
          ON event.execution_id = execution.execution_id
        WHERE execution.execution_id = '${EXECUTION_FINALIZE_FIRST}'
        GROUP BY execution.execution_id, execution.state;
      `).output.trim();
      expect(persisted).toBe('succeeded|execution_finalized|0|1|1');
    } finally {
      if (gateHeld) await gate`SELECT pg_advisory_unlock(${FINALIZE_GATE})`;
      await Promise.all([
        gate.end({ timeout: 5 }),
        observer.end({ timeout: 5 }),
        finalizer.client.end({ timeout: 5 }),
        append.client.end({ timeout: 5 }),
      ]);
    }
  }, CONCURRENCY_TEST_TIMEOUT);

  test('lets cancellation finish before a waiting heartbeat without deadlock', async () => {
    seedLeasedExecution({
      executionId: EXECUTION_LOCK_ORDER,
      leaseId: LEASE_LOCK_ORDER,
      idempotencyKey: 'idem-lock-order',
    });
    const gate = postgresSession('module-runtime-lock-order-gate');
    const observer = postgresSession('module-runtime-lock-order-observer');
    const cancel = runtimeSession('module-runtime-lock-order-cancel');
    const heartbeat = runtimeSession('module-runtime-lock-order-heartbeat');
    let gateHeld = false;

    try {
      await cancel.client`SET deadlock_timeout = '100ms'`;
      await heartbeat.client`SET deadlock_timeout = '5s'`;
      await gate`SELECT pg_advisory_lock(${CANCEL_GATE})`;
      gateHeld = true;

      const cancelOutcomePromise = cancel.repository
        .cancel({
          accountId: ACCOUNT_A,
          projectId: PROJECT_A,
          executionId: EXECUTION_LOCK_ORDER,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await waitForLock(observer, 'module-runtime-lock-order-cancel');

      const heartbeatOutcomePromise = heartbeat.repository
        .heartbeatLease({
          accountId: ACCOUNT_A,
          projectId: PROJECT_A,
          executionId: EXECUTION_LOCK_ORDER,
          leaseId: LEASE_LOCK_ORDER,
          runnerId: RUNNER_A,
          generation: 1,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await waitForLock(observer, 'module-runtime-lock-order-heartbeat');

      await gate`SELECT pg_advisory_unlock(${CANCEL_GATE})`;
      gateHeld = false;
      const [cancelOutcome, heartbeatOutcome] = await Promise.all([
        cancelOutcomePromise,
        heartbeatOutcomePromise,
      ]);

      expect(cancelOutcome.ok).toBe(true);
      if (!cancelOutcome.ok) throw cancelOutcome.error;
      expect(cancelOutcome.value.state).toBe('cancelled');
      expect(heartbeatOutcome.ok).toBe(false);
      if (heartbeatOutcome.ok) throw new Error('Heartbeat unexpectedly succeeded');
      expect(heartbeatOutcome.error).toMatchObject({ status: 409 });

      const persisted = dockerPsql(`
        SELECT
          execution.state,
          bool_and(lease.released_at IS NOT NULL),
          string_agg(event.event_type, ',' ORDER BY event.sequence)
        FROM kortix.module_executions AS execution
        INNER JOIN kortix.module_execution_leases AS lease
          ON lease.execution_id = execution.execution_id
        INNER JOIN kortix.module_execution_events AS event
          ON event.execution_id = execution.execution_id
        WHERE execution.execution_id = '${EXECUTION_LOCK_ORDER}'
        GROUP BY execution.execution_id, execution.state;
      `).output.trim();
      expect(persisted).toBe('cancelled|t|execution_cancelled');
    } finally {
      if (gateHeld) await gate`SELECT pg_advisory_unlock(${CANCEL_GATE})`;
      await Promise.all([
        gate.end({ timeout: 5 }),
        observer.end({ timeout: 5 }),
        cancel.client.end({ timeout: 5 }),
        heartbeat.client.end({ timeout: 5 }),
      ]);
    }
  }, CONCURRENCY_TEST_TIMEOUT);

  test('requires fenced finalize for runner terminal outcomes', () => {
    for (const outcome of ['succeeded', 'unknown', 'failed']) {
      const directTerminalUpdate = dockerPsql(
        `BEGIN;
         GRANT SELECT, UPDATE ON kortix.module_executions TO service_role;
         SET LOCAL ROLE service_role;
         UPDATE kortix.module_executions
         SET state = '${outcome}', terminal_at = now()
         WHERE execution_id = '${EXECUTION_A}';
         ROLLBACK;`,
        true,
      );
      expect(directTerminalUpdate.exitCode).not.toBe(0);
      expect(directTerminalUpdate.output).toMatch(/fenced finalize|terminal transition/i);
    }
  }, DOCKER_TEST_TIMEOUT);

  test('makes terminal rows immutable and shares outbox with terminal finalize', () => {
    const finalized = dockerPsql(`
      SELECT execution_id, state, evidence_id IS NOT NULL, outbox_id IS NOT NULL
      FROM kortix.finalize_module_execution(
        '${ACCOUNT_A}',
        '${PROJECT_A}',
        '${EXECUTION_A}',
        '${LEASE_A}',
        1,
        '${RUNNER_A}',
        'succeeded',
        '${DIGEST_B}',
        '{"outcome":"succeeded"}'::jsonb,
        'outbox-terminal-1',
        '{"usage":[{"unit":"invocation","quantity":1}]}'::jsonb
      );
    `).output.trim();

    expect(finalized).toBe(`${EXECUTION_A}|succeeded|t|t`);

    const terminal = dockerPsql(`
      SELECT
        e.state,
        (e.terminal_at IS NOT NULL),
        (SELECT count(*) FROM kortix.module_execution_evidence WHERE execution_id = e.execution_id),
        (SELECT count(*) FROM kortix.module_execution_outbox WHERE execution_id = e.execution_id),
        (SELECT released_at IS NOT NULL FROM kortix.module_execution_leases WHERE lease_id = '${LEASE_A}')
      FROM kortix.module_executions e
      WHERE e.execution_id = '${EXECUTION_A}';
    `).output.trim();
    expect(terminal).toBe('succeeded|t|1|1|t');

    const mutateExecution = dockerPsql(
      `UPDATE kortix.module_executions SET state = 'failed' WHERE execution_id = '${EXECUTION_A}';`,
      true,
    );
    expect(mutateExecution.exitCode).not.toBe(0);
    expect(mutateExecution.output).toMatch(/immutable|terminal/i);

    const mutateEvidence = dockerPsql(
      `UPDATE kortix.module_execution_evidence
       SET evidence = '{"tampered":true}'::jsonb
       WHERE execution_id = '${EXECUTION_A}';`,
      true,
    );
    expect(mutateEvidence.exitCode).not.toBe(0);
    expect(mutateEvidence.output).toMatch(/append-only|immutable/i);

    const mutateConsent = dockerPsql(
      `UPDATE kortix.project_module_consent_revisions
       SET permission_digest = '${DIGEST_B}'
       WHERE consent_revision_id = '${CONSENT_A}';`,
      true,
    );
    expect(mutateConsent.exitCode).not.toBe(0);
    expect(mutateConsent.output).toMatch(/append-only|immutable/i);

    const mutateOutbox = dockerPsql(
      `UPDATE kortix.module_execution_outbox
       SET payload = '{"tampered":true}'::jsonb
       WHERE execution_id = '${EXECUTION_A}';`,
      true,
    );
    expect(mutateOutbox.exitCode).not.toBe(0);
    expect(mutateOutbox.output).toMatch(/append-only|immutable/i);
  }, DOCKER_TEST_TIMEOUT);

  test('tenant mismatches do not disclose row existence', () => {
    const crossTenant = dockerPsql(`
      SELECT count(*) FROM kortix.module_executions
      WHERE execution_id = '${EXECUTION_A}'
        AND account_id = '${ACCOUNT_B}'
        AND project_id = '${PROJECT_A}';
    `).output.trim();
    expect(crossTenant).toBe('0');

    const claimCross = dockerPsql(
      `
        SELECT * FROM kortix.claim_module_execution(
          '${ACCOUNT_B}',
          '${PROJECT_A}',
          '${EXECUTION_A}',
          '${RUNNER_A}',
          '92000000-0000-4000-a000-000000000001',
          1,
          now() + interval '5 minutes'
        );
      `,
      true,
    );
    expect(claimCross.exitCode).not.toBe(0);
    expect(claimCross.output).not.toMatch(/permission denied|403|forbidden/i);
    expect(claimCross.output).toMatch(/not found|does not exist|no row|missing/i);

    const finalizeCross = dockerPsql(
      `
        SELECT * FROM kortix.finalize_module_execution(
          '${ACCOUNT_B}',
          '${PROJECT_A}',
          '${EXECUTION_A}',
          '${LEASE_A}',
          1,
          '${RUNNER_A}',
          'failed',
          '${DIGEST_B}',
          '{"outcome":"failed"}'::jsonb,
          'outbox-cross-1',
          '{"usage":[]}'::jsonb
        );
      `,
      true,
    );
    expect(finalizeCross.exitCode).not.toBe(0);
    expect(finalizeCross.output).not.toMatch(/permission denied|403|forbidden/i);
    expect(finalizeCross.output).toMatch(/not found|does not exist|no row|missing|lease/i);
  }, DOCKER_TEST_TIMEOUT);
});
