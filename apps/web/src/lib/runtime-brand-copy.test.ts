import { expect, test } from 'bun:test';

import {
  getBootCpuLabel,
  getBootBiosLabel,
  getBootOsLabel,
  getCreditsLabel,
  getIncludedCreditsDescription,
  getManagedKeysOverrideDescription,
  getMobileAppAlt,
  getModelAvailabilityMessage,
  getModelConnectionDescription,
  getModelSetupDescription,
  getNewVersionLabel,
  getSessionStartAriaLabel,
  getSubscriptionActivatedDescription,
  getTeamPlanLabel,
  getVersionHistoryDescription,
} from './runtime-brand-copy';

test('onboarding copy presents OpenOPC credits and managed keys', () => {
  expect(getIncludedCreditsDescription()).toBe('Included with your OpenOPC credits');
  expect(getModelSetupDescription()).toBe(
    'Log in with your coding subscription, paste an API key, or skip to use OpenOPC credits.',
  );
  expect(getManagedKeysOverrideDescription()).toBe(
    'These keys will override the default OpenOPC-managed keys for these tools.',
  );
  expect(getCreditsLabel()).toBe('OpenOPC Credits');
  expect(getBootCpuLabel()).toBe('CPU: OpenOPC Inference Engine X1 @ 3.80 GHz');
  expect(getBootBiosLabel()).toBe('OPENOPC BIOS v2.0.1');
  expect(getBootOsLabel()).toBe('All systems nominal. Starting OPENOPC OS...');
});

test('runtime surfaces name the OpenOPC local execution node', () => {
  expect(getSessionStartAriaLabel()).toBe('Starting your OpenOPC Local Execution');
  expect(getVersionHistoryDescription()).toBe('Version history for OpenOPC Local Execution');
});

test('managed-model guidance presents the OpenOPC subscription', () => {
  expect(getModelConnectionDescription()).toBe(
    "This session needs an LLM connected before it can respond. Upgrade for instant access to OpenOPC's managed models, or bring your own API key from any provider.",
  );
  expect(getModelAvailabilityMessage()).toBe(
    'Connect a model via provider first or upgrade your OpenOPC subscription.',
  );
});

test('account surfaces name the OpenOPC team plan', () => {
  expect(getTeamPlanLabel()).toBe('OpenOPC Team');
  expect(getSubscriptionActivatedDescription()).toBe(
    'Your team is on OpenOPC Team. Compute and LLM credits are ready.',
  );
});

test('update and download surfaces expose the OpenOPC product name', () => {
  expect(getNewVersionLabel('stable')).toBe('New OpenOPC version');
  expect(getNewVersionLabel('dev')).toBe('New dev build');
  expect(getMobileAppAlt()).toBe('OpenOPC mobile app');
});
