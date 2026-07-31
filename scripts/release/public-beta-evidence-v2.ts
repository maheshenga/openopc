import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PublicBetaLane } from './public-beta-lanes';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
  type OpenOpcRestrictedPublicBetaProfileV1,
  computeOpenOpcRestrictedPublicBetaProfileDigest,
  parseOpenOpcRestrictedPublicBetaProfile,
} from './public-beta-release-profile';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
  validateOpenOpcRestrictedPublicBetaLanes,
} from './public-beta-restricted-lanes';

export type PublicBetaGateId =
  | `G${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`
  | `B${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;

export interface PublicBetaEvidenceArtifactV2 {
  path: string;
  digest: `sha256:${string}`;
  sizeBytes: number;
  mediaType: string;
}

export interface PublicBetaEvidenceRecordV2 {
  id: string;
  gate: PublicBetaGateId;
  lane: string;
  attempt: number;
  environment: 'openopc-public-beta-staging';
  commit: string;
  command: string;
  workflow: {
    repository: string;
    workflow: string;
    runId: string;
    runAttempt: number;
  };
  startedAt: string;
  finishedAt: string;
  expiresAt: string;
  outcome: 'passed' | 'failed' | 'blocked';
  stagingUrls: string[];
  dependencyIdentities: string[];
  artifacts: PublicBetaEvidenceArtifactV2[];
  rawEvidencePaths: string[];
  resolvesFailureIds: string[];
  companionEvidenceIds: string[];
}

export interface PublicBetaEvidenceLedgerV2 {
  schemaVersion: 2;
  candidateCommit: string;
  environment: 'openopc-public-beta-staging';
  releaseProfileId: OpenOpcRestrictedPublicBetaProfileV1['id'];
  releaseProfileDigest: `sha256:${string}`;
  schemaDigest: `sha256:${string}`;
  artifactSetDigest: `sha256:${string}`;
  records: PublicBetaEvidenceRecordV2[];
}

export interface ValidatePublicBetaEvidenceOptions {
  now: Date;
  expectedCommit: string;
  verifyArtifact(path: string, digest: string, sizeBytes: number): boolean;
  profile: Readonly<OpenOpcRestrictedPublicBetaProfileV1>;
  lanes: readonly Readonly<PublicBetaLane>[];
  expectedArtifactSetDigest?: `sha256:${string}`;
}

export interface PublicBetaEvidenceCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  cwd: string;
}

const ENVIRONMENT = 'openopc-public-beta-staging' as const;
const HOUR_MS = 60 * 60 * 1_000;
const B7_RESTORE_FRESHNESS_HOURS = 7 * 24;
const B7_SMOKE_FRESHNESS_HOURS = 24;
const MAX_RECORDS = 512;
const MAX_ARRAY_ITEMS = 256;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\+[a-z0-9][a-z0-9!#$&^_.+-]*)?$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_DEPENDENCY = /^(?:fake|fixture|mock|self)(?:[:/@-]|$)/i;
const FAILURE_RESOLUTION_MEDIA_TYPE = 'application/vnd.openopc.failure-resolution+json';

const PRODUCTION_HOSTS = new Set([
  'api.kortix.com',
  'api.openopc.com',
  'admin.openopc.com',
  'app.openopc.com',
  'kortix.com',
  'openopc.com',
  'www.kortix.com',
  'www.openopc.com',
]);

const LEDGER_KEYS = [
  'schemaVersion',
  'candidateCommit',
  'environment',
  'releaseProfileId',
  'releaseProfileDigest',
  'schemaDigest',
  'artifactSetDigest',
  'records',
] as const;
const RECORD_KEYS = [
  'id',
  'gate',
  'lane',
  'attempt',
  'environment',
  'commit',
  'command',
  'workflow',
  'startedAt',
  'finishedAt',
  'expiresAt',
  'outcome',
  'stagingUrls',
  'dependencyIdentities',
  'artifacts',
  'rawEvidencePaths',
  'resolvesFailureIds',
  'companionEvidenceIds',
] as const;
const WORKFLOW_KEYS = ['repository', 'workflow', 'runId', 'runAttempt'] as const;
const ARTIFACT_KEYS = ['path', 'digest', 'sizeBytes', 'mediaType'] as const;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !/[\0\r\n]/.test(value)
  );
}

function uniqueStringArray(
  value: unknown,
  options: { min: number; maxBytes: number; pattern?: RegExp },
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= options.min &&
    value.length <= MAX_ARRAY_ITEMS &&
    value.every(
      (item) =>
        boundedString(item, options.maxBytes) &&
        (options.pattern === undefined || options.pattern.test(item)),
    ) &&
    new Set(value).size === value.length
  );
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) {
    fail('PUBLIC_BETA_EVIDENCE_TIME_INVALID');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail('PUBLIC_BETA_EVIDENCE_TIME_INVALID');
  }
  return parsed;
}

function safeArtifactPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('//') ||
    value.includes('\0')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(segment),
  );
}

function validStagingUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const labels = hostname.replace(/^\[|\]$/g, '').split('.');
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    !PRODUCTION_HOSTS.has(hostname) &&
    !labels.includes('prod') &&
    !labels.includes('production') &&
    hostname !== 'localhost' &&
    hostname !== '0.0.0.0' &&
    hostname !== '::1' &&
    hostname !== '[::1]' &&
    !/^127(?:\.|$)/.test(hostname)
  );
}

function durationHours(record: PublicBetaEvidenceRecordV2): number {
  return (Date.parse(record.expiresAt) - Date.parse(record.finishedAt)) / HOUR_MS;
}

function validateArtifact(
  value: unknown,
  verifyArtifact: ValidatePublicBetaEvidenceOptions['verifyArtifact'],
): PublicBetaEvidenceArtifactV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ARTIFACT_KEYS) ||
    !safeArtifactPath(value.path) ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) < 1 ||
    Number(value.sizeBytes) > MAX_ARTIFACT_BYTES ||
    typeof value.mediaType !== 'string' ||
    !MEDIA_TYPE.test(value.mediaType)
  ) {
    fail('PUBLIC_BETA_EVIDENCE_ARTIFACT_INVALID');
  }
  let verified = false;
  try {
    verified = verifyArtifact(value.path, value.digest, Number(value.sizeBytes));
  } catch {
    verified = false;
  }
  if (!verified) fail('PUBLIC_BETA_EVIDENCE_ARTIFACT_INVALID');
  return value as unknown as PublicBetaEvidenceArtifactV2;
}

function validateRecord(
  value: unknown,
  options: ValidatePublicBetaEvidenceOptions,
): PublicBetaEvidenceRecordV2 {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) {
    fail('PUBLIC_BETA_EVIDENCE_RECORD_INVALID');
  }
  if (value.environment !== ENVIRONMENT) {
    fail('PUBLIC_BETA_EVIDENCE_ENVIRONMENT_INVALID');
  }
  if (
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    typeof value.gate !== 'string' ||
    typeof value.lane !== 'string' ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 1_000 ||
    typeof value.commit !== 'string' ||
    !COMMIT.test(value.commit) ||
    !boundedString(value.command, 4_096) ||
    !isRecord(value.workflow) ||
    !hasExactKeys(value.workflow, WORKFLOW_KEYS) ||
    typeof value.workflow.repository !== 'string' ||
    !REPOSITORY.test(value.workflow.repository) ||
    !boundedString(value.workflow.workflow, 255) ||
    typeof value.workflow.runId !== 'string' ||
    !RUN_ID.test(value.workflow.runId) ||
    !Number.isSafeInteger(value.workflow.runAttempt) ||
    Number(value.workflow.runAttempt) < 1 ||
    Number(value.workflow.runAttempt) > 1_000 ||
    !['passed', 'failed', 'blocked'].includes(String(value.outcome)) ||
    !uniqueStringArray(value.stagingUrls, { min: 0, maxBytes: 2_048 }) ||
    !uniqueStringArray(value.dependencyIdentities, { min: 1, maxBytes: 512 }) ||
    !uniqueStringArray(value.rawEvidencePaths, { min: 1, maxBytes: 1_024 }) ||
    !uniqueStringArray(value.resolvesFailureIds, { min: 0, maxBytes: 255, pattern: ID }) ||
    !uniqueStringArray(value.companionEvidenceIds, { min: 0, maxBytes: 255, pattern: ID }) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > MAX_ARRAY_ITEMS
  ) {
    fail('PUBLIC_BETA_EVIDENCE_RECORD_INVALID');
  }
  if (value.dependencyIdentities.some((identity) => FORBIDDEN_DEPENDENCY.test(identity))) {
    fail('PUBLIC_BETA_EVIDENCE_DEPENDENCY_INVALID');
  }

  const gate = value.gate as PublicBetaGateId;
  const expectedLane = options.lanes.find((entry) => entry.gate === gate);
  if (
    expectedLane === undefined ||
    !(options.profile.requiredGates as readonly PublicBetaGateId[]).includes(gate)
  ) {
    fail('PUBLIC_BETA_EVIDENCE_GATE_NOT_IN_PROFILE');
  }
  if (value.lane !== expectedLane.lane) {
    fail('PUBLIC_BETA_EVIDENCE_LANE_INVALID');
  }
  if (value.outcome === 'passed' && value.commit !== options.expectedCommit) {
    fail('PUBLIC_BETA_EVIDENCE_COMMIT_MISMATCH');
  }
  if (value.stagingUrls.some((url) => !validStagingUrl(url))) {
    fail('PUBLIC_BETA_EVIDENCE_STAGING_URL_INVALID');
  }

  const startedAt = parseTimestamp(value.startedAt);
  const finishedAt = parseTimestamp(value.finishedAt);
  const expiresAt = parseTimestamp(value.expiresAt);
  if (startedAt > finishedAt || finishedAt > options.now.valueOf() || expiresAt <= finishedAt) {
    fail('PUBLIC_BETA_EVIDENCE_TIME_INVALID');
  }

  const record = value as unknown as PublicBetaEvidenceRecordV2;
  const actualDuration = durationHours(record);
  if (gate === 'B7') {
    if (![B7_RESTORE_FRESHNESS_HOURS, B7_SMOKE_FRESHNESS_HOURS].includes(actualDuration)) {
      fail('PUBLIC_BETA_EVIDENCE_EXPIRY_INVALID');
    }
  } else {
    const expectedDuration = expectedLane.maxAgeHours;
    if (actualDuration !== expectedDuration) {
      fail('PUBLIC_BETA_EVIDENCE_EXPIRY_INVALID');
    }
  }

  const artifacts = value.artifacts.map((artifact) => validateArtifact(artifact, options.verifyArtifact));
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  if (
    value.rawEvidencePaths.some(
      (path) => !safeArtifactPath(path) || !artifactPaths.has(path),
    )
  ) {
    fail('PUBLIC_BETA_EVIDENCE_RAW_ARTIFACT_MISSING');
  }
  return record;
}

function validateB7(records: readonly PublicBetaEvidenceRecordV2[], now: number): void {
  const passed = records.filter((record) => record.gate === 'B7' && record.outcome === 'passed');
  if (passed.length === 0) fail('PUBLIC_BETA_EVIDENCE_GATES_INCOMPLETE');

  const restores = passed.filter(
    (record) => durationHours(record) === B7_RESTORE_FRESHNESS_HOURS,
  );
  if (restores.length === 0 || restores.some((record) => record.companionEvidenceIds.length === 0)) {
    fail('PUBLIC_BETA_EVIDENCE_B7_COMPANION_REQUIRED');
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  let hasFreshRestore = false;
  for (const restore of restores) {
    if (Date.parse(restore.expiresAt) < now) continue;
    const validCompanions = restore.companionEvidenceIds.every((id) => {
      const companion = byId.get(id);
      return (
        companion !== undefined &&
        companion.id !== restore.id &&
        companion.gate === 'B7' &&
        companion.lane === restore.lane &&
        companion.outcome === 'passed' &&
        companion.commit === restore.commit &&
        companion.environment === restore.environment &&
        companion.attempt > restore.attempt &&
        Date.parse(companion.finishedAt) >= Date.parse(restore.finishedAt) &&
        durationHours(companion) === B7_SMOKE_FRESHNESS_HOURS &&
        Date.parse(companion.expiresAt) >= now
      );
    });
    if (validCompanions) hasFreshRestore = true;
  }
  if (!hasFreshRestore) {
    const anyFreshRestore = restores.some((record) => Date.parse(record.expiresAt) >= now);
    fail(
      anyFreshRestore
        ? 'PUBLIC_BETA_EVIDENCE_B7_COMPANION_INVALID'
        : 'PUBLIC_BETA_EVIDENCE_STALE',
    );
  }
}

function validateFailureHistory(
  records: readonly PublicBetaEvidenceRecordV2[],
  candidateCommit: string,
): void {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    for (const failureId of record.resolvesFailureIds) {
      const failure = byId.get(failureId);
      if (
        record.outcome !== 'passed' ||
        failure === undefined ||
        (failure.outcome !== 'failed' && failure.outcome !== 'blocked') ||
        failure.gate !== record.gate ||
        failure.commit !== record.commit ||
        failure.attempt >= record.attempt ||
        Date.parse(failure.finishedAt) > Date.parse(record.startedAt) ||
        !record.artifacts.some(
          (artifact) => artifact.mediaType === FAILURE_RESOLUTION_MEDIA_TYPE,
        )
      ) {
        fail('PUBLIC_BETA_EVIDENCE_FAILURE_RESOLUTION_INVALID');
      }
    }
  }

  for (const failure of records) {
    if (
      failure.commit !== candidateCommit ||
      (failure.outcome !== 'failed' && failure.outcome !== 'blocked')
    ) {
      continue;
    }
    const resolved = records.some(
      (record) =>
        record.outcome === 'passed' &&
        record.gate === failure.gate &&
        record.commit === failure.commit &&
        record.attempt > failure.attempt &&
        record.resolvesFailureIds.includes(failure.id),
    );
    if (!resolved) fail('PUBLIC_BETA_EVIDENCE_FAILURE_UNRESOLVED');
  }
}

export function validatePublicBetaEvidenceLedgerV2(
  value: unknown,
  options: ValidatePublicBetaEvidenceOptions,
): PublicBetaEvidenceLedgerV2 {
  if (
    !(options.now instanceof Date) ||
    !Number.isFinite(options.now.valueOf()) ||
    !COMMIT.test(options.expectedCommit) ||
    typeof options.verifyArtifact !== 'function' ||
    !Array.isArray(options.lanes) ||
    (options.expectedArtifactSetDigest !== undefined &&
      !DIGEST.test(options.expectedArtifactSetDigest))
  ) {
    fail('PUBLIC_BETA_EVIDENCE_OPTIONS_INVALID');
  }
  let profile: OpenOpcRestrictedPublicBetaProfileV1;
  try {
    profile = parseOpenOpcRestrictedPublicBetaProfile(options.profile);
    validateOpenOpcRestrictedPublicBetaLanes(options.lanes);
  } catch {
    fail('PUBLIC_BETA_EVIDENCE_OPTIONS_INVALID');
  }
  if (!isRecord(value) || !hasExactKeys(value, LEDGER_KEYS)) {
    fail('PUBLIC_BETA_EVIDENCE_LEDGER_INVALID');
  }
  if (value.environment !== ENVIRONMENT) {
    fail('PUBLIC_BETA_EVIDENCE_ENVIRONMENT_INVALID');
  }
  if (
    value.schemaVersion !== 2 ||
    typeof value.candidateCommit !== 'string' ||
    !COMMIT.test(value.candidateCommit) ||
    typeof value.releaseProfileId !== 'string' ||
    typeof value.releaseProfileDigest !== 'string' ||
    !DIGEST.test(value.releaseProfileDigest) ||
    typeof value.schemaDigest !== 'string' ||
    !DIGEST.test(value.schemaDigest) ||
    typeof value.artifactSetDigest !== 'string' ||
    !DIGEST.test(value.artifactSetDigest) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_RECORDS
  ) {
    fail('PUBLIC_BETA_EVIDENCE_LEDGER_INVALID');
  }
  if (value.candidateCommit !== options.expectedCommit) {
    fail('PUBLIC_BETA_EVIDENCE_COMMIT_MISMATCH');
  }
  if (value.releaseProfileId !== profile.id) {
    fail('PUBLIC_BETA_EVIDENCE_PROFILE_ID_MISMATCH');
  }
  if (value.releaseProfileDigest !== computeOpenOpcRestrictedPublicBetaProfileDigest(profile)) {
    fail('PUBLIC_BETA_EVIDENCE_PROFILE_DIGEST_MISMATCH');
  }
  if (
    options.expectedArtifactSetDigest !== undefined &&
    value.artifactSetDigest !== options.expectedArtifactSetDigest
  ) {
    fail('PUBLIC_BETA_EVIDENCE_ARTIFACT_SET_MISMATCH');
  }

  const validatedOptions: ValidatePublicBetaEvidenceOptions = {
    ...options,
    profile,
    lanes: OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
  };
  const records = value.records.map((record) => validateRecord(record, validatedOptions));
  const ids = new Set<string>();
  const attempts = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) fail('PUBLIC_BETA_EVIDENCE_ID_DUPLICATE');
    ids.add(record.id);
    const attemptKey = `${record.gate}\0${record.attempt}`;
    if (attempts.has(attemptKey)) fail('PUBLIC_BETA_EVIDENCE_ATTEMPT_DUPLICATE');
    attempts.add(attemptKey);
  }

  const gates = new Set(records.map((record) => record.gate));
  if (profile.requiredGates.some((gate) => !gates.has(gate))) {
    fail('PUBLIC_BETA_EVIDENCE_GATES_INCOMPLETE');
  }

  for (const gate of profile.requiredGates) {
    if (gate === 'B7') continue;
    const passed = records.filter((record) => record.gate === gate && record.outcome === 'passed');
    if (passed.length === 0) fail('PUBLIC_BETA_EVIDENCE_GATES_INCOMPLETE');
    if (passed.every((record) => Date.parse(record.expiresAt) < options.now.valueOf())) {
      fail('PUBLIC_BETA_EVIDENCE_STALE');
    }
  }

  const laneByGate = new Map(validatedOptions.lanes.map((entry) => [entry.gate, entry]));
  for (const gate of profile.requiredGates) {
    const lane = laneByGate.get(gate);
    if (lane === undefined) fail('PUBLIC_BETA_EVIDENCE_OPTIONS_INVALID');
    for (const dependency of lane.dependsOn) {
      const hasFreshDependency = records.some(
        (record) =>
          record.gate === dependency &&
          record.outcome === 'passed' &&
          Date.parse(record.expiresAt) >= options.now.valueOf(),
      );
      if (!hasFreshDependency) fail('PUBLIC_BETA_EVIDENCE_GATES_INCOMPLETE');
    }
  }

  validateB7(records, options.now.valueOf());
  validateFailureHistory(records, value.candidateCommit);
  return structuredClone(value) as unknown as PublicBetaEvidenceLedgerV2;
}

function cliArgument(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function validCliArguments(args: string[]): boolean {
  const allowed = new Set(['--ledger', '--commit', '--now']);
  if (args.length !== 6) return false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.has(flag) || value === undefined) return false;
  }
  return new Set(args.filter((_, index) => index % 2 === 0)).size === allowed.size;
}

function resolveTrustedInputFile(cwd: string, value: string): string | null {
  if (!safeArtifactPath(value)) return null;
  try {
    const root = realpathSync.native(resolve(cwd));
    let cursor = root;
    for (const segment of value.split('/')) {
      cursor = resolve(cursor, segment);
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink()) return null;
    }
    const metadata = lstatSync(cursor);
    if (!metadata.isFile()) return null;
    const realFile = realpathSync.native(cursor);
    const relativePath = relative(root, realFile);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return null;
    }
    return realFile;
  } catch {
    return null;
  }
}

export async function runPublicBetaEvidenceCli(
  args: string[],
  io: PublicBetaEvidenceCliIo,
): Promise<number> {
  const emitFailure = (code: string, exit: number) => {
    io.stdout(JSON.stringify({ valid: false, error: code }));
    io.stderr(code);
    return exit;
  };
  if (!validCliArguments(args)) {
    return emitFailure('PUBLIC_BETA_EVIDENCE_USAGE_INVALID', 64);
  }

  const ledgerPath = cliArgument(args, '--ledger');
  const expectedCommit = cliArgument(args, '--commit');
  const nowValue = cliArgument(args, '--now');
  if (ledgerPath === null || expectedCommit === null || nowValue === null) {
    return emitFailure('PUBLIC_BETA_EVIDENCE_USAGE_INVALID', 64);
  }
  const now = new Date(nowValue);
  if (!safeArtifactPath(ledgerPath) || !COMMIT.test(expectedCommit) || !RFC3339_UTC.test(nowValue)) {
    return emitFailure('PUBLIC_BETA_EVIDENCE_USAGE_INVALID', 64);
  }

  const ledgerAbsolute = resolveTrustedInputFile(io.cwd, ledgerPath);
  if (!ledgerAbsolute) {
    return emitFailure('PUBLIC_BETA_EVIDENCE_INPUT_INVALID', 65);
  }

  try {
    const value = JSON.parse(readFileSync(ledgerAbsolute, 'utf8')) as unknown;
    const ledger = validatePublicBetaEvidenceLedgerV2(value, {
      now,
      expectedCommit,
      profile: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
      lanes: OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
      verifyArtifact(path, digest, sizeBytes) {
        try {
          const absolute = resolveTrustedInputFile(io.cwd, path);
          if (!absolute) return false;
          const metadata = lstatSync(absolute);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== sizeBytes) {
            return false;
          }
          const actual = `sha256:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
          return actual === digest;
        } catch {
          return false;
        }
      },
    });
    io.stdout(
      JSON.stringify({
        valid: true,
        candidateCommit: ledger.candidateCommit,
        environment: ledger.environment,
        records: ledger.records.length,
      }),
    );
    return 0;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PUBLIC_BETA_EVIDENCE_INVALID';
    return emitFailure(code, 65);
  }
}

if (import.meta.main) {
  const exit = await runPublicBetaEvidenceCli(process.argv.slice(2), {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
    cwd: process.cwd(),
  });
  process.exit(exit);
}
