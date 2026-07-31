import {
  type PublicBetaJson,
  type PublicBetaSha256Digest,
  computeCanonicalPublicBetaDigest,
} from './public-beta-canonical-json';

export type PublicBetaCosignPlatform = 'linuxAmd64' | 'windowsAmd64';

export interface PublicBetaCosignBuilderLockV1 {
  schemaVersion: 1;
  toolchainId: 'openopc-cosign-v3.1.2.1';
  upstream: {
    repository: 'sigstore/cosign';
    tag: 'v3.1.2';
    tagObjectSha: 'dc80df70da727f4abdd843640594025584a270ae';
    commitSha: '193d2153431f8bb0d945a4c1ee721872f73add67';
    treeSha: '6647db468973d11edb5e737293fcf4b05c69a84a';
    goVersion: '1.26.0';
  };
  buildImage: { reference: 'golang:1.26.0-bookworm'; digest: PublicBetaSha256Digest };
  actions: {
    checkout: '3d3c42e5aac5ba805825da76410c181273ba90b1';
    uploadArtifact: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
    downloadArtifact: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
    attest: '508db95dd578ae2727ebd6217d5ba78e4fbda05d';
    setupBun: '0c5077e51419868618aeaa5fe8019c62421857d6';
  };
  targets: readonly ['linuxAmd64', 'windowsAmd64'];
}

export interface PublicBetaCosignToolSubjectV1 {
  name: 'cosign-linux-amd64' | 'cosign-windows-amd64.exe';
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  releaseTag: 'openopc-cosign-v3.1.2.1';
  releaseAssetId: string;
  bundlePath: string;
  bundleDigest: PublicBetaSha256Digest;
  predicateType: 'https://slsa.dev/provenance/v1';
}

export interface PublicBetaCosignToolchainV1 {
  schemaVersion: 1;
  toolchainId: 'openopc-cosign-v3.1.2.1';
  upstream: PublicBetaCosignBuilderLockV1['upstream'];
  builder: {
    oidcIssuer: 'https://token.actions.githubusercontent.com';
    repository: 'openopc/platform';
    workflowPath: '.github/workflows/openopc-cosign-builder.yml';
    workflowRef: 'refs/heads/main';
    workflowSha: string;
    certificateIdentity: ReturnType<typeof canonicalPublicBetaCosignBuilderIdentity>;
    trigger: 'workflow_dispatch';
    buildContainerDigest: PublicBetaSha256Digest;
    buildContractDigest: PublicBetaSha256Digest;
    goModuleGraphDigest: PublicBetaSha256Digest;
  };
  artifacts: { linuxAmd64: PublicBetaCosignToolSubjectV1; windowsAmd64: PublicBetaCosignToolSubjectV1 };
}

export interface PublicBetaCosignPredicateExpectation {
  workflowSha: string;
  platform: PublicBetaCosignPlatform;
  subjectName: PublicBetaCosignToolSubjectV1['name'];
  subjectDigest: PublicBetaSha256Digest;
  subjectSizeBytes: number;
  buildContainerDigest: PublicBetaSha256Digest;
  buildContractDigest: PublicBetaSha256Digest;
  goModuleGraphDigest: PublicBetaSha256Digest;
  replayDigest: PublicBetaSha256Digest;
}

export interface PublicBetaCosignSlsaPredicateV1 {
  buildDefinition: {
    buildType: 'https://openopc.dev/buildtypes/cosign/v1';
    externalParameters: Readonly<Record<string, PublicBetaJson>>;
    internalParameters: Readonly<Record<string, never>>;
    resolvedDependencies: readonly Readonly<{ uri: string; digest: Readonly<Record<string, string>> }>[];
  };
  runDetails: {
    builder: { id: ReturnType<typeof canonicalPublicBetaCosignBuilderIdentity> };
    metadata: { invocationId: string; startedOn: string; finishedOn: string };
  };
}

const TOOLCHAIN_ID = 'openopc-cosign-v3.1.2.1' as const;
const BUILDER_IDENTITY =
  'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main' as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_SUBJECT_BYTES = 268435456;

const UPSTREAM = Object.freeze({
  repository: 'sigstore/cosign',
  tag: 'v3.1.2',
  tagObjectSha: 'dc80df70da727f4abdd843640594025584a270ae',
  commitSha: '193d2153431f8bb0d945a4c1ee721872f73add67',
  treeSha: '6647db468973d11edb5e737293fcf4b05c69a84a',
  goVersion: '1.26.0',
} as const);

