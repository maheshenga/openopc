import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import type {
  DeveloperModuleArtifact,
  DeveloperModuleArtifactUpload,
  DeveloperModuleTrustAttestation,
  DeveloperModuleVerificationCapability,
  DeveloperModuleVerificationFinding,
  DeveloperModuleVerificationRun,
} from './types';

type DeveloperTrustSelectTypes = [
  DeveloperModuleArtifactUpload,
  DeveloperModuleArtifact,
  DeveloperModuleVerificationRun,
  DeveloperModuleVerificationFinding,
  DeveloperModuleTrustAttestation,
  DeveloperModuleVerificationCapability,
];

const trustTypeCount: DeveloperTrustSelectTypes['length'] = 6;

const migrationPath = join(
  import.meta.dir,
  '..',
  'migrations',
  '20260725120000000_developer_module_trust.sql',
);

function migrationSql(): string {
  return existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
}

function table(value: unknown): PgTable {
  return value as PgTable;
}

function columnNames(value: unknown): string[] {
  return getTableConfig(table(value)).columns.map((column) => column.name);
}

function indexNames(value: unknown): string[] {
  return getTableConfig(table(value))
    .indexes.map((index) => index.config.name)
    .filter((name): name is string => name !== undefined);
}

function uniqueConstraintNames(value: unknown): string[] {
  return getTableConfig(table(value))
    .uniqueConstraints.map((constraint) => constraint.name)
    .filter((name): name is string => name !== undefined);
}

