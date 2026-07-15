import { describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({
  config: {
    API_KEY_SECRET: 'test-api-key-secret',
  },
}));

mock.module('../shared/db', () => ({
  db: {},
}));

const { isAccountTokenLifecycleActive } = await import('../repositories/account-tokens');

describe('Studio worker token lifecycle checks', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');

  test('accepts only active, unrevoked, unexpired project-bound tokens', () => {
    expect(
      isAccountTokenLifecycleActive(
        {
          status: 'active',
          revokedAt: null,
          expiresAt: new Date('2026-07-15T13:00:00.000Z'),
          projectId: 'project-1',
        },
        'project-1',
        now,
      ),
    ).toEqual({ active: true });
  });

  test('rejects revoked, expired, inactive, or wrong-project tokens', () => {
    expect(
      isAccountTokenLifecycleActive(
        { status: 'revoked', revokedAt: null, expiresAt: null, projectId: 'project-1' },
        'project-1',
        now,
      ),
    ).toEqual({ active: false, reason: 'inactive' });

    expect(
      isAccountTokenLifecycleActive(
        {
          status: 'active',
          revokedAt: new Date('2026-07-15T11:00:00.000Z'),
          expiresAt: null,
          projectId: 'project-1',
        },
        'project-1',
        now,
      ),
    ).toEqual({ active: false, reason: 'revoked' });

    expect(
      isAccountTokenLifecycleActive(
        {
          status: 'active',
          revokedAt: null,
          expiresAt: new Date('2026-07-15T11:59:59.000Z'),
          projectId: 'project-1',
        },
        'project-1',
        now,
      ),
    ).toEqual({ active: false, reason: 'expired' });

    expect(
      isAccountTokenLifecycleActive(
        { status: 'active', revokedAt: null, expiresAt: null, projectId: 'project-2' },
        'project-1',
        now,
      ),
    ).toEqual({ active: false, reason: 'project_mismatch' });
  });
});
