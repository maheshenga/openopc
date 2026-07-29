const { describe, expect, test } = require('bun:test');

const {
  desktopSessionUrl,
  fetchDesktopSessionUserId,
  parseDesktopSessionPayload,
} = require('./desktop-session');

describe('desktop authenticated session boundary', () => {
  test('accepts only a UUID user id from the same configured app origin', () => {
    expect(
      desktopSessionUrl(
        'https://app.openopc.example/projects',
        'https://app.openopc.example/projects/active',
      ),
    ).toBe('https://app.openopc.example/api/desktop/session');
    expect(parseDesktopSessionPayload({ userId: '00000000-0000-4000-8000-000000000001' })).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  test('rejects a renderer-controlled origin or malformed session payload', () => {
    expect(() =>
      desktopSessionUrl(
        'https://app.openopc.example/projects',
        'https://attacker.openopc.example/projects',
      ),
    ).toThrow(/origin/i);
    expect(() => parseDesktopSessionPayload({ userId: 'user-1' })).toThrow(/user id/i);
    expect(() => parseDesktopSessionPayload({})).toThrow(/user id/i);
  });

  test('fetches an uncached authenticated identity without following redirects', async () => {
    const calls = [];
    const userId = await fetchDesktopSessionUserId({
      configuredUrl: 'https://app.openopc.example/projects',
      frameUrl: 'https://app.openopc.example/projects/active',
      fetchSession: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          redirected: false,
          json: async () => ({ userId: '00000000-0000-4000-8000-000000000001' }),
        };
      },
    });

    expect(userId).toBe('00000000-0000-4000-8000-000000000001');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://app.openopc.example/api/desktop/session');
    expect(calls[0].init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test('fails closed for unauthorized, redirected, network, and timed-out identity requests', async () => {
    const base = {
      configuredUrl: 'https://app.openopc.example/projects',
      frameUrl: 'https://app.openopc.example/projects/active',
    };

    await expect(
      fetchDesktopSessionUserId({
        ...base,
        fetchSession: async () => ({ ok: false, redirected: false, json: async () => ({}) }),
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      fetchDesktopSessionUserId({
        ...base,
        fetchSession: async () => ({
          ok: true,
          redirected: true,
          json: async () => ({ userId: '00000000-0000-4000-8000-000000000001' }),
        }),
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      fetchDesktopSessionUserId({
        ...base,
        fetchSession: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      fetchDesktopSessionUserId({
        ...base,
        timeoutMs: 10,
        fetchSession: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      }),
    ).rejects.toThrow(/unavailable/i);
  });
});
