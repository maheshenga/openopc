import { describe, expect, test } from 'bun:test';

import { RELEASE_PROFILE_UNAVAILABLE, RESTRICTED_RUNTIME_CAPABILITIES } from '@kortix/api-contract';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID,
  OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_DIGEST,
  OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID,
  loadRuntimeReleaseProfile,
} from './runtime';

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

  test('v1 rejects developer app, AI gateway, and purchase capabilities', () => {
    const runtime = loadRuntimeReleaseProfile({
      OPENOPC_RELEASE_PROFILE_ID: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID,
      OPENOPC_RELEASE_PROFILE_DIGEST: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
    });

    expect(runtime.allows('module.app.render')).toBe(false);
    expect(runtime.allows('module.ai.gateway')).toBe(false);
    expect(runtime.allows('commerce.purchase')).toBe(false);
  });

  test('v2 enables only the reviewed Web/Desktop developer capabilities', () => {
    const runtime = loadRuntimeReleaseProfile({
      OPENOPC_RELEASE_PROFILE_ID: OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID,
      OPENOPC_RELEASE_PROFILE_DIGEST: OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_DIGEST,
    });
    const enabled = new Set([
      'module.wasi.execute',
      'module.app.render',
      'module.ai.gateway',
      'commerce.purchase',
    ]);

    expect(runtime.ready).toBe(true);
    for (const capability of RESTRICTED_RUNTIME_CAPABILITIES) {
      expect(runtime.allows(capability)).toBe(enabled.has(capability));
    }
    expect(runtime.allows('commerce.settlement')).toBe(false);
    expect(runtime.allows('native.mobile')).toBe(false);
  });

  test('v2 remains unavailable when either deployment identity component mismatches', () => {
    expect(
      loadRuntimeReleaseProfile({
        OPENOPC_RELEASE_PROFILE_ID: OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID,
        OPENOPC_RELEASE_PROFILE_DIGEST: `sha256:${'0'.repeat(64)}`,
      }).ready,
    ).toBe(false);
  });

  test('v3 combines sandboxed modules, the AI gateway, and Studio image generation', () => {
    const runtime = loadRuntimeReleaseProfile({
      OPENOPC_RELEASE_PROFILE_ID: 'openopc-image-studio-developer-beta-v3',
      OPENOPC_RELEASE_PROFILE_DIGEST:
        'sha256:184ef4c2d10b8fe311b3b764c96c371c02295a67b445b0c5538b01e627a7267f',
    });

    expect(runtime.ready).toBe(true);
    expect(runtime.allows('module.wasi.execute')).toBe(true);
    expect(runtime.allows('module.app.render')).toBe(true);
    expect(runtime.allows('module.ai.gateway')).toBe(true);
    expect(runtime.allows('studio.image.generate')).toBe(true);
    expect(runtime.allows('commerce.purchase')).toBe(false);
  });
});
