import { expect, test } from 'bun:test';

import {
  combineModuleAppHostReadiness,
  moduleAppHostReadiness,
  parseModuleAppHostConfiguration,
} from './platform-host-config';

const RELEASE_ID = '10000000-0000-4000-a000-000000000001';
const SECOND_RELEASE_ID = '20000000-0000-4000-a000-000000000002';

test('builds one canonical immutable HTTPS origin per release', () => {
  const config = parseModuleAppHostConfiguration('modules.openopc.example');

  expect(config?.descriptorForRelease(RELEASE_ID)).toEqual({
    url: `https://r-${RELEASE_ID}.modules.openopc.example/`,
    origin: `https://r-${RELEASE_ID}.modules.openopc.example`,
  });
  expect(config?.descriptorForRelease(SECOND_RELEASE_ID)).toEqual({
    url: `https://r-${SECOND_RELEASE_ID}.modules.openopc.example/`,
    origin: `https://r-${SECOND_RELEASE_ID}.modules.openopc.example`,
  });
});

test.each([
  '',
  'MODULES.openopc.example',
  'modules.openopc.example.',
  '*.modules.openopc.example',
  'https://modules.openopc.example',
  'modules.openopc.example:443',
  'modules.openopc.example/path',
  'user@modules.openopc.example',
  '127.0.0.1',
  'localhost',
  'modules..openopc.example',
  `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(22)}.example`,
])('rejects a non-canonical module base domain: %s', (value) => {
  expect(parseModuleAppHostConfiguration(value)).toBeNull();
});

test('rejects malformed and non-canonical release UUIDs', () => {
  const config = parseModuleAppHostConfiguration('modules.openopc.example');

  for (const releaseId of [
    RELEASE_ID.toUpperCase(),
    '10000000-0000-0000-a000-000000000001',
    '10000000-0000-6000-a000-000000000001',
    '10000000-0000-4000-7000-000000000001',
    'not-a-release-id',
  ]) {
    expect(() => config?.descriptorForRelease(releaseId)).toThrow('INVALID_MODULE_RELEASE_ID');
  }
});

test('requires host configuration and an internal key only when rendering is enabled', () => {
  const configuration = parseModuleAppHostConfiguration('modules.openopc.example');

  expect(
    moduleAppHostReadiness({
      renderingEnabled: false,
      configuration: null,
      internalServiceKey: '',
    }),
  ).toEqual({ ready: true, code: null });
  expect(
    moduleAppHostReadiness({
      renderingEnabled: true,
      configuration: null,
      internalServiceKey: 'x'.repeat(32),
    }),
  ).toEqual({ ready: false, code: 'PROJECT_MODULE_HOST_UNAVAILABLE' });
  expect(
    moduleAppHostReadiness({
      renderingEnabled: true,
      configuration,
      internalServiceKey: 'x'.repeat(15),
    }),
  ).toEqual({ ready: false, code: 'PROJECT_MODULE_HOST_UNAVAILABLE' });
  expect(
    moduleAppHostReadiness({
      renderingEnabled: true,
      configuration,
      internalServiceKey: 'x'.repeat(16),
    }),
  ).toEqual({ ready: true, code: null });
});

test('combines module-host readiness without losing release-profile identity', () => {
  const readyProfile = {
    ready: true,
    ready_for: 'openopc-web-desktop-developer-beta-v2',
    release_profile_id: 'openopc-web-desktop-developer-beta-v2',
    release_profile_digest: `sha256:${'a'.repeat(64)}`,
  };
  const unavailableHost = {
    ready: false,
    code: 'PROJECT_MODULE_HOST_UNAVAILABLE' as const,
  };
  const readyHost = { ready: true, code: null };

  expect(combineModuleAppHostReadiness(readyProfile, unavailableHost)).toEqual({
    ...readyProfile,
    ready: false,
    module_app_host_ready: false,
  });
  expect(combineModuleAppHostReadiness({ ...readyProfile, ready: false }, readyHost)).toEqual({
    ...readyProfile,
    ready: false,
    module_app_host_ready: true,
  });
  expect(combineModuleAppHostReadiness(readyProfile, readyHost)).toEqual({
    ...readyProfile,
    ready: true,
    module_app_host_ready: true,
  });
});
