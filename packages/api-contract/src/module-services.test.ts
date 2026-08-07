import { describe, expect, test } from 'bun:test';

import {
  CreateDeveloperPaymentOrderInputSchema,
  CreateDeveloperPaymentOrderResultSchema,
  CreateDeveloperPaymentRefundInputSchema,
  DeveloperPaymentOrderViewSchema,
  DeveloperPaymentRefundViewSchema,
  ModulePaymentIdempotencyKeySchema,
  type ModuleServiceCapabilityClaimsV1,
  ModuleServiceCapabilityClaimsV1Schema,
  ModuleServiceCapabilityRequestSchema,
  ModuleServiceConsentDeleteInputSchema,
  ModuleServiceErrorResponseSchema,
  OpenOpcImageEstimateRequestSchema,
  OpenOpcImageModelSchema,
  OpenOpcServiceOperationSchema,
  parseModuleServiceCapabilityClaims,
  parseModuleServiceConsentPutInput,
} from './module-services';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const ACTOR_USER_ID = '60000000-0000-4000-a000-000000000001';

function claims(): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '00000000-0000-4000-8000-000000000001',
    iat: '2026-08-01T00:00:00.000Z',
    exp: '2026-08-01T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.weather-station',
    moduleVersion: '1.2.3',
    consentId: CONSENT_ID,
    grantId: '00000000-0000-4000-8000-000000000002',
    actorUserId: ACTOR_USER_ID,
    service: 'ai',
    operations: ['models.read', 'text.generate'],
  };
}

