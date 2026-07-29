import { type NextRequest, NextResponse } from 'next/server';

import { resolveAdminApiBase } from '@/lib/api-client';
import { forwardableAdminCookieHeader } from '@/lib/admin-session';

const ADMIN_REASON_HEADER = 'x-openopc-admin-reason';

function isDirectApiPath(path: string[]): boolean {
  return (
    (path.length === 2 && path[0] === 'ops' && path[1] === 'overview') ||
    (path.length === 2 && path[0] === 'system' && path[1] === 'maintenance')
  );
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader || /[\u0000-\u001f\u007f]/.test(cookieHeader)) return null;
  for (const part of cookieHeader.split(';')) {
    const candidate = part.trim();
    const separator = candidate.indexOf('=');
    if (separator <= 0 || candidate.slice(0, separator).trim() !== name) continue;
    const value = candidate.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

function adminApiTarget(base: string, path: string[], search: string): URL {
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/+$/, '');
  const mountPath = basePath.endsWith('/v1/admin')
    ? basePath
    : basePath.endsWith('/v1')
      ? `${basePath}/admin`
      : `${basePath}/v1/admin`;
  const encodedPath = `/${path.map(encodeURIComponent).join('/')}`;
  if (isDirectApiPath(path)) {
    const v1Path = basePath.endsWith('/v1/admin')
      ? basePath.slice(0, -'/admin'.length)
      : basePath.endsWith('/v1')
        ? basePath
        : `${basePath}/v1`;
    target.pathname = `${v1Path}${encodedPath}`;
    target.search = search;
    target.hash = '';
    return target;
  }
  const relativePath =
    encodedPath === '/v1/admin'
      ? ''
      : encodedPath.startsWith('/v1/admin/')
        ? encodedPath.slice('/v1/admin'.length)
        : encodedPath.startsWith('/admin/')
          ? encodedPath.slice('/admin'.length)
          : encodedPath;

  target.pathname = `${mountPath}${relativePath === '/' ? '' : relativePath}`;
  target.search = search;
  target.hash = '';
  return target;
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const base = resolveAdminApiBase(process.env);
  const target = adminApiTarget(base, path, request.nextUrl.search);
  const directApiRequest = isDirectApiPath(path);
  const cookie = forwardableAdminCookieHeader(request.headers.get('cookie'));
  const headers = new Headers({ Accept: 'application/json' });
  const contentType = request.headers.get('content-type');
  const adminReason = request.headers.get(ADMIN_REASON_HEADER);
  if (contentType) headers.set('content-type', contentType);
  if (cookie && !directApiRequest) headers.set('cookie', cookie);
  if (adminReason) headers.set(ADMIN_REASON_HEADER, adminReason);
  if (directApiRequest) {
    const token = cookieValue(request.headers.get('cookie'), 'openopc_admin_session');
    if (token) headers.set('authorization', `Bearer ${token}`);
  }
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    cache: 'no-store',
    redirect: 'manual',
  });
  return new NextResponse(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
