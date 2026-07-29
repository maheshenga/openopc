import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';

import * as databaseExports from './index';
import {
  publicRegistrationDecisions,
  publicRegistrationRateBuckets,
} from './schema/kortix';

function checkSql(table: Parameters<typeof getTableConfig>[0], name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!constraint) throw new Error(`missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

describe('public registration guard schema', () => {
  test('stores only digest-bound decisions with exact policy and expiry fields', () => {
    const config = getTableConfig(publicRegistrationDecisions);
    expect(config.name).toBe('public_registration_decisions');
    expect(config.columns.map((column) => column.name)).toEqual([
      'jti_hash',
      'email_digest',
      'device_digest',
      'account_digest',
      'action',
      'policy_versions',
      'issued_at',
      'expires_at',
      'consumed_at',
      'created_at',
    ]);
    expect(config.columns.find((column) => column.name === 'jti_hash')?.primary).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'public_registration_decisions_digest_check',
        'public_registration_decisions_action_check',
        'public_registration_decisions_policy_check',
        'public_registration_decisions_expiry_check',
        'public_registration_decisions_consumption_check',
      ]),
    );
    expect(checkSql(publicRegistrationDecisions, 'public_registration_decisions_expiry_check')).toMatch(
      /5 minutes/i,
    );
  });

  test('uses fixed-window HMAC buckets with one composite identity', () => {
    const config = getTableConfig(publicRegistrationRateBuckets);
    expect(config.name).toBe('public_registration_rate_buckets');
    expect(config.columns.map((column) => column.name)).toEqual([
      'dimension_kind',
      'dimension_key_hash',
      'window_started_at',
      'capacity_limit',
      'window_seconds',
      'request_count',
      'expires_at',
      'updated_at',
    ]);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'dimension_kind',
      'dimension_key_hash',
      'window_started_at',
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'public_registration_rate_buckets_kind_check',
        'public_registration_rate_buckets_hash_check',
        'public_registration_rate_buckets_limits_check',
        'public_registration_rate_buckets_window_check',
      ]),
    );
  });

  test('migration exposes only atomic authorize and consume functions to service_role', () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        '..',
        'migrations',
        '20260728090000000_public_registration_guards.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('kortix.authorize_public_registration_decision');
    expect(migration).toContain('kortix.consume_public_registration_decision');
    expect(migration).toContain('public_registration_decisions_immutable');
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]*authorize_public_registration_decision/i);
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]*consume_public_registration_decision/i);
    expect(migration).not.toMatch(/GRANT\s+(?:UPDATE|DELETE)[^;]*public_registration_decisions/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  test('exports both guard tables from the database package root', () => {
    expect(databaseExports.publicRegistrationDecisions).toBe(publicRegistrationDecisions);
    expect(databaseExports.publicRegistrationRateBuckets).toBe(publicRegistrationRateBuckets);
  });
});
