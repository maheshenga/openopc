import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';

import * as databaseExports from './index';
import {
  accountRequestKindEnum,
  accountRequestStatusEnum,
  accountRequests,
  developerApplicationStateEnum,
  developerApplications,
  policyAcceptancePolicyEnum,
  policyAcceptanceSourceEnum,
  policyAcceptances,
} from './schema/kortix';

describe('public beta identity schema', () => {
  test('exports exact policy, request, and developer application contracts', () => {
    expect(policyAcceptancePolicyEnum.enumValues).toEqual([
      'terms',
      'privacy',
      'acceptable_use',
      'module_rules',
    ]);
    expect(policyAcceptanceSourceEnum.enumValues).toEqual([
      'registration',
      'developer_application',
      'settings',
    ]);
    expect(accountRequestKindEnum.enumValues).toEqual([
      'data_export',
      'account_deletion',
      'security_report',
      'module_report',
    ]);
    expect(accountRequestStatusEnum.enumValues).toEqual([
      'pending',
      'cooling_off',
      'processing',
      'completed',
      'cancelled',
      'rejected',
      'expired',
    ]);
    expect(developerApplicationStateEnum.enumValues).toEqual([
      'draft',
      'submitted',
      'under_review',
      'approved',
      'rejected',
      'suspended',
    ]);
  });

  test('uses account-qualified membership, module, and organization foreign keys', () => {
    const policies = getTableConfig(policyAcceptances);
    expect(policies.name).toBe('policy_acceptances');
    expect(policies.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      'policy_acceptances_account_user_policy_version_unique',
    );
    expect(
      policies.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    ).toContainEqual(['account_id', 'user_id']);

    const requests = getTableConfig(accountRequests);
    expect(requests.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'account_requests_request_account_unique',
        'account_requests_account_user_idempotency_unique',
      ]),
    );
    expect(
      requests.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['account_id', 'requested_by'],
        ['module_installation_id', 'account_id'],
      ]),
    );

    const applications = getTableConfig(developerApplications);
    expect(
      applications.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['organization_id', 'account_id'],
        ['account_id', 'created_by'],
      ]),
    );
  });

  test('bounds state, policy versions, idempotency, reports, and audit-safe metadata', () => {
    expect(getTableConfig(policyAcceptances).checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'policy_acceptances_version_check',
        'policy_acceptances_source_check',
        'policy_acceptances_metadata_check',
      ]),
    );
    expect(getTableConfig(accountRequests).checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'account_requests_reason_check',
        'account_requests_idempotency_check',
        'account_requests_request_hash_check',
        'account_requests_module_check',
        'account_requests_state_check',
        'account_requests_metadata_check',
      ]),
    );
    expect(getTableConfig(developerApplications).checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'developer_applications_revision_check',
        'developer_applications_policy_check',
        'developer_applications_state_check',
        'developer_applications_reason_check',
      ]),
    );
  });

  test('migration makes policies append-only and exposes only bounded service-role mutation', () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        '..',
        'migrations',
        '20260728100000000_public_beta_identity_requests.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('policy_acceptances_append_only');
    expect(migration).toContain('account_requests_guard_mutation');
    expect(migration).toContain('complete_public_registration_decision');
    expect(migration).toMatch(/ALTER TABLE kortix\.policy_acceptances ENABLE ROW LEVEL SECURITY/i);
    expect(migration).not.toMatch(/GRANT\s+(?:UPDATE|DELETE)[^;]*policy_acceptances/i);
    expect(migration).not.toMatch(/GRANT\s+DELETE[^;]*account_requests/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  test('exports all identity tables from the database package root', () => {
    expect(databaseExports.policyAcceptances).toBe(policyAcceptances);
    expect(databaseExports.accountRequests).toBe(accountRequests);
    expect(databaseExports.developerApplications).toBe(developerApplications);
  });
});
