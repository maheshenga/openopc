import {
  CreateDeveloperPaymentOrderInputSchema,
  CreateDeveloperPaymentRefundInputSchema,
  type DeveloperPaymentOrderView,
  type DeveloperPaymentRefundView,
  type ModuleServiceCapabilityClaimsV1,
} from '@kortix/api-contract';
import {
  DeveloperModulePaymentError,
  type DeveloperModulePaymentOrderService,
} from '../module-payments/orders';

import { makeOpenApiApp } from '../openapi';
import { rejectUnavailableCapability } from '../release-profile/routes';
import { type RuntimeReleaseProfile, loadRuntimeReleaseProfile } from '../release-profile/runtime';
import type { AppEnv } from '../types';
import { requireModuleServiceOperation } from './service-auth';

type PaymentOperation = 'orders.create' | 'orders.read' | 'refunds.create';

export interface ModulePaymentRouteDependencies {
  runtime: RuntimeReleaseProfile;
  requireCapability(
    authorization: string | undefined,
    operation: PaymentOperation,
  ): Promise<ModuleServiceCapabilityClaimsV1>;
  orderService: Pick<
    DeveloperModulePaymentOrderService,
    'createOrder' | 'getOrder' | 'createRefund'
  >;
}

let runtimeOrderService: ModulePaymentRouteDependencies['orderService'] | null = null;

export function configureModulePaymentOrderService(
  service: ModulePaymentRouteDependencies['orderService'] | null,
): void {
  runtimeOrderService = service;
}

export function createRuntimeModulePaymentDependencies(): ModulePaymentRouteDependencies {
  return {
    runtime: loadRuntimeReleaseProfile(),
    requireCapability: (authorization, operation) =>
      requireModuleServiceOperation(authorization, { service: 'payment', operation }),
    orderService: runtimeOrderService ?? unavailableOrderService,
  };
}

export function createModulePaymentRoutes(dependencies: ModulePaymentRouteDependencies) {
  const app = makeOpenApiApp<AppEnv>();

  app.use('*', async (context, next) => {
    const rejected = rejectUnavailableCapability(
      context,
      'commerce.purchase',
      dependencies.runtime,
    );
    if (rejected) return rejected;
    return next();
  });

  app.post('/orders', async (context) => {
    const idempotencyKey = context.req.header('idempotency-key');
    const body = await readJson(context);
    const parsed = CreateDeveloperPaymentOrderInputSchema.safeParse(body);
    if (!parsed.success || !idempotencyKey) {
      return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    }
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'orders.create',
      );
      return context.json(
        await dependencies.orderService.createOrder({
          claims,
          input: parsed.data,
          idempotencyKey,
        }),
        201,
      );
    } catch (error) {
      return paymentErrorResponse(context, error);
    }
  });

  app.get('/orders/:orderId', async (context) => {
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'orders.read',
      );
      const order = await dependencies.orderService.getOrder({
        claims,
        orderId: context.req.param('orderId'),
      });
      return context.json(order, 200);
    } catch (error) {
      return paymentErrorResponse(context, error);
    }
  });

  app.post('/orders/:orderId/refunds', async (context) => {
    const idempotencyKey = context.req.header('idempotency-key');
    const body = await readJson(context);
    const parsed = CreateDeveloperPaymentRefundInputSchema.safeParse(body);
    if (!parsed.success || !idempotencyKey) {
      return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    }
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'refunds.create',
      );
      return context.json(
        await dependencies.orderService.createRefund({
          claims,
          orderId: context.req.param('orderId'),
          amountMinor: parsed.data.amount_minor,
          idempotencyKey,
        }),
        201,
      );
    } catch (error) {
      return paymentErrorResponse(context, error);
    }
  });

  return app;
}

async function readJson(context: { req: { text(): Promise<string> } }): Promise<unknown> {
  try {
    const text = await context.req.text();
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

function paymentErrorResponse(
  context: {
    json(payload: { error: string }, status: 400 | 401 | 403 | 404 | 409 | 503): Response;
  },
  error: unknown,
): Response {
  if (error instanceof DeveloperModulePaymentError) {
    return context.json({ error: error.code }, error.status);
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    [400, 401, 403, 404, 409, 503].includes(Number((error as { status?: unknown }).status))
  ) {
    const code = String((error as { code: string }).code);
    if (/^MODULE_(?:SERVICE|PAYMENT)_/.test(code)) {
      return context.json(
        { error: code },
        Number((error as { status: number }).status) as 400 | 401 | 403 | 404 | 409 | 503,
      );
    }
  }
  return context.json({ error: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE' }, 503);
}

const unavailableOrderService = {
  async createOrder(): Promise<never> {
    throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
  },
  async getOrder(): Promise<never> {
    throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
  },
  async createRefund(): Promise<never> {
    throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
  },
} as unknown as ModulePaymentRouteDependencies['orderService'];

export type { DeveloperPaymentOrderView, DeveloperPaymentRefundView };
