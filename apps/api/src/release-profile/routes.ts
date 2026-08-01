import { Hono } from 'hono';

import {
  type OpenOpcReleaseProfileId,
  RELEASE_PROFILE_UNAVAILABLE,
  type RestrictedRuntimeCapability,
  type RuntimeReleaseProfile,
  loadRuntimeReleaseProfile,
} from './runtime';

export interface ReleaseProfileReadiness {
  ready: boolean;
  ready_for: OpenOpcReleaseProfileId | null;
  release_profile_id: OpenOpcReleaseProfileId | null;
  release_profile_digest: `sha256:${string}` | null;
}

export function releaseProfileReadiness(
  runtime: RuntimeReleaseProfile = loadRuntimeReleaseProfile(),
): ReleaseProfileReadiness {
  return Object.freeze({
    ready: runtime.ready,
    ready_for: runtime.ready ? runtime.id : null,
    release_profile_id: runtime.id,
    release_profile_digest: runtime.digest,
  });
}

export function rejectUnavailableCapability(
  c: { json: (body: unknown, status: number) => Response },
  capability: RestrictedRuntimeCapability,
  runtime: RuntimeReleaseProfile = loadRuntimeReleaseProfile(),
): Response | null {
  if (runtime.allows(capability)) return null;
  return c.json({ code: runtime.unavailableCode, capability }, 503);
}

/**
 * The developer beta's `commerce.purchase` capability belongs to the module
 * payment facade. The legacy credit-purchase route mutates the platform's
 * Stripe billing state and stays fail-closed until it receives its own profile
 * capability.
 */
export function rejectPlatformCreditPurchase(c: {
  json: (body: unknown, status: number) => Response;
}): Response {
  return c.json({ code: RELEASE_PROFILE_UNAVAILABLE, capability: 'commerce.purchase' }, 503);
}

export function createReleaseProfileRouter(
  runtime: RuntimeReleaseProfile = loadRuntimeReleaseProfile(),
) {
  const router = new Hono();
  router.get('/runtime-profile', (c) => {
    return c.json(releaseProfileReadiness(runtime), runtime.ready ? 200 : 503);
  });
  return router;
}
