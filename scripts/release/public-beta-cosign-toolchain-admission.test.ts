import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { PublicBetaArchiveExtraction } from './public-beta-archive';
import { canonicalPublicBetaJson, computeCanonicalPublicBetaDigest } from './public-beta-canonical-json';
import type { PublicBetaSha256Digest } from './public-beta-canonical-json';
import type { PublicBetaCosignBuilderLockV1, PublicBetaCosignToolchainV1 } from './public-beta-cosign-toolchain';
import * as admission from './public-beta-cosign-toolchain-admission';
import type { PublicBetaAuthenticatedToolBuilderRun, PublicBetaGitHubActionsClient } from './public-beta-github-actions';
import type { PublicBetaNativeDirectory, PublicBetaNativeFile, PublicBetaNativeFilesystem } from './public-beta-native-filesystem';

const { admitPublicBetaCosignToolchain } = admission;

type JsonRecord = Record<string, unknown>;
type Paths = ReturnType<typeof admissionFixturePaths>;
type AdmissionInput = ReturnType<typeof admissionInput>;
type AdmissionModule = typeof admission & {
  admitPublicBetaCosignToolchainWithDependencies?: (
    input: Readonly<AdmissionInput>,
    dependencies: Readonly<{ filesystem: PublicBetaNativeFilesystem }>,
  ) => Promise<Readonly<unknown> | false>;
};

interface RecordedCommand {
  executable: 'gh';
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface FakeDirectoryState {
  path: string;
  files: Map<string, FakeFileState>;
  published: boolean;
}

interface FakeFileState {
  directory: symbol;
  name: string;
  bytes: Uint8Array;
  closed: boolean;
  replaced: boolean;
}

interface FakeFilesystemOptions {
  failWriteName?: string;
  failZeroWrite?: boolean;
  failCloseName?: string;
  failExactRegularFiles?: boolean;
  shortReadName?: string;
  retainVerificationCleanup?: boolean;
  publishNoReplace?: boolean;
  replaceStageNameAfterWrite?: string;
}

const sha256 = (value: Uint8Array | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const bytes = new TextEncoder();
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`tests/public-beta/${name}`, 'utf8')) as T;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TEST_RECORD_INVALID');
  return value as JsonRecord;
}

function predicate(input: { platform: 'linuxAmd64' | 'windowsAmd64'; name: string; digest: string; sizeBytes: number }): JsonRecord {
  const lock = record(fixture<JsonRecord>('cosign-builder-lock.v1.fixture.json'));
  const upstream = record(lock.upstream);
  return {
    buildDefinition: {
      buildType: 'https://openopc.dev/buildtypes/cosign/v1',
      externalParameters: {
        workflowSha: 'a'.repeat(40), platform: input.platform, subjectName: input.name, subjectDigest: input.digest, subjectSizeBytes: input.sizeBytes,
        buildContainerDigest: record(lock.buildImage).digest, buildContractDigest: `sha256:${'3'.repeat(64)}`, goModuleGraphDigest: `sha256:${'4'.repeat(64)}`,
        replayDigest: input.digest, upstreamRepository: upstream.repository, upstreamTag: upstream.tag, upstreamTagObjectSha: upstream.tagObjectSha,
        upstreamCommitSha: upstream.commitSha, upstreamTreeSha: upstream.treeSha, upstreamGoVersion: upstream.goVersion,
      },
      internalParameters: {},
      resolvedDependencies: [{ uri: 'git+https://github.com/sigstore/cosign@refs/tags/v3.1.2', digest: { sha1: upstream.commitSha, gitTree: upstream.treeSha } }],
    },
    runDetails: {
      builder: { id: 'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main' },
      metadata: { invocationId: '101', startedOn: '2026-07-30T10:00:00.000Z', finishedOn: '2026-07-30T10:01:00.000Z' },
    },
  };
}

function verification(subject: { platform: 'linuxAmd64' | 'windowsAmd64'; name: string; digest: string; sizeBytes: number }): JsonRecord {
  return {
    certificateIdentity: 'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main',
    certificateOidcIssuer: 'https://token.actions.githubusercontent.com', signerDigest: 'a'.repeat(40), sourceRef: 'refs/heads/main', sourceDigest: 'a'.repeat(40),
    statement: {
      _type: 'https://in-toto.io/Statement/v1', subject: [{ name: subject.name, digest: { sha256: subject.digest.slice(7) } }],
      predicateType: 'https://slsa.dev/provenance/v1', predicate: predicate(subject),
    },
  };
}

function commandSubject(input: RecordedCommand): { platform: 'linuxAmd64' | 'windowsAmd64'; name: string } {
  const name = basename(input.args[2] ?? '');
  return {
    platform: name.endsWith('.exe') ? 'windowsAmd64' : 'linuxAmd64',
    name,
  };
}

