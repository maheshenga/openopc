import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  type PublicBetaBuilderProcessRunner,
  type PublicBetaCosignBuildInput,
  type PublicBetaCosignBuildResultV1,
  comparePublicBetaCosignBuilds,
  createPublicBetaCosignBuildPlan,
  createPublicBetaCosignSlsaPredicate,
  executePublicBetaCosignBuildPlan,
  executePublicBetaCosignBuildPlanDetailed,
  redactPublicBetaCosignBuilderStderr,
} from './public-beta-cosign-builder';
import {
  canonicalPublicBetaCosignBuilderIdentity,
  parsePublicBetaCosignBuilderLock,
  parsePublicBetaCosignSlsaPredicate,
} from './public-beta-cosign-toolchain';

const fixtureRoot = resolve(import.meta.dir, '../../tests/public-beta');
const rawLock = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'public-beta-trust/cosign-builder-lock.v1.json'), 'utf8'),
);
const lock = parsePublicBetaCosignBuilderLock(rawLock);

if (!lock) throw new Error('TEST_COSIGN_BUILDER_LOCK_INVALID');

function buildInput(platform: 'linuxAmd64' | 'windowsAmd64' = 'linuxAmd64'): PublicBetaCosignBuildInput {
  return {
    lock,
    platform,
    sourceRoot: resolve(fixtureRoot, 'cosign-source'),
    moduleCacheRoot: resolve(fixtureRoot, 'cosign-module-cache'),
    outputRoot: resolve(fixtureRoot, 'cosign-output'),
  };
}

function buildResult(
  platform: 'linuxAmd64' | 'windowsAmd64' = 'linuxAmd64',
): PublicBetaCosignBuildResultV1 {
  return {
    platform,
    name: platform === 'linuxAmd64' ? 'cosign-linux-amd64' : 'cosign-windows-amd64.exe',
    digest: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 1_024,
    buildContractDigest: `sha256:${'b'.repeat(64)}`,
    goModuleGraphDigest: `sha256:${'c'.repeat(64)}`,
    startedAt: '2026-07-30T10:00:00.000Z',
    finishedAt: '2026-07-30T10:01:00.000Z',
  };
}

function successfulRunner(plan: ReturnType<typeof createPublicBetaCosignBuildPlan>): PublicBetaBuilderProcessRunner {
  return async (command) => {
    const joined = command.args.join(' ');
    let stdout = '';
    if (joined.includes('rev-parse --verify HEAD^{tree}')) {
      stdout = `${lock.upstream.treeSha}\n`;
    } else if (joined.includes('rev-parse --verify HEAD')) {
      stdout = `${lock.upstream.commitSha}\n`;
    } else if (joined.includes('show -s --format=%cI')) {
      stdout = '2025-10-10T12:34:56+00:00\n';
    } else if (command === plan.fetch) {
      stdout = `sha256:${'c'.repeat(64)}\n`;
    } else if (command === plan.inspect) {
      stdout = `sha256:${'a'.repeat(64)}\n1024\ncosign-linux-amd64\n`;
    }
    return { exitCode: 0, timedOut: false, stdout, stderr: '' };
  };
}

test('build phase is immutable and network-disabled', () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput('linuxAmd64'));
  expect(plan.fetch.args).toContain('golang:1.26.0-bookworm@sha256:' + '2a0ba12e116687098780d3ce700f9ce3cb340783779646aafbabed748fa6677c');
  expect(plan.build.args).toContain('--network');
  expect(plan.build.args).toContain('none');
  expect(plan.build.args.join(' ')).toContain('CGO_ENABLED=0');
  expect(plan.build.args.join(' ')).toContain('GOOS=linux');
  expect(plan.build.args.join(' ')).toContain('GOARCH=amd64');
  expect(plan.build.args.join(' ')).toContain('-trimpath');
  expect(plan.build.args.join(' ')).toContain('-buildid=');
});

test('uses the Windows target name and Go environment', () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput('windowsAmd64'));
  expect(plan.build.args.join(' ')).toContain('GOOS=windows');
  expect(plan.build.args.join(' ')).toContain('cosign-windows-amd64.exe');
});

