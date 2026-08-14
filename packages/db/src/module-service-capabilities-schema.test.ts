import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as db from './index';
import {
  moduleServiceAuditEvents,
  moduleServiceCapabilityGrants,
  projectModuleServiceConsents,
  studioJobs,
} from './schema/kortix';

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!constraint) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

function index(table: PgTable, name: string) {
  const candidate = getTableConfig(table).indexes.find((entry) => entry.config.name === name);
  if (!candidate) throw new Error(`Missing index: ${name}`);
  return candidate;
}

function indexColumns(table: PgTable, name: string): string[] {
  return index(table, name).config.columns.map((column) => {
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

test('stores immutable module service consent identities and revocation state', () => {
  expect(getTableConfig(projectModuleServiceConsents)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'project_module_service_consents' }),
  );
  expect(columnNames(projectModuleServiceConsents)).toEqual([
    'consent_id',
    'account_id',
    'project_id',
    'installation_id',
    'release_id',
    'install_revision',
    'service',
    'operations',
    'consent_digest',
    'accepted_by',
    'accepted_at',
    'revoked_by',
    'revoked_at',
  ]);
  const active = index(
    projectModuleServiceConsents,
    'idx_project_module_service_consents_active_identity',
  );
  expect(active.config.unique).toBe(true);
  const activeName = active.config.name;
  const activePredicate = active.config.where;
  if (!activeName || !activePredicate) throw new Error('active consent index is incomplete');
  expect(indexColumns(projectModuleServiceConsents, activeName)).toEqual([
    'installation_id',
    'service',
    'install_revision',
  ]);
  expect(new PgDialect().sqlToQuery(activePredicate).sql).toMatch(/revoked_at" IS NULL/);
});

test('binds consents to exact account, project, installation, and release identities', () => {
  expect(foreignKeys(projectModuleServiceConsents)).toEqual(
    expect.arrayContaining([
      {
        name: 'project_module_service_consents_project_account_fk',
        columns: ['project_id', 'account_id'],
        foreignColumns: ['project_id', 'account_id'],
        foreignTable: 'projects',
        onDelete: 'cascade',
      },
      {
        name: 'project_module_service_consents_installation_identity_fk',
        columns: ['installation_id', 'project_id', 'account_id'],
        foreignColumns: ['installation_id', 'project_id', 'account_id'],
        foreignTable: 'project_module_installations',
        onDelete: 'cascade',
      },
      {
        name: 'project_module_service_consents_release_account_fk',
        columns: ['release_id', 'account_id'],
        foreignColumns: ['release_id', 'account_id'],
        foreignTable: 'developer_module_releases',
        onDelete: 'restrict',
      },
    ]),
  );
  expect(
    checkSql(projectModuleServiceConsents, 'project_module_service_consents_operations_check'),
  ).toMatch(
    /models[.]read[\s\S]*orders[.]create[\s\S]*documents[.]read[\s\S]*settings[.]read[\s\S]*jsonb_array_length/,
  );
  expect(
    checkSql(projectModuleServiceConsents, 'project_module_service_consents_revision_check'),
  ).toMatch(/install_revision" > 0/);
});

test('binds Studio module jobs to the grant identity without reusing account tokens', () => {
  expect(columnNames(studioJobs)).toContain('module_service_grant_id');
  expect(foreignKeys(studioJobs)).toEqual(
    expect.arrayContaining([
      {
        name: 'studio_jobs_module_service_grant_fk',
        columns: ['module_service_grant_id'],
        foreignColumns: ['grant_id'],
        foreignTable: 'module_service_capability_grants',
        onDelete: 'no action',
      },
    ]),
  );
});

test('stores only capability token hashes with bounded operation sets and expiry', () => {
  expect(getTableConfig(moduleServiceCapabilityGrants)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'module_service_capability_grants' }),
  );
  expect(columnNames(moduleServiceCapabilityGrants)).toEqual([
    'grant_id',
    'account_id',
    'project_id',
    'installation_id',
    'release_id',
    'consent_id',
    'service',
    'operations',
    'token_hash',
    'expires_at',
    'revoked_at',
    'created_at',
  ]);
  expect(columnNames(moduleServiceCapabilityGrants)).not.toContain('token');
  expect(
    checkSql(moduleServiceCapabilityGrants, 'module_service_capability_grants_token_hash_check'),
  ).toContain('sha256:');
  expect(
    checkSql(moduleServiceCapabilityGrants, 'module_service_capability_grants_expiry_check'),
  ).toMatch(/expires_at" > [\s\S]*created_at"[\s\S]*5 minutes/);
  expect(
    indexColumns(moduleServiceCapabilityGrants, 'idx_module_service_grants_identity_expiry'),
  ).toEqual(['grant_id', 'expires_at']);
});

test('keeps module service audit events tenant-scoped, append-only, and cascade-safe', () => {
  expect(getTableConfig(moduleServiceAuditEvents)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'module_service_audit_events' }),
  );
  expect(columnNames(moduleServiceAuditEvents)).toEqual([
    'event_id',
    'account_id',
    'project_id',
    'installation_id',
    'release_id',
    'grant_id',
    'service',
    'operation',
    'outcome',
    'code',
    'request_id',
    'created_at',
  ]);
  expect(
    indexColumns(moduleServiceAuditEvents, 'idx_module_service_audit_account_project'),
  ).toEqual(['account_id', 'project_id', 'created_at']);
  expect(checkSql(moduleServiceAuditEvents, 'module_service_audit_events_operation_check')).toMatch(
    /models[.]read[\s\S]*refunds[.]create[\s\S]*documents[.]read[\s\S]*settings[.]read/,
  );
  expect(foreignKeys(moduleServiceAuditEvents)).toEqual(
    expect.arrayContaining([
      {
        name: 'module_service_audit_events_grant_identity_fk',
        columns: [
          'grant_id',
          'account_id',
          'project_id',
          'installation_id',
          'release_id',
          'service',
        ],
        foreignColumns: [
          'grant_id',
          'account_id',
          'project_id',
          'installation_id',
          'release_id',
          'service',
        ],
        foreignTable: 'module_service_capability_grants',
        onDelete: 'cascade',
      },
    ]),
  );
});