function admissionFixturePaths() {
  const root = mkdtempSync(join(tmpdir(), 'openopc-cosign-admission-'));
  const extractedRoot = join(root, 'extracted');
  const outputRoot = join(root, 'output');
  mkdirSync(join(extractedRoot, 'cosign-v3.1.2-openopc.1'), { recursive: true });
  mkdirSync(outputRoot);
  const linux = bytes.encode('linux subject bytes');
  const windows = bytes.encode('windows subject bytes');
  const linuxBundle = bytes.encode('{"linux":"bundle"}\n');
  const windowsBundle = bytes.encode('{"windows":"bundle"}\n');
  const linuxSubjectPath = join(extractedRoot, 'cosign-linux-amd64');
  const windowsSubjectPath = join(extractedRoot, 'cosign-windows-amd64.exe');
  const linuxBundlePath = join(extractedRoot, 'cosign-v3.1.2-openopc.1', 'linux-amd64.jsonl');
  const windowsBundlePath = join(extractedRoot, 'cosign-v3.1.2-openopc.1', 'windows-amd64.jsonl');
  writeFileSync(linuxSubjectPath, linux); writeFileSync(windowsSubjectPath, windows);
  writeFileSync(linuxBundlePath, linuxBundle); writeFileSync(windowsBundlePath, windowsBundle);
  const lock = fixture<JsonRecord>('cosign-builder-lock.v1.fixture.json');
  const manifest = {
    schemaVersion: 1, toolchainId: 'openopc-cosign-v3.1.2.1', upstream: lock.upstream,
    builder: {
      oidcIssuer: 'https://token.actions.githubusercontent.com', repository: 'maheshenga/openopc', workflowPath: '.github/workflows/openopc-cosign-builder.yml', workflowRef: 'refs/heads/main',
      workflowSha: 'a'.repeat(40), certificateIdentity: 'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main', trigger: 'workflow_dispatch',
      buildContainerDigest: record(lock.buildImage).digest,
      buildContractDigest: computeCanonicalPublicBetaDigest({ linuxAmd64: `sha256:${'3'.repeat(64)}`, windowsAmd64: `sha256:${'3'.repeat(64)}` }),
      goModuleGraphDigest: `sha256:${'4'.repeat(64)}`,
    },
    artifacts: {
      linuxAmd64: { name: 'cosign-linux-amd64', digest: sha256(linux), sizeBytes: linux.byteLength, releaseTag: 'openopc-cosign-v3.1.2.1', releaseAssetId: '101', bundlePath: 'cosign-v3.1.2-openopc.1/linux-amd64.jsonl', bundleDigest: sha256(linuxBundle), predicateType: 'https://slsa.dev/provenance/v1' },
      windowsAmd64: { name: 'cosign-windows-amd64.exe', digest: sha256(windows), sizeBytes: windows.byteLength, releaseTag: 'openopc-cosign-v3.1.2.1', releaseAssetId: '102', bundlePath: 'cosign-v3.1.2-openopc.1/windows-amd64.jsonl', bundleDigest: sha256(windowsBundle), predicateType: 'https://slsa.dev/provenance/v1' },
    },
  };
  writeFileSync(join(extractedRoot, 'manifest.json'), `${canonicalPublicBetaJson(manifest)}\n`);
  return { root, extractedRoot, outputRoot, linuxSubjectPath, windowsSubjectPath, linuxBundlePath, windowsBundlePath, manifest };
}

function runner(paths: Paths, mutate?: (value: JsonRecord, call: number) => void): admission.PublicBetaAttestationCommandRunner & { calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    async run(input) {
      void paths;
      calls.push(input);
      const { platform, name } = commandSubject(input);
      const path = input.args[2] ?? '';
      const subjectBytes = readFileSync(path);
      const subject = { platform, name, digest: sha256(subjectBytes), sizeBytes: subjectBytes.byteLength };
      const output = verification(subject);
      mutate?.(output, calls.length - 1);
      return { exitCode: 0, stdout: JSON.stringify([output]), stderr: '' };
    },
  };
}

function admissionInput(paths: Paths, runnerInput: admission.PublicBetaAttestationCommandRunner = runner(paths)) {
  return {
    authenticatedRun: { repository: 'maheshenga/openopc', workflow: '.github/workflows/openopc-cosign-builder.yml', workflowRef: 'refs/heads/main', controlSha: 'a'.repeat(40), runId: '101', runAttempt: 1, event: 'workflow_dispatch', artifactId: '102', artifactDigest: `sha256:${'b'.repeat(64)}`, artifactSizeBytes: 1024, startedAt: '2026-07-30T10:00:00.000Z', finishedAt: '2026-07-30T10:01:00.000Z' },
    extractedRoot: paths.extractedRoot, outputRoot: paths.outputRoot, expectedLock: fixture<JsonRecord>('cosign-builder-lock.v1.fixture.json'), runner: runnerInput,
  };
}

function cleanup(paths: Paths): void { rmSync(paths.root, { recursive: true, force: true }); }

class FakeNativeFilesystem implements PublicBetaNativeFilesystem {
  readonly directories = new Map<symbol, FakeDirectoryState>();
  readonly files = new Map<symbol, FakeFileState>();
  readonly pathToFile = new Map<string, FakeFileState>();
  readonly disposed: Array<{ path: string; expectedNames: readonly string[]; result: 'removed' | 'retained' }> = [];
  readonly published = new Map<string, Map<string, Uint8Array>>();
  private sequence = 0;

