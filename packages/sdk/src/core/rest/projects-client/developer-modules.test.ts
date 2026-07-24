import { beforeEach, expect, mock, test } from 'bun:test';

import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  getDeveloperModuleRelease,
  listDeveloperModuleReleases,
  submitDeveloperModuleRelease,
  validateDeveloperModule,
} from './developer-modules';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify({ valid: true, issues: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('validateDeveloperModule posts one registry item to the Developer Center API', async () => {
  const item = {
    name: 'recruiting-workbench',
    type: 'registry:module',
    module: { schemaVersion: 1, id: 'acme.recruiting' },
  };

  await expect(validateDeveloperModule(item)).resolves.toEqual({ valid: true, issues: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    url: 'http://test.local/developer/modules/validate',
    method: 'POST',
    body: item,
  });
});

test('createKortix exposes developer module validation', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  await expect(
    kortix.developer.modules.validate({ name: 'example', type: 'registry:module' }),
  ).resolves.toEqual({ valid: true, issues: [] });
});

test('developer module release SDK sends account-scoped submit, list and get requests', async () => {
  const item = { name: 'example', type: 'registry:module' };

  await submitDeveloperModuleRelease(item, { accountId: 'acc-1' });
  await listDeveloperModuleReleases({ accountId: 'acc-1', limit: 20 });
  await getDeveloperModuleRelease('release-1', { accountId: 'acc-1' });

  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/modules/releases',
      method: 'POST',
      body: { account_id: 'acc-1', item },
    },
    {
      url: 'http://test.local/developer/modules/releases?account_id=acc-1&limit=20',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/developer/modules/releases/release-1?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
  ]);
});

test('createKortix exposes the developer module release facade', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const item = { name: 'example', type: 'registry:module' };

  await kortix.developer.modules.releases.submit(item, { accountId: 'acc-1' });
  await kortix.developer.modules.releases.list({ accountId: 'acc-1', limit: 10 });
  await kortix.developer.modules.releases.get('release-1', { accountId: 'acc-1' });

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/developer/modules/releases',
    'http://test.local/developer/modules/releases?account_id=acc-1&limit=10',
    'http://test.local/developer/modules/releases/release-1?account_id=acc-1',
  ]);
});
