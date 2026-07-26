export type ModuleBetaTrustFaultScenario = 'invalid-signature' | 'stale-policy' | 'scanner-crash';

export type ModuleBetaTrustScenario =
  | 'clean-wasi'
  | 'secret-leak'
  | 'vulnerable-lockfile'
  | ModuleBetaTrustFaultScenario;

export interface ModuleBetaArtifactRegistrationRequestV1 {
  schemaVersion: 1;
  acceptanceRunId: string;
  scenario: ModuleBetaTrustScenario;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
}

export interface ModuleBetaArtifactRegistrationResponseV1 {
  schemaVersion: 1;
  acceptanceRunId: string;
  scenario: ModuleBetaTrustScenario;
  registered: true;
  faultArmed: boolean;
  registrationId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  expiresAt: string;
  dependencyIdentity: string;
}

export interface ModuleBetaStoredEvidenceReferenceV1 {
  storage: 'minio';
  url: string;
  contentDigest: `sha256:${string}`;
  sizeBytes: number;
}

export interface ModuleBetaDsseEnvelopeV1 {
  payloadType: string;
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface ModuleBetaInspectorEvidenceV1 {
  schemaVersion: 1;
  acceptanceRunId: string;
  controllerIdentity: string;
  runId: string;
  artifact: ModuleBetaStoredEvidenceReferenceV1 & {
    artifactDigest: `sha256:${string}`;
  };
  sbom: ModuleBetaStoredEvidenceReferenceV1;
  attestation: {
    digest: `sha256:${string}`;
    keyId: string;
    envelope: ModuleBetaDsseEnvelopeV1;
  };
  scannerIdentities: string[];
}

export interface ModuleBetaCleanupRequestV1 {
  schemaVersion: 1;
  acceptanceRunId: string;
  accountId: string;
  cancelledUploadId: string;
  artifactIds: string[];
  releaseIds: string[];
  verificationRunIds: string[];
  createExpiredRetentionProbe: true;
  createOrphanObjectProbe: true;
}

export interface ModuleBetaCleanupResponseV1 {
  schemaVersion: 1;
  acceptanceRunId: string;
  dependencyIdentity: string;
  retention: {
    expiredProbeDeleted: true;
    immutableAttemptsPreserved: true;
  };
  orphanCleanup: {
    cancelledUploadAbsent: true;
    orphanProbeDeleted: true;
  };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/;
const DEPENDENCY_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FAULTS = new Set<ModuleBetaTrustFaultScenario>([
  'invalid-signature',
  'stale-policy',
  'scanner-crash',
]);
const SCENARIOS = new Set<ModuleBetaTrustScenario>([
  'clean-wasi',
  'secret-leak',
  'vulnerable-lockfile',
  ...FAULTS,
]);

export function parseModuleBetaArtifactRegistrationRequest(
  value: unknown,
): ModuleBetaArtifactRegistrationRequestV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'acceptanceRunId',
      'scenario',
      'accountId',
      'artifactId',
      'artifactDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    typeof value.scenario !== 'string' ||
    !SCENARIOS.has(value.scenario as ModuleBetaTrustScenario) ||
    typeof value.accountId !== 'string' ||
    !UUID.test(value.accountId) ||
    typeof value.artifactId !== 'string' ||
    !UUID.test(value.artifactId) ||
    typeof value.artifactDigest !== 'string' ||
    !DIGEST.test(value.artifactDigest)
  ) {
    throw new Error('MODULE_BETA_ARTIFACT_REGISTRATION_INVALID');
  }
  return structuredClone(value) as unknown as ModuleBetaArtifactRegistrationRequestV1;
}

export function parseModuleBetaArtifactRegistrationResponse(
  value: unknown,
): ModuleBetaArtifactRegistrationResponseV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'acceptanceRunId',
      'scenario',
      'registered',
      'faultArmed',
      'registrationId',
      'artifactId',
      'artifactDigest',
      'expiresAt',
      'dependencyIdentity',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    typeof value.scenario !== 'string' ||
    !SCENARIOS.has(value.scenario as ModuleBetaTrustScenario) ||
    value.registered !== true ||
    typeof value.faultArmed !== 'boolean' ||
    value.faultArmed !== FAULTS.has(value.scenario as ModuleBetaTrustFaultScenario) ||
    typeof value.registrationId !== 'string' ||
    !UUID.test(value.registrationId) ||
    typeof value.artifactId !== 'string' ||
    !UUID.test(value.artifactId) ||
    typeof value.artifactDigest !== 'string' ||
    !DIGEST.test(value.artifactDigest) ||
    !validDate(value.expiresAt) ||
    !validIdentity(value.dependencyIdentity)
  ) {
    throw new Error('MODULE_BETA_ARTIFACT_REGISTRATION_RESPONSE_INVALID');
  }
  return structuredClone(value) as unknown as ModuleBetaArtifactRegistrationResponseV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && DEPENDENCY_IDENTITY.test(value);
}

function validBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2 * 1024 * 1024) {
    return false;
  }
  if (!BASE64.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function validUuidArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.every((entry) => typeof entry === 'string' && UUID.test(entry)) &&
    new Set(value).size === value.length
  );
}

