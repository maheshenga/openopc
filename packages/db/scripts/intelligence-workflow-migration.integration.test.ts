import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718150000000_intelligence_workflows.sql',
);

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-intelligence-workflow-migration-${crypto.randomUUID().slice(0, 8)}`;

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

const ACCOUNT_ID = '21000000-0000-4000-a000-000000000001';
const ACCOUNT_B_ID = '21000000-0000-4000-a000-000000000002';
const PROJECT_ID = '22000000-0000-4000-a000-000000000001';
const PROJECT_B_ID = '22000000-0000-4000-a000-000000000002';
const JOB_ID = '23000000-0000-4000-a000-000000000001';
const TASK_ID = '24000000-0000-4000-a000-000000000001';

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
  CREATE TABLE kortix.account_tokens(token_id uuid PRIMARY KEY);
  CREATE TABLE kortix.project_sessions(session_id text PRIMARY KEY);
  CREATE TABLE kortix.studio_jobs(
    job_id uuid PRIMARY KEY,
    marker text NOT NULL
  );
  CREATE TABLE kortix.intelligence_tasks(
    task_id uuid PRIMARY KEY,
    job_id uuid REFERENCES kortix.studio_jobs(job_id),
    marker text NOT NULL
  );
  CREATE TABLE kortix.review_items(review_item_id uuid PRIMARY KEY);
  INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_ID}'), ('${ACCOUNT_B_ID}');
  INSERT INTO kortix.projects(project_id, account_id)
    VALUES ('${PROJECT_ID}', '${ACCOUNT_ID}'), ('${PROJECT_B_ID}', '${ACCOUNT_B_ID}');
  INSERT INTO kortix.studio_jobs(job_id, marker) VALUES ('${JOB_ID}', 'studio-before-workflows');
  INSERT INTO kortix.intelligence_tasks(task_id, job_id, marker)
    VALUES ('${TASK_ID}', '${JOB_ID}', 'task-before-workflows');
`;

