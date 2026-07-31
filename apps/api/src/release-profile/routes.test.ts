import { expect, test } from 'bun:test';

import { createReleaseProfileRouter, releaseProfileReadiness } from './routes';
import { loadRuntimeReleaseProfile } from './runtime';

const readyRuntime = loadRuntimeReleaseProfile({
  OPENOPC_RELEASE_PROFILE_ID: 'openopc-restricted-public-beta-v1',
  OPENOPC_RELEASE_PROFILE_DIGEST:
    'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c',
});

test('runtime profile route fails closed without deployment identity', async () => {
  const response = await createReleaseProfileRouter().request('/runtime-profile');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    ready: false,
    ready_for: null,
    release_profile_id: null,
    release_profile_digest: null,
  });
});

test('readiness names only the exact restricted public beta profile', async () => {
  expect(releaseProfileReadiness(readyRuntime)).toEqual({
    ready: true,
    ready_for: 'openopc-restricted-public-beta-v1',
    release_profile_id: 'openopc-restricted-public-beta-v1',
    release_profile_digest:
      'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c',
  });
  const response = await createReleaseProfileRouter(readyRuntime).request('/runtime-profile');
  expect(response.status).toBe(200);
  expect((await response.json()).ready_for).toBe('openopc-restricted-public-beta-v1');
});
