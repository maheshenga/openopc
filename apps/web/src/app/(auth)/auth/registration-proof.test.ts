import { describe, expect, test } from 'bun:test';
import {
  buildRegistrationProofFields,
  getOrCreateRegistrationDeviceId,
} from './registration-proof';

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set('openopc.registration.device-id', initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('registration browser proof', () => {
  test('persists one bounded opaque device identifier', () => {
    const storage = memoryStorage();
    let generated = 0;
    const randomUuid = () => {
      generated += 1;
      return '10000000-0000-4000-a000-000000000001';
    };

    expect(getOrCreateRegistrationDeviceId(storage, randomUuid)).toBe(
      '10000000-0000-4000-a000-000000000001',
    );
    expect(getOrCreateRegistrationDeviceId(storage, randomUuid)).toBe(
      '10000000-0000-4000-a000-000000000001',
    );
    expect(generated).toBe(1);
  });

  test('replaces malformed stored identifiers and fails closed when storage is unavailable', () => {
    const storage = memoryStorage('../raw-device-secret');
    expect(
      getOrCreateRegistrationDeviceId(
        storage,
        () => '20000000-0000-4000-a000-000000000002',
      ),
    ).toBe('20000000-0000-4000-a000-000000000002');

    expect(
      getOrCreateRegistrationDeviceId(
        {
          getItem: () => {
            throw new Error('blocked storage');
          },
          setItem: () => {
            throw new Error('blocked storage');
          },
        },
        () => '30000000-0000-4000-a000-000000000003',
      ),
    ).toBeNull();
  });

  test('builds exact server-action fields only for complete versioned proof', () => {
    expect(
      buildRegistrationProofFields({
        challengeToken: 'turnstile-response-token',
        deviceId: '10000000-0000-4000-a000-000000000001',
        policyVersions: {
          terms: '2026-07-28',
          privacy: '2026-07-28',
          acceptableUse: '2026-07-28',
        },
      }),
    ).toEqual({
      challengeToken: 'turnstile-response-token',
      deviceId: '10000000-0000-4000-a000-000000000001',
      policyTermsVersion: '2026-07-28',
      policyPrivacyVersion: '2026-07-28',
      policyAcceptableUseVersion: '2026-07-28',
    });

    for (const invalid of [
      { challengeToken: '', privacy: '2026-07-28' },
      { challengeToken: 'token', privacy: 'latest' },
      { challengeToken: 'token', privacy: '' },
    ]) {
      expect(
        buildRegistrationProofFields({
          challengeToken: invalid.challengeToken,
          deviceId: '10000000-0000-4000-a000-000000000001',
          policyVersions: {
            terms: '2026-07-28',
            privacy: invalid.privacy,
            acceptableUse: '2026-07-28',
          },
        }),
      ).toBeNull();
    }
  });
});
