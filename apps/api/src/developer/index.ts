import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { config } from '../config';
import { assertAuthorized } from '../iam/dispatcher';
import { registerDeveloperModuleMarketplaceSource } from '../marketplace/developer-modules';
import { supabaseAuth } from '../middleware/auth';
import { db } from '../shared/db';
import { resolveScopedAccountId } from '../shared/resolve-account';
import { getDefaultStudioApiRuntime } from '../studio/default-routes';
import type { AppEnv } from '../types';
import { createDeveloperApp } from './app';
import {
  type DeveloperModuleArtifactRepository,
  DeveloperModuleArtifactService,
  createUnavailableDeveloperArtifactStore,
} from './artifacts';
import { createDrizzleDeveloperModuleArtifactRepository } from './artifacts.drizzle';
import { createDeveloperModuleS3ArtifactStore } from './artifacts.s3';
import {
  type DeveloperModuleDistributionRepository,
  DeveloperModuleDistributionService,
} from './distribution';
import { createDrizzleDeveloperModuleDistributionRepository } from './distribution.drizzle';
import { ProjectModuleInstallationService } from './installations';
import { createDrizzleProjectModuleInstallationRepository as createProjectInstallationRepository } from './installations.drizzle';
import {
  createConfiguredModuleSigningPort,
  resolveModuleSignerConfig,
} from './module-signer-config';
import {
  DEFAULT_DEVELOPER_MODULE_VERIFICATION_BINDING,
  type DeveloperModuleReleaseRepository,
  DeveloperModuleReleaseService,
} from './releases';
import { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';
import { type DeveloperModuleReviewRepository, DeveloperModuleReviewService } from './reviews';
import { createDrizzleDeveloperModuleReviewRepository } from './reviews.drizzle';
import { DeveloperModuleTrustGate } from './trust-gate';
import { createDeveloperTrustReadinessClient } from './trust-readiness';
import { DeveloperModuleVerificationService } from './verification';
import { createDrizzleDeveloperModuleVerificationRepository } from './verification.drizzle';

export { createDeveloperApp, type DeveloperAppDependencies } from './app';
export * from './artifacts';
export { createDrizzleDeveloperModuleArtifactRepository } from './artifacts.drizzle';
export { createDeveloperModuleS3ArtifactStore } from './artifacts.s3';
export * from './distribution';
export { createDrizzleDeveloperModuleDistributionRepository } from './distribution.drizzle';
export * from './installations';
export { createDrizzleProjectModuleInstallationRepository } from './installations.drizzle';
export {
  createConfiguredModuleSigningPort,
  resolveModuleSignerConfig,
} from './module-signer-config';
export * from './releases';
export { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';
export * from './reviews';
export { createDrizzleDeveloperModuleReviewRepository } from './reviews.drizzle';
export * from './trust-gate';
export * from './trust-readiness';
export * from './verification';
export { createDrizzleDeveloperModuleVerificationRepository } from './verification.drizzle';

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

const artifactRepository: DeveloperModuleArtifactRepository =
  createDrizzleDeveloperModuleArtifactRepository(db);
const artifactStore = (() => {
  try {
    const runtime = getDefaultStudioApiRuntime();
    return runtime.enabled
      ? createDeveloperModuleS3ArtifactStore(runtime.store)
      : createUnavailableDeveloperArtifactStore();
  } catch {
    return createUnavailableDeveloperArtifactStore();
  }
})();
const developerTrustReadiness = createDeveloperTrustReadinessClient({
  enabled: process.env.DEVELOPER_TRUST_ENABLED === 'true',
  url: process.env.DEVELOPER_TRUST_READINESS_URL,
});
export const developerModuleArtifactService = new DeveloperModuleArtifactService({
  repository: artifactRepository,
  store: artifactStore,
  codeModulesEnabled: process.env.DEVELOPER_CODE_MODULES_ENABLED === 'true',
  trustInfrastructureReady: () => developerTrustReadiness.isReady(),
});
const releaseRepository: DeveloperModuleReleaseRepository =
  createDrizzleDeveloperModuleReleaseRepository(db);
const releaseService = new DeveloperModuleReleaseService({
  repository: releaseRepository,
  artifacts: artifactRepository,
});
export const developerModuleVerificationRepository =
  createDrizzleDeveloperModuleVerificationRepository(db);
export const developerModuleVerificationService = new DeveloperModuleVerificationService({
  repository: developerModuleVerificationRepository,
  currentPolicy: DEFAULT_DEVELOPER_MODULE_VERIFICATION_BINDING,
});
export const developerModuleTrustGate = new DeveloperModuleTrustGate({
  repository: developerModuleVerificationRepository,
  currentPolicyDigest: DEFAULT_DEVELOPER_MODULE_VERIFICATION_BINDING.policyDigest,
});
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
  trustGate: developerModuleTrustGate,
});
export const projectModuleInstallationService = new ProjectModuleInstallationService({
  repository: createProjectInstallationRepository(db),
  releaseService: developerModuleDistributionService,
  verifiers: configuredSigner ? [configuredSigner] : [],
  platformVersion: process.env.OPENOPC_PLATFORM_VERSION ?? '1.0.0',
  registryVersion: '1.0.0',
});
registerDeveloperModuleMarketplaceSource(
  developerModuleDistributionEnabled ? developerModuleDistributionService : null,
);
const reviewRepository: DeveloperModuleReviewRepository =
  createDrizzleDeveloperModuleReviewRepository(db);
export const developerModuleReviewService = new DeveloperModuleReviewService({
  repository: reviewRepository,
  distributionRepository,
  trustGate: developerModuleTrustGate,
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
  artifactService: developerModuleArtifactService,
  releaseService,
  reviewService: developerModuleReviewService,
  verificationService: developerModuleVerificationService,
});
