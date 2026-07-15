import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260715160000000_studio_phase1.sql',
);

describe('Studio phase 1 migration', () => {
  test('creates the durable Studio tables and indexes needed by the worker and billing hold path', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    for (const table of [
      'studio_provider_configs',
      'studio_jobs',
      'studio_job_attempts',
      'studio_job_events',
      'studio_assets',
      'studio_job_assets',
      'studio_asset_uploads',
      'studio_credit_reservations',
      'studio_usage_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS kortix.${table}`);
    }

    for (const name of [
      'studio_job_status',
      'studio_attempt_status',
      'idx_studio_jobs_claimable',
      'idx_studio_jobs_idempotency',
      'idx_studio_job_attempts_submission_key',
      'idx_studio_job_events_job_cursor',
      'idx_studio_asset_uploads_expiry',
      'idx_studio_credit_reservations_active_account',
    ]) {
      expect(sql).toContain(name);
    }
  });
});
