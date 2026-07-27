import { type Database, moduleRuntimeArtifacts } from '@kortix/db';
import {
  type Sha256Digest,
  WASI_RUNTIME_ARTIFACT_MAX_BYTES,
} from '@openopc/module-runtime-contracts';
import { and, eq, sql } from 'drizzle-orm';

import type {
  RuntimeArtifactLeaseStore,
  RuntimeArtifactMetadata,
  RuntimeArtifactMetadataStore,
} from './runtime-artifacts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

type RuntimeArtifactRow = {
  runtimeArtifactId: string;
  accountId: string;
  releaseId: string;
  runtimeDescriptorId: string;
  artifactDigest: string;
  artifactBytes: number | string;
  mediaType: string;
  storageKey: string;
};

function runtimeArtifact(row: RuntimeArtifactRow | undefined): RuntimeArtifactMetadata | null {
  const artifactBytes = Number(row?.artifactBytes);
  if (
    !row ||
    !DIGEST.test(row.artifactDigest) ||
    !Number.isSafeInteger(artifactBytes) ||
    artifactBytes < 1 ||
    artifactBytes > WASI_RUNTIME_ARTIFACT_MAX_BYTES ||
    row.mediaType !== 'application/wasm' ||
    !row.storageKey.startsWith('module-runtime/artifacts/') ||
    row.storageKey.includes('\\') ||
    row.storageKey.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }
  return {
    runtimeArtifactId: row.runtimeArtifactId,
    accountId: row.accountId,
    releaseId: row.releaseId,
    runtimeDescriptorId: row.runtimeDescriptorId,
    digest: row.artifactDigest as Sha256Digest,
    bytes: artifactBytes,
    mediaType: 'application/wasm',
    storageKey: row.storageKey,
  };
}

export function createDrizzleRuntimeArtifactMetadataStore(
  db: Database,
): RuntimeArtifactMetadataStore {
  return {
    async get(accountId, releaseId, runtimeDescriptorId) {
      const [row] = await db
        .select()
        .from(moduleRuntimeArtifacts)
        .where(
          and(
            eq(moduleRuntimeArtifacts.accountId, accountId),
            eq(moduleRuntimeArtifacts.releaseId, releaseId),
            eq(moduleRuntimeArtifacts.runtimeDescriptorId, runtimeDescriptorId),
          ),
        )
        .limit(1);
      return runtimeArtifact(row);
    },
  };
}

export function createDrizzleRuntimeArtifactLeaseStore(db: Database): RuntimeArtifactLeaseStore {
  return {
    async getForLease(input) {
      const rows = (await db.execute(sql`
        SELECT
          artifact.runtime_artifact_id AS "runtimeArtifactId",
          artifact.account_id AS "accountId",
          artifact.release_id AS "releaseId",
          artifact.runtime_descriptor_id AS "runtimeDescriptorId",
          artifact.artifact_digest AS "artifactDigest",
          artifact.artifact_bytes AS "artifactBytes",
          artifact.media_type AS "mediaType",
          artifact.storage_key AS "storageKey"
        FROM kortix.module_executions AS execution
        INNER JOIN kortix.module_execution_leases AS lease_row
          ON lease_row.execution_id = execution.execution_id
         AND lease_row.account_id = execution.account_id
         AND lease_row.project_id = execution.project_id
        INNER JOIN kortix.module_runtime_descriptors AS descriptor
          ON descriptor.descriptor_id = execution.runtime_descriptor_id
         AND descriptor.account_id = execution.account_id
         AND descriptor.release_id = execution.release_id
        INNER JOIN kortix.module_runtime_artifacts AS artifact
          ON artifact.account_id = execution.account_id
         AND artifact.release_id = execution.release_id
         AND artifact.runtime_descriptor_id = descriptor.descriptor_id
        INNER JOIN kortix.module_runners AS runner
          ON runner.runner_id = lease_row.runner_id
         AND runner.account_id = lease_row.account_id
        INNER JOIN kortix.developer_module_releases AS module_release
          ON module_release.release_id = execution.release_id
         AND module_release.account_id = execution.account_id
         AND module_release.runtime_descriptor_digest = descriptor.descriptor_digest
        WHERE execution.account_id = ${input.accountId}::uuid
          AND execution.project_id = ${input.projectId}::uuid
          AND execution.execution_id = ${input.executionId}::uuid
          AND execution.state IN ('leased', 'running')
          AND execution.deadline_at > clock_timestamp()
          AND lease_row.lease_id = ${input.leaseId}::uuid
          AND lease_row.runner_id = ${input.runnerId}::uuid
          AND lease_row.generation = ${input.generation}::integer
          AND lease_row.released_at IS NULL
          AND lease_row.deadline_at > clock_timestamp()
          AND runner.status IN ('active', 'draining')
          AND module_release.status = 'published'
          AND module_release.revoked_at IS NULL
        LIMIT 1
      `)) as RuntimeArtifactRow[];
      return runtimeArtifact(rows[0]);
    },
  };
}
