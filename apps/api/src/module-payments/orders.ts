import { randomUUID } from 'node:crypto';

import {
  type CreateDeveloperPaymentOrderInput,
  CreateDeveloperPaymentOrderInputSchema,
  type CreateDeveloperPaymentOrderResult,
  type CreateDeveloperPaymentRefundInput,
  CreateDeveloperPaymentRefundInputSchema,
  type DeveloperModulePaymentOrderStatus,
  type DeveloperPaymentOrderView,
  type DeveloperPaymentRefundView,
  ModulePaymentIdempotencyKeySchema,
} from '@kortix/api-contract';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

export type DeveloperModulePaymentErrorCode =
  | 'MODULE_SERVICE_INPUT_INVALID'
  | 'MODULE_PAYMENT_IDEMPOTENCY_CONFLICT'
  | 'MODULE_PAYMENT_ORDER_NOT_FOUND'
  | 'MODULE_PAYMENT_ORDER_STATE_CONFLICT'
  | 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE'
  | 'MODULE_PAYMENT_REFUND_CONFLICT';

export class DeveloperModulePaymentError extends Error {
  constructor(
    readonly code: DeveloperModulePaymentErrorCode,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'DeveloperModulePaymentError';
  }
}

export interface DeveloperModulePaymentCheckout {
  kind: 'redirect' | 'qr';
  url: string;
  mobileUrl: string | null;
}

export interface DeveloperModulePaymentOrder {
  orderId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  moduleId: string;
  provider: string;
  providerOrderId: string | null;
  merchantOrderNo: string;
  amountMinor: number;
  currency: 'CNY';
  productName: string;
  status: DeveloperModulePaymentOrderStatus;
  idempotencyKey: string;
  checkout: DeveloperModulePaymentCheckout | null;
  providerFailureCode: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeveloperModulePaymentRefundStatus = 'refund_requested' | 'refunded' | 'refund_failed';

export interface DeveloperModuleRefund {
  refundId: string;
  orderId: string;
  accountId: string;
  amountMinor: number;
  idempotencyKey: string;
  providerResult: Record<string, unknown> | null;
  status: DeveloperModulePaymentRefundStatus;
  requestedBy: string;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface DeveloperModulePaymentProviderPort {
  create(input: {
    orderId: string;
    merchantOrderNo: string;
    amountMinor: number;
    currency: 'CNY';
    productName: string;
    expiresAt: string;
  }): Promise<{
    providerOrderId: string;
    checkout: DeveloperModulePaymentCheckout;
  }>;
  refund(input: {
    providerOrderId: string;
    amountMinor: number;
  }): Promise<{
    status: 'refunded' | 'failed' | 'unknown';
    providerResult?: unknown;
  }>;
}

export interface DeveloperModulePaymentScope {
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
}

export interface DeveloperModulePaymentAuditInput extends DeveloperModulePaymentScope {
  orderId: string;
  operation: 'orders.create' | 'orders.read' | 'refunds.create';
  outcome: 'succeeded' | 'denied';
  code: DeveloperModulePaymentErrorCode | null;
  createdAt: string;
}

export interface DeveloperModulePaymentProviderCallbackInput {
  provider: 'zpay';
  merchantOrderNo: string;
  providerTradeNo: string;
  amountMinor: number;
  paidAt: string;
  canonicalPayloadDigest: `sha256:${string}`;
}

export interface DeveloperModulePaymentProviderCallbackResult {
  kind: 'recorded' | 'duplicate';
  order: DeveloperModulePaymentOrder;
}

export interface DeveloperModulePaymentRepository {
  reserveOrder(input: {
    order: DeveloperModulePaymentOrder;
  }): Promise<{ kind: 'reserved' | 'resume' | 'replay'; order: DeveloperModulePaymentOrder }>;
  completeOrderInitiation(input: {
    orderId: string;
    providerOrderId: string;
    checkout: DeveloperModulePaymentCheckout;
    updatedAt: string;
  }): Promise<DeveloperModulePaymentOrder>;
  recordProviderFailure(input: {
    orderId: string;
    code: string;
    updatedAt: string;
  }): Promise<void>;
  findOrder(
    input: DeveloperModulePaymentScope & { orderId: string },
  ): Promise<DeveloperModulePaymentOrder | null>;
  transitionOrder(input: {
    orderId: string;
    scope: DeveloperModulePaymentScope;
    targetStatus: DeveloperModulePaymentOrderStatus;
    at: string;
  }): Promise<DeveloperModulePaymentOrder | null>;
  transitionOrderById(input: {
    orderId: string;
    targetStatus: DeveloperModulePaymentOrderStatus;
    at: string;
  }): Promise<DeveloperModulePaymentOrder | null>;
  recordProviderCallback(
    input: DeveloperModulePaymentProviderCallbackInput,
  ): Promise<DeveloperModulePaymentProviderCallbackResult>;
  reserveRefund(input: {
    orderId: string;
    accountId: string;
    projectId: string;
    installationId: string;
    releaseId: string;
    amountMinor: number;
    idempotencyKey: string;
    refundId: string;
    requestedBy: string;
    requestedAt: string;
  }): Promise<{ kind: 'reserved' | 'resume' | 'replay'; refund: DeveloperModuleRefund }>;
  completeRefund(input: {
    refundId: string;
    orderId: string;
    status: 'refunded' | 'refund_failed';
    providerResult: Record<string, unknown> | null;
    resolvedAt: string;
  }): Promise<DeveloperModuleRefund>;
  appendAudit(input: DeveloperModulePaymentAuditInput): Promise<void>;
}

const TRANSITIONS: Readonly<
  Record<DeveloperModulePaymentOrderStatus, readonly DeveloperModulePaymentOrderStatus[]>
> = {
  checkout_issued: ['paid', 'expired'],
  paid: ['refund_requested'],
  expired: ['paid_late'],
  paid_late: ['refund_requested'],
  refund_requested: ['refunded', 'refund_failed'],
  refunded: [],
  refund_failed: [],
};

export function transitionDeveloperModulePaymentOrder(
  order: DeveloperModulePaymentOrder,
  targetStatus: DeveloperModulePaymentOrderStatus,
  at: string,
): DeveloperModulePaymentOrder {
  const targets = TRANSITIONS[order.status];
  if (!targets.includes(targetStatus)) {
    throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_STATE_CONFLICT', 409);
  }
  return {
    ...order,
    status: targetStatus,
    paidAt:
      targetStatus === 'paid' || targetStatus === 'paid_late' ? (order.paidAt ?? at) : order.paidAt,
    updatedAt: at,
  };
}

export class DeveloperModulePaymentOrderService {
  private readonly now: () => Date;
  private readonly createOrderId: () => string;
  private readonly createRefundId: () => string;
  private readonly createMerchantOrderNo: () => string;
  private readonly provider: DeveloperModulePaymentProviderPort;
  private readonly repository: DeveloperModulePaymentRepository;

