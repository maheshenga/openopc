import type { PublicBetaSha256Digest } from './public-beta-canonical-json';

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const POSITIVE_INTEGER_TEXT = /^[1-9][0-9]*$/;
const MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_PROPERTIES = 4_096;

const SOURCE_WORKFLOW = '.github/workflows/openopc-public-beta-gates.yml' as const;
const SOURCE_WORKFLOW_NAME = 'OpenOPC Public Beta Gates';
const SOURCE_ARTIFACT = 'openopc-public-beta-source-candidate';
const BUILDER_WORKFLOW = '.github/workflows/openopc-cosign-builder.yml' as const;
const BUILDER_WORKFLOW_NAME = 'OpenOPC Cosign Builder';
const BUILDER_ARTIFACT = 'openopc-cosign-toolchain-v3.1.2.1';
const CERTIFIER_WORKFLOW = '.github/workflows/openopc-public-beta-certify.yml' as const;
const CERTIFIER_WORKFLOW_NAME = 'OpenOPC Public Beta Certify';
const CERTIFIER_ARTIFACT = 'openopc-public-beta-certified-candidate';
const MAIN_WORKFLOW_REF = 'refs/heads/main' as const;

export interface PublicBetaGitHubActionsClient {
  getWorkflowRun(runId: string): Promise<unknown>;
  listWorkflowRunArtifacts(runId: string): Promise<readonly unknown[]>;
  downloadArtifactArchive(artifactId: string, destinationPath: string): Promise<void>;
  getRepositoryFile(path: string, ref: string): Promise<Uint8Array>;
}

