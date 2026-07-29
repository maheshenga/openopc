import { describe, expect, test } from 'bun:test';
import { buildTeamsHelpCard } from '../channels/teams/help';

describe('Teams command branding', () => {
  test('/help uses OpenOPC copy and retains the existing /login command', () => {
    const card = buildTeamsHelpCard();

    expect(JSON.stringify(card)).toContain('OpenOPC');
    expect(JSON.stringify(card)).toContain('/login');
    expect(JSON.stringify(card)).not.toContain('Kortix');
  });
});
