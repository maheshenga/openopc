import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const registrationMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260728090000000_public_registration_guards.sql',
);
const identityMigrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260728100000000_public_beta_identity_requests.sql',
);
const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `openopc-public-beta-identity-${crypto.randomUUID().slice(0, 8)}`;

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORGANIZATION_A = '33333333-3333-4333-8333-333333333333';
const INSTALLATION_A = '44444444-4444-4444-8444-444444444444';
const DECISION_HASH = `sha256:${'a'.repeat(64)}`;
const CONFLICT_DECISION_HASH = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-07-28T12:00:00.000Z';

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

function authorizeDecisionSql(decisionHash = DECISION_HASH): string {
  return `SELECT kortix.authorize_public_registration_decision(
    '[
      {"kind":"ip","keyHash":"sha256:${'1'.repeat(64)}","limit":10,"windowSeconds":300},
      {"kind":"device","keyHash":"sha256:${'2'.repeat(64)}","limit":10,"windowSeconds":300},
      {"kind":"email","keyHash":"sha256:${'3'.repeat(64)}","limit":10,"windowSeconds":300},
      {"kind":"account","keyHash":"sha256:${'4'.repeat(64)}","limit":10,"windowSeconds":300},
      {"kind":"action","keyHash":"sha256:${'5'.repeat(64)}","limit":10,"windowSeconds":300}
    ]'::jsonb,
    true,
    '${decisionHash}',
    'sha256:${'6'.repeat(64)}',
    'sha256:${'7'.repeat(64)}',
    'sha256:${'8'.repeat(64)}',
    'signup',
    '{"terms":"2026-07-28","privacy":"2026-07-28","acceptableUse":"2026-07-28"}'::jsonb,
    '${NOW}'::timestamptz,
    ('${NOW}'::timestamptz + interval '5 minutes')
  );`;
}

