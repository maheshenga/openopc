import { config } from '../config';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { createStudioProjectRoutes } from './index';
import { createDrizzleStudioRepository } from './repositories/drizzle';

export function createDefaultStudioProjectRoutes() {
  return createStudioProjectRoutes({
    repository: createDrizzleStudioRepository(db),
    loadProjectForUser,
    assertProjectCapability,
    estimateSigningSecret: config.API_KEY_SECRET,
  });
}
