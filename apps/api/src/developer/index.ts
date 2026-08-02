import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { config } from '../config';
import { assertAuthorized } from '../iam/dispatcher';
import { registerDeveloperModuleMarketplaceSource } from '../marketplace/developer-modules';
import { supabaseAuth } from '../middleware/auth';
import { createModuleCustomDomainInternalRoutes } from '../module-domains/app';
import {
  ModuleCustomDomainBindingService,
  createNodeAuthoritativeDnsResolver,
} from '../module-domains/bindings';
import { createDrizzleModuleCustomDomainBindingRepository } from '../module-domains/bindings.drizzle';
import {
  createCloudflareCustomHostnamePort,
  parseModuleDomainOperatorConfig,
} from '../module-domains/cloudflare';
import {
  ModuleCustomDomainStaticHostService,
  createModuleCustomDomainHostRoutes,
} from '../module-domains/host';
import { createDrizzleModuleCustomDomainHostRepository } from '../module-domains/host.drizzle';
import { ProjectModuleLaunchService } from '../module-domains/launch';
import { createDrizzleProjectModuleLaunchRepository } from '../module-domains/launch.drizzle';
import { parseModuleAppHostConfiguration } from '../module-domains/platform-host-config';
import { createRuntimeArtifactS3Store } from '../module-runtime/runtime-artifacts.s3';
import { loadRuntimeReleaseProfile } from '../release-profile/runtime';
import { db } from '../shared/db';
import { resolveScopedAccountId } from '../shared/resolve-account';
import { getDefaultStudioApiRuntime } from '../studio/default-routes';
import type { AppEnv } from '../types';
import { createDeveloperApp } from './app';
import { DeveloperApplicationService } from './applications';
import { createDrizzleDeveloperApplicationRepository } from './applications.drizzle';
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
  createConfiguredModuleSignerKeyring,
  createConfiguredModuleSigningPort,
  createConfiguredModuleSigningPorts,
  resolveModuleSignerConfig,
} from './module-signer-config';
import type { ModuleVerificationPort } from './module-signing';
import { DeveloperPublisherService } from './publishers';
import { createDrizzleDeveloperPublisherRepository } from './publishers.drizzle';
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
export * from './applications';
export { createDrizzleDeveloperApplicationRepository } from './applications.drizzle';
export * from './artifacts';
export { createDrizzleDeveloperModuleArtifactRepository } from './artifacts.drizzle';
export { createDeveloperModuleS3ArtifactStore } from './artifacts.s3';
export * from './distribution';
export { createDrizzleDeveloperModuleDistributionRepository } from './distribution.drizzle';
export * from './installations';
export { createDrizzleProjectModuleInstallationRepository } from './installations.drizzle';
export {
  createConfiguredModuleSignerKeyring,
  createConfiguredModuleSigningPorts,
  createConfiguredModuleSigningPort,
  resolveModuleSignerConfig,
} from './module-signer-config';
export * from './module-signer-keyring';
export * from './releases';
export { createDrizzleDeveloperModuleReleaseRepository } from './releases.drizzle';
export * from './publishers';
export { createDrizzleDeveloperPublisherRepository } from './publishers.drizzle';
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
export const runtimeReleaseProfile = loadRuntimeReleaseProfile();
export const moduleAppHostConfiguration = parseModuleAppHostConfiguration(
  config.OPENOPC_MODULE_APP_BASE_DOMAIN,
);
export const projectModuleLaunchService = new ProjectModuleLaunchService({
  repository: createDrizzleProjectModuleLaunchRepository(db),
  hostConfiguration: moduleAppHostConfiguration,
});
export const developerApplicationService = new DeveloperApplicationService({
  repository: createDrizzleDeveloperApplicationRepository(db),
  currentPolicyVersions: {
    moduleRules: process.env.OPENOPC_DEVELOPER_MODULE_RULES_VERSION ?? '2026-07-28',
    acceptableUse: process.env.OPENOPC_ACCEPTABLE_USE_VERSION ?? '2026-07-28',
  },
});
export const developerPublisherService = new DeveloperPublisherService({
  repository: createDrizzleDeveloperPublisherRepository(db),
});
const developerStudioRuntime = (() => {
  try {
    return getDefaultStudioApiRuntime();
  } catch {
    return { enabled: false } as const;
  }
})();
const artifactStore = developerStudioRuntime.enabled
  ? createDeveloperModuleS3ArtifactStore(developerStudioRuntime.store)
  : createUnavailableDeveloperArtifactStore();
const runtimeArtifactStore = developerStudioRuntime.enabled
  ? createRuntimeArtifactS3Store(developerStudioRuntime.store)
  : undefined;
