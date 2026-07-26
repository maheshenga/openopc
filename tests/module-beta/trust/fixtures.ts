import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRUST_FIXTURE_SCENARIOS = [
  'clean-wasi',
  'secret-leak',
  'vulnerable-lockfile',
  'traversal',
  'oversized-file',
  'invalid-signature',
  'stale-policy',
  'scanner-crash',
] as const;

export type TrustFixtureScenario = (typeof TRUST_FIXTURE_SCENARIOS)[number];
export type TrustFixtureCheckpoint = 'verification' | 'api-rejection' | 'staging-fault';

export interface GeneratedTrustFixture {
  scenario: TrustFixtureScenario;
  checkpoint: TrustFixtureCheckpoint;
  archivePath: string;
  archiveDigest: `sha256:${string}`;
  sizeBytes: number;
}

export interface GenerateTrustFixturesInput {
  outputDirectory: string;
  seed: string;
  publisherId: string;
  oversizedFileBytes?: number;
}

interface PackageFile {
  path: string;
  target: string;
  mediaType: string;
  bytes: Uint8Array;
}

interface RegistryItemFile {
  path: string;
  target: string;
  type: 'registry:file';
}

type RegistryItem = Record<string, unknown> & {
  files: RegistryItemFile[];
  module: Record<string, unknown> & {
    id: string;
    version: string;
    publisher: { id: string; displayName: string };
  };
  dependencies?: string[];
};

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const committedFixtureDirectory = resolve(currentDirectory, 'fixtures');
const cleanFixtureDirectory = join(committedFixtureDirectory, 'clean-wasi');
const vulnerableLockfilePath = join(
  committedFixtureDirectory,
  'vulnerable-lockfile',
  'package-lock.json',
);
const artifactMediaType = 'application/vnd.openopc.developer-module.v2+json';
const defaultOversizedFileBytes = 32 * 1024 * 1024 + 1;
const encoder = new TextEncoder();

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('TRUST_FIXTURE_NON_FINITE_NUMBER');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  throw new Error('TRUST_FIXTURE_NON_JSON_VALUE');
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(canonicalValue(value)));
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function token(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return Object.entries(replacements).reduce(
      (current, [search, replacement]) => current.replaceAll(search, replacement),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => token(entry, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        token(entry, replacements),
      ]),
    );
  }
  return value;
}

function safeSeed(seed: string): string {
  const normalized = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  if (!normalized) throw new Error('TRUST_FIXTURE_SEED_INVALID');
  return normalized;
}

function assertInput(input: GenerateTrustFixturesInput): void {
  const output = resolve(input.outputDirectory);
  if (
    !input.seed.trim() ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.publisherId) ||
    output === committedFixtureDirectory ||
    output.startsWith(`${committedFixtureDirectory}${sep}`) ||
    !Number.isSafeInteger(input.oversizedFileBytes ?? defaultOversizedFileBytes) ||
    (input.oversizedFileBytes ?? defaultOversizedFileBytes) < 1
  ) {
    throw new Error('TRUST_FIXTURE_INPUT_INVALID');
  }
}

async function readEncodedWasm(path: string): Promise<Uint8Array> {
  const value = await readFile(path, 'utf8');
  const normalized = value.trim();
  if (!normalized.startsWith('base64:')) throw new Error('TRUST_FIXTURE_WASM_INVALID');
  const bytes = Buffer.from(normalized.slice('base64:'.length), 'base64');
  if (
    bytes.subarray(0, 8).toString('hex') !== '0061736d0d000100' ||
    !bytes.includes(Buffer.from('run', 'utf8'))
  ) {
    throw new Error('TRUST_FIXTURE_WASM_INVALID');
  }
  return new Uint8Array(bytes);
}

function declareFile(item: RegistryItem, file: PackageFile): void {
  item.files.push({ path: file.path, target: file.target, type: 'registry:file' });
  item.files.sort((left, right) =>
    `${left.path}\0${left.target}`.localeCompare(`${right.path}\0${right.target}`, 'en'),
  );
}

function markerFile(scenario: TrustFixtureScenario, seed: string): PackageFile {
  return {
    path: `acceptance/${scenario}.json`,
    target: `acceptance/${scenario}.json`,
    mediaType: 'application/json',
    bytes: canonicalBytes({ schema: 1, scenario, seed }),
  };
}

function artifactPackage(input: {
  item: RegistryItem;
  files: PackageFile[];
  lockGraph: Record<string, unknown> | null;
}): Uint8Array {
  return canonicalBytes({
    formatVersion: 2,
    mediaType: artifactMediaType,
    item: input.item,
    files: [...input.files]
      .sort((left, right) =>
        `${left.path}\0${left.target}`.localeCompare(`${right.path}\0${right.target}`, 'en'),
      )
      .map((file) => ({
        path: file.path,
        target: file.target,
        mediaType: file.mediaType,
        bytes: `base64:${Buffer.from(file.bytes).toString('base64')}`,
      })),
    lockGraph: input.lockGraph,
    source: null,
  });
}

