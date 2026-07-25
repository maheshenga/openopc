import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  canonicalDeveloperModuleSignaturePayload,
  createEd25519ModuleSigningPort,
  isDistributableDeclarativeModule,
  signDeveloperModulePayload,
} from './module-signing';

function moduleItem() {
  return {
    name: 'recruiting-workbench',
    type: 'registry:module',
    module: {
      schemaVersion: 2,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
      capabilities: [{ id: 'acme.recruiting.score', kind: 'task' }],
    },
  };
}

test('accepts a manifest-only declarative module as distributable', () => {
  expect(isDistributableDeclarativeModule(moduleItem())).toEqual({ ok: true });
});

test('rejects a module carrying template inputs even when the input shape is malformed', () => {
  expect(
    isDistributableDeclarativeModule({ ...moduleItem(), inputs: { prompt: 'secret' } }),
  ).toEqual({ ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' });
});

test('rejects malformed environment variable declarations', () => {
  expect(isDistributableDeclarativeModule({ ...moduleItem(), envVars: 'OPENAI_API_KEY' })).toEqual({
    ok: false,
    code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE',
  });
});

test('rejects file payloads even when the file has a valid registry shape', () => {
  expect(
    isDistributableDeclarativeModule({
      ...moduleItem(),
      files: [{ path: 'run.ts', type: 'registry:file', content: 'export default {}' }],
    }),
  ).toEqual({ ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' });
});

test('rejects package and registry dependencies', () => {
  expect(
    isDistributableDeclarativeModule({
      ...moduleItem(),
      dependencies: ['@acme/runtime'],
    }),
  ).toEqual({ ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' });
});

test('rejects UI surfaces that point to executable entries', () => {
  expect(
    isDistributableDeclarativeModule({
      ...moduleItem(),
      module: {
        ...moduleItem().module,
        ui: [{ id: 'overview', surface: 'panel', entry: 'ui.ts' }],
      },
    }),
  ).toEqual({ ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' });
});

test('rejects desktop-native permission declarations', () => {
  expect(
    isDistributableDeclarativeModule({
      ...moduleItem(),
      module: {
        ...moduleItem().module,
        permissions: { desktop: ['filesystem'] },
      },
    }),
  ).toEqual({ ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' });
});

test('canonicalizes the signed release payload with stable sorted keys', () => {
  const payload = canonicalDeveloperModuleSignaturePayload({
    schema: 1,
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    publisher_id: 'acme',
    manifest_digest: `sha256:${'a'.repeat(64)}`,
  });

  expect(new TextDecoder().decode(payload)).toBe(
    `{"manifest_digest":"sha256:${'a'.repeat(64)}","module_id":"acme.recruiting","module_version":"1.0.0","publisher_id":"acme","schema":1}`,
  );
});

test('signs and verifies the canonical release payload with Ed25519', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const signature = await port.sign(
    canonicalDeveloperModuleSignaturePayload({
      schema: 1,
      module_id: 'acme.recruiting',
      module_version: '1.0.0',
      publisher_id: 'acme',
      manifest_digest: `sha256:${'a'.repeat(64)}`,
    }),
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
  const payload = {
    schema: 1 as const,
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    publisher_id: 'acme',
    manifest_digest: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
  };
  const bytes = canonicalDeveloperModuleSignaturePayload(payload);
  const signature = await port.sign(bytes);

  expect(await port.verify(bytes, signature)).toBe(true);
  expect(
    await port.verify(
      canonicalDeveloperModuleSignaturePayload({ ...payload, module_version: '1.0.1' }),
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
  const bytes = canonicalDeveloperModuleSignaturePayload({
    schema: 1,
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    publisher_id: 'acme',
    manifest_digest: `sha256:${'a'.repeat(64)}`,
  });

  expect(await port.verify(bytes, 'base64:invalid' as `base64url:${string}`)).toBe(false);
});

test('rejects detached signatures beyond the Ed25519 wire size', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
  const bytes = canonicalDeveloperModuleSignaturePayload({
    schema: 1,
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    publisher_id: 'acme',
    manifest_digest: `sha256:${'a'.repeat(64)}`,
  });

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
  const bytes = canonicalDeveloperModuleSignaturePayload({
    schema: 1,
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    publisher_id: 'acme',
    manifest_digest: `sha256:${'a'.repeat(64)}`,
  });
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
    {
      schema: 1,
      module_id: 'acme.recruiting',
      module_version: '1.0.0',
      publisher_id: 'acme',
      manifest_digest: `sha256:${'a'.repeat(64)}`,
    },
    port,
    () => new Date('2026-07-24T12:00:00.000Z'),
  );

  expect(JSON.stringify({ port, signed })).not.toContain(privatePem);
});

test('creates a detached signature attestation with a payload digest and timestamp', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = await signDeveloperModulePayload(
    {
      schema: 1,
      module_id: 'acme.recruiting',
      module_version: '1.0.0',
      publisher_id: 'acme',
      manifest_digest: `sha256:${'a'.repeat(64)}`,
    },
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
