import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { RegistryModuleManifest, ResolvedRegistryModuleFile } from '@kortix/registry';

import { serializeDeveloperModuleArtifactPackage } from './artifacts';
import { extractRuntimeDescriptor } from './runtime-descriptors';

const encoder = new TextEncoder();
const LIMITS =
  '"limits":{"cpuMillis":1000,"fuel":1000000,"memoryMiB":64,"outputBytes":1048576,"pids":8,"wallTimeMs":5000}';
const WASI_DESCRIPTOR = `{"descriptorVersion":1,"runtime":{"component":"runtime/adapter.wasm","imports":["openopc:runtime/assets"],"kind":"wasi-component",${LIMITS},"operation":"run","world":"openopc:adapter/runtime@1.0.0"}}`;
const OCI_DESCRIPTOR = `{"descriptorVersion":1,"runtime":{"args":["serve"],"command":["openopc-adapter"],"image":"sha256:${'a'.repeat(64)}","kind":"oci-image",${LIMITS},"profile":"server-adapter"}}`;

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifest(
  mode: RegistryModuleManifest['execution']['mode'] = 'server-adapter',
  entry = 'runtime/openopc.runtime.json',
): RegistryModuleManifest {
  return {
    schemaVersion: 2,
    id: 'acme.adapter',
    version: '1.0.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'automation',
    locales: ['en'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode, ...(mode === 'declarative' ? {} : { entry }) },
    ...(mode === 'declarative'
      ? {}
      : {
          verification: {
            profile:
              mode === 'server-adapter'
                ? ('server-conformance' as const)
                : ('agent-project' as const),
          },
        }),
  };
}

function artifactBytes(
  descriptorBytes = encoder.encode(WASI_DESCRIPTOR),
  options: {
    manifest?: RegistryModuleManifest;
    descriptorPath?: string;
    descriptorTarget?: string;
    descriptorKind?: ResolvedRegistryModuleFile['kind'];
    duplicateDescriptor?: boolean;
    includeDescriptor?: boolean;
  } = {},
): Uint8Array {
  const moduleManifest = options.manifest ?? manifest();
  const descriptorPath = options.descriptorPath ?? 'runtime/openopc.runtime.json';
  const descriptorTarget = options.descriptorTarget ?? descriptorPath;
  const includeDescriptor = options.includeDescriptor ?? true;
  const declarations = includeDescriptor
    ? [
        {
          path: descriptorPath,
          target: descriptorTarget,
          type: 'registry:file' as const,
        },
      ]
    : [];
  const files: ResolvedRegistryModuleFile[] = includeDescriptor
    ? [
        {
          path: descriptorPath,
          target: descriptorTarget,
          mediaType: 'application/json',
          bytes: descriptorBytes,
          ...(options.descriptorKind === undefined ? {} : { kind: options.descriptorKind }),
        },
      ]
    : [];
  const descriptorFile = files[0];
  if (options.duplicateDescriptor && descriptorFile) {
    files.push({ ...descriptorFile, bytes: descriptorFile.bytes.slice() });
  }
  if (new TextDecoder().decode(descriptorBytes) === WASI_DESCRIPTOR) {
    declarations.push({
      path: 'runtime/adapter.wasm',
      target: 'runtime/adapter.wasm',
      type: 'registry:file',
    });
    files.push({
      path: 'runtime/adapter.wasm',
      target: 'runtime/adapter.wasm',
      mediaType: 'application/wasm',
      bytes: new Uint8Array([0, 97, 115, 109]),
    });
  }
  return serializeDeveloperModuleArtifactPackage({
    item: {
      name: 'adapter',
      type: 'registry:module',
      files: declarations,
      module: moduleManifest,
    },
    files,
    lockGraph: { format: 'openopc-lock.v1', nodes: [] },
  });
}

describe('artifact-bound runtime descriptor extraction', () => {
  test.each([
    ['WASI component', WASI_DESCRIPTOR, 'wasi-component'],
    ['OCI image', OCI_DESCRIPTOR, 'oci-image'],
  ] as const)(
    'extracts canonical %s evidence from the declared artifact entry',
    async (_label, json, kind) => {
      await expect(
        extractRuntimeDescriptor({
          manifest: manifest(),
          artifactBytes: artifactBytes(encoder.encode(json)),
        }),
      ).resolves.toMatchObject({
        descriptorDigest: digest(json),
        entryPath: 'runtime/openopc.runtime.json',
        runtimeKind: kind,
        descriptor: { descriptorVersion: 1, runtime: { kind } },
      });
    },
  );

  test('leaves non-server-adapter execution modes unchanged', async () => {
    await expect(
      extractRuntimeDescriptor({
        manifest: manifest('declarative'),
        artifactBytes: new Uint8Array([0xff]),
      }),
    ).resolves.toBeNull();
  });

  test('rejects an entry that does not resolve to openopc.runtime.json inside the artifact', async () => {
    await expect(
      extractRuntimeDescriptor({
        manifest: manifest('server-adapter', '../openopc.runtime.json'),
        artifactBytes: artifactBytes(),
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_RUNTIME_ENTRY_INVALID' });
  });

  test.each([
    [
      'traversal entry',
      artifactBytes(encoder.encode(WASI_DESCRIPTOR), {
        descriptorPath: '../openopc.runtime.json',
        descriptorTarget: '../openopc.runtime.json',
      }),
      'DEVELOPER_RUNTIME_ARTIFACT_INVALID',
    ],
    [
      'missing descriptor',
      artifactBytes(encoder.encode(WASI_DESCRIPTOR), { includeDescriptor: false }),
      'DEVELOPER_RUNTIME_DESCRIPTOR_MISSING',
    ],
    [
      'duplicate descriptor',
      artifactBytes(encoder.encode(WASI_DESCRIPTOR), { duplicateDescriptor: true }),
      'DEVELOPER_RUNTIME_ARTIFACT_INVALID',
    ],
    [
      'symlink descriptor',
      artifactBytes(encoder.encode(WASI_DESCRIPTOR), { descriptorKind: 'symlink' }),
      'DEVELOPER_RUNTIME_ARTIFACT_INVALID',
    ],
  ] as const)('rejects a canonical artifact with a %s', async (_label, bytes, code) => {
    await expect(
      extractRuntimeDescriptor({ manifest: manifest(), artifactBytes: bytes }),
    ).rejects.toMatchObject({
      code,
    });
  });

  test.each([
    ['non-UTF-8 bytes', new Uint8Array([0xc3, 0x28])],
    ['non-canonical JSON', encoder.encode(JSON.stringify(JSON.parse(WASI_DESCRIPTOR), null, 2))],
    [
      'unknown field',
      encoder.encode(
        WASI_DESCRIPTOR.replace(
          '"kind":"wasi-component",',
          '"kind":"wasi-component","privileged":true,',
        ),
      ),
    ],
    [
      'OCI tag',
      encoder.encode(OCI_DESCRIPTOR.replace(`sha256:${'a'.repeat(64)}`, 'acme/adapter:latest')),
    ],
    [
      'host path field',
      encoder.encode(
        OCI_DESCRIPTOR.replace(
          '"kind":"oci-image",',
          '"hostPath":"/var/run/docker.sock","kind":"oci-image",',
        ),
      ),
    ],
  ] as const)('rejects a descriptor with %s', async (_label, bytes) => {
    await expect(
      extractRuntimeDescriptor({ manifest: manifest(), artifactBytes: artifactBytes(bytes) }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_RUNTIME_DESCRIPTOR_INVALID' });
  });
});
