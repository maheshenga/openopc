import { type KeyObject, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  type ModuleSigningPort,
  type ModuleVerificationPort,
  createEd25519ModuleSigningPort,
  createEd25519ModuleVerificationPort,
} from './module-signing';

export interface ModuleSignerKey {
  keyId: string;
  privateKey?: KeyObject;
  publicKey: KeyObject;
}

export interface ModuleSignerKeyring {
  activeSigner(): ModuleSigningPort;
  verifier(keyId: string): ModuleVerificationPort | undefined;
  verifiers(): readonly ModuleVerificationPort[];
  rotate(key: ModuleSignerKey): Promise<void>;
  revoke(keyId: string): Promise<void>;
}

export function createModuleSignerKeyring(input: {
  environment: 'development' | 'test' | 'staging';
  activeKeyId: string;
  keys: readonly ModuleSignerKey[];
  revokedKeyIds?: readonly string[];
}): ModuleSignerKeyring {
  if (
    !['development', 'test', 'staging'].includes(input.environment) ||
    input.keys.length === 0 ||
    input.keys.length > 16 ||
    new Set(input.keys.map((key) => key.keyId)).size !== input.keys.length ||
    !input.keys.some((key) => key.keyId === input.activeKeyId)
  ) {
    fail();
  }
  for (const key of input.keys) validateKey(input.environment, key);
  const keys = new Map(input.keys.map((key) => [key.keyId, key]));
  const revoked = new Set(input.revokedKeyIds ?? []);
  let activeKeyId = input.activeKeyId;
  if (!keys.get(activeKeyId)?.privateKey || revoked.has(activeKeyId)) fail();

  const signer = (key: ModuleSignerKey): ModuleSigningPort =>
    createEd25519ModuleSigningPort({
      keyId: key.keyId,
      privateKey: key.privateKey ?? fail(),
      publicKey: key.publicKey,
    });
  const verifier = (key: ModuleSignerKey): ModuleVerificationPort =>
    createEd25519ModuleVerificationPort({ keyId: key.keyId, publicKey: key.publicKey });

  return {
    activeSigner() {
      const key = keys.get(activeKeyId);
      if (!key || revoked.has(activeKeyId))
        throw new TypeError('Active module signing key unavailable');
      return signer(key);
    },
    verifier(keyId) {
      const key = keys.get(keyId);
      return key && !revoked.has(keyId) ? verifier(key) : undefined;
    },
    verifiers() {
      return [...keys.values()].filter((key) => !revoked.has(key.keyId)).map(verifier);
    },
    async rotate(key) {
      if (keys.has(key.keyId)) fail();
      validateKey(input.environment, key);
      if (!key.privateKey) fail();
      keys.set(key.keyId, key);
      revoked.delete(key.keyId);
      activeKeyId = key.keyId;
      signer(key);
    },
    async revoke(keyId) {
      if (keyId === activeKeyId) throw new TypeError('Cannot revoke active module signing key');
      if (keys.has(keyId)) revoked.add(keyId);
    },
  };
}

function validateKey(environment: string, key: ModuleSignerKey): void {
  if (!key.keyId.startsWith(`openopc-release-${environment}-`)) fail();
  try {
    const configured = key.publicKey.export({ format: 'der', type: 'spki' });
    createEd25519ModuleVerificationPort({ keyId: key.keyId, publicKey: key.publicKey });
    if (key.privateKey) {
      const derived = createPublicKey(key.privateKey).export({ format: 'der', type: 'spki' });
      if (derived.length !== configured.length || !timingSafeEqual(derived, configured)) fail();
      createEd25519ModuleSigningPort({
        keyId: key.keyId,
        privateKey: key.privateKey,
        publicKey: key.publicKey,
      });
    }
  } catch {
    fail();
  }
}

export function loadModuleSignerKeyringFile(filePath: string): ModuleSignerKeyring {
  try {
    const manifestBytes = readFileSync(filePath);
    if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > 64 * 1024) fail();
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
    if (
      !isRecord(manifest) ||
      !exactKeys(manifest, ['schema', 'environment', 'activeKeyId', 'keys'])
    ) {
      fail();
    }
    if (
      manifest.schema !== 1 ||
      !['development', 'test', 'staging'].includes(String(manifest.environment)) ||
      typeof manifest.activeKeyId !== 'string' ||
      !Array.isArray(manifest.keys)
    ) {
      fail();
    }
    const directory = dirname(filePath);
    const revokedKeyIds: string[] = [];
    const keys = manifest.keys.map((value): ModuleSignerKey => {
      if (
        !isRecord(value) ||
        !exactKeys(
          value,
          ['keyId', 'state', 'privateKeyFile', 'publicKeyFile'],
          ['privateKeyFile'],
        ) ||
        typeof value.keyId !== 'string' ||
        !['active', 'verify', 'revoked'].includes(String(value.state)) ||
        !safeMountedFilename(value.publicKeyFile)
      ) {
        fail();
      }
      if (value.state === 'active' && !safeMountedFilename(value.privateKeyFile)) fail();
      if (value.state !== 'active' && value.privateKeyFile !== undefined) fail();
      const publicKey = createPublicKey({
        key: readBoundedKey(join(directory, value.publicKeyFile)),
        format: 'der',
        type: 'spki',
      });
      const privateKey =
        value.state === 'active'
          ? createPrivateKey({
              key: readBoundedKey(join(directory, String(value.privateKeyFile))),
              format: 'der',
              type: 'pkcs8',
            })
          : undefined;
      if (value.state === 'revoked') revokedKeyIds.push(value.keyId);
      return { keyId: value.keyId, publicKey, ...(privateKey ? { privateKey } : {}) };
    });
    if (
      manifest.keys.filter((value) => isRecord(value) && value.state === 'active').length !== 1 ||
      !manifest.keys.some(
        (value) =>
          isRecord(value) && value.state === 'active' && value.keyId === manifest.activeKeyId,
      )
    ) {
      fail();
    }
    return createModuleSignerKeyring({
      environment: manifest.environment as 'development' | 'test' | 'staging',
      activeKeyId: manifest.activeKeyId,
      keys,
      revokedKeyIds,
    });
  } catch {
    fail();
  }
}

function readBoundedKey(path: string): Buffer {
  const value = readFileSync(path);
  if (value.byteLength === 0 || value.byteLength > 8 * 1024) fail();
  return value;
}

function safeMountedFilename(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.includes(key)) &&
    allowed.filter((key) => !optional.includes(key)).every((key) => Object.hasOwn(value, key))
  );
}

function fail(): never {
  throw new TypeError('DEVELOPER_MODULE_KEYRING_INVALID');
}
