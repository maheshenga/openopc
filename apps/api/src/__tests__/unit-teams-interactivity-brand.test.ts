import { describe, expect, test } from 'bun:test';
import { buildTeamsReviewLoginRequiredCard } from '../channels/teams/cards';

describe('Teams adaptive-card branding', () => {
  test('unlinked review response points to OpenOPC and retains /login', () => {
    const card = buildTeamsReviewLoginRequiredCard();

    expect(JSON.stringify(card)).toContain('OpenOPC');
    expect(JSON.stringify(card)).toContain('/login');
    expect(JSON.stringify(card)).not.toContain('Kortix');
  });
});
