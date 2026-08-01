import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

import {
  DeveloperModulePaymentError,
  type DeveloperModulePaymentOrder,
  DeveloperModulePaymentOrderService,
  type DeveloperModulePaymentProviderPort,
  createInMemoryDeveloperModulePaymentRepository,
  transitionDeveloperModulePaymentOrder,
} from './orders';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const OTHER_GRANT_ID = '60000000-0000-4000-8000-000000000009';
const NOW = '2026-08-01T00:00:00.000Z';
const PAID_AT = '2026-08-01T00:16:00.000Z';
const CALLBACK_DIGEST = `sha256:${'a'.repeat(64)}` as const;

function claims(
  overrides: Partial<ModuleServiceCapabilityClaimsV1> = {},
): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '80000000-0000-4000-8000-000000000001',
    iat: NOW,
    exp: '2026-08-01T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.weather-station',
    moduleVersion: '1.2.3',
    consentId: '50000000-0000-4000-a000-000000000001',
    grantId: GRANT_ID,
    service: 'payment',
    operations: ['orders.create', 'orders.read', 'refunds.create'],
    ...overrides,
  } as ModuleServiceCapabilityClaimsV1;
}

const orderInput = {
  amount_minor: 567,
  currency: 'CNY' as const,
  product_name: 'OpenOPC module purchase',
};

function callbackInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'zpay' as const,
    merchantOrderNo: 'OPC202608010000000000000000001',
    providerTradeNo: 'trade-001',
    amountMinor: 567,
    paidAt: PAID_AT,
    canonicalPayloadDigest: CALLBACK_DIGEST,
    ...overrides,
  };
}

class FakePaymentProvider implements DeveloperModulePaymentProviderPort {
  readonly createCalls: string[] = [];
  readonly refundCalls: string[] = [];
  failCreateAttempts = 0;

  async create(input: { merchantOrderNo: string; amountMinor: number; productName: string }) {
    this.createCalls.push(input.merchantOrderNo);
    if (this.failCreateAttempts > 0) {
      this.failCreateAttempts -= 1;
      throw new Error('provider transport detail must not escape');
    }
    return {
      providerOrderId: `provider-${input.merchantOrderNo}`,
      checkout: {
        kind: 'redirect' as const,
        url: `https://payments.example.com/checkout/${input.merchantOrderNo}`,
        mobileUrl: null,
      },
    };
  }

  async refund(input: { providerOrderId: string; amountMinor: number }) {
    this.refundCalls.push(input.providerOrderId);
    return { status: 'refunded' as const, providerResult: { state: 'success' } };
  }
}

function serviceFixture(provider = new FakePaymentProvider()) {
  const repository = createInMemoryDeveloperModulePaymentRepository();
  const service = new DeveloperModulePaymentOrderService({
    repository,
    provider,
    now: () => new Date(NOW),
    createOrderId: () => '90000000-0000-4000-8000-000000000001',
    createRefundId: () => 'a0000000-0000-4000-8000-000000000001',
    createMerchantOrderNo: () => 'OPC202608010000000000000000001',
  });
  return { repository, service, provider };
}

