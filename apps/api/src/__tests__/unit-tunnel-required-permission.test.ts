import { describe, expect, mock, test } from 'bun:test';

mock.module('../shared/db', () => ({ db: {} }));

const { checkPermissionCandidates } = await import('../tunnel/core/permission-checker');

const PERMISSION_A = '10000000-0000-4000-a000-000000000001';
const PERMISSION_B = '10000000-0000-4000-a000-000000000002';
const PERMISSION_MISSING = '10000000-0000-4000-a000-000000000003';

const candidates = [
  {
    permissionId: PERMISSION_A,
    expiresAt: null,
    scope: { features: ['mouse'] },
  },
  {
    permissionId: PERMISSION_B,
    expiresAt: null,
    scope: { features: ['mouse'] },
  },
] as const;

describe('tunnel required permission fencing', () => {
  test('selects the exact required permission instead of another matching grant', () => {
    expect(checkPermissionCandidates(candidates, 'desktop', 'cua.click', { x: 12, y: 24 })).toEqual(
      { allowed: true, permissionId: PERMISSION_A },
    );

    expect(
      checkPermissionCandidates(candidates, 'desktop', 'cua.click', { x: 12, y: 24 }, PERMISSION_B),
    ).toEqual({ allowed: true, permissionId: PERMISSION_B });
  });

  test('fails closed when the required permission is absent or outside scope', () => {
    expect(
      checkPermissionCandidates(
        candidates,
        'desktop',
        'cua.click',
        { x: 12, y: 24 },
        PERMISSION_MISSING,
      ),
    ).toMatchObject({ allowed: false });

    expect(
      checkPermissionCandidates(
        candidates,
        'desktop',
        'cua.type_text',
        { text: 'safe test value' },
        PERMISSION_B,
      ),
    ).toMatchObject({ allowed: false });
  });
});
