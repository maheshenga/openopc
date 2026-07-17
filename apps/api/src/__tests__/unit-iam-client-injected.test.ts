import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import {
  invalidateIamCacheForProjectResources,
  invalidateIamCacheForUser,
  registerPrincipalScopedMemo,
} from '../iam/cache-registry';
import { authorizeV2WithDatabase, createIamV2Facade } from '../iam/engine-v2';
import { getResourceGrantReader } from '../iam/resource-grants';

function createCountingMemberDatabase() {
  let selects = 0;
  const database = {
    select(shape: Record<string, unknown>) {
      selects += 1;
      const keys = Object.keys(shape);
      const rows = keys.includes('accountRole')
        ? [{ isSuperAdmin: false, accountRole: 'owner', mfaRequired: false }]
        : [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => chain;
      chain.limit = async () => rows;
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query test doubles must be promise-like.
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return chain;
    },
  } as unknown as Database;
  return { database, selectCount: () => selects };
}

function withIamCachingEnabled<T>(create: () => T): T {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return create();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

describe('client-injected IAM facade', () => {
  test('imports without creating the API global database singleton', async () => {
    const script = `
      delete globalThis.__kortixApiDb;
      delete globalThis.__kortixApiDbUrl;
      const iam = await import('./src/iam/engine-v2.ts');
      console.log(JSON.stringify({
        globalDatabaseCreated: Boolean(globalThis.__kortixApiDb),
        factoryType: typeof iam.createIamV2Facade,
      }));
    `;
    const child = Bun.spawn(['bun', '-e', script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: process.env.TEMP ?? '',
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://iam-import-must-stay-lazy.invalid/kortix',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        API_KEY_SECRET: 'test-api-key-secret',
        INTERNAL_KORTIX_ENV: 'dev',
        RECALL_BASE_URL: 'http://127.0.0.1:3001',
        FRONTEND_URL: 'http://127.0.0.1:3000',
        ALLOWED_SANDBOX_PROVIDERS: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    const resultLine = stdout.trim().split(/\r?\n/).at(-1) ?? '';
    expect(JSON.parse(resultLine)).toEqual({
      globalDatabaseCreated: false,
      factoryType: 'function',
    });
  });

  test('authorizes both Studio actions through the real injected IAM role fold', async () => {
    const selectedShapes: string[][] = [];
    const database = {
      select(shape: Record<string, unknown>) {
        const keys = Object.keys(shape);
        selectedShapes.push(keys);
        const rows = keys.includes('accountRole')
          ? [{ isSuperAdmin: false, accountRole: 'owner', mfaRequired: false }]
          : [];
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        chain.where = () => chain;
        chain.limit = async () => rows;
        // biome-ignore lint/suspicious/noThenProperty: Drizzle query test doubles must be promise-like.
        chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
        return chain;
      },
    } as unknown as Database;
    const iam = createIamV2Facade(database);
    const target = { type: 'project' as const, id: '20000000-0000-4000-a000-000000000001' };

    const [runJobs, useProvider] = await Promise.all([
      iam.authorize(
        '30000000-0000-4000-a000-000000000001',
        '10000000-0000-4000-a000-000000000001',
        'project.studio.jobs.run',
        target,
      ),
      iam.authorize(
        '30000000-0000-4000-a000-000000000001',
        '10000000-0000-4000-a000-000000000001',
        'project.studio.providers.use',
        target,
      ),
    ]);

    expect(runJobs).toMatchObject({ allowed: true, reason: 'project_role' });
    expect(useProvider).toMatchObject({ allowed: true, reason: 'project_role' });
    expect(selectedShapes).toContainEqual(['isSuperAdmin', 'accountRole', 'mfaRequired']);
  });

  test('keeps injected facade invalidation out of the API global registry', () => {
    const globalInvalidations: string[] = [];
    registerPrincipalScopedMemo({
      invalidateByPrefix: (prefix) => globalInvalidations.push(prefix),
    });
    const iam = createIamV2Facade({} as Database);

    iam.invalidatePrincipals(['worker-user']);

    expect(globalInvalidations).toEqual([]);
  });

  test('keeps injected database authorization memos out of the API global registry', async () => {
    const first = createCountingMemberDatabase();
    const second = createCountingMemberDatabase();
    const authorize = (database: Database) =>
      authorizeV2WithDatabase(database, 'worker-user', 'worker-account', 'account.read');

    await withIamCachingEnabled(() => authorize(first.database));
    await withIamCachingEnabled(() => authorize(second.database));
    const firstWarmSelects = first.selectCount();
    const secondWarmSelects = second.selectCount();
    invalidateIamCacheForUser('worker-user');
    await authorize(first.database);
    await authorize(second.database);

    expect(first.selectCount()).toBe(firstWarmSelects);
    expect(second.selectCount()).toBe(secondWarmSelects);
  });

  test('scopes facade invalidation to its own injected database', async () => {
    const first = createCountingMemberDatabase();
    const second = createCountingMemberDatabase();
    const firstIam = withIamCachingEnabled(() => createIamV2Facade(first.database));
    const secondIam = withIamCachingEnabled(() => createIamV2Facade(second.database));

    await firstIam.authorize('worker-user', 'worker-account', 'account.read');
    await secondIam.authorize('worker-user', 'worker-account', 'account.read');
    const firstWarmSelects = first.selectCount();
    const secondWarmSelects = second.selectCount();
    firstIam.invalidatePrincipal('worker-user');
    await firstIam.authorize('worker-user', 'worker-account', 'account.read');
    await secondIam.authorize('worker-user', 'worker-account', 'account.read');

    expect(first.selectCount()).toBe(firstWarmSelects * 2);
    expect(second.selectCount()).toBe(secondWarmSelects);
  });

  test('keeps injected resource grant memos out of the API global registry', async () => {
    const injected = createCountingMemberDatabase();
    const reader = withIamCachingEnabled(() => getResourceGrantReader(injected.database));

    await reader.loadProjectResourceGrants('worker-project', 'agent');
    invalidateIamCacheForProjectResources('worker-project');
    await reader.loadProjectResourceGrants('worker-project', 'agent');

    expect(injected.selectCount()).toBe(1);
  });
});
