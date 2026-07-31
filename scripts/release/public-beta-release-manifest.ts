import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE,
  PUBLIC_BETA_ARTIFACT_NAMES,
  PUBLIC_BETA_ARTIFACT_ROLE_POLICIES,
  PUBLIC_BETA_CYCLONEDX_MEDIA_TYPE,
  PUBLIC_BETA_DSSE_MEDIA_TYPE,
  type PublicBetaArtifactManifestEntryV1,
  type PublicBetaArtifactManifestV1,
  type PublicBetaArtifactName,
  type PublicBetaDsseEnvelope,
  parsePublicBetaArtifactManifest,
  parsePublicBetaCycloneDxSbom,
  verifyPublicBetaArtifactManifest,
  verifyPublicBetaDsseProvenance,
} from './public-beta-artifacts';
import {
  canonicalPublicBetaJson,
  computeCanonicalPublicBetaDigest,
  computePublicBetaSha256,
} from './public-beta-canonical-json';
import {
  type PublicBetaEvidenceLedgerV2,
  validatePublicBetaEvidenceLedgerV2,
} from './public-beta-evidence-v2';
import { OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE } from './public-beta-release-profile';
import { OPENOPC_RESTRICTED_PUBLIC_BETA_LANES } from './public-beta-restricted-lanes';
import {
  readPublicBetaBoundedJson,
  readPublicBetaVerifiedJson,
  verifyPublicBetaFile,
} from './public-beta-safe-files';

export type PublicBetaReleaseArtifactName = PublicBetaArtifactName;

export const PUBLIC_BETA_RELEASE_ARTIFACT_NAMES = PUBLIC_BETA_ARTIFACT_NAMES;

