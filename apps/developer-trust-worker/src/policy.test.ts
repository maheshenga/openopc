import { describe, expect, test } from 'bun:test';
import {
  DeveloperTrustPolicyError,
  assertDeveloperTrustPolicyClaim,
  defineDeveloperTrustPolicy,
} from './policy';
import { fixtureDigest as digest, policyInput } from './test-fixtures';

describe('developer trust policy', () => {
  test('derives deterministic immutable policy and scanner-set digests', () => {
    const first = defineDeveloperTrustPolicy(policyInput());
    const second = defineDeveloperTrustPolicy(structuredClone(policyInput()));
    const reorderedInput = policyInput();
    const reordered = defineDeveloperTrustPolicy({
      ...reorderedInput,
      scanners: [...reorderedInput.scanners].reverse(),
    });

    expect(first).toEqual(second);
    expect(reordered.policyDigest).toBe(first.policyDigest);
    expect(reordered.scannerSetDigest).toBe(first.scannerSetDigest);
    expect(first.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.scannerSetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.scanners)).toBe(true);
  });

  test.each([
    ['missing scanner', () => ({ ...policyInput(), scanners: policyInput().scanners.slice(1) })],
    [
      'duplicate scanner',
      () => ({
        ...policyInput(),
        scanners: [...policyInput().scanners, policyInput().scanners[0]],
      }),
    ],
    [
      'relative executable',
      () => ({
        ...policyInput(),
        scanners: policyInput().scanners.map((scanner, index) =>
          index === 0 ? { ...scanner, executable: 'gitleaks' } : scanner,
        ),
      }),
    ],
  ])('rejects %s policy input', (_label, build) => {
    expect(() => defineDeveloperTrustPolicy(build())).toThrow(DeveloperTrustPolicyError);
  });

  test('rejects policy, scanner, and sandbox claim mismatches', () => {
    const policy = defineDeveloperTrustPolicy(policyInput());
    const claim = {
      policyDigest: policy.policyDigest,
      scannerSetDigest: policy.scannerSetDigest,
      sandboxProfileDigest: policy.sandboxProfiles['desktop-package'].profileDigest,
      verificationProfile: 'desktop-package' as const,
    };
    expect(() => assertDeveloperTrustPolicyClaim(policy, claim)).not.toThrow();

    for (const patch of [
      { policyDigest: digest('0') },
      { scannerSetDigest: digest('1') },
      { sandboxProfileDigest: digest('2') },
    ]) {
      expect(() => assertDeveloperTrustPolicyClaim(policy, { ...claim, ...patch })).toThrow(
        DeveloperTrustPolicyError,
      );
    }
  });
});
