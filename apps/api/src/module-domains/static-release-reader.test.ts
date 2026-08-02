import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { RegistryItem } from '@kortix/registry';

import {
  type DeveloperArtifactStore,
  serializeDeveloperModuleArtifactPackage,
} from '../developer/artifacts';
import { type StaticModuleRelease, StaticModuleReleaseReader } from './static-release-reader';

const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const STORAGE_KEY = 'artifacts/weather';

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function moduleItem(
  execution: Record<string, unknown> = {
    mode: 'sandboxed-web',
    entry: 'dist/index.html',
  },
): RegistryItem {
  return {
    name: 'weather-page',
    type: 'registry:module',
    title: 'Weather Page',
    module: {
      schemaVersion: 3,
      id: 'example.weather-page',
      version: '1.2.3',
      publisher: { id: 'example-publisher' },
      locales: ['en'],
      compatibility: { platform: '>=1.0.0', registry: '>=3.0.0' },
      execution,
      verification: { profile: 'sandboxed-web' },
      capabilities: [{ id: 'example.weather-page.view', kind: 'ui' }],
      openopc: { sdkApiVersion: 'v1' },
    },
  } as unknown as RegistryItem;
}

function packageBytes(item = moduleItem()): Uint8Array {
  return serializeDeveloperModuleArtifactPackage({
    item,
    files: [
      {
        path: 'dist/index.html',
        target: 'dist/index.html',
        mediaType: 'text/html',
        bytes: new TextEncoder().encode('<!doctype html><title>Weather</title>'),
        kind: 'file',
      },
      {
        path: 'dist/app.js',
        target: 'dist/app.js',
        mediaType: 'application/javascript',
        bytes: new TextEncoder().encode('window.weather = true;'),
        kind: 'file',
      },
    ],
  });
}

function releaseFor(bytes: Uint8Array): StaticModuleRelease {
  return {
    releaseId: RELEASE_ID,
    storageKey: STORAGE_KEY,
    artifactDigest: digest(bytes),
    artifactSize: bytes.byteLength,
    entryPath: 'dist/index.html',
  };
}

function readerFor(bytes: Uint8Array, yielded = bytes): StaticModuleReleaseReader {
  const artifactStore = {
    async *readCanonical() {
      yield yielded;
    },
  } satisfies Pick<DeveloperArtifactStore, 'readCanonical'>;
  return new StaticModuleReleaseReader({ artifactStore });
}

describe('static module release reader', () => {
  test('serves the manifest entry and packaged JavaScript with deterministic content types', async () => {
    const bytes = packageBytes();
    const reader = readerFor(bytes);
    const release = releaseFor(bytes);

    await expect(reader.read(release, '/')).resolves.toMatchObject({
      contentType: 'text/html; charset=utf-8',
    });
    await expect(reader.read(release, '/dist/app.js')).resolves.toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
    });
  });

  test('rejects artifact metadata above the static-host bound before storage access', async () => {
    const bytes = packageBytes();
    const artifactStore = {
      readCanonical(): AsyncIterable<Uint8Array> {
        throw new Error('oversized metadata must not reach storage');
      },
    } satisfies Pick<DeveloperArtifactStore, 'readCanonical'>;
    const reader = new StaticModuleReleaseReader({ artifactStore });

    await expect(
      reader.read({ ...releaseFor(bytes), artifactSize: 64 * 1024 * 1024 + 1 }, '/'),
    ).resolves.toBeNull();
  });

  test('rejects bytes whose digest does not match immutable release metadata', async () => {
    const bytes = packageBytes();
    const release = {
      ...releaseFor(bytes),
      artifactDigest: `sha256:${'0'.repeat(64)}` as const,
    };

    await expect(readerFor(bytes).read(release, '/')).resolves.toBeNull();
  });

  test('rejects a corrupt canonical artifact package', async () => {
    const bytes = new TextEncoder().encode('not a canonical package');

    await expect(readerFor(bytes).read(releaseFor(bytes), '/')).resolves.toBeNull();
  });

  test('rejects a package whose manifest is not sandboxed web', async () => {
    const bytes = packageBytes(moduleItem({ mode: 'declarative' }));

    await expect(readerFor(bytes).read(releaseFor(bytes), '/')).resolves.toBeNull();
  });

  test('rejects release metadata whose entry disagrees with the signed package manifest', async () => {
    const bytes = packageBytes();

    await expect(
      readerFor(bytes).read({ ...releaseFor(bytes), entryPath: 'dist/other.html' }, '/'),
    ).resolves.toBeNull();
  });

  test('rejects encoded traversal segments before packaged-file selection', async () => {
    const bytes = packageBytes();

    await expect(
      readerFor(bytes).read(releaseFor(bytes), '/dist/%2e%2e/secret.txt'),
    ).resolves.toBeNull();
  });

  test('rejects backslashes before packaged-file selection', async () => {
    const bytes = packageBytes();

    await expect(readerFor(bytes).read(releaseFor(bytes), '/dist%5capp.js')).resolves.toBeNull();
  });

  test('returns null when the requested file is absent from the package', async () => {
    const bytes = packageBytes();

    await expect(readerFor(bytes).read(releaseFor(bytes), '/dist/missing.js')).resolves.toBeNull();
  });

  test('rejects a canonical read whose byte length differs from release metadata', async () => {
    const bytes = packageBytes();
    const truncated = bytes.slice(0, bytes.byteLength - 1);

    await expect(readerFor(bytes, truncated).read(releaseFor(bytes), '/')).resolves.toBeNull();
  });
});
