#!/usr/bin/env bun

import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomUUID,
} from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  type ModuleBetaArtifactRegistrationRequestV1,
  type ModuleBetaInspectorEvidenceV1,
  parseModuleBetaArtifactRegistrationRequest,
  parseModuleBetaArtifactRegistrationResponse,
  parseModuleBetaCleanupRequest,
  parseModuleBetaCleanupResponse,
  parseModuleBetaInspectorEvidence,
} from '../../../packages/module-runtime-contracts/src/module-beta-acceptance';
import {
  type BetaTargets,
  type ModuleBetaEvidenceLane,
  assertNonProductionBetaTargets,
  validateEvidenceLedger,
} from '../../../scripts/release/module-beta-targets';
import {
  type GeneratedTrustFixture,
  type TrustFixtureScenario,
  generateTrustFixtures,
} from './fixtures';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const mockedTargetPattern = /(?:^|[.\/_-])(?:mock|mocked|fake|stub)(?:[.\/_-]|$)/i;
const moduleBetaPayloadType = 'application/vnd.openopc.module-beta-evidence.v1+json' as const;

export interface TrustEvidenceInput {
  gate: string;
  lane: ModuleBetaEvidenceLane;
  outcome: 'not-run' | 'passed' | 'failed';
  dependencyIdentities: readonly string[];
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface SignedEvidenceDocument extends DsseEnvelope {
  payloadType: typeof moduleBetaPayloadType;
}

export interface SafeTrustFinding {
  scanner: string;
  rule_id: string;
  severity: string;
  disposition: string;
}

export interface SafeTrustAttestation {
  attestation_digest: string;
  subject_artifact_digest: string;
  predicate_type: string;
  policy_digest: string;
  result: string;
  sbom_digest: string;
  issuer: string;
  created_at: string;
}

export interface SafeTrustAttempt {
  run_id: string;
  attempt: number;
  state: string;
  terminal_reason: string | null;
  policy_digest: string;
  scanner_set_digest: string;
  sandbox_profile_digest: string;
  sbom_digest: string | null;
  attestation_digest: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  findings: readonly SafeTrustFinding[];
  attestation: SafeTrustAttestation | null;
}

export interface TrustAttemptExpectation {
  state: 'passed' | 'failed' | 'inconclusive' | 'cancelled';
  terminalReason: string;
  findingCodes: readonly string[];
  artifactDigest: `sha256:${string}`;
}

export interface TrustStagingConfig {
  targets: ReturnType<typeof assertTrustStagingTargets>;
  acceptanceUrl: string;
  trustWorkerUrl: string;
  primary: { token: string; accountId: string };
  secondary: { token: string; accountId: string };
  publisherId: string;
  controlToken: string;
  controlIdentity: string;
  dependencyIdentities: readonly string[];
  attestationKeyring: Readonly<Record<string, Uint8Array>>;
  expectedFindings: Readonly<{
    'secret-leak': readonly string[];
    'vulnerable-lockfile': readonly string[];
  }>;
  minioHosts: readonly string[];
  evidenceSigning: {
    keyId: string;
    privateKey: KeyObject;
    publicKeyDer: Uint8Array;
  };
  commit: string;
  runId: string;
  timeoutMs: number;
  pollMs: number;
}

export interface StoredEvidenceReference {
  storage: 'minio';
  url: string;
  contentDigest: `sha256:${string}`;
  sizeBytes: number;
}

export interface InspectorAttestation {
  digest: `sha256:${string}`;
  keyId: string;
  envelope: DsseEnvelope;
}

interface DeveloperArtifactUploadTicket {
  upload_id: string;
  expected_digest: `sha256:${string}`;
  expected_size: number;
  upload_url: string;
  headers: Record<string, string>;
}

interface DeveloperArtifact {
  artifact_id: string;
  account_id: string;
  artifact_digest: `sha256:${string}`;
  size_bytes: number;
}

interface DeveloperRelease {
  release_id: string;
  account_id: string;
  artifact_id: string;
  artifact_digest: `sha256:${string}`;
  runtime_kind: 'wasi-component' | 'oci-image' | null;
  runtime_descriptor_digest: `sha256:${string}` | null;
  status: string;
}

interface DeveloperTrustView {
  release_id: string;
  account_id: string;
  artifact: {
    artifact_id: string;
    artifact_digest: `sha256:${string}`;
    size_bytes: number;
  };
  attempts: SafeTrustAttempt[];
}

type TrustInspectorEvidence = ModuleBetaInspectorEvidenceV1;

interface TrustFixtureResult {
  scenario: TrustFixtureScenario;
  checkpoint: GeneratedTrustFixture['checkpoint'];
  archiveDigest: `sha256:${string}`;
  archiveSizeBytes: number;
  artifactId: string | null;
  artifactDigest: `sha256:${string}` | null;
  releaseId: string | null;
  runId: string | null;
  state: string;
  terminalReason: string;
  findingCodes: string[];
  crossAccountDenied: boolean;
  storageVerified: boolean;
  sbomVerified: boolean;
  attestationKeyId: string | null;
  scannerIdentities: string[];
  controlIdentity: string | null;
}

interface JsonResponse {
  response: Response;
  value: unknown;
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, '..', '..', '..');
const evidenceLedgerPath = resolve(currentDirectory, '..', 'evidence.json');
const evidenceOutputDirectory = resolve(currentDirectory, '..', 'out');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('DSSE_BASE64_INVALID');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('DSSE_BASE64_INVALID');
  return bytes;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value)
  );
}

export function assertPinnedControlIdentity(actual: string, pinned: string): string {
  if (!validIdentifier(actual) || actual !== pinned) {
    throw new Error('TRUST_CONTROL_IDENTITY_MISMATCH');
  }
  return pinned;
}

function assertEd25519PublicKey(publicKeyDer: Uint8Array): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyDer), format: 'der', type: 'spki' });
  } catch {
    throw new Error('DSSE_PUBLIC_KEY_INVALID');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('DSSE_PUBLIC_KEY_INVALID');
  }
  return key;
}

function assertEvidenceKeyId(keyId: string): void {
  if (!/^openopc-module-beta-staging-[A-Za-z0-9._:-]{1,128}$/.test(keyId)) {
    throw new Error('EVIDENCE_SIGNING_KEY_ID_INVALID');
  }
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`MODULE_BETA_ENV_REQUIRED:${name}`);
  return value;
}

function parseJsonEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): unknown {
  try {
    return JSON.parse(requiredEnvironment(environment, name)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MODULE_BETA_ENV_REQUIRED:')) {
      throw error;
    }
    throw new Error(`MODULE_BETA_ENV_INVALID:${name}`);
  }
}

function parseIntegerEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`MODULE_BETA_ENV_INVALID:${name}`);
  }
  return value;
}

function stringArray(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => !validIdentifier(entry))
  ) {
    throw new Error(code);
  }
  const result = [...new Set(value as string[])].sort();
  if (result.length !== value.length) throw new Error(code);
  return result;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_JSON_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new Error('NON_JSON_VALUE');
}

