import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { type EvidenceSigner, createEd25519EvidenceSigner } from '../attestation';

export function createEd25519FileAttestationSigner(input: {
  environment: 'development' | 'test' | 'staging';
  keyId: string;
  issuer: string;
  privateKeyFile: string;
  publicKeyFile: string;
}): EvidenceSigner {
  try {
    if (
      !['development', 'test', 'staging'].includes(input.environment) ||
      !input.keyId.startsWith(`openopc-attestation-${input.environment}-`) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.issuer)
    ) {
      fail();
    }
    const privateKey = createPrivateKey({
      key: readBounded(input.privateKeyFile),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey({
      key: readBounded(input.publicKeyFile),
      format: 'der',
      type: 'spki',
    });
    const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const configured = publicKey.export({ format: 'der', type: 'spki' });
    if (derived.length !== configured.length || !timingSafeEqual(derived, configured)) fail();
    return createEd25519EvidenceSigner({
      privateKey,
      keyId: input.keyId,
      issuer: input.issuer,
    });
  } catch {
    fail();
  }
}

function readBounded(path: string): Buffer {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 1_024 ||
    /[\0\r\n]/.test(path)
  ) {
    fail();
  }
  const value = readFileSync(path);
  if (value.byteLength === 0 || value.byteLength > 8 * 1024) fail();
  return value;
}

function fail(): never {
  throw new TypeError('DEVELOPER_TRUST_ATTESTATION_SIGNER_INVALID');
}
