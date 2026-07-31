import {
  type RestrictedRuntimeCapability,
  type RuntimeReleaseProfile,
  loadRuntimeReleaseProfile,
} from './runtime';

const PROFILE_DIGEST = 'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c';

export const RESTRICTED_RUNTIME_TEST_PROFILE = loadRuntimeReleaseProfile({
  OPENOPC_RELEASE_PROFILE_ID: 'openopc-restricted-public-beta-v1',
  OPENOPC_RELEASE_PROFILE_DIGEST: PROFILE_DIGEST,
});

export const NON_READY_RUNTIME_TEST_PROFILE = loadRuntimeReleaseProfile({});

function serverOwnedRuntimeTestProfile(
  capabilities: readonly RestrictedRuntimeCapability[],
): RuntimeReleaseProfile {
  const allowedCapabilities = new Set(capabilities);
  return Object.freeze({
    id: 'openopc-restricted-public-beta-v1',
    digest: PROFILE_DIGEST,
    ready: true,
    unavailableCode: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
    allows(capability: RestrictedRuntimeCapability) {
      return allowedCapabilities.has(capability);
    },
  });
}

export const FUTURE_WASI_RUNTIME_TEST_PROFILE = serverOwnedRuntimeTestProfile([
  'module.wasi.execute',
]);

export const FUTURE_OCI_RUNTIME_TEST_PROFILE = serverOwnedRuntimeTestProfile([
  'module.wasi.execute',
  'module.oci.execute',
]);

export const COMPLETE_RUNTIME_TEST_PROFILE: RuntimeReleaseProfile = Object.freeze({
  id: 'openopc-restricted-public-beta-v1',
  digest: PROFILE_DIGEST,
  ready: true,
  unavailableCode: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
  allows(_capability: RestrictedRuntimeCapability) {
    return true;
  },
});
