import { deriveRequestContext } from '../iam/cache';
import { assertAuthorized } from '../iam/dispatcher';
import { db } from '../shared/db';
import { createStudioAccountRoutes } from './account-routes';
import { StudioPricingService } from './pricing';
import { createDrizzleStudioRepository } from './repositories/drizzle';
import type { StudioRepository } from './types';

export function createDefaultStudioAccountRoutes(
  input: {
    repository?: StudioRepository;
    authorize?: typeof assertAuthorized;
  } = {},
) {
  const repository = input.repository ?? createDrizzleStudioRepository(db);
  const authorize = input.authorize ?? assertAuthorized;
  return createStudioAccountRoutes({
    pricingService: new StudioPricingService(repository),
    assertAccountCapability: async (c, userId, accountId, action) => {
      await authorize(
        userId,
        accountId,
        action,
        undefined,
        c.get('iamTokenId') ?? undefined,
        deriveRequestContext(c),
      );
    },
  });
}
