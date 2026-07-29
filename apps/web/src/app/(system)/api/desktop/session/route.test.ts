import { expect, mock, test } from 'bun:test';

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
        error: null,
      }),
    },
  }),
}));

const { GET } = await import('./route');

test('desktop session responses are private and never cached', async () => {
  const response = await GET();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({
    userId: '00000000-0000-4000-8000-000000000001',
  });
});
