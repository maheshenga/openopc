import { type KeyObject, createHash, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { readRegistryModuleManifest, validateRegistryItem } from '@kortix/registry';

export interface DeveloperModuleSignaturePayload {
  schema: 1;
  module_id: string;
  module_version: string;
  publisher_id: string;
  manifest_digest: `sha256:${string}`;
}

export type DeveloperModuleDetachedSignature = `base64url:${string}`;

export interface ModuleSigningPort {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<DeveloperModuleDetachedSignature>;
  verify(payload: Uint8Array, signature: DeveloperModuleDetachedSignature): Promise<boolean>;
}

export interface DeveloperModuleSignature {
  algorithm: 'ed25519';
  key_id: string;
  signature: DeveloperModuleDetachedSignature;
  payload_digest: `sha256:${string}`;
  signed_at: string;
}

export type DeclarativeModuleEligibility =
  | { ok: true }
  | { ok: false; code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON only supports JSON values');
}

export function canonicalDeveloperModuleSignaturePayload(
  payload: DeveloperModuleSignaturePayload,
): Uint8Array {
  if (
    payload.schema !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(payload.manifest_digest) ||
    !payload.module_id ||
    !payload.module_version ||
    !payload.publisher_id
  ) {
    throw new TypeError('Invalid developer module signature payload');
  }
  return new TextEncoder().encode(canonicalJson(payload));
}

export function createEd25519ModuleSigningPort(input: {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}): ModuleSigningPort {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.keyId)) {
    throw new TypeError('Invalid module signing key id');
  }
  if (
    input.privateKey.type !== 'private' ||
    input.publicKey.type !== 'public' ||
    input.privateKey.asymmetricKeyType !== 'ed25519' ||
    input.publicKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new TypeError('Module signing keys must be an Ed25519 private/public pair');
  }

  return {
    algorithm: 'ed25519',
    keyId: input.keyId,
    async sign(payload) {
      const signature = signBytes(null, Buffer.from(payload), input.privateKey).toString(
        'base64url',
      );
      return `base64url:${signature}`;
    },
    async verify(payload, signature) {
      if (!/^base64url:[A-Za-z0-9_-]{86}$/.test(signature)) return false;
      try {
        return verifyBytes(
          null,
          Buffer.from(payload),
          input.publicKey,
          Buffer.from(signature.slice('base64url:'.length), 'base64url'),
        );
      } catch {
        return false;
      }
    },
  };
}

export async function signDeveloperModulePayload(
  payload: DeveloperModuleSignaturePayload,
  signer: ModuleSigningPort,
  now: () => Date = () => new Date(),
): Promise<DeveloperModuleSignature> {
  const bytes = canonicalDeveloperModuleSignaturePayload(payload);
  const signedAt = now();
  if (!Number.isFinite(signedAt.getTime())) throw new TypeError('Invalid module signing timestamp');
  const payloadDigest = createHash('sha256').update(bytes).digest('hex');
  return {
    algorithm: signer.algorithm,
    key_id: signer.keyId,
    signature: await signer.sign(bytes),
    payload_digest: `sha256:${payloadDigest}`,
    signed_at: signedAt.toISOString(),
  };
}

export function isDistributableDeclarativeModule(item: unknown): DeclarativeModuleEligibility {
  const validation = validateRegistryItem(item);
  const manifest = readRegistryModuleManifest(item);
  if (!validation.valid || !manifest) {
    return { ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' };
  }

  const candidate = item as Record<string, unknown>;
  const execution = manifest.execution;
  const files = candidate.files;
  const dependencies = candidate.dependencies;
  const devDependencies = candidate.devDependencies;
  const registryDependencies = candidate.registryDependencies;
  const envVars = candidate.envVars;
  const inputs = candidate.inputs;
  const hasFiles = Array.isArray(files) ? files.length > 0 : files !== undefined;
  const hasDependencies = [dependencies, devDependencies, registryDependencies, inputs].some(
    (value) => Array.isArray(value) && value.length > 0,
  );
  const hasEnvVars =
    envVars !== undefined &&
    (typeof envVars !== 'object' ||
      envVars === null ||
      Array.isArray(envVars) ||
      Object.keys(envVars as Record<string, unknown>).length > 0);
  const hasInputs = inputs !== undefined;
  const hasExecutableUi = (manifest.ui ?? []).some((surface) => surface.entry !== undefined);
  const hasDesktopPermission = (manifest.permissions?.desktop?.length ?? 0) > 0;

  return execution.mode === 'declarative' &&
    execution.entry === undefined &&
    !hasFiles &&
    !hasDependencies &&
    !hasEnvVars &&
    !hasInputs &&
    !hasExecutableUi &&
    !hasDesktopPermission
    ? { ok: true }
    : { ok: false, code: 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE' };
}
