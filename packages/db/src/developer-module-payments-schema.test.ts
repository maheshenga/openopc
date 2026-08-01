import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as db from './index';
import {
  developerModulePaymentCallbacks,
  developerModulePaymentOrders,
  developerModulePaymentRefunds,
} from './schema/kortix';

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!constraint) throw new Error(`Missing check constraint: ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql;
}

function indexColumns(table: PgTable, name: string): string[] {
  const candidate = getTableConfig(table).indexes.find((entry) => entry.config.name === name);
  if (!candidate) throw new Error(`Missing index: ${name}`);
  return candidate.config.columns.map((column) => {
    const columnName = (column as { name?: string }).name;
    if (!columnName) throw new Error(`Index ${name} contains an expression`);
    return columnName;
  });
}

function foreignKeys(table: PgTable) {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      name: foreignKey.getName(),
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: getTableConfig(reference.foreignTable).name,
      onDelete: foreignKey.onDelete,
    };
  });
}

test('defines a tenant-bound, minor-unit developer module payment order ledger', () => {
  expect(getTableConfig(developerModulePaymentOrders)).toEqual(
    expect.objectContaining({ schema: 'kortix', name: 'developer_module_payment_orders' }),
  );
  expect(columnNames(developerModulePaymentOrders)).toEqual([
    'order_id',
    'account_id',
    'project_id',
    'installation_id',
    'release_id',
    'module_id',
    'provider',
    'provider_order_id',
    'merchant_order_no',
    'amount_minor',
    'currency',
    'product_name',
    'status',
    'idempotency_key',
    'checkout_kind',
    'checkout_url',
    'checkout_mobile_url',
    'provider_failure_code',
    'expires_at',
    'paid_at',
    'created_at',
    'updated_at',
  ]);
  expect(
    indexColumns(
      developerModulePaymentOrders,
      'developer_module_payment_orders_idempotency_unique',
    ),
  ).toEqual(['account_id', 'project_id', 'installation_id', 'release_id', 'idempotency_key']);
  expect(
    checkSql(developerModulePaymentOrders, 'developer_module_payment_orders_amount_check'),
  ).toMatch(/amount_minor" > 0[\s\S]*amount_minor" <= 100000000/);
  expect(
    checkSql(developerModulePaymentOrders, 'developer_module_payment_orders_state_check'),
  ).toMatch(/checkout_issued[\s\S]*refund_failed/);
  expect(
    checkSql(developerModulePaymentOrders, 'developer_module_payment_orders_secret_check'),
  ).toMatch(/provider_failure_code[\s\S]*(?:sign[\s\S]*key|key[\s\S]*sign)/);
});

test('records only digests for callbacks and uniquely identifies provider trades', () => {
  expect(columnNames(developerModulePaymentCallbacks)).toEqual([
    'callback_id',
    'order_id',
    'provider',
    'provider_trade_no',
    'canonical_payload_digest',
    'verified',
    'outcome',
    'received_at',
  ]);
  expect(
    indexColumns(
      developerModulePaymentCallbacks,
      'developer_module_payment_callbacks_trade_unique',
    ),
  ).toEqual(['provider', 'provider_trade_no']);
  expect(
    checkSql(developerModulePaymentCallbacks, 'developer_module_payment_callbacks_digest_check'),
  ).toContain('sha256:');
  expect(columnNames(developerModulePaymentCallbacks)).not.toContain('payload');
  expect(columnNames(developerModulePaymentCallbacks)).not.toContain('sign');
});

test('keeps refunds tenant-bound, idempotent, and separate from Stripe billing tables', () => {
  expect(columnNames(developerModulePaymentRefunds)).toEqual([
    'refund_id',
    'order_id',
    'account_id',
    'amount_minor',
    'idempotency_key',
    'provider_result',
    'status',
    'requested_by',
    'requested_at',
    'resolved_at',
  ]);
  expect(
    indexColumns(
      developerModulePaymentRefunds,
      'developer_module_payment_refunds_idempotency_unique',
    ),
  ).toEqual(['order_id', 'idempotency_key']);
  expect(
    checkSql(developerModulePaymentRefunds, 'developer_module_payment_refunds_result_check'),
  ).toMatch(/provider_result/);
  expect(foreignKeys(developerModulePaymentRefunds)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'developer_module_payment_refunds_order_account_fk',
        foreignTable: 'developer_module_payment_orders',
        onDelete: 'cascade',
      }),
    ]),
  );
  expect(db).toEqual(
    expect.objectContaining({
      developerModulePaymentOrders,
      developerModulePaymentCallbacks,
      developerModulePaymentRefunds,
    }),
  );
});

test('adds an idempotent payment-only migration without merchant secrets or orders.close', () => {
  const migration = readFileSync(
    join(import.meta.dir, '..', 'migrations', '20260801110000000_developer_module_payments.sql'),
    'utf8',
  );
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.developer_module_payment_orders');
  expect(migration).toContain(
    'CREATE TABLE IF NOT EXISTS kortix.developer_module_payment_callbacks',
  );
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS kortix.developer_module_payment_refunds');
  expect(migration).toContain('developer_module_payment_orders_idempotency_unique');
  expect(migration).toContain(
    'CONSTRAINT developer_module_payment_orders_order_account_unique\n    UNIQUE (order_id, account_id)',
  );
  expect(migration).toContain(
    'REFERENCES kortix.developer_module_payment_orders(order_id, account_id)',
  );
  expect(migration).toContain('developer_module_payment_callbacks_trade_unique');
  expect(migration).toContain('REVOKE ALL');
  expect(migration).not.toMatch(/orders[.]close/i);
  expect(migration).not.toMatch(
    /^\s*(?:merchant_key|api_key|bearer_token|sign|key)\s+(?:text|varchar|jsonb)/im,
  );
});
