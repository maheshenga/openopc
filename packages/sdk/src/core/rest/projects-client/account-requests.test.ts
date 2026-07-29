import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  cancelAccountRequest,
  createAccountRequest,
  listAccountRequests,
} from './account-requests';
import * as projectsClient from './index';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(
    async (url: unknown, options: { method?: string; body?: string } = {}) => {
      calls.push({
        url: String(url),
        method: options.method ?? 'GET',
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      return new Response(JSON.stringify({ request: { request_id: 'request-1' }, created: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });

test('account request SDK maps create, list, and cancel through one account scope', async () => {
  await createAccountRequest({
    accountId: 'account-1',
    kind: 'module_report',
    reason: 'unsafe output',
    moduleInstallationId: 'installation-1',
    idempotencyKey: 'module-report-0001',
  });
  await listAccountRequests({ accountId: 'account-1' });
  await cancelAccountRequest('request/with slash', { accountId: 'account-1' });

  expect(calls).toEqual([
    {
      url: 'http://test.local/account/requests',
      method: 'POST',
      body: {
        account_id: 'account-1',
        kind: 'module_report',
        reason: 'unsafe output',
        module_installation_id: 'installation-1',
        idempotency_key: 'module-report-0001',
      },
    },
    {
      url: 'http://test.local/account/requests?account_id=account-1',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/account/requests/request%2Fwith%20slash/cancel',
      method: 'POST',
      body: { account_id: 'account-1' },
    },
  ]);
});

test('barrel exports the account request client', () => {
  expect(projectsClient.createAccountRequest).toBe(createAccountRequest);
  expect(projectsClient.listAccountRequests).toBe(listAccountRequests);
  expect(projectsClient.cancelAccountRequest).toBe(cancelAccountRequest);
});
