import {
  canonicalPublicBetaJson,
  computeCanonicalPublicBetaDigest,
} from './public-beta-canonical-json';

export const PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE =
  'application/vnd.openopc.public-beta-artifact-manifest.v1+json';
export const PUBLIC_BETA_CYCLONEDX_MEDIA_TYPE = 'application/vnd.cyclonedx+json';
export const PUBLIC_BETA_DSSE_MEDIA_TYPE = 'application/vnd.dsse.envelope.v1+json';
export const PUBLIC_BETA_IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
export const PUBLIC_BETA_LINUX_SERVICE_BUNDLE_MEDIA_TYPE =
  'application/vnd.openopc.linux-service-bundle.v1+zstd';
export const PUBLIC_BETA_WINDOWS_UPDATE_BUNDLE_MEDIA_TYPE =
  'application/vnd.openopc.windows-update-bundle.v1+zstd';

export const PUBLIC_BETA_ARTIFACT_NAMES = Object.freeze([
  'web',
  'admin',
  'api',
  'module-host',
  'studio-worker',
  'developer-trust-worker',
  'automation-browser-worker',
  'module-ledger-worker',
  'wasi-runner',
  'oci-runner',
  'desktop',
] as const);

export type PublicBetaArtifactName = (typeof PUBLIC_BETA_ARTIFACT_NAMES)[number];

export type PublicBetaArtifactRolePolicy =
  | Readonly<{ mediaType: string; locatorKind: 'oci'; repository: string }>
  | Readonly<{ mediaType: string; locatorKind: 'bundle'; pathSuffix: '.tar.zst' }>;

export const PUBLIC_BETA_ARTIFACT_ROLE_POLICIES = Object.freeze({
  web: Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/web',
  }),
  admin: Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/admin',
  }),
  api: Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/api',
  }),
  'module-host': Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/module-host',
  }),
  'studio-worker': Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/studio-worker',
  }),
  'developer-trust-worker': Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/developer-trust-worker',
  }),
  'automation-browser-worker': Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/automation-browser-worker',
  }),
  'module-ledger-worker': Object.freeze({
    mediaType: PUBLIC_BETA_OCI_IMAGE_MEDIA_TYPE,
    locatorKind: 'oci',
    repository: 'openopc/module-ledger-worker',
  }),
  'wasi-runner': Object.freeze({
    mediaType: PUBLIC_BETA_LINUX_SERVICE_BUNDLE_MEDIA_TYPE,
    locatorKind: 'bundle',
    pathSuffix: '.tar.zst',
  }),
  'oci-runner': Object.freeze({
    mediaType: PUBLIC_BETA_LINUX_SERVICE_BUNDLE_MEDIA_TYPE,
    locatorKind: 'bundle',
    pathSuffix: '.tar.zst',
  }),
  desktop: Object.freeze({
    mediaType: PUBLIC_BETA_WINDOWS_UPDATE_BUNDLE_MEDIA_TYPE,
    locatorKind: 'bundle',
    pathSuffix: '.tar.zst',
  }),
} satisfies Record<PublicBetaArtifactName, PublicBetaArtifactRolePolicy>);

export const PUBLIC_BETA_ARTIFACT_MEDIA_TYPES = Object.freeze(
  Object.fromEntries(
    PUBLIC_BETA_ARTIFACT_NAMES.map((name) => [
      name,
      PUBLIC_BETA_ARTIFACT_ROLE_POLICIES[name].mediaType,
    ]),
  ),
) as Readonly<Record<PublicBetaArtifactName, string>>;

export interface PublicBetaArtifactManifestEntryV1 {
  name: PublicBetaArtifactName;
  digest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  provenanceDigest: `sha256:${string}`;
  mediaType: string;
}

export interface PublicBetaArtifactManifestV1 {
  schemaVersion: 1;
  commit: string;
  artifacts: PublicBetaArtifactManifestEntryV1[];
  manifestDigest: `sha256:${string}`;
}

export interface VerifyPublicBetaArtifactManifestOptions {
  expectedCommit: string;
  verifyArtifact?: (artifact: Readonly<PublicBetaArtifactManifestEntryV1>) => boolean;
  verifySbom?: (artifact: Readonly<PublicBetaArtifactManifestEntryV1>) => boolean;
  verifyProvenance?: (artifact: Readonly<PublicBetaArtifactManifestEntryV1>) => boolean;
}

