import { expect, mock, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');
const ADMIN_ROOT = resolve(REPOSITORY_ROOT, 'apps/admin');
const WEB_ADMIN_ROOTS = [
  'apps/web/src/app/admin',
  'apps/web/src/components/admin',
  'apps/web/src/components/pages/admin',
  'apps/web/src/hooks/admin',
  'apps/web/src/features/developer-center/admin',
] as const;

const ADMIN_ROUTE_FILES = [
  'src/app/page.tsx',
  'src/app/accounts/page.tsx',
  'src/app/access-requests/page.tsx',
  'src/app/providers/page.tsx',
  'src/app/ops/page.tsx',
  'src/app/utils/page.tsx',
  'src/app/developer-reviews/page.tsx',
  'src/app/developer-reviews/[releaseId]/page.tsx',
] as const;

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

async function loadModule(path: string): Promise<Record<string, unknown>> {
  try {
    return (await import(path)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test('defines an independently buildable OpenOPC Admin package', () => {
  const packageJson = JSON.parse(readFileSync(resolve(ADMIN_ROOT, 'package.json'), 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };

  expect(packageJson.name).toBe('@kortix/admin');
  expect(packageJson.scripts).toEqual({
    test: 'bun test',
    typecheck: 'tsc --noEmit',
    build: 'next build',
    start: 'next start',
  });
  expect(existsSync(resolve(ADMIN_ROOT, 'next.config.ts'))).toBeTrue();
  expect(existsSync(resolve(ADMIN_ROOT, 'tsconfig.json'))).toBeTrue();
});

test('owns every current operator route and leaves no duplicate Web Admin subtree', () => {
  for (const routeFile of ADMIN_ROUTE_FILES) {
    expect(existsSync(resolve(ADMIN_ROOT, routeFile))).toBeTrue();
  }
  for (const adminRoot of WEB_ADMIN_ROOTS) {
    expect(existsSync(resolve(REPOSITORY_ROOT, adminRoot))).toBeFalse();
  }
});

test('rejects consumer routes while preserving Admin and framework paths', async () => {
  const module = await loadModule('../lib/admin-surface');
  expect(module.isAdminRequestPath).toBeFunction();
  const isAdminRequestPath = module.isAdminRequestPath as (pathname: string) => boolean;

  expect(isAdminRequestPath('/')).toBeTrue();
  expect(isAdminRequestPath('/accounts')).toBeTrue();
  expect(isAdminRequestPath('/developer-reviews/10000000-0000-4000-a000-000000000001')).toBeTrue();
  expect(isAdminRequestPath('/_next/static/chunks/app.js')).toBeTrue();
  expect(isAdminRequestPath('/projects')).toBeFalse();
  expect(isAdminRequestPath('/developer/apply')).toBeFalse();
});

test('forwards only bounded host-only Admin session cookies', async () => {
  const module = await loadModule('../lib/admin-session');
  expect(module.forwardableAdminCookieHeader).toBeFunction();
  const forwardableAdminCookieHeader = module.forwardableAdminCookieHeader as (
    cookieHeader: string | null,
  ) => string | null;

  expect(
    forwardableAdminCookieHeader(
      'consumer_session=secret; openopc_admin_session=session-token; analytics_id=track; openopc_admin_step_up=step-token',
    ),
  ).toBe('openopc_admin_session=session-token; openopc_admin_step_up=step-token');
  expect(forwardableAdminCookieHeader('consumer_session=secret')).toBeNull();
  expect(forwardableAdminCookieHeader('openopc_admin_session=bad\r\nX-Leak: yes')).toBeNull();
});

test('uses the dedicated Admin API URL before the compatibility fallback', async () => {
  const module = await loadModule('../lib/api-client');
  expect(module.resolveAdminApiBase).toBeFunction();
  const resolveAdminApiBase = module.resolveAdminApiBase as (
    env: Record<string, string | undefined>,
  ) => string;

  expect(
    resolveAdminApiBase({
      OPENOPC_ADMIN_API_URL: 'https://admin-api.openopc.example/',
      KORTIX_API_URL: 'https://api.kortix.example',
    }),
  ).toBe('https://admin-api.openopc.example');
  expect(resolveAdminApiBase({ KORTIX_API_URL: 'https://api.openopc.example/' })).toBe(
    'https://api.openopc.example',
  );
});

test('preserves the typed Admin response contract through the same-origin proxy', async () => {
  const module = await loadModule('../lib/api-client');
  const backendApi = module.backendApi as {
    get<T>(endpoint: string): Promise<{ success: boolean; data?: T; error?: unknown }>;
  };
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ role: 'super_admin' }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    await expect(backendApi.get<{ role: string }>('/user-roles')).resolves.toEqual({
      success: true,
      data: { role: 'super_admin' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin-proxy/user-roles');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends a bounded cross-tenant reason without exposing it in the URL', async () => {
  const module = await loadModule('../lib/api-client');
  const backendApi = module.backendApi as {
    get<T>(
      endpoint: string,
      options?: RequestInit & { adminReason?: string },
    ): Promise<{ success: boolean; data?: T; error?: unknown }>;
  };
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ users: [] }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    await backendApi.get('/admin/api/accounts/account-id/users', {
      adminReason: 'Reviewing account members for a support incident',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/admin-proxy/admin/api/accounts/account-id/users');
    expect(String(url)).not.toContain('support');
    expect((init?.headers as Record<string, string>)['x-openopc-admin-reason']).toBe(
      'Reviewing account members for a support incident',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('contains no dependency on Web application pages', () => {
  const forbidden = /(?:apps\/web\/src\/app|\.\.\/.*web\/src\/app|@\/app\/admin)/;
  const offenders = sourceFiles(resolve(ADMIN_ROOT, 'src'))
    .filter((file) => !/\.test\.[^.]+$/.test(file))
    .filter((file) => forbidden.test(readFileSync(file, 'utf8').replaceAll('\\', '/')));
  expect(offenders).toEqual([]);
});
