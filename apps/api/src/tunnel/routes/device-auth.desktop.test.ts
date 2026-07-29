import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TUNNEL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let selectResults: unknown[][] = [];
let insertedValues: unknown[] = [];
let updatedValues: unknown[] = [];
let scopedAccountCalls: Array<'body' | 'query'> = [];
let authorizations: Array<{ userId: string; accountId: string; action: string }> = [];
let updateWhereClauses: Array<{
  values: Record<string, unknown>;
  condition: unknown;
  scope: 'global' | 'transaction';
}> = [];
let returningUpdateOutcomes: boolean[] = [];
interface DeviceAuthTestRow {
  [key: string]: unknown;
  status: string;
}
let activeDeviceAuthRow: DeviceAuthTestRow | null = null;
let selectHook: (() => Promise<void>) | null = null;
let connectionInsertHook: (() => Promise<void>) | null = null;

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRendezvous(parties: number) {
  let arrived = 0;
  const release = createDeferred();
  return async () => {
    arrived += 1;
    if (arrived === parties) release.resolve();
    await release.promise;
  };
}

function selectChain(): any {
  const rows = selectResults.shift() ?? [];
  const chain: any = {};
  for (const method of ['from', 'where', 'limit']) chain[method] = () => chain;
  chain.then = async (
    resolve: (value: unknown[]) => unknown,
    reject: (reason: unknown) => unknown,
  ) => {
    try {
      await selectHook?.();
      return resolve(rows);
    } catch (error) {
      return reject(error);
    }
  };
  return chain;
}

function isTunnelConnectionWrite(values: unknown): values is Record<string, unknown> {
  return Boolean(
    values &&
      typeof values === 'object' &&
      !Array.isArray(values) &&
      'setupTokenHash' in values,
  );
}

function expectApprovalCasWhere(requestId: string, count: number) {
  const approvalClauses = updateWhereClauses.filter(({ values }) => values.status === 'approved');
  expect(approvalClauses).toHaveLength(count);

  const dialect = new PgDialect();
  for (const { condition, scope, values } of approvalClauses) {
    expect(scope).toBe('transaction');
    const query = dialect.sqlToQuery(condition as SQL);
    expect(query.sql).toBe(
      '("kortix"."tunnel_device_auth_requests"."id" = $1 and "kortix"."tunnel_device_auth_requests"."status" = $2 and "kortix"."tunnel_device_auth_requests"."expires_at" > $3)',
    );
    expect(values.updatedAt).toBeInstanceOf(Date);
    expect(query.params).toEqual([
      requestId,
      'pending',
      (values.updatedAt as Date).toISOString(),
    ]);
  }
}

function writeChain(values: unknown, writes = insertedValues): any {
  writes.push(values);
  return {
    returning: async () => {
      if (isTunnelConnectionWrite(values)) await connectionInsertHook?.();
      return [{ tunnelId: TUNNEL_ID }];
    },
    then: (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve().then(() => resolve(undefined), reject),
  };
}

interface TransactionState {
  changedStatus: boolean;
  previousStatus?: string;
}

function updateFactory(
  writes = updatedValues,
  transactionState?: TransactionState,
  scope: 'global' | 'transaction' = 'global',
) {
  return () => ({
    set: (values: Record<string, unknown>) => {
      const applyStatus = () => {
        if (!activeDeviceAuthRow || typeof values.status !== 'string') return;
        if (transactionState && !transactionState.changedStatus) {
          transactionState.changedStatus = true;
          transactionState.previousStatus = activeDeviceAuthRow.status;
        }
        activeDeviceAuthRow.status = values.status;
      };
      const chain: any = {};
      chain.where = (condition: unknown) => {
        updateWhereClauses.push({ values, condition, scope });
        return chain;
      };
      chain.returning = async () => {
        if (!(returningUpdateOutcomes.shift() ?? true)) return [];
        applyStatus();
        writes.push(values);
        return [{ ...(activeDeviceAuthRow ?? {}), ...values }];
      };
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) =>
        Promise.resolve().then(() => {
          applyStatus();
          writes.push(values);
          return resolve(undefined);
        }, reject);
      return chain;
    },
  });
}

