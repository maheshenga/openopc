import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { DeveloperModulePaymentOrder } from './orders';
import { createDrizzleDeveloperModulePaymentRepository } from './orders.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const ORDER_ID = '90000000-0000-4000-8000-000000000001';
const REFUND_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-01T00:00:00.000Z';
const EXPIRES_AT = '2026-08-01T00:15:00.000Z';

function databaseFixture(results: unknown[]) {
  const pending = [...results];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const executor = {
    async execute(query: unknown) {
      const compiled = new PgDialect().sqlToQuery(query as never);
      queries.push({ sql: compiled.sql, params: compiled.params });
      return pending.shift() ?? [];
    },
  };
  const database = {
    ...executor,
    async transaction<T>(run: (tx: typeof executor) => Promise<T>) {
      return run(executor);
    },
  } as unknown as Database;
  return { database, queries };
}

const order: DeveloperModulePaymentOrder = {
  orderId: ORDER_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  installationId: INSTALLATION_ID,
  releaseId: RELEASE_ID,
  moduleId: 'example.weather-station',
  provider: 'zpay',
  providerOrderId: null,
  merchantOrderNo: 'OPC202608010000000000000000001',
  amountMinor: 567,
  currency: 'CNY',
  productName: 'OpenOPC module purchase',
  status: 'checkout_issued',
  idempotencyKey: 'checkout-00000001',
  checkout: null,
  providerFailureCode: null,
  expiresAt: EXPIRES_AT,
  paidAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('developer module payment Drizzle repository', () => {
  test('reserves a new tenant-scoped idempotency record before provider initiation', async () => {
    const fixture = databaseFixture([[order]]);
    const repository = createDrizzleDeveloperModulePaymentRepository(fixture.database);
    await expect(
      repository.reserveOrder({
        order,
      }),
    ).resolves.toEqual({ kind: 'reserved', order });
    expect(fixture.queries).toHaveLength(1);
    expect(fixture.queries[0]?.sql).toMatch(
      /INSERT INTO[\s\S]*developer_module_payment_orders[\s\S]*ON CONFLICT/,
    );
    expect(fixture.queries[0]?.params).toEqual(
      expect.arrayContaining([
        ACCOUNT_ID,
        PROJECT_ID,
        INSTALLATION_ID,
        RELEASE_ID,
        'checkout-00000001',
      ]),
    );
  });

  test('replays an existing immutable order only through the exact tenant identity', async () => {
    const replayOrder = {
      ...order,
      providerOrderId: 'trade-001',
      checkout: {
        kind: 'redirect' as const,
        url: 'https://payments.example.com/checkout/one',
        mobileUrl: null,
      },
    };
    const fixture = databaseFixture([[], [replayOrder]]);
    const repository = createDrizzleDeveloperModulePaymentRepository(fixture.database);
    await expect(repository.reserveOrder({ order })).resolves.toEqual({
      kind: 'replay',
      order: replayOrder,
    });
    expect(fixture.queries).toHaveLength(2);
    expect(fixture.queries[1]?.sql).toMatch(
      /account_id[\s\S]*project_id[\s\S]*installation_id[\s\S]*release_id[\s\S]*idempotency_key/,
    );
    expect(fixture.queries[1]?.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID, RELEASE_ID]),
    );
  });

  test('persists only provider-owned order identifiers and bounded checkout fields', async () => {
    const completed: DeveloperModulePaymentOrder = {
      ...order,
      providerOrderId: 'trade-001',
      checkout: {
        kind: 'redirect',
        url: 'https://payments.example.com/checkout/one',
        mobileUrl: null,
      },
    };
    const completedCheckout = completed.checkout;
    if (!completedCheckout) throw new Error('completed checkout fixture is incomplete');
    const fixture = databaseFixture([[completed]]);
    const repository = createDrizzleDeveloperModulePaymentRepository(fixture.database);
    await expect(
      repository.completeOrderInitiation({
        orderId: ORDER_ID,
        providerOrderId: 'trade-001',
        checkout: completedCheckout,
        updatedAt: NOW,
      }),
    ).resolves.toEqual(completed);
    expect(fixture.queries[0]?.sql).toContain('developer_module_payment_orders');
    expect(fixture.queries.flatMap((query) => query.params)).not.toContain('merchant-key');
    expect(fixture.queries.flatMap((query) => query.params)).not.toContain('sign=secret');
  });

  test('locks the order and inserts one tenant-bound refund idempotency record atomically', async () => {
    const refund = {
      refundId: REFUND_ID,
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      amountMinor: 567,
      idempotencyKey: 'refund-000000001',
      providerResult: null,
      status: 'refund_requested' as const,
      requestedBy: '60000000-0000-4000-8000-000000000001',
      requestedAt: NOW,
      resolvedAt: null,
    };
    const fixture = databaseFixture([[{ ...order, status: 'paid' }], [refund]]);
    const repository = createDrizzleDeveloperModulePaymentRepository(fixture.database);
    await expect(
      repository.reserveRefund({
        orderId: ORDER_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        releaseId: RELEASE_ID,
        amountMinor: 567,
        idempotencyKey: 'refund-000000001',
        refundId: REFUND_ID,
        requestedBy: refund.requestedBy,
        requestedAt: NOW,
      }),
    ).resolves.toEqual({ kind: 'reserved', refund });
    expect(fixture.queries[0]?.sql).toMatch(/FOR UPDATE/);
    expect(fixture.queries[1]?.sql).toContain('developer_module_payment_refunds');
    expect(fixture.queries.flatMap((query) => query.params)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, INSTALLATION_ID, RELEASE_ID, ORDER_ID]),
    );
  });

  test('locks by merchant order and records one provider callback with the payment transition', async () => {
    const paidOrder: DeveloperModulePaymentOrder = { ...order, status: 'paid', paidAt: NOW };
    const fixture = databaseFixture([[order], [{ order_id: ORDER_ID }], [paidOrder]]);
    const repository = createDrizzleDeveloperModulePaymentRepository(fixture.database);

    await expect(
      repository.recordProviderCallback({
        provider: 'zpay',
        merchantOrderNo: order.merchantOrderNo,
        providerTradeNo: 'trade-001',
        amountMinor: 567,
        paidAt: NOW,
        canonicalPayloadDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).resolves.toEqual({ kind: 'recorded', order: paidOrder });

    expect(fixture.queries).toHaveLength(3);
    expect(fixture.queries[0]?.sql).toMatch(/merchant_order_no[\s\S]*FOR UPDATE/);
    expect(fixture.queries[1]?.sql).toMatch(
      /INSERT INTO[\s\S]*developer_module_payment_callbacks[\s\S]*ON CONFLICT/,
    );
    expect(fixture.queries[2]?.sql).toMatch(/UPDATE[\s\S]*developer_module_payment_orders/);
    expect(fixture.queries.flatMap((query) => query.params)).toEqual(
      expect.arrayContaining([
        'zpay',
        'trade-001',
        order.merchantOrderNo,
        `sha256:${'a'.repeat(64)}`,
        'paid',
      ]),
    );
  });

  test('deduplicates an already recorded provider trade inside the callback transaction', async () => {
    const fixture = databaseFixture([[order], [], [{ order_id: ORDER_ID }]]);
    const repository = createDrizzleDeveloperModulePaymentRepository(fixture.database);

    await expect(
      repository.recordProviderCallback({
        provider: 'zpay',
        merchantOrderNo: order.merchantOrderNo,
        providerTradeNo: 'trade-001',
        amountMinor: 567,
        paidAt: NOW,
        canonicalPayloadDigest: `sha256:${'b'.repeat(64)}`,
      }),
    ).resolves.toEqual({ kind: 'duplicate', order });

    expect(fixture.queries).toHaveLength(3);
    expect(fixture.queries[2]?.sql).toMatch(
      /developer_module_payment_callbacks[\s\S]*provider_trade_no/,
    );
  });
});
