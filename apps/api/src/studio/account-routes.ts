import {
  StudioCreatePricingCatalogRequestSchema,
  type StudioResolveBillingIncidentRequest,
  StudioResolveBillingIncidentRequestSchema,
  type StudioResolveBillingIncidentResponse,
} from '@kortix/api-contract';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import { StudioBillingIncidentServiceError } from './billing-incidents';
import type { StudioPricingService } from './pricing';

export type AssertStudioAccountCapability = (
  c: Context<AppEnv>,
  userId: string,
  accountId: string,
  action: string,
) => Promise<void>;

export interface StudioBillingIncidentExecutor {
  resolve(input: {
    accountId: string;
    incidentId: string;
    actorUserId: string;
    actingTokenId: string | null;
    request: StudioResolveBillingIncidentRequest;
  }): Promise<StudioResolveBillingIncidentResponse>;
}

export function createStudioAccountRoutes(input: {
  pricingService: StudioPricingService;
  billingIncidentService?: StudioBillingIncidentExecutor;
  assertAccountCapability: AssertStudioAccountCapability;
}) {
  const app = new Hono<AppEnv>();

  app.get('/:accountId/studio/pricing-catalog', async (c) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    await input.assertAccountCapability(c, userId, accountId, ACCOUNT_ACTIONS.BILLING_READ);
    return c.json({ items: await input.pricingService.list(accountId), next_cursor: null });
  });

  app.post('/:accountId/studio/pricing-catalog', async (c) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    await input.assertAccountCapability(c, userId, accountId, ACCOUNT_ACTIONS.BILLING_WRITE);
    const parsed = StudioCreatePricingCatalogRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid Studio pricing request', code: 'STUDIO_VALIDATION_ERROR' },
        400,
      );
    }
    const result = await input.pricingService.create({
      accountId,
      actorUserId: userId,
      request: parsed.data,
    });
    if (!result.ok) {
      return c.json(
        { error: 'Invalid Studio pricing request', code: 'STUDIO_VALIDATION_ERROR' },
        400,
      );
    }
    return c.json(result.value, 201);
  });

  app.post('/:accountId/studio/pricing-catalog/:pricingCatalogId/deactivate', async (c) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    await input.assertAccountCapability(c, userId, accountId, ACCOUNT_ACTIONS.BILLING_WRITE);
    const result = await input.pricingService.deactivate({
      accountId,
      pricingCatalogId: c.req.param('pricingCatalogId'),
    });
    if (!result.ok) return c.json({ error: 'Not found' }, 404);
    return c.json(result.value);
  });

  app.post('/:accountId/studio/billing-incidents/:incidentId/resolve', async (c) => {
    const accountId = c.req.param('accountId');
    const userId = c.get('userId') as string;
    await input.assertAccountCapability(c, userId, accountId, ACCOUNT_ACTIONS.BILLING_WRITE);
    if (!input.billingIncidentService) {
      return c.json(
        { error: 'Studio billing incident resolution unavailable', code: 'STUDIO_INTERNAL_ERROR' },
        503,
      );
    }
    const incidentId = z.string().uuid().safeParse(c.req.param('incidentId'));
    if (!incidentId.success) return c.json({ error: 'Not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: 'Invalid Studio billing incident request', code: 'STUDIO_VALIDATION_ERROR' },
        400,
      );
    }
    const parsed = StudioResolveBillingIncidentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid Studio billing incident request', code: 'STUDIO_VALIDATION_ERROR' },
        400,
      );
    }
    try {
      return c.json(
        await input.billingIncidentService.resolve({
          accountId,
          incidentId: incidentId.data,
          actorUserId: userId,
          actingTokenId: c.get('iamTokenId') ?? null,
          request: parsed.data,
        }),
      );
    } catch (error) {
      if (error instanceof StudioBillingIncidentServiceError) {
        return c.json({ error: error.code, code: error.code }, error.status);
      }
      return c.json({ error: 'STUDIO_INTERNAL_ERROR', code: 'STUDIO_INTERNAL_ERROR' }, 500);
    }
  });

  return app;
}