function validStoredReference(value: unknown): value is ModuleBetaStoredEvidenceReferenceV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['storage', 'url', 'contentDigest', 'sizeBytes']) ||
    value.storage !== 'minio' ||
    typeof value.url !== 'string' ||
    !DIGEST.test(String(value.contentDigest)) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) < 1 ||
    Number(value.sizeBytes) > 512 * 1024 * 1024
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname !== '/'
    );
  } catch {
    return false;
  }
}

function validEnvelope(value: unknown): value is ModuleBetaDsseEnvelopeV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['payloadType', 'payload', 'signatures']) ||
    typeof value.payloadType !== 'string' ||
    !IDENTIFIER.test(value.payloadType) ||
    !validBase64(value.payload) ||
    !Array.isArray(value.signatures) ||
    value.signatures.length !== 1
  ) {
    return false;
  }
  const signature = value.signatures[0];
  return (
    isRecord(signature) &&
    exactKeys(signature, ['keyid', 'sig']) &&
    typeof signature.keyid === 'string' &&
    IDENTIFIER.test(signature.keyid) &&
    validBase64(signature.sig)
  );
}

export function parseModuleBetaInspectorEvidence(value: unknown): ModuleBetaInspectorEvidenceV1 {
  const invalid = (): never => {
    throw new Error('MODULE_BETA_INSPECTOR_EVIDENCE_INVALID');
  };
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'acceptanceRunId',
      'controllerIdentity',
      'runId',
      'artifact',
      'sbom',
      'attestation',
      'scannerIdentities',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    !validIdentity(value.controllerIdentity) ||
    typeof value.runId !== 'string' ||
    !UUID.test(value.runId) ||
    !isRecord(value.artifact) ||
    !exactKeys(value.artifact, [
      'storage',
      'url',
      'contentDigest',
      'sizeBytes',
      'artifactDigest',
    ]) ||
    !validStoredReference({
      storage: value.artifact.storage,
      url: value.artifact.url,
      contentDigest: value.artifact.contentDigest,
      sizeBytes: value.artifact.sizeBytes,
    }) ||
    typeof value.artifact.artifactDigest !== 'string' ||
    !DIGEST.test(value.artifact.artifactDigest) ||
    !validStoredReference(value.sbom) ||
    !isRecord(value.attestation) ||
    !exactKeys(value.attestation, ['digest', 'keyId', 'envelope']) ||
    typeof value.attestation.digest !== 'string' ||
    !DIGEST.test(value.attestation.digest) ||
    typeof value.attestation.keyId !== 'string' ||
    !IDENTIFIER.test(value.attestation.keyId) ||
    !validEnvelope(value.attestation.envelope) ||
    value.attestation.envelope.signatures[0].keyid !== value.attestation.keyId ||
    !Array.isArray(value.scannerIdentities) ||
    value.scannerIdentities.length < 1 ||
    value.scannerIdentities.length > 32 ||
    value.scannerIdentities.some((identity) => !validIdentity(identity)) ||
    new Set(value.scannerIdentities).size !== value.scannerIdentities.length
  ) {
    invalid();
  }
  return structuredClone(value) as unknown as ModuleBetaInspectorEvidenceV1;
}

export function parseModuleBetaCleanupRequest(value: unknown): ModuleBetaCleanupRequestV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'acceptanceRunId',
      'accountId',
      'cancelledUploadId',
      'artifactIds',
      'releaseIds',
      'verificationRunIds',
      'createExpiredRetentionProbe',
      'createOrphanObjectProbe',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    typeof value.accountId !== 'string' ||
    !UUID.test(value.accountId) ||
    typeof value.cancelledUploadId !== 'string' ||
    !UUID.test(value.cancelledUploadId) ||
    !validUuidArray(value.artifactIds) ||
    !validUuidArray(value.releaseIds) ||
    !validUuidArray(value.verificationRunIds) ||
    value.createExpiredRetentionProbe !== true ||
    value.createOrphanObjectProbe !== true
  ) {
    throw new Error('MODULE_BETA_CLEANUP_REQUEST_INVALID');
  }
  return structuredClone(value) as unknown as ModuleBetaCleanupRequestV1;
}

export function parseModuleBetaCleanupResponse(value: unknown): ModuleBetaCleanupResponseV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'acceptanceRunId',
      'dependencyIdentity',
      'retention',
      'orphanCleanup',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    !validIdentity(value.dependencyIdentity) ||
    !isRecord(value.retention) ||
    !exactKeys(value.retention, ['expiredProbeDeleted', 'immutableAttemptsPreserved']) ||
    value.retention.expiredProbeDeleted !== true ||
    value.retention.immutableAttemptsPreserved !== true ||
    !isRecord(value.orphanCleanup) ||
    !exactKeys(value.orphanCleanup, ['cancelledUploadAbsent', 'orphanProbeDeleted']) ||
    value.orphanCleanup.cancelledUploadAbsent !== true ||
    value.orphanCleanup.orphanProbeDeleted !== true
  ) {
    throw new Error('MODULE_BETA_CLEANUP_RESPONSE_INVALID');
  }
  return structuredClone(value) as unknown as ModuleBetaCleanupResponseV1;
}