test('pins the Go toolchain and deterministic Cosign version metadata', () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const fetch = plan.fetch.args.join(' ');
  const build = plan.build.args.join(' ');
  expect(fetch).toContain('GOTOOLCHAIN=local');
  expect(build).toContain('GOTOOLCHAIN=local');
  expect(build).toContain('GOFLAGS=-mod=readonly');
  expect(build).toContain(
    'sigs.k8s.io/release-utils/version.gitVersion=v3.1.2',
  );
  expect(build).toContain(
    'sigs.k8s.io/release-utils/version.gitCommit=193d2153431f8bb0d945a4c1ee721872f73add67',
  );
  expect(build).toContain(
    'sigs.k8s.io/release-utils/version.gitTreeState=clean',
  );
  expect(build).toContain('sigs.k8s.io/release-utils/version.buildDate=$BUILD_DATE');
  expect(build).toContain('date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ');
});

test('requires an empty output directory before the build writes bytes', () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const build = plan.build.args.join(' ');
  expect(build).toContain('find /out -mindepth 1 -maxdepth 1');
  expect(build).toContain('[ "$entry_count" -eq 0 ]');
});

test('rejects a replay digest mismatch', () => {
  expect(
    comparePublicBetaCosignBuilds(buildResult(), {
      ...buildResult(),
      digest: `sha256:${'f'.repeat(64)}`,
    }),
  ).toBe(false);
});

test('parses a bounded successful process run into a frozen result', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const result = await executePublicBetaCosignBuildPlan(
    plan,
    successfulRunner(plan),
    (() => {
      const values = [
        new Date('2026-07-30T10:00:00.000Z'),
        new Date('2026-07-30T10:01:00.000Z'),
      ];
      return () => values.shift() ?? new Date('2026-07-30T10:01:00.000Z');
    })(),
  );
  expect(result).toMatchObject({
    platform: 'linuxAmd64',
    name: 'cosign-linux-amd64',
    digest: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 1_024,
    goModuleGraphDigest: `sha256:${'c'.repeat(64)}`,
    startedAt: '2026-07-30T10:00:00.000Z',
    finishedAt: '2026-07-30T10:01:00.000Z',
  });
  expect(result && Object.isFrozen(result)).toBe(true);
});

test('rejects a dirty source checkout and changed module inputs', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const statusCommand = plan.verifySource.find((command) => command.args[0] === 'status');
  const moduleCommand = plan.verifySource.find(
    (command) => command.args[0] === 'diff' && command.args.includes('go.mod'),
  );
  if (!statusCommand || !moduleCommand) throw new Error('TEST_COSIGN_BUILDER_PREFLIGHT_INVALID');
  const dirty = await executePublicBetaCosignBuildPlan(plan, async (command) =>
    command === statusCommand
      ? { exitCode: 0, timedOut: false, stdout: ' M cmd/cosign/main.go\n', stderr: '' }
      : baseRunner(command),
  );
  const changedModule = await executePublicBetaCosignBuildPlan(plan, async (command) =>
    command === moduleCommand
      ? { exitCode: 1, timedOut: false, stdout: 'diff --git a/go.mod b/go.mod\n', stderr: '' }
      : baseRunner(command),
  );
  expect(dirty).toBe(false);
  expect(changedModule).toBe(false);
});

test('rejects an unexpected output file and an excessive output size', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const extra = await executePublicBetaCosignBuildPlan(plan, async (command) =>
    command === plan.inspect
      ? {
          exitCode: 0,
          timedOut: false,
          stdout: `sha256:${'a'.repeat(64)}\n1024\nunexpected\n`,
          stderr: '',
        }
      : baseRunner(command),
  );
  const tooLarge = await executePublicBetaCosignBuildPlan(plan, async (command) =>
    command === plan.inspect
      ? {
          exitCode: 0,
          timedOut: false,
          stdout: `sha256:${'a'.repeat(64)}\n268435457\ncosign-linux-amd64\n`,
          stderr: '',
        }
      : baseRunner(command),
  );
  expect(extra).toBe(false);
  expect(tooLarge).toBe(false);
});

