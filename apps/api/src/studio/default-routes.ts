import { lookup } from 'node:dns/promises';
import { parseStudioAdapterEnvironment } from '@kortix/studio-adapters';
import { config } from '../config';
import { deriveRequestContext } from '../iam/cache';
import { assertAuthorized } from '../iam/dispatcher';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { createStudioProjectRoutes } from './index';
import { StudioProviderConfigService, createStudioProviderOriginValidator } from './providers';
import { createDrizzleStudioRepository } from './repositories/drizzle';

const adapterEnvironment = parseStudioAdapterEnvironment(process.env, {
  test: process.env.NODE_ENV === 'test',
});
const providerOriginValidator = createStudioProviderOriginValidator({
  resolve: async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((answer) => ({
      address: answer.address,
      family: answer.family === 6 ? 6 : 4,
    })),
  allowPrivateOrigins: new Set(
    adapterEnvironment.enabled ? adapterEnvironment.privateProviderOrigins : [],
  ),
  allowInsecureLocalEndpoints:
    adapterEnvironment.enabled && adapterEnvironment.allowInsecureLocalEndpoints,
});

export function createDefaultStudioProjectRoutes() {
  const repository = createDrizzleStudioRepository(db);
  return createStudioProjectRoutes({
    repository,
    providerConfigService: new StudioProviderConfigService(repository, {
      validateOrigin: providerOriginValidator,
    }),
    loadProjectForUser,
    assertProjectCapability,
    assertAccountCapability: async (c, userId, accountId, action) => {
      await assertAuthorized(
        userId,
        accountId,
        action,
        undefined,
        c.get('iamTokenId') ?? undefined,
        deriveRequestContext(c),
      );
    },
    estimateSigningSecret: config.API_KEY_SECRET,
  });
}
