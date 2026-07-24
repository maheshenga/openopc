import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { createDeveloperApp } from './app';

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

const authenticatedApp = () =>
  createDeveloperApp({
    authenticate: async (_context, next) => {
      await next();
    },
  });

describe('developer module validation API', () => {
  test('rejects unauthenticated validation requests', async () => {
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
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
});
