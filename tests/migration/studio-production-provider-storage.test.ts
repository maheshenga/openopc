import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  '../../packages/db/migrations/20260716120000000_studio_production_provider_storage.sql',
);
const schemaPath = join(import.meta.dir, '../../packages/db/src/schema/kortix.ts');
const historicalMigrationPaths = [
  '20260715160000000_studio_phase1.sql',
  '20260715170000000_studio_credit_reservations.sql',
  '20260715180000000_studio_worker_hardening.sql',
].map((name) => join(import.meta.dir, '../../packages/db/migrations', name));

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function compact(source: string): string {
  return source.replace(/\s+/g, ' ').trim().toLowerCase();
}

function expectAll(source: string, fragments: string[]): void {
  for (const fragment of fragments) {
    expect(source).toContain(compact(fragment));
  }
}

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(compact(startMarker));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(compact(endMarker), start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Studio production provider storage migration', () => {
  const rawMigration = readIfPresent(migrationPath);
  const migration = compact(rawMigration);
  const schema = compact(readFileSync(schemaPath, 'utf8'));

  test('uses a new forward migration and leaves the historical Studio migrations untouched', () => {
    expect(existsSync(migrationPath)).toBe(true);

    const forbiddenTables = [
      'studio_pricing_catalog',
      'studio_job_recoveries',
      'studio_billing_incidents',
    ];
    const forbiddenHistoricalColumns = [
      'provider_config_version',
      'pricing_catalog_id',
      'pricing_version',
      'pricing_snapshot',
      'submission_kind',
      'staging_manifest_key',
      'staging_manifest_checksum',
      'cost_outcome',
      'cost_recorded_at',
      'platform_loss_credits',
    ];

    for (const historicalPath of historicalMigrationPaths) {
      const historical = compact(readFileSync(historicalPath, 'utf8'));
      for (const table of forbiddenTables) expect(historical).not.toContain(table);
      for (const column of forbiddenHistoricalColumns) expect(historical).not.toContain(column);
    }
  });

  test('declares the pricing catalog before jobs with exact types, constraints, and lookup index', () => {
    expect(
      schema.indexOf(
        "export const studiopricingcatalog = kortixschema.table( 'studio_pricing_catalog'",
      ),
    ).toBeGreaterThan(-1);
    expect(
      schema.indexOf(
        "export const studiopricingcatalog = kortixschema.table( 'studio_pricing_catalog'",
      ),
    ).toBeLessThan(schema.indexOf("export const studiojobs = kortixschema.table( 'studio_jobs'"));
    expectAll(schema, [
      "pricingcatalogid: uuid('pricing_catalog_id').defaultrandom().primarykey()",
      "accountid: uuid('account_id').notnull().references(() => accounts.accountid, { ondelete: 'cascade'",
      "provider: text('provider').notnull()",
      "model: text('model').notnull()",
      "unit: text('unit').notnull()",
      "ratedata: jsonb('rate_data').notnull()",
      "maximumcostrule: jsonb('maximum_cost_rule').notnull()",
      "markuprule: jsonb('markup_rule').notnull()",
      "version: integer('version').notnull()",
      "active: boolean('active').default(true).notnull()",
      "createdbyuserid: uuid('created_by_user_id')",
      "createdat: timestamp('created_at', { withtimezone: true, mode: 'string' }).defaultnow().notnull()",
      "check('studio_pricing_catalog_unit_check', sql`${table.unit} = 'image'`)",
      "check('studio_pricing_catalog_version_check', sql`${table.version} > 0`)",
      "unique('studio_pricing_catalog_scope_version_key').on( table.accountid, table.provider, table.model, table.version",
      "pricingcatalogid: uuid('pricing_catalog_id').references( () => studiopricingcatalog.pricingcatalogid, { ondelete: 'no action'",
      "index('idx_studio_jobs_pricing_catalog').on(table.pricingcatalogid)",
    ]);

    expectAll(migration, [
      'create table if not exists kortix.studio_pricing_catalog',
      'pricing_catalog_id uuid primary key default gen_random_uuid()',
      'account_id uuid not null',
      'provider text not null',
      'model text not null',
      'unit text not null',
      'rate_data jsonb not null',
      'maximum_cost_rule jsonb not null',
      'markup_rule jsonb not null',
      'version integer not null',
      'active boolean not null default true',
      'created_by_user_id uuid null',
      'created_at timestamptz not null default now()',
      "check (unit = 'image')",
      'check (version > 0)',
      'unique (account_id, provider, model, version)',
      'foreign key (account_id) references kortix.accounts(account_id) on delete cascade',
      'foreign key (pricing_catalog_id) references kortix.studio_pricing_catalog(pricing_catalog_id) on delete no action deferrable initially deferred',
      'create index if not exists idx_studio_jobs_pricing_catalog on kortix.studio_jobs (pricing_catalog_id)',
    ]);
  });

  test('adds expand-first job and attempt columns with guarded shape constraints', () => {
    expectAll(schema, [
      "providerconfigversion: text('provider_config_version')",
      "pricingversion: integer('pricing_version')",
      "pricingsnapshot: jsonb('pricing_snapshot')",
      "check('studio_jobs_pricing_snapshot_shape_check'",
      "check('studio_jobs_pricing_version_check'",
      "submissionkind: text('submission_kind')",
      "stagingmanifestkey: text('staging_manifest_key')",
      "stagingmanifestchecksum: text('staging_manifest_checksum')",
      "costoutcome: text('cost_outcome')",
      "costrecordedat: timestamp('cost_recorded_at', { withtimezone: true, mode: 'string' })",
      "check('studio_job_attempts_submission_kind_check'",
      "check('studio_job_attempts_staging_manifest_check'",
      "check('studio_job_attempts_cost_outcome_check'",
      "check('studio_job_attempts_cost_recorded_check'",
      "check('studio_job_attempts_upstream_cost_check'",
    ]);

    expectAll(migration, [
      'add column if not exists provider_config_version text',
      'add column if not exists pricing_catalog_id uuid',
      'add column if not exists pricing_version integer',
      'add column if not exists pricing_snapshot jsonb',
      'provider_config_version is null and pricing_catalog_id is null and pricing_version is null and pricing_snapshot is null',
      'provider_config_version is not null and pricing_catalog_id is not null and pricing_version is not null and pricing_snapshot is not null',
      'pricing_version is null or pricing_version > 0',
      'add column if not exists submission_kind text',
      'add column if not exists staging_manifest_key text',
      'add column if not exists staging_manifest_checksum text',
      'add column if not exists cost_outcome text',
      'add column if not exists cost_recorded_at timestamptz',
      "submission_kind is null or submission_kind in ('async', 'completed')",
      'staging_manifest_key is null and staging_manifest_checksum is null',
      'staging_manifest_key is not null and staging_manifest_checksum is not null',
      "cost_outcome is null or cost_outcome in ('succeeded', 'failed', 'cancelled', 'unknown')",
      'cost_outcome is null and cost_recorded_at is null',
      'cost_outcome is not null and cost_recorded_at is not null',
      'upstream_cost_credits is null or upstream_cost_credits >= 0',
    ]);
  });

  test('declares immutable recovery audits and billing incidents after attempts', () => {
    const attemptsOffset = schema.indexOf(
      "export const studiojobattempts = kortixschema.table( 'studio_job_attempts'",
    );
    const recoveriesOffset = schema.indexOf(
      "export const studiojobrecoveries = kortixschema.table( 'studio_job_recoveries'",
    );
    const incidentsOffset = schema.indexOf(
      "export const studiobillingincidents = kortixschema.table( 'studio_billing_incidents'",
    );
    expect(recoveriesOffset).toBeGreaterThan(attemptsOffset);
    expect(incidentsOffset).toBeGreaterThan(attemptsOffset);

    expectAll(schema, [
      "recoveryid: uuid('recovery_id').defaultrandom().primarykey()",
      "accountid: uuid('account_id').notnull().references(() => accounts.accountid, { ondelete: 'cascade'",
      "projectid: uuid('project_id').notnull().references(() => projects.projectid, { ondelete: 'cascade'",
      "jobid: uuid('job_id').notnull().references(() => studiojobs.jobid, { ondelete: 'cascade'",
      "attemptid: uuid('attempt_id').notnull().references(() => studiojobattempts.attemptid, { ondelete: 'cascade'",
      "idempotencykey: text('idempotency_key').notnull()",
      "requesthash: text('request_hash').notnull()",
      "decision: text('decision').notnull()",
      "reason: text('reason').notnull()",
      "actoruserid: uuid('actor_user_id').notnull()",
      "actortype: text('actor_type').notnull()",
      "actingtokenid: uuid('acting_token_id')",
      "evidence: jsonb('evidence').notnull()",
      "priorjobstatus: text('prior_job_status').notnull()",
      "priorattemptstatus: text('prior_attempt_status').notnull()",
      "resultingjobstatus: text('resulting_job_status').notnull()",
      "resultingattemptstatus: text('resulting_attempt_status').notnull()",
      "result: jsonb('result').notnull()",
      "createdat: timestamp('created_at', { withtimezone: true, mode: 'string' }).defaultnow().notnull()",
      "index('idx_studio_job_recoveries_account').on(table.accountid)",
      "index('idx_studio_job_recoveries_project').on(table.projectid)",
      "index('idx_studio_job_recoveries_attempt').on(table.attemptid)",
      "check( 'studio_job_recoveries_decision_check'",
      "unique('studio_job_recoveries_job_idempotency_key').on( table.jobid, table.idempotencykey",
      "incidentid: uuid('incident_id').defaultrandom().primarykey()",
      "kind: text('kind').notnull()",
      "status: text('status').default('open').notnull()",
      "verifiedcostcredits: numeric('verified_cost_credits', { precision: 12, scale: 4 }).notnull()",
      "potentialliabilitycredits: numeric('potential_liability_credits', { precision: 12, scale: 4 }).notnull()",
      "metadata: jsonb('metadata').default({}).notnull()",
      "openedat: timestamp('opened_at', { withtimezone: true, mode: 'string' }).defaultnow().notnull()",
      "resolvedat: timestamp('resolved_at', { withtimezone: true, mode: 'string' })",
      "resolvedbyuserid: uuid('resolved_by_user_id')",
      "resolution: jsonb('resolution')",
      "index('idx_studio_billing_incidents_account').on(table.accountid)",
      "index('idx_studio_billing_incidents_project').on(table.projectid)",
      "index('idx_studio_billing_incidents_attempt').on(table.attemptid)",
      "check( 'studio_billing_incidents_kind_check'",
      "check( 'studio_billing_incidents_status_check'",
      "check( 'studio_billing_incidents_verified_cost_check'",
      "check( 'studio_billing_incidents_potential_liability_check'",
      "check( 'studio_billing_incidents_resolution_audit_check'",
      "check( 'studio_billing_incidents_resolved_at_check'",
      "unique('studio_billing_incidents_job_attempt_kind_key').on( table.jobid, table.attemptid, table.kind",
    ]);

    expectAll(migration, [
      'create table if not exists kortix.studio_job_recoveries',
      "decision in ('confirm_succeeded', 'confirm_not_created', 'keep_unknown')",
      'unique (job_id, idempotency_key)',
      'create table if not exists kortix.studio_billing_incidents',
      "kind = 'unknown_outcome_hold_expired'",
      "status in ('open', 'resolved')",
      'verified_cost_credits numeric(12,4) not null',
      'potential_liability_credits numeric(12,4) not null',
      "metadata jsonb not null default '{}'::jsonb",
      'opened_at timestamptz not null default now()',
      'resolved_at timestamptz null',
      'resolved_by_user_id uuid null',
      'add column if not exists resolution jsonb',
      'verified_cost_credits >= 0',
      'potential_liability_credits >= 0',
      "status = 'open' and resolved_at is null and resolved_by_user_id is null and resolution is null",
      "status = 'resolved' and resolved_at is not null and resolved_by_user_id is not null and resolution is not null",
      'resolved_at is null or resolved_at >= opened_at',
      'unique (job_id, attempt_id, kind)',
    ]);

    const recoveryCreate = section(
      migration,
      'create table if not exists kortix.studio_job_recoveries',
      'create table if not exists kortix.studio_billing_incidents',
    );
    const incidentCreate = section(
      migration,
      'create table if not exists kortix.studio_billing_incidents',
      'create index if not exists idx_studio_job_recoveries_account',
    );
    expect(incidentCreate).not.toContain('resolution jsonb null');
    expect(migration).toContain(
      compact(
        'alter table kortix.studio_billing_incidents add column if not exists resolution jsonb',
      ),
    );
    for (const [table, tableSection] of [
      ['studio_job_recoveries', recoveryCreate],
      ['studio_billing_incidents', incidentCreate],
    ] as const) {
      for (const parent of ['accounts', 'projects', 'studio_jobs', 'studio_job_attempts']) {
        expect(tableSection).toContain(compact(`references kortix.${parent}(`));
      }
      expect(tableSection).toContain(compact('on delete cascade'));
      const indexStart = migration.indexOf(
        compact(`create index if not exists idx_${table}_account`),
      );
      const indexEndMarker =
        table === 'studio_job_recoveries'
          ? 'create index if not exists idx_studio_billing_incidents_account'
          : 'alter table kortix.studio_billing_incidents';
      const indexEnd = migration.indexOf(compact(indexEndMarker), indexStart + 1);
      expect(indexStart).toBeGreaterThanOrEqual(0);
      expect(indexEnd).toBeGreaterThan(indexStart);
      const indexes = migration.slice(indexStart, indexEnd);
      expect(indexes).toContain(compact(`create index if not exists idx_${table}_account`));
      expect(indexes).toContain(compact(`create index if not exists idx_${table}_project`));
      expect(indexes).toContain(compact(`create index if not exists idx_${table}_attempt`));
    }
  });

  test('enforces one attempt observation and non-double-counting final usage rows', () => {
    expectAll(schema, [
      "attemptid: uuid('attempt_id').references(() => studiojobattempts.attemptid, { ondelete: 'cascade'",
      "outcome: text('outcome')",
      "platformlosscredits: numeric('platform_loss_credits', { precision: 12, scale: 4 }).default('0').notnull()",
      "uniqueindex('idx_studio_usage_events_attempt').on(table.attemptid).where(sql`${table.attemptid} is not null`)",
      "check('studio_usage_events_outcome_shape_check'",
    ]);
    expectAll(migration, [
      'add column if not exists attempt_id uuid',
      'add column if not exists outcome text',
      'add column if not exists platform_loss_credits numeric(12,4) not null default 0',
      'foreign key (attempt_id) references kortix.studio_job_attempts(attempt_id) on delete cascade',
      'create unique index if not exists idx_studio_usage_events_attempt on kortix.studio_usage_events (attempt_id) where attempt_id is not null',
      'outcome is null or',
      "attempt_id is not null and outcome in ('succeeded', 'failed', 'cancelled', 'unknown')",
      'upstream_cost_credits >= 0',
      'final_cost_credits = 0',
      'platform_loss_credits = 0',
      "attempt_id is null and outcome in ('succeeded', 'failed', 'cancelled')",
      'upstream_cost_credits = 0',
      'final_cost_credits >= 0',
      'platform_loss_credits >= 0',
      "metadata ? 'verified_upstream_cost_credits'",
    ]);
  });

  test('guards every additive constraint and trigger and enforces audit immutability', () => {
    const constraintNames = [
      'studio_pricing_catalog_account_fk',
      'studio_pricing_catalog_unit_check',
      'studio_pricing_catalog_version_check',
      'studio_pricing_catalog_scope_version_key',
      'studio_jobs_pricing_catalog_fk',
      'studio_jobs_pricing_snapshot_shape_check',
      'studio_jobs_pricing_version_check',
      'studio_job_attempts_submission_kind_check',
      'studio_job_attempts_staging_manifest_check',
      'studio_job_attempts_cost_outcome_check',
      'studio_job_attempts_cost_recorded_check',
      'studio_job_attempts_upstream_cost_check',
      'studio_job_recoveries_account_fk',
      'studio_job_recoveries_project_fk',
      'studio_job_recoveries_job_fk',
      'studio_job_recoveries_attempt_fk',
      'studio_job_recoveries_decision_check',
      'studio_job_recoveries_job_idempotency_key',
      'studio_billing_incidents_account_fk',
      'studio_billing_incidents_project_fk',
      'studio_billing_incidents_job_fk',
      'studio_billing_incidents_attempt_fk',
      'studio_billing_incidents_kind_check',
      'studio_billing_incidents_status_check',
      'studio_billing_incidents_verified_cost_check',
      'studio_billing_incidents_potential_liability_check',
      'studio_billing_incidents_resolution_audit_check',
      'studio_billing_incidents_resolved_at_check',
      'studio_billing_incidents_job_attempt_kind_key',
      'studio_usage_events_attempt_fk',
      'studio_usage_events_outcome_shape_check',
    ];
    const constraintRelations: Record<string, string> = {
      studio_pricing_catalog_account_fk: 'studio_pricing_catalog',
      studio_pricing_catalog_unit_check: 'studio_pricing_catalog',
      studio_pricing_catalog_version_check: 'studio_pricing_catalog',
      studio_pricing_catalog_scope_version_key: 'studio_pricing_catalog',
      studio_jobs_pricing_catalog_fk: 'studio_jobs',
      studio_jobs_pricing_snapshot_shape_check: 'studio_jobs',
      studio_jobs_pricing_version_check: 'studio_jobs',
      studio_job_attempts_submission_kind_check: 'studio_job_attempts',
      studio_job_attempts_staging_manifest_check: 'studio_job_attempts',
      studio_job_attempts_cost_outcome_check: 'studio_job_attempts',
      studio_job_attempts_cost_recorded_check: 'studio_job_attempts',
      studio_job_attempts_upstream_cost_check: 'studio_job_attempts',
      studio_job_recoveries_account_fk: 'studio_job_recoveries',
      studio_job_recoveries_project_fk: 'studio_job_recoveries',
      studio_job_recoveries_job_fk: 'studio_job_recoveries',
      studio_job_recoveries_attempt_fk: 'studio_job_recoveries',
      studio_job_recoveries_decision_check: 'studio_job_recoveries',
      studio_job_recoveries_job_idempotency_key: 'studio_job_recoveries',
      studio_billing_incidents_account_fk: 'studio_billing_incidents',
      studio_billing_incidents_project_fk: 'studio_billing_incidents',
      studio_billing_incidents_job_fk: 'studio_billing_incidents',
      studio_billing_incidents_attempt_fk: 'studio_billing_incidents',
      studio_billing_incidents_kind_check: 'studio_billing_incidents',
      studio_billing_incidents_status_check: 'studio_billing_incidents',
      studio_billing_incidents_verified_cost_check: 'studio_billing_incidents',
      studio_billing_incidents_potential_liability_check: 'studio_billing_incidents',
      studio_billing_incidents_resolution_audit_check: 'studio_billing_incidents',
      studio_billing_incidents_resolved_at_check: 'studio_billing_incidents',
      studio_billing_incidents_job_attempt_kind_key: 'studio_billing_incidents',
      studio_usage_events_attempt_fk: 'studio_usage_events',
      studio_usage_events_outcome_shape_check: 'studio_usage_events',
    };
    for (const name of constraintNames) {
      const guardNeedle = compact(`from pg_catalog.pg_constraint where conname = '${name}'`);
      expect(migration.split(guardNeedle).length - 1).toBe(1);
      expect(migration).toContain(
        compact(
          `from pg_catalog.pg_constraint where conname = '${name}' and conrelid = 'kortix.${constraintRelations[name]}'::regclass`,
        ),
      );
      expect(migration).toContain(compact(`add constraint ${name}`));
    }

    expectAll(migration, [
      'create or replace function kortix.enforce_studio_pricing_catalog_immutability()',
      'new.active is false and old.active is true',
      'is not distinct from',
      'pg_catalog.pg_trigger_depth() > 1',
      'create trigger trg_studio_pricing_catalog_immutable',
      'create or replace function kortix.enforce_studio_job_recovery_immutability()',
      "tg_op = 'delete' and pg_catalog.pg_trigger_depth() > 1",
      'create trigger trg_studio_job_recoveries_immutable',
      "from pg_catalog.pg_trigger where tgname = 'trg_studio_pricing_catalog_immutable'",
      "from pg_catalog.pg_trigger where tgname = 'trg_studio_job_recoveries_immutable'",
      'not exists (select 1 from kortix.accounts where account_id = old.account_id)',
      'not exists (select 1 from kortix.projects where project_id = old.project_id)',
      'not exists (select 1 from kortix.studio_jobs where job_id = old.job_id)',
      'not exists (select 1 from kortix.studio_job_attempts where attempt_id = old.attempt_id)',
    ]);
    // A live PostgreSQL test should also invoke a nested delete with every parent present and
    // assert that the immutable trigger still rejects it; this sandbox has no PostgreSQL runtime.
  });

  test('applies least-privilege table grants and removes direct client writes', () => {
    expectAll(migration, [
      'revoke all on table kortix.studio_pricing_catalog from public, anon, authenticated',
      'grant select, insert, update on table kortix.studio_pricing_catalog to service_role',
      'revoke all on table kortix.studio_job_recoveries from public, anon, authenticated',
      'grant select, insert on table kortix.studio_job_recoveries to service_role',
      'revoke all on table kortix.studio_billing_incidents from public, anon, authenticated',
      'grant select, insert, update on table kortix.studio_billing_incidents to service_role',
      'revoke insert, update, delete, truncate, references, trigger on table kortix.studio_jobs, kortix.studio_job_attempts, kortix.studio_credit_reservations, kortix.studio_usage_events from public, anon, authenticated',
    ]);
  });

  test('installs both atomic job-create overloads with exact service-role privileges', () => {
    expectAll(migration, [
      'create or replace function public.atomic_create_studio_job(',
      'p_provider_config_version text',
      'p_pricing_catalog_id uuid',
      'p_pricing_version integer',
      'p_pricing_snapshot jsonb',
      "'provider_config_id', config.provider_config_id",
      "'capability_map', config.capability_map",
      "models.model ->> 'pricing_catalog_id' = p_pricing_catalog_id::text",
      "'code', 'provider_config_stale'",
      "'code', 'pricing_stale'",
      'p_reserved_credits::numeric(12,4)',
    ]);
    expect(migration).toContain(
      compact(
        'revoke all on function public.atomic_create_studio_job(uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid, text, text, text, uuid, integer, jsonb, jsonb, text, text, numeric, timestamptz) from public, authenticated',
      ),
    );
    expect(migration).toContain(
      compact(
        'grant execute on function public.atomic_create_studio_job(uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid, text, text, text, uuid, integer, jsonb, jsonb, text, text, numeric, timestamptz) to service_role',
      ),
    );
    expect(migration).not.toContain('drop function public.atomic_create_studio_job');
  });

  test('records one immutable attempt cost and rejects a conflicting second observation', () => {
    expectAll(migration, [
      'create or replace function public.atomic_record_studio_attempt_cost(',
      'p_upstream_usage jsonb',
      'p_upstream_cost_credits numeric',
      'p_outcome text',
      'for update',
      'cost_recorded_at',
      'insert into kortix.studio_usage_events',
      "'code', 'attempt_cost_conflict'",
      'revoke all on function public.atomic_record_studio_attempt_cost(uuid, uuid, text, jsonb, numeric, text, timestamptz) from public, authenticated',
      'grant execute on function public.atomic_record_studio_attempt_cost(uuid, uuid, text, jsonb, numeric, text, timestamptz) to service_role',
    ]);
  });

  test('keeps legacy finalization and adds cost-aware production finalization without double counting', () => {
    expectAll(migration, [
      'create or replace function public.atomic_finalize_studio_job_success(',
      'create or replace function public.atomic_finalize_studio_job_terminal(',
      'if v_job.pricing_snapshot is null then',
      "metadata ->> 'kind' = 'final'",
      'sum(attempt.upstream_cost_credits)',
      'verified_upstream_cost_credits',
      'platform_loss_credits',
      'upstream_cost_credits, final_cost_credits',
      "'code', 'actual_credits_mismatch'",
    ]);
    expect(migration).toContain(
      compact(
        'revoke all on function public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) from public, authenticated',
      ),
    );
    expect(migration).toContain(
      compact(
        'revoke all on function public.atomic_finalize_studio_job_terminal(uuid, uuid, text, text, text, text, text, text, timestamptz) from public, authenticated',
      ),
    );
  });
});
