import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UpgradePlansModal } from './global-upgrade-modal';
import { parseRuntimeProfileDisplayState } from './release-profile';
import { TeamPlanCheckout } from './team-plan-checkout';
import { UpgradeButton } from './upgrade-button';

test('restricted public beta renders no billing upgrade or checkout commands', () => {
  const prior = process.env.NEXT_PUBLIC_OPENOPC_RELEASE_PROFILE_ID;
  process.env.NEXT_PUBLIC_OPENOPC_RELEASE_PROFILE_ID = 'openopc-restricted-public-beta-v1';
  try {
    expect(renderToStaticMarkup(<UpgradeButton />)).toBe('');
    expect(renderToStaticMarkup(<UpgradePlansModal open onOpenChange={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<TeamPlanCheckout open onOpenChange={() => {}} />)).toBe('');
  } finally {
    process.env.NEXT_PUBLIC_OPENOPC_RELEASE_PROFILE_ID = prior;
  }
});

test('server runtime profile display parsing fails closed for unknown profiles', () => {
  expect(parseRuntimeProfileDisplayState(undefined)).toBe('restricted');
  expect(parseRuntimeProfileDisplayState({ ready: true })).toBe('restricted');
  expect(
    parseRuntimeProfileDisplayState({
      ready: true,
      release_profile_id: 'openopc-restricted-public-beta-v1',
    }),
  ).toBe('restricted');
  expect(
    parseRuntimeProfileDisplayState({ ready: true, release_profile_id: 'future-reviewed-profile' }),
  ).toBe('restricted');
});