function databaseAdapter(
  inserts = insertedValues,
  updates = updatedValues,
  transactionState?: TransactionState,
) {
  return {
    select: () => selectChain(),
    insert: () => ({ values: (values: unknown) => writeChain(values, inserts) }),
    update: updateFactory(updates, transactionState, 'transaction'),
  };
}

const database = {
  select: () => selectChain(),
  insert: () => ({ values: (values: unknown) => writeChain(values, insertedValues) }),
  update: () => updateFactory(updatedValues)(),
  transaction: async <T>(callback: (transaction: ReturnType<typeof databaseAdapter>) => Promise<T>) => {
    const pendingInserts: unknown[] = [];
    const pendingUpdates: unknown[] = [];
    const transactionState: TransactionState = { changedStatus: false };
    try {
      const result = await callback(
        databaseAdapter(pendingInserts, pendingUpdates, transactionState),
      );
      insertedValues.push(...pendingInserts);
      updatedValues.push(...pendingUpdates);
      return result;
    } catch (error) {
      if (
        transactionState.changedStatus &&
        activeDeviceAuthRow &&
        typeof transactionState.previousStatus === 'string'
      ) {
        activeDeviceAuthRow.status = transactionState.previousStatus;
      }
      throw error;
    }
  },
};

mock.module('../../shared/db', () => ({
  db: database,
}));

mock.module('../../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_A,
  resolveScopedAccountId: async (_context: unknown, source: 'body' | 'query') => {
    scopedAccountCalls.push(source);
    return ACCOUNT_A;
  },
}));

mock.module('../../iam', () => ({
  ACCOUNT_ACTIONS: { ACCOUNT_WRITE: 'account.write' },
  assertAuthorized: async (userId: string, accountId: string, action: string) => {
    authorizations.push({ userId, accountId, action });
  },
}));

mock.module('../../shared/crypto', () => ({
  generateDeviceCode: () => 'ABC123456',
  generateTunnelToken: () => 'setup-token-1234567890',
  hashSecretKey: (value: string) => `hash:${value}`,
  verifySecretKey: () => true,
  randomAlphanumeric: () => 'device-secret-1234567890abcdef',
}));

mock.module('../core/rate-limiter', () => ({
  tunnelRateLimiter: { check: () => ({ allowed: true, retryAfterMs: 0 }) },
}));

mock.module('../../executor/sync', () => ({
  reconcileComputerConnectors: async () => undefined,
}));

mock.module('../../config', () => ({
  config: { FRONTEND_URL: 'https://app.example.test' },
}));

const { createDeviceAuthPublicRouter, createDeviceAuthRouter } = await import('./device-auth');

beforeEach(() => {
  selectResults = [];
  insertedValues = [];
  updatedValues = [];
  scopedAccountCalls = [];
  authorizations = [];
  updateWhereClauses = [];
  returningUpdateOutcomes = [];
  activeDeviceAuthRow = null;
  selectHook = null;
  connectionInsertHook = null;
});

