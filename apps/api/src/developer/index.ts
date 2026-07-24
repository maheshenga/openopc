import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { config } from '../config';
import { assertAuthorized } from '../iam/dispatcher';
import { supabaseAuth } from '../middleware/auth';
import { db } from '../shared/db';
import { resolveScopedAccountId } from '../shared/resolve-account';
import type { AppEnv } from '../types';
import { createDeveloperApp } from './app';
import {
  type DeveloperModuleDistributionRepository,
  DeveloperModuleDistributionService,
} from './distribution';
import { createDrizzleDeveloperModuleDistributionRepository } from './distribution.drizzle';
import {
  createConfiguredModuleSigningPort,
  resolveModuleSignerConfig,
} from './module-signer-config';
import { type DeveloperModuleReleaseRepository, DeveloperModuleReleaseService } from './releases';
import { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';
import { type DeveloperModuleReviewRepository, DeveloperModuleReviewService } from './reviews';
import { createDrizzleDeveloperModuleReviewRepository } from './reviews.drizzle';

export { createDeveloperApp, type DeveloperAppDependencies } from './app';
export * from './distribution';
export { createDrizzleDeveloperModuleDistributionRepository } from './distribution.drizzle';
export {
  createConfiguredModuleSigningPort,
  resolveModuleSignerConfig,
} from './module-signer-config';
export * from './releases';
export { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';
export * from './reviews';
export { createDrizzleDeveloperModuleReviewRepository } from './reviews.drizzle';

async function requestedAccountId(context: Context<AppEnv>, source: 'body' | 'query') {
  if (source === 'query') return context.req.query('account_id');
  try {
    const body = (await context.req.json()) as { account_id?: unknown };
    return typeof body.account_id === 'string' ? body.account_id : undefined;
  } catch {
    return undefined;
  }
}

async function resolveDeveloperAccountId(
  context: Context<AppEnv>,
  source: 'body' | 'query',
): Promise<string> {
  const boundAccountId = context.get('accountId');
  const requested = await requestedAccountId(context, source);
  if (boundAccountId) {
    if (requested && requested !== boundAccountId) {
      throw new HTTPException(403, { message: 'Requested account is outside token scope' });
    }
    return boundAccountId;
  }
  return resolveScopedAccountId(context, source);
}

const releaseRepository: DeveloperModuleReleaseRepository =
  createDrizzleDeveloperModuleReleaseRepository(db);
const releaseService = new DeveloperModuleReleaseService({ repository: releaseRepository });
const distributionRepository: DeveloperModuleDistributionRepository =
  createDrizzleDeveloperModuleDistributionRepository(db);
const moduleSignerConfig = resolveModuleSignerConfig(config);
export const developerModuleDistributionEnabled = moduleSignerConfig.enabled;
let configuredSigner = null;
try {
  configuredSigner = createConfiguredModuleSigningPort(moduleSignerConfig);
} catch {
  // Keep unrelated Kortix routes available; distribution operations fail closed.
}
export const developerModuleDistributionService = new DeveloperModuleDistributionService({
  repository: distributionRepository,
  signer: configuredSigner,
});
const reviewRepository: DeveloperModuleReviewRepository =
  createDrizzleDeveloperModuleReviewRepository(db);
export const developerModuleReviewService = new DeveloperModuleReviewService({
  repository: reviewRepository,
  distributionRepository,
});

export const developerApp = createDeveloperApp({
  authenticate: supabaseAuth,
  resolveAccountId: resolveDeveloperAccountId,
  authorizeAccount: (context, accountId, action) =>
    assertAuthorized(
      context.get('userId'),
      accountId,
      action,
      { type: 'account' },
      context.get('iamTokenId'),
    ),
  releaseService,
  reviewService: developerModuleReviewService,
});