const developerTrustReadiness = createDeveloperTrustReadinessClient({
  enabled: process.env.DEVELOPER_TRUST_ENABLED === 'true',
  url: process.env.DEVELOPER_TRUST_READINESS_URL,
});
export const developerModuleArtifactService = new DeveloperModuleArtifactService({
  repository: artifactRepository,
  store: artifactStore,
  permissions: developerPublisherService,
  codeModulesEnabled: process.env.DEVELOPER_CODE_MODULES_ENABLED === 'true',
  trustInfrastructureReady: () => developerTrustReadiness.isReady(),
});
const releaseRepository: DeveloperModuleReleaseRepository =
  createDrizzleDeveloperModuleReleaseRepository(db);
const releaseService = new DeveloperModuleReleaseService({
  repository: releaseRepository,
  artifacts: artifactRepository,
  artifactStore,
  runtimeArtifactStore,
  runtime: runtimeReleaseProfile,
  permissions: developerPublisherService,
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
let configuredVerifiers: readonly ModuleVerificationPort[] = [];
try {
  const configuredPorts = createConfiguredModuleSigningPorts(moduleSignerConfig);
  configuredSigner = configuredPorts.signer;
  configuredVerifiers = configuredPorts.verifiers;
} catch {
  // Keep unrelated Kortix routes available; distribution operations fail closed.
}
export const developerModuleDistributionService = new DeveloperModuleDistributionService({
  repository: distributionRepository,
  signer: configuredSigner,
  verifiers: configuredVerifiers,
  trustGate: developerModuleTrustGate,
  permissions: developerPublisherService,
  runtime: runtimeReleaseProfile,
});
export const projectModuleInstallationService = new ProjectModuleInstallationService({
  repository: createProjectInstallationRepository(db),
  releaseService: developerModuleDistributionService,
  verifiers: configuredVerifiers,
  platformVersion: process.env.OPENOPC_PLATFORM_VERSION ?? '1.0.0',
  registryVersion: '1.0.0',
  runtime: runtimeReleaseProfile,
});

function configuredHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

const moduleCustomDomainOperatorConfig = parseModuleDomainOperatorConfig({
  accountId: config.OPENOPC_CLOUDFLARE_ACCOUNT_ID,
  zoneId: config.OPENOPC_CLOUDFLARE_ZONE_ID,
  apiToken: config.OPENOPC_CLOUDFLARE_CUSTOM_HOSTNAME_API_TOKEN,
  cnameTarget: config.OPENOPC_MODULE_CUSTOM_HOSTNAME_TARGET,
  origin: config.OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN,
  controlledSuffix: config.OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX,
});
export const moduleCustomDomainBindingRepository =
  createDrizzleModuleCustomDomainBindingRepository(db);
const moduleCustomDomainHostRepository = createDrizzleModuleCustomDomainHostRepository(db);
export const moduleCustomDomainBindingService = moduleCustomDomainOperatorConfig
  ? new ModuleCustomDomainBindingService({
      repository: moduleCustomDomainBindingRepository,
      dns: createNodeAuthoritativeDnsResolver(),
      cloudflare: createCloudflareCustomHostnamePort(moduleCustomDomainOperatorConfig),
      cnameTarget: moduleCustomDomainOperatorConfig.cnameTarget,
      environment: config.INTERNAL_KORTIX_ENV,
      platformHostnames: [
        configuredHostname(config.KORTIX_URL),
        configuredHostname(config.FRONTEND_URL),
        configuredHostname(config.OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN),
      ].filter((value): value is string => value !== null),
    })
  : null;
export const moduleCustomDomainHostService = moduleCustomDomainOperatorConfig
  ? new ModuleCustomDomainStaticHostService({
      repository: moduleCustomDomainHostRepository,
      artifactStore,
    })
  : null;
export const moduleCustomDomainInternalApp = createModuleCustomDomainInternalRoutes({
  bindingService: moduleCustomDomainBindingService,
  internalServiceKey: config.INTERNAL_SERVICE_KEY,
});
export const moduleCustomDomainHostApp = createModuleCustomDomainHostRoutes({
  hostService: moduleCustomDomainHostService,
  internalServiceKey: config.INTERNAL_SERVICE_KEY,
  environment: config.INTERNAL_KORTIX_ENV,
  runtime: loadRuntimeReleaseProfile(),
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
  permissions: developerPublisherService,
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
  applicationService: developerApplicationService,
  artifactService: developerModuleArtifactService,
  releaseService,
  reviewService: developerModuleReviewService,
  verificationService: developerModuleVerificationService,
  publisherService: developerPublisherService,
});
