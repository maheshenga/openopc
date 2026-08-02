import {
  type Database,
  developerModuleArtifacts,
  developerModuleReleases,
  projectModuleInstallations,
} from '@kortix/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import type { ProjectModuleLaunchCandidate, ProjectModuleLaunchRepository } from './launch';

function candidateFromRow(input: {
  installation: typeof projectModuleInstallations.$inferSelect;
  release: typeof developerModuleReleases.$inferSelect | null;
  artifact: typeof developerModuleArtifacts.$inferSelect | null;
}): ProjectModuleLaunchCandidate {
  const { installation, release, artifact } = input;
  return {
    accountId: installation.accountId,
    projectId: installation.projectId,
    installationId: installation.installationId,
    installRevision: installation.installRevision,
    installationStatus: installation.status,
    activeReleaseId: installation.activeReleaseId,
    activeVersion: installation.activeVersion,
    moduleId: installation.moduleId,
    releaseId: release?.releaseId ?? installation.activeReleaseId,
    releaseStatus: release?.status ?? 'missing',
    releaseModuleId: release?.moduleId ?? '',
    releaseModuleVersion: release?.moduleVersion ?? '',
    manifest: (release?.manifest as unknown as ProjectModuleLaunchCandidate['manifest']) ?? null,
    signatureAlgorithm: release?.signatureAlgorithm ?? null,
    signatureKeyId: release?.signatureKeyId ?? null,
    signature: release?.signature ?? null,
    signaturePayloadDigest: release?.signaturePayloadDigest ?? null,
    signedAt: release?.signedAt ?? null,
    publishedAt: release?.publishedAt ?? null,
    revokedAt: release?.revokedAt ?? null,
    artifactId: release?.artifactId ?? null,
    storageKey: artifact?.storageKey ?? null,
    artifactDigest: artifact?.artifactDigest ?? null,
    artifactSize: artifact?.sizeBytes ?? null,
  };
}

export function createDrizzleProjectModuleLaunchRepository(
  db: Database,
): ProjectModuleLaunchRepository {
  return {
    async loadCandidate(input) {
      const [row] = await db
        .select({
          installation: projectModuleInstallations,
          release: developerModuleReleases,
          artifact: developerModuleArtifacts,
        })
        .from(projectModuleInstallations)
        .leftJoin(
          developerModuleReleases,
          eq(developerModuleReleases.releaseId, projectModuleInstallations.activeReleaseId),
        )
        .leftJoin(
          developerModuleArtifacts,
          and(
            eq(developerModuleArtifacts.artifactId, developerModuleReleases.artifactId),
            eq(developerModuleArtifacts.accountId, developerModuleReleases.accountId),
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
      return row ? candidateFromRow(row) : null;
    },

    async isCurrent(input) {
      const [row] = await db
        .select({ installationId: projectModuleInstallations.installationId })
        .from(projectModuleInstallations)
        .innerJoin(
          developerModuleReleases,
          eq(developerModuleReleases.releaseId, projectModuleInstallations.activeReleaseId),
        )
        .where(
          and(
            eq(projectModuleInstallations.accountId, input.accountId),
            eq(projectModuleInstallations.projectId, input.projectId),
            eq(projectModuleInstallations.installationId, input.installationId),
            eq(projectModuleInstallations.activeReleaseId, input.releaseId),
            eq(projectModuleInstallations.installRevision, input.installRevision),
            eq(projectModuleInstallations.status, 'active'),
            eq(developerModuleReleases.status, 'published'),
            isNotNull(developerModuleReleases.publishedAt),
            isNull(developerModuleReleases.revokedAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
  };
}
