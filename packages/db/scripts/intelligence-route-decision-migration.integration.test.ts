import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const workflowMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718150000000_intelligence_workflows.sql',
);
const nodeIdempotencyMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718151000000_intelligence_workflow_node_idempotency.sql',
);
const routeMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718170000000_intelligence_route_decisions.sql',
);
const evaluationMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718160000000_intelligence_evaluations.sql',
);

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-intelligence-route-migration-${crypto.randomUUID().slice(0, 8)}`;

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

const ACCOUNT_A = '71000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '71000000-0000-4000-a000-000000000002';
const PROJECT_A = '72000000-0000-4000-a000-000000000001';
const PROJECT_B = '72000000-0000-4000-a000-000000000002';
const RUN_A = '73000000-0000-4000-a000-000000000001';
const RUN_B = '73000000-0000-4000-a000-000000000002';
const NODE_A = '74000000-0000-4000-a000-000000000001';
const NODE_B = '74000000-0000-4000-a000-000000000002';
const DECISION_A = '75000000-0000-4000-a000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;

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
  CREATE TABLE kortix.intelligence_tasks(task_id uuid PRIMARY KEY);
  CREATE TABLE kortix.review_items(review_item_id uuid PRIMARY KEY);
  INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_A}'), ('${ACCOUNT_B}');
  INSERT INTO kortix.projects(project_id, account_id)
    VALUES ('${PROJECT_A}', '${ACCOUNT_A}'), ('${PROJECT_B}', '${ACCOUNT_B}');
`;

const COMPONENTS = {
  qualityPpm: 920_000,
  availabilityPpm: 970_000,
  latencyPenaltyPpm: 150_000,
  costPenaltyPpm: 200_000,
  riskPenaltyPpm: 0,
};

function candidate(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    candidateId: HASH,
    providerDefinitionId: 'openai-compatible',
    providerConfigId: '76000000-0000-4000-a000-000000000001',
    modelId: 'images/pro-v1',
    evaluationVersion: 'image-route-eval-v1',
    scorePpm: 1_540_000,
    components: COMPONENTS,
    ...extra,
  });
}

function insertDecisionSql(input: {
  decisionId?: string;
  accountId?: string;
  projectId?: string;
  runId?: string;
  nodeId?: string;
  primary?: string;
}) {
  return `
    INSERT INTO kortix.intelligence_route_decisions(
      decision_id, account_id, project_id, run_id, node_id, request_hash,
      policy_version, policy_hash, primary_candidate, fallback_candidate,
      rejected_candidates, reason_codes, created_at
    ) VALUES (
      '${input.decisionId ?? DECISION_A}', '${input.accountId ?? ACCOUNT_A}',
      '${input.projectId ?? PROJECT_A}', '${input.runId ?? RUN_A}', '${input.nodeId ?? NODE_A}',
      '${HASH}', 'image-route-policy-v1', '${HASH}',
      '${input.primary ?? candidate()}'::jsonb, NULL, '[]'::jsonb,
      '["ROUTE_PRIMARY_SELECTED"]'::jsonb, now()
    );
  `;
}