const ENVIRONMENT = 'openopc-public-beta-staging' as const;
const MANIFEST_KEYS = [
  'schemaVersion',
  'candidateId',
  'commit',
  'environment',
  'artifacts',
  'artifactManifestPath',
  'artifactManifestDigest',
  'evidencePath',
  'evidenceDigest',
  'rollbackTarget',
  'policyVersions',
  'regionalEvidence',
  'approval',
] as const;
const ARTIFACT_KEYS = ['name', 'digest', 'imageOrPath'] as const;
const ROLLBACK_KEYS = ['commit', 'manifestDigest'] as const;
const POLICY_KEYS = ['terms', 'privacy', 'acceptableUse', 'moduleRules'] as const;
const REGIONAL_KEYS = ['id', 'status', 'artifactDigest'] as const;
const APPROVAL_KEYS = ['environment', 'actor', 'approvedAt', 'manifestDigest'] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,254}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const REMOTE_ARTIFACT_REFERENCE =
  /^(https|oci):\/\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/([^?#]+)@sha256:([0-9a-f]{64})$/;
const MAX_REMOTE_ARTIFACT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_OCI_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_OCI_TOKEN_RESPONSE_BYTES = 1024 * 1024;
const MAX_SBOM_BYTES = 32 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 24 * 1024 * 1024;
const PUBLIC_BETA_PROVENANCE_WORKFLOW = 'openopc-public-beta-gates.yml';
const EVIDENCE_SCHEMA_PATH = fileURLToPath(
  new URL('../../tests/public-beta/evidence.v2.schema.json', import.meta.url),
);
const OCI_MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

type ResolveHostname = (hostname: string) => Promise<readonly string[]>;

export interface PublicBetaReleaseManifestV1 {
  schemaVersion: 1;
  candidateId: string;
  commit: string;
  environment: typeof ENVIRONMENT;
  artifacts: Array<{
    name: PublicBetaReleaseArtifactName;
    digest: `sha256:${string}`;
    imageOrPath: string;
  }>;
  artifactManifestPath: string;
  artifactManifestDigest: `sha256:${string}`;
  evidencePath: string;
  evidenceDigest: `sha256:${string}`;
  rollbackTarget: { commit: string; manifestDigest: `sha256:${string}` };
  policyVersions: {
    terms: string;
    privacy: string;
    acceptableUse: string;
    moduleRules: string;
  };
  regionalEvidence: Array<{
    id: string;
    status: 'satisfied' | 'not_applicable';
    artifactDigest: `sha256:${string}`;
  }>;
  approval: null | {
    environment: 'production';
    actor: string;
    approvedAt: string;
    manifestDigest: `sha256:${string}`;
  };
}

export interface PublicBetaEvidenceInput {
  ledger: PublicBetaEvidenceLedgerV2;
  rawBytes: string | Uint8Array;
  artifactManifest?: unknown;
  artifactManifestRawBytes?: string | Uint8Array;
  verifyArtifact(path: string, digest: string, sizeBytes: number): boolean;
  verifyReleaseArtifact(
    artifact: Readonly<PublicBetaReleaseManifestV1['artifacts'][number]>,
  ): boolean;
  verifyArtifactSbom?(artifact: Readonly<PublicBetaArtifactManifestEntryV1>): boolean;
  verifyArtifactProvenance?(artifact: Readonly<PublicBetaArtifactManifestEntryV1>): boolean;
  verifyProvenance?(
    manifest: Readonly<PublicBetaReleaseManifestV1>,
    ledger: Readonly<PublicBetaEvidenceLedgerV2>,
    artifactManifest: Readonly<PublicBetaArtifactManifestV1>,
  ): boolean;
}

export interface PublicBetaReadinessResult {
  status: 'ready' | 'not_ready';
  reasons: string[];
}

export interface PublicBetaReleaseManifestCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  cwd: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function fail(code: string): never {
  throw new Error(code);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validRelativePath(value: unknown, maxLength: number): value is string {
  if (!boundedString(value, maxLength) || isAbsolute(value) || value.includes('\\')) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => PATH_SEGMENT.test(segment));
}

function contentAddressedArtifactDigest(value: unknown): `sha256:${string}` | null {
  if (!boundedString(value, 2_048)) return null;
  const match = REMOTE_ARTIFACT_REFERENCE.exec(value);
  if (!match) return null;
  const repositoryPath = match[3];
  const digest = match[4];
  if (
    repositoryPath === undefined ||
    digest === undefined ||
    repositoryPath.split('/').some((segment) => !PATH_SEGMENT.test(segment))
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'oci:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return `sha256:${digest}`;
}

function remoteArtifactReference(value: string): {
  scheme: 'https' | 'oci';
  registry: string;
  repositoryPath: string;
  digest: `sha256:${string}`;
} | null {
  const match = REMOTE_ARTIFACT_REFERENCE.exec(value);
  const scheme = match?.[1];
  const registry = match?.[2];
  const repositoryPath = match?.[3];
  const digest = match?.[4];
  if (
    (scheme !== 'https' && scheme !== 'oci') ||
    registry === undefined ||
    repositoryPath === undefined ||
    digest === undefined
  ) {
    return null;
  }
  return {
    scheme,
    registry,
    repositoryPath,
    digest: `sha256:${digest}`,
  };
}

function publicRemoteArtifactHost(value: string): boolean {
  try {
    const hostname = new URL(`https://${value}`).hostname.toLowerCase();
    return (
      isIP(hostname) === 0 &&
      hostname.includes('.') &&
      hostname !== 'localhost' &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local') &&
      !hostname.endsWith('.internal')
    );
  } catch {
    return false;
  }
}

function publicIpv4Address(address: string): boolean {
  const octets = address.split('.').map(Number);
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function ipv6Words(address: string): readonly number[] | null {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (half === '') return [];
    const words: number[] = [];
    for (const segment of half.split(':')) {
      if (segment.includes('.')) {
        if (isIP(segment) !== 4) return null;
        const [first, second, third, fourth] = segment.split('.').map(Number);
        if (
          first === undefined ||
          second === undefined ||
          third === undefined ||
          fourth === undefined
        ) {
          return null;
        }
        words.push((first << 8) | second, (third << 8) | fourth);
      } else {
        const word = Number.parseInt(segment, 16);
        if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null;
        words.push(word);
      }
    }
    return words;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (left === null || right === null) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function publicIpv6Address(address: string): boolean {
  const words = ipv6Words(address);
  if (words === null || words.length !== 8) return false;
  const first = words[0];
  const mappedHigh = words[6];
  const mappedLow = words[7];
  if (first === undefined || mappedHigh === undefined || mappedLow === undefined) return false;
  const unspecified = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (ipv4Mapped) {
    const mapped = `${mappedHigh >> 8}.${mappedHigh & 0xff}.${mappedLow >> 8}.${mappedLow & 0xff}`;
    return publicIpv4Address(mapped);
  }
  return !(
    unspecified ||
    loopback ||
    words.slice(0, 6).every((word) => word === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && words[1] === 0x0db8)
  );
}

function publicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4Address(address);
  if (family === 6) return publicIpv6Address(address);
  return false;
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
}

async function hostResolvesOnlyToPublicAddresses(
  host: string,
  resolveHostname: ResolveHostname,
): Promise<boolean> {
  try {
    const hostname = new URL(`https://${host}`).hostname;
    const addresses = await resolveHostname(hostname);
    return addresses.length > 0 && addresses.every(publicNetworkAddress);
  } catch {
    return false;
  }
}

async function responseMatchesDigest(
  response: Response,
  expectedDigest: `sha256:${string}`,
  maxBytes = MAX_REMOTE_ARTIFACT_BYTES,
): Promise<boolean> {
  if (!response.ok) return false;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maxBytes
    ) {
      return false;
    }
  }

  const hash = createHash('sha256');
  const reader = response.body?.getReader();
  if (!reader) return expectedDigest === `sha256:${hash.digest('hex')}`;
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        return false;
      }
      hash.update(value);
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
  return expectedDigest === `sha256:${hash.digest('hex')}`;
}

async function boundedResponseJson(
  response: Response,
  maxBytes: number,
): Promise<JsonRecord | null> {
  if (!response.ok) return null;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      return null;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function bearerChallenge(value: string | null): {
  realm: string;
  service?: string;
  scope?: string;
} | null {
  if (value === null || !/^Bearer\s/i.test(value)) return null;
  const attributes = new Map<string, string>();
  for (const match of value.matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      attributes.set(match[1].toLowerCase(), match[2]);
    }
  }
  const realm = attributes.get('realm');
  if (realm === undefined) return null;
  return {
    realm,
    service: attributes.get('service'),
    scope: attributes.get('scope'),
  };
}

async function ociAuthorization(
  response: Response,
  repositoryPath: string,
  fetcher: typeof fetch,
  resolveHostname: ResolveHostname,
): Promise<string | null> {
  if (response.status !== 401) return null;
  const challenge = bearerChallenge(response.headers.get('www-authenticate'));
  if (challenge === null) return null;
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(challenge.realm);
  } catch {
    return null;
  }
  if (
    tokenUrl.protocol !== 'https:' ||
    tokenUrl.username !== '' ||
    tokenUrl.password !== '' ||
    !publicRemoteArtifactHost(tokenUrl.host) ||
    !(await hostResolvesOnlyToPublicAddresses(tokenUrl.host, resolveHostname))
  ) {
    return null;
  }
  if (challenge.service !== undefined) tokenUrl.searchParams.set('service', challenge.service);
  tokenUrl.searchParams.set('scope', challenge.scope ?? `repository:${repositoryPath}:pull`);
  try {
    const tokenResponse = await fetcher(tokenUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const value = await boundedResponseJson(tokenResponse, MAX_OCI_TOKEN_RESPONSE_BYTES);
    if (value === null) return null;
    const token = typeof value.token === 'string' ? value.token : value.access_token;
    return typeof token === 'string' && token.length > 0 ? `Bearer ${token}` : null;
  } catch {
    return null;
  }
}

export async function verifyRemotePublicBetaReleaseArtifact(
  artifact: Readonly<PublicBetaReleaseManifestV1['artifacts'][number]>,
  fetcher: typeof fetch = fetch,
  resolveHostname: ResolveHostname = defaultResolveHostname,
): Promise<boolean> {
  if (!validArtifactReference(artifact.name, artifact.digest, artifact.imageOrPath)) {
    return false;
  }
  const reference = remoteArtifactReference(artifact.imageOrPath);
  if (
    reference === null ||
    reference.digest !== artifact.digest ||
    !publicRemoteArtifactHost(reference.registry)
  ) {
    return false;
  }
  try {
    if (!(await hostResolvesOnlyToPublicAddresses(reference.registry, resolveHostname))) {
      return false;
    }
    if (reference.scheme === 'https') {
      const response = await fetcher(artifact.imageOrPath, {
        redirect: 'error',
        signal: AbortSignal.timeout(5 * 60 * 1_000),
      });
      return responseMatchesDigest(response, artifact.digest);
    }

    const manifestUrl = `https://${reference.registry}/v2/${reference.repositoryPath}/manifests/${reference.digest}`;
    const request = (authorization?: string) =>
      fetcher(manifestUrl, {
        method: 'GET',
        headers: {
          accept: OCI_MANIFEST_ACCEPT,
          ...(authorization === undefined ? {} : { authorization }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    let response = await request();
    if (response.status === 401) {
      const authorization = await ociAuthorization(
        response,
        reference.repositoryPath,
        fetcher,
        resolveHostname,
      );
      if (authorization === null) return false;
      response = await request(authorization);
    }
    return (
      response.headers.get('docker-content-digest')?.toLowerCase() === artifact.digest &&
      (await responseMatchesDigest(response, artifact.digest, MAX_OCI_MANIFEST_BYTES))
    );
  } catch {
    return false;
  }
}

function pathBindsArtifactRole(
  name: PublicBetaReleaseArtifactName,
  value: string,
  suffix: string,
): boolean {
  if (!value.endsWith(suffix)) return false;
  const segments = value.split('/');
  const filename = segments.at(-1);
  return filename === `${name}${suffix}` || filename?.startsWith(`${name}-`) === true;
}

function validArtifactReference(
  name: PublicBetaReleaseArtifactName,
  digest: `sha256:${string}`,
  value: unknown,
): value is string {
  if (!boundedString(value, 2_048)) return false;
  const policy = PUBLIC_BETA_ARTIFACT_ROLE_POLICIES[name];
  const remote = remoteArtifactReference(value);
  if (policy.locatorKind === 'oci') {
    return (
      remote?.scheme === 'oci' &&
      remote.repositoryPath === policy.repository &&
      remote.digest === digest
    );
  }
  if (validRelativePath(value, 2_048)) {
    return pathBindsArtifactRole(name, value, policy.pathSuffix);
  }
  return (
    remote?.scheme === 'https' &&
    remote.digest === digest &&
    pathBindsArtifactRole(name, remote.repositoryPath, policy.pathSuffix)
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = value.includes('.') ? value : `${value.slice(0, -1)}.000Z`;
  return new Date(parsed).toISOString() === canonical;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

export function computePublicBetaEvidenceDigest(raw: string | Uint8Array): `sha256:${string}` {
  return computePublicBetaSha256(raw);
}

/** Computes the digest used by approval attestation: approval is always null. */
export function computePublicBetaManifestDigest(
  manifest: PublicBetaReleaseManifestV1,
): `sha256:${string}` {
  const preApproval = { ...manifest, approval: null };
  try {
    return computeCanonicalPublicBetaDigest(preApproval);
  } catch {
    fail('PUBLIC_BETA_RELEASE_MANIFEST_INVALID');
  }
}

function parseArtifact(value: unknown): PublicBetaReleaseManifestV1['artifacts'][number] {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) {
    fail('PUBLIC_BETA_RELEASE_ARTIFACT_INVALID');
  }
  if (
    typeof value.name !== 'string' ||
    !PUBLIC_BETA_RELEASE_ARTIFACT_NAMES.includes(value.name as PublicBetaReleaseArtifactName) ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest)
  ) {
    fail('PUBLIC_BETA_RELEASE_ARTIFACT_INVALID');
  }
  if (
    !validArtifactReference(
      value.name as PublicBetaReleaseArtifactName,
      value.digest as `sha256:${string}`,
      value.imageOrPath,
    )
  ) {
    fail('PUBLIC_BETA_RELEASE_ARTIFACT_INVALID');
  }
  return value as PublicBetaReleaseManifestV1['artifacts'][number];
}

function parseRollback(value: unknown): PublicBetaReleaseManifestV1['rollbackTarget'] {
  if (!isRecord(value) || !hasExactKeys(value, ROLLBACK_KEYS)) {
    fail('PUBLIC_BETA_RELEASE_ROLLBACK_INVALID');
  }
  if (
    typeof value.commit !== 'string' ||
    !COMMIT.test(value.commit) ||
    typeof value.manifestDigest !== 'string' ||
    !DIGEST.test(value.manifestDigest)
  ) {
    fail('PUBLIC_BETA_RELEASE_ROLLBACK_INVALID');
  }
  return value as PublicBetaReleaseManifestV1['rollbackTarget'];
}

function parsePolicies(value: unknown): PublicBetaReleaseManifestV1['policyVersions'] {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS)) {
    fail('PUBLIC_BETA_RELEASE_POLICY_INVALID');
  }
  if (POLICY_KEYS.some((key) => !boundedString(value[key], 128))) {
    fail('PUBLIC_BETA_RELEASE_POLICY_INVALID');
  }
  try {
    canonicalPublicBetaJson(value);
  } catch {
    fail('PUBLIC_BETA_RELEASE_POLICY_INVALID');
  }
  return value as PublicBetaReleaseManifestV1['policyVersions'];
}

function parseRegionalEvidence(value: unknown): PublicBetaReleaseManifestV1['regionalEvidence'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    fail('PUBLIC_BETA_RELEASE_REGIONAL_EVIDENCE_INVALID');
  }
  const seen = new Set<string>();
  const records = value.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, REGIONAL_KEYS)) {
      fail('PUBLIC_BETA_RELEASE_REGIONAL_EVIDENCE_INVALID');
    }
    if (
      typeof item.id !== 'string' ||
      !IDENTIFIER.test(item.id) ||
      seen.has(item.id) ||
      (item.status !== 'satisfied' && item.status !== 'not_applicable') ||
      typeof item.artifactDigest !== 'string' ||
      !DIGEST.test(item.artifactDigest)
    ) {
      fail('PUBLIC_BETA_RELEASE_REGIONAL_EVIDENCE_INVALID');
    }
    seen.add(item.id);
    return item as PublicBetaReleaseManifestV1['regionalEvidence'][number];
  });
  return records;
}