const MANIFEST_KEYS = ['schemaVersion', 'commit', 'artifacts', 'manifestDigest'] as const;
const ARTIFACT_KEYS = ['name', 'digest', 'sbomDigest', 'provenanceDigest', 'mediaType'] as const;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\+[a-z0-9][a-z0-9!#$&^_.+-]*)?$/;
const CREDENTIAL_TEXT =
  /(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i;
const SBOM_COMPONENT_TYPES = new Set([
  'application',
  'container',
  'device',
  'file',
  'firmware',
  'framework',
  'library',
  'operating-system',
]);

type JsonRecord = Record<string, unknown>;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  );
}

function validHashes(value: unknown, expectedSha256?: string): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false;
  const algorithms = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, ['alg', 'content'])) return false;
    const expectedLength = { 'SHA-256': 64, 'SHA-384': 96, 'SHA-512': 128 }[
      String(item.alg)
    ];
    if (
      expectedLength === undefined ||
      algorithms.has(String(item.alg)) ||
      typeof item.content !== 'string' ||
      item.content.length !== expectedLength ||
      !/^[0-9a-f]+$/.test(item.content)
    ) {
      return false;
    }
    algorithms.add(String(item.alg));
  }
  return (
    expectedSha256 === undefined ||
    value.some(
      (item) => isRecord(item) && item.alg === 'SHA-256' && item.content === expectedSha256,
    )
  );
}

function exactBase64(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    fail('PUBLIC_BETA_DSSE_BASE64_INVALID');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) fail('PUBLIC_BETA_DSSE_BASE64_INVALID');
  return decoded;
}

