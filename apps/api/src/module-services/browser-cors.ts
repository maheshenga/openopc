import type { MiddlewareHandler } from 'hono';

import type { ModuleAppHostConfiguration } from '../module-domains/platform-host-config';

const RELEASE_LABEL_RE =
  /^r-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const ALLOW_METHODS = 'GET, POST, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type, Idempotency-Key';

export function canonicalModuleServiceBrowserOrigin(
  origin: string | undefined,
  configuration: ModuleAppHostConfiguration | null,
): string | null {
  if (!origin || !configuration) return null;
  try {
    const url = new URL(origin);
    const suffix = `.${configuration.baseDomain}`;
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.port ||
      !url.hostname.endsWith(suffix)
    ) {
      return null;
    }
    const releaseLabel = url.hostname.slice(0, -suffix.length);
    return RELEASE_LABEL_RE.test(releaseLabel) ? origin : null;
  } catch {
    return null;
  }
}

function varyWithOrigin(value: string | null): string {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.some((entry) => entry.toLowerCase() === 'origin')) {
    entries.push('Origin');
  }
  return entries.join(', ');
}

export function createModuleServiceBrowserCors(
  configuration: ModuleAppHostConfiguration | null,
): MiddlewareHandler {
  return async (context, next) => {
    const origin = canonicalModuleServiceBrowserOrigin(context.req.header('Origin'), configuration);
    if (!origin) return next();

    const applyHeaders = () => {
      context.res.headers.set('Access-Control-Allow-Origin', origin);
      context.res.headers.set('Vary', varyWithOrigin(context.res.headers.get('Vary')));
      context.res.headers.delete('Access-Control-Allow-Credentials');
    };

    if (context.req.method === 'OPTIONS') {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Access-Control-Allow-Methods', ALLOW_METHODS);
      context.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
      context.header('Access-Control-Max-Age', '600');
      context.header('Vary', varyWithOrigin(context.res.headers.get('Vary')));
      return context.body(null, 204);
    }

    await next();
    applyHeaders();
  };
}