  constructor(private readonly options: FakeFilesystemOptions = {}) {}

  openDirectory(path: string): PublicBetaNativeDirectory | false {
    const token = this.directoryToken();
    this.directories.set(token.token, { path: `native://${path.replaceAll('\\', '/')}`, files: new Map(), published: false });
    return token;
  }

  createPrivateDirectory(parent: PublicBetaNativeDirectory, prefix: string): PublicBetaNativeDirectory | false {
    const parentState = this.directories.get(parent.token);
    if (!parentState || parentState.published) return false;
    const token = this.directoryToken();
    this.sequence += 1;
    this.directories.set(token.token, { path: `${parentState.path}/${prefix}${String(this.sequence)}`, files: new Map(), published: false });
    return token;
  }

  writeExclusiveFile(directory: PublicBetaNativeDirectory, name: string, value: Uint8Array): PublicBetaNativeFile | false {
    const state = this.directories.get(directory.token);
    if (!state || state.published || state.files.has(name) || this.options.failWriteName === name || (value.byteLength === 0 && this.options.failZeroWrite)) return false;
    const token = this.fileToken();
    const file = { directory: directory.token, name, bytes: new Uint8Array(value), closed: false, replaced: false };
    state.files.set(name, file);
    this.files.set(token.token, file);
    this.pathToFile.set(`${state.path}/${name}`, file);
    if (this.options.replaceStageNameAfterWrite === name) file.replaced = true;
    return token;
  }

  retainExistingRegularFile(directory: PublicBetaNativeDirectory, name: string): PublicBetaNativeFile | false {
    const state = this.directories.get(directory.token);
    const file = state?.files.get(name);
    if (!state || state.published || !file) return false;
    const token = this.fileToken();
    file.closed = false;
    this.files.set(token.token, file);
    return token;
  }

  readFile(file: PublicBetaNativeFile, maxBytes: number): Uint8Array | false {
    const state = this.files.get(file.token);
    if (!state || state.closed || state.replaced || state.bytes.byteLength > maxBytes) return false;
    if (this.options.shortReadName === state.name) return new Uint8Array(state.bytes).slice(0, Math.max(0, state.bytes.byteLength - 1));
    return new Uint8Array(state.bytes);
  }

  closeFile(file: PublicBetaNativeFile): boolean {
    const state = this.files.get(file.token);
    if (!state || this.options.failCloseName === state.name) return false;
    state.closed = true;
    this.files.delete(file.token);
    return true;
  }

  childPath(directory: PublicBetaNativeDirectory, name: string): string | false {
    const state = this.directories.get(directory.token);
    return state ? `${state.path}/${name}` : false;
  }

  exactRegularFiles(directory: PublicBetaNativeDirectory, expected: readonly string[]): boolean {
    const state = this.directories.get(directory.token);
    if (!state || state.published || this.options.failExactRegularFiles) return false;
    const actual = [...state.files.keys()].sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((name, index) => name === wanted[index]) && expected.every((name) => !state.files.get(name)?.replaced);
  }

  publishNoReplace(
    source: PublicBetaNativeDirectory,
    destination: PublicBetaNativeDirectory,
    finalName: string,
    authorizeSource: () => boolean,
  ): boolean {
    const sourceState = this.directories.get(source.token);
    const destinationState = this.directories.get(destination.token);
    if (
      !sourceState ||
      !destinationState ||
      sourceState.published ||
      this.options.publishNoReplace === false ||
      authorizeSource() !== true
    ) {
      return false;
    }
    sourceState.published = true;
    const output = new Map<string, Uint8Array>();
    for (const [name, file] of sourceState.files) output.set(name, new Uint8Array(file.bytes));
    this.published.set(`${destinationState.path}/${finalName}`, output);
    return true;
  }

  disposeUnpublished(directory: PublicBetaNativeDirectory, expectedNames: readonly string[]): 'removed' | 'retained' {
    const state = this.directories.get(directory.token);
    if (!state || state.published) return 'retained';
    const result = this.options.retainVerificationCleanup && state.path.includes('/cosign-verify-') ? 'retained' : this.exactRegularFiles(directory, expectedNames) ? 'removed' : 'retained';
    this.disposed.push({ path: state.path, expectedNames, result });
    return result;
  }

  closeDirectory(directory: PublicBetaNativeDirectory): boolean {
    return this.directories.has(directory.token);
  }

  bytesAt(path: string): Uint8Array {
    const file = this.pathToFile.get(path);
    if (!file) throw new Error(`TEST_NATIVE_PATH_MISSING:${path}`);
    return new Uint8Array(file.bytes);
  }

  replacePath(path: string, value: Uint8Array): void {
    const file = this.pathToFile.get(path);
    if (!file) throw new Error(`TEST_NATIVE_PATH_MISSING:${path}`);
    file.bytes = new Uint8Array(value);
  }

