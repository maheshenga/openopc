import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { ModuleBetaTrustScenario } from '@openopc/module-runtime-contracts';

export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;
export const OPENOPC_TRUST_PREDICATE_TYPE =
  'https://openopc.dev/attestations/developer-module-verification/v1' as const;

export interface DeveloperTrustAcceptanceContextV1 {
  acceptanceRunId: string;
  registrationId: string;
  scenario: ModuleBetaTrustScenario;
}

export interface OpenOpcDeveloperTrustPredicateV1 {
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  runId: string;
  attempt: number;
  result: 'passed' | 'failed' | 'inconclusive' | 'cancelled';
  scannerIdentities: readonly string[];
  scannerIdentityVerified: boolean;
  evidenceDigests: readonly `sha256:${string}`[];
  startedAt: string;
  finishedAt: string;
  acceptance?: DeveloperTrustAcceptanceContextV1;
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
  verify(payload: Buffer, signature: Buffer): Promise<boolean>;
}

export class DeveloperTrustAttestationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeveloperTrustAttestationError';
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SCANNER_IDENTITY =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCEPTANCE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCEPTANCE_SCENARIOS = new Set<ModuleBetaTrustScenario>([
  'clean-wasi',
  'secret-leak',
  'vulnerable-lockfile',
  'invalid-signature',
  'stale-policy',
  'scanner-crash',
]);

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
    !Array.isArray(predicate.scannerIdentities) ||
    predicate.scannerIdentities.length < 1 ||
    predicate.scannerIdentities.length > 32 ||
    predicate.scannerIdentities.some((identity) => !SCANNER_IDENTITY.test(identity)) ||
    new Set(predicate.scannerIdentities).size !== predicate.scannerIdentities.length ||
    predicate.scannerIdentities.some(
      (identity, index) =>
        index > 0 && compareText(predicate.scannerIdentities[index - 1], identity) >= 0,
    ) ||
    typeof predicate.scannerIdentityVerified !== 'boolean' ||
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
  const acceptance = predicate.acceptance;
  if (acceptance !== undefined && !validAcceptanceContext(acceptance)) {
    fail('DEVELOPER_TRUST_ATTESTATION_ACCEPTANCE_CONTEXT_INVALID');
  }
  const startedAt = Date.parse(predicate.startedAt);
  const finishedAt = Date.parse(predicate.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    fail('DEVELOPER_TRUST_ATTESTATION_TIME_INVALID');
  }
}

function validAcceptanceContext(value: unknown): value is DeveloperTrustAcceptanceContextV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const keys = Object.keys(context).sort();
  return (
    keys.length === 3 &&
    keys[0] === 'acceptanceRunId' &&
    keys[1] === 'registrationId' &&
    keys[2] === 'scenario' &&
    typeof context.acceptanceRunId === 'string' &&
    ACCEPTANCE_RUN_ID.test(context.acceptanceRunId) &&
    typeof context.registrationId === 'string' &&
    UUID.test(context.registrationId) &&
    typeof context.scenario === 'string' &&
    ACCEPTANCE_SCENARIOS.has(context.scenario as ModuleBetaTrustScenario)
  );
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
  const publicKey = createPublicKey(privateKey);
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
    async verify(payload: Buffer, signature: Buffer): Promise<boolean> {
      try {
        return cryptoVerify(null, payload, publicKey, signature);
      } catch {
        return false;
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

export async function verifyDeveloperTrustAttestation(input: {
  envelope: DsseEnvelope;
  signer: Pick<EvidenceSigner, 'keyId' | 'verify'>;
}): Promise<boolean> {
  const { envelope, signer } = input;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1 ||
    envelope.signatures[0]?.keyid !== signer.keyId
  ) {
    return false;
  }
  const payload = strictBase64(envelope.payload, 1024 * 1024);
  const signature = strictBase64(envelope.signatures[0].sig, 512);
  if (!payload || !signature) return false;
  try {
    return await signer.verify(dssePreAuthEncoding(envelope.payloadType, payload), signature);
  } catch {
    return false;
  }
}

function strictBase64(value: unknown, maximumBytes: number): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength <= maximumBytes && decoded.toString('base64') === value
    ? decoded
    : null;
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