  constructor(input: {
    repository: DeveloperModulePaymentRepository;
    provider: DeveloperModulePaymentProviderPort;
    now?: () => Date;
    createOrderId?: () => string;
    createRefundId?: () => string;
    createMerchantOrderNo?: () => string;
  }) {
    this.repository = input.repository;
    this.provider = input.provider;
    this.now = input.now ?? (() => new Date());
    this.createOrderId = input.createOrderId ?? cryptoRandomUuid;
    this.createRefundId = input.createRefundId ?? cryptoRandomUuid;
    this.createMerchantOrderNo = input.createMerchantOrderNo ?? (() => `OPC${Date.now()}`);
  }

  async createOrder(input: {
    claims: ModuleServiceCapabilityClaimsV1;
    input: CreateDeveloperPaymentOrderInput;
    idempotencyKey: string;
  }): Promise<CreateDeveloperPaymentOrderResult> {
    assertOperation(input.claims, 'orders.create');
    const orderInput = parseOrderInput(input.input);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const now = validNow(this.now());
    const order: DeveloperModulePaymentOrder = {
      orderId: assertUuid(this.createOrderId()),
      accountId: input.claims.accountId,
      projectId: input.claims.projectId,
      installationId: input.claims.installationId,
      releaseId: input.claims.releaseId,
      moduleId: input.claims.moduleId,
      provider: 'zpay',
      providerOrderId: null,
      merchantOrderNo: boundedMerchantOrderNo(this.createMerchantOrderNo()),
      amountMinor: orderInput.amount_minor,
      currency: orderInput.currency,
      productName: orderInput.product_name,
      status: 'checkout_issued',
      idempotencyKey,
      checkout: null,
      providerFailureCode: null,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      paidAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    let reservation: { kind: 'reserved' | 'resume' | 'replay'; order: DeveloperModulePaymentOrder };
    try {
      reservation = await this.repository.reserveOrder({ order });
    } catch (error) {
      if (error instanceof DeveloperModulePaymentError) throw error;
      throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
    }
    if (reservation.kind === 'replay' && reservation.order.checkout) {
      return createOrderResult(reservation.order);
    }

    let initiated: Awaited<ReturnType<DeveloperModulePaymentProviderPort['create']>>;
    try {
      initiated = await this.provider.create({
        orderId: reservation.order.orderId,
        merchantOrderNo: reservation.order.merchantOrderNo,
        amountMinor: reservation.order.amountMinor,
        currency: reservation.order.currency,
        productName: reservation.order.productName,
        expiresAt: reservation.order.expiresAt,
      });
      assertProviderCreateResult(initiated);
    } catch {
      await this.repository.recordProviderFailure({
        orderId: reservation.order.orderId,
        code: 'provider_unavailable',
        updatedAt: validNow(this.now()).toISOString(),
      });
      throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
    }
    const completed = await this.repository.completeOrderInitiation({
      orderId: reservation.order.orderId,
      providerOrderId: initiated.providerOrderId,
      checkout: initiated.checkout,
      updatedAt: validNow(this.now()).toISOString(),
    });
    await this.repository.appendAudit({
      accountId: completed.accountId,
      projectId: completed.projectId,
      installationId: completed.installationId,
      releaseId: completed.releaseId,
      orderId: completed.orderId,
      operation: 'orders.create',
      outcome: 'succeeded',
      code: null,
      createdAt: completed.updatedAt,
    });
    return createOrderResult(completed);
  }

  async getOrder(input: {
    claims: ModuleServiceCapabilityClaimsV1;
    orderId: string;
  }): Promise<DeveloperPaymentOrderView> {
    assertOperation(input.claims, 'orders.read');
    const orderId = assertUuid(input.orderId);
    const order = await this.repository.findOrder({ ...scope(input.claims), orderId });
    if (!order) {
      await this.repository.appendAudit({
        ...scope(input.claims),
        orderId,
        operation: 'orders.read',
        outcome: 'denied',
        code: 'MODULE_PAYMENT_ORDER_NOT_FOUND',
        createdAt: validNow(this.now()).toISOString(),
      });
      throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
    }
    await this.repository.appendAudit({
      ...scope(order),
      orderId: order.orderId,
      operation: 'orders.read',
      outcome: 'succeeded',
      code: null,
      createdAt: order.updatedAt,
    });
    return orderView(order);
  }

  async createRefund(input: {
    claims: ModuleServiceCapabilityClaimsV1;
    orderId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<DeveloperPaymentRefundView> {
    assertOperation(input.claims, 'refunds.create');
    const orderId = assertUuid(input.orderId);
    const amountMinor = parseRefundAmount(input.amountMinor);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const order = await this.repository.findOrder({ ...scope(input.claims), orderId });
    if (!order) throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
    if (amountMinor > order.amountMinor || !order.providerOrderId) {
      throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
    }
    const requestedAt = validNow(this.now()).toISOString();
    let reservation: { kind: 'reserved' | 'resume' | 'replay'; refund: DeveloperModuleRefund };
    try {
      reservation = await this.repository.reserveRefund({
        orderId,
        ...scope(order),
        amountMinor,
        idempotencyKey,
        refundId: assertUuid(this.createRefundId()),
        requestedBy: assertUuid(input.claims.grantId),
        requestedAt,
      });
    } catch (error) {
      if (error instanceof DeveloperModulePaymentError) throw error;
      throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
    }
    if (reservation.kind === 'replay' && reservation.refund.status !== 'refund_requested') {
      return refundView(reservation.refund);
    }

    let result: Awaited<ReturnType<DeveloperModulePaymentProviderPort['refund']>>;
    try {
      result = await this.provider.refund({
        providerOrderId: order.providerOrderId,
        amountMinor,
      });
    } catch {
      return refundView(reservation.refund);
    }
    const sanitized = redactProviderResult(result.providerResult);
    if (result.status === 'unknown') return refundView(reservation.refund);
    const completed = await this.repository.completeRefund({
      refundId: reservation.refund.refundId,
      orderId,
      status: result.status === 'refunded' ? 'refunded' : 'refund_failed',
      providerResult: sanitized,
      resolvedAt: validNow(this.now()).toISOString(),
    });
    await this.repository.appendAudit({
      ...scope(order),
      orderId,
      operation: 'refunds.create',
      outcome: 'succeeded',
      code: null,
      createdAt: completed.resolvedAt ?? completed.requestedAt,
    });
    return refundView(completed);
  }

  async recordProviderCallback(
    input: DeveloperModulePaymentProviderCallbackInput,
  ): Promise<{ kind: 'recorded' | 'duplicate' }> {
    const callback = parseProviderCallback(input);
    try {
      const result = await this.repository.recordProviderCallback(callback);
      return { kind: result.kind };
    } catch (error) {
      if (error instanceof DeveloperModulePaymentError) throw error;
      throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
    }
  }

  async expireOrder(input: { orderId: string; at: string }): Promise<DeveloperModulePaymentOrder> {
    assertUuid(input.orderId);
    const result = await this.repository.transitionOrderById({
      orderId: input.orderId,
      targetStatus: 'expired',
      at: input.at,
    });
    if (!result) throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
    return result;
  }
}

function parseOrderInput(
  value: CreateDeveloperPaymentOrderInput,
): CreateDeveloperPaymentOrderInput {
  const result = CreateDeveloperPaymentOrderInputSchema.safeParse(value);
  if (!result.success) throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  return result.data;
}

function parseRefundAmount(value: number): number {
  const result = CreateDeveloperPaymentRefundInputSchema.safeParse({ amount_minor: value });
  if (!result.success) throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  return result.data.amount_minor;
}

function parseIdempotencyKey(value: string): string {
  const result = ModulePaymentIdempotencyKeySchema.safeParse(value);
  if (!result.success) throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  return result.data;
}

function parseProviderCallback(
  input: DeveloperModulePaymentProviderCallbackInput,
): DeveloperModulePaymentProviderCallbackInput {
  if (
    input.provider !== 'zpay' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(input.merchantOrderNo) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.providerTradeNo) ||
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor < 1 ||
    input.amountMinor > 100_000_000 ||
    !/^sha256:[0-9a-f]{64}$/.test(input.canonicalPayloadDigest)
  ) {
    throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  }
  const paidAt = validNow(new Date(input.paidAt)).toISOString();
  return { ...input, paidAt };
}

function scope(
  claims: Pick<
    ModuleServiceCapabilityClaimsV1,
    'accountId' | 'projectId' | 'installationId' | 'releaseId'
  >,
): DeveloperModulePaymentScope;
function scope(order: DeveloperModulePaymentOrder): DeveloperModulePaymentScope;
function scope(
  input: Pick<
    DeveloperModulePaymentOrder,
    'accountId' | 'projectId' | 'installationId' | 'releaseId'
  >,
): DeveloperModulePaymentScope {
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    installationId: input.installationId,
    releaseId: input.releaseId,
  };
}

function assertOperation(
  claims: ModuleServiceCapabilityClaimsV1,
  operation: 'orders.create' | 'orders.read' | 'refunds.create',
): void {
  if (claims.service !== 'payment' || !claims.operations.includes(operation)) {
    throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  }
}

function assertUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  }
  return value;
}

function validNow(factory: (() => Date) | Date): Date {
  const now = typeof factory === 'function' ? factory() : factory;
  if (!Number.isFinite(now.getTime())) {
    throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  }
  return now;
}

function boundedMerchantOrderNo(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new DeveloperModulePaymentError('MODULE_SERVICE_INPUT_INVALID', 400);
  }
  return value;
}

