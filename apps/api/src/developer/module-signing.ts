import { type KeyObject, createHash, sign as signBytes, verify as verifyBytes } from 'node:crypto';

import { type DeveloperModuleRelease, canonicalDeveloperModuleManifestDigest } from './releases';

export interface DeveloperModuleSignaturePayloadV2 {
  schema: 2;
  module_id: string;
  module_version: string;
  publisher_id: string;
  artifact_digest: `sha256:${string}`;
  manifest_digest: `sha256:${string}`;
  sbom_digest: `sha256:${string}`;
  trust_attestation_digest: `sha256:${string}`;
  verification_policy_digest: `sha256:${string}`;
  runtime_descriptor_digest: `sha256:${string}` | null;
  runtime_kind: 'wasi-component' | 'oci-image' | null;
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

const SIGNATURE_PAYLOAD_V2_FIELDS = [
  'schema',
  'module_id',
  'module_version',
  'publisher_id',
  'artifact_digest',
  'manifest_digest',
  'sbom_digest',
  'trust_attestation_digest',
  'verification_policy_digest',
  'runtime_descriptor_digest',
  'runtime_kind',
] as const;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DETACHED_ED25519_SIGNATURE = /^base64url:[A-Za-z0-9_-]{86}$/;

function assertExactSignatureV2(payload: DeveloperModuleSignaturePayloadV2): void {
  const candidate = payload as unknown as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== SIGNATURE_PAYLOAD_V2_FIELDS.length ||
    SIGNATURE_PAYLOAD_V2_FIELDS.some((field) => !Object.hasOwn(candidate, field)) ||
    payload.schema !== 2 ||
    typeof payload.module_id !== 'string' ||
    payload.module_id.length === 0 ||
    typeof payload.module_version !== 'string' ||
    payload.module_version.length === 0 ||
    typeof payload.publisher_id !== 'string' ||
    payload.publisher_id.length === 0 ||
    !SHA256_DIGEST.test(payload.artifact_digest) ||
    !SHA256_DIGEST.test(payload.manifest_digest) ||
    !SHA256_DIGEST.test(payload.sbom_digest) ||
    !SHA256_DIGEST.test(payload.trust_attestation_digest) ||
    !SHA256_DIGEST.test(payload.verification_policy_digest) ||
    !(
      (payload.runtime_descriptor_digest === null && payload.runtime_kind === null) ||
      (typeof payload.runtime_descriptor_digest === 'string' &&
        SHA256_DIGEST.test(payload.runtime_descriptor_digest) &&
        (payload.runtime_kind === 'wasi-component' || payload.runtime_kind === 'oci-image'))
    )
  ) {
    throw new TypeError('Invalid developer module signature payload');
  }
}

export function canonicalDeveloperModuleSignaturePayloadV2(
  payload: DeveloperModuleSignaturePayloadV2,
): Uint8Array {
  assertExactSignatureV2(payload);
  return new TextEncoder().encode(JSON.stringify(payload));
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
  payload: DeveloperModuleSignaturePayloadV2,
  signer: ModuleSigningPort,
  now: () => Date = () => new Date(),
): Promise<DeveloperModuleSignature> {
  const bytes = canonicalDeveloperModuleSignaturePayloadV2(payload);
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

export function developerModuleReleaseSignaturePayloadV2(
  release: DeveloperModuleRelease,
): DeveloperModuleSignaturePayloadV2 {
  return {
    schema: 2,
    module_id: release.module_id,
    module_version: release.module_version,
    publisher_id: release.publisher_id,
    artifact_digest: release.artifact_digest as `sha256:${string}`,
    manifest_digest: release.manifest_digest,
    sbom_digest: release.sbom_digest as `sha256:${string}`,
    trust_attestation_digest: release.trust_attestation_digest as `sha256:${string}`,
    verification_policy_digest: release.verification_policy_digest as `sha256:${string}`,
    runtime_descriptor_digest: release.runtime_descriptor_digest,
    runtime_kind: release.runtime_kind,
  };
}

export async function verifyDeveloperModuleReleaseTrustSignature(
  release: DeveloperModuleRelease,
  verifier: ModuleSigningPort,
): Promise<boolean> {
  if (
    !['signed', 'published'].includes(release.status) ||
    release.signature_algorithm !== 'ed25519' ||
    release.signature_key_id !== verifier.keyId ||
    verifier.algorithm !== 'ed25519' ||
    !release.signature ||
    !DETACHED_ED25519_SIGNATURE.test(release.signature) ||
    !release.signature_payload_digest ||
    !release.signed_at ||
    canonicalDeveloperModuleManifestDigest(release.manifest) !== release.manifest_digest
  ) {
    return false;
  }

  try {
    const bytes = canonicalDeveloperModuleSignaturePayloadV2(
      developerModuleReleaseSignaturePayloadV2(release),
    );
    const payloadDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    return (
      payloadDigest === release.signature_payload_digest &&
      (await verifier.verify(bytes, release.signature))
    );
  } catch {
    return false;
  }
}
