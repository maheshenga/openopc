import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  cancelProjectModuleExecution,
  confirmProjectModuleExecution,
  createProjectModuleExecution,
  estimateProjectModuleExecution,
  getProjectModuleExecution,
  listProjectModuleExecutionEvents,
} from './module-executions';

let calls: Array<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      headers: Object.fromEntries(new Headers(options.headers).entries()),
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(JSON.stringify({ execution_id: 'execution-1', events: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('project module execution SDK forwards exact paths, bodies, and idempotency', async () => {
  await estimateProjectModuleExecution('project/one', { installation_id: 'installation-1' });
  await createProjectModuleExecution(
    'project/one',
    { installation_id: 'installation-1', deadline_at: '2026-07-27T09:00:00.000Z' },
    { idempotencyKey: 'execution-op-1' },
  );
  await confirmProjectModuleExecution('project/one', 'execution/one');
  await cancelProjectModuleExecution('project/one', 'execution/one');
  await getProjectModuleExecution('project/one', 'execution/one');
  await listProjectModuleExecutionEvents('project/one', 'execution/one');

  expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
    {
      url: 'http://test.local/projects/project%2Fone/module-executions/estimate',
      method: 'POST',
      body: { installation_id: 'installation-1' },
    },
    {
      url: 'http://test.local/projects/project%2Fone/module-executions',
      method: 'POST',
      body: {
        installation_id: 'installation-1',
        deadline_at: '2026-07-27T09:00:00.000Z',
      },
    },
    {
      url: 'http://test.local/projects/project%2Fone/module-executions/execution%2Fone/confirm',
      method: 'POST',
      body: undefined,
    },
    {
      url: 'http://test.local/projects/project%2Fone/module-executions/execution%2Fone/cancel',
      method: 'POST',
      body: undefined,
    },
    {
      url: 'http://test.local/projects/project%2Fone/module-executions/execution%2Fone',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/projects/project%2Fone/module-executions/execution%2Fone/events',
      method: 'GET',
      body: undefined,
    },
  ]);
  expect(calls[1]?.headers).toEqual(
    expect.objectContaining({ 'idempotency-key': 'execution-op-1' }),
  );
  for (const call of calls) expect(call.body).not.toHaveProperty('account_id');
});
