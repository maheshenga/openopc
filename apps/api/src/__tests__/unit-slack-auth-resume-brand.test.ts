import { describe, expect, test } from 'bun:test';
import { buildSlackAuthPromptConnectedResponse } from '../channels/slack/auth-resume-message';

describe('Slack auth-resume branding', () => {
  test('builds the private prompt with OpenOPC copy', () => {
    const response = buildSlackAuthPromptConnectedResponse({
      hasAccess: true,
    });

    expect(JSON.stringify(response)).toContain('OpenOPC');
    expect(JSON.stringify(response)).not.toContain('Kortix');
  });
});
