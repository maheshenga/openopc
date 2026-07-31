import { expect, test } from 'bun:test';

import {
  type CreateRegistryModuleArtifactInput,
  canonicalRegistryModuleArtifactDescriptor,
  createRegistryModuleArtifactEnvelope,
} from './module-artifact';
import type { RegistryItem } from './schema';

const encoder = new TextEncoder();

function artifactInput(): CreateRegistryModuleArtifactInput {
  const item: RegistryItem = {
    name: 'server-tools',
    type: 'registry:module',
    title: 'Server tools',
    dependencies: ['zeta@2.0.0', 'alpha@1.0.0'],
    devDependencies: ['typescript@5.9.3'],
    registryDependencies: ['acme/shared@1.4.0'],
    files: [
      {
        path: 'src\\main.ts',
        target: 'modules\\acme\\main.ts',
        type: 'registry:file',
      },
      {
        path: 'assets/config.json',
        target: 'modules/acme/config.json',
        type: 'registry:file',
      },
    ],
    module: {
      schemaVersion: 2,
      id: 'acme.server-tools',
      version: '1.2.3',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'automation',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'server-adapter', entry: 'src/main.ts' },
      verification: { profile: 'server-conformance' },
      ui: [{ id: 'settings', surface: 'panel', entry: 'assets/config.json' }],
    },
  };

  return {
    item,
    files: [
      {
        path: 'src\\main.ts',
        target: 'modules\\acme\\main.ts',
        mediaType: 'text/typescript',
        bytes: encoder.encode('export const main = 1;\n'),
      },
      {
        path: 'assets/config.json',
        target: 'modules/acme/config.json',
        mediaType: 'application/json',
        bytes: encoder.encode('{"enabled":true}\n'),
      },
    ],
    lockGraph: {
      format: 'openopc-lock.v1',
      nodes: [
        {
          name: 'zeta',
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/zeta/-/zeta-2.0.0.tgz',
          integrity: `sha512-${'z'.repeat(86)}`,
          dependencies: { alpha: '1.0.0' },
        },
        {
          name: 'alpha',
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz',
          integrity: `sha512-${'a'.repeat(86)}`,
          dependencies: {},
        },
        {
          name: 'typescript',
          version: '5.9.3',
          resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz',
          integrity: `sha512-${'t'.repeat(86)}`,
          dependencies: {},
        },
      ],
    },
    source: {
      uri: 'https://github.com/acme/registry',
      revision: '4f3c2d1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d',
      registryItemAddress: 'acme/server-tools',
    },
  };
}

function clonedInput(): CreateRegistryModuleArtifactInput {
  return structuredClone(artifactInput());
}

function expectArtifactInvalid(operation: () => unknown): void {
  expect(operation).toThrow(/^REGISTRY_MODULE_ARTIFACT_INVALID:/);
}

test('exports the schema-v2 developer module artifact contract', async () => {
  const contract = await import('./module-artifact').catch(() => null);

  expect(contract).not.toBeNull();
  expect(contract?.DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE).toBe(
    'application/vnd.openopc.developer-module.v2+json',
  );
  expect(contract?.DEVELOPER_MODULE_ARTIFACT_FORMAT_VERSION).toBe(2);
  expect(contract?.createRegistryModuleArtifactEnvelope).toBeFunction();
  expect(contract?.canonicalRegistryModuleArtifactDescriptor).toBeFunction();
  expect(contract?.registryModuleArtifactDigest).toBeFunction();
});

test('exposes the artifact contract from the registry package entrypoint', async () => {
  const registry = await import('./index');

  expect(registry.createRegistryModuleArtifactEnvelope).toBeFunction();
  expect(registry.canonicalRegistryModuleArtifactDescriptor).toBeFunction();
});

test('builds a deterministic envelope independent of declaration order and path separators', () => {
  const first = createRegistryModuleArtifactEnvelope(artifactInput());
  const reordered = clonedInput();
  reordered.files?.reverse();
  reordered.item.files?.reverse();
  reordered.item.dependencies?.reverse();
  reordered.item.devDependencies?.reverse();
  reordered.item.registryDependencies?.reverse();
  reordered.lockGraph?.nodes.reverse();
  const second = createRegistryModuleArtifactEnvelope(reordered);

  expect(second).toEqual(first);
  expect(first.descriptor.blobs.map(({ path, target }) => ({ path, target }))).toEqual([
    { path: 'assets/config.json', target: 'modules/acme/config.json' },
    { path: 'src/main.ts', target: 'modules/acme/main.ts' },
  ]);
  expect(first.descriptor.module).toMatchObject({ category: 'automation' });
  expect(
    new TextDecoder().decode(canonicalRegistryModuleArtifactDescriptor(first.descriptor)),
  ).toBe(new TextDecoder().decode(canonicalRegistryModuleArtifactDescriptor(second.descriptor)));
});

