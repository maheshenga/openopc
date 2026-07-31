import { Hono } from 'hono';

import {
  type RestrictedRuntimeCapability,
  type RuntimeReleaseProfile,
  loadRuntimeReleaseProfile,
} from './runtime';

export function releaseProfileReadiness(
  runtime: RuntimeReleaseProfile = loadRuntimeReleaseProfile(),
) {
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
): Response | null {
  const runtime = loadRuntimeReleaseProfile();
  if (runtime.allows(capability)) return null;
  return c.json({ code: runtime.unavailableCode, capability }, 503);
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
