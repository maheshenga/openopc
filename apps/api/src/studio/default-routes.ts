import { db } from '../shared/db';
import {
  assertProjectCapability,
  loadProjectForUser,
} from '../projects/lib/access';
import { createStudioProjectRoutes } from './index';
import { createDrizzleStudioRepository } from './repositories/drizzle';

export function createDefaultStudioProjectRoutes() {
  return createStudioProjectRoutes({
    repository: createDrizzleStudioRepository(db as any),
    loadProjectForUser,
    assertProjectCapability,
  });
}
