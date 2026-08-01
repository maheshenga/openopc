import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

import {
  DEVELOPER_RUNTIME_TEST_PROFILE,
  RESTRICTED_RUNTIME_TEST_PROFILE,
} from '../release-profile/test-fixtures';
import { createModulePaymentRoutes } from './payments';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const ORDER_ID = '90000000-0000-4000-8000-000000000001';
const REFUND_ID = 'a0000000-0000-4000-8000-000000000001';

const claims: ModuleServiceCapabilityClaimsV1 = {
  schemaVersion: 1,
  iss: 'openopc-control-plane',
  aud: 'openopc:module-service',
  jti: '80000000-0000-4000-8000-000000000001',
  iat: '2026-08-01T00:00:00.000Z',
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
};

function routeFixture(runtime = DEVELOPER_RUNTIME_TEST_PROFILE) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const dependencies = {
    runtime,
    requireCapability: async (_authorization: string | undefined, operation: string) => {
      calls.push({ operation, input: null });
      return claims;
    },
    orderService: {
      createOrder: async (input: unknown) => {
        calls.push({ operation: 'createOrder', input });
        return {
          order_id: ORDER_ID,
          status: 'checkout_issued' as const,
          expires_at: '2026-08-01T00:15:00.000Z',
          checkout: {
            kind: 'redirect' as const,
            url: 'https://payments.example.com/checkout/one',
            mobile_url: null,
          },
        };
      },
      getOrder: async (input: unknown) => {
        calls.push({ operation: 'getOrder', input });
        return {
          order_id: ORDER_ID,
          amount_minor: 567,
          currency: 'CNY' as const,
          product_name: 'OpenOPC module purchase',
          status: 'paid' as const,
          expires_at: '2026-08-01T00:15:00.000Z',
          paid_at: '2026-08-01T00:02:00.000Z',
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:02:00.000Z',
        };
      },
      createRefund: async (input: unknown) => {
        calls.push({ operation: 'createRefund', input });
        return {
          refund_id: REFUND_ID,
          order_id: ORDER_ID,
          amount_minor: 567,
          status: 'refunded' as const,
          requested_at: '2026-08-01T00:03:00.000Z',
          resolved_at: '2026-08-01T00:04:00.000Z',
        };
      },
    },
  };
  return { app: createModulePaymentRoutes(dependencies), calls };
}

const auth = { Authorization: 'Bearer v4.public.test-token' };

describe('developer module payment service routes', () => {
  test('rejects buyer payment access when the deployment profile does not enable purchases', async () => {
    const { app, calls } = routeFixture(RESTRICTED_RUNTIME_TEST_PROFILE);
    const response = await app.request('/orders', {
      method: 'POST',
      headers: {
        ...auth,
        'Idempotency-Key': 'checkout-profile-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount_minor: 567,
        currency: 'CNY',
        product_name: 'OpenOPC module purchase',
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'commerce.purchase',
    });
    expect(calls).toHaveLength(0);
  });

  test('requires capability operations and forwards only provider-neutral create input', async () => {
    const { app, calls } = routeFixture();
    const response = await app.request('/orders', {
      method: 'POST',
      headers: {
        ...auth,
        'Idempotency-Key': 'checkout-00000001',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount_minor: 567,
        currency: 'CNY',
        product_name: 'OpenOPC module purchase',
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ order_id: ORDER_ID, status: 'checkout_issued' });
    expect(calls[0]?.operation).toBe('orders.create');
    expect(calls[1]).toEqual({
      operation: 'createOrder',
      input: expect.objectContaining({
        claims,
        idempotencyKey: 'checkout-00000001',
        input: { amount_minor: 567, currency: 'CNY', product_name: 'OpenOPC module purchase' },
      }),
    });
    expect(JSON.stringify(calls)).not.toContain('merchant');
  });

  test('reads and refunds through the claims-bound order service', async () => {
    const { app, calls } = routeFixture();
    const read = await app.request(`/orders/${ORDER_ID}`, { headers: auth });
    expect(read.status).toBe(200);
    expect((await read.json()).status).toBe('paid');
    const refund = await app.request(`/orders/${ORDER_ID}/refunds`, {
      method: 'POST',
      headers: {
        ...auth,
        'Idempotency-Key': 'refund-000000001',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_minor: 567 }),
    });
    expect(refund.status).toBe(201);
    expect((await refund.json()).refund_id).toBe(REFUND_ID);
    expect(calls.map((call) => call.operation)).toEqual([
      'orders.read',
      'getOrder',
      'refunds.create',
      'createRefund',
    ]);
  });

  test('rejects provider configuration, missing idempotency, and close routes', async () => {
    const { app, calls } = routeFixture();
    const invalid = await app.request('/orders', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_minor: 567,
        currency: 'CNY',
        product_name: 'OpenOPC module purchase',
        provider: 'zpay',
        merchant_key: 'secret',
      }),
    });
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(0);
    const close = await app.request(`/orders/${ORDER_ID}/close`, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'close-00000001' },
    });
    expect(close.status).toBe(404);
  });

  test('maps service errors to stable redacted payment errors', async () => {
    const dependencies = {
      runtime: DEVELOPER_RUNTIME_TEST_PROFILE,
      requireCapability: async () => {
        throw Object.assign(new Error('provider key must not escape'), {
          code: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE',
          status: 503,
        });
      },
      orderService: routeFixture().app,
    };
    const app = createModulePaymentRoutes(dependencies as never);
    const response = await app.request('/orders', {
      method: 'POST',
      headers: {
        ...auth,
        'Idempotency-Key': 'checkout-00000002',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_minor: 1, currency: 'CNY', product_name: 'x' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE' });
  });
});
