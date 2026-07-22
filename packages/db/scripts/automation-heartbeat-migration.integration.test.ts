import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260722100000000_automation_heartbeat_durability.sql',
);
const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-automation-heartbeat-${crypto.randomUUID().slice(0, 8)}`;

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

describe.skipIf(!dockerAvailable)('Automation heartbeat migration - real PostgreSQL', () => {
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
      const ready = Bun.spawnSync(
        ['docker', 'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'testdb'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (initComplete && ready.exitCode === 0) {
        const migration = await Bun.file(migrationPath).text();
        dockerPsql(`
          CREATE SCHEMA kortix;
          CREATE TABLE kortix.automation_job_events(
            event_id uuid PRIMARY KEY,
            job_id uuid NOT NULL,
            sequence bigint NOT NULL
          );
          ${migration}
          ${migration}
        `);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 120_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('applies idempotently with the three receipt columns and replay index', () => {
    const shape = dockerPsql(`
      SELECT
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'kortix'
            AND table_name = 'automation_job_events'
            AND column_name IN ('worker_id', 'worker_lease_id', 'worker_ordinal')),
        (SELECT count(*) FROM pg_constraint
          WHERE conname = 'automation_job_events_worker_receipt_check'),
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'kortix'
            AND indexname = 'idx_automation_job_events_worker_ordinal_unique');
    `).output.trim();

    expect(shape).toBe('3|1|1');
  });

  test('accepts only fully absent or fully valid worker receipts', () => {
    const jobId = '30000000-0000-4000-a000-000000000001';
    const leaseId = '40000000-0000-4000-a000-000000000001';
    dockerPsql(`
      INSERT INTO kortix.automation_job_events(event_id, job_id, sequence)
      VALUES ('50000000-0000-4000-a000-000000000001', '${jobId}', 1);
      INSERT INTO kortix.automation_job_events(
        event_id, job_id, sequence, worker_id, worker_lease_id, worker_ordinal
      ) VALUES (
        '50000000-0000-4000-a000-000000000002', '${jobId}', 2,
        'browser-worker-1', '${leaseId}', 1
      );
    `);

    const partialReceipts = [
      "'browser-worker-1', NULL, NULL",
      `'browser-worker-1', '${leaseId}', NULL`,
      `NULL, '${leaseId}', 2`,
      "'browser-worker-1', NULL, 2",
    ];
    for (const [index, values] of partialReceipts.entries()) {
      const rejected = dockerPsql(
        `
          INSERT INTO kortix.automation_job_events(
            event_id, job_id, sequence, worker_id, worker_lease_id, worker_ordinal
          ) VALUES (
            '50000000-0000-4000-a000-00000000000${index + 3}', '${jobId}', ${index + 3},
            ${values}
          );
        `,
        true,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain('automation_job_events_worker_receipt_check');
    }
  });

  test('rejects an exact lease-scoped ordinal replay', () => {
    const replay = dockerPsql(
      `
        INSERT INTO kortix.automation_job_events(
          event_id, job_id, sequence, worker_id, worker_lease_id, worker_ordinal
        ) VALUES (
          '50000000-0000-4000-a000-000000000099',
          '30000000-0000-4000-a000-000000000001', 99,
          'browser-worker-1', '40000000-0000-4000-a000-000000000001', 1
        );
      `,
      true,
    );

    expect(replay.exitCode).not.toBe(0);
    expect(replay.output).toContain('idx_automation_job_events_worker_ordinal_unique');
  });
});
