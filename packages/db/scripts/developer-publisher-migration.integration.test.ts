import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const releaseMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260724120000000_developer_module_releases.sql',
);
const publisherMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260726100000000_developer_publishers.sql',
);
const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-developer-publisher-${crypto.randomUUID().slice(0, 8)}`;

const ACCOUNT_A = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '10000000-0000-4000-a000-000000000002';
const OWNER_A = '20000000-0000-4000-a000-000000000001';
const OWNER_B = '20000000-0000-4000-a000-000000000002';
const AUDIT_EVENT = '30000000-0000-4000-a000-000000000001';

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

describe.skipIf(!dockerAvailable)('developer Publisher migration - real PostgreSQL', () => {
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
        const publisherMigration = await Bun.file(publisherMigrationPath).text();
        dockerPsql(`
          CREATE ROLE anon;
          CREATE ROLE authenticated;
          CREATE ROLE service_role;
          CREATE SCHEMA kortix;
          GRANT USAGE ON SCHEMA kortix TO service_role;
          CREATE TABLE kortix.accounts(account_id uuid PRIMARY KEY);
          ${releaseMigration}
          INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_A}'), ('${ACCOUNT_B}');
          INSERT INTO kortix.developer_publishers(
            publisher_id, account_id, display_name, created_by
          ) VALUES ('acme', '${ACCOUNT_A}', 'Acme', '${OWNER_A}');
          ${publisherMigration}
          ${publisherMigration}
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

  test('applies idempotently and upgrades a legacy Publisher with organization and owner', () => {
    const upgraded = dockerPsql(`
      SELECT
        publisher.slug,
        organization.verification_state,
        (SELECT count(*)
          FROM kortix.developer_publisher_members AS member
          WHERE member.publisher_id = publisher.publisher_id AND member.role = 'owner'),
        (SELECT count(*) FROM pg_constraint
          WHERE conname = 'developer_publishers_organization_account_fk'),
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'kortix'
            AND indexname = 'idx_developer_publishers_slug_lower_unique')
      FROM kortix.developer_publishers AS publisher
      JOIN kortix.developer_organizations AS organization
        ON organization.organization_id = publisher.organization_id
        AND organization.account_id = publisher.account_id
      WHERE publisher.publisher_id = 'acme';
    `).output.trim();

    expect(upgraded).toBe('acme|verified|1|1|1');
  });

  test('rejects invitation token reuse and inconsistent acceptance metadata', () => {
    const token = 'a'.repeat(64);
    dockerPsql(`
      INSERT INTO kortix.developer_invitations(
        account_id, organization_id, email, token_hash, expires_at, created_by
      )
      SELECT
        '${ACCOUNT_A}', organization_id, 'first@example.com', '${token}',
        now() + interval '1 day', '${OWNER_A}'
      FROM kortix.developer_organizations WHERE account_id = '${ACCOUNT_A}';
    `);

    const duplicate = dockerPsql(
      `INSERT INTO kortix.developer_invitations(
        account_id, email, token_hash, expires_at, created_by
      ) VALUES (
        '${ACCOUNT_B}', 'second@example.com', '${token}', now() + interval '1 day', '${OWNER_B}'
      );`,
      true,
    );
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.output).toContain('developer_invitations_token_hash_unique');

    const inconsistent = dockerPsql(
      `UPDATE kortix.developer_invitations
       SET state = 'accepted'
       WHERE token_hash = '${token}';`,
      true,
    );
    expect(inconsistent.exitCode).not.toBe(0);
    expect(inconsistent.output).toContain('developer_invitations_state_check');
  });

  test('rejects cross-account Publisher audit references', () => {
    const rejected = dockerPsql(
      `INSERT INTO kortix.developer_publisher_audit_events(
        account_id, publisher_id, action, actor_user_id
      ) VALUES ('${ACCOUNT_B}', 'acme', 'publisher_read', '${OWNER_B}');`,
      true,
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.output).toContain('developer_publisher_audit_events_publisher_account_fk');
  });

  test('prevents removal of the sole Publisher owner', () => {
    const rejected = dockerPsql(
      `DELETE FROM kortix.developer_publisher_members
       WHERE publisher_id = 'acme' AND user_id = '${OWNER_A}';`,
      true,
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.output).toContain('developer_publishers_owner_present');

    dockerPsql(`
      INSERT INTO kortix.developer_publisher_members(
        account_id, publisher_id, user_id, role, created_by
      ) VALUES ('${ACCOUNT_A}', 'acme', '${OWNER_B}', 'owner', '${OWNER_A}');
      DELETE FROM kortix.developer_publisher_members
      WHERE publisher_id = 'acme' AND user_id = '${OWNER_A}';
    `);
    expect(
      dockerPsql(`SELECT count(*) FROM kortix.developer_publisher_members
        WHERE publisher_id = 'acme' AND role = 'owner';`).output.trim(),
    ).toBe('1');
  });

  test('makes Publisher audit rows append-only even for a database owner', () => {
    dockerPsql(`
      INSERT INTO kortix.developer_publisher_audit_events(
        event_id, account_id, publisher_id, action, actor_user_id, metadata
      ) VALUES (
        '${AUDIT_EVENT}', '${ACCOUNT_A}', 'acme', 'publisher_created', '${OWNER_A}',
        '{"source":"integration"}'::jsonb
      );
    `);

    for (const statement of [
      `UPDATE kortix.developer_publisher_audit_events
       SET metadata = '{"tampered":true}'::jsonb WHERE event_id = '${AUDIT_EVENT}';`,
      `DELETE FROM kortix.developer_publisher_audit_events WHERE event_id = '${AUDIT_EVENT}';`,
    ]) {
      const rejected = dockerPsql(statement, true);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain('append-only');
    }
  });

  test('grants service role no audit mutation privilege', () => {
    const privileges = dockerPsql(`
      SELECT
        has_table_privilege(
          'service_role', 'kortix.developer_publisher_audit_events', 'SELECT'
        ),
        has_table_privilege(
          'service_role', 'kortix.developer_publisher_audit_events', 'INSERT'
        ),
        has_table_privilege(
          'service_role', 'kortix.developer_publisher_audit_events', 'UPDATE'
        ),
        has_table_privilege(
          'service_role', 'kortix.developer_publisher_audit_events', 'DELETE'
        );
    `).output.trim();
    expect(privileges).toBe('t|t|f|f');
  });
});