  publishedFiles(finalName = 'cosign-v3.1.2-openopc.1'): Map<string, Uint8Array> | undefined {
    for (const [path, files] of this.published) if (path.endsWith(`/${finalName}`)) return files;
    return undefined;
  }

  private directoryToken(): PublicBetaNativeDirectory {
    return Object.freeze({ kind: 'directory' as const, token: Symbol('test-directory') });
  }

  private fileToken(): PublicBetaNativeFile {
    return Object.freeze({ kind: 'file' as const, token: Symbol('test-file') });
  }
}

async function admitWithFilesystem(input: AdmissionInput, filesystem: PublicBetaNativeFilesystem): Promise<Readonly<unknown> | false> {
  const fn = (admission as AdmissionModule).admitPublicBetaCosignToolchainWithDependencies;
  expect(fn).toBeFunction();
  return fn?.(input, { filesystem }) ?? false;
}

function fakeRunner(
  filesystem: FakeNativeFilesystem,
  mutate?: (input: RecordedCommand, call: number) => void | Promise<void>,
): admission.PublicBetaAttestationCommandRunner & { calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      await mutate?.(input, calls.length - 1);
      const { platform, name } = commandSubject(input);
      const subjectBytes = filesystem.bytesAt(input.args[2] ?? '');
      const subject = { platform, name, digest: sha256(subjectBytes), sizeBytes: subjectBytes.byteLength };
      return { exitCode: 0, stdout: JSON.stringify([verification(subject)]), stderr: '' };
    },
  };
}