function assertProviderCreateResult(value: {
  providerOrderId: string;
  checkout: DeveloperModulePaymentCheckout;
}): void {
  if (
    !value ||
    typeof value.providerOrderId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.providerOrderId) ||
    !value.checkout ||
    !['redirect', 'qr'].includes(value.checkout.kind) ||
    !isHttpUrl(value.checkout.url) ||
    (value.checkout.mobileUrl !== null && !isHttpUrl(value.checkout.mobileUrl))
  ) {
    throw new Error('invalid provider checkout');
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function createOrderResult(order: DeveloperModulePaymentOrder): CreateDeveloperPaymentOrderResult {
  if (!order.checkout)
    throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
  return {
    order_id: order.orderId,
    status: 'checkout_issued',
    expires_at: order.expiresAt,
    checkout: {
      kind: order.checkout.kind,
      url: order.checkout.url,
      mobile_url: order.checkout.mobileUrl,
    },
  };
}

function orderView(order: DeveloperModulePaymentOrder): DeveloperPaymentOrderView {
  return {
    order_id: order.orderId,
    amount_minor: order.amountMinor,
    currency: order.currency,
    product_name: order.productName,
    status: order.status,
    expires_at: order.expiresAt,
    paid_at: order.paidAt,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}

function refundView(refund: DeveloperModuleRefund): DeveloperPaymentRefundView {
  return {
    refund_id: refund.refundId,
    order_id: refund.orderId,
    amount_minor: refund.amountMinor,
    status: refund.status,
    requested_at: refund.requestedAt,
    resolved_at: refund.resolvedAt,
  };
}

function redactProviderResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:key|sign|token|authorization|password|url)/i.test(key)) continue;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      result[key] = item;
    }
  }
  return result;
}

