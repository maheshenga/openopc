import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { type PublicBetaArchiveExtraction, authenticateAndExtractPublicBetaArchive } from './public-beta-archive';
import { type PublicBetaSha256Digest, canonicalPublicBetaJson, computeCanonicalPublicBetaDigest, computePublicBetaSha256 } from './public-beta-canonical-json';
import {
  type PublicBetaCosignBuilderLockV1,
  type PublicBetaCosignPlatform,
  type PublicBetaCosignToolSubjectV1,
  type PublicBetaCosignToolchainV1,
  parsePublicBetaCosignBuilderLock,
  parsePublicBetaCosignSlsaPredicate,
  parsePublicBetaCosignToolchain,
} from './public-beta-cosign-toolchain';
import {
  type PublicBetaAuthenticatedToolBuilderRun,
  type PublicBetaGitHubActionsClient,
  authenticatePublicBetaToolBuilderRun,
} from './public-beta-github-actions';
import {
  type PublicBetaNativeDirectory,
  type PublicBetaNativeFile,
  type PublicBetaNativeFilesystem,
  createPublicBetaNativeFilesystem,
} from './public-beta-native-filesystem';
import { readPublicBetaBoundedBytes, readPublicBetaBoundedJson, readPublicBetaVerifiedBytes } from './public-beta-safe-files';

const TOOLCHAIN_DIRECTORY = 'cosign-v3.1.2-openopc.1';
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_GH_OUTPUT_BYTES = 1024 * 1024;
const MAX_SUBJECT_BYTES = 268435456;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER_TEXT = /^[1-9][0-9]*$/;
const ENCODER = new TextEncoder();
const CLI_MAX_OUTPUT_BYTES = 4_096;
const CLI_TIMEOUT_MS = 10_000;
const CLI_CONTROL_SHA = /^[a-f0-9]{40}$/;
const CLI_HELP = 'Usage: public-beta:cosign:admit --run-id <positive-decimal> --repository maheshenga/openopc --output-root <path>';

export interface PublicBetaAttestationCommandRunner {
  run(input: Readonly<{
    executable: 'gh';
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }>): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

export interface PublicBetaCosignAdmissionCliCommand {
  executable: 'gh' | 'git';
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PublicBetaCosignAdmissionCliDependencies {
  cwd: string;
  now: () => Date;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  run: (input: Readonly<PublicBetaCosignAdmissionCliCommand>) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
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
  verifyDownloadedArtifact: (input: Readonly<{
    archivePath: string;
    expectedDigest: PublicBetaSha256Digest;
    expectedSizeBytes: number;
  }>) => boolean;
  extractArchive: (input: Readonly<{
    archivePath: string;
    expectedDigest: PublicBetaSha256Digest;
    expectedSizeBytes: number;
    destination: string;
  }>) => Promise<PublicBetaArchiveExtraction | false>;
  admit: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<PublicBetaCosignToolchainV1> | false>;
  expectedLock: () => Readonly<PublicBetaCosignBuilderLockV1> | false;
}

interface DirectoryIdentity { dev: bigint; ino: bigint }
interface TrustedDirectory { path: string; identity: DirectoryIdentity }
interface VerifiedPredicate { buildContractDigest: PublicBetaSha256Digest; goModuleGraphDigest: PublicBetaSha256Digest }
interface VerifiedSubject extends VerifiedPredicate { bundleBytes: Uint8Array; bundleDigest: PublicBetaSha256Digest; bundleSizeBytes: number }

type JsonRecord = Record<string, unknown>;
type AdmissionInput = Readonly<{
  authenticatedRun: PublicBetaAuthenticatedToolBuilderRun;
  extractedRoot: string;
  outputRoot: string;
  expectedLock: PublicBetaCosignBuilderLockV1;
  runner: PublicBetaAttestationCommandRunner;
}>;
type BoundRunner = (input: Parameters<PublicBetaAttestationCommandRunner['run']>[0]) => ReturnType<PublicBetaAttestationCommandRunner['run']>;

interface AdmissionSnapshot {
  authenticatedRun: Readonly<PublicBetaAuthenticatedToolBuilderRun>;
  extractedRoot: string;
  outputRoot: string;
  expectedLock: PublicBetaCosignBuilderLockV1;
  run: BoundRunner;
}

function exactRecord(value: unknown, keys: readonly string[]): JsonRecord | false {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
  const output: JsonRecord = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
    output[key] = descriptor.value;
  }
  return output;
}

function safeDigest(value: unknown): value is PublicBetaSha256Digest {
  return typeof value === 'string' && SHA256.test(value) && value !== `sha256:${'0'.repeat(64)}`;
}

function identity(path: string): DirectoryIdentity | false {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino } : false;
  } catch { return false; }
}

