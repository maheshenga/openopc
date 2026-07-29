import { describe, expect, test } from 'bun:test';
import {
  type PublicRegistrationDependencies,
  type PublicRegistrationInput,
  createPublicRegistrationService,
} from './public-registration';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const HMAC_KEY = new TextEncoder().encode('openopc-public-registration-test-key-32-bytes');

function validInput(overrides: Partial<PublicRegistrationInput> = {}): PublicRegistrationInput {
  return {
    email: ' Person@Example.com ',
    challengeToken: 'turnstile-response-token',
    deviceId: 'device-installation-01',
    clientIp: '203.0.113.10',
    action: 'signup',
    policyVersions: {
      terms: '2026-07-28',
      privacy: '2026-07-28',
      acceptableUse: '2026-07-28',
    },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PublicRegistrationDependencies> = {},
): PublicRegistrationDependencies {
  const consumed = new Set<string>();
  return {
    hmacKey: HMAC_KEY,
    allowedChallengeHostnames: ['staging.openopc.example'],
    now: () => new Date(NOW),
    randomBytes: () => new Uint8Array(32).fill(7),
    verifyChallenge: async () => ({
      valid: true,
      action: 'signup',
      hostname: 'staging.openopc.example',
    }),
    canSignUp: async () => ({ allowed: true, accountId: 'account-01' }),
    consumeRateLimit: async () => ({ allowed: true }),
    consumeDecision: async ({ jtiHash }) => {
      if (consumed.has(jtiHash)) return false;
      consumed.add(jtiHash);
      return true;
    },
    completeDecision: async ({ jtiHash }) => {
      if (consumed.has(jtiHash)) return false;
      consumed.add(jtiHash);
      return true;
    },
    ...overrides,
  };
}

describe('public registration authority', () => {
  test('issues a five-minute one-time decision bound only to digests and exact policies', async () => {
    const durableInputs: Array<Parameters<PublicRegistrationDependencies['consumeRateLimit']>[0]> =
      [];
    const service = createPublicRegistrationService(
      dependencies({
        consumeRateLimit: async (input) => {
          durableInputs.push(input);
          return { allowed: true };
        },
      }),
    );

    const decision = await service.preflight(validInput());

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected an allowed decision');
    expect(decision.expiresAt).toBe('2026-07-28T12:05:00.000Z');
    expect(decision.decisionToken.split('.')).toHaveLength(2);
    const durableInput = durableInputs[0];
    expect(durableInput).toBeDefined();
    expect(durableInput?.persistDecision).toBe(true);
    expect(durableInput?.dimensions.map((dimension) => dimension.kind)).toEqual([
      'ip',
      'device',
      'email',
      'account',
      'action',
    ]);
    expect(durableInput?.decision.policyVersions).toEqual({
      terms: '2026-07-28',
      privacy: '2026-07-28',
      acceptableUse: '2026-07-28',
    });
    expect(JSON.stringify(durableInput)).not.toContain('Person@Example.com');
    expect(JSON.stringify(durableInput)).not.toContain('device-installation-01');
    expect(decision.decisionToken).not.toContain('example.com');
    expect(decision.decisionToken).not.toContain('device-installation-01');
  });

  test('rejects missing tokens and invalid challenge action or hostname', async () => {
    const missing = createPublicRegistrationService(dependencies());
    expect(await missing.preflight(validInput({ challengeToken: '' }))).toEqual({
      allowed: false,
      code: 'REGISTRATION_DENIED',
    });

    for (const challenge of [
      { valid: true, action: 'magic-link', hostname: 'staging.openopc.example' },
      { valid: true, action: 'signup', hostname: 'evil.example' },
      { valid: false, action: 'signup', hostname: 'staging.openopc.example' },
    ]) {
      const service = createPublicRegistrationService(
        dependencies({ verifyChallenge: async () => challenge }),
      );
      expect(await service.preflight(validInput())).toEqual({
        allowed: false,
        code: 'REGISTRATION_DENIED',
      });
    }
  });

  test('fails closed when challenge, access policy, or durable storage is unavailable', async () => {
    for (const override of [
      { verifyChallenge: async () => Promise.reject(new Error('turnstile timeout')) },
      { canSignUp: async () => Promise.reject(new Error('access cache unavailable')) },
      { consumeRateLimit: async () => Promise.reject(new Error('database unavailable')) },
    ] satisfies Array<Partial<PublicRegistrationDependencies>>) {
      const service = createPublicRegistrationService(dependencies(override));
      expect(await service.preflight(validInput())).toEqual({
        allowed: false,
        code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE',
      });
    }
  });

  test('reports the same public rate-limit result for every exhausted dimension', async () => {
    for (const exhausted of ['ip', 'device', 'email', 'account', 'action'] as const) {
      const service = createPublicRegistrationService(
        dependencies({
          consumeRateLimit: async ({ dimensions }) => ({
            allowed: !dimensions.some((dimension) => dimension.kind === exhausted),
          }),
        }),
      );
      expect(await service.preflight(validInput())).toEqual({
        allowed: false,
        code: 'REGISTRATION_RATE_LIMITED',
      });
    }
  });

  test('rejects malformed policy versions before calling external dependencies', async () => {
    let challengeCalls = 0;
    const service = createPublicRegistrationService(
      dependencies({
        verifyChallenge: async () => {
          challengeCalls += 1;
          return { valid: true, action: 'signup', hostname: 'staging.openopc.example' };
        },
      }),
    );

    for (const version of ['', 'latest', ' latest ', '../privacy', 'x'.repeat(65)]) {
      expect(
        await service.preflight(
          validInput({ policyVersions: { ...validInput().policyVersions, privacy: version } }),
        ),
      ).toEqual({ allowed: false, code: 'REGISTRATION_DENIED' });
    }
    expect(challengeCalls).toBe(0);
  });

  test('keeps existing and non-existing email outcomes indistinguishable', async () => {
    const newAccount = createPublicRegistrationService(
      dependencies({ canSignUp: async () => ({ allowed: false }) }),
    );
    const existingAccount = createPublicRegistrationService(
      dependencies({ canSignUp: async () => ({ allowed: false, accountId: 'account-01' }) }),
    );

    expect(await newAccount.preflight(validInput())).toEqual({
      allowed: false,
      code: 'REGISTRATION_DENIED',
    });
    expect(await existingAccount.preflight(validInput())).toEqual({
      allowed: false,
      code: 'REGISTRATION_DENIED',
    });
  });

  test('still consumes abuse limits when access policy denies registration', async () => {
    let rateCalls = 0;
    let persistedDecision = true;
    const service = createPublicRegistrationService(
      dependencies({
        canSignUp: async () => ({ allowed: false }),
        consumeRateLimit: async ({ persistDecision }) => {
          rateCalls += 1;
          persistedDecision = persistDecision;
          return { allowed: true };
        },
      }),
    );

    expect(await service.preflight(validInput())).toEqual({
      allowed: false,
      code: 'REGISTRATION_DENIED',
    });
    expect(rateCalls).toBe(1);
    expect(persistedDecision).toBe(false);
  });

  test('consumes a decision once and rejects replay, tampering, and expiry', async () => {
    const service = createPublicRegistrationService(dependencies());
    const issued = await service.preflight(validInput());
    if (!issued.allowed) throw new Error('expected an allowed decision');

    const first = await service.consumeDecisionToken(issued.decisionToken);
    expect(first.valid).toBe(true);
    if (!first.valid) throw new Error('expected a valid consumed decision');
    expect(first.decision.action).toBe('signup');
    expect(first.decision.policyVersions.privacy).toBe('2026-07-28');

    expect(await service.consumeDecisionToken(issued.decisionToken)).toEqual({
      valid: false,
      code: 'REGISTRATION_DENIED',
    });
    expect(await service.consumeDecisionToken(`${issued.decisionToken}x`)).toEqual({
      valid: false,
      code: 'REGISTRATION_DENIED',
    });

    const expiredService = createPublicRegistrationService(
      dependencies({ now: () => new Date('2026-07-28T12:05:00.000Z') }),
    );
    expect(await expiredService.consumeDecisionToken(issued.decisionToken)).toEqual({
      valid: false,
      code: 'REGISTRATION_DENIED',
    });
  });

  test('rejects a correctly signed decision whose issue time is still in the future', async () => {
    const futureIssuer = createPublicRegistrationService(
      dependencies({ now: () => new Date('2026-07-28T12:10:00.000Z') }),
    );
    const issued = await futureIssuer.preflight(validInput());
    if (!issued.allowed) throw new Error('expected an allowed future decision');

    const currentService = createPublicRegistrationService(dependencies());
    expect(await currentService.consumeDecisionToken(issued.decisionToken)).toEqual({
      valid: false,
      code: 'REGISTRATION_DENIED',
    });
  });

  test('atomically binds one verified user and account to the exact signed policies', async () => {
    const completedInputs: Array<
      Parameters<PublicRegistrationDependencies['completeDecision']>[0]
    > = [];
    const service = createPublicRegistrationService(
      dependencies({
        completeDecision: async (input) => {
          completedInputs.push(input);
          return true;
        },
      }),
    );
    const issued = await service.preflight(validInput());
    if (!issued.allowed) throw new Error('expected an allowed decision');

    const completed = await service.completeRegistrationDecision(issued.decisionToken, {
      accountId: '11111111-1111-4111-8111-111111111111',
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(completed.valid).toBe(true);
    const completedInput = completedInputs[0];
    expect(completedInput).toBeDefined();
    expect(completedInput?.accountId).toBe('11111111-1111-4111-8111-111111111111');
    expect(completedInput?.userId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(completedInput?.decision.policyVersions).toEqual({
      terms: '2026-07-28',
      privacy: '2026-07-28',
      acceptableUse: '2026-07-28',
    });
  });
});
