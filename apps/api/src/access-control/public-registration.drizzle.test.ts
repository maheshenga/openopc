import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';

import type { PublicRegistrationStoredDecision } from './public-registration';
import { createDrizzlePublicRegistrationStore } from './public-registration.drizzle';

const DECISION: PublicRegistrationStoredDecision = {
  jtiHash: `sha256:${'a'.repeat(64)}`,
  emailDigest: `sha256:${'b'.repeat(64)}`,
  deviceDigest: `sha256:${'c'.repeat(64)}`,
  accountDigest: `sha256:${'d'.repeat(64)}`,
  action: 'signup',
  policyVersions: {
    terms: '2026-07-28',
    privacy: '2026-07-28',
    acceptableUse: '2026-07-28',
  },
  issuedAt: '2026-07-28T12:00:00.000Z',
  expiresAt: '2026-07-28T12:05:00.000Z',
};

const DIMENSIONS = [
  {
    kind: 'ip' as const,
    keyHash: `sha256:${'e'.repeat(64)}` as const,
    limit: 30,
    windowSeconds: 300,
  },
  {
    kind: 'device' as const,
    keyHash: `sha256:${'f'.repeat(64)}` as const,
    limit: 10,
    windowSeconds: 300,
  },
];

describe('public registration Drizzle store', () => {
  test('maps atomic database function results from both supported driver row shapes', async () => {
    const results: unknown[] = [
      [{ allowed: true }],
      { rows: [{ consumed: false }] },
      [{ completed: true }],
    ];
    const database = {
      execute: async () => results.shift(),
    } as unknown as Database;
    const store = createDrizzlePublicRegistrationStore(database);

    expect(
      await store.consumeRateLimit({
        dimensions: DIMENSIONS,
        persistDecision: true,
        decision: DECISION,
      }),
    ).toEqual({ allowed: true });
    expect(
      await store.consumeDecision({
        jtiHash: DECISION.jtiHash,
        now: new Date('2026-07-28T12:01:00.000Z'),
      }),
    ).toBe(false);
    expect(
      await store.completeDecision({
        jtiHash: DECISION.jtiHash,
        now: new Date('2026-07-28T12:01:00.000Z'),
        accountId: '11111111-1111-4111-8111-111111111111',
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        decision: DECISION,
      }),
    ).toBe(true);
  });

  test('fails closed on missing or malformed function results', async () => {
    for (const result of [[], [{ allowed: 'true' }], { rows: [] }]) {
      const database = { execute: async () => result } as unknown as Database;
      const store = createDrizzlePublicRegistrationStore(database);
      await expect(
        store.consumeRateLimit({
          dimensions: DIMENSIONS,
          persistDecision: true,
          decision: DECISION,
        }),
      ).rejects.toThrow('PUBLIC_REGISTRATION_DATABASE_RESULT_INVALID');
    }
  });
});