describe.skipIf(!dockerAvailable)('Intelligence workflow migration - real PostgreSQL', () => {
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
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 120_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('applies expand-first without rewriting existing Intelligence or Studio rows', () => {
    const tables = dockerPsql(`
      SELECT string_agg(table_name, ',' ORDER BY table_name)
      FROM information_schema.tables
      WHERE table_schema = 'kortix'
        AND table_name LIKE 'intelligence_workflow_%';
    `).output.trim();
    expect(tables).toBe(
      [
        'intelligence_workflow_approvals',
        'intelligence_workflow_dependencies',
        'intelligence_workflow_events',
        'intelligence_workflow_nodes',
        'intelligence_workflow_payloads',
        'intelligence_workflow_runs',
      ].join(','),
    );

    expect(
      dockerPsql(`
        SELECT job.marker || '|' || task.marker
        FROM kortix.studio_jobs job
        JOIN kortix.intelligence_tasks task ON task.job_id = job.job_id
        WHERE job.job_id = '${JOB_ID}' AND task.task_id = '${TASK_ID}';
      `).output.trim(),
    ).toBe('studio-before-workflows|task-before-workflows');
  });

  test('rejects a workflow run whose account and project do not share a tenant identity', () => {
    const mismatchedTenant = dockerPsql(
      `
        BEGIN;
        INSERT INTO kortix.intelligence_workflow_runs(
          account_id, project_id, actor_type, idempotency_key, request_hash
        ) VALUES (
          '${ACCOUNT_ID}', '${PROJECT_B_ID}', 'system', 'workflow-cross-tenant-0001',
          'sha256:${'a'.repeat(64)}'
        );
        ROLLBACK;
      `,
      true,
    );

    expect(mismatchedTenant.exitCode).not.toBe(0);
  });

  test('enforces graph identity, leases, cursors, payload metadata, and private grants', () => {
    const runA = '25000000-0000-4000-a000-000000000001';
    const runB = '25000000-0000-4000-a000-000000000002';
    const parentA = '26000000-0000-4000-a000-000000000001';
    const childA = '26000000-0000-4000-a000-000000000002';
    const nodeB = '26000000-0000-4000-a000-000000000003';
    const hash = `sha256:${'b'.repeat(64)}`;

    dockerPsql(`
      INSERT INTO kortix.intelligence_workflow_runs(
        run_id, account_id, project_id, actor_type, idempotency_key, request_hash, status
      ) VALUES
        ('${runA}', '${ACCOUNT_ID}', '${PROJECT_ID}', 'system', 'workflow-run-a-0001', '${hash}', 'running'),
        ('${runB}', '${ACCOUNT_B_ID}', '${PROJECT_B_ID}', 'system', 'workflow-run-b-0001', '${hash}', 'running');

      INSERT INTO kortix.intelligence_workflow_nodes(
        node_id, run_id, node_key, role, kind, input_hash, status, terminal_at
      ) VALUES
        ('${parentA}', '${runA}', 'planner-root', 'planner', 'agent', '${hash}', 'succeeded', now()),
        ('${nodeB}', '${runB}', 'foreign-root', 'planner', 'agent', '${hash}', 'pending', NULL);

      INSERT INTO kortix.intelligence_workflow_nodes(
        node_id, run_id, node_key, role, kind, capability_id, capability_version,
        input_ref, input_hash, status, task_id
      ) VALUES (
        '${childA}', '${runA}', 'render-primary', 'executor', 'capability',
        'studio.image.generate', '1.0.0', 'sealed:render-primary', '${hash}', 'ready', '${TASK_ID}'
      );

      INSERT INTO kortix.intelligence_workflow_dependencies(
        run_id, node_id, depends_on_node_id, condition
      ) VALUES ('${runA}', '${childA}', '${parentA}', 'on_success');

      INSERT INTO kortix.intelligence_workflow_events(
        run_id, sequence, event_type, status, graph_version, node_id
      ) VALUES ('${runA}', 1, 'run_created', 'running', 0, NULL);

      INSERT INTO kortix.intelligence_workflow_payloads(
        run_id, node_id, purpose, payload_ref, content_hash, byte_length
      ) VALUES (
        '${runA}', '${childA}', 'node_input', 'sealed:payload-primary', '${hash}', 128
      );
    `);

    const expectRejected = (statement: string) => {
      const result = dockerPsql(`BEGIN;\n${statement}\nROLLBACK;`, true);
      expect(result.exitCode).not.toBe(0);
    };

    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_runs(
        account_id, project_id, actor_type, idempotency_key, request_hash
      ) VALUES (
        '${ACCOUNT_ID}', '${PROJECT_ID}', 'user', 'workflow-missing-actor', '${hash}'
      );
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_runs(
        account_id, project_id, actor_type, idempotency_key, request_hash
      ) VALUES (
        '${ACCOUNT_ID}', '${PROJECT_ID}', 'system', 'workflow-run-a-0001', '${hash}'
      );
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_nodes(
        run_id, node_key, role, kind, capability_id, capability_version, input_hash
      ) VALUES (
        '${runA}', 'future-video', 'executor', 'capability',
        'studio.video.generate', '1.0.0', '${hash}'
      );
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_nodes(
        run_id, node_key, role, kind, input_hash
      ) VALUES ('${runA}', 'render-primary', 'system', 'agent', '${hash}');
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_dependencies(
        run_id, node_id, depends_on_node_id, condition
      ) VALUES ('${runA}', '${childA}', '${nodeB}', 'on_success');
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_dependencies(
        run_id, node_id, depends_on_node_id, condition
      ) VALUES ('${runA}', '${childA}', '${childA}', 'on_success');
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_nodes(
        run_id, node_key, role, kind, capability_id, capability_version,
        input_hash, task_id
      ) VALUES (
        '${runA}', 'render-duplicate-task', 'executor', 'capability',
        'studio.image.generate', '1.0.0', '${hash}', '${TASK_ID}'
      );
    `);
    expectRejected(`
      UPDATE kortix.intelligence_workflow_nodes
      SET lease_owner = 'worker-1', lease_expires_at = now() + interval '1 minute'
      WHERE node_id = '${childA}';
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_events(
        run_id, sequence, event_type, status, graph_version
      ) VALUES ('${runA}', 1, 'node_ready', 'running', 0);
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_payloads(
        run_id, node_id, purpose, payload_ref, content_hash, byte_length
      ) VALUES ('${runA}', '${childA}', 'node_input', 'https://object.invalid/raw', '${hash}', 128);
    `);
    expectRejected(`
      INSERT INTO kortix.intelligence_workflow_approvals(
        run_id, node_id, risk, reason_code, action_summary, status,
        acting_user_id, decision, resolved_at
      ) VALUES (
        '${runA}', '${childA}', 'high', 'WORKFLOW_POLICY_APPROVAL_REQUIRED',
        'Approve image generation', 'pending', gen_random_uuid(), 'approve', now()
      );
    `);

    const grants = dockerPsql(`
      SELECT
        (
          SELECT count(*) = 17
          FROM information_schema.table_privileges
          WHERE table_schema = 'kortix'
            AND table_name LIKE 'intelligence_workflow_%'
            AND grantee = 'service_role'
        ),
        NOT EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = 'kortix'
            AND table_name LIKE 'intelligence_workflow_%'
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')
        ),
        NOT has_table_privilege(
          'service_role', 'kortix.intelligence_workflow_events', 'UPDATE, DELETE'
        ),
        NOT has_table_privilege(
          'service_role', 'kortix.intelligence_workflow_runs', 'DELETE'
        ),
        NOT has_table_privilege(
          'service_role', 'kortix.intelligence_workflow_dependencies', 'UPDATE, DELETE'
        );
    `);
    expect(grants.output.trim()).toBe('t|t|t|t|t');
  });
});
