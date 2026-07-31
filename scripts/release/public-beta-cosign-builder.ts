import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  type PublicBetaSha256Digest,
  canonicalPublicBetaJson,
  computeCanonicalPublicBetaDigest,
} from './public-beta-canonical-json';
import {
  type PublicBetaCosignBuilderLockV1,
  type PublicBetaCosignPlatform,
  type PublicBetaCosignSlsaPredicateV1,
  type PublicBetaCosignToolSubjectV1,
  canonicalPublicBetaCosignBuilderIdentity,
  parsePublicBetaCosignBuilderLock,
  parsePublicBetaCosignSlsaPredicate,
} from './public-beta-cosign-toolchain';

export interface PublicBetaBuilderCommand {
  executable: 'git' | 'docker';
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PublicBetaCosignBuildInput {
  lock: Readonly<PublicBetaCosignBuilderLockV1>;
  platform: PublicBetaCosignPlatform;
  sourceRoot: string;
  moduleCacheRoot: string;
  outputRoot: string;
}

export interface PublicBetaCosignBuildPlan {
  verifySource: readonly PublicBetaBuilderCommand[];
  fetch: PublicBetaBuilderCommand;
  build: PublicBetaBuilderCommand;
  inspect: PublicBetaBuilderCommand;
}

export interface PublicBetaCosignBuildResultV1 {
  platform: PublicBetaCosignPlatform;
  name: PublicBetaCosignToolSubjectV1['name'];
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  buildContractDigest: PublicBetaSha256Digest;
  goModuleGraphDigest: PublicBetaSha256Digest;
  startedAt: string;
  finishedAt: string;
}

export interface PublicBetaCosignComparedBuildV1 extends PublicBetaCosignBuildResultV1 {
  primaryDigest: PublicBetaSha256Digest;
  replayDigest: PublicBetaSha256Digest;
}

export interface PublicBetaBuilderProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type PublicBetaBuilderProcessRunner = (
  command: Readonly<PublicBetaBuilderCommand>,
) => Promise<Readonly<PublicBetaBuilderProcessResult>>;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const INTEGER = /^[1-9][0-9]*$/;
const MAX_SUBJECT_BYTES = 268_435_456;
const MAX_PATH_BYTES = 4_096;
const MAX_CLI_INPUT_BYTES = 1_048_576;
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const INSPECT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1_024;
const PROCESS_OUTPUT_BYTES = 1024 * 1_024;
const BUILD_CONTRACT_VERSION = 1;

type RecordValue = Record<string, unknown>;

interface PlanMetadata {
  platform: PublicBetaCosignPlatform;
  name: PublicBetaCosignToolSubjectV1['name'];
  commitSha: string;
  treeSha: string;
  buildContractDigest: PublicBetaSha256Digest;
}

const planMetadata = new WeakMap<object, Readonly<PlanMetadata>>();

function exactRecord(value: unknown, keys: readonly string[]): RecordValue | false {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return false;
  }
  const snapshot: RecordValue = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function validDigest(value: unknown): value is PublicBetaSha256Digest {
  return typeof value === 'string' && SHA256.test(value) && value !== `sha256:${'0'.repeat(64)}`;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validCommitTimestamp(value: string): boolean {
  if (value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function normalizedRoot(value: unknown): string | false {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes(String.fromCharCode(0)) ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.includes(',')
  ) {
    return false;
  }
  return resolve(value);
}

function rootsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return (
    fromLeft === '' ||
    (!fromLeft.startsWith('..') && !isAbsolute(fromLeft)) ||
    (!fromRight.startsWith('..') && !isAbsolute(fromRight))
  );
}

function command(
  executable: PublicBetaBuilderCommand['executable'],
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Readonly<PublicBetaBuilderCommand> {
  return Object.freeze({
    executable,
    args: Object.freeze([...args]),
    cwd,
    timeoutMs,
    maxOutputBytes,
  });
}

function dockerSecurityArguments(network: 'bridge' | 'none'): readonly string[] {
  return [
    '--rm',
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=67108864',
  ];
}

function target(platform: PublicBetaCosignPlatform): Readonly<{
  goos: 'linux' | 'windows';
  name: PublicBetaCosignToolSubjectV1['name'];
}> {
  return platform === 'linuxAmd64'
    ? Object.freeze({ goos: 'linux', name: 'cosign-linux-amd64' })
    : Object.freeze({ goos: 'windows', name: 'cosign-windows-amd64.exe' });
}

export function createPublicBetaCosignBuildPlan(
  input: Readonly<PublicBetaCosignBuildInput>,
): Readonly<PublicBetaCosignBuildPlan> {
  const record = exactRecord(input, ['lock', 'moduleCacheRoot', 'outputRoot', 'platform', 'sourceRoot']);
  const lock = record && parsePublicBetaCosignBuilderLock(record.lock);
  const sourceRoot = record && normalizedRoot(record.sourceRoot);
  const moduleCacheRoot = record && normalizedRoot(record.moduleCacheRoot);
  const outputRoot = record && normalizedRoot(record.outputRoot);
  if (
    !record ||
    !lock ||
    (record.platform !== 'linuxAmd64' && record.platform !== 'windowsAmd64') ||
    !sourceRoot ||
    !moduleCacheRoot ||
    !outputRoot ||
    rootsOverlap(sourceRoot, moduleCacheRoot) ||
    rootsOverlap(sourceRoot, outputRoot) ||
    rootsOverlap(moduleCacheRoot, outputRoot)
  ) {
    throw new Error('OPENOPC_COSIGN_BUILD_INPUT_INVALID');
  }

  const platform = record.platform;
  const selected = target(platform);
  const image = `${lock.buildImage.reference}@${lock.buildImage.digest}`;
  const sourceMount = `type=bind,source=${sourceRoot},target=/src,readonly`;
  const moduleCacheWriteMount = `type=bind,source=${moduleCacheRoot},target=/gomodcache`;
  const moduleCacheReadMount = `type=bind,source=${moduleCacheRoot},target=/gomodcache,readonly`;
  const outputMount = `type=bind,source=${outputRoot},target=/out`;
  const outputReadMount = `type=bind,source=${outputRoot},target=/out,readonly`;

  const verifySource = Object.freeze([
    command('git', ['rev-parse', '--verify', 'HEAD'], sourceRoot, GIT_TIMEOUT_MS, GIT_OUTPUT_BYTES),
    command(
      'git',
      ['rev-parse', '--verify', 'HEAD^{tree}'],
      sourceRoot,
      GIT_TIMEOUT_MS,
      GIT_OUTPUT_BYTES,
    ),
    command(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      sourceRoot,
      GIT_TIMEOUT_MS,
      GIT_OUTPUT_BYTES,
    ),
    command(
      'git',
      ['diff', '--exit-code', '--', 'go.mod', 'go.sum'],
      sourceRoot,
      GIT_TIMEOUT_MS,
      GIT_OUTPUT_BYTES,
    ),
    command(
      'git',
      ['diff', '--cached', '--exit-code', '--', 'go.mod', 'go.sum'],
      sourceRoot,
      GIT_TIMEOUT_MS,
      GIT_OUTPUT_BYTES,
    ),
    command(
      'git',
      ['show', '-s', '--format=%cI', lock.upstream.commitSha],
      sourceRoot,
      GIT_TIMEOUT_MS,
      GIT_OUTPUT_BYTES,
    ),
  ]);

  const fetchScript = [
    'umask 022',
    'go mod verify >&2',
    'go mod download',
    'go mod verify >&2',
    'module_graph="$(go list -mod=readonly -m all | sha256sum)"',
    'printf "sha256:%s\\n" "${module_graph%% *}"',
  ].join('\n');
  const fetch = command(
    'docker',
    [
      'run',
      '--pull=always',
      ...dockerSecurityArguments('bridge'),
      '--mount',
      sourceMount,
      '--mount',
      moduleCacheWriteMount,
      '--env',
      'GOMODCACHE=/gomodcache',
      '--env',
      'GOFLAGS=-mod=readonly',
      '--env',
      'GOTOOLCHAIN=local',
      '--env',
      'HOME=/tmp',
      '--workdir',
      '/src',
      image,
      '/bin/sh',
      '-eu',
      '-c',
      fetchScript,
    ],
    sourceRoot,
    FETCH_TIMEOUT_MS,
    PROCESS_OUTPUT_BYTES,
  );

  const buildScript = [
    'umask 022',
    'entry_count="$(find /out -mindepth 1 -maxdepth 1 -printf x | wc -c)"',
    '[ "$entry_count" -eq 0 ]',
    `SOURCE_DATE_EPOCH="$(git -c safe.directory=/src show -s --format=%ct ${lock.upstream.commitSha})"`,
    'case "$SOURCE_DATE_EPOCH" in ""|*[!0-9]*) exit 70;; esac',
    'BUILD_DATE="$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"',
    'case "$BUILD_DATE" in ????-??-??T??:??:??Z) ;; *) exit 71;; esac',
    'export SOURCE_DATE_EPOCH',
    `LDFLAGS="-buildid= -X sigs.k8s.io/release-utils/version.gitVersion=${lock.upstream.tag} -X sigs.k8s.io/release-utils/version.gitCommit=${lock.upstream.commitSha} -X sigs.k8s.io/release-utils/version.gitTreeState=clean -X sigs.k8s.io/release-utils/version.buildDate=$BUILD_DATE"`,
    `exec "$@" "-ldflags=$LDFLAGS" -o /out/${selected.name} ./cmd/cosign`,
  ].join('\n');
  const build = command(
    'docker',
    [
      'run',
      '--pull=never',
      ...dockerSecurityArguments('none'),
      '--tmpfs',
      '/gocache:rw,noexec,nosuid,size=536870912',
      '--mount',
      sourceMount,
      '--mount',
      moduleCacheReadMount,
      '--mount',
      outputMount,
      '--env',
      'CGO_ENABLED=0',
      '--env',
      `GOOS=${selected.goos}`,
      '--env',
      'GOARCH=amd64',
      '--env',
      'GOMODCACHE=/gomodcache',
      '--env',
      'GOCACHE=/gocache',
      '--env',
      'GOFLAGS=-mod=readonly',
      '--env',
      'GOTOOLCHAIN=local',
      '--env',
      'HOME=/tmp',
      '--env',
      'TZ=UTC',
      '--env',
      'LANG=C.UTF-8',
      '--env',
      'LC_ALL=C.UTF-8',
      '--workdir',
      '/src',
      image,
      '/bin/sh',
      '-eu',
      '-c',
      buildScript,
      'openopc-cosign-build',
      'go',
      'build',
      '-trimpath',
      '-mod=readonly',
      '-buildvcs=false',
    ],
    sourceRoot,
    BUILD_TIMEOUT_MS,
    PROCESS_OUTPUT_BYTES,
  );

  const inspectScript = [
    'set -eu',
    'entry_count="$(find /out -mindepth 1 -maxdepth 1 -printf x | wc -c)"',
    '[ "$entry_count" -eq 1 ]',
    `[ -f /out/${selected.name} ]`,
    `[ ! -L /out/${selected.name} ]`,
    `artifact_digest="$(sha256sum /out/${selected.name})"`,
    `artifact_size="$(wc -c < /out/${selected.name})"`,
    `printf "sha256:%s\\n%s\\n%s\\n" "\${artifact_digest%% *}" "$artifact_size" "${selected.name}"`,
  ].join('\n');
  const inspect = command(
    'docker',
    [
      'run',
      '--pull=never',
      ...dockerSecurityArguments('none'),
      '--mount',
      outputReadMount,
      image,
      '/bin/sh',
      '-eu',
      '-c',
      inspectScript,
    ],
    outputRoot,
    INSPECT_TIMEOUT_MS,
    GIT_OUTPUT_BYTES,
  );

  const plan = Object.freeze({ verifySource, fetch, build, inspect });
  planMetadata.set(
    plan,
    Object.freeze({
      platform,
      name: selected.name,
      commitSha: lock.upstream.commitSha,
      treeSha: lock.upstream.treeSha,
      buildContractDigest: computeCanonicalPublicBetaDigest({
        schemaVersion: BUILD_CONTRACT_VERSION,
        lock,
        target: { platform, goos: selected.goos, goarch: 'amd64', name: selected.name },
        environment: {
          CGO_ENABLED: '0',
          GOARCH: 'amd64',
          GOOS: selected.goos,
          GOFLAGS: '-mod=readonly',
          GOTOOLCHAIN: 'local',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TZ: 'UTC',
        },
        goBuild: {
          package: './cmd/cosign',
          flags: ['-trimpath', '-mod=readonly', '-buildvcs=false'],
          ldflags: {
            buildId: '',
            buildDateCommit: lock.upstream.commitSha,
            gitCommit: lock.upstream.commitSha,
            gitTreeState: 'clean',
            gitVersion: lock.upstream.tag,
          },
          sourceDateCommit: lock.upstream.commitSha,
        },
        network: { fetch: 'bridge', build: 'none', inspect: 'none' },
      }),
    }),
  );
  return plan;
}

function outputBytes(result: Readonly<PublicBetaBuilderProcessResult>): number {
  return Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8');
}

function validProcessResult(
  value: unknown,
  commandValue: Readonly<PublicBetaBuilderCommand>,
): value is Readonly<PublicBetaBuilderProcessResult> {
  const record = exactRecord(value, ['exitCode', 'stderr', 'stdout', 'timedOut']);
  return Boolean(
    record &&
      record.exitCode === 0 &&
      record.timedOut === false &&
      typeof record.stdout === 'string' &&
      typeof record.stderr === 'string' &&
      outputBytes(record as unknown as PublicBetaBuilderProcessResult) <= commandValue.maxOutputBytes,
  );
}

function oneOutputLine(stdout: string): string | false {
  if (!stdout.endsWith('\n') || stdout.includes('\r')) return false;
  const value = stdout.slice(0, -1);
  return value && !value.includes('\n') ? value : false;
}

function parseInspectionOutput(
  stdout: string,
  expectedName: PublicBetaCosignToolSubjectV1['name'],
): Readonly<{ digest: PublicBetaSha256Digest; sizeBytes: number }> | false {
  if (!stdout.endsWith('\n') || stdout.includes('\r')) return false;
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length !== 3 || !validDigest(lines[0]) || !INTEGER.test(lines[1] ?? '')) return false;
  const sizeBytes = Number(lines[1]);
  if (
    lines[2] !== expectedName ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_SUBJECT_BYTES
  ) {
    return false;
  }
  return Object.freeze({ digest: lines[0], sizeBytes });
}

export async function executePublicBetaCosignBuildPlan(
  plan: Readonly<PublicBetaCosignBuildPlan>,
  runner: PublicBetaBuilderProcessRunner,
  now: () => Date = () => new Date(),
): Promise<Readonly<PublicBetaCosignBuildResultV1> | false> {
  const metadata = planMetadata.get(plan);
  if (!metadata || typeof runner !== 'function' || typeof now !== 'function') return false;
  try {
    const startedAt = now().toISOString();
    if (!validTimestamp(startedAt)) return false;
    for (const sourceCommand of plan.verifySource) {
      const result = await runner(sourceCommand);
      if (!validProcessResult(result, sourceCommand)) return false;
      const args = sourceCommand.args;
      if (args[0] === 'rev-parse' && args[2] === 'HEAD') {
        if (oneOutputLine(result.stdout) !== metadata.commitSha) return false;
      } else if (args[0] === 'rev-parse' && args[2] === 'HEAD^{tree}') {
        if (oneOutputLine(result.stdout) !== metadata.treeSha) return false;
      } else if (args[0] === 'status') {
        if (result.stdout !== '') return false;
      } else if (args[0] === 'show') {
        const commitTimestamp = oneOutputLine(result.stdout);
        if (!commitTimestamp || !validCommitTimestamp(commitTimestamp)) return false;
      }
    }

    const fetchResult = await runner(plan.fetch);
    if (!validProcessResult(fetchResult, plan.fetch)) return false;
    const goModuleGraphDigest = oneOutputLine(fetchResult.stdout);
    if (!validDigest(goModuleGraphDigest)) return false;

    const buildResult = await runner(plan.build);
    if (!validProcessResult(buildResult, plan.build)) return false;

    const inspectResult = await runner(plan.inspect);
    if (!validProcessResult(inspectResult, plan.inspect)) return false;
    const inspected = parseInspectionOutput(inspectResult.stdout, metadata.name);
    if (!inspected) return false;

    const finishedAt = now().toISOString();
    if (!validTimestamp(finishedAt) || Date.parse(startedAt) > Date.parse(finishedAt)) return false;
    return Object.freeze({
      platform: metadata.platform,
      name: metadata.name,
      digest: inspected.digest,
      sizeBytes: inspected.sizeBytes,
      buildContractDigest: metadata.buildContractDigest,
      goModuleGraphDigest,
      startedAt,
      finishedAt,
    });
  } catch {
    return false;
  }
}

function parseBuildResult(value: unknown): Readonly<PublicBetaCosignBuildResultV1> | false {
  const record = exactRecord(value, [
    'buildContractDigest',
    'digest',
    'finishedAt',
    'goModuleGraphDigest',
    'name',
    'platform',
    'sizeBytes',
    'startedAt',
  ]);
  if (
    !record ||
    (record.platform !== 'linuxAmd64' && record.platform !== 'windowsAmd64') ||
    record.name !== (record.platform === 'linuxAmd64' ? 'cosign-linux-amd64' : 'cosign-windows-amd64.exe') ||
    !validDigest(record.digest) ||
    !validDigest(record.buildContractDigest) ||
    !validDigest(record.goModuleGraphDigest) ||
    !Number.isSafeInteger(record.sizeBytes) ||
    (record.sizeBytes as number) < 1 ||
    (record.sizeBytes as number) > MAX_SUBJECT_BYTES ||
    !validTimestamp(record.startedAt) ||
    !validTimestamp(record.finishedAt) ||
    Date.parse(record.startedAt) > Date.parse(record.finishedAt)
  ) {
    return false;
  }
  return Object.freeze({
    platform: record.platform,
    name: record.name,
    digest: record.digest,
    sizeBytes: record.sizeBytes as number,
    buildContractDigest: record.buildContractDigest,
    goModuleGraphDigest: record.goModuleGraphDigest,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  });
}

function parseComparedBuild(value: unknown): Readonly<PublicBetaCosignComparedBuildV1> | false {
  const record = exactRecord(value, [
    'buildContractDigest',
    'digest',
    'finishedAt',
    'goModuleGraphDigest',
    'name',
    'platform',
    'primaryDigest',
    'replayDigest',
    'sizeBytes',
    'startedAt',
  ]);
  if (!record) return false;
  const parsed = parseBuildResult({
    platform: record.platform,
    name: record.name,
    digest: record.digest,
    sizeBytes: record.sizeBytes,
    buildContractDigest: record.buildContractDigest,
    goModuleGraphDigest: record.goModuleGraphDigest,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  });
  if (
    !parsed ||
    !validDigest(record.primaryDigest) ||
    !validDigest(record.replayDigest) ||
    record.primaryDigest !== parsed.digest ||
    record.replayDigest !== parsed.digest
  ) {
    return false;
  }
  return Object.freeze({
    ...parsed,
    primaryDigest: record.primaryDigest,
    replayDigest: record.replayDigest,
  });
}

export function comparePublicBetaCosignBuilds(
  primary: Readonly<PublicBetaCosignBuildResultV1>,
  replay: Readonly<PublicBetaCosignBuildResultV1>,
): Readonly<PublicBetaCosignComparedBuildV1> | false {
  try {
    const left = parseBuildResult(primary);
    const right = parseBuildResult(replay);
    if (
      !left ||
      !right ||
      left.platform !== right.platform ||
      left.name !== right.name ||
      left.digest !== right.digest ||
      left.sizeBytes !== right.sizeBytes ||
      left.buildContractDigest !== right.buildContractDigest ||
      left.goModuleGraphDigest !== right.goModuleGraphDigest
    ) {
      return false;
    }
    return Object.freeze({
      ...left,
      primaryDigest: left.digest,
      replayDigest: right.digest,
    });
  } catch {
    return false;
  }
}

export function createPublicBetaCosignSlsaPredicate(input: Readonly<{
  lock: PublicBetaCosignBuilderLockV1;
  workflowSha: string;
  invocationId: string;
  compared: PublicBetaCosignComparedBuildV1;
}>): Readonly<PublicBetaCosignSlsaPredicateV1> | false {
  try {
    const record = exactRecord(input, ['compared', 'invocationId', 'lock', 'workflowSha']);
    const lock = record && parsePublicBetaCosignBuilderLock(record.lock);
    const compared = record && parseComparedBuild(record.compared);
    if (
      !record ||
      !lock ||
      !compared ||
      typeof record.workflowSha !== 'string' ||
      !SHA1.test(record.workflowSha) ||
      typeof record.invocationId !== 'string' ||
      record.invocationId.length < 1 ||
      record.invocationId.length > 512
    ) {
      return false;
    }
    const predicate = {
      buildDefinition: {
        buildType: 'https://openopc.dev/buildtypes/cosign/v1' as const,
        externalParameters: {
          buildContainerDigest: lock.buildImage.digest,
          buildContractDigest: compared.buildContractDigest,
          goModuleGraphDigest: compared.goModuleGraphDigest,
          platform: compared.platform,
          replayDigest: compared.replayDigest,
          subjectDigest: compared.digest,
          subjectName: compared.name,
          subjectSizeBytes: compared.sizeBytes,
          upstreamCommitSha: lock.upstream.commitSha,
          upstreamGoVersion: lock.upstream.goVersion,
          upstreamRepository: lock.upstream.repository,
          upstreamTag: lock.upstream.tag,
          upstreamTagObjectSha: lock.upstream.tagObjectSha,
          upstreamTreeSha: lock.upstream.treeSha,
          workflowSha: record.workflowSha,
        },
        internalParameters: {},
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/sigstore/cosign@refs/tags/v3.1.2',
            digest: { sha1: lock.upstream.commitSha, gitTree: lock.upstream.treeSha },
          },
        ],
      },
      runDetails: {
        builder: { id: canonicalPublicBetaCosignBuilderIdentity() },
        metadata: {
          invocationId: record.invocationId,
          startedOn: compared.startedAt,
          finishedOn: compared.finishedAt,
        },
      },
    };
    return parsePublicBetaCosignSlsaPredicate(predicate, {
      workflowSha: record.workflowSha,
      platform: compared.platform,
      subjectName: compared.name,
      subjectDigest: compared.digest,
      subjectSizeBytes: compared.sizeBytes,
      buildContainerDigest: lock.buildImage.digest,
      buildContractDigest: compared.buildContractDigest,
      goModuleGraphDigest: compared.goModuleGraphDigest,
      replayDigest: compared.replayDigest,
    });
  } catch {
    return false;
  }
}

