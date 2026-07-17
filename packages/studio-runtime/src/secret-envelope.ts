import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const GCM_AUTH_TAG_LENGTH = 16;
const GCM_IV_LENGTH = 12;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function projectSecretKey(masterSecret: string, projectId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterSecret, 'utf8'),
      Buffer.from(projectId, 'utf8'),
      Buffer.from('kortix-project-secret-v1', 'utf8'),
      32,
    ),
  );
}

function decodeSegment(value: string): Buffer {
  if (!BASE64URL_SEGMENT.test(value)) throw new Error('Unsupported project secret envelope');
  return Buffer.from(value, 'base64url');
}

export function encryptProjectSecretEnvelope(
  masterSecret: string,
  projectId: string,
  value: string,
): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', projectSecretKey(masterSecret, projectId), iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptProjectSecretEnvelope(
  masterSecret: string,
  projectId: string,
  valueEnc: string,
): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded, ...extra] = valueEnc.split(':');
  if (
    version !== ENVELOPE_VERSION ||
    !ivEncoded ||
    !tagEncoded ||
    !ciphertextEncoded ||
    extra.length > 0
  ) {
    throw new Error('Unsupported project secret envelope');
  }

  const iv = decodeSegment(ivEncoded);
  const tag = decodeSegment(tagEncoded);
  const ciphertext = decodeSegment(ciphertextEncoded);
  if (iv.length !== GCM_IV_LENGTH || tag.length !== GCM_AUTH_TAG_LENGTH) {
    throw new Error('Unsupported project secret envelope');
  }

  const decipher = createDecipheriv('aes-256-gcm', projectSecretKey(masterSecret, projectId), iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
