import { describe, expect, test } from 'bun:test';
import { SLACK_HOME_COPY } from '../channels/slack/home-copy';

describe('Slack App Home branding', () => {
  test('defines OpenOPC user-facing copy for the installed-workspace view', () => {
    expect(JSON.stringify(SLACK_HOME_COPY)).toContain('OpenOPC');
    expect(JSON.stringify(SLACK_HOME_COPY)).not.toContain('Kortix');
  });
});
