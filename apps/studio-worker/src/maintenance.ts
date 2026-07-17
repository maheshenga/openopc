import {
  StudioObjectStoreError,
  studioStagingPrefix,
  studioSubmissionKeyHash,
  type StudioObjectStore,
} from '@kortix/studio-runtime';

export type StudioOrphanStagingCandidate = {
  accountId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  submissionKey: string;
  terminalAt: Date;
};

export interface StudioMaintenanceRepository {
  acquireOrRenewLease(input: {
    lockKey: string;
    ownerId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  releaseLease(input: { lockKey: string; ownerId: string }): Promise<void>;
  requeueExpiredJobLeases(now: Date): Promise<void>;
  failStuckUnknownOutcomes(now: Date): Promise<void>;
  compactProgressEvents(now: Date): Promise<void>;
  expireUploads(now: Date): Promise<void>;
  reconcileCreditReservations(now: Date): Promise<void>;
  listOrphanStagingCandidates(input: {
    retentionBefore: Date;
    limit: number;
  }): Promise<StudioOrphanStagingCandidate[]>;
  isOrphanStagingCandidate(input: {
    candidate: StudioOrphanStagingCandidate;
    retentionBefore: Date;
  }): Promise<boolean>;
}

export class StudioMaintenanceCoordinator {
  constructor(
    private readonly deps: {
      repository: StudioMaintenanceRepository;
      ownerId: string;
      lockKey: string;
      ttlMs: number;
      now?: () => Date;
      objectStore?: StudioObjectStore;
      orphanRetentionMs?: number;
      orphanPageLimit?: number;
    },
  ) {
    if (!deps.lockKey.startsWith('studio-maintenance')) {
      throw new Error('Studio maintenance must use an isolated studio-maintenance lease key');
    }
    if (deps.ttlMs <= 0) throw new Error('Studio maintenance lease TTL must be positive');
    if (
      deps.objectStore &&
      (!Number.isInteger(deps.orphanRetentionMs) || (deps.orphanRetentionMs ?? 0) <= 0)
    ) {
      throw new Error('Studio orphan retention must be a positive integer');
    }
    if (
      deps.orphanPageLimit !== undefined &&
      (!Number.isInteger(deps.orphanPageLimit) ||
        deps.orphanPageLimit < 1 ||
        deps.orphanPageLimit > 100)
    ) {
      throw new Error('Studio orphan page limit must be between 1 and 100');
    }
  }

  async runOnce(): Promise<{ acquired: boolean; tasksRun: number }> {
    const now = (this.deps.now ?? (() => new Date()))();
    const acquired = await this.deps.repository.acquireOrRenewLease({
      lockKey: this.deps.lockKey,
      ownerId: this.deps.ownerId,
      expiresAt: new Date(now.getTime() + this.deps.ttlMs),
      now,
    });
    if (!acquired) return { acquired: false, tasksRun: 0 };
    await this.deps.repository.requeueExpiredJobLeases(now);
    await this.deps.repository.failStuckUnknownOutcomes(now);
    await this.deps.repository.compactProgressEvents(now);
    await this.deps.repository.expireUploads(now);
    await this.deps.repository.reconcileCreditReservations(now);
    if (this.deps.objectStore) {
      await this.cleanOrphanStagingObjects(now);
    }
    return { acquired: true, tasksRun: this.deps.objectStore ? 6 : 5 };
  }

  release(): Promise<void> {
    return this.deps.repository.releaseLease({
      lockKey: this.deps.lockKey,
      ownerId: this.deps.ownerId,
    });
  }

  private async cleanOrphanStagingObjects(now: Date): Promise<void> {
    const store = this.deps.objectStore;
    if (!store) return;
    const retentionBefore = new Date(now.getTime() - (this.deps.orphanRetentionMs ?? 0));
    const limit = this.deps.orphanPageLimit ?? 100;
    const candidates = await this.deps.repository.listOrphanStagingCandidates({
      retentionBefore,
      limit,
    });
    for (const candidate of candidates) {
      if (candidate.terminalAt.getTime() > retentionBefore.getTime()) continue;
      const prefix = studioStagingPrefix({
        accountId: candidate.accountId,
        projectId: candidate.projectId,
        jobId: candidate.jobId,
        attemptId: candidate.attemptId,
        submissionKeyHash: studioSubmissionKeyHash(candidate.submissionKey),
      });
      let cursor: string | undefined;
      let pages = 0;
      do {
        pages += 1;
        if (pages > 100) throw new Error('Studio orphan listing exceeded the page bound');
        const page = await store.listObjects({ prefix, cursor, limit });
        for (const listed of page.objects) {
          if (
            listed.namespace !== store.namespace ||
            !safeKeyUnderPrefix(listed.key, prefix) ||
            !listed.etag ||
            !/^[a-f0-9]{64}$/.test(listed.checksum_sha256) ||
            !isRetained(listed.last_modified, retentionBefore)
          ) {
            continue;
          }
          let head: Awaited<ReturnType<StudioObjectStore['headObject']>>;
          try {
            head = await store.headObject({ key: listed.key });
          } catch (error) {
            if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') continue;
            throw error;
          }
          if (
            head.namespace !== store.namespace ||
            head.key !== listed.key ||
            head.etag !== listed.etag ||
            head.checksum_sha256 !== listed.checksum_sha256 ||
            head.last_modified !== listed.last_modified ||
            !isRetained(head.last_modified, retentionBefore)
          ) {
            continue;
          }
          const stillOrphan = await this.deps.repository.isOrphanStagingCandidate({
            candidate,
            retentionBefore,
          });
          if (!stillOrphan) continue;
          try {
            await store.deleteObject({ key: listed.key, if_match: listed.etag });
          } catch (error) {
            if (
              error instanceof StudioObjectStoreError &&
              (error.code === 'NOT_FOUND' || error.code === 'PRECONDITION_FAILED')
            ) {
              continue;
            }
            throw error;
          }
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
    }
  }
}

export function createMemoryStudioMaintenanceRepository(): StudioMaintenanceRepository & {
  calls: string[];
  seedLease(lockKey: string, ownerId: string, expiresAt: Date): void;
  getLease(lockKey: string): { ownerId: string; expiresAt: Date } | null;
} {
  const leases = new Map<string, { ownerId: string; expiresAt: Date }>();
  const calls: string[] = [];
  return {
    calls,
    seedLease(lockKey, ownerId, expiresAt) {
      leases.set(lockKey, { ownerId, expiresAt });
    },
    getLease(lockKey) {
      const lease = leases.get(lockKey);
      return lease ? { ownerId: lease.ownerId, expiresAt: new Date(lease.expiresAt) } : null;
    },
    async acquireOrRenewLease(input) {
      const current = leases.get(input.lockKey);
      if (
        current &&
        current.ownerId !== input.ownerId &&
        current.expiresAt.getTime() >= input.now.getTime()
      ) {
        return false;
      }
      leases.set(input.lockKey, { ownerId: input.ownerId, expiresAt: input.expiresAt });
      return true;
    },
    async releaseLease(input) {
      if (leases.get(input.lockKey)?.ownerId === input.ownerId) leases.delete(input.lockKey);
    },
    async requeueExpiredJobLeases() {
      calls.push('requeueExpiredJobLeases');
    },
    async failStuckUnknownOutcomes() {
      calls.push('failStuckUnknownOutcomes');
    },
    async compactProgressEvents() {
      calls.push('compactProgressEvents');
    },
    async expireUploads() {
      calls.push('expireUploads');
    },
    async reconcileCreditReservations() {
      calls.push('reconcileCreditReservations');
    },
    async listOrphanStagingCandidates() {
      calls.push('listOrphanStagingCandidates');
      return [];
    },
    async isOrphanStagingCandidate() {
      calls.push('isOrphanStagingCandidate');
      return false;
    },
  };
}

function safeKeyUnderPrefix(key: string, prefix: string): boolean {
  return (
    key.startsWith(prefix) &&
    key.length > prefix.length &&
    !key.includes('\\') &&
    key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function isRetained(value: string | undefined, retentionBefore: Date): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= retentionBefore.getTime();
}
