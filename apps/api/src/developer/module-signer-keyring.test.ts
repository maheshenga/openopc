import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { createModuleSignerKeyring, loadModuleSignerKeyringFile } from './module-signer-keyring';
import { createEd25519ModuleSigningPort } from './module-signing';

function releaseKey(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { keyId, privateKey, publicKey };
}

test('rotated release signatures remain verifiable until explicit key revocation', async () => {
  const first = releaseKey('openopc-release-staging-2026-a');
  const keyring = createModuleSignerKeyring({
    environment: 'staging',
    activeKeyId: first.keyId,
    keys: [first],
  });
  const payload = new TextEncoder().encode('openopc release payload');
  const oldSigner = keyring.activeSigner();
  const oldSignature = await oldSigner.sign(payload);

  await keyring.rotate(releaseKey('openopc-release-staging-2026-b'));

  expect(await keyring.verifier(oldSigner.keyId)?.verify(payload, oldSignature)).toBe(true);
  await keyring.revoke(oldSigner.keyId);
  expect(keyring.verifier(oldSigner.keyId)).toBeUndefined();
});

test('accepts only unique non-production release key identities', () => {
  const release = releaseKey('openopc-release-staging-2026-a');
  expect(() =>
    createModuleSignerKeyring({
      environment: 'production' as 'staging',
      activeKeyId: release.keyId,
      keys: [release],
    }),
  ).toThrow('DEVELOPER_MODULE_KEYRING_INVALID');
  expect(() =>
    createModuleSignerKeyring({
      environment: 'staging',
      activeKeyId: 'openopc-attestation-staging-2026-a',
      keys: [{ ...release, keyId: 'openopc-attestation-staging-2026-a' }],
    }),
  ).toThrow('DEVELOPER_MODULE_KEYRING_INVALID');
  expect(() =>
    createModuleSignerKeyring({
      environment: 'staging',
      activeKeyId: release.keyId,
      keys: [release, release],
    }),
  ).toThrow('DEVELOPER_MODULE_KEYRING_INVALID');
});

test('loads active and verification-only keys from a bounded secret mount', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openopc-release-keyring-'));
  try {
    const active = releaseKey('openopc-release-staging-2026-b');
    const previous = releaseKey('openopc-release-staging-2026-a');
    writeFileSync(
      join(directory, 'active.pk8'),
      active.privateKey.export({ format: 'der', type: 'pkcs8' }),
    );
    writeFileSync(
      join(directory, 'active.spki'),
      active.publicKey.export({ format: 'der', type: 'spki' }),
    );
    writeFileSync(
      join(directory, 'previous.spki'),
      previous.publicKey.export({ format: 'der', type: 'spki' }),
    );
    writeFileSync(
      join(directory, 'keyring.json'),
      JSON.stringify({
        schema: 1,
        environment: 'staging',
        activeKeyId: active.keyId,
        keys: [
          {
            keyId: active.keyId,
            state: 'active',
            privateKeyFile: 'active.pk8',
            publicKeyFile: 'active.spki',
          },
          {
            keyId: previous.keyId,
            state: 'verify',
            publicKeyFile: 'previous.spki',
          },
        ],
      }),
    );

    const keyring = loadModuleSignerKeyringFile(join(directory, 'keyring.json'));
    const payload = new TextEncoder().encode('historical release payload');
    const previousSigner = createEd25519ModuleSigningPort(previous);
    const signature = await previousSigner.sign(payload);

    expect(keyring.activeSigner().keyId).toBe(active.keyId);
    expect(await keyring.verifier(previous.keyId)?.verify(payload, signature)).toBe(true);
    expect(JSON.stringify(keyring)).not.toContain('active.pk8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