test('verifies each subject with the exact GitHub identity and control SHA', async () => {
  const paths = admissionFixturePaths();
  try {
    const recordingRunner = runner(paths);
    const admitted = await admitPublicBetaCosignToolchain(admissionInput(paths, recordingRunner));
    expect(recordingRunner.calls).toHaveLength(2);
    expect(admitted).not.toBe(false);
    expect(recordingRunner.calls[0]).toMatchObject({ executable: 'gh', timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
    expect(recordingRunner.calls[0]?.cwd).not.toBe(paths.extractedRoot);
    expect(recordingRunner.calls[0]?.args).toEqual([
      'attestation', 'verify', expect.stringContaining('cosign-linux-amd64'), '--repo', 'maheshenga/openopc', '--bundle', expect.stringContaining('linux-amd64.jsonl'), '--predicate-type', 'https://slsa.dev/provenance/v1', '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com', '--cert-identity', 'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main', '--signer-workflow', 'maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml', '--signer-digest', 'a'.repeat(40), '--source-ref', 'refs/heads/main', '--source-digest', 'a'.repeat(40), '--format', 'json',
    ]);
    expect(recordingRunner.calls[0]?.args[2]).not.toBe(paths.linuxSubjectPath);
    expect(recordingRunner.calls[0]?.args[6]).not.toBe(paths.linuxBundlePath);
    expect(existsSync(join(paths.outputRoot, 'cosign-v3.1.2-openopc.1', 'cosign-linux-amd64'))).toBe(false);
    expect(existsSync(join(paths.outputRoot, 'cosign-v3.1.2-openopc.1', 'cosign-windows-amd64.exe'))).toBe(false);
  } finally { cleanup(paths); }
});

test.each(['issuer', 'certificate-identity', 'signer-digest', 'source-digest', 'predicate-type', 'upstream-commit', 'tree', 'container', 'subject', 'replay-digest'])('rejects verified-output mutation %s', async (mutation) => {
  const paths = admissionFixturePaths();
  try {
    const rejectionRunner = runner(paths, (output) => {
      const verificationResult = output;
      const statement = record(verificationResult.statement);
      const parameters = record(record(record(statement.predicate).buildDefinition).externalParameters);
      if (mutation === 'issuer') verificationResult.certificateOidcIssuer = 'https://wrong.invalid';
      if (mutation === 'certificate-identity') verificationResult.certificateIdentity = 'https://wrong.invalid';
      if (mutation === 'signer-digest') verificationResult.signerDigest = 'b'.repeat(40);
      if (mutation === 'source-digest') verificationResult.sourceDigest = 'b'.repeat(40);
      if (mutation === 'predicate-type') statement.predicateType = 'https://wrong.invalid';
      if (mutation === 'upstream-commit') parameters.upstreamCommitSha = 'b'.repeat(40);
      if (mutation === 'tree') parameters.upstreamTreeSha = 'b'.repeat(40);
      if (mutation === 'container') parameters.buildContainerDigest = `sha256:${'f'.repeat(64)}`;
      if (mutation === 'subject') parameters.subjectDigest = `sha256:${'f'.repeat(64)}`;
      if (mutation === 'replay-digest') parameters.replayDigest = `sha256:${'f'.repeat(64)}`;
    });
    expect(await admitPublicBetaCosignToolchain(admissionInput(paths, rejectionRunner))).toBe(false);
  } finally { cleanup(paths); }
});

test('rejects non-JSON, zero/two results, unknown fields, and process failure', async () => {
  const outputs = ['not-json', '[]', JSON.stringify([verification({ platform: 'linuxAmd64', name: 'cosign-linux-amd64', digest: `sha256:${'1'.repeat(64)}`, sizeBytes: 1 }), verification({ platform: 'linuxAmd64', name: 'cosign-linux-amd64', digest: `sha256:${'1'.repeat(64)}`, sizeBytes: 1 })]), JSON.stringify([{ unexpected: true }])];
  for (const stdout of outputs) {
    const paths = admissionFixturePaths();
    try {
      const hostile: PublicBetaAttestationCommandRunner = { async run() { return { exitCode: 0, stdout, stderr: '' }; } };
      expect(await admitPublicBetaCosignToolchain(admissionInput(paths, hostile))).toBe(false);
    } finally { cleanup(paths); }
  }
  const paths = admissionFixturePaths();
  try {
    const failed: PublicBetaAttestationCommandRunner = { async run() { return { exitCode: 1, stdout: '', stderr: 'failure' }; } };
    expect(await admitPublicBetaCosignToolchain(admissionInput(paths, failed))).toBe(false);
  } finally { cleanup(paths); }
});

test('rejects bundle escape, digest mismatch, binary truncation, and manifest mismatch', async () => {
  for (const mutate of [
    (paths: Paths) => { record(record(paths.manifest.artifacts).linuxAmd64).bundlePath = '../escape.jsonl'; },
    (paths: Paths) => { record(record(paths.manifest.artifacts).linuxAmd64).bundleDigest = `sha256:${'f'.repeat(64)}`; },
    (paths: Paths) => { writeFileSync(paths.linuxSubjectPath, 'truncated'); },
    (paths: Paths) => { record(paths.manifest.builder).workflowSha = 'b'.repeat(40); },
  ]) {
    const paths = admissionFixturePaths();
    try {
      mutate(paths);
      writeFileSync(join(paths.extractedRoot, 'manifest.json'), `${canonicalPublicBetaJson(paths.manifest)}\n`);
      expect(await admitPublicBetaCosignToolchain(admissionInput(paths))).toBe(false);
    } finally { cleanup(paths); }
  }
});

test('refuses existing output and leaves no partial staging directory', async () => {
  const paths = admissionFixturePaths();
  try {
    mkdirSync(join(paths.outputRoot, 'cosign-v3.1.2-openopc.1'));
    expect(await admitPublicBetaCosignToolchain(admissionInput(paths))).toBe(false);
    expect(readdirSync(paths.outputRoot)).toEqual(['cosign-v3.1.2-openopc.1']);
  } finally { cleanup(paths); }
});

test('publishes exactly the admitted manifest and bundles through the native seam', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem();
    const recordingRunner = fakeRunner(filesystem);
    const admitted = await admitWithFilesystem(admissionInput(paths, recordingRunner), filesystem);
    expect(admitted).not.toBe(false);
    expect(recordingRunner.calls).toHaveLength(2);
    expect(recordingRunner.calls[0]?.cwd).not.toBe(paths.extractedRoot);
    expect(recordingRunner.calls[0]?.args[2]).not.toBe(paths.linuxSubjectPath);
    expect(recordingRunner.calls[0]?.args[6]).not.toBe(paths.linuxBundlePath);
    const published = filesystem.publishedFiles();
    expect(published && [...published.keys()].sort()).toEqual(['linux-amd64.jsonl', 'toolchain.json', 'windows-amd64.jsonl']);
    expect(Buffer.from(published?.get('toolchain.json') ?? [])).toEqual(Buffer.from(`${canonicalPublicBetaJson(paths.manifest)}\n`));
    expect(Buffer.from(published?.get('linux-amd64.jsonl') ?? [])).toEqual(readFileSync(paths.linuxBundlePath));
    expect(Buffer.from(published?.get('windows-amd64.jsonl') ?? [])).toEqual(readFileSync(paths.windowsBundlePath));
    expect(published?.has('cosign-linux-amd64')).toBe(false);
    expect(published?.has('cosign-windows-amd64.exe')).toBe(false);
  } finally { cleanup(paths); }
});

test('uses owned verification bytes when original extracted paths mutate while gh awaits', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem();
    const recordingRunner = fakeRunner(filesystem, async (_input, call) => {
      if (call === 0) {
        writeFileSync(paths.linuxSubjectPath, 'mutated subject bytes');
        writeFileSync(paths.linuxBundlePath, '{"mutated":"bundle"}\\n');
      }
    });
    const admitted = await admitWithFilesystem(admissionInput(paths, recordingRunner), filesystem);
    expect(admitted).not.toBe(false);
    expect(recordingRunner.calls).toHaveLength(2);
    const published = filesystem.publishedFiles();
    expect(Buffer.from(published?.get('linux-amd64.jsonl') ?? [])).not.toEqual(readFileSync(paths.linuxBundlePath));
  } finally { cleanup(paths); }
});

