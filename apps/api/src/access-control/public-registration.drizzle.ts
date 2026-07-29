import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import type { PublicRegistrationDependencies } from './public-registration';

type PublicRegistrationStore = Pick<
  PublicRegistrationDependencies,
  'consumeRateLimit' | 'consumeDecision' | 'completeDecision'
>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    typeof result === 'object' &&
    result !== null &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function booleanResult(result: unknown, key: string): boolean {
  const row = resultRows<Record<string, unknown>>(result)[0];
  if (!row || typeof row[key] !== 'boolean') {
    throw new Error('PUBLIC_REGISTRATION_DATABASE_RESULT_INVALID');
  }
  return row[key];
}

export function createDrizzlePublicRegistrationStore(db: Database): PublicRegistrationStore {
  return Object.freeze({
    async consumeRateLimit(input) {
      const result = await db.execute(sql`
        SELECT kortix.authorize_public_registration_decision(
          ${JSON.stringify(input.dimensions)}::jsonb,
          ${input.persistDecision}::boolean,
          ${input.decision.jtiHash}::varchar,
          ${input.decision.emailDigest}::varchar,
          ${input.decision.deviceDigest}::varchar,
          ${input.decision.accountDigest ?? null}::varchar,
          ${input.decision.action}::varchar,
          ${JSON.stringify(input.decision.policyVersions)}::jsonb,
          ${input.decision.issuedAt}::timestamptz,
          ${input.decision.expiresAt}::timestamptz
        ) AS allowed
      `);
      return { allowed: booleanResult(result, 'allowed') };
    },

    async consumeDecision(input) {
      const result = await db.execute(sql`
        SELECT kortix.consume_public_registration_decision(
          ${input.jtiHash}::varchar,
          ${input.now.toISOString()}::timestamptz
        ) AS consumed
      `);
      return booleanResult(result, 'consumed');
    },

    async completeDecision(input) {
      const result = await db.execute(sql`
        SELECT kortix.complete_public_registration_decision(
          ${input.jtiHash}::varchar,
          ${input.now.toISOString()}::timestamptz,
          ${input.accountId}::uuid,
          ${input.userId}::uuid
        ) AS completed
      `);
      return booleanResult(result, 'completed');
    },
  });
}