function checkpoint(scenario: TrustFixtureScenario): TrustFixtureCheckpoint {
  if (scenario === 'traversal' || scenario === 'oversized-file') return 'api-rejection';
  if (
    scenario === 'invalid-signature' ||
    scenario === 'stale-policy' ||
    scenario === 'scanner-crash'
  ) {
    return 'staging-fault';
  }
  return 'verification';
}

async function buildScenario(input: {
  scenario: TrustFixtureScenario;
  template: RegistryItem;
  descriptor: Uint8Array;
  component: Uint8Array;
  vulnerableLockfile: Uint8Array;
  seed: string;
  oversizedFileBytes: number;
}): Promise<Uint8Array> {
  const item = structuredClone(input.template);
  const files: PackageFile[] = [
    {
      path: 'runtime/openopc.runtime.json',
      target: 'runtime/openopc.runtime.json',
      mediaType: 'application/json',
      bytes: input.descriptor,
    },
    {
      path: 'runtime/echo.component.wasm',
      target: 'runtime/echo.component.wasm',
      mediaType: 'application/wasm',
      bytes: input.component,
    },
  ];
  let lockGraph: Record<string, unknown> = { format: 'openopc-lock.v1', nodes: [] };

  if (input.scenario === 'secret-leak') {
    const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const file = {
      path: 'acceptance/credentials.env',
      target: 'acceptance/credentials.env',
      mediaType: 'text/plain',
      bytes: encoder.encode(`AWS_ACCESS_KEY_ID=${secret}\n`),
    };
    declareFile(item, file);
    files.push(file);
  } else if (input.scenario === 'vulnerable-lockfile') {
    const file = {
      path: 'package-lock.json',
      target: 'package-lock.json',
      mediaType: 'application/json',
      bytes: input.vulnerableLockfile,
    };
    item.dependencies = ['lodash@4.17.20'];
    lockGraph = {
      format: 'openopc-lock.v1',
      nodes: [
        {
          name: 'lodash',
          version: '4.17.20',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
          integrity: `sha512-${'a'.repeat(86)}`,
          dependencies: {},
        },
      ],
    };
    declareFile(item, file);
    files.push(file);
  } else if (input.scenario === 'traversal') {
    const file = {
      path: 'acceptance/traversal.txt',
      target: '../outside/traversal.txt',
      mediaType: 'text/plain',
      bytes: encoder.encode('must never escape the artifact root'),
    };
    declareFile(item, file);
    files.push(file);
  } else if (input.scenario === 'oversized-file') {
    const file = {
      path: 'acceptance/oversized.bin',
      target: 'acceptance/oversized.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(input.oversizedFileBytes).fill(0x41),
    };
    declareFile(item, file);
    files.push(file);
  } else if (
    input.scenario === 'invalid-signature' ||
    input.scenario === 'stale-policy' ||
    input.scenario === 'scanner-crash'
  ) {
    const file = markerFile(input.scenario, input.seed);
    declareFile(item, file);
    files.push(file);
  }

  return artifactPackage({ item, files, lockGraph });
}

export async function generateTrustFixtures(
  input: GenerateTrustFixturesInput,
): Promise<GeneratedTrustFixture[]> {
  assertInput(input);
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const seed = safeSeed(input.seed);
  const templateValue = JSON.parse(
    await readFile(join(cleanFixtureDirectory, 'kortix.yaml'), 'utf8'),
  ) as unknown;
  const descriptor = canonicalBytes(
    JSON.parse(await readFile(join(cleanFixtureDirectory, 'openopc.runtime.json'), 'utf8')),
  );
  const component = await readEncodedWasm(join(cleanFixtureDirectory, 'echo.component.wasm'));
  const vulnerableLockfile = new Uint8Array(await readFile(vulnerableLockfilePath));
  const results: GeneratedTrustFixture[] = [];

  for (const scenario of TRUST_FIXTURE_SCENARIOS) {
    const scenarioToken = scenario.replaceAll('-', '.');
    const template = token(templateValue, {
      __PUBLISHER_ID__: input.publisherId,
      __SCENARIO__: scenarioToken,
      __SEED__: seed,
    }) as RegistryItem;
    const bytes = await buildScenario({
      scenario,
      template,
      descriptor,
      component,
      vulnerableLockfile,
      seed,
      oversizedFileBytes: input.oversizedFileBytes ?? defaultOversizedFileBytes,
    });
    const archivePath = join(outputDirectory, `${scenario}.artifact.json`);
    await writeFile(archivePath, bytes, { mode: 0o600 });
    results.push({
      scenario,
      checkpoint: checkpoint(scenario),
      archivePath,
      archiveDigest: sha256(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return results;
}
