import { afterAll, beforeEach, expect, test } from 'bun:test';

import { OPENOPC_RELEASE_PROFILE_DIGESTS } from '@kortix/api-contract';

import { config } from './config';
import { app } from './index';

const RESTRICTED_PROFILE = 'openopc-restricted-public-beta-v1';
const RENDERING_PROFILE = 'openopc-web-desktop-developer-beta-v2';
const original = {
  baseDomain: config.OPENOPC_MODULE_APP_BASE_DOMAIN,
  internalServiceKey: process.env.INTERNAL_SERVICE_KEY,
  profileId: process.env.OPENOPC_RELEASE_PROFILE_ID,
  profileDigest: process.env.OPENOPC_RELEASE_PROFILE_DIGEST,
};

function selectProfile(profileId: typeof RESTRICTED_PROFILE | typeof RENDERING_PROFILE): void {
  process.env.OPENOPC_RELEASE_PROFILE_ID = profileId;
  process.env.OPENOPC_RELEASE_PROFILE_DIGEST = OPENOPC_RELEASE_PROFILE_DIGESTS[profileId];
}

async function expectReadiness(input: {
  status: 200 | 503;
  profileId: typeof RESTRICTED_PROFILE | typeof RENDERING_PROFILE;
  hostReady: boolean;
}): Promise<void> {
  const response = await app.request('/readyz');
  const text = await response.text();

  expect(response.status).toBe(input.status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(text.length).toBeLessThanOrEqual(512);
  expect(JSON.parse(text)).toEqual({
    ready: input.status === 200,
    ready_for: input.profileId,
    release_profile_id: input.profileId,
    release_profile_digest: OPENOPC_RELEASE_PROFILE_DIGESTS[input.profileId],
    module_app_host_ready: input.hostReady,
  });
}

beforeEach(() => {
  config.OPENOPC_MODULE_APP_BASE_DOMAIN = '';
  process.env.INTERNAL_SERVICE_KEY = 'short';
});

afterAll(() => {
  config.OPENOPC_MODULE_APP_BASE_DOMAIN = original.baseDomain;
  if (original.internalServiceKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
  else process.env.INTERNAL_SERVICE_KEY = original.internalServiceKey;
  if (original.profileId === undefined) delete process.env.OPENOPC_RELEASE_PROFILE_ID;
  else process.env.OPENOPC_RELEASE_PROFILE_ID = original.profileId;
  if (original.profileDigest === undefined) delete process.env.OPENOPC_RELEASE_PROFILE_DIGEST;
  else process.env.OPENOPC_RELEASE_PROFILE_DIGEST = original.profileDigest;
});

test('returns 200 without module-host configuration when rendering is disabled', async () => {
  selectProfile(RESTRICTED_PROFILE);
  await expectReadiness({ status: 200, profileId: RESTRICTED_PROFILE, hostReady: true });
});

test('returns 200 with complete module-host configuration when rendering is enabled', async () => {
  selectProfile(RENDERING_PROFILE);
  config.OPENOPC_MODULE_APP_BASE_DOMAIN = 'modules.openopc.example';
  process.env.INTERNAL_SERVICE_KEY = 'internal-readyz-test-key';
  await expectReadiness({ status: 200, profileId: RENDERING_PROFILE, hostReady: true });
});

test('returns 503 when rendering is enabled without a module base domain', async () => {
  selectProfile(RENDERING_PROFILE);
  process.env.INTERNAL_SERVICE_KEY = 'internal-readyz-test-key';
  await expectReadiness({ status: 503, profileId: RENDERING_PROFILE, hostReady: false });
});

test('returns 503 when rendering is enabled with a short internal key', async () => {
  selectProfile(RENDERING_PROFILE);
  config.OPENOPC_MODULE_APP_BASE_DOMAIN = 'modules.openopc.example';
  await expectReadiness({ status: 503, profileId: RENDERING_PROFILE, hostReady: false });
});
