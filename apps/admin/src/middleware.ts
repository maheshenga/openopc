import { type NextRequest, NextResponse } from 'next/server';

import {
  ADMIN_SESSION_COOKIE,
  forwardableAdminCookieHeader,
  type AdminSession,
} from './lib/admin-session';
import { isAdminRequestPath } from './lib/admin-surface';
import { resolveAdminApiBase } from './lib/api-client';

interface AdminMiddlewareOptions {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}

function normalizedHostname(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function allowedAdminHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map(normalizedHostname)
      .filter((host): host is string => Boolean(host)),
  );
}

function isAdminSession(value: unknown): value is AdminSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AdminSession>;
  return (
    typeof candidate.userId === 'string' &&
    candidate.userId.length > 0 &&
    Array.isArray(candidate.permissions) &&
    candidate.permissions.every((permission) => typeof permission === 'string') &&
    (candidate.stepUpExpiresAt === null || typeof candidate.stepUpExpiresAt === 'string')
  );
}

export function createAdminMiddleware({ env, fetchImpl }: AdminMiddlewareOptions) {
  return async function adminMiddleware(request: NextRequest): Promise<NextResponse> {
    const requestHost = normalizedHostname(request.headers.get('host') ?? request.nextUrl.host);
    if (!requestHost || !allowedAdminHosts(env.OPENOPC_ADMIN_ALLOWED_HOSTS).has(requestHost)) {
      return new NextResponse(null, { status: 404 });
    }

    if (!isAdminRequestPath(request.nextUrl.pathname)) {
      return new NextResponse(null, { status: 404 });
    }

    if (!request.cookies.get(ADMIN_SESSION_COOKIE)?.value) {
      return new NextResponse(null, { status: 401 });
    }

    const cookie = forwardableAdminCookieHeader(request.headers.get('cookie'));
    if (!cookie) return new NextResponse(null, { status: 401 });

    let authorityUrl: URL;
    try {
      authorityUrl = new URL('/v1/admin/session', `${resolveAdminApiBase(env)}/`);
    } catch {
      return new NextResponse(null, { status: 503 });
    }

    try {
      const response = await fetchImpl(authorityUrl, {
        headers: { cookie },
        cache: 'no-store',
      });
      if (!response.ok || !isAdminSession(await response.json())) {
        return new NextResponse(null, { status: 401 });
      }
    } catch {
      return new NextResponse(null, { status: 503 });
    }

    return NextResponse.next();
  };
}

export const middleware = createAdminMiddleware({
  env: process.env,
  fetchImpl: fetch,
});

export const config = {
  matcher: ['/((?!_next/image).*)'],
};