export function dssePreAuthEncoding(payloadType: string, payload: Uint8Array): Buffer {
  if (!validIdentifier(payloadType)) throw new Error('DSSE_PAYLOAD_TYPE_INVALID');
  const type = Buffer.from(payloadType, 'utf8');
  const body = Buffer.from(payload);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.byteLength} `, 'utf8'),
    type,
    Buffer.from(` ${body.byteLength} `, 'utf8'),
    body,
  ]);
}

export function validateEvidence(input: TrustEvidenceInput): TrustEvidenceInput {
  if (!/^G(?:[1-9]|1[0-2])$/.test(input.gate) || input.lane !== 'integration') {
    throw new Error('TRUST_EVIDENCE_RECORD_INVALID');
  }
  if (input.outcome === 'passed' && input.dependencyIdentities.length === 0) {
    throw new Error('EVIDENCE_DEPENDENCY_IDENTITY_REQUIRED');
  }
  if (
    input.dependencyIdentities.some(
      (identity) => !validIdentifier(identity) || mockedTargetPattern.test(identity),
    )
  ) {
    throw new Error('EVIDENCE_DEPENDENCY_IDENTITY_INVALID');
  }
  return input;
}

export function assertTrustStagingTargets(input: BetaTargets) {
  const targets = assertNonProductionBetaTargets(input);
  for (const value of Object.values(targets)) {
    const parsed = new URL(value);
    if (mockedTargetPattern.test(`${parsed.hostname}${parsed.pathname}`)) {
      throw new Error('MODULE_BETA_MOCK_TARGET_FORBIDDEN');
    }
  }
  return targets;
}

export function loadTrustStagingConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TrustStagingConfig {
  const targets = assertTrustStagingTargets({
    api: requiredEnvironment(environment, 'MODULE_BETA_API_URL'),
    web: requiredEnvironment(environment, 'MODULE_BETA_WEB_URL'),
    runner: requiredEnvironment(environment, 'MODULE_BETA_RUNNER_URL'),
  });
  const trustServices = assertTrustStagingTargets({
    api: requiredEnvironment(environment, 'MODULE_BETA_TRUST_ACCEPTANCE_URL'),
    web: requiredEnvironment(environment, 'MODULE_BETA_TRUST_WORKER_URL'),
    runner: requiredEnvironment(environment, 'MODULE_BETA_TRUST_WORKER_URL'),
  });
  if (trustServices.api === targets.runner || trustServices.api === trustServices.web) {
    throw new Error('MODULE_BETA_TRUST_ACCEPTANCE_URL_NOT_INDEPENDENT');
  }
  const primary = {
    token: requiredEnvironment(environment, 'MODULE_BETA_PRIMARY_TOKEN'),
    accountId: requiredEnvironment(environment, 'MODULE_BETA_PRIMARY_ACCOUNT_ID'),
  };
  const secondary = {
    token: requiredEnvironment(environment, 'MODULE_BETA_SECONDARY_TOKEN'),
    accountId: requiredEnvironment(environment, 'MODULE_BETA_SECONDARY_ACCOUNT_ID'),
  };
  const publisherId = requiredEnvironment(environment, 'MODULE_BETA_PUBLISHER_ID');
  const controlToken = requiredEnvironment(environment, 'MODULE_BETA_TRUST_CONTROL_TOKEN');
  const controlIdentity = requiredEnvironment(environment, 'MODULE_BETA_TRUST_CONTROL_IDENTITY');
  if (
    primary.token.length < 16 ||
    secondary.token.length < 16 ||
    controlToken.length < 16 ||
    primary.token === secondary.token ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      primary.accountId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      secondary.accountId,
    ) ||
    primary.accountId === secondary.accountId ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(publisherId)
  ) {
    throw new Error('MODULE_BETA_PRINCIPAL_CONFIG_INVALID');
  }
  if (
    !/^[A-Za-z0-9._-]+@[A-Za-z0-9._+-]+#sha256:[0-9a-f]{64}$/.test(controlIdentity) ||
    mockedTargetPattern.test(controlIdentity)
  ) {
    throw new Error('MODULE_BETA_TRUST_CONTROL_IDENTITY_INVALID');
  }
  const dependencyIdentities = stringArray(
    parseJsonEnvironment(environment, 'MODULE_BETA_DEPENDENCY_IDENTITIES_JSON'),
    'MODULE_BETA_DEPENDENCY_IDENTITIES_INVALID',
  );
  validateEvidence({
    gate: 'G3',
    lane: 'integration',
    outcome: 'passed',
    dependencyIdentities,
  });
  if (!dependencyIdentities.includes(controlIdentity)) {
    throw new Error('MODULE_BETA_TRUST_CONTROL_IDENTITY_UNRECORDED');
  }
  if (
    !dependencyIdentities.some((identity) =>
      identity.startsWith('key:openopc-attestation-staging-'),
    ) ||
    !dependencyIdentities.some((identity) => /#sha256:[0-9a-f]{64}$/.test(identity))
  ) {
    throw new Error('MODULE_BETA_DEPENDENCY_IDENTITIES_INVALID');
  }
  const keyringValue = parseJsonEnvironment(environment, 'MODULE_BETA_ATTESTATION_KEYRING_JSON');
  if (!isRecord(keyringValue) || Object.keys(keyringValue).length === 0) {
    throw new Error('MODULE_BETA_ATTESTATION_KEYRING_INVALID');
  }
  const attestationKeyring: Record<string, Uint8Array> = {};
  for (const [keyId, encodedKey] of Object.entries(keyringValue)) {
    if (
      !/^openopc-attestation-staging-[A-Za-z0-9._:-]{1,128}$/.test(keyId) ||
      typeof encodedKey !== 'string' ||
      !dependencyIdentities.includes(`key:${keyId}`)
    ) {
      throw new Error('MODULE_BETA_ATTESTATION_KEYRING_INVALID');
    }
    try {
      const publicKeyDer = exactBase64(encodedKey);
      assertEd25519PublicKey(publicKeyDer);
      attestationKeyring[keyId] = new Uint8Array(publicKeyDer);
    } catch {
      throw new Error('MODULE_BETA_ATTESTATION_KEYRING_INVALID');
    }
  }
  const expectedFindingsValue = parseJsonEnvironment(
    environment,
    'MODULE_BETA_EXPECTED_FINDINGS_JSON',
  );
  if (!isRecord(expectedFindingsValue)) {
    throw new Error('MODULE_BETA_EXPECTED_FINDINGS_INVALID');
  }
  const expectedFindings = {
    'secret-leak': stringArray(
      expectedFindingsValue['secret-leak'],
      'MODULE_BETA_EXPECTED_FINDINGS_INVALID',
    ),
    'vulnerable-lockfile': stringArray(
      expectedFindingsValue['vulnerable-lockfile'],
      'MODULE_BETA_EXPECTED_FINDINGS_INVALID',
    ),
  };
  for (const codes of Object.values(expectedFindings)) {
    if (codes.some((code) => !/^[A-Za-z0-9._-]+:[A-Za-z0-9._:@/+\-]+$/.test(code))) {
      throw new Error('MODULE_BETA_EXPECTED_FINDINGS_INVALID');
    }
  }
  const minioHosts = stringArray(
    parseJsonEnvironment(environment, 'MODULE_BETA_MINIO_HOSTS_JSON'),
    'MODULE_BETA_MINIO_HOSTS_INVALID',
  ).map((host) => host.toLowerCase());
  for (const host of minioHosts) {
    let parsed: URL;
    try {
      parsed = new URL(`https://${host}`);
    } catch {
      throw new Error('MODULE_BETA_MINIO_HOSTS_INVALID');
    }
    if (
      parsed.host !== host ||
      parsed.pathname !== '/' ||
      mockedTargetPattern.test(host) ||
      host.includes('@')
    ) {
      throw new Error('MODULE_BETA_MINIO_HOSTS_INVALID');
    }
    try {
      assertNonProductionBetaTargets({
        api: `https://${host}`,
        web: `https://${host}`,
        runner: `https://${host}`,
      });
    } catch {
      throw new Error('MODULE_BETA_MINIO_HOSTS_INVALID');
    }
  }
  const privateKey = loadEvidencePrivateKey(
    requiredEnvironment(environment, 'MODULE_BETA_EVIDENCE_PRIVATE_KEY_DER_B64'),
  );
  const publicKeyDer = exactBase64(
    requiredEnvironment(environment, 'MODULE_BETA_EVIDENCE_PUBLIC_KEY_DER_B64'),
  );
  const publicKey = assertEd25519PublicKey(publicKeyDer);
  const keyId = requiredEnvironment(environment, 'MODULE_BETA_EVIDENCE_KEY_ID');
  assertEvidenceKeyId(keyId);
  const probe = Buffer.from('openopc-module-beta-staging-key-match-v1');
  if (!cryptoVerify(null, probe, publicKey, cryptoSign(null, probe, privateKey))) {
    throw new Error('EVIDENCE_SIGNING_KEY_PAIR_MISMATCH');
  }
  const commit = requiredEnvironment(environment, 'MODULE_BETA_COMMIT');
  const runId = requiredEnvironment(environment, 'MODULE_BETA_RUN_ID');
  if (!/^[0-9a-f]{7,40}$/.test(commit) || !/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) {
    throw new Error('MODULE_BETA_RUN_IDENTITY_INVALID');
  }
  return Object.freeze({
    targets,
    acceptanceUrl: trustServices.api,
    trustWorkerUrl: trustServices.web,
    primary: Object.freeze(primary),
    secondary: Object.freeze(secondary),
    publisherId,
    controlToken,
    controlIdentity,
    dependencyIdentities: Object.freeze(dependencyIdentities),
    attestationKeyring: Object.freeze(attestationKeyring),
    expectedFindings: Object.freeze({
      'secret-leak': Object.freeze(expectedFindings['secret-leak']),
      'vulnerable-lockfile': Object.freeze(expectedFindings['vulnerable-lockfile']),
    }),
    minioHosts: Object.freeze(minioHosts),
    evidenceSigning: Object.freeze({ keyId, privateKey, publicKeyDer }),
    commit,
    runId,
    timeoutMs: parseIntegerEnvironment(
      environment,
      'MODULE_BETA_TRUST_TIMEOUT_MS',
      10 * 60_000,
      60_000,
      30 * 60_000,
    ),
    pollMs: parseIntegerEnvironment(environment, 'MODULE_BETA_TRUST_POLL_MS', 2_000, 250, 30_000),
  });
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function buildTrustServiceUrl(
  config: Pick<TrustStagingConfig, 'acceptanceUrl' | 'trustWorkerUrl'>,
  service: 'acceptance' | 'worker',
  path: string,
): string {
  return endpoint(service === 'acceptance' ? config.acceptanceUrl : config.trustWorkerUrl, path);
}

function responseIsMocked(response: Response): boolean {
  return (
    response.headers.has('x-openopc-mock') ||
    response.headers.has('x-mock-response') ||
    response.headers.get('x-powered-by')?.toLowerCase().includes('mock') === true
  );
}

export async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const maximumBytes = 2 * 1024 * 1024;
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new Error('MODULE_BETA_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('MODULE_BETA_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new Error('MODULE_BETA_RESPONSE_INVALID_JSON');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('MODULE_BETA_RESPONSE_INVALID_JSON');
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<JsonResponse> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.redirected || responseIsMocked(response)) {
    throw new Error('MODULE_BETA_MOCK_RESPONSE_FORBIDDEN');
  }
  return { response, value: await readBoundedJsonResponse(response) };
}

function bearerHeaders(token: string, includeJson = true): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(includeJson ? { 'content-type': 'application/json' } : {}),
    'x-openopc-module-beta': 'trust-staging-v1',
  };
}

export function acceptanceRequestHeaders(
  config: Pick<TrustStagingConfig, 'controlToken' | 'runId'>,
  authenticate = true,
): Record<string, string> {
  return {
    ...(authenticate
      ? bearerHeaders(config.controlToken)
      : { 'x-openopc-module-beta': 'trust-staging-v1' }),
    'x-openopc-module-beta-run-id': config.runId,
  };
}

async function apiJson(
  config: TrustStagingConfig,
  input: {
    path: string;
    token: string;
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
  },
): Promise<JsonResponse> {
  return fetchJson(
    endpoint(config.targets.api, input.path),
    {
      method: input.method ?? 'GET',
      headers: bearerHeaders(input.token),
      ...(input.body === undefined ? {} : { body: canonicalJson(input.body) }),
    },
    config.timeoutMs,
  );
}

