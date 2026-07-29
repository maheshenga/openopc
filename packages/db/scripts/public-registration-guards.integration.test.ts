import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260728090000000_public_registration_guards.sql',
);
const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `openopc-public-registration-${crypto.randomUUID().slice(0, 8)}`;
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;
const DIGEST_E = `sha256:${'e'.repeat(64)}`;
const DIGEST_F = `sha256:${'f'.repeat(64)}`;
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

function authorizeSql(jtiHash: string, limit = 1, persistDecision = true): string {
  return `SELECT kortix.authorize_public_registration_decision(
    '[
      {"kind":"ip","keyHash":"${DIGEST_A}","limit":${limit},"windowSeconds":300},
      {"kind":"device","keyHash":"${DIGEST_B}","limit":${limit},"windowSeconds":300},
      {"kind":"email","keyHash":"${DIGEST_C}","limit":${limit},"windowSeconds":300},
      {"kind":"account","keyHash":"${DIGEST_D}","limit":${limit},"windowSeconds":300},
      {"kind":"action","keyHash":"${DIGEST_E}","limit":${limit},"windowSeconds":300}
    ]'::jsonb,
    ${persistDecision},
    '${jtiHash}', '${DIGEST_A}', '${DIGEST_B}', '${DIGEST_D}', 'signup',
    '{"terms":"2026-07-28","privacy":"2026-07-28","acceptableUse":"2026-07-28"}'::jsonb,
    '${NOW}'::timestamptz, ('${NOW}'::timestamptz + interval '5 minutes')
  );`;
}

describe.skipIf(!dockerAvailable)('public registration guards - real PostgreSQL', () => {
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

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (dockerPsql('SELECT 1;', true).exitCode === 0) {
        const migration = await Bun.file(migrationPath).text();
        dockerPsql(`
          CREATE ROLE anon;
          CREATE ROLE authenticated;
          CREATE ROLE service_role;
          CREATE SCHEMA kortix;
          ${migration}
          ${migration}
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

  test(
    'applies idempotently with digest-only columns and service-role function access',
    () => {
      const result = dockerPsql(`
        SELECT
          to_regclass('kortix.public_registration_decisions') IS NOT NULL,
          to_regclass('kortix.public_registration_rate_buckets') IS NOT NULL,
          has_function_privilege(
            'service_role',
            'kortix.authorize_public_registration_decision(jsonb,boolean,character varying,character varying,character varying,character varying,character varying,jsonb,timestamp with time zone,timestamp with time zone)',
            'EXECUTE'
          ),
          has_table_privilege(
            'service_role', 'kortix.public_registration_decisions', 'UPDATE'
          );
      `).output.trim();
      expect(result).toBe('t|t|t|f');
    },
    60_000,
  );

  test(
    'counts policy-denied attempts without persisting a consumable decision',
    () => {
      const rateOnly = authorizeSql(DIGEST_F, 1, false)
        .replaceAll(DIGEST_A, DIGEST_F)
        .replaceAll(DIGEST_B, DIGEST_F)
        .replaceAll(DIGEST_C, DIGEST_F)
        .replaceAll(DIGEST_D, DIGEST_F)
        .replaceAll(DIGEST_E, DIGEST_F);
      expect(dockerPsql(rateOnly).output.trim()).toBe('t');
      expect(
        dockerPsql(`
          SELECT count(*), min(request_count), max(request_count)
          FROM kortix.public_registration_rate_buckets
          WHERE dimension_key_hash = '${DIGEST_F}';
        `).output.trim(),
      ).toBe('5|1|1');
      expect(
        dockerPsql('SELECT count(*) FROM kortix.public_registration_decisions;').output.trim(),
      ).toBe('0');
    },
    60_000,
  );

  test(
    'atomically exhausts every fixed-window dimension without storing a second decision',
    () => {
      expect(dockerPsql(authorizeSql(DIGEST_A)).output.trim()).toBe('t');
      expect(dockerPsql(authorizeSql(DIGEST_B)).output.trim()).toBe('f');
      expect(
        dockerPsql(`
          SELECT count(*), min(request_count), max(request_count)
          FROM kortix.public_registration_rate_buckets
          WHERE dimension_key_hash <> '${DIGEST_F}';
        `).output.trim(),
      ).toBe('5|2|2');
      expect(
        dockerPsql('SELECT count(*) FROM kortix.public_registration_decisions;').output.trim(),
      ).toBe('1');
    },
    60_000,
  );

  test(
    'rejects raw dimension values and malformed policy versions',
    () => {
      const freshDimensions = authorizeSql(DIGEST_C)
        .replaceAll(DIGEST_A, DIGEST_F)
        .replaceAll(DIGEST_B, DIGEST_F)
        .replaceAll(DIGEST_C, DIGEST_F)
        .replaceAll(DIGEST_D, DIGEST_F)
        .replaceAll(DIGEST_E, DIGEST_F)
        .replaceAll('2026-07-28T12:00:00.000Z', '2026-07-28T13:00:00.000Z');
      const rawDimension = dockerPsql(
        freshDimensions.replace(DIGEST_F, '203.0.113.10'),
        true,
      );
      expect(rawDimension.exitCode).not.toBe(0);
      expect(rawDimension.output).toContain('public registration dimension invalid');

      const malformedPolicy = dockerPsql(
        freshDimensions.replace(
          '{"terms":"2026-07-28","privacy":"2026-07-28","acceptableUse":"2026-07-28"}',
          '{"terms":"2026-07-28","privacy":"latest","acceptableUse":"2026-07-28"}',
        ),
        true,
      );
      expect(malformedPolicy.exitCode).not.toBe(0);
      expect(malformedPolicy.output).toContain('public_registration_decisions_policy_check');
    },
    60_000,
  );

  test(
    'consumes a decision once and prevents identity mutation or deletion',
    () => {
      expect(
        dockerPsql(
          `SELECT kortix.consume_public_registration_decision(
            '${DIGEST_A}', '2026-07-28T12:04:00.000Z'::timestamptz
          );`,
        ).output.trim(),
      ).toBe('t');
      expect(
        dockerPsql(
          `SELECT kortix.consume_public_registration_decision(
            '${DIGEST_A}', '2026-07-28T12:04:01.000Z'::timestamptz
          );`,
        ).output.trim(),
      ).toBe('f');

      for (const statement of [
        `UPDATE kortix.public_registration_decisions
         SET email_digest = '${DIGEST_E}' WHERE jti_hash = '${DIGEST_A}';`,
        `DELETE FROM kortix.public_registration_decisions WHERE jti_hash = '${DIGEST_A}';`,
      ]) {
        const rejected = dockerPsql(statement, true);
        expect(rejected.exitCode).not.toBe(0);
        expect(rejected.output).toContain('public registration decisions are immutable');
      }
    },
    60_000,
  );
});