describe.skipIf(!dockerAvailable)('Intelligence route decision migration - real PostgreSQL', () => {
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
        const workflowMigration = await Bun.file(workflowMigrationPath).text();
        const nodeIdempotencyMigration = await Bun.file(nodeIdempotencyMigrationPath).text();
        const evaluationMigration = await Bun.file(evaluationMigrationPath).text();
        const routeMigration = await Bun.file(routeMigrationPath).text();
        dockerPsql(
          `BEGIN;\n${PRE_SCHEMA}\n${workflowMigration}\n${nodeIdempotencyMigration}\n${evaluationMigration}\n${routeMigration}\nCOMMIT;`,
        );
        dockerPsql(`BEGIN;\n${routeMigration}\nCOMMIT;`);
        dockerPsql(`
          INSERT INTO kortix.intelligence_workflow_runs(
            run_id, account_id, project_id, actor_type, idempotency_key, request_hash, status
          ) VALUES
            ('${RUN_A}', '${ACCOUNT_A}', '${PROJECT_A}', 'system', 'route-run-a-0001', '${HASH}', 'running'),
            ('${RUN_B}', '${ACCOUNT_B}', '${PROJECT_B}', 'system', 'route-run-b-0001', '${HASH}', 'running');
          INSERT INTO kortix.intelligence_workflow_nodes(
            node_id, run_id, idempotency_key, request_hash, node_key, role, kind,
            capability_id, capability_version, input_hash, status
          ) VALUES
            ('${NODE_A}', '${RUN_A}', 'route-node-a-0001', '${HASH}', 'render-a', 'executor',
             'capability', 'studio.image.generate', '1.0.0', '${HASH}', 'ready'),
            ('${NODE_B}', '${RUN_B}', 'route-node-b-0001', '${HASH}', 'render-b', 'executor',
             'capability', 'studio.image.generate', '1.0.0', '${HASH}', 'ready');
          ${insertDecisionSql({})}
        `);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 120_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  }, 30_000);

  test('adds only the bounded private route decision columns', () => {
    const columns = dockerPsql(`
      SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'kortix' AND table_name = 'intelligence_route_decisions';
    `).output.trim();
    expect(columns).toBe(
      [
        'decision_id', 'account_id', 'project_id', 'run_id', 'node_id', 'protocol_version',
        'request_hash', 'policy_version', 'policy_hash', 'primary_candidate',
        'fallback_candidate', 'rejected_candidates', 'reason_codes', 'created_at',
      ].join(','),
    );
    expect(columns).not.toMatch(/prompt|url|credential|authorization|payload|raw_response/);
    expect(
      dockerPsql(`
        SELECT to_regclass(
          'kortix.idx_intelligence_model_evaluation_snapshots_project_candidate_published'
        ) IS NOT NULL;
      `).output.trim(),
    ).toBe('t');
  });

  test('enforces scope, one decision per node, and exact candidate keys', () => {
    const expectRejected = (statement: string) => {
      expect(dockerPsql(`BEGIN;\n${statement}\nROLLBACK;`, true).exitCode).not.toBe(0);
    };
    expectRejected(
      insertDecisionSql({
        decisionId: '75000000-0000-4000-a000-000000000002',
        accountId: ACCOUNT_B,
      }),
    );
    expectRejected(
      insertDecisionSql({
        decisionId: '75000000-0000-4000-a000-000000000003',
      }),
    );
    expectRejected(
      insertDecisionSql({
        decisionId: '75000000-0000-4000-a000-000000000004',
        runId: RUN_B,
        nodeId: NODE_B,
        accountId: ACCOUNT_B,
        projectId: PROJECT_B,
        primary: candidate({ providerUrl: 'https://forbidden.example' }),
      }),
    );
  });

  test('keeps decisions insert-only and grants only SELECT/INSERT to service_role', () => {
    expect(
      dockerPsql(
        `UPDATE kortix.intelligence_route_decisions SET policy_version = 'changed'
         WHERE decision_id = '${DECISION_A}';`,
        true,
      ).exitCode,
    ).not.toBe(0);
    expect(
      dockerPsql(
        `DELETE FROM kortix.intelligence_route_decisions WHERE decision_id = '${DECISION_A}';`,
        true,
      ).exitCode,
    ).not.toBe(0);

    const grants = dockerPsql(`
      SELECT
        has_table_privilege('service_role', 'kortix.intelligence_route_decisions', 'SELECT, INSERT'),
        NOT has_table_privilege('service_role', 'kortix.intelligence_route_decisions', 'UPDATE, DELETE'),
        NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'kortix'
            AND table_name = 'intelligence_route_decisions'
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')
        );
    `).output.trim();
    expect(grants).toBe('t|t|t');
  });
});
