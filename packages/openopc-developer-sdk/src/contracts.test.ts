import { describe, expect, test } from 'bun:test';
import * as PlatformContracts from '@kortix/api-contract';
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
  OpenOpcChatCompletionRequestSchema as PlatformChatRequestSchema,
  OPENOPC_IMAGE_ERROR_CODES as PlatformImageErrorCodes,
  OpenOpcImageModelSchema as PlatformImageModelSchema,
  OpenOpcModelSchema as PlatformModelSchema,
} from '@kortix/api-contract';
import * as InternalContracts from './contracts';
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
  OPENOPC_IMAGE_ERROR_CODES,
  OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  OPENOPC_SERVICE_NAMES,
  OPENOPC_SERVICE_OPERATIONS,
  OpenOpcChatCompletionRequestSchema,
  OpenOpcImageEventFailureModeSchema,
  OpenOpcImageModelSchema,
  OpenOpcImagePageInputSchema,
  OpenOpcModelSchema,
  openOpcImageEstimateRetryGuidance,
  openOpcModelSupportsImagePurpose,
} from './contracts';
import * as PublicSdk from './index';
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
    expect(OPENOPC_SERVICE_NAMES).toEqual(['ai', 'payment', 'data', 'settings']);
    expect(OPENOPC_AI_SERVICE_OPERATIONS).toEqual([
      'models.read',
      'text.generate',
      'text.stream',
      'image.generate',
    ]);
    expect(OPENOPC_PAYMENT_SERVICE_OPERATIONS).toEqual([
      'orders.create',
      'orders.read',
      'refunds.create',
    ]);
    expect(InternalContracts.OPENOPC_DATA_SERVICE_OPERATIONS).toEqual([
      'documents.list',
      'documents.read',
      'documents.write',
      'documents.delete',
    ]);
    expect(InternalContracts.OPENOPC_SETTINGS_SERVICE_OPERATIONS).toEqual(['settings.read']);
    expect(PublicSdk.OPENOPC_DATA_SERVICE_OPERATIONS).toEqual(
      InternalContracts.OPENOPC_DATA_SERVICE_OPERATIONS,
    );
    expect(PublicSdk.OPENOPC_SETTINGS_SERVICE_OPERATIONS).toEqual(
      InternalContracts.OPENOPC_SETTINGS_SERVICE_OPERATIONS,
    );
    expect(OPENOPC_SERVICE_OPERATIONS).toEqual([
      ...OPENOPC_AI_SERVICE_OPERATIONS,
      ...OPENOPC_PAYMENT_SERVICE_OPERATIONS,
      ...InternalContracts.OPENOPC_DATA_SERVICE_OPERATIONS,
      ...InternalContracts.OPENOPC_SETTINGS_SERVICE_OPERATIONS,
    ]);
    expect(PublicServiceNames).toEqual(OPENOPC_SERVICE_NAMES);
    expect(PublicAiOperations).toEqual(OPENOPC_AI_SERVICE_OPERATIONS);
    expect(PublicPaymentOperations).toEqual(OPENOPC_PAYMENT_SERVICE_OPERATIONS);
    expect(PublicServiceOperations).toEqual(OPENOPC_SERVICE_OPERATIONS);
    expect(OPENOPC_IMAGE_ERROR_CODES).toEqual(PlatformImageErrorCodes);
  });

  test('publishes platform-compatible module data and settings schemas', () => {
    const sdk = PublicSdk as unknown as Record<
      string,
      { safeParse(value: unknown): { success: boolean } } | undefined
    >;
    const platform = PlatformContracts as unknown as Record<
      string,
      { safeParse(value: unknown): { success: boolean } } | undefined
    >;
    const documentInput = {
      key: 'canvases/home',
      expected_revision: null,
      value: { nodes: [], edges: [] },
    };
    const settings = {
      schema_version: 1,
      revision: 1,
      values: { 'canvas.autosave': true },
      loaded_at: '2026-08-11T08:00:00.000Z',
    };

    expect(sdk.OpenOpcModuleDocumentWriteInputSchema).toBeDefined();
    expect(sdk.OpenOpcEffectiveModuleSettingsSchema).toBeDefined();
    if (
      !sdk.OpenOpcModuleDocumentWriteInputSchema ||
      !sdk.OpenOpcEffectiveModuleSettingsSchema ||
      !platform.OpenOpcModuleDocumentWriteInputSchema ||
      !platform.OpenOpcEffectiveModuleSettingsSchema
    ) {
      return;
    }
    expect(sdk.OpenOpcModuleDocumentWriteInputSchema.safeParse(documentInput).success).toBe(
      platform.OpenOpcModuleDocumentWriteInputSchema.safeParse(documentInput).success,
    );
    expect(sdk.OpenOpcEffectiveModuleSettingsSchema.safeParse(settings).success).toBe(
      platform.OpenOpcEffectiveModuleSettingsSchema.safeParse(settings).success,
    );
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

  test('publishes provider-neutral multimodal parts and conservative model capabilities', () => {
    const message = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'describe this' },
        {
          type: 'image_url' as const,
          image_url: { url: 'https://images.example.com/photo.png', detail: 'auto' as const },
        },
      ],
    };
    expect(
      OpenOpcChatCompletionRequestSchema.safeParse({ model: 'vision-model', messages: [message] })
        .success,
    ).toBe(true);
    expect(
      OpenOpcChatCompletionRequestSchema.safeParse({
        model: 'vision-model',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'image_url', image_url: { url: 'https://images.example.com/photo.png' } },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    const visionModel = {
      id: 'vision-model',
      object: 'model' as const,
      owned_by: 'platform',
      capabilities: {
        modalities: ['text', 'image'] as const,
        vision: {
          max_images: 8,
          max_bytes_per_image: 10 * 1024 * 1024,
          max_total_bytes: 20 * 1024 * 1024,
          accepted_mime_types: ['image/png'] as const,
          purposes: ['vision'] as const,
        },
        attachment: {
          max_images: 8,
          max_bytes_per_image: 10 * 1024 * 1024,
          max_total_bytes: 20 * 1024 * 1024,
          accepted_mime_types: ['image/png'] as const,
          purposes: ['attachment'] as const,
        },
      },
    };
    expect(OpenOpcModelSchema.safeParse(visionModel).success).toBe(true);
    expect(PlatformModelSchema.safeParse(visionModel).success).toBe(true);
    expect(openOpcModelSupportsImagePurpose(visionModel, 'vision')).toBe(true);
    expect(openOpcModelSupportsImagePurpose(visionModel, 'attachment')).toBe(true);
    expect(openOpcModelSupportsImagePurpose({ capabilities: undefined }, 'vision')).toBe(false);
    const imageModel = {
      id: 'image-model',
      object: 'image.model',
      owned_by: 'provider',
      name: 'Provider image',
      capabilities: {
        prompt: { max_characters: 8000, max_negative_prompt_characters: 4000 },
        reference_images: {
          max_images: 0,
          max_bytes_per_image: 50 * 1024 * 1024,
          max_total_bytes: 50 * 1024 * 1024,
          accepted_mime_types: ['image/png'],
        },
        output: {
          min_images: 1,
          max_images: 1,
          max_bytes_per_image: 50 * 1024 * 1024,
          accepted_mime_types: ['image/png'],
          aspect_ratios: ['1:1'],
          qualities: ['standard'],
        },
      },
    };
    expect(OpenOpcImageModelSchema.safeParse(imageModel).success).toBe(true);
    expect(PlatformImageModelSchema.safeParse(imageModel).success).toBe(true);
    expect(
      PlatformChatRequestSchema.safeParse({ model: 'vision-model', messages: [message] }).success,
    ).toBe(true);
    expect(OpenOpcImageEventFailureModeSchema.parse('error')).toBe('error');
    expect(OpenOpcImagePageInputSchema.parse({ cursor: null, limit: 100 })).toEqual({
      cursor: null,
      limit: 100,
    });
    expect(openOpcImageEstimateRetryGuidance('OPENOPC_IMAGE_INSUFFICIENT_CREDITS')).toEqual({
      action: 'refresh-quota',
      can_reestimate: true,
      retry_same_estimate: false,
    });
  });
});
