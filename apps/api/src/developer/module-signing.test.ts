import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  type DeveloperModuleSignaturePayloadV2,
  canonicalDeveloperModuleSignaturePayloadV2,
  createEd25519ModuleSigningPort,
  signDeveloperModulePayload,
} from './module-signing';

function signaturePayloadV2(): DeveloperModuleSignaturePayloadV2 {
  return {
    schema: 2,
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    publisher_id: 'acme',
    artifact_digest: `sha256:${'a'.repeat(64)}`,
    manifest_digest: `sha256:${'b'.repeat(64)}`,
    sbom_digest: `sha256:${'c'.repeat(64)}`,
    trust_attestation_digest: `sha256:${'d'.repeat(64)}`,
    verification_policy_digest: `sha256:${'e'.repeat(64)}`,
  };
}

test('canonicalizes the exact schema-2 signed release payload', () => {
  const payload = canonicalDeveloperModuleSignaturePayloadV2(signaturePayloadV2());

  expect(new TextDecoder().decode(payload)).toBe(
    `{"schema":2,"module_id":"acme.recruiting","module_version":"1.0.0","publisher_id":"acme","artifact_digest":"sha256:${'a'.repeat(64)}","manifest_digest":"sha256:${'b'.repeat(64)}","sbom_digest":"sha256:${'c'.repeat(64)}","trust_attestation_digest":"sha256:${'d'.repeat(64)}","verification_policy_digest":"sha256:${'e'.repeat(64)}"}`,
  );
});

test('schema-2 signature changes for every trust-bound digest', () => {
  const base = signaturePayloadV2();
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(base);
  for (const key of [
    'artifact_digest',
    'manifest_digest',
    'sbom_digest',
    'trust_attestation_digest',
    'verification_policy_digest',
  ] as const) {
    expect(
      canonicalDeveloperModuleSignaturePayloadV2({
        ...base,
        [key]: `sha256:${'f'.repeat(64)}`,
      }),
    ).not.toEqual(bytes);
  }
});

test.each([
  ['schema 1', { ...signaturePayloadV2(), schema: 1 }],
  [
    'a missing field',
    Object.fromEntries(
      Object.entries(signaturePayloadV2()).filter(([key]) => key !== 'artifact_digest'),
    ),
  ],
  ['an extra field', { ...signaturePayloadV2(), legacy_digest: `sha256:${'f'.repeat(64)}` }],
  ['an invalid digest', { ...signaturePayloadV2(), sbom_digest: 'sha256:not-a-digest' }],
] as const)('rejects %s without a schema-1 fallback', (_label, payload) => {
  expect(() =>
    canonicalDeveloperModuleSignaturePayloadV2(
      payload as unknown as DeveloperModuleSignaturePayloadV2,
    ),
  ).toThrow('Invalid developer module signature payload');
});

test('signs and verifies the canonical release payload with Ed25519', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const signature = await port.sign(
    canonicalDeveloperModuleSignaturePayloadV2(signaturePayloadV2()),
  );

  expect(signature).toMatch(/^base64url:[A-Za-z0-9_-]+$/);
});

test('rejects a signature when the release payload is tampered', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const payload = signaturePayloadV2();
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(payload);
  const signature = await port.sign(bytes);

  expect(await port.verify(bytes, signature)).toBe(true);
  expect(
    await port.verify(
      canonicalDeveloperModuleSignaturePayloadV2({ ...payload, module_version: '1.0.1' }),
      signature,
    ),
  ).toBe(false);
});

test('rejects detached signatures with an invalid wire prefix', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(signaturePayloadV2());

  expect(await port.verify(bytes, 'base64:invalid' as `base64url:${string}`)).toBe(false);
});

test('rejects detached signatures beyond the Ed25519 wire size', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(signaturePayloadV2());

  expect(await port.verify(bytes, `base64url:${'A'.repeat(87)}`)).toBe(false);
});

test('rejects an invalid signing key id', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  expect(() =>
    createEd25519ModuleSigningPort({
      keyId: 'bad key id',
      privateKey,
      publicKey,
    }),
  ).toThrow('Invalid module signing key id');
});

test('rejects non-Ed25519 signing keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  expect(() =>
    createEd25519ModuleSigningPort({
      keyId: 'openopc-test-2026',
      privateKey,
      publicKey,
    }),
  ).toThrow('Module signing keys must be an Ed25519 private/public pair');
});

test('fails verification when a rotated public key does not match the signer', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { publicKey: rotatedPublicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey: rotatedPublicKey,
  });
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(signaturePayloadV2());
  const signature = await createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  }).sign(bytes);

  expect(await port.verify(bytes, signature)).toBe(false);
});

test('keeps private key material out of serialized signer and attestation values', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const signed = await signDeveloperModulePayload(
    signaturePayloadV2(),
    port,
    () => new Date('2026-07-24T12:00:00.000Z'),
  );

  expect(JSON.stringify({ port, signed })).not.toContain(privatePem);
});

test('creates a detached signature attestation with a payload digest and timestamp', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = await signDeveloperModulePayload(
    signaturePayloadV2(),
    createEd25519ModuleSigningPort({ keyId: 'openopc-test-2026', privateKey, publicKey }),
    () => new Date('2026-07-24T12:00:00.000Z'),
  );

  expect(signed).toMatchObject({
    algorithm: 'ed25519',
    key_id: 'openopc-test-2026',
    signed_at: '2026-07-24T12:00:00.000Z',
  });
  expect(signed.payload_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});