async function acceptanceJson(
  config: TrustStagingConfig,
  input: {
    path: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    authenticate?: boolean;
  },
): Promise<JsonResponse> {
  return fetchJson(
    buildTrustServiceUrl(config, 'acceptance', input.path),
    {
      method: input.method ?? 'GET',
      headers: acceptanceRequestHeaders(config, input.authenticate !== false),
      ...(input.body === undefined ? {} : { body: canonicalJson(input.body) }),
    },
    config.timeoutMs,
  );
}

function recordValue(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return value as number;
}

function digestValue(value: unknown, code: string): `sha256:${string}` {
  const digest = stringValue(value, code);
  if (!digestPattern.test(digest)) throw new Error(code);
  return digest as `sha256:${string}`;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return stringValue(value, code);
}

function parseUploadTicket(value: unknown): DeveloperArtifactUploadTicket {
  const ticket = recordValue(value, 'TRUST_UPLOAD_TICKET_INVALID');
  const headers = recordValue(ticket.headers, 'TRUST_UPLOAD_TICKET_INVALID');
  if (
    !uuidPattern.test(stringValue(ticket.upload_id, 'TRUST_UPLOAD_TICKET_INVALID')) ||
    !Object.values(headers).every((header) => typeof header === 'string')
  ) {
    throw new Error('TRUST_UPLOAD_TICKET_INVALID');
  }
  return {
    upload_id: ticket.upload_id as string,
    expected_digest: digestValue(ticket.expected_digest, 'TRUST_UPLOAD_TICKET_INVALID'),
    expected_size: integerValue(ticket.expected_size, 'TRUST_UPLOAD_TICKET_INVALID'),
    upload_url: stringValue(ticket.upload_url, 'TRUST_UPLOAD_TICKET_INVALID'),
    headers: headers as Record<string, string>,
  };
}

function parseArtifact(value: unknown): DeveloperArtifact {
  const artifact = recordValue(value, 'TRUST_ARTIFACT_RESPONSE_INVALID');
  const parsed = {
    artifact_id: stringValue(artifact.artifact_id, 'TRUST_ARTIFACT_RESPONSE_INVALID'),
    account_id: stringValue(artifact.account_id, 'TRUST_ARTIFACT_RESPONSE_INVALID'),
    artifact_digest: digestValue(artifact.artifact_digest, 'TRUST_ARTIFACT_RESPONSE_INVALID'),
    size_bytes: integerValue(artifact.size_bytes, 'TRUST_ARTIFACT_RESPONSE_INVALID'),
  };
  if (!uuidPattern.test(parsed.artifact_id) || !uuidPattern.test(parsed.account_id)) {
    throw new Error('TRUST_ARTIFACT_RESPONSE_INVALID');
  }
  return parsed;
}

function parseRelease(value: unknown): DeveloperRelease {
  const root = recordValue(value, 'TRUST_RELEASE_RESPONSE_INVALID');
  const release = recordValue(root.release, 'TRUST_RELEASE_RESPONSE_INVALID');
  const runtimeKind = release.runtime_kind;
  let parsedRuntimeKind: DeveloperRelease['runtime_kind'];
  if (runtimeKind === null) {
    parsedRuntimeKind = null;
  } else if (runtimeKind === 'wasi-component' || runtimeKind === 'oci-image') {
    parsedRuntimeKind = runtimeKind;
  } else {
    throw new Error('TRUST_RELEASE_RESPONSE_INVALID');
  }
  const parsed: DeveloperRelease = {
    release_id: stringValue(release.release_id, 'TRUST_RELEASE_RESPONSE_INVALID'),
    account_id: stringValue(release.account_id, 'TRUST_RELEASE_RESPONSE_INVALID'),
    artifact_id: stringValue(release.artifact_id, 'TRUST_RELEASE_RESPONSE_INVALID'),
    artifact_digest: digestValue(release.artifact_digest, 'TRUST_RELEASE_RESPONSE_INVALID'),
    runtime_kind: parsedRuntimeKind,
    runtime_descriptor_digest:
      release.runtime_descriptor_digest === null
        ? null
        : digestValue(release.runtime_descriptor_digest, 'TRUST_RELEASE_RESPONSE_INVALID'),
    status: stringValue(release.status, 'TRUST_RELEASE_RESPONSE_INVALID'),
  };
  if (
    !uuidPattern.test(parsed.release_id) ||
    !uuidPattern.test(parsed.account_id) ||
    !uuidPattern.test(parsed.artifact_id) ||
    (runtimeKind !== null && parsed.runtime_kind === null)
  ) {
    throw new Error('TRUST_RELEASE_RESPONSE_INVALID');
  }
  return parsed;
}

function parseFinding(value: unknown): SafeTrustFinding {
  const finding = recordValue(value, 'TRUST_VIEW_INVALID');
  return {
    scanner: stringValue(finding.scanner, 'TRUST_VIEW_INVALID'),
    rule_id: stringValue(finding.rule_id, 'TRUST_VIEW_INVALID'),
    severity: stringValue(finding.severity, 'TRUST_VIEW_INVALID'),
    disposition: stringValue(finding.disposition, 'TRUST_VIEW_INVALID'),
  };
}

function parseSafeAttestation(value: unknown): SafeTrustAttestation | null {
  if (value === null) return null;
  const attestation = recordValue(value, 'TRUST_VIEW_INVALID');
  return {
    attestation_digest: digestValue(attestation.attestation_digest, 'TRUST_VIEW_INVALID'),
    subject_artifact_digest: digestValue(attestation.subject_artifact_digest, 'TRUST_VIEW_INVALID'),
    predicate_type: stringValue(attestation.predicate_type, 'TRUST_VIEW_INVALID'),
    policy_digest: digestValue(attestation.policy_digest, 'TRUST_VIEW_INVALID'),
    result: stringValue(attestation.result, 'TRUST_VIEW_INVALID'),
    sbom_digest: digestValue(attestation.sbom_digest, 'TRUST_VIEW_INVALID'),
    issuer: stringValue(attestation.issuer, 'TRUST_VIEW_INVALID'),
    created_at: stringValue(attestation.created_at, 'TRUST_VIEW_INVALID'),
  };
}

function parseAttempt(value: unknown): SafeTrustAttempt {
  const attempt = recordValue(value, 'TRUST_VIEW_INVALID');
  const findings = Array.isArray(attempt.findings)
    ? attempt.findings.map(parseFinding)
    : (() => {
        throw new Error('TRUST_VIEW_INVALID');
      })();
  const parsed: SafeTrustAttempt = {
    run_id: stringValue(attempt.run_id, 'TRUST_VIEW_INVALID'),
    attempt: integerValue(attempt.attempt, 'TRUST_VIEW_INVALID'),
    state: stringValue(attempt.state, 'TRUST_VIEW_INVALID'),
    terminal_reason: nullableString(attempt.terminal_reason, 'TRUST_VIEW_INVALID'),
    policy_digest: digestValue(attempt.policy_digest, 'TRUST_VIEW_INVALID'),
    scanner_set_digest: digestValue(attempt.scanner_set_digest, 'TRUST_VIEW_INVALID'),
    sandbox_profile_digest: digestValue(attempt.sandbox_profile_digest, 'TRUST_VIEW_INVALID'),
    sbom_digest:
      attempt.sbom_digest === null ? null : digestValue(attempt.sbom_digest, 'TRUST_VIEW_INVALID'),
    attestation_digest:
      attempt.attestation_digest === null
        ? null
        : digestValue(attempt.attestation_digest, 'TRUST_VIEW_INVALID'),
    started_at: nullableString(attempt.started_at, 'TRUST_VIEW_INVALID'),
    finished_at: nullableString(attempt.finished_at, 'TRUST_VIEW_INVALID'),
    created_at: stringValue(attempt.created_at, 'TRUST_VIEW_INVALID'),
    findings,
    attestation: parseSafeAttestation(attempt.attestation),
  };
  if (!uuidPattern.test(parsed.run_id) || parsed.attempt < 1) {
    throw new Error('TRUST_VIEW_INVALID');
  }
  return parsed;
}

function parseTrustView(value: unknown): DeveloperTrustView {
  const view = recordValue(value, 'TRUST_VIEW_INVALID');
  const artifact = recordValue(view.artifact, 'TRUST_VIEW_INVALID');
  if (!Array.isArray(view.attempts)) throw new Error('TRUST_VIEW_INVALID');
  const parsed: DeveloperTrustView = {
    release_id: stringValue(view.release_id, 'TRUST_VIEW_INVALID'),
    account_id: stringValue(view.account_id, 'TRUST_VIEW_INVALID'),
    artifact: {
      artifact_id: stringValue(artifact.artifact_id, 'TRUST_VIEW_INVALID'),
      artifact_digest: digestValue(artifact.artifact_digest, 'TRUST_VIEW_INVALID'),
      size_bytes: integerValue(artifact.size_bytes, 'TRUST_VIEW_INVALID'),
    },
    attempts: view.attempts.map(parseAttempt),
  };
  if (
    !uuidPattern.test(parsed.release_id) ||
    !uuidPattern.test(parsed.account_id) ||
    !uuidPattern.test(parsed.artifact.artifact_id)
  ) {
    throw new Error('TRUST_VIEW_INVALID');
  }
  return parsed;
}