function trustedDirectory(path: string): TrustedDirectory | false {
  try {
    const absolute = resolve(path);
    const directoryIdentity = identity(absolute);
    if (directoryIdentity === false) return false;
    const real = realpathSync.native(absolute);
    return identity(real) !== false ? { path: absolute, identity: directoryIdentity } : false;
  } catch { return false; }
}

function positiveIntegerText(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_INTEGER_TEXT.test(value) && Number.isSafeInteger(Number(value));
}

function positiveIntegerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  return Number.isFinite(Date.parse(value));
}

function snapshotRun(value: unknown): Readonly<PublicBetaAuthenticatedToolBuilderRun> | false {
  const run = exactRecord(value, ['artifactDigest', 'artifactId', 'artifactSizeBytes', 'controlSha', 'event', 'finishedAt', 'repository', 'runAttempt', 'runId', 'startedAt', 'workflow', 'workflowRef']);
  if (
    !run ||
    run.repository !== 'maheshenga/openopc' ||
    run.workflow !== '.github/workflows/openopc-cosign-builder.yml' ||
    run.workflowRef !== 'refs/heads/main' ||
    run.event !== 'workflow_dispatch' ||
    typeof run.controlSha !== 'string' ||
    !SHA1.test(run.controlSha) ||
    run.controlSha === '0'.repeat(40) ||
    !positiveIntegerText(run.runId) ||
    !positiveIntegerNumber(run.runAttempt) ||
    !positiveIntegerText(run.artifactId) ||
    !safeDigest(run.artifactDigest) ||
    !positiveIntegerNumber(run.artifactSizeBytes) ||
    !validTimestamp(run.startedAt) ||
    !validTimestamp(run.finishedAt) ||
    Date.parse(run.finishedAt) < Date.parse(run.startedAt)
  ) {
    return false;
  }
  return Object.freeze({
    repository: 'maheshenga/openopc',
    workflow: '.github/workflows/openopc-cosign-builder.yml',
    workflowRef: 'refs/heads/main',
    controlSha: run.controlSha,
    runId: run.runId,
    runAttempt: run.runAttempt,
    event: 'workflow_dispatch',
    artifactId: run.artifactId,
    artifactDigest: run.artifactDigest,
    artifactSizeBytes: run.artifactSizeBytes,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}

function snapshotAdmissionInput(input: unknown): AdmissionSnapshot | false {
  const root = exactRecord(input, ['authenticatedRun', 'expectedLock', 'extractedRoot', 'outputRoot', 'runner']);
  if (!root || typeof root.extractedRoot !== 'string' || typeof root.outputRoot !== 'string' || root.extractedRoot.length === 0 || root.outputRoot.length === 0) return false;
  const authenticatedRun = snapshotRun(root.authenticatedRun);
  if (!authenticatedRun || !root.runner || typeof root.runner !== 'object') return false;
  const runDescriptor = Object.getOwnPropertyDescriptor(root.runner, 'run');
  if (!runDescriptor?.enumerable || !('value' in runDescriptor) || typeof runDescriptor.value !== 'function') return false;
  const boundRun = runDescriptor.value.bind(root.runner) as BoundRunner;
  return Object.freeze({
    authenticatedRun,
    extractedRoot: root.extractedRoot,
    outputRoot: root.outputRoot,
    expectedLock: root.expectedLock as PublicBetaCosignBuilderLockV1,
    run: boundRun,
  });
}

function predicateFields(value: unknown): { buildContractDigest: PublicBetaSha256Digest; goModuleGraphDigest: PublicBetaSha256Digest; replayDigest: PublicBetaSha256Digest } | false {
  const root = exactRecord(value, ['buildDefinition', 'runDetails']);
  const definition = root && exactRecord(root.buildDefinition, ['buildType', 'externalParameters', 'internalParameters', 'resolvedDependencies']);
  const parameters = definition && exactRecord(definition.externalParameters, ['buildContainerDigest', 'buildContractDigest', 'goModuleGraphDigest', 'platform', 'replayDigest', 'subjectDigest', 'subjectName', 'subjectSizeBytes', 'upstreamCommitSha', 'upstreamGoVersion', 'upstreamRepository', 'upstreamTag', 'upstreamTagObjectSha', 'upstreamTreeSha', 'workflowSha']);
  return parameters && safeDigest(parameters.buildContractDigest) && safeDigest(parameters.goModuleGraphDigest) && safeDigest(parameters.replayDigest)
    ? { buildContractDigest: parameters.buildContractDigest, goModuleGraphDigest: parameters.goModuleGraphDigest, replayDigest: parameters.replayDigest }
    : false;
}

function parseVerification(stdout: string, subject: Readonly<PublicBetaCosignToolSubjectV1>, platform: PublicBetaCosignPlatform, controlSha: string, lock: Readonly<PublicBetaCosignBuilderLockV1>): VerifiedPredicate | false {
  try {
    if (!stdout || Buffer.byteLength(stdout, 'utf8') > MAX_GH_OUTPUT_BYTES) return false;
    const output = JSON.parse(stdout) as unknown;
    if (!Array.isArray(output) || output.length !== 1) return false;
    const result = exactRecord(output[0], ['certificateIdentity', 'certificateOidcIssuer', 'signerDigest', 'sourceDigest', 'sourceRef', 'statement']);
    if (!result || result.certificateIdentity !== 'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main' || result.certificateOidcIssuer !== 'https://token.actions.githubusercontent.com' || result.signerDigest !== controlSha || result.sourceRef !== 'refs/heads/main' || result.sourceDigest !== controlSha) return false;
    const statement = exactRecord(result.statement, ['_type', 'predicate', 'predicateType', 'subject']);
    if (!statement || statement._type !== 'https://in-toto.io/Statement/v1' || statement.predicateType !== 'https://slsa.dev/provenance/v1' || !Array.isArray(statement.subject) || statement.subject.length !== 1) return false;
    const declaredSubject = exactRecord(statement.subject[0], ['digest', 'name']);
    const declaredDigest = declaredSubject && exactRecord(declaredSubject.digest, ['sha256']);
    if (!declaredSubject || !declaredDigest || declaredSubject.name !== subject.name || declaredDigest.sha256 !== subject.digest.slice('sha256:'.length)) return false;
    const fields = predicateFields(statement.predicate);
    if (!fields || fields.replayDigest !== subject.digest) return false;
    const parsed = parsePublicBetaCosignSlsaPredicate(statement.predicate, {
      workflowSha: controlSha, platform, subjectName: subject.name, subjectDigest: subject.digest, subjectSizeBytes: subject.sizeBytes,
      buildContainerDigest: lock.buildImage.digest, buildContractDigest: fields.buildContractDigest,
      goModuleGraphDigest: fields.goModuleGraphDigest, replayDigest: subject.digest,
    });
    return parsed ? { buildContractDigest: fields.buildContractDigest, goModuleGraphDigest: fields.goModuleGraphDigest } : false;
  } catch { return false; }
}

function readManifest(root: string, run: Readonly<PublicBetaAuthenticatedToolBuilderRun>, lock: Readonly<PublicBetaCosignBuilderLockV1>): Readonly<PublicBetaCosignToolchainV1> | false {
  const input = readPublicBetaBoundedJson({ root, path: 'manifest.json', maxBytes: MAX_MANIFEST_BYTES });
  if (!input) return false;
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(input.file.bytes);
  const toolchain = parsePublicBetaCosignToolchain(input.value);
  if (!toolchain || `${canonicalPublicBetaJson(toolchain)}\n` !== raw || toolchain.builder.workflowSha !== run.controlSha || toolchain.builder.buildContainerDigest !== lock.buildImage.digest || canonicalPublicBetaJson(toolchain.upstream) !== canonicalPublicBetaJson(lock.upstream)) return false;
  return toolchain;
}

function nativeLeafName(path: string): string | false {
  const name = path.split('/').pop();
  return name && name !== '.' && name !== '..' && !name.includes('\\') && !name.includes('/') ? name : false;
}

function readNativeVerifiedFile(filesystem: PublicBetaNativeFilesystem, file: PublicBetaNativeFile, digest: PublicBetaSha256Digest, sizeBytes: number, maxBytes: number): Uint8Array | false {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) return false;
  const bytes = filesystem.readFile(file, maxBytes);
  if (bytes === false || bytes.byteLength !== sizeBytes || computePublicBetaSha256(bytes) !== digest) return false;
  return new Uint8Array(bytes);
}

async function verifySubject(input: {
  filesystem: PublicBetaNativeFilesystem;
  runner: BoundRunner;
  extractedRoot: PublicBetaNativeDirectory;
  extractedRootPath: string;
  subject: Readonly<PublicBetaCosignToolSubjectV1>;
  platform: PublicBetaCosignPlatform;
  controlSha: string;
  lock: Readonly<PublicBetaCosignBuilderLockV1>;
}): Promise<VerifiedSubject | false> {
  const subject = readPublicBetaVerifiedBytes({ root: input.extractedRootPath, path: input.subject.name, digest: input.subject.digest, sizeBytes: input.subject.sizeBytes, maxBytes: MAX_SUBJECT_BYTES });
  const bundle = readPublicBetaBoundedBytes({ root: input.extractedRootPath, path: input.subject.bundlePath, maxBytes: MAX_BUNDLE_BYTES });
  const bundleName = nativeLeafName(input.subject.bundlePath);
  if (!subject || !bundle || bundle.digest !== input.subject.bundleDigest || !bundleName) return false;

  const expectedNames = [input.subject.name, bundleName] as const;
  let workspace: PublicBetaNativeDirectory | false = false;
  let subjectFile: PublicBetaNativeFile | false = false;
  let bundleFile: PublicBetaNativeFile | false = false;
  let result: VerifiedSubject | false = false;
  try {
    workspace = input.filesystem.createPrivateDirectory(input.extractedRoot, 'cosign-verify-');
    if (!workspace) return false;
    subjectFile = input.filesystem.writeExclusiveFile(workspace, input.subject.name, subject.bytes);
    if (!subjectFile) return false;
    bundleFile = input.filesystem.writeExclusiveFile(workspace, bundleName, bundle.bytes);
    if (!bundleFile) return false;
    if (!readNativeVerifiedFile(input.filesystem, subjectFile, input.subject.digest, input.subject.sizeBytes, MAX_SUBJECT_BYTES)) return false;
    if (!readNativeVerifiedFile(input.filesystem, bundleFile, input.subject.bundleDigest, bundle.sizeBytes, MAX_BUNDLE_BYTES)) return false;

    const subjectPath = input.filesystem.childPath(workspace, input.subject.name);
    const bundlePath = input.filesystem.childPath(workspace, bundleName);
    if (!subjectPath || !bundlePath) return false;
    const verification = await input.runner({
      executable: 'gh', cwd: dirname(subjectPath), timeoutMs: 60_000, maxOutputBytes: MAX_GH_OUTPUT_BYTES,
      args: ['attestation', 'verify', subjectPath, '--repo', 'maheshenga/openopc', '--bundle', bundlePath, '--predicate-type', 'https://slsa.dev/provenance/v1', '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com', '--cert-identity', 'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main', '--signer-workflow', 'maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml', '--signer-digest', input.controlSha, '--source-ref', 'refs/heads/main', '--source-digest', input.controlSha, '--format', 'json'],
    });
    if (!verification || verification.exitCode !== 0 || verification.stderr !== '' || Buffer.byteLength(verification.stdout, 'utf8') > MAX_GH_OUTPUT_BYTES) return false;
    const subjectAfter = readNativeVerifiedFile(input.filesystem, subjectFile, input.subject.digest, input.subject.sizeBytes, MAX_SUBJECT_BYTES);
    const bundleAfter = readNativeVerifiedFile(input.filesystem, bundleFile, input.subject.bundleDigest, bundle.sizeBytes, MAX_BUNDLE_BYTES);
    if (!subjectAfter || !bundleAfter) return false;
    const parsed = parseVerification(verification.stdout, input.subject, input.platform, input.controlSha, input.lock);
    result = parsed ? { ...parsed, bundleBytes: bundleAfter, bundleDigest: input.subject.bundleDigest, bundleSizeBytes: bundleAfter.byteLength } : false;
  } catch {
    result = false;
  } finally {
    if (subjectFile && !input.filesystem.closeFile(subjectFile)) result = false;
    if (bundleFile && !input.filesystem.closeFile(bundleFile)) result = false;
    if (workspace) {
      if (input.filesystem.disposeUnpublished(workspace, expectedNames) !== 'removed') result = false;
      if (!input.filesystem.closeDirectory(workspace)) result = false;
    }
  }
  return result;
}

function publishAdmitted(filesystem: PublicBetaNativeFilesystem, outputRoot: PublicBetaNativeDirectory, toolchain: Readonly<PublicBetaCosignToolchainV1>, verified: { linuxAmd64: VerifiedSubject; windowsAmd64: VerifiedSubject }): boolean {
  const manifest = ENCODER.encode(`${canonicalPublicBetaJson(toolchain)}\n`);
  const files = [
    { name: 'toolchain.json', bytes: manifest, digest: computePublicBetaSha256(manifest), maxBytes: MAX_MANIFEST_BYTES },
    { name: 'linux-amd64.jsonl', bytes: verified.linuxAmd64.bundleBytes, digest: verified.linuxAmd64.bundleDigest, maxBytes: MAX_BUNDLE_BYTES },
    { name: 'windows-amd64.jsonl', bytes: verified.windowsAmd64.bundleBytes, digest: verified.windowsAmd64.bundleDigest, maxBytes: MAX_BUNDLE_BYTES },
  ] as const;
  const expectedNames = files.map((file) => file.name);
  let stage: PublicBetaNativeDirectory | false = false;
  let openFile: PublicBetaNativeFile | false = false;
  let published = false;
  let result = false;
  try {
    stage = filesystem.createPrivateDirectory(outputRoot, 'cosign-stage-');
    if (!stage) return false;
    for (const file of files) {
      openFile = filesystem.writeExclusiveFile(stage, file.name, file.bytes);
      if (!openFile) return false;
      if (!readNativeVerifiedFile(filesystem, openFile, file.digest, file.bytes.byteLength, file.maxBytes)) return false;
      if (!filesystem.closeFile(openFile)) return false;
      openFile = false;
    }
    if (!filesystem.exactRegularFiles(stage, expectedNames)) return false;
    if (
      !filesystem.publishNoReplace(
        stage,
        outputRoot,
        TOOLCHAIN_DIRECTORY,
        () => filesystem.exactRegularFiles(stage, expectedNames),
      )
    ) {
      return false;
    }
    published = true;
    result = true;
  } catch {
    result = false;
  } finally {
    if (openFile) filesystem.closeFile(openFile);
    if (stage && !published) filesystem.disposeUnpublished(stage, expectedNames);
    if (stage) filesystem.closeDirectory(stage);
  }
  return result;
}

export async function admitPublicBetaCosignToolchain(input: AdmissionInput): Promise<Readonly<PublicBetaCosignToolchainV1> | false> {
  return admitPublicBetaCosignToolchainWithDependencies(input, { filesystem: createPublicBetaNativeFilesystem() });
}

export async function admitPublicBetaCosignToolchainWithDependencies(
  input: AdmissionInput,
  dependencies: Readonly<{ filesystem: PublicBetaNativeFilesystem }>,
): Promise<Readonly<PublicBetaCosignToolchainV1> | false> {
  let extractedNative: PublicBetaNativeDirectory | false = false;
  let outputNative: PublicBetaNativeDirectory | false = false;
  try {
    const snapshot = snapshotAdmissionInput(input);
    if (!snapshot || !dependencies.filesystem) return false;
    const lock = parsePublicBetaCosignBuilderLock(snapshot.expectedLock);
    const extracted = trustedDirectory(snapshot.extractedRoot);
    const outputRoot = trustedDirectory(snapshot.outputRoot);
    if (!lock || !extracted || !outputRoot) return false;
    extractedNative = dependencies.filesystem.openDirectory(extracted.path);
    outputNative = dependencies.filesystem.openDirectory(outputRoot.path);
    if (!extractedNative || !outputNative) return false;
    const toolchain = readManifest(extracted.path, snapshot.authenticatedRun, lock);
    if (!toolchain) return false;
    const linux = await verifySubject({ filesystem: dependencies.filesystem, runner: snapshot.run, extractedRoot: extractedNative, extractedRootPath: extracted.path, subject: toolchain.artifacts.linuxAmd64, platform: 'linuxAmd64', controlSha: snapshot.authenticatedRun.controlSha, lock });
    if (!linux || linux.goModuleGraphDigest !== toolchain.builder.goModuleGraphDigest) return false;
    const windows = await verifySubject({ filesystem: dependencies.filesystem, runner: snapshot.run, extractedRoot: extractedNative, extractedRootPath: extracted.path, subject: toolchain.artifacts.windowsAmd64, platform: 'windowsAmd64', controlSha: snapshot.authenticatedRun.controlSha, lock });
    if (!windows || windows.goModuleGraphDigest !== toolchain.builder.goModuleGraphDigest || computeCanonicalPublicBetaDigest({ linuxAmd64: linux.buildContractDigest, windowsAmd64: windows.buildContractDigest }) !== toolchain.builder.buildContractDigest) return false;
    return publishAdmitted(dependencies.filesystem, outputNative, toolchain, { linuxAmd64: linux, windowsAmd64: windows }) ? toolchain : false;
  } catch {
    return false;
  } finally {
    if (outputNative) dependencies.filesystem.closeDirectory(outputNative);
    if (extractedNative) dependencies.filesystem.closeDirectory(extractedNative);
  }
}

type CliArguments = Readonly<{ runId: string; outputRoot: string }>;
const CLI_ABORT = Symbol('openopc-cosign-admission-cli-abort');

function parseCliArguments(args: readonly string[]): CliArguments | 'help' | false {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return 'help';
  if (args.length !== 6) return false;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag !== '--run-id' && flag !== '--repository' && flag !== '--output-root') ||
      typeof value !== 'string' ||
      values.has(flag)
    ) {
      return false;
    }
    values.set(flag, value);
  }
  const runId = values.get('--run-id');
  const repository = values.get('--repository');
  const outputRoot = values.get('--output-root');
  return runId && positiveIntegerText(runId) && repository === 'maheshenga/openopc' && outputRoot && !/[\0\r\n]/.test(outputRoot)
    ? Object.freeze({ runId, outputRoot })
    : false;
}

