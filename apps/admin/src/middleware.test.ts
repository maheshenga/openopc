import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import * as middlewareModule from './middleware';

type MiddlewareFactory = (options: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}) => (request: NextRequest) => Promise<Response>;

function factory(): MiddlewareFactory {
  expect(middlewareModule.createAdminMiddleware).toBeFunction();
  return middlewareModule.createAdminMiddleware as MiddlewareFactory;
}

function request(pathname: string, host = 'admin.openopc.example', cookie?: string) {
  return new NextRequest(`https://${host}${pathname}`, {
    headers: {
      host,
      ...(cookie ? { cookie } : {}),
    },
  });
}

describe('OpenOPC Admin middleware', () => {
  test('rejects an unlisted host before consulting the session authority', async () => {
    const fetchImpl = mock(async () => Response.json({ userId: 'unexpected' }));
    const middleware = factory()({
      env: {
        OPENOPC_ADMIN_ALLOWED_HOSTS: 'admin.openopc.example',
        OPENOPC_ADMIN_API_URL: 'https://api.openopc.example',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await middleware(
      request('/', 'consumer.openopc.example', 'openopc_admin_session=session-token'),
    );

    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns 404 for consumer routes on the allowed Admin host', async () => {
    const fetchImpl = mock(async () => Response.json({ userId: 'unexpected' }));
    const middleware = factory()({
      env: {
        OPENOPC_ADMIN_ALLOWED_HOSTS: 'admin.openopc.example',
        OPENOPC_ADMIN_API_URL: 'https://api.openopc.example',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await middleware(
      request('/projects', 'admin.openopc.example', 'openopc_admin_session=session-token'),
    );

    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('requires the host-only Admin session cookie', async () => {
    const fetchImpl = mock(async () => Response.json({ userId: 'unexpected' }));
    const middleware = factory()({
      env: {
        OPENOPC_ADMIN_ALLOWED_HOSTS: 'admin.openopc.example',
        OPENOPC_ADMIN_API_URL: 'https://api.openopc.example',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await middleware(request('/'));

    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('admits an allowed Admin route only after authoritative session verification', async () => {
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ cookie: 'openopc_admin_session=session-token' });
      return Response.json({
        userId: '20000000-0000-4000-a000-000000000002',
        permissions: ['account.read'],
        stepUpExpiresAt: null,
      });
    });
    const middleware = factory()({
      env: {
        OPENOPC_ADMIN_ALLOWED_HOSTS: 'admin.openopc.example',
        OPENOPC_ADMIN_API_URL: 'https://api.openopc.example',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await middleware(
      request('/', 'admin.openopc.example', 'openopc_admin_session=session-token; consumer=x'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://api.openopc.example/v1/admin/session',
    );
  });

  test('fails closed when the session authority rejects the cookie', async () => {
    const middleware = factory()({
      env: {
        OPENOPC_ADMIN_ALLOWED_HOSTS: 'admin.openopc.example',
        OPENOPC_ADMIN_API_URL: 'https://api.openopc.example',
      },
      fetchImpl: mock(async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
    });

    const response = await middleware(
      request('/', 'admin.openopc.example', 'openopc_admin_session=expired'),
    );

    expect(response.status).toBe(401);
  });
});
