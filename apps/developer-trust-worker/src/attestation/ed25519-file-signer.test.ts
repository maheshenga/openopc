import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { createEd25519FileAttestationSigner } from './ed25519-file-signer';

test('loads a distinct non-production attestation key from mounted files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openopc-attestation-key-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyFile = join(directory, 'attestation.pk8');
    const publicKeyFile = join(directory, 'attestation.spki');
    writeFileSync(privateKeyFile, privateKey.export({ format: 'der', type: 'pkcs8' }));
    writeFileSync(publicKeyFile, publicKey.export({ format: 'der', type: 'spki' }));
    const signer = createEd25519FileAttestationSigner({
      environment: 'staging',
      keyId: 'openopc-attestation-staging-2026-a',
      issuer: 'openopc-developer-trust-worker-staging',
      privateKeyFile,
      publicKeyFile,
    });
    const payload = Buffer.from('developer trust evidence');
    const signature = await signer.sign(payload);

    expect(verify(null, payload, publicKey, signature)).toBe(true);
    expect(JSON.stringify(signer)).not.toContain(privateKeyFile);
    expect(() =>
      createEd25519FileAttestationSigner({
        environment: 'staging',
        keyId: 'openopc-release-staging-2026-a',
        issuer: 'openopc-developer-trust-worker-staging',
        privateKeyFile,
        publicKeyFile,
      }),
    ).toThrow('DEVELOPER_TRUST_ATTESTATION_SIGNER_INVALID');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
