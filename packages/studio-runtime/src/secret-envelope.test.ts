import { describe, expect, test } from 'bun:test';
import {
  decryptProjectSecretEnvelope,
  encryptProjectSecretEnvelope,
} from './secret-envelope';

const MASTER_SECRET = 'test-master-secret';
const LEGACY_FIXTURE = 'v1:AAECAwQFBgcICQoL:3lP0cEd22OwH-oO8Tn2rLA:sD2o7-2EYWUV3SOC';

describe('project secret envelope', () => {
  test('decrypts the fixed legacy v1 envelope', () => {
    expect(decryptProjectSecretEnvelope(MASTER_SECRET, 'project-a', LEGACY_FIXTURE)).toBe(
      'legacy value',
    );
  });

  test('round trips a project-bound value', () => {
    const encrypted = encryptProjectSecretEnvelope(MASTER_SECRET, 'project-a', 'new value');

    expect(encrypted).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(decryptProjectSecretEnvelope(MASTER_SECRET, 'project-a', encrypted)).toBe('new value');
  });

  test('does not allow another project to decrypt the envelope', () => {
    const encrypted = encryptProjectSecretEnvelope(MASTER_SECRET, 'project-a', 'isolated value');

    expect(() => decryptProjectSecretEnvelope(MASTER_SECRET, 'project-b', encrypted)).toThrow();
  });

  test.each(['v2:iv:tag:ciphertext', 'v1:iv:tag', 'v1::tag:ciphertext', 'v1:iv::ciphertext'])
  ('rejects malformed envelopes: %s', (value) => {
    expect(() => decryptProjectSecretEnvelope(MASTER_SECRET, 'project-a', value)).toThrow();
  });

  test('rejects a different master secret', () => {
    expect(() => decryptProjectSecretEnvelope('wrong-master-secret', 'project-a', LEGACY_FIXTURE)).toThrow();
  });
});
