import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const releaseMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260724120000000_developer_module_releases.sql',
);
const reviewMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260724150000000_developer_module_reviews.sql',
);
const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-developer-review-${crypto.randomUUID().slice(0, 8)}`;

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const ACTOR_ID = '20000000-0000-4000-a000-000000000004';

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

function releaseSeed(input?: {
  accountId?: string;
  publisherId?: string;
  releaseId?: string;
  moduleId?: string;
}) {
  const accountId = input?.accountId ?? ACCOUNT_ID;
  const publisherId = input?.publisherId ?? 'acme';
  const releaseId = input?.releaseId ?? RELEASE_ID;
  const moduleId = input?.moduleId ?? 'acme.recruiting';
  return `
    INSERT INTO kortix.accounts(account_id) VALUES ('${accountId}');
    INSERT INTO kortix.developer_publishers(
      publisher_id, account_id, display_name, created_by
    ) VALUES (
      '${publisherId}', '${accountId}', '${publisherId}', '${ACTOR_ID}'
    );
    INSERT INTO kortix.developer_module_releases(
      release_id, account_id, publisher_id, item_name, module_id, module_version,
      manifest, manifest_digest, review_requirements, created_by
    ) VALUES (
      '${releaseId}', '${accountId}', '${publisherId}', 'recruiting-workbench',
      '${moduleId}', '1.0.0',
      '{"schemaVersion":1}'::jsonb, 'sha256:${'a'.repeat(64)}',
      '["manifest_review","source_scan","human_review"]'::jsonb, '${ACTOR_ID}'
    );
  `;
}

describe.skipIf(!dockerAvailable)('developer module review migration - real PostgreSQL', () => {
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
      if (dockerPsql('SELECT 1;', true).exitCode === 0) {
        const releaseMigration = await Bun.file(releaseMigrationPath).text();
        const reviewMigration = await Bun.file(reviewMigrationPath).text();
        dockerPsql(`
          CREATE ROLE anon;
          CREATE ROLE authenticated;
          CREATE ROLE service_role;
          CREATE SCHEMA kortix;
          GRANT USAGE ON SCHEMA kortix TO service_role;
          CREATE TABLE kortix.accounts(account_id uuid PRIMARY KEY);
          ${releaseMigration}
          ${reviewMigration}
          ${reviewMigration}
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

  test('applies idempotently with revision, tenant identity, queue, and event constraints', () => {
    const shape = dockerPsql(`
      SELECT
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'kortix'
            AND table_name = 'developer_module_releases'
            AND column_name = 'review_revision'),
        (SELECT count(*) FROM pg_constraint
          WHERE conname = 'developer_module_releases_release_account_unique'),
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'kortix'
            AND indexname = 'idx_developer_module_releases_review_queue'),
        (SELECT count(*) FROM pg_constraint
          WHERE conname = 'developer_module_release_review_events_release_account_fk'),
        (SELECT count(*) FROM pg_constraint
          WHERE conname = 'developer_module_release_review_events_transition_check');
    `).output.trim();
    expect(shape).toBe('1|1|1|1|1');
  });

  test('grants only the review operations required by the service role', () => {
    const privileges = dockerPsql(`
      SELECT
        has_column_privilege('service_role', 'kortix.developer_module_releases', 'status', 'UPDATE'),
        has_column_privilege('service_role', 'kortix.developer_module_releases', 'review_revision', 'UPDATE'),
        has_column_privilege('service_role', 'kortix.developer_module_releases', 'manifest', 'UPDATE'),
        has_table_privilege('service_role', 'kortix.developer_module_release_review_events', 'SELECT'),
        has_table_privilege('service_role', 'kortix.developer_module_release_review_events', 'INSERT'),
        has_table_privilege('service_role', 'kortix.developer_module_release_review_events', 'UPDATE'),
        has_table_privilege('service_role', 'kortix.developer_module_release_review_events', 'DELETE');
    `).output.trim();
    expect(privileges).toBe('t|t|f|t|t|f|f');
  });

  test('commits one legal transition and fences a stale competing revision', () => {
    dockerPsql(releaseSeed());
    const result = dockerPsql(`
      SET ROLE service_role;
      BEGIN;
      WITH transitioned AS (
        UPDATE kortix.developer_module_releases
        SET status = 'review_pending', review_revision = review_revision + 1
        WHERE release_id = '${RELEASE_ID}'
          AND account_id = '${ACCOUNT_ID}'
          AND status = 'validated'
          AND review_revision = 0
        RETURNING release_id, account_id, review_revision
      )
      INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, reason, evidence
      )
      SELECT
        release_id, account_id, review_revision, 'submit', 'validated', 'review_pending',
        '${ACTOR_ID}', 'publisher', 'Ready for review', '[]'::jsonb
      FROM transitioned;
      COMMIT;
      RESET ROLE;

      WITH stale AS (
        UPDATE kortix.developer_module_releases
        SET status = 'changes_requested', review_revision = review_revision + 1
        WHERE release_id = '${RELEASE_ID}'
          AND account_id = '${ACCOUNT_ID}'
          AND status = 'validated'
          AND review_revision = 0
        RETURNING 1
      )
      SELECT
        (SELECT status || ':' || review_revision::text
          FROM kortix.developer_module_releases WHERE release_id = '${RELEASE_ID}'),
        (SELECT count(*) FROM kortix.developer_module_release_review_events
          WHERE release_id = '${RELEASE_ID}'),
        (SELECT count(*) FROM stale);
    `).output.trim();
    expect(result).toContain('review_pending:1|1|0');
  });

  test('rejects invalid sequence, transition, reason, evidence, and event replay', () => {
    const invalidStatements = [
      `INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, evidence
      ) VALUES (
        '${RELEASE_ID}', '${ACCOUNT_ID}', 0, 'submit', 'validated', 'review_pending',
        '${ACTOR_ID}', 'publisher', '[]'::jsonb
      );`,
      `INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, evidence
      ) VALUES (
        '${RELEASE_ID}', '${ACCOUNT_ID}', 2, 'approve', 'validated', 'approved',
        '${ACTOR_ID}', 'platform_admin', '[{},{}]'::jsonb
      );`,
      `INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, evidence
      ) VALUES (
        '${RELEASE_ID}', '${ACCOUNT_ID}', 2, 'request_changes', 'review_pending',
        'changes_requested', '${ACTOR_ID}', 'platform_admin', '[]'::jsonb
      );`,
      `INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, evidence
      ) VALUES (
        '${RELEASE_ID}', '${ACCOUNT_ID}', 2, 'submit', 'validated', 'review_pending',
        '${ACTOR_ID}', 'publisher', '[{}]'::jsonb
      );`,
      `INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, evidence
      ) VALUES (
        '${RELEASE_ID}', '${ACCOUNT_ID}', 2, 'approve', 'review_pending', 'approved',
        '${ACTOR_ID}', 'platform_admin',
        jsonb_build_array(jsonb_build_object('blob', repeat('x', 40000)), '{}'::jsonb)
      );`,
      `INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, reason, evidence
      ) VALUES (
        '${RELEASE_ID}', '${ACCOUNT_ID}', 1, 'submit', 'validated', 'review_pending',
        '${ACTOR_ID}', 'publisher', 'Replay', '[]'::jsonb
      );`,
    ];

    for (const statement of invalidStatements) {
      const rejected = dockerPsql(statement, true);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toMatch(/developer_module_release_review_events_/);
    }
  });

  test('prevents service-role release-content and event mutation', () => {
    const releaseMutation = dockerPsql(
      `SET ROLE service_role;
       UPDATE kortix.developer_module_releases
       SET manifest = '{"tampered":true}'::jsonb
       WHERE release_id = '${RELEASE_ID}';`,
      true,
    );
    expect(releaseMutation.exitCode).not.toBe(0);

    for (const statement of [
      `UPDATE kortix.developer_module_release_review_events SET reason = 'tampered'
        WHERE release_id = '${RELEASE_ID}';`,
      `DELETE FROM kortix.developer_module_release_review_events
        WHERE release_id = '${RELEASE_ID}';`,
    ]) {
      const rejected = dockerPsql(`SET ROLE service_role; ${statement}`, true);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain('permission denied');
    }
  });

  test('preserves the existing account deletion cascade', () => {
    const secondAccount = '10000000-0000-4000-a000-000000000099';
    const secondRelease = '30000000-0000-4000-a000-000000000099';
    dockerPsql(`
      ${releaseSeed({
        accountId: secondAccount,
        publisherId: 'beta',
        releaseId: secondRelease,
        moduleId: 'beta.recruiting',
      })}
      UPDATE kortix.developer_module_releases
      SET status = 'review_pending', review_revision = 1
      WHERE release_id = '${secondRelease}';
      INSERT INTO kortix.developer_module_release_review_events(
        release_id, account_id, sequence, action, from_status, to_status,
        actor_user_id, actor_kind, evidence
      ) VALUES (
        '${secondRelease}', '${secondAccount}', 1, 'submit', 'validated', 'review_pending',
        '${ACTOR_ID}', 'publisher', '[]'::jsonb
      );
      DELETE FROM kortix.accounts WHERE account_id = '${secondAccount}';
    `);
    const remaining = dockerPsql(`
      SELECT
        (SELECT count(*) FROM kortix.developer_publishers WHERE account_id = '${secondAccount}'),
        (SELECT count(*) FROM kortix.developer_module_releases WHERE account_id = '${secondAccount}'),
        (SELECT count(*) FROM kortix.developer_module_release_review_events
          WHERE account_id = '${secondAccount}');
    `).output.trim();
    expect(remaining).toBe('0|0|0');
  });
});
