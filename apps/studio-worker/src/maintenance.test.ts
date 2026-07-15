import { describe, expect, test } from 'bun:test';
import {
  StudioMaintenanceCoordinator,
  createMemoryStudioMaintenanceRepository,
} from './maintenance';

describe('Studio maintenance lease', () => {
  test('uses its own parameterized lease and never mutates the API background-worker owner', async () => {
    const repository = createMemoryStudioMaintenanceRepository();
    repository.seedLease('background-workers', 'api-owner', new Date('2026-07-15T10:05:00.000Z'));
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    const result = await coordinator.runOnce();

    expect(result).toEqual({ acquired: true, tasksRun: 5 });
    expect(repository.getLease('studio-maintenance')?.ownerId).toBe('studio-owner');
    expect(repository.getLease('background-workers')?.ownerId).toBe('api-owner');
    expect(repository.calls).toEqual([
      'requeueExpiredJobLeases',
      'failStuckUnknownOutcomes',
      'compactProgressEvents',
      'expireUploads',
      'reconcileCreditReservations',
    ]);
  });

  test('a live peer lease skips maintenance work', async () => {
    const repository = createMemoryStudioMaintenanceRepository();
    repository.seedLease('studio-maintenance', 'peer', new Date('2026-07-15T10:05:00.000Z'));
    const coordinator = new StudioMaintenanceCoordinator({
      repository,
      ownerId: 'studio-owner',
      lockKey: 'studio-maintenance',
      ttlMs: 60_000,
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(await coordinator.runOnce()).toEqual({ acquired: false, tasksRun: 0 });
    expect(repository.calls).toEqual([]);
  });
});