export interface PublicBetaAuthenticatedSourceRun {
  repository: string;
  workflow: typeof SOURCE_WORKFLOW;
  runId: string;
  runAttempt: number;
  headSha: string;
  artifactId: string;
  artifactDigest: PublicBetaSha256Digest;
  artifactSizeBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface PublicBetaAuthenticatedToolBuilderRun {
  repository: 'openopc/platform';
  workflow: typeof BUILDER_WORKFLOW;
  workflowRef: typeof MAIN_WORKFLOW_REF;
  controlSha: string;
  runId: string;
  runAttempt: number;
  event: 'workflow_dispatch';
  artifactId: string;
  artifactDigest: PublicBetaSha256Digest;
  artifactSizeBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface PublicBetaAuthenticatedCertifierRun {
  repository: string;
  workflow: typeof CERTIFIER_WORKFLOW;
  workflowRef: typeof MAIN_WORKFLOW_REF;
  controlSha: string;
  runId: string;
  runAttempt: number;
  event: 'workflow_run';
  artifactId: string;
  artifactDigest: PublicBetaSha256Digest;
  artifactSizeBytes: number;
  startedAt: string;
  finishedAt: string;
}

type Json = null | boolean | number | string | readonly Json[] | Readonly<Record<string, Json>>;
type JsonRecord = Readonly<Record<string, Json>>;

interface RunSnapshot {
  id: number;
  repository: string;
  repositoryId: number;
  headRepository: string;
  headRepositoryId: number;
  path: string;
  name: string;
  event: string;
  displayTitle: string | null;
  headBranch: string | null;
  headSha: string;
  runAttempt: number;
  startedAt: string;
  finishedAt: string;
}

interface ArtifactSnapshot {
  id: number;
  sizeBytes: number;
  digest: PublicBetaSha256Digest;
}

export async function authenticatePublicBetaSourceRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: string;
  expectedCommit: string;
  runId: string;
  now: Date;
}): Promise<Readonly<PublicBetaAuthenticatedSourceRun> | false> {
  const request = snapshotSourceRequest(input);
  if (!request) return false;

  const run = await readRun(request.client, request.runId);
  if (
    !run ||
    !matchesRun(run, request, {
      workflow: SOURCE_WORKFLOW,
      workflowName: SOURCE_WORKFLOW_NAME,
      event: 'workflow_dispatch',
      headBranch: 'staging',
      expectedSha: request.expectedCommit,
    })
  ) {
    return false;
  }

  const artifact = await findArtifact(request.client, request.runId, SOURCE_ARTIFACT, run, request.now);
  if (!artifact) return false;
  return Object.freeze({
    repository: request.expectedRepository,
    workflow: SOURCE_WORKFLOW,
    runId: request.runId,
    runAttempt: run.runAttempt,
    headSha: run.headSha,
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}

export async function authenticatePublicBetaToolBuilderRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: 'openopc/platform';
  expectedControlSha: string;
  runId: string;
  now: Date;
}): Promise<Readonly<PublicBetaAuthenticatedToolBuilderRun> | false> {
  const request = snapshotBuilderRequest(input);
  if (!request) return false;

  const run = await readRun(request.client, request.runId);
  if (
    !run ||
    !matchesRun(run, request, {
      workflow: BUILDER_WORKFLOW,
      workflowName: BUILDER_WORKFLOW_NAME,
      event: 'workflow_dispatch',
      headBranch: 'main',
      expectedSha: request.expectedControlSha,
    })
  ) {
    return false;
  }

  const artifact = await findArtifact(request.client, request.runId, BUILDER_ARTIFACT, run, request.now);
  if (!artifact) return false;
  return Object.freeze({
    repository: 'openopc/platform',
    workflow: BUILDER_WORKFLOW,
    workflowRef: MAIN_WORKFLOW_REF,
    controlSha: run.headSha,
    runId: request.runId,
    runAttempt: run.runAttempt,
    event: 'workflow_dispatch',
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}

export async function authenticatePublicBetaCertifierRun(input: {
  client: PublicBetaGitHubActionsClient;
  expectedRepository: string;
  expectedCommit: string;
  expectedControlSha: string;
  runId: string;
  now: Date;
}): Promise<Readonly<PublicBetaAuthenticatedCertifierRun> | false> {
  const request = snapshotCertifierRequest(input);
  if (!request) return false;

  const run = await readRun(request.client, request.runId);
  if (
    !run ||
    !matchesRun(run, request, {
      workflow: CERTIFIER_WORKFLOW,
      workflowName: CERTIFIER_WORKFLOW_NAME,
      event: 'workflow_run',
      headBranch: 'main',
      expectedSha: request.expectedControlSha,
    }) ||
    run.displayTitle !== `OpenOPC Public Beta Certify ${request.expectedCommit}`
  ) {
    return false;
  }

  const artifact = await findArtifact(request.client, request.runId, CERTIFIER_ARTIFACT, run, request.now);
  if (!artifact) return false;
  return Object.freeze({
    repository: request.expectedRepository,
    workflow: CERTIFIER_WORKFLOW,
    workflowRef: MAIN_WORKFLOW_REF,
    controlSha: request.expectedControlSha,
    runId: request.runId,
    runAttempt: run.runAttempt,
    event: 'workflow_run',
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}

function snapshotSourceRequest(input: unknown):
  | { client: PublicBetaGitHubActionsClient; expectedRepository: string; expectedCommit: string; runId: string; now: number }
  | false {
  const request = snapshotRequest(input, ['expectedRepository', 'expectedCommit']);
  return request && commitSha(request.expectedCommit)
    ? { ...request, expectedCommit: request.expectedCommit }
    : false;
}

function snapshotBuilderRequest(input: unknown):
  | { client: PublicBetaGitHubActionsClient; expectedRepository: 'openopc/platform'; expectedControlSha: string; runId: string; now: number }
  | false {
  const request = snapshotRequest(input, ['expectedRepository', 'expectedControlSha']);
  return request && request.expectedRepository === 'openopc/platform' && commitSha(request.expectedControlSha)
    ? { ...request, expectedRepository: 'openopc/platform', expectedControlSha: request.expectedControlSha }
    : false;
}

function snapshotCertifierRequest(input: unknown):
  | { client: PublicBetaGitHubActionsClient; expectedRepository: string; expectedCommit: string; expectedControlSha: string; runId: string; now: number }
  | false {
  const request = snapshotRequest(input, ['expectedRepository', 'expectedCommit', 'expectedControlSha']);
  return request && commitSha(request.expectedCommit) && commitSha(request.expectedControlSha)
    ? { ...request, expectedCommit: request.expectedCommit, expectedControlSha: request.expectedControlSha }
    : false;
}

function snapshotRequest(
  input: unknown,
  expectedKeys: readonly string[],
): { client: PublicBetaGitHubActionsClient; expectedRepository: string; runId: string; now: number; [key: string]: unknown } | false {
  try {
    if (typeof input !== 'object' || input === null) return false;
    const candidate = input as Record<string, unknown>;
    const client = candidate.client;
    const expectedRepository = candidate.expectedRepository;
    const runId = candidate.runId;
    const now = candidate.now;
    const expected = expectedKeys.map((key) => candidate[key]);
    const nowMs = Date.prototype.getTime.call(now);
    if (
      !validClient(client) ||
      !repositoryName(expectedRepository) ||
      !positiveIntegerText(runId) ||
      !Number.isFinite(nowMs) ||
      expected.some((value) => typeof value !== 'string')
    ) {
      return false;
    }
    return Object.assign({ client, expectedRepository, runId, now: nowMs }, Object.fromEntries(expectedKeys.map((key, index) => [key, expected[index]])));
  } catch {
    return false;
  }
}

function validClient(value: unknown): value is PublicBetaGitHubActionsClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PublicBetaGitHubActionsClient).getWorkflowRun === 'function' &&
    typeof (value as PublicBetaGitHubActionsClient).listWorkflowRunArtifacts === 'function'
  );
}

function repositoryName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function commitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function positiveIntegerText(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_INTEGER_TEXT.test(value) && Number.isSafeInteger(Number(value));
}

async function readRun(client: PublicBetaGitHubActionsClient, runId: string): Promise<RunSnapshot | false> {
  try {
    return parseRun(await client.getWorkflowRun(runId));
  } catch {
    return false;
  }
}

function parseRun(value: unknown): RunSnapshot | false {
  const run = snapshotJsonRecord(value);
  if (!run) return false;
  const repository = repositorySnapshot(run.repository);
  const headRepository = repositorySnapshot(run.head_repository);
  const id = positiveInteger(run.id);
  const runAttempt = positiveInteger(run.run_attempt);
  const startedAt = timestamp(run.run_started_at);
  const finishedAt = timestamp(run.updated_at);
  if (
    !repository ||
    !headRepository ||
    !id ||
    !runAttempt ||
    typeof run.path !== 'string' ||
    typeof run.name !== 'string' ||
    typeof run.event !== 'string' ||
    (typeof run.display_title !== 'string' && run.display_title !== undefined) ||
    (typeof run.head_branch !== 'string' && run.head_branch !== null) ||
    !commitSha(run.head_sha) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !startedAt ||
    !finishedAt ||
    startedAt.milliseconds > finishedAt.milliseconds
  ) {
    return false;
  }
  return Object.freeze({
    id,
    repository: repository.name,
    repositoryId: repository.id,
    headRepository: headRepository.name,
    headRepositoryId: headRepository.id,
    path: run.path,
    name: run.name,
    event: run.event,
    displayTitle: typeof run.display_title === 'string' ? run.display_title : null,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    runAttempt,
    startedAt: startedAt.value,
    finishedAt: finishedAt.value,
  });
}

function repositorySnapshot(value: Json | undefined): { name: string; id: number } | false {
  const repository = snapshotJsonRecord(value);
  const id = repository && positiveInteger(repository.id);
  return repository && repositoryName(repository.full_name) && id
    ? Object.freeze({ name: repository.full_name, id })
    : false;
}

function matchesRun(
  run: RunSnapshot,
  request: { expectedRepository: string; runId: string; [key: string]: unknown },
  expected: { workflow: string; workflowName: string; event: string; headBranch: string | null; expectedSha: string },
): boolean {
  return (
    String(run.id) === request.runId &&
    sameRepository(run.repository, request.expectedRepository) &&
    sameRepository(run.headRepository, request.expectedRepository) &&
    run.path === expected.workflow &&
    run.name === expected.workflowName &&
    run.event === expected.event &&
    run.headBranch === expected.headBranch &&
    run.headSha === expected.expectedSha
  );
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function findArtifact(
  client: PublicBetaGitHubActionsClient,
  runId: string,
  expectedName: string,
  run: RunSnapshot,
  now: number,
): Promise<ArtifactSnapshot | false> {
  try {
    const artifacts = await client.listWorkflowRunArtifacts(runId);
    const snapshot = snapshotJsonArray(artifacts);
    if (!snapshot) return false;
    const matches = snapshot.filter(
      (artifact) => snapshotJsonRecord(artifact)?.name === expectedName,
    );
    if (matches.length !== 1) return false;
    return parseArtifact(matches[0], run, now);
  } catch {
    return false;
  }
}

function parseArtifact(value: Json, run: RunSnapshot, now: number): ArtifactSnapshot | false {
  const artifact = snapshotJsonRecord(value);
  const workflowRun = artifact && snapshotJsonRecord(artifact.workflow_run);
  const id = artifact && positiveInteger(artifact.id);
  const sizeBytes = artifact && positiveInteger(artifact.size_in_bytes);
  const expiresAt = artifact && timestamp(artifact.expires_at);
  if (
    !artifact ||
    !workflowRun ||
    !id ||
    !sizeBytes ||
    sizeBytes > MAX_ARTIFACT_SIZE_BYTES ||
    typeof artifact.digest !== 'string' ||
    !SHA256_DIGEST.test(artifact.digest) ||
    artifact.expired !== false ||
    !expiresAt ||
    expiresAt.milliseconds <= now ||
    workflowRun.id !== run.id ||
    workflowRun.head_sha !== run.headSha ||
    workflowRun.repository_id !== run.repositoryId ||
    workflowRun.head_repository_id !== run.headRepositoryId
  ) {
    return false;
  }
  return Object.freeze({ id, sizeBytes, digest: artifact.digest as PublicBetaSha256Digest });
}

function timestamp(value: unknown): { value: string; milliseconds: number } | false {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Object.freeze({ value, milliseconds }) : false;
}

function positiveInteger(value: unknown): number | false {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : false;
}

function snapshotJsonRecord(value: unknown): JsonRecord | false {
  const snapshot = snapshotJson(value);
  return snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object' ? snapshot : false;
}

function snapshotJsonArray(value: unknown): readonly Json[] | false {
  const snapshot = snapshotJson(value);
  return Array.isArray(snapshot) ? snapshot : false;
}

function snapshotJson(value: unknown, depth = 0, active = new Set<object>()): Json | false {
  try {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : false;
    if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH || active.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if ((Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) return false;
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_JSON_PROPERTIES) return false;
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (names.length !== value.length + 1 || names.some((name) => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(name))) return false;
        const clone: Json[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
          const item = snapshotJson(descriptor.value, depth + 1, active);
          if (item === false && descriptor.value !== false) return false;
          clone.push(item);
        }
        return Object.freeze(clone);
      }
      const clone: Record<string, Json> = {};
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
        const item = snapshotJson(descriptor.value, depth + 1, active);
        if (item === false && descriptor.value !== false) return false;
        Object.defineProperty(clone, name, { value: item, enumerable: true, writable: false, configurable: false });
      }
      return Object.freeze(clone);
    } finally {
      active.delete(value);
    }
  } catch {
    return false;
  }
}
