import { z } from 'zod';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DeveloperArtifactRetentionConfigSchema = z
  .object({
    ownerId: z.string().regex(SAFE_IDENTIFIER),
    leaseMs: z.number().int().min(5_000).max(300_000),
    uploadBatchSize: z.number().int().min(1).max(100),
    objectBatchSize: z.number().int().min(1).max(100),
    orphanGraceMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 24 * 60 * 60_000),
    maxAttempts: z.number().int().min(1).max(20),
    retryBaseMs: z.number().int().min(100).max(60_000),
    retryMaxMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000),
  })
  .strict()
  .refine((value) => value.retryMaxMs >= value.retryBaseMs, {
    message: 'retryMaxMs must be greater than or equal to retryBaseMs',
  });

export type DeveloperArtifactRetentionConfig = z.infer<
  typeof DeveloperArtifactRetentionConfigSchema
>;

export interface DeveloperArtifactRetentionRun {
  runId: string;
  acceptanceRunId: string | null;
  state: 'running';
  attempts: number;
  cursor: string | null;
  leaseOwner: string;
  leaseExpiresAt: string;
  claimedAt: string;
}

export interface DeveloperArtifactRetentionRunStatus {
  runId: string;
  acceptanceRunId: string | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  availableAt: string;
  cursor: string | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface DeveloperArtifactCleanupCandidate {
  accountId: string;
  uploadId: string;
  state: 'cancelled' | 'expired' | 'finalized';
  storageKey: string;
  cleanupAttempts: number;
}

export interface DeveloperArtifactRetentionRepository {
  enqueueRun(input: {
    acceptanceRunId: string | null;
    delayMs: number;
  }): Promise<DeveloperArtifactRetentionRunStatus>;
  getRunByAcceptanceRunId(
    acceptanceRunId: string,
  ): Promise<DeveloperArtifactRetentionRunStatus | null>;
  claimRun(input: {
    ownerId: string;
    leaseMs: number;
  }): Promise<DeveloperArtifactRetentionRun | null>;
  renewRunLease(input: {
    runId: string;
    ownerId: string;
    leaseMs: number;
  }): Promise<{ valid: boolean; now: string }>;
  claimUploadCandidates(input: {
    runId: string;
    ownerId: string;
    limit: number;
  }): Promise<readonly DeveloperArtifactCleanupCandidate[]>;
  markUploadDeleted(input: {
    runId: string;
    ownerId: string;
    accountId: string;
    uploadId: string;
  }): Promise<boolean>;
  recordUploadFailure(input: {
    runId: string;
    ownerId: string;
    accountId: string;
    uploadId: string;
    errorCode: string;
    delayMs: number;
  }): Promise<boolean>;
  isStagingKeyReferenced(input: {
    runId: string;
    ownerId: string;
    storageKey: string;
  }): Promise<{ leaseValid: boolean; referenced: boolean }>;
  rescheduleRun(input: {
    runId: string;
    ownerId: string;
    cursor: string | null;
    delayMs: number;
  }): Promise<boolean>;
  completeRun(input: { runId: string; ownerId: string }): Promise<boolean>;
  retryRun(input: {
    runId: string;
    ownerId: string;
    errorCode: string;
    delayMs: number;
    terminal: boolean;
  }): Promise<boolean>;
}

export interface DeveloperArtifactRetentionObject {
  key: string;
  etag: string;
  lastModified: string;
}

export interface DeveloperArtifactRetentionStore {
  head(storageKey: string): Promise<DeveloperArtifactRetentionObject | null>;
  delete(storageKey: string, etag: string): Promise<void>;
  listStaging(input: { cursor: string | null; limit: number }): Promise<{
    objects: readonly DeveloperArtifactRetentionObject[];
    nextCursor: string | null;
  }>;
}

export const DeveloperArtifactRetentionTickResultSchema = z.discriminatedUnion('success', [
  z
    .object({
      success: z.literal(true),
      data: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('idle') }).strict(),
        z
          .object({
            kind: z.enum(['progress', 'completed']),
            runId: z.string().uuid(),
            uploadsDeleted: z.number().int().nonnegative(),
            orphanObjectsDeleted: z.number().int().nonnegative(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      error: z
        .object({
          code: z.enum([
            'RETENTION_CONFIG_INVALID',
            'RETENTION_REPOSITORY_FAILED',
            'RETENTION_OBJECT_STORE_FAILED',
            'RETENTION_LEASE_LOST',
          ]),
          recoverable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

export type DeveloperArtifactRetentionTickResult = z.infer<
  typeof DeveloperArtifactRetentionTickResultSchema
>;

export interface DeveloperArtifactRetentionWorker {
  runOnce(options?: { signal?: AbortSignal }): Promise<DeveloperArtifactRetentionTickResult>;
}
