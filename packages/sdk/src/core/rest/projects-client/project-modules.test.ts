import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type ProjectModuleErrorResponse,
  installProjectModule,
  listProjectModuleInstallationHistory,
  listProjectModules,
  rollbackProjectModule,
  updateProjectModule,
} from './project-modules';

let calls: Array<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      headers: Object.fromEntries(new Headers(opts.headers).entries()),
      body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify({ modules: [], installation: {}, event: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('project module wire types expose transition and stable error-code shapes', () => {
  const error: ProjectModuleErrorResponse = {
    error: 'PROJECT_MODULE_INSTALL_CONFLICT',
  };

  expect(error.error).toBe('PROJECT_MODULE_INSTALL_CONFLICT');
});

test('project module transport encodes project and module path segments', async () => {
  await listProjectModules('project/with space');
  await listProjectModuleInstallationHistory('project/with space', 'module/with space');
  await updateProjectModule('project/with space', 'module/with space', {
    release_id: 'release-v2',
    expected_install_revision: 1,
  });

  expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
    {
      url: 'http://test.local/projects/project%2Fwith%20space/modules',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/projects/project%2Fwith%20space/modules/module%2Fwith%20space/history',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/projects/project%2Fwith%20space/modules/module%2Fwith%20space/update',
      method: 'POST',
      body: { release_id: 'release-v2', expected_install_revision: 1 },
    },
  ]);
});

test('project module mutations forward idempotency keys without adding account fields', async () => {
  await installProjectModule(
    'project-1',
    { release_id: 'release-v1', expected_install_revision: 0 },
    { idempotencyKey: 'op-1' },
  );
  await updateProjectModule(
    'project-1',
    'module-1',
    { release_id: 'release-v2', expected_install_revision: 1 },
    { idempotencyKey: 'op-2' },
  );
  await rollbackProjectModule(
    'project-1',
    'module-1',
    { release_id: 'release-v1', expected_install_revision: 2 },
    { idempotencyKey: 'op-3' },
  );

  expect(calls.map(({ url, headers, body }) => ({ url, headers, body }))).toEqual([
    {
      url: 'http://test.local/projects/project-1/modules/install',
      headers: expect.objectContaining({ 'idempotency-key': 'op-1' }),
      body: { release_id: 'release-v1', expected_install_revision: 0 },
    },
    {
      url: 'http://test.local/projects/project-1/modules/module-1/update',
      headers: expect.objectContaining({ 'idempotency-key': 'op-2' }),
      body: { release_id: 'release-v2', expected_install_revision: 1 },
    },
    {
      url: 'http://test.local/projects/project-1/modules/module-1/rollback',
      headers: expect.objectContaining({ 'idempotency-key': 'op-3' }),
      body: { release_id: 'release-v1', expected_install_revision: 2 },
    },
  ]);
  for (const call of calls) expect(call.headers).not.toHaveProperty('account_id');
});