function cryptoRandomUuid(): string {
  return randomUUID();
}

function orderKey(
  order: Pick<
    DeveloperModulePaymentOrder,
    'accountId' | 'projectId' | 'installationId' | 'releaseId' | 'idempotencyKey'
  >,
): string {
  return [
    order.accountId,
    order.projectId,
    order.installationId,
    order.releaseId,
    order.idempotencyKey,
  ].join(':');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryDeveloperModulePaymentRepository(): DeveloperModulePaymentRepository {
  const orders = new Map<string, DeveloperModulePaymentOrder>();
  const ordersById = new Map<string, DeveloperModulePaymentOrder>();
  const ordersByMerchantNo = new Map<string, DeveloperModulePaymentOrder>();
  const callbacksByTrade = new Map<string, { orderId: string }>();
  const refunds = new Map<string, DeveloperModuleRefund>();
  const refundsByKey = new Map<string, DeveloperModuleRefund>();

  return {
    async reserveOrder({ order }) {
      const key = orderKey(order);
      const current = orders.get(key);
      if (!current) {
        const stored = clone(order);
        orders.set(key, stored);
        ordersById.set(stored.orderId, stored);
        ordersByMerchantNo.set(stored.merchantOrderNo, stored);
        return { kind: 'reserved', order: clone(stored) };
      }
      if (
        current.amountMinor !== order.amountMinor ||
        current.currency !== order.currency ||
        current.productName !== order.productName ||
        current.moduleId !== order.moduleId
      ) {
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_IDEMPOTENCY_CONFLICT', 409);
      }
      return {
        kind: current.checkout ? 'replay' : 'resume',
        order: clone(current),
      };
    },

    async completeOrderInitiation({ orderId, providerOrderId, checkout, updatedAt }) {
      const current = ordersById.get(orderId);
      if (!current) throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
      current.providerOrderId = providerOrderId;
      current.checkout = clone(checkout);
      current.providerFailureCode = null;
      current.updatedAt = updatedAt;
      return clone(current);
    },

    async recordProviderFailure({ orderId, code, updatedAt }) {
      const current = ordersById.get(orderId);
      if (!current) return;
      current.providerFailureCode = code;
      current.updatedAt = updatedAt;
    },

    async findOrder(input) {
      const current = ordersById.get(input.orderId);
      if (
        !current ||
        current.accountId !== input.accountId ||
        current.projectId !== input.projectId ||
        current.installationId !== input.installationId ||
        current.releaseId !== input.releaseId
      ) {
        return null;
      }
      return clone(current);
    },

    async transitionOrder({ orderId, scope: currentScope, targetStatus, at }) {
      const current = ordersById.get(orderId);
      if (
        !current ||
        current.accountId !== currentScope.accountId ||
        current.projectId !== currentScope.projectId ||
        current.installationId !== currentScope.installationId ||
        current.releaseId !== currentScope.releaseId
      ) {
        return null;
      }
      const next = transitionDeveloperModulePaymentOrder(current, targetStatus, at);
      Object.assign(current, next);
      return clone(current);
    },

    async transitionOrderById({ orderId, targetStatus, at }) {
      const current = ordersById.get(orderId);
      if (!current) return null;
      const next = transitionDeveloperModulePaymentOrder(current, targetStatus, at);
      Object.assign(current, next);
      return clone(current);
    },

    async recordProviderCallback(input) {
      const current = ordersByMerchantNo.get(input.merchantOrderNo);
      if (!current || current.provider !== input.provider) {
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
      }
      if (current.amountMinor !== input.amountMinor) {
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_STATE_CONFLICT', 409);
      }

      const callbackKey = `${input.provider}:${input.providerTradeNo}`;
      const existing = callbacksByTrade.get(callbackKey);
      if (existing) {
        if (existing.orderId !== current.orderId) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_STATE_CONFLICT', 409);
        }
        return { kind: 'duplicate', order: clone(current) };
      }

      let kind: 'recorded' | 'duplicate' = 'duplicate';
      if (current.status === 'checkout_issued') {
        Object.assign(
          current,
          transitionDeveloperModulePaymentOrder(current, 'paid', input.paidAt),
        );
        kind = 'recorded';
      } else if (current.status === 'expired') {
        Object.assign(
          current,
          transitionDeveloperModulePaymentOrder(current, 'paid_late', input.paidAt),
        );
        kind = 'recorded';
      }
      callbacksByTrade.set(callbackKey, { orderId: current.orderId });
      return { kind, order: clone(current) };
    },

    async reserveRefund(input) {
      const order = ordersById.get(input.orderId);
      if (
        !order ||
        order.accountId !== input.accountId ||
        order.projectId !== input.projectId ||
        order.installationId !== input.installationId ||
        order.releaseId !== input.releaseId
      ) {
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_ORDER_NOT_FOUND', 404);
      }
      const key = `${input.orderId}:${input.idempotencyKey}`;
      const currentRefund = refundsByKey.get(key);
      if (currentRefund) {
        if (currentRefund.amountMinor !== input.amountMinor) {
          throw new DeveloperModulePaymentError('MODULE_PAYMENT_IDEMPOTENCY_CONFLICT', 409);
        }
        return {
          kind: currentRefund.status === 'refund_requested' ? 'resume' : 'replay',
          refund: clone(currentRefund),
        };
      }
      if (input.amountMinor > order.amountMinor || !['paid', 'paid_late'].includes(order.status)) {
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
      }
      const next = transitionDeveloperModulePaymentOrder(
        order,
        'refund_requested',
        input.requestedAt,
      );
      Object.assign(order, next);
      const refund: DeveloperModuleRefund = {
        refundId: input.refundId,
        orderId: input.orderId,
        accountId: input.accountId,
        amountMinor: input.amountMinor,
        idempotencyKey: input.idempotencyKey,
        providerResult: null,
        status: 'refund_requested',
        requestedBy: input.requestedBy,
        requestedAt: input.requestedAt,
        resolvedAt: null,
      };
      refunds.set(refund.refundId, refund);
      refundsByKey.set(key, refund);
      return { kind: 'reserved', refund: clone(refund) };
    },

    async completeRefund({ refundId, orderId, status, providerResult, resolvedAt }) {
      const refund = refunds.get(refundId);
      const order = ordersById.get(orderId);
      if (!refund || !order)
        throw new DeveloperModulePaymentError('MODULE_PAYMENT_REFUND_CONFLICT', 409);
      const nextOrder = transitionDeveloperModulePaymentOrder(order, status, resolvedAt);
      Object.assign(order, nextOrder);
      refund.status = status;
      refund.providerResult = clone(providerResult);
      refund.resolvedAt = resolvedAt;
      return clone(refund);
    },

    async appendAudit() {
      // The in-memory repository intentionally does not retain audit rows; SQL repositories do.
    },
  };
}
