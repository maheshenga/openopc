import { describe, expect, test } from 'bun:test';

import { RELEASE_PROFILE_UNAVAILABLE, loadRuntimeReleaseProfile } from './runtime';

const digest = 'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c';

describe('loadRuntimeReleaseProfile', () => {
  test('fails closed for missing or malformed deployment identity', () => {
    expect(loadRuntimeReleaseProfile({}).ready).toBe(false);
    expect(
      loadRuntimeReleaseProfile({
        OPENOPC_RELEASE_PROFILE_ID: 'openopc-restricted-public-beta-v1',
        OPENOPC_RELEASE_PROFILE_DIGEST: 'sha256:not-a-real-digest',
      }).ready,
    ).toBe(false);
  });

  test('enables only approved restricted-public-beta capabilities', () => {
    const runtime = loadRuntimeReleaseProfile({
      OPENOPC_RELEASE_PROFILE_ID: 'openopc-restricted-public-beta-v1',
      OPENOPC_RELEASE_PROFILE_DIGEST: digest,
    });

    expect(runtime.ready).toBe(true);
    expect(runtime.allows('studio.text.generate')).toBe(true);
    expect(runtime.allows('studio.image.generate')).toBe(true);
    expect(runtime.allows('studio.video.generate')).toBe(true);
    expect(runtime.allows('module.wasi.execute')).toBe(true);
    expect(runtime.allows('module.oci.execute')).toBe(false);
    expect(runtime.unavailableCode).toBe(RELEASE_PROFILE_UNAVAILABLE);
  });

  test('does not accept caller parameters as capability enablement', () => {
    const runtime = loadRuntimeReleaseProfile({
      OPENOPC_RELEASE_PROFILE_ID: 'openopc-restricted-public-beta-v1',
      OPENOPC_RELEASE_PROFILE_DIGEST: digest,
      OPENOPC_RELEASE_PROFILE_CAPABILITIES: 'module.oci.execute,commerce.purchase',
    });

    expect(runtime.allows('module.oci.execute')).toBe(false);
    expect(runtime.allows('commerce.purchase')).toBe(false);
    expect(runtime.allows('artifact.remote-url')).toBe(false);
  });
});
