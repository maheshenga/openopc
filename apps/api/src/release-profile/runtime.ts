import {
  OPENOPC_RELEASE_PROFILE_DIGESTS,
  OPENOPC_RELEASE_PROFILE_IDS,
  type OpenOpcReleaseProfileId,
  RELEASE_PROFILE_UNAVAILABLE,
  type RestrictedRuntimeCapability,
} from '@kortix/api-contract';

export { RELEASE_PROFILE_UNAVAILABLE } from '@kortix/api-contract';
export type { OpenOpcReleaseProfileId, RestrictedRuntimeCapability } from '@kortix/api-contract';

export const OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID =
  'openopc-restricted-public-beta-v1' as const satisfies OpenOpcReleaseProfileId;
export const OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST =
  OPENOPC_RELEASE_PROFILE_DIGESTS[OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID];
export const OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID =
  'openopc-web-desktop-developer-beta-v2' as const satisfies OpenOpcReleaseProfileId;
export const OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_DIGEST =
  OPENOPC_RELEASE_PROFILE_DIGESTS[OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID];
export const OPENOPC_IMAGE_STUDIO_DEVELOPER_BETA_PROFILE_ID =
  'openopc-image-studio-developer-beta-v3' as const satisfies OpenOpcReleaseProfileId;
export const OPENOPC_IMAGE_STUDIO_DEVELOPER_BETA_PROFILE_DIGEST =
  OPENOPC_RELEASE_PROFILE_DIGESTS[OPENOPC_IMAGE_STUDIO_DEVELOPER_BETA_PROFILE_ID];

const PROFILE_CAPABILITIES: Readonly<
  Record<OpenOpcReleaseProfileId, readonly RestrictedRuntimeCapability[]>
> = {
  [OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_ID]: [
    'studio.text.generate',
    'studio.image.generate',
    'studio.video.generate',
    'module.wasi.execute',
  ],
  [OPENOPC_WEB_DESKTOP_DEVELOPER_BETA_PROFILE_ID]: [
    'module.wasi.execute',
    'module.app.render',
    'module.ai.gateway',
    'commerce.purchase',
  ],
  [OPENOPC_IMAGE_STUDIO_DEVELOPER_BETA_PROFILE_ID]: [
    'module.wasi.execute',
    'module.app.render',
    'module.ai.gateway',
    'studio.image.generate',
  ],
};

export interface RuntimeReleaseProfile {
  readonly id: OpenOpcReleaseProfileId | null;
  readonly digest: `sha256:${string}` | null;
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
  const selectedProfile = OPENOPC_RELEASE_PROFILE_IDS.find(
    (id) =>
      environment.OPENOPC_RELEASE_PROFILE_ID === id &&
      environment.OPENOPC_RELEASE_PROFILE_DIGEST === OPENOPC_RELEASE_PROFILE_DIGESTS[id],
  );
  const ready = selectedProfile !== undefined;
  const enabledCapabilities = new Set<RestrictedRuntimeCapability>(
    selectedProfile ? PROFILE_CAPABILITIES[selectedProfile] : [],
  );
  const runtimeProfile = {
    id: ready ? selectedProfile : null,
    digest: ready ? OPENOPC_RELEASE_PROFILE_DIGESTS[selectedProfile] : null,
    ready,
    unavailableCode: RELEASE_PROFILE_UNAVAILABLE,
    allows(capability: RestrictedRuntimeCapability): boolean {
      return ready && enabledCapabilities.has(capability);
    },
  } satisfies RuntimeReleaseProfile;
  return Object.freeze(runtimeProfile);
}

export function assertRuntimeCapability(
  capability: RestrictedRuntimeCapability,
  runtime: RuntimeReleaseProfile = loadRuntimeReleaseProfile(),
): void {
  if (!runtime.allows(capability)) throw new ReleaseProfileUnavailableError(capability);
}
