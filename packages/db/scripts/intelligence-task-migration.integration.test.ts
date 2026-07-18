import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { IntelligenceCreateTaskRequest } from '@kortix/api-contract';
import { sql } from 'drizzle-orm';
import {
  IntelligenceTaskService,
  createDrizzleIntelligenceTaskStore,
  intelligenceStudioIdempotencyKey,
} from '../../../apps/api/src/intelligence/task-service';
import { createDb } from '../src/client';

const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260718140000000_intelligence_task_bridge.sql',
);

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-intelligence-task-migration-${crypto.randomUUID().slice(0, 8)}`;
let mappedPostgresPort = '';

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

function rowsFromExecute(value: unknown): Record<string, unknown>[] {
  if (!value || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    return [];
  }
  return Array.from(value as Iterable<Record<string, unknown>>);
}

const ACCOUNT_A = '11000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '11000000-0000-4000-a000-000000000002';
const PROJECT_A = '12000000-0000-4000-a000-000000000001';
const PROJECT_B = '12000000-0000-4000-a000-000000000002';
const PROVIDER_A = '14000000-0000-4000-a000-000000000001';
const PROVIDER_B = '14000000-0000-4000-a000-000000000002';
const JOB_A = '16000000-0000-4000-a000-000000000001';
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
  CREATE TABLE kortix.account_tokens(token_id uuid PRIMARY KEY);
  CREATE TABLE kortix.project_sessions(session_id text PRIMARY KEY);
  CREATE TABLE kortix.studio_provider_configs(
    provider_config_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    provider text NOT NULL
  );
  CREATE TABLE kortix.studio_jobs(
    job_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    UNIQUE (account_id, idempotency_key)
  );
  INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_A}'), ('${ACCOUNT_B}');
  INSERT INTO kortix.projects(project_id, account_id)
    VALUES ('${PROJECT_A}', '${ACCOUNT_A}'), ('${PROJECT_B}', '${ACCOUNT_B}');
  INSERT INTO kortix.studio_provider_configs(provider_config_id, account_id, project_id, provider)
    VALUES
      ('${PROVIDER_A}', '${ACCOUNT_A}', '${PROJECT_A}', 'fake'),
      ('${PROVIDER_B}', '${ACCOUNT_B}', '${PROJECT_B}', 'fake');
  INSERT INTO kortix.studio_jobs(
    job_id, account_id, project_id, idempotency_key, request_hash
  ) VALUES ('${JOB_A}', '${ACCOUNT_A}', '${PROJECT_A}', 'seed-job', 'seed-request-hash');
`;

