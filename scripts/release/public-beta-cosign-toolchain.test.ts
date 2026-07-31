import { expect, test } from 'bun:test';

import { computeCanonicalPublicBetaDigest } from './public-beta-canonical-json';
import {
  canonicalPublicBetaCosignBuilderIdentity,
  computePublicBetaCosignToolchainDigest,
  parsePublicBetaCosignBuilderLock,
  parsePublicBetaCosignSlsaPredicate,
  parsePublicBetaCosignToolchain,
  selectPublicBetaCosignToolSubject,
} from './public-beta-cosign-toolchain';

const fixture = <T>(name: string) => Bun.file(`tests/public-beta/${name}`).json() as Promise<T>;

const digest = (character: string) => `sha256:${character.repeat(64)}`;
type MutableRecord = Record<string, unknown>;

function predicateExpectation(overrides: MutableRecord = {}): MutableRecord {
  return {
    workflowSha: 'a'.repeat(40),
    platform: 'linuxAmd64',
    subjectName: 'cosign-linux-amd64',
    subjectDigest: digest('1'),
    subjectSizeBytes: 1024,
    buildContainerDigest: digest('2'),
    buildContractDigest: digest('3'),
    goModuleGraphDigest: digest('4'),
    replayDigest: digest('1'),
    ...overrides,
  };
}

function record(value: unknown): MutableRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture must be an object');
  }
  return value as MutableRecord;
}

function expectClosedObjectSchema(schema: unknown, required: readonly string[]): MutableRecord {
  const object = record(schema);
  expect(object.type).toBe('object');
  expect(object.additionalProperties).toBe(false);
  expect(object.required).toEqual(required);
  expect(Object.keys(record(object.properties))).toEqual(required);
  return object;
}

function expectDigestPattern(properties: MutableRecord, keys: readonly string[]): void {
  for (const key of keys) {
    expect(record(properties[key])).toEqual({
      type: 'string',
      pattern: '^sha256:(?!0{64}$)[a-f0-9]{64}$',
    });
  }
}

test('pins the exact upstream source and derives the builder identity', async () => {
  const lock = parsePublicBetaCosignBuilderLock(await fixture('cosign-builder-lock.v1.fixture.json'));

  expect(lock).not.toBe(false);
  if (lock === false) throw new Error('fixture builder lock must parse');
  expect(lock.upstream).toEqual({
    repository: 'sigstore/cosign',
    tag: 'v3.1.2',
    tagObjectSha: 'dc80df70da727f4abdd843640594025584a270ae',
    commitSha: '193d2153431f8bb0d945a4c1ee721872f73add67',
    treeSha: '6647db468973d11edb5e737293fcf4b05c69a84a',
    goVersion: '1.26.0',
  });
  expect(canonicalPublicBetaCosignBuilderIdentity()).toBe(
    'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main',
  );
  expect(Object.isFrozen(lock)).toBe(true);
  expect(Object.isFrozen(lock.upstream)).toBe(true);
});

test('enforces key-to-name platform mapping and returns the fixed subject', async () => {
  const manifest = record(await fixture('cosign-toolchain.v1.fixture.json'));
  const artifacts = record(manifest.artifacts);
  record(artifacts.linuxAmd64).name = 'cosign-windows-amd64.exe';
  record(artifacts.windowsAmd64).name = 'cosign-linux-amd64';
  expect(parsePublicBetaCosignToolchain(manifest)).toBe(false);

  const parsed = parsePublicBetaCosignToolchain(
    await fixture('cosign-toolchain.v1.fixture.json'),
  );
  expect(parsed).not.toBe(false);
  if (parsed === false) throw new Error('fixture toolchain must parse');
  expect(selectPublicBetaCosignToolSubject(parsed, 'linuxAmd64').name).toBe(
    'cosign-linux-amd64',
  );
  expect(selectPublicBetaCosignToolSubject(parsed, 'windowsAmd64').name).toBe(
    'cosign-windows-amd64.exe',
  );
});

