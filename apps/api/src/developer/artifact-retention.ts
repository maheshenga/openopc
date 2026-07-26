import {
  type DeveloperArtifactCleanupCandidate,
  type DeveloperArtifactRetentionConfig,
  DeveloperArtifactRetentionConfigSchema,
  type DeveloperArtifactRetentionRepository,
  type DeveloperArtifactRetentionRun,
  type DeveloperArtifactRetentionStore,
  type DeveloperArtifactRetentionTickResult,
  type DeveloperArtifactRetentionWorker,
} from './artifact-retention-spec';

export function createDeveloperArtifactRetentionWorker(input: {
  config: DeveloperArtifactRetentionConfig;
  repository: DeveloperArtifactRetentionRepository;
  store: DeveloperArtifactRetentionStore;
}): DeveloperArtifactRetentionWorker {
  const parsed = DeveloperArtifactRetentionConfigSchema.safeParse(input.config);
  if (!parsed.success) {
    return {
      async runOnce() {
        return {
          success: false,
          error: { code: 'RETENTION_CONFIG_INVALID', recoverable: false },
        };
      },
    };
  }
  const config = parsed.data;

  const retryDelayMs = (attempt: number): number =>
    Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(Math.max(attempt, 0), 12));

  return {
    async runOnce(options): Promise<DeveloperArtifactRetentionTickResult> {
      const signal = options?.signal;
      // An abort before any claim means the tick never started: report idle.
      if (signal?.aborted) return { success: true, data: { kind: 'idle' } };

      let run: DeveloperArtifactRetentionRun | null;
      try {
        run = await input.repository.claimRun({
          ownerId: config.ownerId,
          leaseMs: config.leaseMs,
        });
      } catch {
        return {
          success: false,
          error: { code: 'RETENTION_REPOSITORY_FAILED', recoverable: true },
        };
      }
      if (!run) return { success: true, data: { kind: 'idle' } };
      const claimedRun = run;

      // Track the latest database-reported time; the API host clock never
      // participates in eligibility or orphan-maturity decisions.
      let databaseNow = Date.parse(claimedRun.claimedAt);
      const leaseLost = (): DeveloperArtifactRetentionTickResult => ({
        success: false,
        error: { code: 'RETENTION_LEASE_LOST', recoverable: true },
      });

      const retryFailure = async (
        code: 'RETENTION_REPOSITORY_FAILED' | 'RETENTION_OBJECT_STORE_FAILED',
        candidate?: DeveloperArtifactCleanupCandidate,
      ): Promise<DeveloperArtifactRetentionTickResult> => {
        // The claim already consumed this run attempt, so terminal failure and
        // backoff derive from the stored attempt count as-is.
        const terminal = claimedRun.attempts >= config.maxAttempts;
        if (candidate) {
          await input.repository
            .recordUploadFailure({
              runId: claimedRun.runId,
              ownerId: config.ownerId,
              accountId: candidate.accountId,
              uploadId: candidate.uploadId,
              errorCode: code,
              delayMs: retryDelayMs(candidate.cleanupAttempts),
            })
            .catch(() => undefined);
        }
        const retried = await input.repository
          .retryRun({
            runId: claimedRun.runId,
            ownerId: config.ownerId,
            errorCode: code,
            delayMs: retryDelayMs(claimedRun.attempts - 1),
            terminal,
          })
          .catch(() => false);
        return {
          success: false,
          error: { code, recoverable: retried && !terminal },
        };
      };

      // Renew the run lease immediately before every destructive object-store
      // call so a fenced-out worker can never delete under a stale lease.
      const renewLease = async (): Promise<
        { renewed: true } | { renewed: false; result: DeveloperArtifactRetentionTickResult }
      > => {
        let renewal: { valid: boolean; now: string };
        try {
          renewal = await input.repository.renewRunLease({
            runId: claimedRun.runId,
            ownerId: config.ownerId,
            leaseMs: config.leaseMs,
          });
        } catch {
          return { renewed: false, result: await retryFailure('RETENTION_REPOSITORY_FAILED') };
        }
        if (!renewal.valid) return { renewed: false, result: leaseLost() };
        const renewedAt = Date.parse(renewal.now);
        if (Number.isFinite(renewedAt)) databaseNow = Math.max(databaseNow, renewedAt);
        return { renewed: true };
      };

      let uploadsDeleted = 0;
      const yieldProgress = async (
        cursor: string | null,
        orphanObjectsDeleted: number,
      ): Promise<DeveloperArtifactRetentionTickResult> => {
        let rescheduled: boolean;
        try {
          rescheduled = await input.repository.rescheduleRun({
            runId: claimedRun.runId,
            ownerId: config.ownerId,
            cursor,
            delayMs: 0,
          });
        } catch {
          return retryFailure('RETENTION_REPOSITORY_FAILED');
        }
        if (!rescheduled) return leaseLost();
        return {
          success: true,
          data: {
            kind: 'progress',
            runId: claimedRun.runId,
            uploadsDeleted,
            orphanObjectsDeleted,
          },
        };
      };

      // Claim one upload candidate at a time so a stop request never strands a
      // large claimed batch behind an aborted tick.
      let uploadClaims = 0;
      while (uploadClaims < config.uploadBatchSize) {
        if (signal?.aborted) return yieldProgress(claimedRun.cursor, 0);
        let candidates: readonly DeveloperArtifactCleanupCandidate[];
        try {
          candidates = await input.repository.claimUploadCandidates({
            runId: claimedRun.runId,
            ownerId: config.ownerId,
            limit: 1,
          });
        } catch {
          return retryFailure('RETENTION_REPOSITORY_FAILED');
        }
        const candidate = candidates[0];
        if (!candidate) break;
        uploadClaims += 1;

        const renewal = await renewLease();
        if (!renewal.renewed) return renewal.result;
        try {
          const object = await input.store.head(candidate.storageKey);
          // A destructive call that was already started is always finished and
          // marked, even when a stop request arrives while it is in flight.
          if (object) await input.store.delete(candidate.storageKey, object.etag);
        } catch {
          return retryFailure('RETENTION_OBJECT_STORE_FAILED', candidate);
        }
        let marked: boolean;
        try {
          marked = await input.repository.markUploadDeleted({
            runId: claimedRun.runId,
            ownerId: config.ownerId,
            accountId: candidate.accountId,
            uploadId: candidate.uploadId,
          });
        } catch {
          return retryFailure('RETENTION_REPOSITORY_FAILED', candidate);
        }
        if (!marked) return leaseLost();
        uploadsDeleted += 1;
      }

      if (uploadClaims >= config.uploadBatchSize) {
        return yieldProgress(claimedRun.cursor, 0);
      }
      if (signal?.aborted) return yieldProgress(claimedRun.cursor, 0);

      let page: {
        objects: readonly { key: string; etag: string; lastModified: string }[];
        nextCursor: string | null;
      };
      try {
        page = await input.store.listStaging({
          cursor: claimedRun.cursor,
          limit: config.objectBatchSize,
        });
      } catch {
        return retryFailure('RETENTION_OBJECT_STORE_FAILED');
      }

      let orphanObjectsDeleted = 0;
      for (const object of page.objects) {
        // Maturity uses database time only: a skewed API host clock must never
        // widen the orphan window.
        const orphanCutoff = databaseNow - config.orphanGraceMs;
        const lastModified = Date.parse(object.lastModified);
        if (!Number.isFinite(lastModified) || lastModified > orphanCutoff) continue;
        if (signal?.aborted) return yieldProgress(claimedRun.cursor, orphanObjectsDeleted);
        let decision: { leaseValid: boolean; referenced: boolean };
        try {
          decision = await input.repository.isStagingKeyReferenced({
            runId: claimedRun.runId,
            ownerId: config.ownerId,
            storageKey: object.key,
          });
        } catch {
          return retryFailure('RETENTION_REPOSITORY_FAILED');
        }
        if (!decision.leaseValid) return leaseLost();
        if (decision.referenced) continue;
        const renewal = await renewLease();
        if (!renewal.renewed) return renewal.result;
        try {
          await input.store.delete(object.key, object.etag);
        } catch {
          return retryFailure('RETENTION_OBJECT_STORE_FAILED');
        }
        orphanObjectsDeleted += 1;
      }

      if (signal?.aborted) return yieldProgress(claimedRun.cursor, orphanObjectsDeleted);
      if (page.nextCursor !== null) {
        return yieldProgress(page.nextCursor, orphanObjectsDeleted);
      }

      let completed: boolean;
      try {
        completed = await input.repository.completeRun({
          runId: claimedRun.runId,
          ownerId: config.ownerId,
        });
      } catch {
        return retryFailure('RETENTION_REPOSITORY_FAILED');
      }
      if (!completed) return leaseLost();
      return {
        success: true,
        data: {
          kind: 'completed',
          runId: claimedRun.runId,
          uploadsDeleted,
          orphanObjectsDeleted,
        },
      };
    },
  };
}