describe.skipIf(!dockerAvailable)('Intelligence task bridge migration - real PostgreSQL', () => {
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
        const mappedPort = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (mappedPort.exitCode !== 0) throw new Error(mappedPort.stderr.toString());
        const mappedPortValue = mappedPort.stdout
          .toString()
          .trim()
          .match(/:(\d+)$/)?.[1];
        if (!mappedPortValue) {
          throw new Error(`Could not resolve mapped PostgreSQL port: ${mappedPort.stdout}`);
        }
        mappedPostgresPort = mappedPortValue;
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

  test('enforces project-scoped idempotency and durable event cursors', () => {
    const taskId = '15000000-0000-4000-a000-000000000001';
    dockerPsql(`
      INSERT INTO kortix.intelligence_tasks(
        task_id, account_id, project_id, job_id, actor_type, provider_config_id,
        capability_id, capability_version, model, request_hash,
        idempotency_key, agent_card_hash
      ) VALUES (
        '${taskId}', '${ACCOUNT_A}', '${PROJECT_A}', '${JOB_A}', 'user', '${PROVIDER_A}',
        'studio.image.generate', '1.0.0', 'fake/image-v1', '${HASH_A}',
        'same-key', '${'c'.repeat(64)}'
      );
      INSERT INTO kortix.intelligence_task_events(
        task_id, sequence, studio_cursor, event_type, status
      ) VALUES ('${taskId}', 1, NULL, 'created', 'queued');
    `);

    const sameProjectMismatch = dockerPsql(
      `
      INSERT INTO kortix.intelligence_tasks(
        account_id, project_id, actor_type, provider_config_id,
        capability_id, capability_version, model, request_hash,
        idempotency_key, agent_card_hash
      ) VALUES (
        '${ACCOUNT_A}', '${PROJECT_A}', 'user', '${PROVIDER_A}',
        'studio.image.generate', '1.0.0', 'fake/image-v1', '${HASH_B}',
        'same-key', '${'d'.repeat(64)}'
      );
    `,
      true,
    );
    expect(sameProjectMismatch.exitCode).not.toBe(0);

    const crossProjectSameKey = dockerPsql(
      `
      INSERT INTO kortix.intelligence_tasks(
        account_id, project_id, actor_type, provider_config_id,
        capability_id, capability_version, model, request_hash,
        idempotency_key, agent_card_hash
      ) VALUES (
        '${ACCOUNT_B}', '${PROJECT_B}', 'user', '${PROVIDER_B}',
        'studio.image.generate', '1.0.0', 'fake/image-v1', '${HASH_B}',
        'same-key', '${'e'.repeat(64)}'
      );
    `,
      true,
    );
    expect(crossProjectSameKey.exitCode).toBe(0);

    const duplicateSequence = dockerPsql(
      `
      INSERT INTO kortix.intelligence_task_events(
        task_id, sequence, studio_cursor, event_type, status
      ) VALUES ('${taskId}', 1, 2, 'progress', 'running');
    `,
      true,
    );
    expect(duplicateSequence.exitCode).not.toBe(0);

    const duplicateStudioCursor = dockerPsql(
      `
      INSERT INTO kortix.intelligence_task_events(
        task_id, sequence, studio_cursor, event_type, status
      ) VALUES ('${taskId}', 2, 1, 'progress', 'running');
      INSERT INTO kortix.intelligence_task_events(
        task_id, sequence, studio_cursor, event_type, status
      ) VALUES ('${taskId}', 3, 1, 'progress', 'running');
    `,
      true,
    );
    expect(duplicateStudioCursor.exitCode).not.toBe(0);

    dockerPsql(`
      UPDATE kortix.intelligence_tasks
      SET studio_source_cursor = 5
      WHERE task_id = '${taskId}';
    `);
    expect(
      dockerPsql(
        `SELECT studio_source_cursor FROM kortix.intelligence_tasks WHERE task_id = '${taskId}';`,
      ).output.trim(),
    ).toBe('5');

    const invalidParent = dockerPsql(
      `
      INSERT INTO kortix.intelligence_tasks(
        account_id, project_id, actor_type, parent_task_id, provider_config_id,
        capability_id, capability_version, model, request_hash,
        idempotency_key, agent_card_hash
      ) VALUES (
        '${ACCOUNT_A}', '${PROJECT_A}', 'user',
        '15000000-0000-4000-a000-000000000099', '${PROVIDER_A}',
        'studio.image.generate', '1.0.0', 'fake/image-v1', '${HASH_A}',
        'invalid-parent', '${'f'.repeat(64)}'
      );
    `,
      true,
    );
    expect(invalidParent.exitCode).not.toBe(0);

    const deleteLinkedJob = dockerPsql(
      `DELETE FROM kortix.studio_jobs WHERE job_id = '${JOB_A}';`,
      true,
    );
    expect(deleteLinkedJob.exitCode).not.toBe(0);

    const grants = dockerPsql(`
      SELECT
        (
          SELECT count(*) = 8
          FROM information_schema.table_privileges
          WHERE table_schema = 'kortix'
            AND table_name IN ('intelligence_tasks', 'intelligence_task_events')
            AND grantee = 'service_role'
            AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        ),
        NOT EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = 'kortix'
            AND table_name IN ('intelligence_tasks', 'intelligence_task_events')
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')
        );
    `);
    expect(grants.output.trim()).toBe('t|t');
  }, 30_000);

  test('rolls back a reservation whose parent belongs to another project', async () => {
    const database = createDb(postgresUrl(), { max: 1 });
    const parentTaskId = '15000000-0000-4000-a000-000000000010';
    const parentJobId = '16000000-0000-4000-a000-000000000010';
    const idempotencyKey = 'postgres-cross-project-parent-01';
    const missingParentIdempotencyKey = 'postgres-missing-parent-01';
    dockerPsql(`
      INSERT INTO kortix.studio_jobs(
        job_id, account_id, project_id, idempotency_key, request_hash
      ) VALUES (
        '${parentJobId}', '${ACCOUNT_A}', '${PROJECT_A}',
        'postgres-parent-job-01', 'postgres-parent-job-request'
      );
      INSERT INTO kortix.intelligence_tasks(
        task_id, account_id, project_id, job_id, actor_type, provider_config_id,
        capability_id, capability_version, model, request_hash,
        idempotency_key, agent_card_hash
      ) VALUES (
        '${parentTaskId}', '${ACCOUNT_A}', '${PROJECT_A}', '${parentJobId}',
        'system', '${PROVIDER_A}', 'studio.image.generate', '1.0.0',
        'fake/image-v1', '${HASH_A}', 'postgres-parent-task-01', '${'8'.repeat(64)}'
      );
    `);
    let creatorCalls = 0;
    const service = new IntelligenceTaskService({
      store: createDrizzleIntelligenceTaskStore(database),
      createStudioJob: async () => {
        creatorCalls += 1;
        return { jobId: crypto.randomUUID(), created: true };
      },
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });
    const request = {
      protocol_version: 'intelligence.v1',
      capability_id: 'studio.image.generate',
      agent_card_hash: '7'.repeat(64),
      provider_config_id: PROVIDER_B,
      model: 'fake/image-v1',
      input: {
        capability: 'image.generate',
        image: {
          prompt: 'Cross-project parent must not reserve a task',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      },
      idempotency_key: idempotencyKey,
      parent_task_id: parentTaskId,
      deadline_at: null,
    } satisfies IntelligenceCreateTaskRequest;

    try {
      await expect(
        service.create({
          accountId: ACCOUNT_B,
          projectId: PROJECT_B,
          actorUserId: null,
          actorType: 'system',
          actingTokenId: null,
          agentName: 'postgres-integration',
          sessionId: null,
          request,
        }),
      ).rejects.toMatchObject({ code: 'INTELLIGENCE_VALIDATION_ERROR', status: 400 });
      await expect(
        service.create({
          accountId: ACCOUNT_B,
          projectId: PROJECT_B,
          actorUserId: null,
          actorType: 'system',
          actingTokenId: null,
          agentName: 'postgres-integration',
          sessionId: null,
          request: {
            ...request,
            idempotency_key: missingParentIdempotencyKey,
            parent_task_id: '15000000-0000-4000-a000-000000000099',
          },
        }),
      ).rejects.toMatchObject({ code: 'INTELLIGENCE_VALIDATION_ERROR', status: 400 });
      expect(creatorCalls).toBe(0);

      const [counts] = rowsFromExecute(
        await database.execute(sql`
          SELECT
            count(*)::integer AS task_count,
            count(event.event_id)::integer AS event_count
          FROM kortix.intelligence_tasks task
          LEFT JOIN kortix.intelligence_task_events event ON event.task_id = task.task_id
          WHERE task.project_id = ${PROJECT_B}::uuid
            AND task.idempotency_key IN (${idempotencyKey}, ${missingParentIdempotencyKey})
        `),
      );
      expect(counts).toMatchObject({ task_count: 0, event_count: 0 });
    } finally {
      await (
        database as unknown as { $client: { end(options?: unknown): Promise<void> } }
      ).$client.end({ timeout: 1 });
    }
  }, 30_000);

  test('creates exactly one Studio job for concurrent idempotent task creates', async () => {
    const databaseA = createDb(postgresUrl(), { max: 2 });
    const databaseB = createDb(postgresUrl(), { max: 2 });
    const idempotencyKey = 'postgres-intelligence-task-idempotency-01';
    const stableStudioKey = intelligenceStudioIdempotencyKey(PROJECT_A, idempotencyKey);
    const request = {
      protocol_version: 'intelligence.v1',
      capability_id: 'studio.image.generate',
      agent_card_hash: '9'.repeat(64),
      provider_config_id: PROVIDER_A,
      model: 'fake/image-v1',
      input: {
        capability: 'image.generate',
        image: {
          prompt: 'Real PostgreSQL idempotency coverage',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      },
      idempotency_key: idempotencyKey,
      parent_task_id: null,
      deadline_at: null,
    } satisfies IntelligenceCreateTaskRequest;
    let creatorCalls = 0;
    const createStudioJob: ConstructorParameters<
      typeof IntelligenceTaskService
    >[0]['createStudioJob'] = async (task) => {
      creatorCalls += 1;
      const candidateJobId = crypto.randomUUID();
      const inserted = rowsFromExecute(
        await databaseA.execute(sql`
          INSERT INTO kortix.studio_jobs(
            job_id, account_id, project_id, idempotency_key, request_hash
          ) VALUES (
            ${candidateJobId}::uuid,
            ${task.accountId}::uuid,
            ${task.projectId}::uuid,
            ${task.studioIdempotencyKey},
            ${task.studioRequestHash}
          )
          ON CONFLICT (account_id, idempotency_key) DO NOTHING
          RETURNING job_id
        `),
      );
      const [job] = rowsFromExecute(
        await databaseA.execute(sql`
          SELECT job_id
          FROM kortix.studio_jobs
          WHERE account_id = ${task.accountId}::uuid
            AND idempotency_key = ${task.studioIdempotencyKey}
        `),
      );
      if (!job?.job_id) throw new Error('Idempotent Studio job could not be reloaded');
      return { jobId: String(job.job_id), created: inserted.length === 1 };
    };
    const makeService = (database: ReturnType<typeof createDb>) =>
      new IntelligenceTaskService({
        store: createDrizzleIntelligenceTaskStore(database),
        createStudioJob,
        readStudioEvents: async () => ({ items: [], next_cursor: null }),
      });
    const input = {
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actorUserId: null,
      actorType: 'system' as const,
      actingTokenId: null,
      agentName: 'postgres-integration',
      sessionId: null,
      request,
    };

    try {
      const serviceA = makeService(databaseA);
      const serviceB = makeService(databaseB);
      const results = await Promise.all([serviceA.create(input), serviceB.create(input)]);
      expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
      expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(creatorCalls).toBeGreaterThanOrEqual(1);

      const [counts] = rowsFromExecute(
        await databaseA.execute(sql`
          SELECT
            (
              SELECT count(*)::integer
              FROM kortix.intelligence_tasks
              WHERE project_id = ${PROJECT_A}::uuid
                AND idempotency_key = ${idempotencyKey}
            ) AS task_count,
            (
              SELECT count(*)::integer
              FROM kortix.studio_jobs
              WHERE account_id = ${ACCOUNT_A}::uuid
                AND idempotency_key = ${stableStudioKey}
            ) AS job_count,
            (
              SELECT count(*)::integer
              FROM kortix.intelligence_task_events event
              JOIN kortix.intelligence_tasks task ON task.task_id = event.task_id
              WHERE task.project_id = ${PROJECT_A}::uuid
                AND task.idempotency_key = ${idempotencyKey}
                AND event.event_type = 'created'
            ) AS created_event_count
        `),
      );
      expect(counts).toMatchObject({ task_count: 1, job_count: 1, created_event_count: 1 });
      await expect(
        serviceA.events({
          accountId: ACCOUNT_B,
          projectId: PROJECT_B,
          taskId: results[0].taskId,
          cursor: null,
        }),
      ).resolves.toBeNull();
    } finally {
      await Promise.all([
        (
          databaseA as unknown as { $client: { end(options?: unknown): Promise<void> } }
        ).$client.end({ timeout: 1 }),
        (
          databaseB as unknown as { $client: { end(options?: unknown): Promise<void> } }
        ).$client.end({ timeout: 1 }),
      ]);
    }
  }, 60_000);

  test('fails closed when a task points at a cross-project Studio job', async () => {
    const database = createDb(postgresUrl(), { max: 1 });
    const taskId = '15000000-0000-4000-a000-000000000099';
    const foreignJobId = '16000000-0000-4000-a000-000000000099';
    const idempotencyKey = 'postgres-cross-project-binding-01';
    const stableStudioKey = intelligenceStudioIdempotencyKey(PROJECT_A, idempotencyKey);
    dockerPsql(`
      INSERT INTO kortix.studio_jobs(
        job_id, account_id, project_id, idempotency_key, request_hash
      ) VALUES (
        '${foreignJobId}', '${ACCOUNT_B}', '${PROJECT_B}',
        '${stableStudioKey}', '${'e'.repeat(64)}'
      );
      INSERT INTO kortix.intelligence_tasks(
        task_id, account_id, project_id, job_id, actor_type, provider_config_id,
        capability_id, capability_version, model, request_hash,
        idempotency_key, agent_card_hash
      ) VALUES (
        '${taskId}', '${ACCOUNT_A}', '${PROJECT_A}', '${foreignJobId}', 'system', '${PROVIDER_A}',
        'studio.image.generate', '1.0.0', 'fake/image-v1', '${HASH_A}',
        '${idempotencyKey}', '${'9'.repeat(64)}'
      );
    `);
    try {
      const store = createDrizzleIntelligenceTaskStore(database);
      await expect(
        store.findByIdempotency({
          accountId: ACCOUNT_A,
          projectId: PROJECT_A,
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        code: 'INTELLIGENCE_TASK_EXECUTION_FAILED',
        status: 503,
      });
    } finally {
      await (
        database as unknown as { $client: { end(options?: unknown): Promise<void> } }
      ).$client.end({ timeout: 1 });
    }
  }, 30_000);
});

describe('Intelligence task bridge migration static checks', () => {
  test('defines project-scoped task idempotency and durable event cursor constraints', async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).toMatch(/create\s+table\s+(?:if\s+not\s+exists\s+)?kortix\.intelligence_tasks/i);
    expect(sql).toMatch(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?kortix\.intelligence_task_events/i,
    );
    expect(sql).toMatch(/unique[^(]*\(\s*project_id\s*,\s*idempotency_key\s*\)/i);
    expect(sql).toMatch(/unique[^(]*\(\s*task_id\s*,\s*sequence\s*\)/i);
    expect(sql).toMatch(/studio_job_cursor|studio_cursor/i);
    expect(sql).toMatch(/studio_source_cursor/i);
    expect(sql).toMatch(/job_id[^,]*on\s+delete\s+restrict/i);
    for (const constraint of [
      'intelligence_tasks_account_id_accounts_account_id_fk',
      'intelligence_tasks_project_id_projects_project_id_fk',
      'intelligence_tasks_job_id_studio_jobs_job_id_fk',
      'intelligence_tasks_acting_token_id_account_tokens_token_id_fk',
      'intelligence_tasks_session_id_project_sessions_session_id_fk',
      'intelligence_tasks_provider_config_id_studio_provider_configs_provider_config_id_fk',
      'intelligence_tasks_parent_task_fk',
      'intelligence_task_events_task_id_intelligence_tasks_task_id_fk',
    ]) {
      expect(sql.toLowerCase()).toContain(`constraint ${constraint}`);
    }
    expect(sql).not.toMatch(/drop\s+(table|column)/i);
  });
});
