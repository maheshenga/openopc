import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as db from './index';
import {
  developerModuleDistributionActionEnum,
  developerModuleReleaseDistributionEvents,
  developerModuleReleases,
  projectModuleInstallationActionEnum,
  projectModuleInstallationEvents,
  projectModuleInstallationStatusEnum,
  projectModuleInstallations,
} from './schema/kortix';

function checkConstraintSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!constraint) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

function uniqueConstraintNames(table: PgTable): string[] {
  return getTableConfig(table)
    .uniqueConstraints.map((constraint) => constraint.name)
    .filter((name): name is string => name !== undefined);
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

test('adds public signature lifecycle columns to developer module releases', () => {
  const columns = getTableConfig(developerModuleReleases).columns.map((column) => column.name);

  expect(columns).toEqual(
    expect.arrayContaining([
      'signature_algorithm',
      'signature_key_id',
      'signature',
      'signature_payload_digest',
      'signed_at',
      'published_at',
      'revoked_at',
    ]),
  );
});

test('keeps signature metadata and lifecycle timestamps internally consistent', () => {
  expect(
    checkConstraintSql(
      developerModuleReleases,
      'developer_module_releases_signature_consistency_check',
    ),
  ).toMatch(/ed25519[\s\S]*base64url:[\s\S]*sha256:/);
  expect(
    checkConstraintSql(
      developerModuleReleases,
      'developer_module_releases_lifecycle_timestamps_check',
    ),
  ).toMatch(/published[\s\S]*deprecated[\s\S]*revoked/);
});

test('stores immutable platform-admin distribution transitions', () => {
  expect(developerModuleDistributionActionEnum.enumValues).toEqual(['sign', 'publish', 'revoke']);
  expect(getTableConfig(developerModuleReleaseDistributionEvents)).toEqual(
    expect.objectContaining({
      schema: 'kortix',
      name: 'developer_module_release_distribution_events',
    }),
  );
  expect(
    getTableConfig(developerModuleReleaseDistributionEvents).columns.map((column) => column.name),
  ).toEqual(
    expect.arrayContaining([
      'distribution_event_id',
      'release_id',
      'account_id',
      'sequence',
      'action',
      'from_status',
      'to_status',
      'actor_user_id',
      'actor_kind',
      'reason',
      'created_at',
    ]),
  );
});

test('binds distribution history to the owning release and valid state transitions', () => {
  expect(uniqueConstraintNames(developerModuleReleaseDistributionEvents)).toContain(
    'developer_module_release_distribution_events_release_sequence_unique',
  );
  expect(foreignKeys(developerModuleReleaseDistributionEvents)).toContainEqual({
    name: 'developer_module_release_distribution_events_release_account_fk',
    columns: ['release_id', 'account_id'],
    foreignColumns: ['release_id', 'account_id'],
    foreignTable: 'developer_module_releases',
    onDelete: 'cascade',
  });
  expect(
    checkConstraintSql(
      developerModuleReleaseDistributionEvents,
      'developer_module_release_distribution_events_transition_check',
    ),
  ).toMatch(/platform_admin[\s\S]*approved[\s\S]*signed[\s\S]*published[\s\S]*revoked/);
});

test('stores one active module pointer per project', () => {
  expect(projectModuleInstallationStatusEnum.enumValues).toEqual(['active', 'blocked']);
  expect(projectModuleInstallationActionEnum.enumValues).toEqual(['install', 'update', 'rollback']);
  expect(getTableConfig(projectModuleInstallations)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'project_module_installations' }),
  );
  expect(getTableConfig(projectModuleInstallations).columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      'installation_id',
      'project_id',
      'account_id',
      'module_id',
      'active_release_id',
      'active_version',
      'install_revision',
      'status',
      'installed_by',
      'created_at',
      'updated_at',
    ]),
  );
});

test('binds the installation pointer to one project account and globally published release', () => {
  expect(uniqueConstraintNames(projectModuleInstallations)).toContain(
    'project_module_installations_project_module_unique',
  );
  expect(foreignKeys(projectModuleInstallations)).toEqual(
    expect.arrayContaining([
      {
        name: 'project_module_installations_project_account_fk',
        columns: ['project_id', 'account_id'],
        foreignColumns: ['project_id', 'account_id'],
        foreignTable: 'projects',
        onDelete: 'cascade',
      },
      {
        name: 'project_module_installations_release_identity_fk',
        columns: ['active_release_id'],
        foreignColumns: ['release_id'],
        foreignTable: 'developer_module_releases',
        onDelete: 'no action',
      },
    ]),
  );
  expect(
    checkConstraintSql(projectModuleInstallations, 'project_module_installations_revision_check'),
  ).toContain('install_revision');
  expect(
    checkConstraintSql(
      projectModuleInstallations,
      'project_module_installations_active_version_check',
    ),
  ).toContain('active_version');
});

test('keeps the active module id and version consistent with the exact release', () => {
  expect(uniqueConstraintNames(developerModuleReleases)).toContain(
    'developer_module_releases_installation_identity_unique',
  );
  expect(foreignKeys(projectModuleInstallations)).toContainEqual({
    name: 'project_module_installations_release_identity_fk',
    columns: ['active_release_id'],
    foreignColumns: ['release_id'],
    foreignTable: 'developer_module_releases',
    onDelete: 'no action',
  });
});