test('rejects failed and timed out processes before parsing output', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const failed = await executePublicBetaCosignBuildPlan(plan, async () => ({
    exitCode: 1,
    timedOut: false,
    stdout: '',
    stderr: 'failure',
  }));
  const timedOut = await executePublicBetaCosignBuildPlan(plan, async () => ({
    exitCode: null,
    timedOut: true,
    stdout: '',
    stderr: 'timeout',
  }));
  expect(failed).toBe(false);
  expect(timedOut).toBe(false);
});

test('classifies and redacts a module fetch process failure', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const execution = await executePublicBetaCosignBuildPlanDetailed(
    plan,
    async (command) =>
      command === plan.fetch
        ? {
            exitCode: 1,
            timedOut: false,
            stdout: '',
            stderr: 'go: https://user:download-secret@proxy.invalid?token=query-secret failed',
          }
        : baseRunner(command),
    () => new Date('2026-07-30T10:00:00.000Z'),
  );

  expect(execution.ok).toBe(false);
  if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
  expect(execution.failure).toMatchObject({
    schemaVersion: 1,
    code: 'OPENOPC_COSIGN_BUILD_PROCESS_FAILED',
    stage: 'module-fetch',
    operation: 'module-fetch',
    executable: 'docker',
    exitCode: 1,
    timedOut: false,
    outputLimited: false,
  });
  expect(execution.failure.stderrExcerpt).not.toContain('download-secret');
  expect(execution.failure.stderrExcerpt).not.toContain('query-secret');
  expect(Buffer.byteLength(JSON.stringify(execution.failure), 'utf8')).toBeLessThanOrEqual(8_192);
  expect(Object.isFrozen(execution.failure)).toBe(true);
});

test('classifies an offline build timeout', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const execution = await executePublicBetaCosignBuildPlanDetailed(
    plan,
    async (command) =>
      command === plan.build
        ? { exitCode: null, timedOut: true, stdout: '', stderr: 'build timed out' }
        : baseRunner(command),
    () => new Date('2026-07-30T10:00:00.000Z'),
  );

  expect(execution.ok).toBe(false);
  if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
  expect(execution.failure).toMatchObject({
    code: 'OPENOPC_COSIGN_BUILD_PROCESS_FAILED',
    stage: 'offline-build',
    operation: 'offline-build',
    executable: 'docker',
    exitCode: null,
    timedOut: true,
    outputLimited: false,
  });
});

test('classifies oversized process output without retaining excerpts', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const execution = await executePublicBetaCosignBuildPlanDetailed(
    plan,
    async (command) =>
      command === plan.fetch
        ? {
            exitCode: 1,
            timedOut: false,
            stdout: 'x'.repeat(command.maxOutputBytes + 1),
            stderr: 'must not be retained',
          }
        : baseRunner(command),
    () => new Date('2026-07-30T10:00:00.000Z'),
  );

  expect(execution.ok).toBe(false);
  if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
  expect(execution.failure).toMatchObject({
    code: 'OPENOPC_COSIGN_BUILD_OUTPUT_LIMIT_EXCEEDED',
    stage: 'module-fetch',
    operation: 'module-fetch',
    outputLimited: true,
    stdoutExcerpt: '',
    stderrExcerpt: '',
  });
});

test('classifies an invalid module graph digest', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const execution = await executePublicBetaCosignBuildPlanDetailed(
    plan,
    async (command) =>
      command === plan.fetch
        ? { exitCode: 0, timedOut: false, stdout: 'not-a-digest\n', stderr: '' }
        : baseRunner(command),
    () => new Date('2026-07-30T10:00:00.000Z'),
  );

  expect(execution.ok).toBe(false);
  if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
  expect(execution.failure).toMatchObject({
    code: 'OPENOPC_COSIGN_BUILD_OUTPUT_INVALID',
    stage: 'module-fetch',
    operation: 'module-fetch',
    executable: 'docker',
    exitCode: 0,
    timedOut: false,
    outputLimited: false,
  });
});

