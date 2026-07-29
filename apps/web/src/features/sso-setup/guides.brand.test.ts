import { expect, test } from 'bun:test';

import { PROVIDER_GUIDES, SCIM_PROVIDER_GUIDES, SSO_GROUP_MAPPING_INTRO } from './guides';

test('SSO and SCIM setup guidance presents the OpenOPC product name', () => {
  const visibleGuidance = JSON.stringify([...PROVIDER_GUIDES, ...SCIM_PROVIDER_GUIDES]);

  expect(visibleGuidance).toContain('OpenOPC');
  expect(visibleGuidance).not.toMatch(/\bKortix\b/);
  expect(SSO_GROUP_MAPPING_INTRO).toBe(
    'Create an OpenOPC group for every group your IdP sends — no per-group mapping.',
  );
});