export function validateTerminalAttempt(
  attempt: SafeTrustAttempt,
  expected: TrustAttemptExpectation,
): SafeTrustAttempt {
  if (attempt.state !== expected.state) throw new Error('TRUST_TERMINAL_STATE_MISMATCH');
  if (attempt.terminal_reason !== expected.terminalReason) {
    throw new Error('TRUST_TERMINAL_REASON_MISMATCH');
  }
  const actualCodes = attempt.findings
    .map((finding) => `${finding.scanner}:${finding.rule_id}`)
    .sort();
  const expectedCodes = [...expected.findingCodes].sort();
  if (
    actualCodes.length !== expectedCodes.length ||
    actualCodes.some((code, index) => code !== expectedCodes[index])
  ) {
    throw new Error('TRUST_FINDING_CODE_MISMATCH');
  }
  if (
    !digestPattern.test(attempt.policy_digest) ||
    !digestPattern.test(attempt.scanner_set_digest) ||
    !digestPattern.test(attempt.sandbox_profile_digest) ||
    !attempt.sbom_digest ||
    !digestPattern.test(attempt.sbom_digest) ||
    !attempt.attestation_digest ||
    !digestPattern.test(attempt.attestation_digest) ||
    !attempt.started_at ||
    !attempt.finished_at ||
    !Number.isFinite(Date.parse(attempt.started_at)) ||
    !Number.isFinite(Date.parse(attempt.finished_at)) ||
    Date.parse(attempt.finished_at) < Date.parse(attempt.started_at)
  ) {
    throw new Error('TRUST_TERMINAL_EVIDENCE_INCOMPLETE');
  }
  const attestation = attempt.attestation;
  if (
    !attestation ||
    attestation.attestation_digest !== attempt.attestation_digest ||
    attestation.subject_artifact_digest !== expected.artifactDigest ||
    attestation.policy_digest !== attempt.policy_digest ||
    attestation.result !== attempt.state ||
    attestation.sbom_digest !== attempt.sbom_digest ||
    attestation.predicate_type !==
      'https://openopc.dev/attestations/developer-module-verification/v1'
  ) {
    throw new Error('TRUST_ATTESTATION_BINDING_MISMATCH');
  }
  return attempt;
}

export function assertImmutableAttempt(first: unknown, second: unknown): void {
  if (canonicalJson(first) !== canonicalJson(second)) throw new Error('TRUST_ATTEMPT_MUTATED');
}

export async function waitForImmutableTrustAttempt<T extends { run_id: string; state: string }>(
  readTrust: () => Promise<{ attempts: readonly T[] }>,
  input: { timeoutMs: number; pollMs: number },
): Promise<T> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    !Number.isSafeInteger(input.pollMs) ||
    input.pollMs < 0
  ) {
    throw new Error('TRUST_POLL_CONFIG_INVALID');
  }
  const terminalStates = new Set(['passed', 'failed', 'inconclusive', 'cancelled']);
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    const view = await readTrust();
    const candidate = view.attempts.at(-1);
    if (candidate && terminalStates.has(candidate.state)) {
      if (input.pollMs > 0) await delay(input.pollMs);
      const confirmation = (await readTrust()).attempts.find(
        (attempt) => attempt.run_id === candidate.run_id,
      );
      if (!confirmation) throw new Error('TRUST_TERMINAL_ATTEMPT_DISAPPEARED');
      assertImmutableAttempt(candidate, confirmation);
      return candidate;
    }
    if (input.pollMs > 0) await delay(input.pollMs);
  }
  throw new Error('TRUST_VERIFICATION_TIMEOUT');
}