test('omits the legacy category field from a schema-v3 artifact descriptor', () => {
  const input = artifactInput();
  const module = input.item.module as unknown as Record<string, unknown>;
  delete module.category;
  Object.assign(module, {
    schemaVersion: 3,
    openopc: {
      sdkApiVersion: 'v1',
      catalog: { labels: ['server'] },
    },
  });

  const envelope = createRegistryModuleArtifactEnvelope(input);
  expect(Object.hasOwn(envelope.descriptor.module, 'category')).toBe(false);
  expect(
    new TextDecoder().decode(canonicalRegistryModuleArtifactDescriptor(envelope.descriptor)),
  ).not.toContain('"category"');
});

test('identifies v2 and v3 as supported schema versions when a manifest is invalid', () => {
  const input = artifactInput();
  const module = input.item.module as unknown as Record<string, unknown>;
  module.schemaVersion = 4;

  expect(() => createRegistryModuleArtifactEnvelope(input)).toThrow(
    'item.module must be a valid schema-version-2 or schema-version-3 module manifest',
  );
});

test.each([
  [
    'file byte',
    (input: CreateRegistryModuleArtifactInput) => {
      if (!input.files?.[0]) throw new Error('file fixture missing');
      input.files[0].bytes = encoder.encode('export const main = 2;\n');
    },
  ],
  [
    'dependency',
    (input: CreateRegistryModuleArtifactInput) => {
      if (!input.item.dependencies) throw new Error('dependency fixture missing');
      input.item.dependencies[0] = 'zeta@2.0.1';
      const node = input.lockGraph?.nodes.find((candidate) => candidate.name === 'zeta');
      if (!node) throw new Error('zeta lock fixture missing');
      node.version = '2.0.1';
      node.resolved = 'https://registry.npmjs.org/zeta/-/zeta-2.0.1.tgz';
    },
  ],
  [
    'entry',
    (input: CreateRegistryModuleArtifactInput) => {
      if (!input.item.module) throw new Error('module fixture missing');
      input.item.module.execution.entry = 'assets/config.json';
    },
  ],
  [
    'lock graph',
    (input: CreateRegistryModuleArtifactInput) => {
      if (!input.lockGraph?.nodes[0]) throw new Error('lock fixture missing');
      input.lockGraph.nodes[0].integrity = `sha512-${'x'.repeat(86)}`;
    },
  ],
  [
    'source revision',
    (input: CreateRegistryModuleArtifactInput) => {
      if (!input.source) throw new Error('source fixture missing');
      input.source.revision = '5f3c2d1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c4d';
    },
  ],
] as const)('changes the artifact digest when a %s changes', (_label, mutate) => {
  const base = createRegistryModuleArtifactEnvelope(artifactInput());
  const changed = clonedInput();
  mutate(changed);

  expect(createRegistryModuleArtifactEnvelope(changed).artifactDigest).not.toBe(
    base.artifactDigest,
  );
});

test.each([
  '../escape.ts',
  '/absolute.ts',
  'C:\\absolute.ts',
  'src/file.ts:stream',
  'src/CON',
] as const)('rejects unsafe artifact path %s', (path) => {
  const input = clonedInput();
  if (!input.item.files?.[0] || !input.files?.[0]) throw new Error('file fixture missing');
  input.item.files[0].path = path;
  input.files[0].path = path;

  expectArtifactInvalid(() => createRegistryModuleArtifactEnvelope(input));
});

test('rejects case-folding path collisions and undeclared blobs', () => {
  const collision = clonedInput();
  collision.item.files?.push({
    path: 'SRC/MAIN.ts',
    target: 'modules/acme/second.ts',
    type: 'registry:file',
  });
  collision.files?.push({
    path: 'SRC/MAIN.ts',
    target: 'modules/acme/second.ts',
    mediaType: 'text/typescript',
    bytes: encoder.encode('export const second = 1;\n'),
  });
  expectArtifactInvalid(() => createRegistryModuleArtifactEnvelope(collision));

  const undeclared = clonedInput();
  if (!undeclared.files?.[0]) throw new Error('file fixture missing');
  undeclared.files[0].path = 'src/undeclared.ts';
  expectArtifactInvalid(() => createRegistryModuleArtifactEnvelope(undeclared));
});

test('requires a deterministic lock graph for code-bearing modules and rejects floating ranges', () => {
  const missingLock = clonedInput();
  missingLock.lockGraph = null;
  expectArtifactInvalid(() => createRegistryModuleArtifactEnvelope(missingLock));

  const floating = clonedInput();
  if (!floating.item.dependencies) throw new Error('dependency fixture missing');
  floating.item.dependencies[0] = 'zeta@^2.0.0';
  expectArtifactInvalid(() => createRegistryModuleArtifactEnvelope(floating));
});

test('enforces streaming-equivalent file count and byte limits', () => {
  const input = clonedInput();
  input.limits = { maxFiles: 1, maxFileBytes: 8, maxExpandedBytes: 16 };

  expectArtifactInvalid(() => createRegistryModuleArtifactEnvelope(input));
});
