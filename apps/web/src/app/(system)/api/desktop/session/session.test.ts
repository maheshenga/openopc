import { describe, expect, test } from 'bun:test';

import { DesktopSessionError, resolveDesktopSession } from './session';

describe('desktop session identity endpoint contract', () => {
  test('returns only the authenticated UUID user id', async () => {
    await expect(
      resolveDesktopSession(async () => ({
        data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
        error: null,
      })),
    ).resolves.toEqual({ userId: '00000000-0000-4000-8000-000000000001' });
  });

  test('fails closed when the server session is missing or malformed', async () => {
    const unauthenticated = expect(
      resolveDesktopSession(async () => ({ data: { user: null }, error: null })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await unauthenticated;
    const malformed = resolveDesktopSession(async () => ({
      data: { user: { id: 'user-1' } },
      error: null,
    }));
    await expect(malformed).rejects.toBeInstanceOf(DesktopSessionError);
    await expect(malformed).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
  });
});
