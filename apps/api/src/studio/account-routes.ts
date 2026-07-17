import { StudioCreatePricingCatalogRequestSchema } from '@kortix/api-contract';
import { type Context, Hono } from 'hono';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import type { StudioPricingService } from './pricing';

export type AssertStudioAccountCapability = (
  c: Context<AppEnv>,
  userId: string,
  accountId: string,
  action: string,
) => Promise<void>;

export function createStudioAccountRoutes(input: {
  pricingService: StudioPricingService;
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

  return app;
}
