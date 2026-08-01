import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { RegistryItem } from '@kortix/registry';

import {
  createMemoryDeveloperArtifactStore,
  serializeDeveloperModuleArtifactPackage,
} from '../developer/artifacts';
import {
  ModuleCustomDomainStaticHostService,
  createMemoryModuleCustomDomainHostRepository,
  createModuleCustomDomainHostRoutes,
} from './host';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const BINDING_ID = '60000000-0000-4000-a000-000000000006';
const OTHER_BINDING_ID = '60000000-0000-4000-a000-000000000007';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const INTERNAL_SERVICE_KEY = 'internal-module-host-test-key';

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sandboxedWebItem(): RegistryItem {
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
      execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
      verification: { profile: 'sandboxed-web' },
      capabilities: [{ id: 'example.weather-page.view', kind: 'ui' }],
      openopc: { sdkApiVersion: 'v1' },
    },
  } as RegistryItem;
}

async function hostHarness() {
  const artifactStore = createMemoryDeveloperArtifactStore();
  const artifactBytes = serializeDeveloperModuleArtifactPackage({
    item: sandboxedWebItem(),
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
  const artifactDigest = digest(artifactBytes);
  const storageKey = await artifactStore.store.writeCanonical({
    accountId: ACCOUNT_ID,
    artifactDigest,
    bytes: artifactBytes,
    digest: artifactDigest,
  });
  const hostService = new ModuleCustomDomainStaticHostService({
    repository: createMemoryModuleCustomDomainHostRepository({
      releases: [
        {
          environment: 'dev',
          bindingId: BINDING_ID,
          releaseId: RELEASE_ID,
          storageKey,
          artifactDigest,
          artifactSize: artifactBytes.byteLength,
          entryPath: 'dist/index.html',
        },
      ],
    }),
    artifactStore: artifactStore.store,
  });
  return createModuleCustomDomainHostRoutes({
    hostService,
    internalServiceKey: INTERNAL_SERVICE_KEY,
    environment: 'dev',
  });
}

describe('module custom domain static host', () => {
  test('serves the immutable sandboxed-web entry only for the active binding selected by the worker', async () => {
    const app = await hostHarness();

    const response = await app.request(`/module-host/releases/${RELEASE_ID}/`, {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Domain-Binding': BINDING_ID,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html><title>Weather</title>');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('rejects unauthenticated or mismatched worker binding requests without revealing release data', async () => {
    const app = await hostHarness();

    const unauthenticated = await app.request(`/module-host/releases/${RELEASE_ID}/dist/app.js`, {
      headers: { 'X-OpenOPC-Module-Domain-Binding': BINDING_ID },
    });
    expect(unauthenticated.status).toBe(401);

    const mismatched = await app.request(`/module-host/releases/${RELEASE_ID}/dist/app.js`, {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Domain-Binding': OTHER_BINDING_ID,
      },
    });
    expect(mismatched.status).toBe(404);
    expect(await mismatched.text()).not.toContain('Weather');
  });
});
