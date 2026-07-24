import { generateKeyPairSync } from 'node:crypto';

import { expect, test } from 'bun:test';

import { DeveloperModuleDistributionError } from './distribution';
import {
  createConfiguredModuleSigningPort,
  resolveModuleSignerConfig,
} from './module-signer-config';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIVATE_KEY_BASE64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const PUBLIC_KEY_BASE64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

test('disabled distribution returns no signer without parsing key material', () => {
  expect(createConfiguredModuleSigningPort({ enabled: false })).toBeNull();
});

test('enabled distribution with incomplete config fails closed with a typed unavailable error', () => {
  expect(() =>
    createConfiguredModuleSigningPort({
      enabled: true,
      keyId: '',
      privateKeyBase64: PRIVATE_KEY_BASE64,
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
  ).toThrow(DeveloperModuleDistributionError);
  expect(() =>
    createConfiguredModuleSigningPort({
      enabled: true,
      keyId: '',
      privateKeyBase64: PRIVATE_KEY_BASE64,
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
  ).toThrow('DEVELOPER_MODULE_SIGNER_UNAVAILABLE');
});

test('valid base64 PKCS8/SPKI keys produce an in-memory signing port without serialization leaks', async () => {
  const signer = createConfiguredModuleSigningPort({
    enabled: true,
    keyId: 'module-key-2026',
    privateKeyBase64: PRIVATE_KEY_BASE64,
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  if (!signer) throw new Error('Expected configured signer');
  const payload = new TextEncoder().encode('openopc distribution payload');
  const signature = await signer.sign(payload);

  expect(signer.keyId).toBe('module-key-2026');
  expect(await signer.verify(payload, signature)).toBe(true);
  expect(JSON.stringify(signer)).not.toContain(PRIVATE_KEY_BASE64);
  expect(JSON.stringify(signer)).not.toContain(PUBLIC_KEY_BASE64);
});

test('mismatched or malformed key material fails closed without exposing the values', () => {
  const rotated = generateKeyPairSync('ed25519');
  const rotatedPublic = rotated.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  expect(() =>
    createConfiguredModuleSigningPort({
      enabled: true,
      keyId: 'module-key-2026',
      privateKeyBase64: PRIVATE_KEY_BASE64,
      publicKeyBase64: rotatedPublic,
    }),
  ).toThrow('DEVELOPER_MODULE_SIGNER_UNAVAILABLE');
  expect(() =>
    createConfiguredModuleSigningPort({
      enabled: true,
      keyId: 'module-key-2026',
      privateKeyBase64: 'not-base64',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
  ).toThrow('DEVELOPER_MODULE_SIGNER_UNAVAILABLE');
});

test('prefers the OpenOPC enable flag and falls back to the Kortix flag', () => {
  const base = {
    OPENOPC_DEVELOPER_MODULE_SIGNING_KEY_ID: 'module-key-2026',
    OPENOPC_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64: PRIVATE_KEY_BASE64,
    OPENOPC_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64: PUBLIC_KEY_BASE64,
  };
  expect(
    resolveModuleSignerConfig({
      ...base,
      KORTIX_DEVELOPER_MODULE_DISTRIBUTION_ENABLED: 'true',
    }),
  ).toEqual(expect.objectContaining({ enabled: true, keyId: 'module-key-2026' }));
  expect(
    resolveModuleSignerConfig({
      ...base,
      OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED: 'false',
      KORTIX_DEVELOPER_MODULE_DISTRIBUTION_ENABLED: 'true',
    }),
  ).toEqual(expect.objectContaining({ enabled: false }));
});

test('falls back to legacy key names when normalized primary values are empty', () => {
  expect(
    resolveModuleSignerConfig({
      OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED: 'true',
      OPENOPC_DEVELOPER_MODULE_SIGNING_KEY_ID: '',
      OPENOPC_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64: '',
      OPENOPC_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64: '',
      KORTIX_DEVELOPER_MODULE_SIGNING_KEY_ID: 'legacy-key',
      KORTIX_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64: PRIVATE_KEY_BASE64,
      KORTIX_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64: PUBLIC_KEY_BASE64,
    }),
  ).toEqual({
    enabled: true,
    keyId: 'legacy-key',
    privateKeyBase64: PRIVATE_KEY_BASE64,
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
});
