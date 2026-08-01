import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as db from './index';
import { moduleCustomDomainBindings } from './schema/kortix';

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!constraint) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

function indexColumns(table: PgTable, name: string): string[] {
  const candidate = getTableConfig(table).indexes.find((entry) => entry.config.name === name);
  if (!candidate) throw new Error(`Missing index: ${name}`);
  return candidate.config.columns.map((column) => {
    const columnName = (column as { name?: string }).name;
    if (!columnName) throw new Error(`Index ${name} contains an expression`);
    return columnName;
  });
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

test('stores tenant-bound custom domains with only a verification hash', () => {
  expect(getTableConfig(moduleCustomDomainBindings)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'module_custom_domain_bindings' }),
  );
  expect(columnNames(moduleCustomDomainBindings)).toEqual([
    'binding_id',
    'environment',
    'account_id',
    'project_id',
    'installation_id',
    'release_id',
    'hostname',
    'hostname_ascii',
    'state',
    'verification_token_hash',
    'cloudflare_custom_hostname_id',
    'cname_target',
    'failure_code',
    'created_by',
    'created_at',
    'updated_at',
  ]);
  expect(
    indexColumns(moduleCustomDomainBindings, 'module_custom_domain_bindings_hostname_unique'),
  ).toEqual(['hostname_ascii']);
  expect(
    checkSql(moduleCustomDomainBindings, 'module_custom_domain_bindings_hostname_check'),
  ).toMatch(/hostname_ascii[\s\S]*lower[\s\S]*hostname_ascii/);
  expect(
    checkSql(moduleCustomDomainBindings, 'module_custom_domain_bindings_hash_check'),
  ).toContain('sha256:');
  expect(columnNames(moduleCustomDomainBindings)).not.toContain('verification_token');
});

test('binds domains to exact project, installation, and release identities', () => {
  expect(foreignKeys(moduleCustomDomainBindings)).toEqual(
    expect.arrayContaining([
      {
        name: 'module_custom_domain_bindings_project_account_fk',
        columns: ['project_id', 'account_id'],
        foreignColumns: ['project_id', 'account_id'],
        foreignTable: 'projects',
        onDelete: 'cascade',
      },
      {
        name: 'module_custom_domain_bindings_installation_identity_fk',
        columns: ['installation_id', 'project_id', 'account_id'],
        foreignColumns: ['installation_id', 'project_id', 'account_id'],
        foreignTable: 'project_module_installations',
        onDelete: 'cascade',
      },
      {
        name: 'module_custom_domain_bindings_release_account_fk',
        columns: ['release_id', 'account_id'],
        foreignColumns: ['release_id', 'account_id'],
        foreignTable: 'developer_module_releases',
        onDelete: 'restrict',
      },
    ]),
  );
  expect(checkSql(moduleCustomDomainBindings, 'module_custom_domain_bindings_state_check')).toMatch(
    /requested[\s\S]*dns_pending[\s\S]*hostname_pending[\s\S]*active[\s\S]*failed[\s\S]*disabled/,
  );
  expect(
    checkSql(moduleCustomDomainBindings, 'module_custom_domain_bindings_provider_state_check'),
  ).toMatch(/hostname_pending[\s\S]*cloudflare_custom_hostname_id[\s\S]*active/);
  expect(
    checkSql(moduleCustomDomainBindings, 'module_custom_domain_bindings_environment_check'),
  ).toMatch(/dev[\s\S]*staging[\s\S]*prod[\s\S]*preview/);
  expect(db).toEqual(expect.objectContaining({ moduleCustomDomainBindings }));
});

test('adds an idempotent, least-privilege custom-domain migration without provider secrets', () => {
  const migration = readFileSync(
    join(import.meta.dir, '..', 'migrations', '20260801120000000_module_custom_domains.sql'),
    'utf8',
  );
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.module_custom_domain_bindings');
  expect(migration).toContain('module_custom_domain_bindings_hostname_unique');
  expect(migration).toContain('verification_token_hash');
  expect(migration).toContain('REVOKE ALL PRIVILEGES');
  expect(migration).not.toMatch(/^\s*verification_token\s+/im);
  expect(migration).not.toMatch(/^\s*(?:api_token|cloudflare_token|dns_credentials)\s+/im);
});
