import { randomUUID } from 'node:crypto';

import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import { isoTimestamp, nullableIsoTimestamp } from '../shared/iso-timestamp';
import {
  type DeveloperModulePaymentCheckout,
  DeveloperModulePaymentError,
  type DeveloperModulePaymentOrder,
  type DeveloperModulePaymentRefundStatus,
  type DeveloperModulePaymentRepository,
  type DeveloperModuleRefund,
  transitionDeveloperModulePaymentOrder,
} from './orders';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Pick<Database, 'execute'> | Pick<Transaction, 'execute'>;
type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows;
  }
  return [];
}

function value(row: Row, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function requiredString(row: Row, camel: string, snake: string): string {
  const result = value(row, camel, snake);
  if (typeof result !== 'string') throw new TypeError(`Missing payment row field ${camel}`);
  return result;
}

function optionalString(row: Row, camel: string, snake: string): string | null {
  const result = value(row, camel, snake);
  return result === null || result === undefined ? null : String(result);
}

function requiredTimestamp(row: Row, camel: string, snake: string): string {
  return isoTimestamp(value(row, camel, snake), `payment row field ${camel}`);
}

function optionalTimestamp(row: Row, camel: string, snake: string): string | null {
  return nullableIsoTimestamp(value(row, camel, snake), `payment row field ${camel}`);
}

function requiredNumber(row: Row, camel: string, snake: string): number {
  const result = Number(value(row, camel, snake));
  if (!Number.isSafeInteger(result)) throw new TypeError(`Missing payment row field ${camel}`);
  return result;
}

function mapCheckout(row: Row): DeveloperModulePaymentCheckout | null {
  const nested = value(row, 'checkout', 'checkout');
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const checkout = nested as Record<string, unknown>;
    const kind = checkout.kind;
    const url = checkout.url;
    const mobileUrl = checkout.mobileUrl ?? checkout.mobile_url ?? null;
    if (
      (kind === 'redirect' || kind === 'qr') &&
      typeof url === 'string' &&
      (mobileUrl === null || typeof mobileUrl === 'string')
    ) {
      return { kind, url, mobileUrl };
    }
  }
  const kind = optionalString(row, 'checkoutKind', 'checkout_kind');
  const url = optionalString(row, 'checkoutUrl', 'checkout_url');
  const mobileUrl = optionalString(row, 'checkoutMobileUrl', 'checkout_mobile_url');
  return kind && url ? { kind: kind as 'redirect' | 'qr', url, mobileUrl } : null;
}

export function mapDeveloperModulePaymentOrder(row: Row): DeveloperModulePaymentOrder {
  return {
    orderId: requiredString(row, 'orderId', 'order_id'),
    accountId: requiredString(row, 'accountId', 'account_id'),
    projectId: requiredString(row, 'projectId', 'project_id'),
    installationId: requiredString(row, 'installationId', 'installation_id'),
    releaseId: requiredString(row, 'releaseId', 'release_id'),
    moduleId: requiredString(row, 'moduleId', 'module_id'),
    provider: requiredString(row, 'provider', 'provider'),
    providerOrderId: optionalString(row, 'providerOrderId', 'provider_order_id'),
    merchantOrderNo: requiredString(row, 'merchantOrderNo', 'merchant_order_no'),
    amountMinor: requiredNumber(row, 'amountMinor', 'amount_minor'),
    currency: requiredString(row, 'currency', 'currency') as 'CNY',
    productName: requiredString(row, 'productName', 'product_name'),
    status: requiredString(row, 'status', 'status') as DeveloperModulePaymentOrder['status'],
    idempotencyKey: requiredString(row, 'idempotencyKey', 'idempotency_key'),
    checkout: mapCheckout(row),
    providerFailureCode: optionalString(row, 'providerFailureCode', 'provider_failure_code'),
    expiresAt: requiredTimestamp(row, 'expiresAt', 'expires_at'),
    paidAt: optionalTimestamp(row, 'paidAt', 'paid_at'),
    createdAt: requiredTimestamp(row, 'createdAt', 'created_at'),
    updatedAt: requiredTimestamp(row, 'updatedAt', 'updated_at'),
  };
}

