import {
  type Database,
  developerModuleReleases,
  developerModuleVerificationRuns,
  developerPublishers,
} from '@kortix/db';
import type { RegistryModuleManifest } from '@kortix/registry';
import { and, desc, eq } from 'drizzle-orm';

import {
  type DeveloperModuleRelease,
  DeveloperModuleReleaseError,
  type DeveloperModuleReleaseRepository,
  type DeveloperModuleReviewRequirement,
} from './releases';

type DeveloperModuleReleaseRow = typeof developerModuleReleases.$inferSelect;

export function serializeDeveloperModuleReleaseRow(
  row: DeveloperModuleReleaseRow,
): DeveloperModuleRelease {
  return {
    release_id: row.releaseId,
    account_id: row.accountId,
    item_name: row.itemName,
    publisher_id: row.publisherId,
    module_id: row.moduleId,
    module_version: row.moduleVersion,
    manifest: structuredClone(row.manifest) as unknown as RegistryModuleManifest,
    manifest_digest: row.manifestDigest as `sha256:${string}`,
    artifact_id: row.artifactId,
    artifact_digest: row.artifactDigest as `sha256:${string}` | null,
    sbom_digest: row.sbomDigest as `sha256:${string}` | null,
    trust_attestation_digest: row.trustAttestationDigest as `sha256:${string}` | null,
    verification_policy_digest: row.verificationPolicyDigest as `sha256:${string}` | null,
    review_requirements: [...row.reviewRequirements] as DeveloperModuleReviewRequirement[],
    status: row.status,
    review_revision: row.reviewRevision,
    signature_algorithm: row.signatureAlgorithm as 'ed25519' | null,
    signature_key_id: row.signatureKeyId,
    signature: row.signature as `base64url:${string}` | null,
    signature_payload_digest: row.signaturePayloadDigest as `sha256:${string}` | null,
    signed_at: row.signedAt,
    published_at: row.publishedAt,
    revoked_at: row.revokedAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function createDrizzleDeveloperModuleReleaseRepository(
  db: Database,
): DeveloperModuleReleaseRepository {
  return {
    async submit(input) {
      return db.transaction(async (tx) => {
        const [existingPublisher] = await tx
          .select({ publisherId: developerPublishers.publisherId })
          .from(developerPublishers)
          .where(
            and(
              eq(developerPublishers.accountId, input.accountId),
              eq(developerPublishers.publisherId, input.manifest.publisher.id),
            ),
          )
          .limit(1);
        if (!existingPublisher) {
          throw new DeveloperModuleReleaseError('DEVELOPER_PUBLISHER_CONFLICT', 409);
        }

        const [inserted] = await tx
          .insert(developerModuleReleases)
          .values({
            accountId: input.accountId,
            publisherId: input.manifest.publisher.id,
            itemName: input.itemName,
            moduleId: input.manifest.id,
            moduleVersion: input.manifest.version,
            manifest: input.manifest as unknown as Record<string, unknown>,
            manifestDigest: input.manifestDigest,
            artifactId: input.artifactId,
            artifactDigest: input.artifactDigest,
            reviewRequirements: [...input.reviewRequirements],
            status: 'validated',
            createdBy: input.actorUserId,
          })
          .onConflictDoNothing({
            target: [developerModuleReleases.moduleId, developerModuleReleases.moduleVersion],
          })
          .returning();

        if (inserted) {
          await tx
            .insert(developerModuleVerificationRuns)
            .values({
              releaseId: inserted.releaseId,
              artifactId: input.artifactId,
              accountId: input.accountId,
              policyDigest: input.verification.policyDigest,
              scannerSetDigest: input.verification.scannerSetDigest,
              sandboxProfileDigest: input.verification.sandboxProfileDigest,
              attempt: 1,
              state: 'queued',
            })
            .returning({ runId: developerModuleVerificationRuns.runId });
          return { release: serializeDeveloperModuleReleaseRow(inserted), created: true };
        }

        const [existingRelease] = await tx
          .select()
          .from(developerModuleReleases)
          .where(
            and(
              eq(developerModuleReleases.moduleId, input.manifest.id),
              eq(developerModuleReleases.moduleVersion, input.manifest.version),
            ),
          )
          .limit(1);
        if (
          !existingRelease ||
          existingRelease.accountId !== input.accountId ||
          existingRelease.manifestDigest !== input.manifestDigest ||
          existingRelease.artifactDigest !== input.artifactDigest
        ) {
          throw new DeveloperModuleReleaseError('DEVELOPER_MODULE_VERSION_CONFLICT', 409);
        }
        return { release: serializeDeveloperModuleReleaseRow(existingRelease), created: false };
      });
    },

    async list(accountId, limit) {
      const rows = await db
        .select()
        .from(developerModuleReleases)
        .where(eq(developerModuleReleases.accountId, accountId))
        .orderBy(desc(developerModuleReleases.createdAt), desc(developerModuleReleases.releaseId))
        .limit(limit);
      return rows.map(serializeDeveloperModuleReleaseRow);
    },

    async get(accountId, releaseId) {
      const [row] = await db
        .select()
        .from(developerModuleReleases)
        .where(
          and(
            eq(developerModuleReleases.accountId, accountId),
            eq(developerModuleReleases.releaseId, releaseId),
          ),
        )
        .limit(1);
      return row ? serializeDeveloperModuleReleaseRow(row) : null;
    },
  };
}
