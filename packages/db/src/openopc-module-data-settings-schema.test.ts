import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as db from './index';

function columns(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(table: PgTable, name: string): string {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(check.value).sql;
}

function indexNames(table: PgTable): string[] {
  return getTableConfig(table)
    .indexes.map((index) => index.config.name)
    .filter((name): name is string => typeof name === 'string');
}

test('defines tenant-bound versioned module documents without credential columns', () => {
  const table = (db as Record<string, unknown>).projectModuleDocuments as PgTable | undefined;
  expect(table).toBeDefined();
  if (!table) return;
  expect(getTableConfig(table)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'project_module_documents' }),
  );
  expect(columns(table)).toEqual([
    'document_id',
    'account_id',
    'project_id',
    'installation_id',
    'document_key',
    'revision',
    'value',
    'created_at',
    'updated_at',
  ]);
  expect(columns(table)).not.toEqual(expect.arrayContaining(['api_key', 'token', 'provider_url']));
  expect(indexNames(table)).toEqual(
    expect.arrayContaining([
      'project_module_documents_identity_unique',
      'idx_project_module_documents_account_project',
    ]),
  );
  expect(checkSql(table, 'project_module_documents_key_check')).toMatch(/document_key/);
  expect(checkSql(table, 'project_module_documents_value_check')).toMatch(/2000000/);
  expect(checkSql(table, 'project_module_documents_revision_check')).toMatch(/revision/);
});

test('defines platform-managed scalar settings with project installation isolation', () => {
  const table = (db as Record<string, unknown>).projectModuleSettingValues as PgTable | undefined;
  expect(table).toBeDefined();
  if (!table) return;
  expect(getTableConfig(table)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'project_module_setting_values' }),
  );
  expect(columns(table)).toEqual([
    'setting_id',
    'account_id',
    'project_id',
    'installation_id',
    'setting_key',
    'value',
    'revision',
    'updated_by',
    'created_at',
    'updated_at',
  ]);
  expect(indexNames(table)).toEqual(
    expect.arrayContaining([
      'project_module_setting_values_identity_unique',
      'idx_project_module_setting_values_account_project',
    ]),
  );
  expect(checkSql(table, 'project_module_setting_values_key_check')).toMatch(/setting_key/);
  expect(checkSql(table, 'project_module_setting_values_value_check')).toMatch(/jsonb_typeof/);
});

test('defines one aggregate settings revision per module installation', () => {
  const table = (db as Record<string, unknown>).projectModuleSettings as PgTable | undefined;
  expect(table).toBeDefined();
  if (!table) return;
  expect(getTableConfig(table)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'project_module_settings' }),
  );
  expect(columns(table)).toEqual([
    'settings_id',
    'account_id',
    'project_id',
    'installation_id',
    'revision',
    'created_at',
    'updated_at',
  ]);
  expect(indexNames(table)).toContain('project_module_settings_installation_unique');
  expect(checkSql(table, 'project_module_settings_revision_check')).toMatch(/revision/);
});

test('ships an idempotent data/settings migration with no public grants', () => {
  const migration = readFileSync(
    join(import.meta.dir, '..', 'migrations', '20260813120000000_openopc_module_data_settings.sql'),
    'utf8',
  );
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.project_module_documents');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.project_module_setting_values');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.project_module_settings');
  expect(migration).toContain('protect_project_module_document_revision');
  expect(migration).toContain('REVOKE ALL');
  expect(migration).not.toMatch(
    /\b(?:api_key|access_token|provider_url)\s+(?:text|varchar|jsonb)\b/i,
  );
  expect(migration).not.toMatch(/GRANT .* TO (?:anon|authenticated)/i);
});