type RecordValue = Record<string, unknown>;

function exactRecord(value: unknown, expectedKeys: readonly string[]): RecordValue | false {
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
  const keys = [...expectedKeys].sort();
  if (names.length !== keys.length || names.some((name, index) => name !== keys[index])) return false;
  const snapshot: RecordValue = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactArray(value: unknown, expected: readonly string[]): boolean {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length !== expected.length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    return false;
  }
  return expected.every((item, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor?.enumerable && 'value' in descriptor && descriptor.value === item;
  });
}

function singleValueArray(value: unknown): unknown | false {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length !== 1 ||
    Object.getOwnPropertyNames(value).length !== 2
  ) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, '0');
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : false;
}

function validDigest(value: unknown): value is PublicBetaSha256Digest {
  return typeof value === 'string' && SHA256.test(value) && value !== `sha256:${'0'.repeat(64)}`;
}

function validSha1(value: unknown): value is string {
  return typeof value === 'string' && SHA1.test(value) && value !== '0'.repeat(40);
}

function parseUpstream(value: unknown): PublicBetaCosignBuilderLockV1['upstream'] | false {
  const record = exactRecord(value, Object.keys(UPSTREAM));
  if (!record || Object.keys(UPSTREAM).some((key) => record[key] !== UPSTREAM[key as keyof typeof UPSTREAM])) {
    return false;
  }
  return Object.freeze({ ...UPSTREAM });
}

function parseSubject(value: unknown, platform: PublicBetaCosignPlatform): PublicBetaCosignToolSubjectV1 | false {
  const record = exactRecord(value, [
    'bundleDigest',
    'bundlePath',
    'digest',
    'name',
    'predicateType',
    'releaseAssetId',
    'releaseTag',
    'sizeBytes',
  ]);
  const name = platform === 'linuxAmd64' ? 'cosign-linux-amd64' : 'cosign-windows-amd64.exe';
  const bundlePath = `cosign-v3.1.2-openopc.1/${platform === 'linuxAmd64' ? 'linux-amd64' : 'windows-amd64'}.jsonl`;
  if (
    !record ||
    record.name !== name ||
    !validDigest(record.digest) ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 1 ||
    record.sizeBytes > MAX_SUBJECT_BYTES ||
    record.releaseTag !== TOOLCHAIN_ID ||
    typeof record.releaseAssetId !== 'string' ||
    !/^[1-9][0-9]*$/.test(record.releaseAssetId) ||
    record.bundlePath !== bundlePath ||
    !validDigest(record.bundleDigest) ||
    record.predicateType !== 'https://slsa.dev/provenance/v1'
  ) {
    return false;
  }
  return Object.freeze({
    name,
    digest: record.digest,
    sizeBytes: record.sizeBytes,
    releaseTag: TOOLCHAIN_ID,
    releaseAssetId: record.releaseAssetId,
    bundlePath,
    bundleDigest: record.bundleDigest,
    predicateType: 'https://slsa.dev/provenance/v1',
  });
}

export function canonicalPublicBetaCosignBuilderIdentity(): typeof BUILDER_IDENTITY {
  return BUILDER_IDENTITY;
}

export function parsePublicBetaCosignBuilderLock(
  value: unknown,
): Readonly<PublicBetaCosignBuilderLockV1> | false {
  try {
    const record = exactRecord(value, ['actions', 'buildImage', 'schemaVersion', 'targets', 'toolchainId', 'upstream']);
    if (!record || record.schemaVersion !== 1 || record.toolchainId !== TOOLCHAIN_ID || !exactArray(record.targets, ['linuxAmd64', 'windowsAmd64'])) return false;
    const upstream = parseUpstream(record.upstream);
    const image = exactRecord(record.buildImage, ['digest', 'reference']);
    const actions = exactRecord(record.actions, ['attest', 'checkout', 'downloadArtifact', 'setupBun', 'uploadArtifact']);
    if (
      !upstream ||
      !image || image.reference !== 'golang:1.26.0-bookworm' || !validDigest(image.digest) ||
      !actions ||
      actions.checkout !== '3d3c42e5aac5ba805825da76410c181273ba90b1' ||
      actions.uploadArtifact !== '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' ||
      actions.downloadArtifact !== '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c' ||
      actions.attest !== '508db95dd578ae2727ebd6217d5ba78e4fbda05d' ||
      actions.setupBun !== '0c5077e51419868618aeaa5fe8019c62421857d6'
    ) return false;
    return Object.freeze({
      schemaVersion: 1,
      toolchainId: TOOLCHAIN_ID,
      upstream,
      buildImage: Object.freeze({ reference: image.reference, digest: image.digest }),
      actions: Object.freeze({ ...actions }) as PublicBetaCosignBuilderLockV1['actions'],
      targets: Object.freeze(['linuxAmd64', 'windowsAmd64']) as PublicBetaCosignBuilderLockV1['targets'],
    });
  } catch {
    return false;
  }
}