test('binds runner.run once before awaiting verifier output', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem();
    const calls: RecordedCommand[] = [];
    const runnerInput: admission.PublicBetaAttestationCommandRunner = {
      async run(input) {
        calls.push(input);
        runnerInput.run = async () => {
          throw new Error('TEST_UNBOUND_RUNNER_USED');
        };
        const { platform, name } = commandSubject(input);
        const subjectBytes = filesystem.bytesAt(input.args[2] ?? '');
        return {
          exitCode: 0,
          stdout: JSON.stringify([verification({ platform, name, digest: sha256(subjectBytes), sizeBytes: subjectBytes.byteLength })]),
          stderr: '',
        };
      },
    };
    expect(await admitWithFilesystem(admissionInput(paths, runnerInput), filesystem)).not.toBe(false);
    expect(calls).toHaveLength(2);
  } finally { cleanup(paths); }
});

test('uses the authenticated-run snapshot after verifier awaits', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem();
    const input = admissionInput(paths);
    const recordingRunner = fakeRunner(filesystem, async (_command, call) => {
      if (call === 0) {
        input.authenticatedRun.controlSha = 'b'.repeat(40);
        input.authenticatedRun.artifactId = '999';
      }
    });
    input.runner = recordingRunner;
    expect(await admitWithFilesystem(input, filesystem)).not.toBe(false);
    expect(recordingRunner.calls).toHaveLength(2);
  } finally { cleanup(paths); }
});

test('rejects authenticated-run accessors without invoking getters', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem();
    const recordingRunner = fakeRunner(filesystem);
    const input = admissionInput(paths, recordingRunner);
    const original = input.authenticatedRun;
    let getterCount = 0;
    const accessorRun = Object.fromEntries(Object.keys(original).map((key) => [
      key,
      {
        enumerable: true,
        get() {
          getterCount += 1;
          return record(original)[key];
        },
      },
    ]));
    input.authenticatedRun = Object.create(Object.prototype, accessorRun);
    expect(await admitWithFilesystem(input, filesystem)).toBe(false);
    expect(recordingRunner.calls).toHaveLength(0);
    expect(getterCount).toBe(0);
  } finally { cleanup(paths); }
});

test('snapshots authenticated-run proxy data descriptors without property gets', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem();
    const input = admissionInput(paths);
    const target = { ...input.authenticatedRun };
    let getTrapCount = 0;
    input.authenticatedRun = new Proxy(target, {
      get(proxiedTarget, property, receiver) {
        getTrapCount += 1;
        return Reflect.get(proxiedTarget, property, receiver);
      },
    });
    const recordingRunner = fakeRunner(filesystem, async (_command, call) => {
      if (call === 0) target.controlSha = 'b'.repeat(40);
    });
    input.runner = recordingRunner;
    expect(await admitWithFilesystem(input, filesystem)).not.toBe(false);
    expect(recordingRunner.calls).toHaveLength(2);
    expect(getTrapCount).toBe(0);
  } finally { cleanup(paths); }
});

test('rejects retained verification cleanup before publishing', async () => {
  const paths = admissionFixturePaths();
  try {
    const filesystem = new FakeNativeFilesystem({ retainVerificationCleanup: true });
    const recordingRunner = fakeRunner(filesystem);
    expect(await admitWithFilesystem(admissionInput(paths, recordingRunner), filesystem)).toBe(false);
    expect(recordingRunner.calls).toHaveLength(1);
    expect(filesystem.publishedFiles()).toBeUndefined();
    expect(filesystem.disposed.some((entry) => entry.result === 'retained')).toBe(true);
  } finally { cleanup(paths); }
});

test.each([
  ['short write', new FakeNativeFilesystem({ failWriteName: 'toolchain.json' })],
  ['retained reread mismatch', new FakeNativeFilesystem({ shortReadName: 'toolchain.json' })],
  ['close failure', new FakeNativeFilesystem({ failCloseName: 'toolchain.json' })],
  ['membership mismatch', new FakeNativeFilesystem({ failExactRegularFiles: true })],
  ['stage replacement', new FakeNativeFilesystem({ replaceStageNameAfterWrite: 'toolchain.json' })],
  ['existing target collision', new FakeNativeFilesystem({ publishNoReplace: false })],
])('rejects native publication failure: %s', async (_name, filesystem) => {
  const paths = admissionFixturePaths();
  try {
    expect(await admitWithFilesystem(admissionInput(paths, fakeRunner(filesystem)), filesystem)).toBe(false);
    expect(filesystem.publishedFiles()).toBeUndefined();
    expect(filesystem.disposed.length).toBeGreaterThan(0);
  } finally { cleanup(paths); }
});

test('rejects zero-byte native writes before issuing verifier commands', async () => {
  const paths = admissionFixturePaths();
  try {
    writeFileSync(paths.linuxBundlePath, new Uint8Array());
    record(record(paths.manifest.artifacts).linuxAmd64).bundleDigest = sha256(new Uint8Array());
    writeFileSync(join(paths.extractedRoot, 'manifest.json'), `${canonicalPublicBetaJson(paths.manifest)}\n`);
    const filesystem = new FakeNativeFilesystem({ failZeroWrite: true });
    const recordingRunner = fakeRunner(filesystem);
    expect(await admitWithFilesystem(admissionInput(paths, recordingRunner), filesystem)).toBe(false);
    expect(recordingRunner.calls).toHaveLength(0);
    expect(filesystem.publishedFiles()).toBeUndefined();
  } finally { cleanup(paths); }
});

