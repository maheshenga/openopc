import { describe, expect, test } from 'bun:test';

import { type Database, accountMembers, developerApplications } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  createDrizzleDeveloperApplicationRepository,
  serializeDeveloperApplication,
} from './applications.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const APPLICATION_ID = '40000000-0000-4000-a000-000000000001';
const NOW = '2026-07-28T08:00:00.000Z';

const applicationRow = {
  applicationId: APPLICATION_ID,
  accountId: ACCOUNT_ID,
  organizationId: ORGANIZATION_ID,
  state: 'submitted' as const,
  revision: 0,
  policyVersions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
  submittedAt: NOW,
  decidedAt: null,
  suspendedAt: null,
  decisionReason: null,
  createdBy: USER_ID,
  updatedBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function params(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('developer application Drizzle repository', () => {
  test('serializes the complete public application projection', () => {
    expect(serializeDeveloperApplication(applicationRow)).toEqual({
      application_id: APPLICATION_ID,
      account_id: ACCOUNT_ID,
      organization_id: ORGANIZATION_ID,
      state: 'submitted',
      revision: 0,
      policy_versions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
      submitted_at: NOW,
      decided_at: null,
      suspended_at: null,
      decision_reason: null,
      created_by: USER_ID,
      updated_by: null,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  test('reads current state only after an account and user membership fence', async () => {
    const conditions: unknown[] = [];
    const database = {
      select() {
        return {
          from(table: unknown) {
            return {
              where(condition: unknown) {
                conditions.push(condition);
                return {
                  async limit() {
                    if (table === accountMembers) return [{ userId: USER_ID }];
                    if (table === developerApplications) return [applicationRow];
                    throw new Error('unexpected table');
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperApplicationRepository(database);

    await expect(repository.current({ accountId: ACCOUNT_ID, userId: USER_ID })).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({
        application_id: APPLICATION_ID,
        account_id: ACCOUNT_ID,
        state: 'submitted',
      }),
    });
    expect(conditions.flatMap(params)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, USER_ID, ACCOUNT_ID]),
    );
  });
});