function processSucceeded(
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
  maxOutputBytes: number,
): boolean {
  return (
    result.exitCode === 0 &&
    result.stderr === '' &&
    Buffer.byteLength(result.stdout, 'utf8') <= maxOutputBytes &&
    Buffer.byteLength(result.stderr, 'utf8') <= maxOutputBytes
  );
}

function oneOutputLine(value: string): string | false {
  const lines = value.split('\n');
  return lines.length === 2 && lines[1] === '' && lines[0] !== '' && !lines[0]?.includes('\r')
    ? lines[0] ?? false
    : false;
}

export async function runPublicBetaCosignAdmissionCli(
  args: readonly string[],
  dependencies: Readonly<PublicBetaCosignAdmissionCliDependencies>,
): Promise<number> {
  const parsed = parseCliArguments(args);
  if (parsed === 'help') {
    dependencies.stdout(CLI_HELP);
    return 0;
  }
  const fail = (code: string): number => {
    dependencies.stderr(code);
    return 1;
  };
  if (!parsed) return fail('OPENOPC_COSIGN_ADMISSION_USAGE_INVALID');

  let workspace: string | false = false;
  let failure: string | false = false;
  try {
    const ghVersion = await dependencies.run({
      executable: 'gh',
      args: ['version'],
      cwd: dependencies.cwd,
      timeoutMs: CLI_TIMEOUT_MS,
      maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
    });
    if (!processSucceeded(ghVersion, CLI_MAX_OUTPUT_BYTES) || !/^gh version 2\.95\.0(?:\s|$)/.test(ghVersion.stdout)) {
      failure = 'OPENOPC_COSIGN_ADMISSION_GH_VERSION_INVALID';
      throw CLI_ABORT;
    }
    const control = await dependencies.run({
      executable: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: dependencies.cwd,
      timeoutMs: CLI_TIMEOUT_MS,
      maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
    });
    const controlSha = processSucceeded(control, CLI_MAX_OUTPUT_BYTES) ? oneOutputLine(control.stdout) : false;
    if (!controlSha || !CLI_CONTROL_SHA.test(controlSha)) {
      failure = 'OPENOPC_COSIGN_ADMISSION_CONTROL_SHA_INVALID';
      throw CLI_ABORT;
    }
    const authenticatedRun = await dependencies.authenticateBuilderRun({
      client: dependencies.client,
      expectedRepository: 'maheshenga/openopc',
      expectedControlSha: controlSha,
      runId: parsed.runId,
      now: dependencies.now(),
    });
    if (!authenticatedRun) {
      failure = 'OPENOPC_COSIGN_ADMISSION_AUTHENTICATION_FAILED';
      throw CLI_ABORT;
    }
    const lock = dependencies.expectedLock();
    if (!lock) {
      failure = 'OPENOPC_COSIGN_ADMISSION_ADMISSION_FAILED';
      throw CLI_ABORT;
    }
    workspace = dependencies.createPrivateWorkspace();
    if (!workspace) {
      failure = 'OPENOPC_COSIGN_ADMISSION_WORKSPACE_FAILED';
      throw CLI_ABORT;
    }
    const archivePath = join(workspace, 'artifact.zip');
    const extractionDestination = join(workspace, 'extracted');
    try {
      await dependencies.client.downloadArtifactArchive(authenticatedRun.artifactId, archivePath);
    } catch {
      failure = 'OPENOPC_COSIGN_ADMISSION_DOWNLOAD_FAILED';
      throw CLI_ABORT;
    }
    if (!dependencies.verifyDownloadedArtifact({
      archivePath,
      expectedDigest: authenticatedRun.artifactDigest,
      expectedSizeBytes: authenticatedRun.artifactSizeBytes,
    })) {
      failure = 'OPENOPC_COSIGN_ADMISSION_DIGEST_FAILED';
      throw CLI_ABORT;
    }
    const extraction = await dependencies.extractArchive({
      archivePath,
      expectedDigest: authenticatedRun.artifactDigest,
      expectedSizeBytes: authenticatedRun.artifactSizeBytes,
      destination: extractionDestination,
    });
    if (!extraction) {
      failure = 'OPENOPC_COSIGN_ADMISSION_EXTRACTION_FAILED';
      throw CLI_ABORT;
    }
    const admitted = await dependencies.admit({
      authenticatedRun,
      extractedRoot: extractionDestination,
      outputRoot: parsed.outputRoot,
      expectedLock: lock,
      runner: { run: async (input) => dependencies.run(input) },
    });
    if (!admitted) {
      failure = 'OPENOPC_COSIGN_ADMISSION_ADMISSION_FAILED';
      throw CLI_ABORT;
    }
  } catch (error) {
    if (error !== CLI_ABORT) failure = 'OPENOPC_COSIGN_ADMISSION_INTERNAL_FAILED';
  } finally {
    if (workspace && !dependencies.disposePrivateWorkspace(workspace)) {
      failure = 'OPENOPC_COSIGN_ADMISSION_CLEANUP_FAILED';
    }
  }
  if (failure) return fail(failure);
  dependencies.stdout('OPENOPC_COSIGN_ADMISSION_OK');
  return 0;
}

