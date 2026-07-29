import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAuthWelcomeTitle,
  buildChatIdentityConnectCopy,
  buildChatIdentityMissingLinkMessage,
  buildChatIdentitySuccessDescription,
} from './auth-brand-copy.ts';
import { buildDesktopBounceHtml, buildMobileBounceHtml } from './desktop-bounce.ts';

test('auth welcomes returning users with the visible product brand', () => {
  assert.equal(buildAuthWelcomeTitle(), 'Welcome to OpenOPC');
});

test('chat authorization names the visible product brand', () => {
  assert.deepEqual(buildChatIdentityConnectCopy('Slack'), {
    title: 'Connect Slack to OpenOPC',
    description:
      "The OpenOPC bot in Slack will run as you, with your own credentials, secrets, and connected apps instead of the installer's.",
  });
});

test('chat binding results name the visible product brand in every outcome', () => {
  assert.equal(
    buildChatIdentitySuccessDescription({
      service: 'Teams',
      workspaceName: 'Operations',
      hasAccess: false,
      resumed: false,
    }),
    'Your OpenOPC account is connected in Operations. Head back to Teams and request project access to continue.',
  );
  assert.equal(
    buildChatIdentitySuccessDescription({
      service: 'Slack',
      workspaceName: null,
      hasAccess: true,
      resumed: true,
    }),
    'Your OpenOPC account is connected. OpenOPC is picking up your Slack message now.',
  );
  assert.equal(
    buildChatIdentitySuccessDescription({
      service: 'Teams',
      hasAccess: true,
      resumed: false,
    }),
    'Your OpenOPC account is connected. Head back to Teams and mention OpenOPC with a task.',
  );
});

test('expired chat links use the visible brand without renaming the Slack command', () => {
  assert.equal(
    buildChatIdentityMissingLinkMessage('Slack'),
    'This page is opened from an OpenOPC message in Slack. Run /kortix login in Slack to get a fresh link.',
  );
  assert.equal(
    buildChatIdentityMissingLinkMessage('Teams'),
    'This page is opened from an OpenOPC message in Teams. Start the login from Teams to get a fresh link.',
  );
});

test('native bounce pages name the desktop product while preserving the custom scheme', () => {
  const desktopHtml = buildDesktopBounceHtml(
    new URLSearchParams({ desktop: 'true', code: 'desktop-code' }),
  );
  assert.ok(desktopHtml.includes('<title>Opening OpenOPC Desktop…</title>'));
  assert.ok(desktopHtml.includes('Opening OpenOPC Desktop… you can close this tab.'));
  assert.ok(desktopHtml.includes('kortix://auth/callback?code=desktop-code'));

  const mobileHtml = buildMobileBounceHtml(
    new URLSearchParams({ mobile_callback: '1', code: 'mobile-code' }),
  );
  assert.ok(mobileHtml.includes('>Open OpenOPC Desktop</a>'));
  assert.ok(mobileHtml.includes('kortix://auth/callback?mobile_callback=1'));
});
