import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import {
  automationApprovalPolicyEnum,
  automationApprovalStatusEnum,
  automationApprovals,
  automationBrowserProfileStatusEnum,
  automationBrowserProfiles,
  automationExecutionDomainEnum,
  automationJobEvents,
  automationJobStatusEnum,
  automationJobSteps,
  automationJobs,
  automationKillSwitchScopeEnum,
  automationKillSwitches,
  automationPolicies,
  automationRiskEnum,
  automationStepStatusEnum,
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

function checkConstraintNames(table: PgTable): string[] {
  return getTableConfig(table)
    .checks.map((constraint) => constraint.name)
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

describe('automation durable schema', () => {
  test('declares the version-one automation enum values', () => {
    expect(automationExecutionDomainEnum.enumValues).toEqual(['browser', 'desktop']);
    expect(automationRiskEnum.enumValues).toEqual(['observe', 'operate', 'external_effect']);
    expect(automationJobStatusEnum.enumValues).toEqual([
      'queued',
      'awaiting_approval',
      'dispatched',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'retryable',
    ]);
    expect(automationStepStatusEnum.enumValues).toEqual([
      'pending',
      'awaiting_approval',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'skipped',
    ]);
    expect(automationApprovalStatusEnum.enumValues).toEqual([
      'pending',
      'approved',
      'rejected',
      'expired',
      'consumed',
    ]);
    expect(automationApprovalPolicyEnum.enumValues).toEqual(['project-default', 'full-access']);
    expect(automationBrowserProfileStatusEnum.enumValues).toEqual(['active', 'revoked', 'expired']);
    expect(automationKillSwitchScopeEnum.enumValues).toEqual(['account', 'project', 'device']);
  });

  test('places all seven automation tables in the kortix schema', () => {
    const expectedNames = new Map<PgTable, string>([
      [automationJobs, 'automation_jobs'],
      [automationJobSteps, 'automation_job_steps'],
      [automationJobEvents, 'automation_job_events'],
      [automationApprovals, 'automation_approvals'],
      [automationPolicies, 'automation_policies'],
      [automationBrowserProfiles, 'automation_browser_profiles'],
      [automationKillSwitches, 'automation_kill_switches'],
    ]);

    for (const [table, expectedName] of expectedNames) {
      const config = getTableConfig(table);
      expect(config.schema).toBe('kortix');
      expect(config.name).toBe(expectedName);
    }
  });

  test('stores scoped jobs, leases, cancellation, policy snapshots, and targets', () => {
    expect(columnNames(automationJobs)).toEqual(
      expect.arrayContaining([
        'job_id',
        'account_id',
        'project_id',
        'actor_user_id',
        'source_run_id',
        'protocol_version',
        'execution_domain',
        'request_envelope',
        'request_hash',
        'idempotency_key',
        'status',
        'approval_policy',
        'policy_snapshot_hash',
        'browser_profile_id',
        'target_device_id',
        'lease_owner',
        'lease_expires_at',
        'cancel_requested_at',
        'kill_switch_generation',
        'deadline_at',
        'created_at',
        'updated_at',
        'terminal_at',
      ]),
    );
    expect(indexNames(automationJobs)).toEqual(
      expect.arrayContaining([
        'idx_automation_jobs_account_created',
        'idx_automation_jobs_project_created',
        'idx_automation_jobs_claimable',
        'idx_automation_jobs_browser_profile',
        'idx_automation_jobs_target_device',
      ]),
    );
  });

  test('prevents duplicate project idempotency keys and event sequences', () => {
    expect(uniqueConstraintNames(automationJobs)).toContain(
      'automation_jobs_project_idempotency_unique',
    );
    expect(uniqueConstraintNames(automationJobEvents)).toContain(
      'automation_job_events_job_sequence_unique',
    );
    expect(checkConstraintNames(automationJobEvents)).toContain(
      'automation_job_events_sequence_positive_check',
    );
    expect(columnNames(automationJobEvents)).toEqual(
      expect.arrayContaining(['worker_id', 'worker_lease_id', 'worker_ordinal']),
    );
    expect(indexNames(automationJobEvents)).toContain(
      'idx_automation_job_events_worker_ordinal_unique',
    );
    expect(checkConstraintNames(automationJobEvents)).toContain(
      'automation_job_events_worker_receipt_check',
    );
    const receiptCheck = checkConstraintSql(
      automationJobEvents,
      'automation_job_events_worker_receipt_check',
    );
    expect(receiptCheck).toContain('"worker_id" IS NOT NULL');
    expect(receiptCheck).toContain('"worker_lease_id" IS NOT NULL');
    expect(receiptCheck).toContain('"worker_ordinal" IS NOT NULL');
  });

  test('binds persistent profiles and approvals to the same project and job', () => {
    expect(uniqueConstraintNames(automationBrowserProfiles)).toContain(
      'automation_browser_profiles_project_profile_unique',
    );
    expect(uniqueConstraintNames(automationJobSteps)).toContain(
      'automation_job_steps_job_step_unique',
    );

    expect(foreignKeys(automationJobs)).toContainEqual({
      name: 'automation_jobs_project_profile_fk',
      columns: ['project_id', 'browser_profile_id'],
      foreignColumns: ['project_id', 'profile_id'],
      foreignTable: 'automation_browser_profiles',
      onDelete: 'restrict',
    });
    expect(foreignKeys(automationApprovals)).toContainEqual({
      name: 'automation_approvals_job_step_fk',
      columns: ['job_id', 'step_id'],
      foreignColumns: ['job_id', 'step_id'],
      foreignTable: 'automation_job_steps',
      onDelete: 'cascade',
    });
  });

  test('cascades job-owned steps, events, and approvals without touching tunnel tables', () => {
    for (const table of [automationJobSteps, automationJobEvents, automationApprovals]) {
      expect(foreignKeys(table)).toContainEqual(
        expect.objectContaining({
          columns: ['job_id'],
          foreignColumns: ['job_id'],
          foreignTable: 'automation_jobs',
          onDelete: 'cascade',
        }),
      );
    }
  });

  test('indexes project policy, profile, approval, and kill-switch access paths', () => {
    expect(indexNames(automationPolicies)).toContain('idx_automation_policies_updated');
    expect(indexNames(automationBrowserProfiles)).toEqual(
      expect.arrayContaining([
        'idx_automation_browser_profiles_project_status',
        'idx_automation_browser_profiles_expiry',
      ]),
    );
    expect(indexNames(automationApprovals)).toEqual(
      expect.arrayContaining([
        'idx_automation_approvals_job_status',
        'idx_automation_approvals_expiry',
      ]),
    );
    expect(indexNames(automationKillSwitches)).toEqual(
      expect.arrayContaining([
        'idx_automation_kill_switches_account_active',
        'idx_automation_kill_switches_project_active',
        'idx_automation_kill_switches_device_active',
      ]),
    );
  });

  test('defines checks for hashes, lease pairs, JSON shape, profile state, and kill scope', () => {
    expect(checkConstraintNames(automationJobs)).toEqual(
      expect.arrayContaining([
        'automation_jobs_request_hash_check',
        'automation_jobs_policy_snapshot_hash_check',
        'automation_jobs_lease_pair_check',
        'automation_jobs_target_check',
      ]),
    );
    expect(checkConstraintNames(automationPolicies)).toContain(
      'automation_policies_allowed_origins_check',
    );
    expect(checkConstraintNames(automationBrowserProfiles)).toContain(
      'automation_browser_profiles_state_check',
    );
    expect(checkConstraintNames(automationKillSwitches)).toEqual(
      expect.arrayContaining([
        'automation_kill_switches_scope_check',
        'automation_kill_switches_generation_check',
        'automation_kill_switches_release_check',
      ]),
    );
  });
});

describe('automation migration', () => {
  test('creates the isolated automation schema objects idempotently', () => {
    const migration = readFileSync(
      join(import.meta.dir, '..', 'migrations', '20260721140000000_automation_control.sql'),
      'utf8',
    );

    for (const table of [
      'automation_policies',
      'automation_browser_profiles',
      'automation_jobs',
      'automation_job_steps',
      'automation_approvals',
      'automation_job_events',
      'automation_kill_switches',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS kortix.${table}`);
    }
    expect(migration).toContain('CREATE OR REPLACE FUNCTION kortix.set_automation_updated_at()');
    expect(migration).toContain('CREATE TRIGGER automation_jobs_set_updated_at');
    expect(migration).toContain('CREATE TRIGGER automation_policies_set_updated_at');
    expect(migration).toContain('CREATE TRIGGER automation_browser_profiles_set_updated_at');
    expect(migration).not.toMatch(/(?:ALTER|DROP|CREATE)\s+TABLE\s+kortix\.tunnel_/i);
  });

  test('adds lease-scoped worker ordinal fencing without rewriting the original migration', () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        '..',
        'migrations',
        '20260722100000000_automation_heartbeat_durability.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('ALTER TABLE kortix.automation_job_events');
    expect(migration).toContain('worker_lease_id uuid');
    expect(migration).toContain('automation_job_events_worker_receipt_check');
    expect(migration).toContain('worker_id IS NOT NULL');
    expect(migration).toContain('worker_lease_id IS NOT NULL');
    expect(migration).toContain('worker_ordinal IS NOT NULL');
    expect(migration).toContain('idx_automation_job_events_worker_ordinal_unique');
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });
});