test('stores immutable installation, update, and rollback history', () => {
  expect(getTableConfig(projectModuleInstallationEvents)).toEqual(
    expect.objectContaining({
      schema: 'kortix',
      name: 'project_module_installation_events',
    }),
  );
  expect(
    getTableConfig(projectModuleInstallationEvents).columns.map((column) => column.name),
  ).toEqual(
    expect.arrayContaining([
      'installation_event_id',
      'installation_id',
      'project_id',
      'account_id',
      'sequence',
      'action',
      'from_release_id',
      'to_release_id',
      'expected_revision',
      'resulting_revision',
      'idempotency_key',
      'actor_user_id',
      'created_at',
    ]),
  );
});

test('fences installation history by identity, account, sequence, and revision', () => {
  expect(uniqueConstraintNames(projectModuleInstallationEvents)).toContain(
    'project_module_installation_events_installation_sequence_unique',
  );
  expect(uniqueConstraintNames(projectModuleInstallationEvents)).toContain(
    'project_module_installation_events_account_project_idempotency_unique',
  );
  expect(foreignKeys(projectModuleInstallationEvents)).toEqual(
    expect.arrayContaining([
      {
        name: 'project_module_installation_events_installation_identity_fk',
        columns: ['installation_id', 'project_id', 'account_id'],
        foreignColumns: ['installation_id', 'project_id', 'account_id'],
        foreignTable: 'project_module_installations',
        onDelete: 'cascade',
      },
      {
        name: 'project_module_installation_events_to_release_account_fk',
        columns: ['to_release_id'],
        foreignColumns: ['release_id'],
        foreignTable: 'developer_module_releases',
        onDelete: 'no action',
      },
    ]),
  );
  expect(
    checkConstraintSql(
      projectModuleInstallationEvents,
      'project_module_installation_events_revision_check',
    ),
  ).toMatch(/expected_revision[\s\S]*resulting_revision/);
  expect(
    checkConstraintSql(
      projectModuleInstallationEvents,
      'project_module_installation_events_transition_check',
    ),
  ).toMatch(/install[\s\S]*update[\s\S]*rollback/);
  expect(
    checkConstraintSql(
      projectModuleInstallationEvents,
      'project_module_installation_events_idempotency_key_check',
    ),
  ).toMatch(/idempotency/);
});

test('exports distribution tables and enums from the database package', () => {
  expect(db).toEqual(
    expect.objectContaining({
      developerModuleDistributionActionEnum,
      developerModuleReleaseDistributionEvents,
      projectModuleInstallationStatusEnum,
      projectModuleInstallationActionEnum,
      projectModuleInstallations,
      projectModuleInstallationEvents,
    }),
  );
});

test('adds an idempotent service-only migration with append-only event triggers', () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      '..',
      'migrations',
      '20260724180000000_developer_module_distribution.sql',
    ),
    'utf8',
  );

  expect(migration).toContain('ADD COLUMN IF NOT EXISTS signature_algorithm');
  expect(migration).toContain('developer_module_releases_installation_identity_unique');
  expect(migration).toContain('project_module_installations_release_identity_fk');
  expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(3);
  expect(migration).toContain('CREATE TYPE kortix.developer_module_distribution_action');
  expect(migration).toContain(
    'CREATE TABLE IF NOT EXISTS kortix.developer_module_release_distribution_events',
  );
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.project_module_installations');
  expect(migration).toContain(
    'CREATE TABLE IF NOT EXISTS kortix.project_module_installation_events',
  );
  expect(migration).toContain('developer_module_release_distribution_events_append_only');
  expect(migration).toContain('project_module_installation_events_append_only');
  expect(migration).toContain('FROM kortix.developer_module_releases AS release');
  expect(migration).toContain('FROM kortix.project_module_installations AS installation');
  expect(migration).toContain('while the parent still exists remain append-only violations.');
  expect(migration).toContain(
    'DROP FUNCTION IF EXISTS kortix.mark_developer_module_distribution_event_cascade()',
  );
  expect(migration).toContain(
    'DROP FUNCTION IF EXISTS kortix.mark_project_module_installation_event_cascade()',
  );
  expect(migration).toMatch(/REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  expect(migration).not.toMatch(/GRANT .* TO (?:anon|authenticated)/i);
  expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
});

test('adds cross-account release references and durable idempotency in a follow-up migration', () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      '..',
      'migrations',
      '20260724210000000_project_module_installation_compatibility.sql',
    ),
    'utf8',
  );

  expect(migration).toContain('ADD COLUMN IF NOT EXISTS idempotency_key');
  expect(migration).toContain('project_module_installations_release_identity_fk');
  expect(migration).toContain('FOREIGN KEY (active_release_id)');
  expect(migration).toContain('FOREIGN KEY (to_release_id)');
  expect(migration).toContain(
    'project_module_installation_events_account_project_idempotency_unique',
  );
  expect(migration).toContain('project_module_installation_events_idempotency_key_check');
});
