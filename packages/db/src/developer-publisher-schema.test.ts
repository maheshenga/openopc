import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';

import * as databaseExports from './index';
import {
  developerInvitationStateEnum,
  developerInvitations,
  developerOrganizationVerificationStateEnum,
  developerOrganizations,
  developerPublisherAuditEvents,
  developerPublisherMembers,
  developerPublisherRoleEnum,
  developerPublishers,
} from './schema/kortix';

describe('developer publisher authority schema', () => {
  test('exports invitation, verification, Publisher role, and audit tables', () => {
    expect(developerInvitationStateEnum.enumValues).toEqual([
      'pending',
      'accepted',
      'expired',
      'revoked',
    ]);
    expect(developerOrganizationVerificationStateEnum.enumValues).toEqual([
      'pending',
      'verified',
      'rejected',
      'suspended',
    ]);
    expect(developerPublisherRoleEnum.enumValues).toEqual([
      'owner',
      'developer',
      'release_manager',
      'finance_viewer',
      'support_viewer',
    ]);
    expect(
      [
        developerInvitations,
        developerOrganizations,
        developerPublishers,
        developerPublisherMembers,
        developerPublisherAuditEvents,
      ].map((table) => getTableConfig(table).name),
    ).toEqual([
      'developer_invitations',
      'developer_organizations',
      'developer_publishers',
      'developer_publisher_members',
      'developer_publisher_audit_events',
    ]);
  });

  test('globally fences Publisher slug and tenant-qualified organization ownership', () => {
    const config = getTableConfig(developerPublishers);
    const slug = config.columns.find((column) => column.name === 'slug');
    expect(slug?.isUnique).toBe(true);
    expect(slug?.uniqueName).toBe('developer_publishers_slug_unique');
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'organization_id',
        'slug',
        'status',
        'authority_revision',
        'suspended_reason',
        'suspended_by',
        'suspended_at',
      ]),
    );

    const organizationForeignKey = config.foreignKeys
      .map((foreignKey) => foreignKey.reference())
      .find((reference) => reference.foreignTable === developerOrganizations);
    expect(organizationForeignKey?.columns.map((column) => column.name)).toEqual([
      'organization_id',
      'account_id',
    ]);
    expect(organizationForeignKey?.foreignColumns.map((column) => column.name)).toEqual([
      'organization_id',
      'account_id',
    ]);
  });

  test('stores only unique invitation token hashes with state-consistent timestamps', () => {
    const config = getTableConfig(developerInvitations);
    const tokenHash = config.columns.find((column) => column.name === 'token_hash');
    expect(tokenHash?.isUnique).toBe(true);
    expect(tokenHash?.uniqueName).toBe('developer_invitations_token_hash_unique');
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'developer_invitations_token_hash_check',
        'developer_invitations_email_check',
        'developer_invitations_expiry_check',
        'developer_invitations_state_check',
      ]),
    );
  });

  test('bounds organization verification, member revisions, and audit records', () => {
    const organizations = getTableConfig(developerOrganizations);
    expect(organizations.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'developer_organizations_organization_account_unique',
        'developer_organizations_account_unique',
      ]),
    );
    expect(organizations.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'developer_organizations_name_check',
        'developer_organizations_metadata_check',
        'developer_organizations_revision_check',
        'developer_organizations_verification_transition_check',
      ]),
    );

    const members = getTableConfig(developerPublisherMembers);
    expect(members.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'developer_publisher_members_member_account_unique',
        'developer_publisher_members_publisher_user_unique',
      ]),
    );
    expect(members.checks.map((constraint) => constraint.name)).toContain(
      'developer_publisher_members_revision_check',
    );

    const audit = getTableConfig(developerPublisherAuditEvents);
    expect(audit.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      'developer_publisher_audit_events_event_account_unique',
    );
    expect(audit.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'developer_publisher_audit_events_resource_check',
        'developer_publisher_audit_events_action_check',
        'developer_publisher_audit_events_json_check',
      ]),
    );
  });

  test('migration enforces case-folded slug, owner presence, and append-only audit', () => {
    const migration = readFileSync(
      join(import.meta.dir, '..', 'migrations', '20260726100000000_developer_publishers.sql'),
      'utf8',
    );

    expect(migration).toContain('idx_developer_publishers_slug_lower_unique');
    expect(migration).toContain('lower(slug)');
    expect(migration).toContain('developer_publishers_owner_present');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('developer_publisher_audit_events_append_only');
    expect(migration).toMatch(
      /GRANT\s+SELECT,\s*INSERT[\s\S]*developer_publisher_audit_events[\s\S]*TO service_role/i,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:UPDATE|DELETE)[^;]*developer_publisher_audit_events/i,
    );
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  test('exports Publisher authority tables and enums from the database package root', () => {
    expect(databaseExports.developerInvitations).toBe(developerInvitations);
    expect(databaseExports.developerOrganizations).toBe(developerOrganizations);
    expect(databaseExports.developerPublisherMembers).toBe(developerPublisherMembers);
    expect(databaseExports.developerPublisherAuditEvents).toBe(developerPublisherAuditEvents);
    expect(databaseExports.developerPublisherRoleEnum).toBe(developerPublisherRoleEnum);
  });
});
