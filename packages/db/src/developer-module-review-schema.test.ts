import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import {
  developerModuleReleaseReviewEvents,
  developerModuleReviewActionEnum,
  developerModuleReviewActorKindEnum,
} from './schema/kortix';

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexNames(table: PgTable): string[] {
  return getTableConfig(table)
    .indexes.map((index) => index.config.name)
    .filter((name): name is string => name !== undefined);
}

function uniqueConstraintNames(table: PgTable): string[] {
  return getTableConfig(table)
    .uniqueConstraints.map((constraint) => constraint.name)
    .filter((name): name is string => name !== undefined);
}

function checkConstraintSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!constraint) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

function foreignKeys(table: PgTable) {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      name: foreignKey.getName(),
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: getTableConfig(reference.foreignTable).name,
      onDelete: foreignKey.onDelete,
    };
  });
}

describe('developer module review durable schema', () => {
  test('declares bounded review actions and actor kinds', () => {
    expect(developerModuleReviewActionEnum.enumValues).toEqual([
      'submit',
      'resubmit',
      'request_changes',
      'approve',
      'revoke',
    ]);
    expect(developerModuleReviewActorKindEnum.enumValues).toEqual(['publisher', 'platform_admin']);
  });

  test('stores immutable account-scoped transition history', () => {
    expect(getTableConfig(developerModuleReleaseReviewEvents)).toEqual(
      expect.objectContaining({
        schema: 'kortix',
        name: 'developer_module_release_review_events',
      }),
    );
    expect(columnNames(developerModuleReleaseReviewEvents)).toEqual(
      expect.arrayContaining([
        'review_event_id',
        'release_id',
        'account_id',
        'sequence',
        'action',
        'from_status',
        'to_status',
        'actor_user_id',
        'actor_kind',
        'reason',
        'evidence',
        'created_at',
      ]),
    );
    expect(uniqueConstraintNames(developerModuleReleaseReviewEvents)).toContain(
      'developer_module_release_review_events_release_sequence_unique',
    );
    expect(indexNames(developerModuleReleaseReviewEvents)).toContain(
      'idx_developer_module_release_review_events_account_release_sequence',
    );
  });

  test('binds event account identity to the parent release and bounds payloads', () => {
    expect(foreignKeys(developerModuleReleaseReviewEvents)).toContainEqual({
      name: 'developer_module_release_review_events_release_account_fk',
      columns: ['release_id', 'account_id'],
      foreignColumns: ['release_id', 'account_id'],
      foreignTable: 'developer_module_releases',
      onDelete: 'cascade',
    });
    expect(
      checkConstraintSql(
        developerModuleReleaseReviewEvents,
        'developer_module_release_review_events_sequence_check',
      ),
    ).toContain('sequence');
    expect(
      checkConstraintSql(
        developerModuleReleaseReviewEvents,
        'developer_module_release_review_events_transition_check',
      ),
    ).toContain('review_pending');
    const evidenceCheck = checkConstraintSql(
      developerModuleReleaseReviewEvents,
      'developer_module_release_review_events_evidence_check',
    );
    expect(evidenceCheck).toContain('pg_column_size');
    expect(evidenceCheck).toContain('developer_module_review_evidence_valid');
  });
});

describe('developer module review migration', () => {
  test('adds revision fencing and append-only service-role history', () => {
    const migration = readFileSync(
      join(import.meta.dir, '..', 'migrations', '20260724150000000_developer_module_reviews.sql'),
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS review_revision integer');
    expect(migration).toContain('developer_module_releases_release_account_unique');
    expect(migration).toContain('idx_developer_module_releases_review_queue');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS kortix.developer_module_release_review_events',
    );
    expect(migration).toContain('developer_module_release_review_events_transition_check');
    expect(migration).toMatch(
      /GRANT\s+SELECT,\s*INSERT[\s\S]*developer_module_release_review_events[\s\S]*TO service_role/i,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:UPDATE|DELETE)[^;]*developer_module_release_review_events/i,
    );
    expect(migration).toMatch(/GRANT UPDATE \(status, review_revision, updated_at\)/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  test('trust migration makes automatic review evidence server-only and unique', () => {
    const migration = readFileSync(
      join(import.meta.dir, '..', 'migrations', '20260725120000000_developer_module_trust.sql'),
      'utf8',
    );

    expect(migration).toContain('developer_module_review_evidence_valid');
    expect(migration).toContain("'source_scan'");
    expect(migration).toContain("'sandbox_test'");
    expect(migration).toContain("'system_attestation'");
    expect(migration).toContain("COUNT(DISTINCT item ->> 'requirement')");
    expect(migration).toContain("item ->> 'requirement' IS NULL");
    expect(migration).toContain("item ->> 'run_id' IS NULL");
    expect(migration).toContain("item ->> 'evidence_digest' IS NULL");
    expect(migration).toContain("item ->> 'policy_digest' IS NULL");
    expect(migration).toContain("item ->> 'summary' IS NULL");
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS developer_module_release_review_events_evidence_check',
    );
  });
});