type CliCommand = Readonly<{
  executable: 'gh' | 'git';
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

type CliDependencies = {
  cwd: string;
  now: () => Date;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  run: (input: CliCommand) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
  client: PublicBetaGitHubActionsClient;
  authenticateBuilderRun: (input: {
    client: PublicBetaGitHubActionsClient;
    expectedRepository: 'maheshenga/openopc';
    expectedControlSha: string;
    runId: string;
    now: Date;
  }) => Promise<Readonly<PublicBetaAuthenticatedToolBuilderRun> | false>;
  createPrivateWorkspace: () => string | false;
  disposePrivateWorkspace: (workspace: string) => boolean;
  verifyDownloadedArtifact: (input: Readonly<{ archivePath: string; expectedDigest: PublicBetaSha256Digest; expectedSizeBytes: number }>) => boolean;
  extractArchive: (input: Readonly<{ archivePath: string; expectedDigest: PublicBetaSha256Digest; expectedSizeBytes: number; destination: string }>) => Promise<PublicBetaArchiveExtraction | false>;
  admit: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<PublicBetaCosignToolchainV1> | false>;
  expectedLock: () => Readonly<PublicBetaCosignBuilderLockV1> | false;
};

type CliModule = typeof admission & {
  runPublicBetaCosignAdmissionCli?: (args: readonly string[], dependencies: CliDependencies) => Promise<number>;
};

function cliFixture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: CliCommand[] = [];
  const events: string[] = [];
  const workspace = 'C:/private/openopc-cosign-admission';
  const authenticatedRun = Object.freeze({
    repository: 'maheshenga/openopc' as const,
    workflow: '.github/workflows/openopc-cosign-builder.yml' as const,
    workflowRef: 'refs/heads/main' as const,
    controlSha: 'a'.repeat(40),
    runId: '101',
    runAttempt: 1,
    event: 'workflow_dispatch' as const,
    artifactId: '102',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    artifactSizeBytes: 1024,
    startedAt: '2026-07-30T10:00:00.000Z',
    finishedAt: '2026-07-30T10:01:00.000Z',
  });
  const dependencies: CliDependencies = {
    cwd: 'C:/reviewed/control',
    now: () => new Date('2026-07-31T00:00:00.000Z'),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    async run(input) {
      calls.push(input);
      if (input.executable === 'gh') return { exitCode: 0, stdout: 'gh version 2.95.0 (2026-07-01)\n', stderr: '' };
      return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    },
    client: {
      async getWorkflowRun() { throw new Error('TEST_AUTH_MOCK_MISSING'); },
      async listWorkflowRunArtifacts() { throw new Error('TEST_AUTH_MOCK_MISSING'); },
      async downloadArtifactArchive(artifactId, destinationPath) {
        events.push(`download:${artifactId}:${destinationPath}`);
      },
      async getRepositoryFile() { throw new Error('TEST_AUTH_MOCK_MISSING'); },
    },
    async authenticateBuilderRun() { return false; },
    createPrivateWorkspace() { events.push('workspace'); return workspace; },
    disposePrivateWorkspace(path) { events.push(`cleanup:${path}`); return true; },
    verifyDownloadedArtifact(input) {
      events.push(`digest:${input.archivePath}`);
      return true;
    },
    async extractArchive(input) {
      events.push(`extract:${input.destination}`);
      return { path: 'C:/untrusted/artifact.zip', digest: `sha256:${'c'.repeat(64)}`, sizeBytes: 1 };
    },
    async admit(input) {
      events.push(`admit:${String(input.outputRoot)}`);
      return { schemaVersion: 1 } as PublicBetaCosignToolchainV1;
    },
    expectedLock: () => fixture<JsonRecord>('cosign-builder-lock.v1.fixture.json') as PublicBetaCosignBuilderLockV1,
  };
  return { stdout, stderr, calls, events, workspace, authenticatedRun, dependencies };
}

async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const fn = (admission as CliModule).runPublicBetaCosignAdmissionCli;
  expect(fn).toBeFunction();
  return fn?.(args, dependencies) ?? 1;
}

test('imports without constructing the CLI runner or requiring production dependencies', async () => {
  const imported = await import('./public-beta-cosign-toolchain-admission');
  expect((imported as CliModule).runPublicBetaCosignAdmissionCli).toBeFunction();
});

test('prints help without calling a dependency', async () => {
  const fixture = cliFixture();
  expect(await runCli(['--help'], fixture.dependencies)).toBe(0);
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.events).toEqual([]);
  expect(fixture.stderr).toEqual([]);
  expect(fixture.stdout).toEqual([expect.stringContaining('Usage:')]);
});