describe('module service wire contract', () => {
  test('accepts only the fourteen public operation identifiers', () => {
    for (const operation of [
      'models.read',
      'text.generate',
      'text.stream',
      'images.models.read',
      'images.estimates.create',
      'images.jobs.create',
      'images.jobs.read',
      'images.jobs.cancel',
      'images.assets.create',
      'images.assets.read',
      'images.assets.download',
      'orders.create',
      'orders.read',
      'refunds.create',
    ]) {
      expect(OpenOpcServiceOperationSchema.safeParse(operation).success).toBe(true);
    }
    expect(OpenOpcServiceOperationSchema.safeParse('orders.close').success).toBe(false);
  });

  test('rejects a payment operation requested through the AI service', () => {
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'ai',
        operations: ['models.read', 'text.generate'],
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'ai',
        operations: ['orders.create'],
      }).success,
    ).toBe(false);
  });

  test('rejects an AI operation requested through the payment service', () => {
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'payment',
        operations: ['orders.create', 'orders.read', 'refunds.create'],
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'payment',
        operations: ['text.generate'],
      }).success,
    ).toBe(false);
  });

  test('requires a non-empty unique operation set', () => {
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({ service: 'ai', operations: [] }).success,
    ).toBe(false);
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'ai',
        operations: ['models.read', 'models.read'],
      }).success,
    ).toBe(false);
  });

  test('parses the exact v1 capability claim and rejects cross-service or extra data', () => {
    expect(parseModuleServiceCapabilityClaims(claims())).toEqual(claims());
    expect(
      ModuleServiceCapabilityClaimsV1Schema.safeParse({
        ...claims(),
        operations: ['orders.read'],
      }).success,
    ).toBe(false);
    expect(
      ModuleServiceCapabilityClaimsV1Schema.safeParse({
        ...claims(),
        provider_url: 'https://new-api.example.com',
      }).success,
    ).toBe(false);
  });

  test('accepts provider-neutral image input and rejects provider configuration', () => {
    const model = {
      id: 'img1/opaque-model:signature',
      object: 'image_model',
      owned_by: 'openopc',
      name: 'OpenOPC Image',
      capabilities: {
        reference_images: true,
        max_reference_images: 4,
        supports_negative_prompt: true,
        supports_seed: true,
        aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        qualities: ['standard', 'high'],
        max_output_count: 4,
      },
    };
    const request = {
      model: model.id,
      input: {
        prompt: 'A clean product photograph',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    };

    expect(OpenOpcImageModelSchema.safeParse(model).success).toBe(true);
    expect(OpenOpcImageEstimateRequestSchema.safeParse(request).success).toBe(true);
    expect(
      OpenOpcImageEstimateRequestSchema.safeParse({
        ...request,
        provider_config_id: 'provider-secret',
      }).success,
    ).toBe(false);
    expect(
      OpenOpcImageEstimateRequestSchema.safeParse({
        ...request,
        provider_url: 'https://provider.example.com',
      }).success,
    ).toBe(false);
  });

  test('parses consent input against the path service without accepting an account id', () => {
    expect(
      parseModuleServiceConsentPutInput('ai', {
        operations: ['models.read', 'text.generate'],
        expected_install_revision: 4,
      }),
    ).toEqual({
      operations: ['models.read', 'text.generate'],
      expected_install_revision: 4,
    });
    expect(() =>
      parseModuleServiceConsentPutInput('ai', {
        operations: ['orders.create'],
        expected_install_revision: 4,
      }),
    ).toThrow();
    expect(() =>
      parseModuleServiceConsentPutInput('ai', {
        operations: ['models.read'],
        expected_install_revision: 4,
        account_id: ACCOUNT_ID,
      }),
    ).toThrow();
  });

  test('requires a positive revision for consent revocation', () => {
    expect(
      ModuleServiceConsentDeleteInputSchema.safeParse({ expected_install_revision: 4 }).success,
    ).toBe(true);
    expect(
      ModuleServiceConsentDeleteInputSchema.safeParse({ expected_install_revision: 0 }).success,
    ).toBe(false);
  });

  test('recognizes stable module service errors and rejects provider-shaped errors', () => {
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'MODULE_SERVICE_CAPABILITY_EXPIRED',
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'MODULE_AI_PROVIDER_UNAVAILABLE',
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'MODULE_PAYMENT_IDEMPOTENCY_CONFLICT',
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE',
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'NEW_API_KEY_INVALID',
        provider_url: 'https://new-api.example.com',
      }).success,
    ).toBe(false);
  });

  test('accepts only bounded CNY order input without provider configuration', () => {
    expect(
      CreateDeveloperPaymentOrderInputSchema.parse({
        amount_minor: 567,
        currency: 'CNY',
        product_name: 'OpenOPC module purchase',
      }),
    ).toEqual({
      amount_minor: 567,
      currency: 'CNY',
      product_name: 'OpenOPC module purchase',
    });

    for (const input of [
      { amount_minor: 0, currency: 'CNY', product_name: 'x' },
      { amount_minor: 1.5, currency: 'CNY', product_name: 'x' },
      { amount_minor: 100_000_001, currency: 'CNY', product_name: 'x' },
      { amount_minor: 1, currency: 'USD', product_name: 'x' },
      { amount_minor: 1, currency: 'CNY', product_name: '' },
      { amount_minor: 1, currency: 'CNY', product_name: 'x'.repeat(101) },
      {
        amount_minor: 1,
        currency: 'CNY',
        product_name: 'x',
        provider: 'zpay',
      },
      {
        amount_minor: 1,
        currency: 'CNY',
        product_name: 'x',
        api_key: 'merchant-secret',
      },
    ]) {
      expect(CreateDeveloperPaymentOrderInputSchema.safeParse(input).success).toBe(false);
    }
    expect(
      CreateDeveloperPaymentOrderInputSchema.safeParse({
        amount_minor: 1,
        currency: 'CNY',
        product_name: '🚀'.repeat(100),
      }).success,
    ).toBe(true);
  });

  test('requires printable bounded idempotency keys and positive refund amounts', () => {
    expect(ModulePaymentIdempotencyKeySchema.parse('checkout-00000001')).toBe('checkout-00000001');
    for (const key of ['short', 'x'.repeat(129), 'checkout-000000\n', 'checkout-密钥-000000']) {
      expect(ModulePaymentIdempotencyKeySchema.safeParse(key).success).toBe(false);
    }
    expect(CreateDeveloperPaymentRefundInputSchema.parse({ amount_minor: 567 })).toEqual({
      amount_minor: 567,
    });
    expect(CreateDeveloperPaymentRefundInputSchema.safeParse({ amount_minor: 0 }).success).toBe(
      false,
    );
    expect(
      CreateDeveloperPaymentRefundInputSchema.safeParse({
        amount_minor: 1,
        merchant_key: 'secret',
      }).success,
    ).toBe(false);
  });

  test('parses provider-neutral checkout, order, and refund response shapes', () => {
    expect(
      CreateDeveloperPaymentOrderResultSchema.parse({
        order_id: '90000000-0000-4000-8000-000000000001',
        status: 'checkout_issued',
        expires_at: '2026-08-01T00:15:00.000Z',
        checkout: {
          kind: 'redirect',
          url: 'https://payments.example.com/checkout/one',
          mobile_url: null,
        },
      }),
    ).toEqual({
      order_id: '90000000-0000-4000-8000-000000000001',
      status: 'checkout_issued',
      expires_at: '2026-08-01T00:15:00.000Z',
      checkout: {
        kind: 'redirect',
        url: 'https://payments.example.com/checkout/one',
        mobile_url: null,
      },
    });

    expect(
      DeveloperPaymentOrderViewSchema.safeParse({
        order_id: '90000000-0000-4000-8000-000000000001',
        amount_minor: 567,
        currency: 'CNY',
        product_name: 'OpenOPC module purchase',
        status: 'paid',
        expires_at: '2026-08-01T00:15:00.000Z',
        paid_at: '2026-08-01T00:02:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:02:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      DeveloperPaymentRefundViewSchema.safeParse({
        refund_id: 'a0000000-0000-4000-8000-000000000001',
        order_id: '90000000-0000-4000-8000-000000000001',
        amount_minor: 567,
        status: 'refunded',
        requested_at: '2026-08-01T00:03:00.000Z',
        resolved_at: '2026-08-01T00:04:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      DeveloperPaymentOrderViewSchema.safeParse({
        order_id: '90000000-0000-4000-8000-000000000001',
        amount_minor: 567,
        currency: 'CNY',
        product_name: 'OpenOPC module purchase',
        status: 'paid',
        expires_at: '2026-08-01T00:15:00.000Z',
        paid_at: '2026-08-01T00:02:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:02:00.000Z',
        pid: 'merchant-001',
      }).success,
    ).toBe(false);
  });
});