test.each([
  ['unknown key', (value: MutableRecord) => { value.extra = true; }],
  ['wrong source repository', (value: MutableRecord) => { record(value.upstream).repository = 'fork/cosign'; }],
  ['mutable action tag', (value: MutableRecord) => { record(value.actions).checkout = 'v4'; }],
  ['non-64-hex image digest', (value: MutableRecord) => { record(value.buildImage).digest = 'sha256:abc'; }],
  ['zero image digest', (value: MutableRecord) => { record(value.buildImage).digest = digest('0'); }],
  ['wrong action commit', (value: MutableRecord) => { record(value.actions).attest = 'a'.repeat(40); }],
  ['wrong target order', (value: MutableRecord) => { value.targets = ['windowsAmd64', 'linuxAmd64']; }],
])('rejects builder-lock %s', async (_name, mutate) => {
  const lock = record(await fixture('cosign-builder-lock.v1.fixture.json'));
  mutate(lock);
  expect(parsePublicBetaCosignBuilderLock(lock)).toBe(false);
});

test.each([
  ['unknown artifact key', (value: MutableRecord) => { const artifacts = record(value.artifacts); artifacts.darwinAmd64 = artifacts.linuxAmd64; }],
  ['non-40-hex workflow SHA', (value: MutableRecord) => { record(value.builder).workflowSha = 'main'; }],
  ['zero subject digest', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).digest = digest('0'); }],
  ['unsafe bundle path', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).bundlePath = '../linux.jsonl'; }],
  ['wrong bundle suffix', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).bundlePath = 'linux-amd64.json'; }],
  ['wrong release tag', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).releaseTag = 'v3.1.2'; }],
  ['zero size', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).sizeBytes = 0; }],
  ['oversized subject', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).sizeBytes = 268435457; }],
  ['non-decimal asset ID', (value: MutableRecord) => { record(record(value.artifacts).linuxAmd64).releaseAssetId = 'asset-1'; }],
  ['duplicate subject digest', (value: MutableRecord) => { const artifacts = record(value.artifacts); record(artifacts.windowsAmd64).digest = record(artifacts.linuxAmd64).digest; }],
])('rejects toolchain %s', async (_name, mutate) => {
  const toolchain = record(await fixture('cosign-toolchain.v1.fixture.json'));
  mutate(toolchain);
  expect(parsePublicBetaCosignToolchain(toolchain)).toBe(false);
});

test('fails closed for getters, symbols, and non-plain prototype input', async () => {
  const lock = record(await fixture('cosign-builder-lock.v1.fixture.json'));
  const upstream = lock.upstream;
  Object.defineProperty(lock, 'upstream', { enumerable: true, get: () => upstream });
  expect(parsePublicBetaCosignBuilderLock(lock)).toBe(false);

  const toolchain = record(await fixture('cosign-toolchain.v1.fixture.json'));
  toolchain[Symbol('hostile')] = true;
  expect(parsePublicBetaCosignToolchain(toolchain)).toBe(false);

  expect(parsePublicBetaCosignBuilderLock(Object.assign(Object.create(null), lock))).toBe(false);
});