test('classifies runner exceptions without leaking authorization material', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const execution = await executePublicBetaCosignBuildPlanDetailed(
    plan,
    async (command) => {
      if (command === plan.fetch) {
        throw new Error('Authorization: Bearer ghp_1234567890abcdef');
      }
      return baseRunner(command);
    },
    () => new Date('2026-07-30T10:00:00.000Z'),
  );

  expect(execution.ok).toBe(false);
  if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
  expect(execution.failure).toMatchObject({
    code: 'OPENOPC_COSIGN_BUILD_RUNNER_FAILED',
    stage: 'module-fetch',
    operation: 'module-fetch',
    executable: 'docker',
    exitCode: null,
    timedOut: false,
    outputLimited: false,
  });
  expect(execution.failure.stderrExcerpt).toBe('Authorization: [REDACTED]');
  expect(execution.failure.stderrExcerpt).not.toContain('ghp_1234567890abcdef');
});

test('bounds retained multibyte output by UTF-8 bytes', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const baseRunner = successfulRunner(plan);
  const execution = await executePublicBetaCosignBuildPlanDetailed(
    plan,
    async (command) =>
      command === plan.fetch
        ? {
            exitCode: 1,
            timedOut: false,
            stdout: '\u754c'.repeat(1_200),
            stderr: '\u9519'.repeat(1_200),
          }
        : baseRunner(command),
    () => new Date('2026-07-30T10:00:00.000Z'),
  );

  expect(execution.ok).toBe(false);
  if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
  const retainedBytes =
    Buffer.byteLength(execution.failure.stdoutExcerpt, 'utf8') +
    Buffer.byteLength(execution.failure.stderrExcerpt, 'utf8');
  expect(retainedBytes).toBeLessThanOrEqual(4_096);
  expect(execution.failure.stdoutExcerpt).not.toContain('\ufffd');
  expect(execution.failure.stderrExcerpt).not.toContain('\ufffd');
});

test('runs bounded module DNS and TLS preflight before dependency download', () => {
  const fetch = createPublicBetaCosignBuildPlan(buildInput()).fetch.args.join(' ');
  expect(fetch).toContain('timeout 10 getent hosts proxy.golang.org');
  expect(fetch).toContain(
    "curl --fail --silent --show-error --max-time 20 --proto '=https' https://proxy.golang.org/",
  );
  expect(fetch).toContain(
    "curl --fail --silent --show-error --max-time 20 --proto '=https' https://sum.golang.org/supported",
  );
  expect(fetch.indexOf('timeout 10 getent hosts proxy.golang.org')).toBeLessThan(
    fetch.indexOf('go mod download'),
  );
});

test('build CLI emits one canonical source failure diagnostic', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'openopc-cosign-build-failure-'));
  const sourceRoot = resolve(root, 'source');
  const moduleCacheRoot = resolve(root, 'module-cache');
  const outputRoot = resolve(root, 'output');
  try {
    mkdirSync(sourceRoot);
    mkdirSync(moduleCacheRoot);
    mkdirSync(outputRoot);
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, 'public-beta-cosign-builder.ts'),
        'build',
        sourceRoot,
        moduleCacheRoot,
        outputRoot,
      ],
      {
        env: { ...process.env, OPENOPC_COSIGN_PLATFORM: 'linuxAmd64' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trimEnd().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(stderr)).toMatchObject({
      schemaVersion: 1,
      code: 'OPENOPC_COSIGN_BUILD_PROCESS_FAILED',
      stage: 'source-verify',
      operation: 'source-commit',
      executable: 'git',
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('bounds process output and redacts credentials from process stderr', async () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  const result = await executePublicBetaCosignBuildPlan(plan, async (command) => ({
    exitCode: 0,
    timedOut: false,
    stdout: 'x'.repeat(command.maxOutputBytes + 1),
    stderr: 'https://user:super-secret@example.invalid/build?token=super-secret',
  }));
  expect(result).toBe(false);
  expect(redactPublicBetaCosignBuilderStderr('https://user:super-secret@example.invalid/build?token=super-secret')).not.toContain('super-secret');
});

test('redacts long URL credentials before bounding diagnostics', () => {
  const secret = 's'.repeat(5_000);
  const redacted = redactPublicBetaCosignBuilderStderr(
    `https://user:${secret}@example.invalid/build`,
  );
  expect(redacted).toBe('https://[REDACTED]@example.invalid/build');
});

test('predicate CLI rejects unplanned inline JSON input', async () => {
  const compared = comparePublicBetaCosignBuilds(buildResult(), buildResult());
  if (!compared) throw new Error('TEST_COSIGN_BUILDER_COMPARISON_INVALID');
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, 'public-beta-cosign-builder.ts'),
      'predicate',
      '--json',
      JSON.stringify({
        compared,
        invocationId: 'run-42',
        workflowSha: 'd'.repeat(40),
      }),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr.trim()).toBe('OPENOPC_COSIGN_BUILDER_ARGUMENTS_INVALID');
});

