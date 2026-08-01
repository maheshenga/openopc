import { expect, test } from 'bun:test';

import {
  createReleaseProfileRouter,
  rejectPlatformCreditPurchase,
  releaseProfileReadiness,
} from './routes';
import {
  OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_DIGEST,
  OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID,
  loadRuntimeReleaseProfile,
} from './runtime';

const readyRuntime = loadRuntimeReleaseProfile({
  OPENOPC_RELEASE_PROFILE_ID: 'openopc-restricted-public-beta-v1',
  OPENOPC_RELEASE_PROFILE_DIGEST:
    'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c',
});

const readyDeveloperRuntime = loadRuntimeReleaseProfile({
  OPENOPC_RELEASE_PROFILE_ID: OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID,
  OPENOPC_RELEASE_PROFILE_DIGEST: OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_DIGEST,
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

test('readiness exposes the separately identified developer beta profile', async () => {
  expect(releaseProfileReadiness(readyDeveloperRuntime)).toEqual({
    ready: true,
    ready_for: 'openopc-web-desktop-developer-beta-v2',
    release_profile_id: 'openopc-web-desktop-developer-beta-v2',
    release_profile_digest: OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_DIGEST,
  });
  const response =
    await createReleaseProfileRouter(readyDeveloperRuntime).request('/runtime-profile');
  expect(response.status).toBe(200);
  expect((await response.json()).release_profile_id).toBe('openopc-web-desktop-developer-beta-v2');
});

test('legacy platform credit purchases remain fail-closed outside module payments', () => {
  const response = rejectPlatformCreditPurchase({
    json(body, status) {
      return Response.json(body, { status });
    },
  });
  expect(response.status).toBe(503);
});
