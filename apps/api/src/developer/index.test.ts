import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { createDeveloperApp } from './app';
import {
  DeveloperModuleReleaseService,
  createMemoryDeveloperModuleReleaseRepository,
} from './releases';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';

const validModuleItem = () => ({
  name: 'recruiting-workbench',
  type: 'registry:module',
  module: {
    schemaVersion: 1,
    id: 'acme.recruiting',
    version: '1.0.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'industry',
    locales: ['en', 'zh-CN'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode: 'declarative', entry: undefined as string | undefined },
    capabilities: [{ id: 'acme.recruiting.score', kind: 'task' }],
    permissions: {
      secrets: ['RECRUITING_MODEL_API_KEY'],
      network: ['https://api.example.com'],
    },
  },
});

const authenticatedApp = (
  input: {
    accountId?: string;
    releaseService?: DeveloperModuleReleaseService;
    resolvedSources?: Array<'body' | 'query'>;
  } = {},
) =>
  createDeveloperApp({
    authenticate: async (context, next) => {
      context.set('userId', USER_ID);
      context.set('userEmail', 'developer@example.com');
      await next();
    },
    resolveAccountId: async (_context, source) => {
      input.resolvedSources?.push(source);
      return input.accountId ?? ACCOUNT_ID;
    },
    releaseService:
      input.releaseService ??
      new DeveloperModuleReleaseService({
        repository: createMemoryDeveloperModuleReleaseRepository(),
      }),
  });

describe('developer module validation API', () => {
  test('rejects unauthenticated validation requests', async () => {
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
      resolveAccountId: async () => ACCOUNT_ID,
      releaseService: new DeveloperModuleReleaseService({
        repository: createMemoryDeveloperModuleReleaseRepository(),
      }),
    });
    const response = await app.request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'example', type: 'registry:module' }),
    });

    expect(response.status).toBe(401);
  });

  test('accepts a valid developer module manifest', async () => {
    const response = await authenticatedApp().request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validModuleItem()),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true, issues: [] });
  });

  test('returns bounded issues without echoing submitted credentials', async () => {
    const item = validModuleItem();
    item.module.version = 'latest';
    item.module.execution = {
      mode: 'server-adapter',
      entry: 'https://evil.example/adapter.js',
    };
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];
    item.module.permissions.network = ['https://user:pass@example.com'];

    const response = await authenticatedApp().request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    });
    const body = (await response.json()) as {
      valid: boolean;
      issues: Array<{ severity: string; path: string; message: string }>;
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'item.module.version',
        'item.module.execution.entry',
        'item.module.permissions.secrets[0]',
        'item.module.permissions.network[0]',
      ]),
    );
    expect(serialized).not.toContain('sk-live-super-secret');
    expect(serialized).not.toContain('user:pass');
  });

  test('rejects a non-object registry item body', async () => {
    const response = await authenticatedApp().request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    });

    expect(response.status).toBe(400);
  });

  test('requires authentication for every release endpoint', async () => {
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
      resolveAccountId: async () => ACCOUNT_ID,
      releaseService: new DeveloperModuleReleaseService({
        repository: createMemoryDeveloperModuleReleaseRepository(),
      }),
    });

    const responses = await Promise.all([
      app.request('/modules/releases', { method: 'POST', body: '{}' }),
      app.request('/modules/releases'),
      app.request('/modules/releases/30000000-0000-4000-a000-000000000003'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
  });

  test('submits, lists and reads account-scoped validated releases', async () => {
    const resolvedSources: Array<'body' | 'query'> = [];
    const app = authenticatedApp({ resolvedSources });

    const submitted = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, item: validModuleItem() }),
    });
    const submission = (await submitted.json()) as {
      created: boolean;
      release: { release_id: string; status: string; account_id: string };
    };
    const listed = await app.request(`/modules/releases?account_id=${ACCOUNT_ID}&limit=20`);
    const fetched = await app.request(
      `/modules/releases/${submission.release.release_id}?account_id=${ACCOUNT_ID}`,
    );

    expect(submitted.status).toBe(201);
    expect(submission).toEqual(
      expect.objectContaining({
        created: true,
        release: expect.objectContaining({ status: 'validated', account_id: ACCOUNT_ID }),
      }),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown).toEqual(
      expect.objectContaining({ releases: [expect.objectContaining({ account_id: ACCOUNT_ID })] }),
    );
    expect(fetched.status).toBe(200);
    expect(resolvedSources).toEqual(['body', 'query', 'query']);
  });

  test('returns safe errors for invalid submissions without credential echo', async () => {
    const app = authenticatedApp();
    const item = validModuleItem();
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];

    const response = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item }),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain('DEVELOPER_MODULE_INVALID');
    expect(body).not.toContain('sk-live-super-secret');
  });

  test('returns 404 instead of exposing another account release', async () => {
    const releaseService = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const ownerApp = authenticatedApp({ accountId: ACCOUNT_ID, releaseService });
    const otherApp = authenticatedApp({ accountId: OTHER_ACCOUNT_ID, releaseService });
    const submitted = await ownerApp.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: validModuleItem() }),
    });
    const body = (await submitted.json()) as { release: { release_id: string } };

    const response = await otherApp.request(`/modules/releases/${body.release.release_id}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
  });
});
