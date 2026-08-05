import { describe, expect, test } from 'bun:test';
import {
  CreateDeveloperPaymentOrderInputSchema,
  CreateDeveloperPaymentOrderResultSchema,
  CreateDeveloperPaymentRefundInputSchema,
  DeveloperPaymentOrderViewSchema,
  DeveloperPaymentRefundViewSchema,
  ModulePaymentIdempotencyKeySchema,
  ModuleServiceCapabilityRequestSchema,
  ModuleServiceErrorResponseSchema,
} from '@kortix/api-contract';
import {
  ModuleServiceCapabilityRequestSchema as InternalCapabilitySchema,
  ModuleServiceErrorResponseSchema as InternalErrorResponseSchema,
  ModulePaymentIdempotencyKeySchema as InternalIdempotencyKeySchema,
  CreateDeveloperPaymentOrderInputSchema as InternalOrderInputSchema,
  CreateDeveloperPaymentOrderResultSchema as InternalOrderResultSchema,
  DeveloperPaymentOrderViewSchema as InternalOrderViewSchema,
  CreateDeveloperPaymentRefundInputSchema as InternalRefundInputSchema,
  DeveloperPaymentRefundViewSchema as InternalRefundViewSchema,
  OPENOPC_AI_SERVICE_OPERATIONS,
  OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  OPENOPC_SERVICE_NAMES,
  OPENOPC_SERVICE_OPERATIONS,
} from './contracts';
import {
  OPENOPC_AI_SERVICE_OPERATIONS as PublicAiOperations,
  OPENOPC_PAYMENT_SERVICE_OPERATIONS as PublicPaymentOperations,
  OPENOPC_SERVICE_NAMES as PublicServiceNames,
  OPENOPC_SERVICE_OPERATIONS as PublicServiceOperations,
} from './index';
import type {
  ModuleServiceCapabilityRequest,
  ModuleServiceErrorResponse,
  OpenOpcAiServiceOperation,
  OpenOpcPaymentServiceOperation,
} from './index';

const ORDER_INPUT = {
  amount_minor: 567,
  currency: 'CNY' as const,
  product_name: 'OpenOPC module purchase',
};

describe('OpenOPC public contracts', () => {
  test('exposes the exact service operation vocabulary', () => {
    expect(OPENOPC_SERVICE_NAMES).toEqual(['ai', 'payment']);
    expect(OPENOPC_AI_SERVICE_OPERATIONS).toEqual(['models.read', 'text.generate', 'text.stream']);
    expect(OPENOPC_PAYMENT_SERVICE_OPERATIONS).toEqual([
      'orders.create',
      'orders.read',
      'refunds.create',
    ]);
    expect(OPENOPC_SERVICE_OPERATIONS).toEqual([
      ...OPENOPC_AI_SERVICE_OPERATIONS,
      ...OPENOPC_PAYMENT_SERVICE_OPERATIONS,
    ]);
    expect(PublicServiceNames).toEqual(OPENOPC_SERVICE_NAMES);
    expect(PublicAiOperations).toEqual(OPENOPC_AI_SERVICE_OPERATIONS);
    expect(PublicPaymentOperations).toEqual(OPENOPC_PAYMENT_SERVICE_OPERATIONS);
    expect(PublicServiceOperations).toEqual(OPENOPC_SERVICE_OPERATIONS);
  });

  test('keeps payment and capability validation compatible with the platform contract', () => {
    const orderResult = {
      order_id: '90000000-0000-4000-8000-000000000001',
      status: 'checkout_issued' as const,
      expires_at: '2026-08-01T00:15:00.000Z',
      checkout: {
        kind: 'redirect' as const,
        url: 'https://payments.example.com/checkout/one',
        mobile_url: null,
      },
    };
    const orderView = {
      order_id: orderResult.order_id,
      ...ORDER_INPUT,
      status: 'paid' as const,
      expires_at: orderResult.expires_at,
      paid_at: '2026-08-01T00:02:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:02:00.000Z',
    };
    const refundInput = { amount_minor: 567 };
    const refundView = {
      refund_id: 'a0000000-0000-4000-8000-000000000001',
      order_id: orderResult.order_id,
      amount_minor: 567,
      status: 'refunded' as const,
      requested_at: '2026-08-01T00:03:00.000Z',
      resolved_at: '2026-08-01T00:04:00.000Z',
    };
    const capability = { service: 'ai' as const, operations: ['models.read' as const] };
    expect(InternalOrderInputSchema.safeParse(ORDER_INPUT).success).toBe(
      CreateDeveloperPaymentOrderInputSchema.safeParse(ORDER_INPUT).success,
    );
    expect(InternalOrderResultSchema.safeParse(orderResult).success).toBe(
      CreateDeveloperPaymentOrderResultSchema.safeParse(orderResult).success,
    );
    expect(InternalOrderViewSchema.safeParse(orderView).success).toBe(
      DeveloperPaymentOrderViewSchema.safeParse(orderView).success,
    );
    expect(InternalRefundInputSchema.safeParse(refundInput).success).toBe(
      CreateDeveloperPaymentRefundInputSchema.safeParse(refundInput).success,
    );
    expect(InternalRefundViewSchema.safeParse(refundView).success).toBe(
      DeveloperPaymentRefundViewSchema.safeParse(refundView).success,
    );
    expect(InternalIdempotencyKeySchema.safeParse('checkout-00000001').success).toBe(
      ModulePaymentIdempotencyKeySchema.safeParse('checkout-00000001').success,
    );
    expect(InternalCapabilitySchema.safeParse(capability).success).toBe(
      ModuleServiceCapabilityRequestSchema.safeParse(capability).success,
    );
    expect(
      InternalErrorResponseSchema.safeParse({ error: 'MODULE_SERVICE_CAPABILITY_EXPIRED' }).success,
    ).toBe(
      ModuleServiceErrorResponseSchema.safeParse({ error: 'MODULE_SERVICE_CAPABILITY_EXPIRED' })
        .success,
    );
  });

  test('rejects credentials and malformed payment values at the public boundary', () => {
    expect(
      InternalOrderInputSchema.safeParse({ ...ORDER_INPUT, merchant_key: 'secret' }).success,
    ).toBe(false);
    expect(InternalRefundInputSchema.safeParse({ amount_minor: 0 }).success).toBe(false);
    expect(InternalIdempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(
      InternalCapabilitySchema.safeParse({ service: 'ai', operations: ['orders.create'] }).success,
    ).toBe(false);
  });

  test('publishes the operation-specific capability and error types', () => {
    const aiOperation: OpenOpcAiServiceOperation = 'text.generate';
    const paymentOperation: OpenOpcPaymentServiceOperation = 'orders.read';
    const capability: ModuleServiceCapabilityRequest = {
      service: 'ai',
      operations: [aiOperation],
    };
    const error: ModuleServiceErrorResponse = {
      error: 'MODULE_SERVICE_UNAVAILABLE',
      message: 'temporarily unavailable',
    };
    expect(capability.operations).toEqual(['text.generate']);
    expect(paymentOperation).toBe('orders.read');
    expect(error.error).toBe('MODULE_SERVICE_UNAVAILABLE');
  });
});