export function redactPublicBetaCosignBuilderStderr(value: unknown): string {
  if (typeof value !== 'string') return 'OPENOPC_COSIGN_BUILDER_FAILED';
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/\b(token|password|secret|authorization)=([^\s&]+)/giu, '$1=[REDACTED]')
    .replace(/\b(bearer)\s+[^\s]+/giu, '$1 [REDACTED]')
    .slice(0, 4_096);
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  state: { bytes: number; overflow: boolean },
  maxOutputBytes: number,
  stop: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      state.bytes += item.value.byteLength;
      if (state.bytes > maxOutputBytes) {
        state.overflow = true;
        stop();
        await reader.cancel();
        break;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (state.overflow) return '';
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const defaultProcessRunner: PublicBetaBuilderProcessRunner = async (commandValue) => {
  const child = Bun.spawn([commandValue.executable, ...commandValue.args], {
    cwd: commandValue.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  let timedOut = false;
  const stop = () => {
    try {
      child.kill();
    } catch {
      // The process may have exited between the bound check and termination.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, commandValue.timeoutMs);
  const state = { bytes: 0, overflow: false };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessStream(child.stdout, state, commandValue.maxOutputBytes, stop),
      readProcessStream(child.stderr, state, commandValue.maxOutputBytes, stop),
      child.exited,
    ]);
    return {
      exitCode,
      timedOut,
      stdout: state.overflow ? 'x'.repeat(commandValue.maxOutputBytes + 1) : stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
  }
};

function productionLock(): Readonly<PublicBetaCosignBuilderLockV1> {
  const raw = JSON.parse(
    readFileSync(resolve(import.meta.dir, 'public-beta-trust/cosign-builder-lock.v1.json'), 'utf8'),
  ) as unknown;
  const lock = parsePublicBetaCosignBuilderLock(raw);
  if (!lock) throw new Error('OPENOPC_COSIGN_BUILDER_LOCK_INVALID');
  return lock;
}

function help(commandName?: string): string {
  if (commandName === 'build') {
    return 'Usage: public-beta:cosign:build [--plan] <source-root> <module-cache-root> <output-root>';
  }
  if (commandName === 'predicate') {
    return 'Usage: public-beta:cosign:predicate <compared-build-input.json>';
  }
  if (commandName === 'compare') {
    return 'Usage: public-beta:cosign:compare <primary-build-result.json> <replay-build-result.json>';
  }
  return `${help('build')}\n${help('predicate')}\n${help('compare')}`;
}

function readBoundedJson(path: string): unknown {
  const file = resolve(path);
  const stats = statSync(file, { bigint: true });
  if (!stats.isFile() || stats.size < 1n || stats.size > BigInt(MAX_CLI_INPUT_BYTES)) {
    throw new Error('OPENOPC_COSIGN_BUILDER_INPUT_INVALID');
  }
  const bytes = readFileSync(file);
  if (bytes.byteLength !== Number(stats.size)) {
    throw new Error('OPENOPC_COSIGN_BUILDER_INPUT_CHANGED');
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

async function runCli(args: readonly string[]): Promise<number> {
  const commandName = args[0];
  if (args.length === 0 || commandName === '--help' || commandName === '-h') {
    console.log(help());
    return 0;
  }
  if (commandName === 'build') {
    if (args[1] === '--help' || args[1] === '-h') {
      console.log(help('build'));
      return 0;
    }
    const planOnly = args[1] === '--plan';
    const roots = args.slice(planOnly ? 2 : 1);
    if (roots.length !== 3) throw new Error('OPENOPC_COSIGN_BUILDER_ARGUMENTS_INVALID');
    const platformValue = process.env.OPENOPC_COSIGN_PLATFORM;
    if (platformValue !== 'linuxAmd64' && platformValue !== 'windowsAmd64') {
      throw new Error('OPENOPC_COSIGN_BUILDER_PLATFORM_INVALID');
    }
    const plan = createPublicBetaCosignBuildPlan({
      lock: productionLock(),
      platform: platformValue,
      sourceRoot: resolve(roots[0] as string),
      moduleCacheRoot: resolve(roots[1] as string),
      outputRoot: resolve(roots[2] as string),
    });
    if (planOnly) {
      console.log(canonicalPublicBetaJson(plan));
      return 0;
    }
    const result = await executePublicBetaCosignBuildPlan(plan, defaultProcessRunner);
    if (!result) throw new Error('OPENOPC_COSIGN_BUILD_FAILED');
    console.log(canonicalPublicBetaJson(result));
    return 0;
  }
  if (commandName === 'predicate') {
    if (args[1] === '--help' || args[1] === '-h') {
      console.log(help('predicate'));
      return 0;
    }
    if (args.length !== 2) throw new Error('OPENOPC_COSIGN_BUILDER_ARGUMENTS_INVALID');
    const raw = exactRecord(readBoundedJson(args[1] as string), [
      'compared',
      'invocationId',
      'workflowSha',
    ]);
    if (!raw) throw new Error('OPENOPC_COSIGN_BUILDER_INPUT_INVALID');
    const predicate = createPublicBetaCosignSlsaPredicate({
      lock: productionLock(),
      workflowSha: raw.workflowSha as string,
      invocationId: raw.invocationId as string,
      compared: raw.compared as PublicBetaCosignComparedBuildV1,
    });
    if (!predicate) throw new Error('OPENOPC_COSIGN_PREDICATE_INVALID');
    console.log(canonicalPublicBetaJson(predicate));
    return 0;
  }
  if (commandName === 'compare') {
    if (args[1] === '--help' || args[1] === '-h') {
      console.log(help('compare'));
      return 0;
    }
    if (args.length !== 3) throw new Error('OPENOPC_COSIGN_BUILDER_ARGUMENTS_INVALID');
    const compared = comparePublicBetaCosignBuilds(
      readBoundedJson(args[1] as string) as PublicBetaCosignBuildResultV1,
      readBoundedJson(args[2] as string) as PublicBetaCosignBuildResultV1,
    );
    if (!compared) throw new Error('OPENOPC_COSIGN_BUILD_COMPARISON_INVALID');
    console.log(canonicalPublicBetaJson(compared));
    return 0;
  }
  throw new Error('OPENOPC_COSIGN_BUILDER_ARGUMENTS_INVALID');
}

if (import.meta.main) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : error;
      console.error(redactPublicBetaCosignBuilderStderr(message));
      process.exitCode = 1;
    });
}