function dssePreAuthEncoding(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = Buffer.from(payloadType, 'utf8');
  const body = Buffer.from(payload);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.byteLength} `, 'utf8'),
    type,
    Buffer.from(` ${body.byteLength} `, 'utf8'),
    body,
  ]);
}

function validTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalArtifacts(
  artifacts: readonly Readonly<PublicBetaArtifactManifestEntryV1>[],
): PublicBetaArtifactManifestEntryV1[] {
  const order = new Map(PUBLIC_BETA_ARTIFACT_NAMES.map((name, index) => [name, index]));
  return [...artifacts]
    .sort(
      (left, right) =>
        (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.name) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((artifact) => ({ ...artifact }));
}

export interface ParsePublicBetaCycloneDxSbomOptions {
  artifactName: PublicBetaArtifactName;
  artifactDigest: `sha256:${string}`;
  commit: string;
}

export function parsePublicBetaCycloneDxSbom(
  value: unknown,
  options: ParsePublicBetaCycloneDxSbomOptions,
): JsonRecord {
  if (
    !PUBLIC_BETA_ARTIFACT_NAMES.includes(options.artifactName) ||
    !DIGEST.test(options.artifactDigest) ||
    !COMMIT.test(options.commit)
  ) {
    fail('PUBLIC_BETA_SBOM_OPTIONS_INVALID');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bomFormat',
      'specVersion',
      'version',
      'metadata',
      'components',
      'dependencies',
    ]) ||
    value.bomFormat !== 'CycloneDX' ||
    value.specVersion !== '1.6' ||
    value.version !== 1 ||
    !isRecord(value.metadata) ||
    !hasExactKeys(value.metadata, ['component']) ||
    !isRecord(value.metadata.component) ||
    !hasExactKeys(value.metadata.component, [
      'type',
      'name',
      'version',
      'bom-ref',
      'hashes',
    ]) ||
    !Array.isArray(value.components) ||
    value.components.length > 10_000 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 10_000
  ) {
    fail('PUBLIC_BETA_SBOM_INVALID');
  }

  const root = value.metadata.component;
  const expectedReference = `urn:openopc:artifact:${options.artifactName}@${options.artifactDigest}`;
  if (
    !SBOM_COMPONENT_TYPES.has(String(root.type)) ||
    root.name !== options.artifactName ||
    root.version !== options.commit ||
    root['bom-ref'] !== expectedReference ||
    !validHashes(root.hashes, options.artifactDigest.slice('sha256:'.length))
  ) {
    fail('PUBLIC_BETA_SBOM_SUBJECT_MISMATCH');
  }

  const references = new Set<string>([expectedReference]);
  for (const item of value.components) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['type', 'name', 'version', 'purl', 'bom-ref', 'hashes']) ||
      !SBOM_COMPONENT_TYPES.has(String(item.type)) ||
      !boundedText(item.name, 214) ||
      !boundedText(item.version, 128) ||
      !boundedText(item.purl, 512) ||
      !String(item.purl).startsWith('pkg:') ||
      item['bom-ref'] !== item.purl ||
      references.has(String(item['bom-ref'])) ||
      (item.hashes !== undefined && !validHashes(item.hashes))
    ) {
      fail('PUBLIC_BETA_SBOM_COMPONENT_INVALID');
    }
    references.add(String(item['bom-ref']));
  }

  const dependencyReferences = new Set<string>();
  for (const item of value.dependencies) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['ref', 'dependsOn']) ||
      typeof item.ref !== 'string' ||
      !references.has(item.ref) ||
      dependencyReferences.has(item.ref) ||
      !Array.isArray(item.dependsOn) ||
      new Set(item.dependsOn).size !== item.dependsOn.length ||
      item.dependsOn.some((reference) => typeof reference !== 'string' || !references.has(reference))
    ) {
      fail('PUBLIC_BETA_SBOM_DEPENDENCY_INVALID');
    }
    dependencyReferences.add(item.ref);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('PUBLIC_BETA_SBOM_INVALID');
  }
  if (serialized.length > 32 * 1024 * 1024 || CREDENTIAL_TEXT.test(serialized)) {
    fail('PUBLIC_BETA_SBOM_SENSITIVE_CONTENT');
  }
  return structuredClone(value);
}

export interface PublicBetaDsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface VerifyPublicBetaDsseProvenanceOptions {
  artifactName: PublicBetaArtifactName;
  artifactDigest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  commit: string;
  repository: string;
  builderId: string;
  verifySignature?(
    envelope: Readonly<PublicBetaDsseEnvelope>,
    preAuthEncoding: Uint8Array,
  ): boolean;
}

export function verifyPublicBetaDsseProvenance(
  value: unknown,
  options: VerifyPublicBetaDsseProvenanceOptions,
): JsonRecord {
  if (
    !PUBLIC_BETA_ARTIFACT_NAMES.includes(options.artifactName) ||
    !DIGEST.test(options.artifactDigest) ||
    !DIGEST.test(options.sbomDigest) ||
    !COMMIT.test(options.commit) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
    !boundedText(options.builderId, 2_048) ||
    !options.builderId.startsWith('https://github.com/')
  ) {
    fail('PUBLIC_BETA_PROVENANCE_OPTIONS_INVALID');
  }
  if (typeof options.verifySignature !== 'function') {
    fail('PUBLIC_BETA_PROVENANCE_SIGNATURE_VERIFIER_REQUIRED');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payloadType', 'payload', 'signatures']) ||
    value.payloadType !== PUBLIC_BETA_IN_TOTO_PAYLOAD_TYPE ||
    typeof value.payload !== 'string' ||
    !Array.isArray(value.signatures) ||
    value.signatures.length !== 1
  ) {
    fail('PUBLIC_BETA_DSSE_ENVELOPE_INVALID');
  }
  const signature = value.signatures[0];
  if (
    !isRecord(signature) ||
    !hasExactKeys(signature, ['keyid', 'sig']) ||
    !boundedText(signature.keyid, 256) ||
    typeof signature.sig !== 'string'
  ) {
    fail('PUBLIC_BETA_DSSE_SIGNATURE_INVALID');
  }
  const payload = exactBase64(value.payload);
  const signatureBytes = exactBase64(signature.sig);
  if (payload.byteLength < 1 || payload.byteLength > 16 * 1024 * 1024 || signatureBytes.byteLength < 1) {
    fail('PUBLIC_BETA_DSSE_ENVELOPE_INVALID');
  }

  let statement: unknown;
  let payloadText: string;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    statement = JSON.parse(payloadText) as unknown;
  } catch {
    fail('PUBLIC_BETA_DSSE_PAYLOAD_INVALID');
  }
  let canonicalPayload: string;
  try {
    canonicalPayload = canonicalPublicBetaJson(statement);
  } catch {
    fail('PUBLIC_BETA_DSSE_PAYLOAD_NOT_CANONICAL');
  }
  if (canonicalPayload !== payloadText) {
    fail('PUBLIC_BETA_DSSE_PAYLOAD_NOT_CANONICAL');
  }
  if (
    !isRecord(statement) ||
    !hasExactKeys(statement, ['_type', 'subject', 'predicateType', 'predicate']) ||
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    !isRecord(statement.subject[0]) ||
    !hasExactKeys(statement.subject[0], ['name', 'digest']) ||
    !isRecord(statement.subject[0].digest) ||
    !hasExactKeys(statement.subject[0].digest, ['sha256']) ||
    statement.subject[0].name !== options.artifactName ||
    statement.subject[0].digest.sha256 !== options.artifactDigest.slice('sha256:'.length) ||
    !isRecord(statement.predicate) ||
    !hasExactKeys(statement.predicate, ['buildDefinition', 'runDetails'])
  ) {
    fail('PUBLIC_BETA_PROVENANCE_STATEMENT_INVALID');
  }

  const buildDefinition = statement.predicate.buildDefinition;
  const runDetails = statement.predicate.runDetails;
  if (
    !isRecord(buildDefinition) ||
    !hasExactKeys(buildDefinition, [
      'buildType',
      'externalParameters',
      'internalParameters',
      'resolvedDependencies',
    ]) ||
    buildDefinition.buildType !== 'https://openopc.dev/buildtypes/public-beta/v1' ||
    !isRecord(buildDefinition.externalParameters) ||
    !hasExactKeys(buildDefinition.externalParameters, [
      'artifactName',
      'commit',
      'sbomDigest',
    ]) ||
    buildDefinition.externalParameters.artifactName !== options.artifactName ||
    buildDefinition.externalParameters.commit !== options.commit ||
    buildDefinition.externalParameters.sbomDigest !== options.sbomDigest ||
    !isRecord(buildDefinition.internalParameters) ||
    Object.keys(buildDefinition.internalParameters).length !== 0 ||
    !Array.isArray(buildDefinition.resolvedDependencies) ||
    buildDefinition.resolvedDependencies.length !== 1
  ) {
    fail('PUBLIC_BETA_PROVENANCE_BUILD_DEFINITION_INVALID');
  }
  const source = buildDefinition.resolvedDependencies[0];
  if (
    !isRecord(source) ||
    !hasExactKeys(source, ['uri', 'digest']) ||
    source.uri !== `git+https://github.com/${options.repository}@${options.commit}` ||
    !isRecord(source.digest) ||
    !hasExactKeys(source.digest, ['gitCommit']) ||
    source.digest.gitCommit !== options.commit
  ) {
    fail('PUBLIC_BETA_PROVENANCE_SOURCE_INVALID');
  }
  if (
    !isRecord(runDetails) ||
    !hasExactKeys(runDetails, ['builder', 'metadata']) ||
    !isRecord(runDetails.builder) ||
    !hasExactKeys(runDetails.builder, ['id']) ||
    runDetails.builder.id !== options.builderId ||
    !isRecord(runDetails.metadata) ||
    !hasExactKeys(runDetails.metadata, ['invocationId', 'startedOn', 'finishedOn']) ||
    !boundedText(runDetails.metadata.invocationId, 2_048) ||
    !String(runDetails.metadata.invocationId).startsWith(
      `https://github.com/${options.repository}/actions/runs/`,
    ) ||
    !validTimestamp(runDetails.metadata.startedOn) ||
    !validTimestamp(runDetails.metadata.finishedOn) ||
    Date.parse(runDetails.metadata.startedOn) > Date.parse(runDetails.metadata.finishedOn)
  ) {
    fail('PUBLIC_BETA_PROVENANCE_RUN_DETAILS_INVALID');
  }

  const envelope = value as unknown as PublicBetaDsseEnvelope;
  try {
    if (
      options.verifySignature(envelope, dssePreAuthEncoding(envelope.payloadType, payload)) !== true
    ) {
      fail('PUBLIC_BETA_PROVENANCE_SIGNATURE_INVALID');
    }
  } catch {
    fail('PUBLIC_BETA_PROVENANCE_SIGNATURE_INVALID');
  }
  return structuredClone(statement);
}

