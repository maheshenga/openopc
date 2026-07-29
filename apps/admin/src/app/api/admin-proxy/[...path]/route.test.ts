import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET, PUT } from './route';

test('normalizes the Admin API mount and forwards the audit reason', async () => {
  const originalBase = process.env.OPENOPC_ADMIN_API_URL;
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  process.env.OPENOPC_ADMIN_API_URL = 'https://api.openopc.example';
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    const request = new NextRequest(
      'https://admin.openopc.example/api/admin-proxy/admin/api/accounts/10000000-0000-4000-a000-000000000001/users?cursor=next',
      {
        headers: {
          cookie:
            'consumer_session=secret; openopc_admin_session=session-token; openopc_admin_step_up=step-token',
          'content-type': 'application/json',
          'x-openopc-admin-reason': 'Reviewing account members for a support incident',
        },
      },
    );

    await GET(request, {
      params: Promise.resolve({
        path: ['admin', 'api', 'accounts', '10000000-0000-4000-a000-000000000001', 'users'],
      }),
    });

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe(
      'https://api.openopc.example/v1/admin/api/accounts/10000000-0000-4000-a000-000000000001/users?cursor=next',
    );
    const headers = init?.headers as Headers;
    expect(headers.get('cookie')).toBe(
      'openopc_admin_session=session-token; openopc_admin_step_up=step-token',
    );
    expect(headers.get('x-openopc-admin-reason')).toBe(
      'Reviewing account members for a support incident',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.OPENOPC_ADMIN_API_URL;
    else process.env.OPENOPC_ADMIN_API_URL = originalBase;
  }
});

test('does not duplicate the Admin mount when the proxy path is exactly v1/admin', async () => {
  const originalBase = process.env.OPENOPC_ADMIN_API_URL;
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  process.env.OPENOPC_ADMIN_API_URL = 'https://api.openopc.example';
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    await GET(
      new NextRequest('https://admin.openopc.example/api/admin-proxy/v1/admin'),
      { params: Promise.resolve({ path: ['v1', 'admin'] }) },
    );

    const [target] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe('https://api.openopc.example/v1/admin');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.OPENOPC_ADMIN_API_URL;
    else process.env.OPENOPC_ADMIN_API_URL = originalBase;
  }
});

test('bridges the operations overview to the authenticated non-Admin API mount', async () => {
  const originalBase = process.env.OPENOPC_ADMIN_API_URL;
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  process.env.OPENOPC_ADMIN_API_URL = 'https://api.openopc.example';
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    await GET(
      new NextRequest('https://admin.openopc.example/api/admin-proxy/ops/overview', {
        headers: { cookie: 'openopc_admin_session=session-token' },
      }),
      { params: Promise.resolve({ path: ['ops', 'overview'] }) },
    );

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe('https://api.openopc.example/v1/ops/overview');
    expect((init?.headers as Headers).get('authorization')).toBe('Bearer session-token');
    expect((init?.headers as Headers).get('cookie')).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.OPENOPC_ADMIN_API_URL;
    else process.env.OPENOPC_ADMIN_API_URL = originalBase;
  }
});

test('bridges maintenance reads and writes to the system API mount', async () => {
  const originalBase = process.env.OPENOPC_ADMIN_API_URL;
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  process.env.OPENOPC_ADMIN_API_URL = 'https://api.openopc.example';
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    await PUT(
      new NextRequest('https://admin.openopc.example/api/admin-proxy/system/maintenance', {
        method: 'PUT',
        headers: {
          cookie: 'openopc_admin_session=session-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ level: 'none' }),
      }),
      { params: Promise.resolve({ path: ['system', 'maintenance'] }) },
    );

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe('https://api.openopc.example/v1/system/maintenance');
    expect((init?.headers as Headers).get('authorization')).toBe('Bearer session-token');
    expect((init?.headers as Headers).get('cookie')).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.OPENOPC_ADMIN_API_URL;
    else process.env.OPENOPC_ADMIN_API_URL = originalBase;
  }
});
