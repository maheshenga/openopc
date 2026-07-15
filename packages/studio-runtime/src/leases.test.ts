import { describe, expect, test } from 'bun:test';
import { studioMaintenanceLeaseName } from './leases';

describe('Studio leases', () => {
  test('uses a parameterized maintenance lease name isolated from API background workers', () => {
    expect(studioMaintenanceLeaseName()).toBe('studio-maintenance');
    expect(studioMaintenanceLeaseName('media-cleanup')).toBe('studio-maintenance:media-cleanup');
    expect(studioMaintenanceLeaseName()).not.toBe('background-workers');
  });
});
