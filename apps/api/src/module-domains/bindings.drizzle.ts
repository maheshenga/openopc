import {
  type Database,
  developerModuleReleases,
  moduleCustomDomainBindings,
  projectModuleInstallations,
} from '@kortix/db';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import {
  type ModuleCustomDomainBinding,
  ModuleCustomDomainBindingError,
  type ModuleCustomDomainBindingRepository,
  type ModuleCustomDomainInstallation,
} from './bindings';

type BindingRow = typeof moduleCustomDomainBindings.$inferSelect;

function mapBinding(row: BindingRow): ModuleCustomDomainBinding {
  return {
    bindingId: row.bindingId,
    environment: row.environment as ModuleCustomDomainBinding['environment'],
    accountId: row.accountId,
    projectId: row.projectId,
    installationId: row.installationId,
    releaseId: row.releaseId,
    hostname: row.hostname,
    hostnameAscii: row.hostnameAscii,
    state: row.state as ModuleCustomDomainBinding['state'],
    verificationTokenHash: row.verificationTokenHash as `sha256:${string}`,
    cloudflareCustomHostnameId: row.cloudflareCustomHostnameId,
    cnameTarget: row.cnameTarget,
    failureCode: row.failureCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapInstallation(row: {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  installationStatus: string;
  releaseId: string;
  releaseAccountId: string;
  releaseStatus: string;
  releaseExecutionMode: string | null;
  signatureAlgorithm: string | null;
  signature: string | null;
  signedAt: string | null;
}): ModuleCustomDomainInstallation {
  return {
    accountId: row.accountId,
    projectId: row.projectId,
    installationId: row.installationId,
    installRevision: row.installRevision,
    installationStatus:
      row.installationStatus as ModuleCustomDomainInstallation['installationStatus'],
    releaseId: row.releaseId,
    releaseAccountId: row.releaseAccountId,
    releaseStatus: row.releaseStatus,
    releaseExecutionMode: row.releaseExecutionMode,
    signatureAlgorithm: row.signatureAlgorithm,
    signature: row.signature,
    signedAt: row.signedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

export function createDrizzleModuleCustomDomainBindingRepository(
  db: Database,
): ModuleCustomDomainBindingRepository {
  return {
    async resolveInstallation(input) {
      const [row] = await db
        .select({
          accountId: projectModuleInstallations.accountId,
          projectId: projectModuleInstallations.projectId,
          installationId: projectModuleInstallations.installationId,
          installRevision: projectModuleInstallations.installRevision,
          installationStatus: projectModuleInstallations.status,
          releaseId: projectModuleInstallations.activeReleaseId,
          releaseAccountId: developerModuleReleases.accountId,
          releaseStatus: developerModuleReleases.status,
          releaseExecutionMode: sql<
            string | null
          >`${developerModuleReleases.manifest} #>> '{execution,mode}'`,
          signatureAlgorithm: developerModuleReleases.signatureAlgorithm,
          signature: developerModuleReleases.signature,
          signedAt: developerModuleReleases.signedAt,
        })
        .from(projectModuleInstallations)
        .innerJoin(
          developerModuleReleases,
          and(
            eq(developerModuleReleases.releaseId, projectModuleInstallations.activeReleaseId),
            eq(developerModuleReleases.accountId, projectModuleInstallations.accountId),
          ),
        )
        .where(
          and(
            eq(projectModuleInstallations.accountId, input.accountId),
            eq(projectModuleInstallations.projectId, input.projectId),
            eq(projectModuleInstallations.installationId, input.installationId),
          ),
        )
        .limit(1);
      return row ? mapInstallation(row) : null;
    },

    async findByHostnameAscii(hostnameAscii) {
      const [row] = await db
        .select()
        .from(moduleCustomDomainBindings)
        .where(eq(moduleCustomDomainBindings.hostnameAscii, hostnameAscii))
        .limit(1);
      return row ? mapBinding(row) : null;
    },

    async create(binding) {
      try {
        const [row] = await db
          .insert(moduleCustomDomainBindings)
          .values({
            bindingId: binding.bindingId,
            environment: binding.environment,
            accountId: binding.accountId,
            projectId: binding.projectId,
            installationId: binding.installationId,
            releaseId: binding.releaseId,
            hostname: binding.hostname,
            hostnameAscii: binding.hostnameAscii,
            state: binding.state,
            verificationTokenHash: binding.verificationTokenHash,
            cloudflareCustomHostnameId: binding.cloudflareCustomHostnameId,
            cnameTarget: binding.cnameTarget,
            failureCode: binding.failureCode,
            createdBy: binding.createdBy,
            createdAt: binding.createdAt,
            updatedAt: binding.updatedAt,
          })
          .returning();
        if (!row) throw new Error('module custom domain insert returned no row');
        return mapBinding(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ModuleCustomDomainBindingError('MODULE_DOMAIN_HOSTNAME_CONFLICT', 409);
        }
        throw error;
      }
    },

    async list(input) {
      const rows = await db
        .select()
        .from(moduleCustomDomainBindings)
        .where(
          and(
            eq(moduleCustomDomainBindings.environment, input.environment),
            eq(moduleCustomDomainBindings.accountId, input.accountId),
            eq(moduleCustomDomainBindings.projectId, input.projectId),
            eq(moduleCustomDomainBindings.installationId, input.installationId),
          ),
        )
        .orderBy(
          asc(moduleCustomDomainBindings.createdAt),
          asc(moduleCustomDomainBindings.bindingId),
        );
      return rows.map(mapBinding);
    },

    async get(input) {
      const [row] = await db
        .select()
        .from(moduleCustomDomainBindings)
        .where(
          and(
            eq(moduleCustomDomainBindings.environment, input.environment),
            eq(moduleCustomDomainBindings.accountId, input.accountId),
            eq(moduleCustomDomainBindings.projectId, input.projectId),
            eq(moduleCustomDomainBindings.installationId, input.installationId),
            eq(moduleCustomDomainBindings.bindingId, input.bindingId),
          ),
        )
        .limit(1);
      return row ? mapBinding(row) : null;
    },

    async transition(input) {
      const [row] = await db
        .update(moduleCustomDomainBindings)
        .set({
          state: input.to,
          ...(input.cloudflareCustomHostnameId !== undefined
            ? { cloudflareCustomHostnameId: input.cloudflareCustomHostnameId }
            : {}),
          ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(moduleCustomDomainBindings.environment, input.environment),
            eq(moduleCustomDomainBindings.accountId, input.accountId),
            eq(moduleCustomDomainBindings.projectId, input.projectId),
            eq(moduleCustomDomainBindings.installationId, input.installationId),
            eq(moduleCustomDomainBindings.bindingId, input.bindingId),
            inArray(moduleCustomDomainBindings.state, [...input.from]),
          ),
        )
        .returning();
      return row ? mapBinding(row) : null;
    },

    async findActiveByHostnameAscii(input) {
      const [row] = await db
        .select({ binding: moduleCustomDomainBindings })
        .from(moduleCustomDomainBindings)
        .innerJoin(
          projectModuleInstallations,
          and(
            eq(
              projectModuleInstallations.installationId,
              moduleCustomDomainBindings.installationId,
            ),
            eq(projectModuleInstallations.projectId, moduleCustomDomainBindings.projectId),
            eq(projectModuleInstallations.accountId, moduleCustomDomainBindings.accountId),
            eq(projectModuleInstallations.activeReleaseId, moduleCustomDomainBindings.releaseId),
          ),
        )
        .innerJoin(
          developerModuleReleases,
          and(
            eq(developerModuleReleases.releaseId, moduleCustomDomainBindings.releaseId),
            eq(developerModuleReleases.accountId, moduleCustomDomainBindings.accountId),
          ),
        )
        .where(
          and(
            eq(moduleCustomDomainBindings.environment, input.environment),
            eq(moduleCustomDomainBindings.hostnameAscii, input.hostnameAscii),
            eq(moduleCustomDomainBindings.state, 'active'),
            eq(projectModuleInstallations.status, 'active'),
            eq(developerModuleReleases.status, 'published'),
            eq(developerModuleReleases.signatureAlgorithm, 'ed25519'),
            isNotNull(developerModuleReleases.signature),
            isNotNull(developerModuleReleases.signedAt),
            sql`${developerModuleReleases.manifest} #>> '{execution,mode}' = 'sandboxed-web'`,
          ),
        )
        .limit(1);
      return row ? mapBinding(row.binding) : null;
    },
  };
}
