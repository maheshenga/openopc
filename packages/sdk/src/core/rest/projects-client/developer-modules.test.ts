import { beforeEach, expect, mock, test } from 'bun:test';

import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import { validateDeveloperModule } from './developer-modules';

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
