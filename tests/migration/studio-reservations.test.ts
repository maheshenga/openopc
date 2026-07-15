import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260715160000000_studio_phase1.sql',
);
const reservationMigrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260715170000000_studio_credit_reservations.sql',
);
const workerHardeningMigrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260715180000000_studio_worker_hardening.sql',
);

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

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

  test('ships post-Task-7 schema and RPC changes in a forward migration', () => {
    const phase1Sql = readFileSync(migrationPath, 'utf8');
    const reservationSql = readFileSync(reservationMigrationPath, 'utf8');
    const hardeningSql = readIfPresent(workerHardeningMigrationPath);

    expect(existsSync(workerHardeningMigrationPath)).toBe(true);
    expect(phase1Sql).not.toContain('idx_studio_credit_reservations_expiry');
    expect(reservationSql).not.toContain('ALTER COLUMN daily_credits_balance TYPE numeric(12,4)');
    expect(reservationSql).toContain("'billing.reservation_released'");
    expect(hardeningSql).toContain('idx_studio_credit_reservations_expiry');
    expect(hardeningSql).toContain('ALTER COLUMN daily_credits_balance TYPE numeric(12,4)');
    expect(hardeningSql).not.toContain("'billing.reservation_released'");
  });

  test('adds reservation-aware billing RPCs without changing the existing debit signature', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);

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
    expect(sql).toContain("'queued'");
    expect(sql).not.toContain("'billing.reservation_released'");

    for (const rpcName of [
      'public.atomic_create_studio_job',
      'public.atomic_settle_studio_job',
      'public.atomic_release_studio_job',
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${rpcName}(`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${rpcName}`);
    }
  });

  test('serializes Studio idempotency checks behind the account wallet lock', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const createStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_create_studio_job(');
    const createEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_settle_studio_job(');
    const body = sql.slice(createStart, createEnd);
    const walletLock = body.indexOf('FROM kortix.credit_accounts');
    const idempotencyRead = body.indexOf('FROM kortix.studio_jobs');

    expect(walletLock).toBeGreaterThan(-1);
    expect(idempotencyRead).toBeGreaterThan(-1);
    expect(walletLock).toBeLessThan(idempotencyRead);
  });

  test('rejects account-wide idempotency key reuse across project boundaries', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const createStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_create_studio_job(');
    const createEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_settle_studio_job(');
    const body = sql.slice(createStart, createEnd);

    expect(body).toContain('SELECT job_id, project_id, request_hash, status');
    expect(body).toContain('v_existing.project_id <> p_project_id');
    expect(body).toContain("'code', 'idempotency_mismatch'");
  });

  test('preserves four-decimal Studio credit precision during wallet debit', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const debitStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_use_credits(');
    const debitEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_create_studio_job(');
    const body = sql.slice(debitStart, debitEnd);

    expect(body).toContain('v_total NUMERIC(12,4)');
    expect(body).toContain('v_fd NUMERIC(12,4)');
    expect(body).toContain('v_rem NUMERIC(12,4)');
    expect(sql).toContain('ALTER COLUMN daily_credits_balance TYPE numeric(12,4)');
  });

  test('returns a stable machine code for insufficient Studio reservation credits', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const createStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_create_studio_job(');
    const createEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_settle_studio_job(');
    const body = sql.slice(createStart, createEnd);

    expect(body).toContain("'code', 'insufficient_credits'");
  });

  test('keeps privileged Studio wallet RPCs service-role only', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const grants = sql
      .split(/\r?\n/)
      .filter((line) =>
        /GRANT EXECUTE ON FUNCTION public\.atomic_(create|settle|release)_studio_job/.test(line),
      );

    expect(grants).toHaveLength(3);
    for (const grant of grants) {
      expect(grant.trim()).toEndWith('TO service_role;');
    }

    const revokes = sql
      .split(/\r?\n/)
      .filter((line) =>
        /REVOKE ALL ON FUNCTION public\.atomic_(create|settle|release)_studio_job/.test(line),
      );
    expect(revokes).toHaveLength(3);
    for (const revoke of revokes) {
      expect(revoke.trim()).toEndWith('FROM PUBLIC, authenticated;');
    }
  });

  test('atomically chooses cancellation or success before exposing assets and charging credits', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const finalizeStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.atomic_finalize_studio_job_success(',
    );
    const finalizeEnd = sql.indexOf('REVOKE ALL ON FUNCTION', finalizeStart);
    const body = sql.slice(finalizeStart, finalizeEnd);

    expect(finalizeStart).toBeGreaterThan(-1);
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain('cancellation_requested_at');
    expect(body).toContain('public.atomic_settle_studio_job');
    expect(body).toContain('public.atomic_release_studio_job');
    expect(body).toContain('INSERT INTO kortix.studio_assets');
    expect(body).toContain('INSERT INTO kortix.studio_job_assets');
    expect(body).toContain('INSERT INTO kortix.studio_usage_events');
    expect(body).toContain('INSERT INTO kortix.studio_job_events');
    expect(body).toContain('UPDATE kortix.studio_job_attempts');
    expect(body).toContain('UPDATE kortix.studio_jobs');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) FROM PUBLIC, authenticated;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) TO service_role;',
    );
  });

  test('uses a consistent job then reservation lock order for Studio settlement', () => {
    const sql = readIfPresent(workerHardeningMigrationPath);
    const settleStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_settle_studio_job(');
    const settleEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_release_studio_job(');
    const body = sql.slice(settleStart, settleEnd);

    const jobLock = body.indexOf('FROM kortix.studio_jobs');
    const reservationLock = body.indexOf('FROM kortix.studio_credit_reservations');
    expect(jobLock).toBeGreaterThan(-1);
    expect(reservationLock).toBeGreaterThan(-1);
    expect(jobLock).toBeLessThan(reservationLock);
  });
});