export function parsePublicBetaCosignToolchain(
  value: unknown,
): Readonly<PublicBetaCosignToolchainV1> | false {
  try {
    const record = exactRecord(value, ['artifacts', 'builder', 'schemaVersion', 'toolchainId', 'upstream']);
    if (!record || record.schemaVersion !== 1 || record.toolchainId !== TOOLCHAIN_ID) return false;
    const upstream = parseUpstream(record.upstream);
    const builder = exactRecord(record.builder, ['buildContainerDigest', 'buildContractDigest', 'certificateIdentity', 'goModuleGraphDigest', 'oidcIssuer', 'repository', 'trigger', 'workflowPath', 'workflowRef', 'workflowSha']);
    const artifacts = exactRecord(record.artifacts, ['linuxAmd64', 'windowsAmd64']);
    const linuxAmd64 = artifacts && parseSubject(artifacts.linuxAmd64, 'linuxAmd64');
    const windowsAmd64 = artifacts && parseSubject(artifacts.windowsAmd64, 'windowsAmd64');
    if (
      !upstream || !builder || !artifacts || !linuxAmd64 || !windowsAmd64 ||
      builder.oidcIssuer !== 'https://token.actions.githubusercontent.com' ||
      builder.repository !== 'openopc/platform' ||
      builder.workflowPath !== '.github/workflows/openopc-cosign-builder.yml' ||
      builder.workflowRef !== 'refs/heads/main' ||
      !validSha1(builder.workflowSha) ||
      builder.certificateIdentity !== BUILDER_IDENTITY ||
      builder.trigger !== 'workflow_dispatch' ||
      !validDigest(builder.buildContainerDigest) ||
      !validDigest(builder.buildContractDigest) ||
      !validDigest(builder.goModuleGraphDigest) ||
      linuxAmd64.digest === windowsAmd64.digest
    ) return false;
    return Object.freeze({
      schemaVersion: 1,
      toolchainId: TOOLCHAIN_ID,
      upstream,
      builder: Object.freeze({ ...builder }) as PublicBetaCosignToolchainV1['builder'],
      artifacts: Object.freeze({ linuxAmd64, windowsAmd64 }),
    });
  } catch {
    return false;
  }
}

export function computePublicBetaCosignToolchainDigest(value: unknown): PublicBetaSha256Digest | false {
  const parsed = parsePublicBetaCosignToolchain(value);
  return parsed ? computeCanonicalPublicBetaDigest(parsed) : false;
}

export function selectPublicBetaCosignToolSubject(
  toolchain: Readonly<PublicBetaCosignToolchainV1>,
  platform: PublicBetaCosignPlatform,
): Readonly<PublicBetaCosignToolSubjectV1> {
  return toolchain.artifacts[platform];
}