function parseApproval(value: unknown): PublicBetaReleaseManifestV1['approval'] {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_KEYS)) {
    fail('PUBLIC_BETA_RELEASE_APPROVAL_INVALID');
  }
  if (
    value.environment !== 'production' ||
    typeof value.actor !== 'string' ||
    !IDENTIFIER.test(value.actor) ||
    !validTimestamp(value.approvedAt) ||
    typeof value.manifestDigest !== 'string' ||
    !DIGEST.test(value.manifestDigest)
  ) {
    fail('PUBLIC_BETA_RELEASE_APPROVAL_INVALID');
  }
  return value as PublicBetaReleaseManifestV1['approval'];
}

export function parsePublicBetaReleaseManifest(value: unknown): PublicBetaReleaseManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    fail('PUBLIC_BETA_RELEASE_MANIFEST_KEYS_INVALID');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.candidateId !== 'string' ||
    !IDENTIFIER.test(value.candidateId) ||
    typeof value.commit !== 'string' ||
    !COMMIT.test(value.commit) ||
    value.environment !== ENVIRONMENT ||
    !validRelativePath(value.artifactManifestPath, 1_024) ||
    typeof value.artifactManifestDigest !== 'string' ||
    !DIGEST.test(value.artifactManifestDigest) ||
    !validRelativePath(value.evidencePath, 1_024) ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    !Array.isArray(value.artifacts)
  ) {
    fail('PUBLIC_BETA_RELEASE_MANIFEST_INVALID');
  }

  if (value.artifacts.length !== PUBLIC_BETA_RELEASE_ARTIFACT_NAMES.length) {
    fail('PUBLIC_BETA_RELEASE_ARTIFACTS_INCOMPLETE');
  }

  const artifacts = value.artifacts.map(parseArtifact);
  const names = artifacts.map((item) => item.name);
  if (
    new Set(names).size !== names.length ||
    PUBLIC_BETA_RELEASE_ARTIFACT_NAMES.some((name) => !names.includes(name))
  ) {
    fail('PUBLIC_BETA_RELEASE_ARTIFACTS_INCOMPLETE');
  }

  const rollbackTarget = parseRollback(value.rollbackTarget);
  if (rollbackTarget.commit === value.commit) {
    fail('PUBLIC_BETA_RELEASE_ROLLBACK_INVALID');
  }
  const policyVersions = parsePolicies(value.policyVersions);
  const regionalEvidence = parseRegionalEvidence(value.regionalEvidence);
  const approval = parseApproval(value.approval);

  return structuredClone({
    schemaVersion: 1 as const,
    candidateId: value.candidateId,
    commit: value.commit,
    environment: ENVIRONMENT,
    artifacts,
    artifactManifestPath: value.artifactManifestPath,
    artifactManifestDigest: value.artifactManifestDigest,
    evidencePath: value.evidencePath,
    evidenceDigest: value.evidenceDigest,
    rollbackTarget,
    policyVersions,
    regionalEvidence,
    approval,
  }) as PublicBetaReleaseManifestV1;
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function cliArgument(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function validCliArguments(args: string[]): boolean {
  const allowed = new Set(['--manifest', '--evidence', '--now']);
  if (args.length !== 6) return false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.has(flag) || value === undefined) return false;
  }
  return new Set(args.filter((_, index) => index % 2 === 0)).size === allowed.size;
}