export async function updateTrustEvidenceLedger(input: {
  ledgerPath: string;
  commit: string;
  runId: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  dependencyIdentities: readonly string[];
  artifacts: Record<'G2' | 'G3' | 'G4', string>;
  evidenceKey: { keyId: string; publicKeyDer: Uint8Array };
}): Promise<void> {
  const startedAt = Date.parse(input.startedAt);
  const finishedAt = Date.parse(input.finishedAt);
  if (
    !/^[0-9a-f]{7,40}$/.test(input.commit) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.runId) ||
    !input.command.trim() ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt
  ) {
    throw new Error('TRUST_EVIDENCE_RUN_METADATA_INVALID');
  }
  await Promise.all(
    (['G2', 'G3', 'G4'] as const).map(async (gate) => {
      let envelope: SignedEvidenceDocument;
      try {
        envelope = JSON.parse(
          await readFile(resolve(repositoryRoot, input.artifacts[gate]), 'utf8'),
        ) as SignedEvidenceDocument;
      } catch {
        throw new Error('TRUST_EVIDENCE_ARTIFACT_SIGNATURE_INVALID');
      }
      let document: unknown;
      try {
        document = verifySignedEvidenceDocument(envelope, input.evidenceKey);
      } catch {
        throw new Error('TRUST_EVIDENCE_ARTIFACT_SIGNATURE_INVALID');
      }
      if (
        !isRecord(document) ||
        document.schemaVersion !== 1 ||
        document.gate !== gate ||
        document.outcome !== 'passed' ||
        document.commit !== input.commit ||
        document.runId !== input.runId ||
        !Array.isArray(document.dependencyIdentities) ||
        canonicalJson(document.dependencyIdentities) !== canonicalJson(input.dependencyIdentities)
      ) {
        throw new Error('TRUST_EVIDENCE_ARTIFACT_BINDING_INVALID');
      }
    }),
  );
  const ledger = validateEvidenceLedger(
    JSON.parse(await readFile(input.ledgerPath, 'utf8')) as unknown,
  );
  const gates = new Set(['G2', 'G3', 'G4']);
  const records = ledger.records.map((record) => {
    if (!gates.has(record.gate)) return { ...record };
    const gate = record.gate as keyof typeof input.artifacts;
    const artifactPath = input.artifacts[gate];
    validateEvidence({
      gate,
      lane: 'integration',
      outcome: 'passed',
      dependencyIdentities: input.dependencyIdentities,
    });
    if (!artifactPath.trim()) throw new Error('EVIDENCE_ARTIFACT_REQUIRED');
    return {
      id: `${gate}-${input.commit.slice(0, 12)}-${input.runId}`,
      gate,
      lane: 'integration' as const,
      command: input.command,
      environment: 'staging',
      dependencyIdentities: [...input.dependencyIdentities],
      commit: input.commit,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: 'passed' as const,
      artifactPaths: [artifactPath],
    };
  });
  const updated = validateEvidenceLedger({ schemaVersion: 1, records });
  const temporaryPath = `${input.ledgerPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, input.ledgerPath);
}

export function verifyDsseEnvelope(
  envelope: DsseEnvelope,
  input: { keyId: string; publicKeyDer: Uint8Array },
): unknown {
  if (
    !isRecord(envelope) ||
    !validIdentifier(envelope.payloadType) ||
    typeof envelope.payload !== 'string' ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1
  ) {
    throw new Error('DSSE_ENVELOPE_INVALID');
  }
  const signature = envelope.signatures[0];
  if (!signature || signature.keyid !== input.keyId || !validIdentifier(signature.keyid)) {
    throw new Error('DSSE_KEY_ID_MISMATCH');
  }
  const payload = exactBase64(envelope.payload);
  const signatureBytes = exactBase64(signature.sig);
  if (
    !cryptoVerify(
      null,
      dssePreAuthEncoding(envelope.payloadType, payload),
      assertEd25519PublicKey(input.publicKeyDer),
      signatureBytes,
    )
  ) {
    throw new Error('DSSE_SIGNATURE_INVALID');
  }
  let document: unknown;
  try {
    document = JSON.parse(payload.toString('utf8')) as unknown;
  } catch {
    throw new Error('DSSE_PAYLOAD_INVALID');
  }
  if (canonicalJson(document) !== payload.toString('utf8')) {
    throw new Error('DSSE_PAYLOAD_NOT_CANONICAL');
  }
  return document;
}

export async function signEvidenceDocument(
  document: unknown,
  input: { keyId: string; privateKey: KeyObject },
): Promise<SignedEvidenceDocument> {
  assertEvidenceKeyId(input.keyId);
  if (input.privateKey.type !== 'private' || input.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('EVIDENCE_SIGNING_PRIVATE_KEY_INVALID');
  }
  const payload = Buffer.from(canonicalJson(document), 'utf8');
  const signature = cryptoSign(
    null,
    dssePreAuthEncoding(moduleBetaPayloadType, payload),
    input.privateKey,
  );
  return {
    payloadType: moduleBetaPayloadType,
    payload: payload.toString('base64'),
    signatures: [{ keyid: input.keyId, sig: signature.toString('base64') }],
  };
}

export function verifySignedEvidenceDocument(
  envelope: SignedEvidenceDocument,
  input: { keyId: string; publicKeyDer: Uint8Array },
): unknown {
  assertEvidenceKeyId(input.keyId);
  if (envelope.payloadType !== moduleBetaPayloadType) {
    throw new Error('EVIDENCE_PAYLOAD_TYPE_INVALID');
  }
  return verifyDsseEnvelope(envelope, input);
}

export async function verifyStoredEvidence(
  reference: StoredEvidenceReference,
  input: {
    allowedHosts: readonly string[];
    fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  },
): Promise<{ digest: `sha256:${string}`; sizeBytes: number }> {
  if (
    reference.storage !== 'minio' ||
    !digestPattern.test(reference.contentDigest) ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes < 1 ||
    reference.sizeBytes > 64 * 1024 * 1024
  ) {
    throw new Error('TRUST_STORAGE_REFERENCE_INVALID');
  }
  let url: URL;
  try {
    url = new URL(reference.url);
  } catch {
    throw new Error('TRUST_STORAGE_URL_INVALID');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    mockedTargetPattern.test(`${url.hostname}${url.pathname}`) ||
    !input.allowedHosts.map((host) => host.toLowerCase()).includes(url.host.toLowerCase())
  ) {
    throw new Error('TRUST_STORAGE_URL_INVALID');
  }
  const response = await (input.fetcher ?? fetch)(url.href, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (
    !response.ok ||
    response.redirected ||
    response.headers.has('x-openopc-mock') ||
    response.headers.has('x-mock-response')
  ) {
    throw new Error('TRUST_STORAGE_READ_FAILED');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== reference.sizeBytes) {
    throw new Error('TRUST_STORAGE_SIZE_MISMATCH');
  }
  if (!response.body) throw new Error('TRUST_STORAGE_READ_FAILED');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    sizeBytes += next.value.byteLength;
    if (sizeBytes > reference.sizeBytes || sizeBytes > 64 * 1024 * 1024) {
      await reader.cancel().catch(() => undefined);
      throw new Error('TRUST_STORAGE_SIZE_MISMATCH');
    }
    hash.update(next.value);
  }
  const digest = `sha256:${hash.digest('hex')}` as const;
  if (sizeBytes !== reference.sizeBytes) throw new Error('TRUST_STORAGE_SIZE_MISMATCH');
  if (digest !== reference.contentDigest) throw new Error('TRUST_STORAGE_DIGEST_MISMATCH');
  return { digest, sizeBytes };
}

export function verifyInspectorAttestation(
  attestation: InspectorAttestation,
  expected: {
    runId: string;
    attempt: number;
    state: 'passed' | 'failed' | 'inconclusive' | 'cancelled';
    artifactDigest: `sha256:${string}`;
    sbomDigest: `sha256:${string}`;
    policyDigest: `sha256:${string}`;
    scannerSetDigest: `sha256:${string}`;
    sandboxProfileDigest: `sha256:${string}`;
    scannerIdentities: readonly string[];
    scannerIdentityVerified: boolean;
    acceptance?: {
      acceptanceRunId: string;
      registrationId: string;
      scenario: Exclude<TrustFixtureScenario, 'traversal' | 'oversized-file'>;
    };
    keyring: Readonly<Record<string, Uint8Array>>;
  },
): unknown {
  if (
    !digestPattern.test(attestation.digest) ||
    !/^openopc-attestation-staging-[A-Za-z0-9._:-]{1,128}$/.test(attestation.keyId) ||
    sha256(canonicalJson(attestation.envelope)) !== attestation.digest
  ) {
    throw new Error('TRUST_ATTESTATION_DIGEST_INVALID');
  }
  const publicKeyDer = expected.keyring[attestation.keyId];
  if (!publicKeyDer) throw new Error('TRUST_ATTESTATION_KEY_UNPINNED');
  const statement = verifyDsseEnvelope(attestation.envelope, {
    keyId: attestation.keyId,
    publicKeyDer,
  });
  if (!isRecord(statement)) throw new Error('TRUST_ATTESTATION_STATEMENT_INVALID');
  const subject = Array.isArray(statement.subject) ? statement.subject[0] : undefined;
  const subjectDigest =
    isRecord(subject) && isRecord(subject.digest) ? subject.digest.sha256 : null;
  const predicate = statement.predicate;
  const acceptance = isRecord(predicate) ? predicate.acceptance : undefined;
  const acceptanceMatches = expected.acceptance
    ? isRecord(acceptance) &&
      Object.keys(acceptance).sort().join(',') === 'acceptanceRunId,registrationId,scenario' &&
      acceptance.acceptanceRunId === expected.acceptance.acceptanceRunId &&
      acceptance.registrationId === expected.acceptance.registrationId &&
      acceptance.scenario === expected.acceptance.scenario
    : acceptance === undefined;
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !==
      'https://openopc.dev/attestations/developer-module-verification/v1' ||
    subjectDigest !== expected.artifactDigest.slice('sha256:'.length) ||
    !isRecord(predicate) ||
    predicate.artifactDigest !== expected.artifactDigest ||
    predicate.sbomDigest !== expected.sbomDigest ||
    predicate.policyDigest !== expected.policyDigest ||
    predicate.scannerSetDigest !== expected.scannerSetDigest ||
    predicate.sandboxProfileDigest !== expected.sandboxProfileDigest ||
    predicate.runId !== expected.runId ||
    predicate.attempt !== expected.attempt ||
    predicate.result !== expected.state ||
    !Array.isArray(predicate.scannerIdentities) ||
    predicate.scannerIdentities.length !== expected.scannerIdentities.length ||
    predicate.scannerIdentities.some(
      (identity, index) => identity !== expected.scannerIdentities[index],
    ) ||
    predicate.scannerIdentityVerified !== expected.scannerIdentityVerified ||
    !acceptanceMatches ||
    !Array.isArray(predicate.evidenceDigests) ||
    predicate.evidenceDigests.some(
      (digest) => typeof digest !== 'string' || !digestPattern.test(digest),
    )
  ) {
    throw new Error('TRUST_ATTESTATION_STATEMENT_INVALID');
  }
  return statement;
}

export function sha256(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function loadEvidencePrivateKey(value: string): KeyObject {
  let bytes: Buffer;
  try {
    bytes = exactBase64(value);
  } catch {
    throw new Error('EVIDENCE_SIGNING_PRIVATE_KEY_INVALID');
  }
  try {
    const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('EVIDENCE_SIGNING_PRIVATE_KEY_INVALID');
    }
    return key;
  } catch {
    throw new Error('EVIDENCE_SIGNING_PRIVATE_KEY_INVALID');
  }
}

function apiError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === 'string' ? value.error : null;
}

export function assertAllowedPresignedUploadUrl(
  value: string,
  allowedHosts: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TRUST_UPLOAD_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    mockedTargetPattern.test(`${url.hostname}${url.pathname}`) ||
    !allowedHosts.map((host) => host.toLowerCase()).includes(url.host.toLowerCase())
  ) {
    throw new Error('TRUST_UPLOAD_URL_INVALID');
  }
  return url;
}

async function createUploadAndPut(
  config: TrustStagingConfig,
  fixture: GeneratedTrustFixture,
): Promise<DeveloperArtifactUploadTicket> {
  const created = await apiJson(config, {
    path: '/developer/modules/artifact-uploads',
    token: config.primary.token,
    method: 'POST',
    body: {
      account_id: config.primary.accountId,
      publisher_id: config.publisherId,
      expected_size: fixture.sizeBytes,
      expected_digest: fixture.archiveDigest,
    },
  });
  if (created.response.status !== 201) {
    throw new Error(
      `TRUST_UPLOAD_CREATE_FAILED:${apiError(created.value) ?? created.response.status}`,
    );
  }
  const ticket = parseUploadTicket(created.value);
  if (
    ticket.expected_digest !== fixture.archiveDigest ||
    ticket.expected_size !== fixture.sizeBytes
  ) {
    throw new Error('TRUST_UPLOAD_TICKET_BINDING_MISMATCH');
  }
  const uploadUrl = assertAllowedPresignedUploadUrl(ticket.upload_url, config.minioHosts);
  const bytes = await readFile(fixture.archivePath);
  if (bytes.byteLength !== fixture.sizeBytes || sha256(bytes) !== fixture.archiveDigest) {
    throw new Error('TRUST_FIXTURE_CHANGED_AFTER_GENERATION');
  }
  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: ticket.headers,
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!uploaded.ok || uploaded.redirected || responseIsMocked(uploaded)) {
    throw new Error(`TRUST_UPLOAD_PUT_FAILED:${uploaded.status}`);
  }
  await uploaded.body?.cancel().catch(() => undefined);
  return ticket;
}

async function finalizeUpload(config: TrustStagingConfig, uploadId: string): Promise<JsonResponse> {
  return apiJson(config, {
    path: `/developer/modules/artifact-uploads/${encodeURIComponent(uploadId)}/finalize`,
    token: config.primary.token,
    method: 'POST',
    body: { account_id: config.primary.accountId },
  });
}

export function assertOpaqueNotFoundResponses(
  crossAccount: { status: number; value: unknown },
  missing: { status: number; value: unknown },
): void {
  if (
    crossAccount.status !== 404 ||
    missing.status !== 404 ||
    canonicalJson(crossAccount.value) !== canonicalJson(missing.value)
  ) {
    throw new Error('TRUST_CROSS_ACCOUNT_RESPONSE_NOT_OPAQUE');
  }
}

async function expectCrossAccountNotFound(
  config: TrustStagingConfig,
  path: string,
  randomMissingPath: string,
): Promise<void> {
  const withSecondaryAccount = (value: string) => {
    const separator = value.includes('?') ? '&' : '?';
    return `${value}${separator}account_id=${encodeURIComponent(config.secondary.accountId)}`;
  };
  const [denied, missing] = await Promise.all([
    apiJson(config, {
      path: withSecondaryAccount(path),
      token: config.secondary.token,
    }),
    apiJson(config, {
      path: withSecondaryAccount(randomMissingPath),
      token: config.secondary.token,
    }),
  ]);
  assertOpaqueNotFoundResponses(
    { status: denied.response.status, value: denied.value },
    { status: missing.response.status, value: missing.value },
  );
}

export function buildTrustRegistration(
  config: Pick<TrustStagingConfig, 'runId'>,
  scenario: Exclude<TrustFixtureScenario, 'traversal' | 'oversized-file'>,
  artifact: Pick<DeveloperArtifact, 'artifact_id' | 'account_id' | 'artifact_digest'>,
): ModuleBetaArtifactRegistrationRequestV1 {
  return parseModuleBetaArtifactRegistrationRequest({
    schemaVersion: 1,
    acceptanceRunId: config.runId,
    scenario,
    accountId: artifact.account_id,
    artifactId: artifact.artifact_id,
    artifactDigest: artifact.artifact_digest,
  });
}

async function registerVerificationFixture(
  config: TrustStagingConfig,
  fixture: GeneratedTrustFixture,
  artifact: DeveloperArtifact,
): Promise<{ controllerIdentity: string; registrationId: string }> {
  if (fixture.scenario === 'traversal' || fixture.scenario === 'oversized-file') {
    throw new Error('TRUST_REGISTRATION_SCENARIO_INVALID');
  }
  const registered = await acceptanceJson(config, {
    path: '/module-beta/trust/registrations',
    method: 'POST',
    body: buildTrustRegistration(config, fixture.scenario, artifact),
  });
  let result: ReturnType<typeof parseModuleBetaArtifactRegistrationResponse>;
  try {
    result = parseModuleBetaArtifactRegistrationResponse(registered.value);
  } catch {
    throw new Error('TRUST_REGISTRATION_INVALID');
  }
  const identity = result.dependencyIdentity;
  const expiresAt = Date.parse(result.expiresAt);
  if (
    registered.response.status !== 201 ||
    result.schemaVersion !== 1 ||
    result.registered !== true ||
    result.acceptanceRunId !== config.runId ||
    result.scenario !== fixture.scenario ||
    result.faultArmed !== (fixture.checkpoint === 'staging-fault') ||
    !uuidPattern.test(stringValue(result.registrationId, 'TRUST_REGISTRATION_INVALID')) ||
    result.artifactId !== artifact.artifact_id ||
    result.artifactDigest !== artifact.artifact_digest ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !validIdentifier(identity) ||
    mockedTargetPattern.test(identity)
  ) {
    throw new Error('TRUST_REGISTRATION_INVALID');
  }
  return {
    controllerIdentity: assertPinnedControlIdentity(identity, config.controlIdentity),
    registrationId: result.registrationId,
  };
}

function parseInspectorEvidence(value: unknown): TrustInspectorEvidence {
  try {
    return parseModuleBetaInspectorEvidence(value);
  } catch {
    throw new Error('TRUST_INSPECTOR_EVIDENCE_INVALID');
  }
}

function expectedAttempt(
  config: TrustStagingConfig,
  scenario: TrustFixtureScenario,
  artifactDigest: `sha256:${string}`,
): TrustAttemptExpectation {
  if (scenario === 'clean-wasi') {
    return {
      state: 'passed',
      terminalReason: 'verification_completed',
      findingCodes: [],
      artifactDigest,
    };
  }
  if (scenario === 'secret-leak' || scenario === 'vulnerable-lockfile') {
    return {
      state: 'failed',
      terminalReason: 'blocking_findings',
      findingCodes: config.expectedFindings[scenario],
      artifactDigest,
    };
  }
  if (scenario === 'invalid-signature') {
    return {
      state: 'inconclusive',
      terminalReason: 'attestation_signature_invalid',
      findingCodes: [],
      artifactDigest,
    };
  }
  if (scenario === 'stale-policy') {
    return {
      state: 'inconclusive',
      terminalReason: 'policy_mismatch',
      findingCodes: [],
      artifactDigest,
    };
  }
  return {
    state: 'inconclusive',
    terminalReason: 'scanner_inconclusive',
    findingCodes: [],
    artifactDigest,
  };
}

async function readTrustView(
  config: TrustStagingConfig,
  releaseId: string,
): Promise<DeveloperTrustView> {
  const result = await apiJson(config, {
    path: `/developer/modules/releases/${encodeURIComponent(releaseId)}/trust?account_id=${encodeURIComponent(config.primary.accountId)}`,
    token: config.primary.token,
  });
  if (result.response.status !== 200) {
    throw new Error(`TRUST_VIEW_READ_FAILED:${apiError(result.value) ?? result.response.status}`);
  }
  return parseTrustView(result.value);
}

function requiredScannerIdentities(
  identities: readonly string[],
  allowed: readonly string[],
): void {
  const scannerNames = ['gitleaks', 'syft', 'osv-scanner', 'semgrep', 'license-policy'];
  if (
    identities.some((identity) => !allowed.includes(identity)) ||
    scannerNames.some((name) => !identities.some((identity) => identity.startsWith(`${name}@`)))
  ) {
    throw new Error('TRUST_SCANNER_IDENTITIES_INVALID');
  }
}

async function inspectTerminalEvidence(input: {
  config: TrustStagingConfig;
  fixture: GeneratedTrustFixture;
  artifact: DeveloperArtifact;
  attempt: SafeTrustAttempt;
  registrationId: string;
}): Promise<{
  attestationKeyId: string;
  scannerIdentities: string[];
}> {
  const inspected = await acceptanceJson(input.config, {
    path: `/module-beta/trust/runs/${encodeURIComponent(input.attempt.run_id)}/evidence`,
  });
  if (inspected.response.status !== 200) {
    throw new Error(`TRUST_INSPECTOR_READ_FAILED:${inspected.response.status}`);
  }
  const evidence = parseInspectorEvidence(inspected.value);
  if (
    evidence.acceptanceRunId !== input.config.runId ||
    evidence.controllerIdentity !== input.config.controlIdentity ||
    evidence.runId !== input.attempt.run_id ||
    evidence.artifact.artifactDigest !== input.artifact.artifact_digest ||
    evidence.artifact.contentDigest !== input.fixture.archiveDigest ||
    evidence.artifact.sizeBytes !== input.fixture.sizeBytes ||
    evidence.sbom.contentDigest !== input.attempt.sbom_digest ||
    evidence.attestation.digest !== input.attempt.attestation_digest
  ) {
    throw new Error('TRUST_INSPECTOR_BINDING_MISMATCH');
  }
  await Promise.all([
    verifyStoredEvidence(evidence.artifact, { allowedHosts: input.config.minioHosts }),
    verifyStoredEvidence(evidence.sbom, { allowedHosts: input.config.minioHosts }),
  ]);
  verifyInspectorAttestation(evidence.attestation, {
    runId: input.attempt.run_id,
    attempt: input.attempt.attempt,
    state: input.attempt.state as 'passed' | 'failed' | 'inconclusive' | 'cancelled',
    artifactDigest: input.artifact.artifact_digest,
    sbomDigest: input.attempt.sbom_digest as `sha256:${string}`,
    policyDigest: input.attempt.policy_digest as `sha256:${string}`,
    scannerSetDigest: input.attempt.scanner_set_digest as `sha256:${string}`,
    sandboxProfileDigest: input.attempt.sandbox_profile_digest as `sha256:${string}`,
    scannerIdentities: evidence.scannerIdentities,
    scannerIdentityVerified: input.fixture.scenario !== 'stale-policy',
    acceptance: {
      acceptanceRunId: input.config.runId,
      registrationId: input.registrationId,
      scenario: input.fixture.scenario as Exclude<
        TrustFixtureScenario,
        'traversal' | 'oversized-file'
      >,
    },
    keyring: input.config.attestationKeyring,
  });
  requiredScannerIdentities(evidence.scannerIdentities, input.config.dependencyIdentities);
  if (!input.config.dependencyIdentities.includes(`key:${evidence.attestation.keyId}`)) {
    throw new Error('TRUST_ATTESTATION_KEY_ID_UNRECORDED');
  }
  return {
    attestationKeyId: evidence.attestation.keyId,
    scannerIdentities: evidence.scannerIdentities,
  };
}

async function executeApiRejectionFixture(
  config: TrustStagingConfig,
  fixture: GeneratedTrustFixture,
): Promise<TrustFixtureResult> {
  const upload = await createUploadAndPut(config, fixture);
  const finalized = await finalizeUpload(config, upload.upload_id);
  const error = apiError(finalized.value);
  if (finalized.response.status !== 400 || error !== 'DEVELOPER_ARTIFACT_INVALID') {
    throw new Error(
      `TRUST_MALICIOUS_ARCHIVE_ACCEPTED:${fixture.scenario}:${finalized.response.status}:${error ?? 'unknown'}`,
    );
  }
  return {
    scenario: fixture.scenario,
    checkpoint: fixture.checkpoint,
    archiveDigest: fixture.archiveDigest,
    archiveSizeBytes: fixture.sizeBytes,
    artifactId: null,
    artifactDigest: null,
    releaseId: null,
    runId: null,
    state: 'rejected',
    terminalReason: error,
    findingCodes: [],
    crossAccountDenied: false,
    storageVerified: false,
    sbomVerified: false,
    attestationKeyId: null,
    scannerIdentities: [],
    controlIdentity: null,
  };
}

async function executeVerificationFixture(
  config: TrustStagingConfig,
  fixture: GeneratedTrustFixture,
): Promise<TrustFixtureResult> {
  const upload = await createUploadAndPut(config, fixture);
  const finalized = await finalizeUpload(config, upload.upload_id);
  if (finalized.response.status !== 200 && finalized.response.status !== 201) {
    throw new Error(
      `TRUST_ARTIFACT_FINALIZE_FAILED:${apiError(finalized.value) ?? finalized.response.status}`,
    );
  }
  const artifact = parseArtifact(finalized.value);
  if (artifact.account_id !== config.primary.accountId) {
    throw new Error('TRUST_ARTIFACT_ACCOUNT_MISMATCH');
  }
  await expectCrossAccountNotFound(
    config,
    `/developer/modules/artifacts/${encodeURIComponent(artifact.artifact_id)}`,
    `/developer/modules/artifacts/${randomUUID()}`,
  );
  const registration = await registerVerificationFixture(config, fixture, artifact);
  const submitted = await apiJson(config, {
    path: '/developer/modules/releases',
    token: config.primary.token,
    method: 'POST',
    body: { account_id: config.primary.accountId, artifact_id: artifact.artifact_id },
  });
  if (submitted.response.status !== 200 && submitted.response.status !== 201) {
    throw new Error(
      `TRUST_RELEASE_SUBMIT_FAILED:${apiError(submitted.value) ?? submitted.response.status}`,
    );
  }
  const release = parseRelease(submitted.value);
  if (
    release.account_id !== config.primary.accountId ||
    release.artifact_id !== artifact.artifact_id ||
    release.artifact_digest !== artifact.artifact_digest ||
    release.runtime_kind !== 'wasi-component' ||
    !release.runtime_descriptor_digest
  ) {
    throw new Error('TRUST_RELEASE_BINDING_MISMATCH');
  }
  const attempt = await waitForImmutableTrustAttempt(
    async () => readTrustView(config, release.release_id),
    { timeoutMs: config.timeoutMs, pollMs: config.pollMs },
  );
  const expected = expectedAttempt(config, fixture.scenario, artifact.artifact_digest);
  validateTerminalAttempt(attempt, expected);
  const trust = await readTrustView(config, release.release_id);
  if (
    trust.release_id !== release.release_id ||
    trust.account_id !== config.primary.accountId ||
    trust.artifact.artifact_id !== artifact.artifact_id ||
    trust.artifact.artifact_digest !== artifact.artifact_digest
  ) {
    throw new Error('TRUST_VIEW_BINDING_MISMATCH');
  }
  await expectCrossAccountNotFound(
    config,
    `/developer/modules/releases/${encodeURIComponent(release.release_id)}/trust`,
    `/developer/modules/releases/${randomUUID()}/trust`,
  );
  const inspected = await inspectTerminalEvidence({
    config,
    fixture,
    artifact,
    attempt,
    registrationId: registration.registrationId,
  });
  return {
    scenario: fixture.scenario,
    checkpoint: fixture.checkpoint,
    archiveDigest: fixture.archiveDigest,
    archiveSizeBytes: fixture.sizeBytes,
    artifactId: artifact.artifact_id,
    artifactDigest: artifact.artifact_digest,
    releaseId: release.release_id,
    runId: attempt.run_id,
    state: attempt.state,
    terminalReason: attempt.terminal_reason as string,
    findingCodes: attempt.findings.map((finding) => `${finding.scanner}:${finding.rule_id}`).sort(),
    crossAccountDenied: true,
    storageVerified: true,
    sbomVerified: true,
    attestationKeyId: inspected.attestationKeyId,
    scannerIdentities: inspected.scannerIdentities,
    controlIdentity: registration.controllerIdentity,
  };
}

async function executeFixture(
  config: TrustStagingConfig,
  fixture: GeneratedTrustFixture,
): Promise<TrustFixtureResult> {
  return fixture.checkpoint === 'api-rejection'
    ? executeApiRejectionFixture(config, fixture)
    : executeVerificationFixture(config, fixture);
}

async function assertRunnerReadiness(config: TrustStagingConfig): Promise<Record<string, unknown>> {
  const result = await fetchJson(
    buildTrustServiceUrl(config, 'worker', '/readyz'),
    {
      method: 'GET',
      headers: { 'x-openopc-module-beta': 'trust-staging-v1' },
    },
    config.timeoutMs,
  );
  const readiness = recordValue(result.value, 'TRUST_READINESS_INVALID');
  const components = recordValue(readiness.components, 'TRUST_READINESS_INVALID');
  const expected = [
    'objectStorage',
    'postgresClaims',
    'policy',
    'gitleaks',
    'syft',
    'osv',
    'semgrep',
    'licensePolicy',
    'attestationSigner',
    'sandboxControl',
  ];
  if (
    result.response.status !== 200 ||
    readiness.enabled !== true ||
    readiness.ready !== true ||
    Object.keys(components).length !== expected.length ||
    expected.some((name) => {
      const component = components[name];
      return !isRecord(component) || component.ready !== true || component.reason !== 'ready';
    })
  ) {
    throw new Error('TRUST_READINESS_INVALID');
  }
  return {
    enabled: true,
    ready: true,
    components: Object.fromEntries(
      expected.map((name) => [name, { ready: true, reason: 'ready' }]),
    ),
  };
}

async function createCancelledUploadProbe(
  config: TrustStagingConfig,
  fixture: GeneratedTrustFixture,
): Promise<string> {
  const upload = await createUploadAndPut(config, fixture);
  const cancelled = await apiJson(config, {
    path: `/developer/modules/artifact-uploads/${encodeURIComponent(upload.upload_id)}?account_id=${encodeURIComponent(config.primary.accountId)}`,
    token: config.primary.token,
    method: 'DELETE',
  });
  if (cancelled.response.status !== 204) {
    throw new Error(`TRUST_CANCELLED_UPLOAD_PROBE_FAILED:${cancelled.response.status}`);
  }
  return upload.upload_id;
}

export async function verifyCleanupPreservesImmutableAttempts<T>(input: {
  releaseIds: readonly string[];
  readTrust(releaseId: string): Promise<{ release_id: string; attempts: readonly unknown[] }>;
  cleanup(): Promise<T>;
}): Promise<{
  result: T;
  attemptCount: number;
  snapshotDigest: `sha256:${string}`;
}> {
  if (
    input.releaseIds.length < 1 ||
    input.releaseIds.length > 128 ||
    new Set(input.releaseIds).size !== input.releaseIds.length ||
    input.releaseIds.some(
      (releaseId) => !uuidPattern.test(releaseId) || releaseId !== releaseId.toLowerCase(),
    )
  ) {
    throw new Error('TRUST_CLEANUP_ATTEMPT_SNAPSHOT_INVALID');
  }
  const releaseIds = [...input.releaseIds].sort();
  const capture = async () =>
    Promise.all(
      releaseIds.map(async (releaseId) => {
        const trust = await input.readTrust(releaseId);
        if (trust.release_id !== releaseId || !Array.isArray(trust.attempts)) {
          throw new Error('TRUST_CLEANUP_ATTEMPT_SNAPSHOT_INVALID');
        }
        return { releaseId, attempts: structuredClone(trust.attempts) };
      }),
    );

  const before = await capture();
  const beforeJson = canonicalJson(before);
  const result = await input.cleanup();
  const afterJson = canonicalJson(await capture());
  if (afterJson !== beforeJson) {
    throw new Error('TRUST_CLEANUP_IMMUTABLE_ATTEMPTS_CHANGED');
  }
  return {
    result,
    attemptCount: before.reduce((total, entry) => total + entry.attempts.length, 0),
    snapshotDigest: sha256(beforeJson),
  };
}

export async function waitForModuleBetaCleanup(input: {
  acceptanceRunId: string;
  dependencyIdentity: string;
  timeoutMs: number;
  pollMs: number;
  cleanup(): Promise<JsonResponse>;
}): Promise<JsonResponse> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.acceptanceRunId) ||
    !validIdentifier(input.dependencyIdentity) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    !Number.isSafeInteger(input.pollMs) ||
    input.pollMs < 0
  ) {
    throw new Error('TRUST_CLEANUP_POLL_INVALID');
  }
  const deadline = Date.now() + input.timeoutMs;
  const maximumPolls = input.pollMs === 0 ? 10_000 : Math.ceil(input.timeoutMs / input.pollMs) + 1;
  let retentionRunId: string | null = null;
  for (let poll = 0; poll < maximumPolls && Date.now() <= deadline; poll += 1) {
    const result = await input.cleanup();
    if (result.response.status === 200) {
      let final: ReturnType<typeof parseModuleBetaCleanupResponse>;
      try {
        final = parseModuleBetaCleanupResponse(result.value);
      } catch {
        throw new Error('TRUST_CLEANUP_EVIDENCE_INVALID');
      }
      if (
        final.acceptanceRunId !== input.acceptanceRunId ||
        final.dependencyIdentity !== input.dependencyIdentity
      ) {
        throw new Error('TRUST_CLEANUP_EVIDENCE_INVALID');
      }
      return result;
    }
    if (result.response.status !== 202) {
      throw new Error(`TRUST_CLEANUP_WORKER_FAILED:${result.response.status}`);
    }
    const pending = cleanupPendingResponse(result.value);
    if (
      pending.acceptanceRunId !== input.acceptanceRunId ||
      pending.dependencyIdentity !== input.dependencyIdentity ||
      (retentionRunId !== null && pending.retentionRunId !== retentionRunId)
    ) {
      throw new Error('TRUST_CLEANUP_PENDING_INVALID');
    }
    retentionRunId = pending.retentionRunId;
    if (input.pollMs > 0) await delay(input.pollMs);
  }
  throw new Error('TRUST_CLEANUP_TIMEOUT');
}

function cleanupPendingResponse(value: unknown): {
  acceptanceRunId: string;
  dependencyIdentity: string;
  retentionRunId: string;
  state: 'queued' | 'running';
} {
  if (!isRecord(value)) throw new Error('TRUST_CLEANUP_PENDING_INVALID');
  const expectedKeys = [
    'acceptanceRunId',
    'dependencyIdentity',
    'retentionRunId',
    'schemaVersion',
    'state',
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.acceptanceRunId) ||
    !validIdentifier(value.dependencyIdentity) ||
    typeof value.retentionRunId !== 'string' ||
    !uuidPattern.test(value.retentionRunId) ||
    value.retentionRunId !== value.retentionRunId.toLowerCase() ||
    (value.state !== 'queued' && value.state !== 'running')
  ) {
    throw new Error('TRUST_CLEANUP_PENDING_INVALID');
  }
  return {
    acceptanceRunId: value.acceptanceRunId,
    dependencyIdentity: value.dependencyIdentity,
    retentionRunId: value.retentionRunId,
    state: value.state,
  };
}

async function runRetentionAndOrphanCleanup(input: {
  config: TrustStagingConfig;
  cancelledUploadId: string;
  results: readonly TrustFixtureResult[];
}): Promise<{ summary: Record<string, unknown>; dependencyIdentity: string }> {
  const releaseIds = input.results.flatMap((result) =>
    result.releaseId === null ? [] : [result.releaseId],
  );
  const cleanupBody = parseModuleBetaCleanupRequest({
    schemaVersion: 1,
    acceptanceRunId: input.config.runId,
    accountId: input.config.primary.accountId,
    cancelledUploadId: input.cancelledUploadId,
    artifactIds: input.results.flatMap((result) =>
      result.artifactId === null ? [] : [result.artifactId],
    ),
    releaseIds,
    verificationRunIds: input.results.flatMap((result) =>
      result.runId === null ? [] : [result.runId],
    ),
    createExpiredRetentionProbe: true,
    createOrphanObjectProbe: true,
  });
  const preserved = await verifyCleanupPreservesImmutableAttempts({
    releaseIds,
    readTrust: (releaseId) => readTrustView(input.config, releaseId),
    cleanup: () =>
      waitForModuleBetaCleanup({
        acceptanceRunId: input.config.runId,
        dependencyIdentity: input.config.controlIdentity,
        timeoutMs: input.config.timeoutMs,
        pollMs: input.config.pollMs,
        cleanup: () =>
          acceptanceJson(input.config, {
            path: '/module-beta/trust/cleanup',
            method: 'POST',
            body: cleanupBody,
          }),
      }),
  });
  const cleaned = preserved.result;
  let root: ReturnType<typeof parseModuleBetaCleanupResponse>;
  try {
    root = parseModuleBetaCleanupResponse(cleaned.value);
  } catch {
    throw new Error('TRUST_CLEANUP_EVIDENCE_INVALID');
  }
  const { retention, orphanCleanup } = root;
  const identity = root.dependencyIdentity;
  if (
    cleaned.response.status !== 200 ||
    root.schemaVersion !== 1 ||
    root.acceptanceRunId !== input.config.runId ||
    retention.expiredProbeDeleted !== true ||
    retention.immutableAttemptsPreserved !== true ||
    orphanCleanup.cancelledUploadAbsent !== true ||
    orphanCleanup.orphanProbeDeleted !== true ||
    !validIdentifier(identity) ||
    mockedTargetPattern.test(identity)
  ) {
    throw new Error('TRUST_CLEANUP_EVIDENCE_INVALID');
  }
  return {
    summary: {
      retention: {
        expiredProbeDeleted: true,
        immutableAttemptsPreserved: true,
        immutableAttemptCount: preserved.attemptCount,
        immutableAttemptSnapshotDigest: preserved.snapshotDigest,
      },
      orphanCleanup: {
        cancelledUploadAbsent: true,
        orphanProbeDeleted: true,
      },
    },
    dependencyIdentity: assertPinnedControlIdentity(identity, input.config.controlIdentity),
  };
}

function evidencePath(path: string): string {
  const value = relative(repositoryRoot, path).split(sep).join('/');
  if (!value || value.startsWith('../')) throw new Error('EVIDENCE_OUTPUT_PATH_INVALID');
  return value;
}

async function writeSignedEvidenceFile(
  path: string,
  document: unknown,
  config: TrustStagingConfig,
): Promise<void> {
  const envelope = await signEvidenceDocument(document, {
    keyId: config.evidenceSigning.keyId,
    privateKey: config.evidenceSigning.privateKey,
  });
  const verified = verifySignedEvidenceDocument(envelope, {
    keyId: config.evidenceSigning.keyId,
    publicKeyDer: config.evidenceSigning.publicKeyDer,
  });
  if (canonicalJson(verified) !== canonicalJson(document)) {
    throw new Error('EVIDENCE_SIGNATURE_ROUND_TRIP_FAILED');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function publicResult(result: TrustFixtureResult): Record<string, unknown> {
  return {
    scenario: result.scenario,
    checkpoint: result.checkpoint,
    archiveDigest: result.archiveDigest,
    archiveSizeBytes: result.archiveSizeBytes,
    artifactId: result.artifactId,
    artifactDigest: result.artifactDigest,
    releaseId: result.releaseId,
    runId: result.runId,
    state: result.state,
    terminalReason: result.terminalReason,
    findingCodes: result.findingCodes,
    crossAccountDenied: result.crossAccountDenied,
    storageVerified: result.storageVerified,
    sbomVerified: result.sbomVerified,
    attestationKeyId: result.attestationKeyId,
    scannerIdentities: result.scannerIdentities,
    controlIdentity: result.controlIdentity,
  };
}

export async function runTrustStagingAcceptance(config: TrustStagingConfig): Promise<{
  results: TrustFixtureResult[];
  outputPaths: Record<'G2' | 'G3' | 'G4', string>;
}> {
  const startedAt = new Date().toISOString();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'openopc-module-beta-trust-'));
  try {
    const readiness = await assertRunnerReadiness(config);
    const fixtures = await generateTrustFixtures({
      outputDirectory: fixtureDirectory,
      seed: `${config.commit}:${config.runId}`,
      publisherId: config.publisherId,
    });
    const results: TrustFixtureResult[] = [];
    for (const fixture of fixtures) {
      results.push(await executeFixture(config, fixture));
    }
    const cleanFixture = fixtures.find((fixture) => fixture.scenario === 'clean-wasi');
    if (!cleanFixture) throw new Error('TRUST_CLEAN_FIXTURE_MISSING');
    const cancelledUploadId = await createCancelledUploadProbe(config, cleanFixture);
    const cleanup = await runRetentionAndOrphanCleanup({
      config,
      cancelledUploadId,
      results,
    });
    const dependencyIdentities = [
      ...new Set([
        ...config.dependencyIdentities,
        ...results.flatMap((result) => result.scannerIdentities),
        ...results.flatMap((result) =>
          result.attestationKeyId ? [`key:${result.attestationKeyId}`] : [],
        ),
        ...results.flatMap((result) => (result.controlIdentity ? [result.controlIdentity] : [])),
        cleanup.dependencyIdentity,
        `key:${config.evidenceSigning.keyId}`,
      ]),
    ].sort();
    validateEvidence({
      gate: 'G3',
      lane: 'integration',
      outcome: 'passed',
      dependencyIdentities,
    });
    const finishedAt = new Date().toISOString();
    const outputPaths = {
      G2: join(evidenceOutputDirectory, 'G2-artifacts.json'),
      G3: join(evidenceOutputDirectory, 'G3-trust.json'),
      G4: join(evidenceOutputDirectory, 'G4-malicious.json'),
    };
    const common = {
      schemaVersion: 1,
      lane: 'integration',
      environment: 'staging',
      commit: config.commit,
      runId: config.runId,
      startedAt,
      finishedAt,
      dependencyIdentities,
      targets: {
        api: new URL(config.targets.api).origin,
        web: new URL(config.targets.web).origin,
        runner: new URL(config.targets.runner).origin,
        acceptance: new URL(config.acceptanceUrl).origin,
        trustWorker: new URL(config.trustWorkerUrl).origin,
      },
    };
    const clean = results.find((result) => result.scenario === 'clean-wasi');
    if (!clean || clean.state !== 'passed') throw new Error('TRUST_CLEAN_ACCEPTANCE_UNMET');
    const malicious = results.filter((result) => result.scenario !== 'clean-wasi');
    if (
      malicious.some(
        (result) =>
          !['failed', 'inconclusive', 'rejected'].includes(result.state) ||
          (result.checkpoint !== 'api-rejection' && !result.crossAccountDenied),
      )
    ) {
      throw new Error('TRUST_MALICIOUS_ACCEPTANCE_UNMET');
    }
    await Promise.all([
      writeSignedEvidenceFile(
        outputPaths.G2,
        {
          ...common,
          gate: 'G2',
          outcome: 'passed',
          artifactChecks: results.map(publicResult),
        },
        config,
      ),
      writeSignedEvidenceFile(
        outputPaths.G3,
        {
          ...common,
          gate: 'G3',
          outcome: 'passed',
          readiness,
          cleanTrust: publicResult(clean),
          cleanup: cleanup.summary,
        },
        config,
      ),
      writeSignedEvidenceFile(
        outputPaths.G4,
        {
          ...common,
          gate: 'G4',
          outcome: 'passed',
          maliciousChecks: malicious.map(publicResult),
        },
        config,
      ),
    ]);
    const relativeOutputPaths = {
      G2: evidencePath(outputPaths.G2),
      G3: evidencePath(outputPaths.G3),
      G4: evidencePath(outputPaths.G4),
    };
    await updateTrustEvidenceLedger({
      ledgerPath: evidenceLedgerPath,
      commit: config.commit,
      runId: config.runId,
      command: 'bun tests/module-beta/trust/run.ts',
      startedAt,
      finishedAt,
      dependencyIdentities,
      artifacts: relativeOutputPaths,
      evidenceKey: {
        keyId: config.evidenceSigning.keyId,
        publicKeyDer: config.evidenceSigning.publicKeyDer,
      },
    });
    return { results, outputPaths: relativeOutputPaths };
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const config = loadTrustStagingConfig();
  const result = await runTrustStagingAcceptance(config);
  console.log(
    canonicalJson({
      status: 'passed',
      gates: ['G2', 'G3', 'G4'],
      scenarios: result.results.map((entry) => ({
        scenario: entry.scenario,
        state: entry.state,
        terminalReason: entry.terminalReason,
      })),
      outputPaths: result.outputPaths,
    }),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'MODULE_BETA_TRUST_UNKNOWN_FAILURE';
    console.error(`[module-beta:trust] ${message}`);
    process.exitCode = 1;
  });
}
