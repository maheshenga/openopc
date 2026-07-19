import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { resolve } from 'node:path';
import { type Database, createDb } from '@kortix/db';
import {
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { createPostgresWorkflowStore } from './postgres-store';
import { createWorkflowScheduler } from './scheduler';
import { runWorkflowStoreConformance } from './store-conformance.test';
import type { WorkflowImageTaskBridge } from './task-bridge';

const dockerEnvironment = { ...process.env };
delete dockerEnvironment.DOCKER_HOST;
const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  Bun.spawnSync(['docker', 'version'], {
    env: dockerEnvironment,
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;
const container = `kortix-workflow-store-${crypto.randomUUID().slice(0, 8)}`;
const migrationPaths = [
  '20260718150000000_intelligence_workflows.sql',
  '20260718151000000_intelligence_workflow_node_idempotency.sql',
].map((name) => resolve(import.meta.dir, '../../../../../packages/db/migrations', name));

const ACCOUNT_ID = '63000000-0000-4000-a000-000000000001';
const PROJECT_ID = '64000000-0000-4000-a000-000000000001';
const TASK_ID = '69000000-0000-4000-a000-000000000001';
const TASK_ID_2 = '69000000-0000-4000-a000-000000000002';

let client: Sql | null = null;
let database: Database | null = null;
let databaseUrl: string | null = null;

function dockerPsql(statement: string): void {
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
    ],
    {
      env: dockerEnvironment,
      stdin: Buffer.from(statement),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`${result.stdout.toString()}${result.stderr.toString()}`);
  }
}

async function startPostgres(): Promise<void> {
  const started = Bun.spawnSync(
    [
      'docker',
      'run',
      '--rm',
      '-d',
      '-p',
      '5432',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ],
    { env: dockerEnvironment, stdout: 'pipe', stderr: 'pipe' },
  );
  if (started.exitCode !== 0) throw new Error(started.stderr.toString());

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    const logs = Bun.spawnSync(['docker', 'logs', container], {
      env: dockerEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const initialized = `${logs.stdout.toString()}${logs.stderr.toString()}`.includes(
      'PostgreSQL init process complete; ready for start up.',
    );
    const probe = Bun.spawnSync(
      ['docker', 'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'testdb'],
      { env: dockerEnvironment, stdout: 'ignore', stderr: 'ignore' },
    );
    if (initialized && probe.exitCode === 0) {
      ready = true;
      break;
    }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

  const portResult = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
    env: dockerEnvironment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const port = /:(\d+)\s*$/m.exec(portResult.stdout.toString())?.[1];
  if (!port) throw new Error(`Could not resolve PostgreSQL port: ${portResult.stderr.toString()}`);

  const schema = `
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
    CREATE TABLE kortix.studio_jobs(job_id uuid PRIMARY KEY);
    CREATE TABLE kortix.intelligence_tasks(
      task_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      project_id uuid NOT NULL,
      job_id uuid REFERENCES kortix.studio_jobs(job_id)
    );
    CREATE TABLE kortix.review_items(review_item_id uuid PRIMARY KEY);
    INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_ID}');
    INSERT INTO kortix.projects(project_id, account_id) VALUES ('${PROJECT_ID}', '${ACCOUNT_ID}');
    INSERT INTO kortix.intelligence_tasks(task_id, account_id, project_id)
      VALUES
        ('${TASK_ID}', '${ACCOUNT_ID}', '${PROJECT_ID}'),
        ('${TASK_ID_2}', '${ACCOUNT_ID}', '${PROJECT_ID}');
  `;
  const migrations = await Promise.all(migrationPaths.map((path) => Bun.file(path).text()));
  dockerPsql(`BEGIN;\n${schema}\n${migrations.join('\n')}\nCOMMIT;`);

  databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/testdb`;
  client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });
  database = createDb(databaseUrl, { max: 1, onnotice: () => undefined });
  await database.execute(sql`SELECT 1`);
}

async function resetWorkflowTables(): Promise<void> {
  if (!client) throw new Error('PostgreSQL workflow fixture is not ready');
  await client.unsafe(`
    TRUNCATE TABLE
      kortix.intelligence_workflow_events,
      kortix.intelligence_workflow_approvals,
      kortix.intelligence_workflow_dependencies,
      kortix.intelligence_workflow_payloads,
      kortix.intelligence_workflow_nodes,
      kortix.intelligence_workflow_runs
  `);
}

async function closeDatabase(databaseClient: Database): Promise<void> {
  await (
    databaseClient as unknown as { $client?: { end(options?: unknown): Promise<void> } }
  ).$client?.end({ timeout: 5 });
}

function createIndependentDatabases(): [Database, Database] {
  if (!databaseUrl) throw new Error('PostgreSQL workflow fixture is not ready');
  return [
    createDb(databaseUrl, { max: 1, onnotice: () => undefined }),
    createDb(databaseUrl, { max: 1, onnotice: () => undefined }),
  ];
}

if (enabled) {
  setDefaultTimeout(30_000);
  beforeAll(startPostgres, 120_000);
  afterAll(async () => {
    await Promise.all([
      client?.end({ timeout: 5 }),
      (
        database as unknown as { $client?: { end(options?: unknown): Promise<void> } } | null
      )?.$client?.end({ timeout: 5 }),
    ]);
    Bun.spawnSync(['docker', 'rm', '-f', container], {
      env: dockerEnvironment,
      stdout: 'ignore',
      stderr: 'ignore',
    });
  });

  runWorkflowStoreConformance('PostgreSQL', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    return createPostgresWorkflowStore(database);
  });

  test('uses database uniqueness for concurrent project-scoped run creation', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const [databaseA, databaseB] = createIndependentDatabases();
    try {
      const run = workflowRunFixture();
      const [first, second] = await Promise.all([
        createPostgresWorkflowStore(databaseA).startRun({ run }),
        createPostgresWorkflowStore(databaseB).startRun({ run }),
      ]);
      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(first.run).toEqual(run);
      expect(second.run).toEqual(run);
      const page = await createPostgresWorkflowStore(databaseA).readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 100,
      });
      expect(page.items.map((event) => event.type)).toEqual(['run_created']);
    } finally {
      await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
    }
  });

  test('serializes concurrent graph mutation through the locked run row', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const [databaseA, databaseB] = createIndependentDatabases();
    try {
      const storeA = createPostgresWorkflowStore(databaseA);
      const storeB = createPostgresWorkflowStore(databaseB);
      const run = workflowRunFixture();
      await storeA.startRun({ run });
      const nodeA = workflowNodeFixture({
        run_id: run.run_id,
        node_id: '62000000-0000-4000-a000-000000000011',
        node_key: 'render-alpha',
      });
      const nodeB = workflowNodeFixture({
        run_id: run.run_id,
        node_id: '62000000-0000-4000-a000-000000000012',
        node_key: 'render-beta',
      });
      const [left, right] = await Promise.allSettled([
        storeA.appendNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 0,
          idempotencyKey: 'workflow-node-render-alpha-0001',
          requestHash: nodeA.input_hash,
          node: nodeA,
        }),
        storeB.appendNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 0,
          idempotencyKey: 'workflow-node-render-beta-0001',
          requestHash: nodeB.input_hash,
          node: nodeB,
        }),
      ]);
      const fulfilled = [left, right].filter((result) => result.status === 'fulfilled');
      const rejected = [left, right].filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: 'WORKFLOW_GRAPH_VERSION_CONFLICT' });
      await expect(
        storeA.getRun({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
        }),
      ).resolves.toMatchObject({ graph_version: 1 });
    } finally {
      await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
    }
  });

  test('claims one ready node across independent database clients', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const [databaseA, databaseB] = createIndependentDatabases();
    try {
      const storeA = createPostgresWorkflowStore(databaseA);
      const storeB = createPostgresWorkflowStore(databaseB);
      const run = workflowRunFixture();
      const node = workflowNodeFixture({ run_id: run.run_id });
      await storeA.startRun({ run });
      await storeA.appendNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        requestHash: node.input_hash,
        node,
      });
      await storeA.sealGraph({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 1,
        updatedAt: '2026-07-18T10:01:00.000Z',
      });
      const [left, right] = await Promise.all([
        storeA.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-a',
          now: '2026-07-18T10:02:00.000Z',
          leaseMs: 60_000,
        }),
        storeB.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:02:00.000Z',
          leaseMs: 60_000,
        }),
      ]);
      expect([left, right].filter(Boolean)).toHaveLength(1);
      expect([left, right].filter((claim) => claim === null)).toHaveLength(1);
    } finally {
      await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
    }
  });

  test('keeps concurrent task attachment immutable across database clients', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const [databaseA, databaseB] = createIndependentDatabases();
    try {
      const storeA = createPostgresWorkflowStore(databaseA);
      const storeB = createPostgresWorkflowStore(databaseB);
      const run = workflowRunFixture();
      const node = workflowNodeFixture({ run_id: run.run_id });
      await storeA.startRun({ run });
      await storeA.appendNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        requestHash: node.input_hash,
        node,
      });
      await storeA.sealGraph({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 1,
        updatedAt: '2026-07-18T10:01:00.000Z',
      });
      await storeA.claimReadyNode({
        accountId: run.account_id,
        projectId: run.project_id,
        workerId: 'workflow-worker-a',
        now: '2026-07-18T10:02:00.000Z',
        leaseMs: 60_000,
      });
      const [left, right] = await Promise.allSettled([
        storeA.attachTask({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: node.node_id,
          workerId: 'workflow-worker-a',
          taskId: TASK_ID,
          updatedAt: '2026-07-18T10:02:30.000Z',
        }),
        storeB.attachTask({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          nodeId: node.node_id,
          workerId: 'workflow-worker-b',
          taskId: TASK_ID_2,
          updatedAt: '2026-07-18T10:02:30.000Z',
        }),
      ]);
      expect([left, right].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = [left, right].filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: 'WORKFLOW_TASK_ATTACHMENT_CONFLICT' });
    } finally {
      await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
    }
  });

  test('recovers one task across lease loss and scheduler process restarts', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const [databaseA, databaseB] = createIndependentDatabases();
    const databaseC = createDb(databaseUrl ?? '', { max: 1, onnotice: () => undefined });
    try {
      const storeA = createPostgresWorkflowStore(databaseA);
      const storeB = createPostgresWorkflowStore(databaseB);
      const storeC = createPostgresWorkflowStore(databaseC);
      const run = workflowRunFixture({
        deadline_at: '2026-07-18T11:00:00.000Z',
      });
      const node = workflowNodeFixture({
        run_id: run.run_id,
        deadline_at: '2026-07-18T11:00:00.000Z',
      });
      await storeA.startRun({ run });
      await storeA.appendNode({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-restart-primary-0001',
        requestHash: node.input_hash,
        node,
      });
      await storeA.sealGraph({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 1,
        updatedAt: '2026-07-18T10:01:00.000Z',
      });

      let taskExists = false;
      let taskSubmissions = 0;
      let taskRequests = 0;
      let reconciliations = 0;
      const bridge: WorkflowImageTaskBridge = {
        createOrReplay: async () => {
          taskRequests += 1;
          const created = !taskExists;
          if (created) {
            taskExists = true;
            taskSubmissions += 1;
          }
          return { taskId: TASK_ID, jobId: '66000000-0000-4000-a000-000000000001', created };
        },
        reconcile: async () => {
          reconciliations += 1;
          if (reconciliations === 1) throw new Error('simulated scheduler process crash');
          return { status: 'succeeded', assetIds: [], reasonCode: null };
        },
      };
      const common = {
        bridge,
        isReady: async () => true,
        listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
        authorizeNode: async () => ({
          actingTokenId: null,
          sessionId: null,
          parentTaskId: null,
        }),
        readNodeRequest: async () => ({ capability: 'image.generate' }),
        leaseMs: 1_000,
        maxClaimsPerRun: 1,
      };

      let schedulerANowCalls = 0;
      const schedulerA = createWorkflowScheduler({
        ...common,
        workflow: storeA,
        workerId: 'workflow-worker-a',
        now: () => {
          schedulerANowCalls += 1;
          return schedulerANowCalls < 6 ? '2026-07-18T10:02:00.000Z' : '2026-07-18T10:04:00.000Z';
        },
      });
      await expect(schedulerA.runOnce()).resolves.toMatchObject({
        claimed: 1,
        attached: 0,
        leaseLost: 1,
      });

      const schedulerB = createWorkflowScheduler({
        ...common,
        workflow: storeB,
        workerId: 'workflow-worker-b',
        now: () => '2026-07-18T10:04:00.000Z',
      });
      await expect(schedulerB.runOnce()).rejects.toThrow('simulated scheduler process crash');

      const schedulerC = createWorkflowScheduler({
        ...common,
        workflow: storeC,
        workerId: 'workflow-worker-c',
        now: () => '2026-07-18T10:06:00.000Z',
      });
      await expect(schedulerC.runOnce()).resolves.toMatchObject({
        claimed: 1,
        attached: 0,
        completed: 1,
        leaseLost: 0,
      });

      await expect(
        storeC.getRun({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
        }),
      ).resolves.toMatchObject({ status: 'succeeded' });
      const events = await storeC.readEvents({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        afterSequence: 0,
        limit: 100,
      });
      expect(events.items.filter((event) => event.type === 'task_attached')).toHaveLength(1);
      expect({ taskRequests, taskSubmissions, reconciliations }).toEqual({
        taskRequests: 2,
        taskSubmissions: 1,
        reconciliations: 2,
      });
    } finally {
      await Promise.all([
        closeDatabase(databaseA),
        closeDatabase(databaseB),
        closeDatabase(databaseC),
      ]);
    }
  });
}
