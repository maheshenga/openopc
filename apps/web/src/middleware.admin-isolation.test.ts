import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { config, middleware } from './middleware';

const originalFetch = globalThis.fetch;
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
};

beforeAll(() => {
  process.env.SUPABASE_URL = 'https://supabase.openopc.invalid';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  globalThis.fetch = mock(async () =>
    Response.json({ user: null }, { status: 401 }),
  ) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalEnv.SUPABASE_URL;
  if (originalEnv.SUPABASE_ANON_KEY === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalEnv.SUPABASE_ANON_KEY;
});

describe('Web Admin surface isolation', () => {
  for (const pathname of [
    '/admin',
    '/admin/accounts',
    '/_next/static/chunks/admin-shell.js',
    '/admin-assets/operator.css',
    '/_openopc-admin/runtime.js',
  ]) {
    test(`returns an opaque 404 for ${pathname}`, async () => {
      const response = await middleware(
        new NextRequest(`https://app.openopc.example${pathname}`, {
          headers: { authorization: 'Bearer consumer-secret' },
        }),
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    });
  }

  test('the production matcher reaches Admin chunks before the static shortcut', () => {
    const path = '/_next/static/chunks/admin-shell.js';
    const patterns = config.matcher as string[];
    const reachesMiddleware = patterns.some((pattern) => {
      try {
        return new RegExp(`^${pattern}$`).test(path);
      } catch {
        return false;
      }
    });

    expect(reachesMiddleware).toBeTrue();
  });
});