test('exports all module service capability tables from the database package', () => {
  expect(db).toEqual(
    expect.objectContaining({
      projectModuleServiceConsents,
      moduleServiceCapabilityGrants,
      moduleServiceAuditEvents,
    }),
  );
});

test('adds an idempotent, service-only migration without raw token storage', () => {
  const migration = readFileSync(
    join(import.meta.dir, '..', 'migrations', '20260801100000000_module_service_capabilities.sql'),
    'utf8',
  );

  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.project_module_service_consents');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.module_service_capability_grants');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.module_service_audit_events');
  expect(migration).toContain('idx_project_module_service_consents_active_identity');
  expect(migration).toContain('module_service_audit_events_append_only');
  expect(migration).toContain('protect_project_module_service_consent');
  expect(migration).toContain('protect_module_service_capability_grant');
  expect(migration).toMatch(
    /CONSTRAINT module_service_audit_events_grant_identity_fk[\s\S]*?REFERENCES kortix[.]module_service_capability_grants[\s\S]*?ON DELETE CASCADE/,
  );
  expect(migration).toMatch(/TG_OP = 'DELETE'[\s\S]*project_module_installations[\s\S]*RETURN OLD/);
  expect(migration).toMatch(/REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  expect(migration).not.toMatch(/\btoken\b(?!_hash)/i);
  expect(migration).not.toMatch(/GRANT .* TO (?:anon|authenticated)/i);
});

test('adds the Studio grant link and image generation operation in a forward migration', () => {
  const migration = readFileSync(
    join(import.meta.dir, '..', 'migrations', '20260806120000000_studio_module_service_grants.sql'),
    'utf8',
  );

  expect(migration).toContain('ADD COLUMN IF NOT EXISTS module_service_grant_id uuid');
  expect(migration).toContain('studio_jobs_module_service_grant_fk');
  expect(migration).toContain("'image.generate'");
  expect(migration).toContain('studio_jobs_module_actor_check');
  expect(migration).not.toMatch(/\bgrant\b\s*FROM/i);
});
