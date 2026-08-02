import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { RegistryItem } from '@kortix/registry';

import {
  createMemoryDeveloperArtifactStore,
  serializeDeveloperModuleArtifactPackage,
} from '../developer/artifacts';
import type { RuntimeReleaseProfile } from '../release-profile/runtime';
import {
  DEVELOPER_RUNTIME_TEST_PROFILE,
  RESTRICTED_RUNTIME_TEST_PROFILE,
} from '../release-profile/test-fixtures';
import {
  ModuleCustomDomainStaticHostService,
  ModulePlatformStaticHostService,
  createMemoryModuleCustomDomainHostRepository,
  createModuleCustomDomainHostRoutes,
  parseModuleFrameAncestors,
} from './host';
import { type StaticModuleRelease, StaticModuleReleaseReader } from './static-release-reader';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const BINDING_ID = '60000000-0000-4000-a000-000000000006';
const OTHER_BINDING_ID = '60000000-0000-4000-a000-000000000007';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const OTHER_RELEASE_ID = '40000000-0000-4000-a000-000000000005';
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

type PlatformReleaseState =
  | 'published'
  | 'unpublished'
  | 'revoked'
  | 'deprecated'
  | 'missing-artifact'
  | 'corrupt-artifact'
  | 'repository-unavailable';

async function hostHarness(
  input: {
    runtime?: RuntimeReleaseProfile;
    internalServiceKey?: string;
    platformReleaseState?: PlatformReleaseState;
    platformHostAvailable?: boolean;
    frameValues?: readonly (string | undefined)[];
  } = {},
) {
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
  const corruptBytes = new TextEncoder().encode('not a canonical package');
  const corruptDigest = digest(corruptBytes);
  const corruptStorageKey = await artifactStore.store.writeCanonical({
    accountId: ACCOUNT_ID,
    artifactDigest: corruptDigest,
    bytes: corruptBytes,
    digest: corruptDigest,
  });
  const release: StaticModuleRelease = {
    releaseId: RELEASE_ID,
    storageKey,
    artifactDigest,
    artifactSize: artifactBytes.byteLength,
    entryPath: 'dist/index.html',
  };
  const reader = new StaticModuleReleaseReader({ artifactStore: artifactStore.store });
  const hostService = new ModuleCustomDomainStaticHostService({
    repository: createMemoryModuleCustomDomainHostRepository({
      releases: [
        {
          environment: 'dev',
          bindingId: BINDING_ID,
          ...release,
        },
      ],
    }),
    reader,
  });
  const platformState = input.platformReleaseState ?? 'published';
  const platformRelease =
    platformState === 'missing-artifact'
      ? { ...release, storageKey: 'artifacts/missing' }
      : platformState === 'corrupt-artifact'
        ? {
            ...release,
            storageKey: corruptStorageKey,
            artifactDigest: corruptDigest,
            artifactSize: corruptBytes.byteLength,
          }
        : release;
  const platformHostService =
    input.platformHostAvailable === false
      ? null
      : new ModulePlatformStaticHostService({
          repository: {
            async loadPublishedSandboxedWebRelease() {
              if (platformState === 'repository-unavailable') {
                throw new Error('database unavailable');
              }
              return platformState === 'published' ||
                platformState === 'missing-artifact' ||
                platformState === 'corrupt-artifact'
                ? platformRelease
                : null;
            },
          },
          reader,
        });
  return createModuleCustomDomainHostRoutes({
    hostService,
    platformHostService,
    frameAncestors: parseModuleFrameAncestors(input.frameValues ?? ['https://app.openopc.example']),
    internalServiceKey: input.internalServiceKey ?? INTERNAL_SERVICE_KEY,
    environment: 'dev',
    runtime: input.runtime ?? DEVELOPER_RUNTIME_TEST_PROFILE,
  });
}

describe('module static host frame policy', () => {
  test('accepts exact HTTPS and loopback HTTP origins while rejecting URL embellishments', () => {
    expect(
      parseModuleFrameAncestors([
        'https://app.openopc.example',
        'https://app.openopc.example/',
        'http://localhost:3000',
        'http://127.0.0.1:3000/',
        'http://[::1]:3000',
        'http://app.openopc.example',
        'https://user:pass@app.openopc.example',
        'https://app.openopc.example/path',
        'https://app.openopc.example/?query=1',
        'https://app.openopc.example/#fragment',
        'https://*.example.com',
        'https://*',
        undefined,
      ]),
    ).toEqual([
      'https://app.openopc.example',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]);
  });
});