export function computePublicBetaEvidenceSchemaDigest(): `sha256:${string}` {
  return computePublicBetaSha256(readFileSync(EVIDENCE_SCHEMA_PATH));
}

function verifyArtifactAt(cwd: string, path: string, digest: string, sizeBytes: number): boolean {
  return verifyPublicBetaFile({
    root: cwd,
    path,
    digest: digest as `sha256:${string}`,
    sizeBytes,
    maxBytes: sizeBytes,
  });
}

function evidenceArtifactForDigest(
  ledger: Readonly<PublicBetaEvidenceLedgerV2>,
  digest: string,
  mediaType: string,
): PublicBetaEvidenceLedgerV2['records'][number]['artifacts'][number] | null {
  if (!isRecord(ledger) || !Array.isArray(ledger.records)) return null;
  const matches = ledger.records.flatMap((record) =>
    Array.isArray(record.artifacts)
      ? record.artifacts.filter(
          (artifact) => artifact.digest === digest && artifact.mediaType === mediaType,
        )
      : [],
  );
  const coordinates = new Map(
    matches.map((artifact) => [
      `${artifact.path}\0${artifact.digest}\0${artifact.sizeBytes}\0${artifact.mediaType}`,
      artifact,
    ]),
  );
  return coordinates.size === 1 ? (coordinates.values().next().value ?? null) : null;
}