describe('desktop device-auth account contract', () => {
  test('stores the selected account on create and returns it after approval', async () => {
    const publicApp = new Hono();
    publicApp.route('/', createDeviceAuthPublicRouter());

    const created = await publicApp.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_A, machineHostname: 'desktop-a' }),
    });
    expect(created.status).toBe(201);
    expect(insertedValues[0]).toMatchObject({ accountId: ACCOUNT_A, machineHostname: 'desktop-a' });

    selectResults.push([
      {
        status: 'approved',
        accountId: ACCOUNT_A,
        tunnelId: TUNNEL_ID,
        setupToken: 'setup-token-1234567890',
        deviceSecretHash: 'hash:secret',
        expiresAt: new Date('2026-07-29T12:05:00.000Z'),
      },
    ]);
    const polled = await publicApp.request('/ABC123456/status', {
      headers: { Authorization: 'Bearer device-secret-1234567890abcdef' },
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({
      status: 'approved',
      accountId: ACCOUNT_A,
      tunnelId: TUNNEL_ID,
      token: 'setup-token-1234567890',
    });
  });

  test('approves only the scoped account with account.write permission', async () => {
    selectResults.push([
      {
        id: 'request-1',
        status: 'pending',
        accountId: ACCOUNT_A,
        machineHostname: 'desktop-a',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('authType' as never, 'supabase' as never);
      context.set('userId' as never, USER_ID as never);
      await next();
    });
    app.route('/', createDeviceAuthRouter());

    const response = await app.request('/ABC123456/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_A, capabilities: [] }),
    });

    expect(response.status).toBe(200);
    expect(scopedAccountCalls).toEqual(['body']);
    expect(authorizations).toEqual([
      { userId: USER_ID, accountId: ACCOUNT_A, action: 'account.write' },
    ]);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({ accountId: ACCOUNT_A, setupTokenHash: 'hash:setup-token-1234567890' }),
    );
    expect(updatedValues).toContainEqual(
      expect.objectContaining({ status: 'approved', accountId: ACCOUNT_A, tunnelId: TUNNEL_ID }),
    );
  });

  test('rejects approval when the request account differs from the selected account', async () => {
    selectResults.push([
      {
        id: 'request-2',
        status: 'pending',
        accountId: ACCOUNT_B,
        machineHostname: 'desktop-b',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('authType' as never, 'supabase' as never);
      context.set('userId' as never, USER_ID as never);
      await next();
    });
    app.route('/', createDeviceAuthRouter());

    const response = await app.request('/ABC123456/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_A, capabilities: [] }),
    });

    expect(response.status).toBe(409);
    expect(insertedValues).toEqual([]);
  });

  test('commits only one tunnel and grant set when approvals race', async () => {
    activeDeviceAuthRow = {
      id: 'request-concurrent-approve',
      status: 'pending',
      accountId: ACCOUNT_A,
      machineHostname: 'desktop-a',
      expiresAt: new Date(Date.now() + 60_000),
    };
    selectResults.push([activeDeviceAuthRow], [activeDeviceAuthRow]);
    selectHook = createRendezvous(2);
    returningUpdateOutcomes.push(true, false);
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('authType' as never, 'supabase' as never);
      context.set('userId' as never, USER_ID as never);
      await next();
    });
    app.route('/', createDeviceAuthRouter());
    const request = () =>
      app.request('/ABC123456/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: ACCOUNT_A, capabilities: ['filesystem'] }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expectApprovalCasWhere('request-concurrent-approve', 2);
    expect(insertedValues.filter(isTunnelConnectionWrite)).toHaveLength(1);
    expect(insertedValues.filter(Array.isArray)).toHaveLength(1);
    expect(activeDeviceAuthRow.status).toBe('approved');
  });

  test('rolls back approval side effects when denial wins the race', async () => {
    activeDeviceAuthRow = {
      id: 'request-approve-deny',
      status: 'pending',
      accountId: ACCOUNT_A,
      machineHostname: 'desktop-a',
      expiresAt: new Date(Date.now() + 60_000),
    };
    selectResults.push([activeDeviceAuthRow]);
    const connectionInserted = createDeferred();
    const resumeApproval = createDeferred();
    connectionInsertHook = async () => {
      connectionInserted.resolve();
      await resumeApproval.promise;
    };
    returningUpdateOutcomes.push(true, false);
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('authType' as never, 'supabase' as never);
      context.set('userId' as never, USER_ID as never);
      await next();
    });
    app.route('/', createDeviceAuthRouter());

    const approval = app.request('/ABC123456/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_A, capabilities: ['filesystem'] }),
    });
    await connectionInserted.promise;
    const denial = await app.request('/ABC123456/deny', { method: 'POST' });
    resumeApproval.resolve();
    const approvalResponse = await approval;

    expect(denial.status).toBe(200);
    expect(approvalResponse.status).toBe(409);
    expect(activeDeviceAuthRow.status).toBe('denied');
    expect(insertedValues.filter(isTunnelConnectionWrite)).toHaveLength(0);
    expect(insertedValues.filter(Array.isArray)).toHaveLength(0);
  });
});