describe('module custom domain static host', () => {
  test('rejects sandboxed-web assets when the deployment profile does not enable rendering', async () => {
    const app = await hostHarness({ runtime: RESTRICTED_RUNTIME_TEST_PROFILE });

    const response = await app.request(`/module-host/releases/${RELEASE_ID}/`, {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Domain-Binding': BINDING_ID,
      },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.app.render',
    });
  });

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
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://app.openopc.example',
    );
  });

  test('rejects unauthenticated or mismatched worker binding requests without revealing release data', async () => {
    const app = await hostHarness();

    const unauthenticated = await app.request(`/module-host/releases/${RELEASE_ID}/dist/app.js`, {
      headers: { 'X-OpenOPC-Module-Domain-Binding': BINDING_ID },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe('Unauthorized');

    const mismatched = await app.request(`/module-host/releases/${RELEASE_ID}/dist/app.js`, {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Domain-Binding': OTHER_BINDING_ID,
      },
    });
    expect(mismatched.status).toBe(404);
    expect(await mismatched.text()).toBe('Not Found');
  });
});

describe('module platform static host', () => {
  test('serves an immutable release origin with the shared static security policy', async () => {
    const app = await hostHarness();

    const response = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Release': RELEASE_ID,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Weather</title>');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://app.openopc.example',
    );
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });

  test("uses frame-ancestors 'none' when no configured frontend origin is valid", async () => {
    const app = await hostHarness({ frameValues: ['http://app.openopc.example/path'] });

    const response = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Release': RELEASE_ID,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  test('rejects a missing worker key and a configured key that is too short', async () => {
    const app = await hostHarness();
    const missing = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
      headers: { 'X-OpenOPC-Module-Release': RELEASE_ID },
    });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe('Unauthorized');

    const shortKeyApp = await hostHarness({ internalServiceKey: 'short' });
    const short = await shortKeyApp.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
      headers: {
        'X-Kortix-Internal-Key': 'short',
        'X-OpenOPC-Module-Release': RELEASE_ID,
      },
    });
    expect(short.status).toBe(401);
    expect(await short.text()).toBe('Unauthorized');
  });

  test('rejects forged, malformed, or cross-release trusted identity headers', async () => {
    const app = await hostHarness();
    for (const header of ['', 'not-a-release', OTHER_RELEASE_ID]) {
      const response = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
        headers: {
          'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
          ...(header ? { 'X-OpenOPC-Module-Release': header } : {}),
        },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    }
  });

  test('checks the capability profile before release identity or repository data', async () => {
    const app = await hostHarness({
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      platformReleaseState: 'repository-unavailable',
    });

    const response = await app.request('/module-host/platform/releases/not-a-uuid/', {
      headers: {
        'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Release': 'not-a-uuid',
      },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.app.render',
    });
  });

  for (const state of ['unpublished', 'revoked', 'deprecated'] as const) {
    test(`does not expose a ${state} release`, async () => {
      const app = await hostHarness({ platformReleaseState: state });

      const response = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
        headers: {
          'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
          'X-OpenOPC-Module-Release': RELEASE_ID,
        },
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    });
  }

  for (const state of ['missing-artifact', 'corrupt-artifact'] as const) {
    test(`does not expose a release with a ${state}`, async () => {
      const app = await hostHarness({ platformReleaseState: state });

      const response = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
        headers: {
          'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
          'X-OpenOPC-Module-Release': RELEASE_ID,
        },
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    });
  }

  test('maps unavailable platform repository and service states to opaque not found responses', async () => {
    const unavailableRepository = await hostHarness({
      platformReleaseState: 'repository-unavailable',
    });
    const unavailableService = await hostHarness({ platformHostAvailable: false });
    for (const app of [unavailableRepository, unavailableService]) {
      const response = await app.request(`/module-host/platform/releases/${RELEASE_ID}/`, {
        headers: {
          'X-Kortix-Internal-Key': INTERNAL_SERVICE_KEY,
          'X-OpenOPC-Module-Release': RELEASE_ID,
        },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    }
  });
});