function mapRefund(row: Row): DeveloperModuleRefund {
  const providerResult = value(row, 'providerResult', 'provider_result');
  return {
    refundId: requiredString(row, 'refundId', 'refund_id'),
    orderId: requiredString(row, 'orderId', 'order_id'),
    accountId: requiredString(row, 'accountId', 'account_id'),
    amountMinor: requiredNumber(row, 'amountMinor', 'amount_minor'),
    idempotencyKey: requiredString(row, 'idempotencyKey', 'idempotency_key'),
    providerResult:
      providerResult && typeof providerResult === 'object' && !Array.isArray(providerResult)
        ? (providerResult as Record<string, unknown>)
        : null,
    status: requiredString(row, 'status', 'status') as DeveloperModulePaymentRefundStatus,
    requestedBy: requiredString(row, 'requestedBy', 'requested_by'),
    requestedAt: requiredTimestamp(row, 'requestedAt', 'requested_at'),
    resolvedAt: optionalTimestamp(row, 'resolvedAt', 'resolved_at'),
  };
}

function checkoutValues(checkout: DeveloperModulePaymentCheckout): {
  kind: string;
  url: string;
  mobileUrl: string | null;
} {
  return { kind: checkout.kind, url: checkout.url, mobileUrl: checkout.mobileUrl };
}