async function runProductionCliProcess(
  input: Readonly<PublicBetaCosignAdmissionCliCommand>,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn([input.executable, ...input.args], {
    cwd: input.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: input.timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedProcessOutput(child.stdout, input.maxOutputBytes, () => child.kill()),
    readBoundedProcessOutput(child.stderr, input.maxOutputBytes, () => child.kill()),
    child.exited,
  ]);
  return stdout === false || stderr === false ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode, stdout, stderr };
}

async function readBoundedProcessOutput(
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number,
  onLimit: () => void,
): Promise<string | false> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
      size += next.value.byteLength;
      if (size > maxOutputBytes) {
        onLimit();
        return false;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function productionGitHubActionsClient(
  cwd: string,
  run: PublicBetaCosignAdmissionCliDependencies['run'],
): PublicBetaGitHubActionsClient {
  const api = async (args: readonly string[]): Promise<unknown> => {
    const result = await run({ executable: 'gh', args: ['api', ...args], cwd, timeoutMs: CLI_TIMEOUT_MS, maxOutputBytes: MAX_GH_OUTPUT_BYTES });
    if (!processSucceeded(result, MAX_GH_OUTPUT_BYTES)) throw new Error('OPENOPC_COSIGN_ADMISSION_GH_API_FAILED');
    return JSON.parse(result.stdout) as unknown;
  };
  return {
    getWorkflowRun: (runId) => api([`repos/maheshenga/openopc/actions/runs/${runId}`]),
    async listWorkflowRunArtifacts(runId) {
      const output = await api([`repos/maheshenga/openopc/actions/runs/${runId}/artifacts`, '--paginate', '--slurp']);
      if (!Array.isArray(output)) return [];
      const artifacts: unknown[] = [];
      for (const page of output) {
        if (!page || typeof page !== 'object' || !Array.isArray((page as { artifacts?: unknown }).artifacts)) return [];
        artifacts.push(...(page as { artifacts: readonly unknown[] }).artifacts);
      }
      return artifacts;
    },
    async downloadArtifactArchive(artifactId, destinationPath) {
      const result = await run({
        executable: 'gh',
        args: ['api', `repos/maheshenga/openopc/actions/artifacts/${artifactId}/zip`, '--output', destinationPath],
        cwd,
        timeoutMs: 60_000,
        maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
      });
      if (!processSucceeded(result, CLI_MAX_OUTPUT_BYTES)) throw new Error('OPENOPC_COSIGN_ADMISSION_DOWNLOAD_FAILED');
    },
    async getRepositoryFile(path, ref) {
      const output = await api([`repos/maheshenga/openopc/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`]);
      const content = output && typeof output === 'object' ? (output as { content?: unknown }).content : false;
      if (typeof content !== 'string') throw new Error('OPENOPC_COSIGN_ADMISSION_GH_CONTENT_FAILED');
      return new Uint8Array(Buffer.from(content.replaceAll('\n', ''), 'base64'));
    },
  };
}

function productionAdmissionDependencies(): PublicBetaCosignAdmissionCliDependencies {
  const cwd = process.cwd();
  const run = runProductionCliProcess;
  const ownedWorkspaces = new Map<string, DirectoryIdentity>();
  return {
    cwd,
    now: () => new Date(),
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
    run,
    client: productionGitHubActionsClient(cwd, run),
    authenticateBuilderRun: authenticatePublicBetaToolBuilderRun,
    createPrivateWorkspace() {
      try {
        const workspace = mkdtempSync(join(tmpdir(), 'openopc-cosign-admission-'));
        const workspaceIdentity = identity(workspace);
        if (!workspaceIdentity) return false;
        ownedWorkspaces.set(workspace, workspaceIdentity);
        return workspace;
      } catch { return false; }
    },
    disposePrivateWorkspace(workspace) {
      try {
        const expected = ownedWorkspaces.get(workspace);
        const current = identity(workspace);
        if (!expected || !current || expected.dev !== current.dev || expected.ino !== current.ino) return false;
        ownedWorkspaces.delete(workspace);
        return true;
      } catch { return false; }
    },
    verifyDownloadedArtifact(input) {
      try {
        const stats = lstatSync(input.archivePath);
        const bytes = readFileSync(input.archivePath);
        return stats.isFile() && !stats.isSymbolicLink() && bytes.byteLength === input.expectedSizeBytes && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === input.expectedDigest;
      } catch { return false; }
    },
    extractArchive: authenticateAndExtractPublicBetaArchive,
    async admit(input) {
      return admitPublicBetaCosignToolchain(input as AdmissionInput);
    },
    expectedLock() {
      try {
        const raw = JSON.parse(readFileSync(resolve(import.meta.dir, 'public-beta-trust/cosign-builder-lock.v1.json'), 'utf8')) as unknown;
        return parsePublicBetaCosignBuilderLock(raw);
      } catch { return false; }
    },
  };
}

if (import.meta.main) {
  process.exitCode = await runPublicBetaCosignAdmissionCli(process.argv.slice(2), productionAdmissionDependencies());
}
