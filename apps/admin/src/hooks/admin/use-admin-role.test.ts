import { expect, mock, test } from 'bun:test';

import * as roleModule from './use-admin-role';

test('fetchAdminRole reads the authoritative Admin session through the Admin proxy', async () => {
  expect(roleModule.fetchAdminRole).toBeFunction();
  const get = mock(async (path: string, options?: unknown) => {
    expect(path).toBe('/session');
    expect(options).toEqual({ showErrors: false });
    return {
      success: true,
      data: {
      userId: '20000000-0000-4000-a000-000000000002',
      permissions: ['account.read'],
      stepUpAt: null,
      stepUpExpiresAt: null,
      },
    };
  });

  try {
    await expect(roleModule.fetchAdminRole(true, { get } as never)).resolves.toEqual({
      isAdmin: true,
      role: null,
    });
    expect(get).toHaveBeenCalledTimes(1);
  } finally {
    get.mockRestore();
  }
});