test('compare CLI emits a canonical matching build result only from bounded JSON files', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'openopc-cosign-compare-'));
  try {
    const primaryPath = resolve(root, 'primary.json');
    const replayPath = resolve(root, 'replay.json');
    writeFileSync(primaryPath, JSON.stringify(buildResult()), 'utf8');
    writeFileSync(replayPath, JSON.stringify(buildResult()), 'utf8');
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, 'public-beta-cosign-builder.ts'),
        'compare',
        primaryPath,
        replayPath,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual(comparePublicBetaCosignBuilds(buildResult(), buildResult()));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('top-level CLI help advertises the fixed compare file interface', async () => {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, 'public-beta-cosign-builder.ts'), '--help'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(stdout).toContain(
    'Usage: public-beta:cosign:compare <primary-build-result.json> <replay-build-result.json>',
  );
});

test('binds a commit-derived build date into the source preflight', () => {
  const plan = createPublicBetaCosignBuildPlan(buildInput());
  expect(plan.verifySource.some((command) => command.args.join(' ').includes('show -s --format=%cI 193d2153431f8bb0d945a4c1ee721872f73add67'))).toBe(true);
  expect(plan.build.args.join(' ')).toContain('SOURCE_DATE_EPOCH');
});

test('binds upstream source, control revision, build contract, and replay bytes', () => {
  const compared = comparePublicBetaCosignBuilds(buildResult(), buildResult());
  if (!compared) throw new Error('TEST_COSIGN_BUILDER_COMPARISON_INVALID');
  const predicate = createPublicBetaCosignSlsaPredicate({
    lock,
    workflowSha: 'd'.repeat(40),
    invocationId: 'run-42',
    compared,
  });
  if (!predicate) throw new Error('TEST_COSIGN_BUILDER_PREDICATE_INVALID');
  expect(predicate.buildDefinition.buildType).toBe('https://openopc.dev/buildtypes/cosign/v1');
  expect(predicate.buildDefinition.resolvedDependencies).toContainEqual({
    uri: 'git+https://github.com/sigstore/cosign@refs/tags/v3.1.2',
    digest: {
      sha1: '193d2153431f8bb0d945a4c1ee721872f73add67',
      gitTree: '6647db468973d11edb5e737293fcf4b05c69a84a',
    },
  });
  expect(predicate.runDetails.builder.id).toBe(canonicalPublicBetaCosignBuilderIdentity());
  expect(predicate.buildDefinition.externalParameters.replayDigest).toBe(compared.digest);
  expect(
    parsePublicBetaCosignSlsaPredicate(predicate, {
      workflowSha: 'd'.repeat(40),
      platform: 'linuxAmd64',
      subjectName: 'cosign-linux-amd64',
      subjectDigest: compared.digest,
      subjectSizeBytes: compared.sizeBytes,
      buildContainerDigest: lock.buildImage.digest,
      buildContractDigest: compared.buildContractDigest,
      goModuleGraphDigest: compared.goModuleGraphDigest,
      replayDigest: compared.replayDigest,
    }),
  ).toEqual(predicate);
});