describe.skipIf(!dockerAvailable)('public beta identity migration - real PostgreSQL', () => {
  beforeAll(async () => {
    const registrationMigration = await Bun.file(registrationMigrationPath).text();
    const identityMigration = await Bun.file(identityMigrationPath).text();
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

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (dockerPsql('SELECT 1;', true).exitCode === 0) {
        dockerPsql(`
          CREATE ROLE anon;
          CREATE ROLE authenticated;
          CREATE ROLE service_role;
          CREATE SCHEMA kortix;
          CREATE TABLE kortix.accounts (
            account_id uuid PRIMARY KEY,
            name text NOT NULL
          );
          CREATE TABLE kortix.account_members (
            user_id uuid NOT NULL,
            account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, account_id)
          );
          CREATE TABLE kortix.developer_organizations (
            organization_id uuid PRIMARY KEY,
            account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
            CONSTRAINT developer_organizations_organization_account_unique
              UNIQUE (organization_id, account_id),
            CONSTRAINT developer_organizations_account_unique UNIQUE (account_id)
          );
          CREATE TABLE kortix.project_module_installations (
            installation_id uuid PRIMARY KEY,
            account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE
          );
          ${registrationMigration}
          ${identityMigration}
          ${identityMigration}
          INSERT INTO kortix.accounts(account_id, name) VALUES
            ('${ACCOUNT_A}', 'Account A'),
            ('${ACCOUNT_B}', 'Account B');
          INSERT INTO kortix.account_members(user_id, account_id) VALUES
            ('${USER_A}', '${ACCOUNT_A}'),
            ('${USER_B}', '${ACCOUNT_B}');
          INSERT INTO kortix.developer_organizations(organization_id, account_id)
            VALUES ('${ORGANIZATION_A}', '${ACCOUNT_A}');
          INSERT INTO kortix.project_module_installations(installation_id, account_id)
            VALUES ('${INSTALLATION_A}', '${ACCOUNT_A}');
        `);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 240_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  }, 60_000);

  test('applies idempotently with least-privilege service-role access', () => {
    const result = dockerPsql(`
        SELECT
          to_regclass('kortix.policy_acceptances') IS NOT NULL,
          to_regclass('kortix.account_requests') IS NOT NULL,
          to_regclass('kortix.developer_applications') IS NOT NULL,
          has_function_privilege(
            'service_role',
            'kortix.complete_public_registration_decision(character varying,timestamp with time zone,uuid,uuid)',
            'EXECUTE'
          ),
          has_table_privilege('service_role', 'kortix.policy_acceptances', 'UPDATE'),
          has_table_privilege('service_role', 'kortix.account_requests', 'DELETE'),
          has_column_privilege('service_role', 'kortix.account_requests', 'status', 'UPDATE'),
          has_column_privilege('service_role', 'kortix.account_requests', 'account_id', 'UPDATE');
      `).output.trim();
    expect(result).toBe('t|t|t|t|f|f|t|f');
  }, 60_000);

  test('completes one decision atomically and only retries for the same verified subject', () => {
    expect(dockerPsql(authorizeDecisionSql()).output.trim()).toBe('t');
    const first = dockerPsql(`
        SELECT kortix.complete_public_registration_decision(
          '${DECISION_HASH}', '${NOW}'::timestamptz, '${ACCOUNT_A}', '${USER_A}'
        );
      `).output.trim();
    const retry = dockerPsql(`
        SELECT kortix.complete_public_registration_decision(
          '${DECISION_HASH}', '${NOW}'::timestamptz, '${ACCOUNT_A}', '${USER_A}'
        );
      `).output.trim();
    const foreignReplay = dockerPsql(`
        SELECT kortix.complete_public_registration_decision(
          '${DECISION_HASH}', '${NOW}'::timestamptz, '${ACCOUNT_B}', '${USER_B}'
        );
      `).output.trim();
    expect(`${first}|${retry}|${foreignReplay}`).toBe('t|t|f');
    expect(
      dockerPsql(`
          SELECT count(*), string_agg(policy::text, ',' ORDER BY policy::text)
          FROM kortix.policy_acceptances
          WHERE registration_decision_jti_hash = '${DECISION_HASH}';
        `).output.trim(),
    ).toBe('3|acceptable_use,privacy,terms');

    for (const statement of [
      `UPDATE kortix.policy_acceptances SET version = 'changed' WHERE registration_decision_jti_hash = '${DECISION_HASH}';`,
      `DELETE FROM kortix.policy_acceptances WHERE registration_decision_jti_hash = '${DECISION_HASH}';`,
    ]) {
      const rejected = dockerPsql(statement, true);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain('policy acceptances are append-only');
    }

    expect(dockerPsql(authorizeDecisionSql(CONFLICT_DECISION_HASH)).output.trim()).toBe('t');
    const conflictingAcceptance = dockerPsql(
      `SELECT kortix.complete_public_registration_decision(
          '${CONFLICT_DECISION_HASH}', '${NOW}'::timestamptz, '${ACCOUNT_A}', '${USER_A}'
        );`,
      true,
    );
    expect(conflictingAcceptance.exitCode).not.toBe(0);
    expect(
      dockerPsql(`
          SELECT registration.consumed_at IS NULL, count(acceptance.acceptance_id)
          FROM kortix.public_registration_decisions AS registration
          LEFT JOIN kortix.policy_acceptances AS acceptance
            ON acceptance.registration_decision_jti_hash = registration.jti_hash
          WHERE registration.jti_hash = '${CONFLICT_DECISION_HASH}'
          GROUP BY registration.consumed_at;
        `).output.trim(),
    ).toBe('t|0');
  }, 60_000);

  test('enforces account-qualified module reports and immutable request identity', () => {
    expect(
      dockerPsql(`
          INSERT INTO kortix.account_requests (
            request_id, account_id, requested_by, kind, status, reason,
            module_installation_id, idempotency_key, request_hash, requested_at, updated_at
          ) VALUES (
            '55555555-5555-4555-8555-555555555555', '${ACCOUNT_A}', '${USER_A}',
            'module_report', 'pending', 'unsafe output', '${INSTALLATION_A}',
            'module-report-0001', 'sha256:${'b'.repeat(64)}', '${NOW}', '${NOW}'
          );
          SELECT count(*) FROM kortix.account_requests;
        `).output.trim(),
    ).toBe('INSERT 0 1\n1');

    const wrongTenant = dockerPsql(
      `INSERT INTO kortix.account_requests (
          account_id, requested_by, kind, status, module_installation_id,
          idempotency_key, request_hash, requested_at, updated_at
        ) VALUES (
          '${ACCOUNT_B}', '${USER_B}', 'module_report', 'pending', '${INSTALLATION_A}',
          'module-report-0002', 'sha256:${'c'.repeat(64)}', '${NOW}', '${NOW}'
        );`,
      true,
    );
    expect(wrongTenant.exitCode).not.toBe(0);

    const mutation = dockerPsql(
      `UPDATE kortix.account_requests
         SET requested_by = '${USER_B}'
         WHERE request_id = '55555555-5555-4555-8555-555555555555';`,
      true,
    );
    expect(mutation.exitCode).not.toBe(0);
    expect(mutation.output).toContain('account request identity is immutable');

    expect(
      dockerPsql(`
          UPDATE kortix.account_requests
          SET status = 'cancelled', terminal_at = '${NOW}', updated_at = '${NOW}'
          WHERE request_id = '55555555-5555-4555-8555-555555555555';
          SELECT status FROM kortix.account_requests
          WHERE request_id = '55555555-5555-4555-8555-555555555555';
        `).output.trim(),
    ).toBe('UPDATE 1\ncancelled');

    expect(
      dockerPsql(`
          INSERT INTO kortix.account_requests (
            request_id, account_id, requested_by, kind, status,
            idempotency_key, request_hash, requested_at, expires_at, updated_at
          ) VALUES (
            '77777777-7777-4777-8777-777777777777', '${ACCOUNT_A}', '${USER_A}',
            'data_export', 'pending', 'export-request-0001',
            'sha256:${'d'.repeat(64)}', '${NOW}',
            ('${NOW}'::timestamptz + interval '7 days'), '${NOW}'
          );
          UPDATE kortix.account_requests
          SET status = 'processing', processing_started_at = '${NOW}', updated_at = '${NOW}'
          WHERE request_id = '77777777-7777-4777-8777-777777777777';
          UPDATE kortix.account_requests
          SET status = 'completed', terminal_at = '${NOW}', updated_at = '${NOW}'
          WHERE request_id = '77777777-7777-4777-8777-777777777777';
          UPDATE kortix.account_requests
          SET status = 'expired', updated_at = '${NOW}'
          WHERE request_id = '77777777-7777-4777-8777-777777777777';
          SELECT status FROM kortix.account_requests
          WHERE request_id = '77777777-7777-4777-8777-777777777777';
        `).output.trim(),
    ).toBe('INSERT 0 1\nUPDATE 1\nUPDATE 1\nUPDATE 1\nexpired');
    const expiredMutation = dockerPsql(
      `UPDATE kortix.account_requests
         SET result_metadata = '{"changed":true}'::jsonb
         WHERE request_id = '77777777-7777-4777-8777-777777777777';`,
      true,
    );
    expect(expiredMutation.exitCode).not.toBe(0);
    expect(expiredMutation.output).toContain('terminal account requests are immutable');
  }, 60_000);

  test('persists revision-fenced developer applications against the same organization authority', () => {
    expect(
      dockerPsql(`
          INSERT INTO kortix.developer_applications (
            application_id, account_id, organization_id, state, revision,
            policy_versions, created_by, created_at, updated_at
          ) VALUES (
            '66666666-6666-4666-8666-666666666666', '${ACCOUNT_A}', '${ORGANIZATION_A}',
            'draft', 0,
            '{"moduleRules":"2026-07-28","acceptableUse":"2026-07-28"}'::jsonb,
            '${USER_A}', '${NOW}', '${NOW}'
          );
          SELECT state, revision FROM kortix.developer_applications;
        `).output.trim(),
    ).toBe('INSERT 0 1\ndraft|0');

    const wrongTenant = dockerPsql(
      `INSERT INTO kortix.developer_applications (
          account_id, organization_id, state, revision, policy_versions,
          created_by, created_at, updated_at
        ) VALUES (
          '${ACCOUNT_B}', '${ORGANIZATION_A}', 'draft', 0,
          '{"moduleRules":"2026-07-28","acceptableUse":"2026-07-28"}'::jsonb,
          '${USER_B}', '${NOW}', '${NOW}'
        );`,
      true,
    );
    expect(wrongTenant.exitCode).not.toBe(0);
  }, 60_000);
});
