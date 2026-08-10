import { expect, test } from 'bun:test';

import {
  DisabledStateAssessmentV1Schema,
  RELEASE_PROFILE_UNAVAILABLE,
  RESTRICTED_DISABLED_CAPABILITIES,
  ReleaseProfileStatusSchema,
  ReleaseProfileUnavailableSchema,
  RestrictedRuntimeCapabilitySchema,
} from './release-profile';

test('release profile unavailable code remains stable', () => {
  expect(RELEASE_PROFILE_UNAVAILABLE).toBe('OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE');
});

test('runtime profile schemas accept only the protected public wire contract', () => {
  expect(
    ReleaseProfileStatusSchema.parse({
      ready: true,
      ready_for: 'openopc-restricted-public-beta-v1',
      release_profile_id: 'openopc-restricted-public-beta-v1',
      release_profile_digest: `sha256:${'a'.repeat(64)}`,
    }),
  ).toEqual({
    ready: true,
    ready_for: 'openopc-restricted-public-beta-v1',
    release_profile_id: 'openopc-restricted-public-beta-v1',
    release_profile_digest: `sha256:${'a'.repeat(64)}`,
  });
  expect(() =>
    ReleaseProfileStatusSchema.parse({
      ready: true,
      ready_for: 'complete-public-beta',
      release_profile_id: 'openopc-restricted-public-beta-v1',
      release_profile_digest: `sha256:${'a'.repeat(64)}`,
    }),
  ).toThrow();
  expect(
    ReleaseProfileUnavailableSchema.parse({
      code: RELEASE_PROFILE_UNAVAILABLE,
      capability: 'commerce.purchase',
    }),
  ).toEqual({ code: RELEASE_PROFILE_UNAVAILABLE, capability: 'commerce.purchase' });
  expect(RestrictedRuntimeCapabilitySchema.safeParse('caller.supplied.feature').success).toBe(
    false,
  );
});

test('runtime profile status accepts each finite OpenOPC profile identity', () => {
  expect(
    ReleaseProfileStatusSchema.parse({
      ready: true,
      ready_for: 'openopc-web-desktop-developer-beta-v2',
      release_profile_id: 'openopc-web-desktop-developer-beta-v2',
      release_profile_digest: `sha256:${'b'.repeat(64)}`,
    }),
  ).toEqual({
    ready: true,
    ready_for: 'openopc-web-desktop-developer-beta-v2',
    release_profile_id: 'openopc-web-desktop-developer-beta-v2',
    release_profile_digest: `sha256:${'b'.repeat(64)}`,
  });
  expect(() =>
    ReleaseProfileStatusSchema.parse({
      ready: true,
      ready_for: 'openopc-web-desktop-developer-beta-v3',
      release_profile_id: 'openopc-web-desktop-developer-beta-v3',
      release_profile_digest: `sha256:${'b'.repeat(64)}`,
    }),
  ).toThrow();
  expect(RestrictedRuntimeCapabilitySchema.safeParse('module.ai.gateway').success).toBe(true);

  expect(
    ReleaseProfileStatusSchema.parse({
      ready: true,
      ready_for: 'openopc-image-studio-developer-beta-v3',
      release_profile_id: 'openopc-image-studio-developer-beta-v3',
      release_profile_digest: `sha256:${'c'.repeat(64)}`,
    }),
  ).toMatchObject({
    ready_for: 'openopc-image-studio-developer-beta-v3',
    release_profile_id: 'openopc-image-studio-developer-beta-v3',
  });
});

test('v1 disabled-state evidence covers the developer AI gateway capability', () => {
  expect(RESTRICTED_DISABLED_CAPABILITIES).toContain('module.ai.gateway');
});

test('disabled assessment schema rejects incomplete and self-described records', () => {
  const records = RESTRICTED_DISABLED_CAPABILITIES.map((capability) => ({
    capability,
    artifactAbsent: true,
    deployedServiceAbsent: true,
    serverFlag: false,
    apiCliRejected: true,
    iamCapabilityAbsent: true,
    legacyDirectRouteRejected: true,
    uiAdvertised: false,
  }));
  const assessment = {
    schemaVersion: 1,
    releaseProfileId: 'openopc-restricted-public-beta-v1',
    releaseProfileDigest: `sha256:${'a'.repeat(64)}`,
    commit: 'a'.repeat(40),
    controlSha: 'b'.repeat(40),
    records,
    assessmentDigest: `sha256:${'c'.repeat(64)}`,
  };
  expect(DisabledStateAssessmentV1Schema.safeParse(assessment).success).toBe(true);
  expect(
    DisabledStateAssessmentV1Schema.safeParse({ ...assessment, records: records.slice(1) }).success,
  ).toBe(false);
  expect(
    DisabledStateAssessmentV1Schema.safeParse({ ...assessment, records: [...records].reverse() })
      .success,
  ).toBe(false);
  expect(
    DisabledStateAssessmentV1Schema.safeParse({ ...assessment, selfReportedReady: true }).success,
  ).toBe(false);
});