export function createDrizzleDeveloperModulePaymentRepository(
  db: Database,
): DeveloperModulePaymentRepository {
  const findOrder = async (
    executor: Executor,
    input: {
      orderId: string;
      accountId: string;
      projectId: string;
      installationId: string;
      releaseId: string;
      forUpdate?: boolean;
    },
  ): Promise<DeveloperModulePaymentOrder | null> => {
    const result = await executor.execute(sql`
      SELECT payment_order.*
      FROM kortix.developer_module_payment_orders payment_order
      WHERE payment_order.order_id = ${input.orderId}
        AND payment_order.account_id = ${input.accountId}
        AND payment_order.project_id = ${input.projectId}
        AND payment_order.installation_id = ${input.installationId}
        AND payment_order.release_id = ${input.releaseId}
      LIMIT 1
      ${input.forUpdate ? sql`FOR UPDATE` : sql``}
    `);
    const row = rows(result)[0];
    return row ? mapDeveloperModulePaymentOrder(row) : null;
  };

  return {
    async reserveOrder({ order }) {
      const inserted = rows(
        await db.execute(sql`
          INSERT INTO kortix.developer_module_payment_orders (
            order_id, account_id, project_id, installation_id, release_id, module_id,
            provider, provider_order_id, merchant_order_no, amount_minor, currency,
            product_name, status, idempotency_key, expires_at, paid_at, created_at, updated_at
          ) VALUES (
            ${order.orderId}, ${order.accountId}, ${order.projectId}, ${order.installationId},
            ${order.releaseId}, ${order.moduleId}, ${order.provider}, ${order.providerOrderId},
            ${order.merchantOrderNo}, ${order.amountMinor}, ${order.currency}, ${order.productName},
            ${order.status}, ${order.idempotencyKey}, ${order.expiresAt}, ${order.paidAt},
            ${order.createdAt}, ${order.updatedAt}
          )
          ON CONFLICT (account_id, project_id, installation_id, release_id, idempotency_key)
          DO NOTHING
          RETURNING *
        `),
      )[0];
      if (inserted) return { kind: 'reserved', order: mapDeveloperModulePaymentOrder(inserted) };

      const existingResult = await db.execute(sql`
        SELECT payment_order.*
        FROM kortix.developer_module_payment_orders payment_order
        WHERE payment_order.account_id = ${order.accountId}
          AND payment_order.project_id = ${order.projectId}
          AND payment_order.installation_id = ${order.installationId}
          AND payment_order.release_id = ${order.releaseId}
          AND payment_order.idempotency_key = ${order.idempotencyKey}
        FOR UPDATE
      `);
      const existingRow = rows(existingResult)[0];
      if (!existingRow)
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
      const existing = mapDeveloperModulePaymentOrder(existingRow);
      if (
        existing.amountMinor !== order.amountMinor ||
        existing.currency !== order.currency ||
        existing.productName !== order.productName ||
        existing.moduleId !== order.moduleId
      ) {
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_IDEMPOTENCY_CONFLICT', 409);
      }
      return { kind: existing.checkout ? 'replay' : 'resume', order: existing };
    },

    async completeOrderInitiation(input) {
      const checkout = checkoutValues(input.checkout);
      const result = await db.execute(sql`
        UPDATE kortix.developer_module_payment_orders
        SET provider_order_id = ${input.providerOrderId},
            checkout_kind = ${checkout.kind},
            checkout_url = ${checkout.url},
            checkout_mobile_url = ${checkout.mobileUrl},
            provider_failure_code = NULL,
            updated_at = ${input.updatedAt}
        WHERE order_id = ${input.orderId}
        RETURNING *
      `);
      const row = rows(result)[0];
      if (!row) throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
      return mapDeveloperModulePaymentOrder(row);
    },

    async recordProviderFailure(input) {
      await db.execute(sql`
        UPDATE kortix.developer_module_payment_orders
        SET provider_failure_code = ${input.code}, updated_at = ${input.updatedAt}
        WHERE order_id = ${input.orderId} AND provider_order_id IS NULL
      `);
    },

    async findOrder(input) {
      return findOrder(db, input);
    },

    async transitionOrder(input) {
      return db.transaction(async (tx) => {
        const current = await findOrder(tx, {
          ...input.scope,
          orderId: input.orderId,
          forUpdate: true,
        });
        if (!current) return null;
        const next = transitionDeveloperModulePaymentOrder(current, input.targetStatus, input.at);
        const updated = await tx.execute(sql`
          UPDATE kortix.developer_module_payment_orders
          SET status = ${next.status}, paid_at = ${next.paidAt}, updated_at = ${next.updatedAt}
          WHERE order_id = ${input.orderId}
          RETURNING *
        `);
        const row = rows(updated)[0];
        return row ? mapDeveloperModulePaymentOrder(row) : null;
      });
    },

    async transitionOrderById(input) {
      return db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          SELECT payment_order.*
          FROM kortix.developer_module_payment_orders payment_order
          WHERE payment_order.order_id = ${input.orderId}
          FOR UPDATE
        `);
        const row = rows(result)[0];
        if (!row) return null;
        const current = mapDeveloperModulePaymentOrder(row);
        const next = transitionDeveloperModulePaymentOrder(current, input.targetStatus, input.at);
        const updated = await tx.execute(sql`
          UPDATE kortix.developer_module_payment_orders
          SET status = ${next.status}, paid_at = ${next.paidAt}, updated_at = ${next.updatedAt}
          WHERE order_id = ${input.orderId}
          RETURNING *
        `);
        const updatedRow = rows(updated)[0];
        return updatedRow ? mapDeveloperModulePaymentOrder(updatedRow) : null;
      });
    },

    async recordProviderCallback(input) {
      return db.transaction(async (tx) => {
        const orderResult = await tx.execute(sql`
          SELECT payment_order.*
          FROM kortix.developer_module_payment_orders payment_order
          WHERE payment_order.provider = ${input.provider}
            AND payment_order.merchant_order_no = ${input.merchantOrderNo}
          LIMIT 1
          FOR UPDATE
        `);
        const orderRow = rows(orderResult)[0];
        if (!orderRow) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
        }
        const current = mapDeveloperModulePaymentOrder(orderRow);
        if (current.amountMinor !== input.amountMinor) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_STATE_CONFLICT', 409);
        }

        const targetStatus =
          current.status === 'checkout_issued'
            ? 'paid'
            : current.status === 'expired'
              ? 'paid_late'
              : null;
        const outcome = targetStatus ?? 'duplicate';
        const inserted = rows(
          await tx.execute(sql`
            INSERT INTO kortix.developer_module_payment_callbacks (
              order_id, provider, provider_trade_no, canonical_payload_digest,
              verified, outcome, received_at
            ) VALUES (
              ${current.orderId}, ${input.provider}, ${input.providerTradeNo},
              ${input.canonicalPayloadDigest}, TRUE, ${outcome}, ${input.paidAt}
            )
            ON CONFLICT (provider, provider_trade_no)
              WHERE provider_trade_no IS NOT NULL
            DO NOTHING
            RETURNING order_id
          `),
        )[0];

        if (!inserted) {
          const duplicateResult = await tx.execute(sql`
            SELECT callback.order_id
            FROM kortix.developer_module_payment_callbacks callback
            WHERE callback.provider = ${input.provider}
              AND callback.provider_trade_no = ${input.providerTradeNo}
            LIMIT 1
          `);
          const duplicateOrderId = optionalString(
            rows(duplicateResult)[0] ?? {},
            'orderId',
            'order_id',
          );
          if (duplicateOrderId !== current.orderId) {
            throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_STATE_CONFLICT', 409);
          }
          return { kind: 'duplicate', order: current };
        }

        if (!targetStatus) return { kind: 'duplicate', order: current };
        const next = transitionDeveloperModulePaymentOrder(current, targetStatus, input.paidAt);
        const updated = await tx.execute(sql`
          UPDATE kortix.developer_module_payment_orders
          SET status = ${next.status}, paid_at = ${next.paidAt}, updated_at = ${next.updatedAt}
          WHERE order_id = ${current.orderId} AND status = ${current.status}
          RETURNING *
        `);
        const updatedRow = rows(updated)[0];
        if (!updatedRow) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_STATE_CONFLICT', 409);
        }
        return { kind: 'recorded', order: mapDeveloperModulePaymentOrder(updatedRow) };
      });
    },

    async reserveRefund(input) {
      return db.transaction(async (tx) => {
        const current = await findOrder(tx, {
          orderId: input.orderId,
          accountId: input.accountId,
          projectId: input.projectId,
          installationId: input.installationId,
          releaseId: input.releaseId,
          forUpdate: true,
        });
        if (!current) throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
        if (
          input.amountMinor > current.amountMinor ||
          !['paid', 'paid_late'].includes(current.status)
        ) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
        }
        const transitioned = transitionDeveloperModulePaymentOrder(
          current,
          'refund_requested',
          input.requestedAt,
        );
        const inserted = rows(
          await tx.execute(sql`
            WITH transitioned AS (
              UPDATE kortix.developer_module_payment_orders
              SET status = ${transitioned.status}, updated_at = ${transitioned.updatedAt}
              WHERE order_id = ${input.orderId}
                AND status IN ('paid', 'paid_late')
              RETURNING order_id
            )
            INSERT INTO kortix.developer_module_payment_refunds (
              refund_id, order_id, account_id, amount_minor, idempotency_key,
              provider_result, status, requested_by, requested_at, resolved_at
            )
            SELECT ${input.refundId}, ${input.orderId}, ${input.accountId}, ${input.amountMinor},
              ${input.idempotencyKey}, NULL, 'refund_requested', ${input.requestedBy},
              ${input.requestedAt}, NULL
            FROM transitioned
            ON CONFLICT (order_id, idempotency_key) DO NOTHING
            RETURNING *
          `),
        )[0];
        if (inserted) return { kind: 'reserved', refund: mapRefund(inserted) };
        const replayResult = await tx.execute(sql`
          SELECT refund.*
          FROM kortix.developer_module_payment_refunds refund
          WHERE refund.order_id = ${input.orderId}
            AND refund.account_id = ${input.accountId}
            AND refund.idempotency_key = ${input.idempotencyKey}
          FOR UPDATE
        `);
        const replayRow = rows(replayResult)[0];
        if (!replayRow)
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
        const replay = mapRefund(replayRow);
        if (replay.amountMinor !== input.amountMinor) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_IDEMPOTENCY_CONFLICT', 409);
        }
        return {
          kind: replay.status === 'refund_requested' ? 'resume' : 'replay',
          refund: replay,
        };
      });
    },

    async completeRefund(input) {
      return db.transaction(async (tx) => {
        const updatedRefund = await tx.execute(sql`
          UPDATE kortix.developer_module_payment_refunds
          SET status = ${input.status}, provider_result = ${input.providerResult}, resolved_at = ${input.resolvedAt}
          WHERE refund_id = ${input.refundId} AND order_id = ${input.orderId}
          RETURNING *
        `);
        const refundRow = rows(updatedRefund)[0];
        if (!refundRow)
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
        await tx.execute(sql`
          UPDATE kortix.developer_module_payment_orders
          SET status = ${input.status}, updated_at = ${input.resolvedAt}
          WHERE order_id = ${input.orderId} AND status = 'refund_requested'
        `);
        return mapRefund(refundRow);
      });
    },

    async appendAudit(input) {
      await db.execute(sql`
        INSERT INTO kortix.module_service_audit_events (
          event_id, account_id, project_id, installation_id, release_id, grant_id,
          service, operation, outcome, code, request_id, created_at
        ) VALUES (
          ${randomUUID()}, ${input.accountId}, ${input.projectId}, ${input.installationId},
          ${input.releaseId}, NULL, 'payment', ${input.operation}, ${input.outcome},
          ${input.code}, ${randomUUID()}, ${input.createdAt}
        )
      `);
    },
  };
}
