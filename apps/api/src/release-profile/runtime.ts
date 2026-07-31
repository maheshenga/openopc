import {
  RELEASE_PROFILE_UNAVAILABLE,
  type RestrictedRuntimeCapability,
} from '@kortix/api-contract';

export { RELEASE_PROFILE_UNAVAILABLE } from '@kortix/api-contract';
export type { RestrictedRuntimeCapability } from '@kortix/api-contract';

export const OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID =
  'openopc-restricted-public-beta-v1' as const;
export const OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST =
  'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c' as const;

const ENABLED_CAPABILITIES = new Set<RestrictedRuntimeCapability>([
  'studio.text.generate',
  'studio.image.generate',
  'studio.video.generate',
  'module.wasi.execute',
]);

export interface RuntimeReleaseProfile {
  readonly id: typeof OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID | null;
  readonly digest: typeof OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST | null;
  readonly ready: boolean;
  readonly unavailableCode: typeof RELEASE_PROFILE_UNAVAILABLE;
  allows(capability: RestrictedRuntimeCapability): boolean;
}

export class ReleaseProfileUnavailableError extends Error {
  readonly code = RELEASE_PROFILE_UNAVAILABLE;
  readonly status = 503;

  constructor(readonly capability: RestrictedRuntimeCapability) {
    super(RELEASE_PROFILE_UNAVAILABLE);
    this.name = 'ReleaseProfileUnavailableError';
  }
}

export function loadRuntimeReleaseProfile(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeReleaseProfile {
  const ready =
    environment.OPENOPC_RELEASE_PROFILE_ID === OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID &&
    environment.OPENOPC_RELEASE_PROFILE_DIGEST === OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST;
  const profile = {
    id: ready ? OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID : null,
    digest: ready ? OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST : null,
    ready,
    unavailableCode: RELEASE_PROFILE_UNAVAILABLE,
    allows(capability: RestrictedRuntimeCapability): boolean {
      return ready && ENABLED_CAPABILITIES.has(capability);
    },
  } satisfies RuntimeReleaseProfile;
  return Object.freeze(profile);
}

export function assertRuntimeCapability(
  capability: RestrictedRuntimeCapability,
  runtime: RuntimeReleaseProfile = loadRuntimeReleaseProfile(),
): void {
  if (!runtime.allows(capability)) throw new ReleaseProfileUnavailableError(capability);
}
