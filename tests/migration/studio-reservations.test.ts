import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260715160000000_studio_phase1.sql',
);
const reservationMigrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260715170000000_studio_credit_reservations.sql',
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

  test('adds reservation-aware billing RPCs without changing the existing debit signature', () => {
    const sql = readFileSync(reservationMigrationPath, 'utf8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.atomic_use_credits(');
    expect(sql).toContain('p_account_id uuid');
    expect(sql).toContain('p_amount numeric');
    expect(sql).toContain('p_description text');
    expect(sql).toContain('p_ledger_type text');
    expect(sql).toContain('v_reserved');
    expect(sql).toContain('kortix.studio_credit_reservations');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('v_available := GREATEST(0, v_total - v_reserved)');
    expect(sql).toContain('IF v_available < p_amount THEN');
    expect(sql).toContain("'available', v_available");

    for (const rpcName of [
      'public.atomic_create_studio_job',
      'public.atomic_settle_studio_job',
      'public.atomic_release_studio_job',
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${rpcName}(`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${rpcName}`);
    }
  });
});
