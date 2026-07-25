import { describe, expect, test } from 'bun:test';

import {
  DeveloperVerificationCapabilityError,
  VERIFICATION_CAPABILITY_AUDIENCE,
  createMemoryVerificationCapabilityBroker,
} from './broker';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const issuedAt = '2026-07-25T00:00:00.000Z';

function grantInput() {
  return {
    releaseId: '30000000-0000-4000-a000-000000000003',
    artifactDigest: digest('a'),
    runId: '50000000-0000-4000-a000-000000000005',
    sandboxInstanceId: 'sandbox-instance-1',
    fixtures: [
      { action: 'synthetic.search', response: { items: [{ title: 'Synthetic result' }] } },
    ],
    issuedAt,
    expiresAt: '2026-07-25T00:05:00.000Z',
    nonce: 'nonce-fixture-1234567890',
    policyDigest: digest('b'),
    maxCalls: 1,
    maxPayloadBytes: 1_024,
  } as const;
}

function authorization(token: string) {
  return {
    token,
    audience: VERIFICATION_CAPABILITY_AUDIENCE,
    nonce: 'nonce-fixture-1234567890',
    runId: '50000000-0000-4000-a000-000000000005',
    sandboxInstanceId: 'sandbox-instance-1',
    action: 'synthetic.search',
    payloadBytes: 128,
    now: '2026-07-25T00:01:00.000Z',
  } as const;
}

describe('verification capability broker', () => {
  test('stores only token/nonce hashes and atomically enforces calls and bytes', async () => {
    const { broker, snapshot } = createMemoryVerificationCapabilityBroker({
      tokenFactory: () => 'verification-token-fixture-1234567890',
    });
    const grant = await broker.issue(grantInput());
    const stored = JSON.stringify(snapshot());
    expect(stored).not.toContain(grant.token);
    expect(stored).not.toContain(grantInput().nonce);
    expect(stored).toMatch(/tokenHash|nonceHash/);

    const attempts = await Promise.allSettled([
      broker.authorize(authorization(grant.token)),
      broker.authorize(authorization(grant.token)),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(snapshot()[0]).toMatchObject({ callsUsed: 1, payloadBytesUsed: 128 });
  });

  test.each([
    ['wrong audience', { audience: 'general-api' }],
    ['wrong nonce', { nonce: 'wrong-nonce' }],
    ['wrong sandbox', { sandboxInstanceId: 'stale-sandbox' }],
    ['undeclared action', { action: 'connector.read' }],
    ['expired', { now: '2026-07-25T00:06:00.000Z' }],
    ['payload limit', { payloadBytes: 2_048 }],
  ] as const)('denies %s and records bounded evidence', async (_label, patch) => {
    const { broker } = createMemoryVerificationCapabilityBroker({
      tokenFactory: () => 'verification-token-fixture-1234567890',
    });
    const grant = await broker.issue(grantInput());
    await expect(
      broker.authorize({ ...authorization(grant.token), ...patch }),
    ).rejects.toBeInstanceOf(DeveloperVerificationCapabilityError);
    expect(await broker.evidence(grantInput().runId)).toEqual([
      expect.objectContaining({ outcome: 'denied' }),
    ]);
  });

  test('revokes all capabilities for a terminal run', async () => {
    const { broker } = createMemoryVerificationCapabilityBroker({
      tokenFactory: () => 'verification-token-fixture-1234567890',
    });
    const grant = await broker.issue(grantInput());
    await broker.revokeRun(grantInput().runId);
    await expect(broker.authorize(authorization(grant.token))).rejects.toMatchObject({
      code: 'DEVELOPER_VERIFICATION_CAPABILITY_DENIED',
    });
  });
});