test.each([
  [],
  ['--run-id', '101', '--repository', 'maheshenga/openopc'],
  ['--run-id', '101', '--run-id', '102', '--repository', 'maheshenga/openopc', '--output-root', 'C:/out'],
  ['--unknown', 'x', '--run-id', '101', '--repository', 'maheshenga/openopc', '--output-root', 'C:/out'],
  ['--run-id', '01', '--repository', 'maheshenga/openopc', '--output-root', 'C:/out'],
  ['--run-id', '1e2', '--repository', 'maheshenga/openopc', '--output-root', 'C:/out'],
  ['--run-id', '101', '--repository', 'openopc/platform', '--output-root', 'C:/out'],
  ['--run-id', '101', '--repository', 'other/repository', '--output-root', 'C:/out'],
])('rejects closed CLI arguments %#j before any side effect', async (args) => {
  const fixture = cliFixture();
  expect(await runCli(args, fixture.dependencies)).toBe(1);
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.events).toEqual([]);
  expect(fixture.stderr).toEqual(['OPENOPC_COSIGN_ADMISSION_USAGE_INVALID']);
});

test('uses only frozen repository, run, control, workspace, archive, and output inputs', async () => {
  const fixture = cliFixture();
  const admit = fixture.dependencies.admit;
  fixture.dependencies.admit = async (input) => {
    expect(input).toMatchObject({
      authenticatedRun: fixture.authenticatedRun,
      extractedRoot: join(fixture.workspace, 'extracted'),
      outputRoot: 'C:/admitted',
    });
    return admit(input);
  };
  fixture.dependencies.authenticateBuilderRun = async (input: unknown) => {
    expect(input).toEqual({
      client: fixture.dependencies.client,
      expectedRepository: 'maheshenga/openopc',
      expectedControlSha: 'a'.repeat(40),
      runId: '101',
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    return fixture.authenticatedRun;
  };
  expect(await runCli(['--run-id', '101', '--repository', 'maheshenga/openopc', '--output-root', 'C:/admitted'], fixture.dependencies)).toBe(0);
  expect(fixture.calls).toEqual([
    { executable: 'gh', args: ['version'], cwd: 'C:/reviewed/control', timeoutMs: 10_000, maxOutputBytes: 4_096 },
    { executable: 'git', args: ['rev-parse', 'HEAD'], cwd: 'C:/reviewed/control', timeoutMs: 10_000, maxOutputBytes: 4_096 },
  ]);
  expect(fixture.events).toEqual([
    'workspace',
    `download:102:${join(fixture.workspace, 'artifact.zip')}`,
    `digest:${join(fixture.workspace, 'artifact.zip')}`,
    `extract:${join(fixture.workspace, 'extracted')}`,
    'admit:C:/admitted',
    `cleanup:${fixture.workspace}`,
  ]);
  expect(fixture.stderr).toEqual([]);
  expect(fixture.stdout).toEqual(['OPENOPC_COSIGN_ADMISSION_OK']);
});

test.each([
  ['gh version', 'OPENOPC_COSIGN_ADMISSION_GH_VERSION_INVALID', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.run = async () => ({ exitCode: 1, stdout: 'sensitive output', stderr: 'sensitive error' });
  }],
  ['control sha', 'OPENOPC_COSIGN_ADMISSION_CONTROL_SHA_INVALID', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.run = async (input) => input.executable === 'gh'
      ? { exitCode: 0, stdout: 'gh version 2.95.0\n', stderr: '' }
      : { exitCode: 0, stdout: 'not-a-sha\n', stderr: '' };
  }],
  ['authentication', 'OPENOPC_COSIGN_ADMISSION_AUTHENTICATION_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.authenticateBuilderRun = async () => false;
  }],
  ['workspace', 'OPENOPC_COSIGN_ADMISSION_WORKSPACE_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.createPrivateWorkspace = () => false;
  }],
  ['download', 'OPENOPC_COSIGN_ADMISSION_DOWNLOAD_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.client.downloadArtifactArchive = async () => { throw new Error('sensitive download error'); };
  }],
  ['digest', 'OPENOPC_COSIGN_ADMISSION_DIGEST_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.verifyDownloadedArtifact = () => false;
  }],
  ['extraction', 'OPENOPC_COSIGN_ADMISSION_EXTRACTION_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.extractArchive = async () => false;
  }],
  ['admission', 'OPENOPC_COSIGN_ADMISSION_ADMISSION_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.admit = async () => false;
  }],
  ['cleanup', 'OPENOPC_COSIGN_ADMISSION_CLEANUP_FAILED', (fixture: ReturnType<typeof cliFixture>) => {
    fixture.dependencies.disposePrivateWorkspace = () => false;
  }],
])('returns a stable redacted code for %s failure', async (_stage, code, mutate) => {
  const fixture = cliFixture();
  fixture.dependencies.authenticateBuilderRun = async () => fixture.authenticatedRun;
  mutate(fixture);
  expect(await runCli(['--run-id', '101', '--repository', 'maheshenga/openopc', '--output-root', 'C:/admitted'], fixture.dependencies)).toBe(1);
  expect(fixture.stderr).toEqual([code]);
  expect(fixture.stderr.join('\n')).not.toContain('sensitive');
});
