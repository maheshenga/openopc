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
}

export class StudioMaintenanceCoordinator {
  constructor(
    private readonly deps: {
      repository: StudioMaintenanceRepository;
      ownerId: string;
      lockKey: string;
      ttlMs: number;
      now?: () => Date;
    },
  ) {
    if (!deps.lockKey.startsWith('studio-maintenance')) {
      throw new Error('Studio maintenance must use an isolated studio-maintenance lease key');
    }
    if (deps.ttlMs <= 0) throw new Error('Studio maintenance lease TTL must be positive');
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
    return { acquired: true, tasksRun: 5 };
  }

  release(): Promise<void> {
    return this.deps.repository.releaseLease({
      lockKey: this.deps.lockKey,
      ownerId: this.deps.ownerId,
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
  };
}