export function computePublicBetaArtifactManifestDigest(
  value: Pick<PublicBetaArtifactManifestV1, 'schemaVersion' | 'commit' | 'artifacts'>,
): `sha256:${string}` {
  const payload = {
    schemaVersion: value.schemaVersion,
    commit: value.commit,
    artifacts: canonicalArtifacts(value.artifacts),
  };
  return computeCanonicalPublicBetaDigest(payload);
}

function parseArtifact(value: unknown): PublicBetaArtifactManifestEntryV1 {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) {
    fail('PUBLIC_BETA_ARTIFACT_MANIFEST_INVALID');
  }
  if (
    typeof value.name !== 'string' ||
    !PUBLIC_BETA_ARTIFACT_NAMES.includes(value.name as PublicBetaArtifactName) ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest) ||
    typeof value.sbomDigest !== 'string' ||
    !DIGEST.test(value.sbomDigest) ||
    typeof value.provenanceDigest !== 'string' ||
    !DIGEST.test(value.provenanceDigest) ||
    typeof value.mediaType !== 'string' ||
    value.mediaType.length > 255 ||
    !MEDIA_TYPE.test(value.mediaType)
  ) {
    fail('PUBLIC_BETA_ARTIFACT_MANIFEST_INVALID');
  }
  if (
    value.mediaType !==
    PUBLIC_BETA_ARTIFACT_MEDIA_TYPES[value.name as PublicBetaArtifactName]
  ) {
    fail('PUBLIC_BETA_ARTIFACT_MEDIA_TYPE_MISMATCH');
  }
  return value as unknown as PublicBetaArtifactManifestEntryV1;
}

