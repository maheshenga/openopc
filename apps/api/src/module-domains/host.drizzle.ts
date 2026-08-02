import {
  type Database,
  developerModuleArtifacts,
  developerModuleReleases,
  moduleCustomDomainBindings,
  projectModuleInstallations,
} from '@kortix/db';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

import type {
  ModuleCustomDomainHostRepository,
  ModuleCustomDomainStaticRelease,
  ModulePlatformHostRepository,
} from './host';

function entryPath(manifest: Record<string, unknown>): string | null {
  const execution = manifest.execution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return null;
  const value = execution as Record<string, unknown>;
  return value.mode === 'sandboxed-web' && typeof value.entry === 'string' && value.entry.length > 0
    ? value.entry
    : null;
}

function platformEntryPath(manifest: Record<string, unknown>): string | null {
  return manifest.schemaVersion === 3 ? entryPath(manifest) : null;
}

export function createDrizzleModulePlatformHostRepository(
  db: Database,
): ModulePlatformHostRepository {
  return {
    async loadPublishedSandboxedWebRelease(input) {
      const [row] = await db
        .select({
          releaseId: developerModuleReleases.releaseId,
          storageKey: developerModuleArtifacts.storageKey,
          artifactDigest: developerModuleArtifacts.artifactDigest,
          artifactSize: developerModuleArtifacts.sizeBytes,
          manifest: developerModuleReleases.manifest,
        })
        .from(developerModuleReleases)
        .innerJoin(
          developerModuleArtifacts,
          and(
            eq(developerModuleArtifacts.artifactId, developerModuleReleases.artifactId),
            eq(developerModuleArtifacts.accountId, developerModuleReleases.accountId),
            eq(developerModuleArtifacts.artifactDigest, developerModuleReleases.artifactDigest),
          ),
        )
        .where(
          and(
            eq(developerModuleReleases.releaseId, input.releaseId),
            eq(developerModuleReleases.status, 'published'),
            isNull(developerModuleReleases.revokedAt),
            sql`${developerModuleReleases.manifest}->>'schemaVersion' = ${'3'}`,
            sql`${developerModuleReleases.manifest}->'execution'->>'mode' = ${'sandboxed-web'}`,
            sql`coalesce(${developerModuleReleases.manifest}->'execution'->>'entry', '') <> ''`,
            eq(developerModuleReleases.signatureAlgorithm, 'ed25519'),
            isNotNull(developerModuleReleases.signatureKeyId),
            isNotNull(developerModuleReleases.signature),
            isNotNull(developerModuleReleases.signaturePayloadDigest),
            isNotNull(developerModuleReleases.signedAt),
            isNotNull(developerModuleReleases.publishedAt),
            isNotNull(developerModuleReleases.artifactId),
            isNotNull(developerModuleReleases.artifactDigest),
            isNotNull(developerModuleArtifacts.storageKey),
            isNotNull(developerModuleArtifacts.artifactDigest),
            gt(developerModuleArtifacts.sizeBytes, 0),
          ),
        )
        .limit(1);
      if (!row) return null;
      const entry = platformEntryPath(row.manifest);
      if (!entry) return null;
      return {
        releaseId: row.releaseId,
        storageKey: row.storageKey,
        artifactDigest: row.artifactDigest as `sha256:${string}`,
        artifactSize: row.artifactSize,
        entryPath: entry,
      };
    },
  };
}

export function createDrizzleModuleCustomDomainHostRepository(
  db: Database,
): ModuleCustomDomainHostRepository {
  return {
    async loadActiveSandboxedWebRelease(input) {
      const [row] = await db
        .select({
          environment: moduleCustomDomainBindings.environment,
          bindingId: moduleCustomDomainBindings.bindingId,
          releaseId: developerModuleReleases.releaseId,
          storageKey: developerModuleArtifacts.storageKey,
          artifactDigest: developerModuleArtifacts.artifactDigest,
          artifactSize: developerModuleArtifacts.sizeBytes,
          manifest: developerModuleReleases.manifest,
        })
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
        .innerJoin(
          developerModuleArtifacts,
          and(
            eq(developerModuleArtifacts.artifactId, developerModuleReleases.artifactId),
            eq(developerModuleArtifacts.accountId, developerModuleReleases.accountId),
          ),
        )
        .where(
          and(
            eq(moduleCustomDomainBindings.environment, input.environment),
            eq(moduleCustomDomainBindings.bindingId, input.bindingId),
            eq(moduleCustomDomainBindings.releaseId, input.releaseId),
            eq(moduleCustomDomainBindings.state, 'active'),
            eq(projectModuleInstallations.status, 'active'),
            eq(developerModuleReleases.releaseId, input.releaseId),
            eq(developerModuleReleases.status, 'published'),
            eq(developerModuleReleases.signatureAlgorithm, 'ed25519'),
            isNotNull(developerModuleReleases.signature),
            isNotNull(developerModuleReleases.signedAt),
          ),
        )
        .limit(1);
      if (!row) return null;
      const entry = entryPath(row.manifest);
      if (!entry) return null;
      return {
        environment: row.environment as ModuleCustomDomainStaticRelease['environment'],
        bindingId: row.bindingId,
        releaseId: row.releaseId,
        storageKey: row.storageKey,
        artifactDigest: row.artifactDigest as `sha256:${string}`,
        artifactSize: row.artifactSize,
        entryPath: entry,
      };
    },
  };
}