test('agrees with all closed schemas and deterministic fixtures', async () => {
  const lock = parsePublicBetaCosignBuilderLock(await fixture('cosign-builder-lock.v1.fixture.json'));
  const toolchain = parsePublicBetaCosignToolchain(await fixture('cosign-toolchain.v1.fixture.json'));
  const predicate = parsePublicBetaCosignSlsaPredicate(
    await fixture('cosign-slsa-predicate.v1.fixture.json'),
    predicateExpectation() as never,
  );
  expect(lock).not.toBe(false);
  expect(toolchain).not.toBe(false);
  expect(predicate).not.toBe(false);
  if (toolchain === false) throw new Error('fixture toolchain must parse');
  expect(computePublicBetaCosignToolchainDigest(toolchain)).toBe(
    computeCanonicalPublicBetaDigest(toolchain),
  );

  const [lockSchema, toolchainSchema, predicateSchema] = await Promise.all([
    fixture('cosign-builder-lock.v1.schema.json'),
    fixture('cosign-toolchain.v1.schema.json'),
    fixture('cosign-slsa-predicate.v1.schema.json'),
  ]);
  for (const schema of [lockSchema, toolchainSchema, predicateSchema]) {
    expect(record(schema).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(record(schema).additionalProperties).toBe(false);
  }
  expect(record(record(lockSchema).properties).targets).toEqual({
    const: ['linuxAmd64', 'windowsAmd64'],
  });
  expect(record(record(toolchainSchema).properties).toolchainId).toEqual({
    const: 'openopc-cosign-v3.1.2.1',
  });
  expect(record(record(record(predicateSchema).properties).buildDefinition).additionalProperties).toBe(false);
});

test('states every expressible builder-lock and toolchain contract in the schemas', async () => {
  const lock = record(await fixture('cosign-builder-lock.v1.schema.json'));
  const toolchain = record(await fixture('cosign-toolchain.v1.schema.json'));

  const lockProperties = record(expectClosedObjectSchema(lock, [
    'schemaVersion', 'toolchainId', 'upstream', 'buildImage', 'actions', 'targets',
  ]).properties);
  expect(lockProperties.schemaVersion).toEqual({ const: 1 });
  expect(lockProperties.toolchainId).toEqual({ const: 'openopc-cosign-v3.1.2.1' });
  expect(lockProperties.targets).toEqual({ const: ['linuxAmd64', 'windowsAmd64'] });
  expect(record(lockProperties.upstream).required).toEqual([
    'repository', 'tag', 'tagObjectSha', 'commitSha', 'treeSha', 'goVersion',
  ]);
  expect(record(lockProperties.upstream).additionalProperties).toBe(false);
  expect(record(lockProperties.upstream).properties).toEqual({
    repository: { const: 'sigstore/cosign' },
    tag: { const: 'v3.1.2' },
    tagObjectSha: { const: 'dc80df70da727f4abdd843640594025584a270ae' },
    commitSha: { const: '193d2153431f8bb0d945a4c1ee721872f73add67' },
    treeSha: { const: '6647db468973d11edb5e737293fcf4b05c69a84a' },
    goVersion: { const: '1.26.0' },
  });
  expect(record(lockProperties.buildImage).required).toEqual(['reference', 'digest']);
  expect(record(lockProperties.buildImage).additionalProperties).toBe(false);
  expect(record(lockProperties.buildImage).properties).toEqual({
    reference: { const: 'golang:1.26.0-bookworm' },
    digest: { type: 'string', pattern: '^sha256:(?!0{64}$)[a-f0-9]{64}$' },
  });
  expect(record(lockProperties.actions).required).toEqual([
    'checkout', 'uploadArtifact', 'downloadArtifact', 'attest', 'setupBun',
  ]);
  expect(record(lockProperties.actions).additionalProperties).toBe(false);
  expect(record(lockProperties.actions).properties).toEqual({
    checkout: { const: '3d3c42e5aac5ba805825da76410c181273ba90b1' },
    uploadArtifact: { const: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' },
    downloadArtifact: { const: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c' },
    attest: { const: '508db95dd578ae2727ebd6217d5ba78e4fbda05d' },
    setupBun: { const: '0c5077e51419868618aeaa5fe8019c62421857d6' },
  });

  const toolchainProperties = record(expectClosedObjectSchema(toolchain, [
    'schemaVersion', 'toolchainId', 'upstream', 'builder', 'artifacts',
  ]).properties);
  expect(toolchainProperties.schemaVersion).toEqual({ const: 1 });
  expect(toolchainProperties.toolchainId).toEqual({ const: 'openopc-cosign-v3.1.2.1' });
  expect(toolchainProperties.upstream).toEqual({ $ref: 'cosign-builder-lock.v1.schema.json#/properties/upstream' });
  const builder = record(toolchainProperties.builder);
  const builderProperties = record(expectClosedObjectSchema(builder, [
    'oidcIssuer', 'repository', 'workflowPath', 'workflowRef', 'workflowSha', 'certificateIdentity',
    'trigger', 'buildContainerDigest', 'buildContractDigest', 'goModuleGraphDigest',
  ]).properties);
  expect(builderProperties.oidcIssuer).toEqual({ const: 'https://token.actions.githubusercontent.com' });
  expect(builderProperties.repository).toEqual({ const: 'openopc/platform' });
  expect(builderProperties.workflowPath).toEqual({ const: '.github/workflows/openopc-cosign-builder.yml' });
  expect(builderProperties.workflowRef).toEqual({ const: 'refs/heads/main' });
  expect(builderProperties.workflowSha).toEqual({ type: 'string', pattern: '^(?!0{40}$)[a-f0-9]{40}$' });
  expect(builderProperties.certificateIdentity).toEqual({
    const: 'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main',
  });
  expect(builderProperties.trigger).toEqual({ const: 'workflow_dispatch' });
  expectDigestPattern(builderProperties, [
    'buildContainerDigest', 'buildContractDigest', 'goModuleGraphDigest',
  ]);
  const artifacts = record(expectClosedObjectSchema(toolchainProperties.artifacts, [
    'linuxAmd64', 'windowsAmd64',
  ]).properties);
  expect(artifacts).toEqual({
    linuxAmd64: { $ref: '#/$defs/linuxSubject' },
    windowsAmd64: { $ref: '#/$defs/windowsSubject' },
  });
  const subject = record(record(toolchain.$defs).subject);
  const subjectProperties = record(expectClosedObjectSchema(subject, [
    'name', 'digest', 'sizeBytes', 'releaseTag', 'releaseAssetId', 'bundlePath', 'bundleDigest', 'predicateType',
  ]).properties);
  expect(subjectProperties.name).toEqual({ type: 'string' });
  expectDigestPattern(subjectProperties, ['digest', 'bundleDigest']);
  expect(subjectProperties.sizeBytes).toEqual({ type: 'integer', minimum: 1, maximum: 268435456 });
  expect(subjectProperties.releaseTag).toEqual({ const: 'openopc-cosign-v3.1.2.1' });
  expect(subjectProperties.releaseAssetId).toEqual({ type: 'string', pattern: '^[1-9][0-9]*$' });
  expect(subjectProperties.bundlePath).toEqual({ type: 'string' });
  expect(subjectProperties.predicateType).toEqual({ const: 'https://slsa.dev/provenance/v1' });
  expect(record(toolchain.$defs).linuxSubject).toEqual({
    allOf: [
      { $ref: '#/$defs/subject' },
      { properties: { name: { const: 'cosign-linux-amd64' }, bundlePath: { const: 'cosign-v3.1.2-openopc.1/linux-amd64.jsonl' } } },
    ],
  });
  expect(record(toolchain.$defs).windowsSubject).toEqual({
    allOf: [
      { $ref: '#/$defs/subject' },
      { properties: { name: { const: 'cosign-windows-amd64.exe' }, bundlePath: { const: 'cosign-v3.1.2-openopc.1/windows-amd64.jsonl' } } },
    ],
  });
});

test('states every expressible SLSA predicate contract in the schema', async () => {
  const predicate = record(await fixture('cosign-slsa-predicate.v1.schema.json'));
  const toolchain = record(await fixture('cosign-toolchain.v1.schema.json'));
  const predicateProperties = record(expectClosedObjectSchema(predicate, ['buildDefinition', 'runDetails']).properties);
  const buildDefinition = record(expectClosedObjectSchema(predicateProperties.buildDefinition, [
    'buildType', 'externalParameters', 'internalParameters', 'resolvedDependencies',
  ]).properties);
  expect(buildDefinition.buildType).toEqual({ const: 'https://openopc.dev/buildtypes/cosign/v1' });
  const parameters = record(expectClosedObjectSchema(buildDefinition.externalParameters, [
    'workflowSha', 'platform', 'subjectName', 'subjectDigest', 'subjectSizeBytes', 'buildContainerDigest',
    'buildContractDigest', 'goModuleGraphDigest', 'replayDigest', 'upstreamRepository', 'upstreamTag',
    'upstreamTagObjectSha', 'upstreamCommitSha', 'upstreamTreeSha', 'upstreamGoVersion',
  ]).properties);
  expect(parameters.workflowSha).toEqual({ type: 'string', pattern: '^(?!0{40}$)[a-f0-9]{40}$' });
  expect(parameters.platform).toEqual({ enum: ['linuxAmd64', 'windowsAmd64'] });
  expect(parameters.subjectName).toEqual({ enum: ['cosign-linux-amd64', 'cosign-windows-amd64.exe'] });
  expectDigestPattern(parameters, ['subjectDigest', 'buildContainerDigest', 'buildContractDigest', 'goModuleGraphDigest', 'replayDigest']);
  expect(parameters.subjectSizeBytes).toEqual({ type: 'integer', minimum: 1, maximum: 268435456 });
  expect(Object.fromEntries([
    ['upstreamRepository', parameters.upstreamRepository], ['upstreamTag', parameters.upstreamTag],
    ['upstreamTagObjectSha', parameters.upstreamTagObjectSha], ['upstreamCommitSha', parameters.upstreamCommitSha],
    ['upstreamTreeSha', parameters.upstreamTreeSha], ['upstreamGoVersion', parameters.upstreamGoVersion],
  ])).toEqual({
    upstreamRepository: { const: 'sigstore/cosign' }, upstreamTag: { const: 'v3.1.2' },
    upstreamTagObjectSha: { const: 'dc80df70da727f4abdd843640594025584a270ae' },
    upstreamCommitSha: { const: '193d2153431f8bb0d945a4c1ee721872f73add67' },
    upstreamTreeSha: { const: '6647db468973d11edb5e737293fcf4b05c69a84a' }, upstreamGoVersion: { const: '1.26.0' },
  });
  const platformSubjectBinding: MutableRecord = {
    if: { properties: { platform: { const: 'linuxAmd64' } } },
    else: { properties: { subjectName: { const: 'cosign-windows-amd64.exe' } } },
  };
  Object.defineProperty(platformSubjectBinding, 'then', {
    enumerable: true,
    value: { properties: { subjectName: { const: 'cosign-linux-amd64' } } },
  });
  expect(record(buildDefinition.externalParameters).allOf).toEqual([platformSubjectBinding]);
  expect(buildDefinition.internalParameters).toEqual({ type: 'object', additionalProperties: false, maxProperties: 0 });
  expect(record(buildDefinition.resolvedDependencies)).toEqual({
    type: 'array', minItems: 1, maxItems: 1, items: {
      type: 'object', additionalProperties: false, required: ['uri', 'digest'], properties: {
        uri: { const: 'git+https://github.com/sigstore/cosign@refs/tags/v3.1.2' }, digest: {
          type: 'object', additionalProperties: false, required: ['sha1', 'gitTree'], properties: {
            sha1: { const: '193d2153431f8bb0d945a4c1ee721872f73add67' },
            gitTree: { const: '6647db468973d11edb5e737293fcf4b05c69a84a' },
          },
        },
      },
    },
  });
  const runDetails = record(expectClosedObjectSchema(predicateProperties.runDetails, ['builder', 'metadata']).properties);
  expect(record(runDetails.builder)).toEqual({
    type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: { const: 'https://github.com/openopc/platform/.github/workflows/openopc-cosign-builder.yml@refs/heads/main' },
    },
  });
  const metadata = record(runDetails.metadata);
  const metadataProperties = record(expectClosedObjectSchema(metadata, ['invocationId', 'startedOn', 'finishedOn']).properties);
  expect(metadata.$comment).toBe('Runtime also requires valid UTC instants and startedOn <= finishedOn.');
  expect(metadataProperties.invocationId).toEqual({ type: 'string', minLength: 1, maxLength: 512 });
  expect(metadataProperties.startedOn).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
  expect(metadataProperties.finishedOn).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
  expect(toolchain.$comment).toBe(
    'Runtime additionally requires linuxAmd64 and windowsAmd64 artifact digests to differ; JSON Schema cannot express this cross-property inequality.',
  );
});

test('binds the SLSA predicate to the expected compared subject and build contract', async () => {
  const predicate = await fixture('cosign-slsa-predicate.v1.fixture.json');
  const parsed = parsePublicBetaCosignSlsaPredicate(predicate, {
    workflowSha: 'a'.repeat(40),
    platform: 'linuxAmd64',
    subjectName: 'cosign-linux-amd64',
    subjectDigest: digest('1'),
    subjectSizeBytes: 1024,
    buildContainerDigest: digest('2'),
    buildContractDigest: digest('3'),
    goModuleGraphDigest: digest('4'),
    replayDigest: digest('1'),
  });

  expect(parsed).not.toBe(false);
  if (parsed === false) throw new Error('fixture predicate must parse');
  expect(parsed.buildDefinition.buildType).toBe('https://openopc.dev/buildtypes/cosign/v1');
  expect(parsed.runDetails.builder.id).toBe(canonicalPublicBetaCosignBuilderIdentity());
  expect(Object.isFrozen(parsed)).toBe(true);
});

test.each([
  ['mismatched expected subject digest', (_predicate: MutableRecord, expected: MutableRecord) => { expected.subjectDigest = digest('9'); }],
  ['bad platform-to-name mapping', (predicate: MutableRecord, expected: MutableRecord) => {
    const parameters = record(record(predicate.buildDefinition).externalParameters);
    parameters.platform = 'windowsAmd64';
    expected.platform = 'windowsAmd64';
  }],
  ['malformed compared subject digest', (predicate: MutableRecord, expected: MutableRecord) => {
    const parameters = record(record(predicate.buildDefinition).externalParameters);
    parameters.subjectDigest = 'sha256:abc';
    expected.subjectDigest = 'sha256:abc';
  }],
  ['hostile predicate getter', (predicate: MutableRecord) => {
    const runDetails = predicate.runDetails;
    Object.defineProperty(predicate, 'runDetails', { enumerable: true, get: () => runDetails });
  }],
  ['hostile predicate symbol', (predicate: MutableRecord) => { predicate[Symbol('hostile')] = true; }],
  ['hostile predicate prototype', (predicate: MutableRecord) => { Object.setPrototypeOf(predicate, null); }],
])('rejects predicate %s', async (_name, mutate) => {
  const predicate = record(await fixture('cosign-slsa-predicate.v1.fixture.json'));
  const expected = predicateExpectation();
  mutate(predicate, expected);
  expect(parsePublicBetaCosignSlsaPredicate(predicate, expected as never)).toBe(false);
});

test('rejects predicate expectations outside the closed platform domain', async () => {
  const predicate = record(await fixture('cosign-slsa-predicate.v1.fixture.json'));
  const parameters = record(record(predicate.buildDefinition).externalParameters);
  parameters.platform = 'darwinAmd64';
  parameters.subjectName = 'cosign-windows-amd64.exe';

  expect(
    parsePublicBetaCosignSlsaPredicate(predicate, {
      workflowSha: 'a'.repeat(40),
      platform: 'darwinAmd64',
      subjectName: 'cosign-windows-amd64.exe',
      subjectDigest: digest('1'),
      subjectSizeBytes: 1024,
      buildContainerDigest: digest('2'),
      buildContractDigest: digest('3'),
      goModuleGraphDigest: digest('4'),
      replayDigest: digest('1'),
    } as never),
  ).toBe(false);
});

test('rejects noncanonical or reversed predicate timestamps and documents the schema boundary', async () => {
  const expected = {
    workflowSha: 'a'.repeat(40),
    platform: 'linuxAmd64' as const,
    subjectName: 'cosign-linux-amd64' as const,
    subjectDigest: digest('1'),
    subjectSizeBytes: 1024,
    buildContainerDigest: digest('2'),
    buildContractDigest: digest('3'),
    goModuleGraphDigest: digest('4'),
    replayDigest: digest('1'),
  };
  const noncanonical = record(await fixture('cosign-slsa-predicate.v1.fixture.json'));
  record(record(noncanonical.runDetails).metadata).startedOn = '2026-07-30T10:00:00Z';
  expect(parsePublicBetaCosignSlsaPredicate(noncanonical, expected)).toBe(false);

  const impossibleInstant = record(await fixture('cosign-slsa-predicate.v1.fixture.json'));
  record(record(impossibleInstant.runDetails).metadata).startedOn = '2026-02-30T10:00:00.000Z';
  expect(parsePublicBetaCosignSlsaPredicate(impossibleInstant, expected)).toBe(false);

  const reversed = record(await fixture('cosign-slsa-predicate.v1.fixture.json'));
  record(record(reversed.runDetails).metadata).finishedOn = '2026-07-30T09:59:59.999Z';
  expect(parsePublicBetaCosignSlsaPredicate(reversed, expected)).toBe(false);

  const schema = record(await fixture('cosign-slsa-predicate.v1.schema.json'));
  const metadata = record(record(record(schema.properties).runDetails).properties);
  const metadataProperties = record(metadata.metadata);
  expect(record(record(metadataProperties.properties).startedOn)).toEqual({
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  });
  expect(record(record(metadataProperties.properties).finishedOn)).toEqual({
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  });
  expect(metadataProperties.$comment).toBe(
    'Runtime also requires valid UTC instants and startedOn <= finishedOn.',
  );
});

test('keeps duplicate subject-digest rejection runtime-only and explicit to schema consumers', async () => {
  const toolchain = record(await fixture('cosign-toolchain.v1.fixture.json'));
  const artifacts = record(toolchain.artifacts);
  record(artifacts.windowsAmd64).digest = record(artifacts.linuxAmd64).digest;
  expect(parsePublicBetaCosignToolchain(toolchain)).toBe(false);

  const schema = record(await fixture('cosign-toolchain.v1.schema.json'));
  expect(schema.$comment).toBe(
    'Runtime additionally requires linuxAmd64 and windowsAmd64 artifact digests to differ; JSON Schema cannot express this cross-property inequality.',
  );
  expect(record(record(schema.properties).artifacts).additionalProperties).toBe(false);
});