export function parsePublicBetaArtifactManifest(value: unknown): PublicBetaArtifactManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    fail('PUBLIC_BETA_ARTIFACT_MANIFEST_INVALID');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.commit !== 'string' ||
    !COMMIT.test(value.commit) ||
    !Array.isArray(value.artifacts) ||
    typeof value.manifestDigest !== 'string' ||
    !DIGEST.test(value.manifestDigest)
  ) {
    fail('PUBLIC_BETA_ARTIFACT_MANIFEST_INVALID');
  }

  const artifacts = value.artifacts.map(parseArtifact);
  const names = artifacts.map((artifact) => artifact.name);
  if (
    artifacts.length !== PUBLIC_BETA_ARTIFACT_NAMES.length ||
    new Set(names).size !== artifacts.length ||
    PUBLIC_BETA_ARTIFACT_NAMES.some((name) => !names.includes(name))
  ) {
    fail('PUBLIC_BETA_ARTIFACT_SET_INCOMPLETE');
  }
  if (new Set(artifacts.map((artifact) => artifact.digest)).size !== artifacts.length) {
    fail('PUBLIC_BETA_ARTIFACT_DIGEST_REUSED');
  }
  if (new Set(artifacts.map((artifact) => artifact.sbomDigest)).size !== artifacts.length) {
    fail('PUBLIC_BETA_SBOM_DIGEST_REUSED');
  }
  if (
    new Set(artifacts.map((artifact) => artifact.provenanceDigest)).size !== artifacts.length
  ) {
    fail('PUBLIC_BETA_PROVENANCE_DIGEST_REUSED');
  }

  const parsed: PublicBetaArtifactManifestV1 = {
    schemaVersion: 1,
    commit: value.commit,
    artifacts: canonicalArtifacts(artifacts),
    manifestDigest: value.manifestDigest as `sha256:${string}`,
  };
  if (parsed.manifestDigest !== computePublicBetaArtifactManifestDigest(parsed)) {
    fail('PUBLIC_BETA_ARTIFACT_MANIFEST_DIGEST_INVALID');
  }
  return parsed;
}

export function verifyPublicBetaArtifactManifest(
  value: unknown,
  options: VerifyPublicBetaArtifactManifestOptions,
): PublicBetaArtifactManifestV1 {
  const parsed = parsePublicBetaArtifactManifest(value);
  if (
    !isRecord(options) ||
    typeof options.expectedCommit !== 'string' ||
    !COMMIT.test(options.expectedCommit)
  ) {
    fail('PUBLIC_BETA_ARTIFACT_OPTIONS_INVALID');
  }
  if (parsed.commit !== options.expectedCommit) fail('PUBLIC_BETA_ARTIFACT_COMMIT_MISMATCH');
  if (typeof options.verifyArtifact !== 'function') fail('PUBLIC_BETA_ARTIFACT_VERIFIER_REQUIRED');
  if (typeof options.verifySbom !== 'function') fail('PUBLIC_BETA_SBOM_VERIFIER_REQUIRED');
  if (typeof options.verifyProvenance !== 'function') {
    fail('PUBLIC_BETA_PROVENANCE_VERIFIER_REQUIRED');
  }

  for (const artifact of parsed.artifacts) {
    try {
      if (!options.verifyArtifact(artifact)) fail('PUBLIC_BETA_ARTIFACT_UNVERIFIED');
    } catch {
      fail('PUBLIC_BETA_ARTIFACT_UNVERIFIED');
    }
    try {
      if (!options.verifySbom(artifact)) fail('PUBLIC_BETA_SBOM_UNVERIFIED');
    } catch {
      fail('PUBLIC_BETA_SBOM_UNVERIFIED');
    }
    try {
      if (!options.verifyProvenance(artifact)) fail('PUBLIC_BETA_PROVENANCE_UNVERIFIED');
    } catch {
      fail('PUBLIC_BETA_PROVENANCE_UNVERIFIED');
    }
  }
  return parsed;
}
