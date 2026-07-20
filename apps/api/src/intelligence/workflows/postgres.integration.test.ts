import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { resolve } from 'node:path';
import { type Database, createDb, intelligenceWorkflowPayloads } from '@kortix/db';
import {
  workflowApprovalFixture,
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import { and, eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { applyVerdict, bulkApplyVerdict } from '../../projects/review-items';
import { createWorkflowReviewProjectionStore } from '../../projects/workflow-review-projection';
import { createPostgresWorkflowPayloadRepository } from './payload-repository';
import { createPostgresWorkflowStore } from './postgres-store';
import {
  createPostgresWorkflowApprovalLookup,
  createWorkflowReviewAdapter,
} from './review-adapter';
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
  '20260719100000000_intelligence_workflow_payload_identity.sql',
  '20260720120000000_intelligence_workflow_node_budget_reservations.sql',
  '20260720130000000_intelligence_task_execution_origin.sql',
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

  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    const probe = Bun.spawnSync(
      [
        'docker',
        'exec',
        container,
        'psql',
        '-X',
        '-U',
        'postgres',
        '-d',
        'testdb',
        '-tAc',
        'SELECT 1',
      ],
      { env: dockerEnvironment, stdout: 'ignore', stderr: 'ignore' },
    );
    if (probe.exitCode === 0) {
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
    CREATE TABLE kortix.studio_jobs(
      job_id uuid PRIMARY KEY,
      reserved_credits numeric(12, 4) NOT NULL DEFAULT 0
    );
    CREATE TABLE kortix.intelligence_tasks(
      task_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      project_id uuid NOT NULL,
      job_id uuid REFERENCES kortix.studio_jobs(job_id)
    );
    CREATE TABLE kortix.review_items(
      review_item_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      project_id uuid NOT NULL,
      origin_session_id text,
      kind text NOT NULL,
      status text NOT NULL,
      risk text NOT NULL,
      source text NOT NULL,
      title text NOT NULL,
      summary text NOT NULL DEFAULT '',
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      agent text NOT NULL DEFAULT '',
      created_by uuid NOT NULL,
      acted_by uuid,
      acted_at timestamptz,
      feedback text,
      metadata jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
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
      kortix.intelligence_workflow_runs,
      kortix.review_items
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
  beforeAll(async () => {
    try {
      await startPostgres();
    } catch (error) {
      removePostgresContainer();
      throw error;
    }
  }, 210_000);
  afterAll(async () => {
    await Promise.all([
      client?.end({ timeout: 5 }),
      (
        database as unknown as { $client?: { end(options?: unknown): Promise<void> } } | null
      )?.$client?.end({ timeout: 5 }),
    ]);
    removePostgresContainer();
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

  test('persists one project-scoped node input locator for scheduler restart', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const store = createPostgresWorkflowStore(database);
    const run = workflowRunFixture({ account_id: ACCOUNT_ID, project_id: PROJECT_ID });
    const node = workflowNodeFixture({ run_id: run.run_id });
    await store.startRun({ run });
    await store.appendNode({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-postgres-payload-node-0001',
      requestHash: `sha256:${'a'.repeat(64)}`,
      node,
    });
    const repository = createPostgresWorkflowPayloadRepository(database);
    const input = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: run.run_id,
      nodeId: node.node_id,
      payload: {
        payloadRef: 'sealed:69000000-0000-4000-a000-000000000099',
        contentHash: node.input_hash,
        byteLength: 256,
        contentType: 'application/json' as const,
      },
      createdAt: '2026-07-18T10:00:01.000Z',
    };

    await expect(repository.putNodeInput(input)).resolves.toMatchObject({ created: true });
    await expect(repository.putNodeInput(input)).resolves.toMatchObject({ created: false });
    await expect(repository.getNodeInput(input)).resolves.toMatchObject({
      payloadRef: input.payload.payloadRef,
      contentHash: node.input_hash,
      purpose: 'node_input',
    });
    await expect(
      repository.getNodeInput({
        ...input,
        projectId: '64000000-0000-4000-a000-000000000099',
      }),
    ).resolves.toBeNull();
  });

  test('uses database uniqueness for concurrent node input locator writes', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const store = createPostgresWorkflowStore(database);
    const run = workflowRunFixture({ account_id: ACCOUNT_ID, project_id: PROJECT_ID });
    const node = workflowNodeFixture({ run_id: run.run_id });
    await store.startRun({ run });
    await store.appendNode({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-postgres-payload-concurrent-node-0001',
      requestHash: `sha256:${'b'.repeat(64)}`,
      node,
    });
    const [databaseA, databaseB] = createIndependentDatabases();
    try {
      const repositoryA = createPostgresWorkflowPayloadRepository(databaseA);
      const repositoryB = createPostgresWorkflowPayloadRepository(databaseB);
      const input = {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        nodeId: node.node_id,
        payload: {
          payloadRef: 'sealed:69000000-0000-4000-a000-000000000097',
          contentHash: node.input_hash,
          byteLength: 256,
          contentType: 'application/json' as const,
        },
        createdAt: '2026-07-18T10:00:01.000Z',
      };

      const [first, second] = await Promise.all([
        repositoryA.putNodeInput(input),
        repositoryB.putNodeInput({
          ...input,
          payload: {
            ...input.payload,
            payloadRef: 'sealed:69000000-0000-4000-a000-000000000098',
          },
        }),
      ]);

      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(first.record.payloadRef).toBe(second.record.payloadRef);
      const [{ count }] = await databaseA
        .select({ count: sql<number>`count(*)::int` })
        .from(intelligenceWorkflowPayloads)
        .where(
          and(
            eq(intelligenceWorkflowPayloads.runId, run.run_id),
            eq(intelligenceWorkflowPayloads.nodeId, node.node_id),
            eq(intelligenceWorkflowPayloads.purpose, 'node_input'),
          ),
        );
      expect(count).toBe(1);
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

  test('serializes cumulative budget reservations across independent database clients', async () => {
    if (!database) throw new Error('PostgreSQL workflow fixture is not ready');

    async function runScenario(leftCredits: number, rightCredits: number) {
      await resetWorkflowTables();
      const [databaseA, databaseB] = createIndependentDatabases();
      try {
        const storeA = createPostgresWorkflowStore(databaseA);
        const storeB = createPostgresWorkflowStore(databaseB);
        const run = workflowRunFixture({ max_approved_credits: 10 });
        const alpha = workflowNodeFixture({
          run_id: run.run_id,
          node_id: '62000000-0000-4000-a000-000000000011',
          node_key: 'render-alpha',
        });
        const beta = workflowNodeFixture({
          run_id: run.run_id,
          node_id: '62000000-0000-4000-a000-000000000012',
          node_key: 'render-beta',
        });
        await storeA.startRun({ run });
        await storeA.appendNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 0,
          idempotencyKey: 'workflow-node-render-alpha-budget-0001',
          requestHash: alpha.input_hash,
          node: alpha,
        });
        await storeA.appendNode({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 1,
          idempotencyKey: 'workflow-node-render-beta-budget-0001',
          requestHash: beta.input_hash,
          node: beta,
        });
        await storeA.sealGraph({
          accountId: run.account_id,
          projectId: run.project_id,
          runId: run.run_id,
          expectedGraphVersion: 2,
          updatedAt: '2026-07-18T10:01:00.000Z',
        });
        await storeA.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-a',
          now: '2026-07-18T10:02:00.000Z',
          leaseMs: 60_000,
        });
        await storeA.claimReadyNode({
          accountId: run.account_id,
          projectId: run.project_id,
          workerId: 'workflow-worker-b',
          now: '2026-07-18T10:02:00.000Z',
          leaseMs: 60_000,
        });

        return await Promise.all([
          storeA.reserveNodeBudget({
            accountId: run.account_id,
            projectId: run.project_id,
            runId: run.run_id,
            nodeId: alpha.node_id,
            workerId: 'workflow-worker-a',
            now: '2026-07-18T10:02:30.000Z',
            maxApprovedCredits: leftCredits,
          }),
          storeB.reserveNodeBudget({
            accountId: run.account_id,
            projectId: run.project_id,
            runId: run.run_id,
            nodeId: beta.node_id,
            workerId: 'workflow-worker-b',
            now: '2026-07-18T10:02:30.000Z',
            maxApprovedCredits: rightCredits,
          }),
        ]);
      } finally {
        await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
      }
    }

    const overCeiling = await runScenario(6, 6);
    expect(overCeiling.filter(Boolean)).toHaveLength(1);
    expect(overCeiling.filter((result) => result === null)).toHaveLength(1);

    const exactCeiling = await runScenario(6, 4);
    expect(exactCeiling.every(Boolean)).toBe(true);
    expect(exactCeiling.map((result) => result?.reservedCredits).sort()).toEqual([4, 6]);
    expect(exactCeiling.map((result) => result?.remainingCredits).sort()).toEqual([0, 4]);
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

  test('projects and resolves one native Review Center item across replay', async () => {
    if (!database || !client) throw new Error('PostgreSQL workflow fixture is not ready');
    await resetWorkflowTables();
    const store = createPostgresWorkflowStore(database);
    const run = workflowRunFixture({
      actor_id: '65000000-0000-4000-a000-000000000002',
      deadline_at: '2026-07-18T11:00:00.000Z',
    });
    const node = workflowNodeFixture({
      run_id: run.run_id,
      deadline_at: '2026-07-18T11:00:00.000Z',
    });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      risk: 'high',
      action_summary: 'Publish the approved campaign image',
      requested_at: '2026-07-18T10:02:30.000Z',
      review_item_id: null,
    });
    await store.startRun({ run });
    await store.appendNode({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-review-primary-0001',
      requestHash: node.input_hash,
      node,
    });
    await store.sealGraph({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 1,
      updatedAt: '2026-07-18T10:01:00.000Z',
    });
    await store.claimReadyNode({
      accountId: run.account_id,
      projectId: run.project_id,
      workerId: 'workflow-worker-review',
      now: '2026-07-18T10:02:00.000Z',
      leaseMs: 60_000,
    });
    const actions: string[] = [];
    const adapter = createWorkflowReviewAdapter({
      workflow: store,
      projection: createWorkflowReviewProjectionStore(database),
      loadApproval: createPostgresWorkflowApprovalLookup(database),
      authorize: async ({ action }) => {
        actions.push(action);
      },
      now: () => '2026-07-18T10:03:00.000Z',
    });
    const projectCommand = {
      accountId: run.account_id,
      projectId: run.project_id,
      actorUserId: run.actor_id ?? '65000000-0000-4000-a000-000000000002',
      actorType: 'agent' as const,
      actingTokenId: '68000000-0000-4000-a000-000000000001',
      workerId: 'workflow-worker-review',
      run: { ...run, status: 'running' as const },
      node: { ...node, status: 'running' as const },
      approval,
    };

    const first = await adapter.project(projectCommand);
    const replay = await adapter.project(projectCommand);
    expect(first?.projection?.reviewItemId).toBe(replay?.projection?.reviewItemId);
    const [{ count }] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM kortix.review_items
    `;
    expect(count).toBe(1);
    await expect(
      applyVerdict(
        first?.projection?.reviewItemId ?? '',
        run.project_id,
        {
          verdict: 'approve',
          actingUserId: '65000000-0000-4000-a000-000000000001',
        },
        database,
      ),
    ).resolves.toBeNull();
    await expect(
      bulkApplyVerdict(
        [first?.projection?.reviewItemId ?? ''],
        run.project_id,
        {
          verdict: 'approve',
          actingUserId: '65000000-0000-4000-a000-000000000001',
        },
        database,
      ),
    ).resolves.toEqual([]);

    const resolved = await adapter.resolve({
      reviewItemId: first?.projection?.reviewItemId ?? '',
      accountId: run.account_id,
      projectId: run.project_id,
      actorUserId: '65000000-0000-4000-a000-000000000001',
      actorType: 'user',
      actingTokenId: null,
      verdict: 'approve',
      feedback: 'Approved from Review Center',
    });

    expect(resolved?.projection.status).toBe('approved');
    const [state] = await client<
      Array<{
        run_status: string;
        approval_status: string;
        acting_user_id: string | null;
        decision: string | null;
      }>
    >`
      SELECT
        run.status AS run_status,
        approval.status AS approval_status,
        approval.acting_user_id::text,
        approval.decision
      FROM kortix.intelligence_workflow_runs AS run
      JOIN kortix.intelligence_workflow_approvals AS approval
        ON approval.run_id = run.run_id
      WHERE run.run_id = ${run.run_id}::uuid
        AND approval.approval_id = ${approval.approval_id}::uuid
    `;
    expect(state).toMatchObject({
      run_status: 'running',
      approval_status: 'approved',
      acting_user_id: '65000000-0000-4000-a000-000000000001',
      decision: 'approve',
    });
    expect(actions).toEqual([
      'project.review.submit',
      'project.review.submit',
      'project.review.act',
    ]);
  }, 60_000);
}

function removePostgresContainer(): void {
  Bun.spawnSync(['docker', 'rm', '-f', container], {
    env: dockerEnvironment,
    stdout: 'ignore',
    stderr: 'ignore',
  });
}
