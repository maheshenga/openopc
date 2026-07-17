import {
  type StudioObjectStore,
  StudioObjectStoreError,
  studioStagingPrefix,
  studioSubmissionKeyHash,
} from '@kortix/studio-runtime';

export type StudioOrphanStagingCandidate = {
  accountId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  submissionKey: string;
  terminalAt: Date;
};

export type StudioOrphanStagingCursor = {
  terminalAt: Date;
  attemptId: string;
};

const DAY_MS = 24 * 60 * 60_000;

export const STUDIO_ORPHAN_CLEANUP_DEFAULTS = Object.freeze({
  retentionMs: 7 * DAY_MS,
  candidatePageLimit: 25,
  objectPageLimit: 100,
  candidateBudget: 25,
  pageBudget: 100,
  objectBudget: 1_000,
});

const STUDIO_ORPHAN_CLEANUP_LIMITS = Object.freeze({
  retentionMs: 30 * DAY_MS,
  candidatePageLimit: 100,
  objectPageLimit: 100,
  candidateBudget: 100,
  pageBudget: 1_000,
  objectBudget: 10_000,
});

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
    after?: StudioOrphanStagingCursor;
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
      /** @deprecated Use orphanObjectPageLimit. */
      orphanPageLimit?: number;
      orphanCandidatePageLimit?: number;
      orphanObjectPageLimit?: number;
      orphanCandidateBudget?: number;
      orphanPageBudget?: number;
      orphanObjectBudget?: number;
    },
  ) {
    if (!deps.lockKey.startsWith('studio-maintenance')) {
      throw new Error('Studio maintenance must use an isolated studio-maintenance lease key');
    }
    if (deps.ttlMs <= 0) throw new Error('Studio maintenance lease TTL must be positive');
    this.orphanRetentionMs = boundedInteger(
      'Studio orphan retention',
      deps.orphanRetentionMs ?? STUDIO_ORPHAN_CLEANUP_DEFAULTS.retentionMs,
      1,
      STUDIO_ORPHAN_CLEANUP_LIMITS.retentionMs,
      '30 days',
    );
    this.orphanCandidatePageLimit = boundedInteger(
      'Studio orphan candidate page limit',
      deps.orphanCandidatePageLimit ?? STUDIO_ORPHAN_CLEANUP_DEFAULTS.candidatePageLimit,
      1,
      STUDIO_ORPHAN_CLEANUP_LIMITS.candidatePageLimit,
    );
    this.orphanObjectPageLimit = boundedInteger(
      'Studio orphan object page limit',
      deps.orphanObjectPageLimit ??
        deps.orphanPageLimit ??
        STUDIO_ORPHAN_CLEANUP_DEFAULTS.objectPageLimit,
      1,
      STUDIO_ORPHAN_CLEANUP_LIMITS.objectPageLimit,
    );
    this.orphanCandidateBudget = boundedInteger(
      'Studio orphan candidate budget',
      deps.orphanCandidateBudget ?? STUDIO_ORPHAN_CLEANUP_DEFAULTS.candidateBudget,
      1,
      STUDIO_ORPHAN_CLEANUP_LIMITS.candidateBudget,
    );
    this.orphanPageBudget = boundedInteger(
      'Studio orphan page budget',
      deps.orphanPageBudget ?? STUDIO_ORPHAN_CLEANUP_DEFAULTS.pageBudget,
      1,
      STUDIO_ORPHAN_CLEANUP_LIMITS.pageBudget,
    );
    this.orphanObjectBudget = boundedInteger(
      'Studio orphan object budget',
      deps.orphanObjectBudget ?? STUDIO_ORPHAN_CLEANUP_DEFAULTS.objectBudget,
      1,
      STUDIO_ORPHAN_CLEANUP_LIMITS.objectBudget,
    );
  }

  private readonly orphanRetentionMs: number;
  private readonly orphanCandidatePageLimit: number;
  private readonly orphanObjectPageLimit: number;
  private readonly orphanCandidateBudget: number;
  private readonly orphanPageBudget: number;
  private readonly orphanObjectBudget: number;
  private orphanCandidateAfter: StudioOrphanStagingCursor | undefined;
  private orphanPendingCandidates: StudioOrphanStagingCandidate[] = [];
  private orphanActiveCandidate:
    | {
        candidate: StudioOrphanStagingCandidate;
        objectCursor?: string;
        seenObjectCursors: Set<string>;
      }
    | undefined;

  async runOnce(): Promise<{ acquired: boolean; tasksRun: number }> {
    const now = this.currentTime();
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
    const retentionBefore = new Date(now.getTime() - this.orphanRetentionMs);
    let remainingCandidates = this.orphanCandidateBudget;
    let remainingPages = this.orphanPageBudget;
    let remainingObjects = this.orphanObjectBudget;

    while (
      remainingPages > 0 &&
      remainingObjects > 0 &&
      (this.orphanActiveCandidate !== undefined || remainingCandidates > 0)
    ) {
      if (!this.orphanActiveCandidate) {
        if (this.orphanPendingCandidates.length === 0) {
          if (!(await this.renewMaintenanceLease())) return;
          const candidates = await this.deps.repository.listOrphanStagingCandidates({
            retentionBefore,
            ...(this.orphanCandidateAfter ? { after: this.orphanCandidateAfter } : {}),
            limit: this.orphanCandidatePageLimit,
          });
          if (!(await this.renewMaintenanceLease())) return;
          if (candidates.length > this.orphanCandidatePageLimit) {
            throw new Error('Studio orphan candidate listing exceeded the page limit');
          }
          const advancing = advancingCandidates(candidates, this.orphanCandidateAfter);
          if (advancing.length === 0) {
            this.orphanCandidateAfter = undefined;
            return;
          }
          this.orphanPendingCandidates = advancing;
        }
        const candidate = this.orphanPendingCandidates.shift();
        if (!candidate) return;
        this.orphanActiveCandidate = { candidate, seenObjectCursors: new Set() };
        remainingCandidates -= 1;
        if (!(await this.renewMaintenanceLease())) return;
      }

      const active = this.orphanActiveCandidate;
      const candidate = active.candidate;
      if (candidate.terminalAt.getTime() > retentionBefore.getTime()) {
        this.completeOrphanCandidate(candidate);
        continue;
      }
      const prefix = studioStagingPrefix({
        accountId: candidate.accountId,
        projectId: candidate.projectId,
        jobId: candidate.jobId,
        attemptId: candidate.attemptId,
        submissionKeyHash: studioSubmissionKeyHash(candidate.submissionKey),
      });
      const requestLimit = Math.min(this.orphanObjectPageLimit, remainingObjects);
      if (!(await this.renewMaintenanceLease())) return;
      const page = await store.listObjects({
        prefix,
        ...(active.objectCursor ? { cursor: active.objectCursor } : {}),
        limit: requestLimit,
      });
      if (!(await this.renewMaintenanceLease())) return;
      remainingPages -= 1;
      if (page.objects.length > requestLimit) {
        throw new Error('Studio orphan object listing exceeded the requested limit');
      }
      for (const listed of page.objects) {
        remainingObjects -= 1;
        if (
          listed.namespace !== store.namespace ||
          !safeKeyUnderPrefix(listed.key, prefix) ||
          !listed.etag ||
          !/^[a-f0-9]{64}$/.test(listed.checksum_sha256) ||
          !isRetained(listed.last_modified, retentionBefore)
        ) {
          continue;
        }
        if (!(await this.renewMaintenanceLease())) return;
        let head: Awaited<ReturnType<StudioObjectStore['headObject']>>;
        try {
          head = await store.headObject({ key: listed.key });
        } catch (error) {
          if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') {
            if (!(await this.renewMaintenanceLease())) return;
            continue;
          }
          throw error;
        }
        if (!(await this.renewMaintenanceLease())) return;
        if (
          head.namespace !== store.namespace ||
          head.key !== listed.key ||
          head.etag !== listed.etag ||
          head.checksum_sha256 !== listed.checksum_sha256 ||
          head.last_modified !== listed.last_modified ||
          !hasRequiredEncryption(head, store) ||
          !isRetained(head.last_modified, retentionBefore)
        ) {
          continue;
        }
        if (!(await this.renewMaintenanceLease())) return;
        const stillOrphan = await this.deps.repository.isOrphanStagingCandidate({
          candidate,
          retentionBefore,
        });
        if (!(await this.renewMaintenanceLease())) return;
        if (!stillOrphan) continue;
        if (!(await this.renewMaintenanceLease())) return;
        try {
          await store.deleteObject({ key: listed.key, if_match: listed.etag });
        } catch (error) {
          if (
            error instanceof StudioObjectStoreError &&
            (error.code === 'NOT_FOUND' || error.code === 'PRECONDITION_FAILED')
          ) {
            if (!(await this.renewMaintenanceLease())) return;
            continue;
          }
          throw error;
        }
        if (!(await this.renewMaintenanceLease())) return;
      }
      if (page.next_cursor !== null) {
        if (
          !validOpaqueCursor(page.next_cursor) ||
          active.seenObjectCursors.has(page.next_cursor)
        ) {
          throw new Error('Studio orphan object listing returned an invalid cursor');
        }
        active.seenObjectCursors.add(page.next_cursor);
        active.objectCursor = page.next_cursor;
      } else {
        this.completeOrphanCandidate(candidate);
      }
    }
  }

  private completeOrphanCandidate(candidate: StudioOrphanStagingCandidate): void {
    this.orphanCandidateAfter = {
      terminalAt: new Date(candidate.terminalAt),
      attemptId: candidate.attemptId,
    };
    this.orphanActiveCandidate = undefined;
  }

  private currentTime(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private renewMaintenanceLease(): Promise<boolean> {
    const now = this.currentTime();
    return this.deps.repository.acquireOrRenewLease({
      lockKey: this.deps.lockKey,
      ownerId: this.deps.ownerId,
      expiresAt: new Date(now.getTime() + this.deps.ttlMs),
      now,
    });
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

function validOpaqueCursor(cursor: string): boolean {
  return cursor.length > 0 && cursor.length <= 4_096;
}

function hasRequiredEncryption(
  metadata: Awaited<ReturnType<StudioObjectStore['headObject']>>,
  store: StudioObjectStore,
): boolean {
  const required = store.required_server_side_encryption;
  if (!required || metadata.server_side_encryption !== required) return false;
  if (required === 'aws:kms') {
    return (
      typeof store.required_sse_kms_key_id === 'string' &&
      store.required_sse_kms_key_id.length > 0 &&
      metadata.sse_kms_key_id === store.required_sse_kms_key_id
    );
  }
  return metadata.sse_kms_key_id == null;
}

function boundedInteger(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
  maximumLabel = String(maximum),
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximumLabel}`);
  }
  return value;
}

function advancingCandidates(
  candidates: readonly StudioOrphanStagingCandidate[],
  after: StudioOrphanStagingCursor | undefined,
): StudioOrphanStagingCandidate[] {
  const result: StudioOrphanStagingCandidate[] = [];
  let cursor = after;
  for (const candidate of candidates) {
    if (!cursor || compareCandidateCursor(candidate, cursor) > 0) {
      result.push(candidate);
      cursor = candidate;
    }
  }
  return result;
}

function compareCandidateCursor(
  left: StudioOrphanStagingCursor,
  right: StudioOrphanStagingCursor,
): number {
  const time = left.terminalAt.getTime() - right.terminalAt.getTime();
  return time || left.attemptId.localeCompare(right.attemptId);
}