function validRfc3339(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function parsePublicBetaCosignSlsaPredicate(
  value: unknown,
  expected: Readonly<PublicBetaCosignPredicateExpectation>,
): Readonly<PublicBetaCosignSlsaPredicateV1> | false {
  try {
    const expectedRecord = exactRecord(expected, ['buildContainerDigest', 'buildContractDigest', 'goModuleGraphDigest', 'platform', 'replayDigest', 'subjectDigest', 'subjectName', 'subjectSizeBytes', 'workflowSha']);
    const root = exactRecord(value, ['buildDefinition', 'runDetails']);
    if (!expectedRecord || !root || (expectedRecord.platform !== 'linuxAmd64' && expectedRecord.platform !== 'windowsAmd64') || !validSha1(expectedRecord.workflowSha) || !validDigest(expectedRecord.subjectDigest) || !validDigest(expectedRecord.buildContainerDigest) || !validDigest(expectedRecord.buildContractDigest) || !validDigest(expectedRecord.goModuleGraphDigest) || !validDigest(expectedRecord.replayDigest) || !Number.isSafeInteger(expectedRecord.subjectSizeBytes) || expectedRecord.subjectSizeBytes < 1 || expectedRecord.subjectSizeBytes > MAX_SUBJECT_BYTES) return false;
    const buildDefinition = exactRecord(root.buildDefinition, ['buildType', 'externalParameters', 'internalParameters', 'resolvedDependencies']);
    const runDetails = exactRecord(root.runDetails, ['builder', 'metadata']);
    const builder = runDetails && exactRecord(runDetails.builder, ['id']);
    const metadata = runDetails && exactRecord(runDetails.metadata, ['finishedOn', 'invocationId', 'startedOn']);
    const parameters = buildDefinition && exactRecord(buildDefinition.externalParameters, ['buildContainerDigest', 'buildContractDigest', 'goModuleGraphDigest', 'platform', 'replayDigest', 'subjectDigest', 'subjectName', 'subjectSizeBytes', 'upstreamCommitSha', 'upstreamGoVersion', 'upstreamRepository', 'upstreamTag', 'upstreamTagObjectSha', 'upstreamTreeSha', 'workflowSha']);
    const internal = buildDefinition && exactRecord(buildDefinition.internalParameters, []);
    if (!buildDefinition || !runDetails || !builder || !metadata || !parameters || !internal || buildDefinition.buildType !== 'https://openopc.dev/buildtypes/cosign/v1' || builder.id !== BUILDER_IDENTITY || typeof metadata.invocationId !== 'string' || !metadata.invocationId || metadata.invocationId.length > 512 || !validRfc3339(metadata.startedOn) || !validRfc3339(metadata.finishedOn) || Date.parse(metadata.startedOn) > Date.parse(metadata.finishedOn)) return false;
    if (
      parameters.workflowSha !== expectedRecord.workflowSha || parameters.platform !== expectedRecord.platform ||
      parameters.subjectName !== expectedRecord.subjectName || parameters.subjectDigest !== expectedRecord.subjectDigest ||
      parameters.subjectSizeBytes !== expectedRecord.subjectSizeBytes || parameters.buildContainerDigest !== expectedRecord.buildContainerDigest ||
      parameters.buildContractDigest !== expectedRecord.buildContractDigest || parameters.goModuleGraphDigest !== expectedRecord.goModuleGraphDigest ||
      parameters.replayDigest !== expectedRecord.replayDigest || parameters.upstreamRepository !== UPSTREAM.repository ||
      parameters.upstreamTag !== UPSTREAM.tag || parameters.upstreamTagObjectSha !== UPSTREAM.tagObjectSha ||
      parameters.upstreamCommitSha !== UPSTREAM.commitSha || parameters.upstreamTreeSha !== UPSTREAM.treeSha ||
      parameters.upstreamGoVersion !== UPSTREAM.goVersion ||
      (expectedRecord.platform === 'linuxAmd64' ? expectedRecord.subjectName !== 'cosign-linux-amd64' : expectedRecord.subjectName !== 'cosign-windows-amd64.exe')
    ) return false;
    const dependencyValue = singleValueArray(buildDefinition.resolvedDependencies);
    if (!dependencyValue) return false;
    const dependency = exactRecord(dependencyValue, ['digest', 'uri']);
    const dependencyDigest = dependency && exactRecord(dependency.digest, ['gitTree', 'sha1']);
    if (!dependency || !dependencyDigest || dependency.uri !== 'git+https://github.com/sigstore/cosign@refs/tags/v3.1.2' || dependencyDigest.sha1 !== UPSTREAM.commitSha || dependencyDigest.gitTree !== UPSTREAM.treeSha) return false;
    const frozenParameters = Object.freeze({ ...parameters }) as Readonly<Record<string, PublicBetaJson>>;
    return Object.freeze({
      buildDefinition: Object.freeze({
        buildType: 'https://openopc.dev/buildtypes/cosign/v1',
        externalParameters: frozenParameters,
        internalParameters: Object.freeze({}),
        resolvedDependencies: Object.freeze([Object.freeze({ uri: dependency.uri, digest: Object.freeze({ ...dependencyDigest }) })]),
      }),
      runDetails: Object.freeze({
        builder: Object.freeze({ id: BUILDER_IDENTITY }),
        metadata: Object.freeze({ ...metadata }) as PublicBetaCosignSlsaPredicateV1['runDetails']['metadata'],
      }),
    });
  } catch {
    return false;
  }
}