function checkConstraintSql(value: unknown, name: string): string {
  const constraint = getTableConfig(table(value)).checks.find(
    (candidate) => candidate.name === name,
  );
  if (!constraint) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

function foreignKeys(value: unknown) {
  return getTableConfig(table(value)).foreignKeys.map((foreignKey) => {
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

describe('developer module trust migration', () => {
  test('fails clearly instead of retaining schema-1 signed or published rows', () => {
    const migration = migrationSql();

    expect(migration).toContain('OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED');
    expect(migration).toMatch(/status IN \('signed', 'published'\)/);
    expect(migration).toContain('signature_payload_digest IS NOT NULL');
    expect(migration).not.toContain('signature schema 1 compatibility');
  });

  test('creates service-only immutable trust records and a narrow worker role', () => {
    const migration = migrationSql();

    for (const name of [
      'developer_module_artifact_uploads',
      'developer_module_artifacts',
      'developer_module_verification_runs',
      'developer_module_verification_findings',
      'developer_module_trust_attestations',
      'developer_module_verification_capabilities',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS kortix.${name}`);
    }
    expect(migration).toContain('developer_module_artifacts_append_only');
    expect(migration).toContain('developer_module_verification_findings_append_only');
    expect(migration).toContain('developer_module_trust_attestations_append_only');
    expect(migration).toContain('CREATE ROLE developer_trust_worker NOLOGIN');
    expect(migration).toMatch(/REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(migration).not.toMatch(/GRANT .* TO (?:anon|authenticated)/i);
  });

  test('limits running verification updates to lease heartbeat fields', () => {
    const migration = migrationSql();
    const guard = migration.match(
      /IF OLD\.state = 'running' AND NEW\.state = 'running' THEN([\s\S]*?)END IF;/,
    );

    expect(guard).not.toBeNull();
    expect(guard?.[1]).toContain(
      'running developer module verification runs only accept lease heartbeat updates',
    );
    for (const column of [
      'terminal_reason',
      'sbom_digest',
      'attestation_digest',
      'resource_summary',
      'started_at',
      'finished_at',
    ]) {
      expect(guard?.[1]).toContain(`NEW.${column}`);
    }
  });
});

describe('developer module trust Drizzle schema', () => {
  test('publishes one select type for every trust record', () => {
    expect(trustTypeCount).toBe(6);
  });

  test('declares bounded artifact and verification state enums', async () => {
    const schema = await import('./schema/kortix');

    expect(schema.developerArtifactUploadStateEnum?.enumValues).toEqual([
      'created',
      'uploaded',
      'finalized',
      'cancelled',
      'expired',
    ]);
    expect(schema.developerVerificationStateEnum?.enumValues).toEqual([
      'queued',
      'running',
      'passed',
      'failed',
      'inconclusive',
      'cancelled',
    ]);
    expect(schema.developerFindingSeverityEnum?.enumValues).toEqual([
      'info',
      'low',
      'medium',
      'high',
      'critical',
    ]);
  });

  test('stores artifact uploads and immutable finalized artifacts', async () => {
    const schema = await import('./schema/kortix');
    const uploads = schema.developerModuleArtifactUploads;
    const artifacts = schema.developerModuleArtifacts;

    expect(uploads).toBeDefined();
    expect(artifacts).toBeDefined();
    expect(columnNames(uploads)).toEqual(
      expect.arrayContaining([
        'upload_id',
        'account_id',
        'publisher_id',
        'state',
        'expected_digest',
        'expected_size',
        'staging_storage_key',
        'expires_at',
        'created_by',
        'created_at',
        'updated_at',
      ]),
    );
    expect(columnNames(artifacts)).toEqual(
      expect.arrayContaining([
        'artifact_id',
        'account_id',
        'publisher_id',
        'artifact_digest',
        'envelope_digest',
        'storage_key',
        'media_type',
        'size_bytes',
        'item_snapshot',
        'source_provenance',
        'created_by',
        'created_at',
      ]),
    );
    expect(uniqueConstraintNames(artifacts)).toEqual(
      expect.arrayContaining([
        'developer_module_artifacts_artifact_account_unique',
        'developer_module_artifacts_account_digest_unique',
      ]),
    );
  });

  test('stores leased runs, sanitized findings, attestations, and hashed capabilities', async () => {
    const schema = await import('./schema/kortix');

    expect(columnNames(schema.developerModuleVerificationRuns)).toEqual(
      expect.arrayContaining([
        'run_id',
        'release_id',
        'artifact_id',
        'account_id',
        'policy_digest',
        'scanner_set_digest',
        'sandbox_profile_digest',
        'attempt',
        'state',
        'lease_owner',
        'lease_token_hash',
        'lease_expires_at',
        'heartbeat_at',
        'terminal_reason',
        'sbom_digest',
        'attestation_digest',
        'resource_summary',
        'started_at',
        'finished_at',
        'created_at',
        'updated_at',
      ]),
    );
    expect(columnNames(schema.developerModuleVerificationFindings)).toEqual(
      expect.arrayContaining([
        'finding_id',
        'run_id',
        'account_id',
        'fingerprint',
        'scanner',
        'rule_id',
        'severity',
        'path',
        'location',
        'summary',
        'disposition',
        'created_at',
      ]),
    );
    expect(columnNames(schema.developerModuleTrustAttestations)).toEqual(
      expect.arrayContaining([
        'attestation_id',
        'run_id',
        'account_id',
        'attestation_digest',
        'subject_artifact_digest',
        'predicate_type',
        'policy_digest',
        'result',
        'sbom_digest',
        'dsse_envelope',
        'issuer',
        'created_at',
      ]),
    );
    expect(columnNames(schema.developerModuleVerificationCapabilities)).toEqual(
      expect.arrayContaining([
        'capability_id',
        'run_id',
        'account_id',
        'sandbox_instance_id',
        'audience',
        'token_hash',
        'nonce_hash',
        'allowed_actions',
        'max_calls',
        'calls_used',
        'max_payload_bytes',
        'payload_bytes_used',
        'expires_at',
        'revoked_at',
        'created_at',
        'updated_at',
      ]),
    );
    expect(indexNames(schema.developerModuleVerificationRuns)).toContain(
      'idx_developer_module_verification_runs_active_unique',
    );
  });

  test('uses account-qualified foreign keys for every tenant-owned identifier', async () => {
    const schema = await import('./schema/kortix');

    expect(foreignKeys(schema.developerModuleArtifacts)).toContainEqual({
      name: 'developer_module_artifacts_publisher_account_fk',
      columns: ['publisher_id', 'account_id'],
      foreignColumns: ['publisher_id', 'account_id'],
      foreignTable: 'developer_publishers',
      onDelete: 'restrict',
    });
    expect(foreignKeys(schema.developerModuleVerificationRuns)).toEqual(
      expect.arrayContaining([
        {
          name: 'developer_module_verification_runs_release_account_fk',
          columns: ['release_id', 'account_id', 'artifact_id'],
          foreignColumns: ['release_id', 'account_id', 'artifact_id'],
          foreignTable: 'developer_module_releases',
          onDelete: 'cascade',
        },
        {
          name: 'developer_module_verification_runs_artifact_account_fk',
          columns: ['artifact_id', 'account_id'],
          foreignColumns: ['artifact_id', 'account_id'],
          foreignTable: 'developer_module_artifacts',
          onDelete: 'restrict',
        },
      ]),
    );
    for (const [value, name] of [
      [
        schema.developerModuleVerificationFindings,
        'developer_module_verification_findings_run_account_fk',
      ],
      [
        schema.developerModuleTrustAttestations,
        'developer_module_trust_attestations_run_account_fk',
      ],
      [
        schema.developerModuleVerificationCapabilities,
        'developer_module_verification_capabilities_run_account_fk',
      ],
    ] as const) {
      expect(foreignKeys(value)).toContainEqual(
        expect.objectContaining({
          name,
          columns: ['run_id', 'account_id'],
          foreignColumns: ['run_id', 'account_id'],
        }),
      );
    }
  });

  test('binds release trust columns to the artifact account and gates distribution', async () => {
    const schema = await import('./schema/kortix');
    const releases = schema.developerModuleReleases;

    expect(columnNames(releases)).toEqual(
      expect.arrayContaining([
        'artifact_id',
        'artifact_digest',
        'sbom_digest',
        'trust_attestation_digest',
        'verification_policy_digest',
      ]),
    );
    expect(foreignKeys(releases)).toContainEqual({
      name: 'developer_module_releases_artifact_account_fk',
      columns: ['artifact_id', 'account_id'],
      foreignColumns: ['artifact_id', 'account_id'],
      foreignTable: 'developer_module_artifacts',
      onDelete: 'restrict',
    });
    expect(
      checkConstraintSql(releases, 'developer_module_releases_trust_before_distribution_check'),
    ).toMatch(/signed[\s\S]*published[\s\S]*artifact_digest[\s\S]*sbom_digest[\s\S]*policy/);
  });

  test('exports all trust tables and enums from the database package', async () => {
    const db = await import('./index');

    for (const name of [
      'developerArtifactUploadStateEnum',
      'developerVerificationStateEnum',
      'developerFindingSeverityEnum',
      'developerModuleArtifactUploads',
      'developerModuleArtifacts',
      'developerModuleVerificationRuns',
      'developerModuleVerificationFindings',
      'developerModuleTrustAttestations',
      'developerModuleVerificationCapabilities',
    ]) {
      expect(db).toHaveProperty(name);
    }
  });
});
