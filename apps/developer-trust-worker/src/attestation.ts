import { type KeyObject, createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';

export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;
export const OPENOPC_TRUST_PREDICATE_TYPE =
  'https://openopc.dev/attestations/developer-module-verification/v1' as const;

export interface OpenOpcDeveloperTrustPredicateV1 {
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  runId: string;
  attempt: number;
  result: 'passed' | 'failed' | 'inconclusive' | 'cancelled';
  evidenceDigests: readonly `sha256:${string}`[];
  startedAt: string;
  finishedAt: string;
}

export interface DsseEnvelope {
  payloadType: typeof IN_TOTO_PAYLOAD_TYPE;
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface EvidenceSigner {
  keyId: string;
  issuer: string;
  sign(payload: Buffer): Promise<Buffer>;
}

export class DeveloperTrustAttestationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeveloperTrustAttestationError';
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(code: string): never {
  throw new DeveloperTrustAttestationError(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DEVELOPER_TRUST_ATTESTATION_INVALID_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  fail('DEVELOPER_TRUST_ATTESTATION_INVALID_JSON');
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function validatePredicate(predicate: OpenOpcDeveloperTrustPredicateV1): void {
  if (
    !['passed', 'failed', 'inconclusive', 'cancelled'].includes(predicate.result) ||
    !Array.isArray(predicate.evidenceDigests) ||
    predicate.evidenceDigests.length > 100
  ) {
    fail('DEVELOPER_TRUST_ATTESTATION_RESULT_INVALID');
  }
  for (const digest of [
    predicate.artifactDigest,
    predicate.policyDigest,
    predicate.scannerSetDigest,
    predicate.sandboxProfileDigest,
    predicate.sbomDigest,
    ...predicate.evidenceDigests,
  ]) {
    if (!DIGEST.test(digest)) fail('DEVELOPER_TRUST_ATTESTATION_DIGEST_INVALID');
  }
  if (
    !validIdentifier(predicate.runId) ||
    !Number.isSafeInteger(predicate.attempt) ||
    predicate.attempt < 1
  ) {
    fail('DEVELOPER_TRUST_ATTESTATION_COORDINATE_INVALID');
  }
  const startedAt = Date.parse(predicate.startedAt);
  const finishedAt = Date.parse(predicate.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    fail('DEVELOPER_TRUST_ATTESTATION_TIME_INVALID');
  }
}

export function dssePreAuthEncoding(payloadType: string, payload: Buffer): Buffer {
  if (!validIdentifier(payloadType)) fail('DEVELOPER_TRUST_DSSE_PAYLOAD_TYPE_INVALID');
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.byteLength} `, 'utf8'),
    type,
    Buffer.from(` ${payload.byteLength} `, 'utf8'),
    payload,
  ]);
}

export function createEd25519EvidenceSigner(input: {
  privateKey: KeyObject | string;
  keyId: string;
  issuer: string;
}): EvidenceSigner {
  if (!validIdentifier(input.keyId) || !validIdentifier(input.issuer)) {
    fail('DEVELOPER_TRUST_EVIDENCE_SIGNER_IDENTITY_INVALID');
  }
  let privateKey: KeyObject;
  try {
    privateKey =
      typeof input.privateKey === 'string' ? createPrivateKey(input.privateKey) : input.privateKey;
  } catch {
    fail('DEVELOPER_TRUST_EVIDENCE_PRIVATE_KEY_INVALID');
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    fail('DEVELOPER_TRUST_EVIDENCE_PRIVATE_KEY_INVALID');
  }
  return Object.freeze({
    keyId: input.keyId,
    issuer: input.issuer,
    async sign(payload: Buffer): Promise<Buffer> {
      try {
        return cryptoSign(null, payload, privateKey);
      } catch {
        fail('DEVELOPER_TRUST_EVIDENCE_SIGNING_FAILED');
      }
    },
  });
}

export async function createDeveloperTrustAttestation(input: {
  moduleId: string;
  moduleVersion: string;
  predicate: OpenOpcDeveloperTrustPredicateV1;
  signer: EvidenceSigner;
}): Promise<{
  statement: Record<string, unknown> & { subject: unknown[] };
  envelope: DsseEnvelope;
  attestationDigest: `sha256:${string}`;
}> {
  if (!validIdentifier(input.moduleId) || !validIdentifier(input.moduleVersion)) {
    fail('DEVELOPER_TRUST_ATTESTATION_SUBJECT_INVALID');
  }
  validatePredicate(input.predicate);
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `${input.moduleId}@${input.moduleVersion}`,
        digest: { sha256: input.predicate.artifactDigest.slice('sha256:'.length) },
      },
    ],
    predicateType: OPENOPC_TRUST_PREDICATE_TYPE,
    predicate: { ...input.predicate },
  };
  const payload = Buffer.from(canonicalJson(statement), 'utf8');
  const signature = await input.signer.sign(dssePreAuthEncoding(IN_TOTO_PAYLOAD_TYPE, payload));
  const envelope: DsseEnvelope = {
    payloadType: IN_TOTO_PAYLOAD_TYPE,
    payload: payload.toString('base64'),
    signatures: [{ keyid: input.signer.keyId, sig: signature.toString('base64') }],
  };
  return {
    statement,
    envelope,
    attestationDigest: sha256(canonicalJson(envelope)),
  };
}

export async function validateOptionalSigstoreBundle(input: {
  bundle: Record<string, unknown>;
  subjectDigest: `sha256:${string}`;
  verifier?: { verify(bundle: Record<string, unknown>, subjectDigest: string): Promise<boolean> };
}): Promise<`sha256:${string}`> {
  if (!DIGEST.test(input.subjectDigest)) fail('DEVELOPER_TRUST_SIGSTORE_SUBJECT_INVALID');
  if (!input.verifier) fail('DEVELOPER_TRUST_SIGSTORE_VERIFIER_REQUIRED');
  let verified = false;
  try {
    verified = await input.verifier.verify(input.bundle, input.subjectDigest);
  } catch {
    fail('DEVELOPER_TRUST_SIGSTORE_VERIFICATION_FAILED');
  }
  if (!verified) fail('DEVELOPER_TRUST_SIGSTORE_VERIFICATION_FAILED');
  return sha256(canonicalJson({ bundle: input.bundle, subjectDigest: input.subjectDigest }));
}
