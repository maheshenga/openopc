const EXACT_OPERATOR_PATHS = new Set([
  '/',
  '/accounts',
  '/access-requests',
  '/providers',
  '/ops',
  '/utils',
  '/developer-applications',
  '/developer-reviews',
]);

const FRAMEWORK_PATH_PREFIXES = ['/_next/', '/api/admin-proxy/'];

export function isAdminRequestPath(pathname: string): boolean {
  if (EXACT_OPERATOR_PATHS.has(pathname)) return true;
  if (FRAMEWORK_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (/^\/developer-applications\/[0-9a-f-]+$/i.test(pathname)) return true;
  if (/^\/developer-reviews\/[0-9a-f-]+$/i.test(pathname)) return true;
  return pathname === '/favicon.ico' || pathname === '/robots.txt';
}