describe('developer module payment order service', () => {
  test('creates one provider order and replays the same immutable idempotent request', async () => {
    const { service, provider } = serviceFixture();
    const first = await service.createOrder({
      claims: claims(),
      input: orderInput,
      idempotencyKey: 'checkout-00000001',
    });
    const replay = await service.createOrder({
      claims: claims(),
      input: orderInput,
      idempotencyKey: 'checkout-00000001',
    });

    expect(replay).toEqual(first);
    expect(provider.createCalls).toEqual(['OPC202608010000000000000000001']);
    await expect(
      service.createOrder({
        claims: claims(),
        input: { ...orderInput, amount_minor: 568 },
        idempotencyKey: 'checkout-00000001',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_IDEMPOTENCY_CONFLICT', status: 409 });
    await expect(
      service.createOrder({
        claims: claims(),
        input: { ...orderInput, product_name: 'different module' },
        idempotencyKey: 'checkout-00000001',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_IDEMPOTENCY_CONFLICT', status: 409 });
  });

  test('records a bounded provider failure and retries only the unfinished provider attempt', async () => {
    const provider = new FakePaymentProvider();
    provider.failCreateAttempts = 1;
    const { service } = serviceFixture(provider);
    await expect(
      service.createOrder({
        claims: claims(),
        input: orderInput,
        idempotencyKey: 'checkout-00000002',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE', status: 503 });

    const result = await service.createOrder({
      claims: claims(),
      input: orderInput,
      idempotencyKey: 'checkout-00000002',
    });
    expect(result.status).toBe('checkout_issued');
    expect(provider.createCalls).toHaveLength(2);
  });

  test('enforces only the documented order state transitions', () => {
    const base = (status: DeveloperModulePaymentOrder['status']): DeveloperModulePaymentOrder => ({
      orderId: '90000000-0000-4000-8000-000000000001',
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: RELEASE_ID,
      moduleId: 'example.weather-station',
      provider: 'zpay',
      providerOrderId: 'provider-1',
      merchantOrderNo: 'OPC202608010000000000000000001',
      amountMinor: 567,
      currency: 'CNY',
      productName: 'OpenOPC module purchase',
      status,
      idempotencyKey: 'checkout-00000003',
      expiresAt: '2026-08-01T00:15:00.000Z',
      paidAt: status === 'paid' || status === 'paid_late' ? NOW : null,
      checkout: {
        kind: 'redirect',
        url: 'https://payments.example.com/checkout/one',
        mobileUrl: null,
      },
      providerFailureCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const allowed: Array<
      [DeveloperModulePaymentOrder['status'], DeveloperModulePaymentOrder['status']]
    > = [
      ['checkout_issued', 'paid'],
      ['checkout_issued', 'expired'],
      ['expired', 'paid_late'],
      ['paid', 'refund_requested'],
      ['paid_late', 'refund_requested'],
      ['refund_requested', 'refunded'],
      ['refund_requested', 'refund_failed'],
    ];
    for (const [from, to] of allowed) {
      expect(transitionDeveloperModulePaymentOrder(base(from), to, NOW).status).toBe(to);
    }
    for (const [from, to] of [
      ['checkout_issued', 'refunded'],
      ['expired', 'paid'],
      ['paid', 'paid_late'],
      ['refunded', 'paid'],
      ['refund_failed', 'refunded'],
    ] as const) {
      expect(() => transitionDeveloperModulePaymentOrder(base(from), to, NOW)).toThrow(
        DeveloperModulePaymentError,
      );
    }
  });

  test('binds reads and refunds to account, project, installation, and release claims', async () => {
    const { service } = serviceFixture();
    const created = await service.createOrder({
      claims: claims(),
      input: orderInput,
      idempotencyKey: 'checkout-00000004',
    });
    await expect(
      service.getOrder({
        claims: claims({ accountId: OTHER_ACCOUNT_ID, grantId: OTHER_GRANT_ID }),
        orderId: created.order_id,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_ORDER_NOT_FOUND', status: 404 });
    await expect(
      service.createRefund({
        claims: claims({ accountId: OTHER_ACCOUNT_ID, grantId: OTHER_GRANT_ID }),
        orderId: created.order_id,
        amountMinor: 567,
        idempotencyKey: 'refund-000000001',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_ORDER_NOT_FOUND', status: 404 });

    await service.recordProviderCallback(callbackInput({ paidAt: NOW }));
    const refund = await service.createRefund({
      claims: claims(),
      orderId: created.order_id,
      amountMinor: 567,
      idempotencyKey: 'refund-000000001',
    });
    expect(refund.status).toBe('refunded');
    const replay = await service.createRefund({
      claims: claims(),
      orderId: created.order_id,
      amountMinor: 567,
      idempotencyKey: 'refund-000000001',
    });
    expect(replay).toEqual(refund);
  });

  test('records a provider callback after local expiry as paid_late', async () => {
    const { repository, service } = serviceFixture();
    const created = await service.createOrder({
      claims: claims(),
      input: orderInput,
      idempotencyKey: 'checkout-00000005',
    });

    await service.expireOrder({
      orderId: created.order_id,
      at: '2026-08-01T00:15:01.000Z',
    });

    await expect(service.recordProviderCallback(callbackInput())).resolves.toEqual({
      kind: 'recorded',
    });
    await expect(
      repository.findOrder({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        releaseId: RELEASE_ID,
        orderId: created.order_id,
      }),
    ).resolves.toMatchObject({ status: 'paid_late', paidAt: PAID_AT });
  });

  test('records a provider callback once and rejects unknown orders or amount mismatches', async () => {
    const { repository, service } = serviceFixture();
    const created = await service.createOrder({
      claims: claims(),
      input: orderInput,
      idempotencyKey: 'checkout-00000006',
    });

    await expect(service.recordProviderCallback(callbackInput())).resolves.toEqual({
      kind: 'recorded',
    });
    await expect(service.recordProviderCallback(callbackInput())).resolves.toEqual({
      kind: 'duplicate',
    });
    await expect(
      repository.findOrder({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        releaseId: RELEASE_ID,
        orderId: created.order_id,
      }),
    ).resolves.toMatchObject({ status: 'paid', paidAt: PAID_AT });

    await expect(
      service.recordProviderCallback(
        callbackInput({ providerTradeNo: 'trade-002', amountMinor: 568 }),
      ),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_ORDER_STATE_CONFLICT', status: 409 });
    await expect(
      service.recordProviderCallback(
        callbackInput({
          merchantOrderNo: 'OPC202608010000000000000000099',
          providerTradeNo: 'trade-003',
        }),
      ),
    ).rejects.toMatchObject({ code: 'MODULE_PAYMENT_ORDER_NOT_FOUND', status: 404 });
  });

  test('does not expose a provider close operation', () => {
    const { service } = serviceFixture();
    expect('close' in service).toBe(false);
  });
});
