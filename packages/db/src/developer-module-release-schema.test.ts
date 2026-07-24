import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import {
  developerModuleReleaseStatusEnum,
  developerModuleReleases,
  developerPublishers,
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

describe('developer module release durable schema', () => {
  test('declares the complete additive release lifecycle', () => {
    expect(developerModuleReleaseStatusEnum.enumValues).toEqual([
      'validated',
      'review_pending',
      'changes_requested',
      'approved',
      'signed',
      'published',
      'revoked',
      'deprecated',
    ]);
  });

  test('stores publisher ownership and immutable release metadata in the kortix schema', () => {
    expect(getTableConfig(developerPublishers)).toEqual(
      expect.objectContaining({ schema: 'kortix', name: 'developer_publishers' }),
    );
    expect(getTableConfig(developerModuleReleases)).toEqual(
      expect.objectContaining({ schema: 'kortix', name: 'developer_module_releases' }),
    );
    expect(columnNames(developerPublishers)).toEqual(
      expect.arrayContaining([
        'publisher_id',
        'account_id',
        'display_name',
        'created_by',
        'created_at',
        'updated_at',
      ]),
    );
    expect(columnNames(developerModuleReleases)).toEqual(
      expect.arrayContaining([
        'release_id',
        'account_id',
        'publisher_id',
        'item_name',
        'module_id',
        'module_version',
        'manifest',
        'manifest_digest',
        'review_requirements',
        'status',
        'created_by',
        'created_at',
        'updated_at',
      ]),
    );
  });

  test('binds each release to the publisher account and prevents version reuse', () => {
    expect(uniqueConstraintNames(developerPublishers)).toContain(
      'developer_publishers_publisher_account_unique',
    );
    expect(uniqueConstraintNames(developerModuleReleases)).toContain(
      'developer_module_releases_module_version_unique',
    );
    expect(foreignKeys(developerModuleReleases)).toContainEqual({
      name: 'developer_module_releases_publisher_account_fk',
      columns: ['publisher_id', 'account_id'],
      foreignColumns: ['publisher_id', 'account_id'],
      foreignTable: 'developer_publishers',
      onDelete: 'restrict',
    });
  });

  test('bounds account access paths, JSON metadata, namespace and digests', () => {
    expect(indexNames(developerPublishers)).toContain('idx_developer_publishers_account_created');
    expect(indexNames(developerModuleReleases)).toEqual(
      expect.arrayContaining([
        'idx_developer_module_releases_account_created',
        'idx_developer_module_releases_account_status_created',
      ]),
    );
    expect(
      checkConstraintSql(developerModuleReleases, 'developer_module_releases_manifest_check'),
    ).toContain('pg_column_size');
    expect(
      checkConstraintSql(developerModuleReleases, 'developer_module_releases_digest_check'),
    ).toContain('sha256:');
    expect(
      checkConstraintSql(developerModuleReleases, 'developer_module_releases_namespace_check'),
    ).toContain('publisher_id');
  });
});

describe('developer module release migration', () => {
  test('creates service-only tables and protects release content from mutation', () => {
    const migration = readFileSync(
      join(import.meta.dir, '..', 'migrations', '20260724120000000_developer_module_releases.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.developer_publishers');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.developer_module_releases');
    expect(migration).toContain('developer_module_releases_content_immutable');
    expect(migration).toContain('REVOKE ALL');
    expect(migration).toContain('TO service_role');
    expect(migration).not.toMatch(/GRANT .* TO (?:anon|authenticated)/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });
});
