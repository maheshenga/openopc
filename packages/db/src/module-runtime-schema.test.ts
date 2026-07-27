import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as db from './index';
import {
  moduleCapabilityAudienceEnum,
  moduleCapabilityGrants,
  moduleCapabilityUses,
  moduleExecutionEvents,
  moduleExecutionEvidence,
  moduleExecutionHeartbeats,
  moduleExecutionInputs,
  moduleExecutionLeases,
  moduleExecutionOutbox,
  moduleExecutionOutputs,
  moduleExecutionStateEnum,
  moduleExecutions,
  moduleKillSwitchGenerations,
  moduleKillSwitchScopeEnum,
  moduleOutboxStatusEnum,
  moduleRunnerProfiles,
  moduleRunnerStatusEnum,
  moduleRunners,
  moduleRuntimeArtifacts,
  moduleRuntimeDescriptors,
  moduleRuntimeKindEnum,
  projectModuleConsentRevisions,
} from './schema/kortix';

const migrationSql = (
  await Bun.file(
    resolve(
      import.meta.dir,
      '..',
      'migrations',
      '20260727150000000_module_runtime_control_plane.sql',
    ),
  ).text()
).replaceAll('\r\n', '\n');

function migrationFunctionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION kortix.${name}(`;
  const start = migrationSql.indexOf(marker);
  if (start < 0) throw new Error(`Missing migration function: ${name}`);
  const end = migrationSql.indexOf('\nEND;\n$$;', start);
  if (end < 0) throw new Error(`Unterminated migration function: ${name}`);
  return migrationSql.slice(start, end);
}

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexNames(table: PgTable): string[] {
  return getTableConfig(table)
    .indexes.map((index) => index.config.name)
    .filter((name): name is string => name !== undefined);
}

function indexColumnNames(table: PgTable, name: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  if (!index) throw new Error(`Missing index: ${name}`);
  return index.config.columns.map((column) => {
    const columnName = (column as { name?: string }).name;
    if (!columnName) throw new Error(`Index ${name} contains a non-column expression`);
    return columnName;
  });
}

function indexWhereSql(table: PgTable, name: string): string {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  if (!index?.config.where) throw new Error(`Missing partial-index predicate: ${name}`);
  return new PgDialect().sqlToQuery(index.config.where).sql;
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

test('terminal evidence and consent snapshots are immutable', () => {
  expect(moduleExecutionEvidence.executionId).toBeDefined();
  expect(projectModuleConsentRevisions.permissionDigest).toBeDefined();
});

test('declares the nine-state module execution machine and runtime enums', () => {
  expect(moduleExecutionStateEnum.enumValues).toEqual([
    'pending',
    'awaiting_confirmation',
    'dispatchable',
    'leased',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'unknown',
  ]);
  expect(moduleRuntimeKindEnum.enumValues).toEqual(['wasi-component', 'oci-image']);
  expect(moduleRunnerStatusEnum.enumValues).toEqual([
    'active',
    'draining',
    'quarantined',
    'revoked',
  ]);
  expect(moduleCapabilityAudienceEnum.enumValues).toEqual([
    'secret',
    'egress',
    'model',
    'desktop',
    'paid-call',
  ]);
  expect(moduleKillSwitchScopeEnum.enumValues).toEqual(['account', 'project', 'runner']);
  expect(moduleOutboxStatusEnum.enumValues).toEqual([
    'pending',
    'processing',
    'completed',
    'failed',
  ]);
});

test('locks execution before lease in heartbeat and finalize functions', () => {
  for (const name of ['heartbeat_module_execution', 'finalize_module_execution']) {
    const body = migrationFunctionBody(name);
    const executionLock = body.indexOf('FROM kortix.module_executions AS execution');
    const leaseLock = body.indexOf('FROM kortix.module_execution_leases AS lease');

    expect(executionLock).toBeGreaterThan(-1);
    expect(leaseLock).toBeGreaterThan(-1);
    expect(executionLock).toBeLessThan(leaseLock);
  }
});

test('stores runtime descriptors and install consent revisions with digests', () => {
  expect(getTableConfig(moduleRuntimeDescriptors)).toEqual(
    expect.objectContaining({ name: 'module_runtime_descriptors', schema: 'kortix' }),
  );
  expect(columnNames(moduleRuntimeDescriptors)).toEqual(
    expect.arrayContaining([
      'descriptor_id',
      'account_id',
      'release_id',
      'runtime_kind',
      'descriptor_digest',
      'descriptor',
      'created_at',
    ]),
  );
  expect(
    checkConstraintSql(moduleRuntimeDescriptors, 'module_runtime_descriptors_digest_check'),
  ).toMatch(/sha256:/);

  expect(getTableConfig(projectModuleConsentRevisions)).toEqual(
    expect.objectContaining({ name: 'project_module_consent_revisions', schema: 'kortix' }),
  );
  expect(columnNames(projectModuleConsentRevisions)).toEqual(
    expect.arrayContaining([
      'consent_revision_id',
      'account_id',
      'project_id',
      'installation_id',
      'install_revision',
      'release_id',
      'permission_digest',
      'permission_snapshot',
      'resource_cpu_millis_ceiling',
      'resource_memory_mib_ceiling',
      'resource_wall_time_ms_ceiling',
      'cost_ceiling_micro',
      'accepted_by',
      'created_at',
    ]),
  );
  expect(
    checkConstraintSql(
      projectModuleConsentRevisions,
      'project_module_consent_revisions_permission_digest_check',
    ),
  ).toMatch(/sha256:/);
});

test('stores immutable execution inputs and WASI runtime artifacts with tenant identities', () => {
  expect(getTableConfig(moduleExecutionInputs)).toEqual(
    expect.objectContaining({ name: 'module_execution_inputs', schema: 'kortix' }),
  );
  expect(columnNames(moduleExecutionInputs)).toEqual([
    'execution_id',
    'account_id',
    'project_id',
    'input_payload',
    'input_digest',
    'created_at',
  ]);
  expect(foreignKeys(moduleExecutionInputs)).toContainEqual(
    expect.objectContaining({
      name: 'module_execution_inputs_execution_identity_fk',
      columns: ['execution_id', 'account_id', 'project_id'],
      foreignColumns: ['execution_id', 'account_id', 'project_id'],
      foreignTable: 'module_executions',
    }),
  );
  expect(
    checkConstraintSql(moduleExecutionInputs, 'module_execution_inputs_payload_size_check'),
  ).toMatch(/octet_length\(.+\) <= 262144/);
  expect(checkConstraintSql(moduleExecutionInputs, 'module_execution_inputs_digest_check')).toMatch(
    /sha256:/,
  );

  expect(getTableConfig(moduleRuntimeArtifacts)).toEqual(
    expect.objectContaining({ name: 'module_runtime_artifacts', schema: 'kortix' }),
  );
  expect(columnNames(moduleRuntimeArtifacts)).toEqual([
    'runtime_artifact_id',
    'account_id',
    'release_id',
    'runtime_descriptor_id',
    'artifact_digest',
    'artifact_bytes',
    'media_type',
    'storage_key',
    'created_at',
  ]);
  expect(foreignKeys(moduleRuntimeArtifacts)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'module_runtime_artifacts_release_account_fk',
        columns: ['release_id', 'account_id'],
        foreignColumns: ['release_id', 'account_id'],
        foreignTable: 'developer_module_releases',
      }),
      expect.objectContaining({
        name: 'module_runtime_artifacts_descriptor_account_fk',
        columns: ['runtime_descriptor_id', 'account_id'],
        foreignColumns: ['descriptor_id', 'account_id'],
        foreignTable: 'module_runtime_descriptors',
      }),
    ]),
  );
  expect(uniqueConstraintNames(moduleRuntimeArtifacts)).toEqual(
    expect.arrayContaining([
      'module_runtime_artifacts_identity_unique',
      'module_runtime_artifacts_release_account_unique',
      'module_runtime_artifacts_descriptor_account_unique',
    ]),
  );
  expect(
    checkConstraintSql(moduleRuntimeArtifacts, 'module_runtime_artifacts_digest_check'),
  ).toMatch(/sha256:/);
  expect(
    checkConstraintSql(moduleRuntimeArtifacts, 'module_runtime_artifacts_bytes_check'),
  ).toMatch(/BETWEEN 1 AND 33554432/i);
  expect(
    checkConstraintSql(moduleRuntimeArtifacts, 'module_runtime_artifacts_media_type_check'),
  ).toMatch(/application\/wasm/);

  expect(migrationSql).toMatch(
    /CREATE TRIGGER module_execution_inputs_append_only\s+BEFORE UPDATE OR DELETE ON kortix\.module_execution_inputs/,
  );
  expect(migrationSql).toMatch(
    /CREATE TRIGGER module_runtime_artifacts_append_only\s+BEFORE UPDATE OR DELETE ON kortix\.module_runtime_artifacts/,
  );
});

test('stores Runner registrations, profiles, executions, and fenced leases', () => {
  expect(columnNames(moduleRunners)).toEqual(
    expect.arrayContaining([
      'runner_id',
      'account_id',
      'node_identity',
      'status',
      'software_version',
      'attestation_digest',
      'certificate_thumbprint',
      'created_at',
      'updated_at',
    ]),
  );
  expect(columnNames(moduleRunnerProfiles)).toEqual(
    expect.arrayContaining([
      'profile_id',
      'runner_id',
      'account_id',
      'profile_name',
      'runtime_kind',
      'created_at',
    ]),
  );
  expect(columnNames(moduleExecutions)).toEqual(
    expect.arrayContaining([
      'execution_id',
      'account_id',
      'project_id',
      'installation_id',
      'release_id',
      'consent_revision_id',
      'runtime_descriptor_id',
      'runtime_kind',
      'runtime_profile',
      'state',
      'idempotency_key',
      'work_envelope_digest',
      'kill_switch_generation',
      'deadline_at',
      'created_at',
      'updated_at',
      'terminal_at',
    ]),
  );
  expect(foreignKeys(moduleExecutions)).toContainEqual(
    expect.objectContaining({
      columns: ['project_id', 'account_id'],
      foreignColumns: ['project_id', 'account_id'],
      foreignTable: 'projects',
    }),
  );
  expect(moduleExecutions.runtimeKind.notNull).toBe(true);
  expect(moduleExecutions.runtimeProfile.notNull).toBe(true);
  expect(indexNames(moduleExecutions)).not.toContain('idx_module_executions_claimable');
  expect(indexColumnNames(moduleExecutions, 'idx_module_executions_dispatchable_profile')).toEqual([
    'account_id',
    'state',
    'runtime_kind',
    'runtime_profile',
    'deadline_at',
    'created_at',
    'execution_id',
  ]);
  expect(indexWhereSql(moduleExecutions, 'idx_module_executions_dispatchable_profile')).toMatch(
    /state.+dispatchable/,
  );
  expect(columnNames(moduleExecutionLeases)).toEqual(
    expect.arrayContaining([
      'lease_id',
      'execution_id',
      'account_id',
      'project_id',
      'runner_id',
      'generation',
      'deadline_at',
      'claimed_at',
      'released_at',
      'created_at',
    ]),
  );
  expect(indexNames(moduleExecutionLeases)).toContain(
    'module_execution_leases_live_execution_unique',
  );
  expect(columnNames(moduleExecutionHeartbeats)).toEqual(
    expect.arrayContaining([
      'heartbeat_id',
      'lease_id',
      'execution_id',
      'account_id',
      'project_id',
      'runner_id',
      'generation',
      'observed_at',
      'created_at',
    ]),
  );
});

test('stores capability grants/uses, events, outputs, evidence, kill switches, and outbox', () => {
  expect(columnNames(moduleCapabilityGrants)).toEqual(
    expect.arrayContaining([
      'grant_id',
      'execution_id',
      'account_id',
      'project_id',
      'lease_id',
      'audience',
      'token_hash',
      'expires_at',
      'revoked_at',
      'created_at',
    ]),
  );
  expect(
    checkConstraintSql(moduleCapabilityGrants, 'module_capability_grants_token_hash_check'),
  ).toMatch(/sha256:/);
  expect(columnNames(moduleCapabilityUses)).toEqual(
    expect.arrayContaining([
      'use_id',
      'grant_id',
      'execution_id',
      'account_id',
      'project_id',
      'observed_at',
      'created_at',
    ]),
  );
  expect(columnNames(moduleExecutionEvents)).toEqual(
    expect.arrayContaining([
      'event_id',
      'execution_id',
      'account_id',
      'project_id',
      'sequence',
      'event_type',
      'payload',
      'created_at',
    ]),
  );
  expect(uniqueConstraintNames(moduleExecutionEvents)).toContain(
    'module_execution_events_execution_sequence_unique',
  );
  expect(columnNames(moduleExecutionOutputs)).toEqual(
    expect.arrayContaining([
      'output_id',
      'execution_id',
      'account_id',
      'project_id',
      'output_digest',
      'size_bytes',
      'created_at',
    ]),
  );
  expect(columnNames(moduleExecutionEvidence)).toEqual(
    expect.arrayContaining([
      'evidence_id',
      'execution_id',
      'account_id',
      'project_id',
      'lease_id',
      'generation',
      'runner_id',
      'outcome',
      'evidence_digest',
      'evidence',
      'created_at',
    ]),
  );
  expect(columnNames(moduleKillSwitchGenerations)).toEqual(
    expect.arrayContaining([
      'kill_switch_id',
      'account_id',
      'project_id',
      'runner_id',
      'scope',
      'generation',
      'active',
      'activated_at',
      'released_at',
      'created_at',
    ]),
  );
  expect(columnNames(moduleExecutionOutbox)).toEqual(
    expect.arrayContaining([
      'outbox_id',
      'execution_id',
      'account_id',
      'project_id',
      'idempotency_key',
      'payload',
      'status',
      'created_at',
      'updated_at',
    ]),
  );
});

test('exports module runtime control-plane symbols from the package surface', () => {
  expect(db).toEqual(
    expect.objectContaining({
      moduleExecutionStateEnum,
      moduleRuntimeKindEnum,
      moduleRunnerStatusEnum,
      moduleCapabilityAudienceEnum,
      moduleKillSwitchScopeEnum,
      moduleOutboxStatusEnum,
      moduleRuntimeDescriptors,
      moduleRuntimeArtifacts,
      projectModuleConsentRevisions,
      moduleRunners,
      moduleRunnerProfiles,
      moduleExecutions,
      moduleExecutionInputs,
      moduleExecutionLeases,
      moduleExecutionHeartbeats,
      moduleCapabilityGrants,
      moduleCapabilityUses,
      moduleExecutionEvents,
      moduleExecutionOutputs,
      moduleExecutionEvidence,
      moduleKillSwitchGenerations,
      moduleExecutionOutbox,
    }),
  );
});