function evidenceRecordArtifactForDigest(
  ledger: Readonly<PublicBetaEvidenceLedgerV2>,
  digest: string,
  mediaType: string,
): {
  record: PublicBetaEvidenceLedgerV2['records'][number];
  artifact: PublicBetaEvidenceLedgerV2['records'][number]['artifacts'][number];
} | null {
  if (!isRecord(ledger) || !Array.isArray(ledger.records)) return null;
  const matches = ledger.records.flatMap((record) => {
    if (!isRecord(record) || !Array.isArray(record.artifacts)) return [];
    return record.artifacts
      .filter(
        (artifact) =>
          isRecord(artifact) && artifact.digest === digest && artifact.mediaType === mediaType,
      )
      .map((artifact) => ({
        record: record as unknown as PublicBetaEvidenceLedgerV2['records'][number],
        artifact:
          artifact as unknown as PublicBetaEvidenceLedgerV2['records'][number]['artifacts'][number],
      }));
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function readEvidenceJsonAt(
  cwd: string,
  artifact: PublicBetaEvidenceLedgerV2['records'][number]['artifacts'][number],
  maxBytes: number,
): unknown | null {
  const result = readPublicBetaVerifiedJson({
    root: cwd,
    path: artifact.path,
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    maxBytes,
  });
  return result === false ? null : result.value;
}

export function verifyPublicBetaArtifactSbomFromLedger(
  cwd: string,
  ledger: Readonly<PublicBetaEvidenceLedgerV2>,
  artifact: Readonly<PublicBetaArtifactManifestEntryV1>,
): boolean {
  const evidenceArtifact = evidenceArtifactForDigest(
    ledger,
    artifact.sbomDigest,
    PUBLIC_BETA_CYCLONEDX_MEDIA_TYPE,
  );
  if (evidenceArtifact === null) return false;
  const value = readEvidenceJsonAt(cwd, evidenceArtifact, MAX_SBOM_BYTES);
  if (value === null) return false;
  try {
    parsePublicBetaCycloneDxSbom(value, {
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      commit: ledger.candidateCommit,
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyPublicBetaArtifactProvenanceFromLedger(
  cwd: string,
  ledger: Readonly<PublicBetaEvidenceLedgerV2>,
  artifact: Readonly<PublicBetaArtifactManifestEntryV1>,
  verifySignature?: (
    envelope: Readonly<PublicBetaDsseEnvelope>,
    preAuthEncoding: Uint8Array,
  ) => boolean,
): boolean {
  const match = evidenceRecordArtifactForDigest(
    ledger,
    artifact.provenanceDigest,
    PUBLIC_BETA_DSSE_MEDIA_TYPE,
  );
  if (match === null) return false;
  const { record, artifact: evidenceArtifact } = match;
  if (
    !isRecord(record.workflow) ||
    typeof record.workflow.repository !== 'string' ||
    typeof record.workflow.workflow !== 'string' ||
    typeof record.workflow.runId !== 'string' ||
    !Number.isSafeInteger(record.workflow.runAttempt) ||
    !Array.isArray(record.rawEvidencePaths) ||
    record.gate !== 'G3' ||
    record.outcome !== 'passed' ||
    record.commit !== ledger.candidateCommit ||
    record.environment !== ledger.environment ||
    record.workflow.workflow !== PUBLIC_BETA_PROVENANCE_WORKFLOW ||
    !record.rawEvidencePaths.includes(evidenceArtifact.path)
  ) {
    return false;
  }
  const value = readEvidenceJsonAt(cwd, evidenceArtifact, MAX_PROVENANCE_BYTES);
  if (value === null) return false;
  const repository = record.workflow.repository;
  const builderId =
    `https://github.com/${repository}/.github/workflows/${PUBLIC_BETA_PROVENANCE_WORKFLOW}@refs/heads/staging`;
  const invocationId =
    `https://github.com/${repository}/actions/runs/${record.workflow.runId}/attempts/${record.workflow.runAttempt}`;
  try {
    const statement = verifyPublicBetaDsseProvenance(value, {
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      sbomDigest: artifact.sbomDigest,
      commit: ledger.candidateCommit,
      repository,
      builderId,
      verifySignature,
    });
    if (!isRecord(statement.predicate) || !isRecord(statement.predicate.runDetails)) return false;
    const { runDetails } = statement.predicate;
    if (!isRecord(runDetails.metadata)) return false;
    return (
      runDetails.metadata.invocationId === invocationId &&
      runDetails.metadata.startedOn === record.startedAt &&
      runDetails.metadata.finishedOn === record.finishedAt
    );
  } catch {
    return false;
  }
}

function verifyReleaseArtifactAt(
  cwd: string,
  artifact: Readonly<PublicBetaReleaseManifestV1['artifacts'][number]>,
): boolean {
  if (!validArtifactReference(artifact.name, artifact.digest, artifact.imageOrPath)) return false;
  const remoteDigest = contentAddressedArtifactDigest(artifact.imageOrPath);
  if (remoteDigest !== null) return false;
  return verifyPublicBetaFile({
    root: cwd,
    path: artifact.imageOrPath,
    digest: artifact.digest,
    maxBytes: MAX_REMOTE_ARTIFACT_BYTES,
  });
}

function emitCliResult(io: PublicBetaReleaseManifestCliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

export async function runPublicBetaReleaseManifestCli(
  args: string[],
  io: PublicBetaReleaseManifestCliIo,
): Promise<number> {
  const emitInvalid = (error: string, exitCode = 65): number => {
    emitCliResult(io, { status: 'invalid', error });
    io.stderr(error);
    return exitCode;
  };

  if (!validCliArguments(args)) return emitInvalid('PUBLIC_BETA_RELEASE_USAGE_INVALID', 64);

  const manifestPath = cliArgument(args, '--manifest');
  const evidencePath = cliArgument(args, '--evidence');
  const nowValue = cliArgument(args, '--now');
  if (
    manifestPath === null ||
    evidencePath === null ||
    nowValue === null ||
    !validTimestamp(nowValue)
  ) {
    return emitInvalid('PUBLIC_BETA_RELEASE_USAGE_INVALID', 64);
  }

  try {
    const manifestFile = readPublicBetaBoundedJson({
      root: io.cwd,
      path: manifestPath,
      maxBytes: MAX_SBOM_BYTES,
    });
    if (manifestFile === false) return emitInvalid('PUBLIC_BETA_RELEASE_INPUT_INVALID');
    const manifestValue = manifestFile.value;
    const manifest = parsePublicBetaReleaseManifest(manifestValue);
    if (manifest.evidencePath !== evidencePath.replaceAll('\\', '/')) {
      return emitInvalid('PUBLIC_BETA_EVIDENCE_PATH_MISMATCH');
    }
    const artifactManifestFile = readPublicBetaBoundedJson({
      root: io.cwd,
      path: manifest.artifactManifestPath,
      maxBytes: MAX_SBOM_BYTES,
    });
    if (artifactManifestFile === false) {
      return emitInvalid('PUBLIC_BETA_ARTIFACT_MANIFEST_INPUT_INVALID');
    }
    const evidenceFile = readPublicBetaBoundedJson({
      root: io.cwd,
      path: evidencePath,
      maxBytes: MAX_SBOM_BYTES,
    });
    if (evidenceFile === false) return emitInvalid('PUBLIC_BETA_RELEASE_INPUT_INVALID');
    const artifactManifestBytes = artifactManifestFile.file.bytes;
    const artifactManifestValue = artifactManifestFile.value;
    const evidenceBytes = evidenceFile.file.bytes;
    const evidenceValue = evidenceFile.value;
    const remoteReleaseArtifacts = new Map<PublicBetaReleaseArtifactName, boolean>();
    for (const artifact of manifest.artifacts) {
      if (contentAddressedArtifactDigest(artifact.imageOrPath) !== null) {
        remoteReleaseArtifacts.set(
          artifact.name,
          await verifyRemotePublicBetaReleaseArtifact(artifact),
        );
      }
    }
    const result = evaluatePublicBetaReadiness(
      manifest,
      {
        ledger: evidenceValue as PublicBetaEvidenceLedgerV2,
        rawBytes: evidenceBytes,
        artifactManifest: artifactManifestValue,
        artifactManifestRawBytes: artifactManifestBytes,
        verifyArtifact: (path, digest, sizeBytes) =>
          verifyArtifactAt(io.cwd, path, digest, sizeBytes),
        verifyReleaseArtifact: (artifact) =>
          contentAddressedArtifactDigest(artifact.imageOrPath) === null
            ? verifyReleaseArtifactAt(io.cwd, artifact)
            : remoteReleaseArtifacts.get(artifact.name) === true,
        verifyArtifactSbom: (artifact) =>
          verifyPublicBetaArtifactSbomFromLedger(
            io.cwd,
            evidenceValue as PublicBetaEvidenceLedgerV2,
            artifact,
          ),
        verifyArtifactProvenance: (artifact) =>
          verifyPublicBetaArtifactProvenanceFromLedger(
            io.cwd,
            evidenceValue as PublicBetaEvidenceLedgerV2,
            artifact,
          ),
      },
      new Date(nowValue),
    );
    emitCliResult(io, result);
    if (result.status === 'not_ready') io.stderr(result.reasons.join('\n'));
    return result.status === 'ready' ? 0 : 2;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PUBLIC_BETA_RELEASE_INPUT_INVALID';
    return emitInvalid(code);
  }
}

export function evaluatePublicBetaReadiness(
  manifest: PublicBetaReleaseManifestV1,
  evidence: PublicBetaEvidenceInput,
  now: Date,
): PublicBetaReadinessResult {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    fail('PUBLIC_BETA_READINESS_NOW_INVALID');
  }

  const reasons: string[] = [];
  const evidenceInput = (isRecord(evidence) ? evidence : {}) as Partial<PublicBetaEvidenceInput>;
  const ledger = evidenceInput.ledger;
  const artifactManifest = evidenceInput.artifactManifest;
  const artifactManifestRawBytes =
    typeof evidenceInput.artifactManifestRawBytes === 'string' ||
    evidenceInput.artifactManifestRawBytes instanceof Uint8Array
      ? evidenceInput.artifactManifestRawBytes
      : null;
  const rawBytes =
    typeof evidenceInput.rawBytes === 'string' || evidenceInput.rawBytes instanceof Uint8Array
      ? evidenceInput.rawBytes
      : null;
  const verifyEvidenceArtifact =
    typeof evidenceInput.verifyArtifact === 'function' ? evidenceInput.verifyArtifact : null;
  const verifyReleaseArtifact =
    typeof evidenceInput.verifyReleaseArtifact === 'function'
      ? evidenceInput.verifyReleaseArtifact
      : null;
  const verifyArtifactSbom =
    typeof evidenceInput.verifyArtifactSbom === 'function' ? evidenceInput.verifyArtifactSbom : null;
  const verifyArtifactProvenance =
    typeof evidenceInput.verifyArtifactProvenance === 'function'
      ? evidenceInput.verifyArtifactProvenance
      : null;
  const verifyProvenance =
    typeof evidenceInput.verifyProvenance === 'function' ? evidenceInput.verifyProvenance : null;

  if (rawBytes === null) {
    addReason(reasons, 'PUBLIC_BETA_EVIDENCE_RAW_BYTES_REQUIRED');
  }
  if (artifactManifest === undefined) {
    addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_REQUIRED');
  }
  if (artifactManifestRawBytes === null) {
    addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_RAW_BYTES_REQUIRED');
  }
  if (verifyEvidenceArtifact === null) {
    addReason(reasons, 'PUBLIC_BETA_EVIDENCE_ARTIFACT_VERIFIER_REQUIRED');
  }
  if (verifyReleaseArtifact === null) {
    addReason(reasons, 'PUBLIC_BETA_RELEASE_ARTIFACT_VERIFIER_REQUIRED');
  }
  if (verifyArtifactSbom === null) {
    addReason(reasons, 'PUBLIC_BETA_SBOM_VERIFIER_REQUIRED');
  }
  if (verifyArtifactProvenance === null) {
    addReason(reasons, 'PUBLIC_BETA_PROVENANCE_VERIFIER_REQUIRED');
  }
  if (verifyProvenance === null) {
    addReason(reasons, 'PUBLIC_BETA_RELEASE_PROVENANCE_VERIFIER_REQUIRED');
  }

  const verifiedReleaseArtifacts = new Map<PublicBetaReleaseArtifactName, boolean>();
  let releaseArtifactsVerified = verifyReleaseArtifact !== null;
  if (verifyReleaseArtifact !== null) {
    for (const artifact of manifest.artifacts) {
      let verified = false;
      try {
        verified = verifyReleaseArtifact(artifact);
      } catch {
        verified = false;
      }
      verifiedReleaseArtifacts.set(artifact.name, verified);
      if (!verified) releaseArtifactsVerified = false;
    }
    if (!releaseArtifactsVerified) {
      addReason(reasons, 'PUBLIC_BETA_RELEASE_ARTIFACT_UNVERIFIED');
    }
  }

  if (rawBytes !== null && manifest.evidenceDigest !== computePublicBetaEvidenceDigest(rawBytes)) {
    addReason(reasons, 'PUBLIC_BETA_EVIDENCE_DIGEST_MISMATCH');
  }

  if (!isRecord(ledger) || ledger.candidateCommit !== manifest.commit) {
    addReason(reasons, 'PUBLIC_BETA_EVIDENCE_COMMIT_MISMATCH');
  }
  if (!isRecord(ledger) || ledger.environment !== ENVIRONMENT) {
    addReason(reasons, 'PUBLIC_BETA_EVIDENCE_ENVIRONMENT_INVALID');
  }
  if (
    isRecord(ledger) &&
    Array.isArray(ledger.records) &&
    ledger.records.some((record) => !isRecord(record) || record.commit !== manifest.commit)
  ) {
    addReason(reasons, 'PUBLIC_BETA_EVIDENCE_COMMIT_MISMATCH');
  }

  if (rawBytes !== null) {
    try {
      const rawText = typeof rawBytes === 'string' ? rawBytes : new TextDecoder().decode(rawBytes);
      const rawLedger = JSON.parse(rawText) as unknown;
      if (canonicalPublicBetaJson(rawLedger) !== canonicalPublicBetaJson(ledger)) {
        addReason(reasons, 'PUBLIC_BETA_EVIDENCE_BYTES_MISMATCH');
      }
    } catch {
      addReason(reasons, 'PUBLIC_BETA_EVIDENCE_BYTES_INVALID');
    }
  }

  let validatedLedger: PublicBetaEvidenceLedgerV2 | null = null;
  if (verifyEvidenceArtifact !== null) {
    try {
      validatedLedger = validatePublicBetaEvidenceLedgerV2(ledger, {
        now,
        expectedCommit: manifest.commit,
        profile: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
        lanes: OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
        expectedArtifactSetDigest: manifest.artifactManifestDigest,
        verifyArtifact: verifyEvidenceArtifact,
      });
    } catch (error) {
      addReason(reasons, error instanceof Error ? error.message : 'PUBLIC_BETA_EVIDENCE_INVALID');
    }
  }

  let validatedArtifactManifest: PublicBetaArtifactManifestV1 | null = null;
  if (artifactManifest !== undefined) {
    try {
      const parsedArtifactManifest = parsePublicBetaArtifactManifest(artifactManifest);
      if (parsedArtifactManifest.manifestDigest !== manifest.artifactManifestDigest) {
        addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_DIGEST_MISMATCH');
      } else if (parsedArtifactManifest.commit !== manifest.commit) {
        addReason(reasons, 'PUBLIC_BETA_ARTIFACT_COMMIT_MISMATCH');
      } else {
        validatedArtifactManifest = parsedArtifactManifest;
      }
    } catch (error) {
      addReason(
        reasons,
        error instanceof Error ? error.message : 'PUBLIC_BETA_ARTIFACT_MANIFEST_INVALID',
      );
    }
  }
  if (artifactManifestRawBytes === null) {
    validatedArtifactManifest = null;
  } else if (validatedArtifactManifest !== null) {
    try {
      const rawText =
        typeof artifactManifestRawBytes === 'string'
          ? artifactManifestRawBytes
          : new TextDecoder('utf-8', { fatal: true }).decode(artifactManifestRawBytes);
      const rawArtifactManifest = JSON.parse(rawText) as unknown;
      if (
        canonicalPublicBetaJson(rawArtifactManifest) !== canonicalPublicBetaJson(artifactManifest)
      ) {
        addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_BYTES_MISMATCH');
        validatedArtifactManifest = null;
      }
    } catch {
      addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_BYTES_INVALID');
      validatedArtifactManifest = null;
    }
  }

  if (validatedLedger !== null) {
    try {
      if (validatedLedger.schemaDigest !== computePublicBetaEvidenceSchemaDigest()) {
        addReason(reasons, 'PUBLIC_BETA_EVIDENCE_SCHEMA_DIGEST_MISMATCH');
        validatedLedger = null;
      }
    } catch {
      addReason(reasons, 'PUBLIC_BETA_EVIDENCE_SCHEMA_UNVERIFIED');
      validatedLedger = null;
    }
  }

  if (
    validatedLedger !== null &&
    validatedArtifactManifest !== null &&
    validatedLedger.artifactSetDigest !== validatedArtifactManifest.manifestDigest
  ) {
    addReason(reasons, 'PUBLIC_BETA_ARTIFACT_SET_DIGEST_MISMATCH');
    validatedArtifactManifest = null;
  }

  if (validatedArtifactManifest !== null) {
    const releaseArtifacts = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact]));
    if (
      validatedArtifactManifest.artifacts.some(
        (artifact) => releaseArtifacts.get(artifact.name)?.digest !== artifact.digest,
      )
    ) {
      addReason(reasons, 'PUBLIC_BETA_RELEASE_ARTIFACT_SET_MISMATCH');
      validatedArtifactManifest = null;
    }
  }

  if (
    validatedLedger !== null &&
    validatedArtifactManifest !== null &&
    artifactManifestRawBytes !== null
  ) {
    const evidenceEntries = validatedLedger.records.flatMap((record) =>
      record.artifacts.filter(
        (artifact) =>
          artifact.path === manifest.artifactManifestPath &&
          artifact.mediaType === PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE,
      ),
    );
    if (evidenceEntries.length === 0) {
      addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_EVIDENCE_MISSING');
      validatedArtifactManifest = null;
    } else {
      const expectedDigest = computePublicBetaEvidenceDigest(artifactManifestRawBytes);
      const expectedSize = bytes(artifactManifestRawBytes).byteLength;
      if (
        evidenceEntries.length !== 1 ||
        evidenceEntries[0]?.digest !== expectedDigest ||
        evidenceEntries[0]?.sizeBytes !== expectedSize
      ) {
        addReason(reasons, 'PUBLIC_BETA_ARTIFACT_MANIFEST_EVIDENCE_INVALID');
        validatedArtifactManifest = null;
      }
    }
  }

  if (
    validatedArtifactManifest !== null &&
    releaseArtifactsVerified &&
    verifyArtifactSbom !== null &&
    verifyArtifactProvenance !== null
  ) {
    try {
      validatedArtifactManifest = verifyPublicBetaArtifactManifest(validatedArtifactManifest, {
        expectedCommit: manifest.commit,
        verifyArtifact: (artifact) => verifiedReleaseArtifacts.get(artifact.name) === true,
        verifySbom: verifyArtifactSbom,
        verifyProvenance: verifyArtifactProvenance,
      });
    } catch (error) {
      addReason(
        reasons,
        error instanceof Error ? error.message : 'PUBLIC_BETA_ARTIFACT_MANIFEST_UNVERIFIED',
      );
      validatedArtifactManifest = null;
    }
  } else if (validatedArtifactManifest !== null) {
    validatedArtifactManifest = null;
  }

  if (verifyProvenance !== null) {
    try {
      if (
        validatedLedger === null ||
        validatedArtifactManifest === null ||
        !verifyProvenance(manifest, validatedLedger, validatedArtifactManifest)
      ) {
        addReason(reasons, 'PUBLIC_BETA_RELEASE_PROVENANCE_UNVERIFIED');
      }
    } catch {
      addReason(reasons, 'PUBLIC_BETA_RELEASE_PROVENANCE_UNVERIFIED');
    }
  }

  if (manifest.approval === null) {
    addReason(reasons, 'PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED');
  } else {
    try {
      if (manifest.approval.manifestDigest !== computePublicBetaManifestDigest(manifest)) {
        addReason(reasons, 'PUBLIC_BETA_APPROVAL_BINDING_INVALID');
      }
    } catch {
      addReason(reasons, 'PUBLIC_BETA_APPROVAL_BINDING_INVALID');
    }
    if (Date.parse(manifest.approval.approvedAt) > now.valueOf()) {
      addReason(reasons, 'PUBLIC_BETA_APPROVAL_TIME_INVALID');
    }
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'not_ready',
    reasons,
  };
}

if (import.meta.main) {
  const configuredBundleRoot = process.env.OPENOPC_PUBLIC_BETA_BUNDLE_ROOT;
  runPublicBetaReleaseManifestCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(`${value}\n`),
    cwd:
      configuredBundleRoot === undefined
        ? process.cwd()
        : resolve(process.cwd(), configuredBundleRoot),
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
