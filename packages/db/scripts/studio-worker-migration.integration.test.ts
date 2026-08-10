import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { createStudioProjectRoutes } from '../../../apps/api/src/studio';
import { createStudioCredentialBindingExists } from '../../../apps/api/src/studio/credential-existence';
import { StudioRecoveryService } from '../../../apps/api/src/studio/recovery';
import {
  createDrizzleStudioRecoveryRepository,
  createDrizzleStudioRepository,
} from '../../../apps/api/src/studio/repositories/drizzle';
import { StudioStorageService } from '../../../apps/api/src/studio/storage';
import { StudioMaintenanceCoordinator } from '../../../apps/studio-worker/src/maintenance';
import {
  PostgresStudioMaintenanceRepository,
  type StudioSqlClient,
} from '../../../apps/studio-worker/src/postgres';
import { StudioResultStager } from '../../../apps/studio-worker/src/result-stager';
import { InMemoryStudioObjectStore } from '../../studio-runtime/src';
import { createDb } from '../src/client';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-studio-worker-migration-${crypto.randomUUID().slice(0, 8)}`;
const migrationsDirectory = resolve(import.meta.dir, '..', 'migrations');
const recoveryHardeningMigration = '20260717020000000_studio_recovery_hardening.sql';
const pollingUnknownHoldMigration = '20260718010000000_studio_polling_unknown_hold.sql';
const studioModuleServiceGrantsMigration = '20260806120000000_studio_module_service_grants.sql';
let mappedPostgresPort = '';
const silentMigrationLogger = {
  debug: (_message: string) => undefined,
  info: (_message: string) => undefined,
  warn: (_message: string) => undefined,
  error: (_message: string) => undefined,
};

const SUCCESS_ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const CANCEL_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const CAP_ACCOUNT_ID = '10000000-0000-4000-a000-000000000004';
const SUCCESS_PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const CANCEL_PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const CAP_PROJECT_ID = '20000000-0000-4000-a000-000000000004';
const SUCCESS_PROVIDER_ID = '30000000-0000-4000-a000-000000000001';
const CANCEL_PROVIDER_ID = '30000000-0000-4000-a000-000000000002';
const CAP_PROVIDER_ID = '30000000-0000-4000-a000-000000000004';
const SUCCESS_JOB_ID = '40000000-0000-4000-a000-000000000001';
const CANCEL_JOB_ID = '40000000-0000-4000-a000-000000000002';
const CAP_JOB_ID = '40000000-0000-4000-a000-000000000004';
const SUCCESS_ATTEMPT_ID = '50000000-0000-4000-a000-000000000001';
const CANCEL_ATTEMPT_ID = '50000000-0000-4000-a000-000000000002';
const CAP_ATTEMPT_ID = '50000000-0000-4000-a000-000000000004';
const FAILED_JOB_ID = '40000000-0000-4000-a000-000000000003';
const FAILED_ATTEMPT_ID = '50000000-0000-4000-a000-000000000003';
const PRODUCTION_PROVIDER = 'openai-compatible';
const PRODUCTION_MODEL = 'openai-compatible/image-v1';

interface ProductionScope {
  accountId: string;
  projectId: string;
  providerId: string;
  pricingId: string;
  providerVersion: string;
  maxProviderCredits: number;
  markupCredits: number;
  snapshot: Record<string, unknown>;
}

function dockerPsql(sql: string, allowFailure = false, database = 'testdb') {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

function dockerPsqlJson(sql: string, database = 'testdb'): Record<string, unknown> {
  const output = dockerPsql(sql, false, database).output;
  const jsonLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith('{') && line.endsWith('}'));
  if (!jsonLine) throw new Error(`PostgreSQL did not return a JSON object:\n${output}`);
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

async function applyMigration(name: string, database = 'testdb'): Promise<void> {
  const migration = await Bun.file(resolve(import.meta.dir, '..', 'migrations', name)).text();
  dockerPsql(`BEGIN;\n${migration}\nCOMMIT;`, false, database);
}

function postgresUrl(database: string): string {
  if (!mappedPostgresPort) throw new Error('PostgreSQL host port is not mapped');
  return `postgres://postgres:test@127.0.0.1:${mappedPostgresPort}/${database}`;
}

async function applyOnlyRecordedForwardMigration(database: string): Promise<string[]> {
  const migrationNames = readdirSync(migrationsDirectory).filter((name) =>
    /^\d{17}.*\.sql$/.test(name),
  );
  const historicalMigrationCount = migrationNames.filter(
    (name) => name < recoveryHardeningMigration,
  ).length;
  const laterMigrationPattern = migrationNames
    .filter((name) => name > recoveryHardeningMigration)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const base = {
    databaseUrl: postgresUrl(database),
    dir: migrationsDirectory,
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'kortix_migrations',
    createMigrationsSchema: true,
    checkOrder: true,
    singleTransaction: true,
    verbose: false,
    logger: silentMigrationLogger,
    ...(laterMigrationPattern ? { ignorePattern: `(?:${laterMigrationPattern})$` } : {}),
  } as const;

  await runner({
    ...base,
    direction: 'up',
    count: historicalMigrationCount,
    fake: true,
  });
  const applied = await runner({
    ...base,
    direction: 'up',
    count: Number.POSITIVE_INFINITY,
  });
  return applied.map((migration) => migration.name);
}

const PRE_STUDIO_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;

  CREATE SCHEMA kortix;
  GRANT USAGE ON SCHEMA kortix TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT ALL ON TABLES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT ON TABLES TO anon;

  CREATE TABLE kortix.accounts (
    account_id uuid PRIMARY KEY
  );

  CREATE TABLE kortix.projects (
    project_id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id)
  );

  CREATE TABLE kortix.project_secrets (
    secret_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES kortix.projects(project_id),
    identifier text NOT NULL,
    owner_user_id uuid,
    active boolean NOT NULL DEFAULT true,
    value_enc text NOT NULL
  );

  CREATE TABLE kortix.executor_connectors (
    connector_id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
    project_id uuid NOT NULL REFERENCES kortix.projects(project_id),
    slug text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'active'
  );

  CREATE TABLE kortix.executor_connection_profiles (
    profile_id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id),
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active'
  );

  CREATE TABLE kortix.executor_credentials (
    credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id),
    profile_id uuid NOT NULL,
    value_enc text NOT NULL
  );

  CREATE TABLE kortix.worker_leader_lease (
    lock_key text PRIMARY KEY,
    owner_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE kortix.project_sessions (
    session_id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
    project_id uuid NOT NULL REFERENCES kortix.projects(project_id)
  );

  CREATE TABLE kortix.account_tokens (
    token_id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
    user_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'active',
    revoked_at timestamptz,
    expires_at timestamptz,
    project_id uuid,
    agent_grant jsonb
  );

  CREATE TABLE kortix.credit_accounts (
    account_id uuid PRIMARY KEY REFERENCES kortix.accounts(account_id),
    balance numeric(12,4) NOT NULL DEFAULT 0,
    daily_credits_balance numeric(10,2) NOT NULL DEFAULT 0,
    expiring_credits numeric(12,4) NOT NULL DEFAULT 0,
    non_expiring_credits numeric(12,4) NOT NULL DEFAULT 0,
    updated_at timestamptz DEFAULT now()
  );

  CREATE TABLE kortix.credit_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES kortix.credit_accounts(account_id),
    amount numeric(12,4) NOT NULL,
    balance_after numeric(12,4) NOT NULL,
    type text NOT NULL,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb
  );
`;

const PRE_STUDIO_SCHEMA_WITH_EXISTING_ROLES = PRE_STUDIO_SCHEMA.replace(
  /\s*CREATE ROLE (?:anon|authenticated|service_role) NOLOGIN;/g,
  '',
);

// This suite isolates the Studio migration chain, so represent only the module-service
// tables required by the later Studio grant-link migration. The full migration chain is
// exercised separately by the fresh-database migration gate.
const MODULE_SERVICE_MIGRATION_PREREQUISITES = `
  CREATE TABLE kortix.project_module_service_consents (
    consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service varchar(16) NOT NULL,
    operations jsonb NOT NULL
  );

  CREATE TABLE kortix.module_service_capability_grants (
    grant_id uuid PRIMARY KEY,
    service varchar(16) NOT NULL,
    operations jsonb NOT NULL
  );

  CREATE TABLE kortix.module_service_audit_events (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service varchar(16) NOT NULL,
    operation varchar(32)
  );
`;

const CORE_FIXTURES = `
  INSERT INTO kortix.accounts(account_id) VALUES
    ('${SUCCESS_ACCOUNT_ID}'),
    ('${CANCEL_ACCOUNT_ID}'),
    ('${CAP_ACCOUNT_ID}');

  INSERT INTO kortix.projects(project_id, account_id) VALUES
    ('${SUCCESS_PROJECT_ID}', '${SUCCESS_ACCOUNT_ID}'),
    ('${CANCEL_PROJECT_ID}', '${CANCEL_ACCOUNT_ID}'),
    ('${CAP_PROJECT_ID}', '${CAP_ACCOUNT_ID}');

  INSERT INTO kortix.credit_accounts(
    account_id, balance, daily_credits_balance, expiring_credits, non_expiring_credits
  ) VALUES
    ('${SUCCESS_ACCOUNT_ID}', 20, 10, 5, 5),
    ('${CANCEL_ACCOUNT_ID}', 20, 10, 5, 5),
    ('${CAP_ACCOUNT_ID}', 20, 10, 5, 5);

  INSERT INTO kortix.studio_provider_configs(
    provider_config_id, account_id, project_id, provider, display_name,
    credential_binding, capability_map
  ) VALUES
    (
      '${SUCCESS_PROVIDER_ID}', '${SUCCESS_ACCOUNT_ID}', '${SUCCESS_PROJECT_ID}',
      'fake', 'Success Fake Provider', '{"kind":"none"}'::jsonb,
      '{"image.generate":true}'::jsonb
    ),
    (
      '${CANCEL_PROVIDER_ID}', '${CANCEL_ACCOUNT_ID}', '${CANCEL_PROJECT_ID}',
      'fake', 'Cancellation Fake Provider', '{"kind":"none"}'::jsonb,
      '{"image.generate":true}'::jsonb
    ),
    (
      '${CAP_PROVIDER_ID}', '${CAP_ACCOUNT_ID}', '${CAP_PROJECT_ID}',
      'fake', 'Reservation Cap Fake Provider', '{"kind":"none"}'::jsonb,
      '{"image.generate":true}'::jsonb
    );
`;

function seedRunningJob(input: {
  accountId: string;
  projectId: string;
  providerId: string;
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  cancellationRequested: boolean;
  reservedCredits?: number;
}) {
  const reservedCredits = input.reservedCredits ?? 2;
  dockerPsql(`
    INSERT INTO kortix.studio_jobs(
      job_id, account_id, project_id, actor_user_id, actor_type, capability,
      provider_config_id, provider, model, input, status, idempotency_key,
      request_hash, attempt_count, reserved_credits, lease_owner,
      lease_expires_at, available_at, started_at, cancellation_requested_at
    ) VALUES (
      '${input.jobId}', '${input.accountId}', '${input.projectId}',
      '60000000-0000-4000-a000-000000000001', 'user', 'image.generate',
      '${input.providerId}', 'fake', 'fake-image-v1',
      '{"capability":"image.generate","image":{"prompt":"Studio integration test"}}'::jsonb,
      'running', 'idem:${input.jobId}', 'hash:${input.jobId}', 1, ${reservedCredits},
      '${input.leaseOwner}', '2026-07-16T00:00:00Z', now(), now(),
      ${input.cancellationRequested ? "'2026-07-15T11:59:00Z'::timestamptz" : 'NULL'}
    );

    INSERT INTO kortix.studio_job_attempts(
      attempt_id, job_id, submission_key, provider_request_id,
      adapter_version, status, started_at
    ) VALUES (
      '${input.attemptId}', '${input.jobId}', 'submission:${input.attemptId}',
      'provider:${input.attemptId}', 'fake-v1', 'polling', now()
    );

    INSERT INTO kortix.studio_credit_reservations(
      account_id, job_id, amount_credits, status, expires_at
    ) VALUES ('${input.accountId}', '${input.jobId}', ${reservedCredits}, 'active', '2026-07-16T00:00:00Z');

    INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload)
    VALUES ('${input.jobId}', 1, 'queued', '{}'::jsonb);
  `);
}

function finalizeJob(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  objectKey: string;
  completedAt: string;
  actualCredits?: number;
}) {
  const actualCredits = input.actualCredits ?? 1.25;
  return dockerPsqlJson(`
    SET ROLE service_role;
    SELECT public.atomic_finalize_studio_job_success(
      '${input.jobId}'::uuid,
      '${input.attemptId}'::uuid,
      '${input.leaseOwner}',
      ${actualCredits},
      jsonb_build_array(jsonb_build_object(
        'kind', 'image',
        'mimeType', 'image/png',
        'bucket', 'studio-integration',
        'objectKey', '${input.objectKey}',
        'checksumSha256', 'integration-checksum',
        'sizeBytes', 4,
        'filename', 'result.png'
      )),
      '${input.completedAt}'::timestamptz
    );
  `);
}

function seedProductionScope(input: {
  suffix: string;
  maxProviderCredits?: number;
  markupCredits?: number;
  balance?: number;
  omitRateCredits?: boolean;
}): ProductionScope {
  const accountId = `70000000-0000-4000-a000-0000000000${input.suffix}`;
  const projectId = `71000000-0000-4000-a000-0000000000${input.suffix}`;
  const providerId = `72000000-0000-4000-a000-0000000000${input.suffix}`;
  const pricingId = `73000000-0000-4000-a000-0000000000${input.suffix}`;
  const maxProviderCredits = input.maxProviderCredits ?? 8;
  const markupCredits = input.markupCredits ?? 1;
  const balance = input.balance ?? 100;
  const rateDataSql = input.omitRateCredits
    ? "'{}'::jsonb"
    : "jsonb_build_object('rate_credits', 2)";

  dockerPsql(`
    INSERT INTO kortix.accounts(account_id) VALUES ('${accountId}');
    INSERT INTO kortix.projects(project_id, account_id) VALUES ('${projectId}', '${accountId}');
    INSERT INTO kortix.credit_accounts(
      account_id, balance, daily_credits_balance, expiring_credits, non_expiring_credits
    ) VALUES ('${accountId}', ${balance}, ${balance}, 0, 0);

    INSERT INTO kortix.studio_pricing_catalog(
      pricing_catalog_id, account_id, provider, model, unit, rate_data,
      maximum_cost_rule, markup_rule, version, active
    ) VALUES (
      '${pricingId}', '${accountId}', '${PRODUCTION_PROVIDER}', '${PRODUCTION_MODEL}',
      'image', ${rateDataSql},
      jsonb_build_object('max_provider_credits', ${maxProviderCredits}),
      jsonb_build_object('markup_credits', ${markupCredits}), 1, true
    );

    INSERT INTO kortix.studio_provider_configs(
      provider_config_id, account_id, project_id, provider, display_name,
      base_url, credential_binding, capability_map, enabled
    ) VALUES (
      '${providerId}', '${accountId}', '${projectId}', '${PRODUCTION_PROVIDER}',
      'Production integration provider', 'https://provider.invalid/v1',
      jsonb_build_object('kind', 'secret', 'identifier', 'integration-only'),
      jsonb_build_object(
        'definition_id', 'openai-compatible',
        'capabilities', jsonb_build_object(
          'image.generate', jsonb_build_object(
            'models', jsonb_build_array(jsonb_build_object(
              'model', '${PRODUCTION_MODEL}',
              'pricing_catalog_id', '${pricingId}'
            ))
          )
        )
      ),
      true
    );
  `);

  const versionState = dockerPsqlJson(`
    SELECT jsonb_build_object(
      'provider_version', md5(jsonb_build_object(
        'provider_config_id', config.provider_config_id,
        'account_id', config.account_id,
        'project_id', config.project_id,
        'provider', config.provider,
        'base_url', config.base_url,
        'region', config.region,
        'credential_binding', config.credential_binding,
        'capability_map', config.capability_map,
        'enabled', config.enabled
      )::text)
    )
    FROM kortix.studio_provider_configs config
    WHERE config.provider_config_id = '${providerId}';
  `);

  return {
    accountId,
    projectId,
    providerId,
    pricingId,
    providerVersion: String(versionState.provider_version),
    maxProviderCredits,
    markupCredits,
    snapshot: {
      pricing_catalog_id: pricingId,
      version: 1,
      provider: PRODUCTION_PROVIDER,
      model: PRODUCTION_MODEL,
      unit: 'image',
      rate_credits: 2,
      max_provider_credits: maxProviderCredits,
      markup_credits: markupCredits,
    },
  };
}

function createProductionJob(
  scope: ProductionScope,
  overrides: Partial<{
    accountId: string;
    projectId: string;
    providerId: string;
    providerVersion: string;
    provider: string;
    model: string;
    pricingId: string;
    pricingVersion: number;
    snapshot: Record<string, unknown>;
    outputCount: number;
    reservedCredits: number;
    idempotencyKey: string;
    requestHash: string;
  }> = {},
): Record<string, unknown> {
  const outputCount = overrides.outputCount ?? 1;
  const reservedCredits =
    overrides.reservedCredits ?? scope.maxProviderCredits + scope.markupCredits * outputCount;
  const idempotencyKey = overrides.idempotencyKey ?? `production-create:${scope.accountId}`;
  const requestHash = overrides.requestHash ?? `production-hash:${scope.accountId}`;
  const snapshot = overrides.snapshot ?? scope.snapshot;

  return dockerPsqlJson(`
    SET ROLE service_role;
    SELECT public.atomic_create_studio_job(
      '${overrides.accountId ?? scope.accountId}'::uuid,
      '${overrides.projectId ?? scope.projectId}'::uuid,
      '60000000-0000-4000-a000-000000000001'::uuid,
      'user',
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::uuid,
      'image.generate',
      '${overrides.providerId ?? scope.providerId}'::uuid,
      '${overrides.providerVersion ?? scope.providerVersion}',
      '${overrides.provider ?? PRODUCTION_PROVIDER}',
      '${overrides.model ?? PRODUCTION_MODEL}',
      '${overrides.pricingId ?? scope.pricingId}'::uuid,
      ${overrides.pricingVersion ?? 1},
      '${JSON.stringify(snapshot)}'::jsonb,
      '${JSON.stringify({
        capability: 'image.generate',
        image: { prompt: 'Production integration test', output_count: outputCount },
      })}'::jsonb,
      '${idempotencyKey}',
      '${requestHash}',
      ${reservedCredits},
      clock_timestamp() + interval '1 hour'
    );
  `);
}

function prepareProductionAttempt(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  status?: 'submitted' | 'polling' | 'reconciling';
}): void {
  dockerPsql(`
    UPDATE kortix.studio_jobs
    SET status = 'running',
        attempt_count = attempt_count + 1,
        lease_owner = '${input.leaseOwner}',
        lease_expires_at = clock_timestamp() + interval '1 hour',
        started_at = COALESCE(started_at, clock_timestamp())
    WHERE job_id = '${input.jobId}';

    INSERT INTO kortix.studio_job_attempts(
      attempt_id, job_id, submission_key, provider_request_id,
      adapter_version, status, provider_config_version, started_at
    )
    SELECT
      '${input.attemptId}', job_id, 'submission:${input.attemptId}',
      'provider:${input.attemptId}', 'openai-compatible-v1',
      '${input.status ?? 'polling'}', provider_config_version, clock_timestamp()
    FROM kortix.studio_jobs
    WHERE job_id = '${input.jobId}';
  `);
}

function recordProductionAttemptCost(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  usage: Record<string, unknown>;
  cost: number;
  costSql?: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  recordedAtSql?: string;
}): Record<string, unknown> {
  return dockerPsqlJson(`
    SET ROLE service_role;
    SELECT public.atomic_record_studio_attempt_cost(
      '${input.jobId}'::uuid,
      '${input.attemptId}'::uuid,
      '${input.leaseOwner}',
      '${JSON.stringify(input.usage)}'::jsonb,
      ${input.costSql ?? input.cost},
      '${input.outcome}',
      ${input.recordedAtSql ?? 'clock_timestamp()'}
    );
  `);
}

function prepareRecoveryAttempt(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  manifestKey: string;
  manifestChecksum: string;
  status?: 'polling' | 'reconciling';
}): void {
  prepareProductionAttempt({
    jobId: input.jobId,
    attemptId: input.attemptId,
    leaseOwner: input.leaseOwner,
    status: input.status ?? 'reconciling',
  });
  dockerPsql(`
    UPDATE kortix.studio_job_attempts
    SET submission_kind = 'async',
        staging_manifest_key = '${input.manifestKey}',
        staging_manifest_checksum = '${input.manifestChecksum}',
        retry_classification = ${input.status === 'polling' ? "'unknown_outcome'" : 'retry_classification'}
    WHERE attempt_id = '${input.attemptId}';
  `);
}

function clearStudioLease(jobId: string): void {
  dockerPsql(`
    UPDATE kortix.studio_jobs
    SET lease_owner = NULL, lease_expires_at = NULL
    WHERE job_id = '${jobId}';
  `);
}

function finalizeProductionSuccess(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  actualCredits: number;
  assetCount: number;
  objectPrefix: string;
  duplicateObjectKey?: boolean;
}): Record<string, unknown> {
  const assets = Array.from({ length: input.assetCount }, (_, index) => ({
    kind: 'image',
    mimeType: 'image/png',
    bucket: 'studio-integration',
    objectKey: `${input.objectPrefix}/${input.duplicateObjectKey ? 1 : index + 1}.png`,
    checksumSha256: `integration-checksum-${index + 1}`,
    sizeBytes: 4,
    filename: `result-${index + 1}.png`,
  }));
  return dockerPsqlJson(`
    SET ROLE service_role;
    SELECT public.atomic_finalize_studio_job_success(
      '${input.jobId}'::uuid,
      '${input.attemptId}'::uuid,
      '${input.leaseOwner}',
      ${input.actualCredits},
      '${JSON.stringify(assets)}'::jsonb,
      clock_timestamp()
    );
  `);
}

function finalizeProductionTerminal(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  status: 'failed' | 'cancelled';
  reason: string;
}): Record<string, unknown> {
  return dockerPsqlJson(`
    SET ROLE service_role;
    SELECT public.atomic_finalize_studio_job_terminal(
      '${input.jobId}'::uuid,
      '${input.attemptId}'::uuid,
      '${input.leaseOwner}',
      '${input.status}',
      'STUDIO_PROVIDER_REJECTED',
      'provider rejected the request',
      'terminal',
      '${input.reason}',
      clock_timestamp()
    );
  `);
}

interface RecoveryCallInput {
  projectId: string;
  jobId: string;
  attemptId: string;
  decision: 'confirm_succeeded' | 'confirm_not_created' | 'keep_unknown';
  idempotencyKey: string;
  requestHash: string;
  evidence?: Record<string, unknown>;
  resultAssets?: Array<Record<string, unknown>> | null;
  actualCredits?: number | null;
  keepUnknownUntilSql?: string;
  recoveredAtSql?: string;
  reason?: string;
}

function recoveryAssets(objectKey: string): Array<Record<string, unknown>> {
  return [
    {
      kind: 'image',
      mimeType: 'image/png',
      bucket: 'studio-integration',
      objectKey,
      checksumSha256: 'recovery-integration-checksum',
      sizeBytes: 4,
      filename: 'recovered-result.png',
    },
  ];
}

function recoveryCallSql(input: RecoveryCallInput): string {
  const evidence = JSON.stringify(input.evidence ?? {}).replaceAll("'", "''");
  const assets =
    input.resultAssets == null
      ? 'NULL::jsonb'
      : `'${JSON.stringify(input.resultAssets).replaceAll("'", "''")}'::jsonb`;
  const actualCredits = input.actualCredits == null ? 'NULL::numeric' : input.actualCredits;
  const reason = (input.reason ?? 'Operator confirmed the provider outcome.').replaceAll("'", "''");

  return `
    SET ROLE service_role;
    SELECT public.atomic_recover_studio_job(
      '${input.projectId}'::uuid,
      '${input.jobId}'::uuid,
      '${input.attemptId}'::uuid,
      '60000000-0000-4000-a000-000000000001'::uuid,
      'user',
      NULL::uuid,
      '${input.decision}',
      '${input.idempotencyKey}',
      '${input.requestHash}',
      '${reason}',
      '${evidence}'::jsonb,
      ${assets},
      ${actualCredits},
      ${input.keepUnknownUntilSql ?? 'NULL::timestamptz'},
      ${input.recoveredAtSql ?? 'clock_timestamp()'}
    );
  `;
}

function recoverProductionJob(input: RecoveryCallInput): Record<string, unknown> {
  return dockerPsqlJson(recoveryCallSql(input));
}

function expireUnknownHoldSql(input: {
  jobId: string;
  attemptId: string;
  expiredAtSql?: string;
}): string {
  return `
    SET ROLE service_role;
    SELECT public.atomic_expire_studio_unknown_hold(
      '${input.jobId}'::uuid,
      '${input.attemptId}'::uuid,
      ${input.expiredAtSql ?? 'clock_timestamp()'}
    );
  `;
}

function expireUnknownHold(input: {
  jobId: string;
  attemptId: string;
  expiredAtSql?: string;
}): Record<string, unknown> {
  return dockerPsqlJson(expireUnknownHoldSql(input));
}

describe.skipIf(!dockerAvailable)('Studio worker migrations - real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    let ready = false;
    const readinessDeadline = Date.now() + 90_000;
    while (Date.now() < readinessDeadline) {
      const logs = Bun.spawnSync(['docker', 'logs', container], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const initComplete = `${logs.stdout.toString()}${logs.stderr.toString()}`.includes(
        'PostgreSQL init process complete; ready for start up.',
      );
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'testdb'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (initComplete && probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    const mappedPort = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (mappedPort.exitCode !== 0) throw new Error(mappedPort.stderr.toString());
    const mappedPortValue = mappedPort.stdout
      .toString()
      .trim()
      .match(/:(\d+)$/)?.[1];
    if (!mappedPortValue)
      throw new Error(`Could not resolve mapped PostgreSQL port: ${mappedPort.stdout}`);
    mappedPostgresPort = mappedPortValue;

    dockerPsql(PRE_STUDIO_SCHEMA);
    await applyMigration('20260715160000000_studio_phase1.sql');
    await applyMigration('20260715170000000_studio_credit_reservations.sql');
    await applyMigration('20260715180000000_studio_worker_hardening.sql');
    await applyMigration('20260716120000000_studio_production_provider_storage.sql');
    await applyMigration(recoveryHardeningMigration);
    await applyMigration(pollingUnknownHoldMigration);
    dockerPsql(MODULE_SERVICE_MIGRATION_PREREQUISITES);
    await applyMigration(studioModuleServiceGrantsMigration);
    dockerPsql(CORE_FIXTURES);
  }, 150_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('applies the Studio production chain and resolves both create overloads and cost RPC', () => {
    const state = dockerPsqlJson(`
        SELECT jsonb_build_object(
          'studio_tables', (
            SELECT count(*) FROM pg_tables
            WHERE schemaname = 'kortix' AND tablename LIKE 'studio_%'
          ),
          'daily_precision', (
            SELECT numeric_precision FROM information_schema.columns
            WHERE table_schema = 'kortix' AND table_name = 'credit_accounts'
              AND column_name = 'daily_credits_balance'
          ),
          'daily_scale', (
            SELECT numeric_scale FROM information_schema.columns
            WHERE table_schema = 'kortix' AND table_name = 'credit_accounts'
              AND column_name = 'daily_credits_balance'
          ),
          'module_grant_column_exists', EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'kortix' AND table_name = 'studio_jobs'
              AND column_name = 'module_service_grant_id'
          ),
          'module_grant_fk_exists', EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
            WHERE conname = 'studio_jobs_module_service_grant_fk'
              AND conrelid = 'kortix.studio_jobs'::regclass
          ),
          'module_actor_check_exists', EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
            WHERE conname = 'studio_jobs_module_actor_check'
              AND conrelid = 'kortix.studio_jobs'::regclass
          ),
          'finalizer_exists', to_regprocedure(
            'public.atomic_finalize_studio_job_success(uuid,uuid,text,numeric,jsonb,timestamp with time zone)'
          ) IS NOT NULL,
          'service_role_can_finalize', has_function_privilege(
            'service_role',
            'public.atomic_finalize_studio_job_success(uuid,uuid,text,numeric,jsonb,timestamp with time zone)',
            'EXECUTE'
          ),
          'authenticated_can_finalize', has_function_privilege(
            'authenticated',
            'public.atomic_finalize_studio_job_success(uuid,uuid,text,numeric,jsonb,timestamp with time zone)',
            'EXECUTE'
          ),
          'terminal_finalizer_exists', to_regprocedure(
            'public.atomic_finalize_studio_job_terminal(uuid,uuid,text,text,text,text,text,text,timestamp with time zone)'
          ) IS NOT NULL,
          'legacy_create_exists', to_regprocedure(
            'public.atomic_create_studio_job(uuid,uuid,uuid,text,uuid,text,text,uuid,text,uuid,text,text,jsonb,text,text,numeric,timestamp with time zone)'
          ) IS NOT NULL,
          'production_create_exists', to_regprocedure(
            'public.atomic_create_studio_job(uuid,uuid,uuid,text,uuid,text,text,uuid,text,uuid,text,text,text,uuid,integer,jsonb,jsonb,text,text,numeric,timestamp with time zone)'
          ) IS NOT NULL,
          'service_role_can_create_production', has_function_privilege(
            'service_role',
            'public.atomic_create_studio_job(uuid,uuid,uuid,text,uuid,text,text,uuid,text,uuid,text,text,text,uuid,integer,jsonb,jsonb,text,text,numeric,timestamp with time zone)',
            'EXECUTE'
          ),
          'authenticated_can_create_production', has_function_privilege(
            'authenticated',
            'public.atomic_create_studio_job(uuid,uuid,uuid,text,uuid,text,text,uuid,text,uuid,text,text,text,uuid,integer,jsonb,jsonb,text,text,numeric,timestamp with time zone)',
            'EXECUTE'
          ),
          'anon_can_create_production', has_function_privilege(
            'anon',
            'public.atomic_create_studio_job(uuid,uuid,uuid,text,uuid,text,text,uuid,text,uuid,text,text,text,uuid,integer,jsonb,jsonb,text,text,numeric,timestamp with time zone)',
            'EXECUTE'
          ),
          'record_cost_exists', to_regprocedure(
            'public.atomic_record_studio_attempt_cost(uuid,uuid,text,jsonb,numeric,text,timestamp with time zone)'
          ) IS NOT NULL,
          'service_role_can_record_cost', has_function_privilege(
            'service_role',
            'public.atomic_record_studio_attempt_cost(uuid,uuid,text,jsonb,numeric,text,timestamp with time zone)',
            'EXECUTE'
          ),
          'authenticated_can_record_cost', has_function_privilege(
            'authenticated',
            'public.atomic_record_studio_attempt_cost(uuid,uuid,text,jsonb,numeric,text,timestamp with time zone)',
            'EXECUTE'
          ),
          'recover_exists', to_regprocedure(
            'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamp with time zone,timestamp with time zone)'
          ) IS NOT NULL,
          'recover_security_definer', (
            SELECT procedure.prosecdef
            FROM pg_catalog.pg_proc procedure
            WHERE procedure.oid = to_regprocedure(
              'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamp with time zone,timestamp with time zone)'
            )
          ),
          'service_role_can_recover', has_function_privilege(
            'service_role',
            'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamp with time zone,timestamp with time zone)',
            'EXECUTE'
          ),
          'authenticated_can_recover', has_function_privilege(
            'authenticated',
            'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamp with time zone,timestamp with time zone)',
            'EXECUTE'
          ),
          'anon_can_recover', has_function_privilege(
            'anon',
            'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamp with time zone,timestamp with time zone)',
            'EXECUTE'
          ),
          'expire_hold_exists', to_regprocedure(
            'public.atomic_expire_studio_unknown_hold(uuid,uuid,timestamp with time zone)'
          ) IS NOT NULL,
          'expire_hold_security_definer', (
            SELECT procedure.prosecdef
            FROM pg_catalog.pg_proc procedure
            WHERE procedure.oid = to_regprocedure(
              'public.atomic_expire_studio_unknown_hold(uuid,uuid,timestamp with time zone)'
            )
          ),
          'service_role_can_expire_hold', has_function_privilege(
            'service_role',
            'public.atomic_expire_studio_unknown_hold(uuid,uuid,timestamp with time zone)',
            'EXECUTE'
          ),
          'authenticated_can_expire_hold', has_function_privilege(
            'authenticated',
            'public.atomic_expire_studio_unknown_hold(uuid,uuid,timestamp with time zone)',
            'EXECUTE'
          ),
          'anon_can_expire_hold', has_function_privilege(
            'anon',
            'public.atomic_expire_studio_unknown_hold(uuid,uuid,timestamp with time zone)',
            'EXECUTE'
          ),
          'service_role_can_call_internal_settlement', has_function_privilege(
            'service_role',
            'kortix.atomic_settle_studio_job_production(uuid,numeric,text,text)',
            'EXECUTE'
          ),
          'authenticated_can_call_internal_settlement', has_function_privilege(
            'authenticated',
            'kortix.atomic_settle_studio_job_production(uuid,numeric,text,text)',
            'EXECUTE'
          ),
          'anon_can_call_internal_settlement', has_function_privilege(
            'anon',
            'kortix.atomic_settle_studio_job_production(uuid,numeric,text,text)',
            'EXECUTE'
          ),
          'service_role_can_finalize_terminal', has_function_privilege(
            'service_role',
            'public.atomic_finalize_studio_job_terminal(uuid,uuid,text,text,text,text,text,text,timestamp with time zone)',
            'EXECUTE'
          ),
          'authenticated_can_finalize_terminal', has_function_privilege(
            'authenticated',
            'public.atomic_finalize_studio_job_terminal(uuid,uuid,text,text,text,text,text,text,timestamp with time zone)',
            'EXECUTE'
          )
        );
      `);

    expect(state).toEqual({
      studio_tables: 12,
      daily_precision: 12,
      daily_scale: 4,
      module_grant_column_exists: true,
      module_grant_fk_exists: true,
      module_actor_check_exists: true,
      finalizer_exists: true,
      service_role_can_finalize: true,
      authenticated_can_finalize: false,
      terminal_finalizer_exists: true,
      legacy_create_exists: true,
      production_create_exists: true,
      service_role_can_create_production: true,
      authenticated_can_create_production: false,
      anon_can_create_production: false,
      record_cost_exists: true,
      service_role_can_record_cost: true,
      authenticated_can_record_cost: false,
      recover_exists: true,
      recover_security_definer: true,
      service_role_can_recover: true,
      authenticated_can_recover: false,
      anon_can_recover: false,
      expire_hold_exists: true,
      expire_hold_security_definer: true,
      service_role_can_expire_hold: true,
      authenticated_can_expire_hold: false,
      anon_can_expire_hold: false,
      service_role_can_call_internal_settlement: false,
      authenticated_can_call_internal_settlement: false,
      anon_can_call_internal_settlement: false,
      service_role_can_finalize_terminal: true,
      authenticated_can_finalize_terminal: false,
    });
  }, 30_000);

  test('API routes reject cross-tenant secret and connector credential decoys', async () => {
    const scope = seedProductionScope({ suffix: '29' });
    const accountB = '81000000-0000-4000-a000-000000000029';
    const projectB = '82000000-0000-4000-a000-000000000029';
    const connectorProviderId = '72000000-0000-4000-a000-000000000129';
    const connectorA = '83000000-0000-4000-a000-000000000029';
    const connectorB = '83000000-0000-4000-a000-000000000129';
    const profileA = '84000000-0000-4000-a000-000000000029';
    const profileB = '84000000-0000-4000-a000-000000000129';
    const capabilityMap = {
      definition_id: 'openai-compatible',
      capabilities: {
        'image.generate': {
          models: [
            {
              model: PRODUCTION_MODEL,
              pricing_catalog_id: scope.pricingId,
              dialect_profile_id: 'openai-images-v1-generic',
              supports_reference_images: false,
              allowed_advanced_fields: [],
              size_map: {
                '1:1': '1024x1024',
                '4:3': '1536x1024',
                '3:4': '1024x1536',
                '16:9': '1536x864',
                '9:16': '864x1536',
              },
            },
          ],
        },
      },
    };
    dockerPsql(`
      UPDATE kortix.studio_provider_configs
      SET credential_binding = jsonb_build_object('kind', 'secret', 'identifier', 'STUDIO_IMAGE_KEY'),
          capability_map = '${JSON.stringify(capabilityMap)}'::jsonb
      WHERE provider_config_id = '${scope.providerId}';
      INSERT INTO kortix.studio_provider_configs(
        provider_config_id, account_id, project_id, provider, display_name,
        base_url, credential_binding, capability_map, enabled
      ) VALUES (
        '${connectorProviderId}', '${scope.accountId}', '${scope.projectId}', '${PRODUCTION_PROVIDER}',
        'Connector integration provider', 'https://provider.invalid/v1',
        jsonb_build_object('kind', 'connector', 'slug', 'studio-images'),
        '${JSON.stringify(capabilityMap)}'::jsonb, true
      );
      INSERT INTO kortix.accounts(account_id) VALUES ('${accountB}');
      INSERT INTO kortix.projects(project_id, account_id) VALUES ('${projectB}', '${accountB}');
      INSERT INTO kortix.project_secrets(project_id, identifier, owner_user_id, active, value_enc)
      VALUES ('${projectB}', 'STUDIO_IMAGE_KEY', NULL, true, 'encrypted-decoy');
      INSERT INTO kortix.executor_connectors(
        connector_id, account_id, project_id, slug, enabled, status
      ) VALUES ('${connectorB}', '${accountB}', '${projectB}', 'studio-images', true, 'active');
      INSERT INTO kortix.executor_connection_profiles(
        profile_id, connector_id, account_id, project_id, is_default, status
      ) VALUES ('${profileB}', '${connectorB}', '${accountB}', '${projectB}', true, 'active');
      INSERT INTO kortix.executor_credentials(connector_id, profile_id, value_enc)
      VALUES ('${connectorB}', '${profileB}', 'encrypted-decoy');
    `);
    const database = createDb(postgresUrl('testdb'), { max: 1 });
    const repository = createDrizzleStudioRepository(database);
    const app = createStudioProjectRoutes({
      repository,
      storageService: new StudioStorageService({
        repository,
        store: new InMemoryStudioObjectStore({ namespace: 'credential-decoy', ready: true }),
      }),
      credentialBindingExists: createStudioCredentialBindingExists(database),
      loadProjectForUser: async (_context, projectId) =>
        projectId === scope.projectId
          ? {
              row: { accountId: scope.accountId, projectId },
              userId: '60000000-0000-4000-a000-000000000001',
            }
          : null,
      assertProjectCapability: async () => {},
      estimateSigningSecret: 'studio-cross-tenant-credential-decoy-test',
    });
    const request = {
      capability: 'image.generate',
      model: PRODUCTION_MODEL,
      input: {
        capability: 'image.generate',
        image: {
          prompt: 'Cross-tenant credential decoy',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      },
    };
    const requestEstimate = (providerConfigId: string) =>
      app.request(`/${scope.projectId}/studio/estimates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, provider_config_id: providerConfigId }),
      });
    try {
      const capabilities = await app.request(`/${scope.projectId}/studio/capabilities`);
      expect(await capabilities.json()).toEqual({ items: [], next_cursor: null });
      for (const providerConfigId of [scope.providerId, connectorProviderId]) {
        const estimate = await requestEstimate(providerConfigId);
        expect(estimate.status).toBe(409);
        expect(await estimate.json()).toMatchObject({ code: 'STUDIO_CREDENTIAL_UNAVAILABLE' });
      }

      dockerPsql(`
        INSERT INTO kortix.project_secrets(project_id, identifier, owner_user_id, active, value_enc)
        VALUES ('${scope.projectId}', 'STUDIO_IMAGE_KEY', NULL, true, 'encrypted-owned');
        INSERT INTO kortix.executor_connectors(
          connector_id, account_id, project_id, slug, enabled, status
        ) VALUES ('${connectorA}', '${scope.accountId}', '${scope.projectId}', 'studio-images', true, 'active');
        INSERT INTO kortix.executor_connection_profiles(
          profile_id, connector_id, account_id, project_id, is_default, status
        ) VALUES ('${profileA}', '${connectorA}', '${scope.accountId}', '${scope.projectId}', true, 'active');
        INSERT INTO kortix.executor_credentials(connector_id, profile_id, value_enc)
        VALUES ('${connectorA}', '${profileA}', 'encrypted-owned');
      `);

      const executableCapabilities = await app.request(`/${scope.projectId}/studio/capabilities`);
      expect(
        ((await executableCapabilities.json()) as { items: unknown[] }).items,
      ).not.toHaveLength(0);
      const secretEstimate = await requestEstimate(scope.providerId);
      expect(secretEstimate.status).toBe(200);
      const secretEstimateBody = (await secretEstimate.json()) as Record<string, unknown>;
      expect((await requestEstimate(connectorProviderId)).status).toBe(200);

      dockerPsql(`
        DELETE FROM kortix.project_secrets
        WHERE project_id = '${scope.projectId}' AND identifier = 'STUDIO_IMAGE_KEY';
      `);
      const job = await app.request(`/${scope.projectId}/studio/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          provider_config_id: scope.providerId,
          estimate_id: secretEstimateBody.estimate_id,
          estimate_token: secretEstimateBody.estimate_token,
          idempotency_key: 'cross-tenant-secret-decoy-job',
          request_hash: secretEstimateBody.input_hash,
        }),
      });
      expect(job.status).toBe(409);
      expect(await job.json()).toMatchObject({ code: 'STUDIO_CREDENTIAL_UNAVAILABLE' });
      expect(
        dockerPsqlJson(`
          SELECT jsonb_build_object(
            'job_count', count(*)
          ) FROM kortix.studio_jobs
          WHERE account_id = '${scope.accountId}' AND project_id = '${scope.projectId}';
        `),
      ).toEqual({ job_count: 0 });
    } finally {
      await (
        database as unknown as { $client: { end(options?: unknown): Promise<void> } }
      ).$client.end({ timeout: 1 });
    }
  }, 30_000);

  test('applies the recorded B2 and B3 forward-upgrade paths with dirty reservation anchors', async () => {
    for (const variant of ['b2', 'b3'] as const) {
      const database = `studio_upgrade_${variant}`;
      dockerPsql(`CREATE DATABASE ${database};`);
      dockerPsql(PRE_STUDIO_SCHEMA_WITH_EXISTING_ROLES, false, database);
      await applyMigration('20260715160000000_studio_phase1.sql', database);
      await applyMigration('20260715170000000_studio_credit_reservations.sql', database);
      await applyMigration('20260715180000000_studio_worker_hardening.sql', database);
      await applyMigration('20260716120000000_studio_production_provider_storage.sql', database);
      dockerPsql(CORE_FIXTURES, false, database);

      const jobIds = [1, 2, 3, 4].map(
        (index) => `81000000-0000-4000-a000-0000000000${variant === 'b2' ? '1' : '2'}${index}`,
      );
      dockerPsql(
        `
          INSERT INTO kortix.studio_jobs(
            job_id, account_id, project_id, actor_user_id, actor_type, capability,
            provider_config_id, provider, model, input, status, idempotency_key,
            request_hash, attempt_count, reserved_credits, available_at, created_at
          ) VALUES
            (
              '${jobIds[0]}', '${SUCCESS_ACCOUNT_ID}', '${SUCCESS_PROJECT_ID}',
              '60000000-0000-4000-a000-000000000001', 'user', 'image.generate',
              '${SUCCESS_PROVIDER_ID}', 'fake', 'fake-image-v1', '{}'::jsonb, 'running',
              'upgrade-${variant}-1', 'upgrade-hash-${variant}-1', 0, 1,
              clock_timestamp(), clock_timestamp() - interval '10 days'
            ),
            (
              '${jobIds[1]}', '${SUCCESS_ACCOUNT_ID}', '${SUCCESS_PROJECT_ID}',
              '60000000-0000-4000-a000-000000000001', 'user', 'image.generate',
              '${SUCCESS_PROVIDER_ID}', 'fake', 'fake-image-v1', '{}'::jsonb, 'running',
              'upgrade-${variant}-2', 'upgrade-hash-${variant}-2', 0, 1,
              clock_timestamp(), clock_timestamp() - interval '20 days'
            ),
            (
              '${jobIds[2]}', '${SUCCESS_ACCOUNT_ID}', '${SUCCESS_PROJECT_ID}',
              '60000000-0000-4000-a000-000000000001', 'user', 'image.generate',
              '${SUCCESS_PROVIDER_ID}', 'fake', 'fake-image-v1', '{}'::jsonb, 'running',
              'upgrade-${variant}-3', 'upgrade-hash-${variant}-3', 0, 1,
              clock_timestamp(), clock_timestamp() - interval '5 days'
            ),
            (
              '${jobIds[3]}', '${SUCCESS_ACCOUNT_ID}', '${SUCCESS_PROJECT_ID}',
              '60000000-0000-4000-a000-000000000001', 'user', 'image.generate',
              '${SUCCESS_PROVIDER_ID}', 'fake', 'fake-image-v1', '{}'::jsonb, 'running',
              'upgrade-${variant}-4', 'upgrade-hash-${variant}-4', 0, 1,
              clock_timestamp(), 'infinity'::timestamptz
            );

          INSERT INTO kortix.studio_credit_reservations(
            account_id, job_id, amount_credits, status, expires_at, created_at
          ) VALUES
            ('${SUCCESS_ACCOUNT_ID}', '${jobIds[0]}', 1, 'active', clock_timestamp() + interval '1 hour', NULL),
            ('${SUCCESS_ACCOUNT_ID}', '${jobIds[1]}', 1, 'active', clock_timestamp() + interval '1 hour', 'infinity'::timestamptz),
            ('${SUCCESS_ACCOUNT_ID}', '${jobIds[2]}', 1, 'active', clock_timestamp() + interval '1 hour', clock_timestamp() + interval '1 year'),
            ('${SUCCESS_ACCOUNT_ID}', '${jobIds[3]}', 1, 'active', clock_timestamp() + interval '1 hour', '-infinity'::timestamptz);
        `,
        false,
        database,
      );

      if (variant === 'b2') {
        dockerPsql(
          `
            DROP FUNCTION public.atomic_recover_studio_job(
              uuid, uuid, uuid, uuid, text, uuid, text, text, text, text,
              jsonb, jsonb, numeric, timestamptz, timestamptz
            );
            DROP FUNCTION public.atomic_expire_studio_unknown_hold(uuid, uuid, timestamptz);
          `,
          false,
          database,
        );
      }

      const applied = await applyOnlyRecordedForwardMigration(database);
      expect(applied).toHaveLength(1);
      expect(applied[0]).toContain('20260717020000000_studio_recovery_hardening');
      expect(
        dockerPsqlJson(
          `
            SELECT jsonb_build_object(
              'all_valid', NOT EXISTS (
                SELECT 1
                FROM kortix.studio_credit_reservations
                WHERE created_at IS NULL
                  OR created_at::text IN ('infinity', '-infinity')
                  OR created_at > clock_timestamp()
              ),
              'trusted_backfills', (
                SELECT count(*)
                FROM kortix.studio_credit_reservations reservation
                JOIN kortix.studio_jobs job USING (job_id)
                WHERE reservation.job_id IN ('${jobIds[0]}', '${jobIds[1]}', '${jobIds[2]}')
                  AND reservation.created_at = job.created_at
              ),
              'fallback_reached_cap', (
                SELECT created_at <= clock_timestamp() - interval '29 days 23 hours'
                FROM kortix.studio_credit_reservations
                WHERE job_id = '${jobIds[3]}'
              ),
              'created_at_not_null', (
                SELECT is_nullable = 'NO'
                FROM information_schema.columns
                WHERE table_schema = 'kortix'
                  AND table_name = 'studio_credit_reservations'
                  AND column_name = 'created_at'
              ),
              'recovery_exists', to_regprocedure(
                'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamptz,timestamptz)'
              ) IS NOT NULL,
              'expiry_exists', to_regprocedure(
                'public.atomic_expire_studio_unknown_hold(uuid,uuid,timestamptz)'
              ) IS NOT NULL,
              'service_can_recover', has_function_privilege(
                'service_role',
                'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamptz,timestamptz)',
                'EXECUTE'
              ),
              'authenticated_can_recover', has_function_privilege(
                'authenticated',
                'public.atomic_recover_studio_job(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb,jsonb,numeric,timestamptz,timestamptz)',
                'EXECUTE'
              ),
              'forward_recorded', EXISTS (
                SELECT 1
                FROM kortix_migrations.pgmigrations
                WHERE name LIKE '20260717020000000_studio_recovery_hardening%'
              )
            );
          `,
          database,
        ),
      ).toEqual({
        all_valid: true,
        trusted_backfills: 3,
        fallback_reached_cap: true,
        created_at_not_null: true,
        recovery_exists: true,
        expiry_exists: true,
        service_can_recover: true,
        authenticated_can_recover: false,
        forward_recorded: true,
      });

      const immutable = dockerPsql(
        `
          SET ROLE service_role;
          UPDATE kortix.studio_credit_reservations
          SET created_at = clock_timestamp()
          WHERE job_id = '${jobIds[0]}';
        `,
        true,
        database,
      );
      expect(immutable.exitCode).not.toBe(0);
      expect(immutable.output).toContain('Studio reservation creation time is immutable');
    }
  }, 150_000);

  test('times out before backfill when live traffic blocks the reservation table lock', async () => {
    const database = 'studio_upgrade_lock';
    const jobId = '81000000-0000-4000-a000-000000000031';
    dockerPsql(`CREATE DATABASE ${database};`);
    dockerPsql(PRE_STUDIO_SCHEMA_WITH_EXISTING_ROLES, false, database);
    await applyMigration('20260715160000000_studio_phase1.sql', database);
    await applyMigration('20260715170000000_studio_credit_reservations.sql', database);
    await applyMigration('20260715180000000_studio_worker_hardening.sql', database);
    await applyMigration('20260716120000000_studio_production_provider_storage.sql', database);
    dockerPsql(CORE_FIXTURES, false, database);
    dockerPsql(
      `
        INSERT INTO kortix.studio_jobs(
          job_id, account_id, project_id, actor_user_id, actor_type, capability,
          provider_config_id, provider, model, input, status, idempotency_key,
          request_hash, attempt_count, reserved_credits, available_at, created_at
        ) VALUES (
          '${jobId}', '${SUCCESS_ACCOUNT_ID}', '${SUCCESS_PROJECT_ID}',
          '60000000-0000-4000-a000-000000000001', 'user', 'image.generate',
          '${SUCCESS_PROVIDER_ID}', 'fake', 'fake-image-v1', '{}'::jsonb, 'running',
          'upgrade-lock', 'upgrade-lock-hash', 0, 1,
          clock_timestamp(), clock_timestamp() - interval '1 day'
        );
        INSERT INTO kortix.studio_credit_reservations(
          account_id, job_id, amount_credits, status, expires_at, created_at
        ) VALUES (
          '${SUCCESS_ACCOUNT_ID}', '${jobId}', 1, 'active',
          clock_timestamp() + interval '1 hour', 'infinity'::timestamptz
        );
      `,
      false,
      database,
    );

    const migrationSql = await Bun.file(
      resolve(migrationsDirectory, recoveryHardeningMigration),
    ).text();
    const holder = new pg.Client({ connectionString: postgresUrl(database) });
    const migrator = new pg.Client({ connectionString: postgresUrl(database) });
    await holder.connect();
    await migrator.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM kortix.studio_credit_reservations WHERE job_id = $1 FOR UPDATE',
        [jobId],
      );

      const blockedMigration = migrator.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
      await Bun.sleep(250);
      expect(
        dockerPsqlJson(
          `
            SELECT jsonb_build_object(
              'created_at', created_at::text,
              'constraint_exists', EXISTS (
                SELECT 1 FROM pg_catalog.pg_constraint
                WHERE conname = 'studio_credit_reservations_created_at_finite_check'
                  AND conrelid = 'kortix.studio_credit_reservations'::regclass
              )
            )
            FROM kortix.studio_credit_reservations
            WHERE job_id = '${jobId}';
          `,
          database,
        ),
      ).toEqual({ created_at: 'infinity', constraint_exists: false });

      let lockError: unknown;
      try {
        await blockedMigration;
      } catch (error) {
        lockError = error;
      }
      expect(lockError).toBeInstanceOf(Error);
      expect((lockError as { code?: string }).code).toBe('55P03');
      await migrator.query('ROLLBACK');
      await holder.query('ROLLBACK');

      await migrator.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
      expect(
        dockerPsqlJson(
          `
            SELECT jsonb_build_object(
              'created_at_is_finite', created_at::text NOT IN ('infinity', '-infinity'),
              'created_at_is_not_future', created_at <= clock_timestamp()
            )
            FROM kortix.studio_credit_reservations
            WHERE job_id = '${jobId}';
          `,
          database,
        ),
      ).toEqual({ created_at_is_finite: true, created_at_is_not_future: true });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await migrator.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      await migrator.end();
    }
  }, 90_000);

  test('removes direct client access from every PostgREST-exposed Studio table', () => {
    const state = dockerPsqlJson(`
      WITH studio_tables(table_name) AS (
        SELECT unnest(ARRAY[
          'studio_provider_configs', 'studio_jobs', 'studio_job_attempts',
          'studio_job_events', 'studio_assets', 'studio_job_assets',
          'studio_asset_uploads', 'studio_credit_reservations',
          'studio_usage_events', 'studio_pricing_catalog',
          'studio_job_recoveries', 'studio_billing_incidents'
        ])
      )
      SELECT jsonb_build_object(
        'table_count', count(*),
        'anon_direct_count', count(*) FILTER (
          WHERE has_table_privilege('anon', 'kortix.' || table_name, 'SELECT')
             OR has_table_privilege('anon', 'kortix.' || table_name, 'INSERT')
             OR has_table_privilege('anon', 'kortix.' || table_name, 'UPDATE')
             OR has_table_privilege('anon', 'kortix.' || table_name, 'DELETE')
        ),
        'authenticated_direct_count', count(*) FILTER (
          WHERE has_table_privilege('authenticated', 'kortix.' || table_name, 'SELECT')
             OR has_table_privilege('authenticated', 'kortix.' || table_name, 'INSERT')
             OR has_table_privilege('authenticated', 'kortix.' || table_name, 'UPDATE')
             OR has_table_privilege('authenticated', 'kortix.' || table_name, 'DELETE')
        ),
        'service_role_select_count', count(*) FILTER (
          WHERE has_table_privilege('service_role', 'kortix.' || table_name, 'SELECT')
        )
      )
      FROM studio_tables;
    `);
    expect(state).toEqual({
      table_count: 12,
      anon_direct_count: 0,
      authenticated_direct_count: 0,
      service_role_select_count: 12,
    });
    expect(
      dockerPsql('SET ROLE anon; SELECT job_id FROM kortix.studio_jobs LIMIT 1;', true).exitCode,
    ).not.toBe(0);
    expect(
      dockerPsql(
        'SET ROLE authenticated; UPDATE kortix.studio_provider_configs SET enabled = enabled WHERE false;',
        true,
      ).exitCode,
    ).not.toBe(0);
    expect(
      dockerPsql(
        `SET ROLE authenticated;
         SELECT public.atomic_recover_studio_job(
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text,
           NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text,
           NULL::jsonb, NULL::jsonb, NULL::numeric, NULL::timestamptz, NULL::timestamptz
         );`,
        true,
      ).exitCode,
    ).not.toBe(0);
    expect(
      dockerPsql(
        `SET ROLE anon;
         SELECT public.atomic_expire_studio_unknown_hold(
           NULL::uuid, NULL::uuid, NULL::timestamptz
         );`,
        true,
      ).exitCode,
    ).not.toBe(0);
  }, 30_000);

  test('creates production jobs only from the locked provider and exact pricing snapshot', () => {
    const scope = seedProductionScope({ suffix: '01' });
    const secondPricingId = '73000000-0000-4000-a000-000000000101';
    const secondSnapshot = {
      ...scope.snapshot,
      pricing_catalog_id: secondPricingId,
      version: 2,
    };
    dockerPsql(`
      INSERT INTO kortix.studio_pricing_catalog(
        pricing_catalog_id, account_id, provider, model, unit, rate_data,
        maximum_cost_rule, markup_rule, version, active
      ) VALUES (
        '${secondPricingId}', '${scope.accountId}', '${PRODUCTION_PROVIDER}',
        '${PRODUCTION_MODEL}', 'image', jsonb_build_object('rate_credits', 2),
        jsonb_build_object('max_provider_credits', 8),
        jsonb_build_object('markup_credits', 1), 2, true
      );
    `);

    expect(createProductionJob(scope, { providerVersion: 'stale-provider-version' })).toMatchObject(
      {
        success: false,
        code: 'provider_config_stale',
      },
    );
    expect(
      createProductionJob(scope, {
        pricingId: secondPricingId,
        pricingVersion: 2,
        snapshot: secondSnapshot,
      }),
    ).toMatchObject({ success: false, code: 'pricing_stale' });
    expect(
      createProductionJob(scope, {
        model: 'openai-compatible/not-configured',
        snapshot: { ...scope.snapshot, model: 'openai-compatible/not-configured' },
      }),
    ).toMatchObject({ success: false, code: 'pricing_stale' });
    expect(
      createProductionJob(scope, {
        snapshot: { ...scope.snapshot, markup_credits: 9 },
      }),
    ).toMatchObject({ success: false, code: 'pricing_stale' });
    expect(createProductionJob(scope, { reservedCredits: 8 })).toMatchObject({
      success: false,
      code: 'pricing_stale',
    });
    expect(createProductionJob(scope, { outputCount: 0 })).toMatchObject({ success: false });

    const created = createProductionJob(scope, {
      outputCount: 2,
      idempotencyKey: 'production-create:validated',
      requestHash: 'production-create:validated-hash',
    });
    expect(created).toMatchObject({ success: true, idempotent: false, reserved: 10 });
    const productionJobId = String(created.job_id);

    const legacy = dockerPsqlJson(`
      SET ROLE service_role;
      SELECT public.atomic_create_studio_job(
        '${scope.accountId}'::uuid,
        '${scope.projectId}'::uuid,
        '60000000-0000-4000-a000-000000000001'::uuid,
        'user', NULL::uuid, NULL::text, NULL::text, NULL::uuid,
        'image.generate', '${scope.providerId}'::uuid,
        '${PRODUCTION_PROVIDER}', '${PRODUCTION_MODEL}',
        '{"capability":"image.generate","image":{"prompt":"legacy","output_count":1}}'::jsonb,
        'production-create:legacy-replay', 'production-create:legacy-replay-hash',
        1, clock_timestamp() + interval '1 hour'
      );
    `);
    expect(legacy).toMatchObject({ success: true, idempotent: false });
    const legacyJobId = String(legacy.job_id);

    dockerPsql(`
      UPDATE kortix.studio_pricing_catalog
      SET active = false
      WHERE pricing_catalog_id = '${scope.pricingId}';
    `);

    expect(
      createProductionJob(scope, {
        outputCount: 2,
        reservedCredits: -1,
        idempotencyKey: 'production-create:validated',
        requestHash: 'production-create:validated-hash',
      }),
    ).toMatchObject({ success: true, idempotent: true, job_id: productionJobId });
    expect(
      createProductionJob(scope, {
        idempotencyKey: 'production-create:legacy-replay',
        requestHash: 'production-create:legacy-replay-hash',
      }),
    ).toMatchObject({ success: true, idempotent: true, job_id: legacyJobId });

    const state = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'production_job', (
          SELECT jsonb_build_object(
            'provider_config_version', provider_config_version,
            'pricing_catalog_id', pricing_catalog_id,
            'pricing_version', pricing_version,
            'pricing_snapshot', pricing_snapshot,
            'reserved_credits', reserved_credits
          ) FROM kortix.studio_jobs WHERE job_id = '${productionJobId}'
        ),
        'reservation', (
          SELECT jsonb_build_object('amount', amount_credits, 'status', status)
          FROM kortix.studio_credit_reservations WHERE job_id = '${productionJobId}'
        ),
        'event_types', (
          SELECT jsonb_agg(event_type ORDER BY cursor)
          FROM kortix.studio_job_events WHERE job_id = '${productionJobId}'
        ),
        'legacy_snapshot_is_null', (
          SELECT pricing_snapshot IS NULL AND provider_config_version IS NULL
          FROM kortix.studio_jobs WHERE job_id = '${legacyJobId}'
        )
      );
    `);
    expect(state).toMatchObject({
      production_job: {
        provider_config_version: scope.providerVersion,
        pricing_catalog_id: scope.pricingId,
        pricing_version: 1,
        pricing_snapshot: scope.snapshot,
        reserved_credits: 10,
      },
      reservation: { amount: 10, status: 'active' },
      event_types: ['queued'],
      legacy_snapshot_is_null: true,
    });

    dockerPsql(`DELETE FROM kortix.credit_accounts WHERE account_id = '${scope.accountId}';`);
    expect(
      createProductionJob(scope, {
        outputCount: 2,
        idempotencyKey: 'production-create:validated',
        requestHash: 'production-create:validated-hash',
      }),
    ).toMatchObject({ success: true, idempotent: true, job_id: productionJobId });
  }, 30_000);

  test('rejects a pricing catalog row with a missing numeric rate field', () => {
    const scope = seedProductionScope({ suffix: '08', omitRateCredits: true });
    expect(
      createProductionJob(scope, {
        snapshot: { ...scope.snapshot, rate_credits: null },
      }),
    ).toMatchObject({ success: false, code: 'pricing_stale' });
  }, 30_000);

  test('records one canonical attempt cost and rejects conflict, forged lease, and terminal jobs', () => {
    const scope = seedProductionScope({ suffix: '02' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000002';
    const secondAttemptId = '74000000-0000-4000-a000-000000000102';
    const futureAttemptId = '74000000-0000-4000-a000-000000000202';
    const nanAttemptId = '74000000-0000-4000-a000-000000000302';
    const leaseOwner = 'studio-worker:production-cost';
    prepareProductionAttempt({ jobId, attemptId: nanAttemptId, leaseOwner });
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId: nanAttemptId,
        leaseOwner,
        usage: { request_id: 'non-finite-cost' },
        cost: 0,
        costSql: "'NaN'::numeric",
        outcome: 'failed',
      }),
    ).toMatchObject({ success: false });
    const directNan = dockerPsql(
      `
        UPDATE kortix.studio_job_attempts
        SET upstream_usage = '{"request_id":"direct-non-finite"}'::jsonb,
            upstream_cost_credits = 'NaN'::numeric,
            cost_outcome = 'failed',
            cost_recorded_at = clock_timestamp()
        WHERE attempt_id = '${nanAttemptId}';
      `,
      true,
    );
    expect(directNan.exitCode).not.toBe(0);

    prepareProductionAttempt({ jobId, attemptId, leaseOwner });

    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId,
        leaseOwner,
        usage: { request_id: 'request-2', output_count: 1 },
        cost: 3.5,
        outcome: 'succeeded',
      }),
    ).toMatchObject({ success: true, idempotent: false, upstream_cost_credits: 3.5 });
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId,
        leaseOwner,
        usage: { output_count: 1, request_id: 'request-2' },
        cost: 3.5,
        outcome: 'succeeded',
      }),
    ).toMatchObject({ success: true, idempotent: true, upstream_cost_credits: 3.5 });
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId,
        leaseOwner,
        usage: { request_id: 'request-2', output_count: 1 },
        cost: 3.6,
        outcome: 'succeeded',
      }),
    ).toMatchObject({ success: false, code: 'attempt_cost_conflict' });
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId,
        leaseOwner: 'studio-worker:forged-owner',
        usage: { request_id: 'request-2', output_count: 1 },
        cost: 3.5,
        outcome: 'succeeded',
      }),
    ).toMatchObject({ success: false });

    prepareProductionAttempt({ jobId, attemptId: futureAttemptId, leaseOwner });
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId: futureAttemptId,
        leaseOwner,
        usage: { request_id: 'after-lease-expiry' },
        cost: 1,
        outcome: 'failed',
        recordedAtSql: "clock_timestamp() + interval '2 hours'",
      }),
    ).toMatchObject({ success: false });

    prepareProductionAttempt({ jobId, attemptId: secondAttemptId, leaseOwner });
    dockerPsql(`
      UPDATE kortix.studio_jobs
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE job_id = '${jobId}';
    `);
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId: secondAttemptId,
        leaseOwner,
        usage: { request_id: 'expired' },
        cost: 1,
        outcome: 'failed',
      }),
    ).toMatchObject({ success: false });

    dockerPsql(`
      UPDATE kortix.studio_jobs
      SET status = 'failed', lease_expires_at = clock_timestamp() + interval '1 hour'
      WHERE job_id = '${jobId}';
    `);
    expect(
      recordProductionAttemptCost({
        jobId,
        attemptId: secondAttemptId,
        leaseOwner,
        usage: { request_id: 'terminal' },
        cost: 1,
        outcome: 'failed',
      }),
    ).toMatchObject({ success: false });

    const state = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'attempt', (
          SELECT jsonb_build_object(
            'usage', upstream_usage,
            'cost', upstream_cost_credits,
            'outcome', cost_outcome,
            'recorded', cost_recorded_at IS NOT NULL
          ) FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
        ),
        'usage_count', (
          SELECT count(*) FROM kortix.studio_usage_events WHERE attempt_id = '${attemptId}'
        ),
        'usage_shape', (
          SELECT jsonb_build_object(
            'upstream', upstream_cost_credits,
            'final', final_cost_credits,
            'loss', platform_loss_credits,
            'outcome', outcome
          ) FROM kortix.studio_usage_events WHERE attempt_id = '${attemptId}'
        )
      );
    `);
    expect(state).toMatchObject({
      attempt: {
        usage: { request_id: 'request-2', output_count: 1 },
        cost: 3.5,
        outcome: 'succeeded',
        recorded: true,
      },
      usage_count: 1,
      usage_shape: { upstream: 3.5, final: 0, loss: 0, outcome: 'succeeded' },
    });
  }, 30_000);

  test('derives production success from multiple attempts and rolls back an expected-cost mismatch', () => {
    const scope = seedProductionScope({ suffix: '03' });
    const created = createProductionJob(scope, { outputCount: 2 });
    const jobId = String(created.job_id);
    const firstAttemptId = '74000000-0000-4000-a000-000000000003';
    const finalAttemptId = '74000000-0000-4000-a000-000000000103';
    const leaseOwner = 'studio-worker:production-success';
    prepareProductionAttempt({ jobId, attemptId: firstAttemptId, leaseOwner });
    prepareProductionAttempt({ jobId, attemptId: finalAttemptId, leaseOwner });

    recordProductionAttemptCost({
      jobId,
      attemptId: firstAttemptId,
      leaseOwner,
      usage: { request_id: 'failed-request' },
      cost: 3,
      outcome: 'failed',
    });
    dockerPsql(`
      UPDATE kortix.studio_job_attempts
      SET status = 'failed', ended_at = clock_timestamp()
      WHERE attempt_id = '${firstAttemptId}';
    `);
    recordProductionAttemptCost({
      jobId,
      attemptId: finalAttemptId,
      leaseOwner,
      usage: { request_id: 'successful-request', output_count: 2 },
      cost: 4,
      outcome: 'succeeded',
    });

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId: finalAttemptId,
        leaseOwner,
        actualCredits: 8,
        assetCount: 2,
        objectPrefix: 'studio/production-mismatch',
      }),
    ).toMatchObject({ success: false, code: 'actual_credits_mismatch', expected: 9 });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'assets', (SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}'),
          'final_usage', (
            SELECT count(*) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          ),
          'ledger', (SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}')
        );
      `),
    ).toEqual({ status: 'running', reservation: 'active', assets: 0, final_usage: 0, ledger: 0 });

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId: finalAttemptId,
        leaseOwner,
        actualCredits: 9,
        assetCount: 2,
        objectPrefix: 'studio/production-success',
      }),
    ).toMatchObject({ success: true, outcome: 'succeeded', idempotent: false });

    const state = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'job_actual', (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
        'reservation_status', (
          SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
        ),
        'attempt_cost_sum', (
          SELECT sum(upstream_cost_credits) FROM kortix.studio_job_attempts
          WHERE job_id = '${jobId}' AND cost_recorded_at IS NOT NULL
        ),
        'usage_upstream_sum', (
          SELECT sum(upstream_cost_credits) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'
        ),
        'usage_count', (SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'),
        'final_usage', (
          SELECT jsonb_build_object(
            'attempt_id', attempt_id,
            'upstream', upstream_cost_credits,
            'final', final_cost_credits,
            'loss', platform_loss_credits,
            'outcome', outcome,
            'verified', metadata -> 'verified_upstream_cost_credits'
          ) FROM kortix.studio_usage_events
          WHERE job_id = '${jobId}' AND attempt_id IS NULL
        ),
        'asset_count', (SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}'),
        'ledger_amount', (
          SELECT amount FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'
        )
      );
    `);
    expect(state).toMatchObject({
      job_actual: 9,
      reservation_status: 'settled',
      attempt_cost_sum: 7,
      usage_upstream_sum: 7,
      usage_count: 3,
      final_usage: {
        attempt_id: null,
        upstream: 0,
        final: 9,
        loss: 0,
        outcome: 'succeeded',
        verified: 7,
      },
      asset_count: 2,
      ledger_amount: -9,
    });

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId: finalAttemptId,
        leaseOwner,
        actualCredits: 9,
        assetCount: 2,
        objectPrefix: 'studio/production-success',
      }),
    ).toMatchObject({ success: true, outcome: 'succeeded', idempotent: true });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'usage_count', (SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'),
          'ledger_count', (SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'),
          'asset_count', (SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}')
        );
      `),
    ).toEqual({ usage_count: 3, ledger_count: 1, asset_count: 2 });
  }, 30_000);

  test('rejects duplicate production output objects before charging markup', () => {
    const scope = seedProductionScope({ suffix: '09' });
    const created = createProductionJob(scope, { outputCount: 2 });
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000009';
    const leaseOwner = 'studio-worker:production-duplicate-assets';
    prepareProductionAttempt({ jobId, attemptId, leaseOwner });
    recordProductionAttemptCost({
      jobId,
      attemptId,
      leaseOwner,
      usage: { request_id: 'duplicate-output-object' },
      cost: 1,
      outcome: 'succeeded',
    });

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId,
        leaseOwner,
        actualCredits: 3,
        assetCount: 2,
        objectPrefix: 'studio/production-duplicate-assets',
        duplicateObjectKey: true,
      }),
    ).toMatchObject({ success: false });
    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId,
        leaseOwner,
        actualCredits: 4,
        assetCount: 3,
        objectPrefix: 'studio/production-over-request-assets',
      }),
    ).toMatchObject({ success: false });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'ledger_count', (
            SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'
          ),
          'asset_count', (
            SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}'
          ),
          'final_usage_count', (
            SELECT count(*) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          )
        );
      `),
    ).toEqual({
      job_status: 'running',
      reservation: 'active',
      ledger_count: 0,
      asset_count: 0,
      final_usage_count: 0,
    });
  }, 30_000);

  test('caps production success at the reservation and records only provider excess as loss', () => {
    const scope = seedProductionScope({ suffix: '04' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000004';
    const leaseOwner = 'studio-worker:production-cap';
    prepareProductionAttempt({ jobId, attemptId, leaseOwner });
    recordProductionAttemptCost({
      jobId,
      attemptId,
      leaseOwner,
      usage: { request_id: 'expensive-request' },
      cost: 10,
      outcome: 'succeeded',
    });

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId,
        leaseOwner,
        actualCredits: 11,
        assetCount: 1,
        objectPrefix: 'studio/production-cap',
      }),
    ).toMatchObject({ success: true, outcome: 'succeeded' });

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_actual', (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'ledger_amount', (
            SELECT amount FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'
          ),
          'upstream_sum', (
            SELECT sum(upstream_cost_credits) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'
          ),
          'final', (
            SELECT jsonb_build_object(
              'cost', final_cost_credits,
              'loss', platform_loss_credits,
              'verified', metadata -> 'verified_upstream_cost_credits',
              'settlement_key', metadata ->> 'settlement_key',
              'has_release_key', metadata ? 'release_key'
            ) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          )
        );
      `),
    ).toEqual({
      job_actual: 9,
      reservation_status: 'settled',
      ledger_amount: -9,
      upstream_sum: 10,
      final: {
        cost: 9,
        loss: 1,
        verified: 10,
        settlement_key: `studio:settle:${jobId}`,
        has_release_key: false,
      },
    });
  }, 30_000);

  test('settles verified production failures and releases only zero-cost failures', () => {
    const scope = seedProductionScope({ suffix: '05' });
    const chargedJob = createProductionJob(scope, {
      idempotencyKey: 'production-terminal:charged',
      requestHash: 'production-terminal:charged-hash',
    });
    const chargedJobId = String(chargedJob.job_id);
    const chargedAttemptId = '74000000-0000-4000-a000-000000000005';
    const chargedLease = 'studio-worker:production-terminal-charged';
    prepareProductionAttempt({
      jobId: chargedJobId,
      attemptId: chargedAttemptId,
      leaseOwner: chargedLease,
    });
    recordProductionAttemptCost({
      jobId: chargedJobId,
      attemptId: chargedAttemptId,
      leaseOwner: chargedLease,
      usage: { request_id: 'failed-charged' },
      cost: 4,
      outcome: 'failed',
    });
    expect(
      finalizeProductionTerminal({
        jobId: chargedJobId,
        attemptId: chargedAttemptId,
        leaseOwner: chargedLease,
        status: 'failed',
        reason: 'terminal_failure',
      }),
    ).toMatchObject({ success: true, outcome: 'failed', idempotent: false });

    const zeroJob = createProductionJob(scope, {
      idempotencyKey: 'production-terminal:zero',
      requestHash: 'production-terminal:zero-hash',
    });
    const zeroJobId = String(zeroJob.job_id);
    const zeroAttemptId = '74000000-0000-4000-a000-000000000105';
    const zeroLease = 'studio-worker:production-terminal-zero';
    prepareProductionAttempt({ jobId: zeroJobId, attemptId: zeroAttemptId, leaseOwner: zeroLease });
    expect(
      finalizeProductionTerminal({
        jobId: zeroJobId,
        attemptId: zeroAttemptId,
        leaseOwner: zeroLease,
        status: 'failed',
        reason: 'zero_cost_failure',
      }),
    ).toMatchObject({ success: true, outcome: 'failed', idempotent: false });

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'charged', (
            SELECT jsonb_build_object(
              'job_status', job.status,
              'actual', job.actual_credits,
              'reservation', reservation.status,
              'final_cost', usage.final_cost_credits,
              'upstream', usage.upstream_cost_credits,
              'loss', usage.platform_loss_credits,
              'outcome', usage.outcome
            )
            FROM kortix.studio_jobs job
            JOIN kortix.studio_credit_reservations reservation USING (job_id)
            JOIN kortix.studio_usage_events usage ON usage.job_id = job.job_id
              AND usage.attempt_id IS NULL
            WHERE job.job_id = '${chargedJobId}'
          ),
          'zero', (
            SELECT jsonb_build_object(
              'job_status', job.status,
              'actual', job.actual_credits,
              'reservation', reservation.status,
              'final_cost', usage.final_cost_credits,
              'outcome', usage.outcome
            )
            FROM kortix.studio_jobs job
            JOIN kortix.studio_credit_reservations reservation USING (job_id)
            JOIN kortix.studio_usage_events usage ON usage.job_id = job.job_id
              AND usage.attempt_id IS NULL
            WHERE job.job_id = '${zeroJobId}'
          )
        );
      `),
    ).toEqual({
      charged: {
        job_status: 'failed',
        actual: 4,
        reservation: 'settled',
        final_cost: 4,
        upstream: 0,
        loss: 0,
        outcome: 'failed',
      },
      zero: {
        job_status: 'failed',
        actual: 0,
        reservation: 'released',
        final_cost: 0,
        outcome: 'failed',
      },
    });
  }, 30_000);

  test('settles a positive verified cost against a zero reservation without a zero-value debit', () => {
    const scope = seedProductionScope({
      suffix: '07',
      maxProviderCredits: 0,
      markupCredits: 0,
    });
    const created = createProductionJob(scope);
    expect(created).toMatchObject({ success: true, reserved: 0 });
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000007';
    const leaseOwner = 'studio-worker:production-zero-cap';
    prepareProductionAttempt({ jobId, attemptId, leaseOwner });
    recordProductionAttemptCost({
      jobId,
      attemptId,
      leaseOwner,
      usage: { request_id: 'unexpected-positive-cost' },
      cost: 1.25,
      outcome: 'failed',
    });

    expect(
      finalizeProductionTerminal({
        jobId,
        attemptId,
        leaseOwner,
        status: 'failed',
        reason: 'zero_cap_failure',
      }),
    ).toMatchObject({ success: true, outcome: 'failed', idempotent: false });

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_actual', (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'reservation', (
            SELECT jsonb_build_object('status', status, 'settlement_key', settlement_key)
            FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'ledger_count', (
            SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'
          ),
          'final', (
            SELECT jsonb_build_object(
              'cost', final_cost_credits,
              'loss', platform_loss_credits,
              'verified', metadata -> 'verified_upstream_cost_credits',
              'settlement_key', metadata ->> 'settlement_key',
              'has_release_key', metadata ? 'release_key'
            ) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          )
        );
      `),
    ).toEqual({
      job_actual: 0,
      reservation: { status: 'settled', settlement_key: `studio:settle:${jobId}` },
      ledger_count: 0,
      final: {
        cost: 0,
        loss: 1.25,
        verified: 1.25,
        settlement_key: `studio:settle:${jobId}`,
        has_release_key: false,
      },
    });
  }, 30_000);

  test('settles verified cost at the production success cancellation fence without assets', () => {
    const scope = seedProductionScope({ suffix: '06' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000006';
    const leaseOwner = 'studio-worker:production-cancel';
    prepareProductionAttempt({ jobId, attemptId, leaseOwner });
    recordProductionAttemptCost({
      jobId,
      attemptId,
      leaseOwner,
      usage: { request_id: 'cancelled-after-cost' },
      cost: 2,
      outcome: 'cancelled',
    });
    dockerPsql(`
      UPDATE kortix.studio_jobs
      SET cancellation_requested_at = clock_timestamp()
      WHERE job_id = '${jobId}';
    `);

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId,
        leaseOwner,
        actualCredits: 999,
        assetCount: 1,
        objectPrefix: 'studio/production-cancel-must-not-exist',
      }),
    ).toMatchObject({ success: true, outcome: 'cancelled', idempotent: false });

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object('status', status, 'actual', actual_credits)
            FROM kortix.studio_jobs WHERE job_id = '${jobId}'
          ),
          'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'asset_count', (SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}'),
          'upstream_sum', (
            SELECT sum(upstream_cost_credits) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'
          ),
          'final', (
            SELECT jsonb_build_object(
              'cost', final_cost_credits,
              'loss', platform_loss_credits,
              'outcome', outcome,
              'verified', metadata -> 'verified_upstream_cost_credits'
            ) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          )
        );
      `),
    ).toEqual({
      job: { status: 'cancelled', actual: 2 },
      reservation: 'settled',
      asset_count: 0,
      upstream_sum: 2,
      final: { cost: 2, loss: 0, outcome: 'cancelled', verified: 2 },
    });

    expect(
      finalizeProductionSuccess({
        jobId,
        attemptId,
        leaseOwner,
        actualCredits: 999,
        assetCount: 1,
        objectPrefix: 'studio/production-cancel-must-not-exist',
      }),
    ).toMatchObject({ success: true, outcome: 'cancelled', idempotent: true });
  }, 30_000);

  test('recovers a confirmed success and replays the stored result byte-for-byte', () => {
    const scope = seedProductionScope({ suffix: '10' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000010';
    const leaseOwner = 'studio-worker:recovery-success';
    const manifestKey = `staging/${jobId}/manifest.json`;
    const manifestChecksum = 'a'.repeat(64);
    const evidence = {
      staging_manifest_key: manifestKey,
      staging_manifest_checksum: manifestChecksum,
      provider_request_id: 'provider-recovery-success',
      upstream_usage: { output_count: 1 },
      upstream_cost_credits: 2,
    };
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner,
      manifestKey,
      manifestChecksum,
    });
    clearStudioLease(jobId);

    const call = {
      projectId: scope.projectId,
      jobId,
      attemptId,
      decision: 'confirm_succeeded' as const,
      idempotencyKey: 'recovery-success-key-00000010',
      requestHash: 'recovery-success-hash-10',
      evidence,
      resultAssets: recoveryAssets(`studio/recovery/${jobId}/result.png`),
      actualCredits: 3,
    };
    const first = recoverProductionJob(call);
    expect(first).toMatchObject({
      job_id: jobId,
      attempt_id: attemptId,
      decision: 'confirm_succeeded',
      job_status: 'succeeded',
      attempt_status: 'succeeded',
      reservation_status: 'settled',
      hold_expires_at: null,
    });
    expect(first.recovery_id).toEqual(expect.any(String));

    const replay = recoverProductionJob(call);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(recoverProductionJob({ ...call, projectId: SUCCESS_PROJECT_ID })).toMatchObject({
      success: false,
      code: 'recovery_job_not_found',
    });
    expect(
      recoverProductionJob({ ...call, requestHash: 'different-recovery-success-hash' }),
    ).toMatchObject({ success: false, code: 'recovery_conflict' });

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object('status', status, 'actual', actual_credits)
            FROM kortix.studio_jobs WHERE job_id = '${jobId}'
          ),
          'attempt', (
            SELECT jsonb_build_object(
              'status', status,
              'cost', upstream_cost_credits,
              'outcome', cost_outcome
            ) FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
          ),
          'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          ),
          'attempt_usage', (
            SELECT count(*) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id = '${attemptId}'
          ),
          'final_usage', (
            SELECT count(*) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          ),
          'assets', (
            SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}'
          ),
          'stored_result', (
            SELECT result FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({
      job: { status: 'succeeded', actual: 3 },
      attempt: { status: 'succeeded', cost: 2, outcome: 'succeeded' },
      reservation: 'settled',
      recoveries: 1,
      attempt_usage: 1,
      final_usage: 1,
      assets: 1,
      stored_result: first,
    });
  }, 30_000);

  test('reuses an identical immutable unknown cost observation during success recovery', () => {
    const scope = seedProductionScope({ suffix: '16' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000016';
    const leaseOwner = 'studio-worker:recovery-unknown-cost';
    const manifestKey = `staging/${jobId}/manifest.json`;
    const manifestChecksum = 'b'.repeat(64);
    const usage = { output_count: 1, provider_request_id: 'unknown-cost' };
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner,
      manifestKey,
      manifestChecksum,
    });
    recordProductionAttemptCost({
      jobId,
      attemptId,
      leaseOwner,
      usage,
      cost: 2,
      outcome: 'unknown',
    });
    const before = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'recorded_at', cost_recorded_at,
        'usage_count', (
          SELECT count(*) FROM kortix.studio_usage_events
          WHERE job_id = '${jobId}' AND attempt_id = '${attemptId}'
        )
      ) FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}';
    `);
    clearStudioLease(jobId);

    const base = {
      projectId: scope.projectId,
      jobId,
      attemptId,
      decision: 'confirm_succeeded' as const,
      evidence: {
        staging_manifest_key: manifestKey,
        staging_manifest_checksum: manifestChecksum,
        upstream_usage: usage,
        upstream_cost_credits: 2,
      },
      resultAssets: recoveryAssets(`studio/recovery/${jobId}/unknown.png`),
      actualCredits: 3,
    };
    expect(
      recoverProductionJob({
        ...base,
        idempotencyKey: 'recovery-unknown-mismatch-key-16',
        requestHash: 'recovery-unknown-mismatch-hash-16',
        evidence: { ...base.evidence, upstream_cost_credits: 3 },
        actualCredits: 4,
      }),
    ).toMatchObject({ success: false, code: 'attempt_cost_conflict' });

    expect(
      recoverProductionJob({
        ...base,
        idempotencyKey: 'recovery-unknown-success-key-16',
        requestHash: 'recovery-unknown-success-hash-16',
      }),
    ).toMatchObject({ decision: 'confirm_succeeded', job_status: 'succeeded' });

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'outcome', cost_outcome,
          'recorded_at', cost_recorded_at,
          'usage_count', (
            SELECT count(*) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id = '${attemptId}'
          ),
          'recovery_count', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          )
        ) FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}';
      `),
    ).toEqual({
      outcome: 'unknown',
      recorded_at: before.recorded_at,
      usage_count: 1,
      recovery_count: 1,
    });
  }, 30_000);

  test('rejects a negative recovery cost before fixed-scale normalization', () => {
    const scope = seedProductionScope({ suffix: '17' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000017';
    const manifestKey = `staging/${jobId}/manifest.json`;
    const manifestChecksum = '4'.repeat(64);
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:recovery-negative-cost',
      manifestKey,
      manifestChecksum,
    });
    clearStudioLease(jobId);

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'confirm_succeeded',
        idempotencyKey: 'recovery-negative-cost-key-17',
        requestHash: 'recovery-negative-cost-hash-17',
        evidence: {
          staging_manifest_key: manifestKey,
          staging_manifest_checksum: manifestChecksum,
          upstream_usage: { output_count: 1 },
          upstream_cost_credits: -0.00001,
        },
        resultAssets: recoveryAssets(`studio/recovery/${jobId}/negative-cost.png`),
        actualCredits: 1,
      }),
    ).toMatchObject({ success: false, code: 'recovery_cost_invalid' });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'attempt_recorded_at', (
            SELECT cost_recorded_at FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
          ),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({
      job_status: 'running',
      attempt_recorded_at: null,
      reservation_status: 'active',
      recoveries: 0,
    });
  }, 30_000);

  test('rejects nested negative recovery usage before recording immutable cost', () => {
    const scope = seedProductionScope({ suffix: '20' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000020';
    const manifestKey = `staging/${jobId}/manifest.json`;
    const manifestChecksum = '5'.repeat(64);
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:recovery-nested-negative',
      manifestKey,
      manifestChecksum,
    });
    clearStudioLease(jobId);

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'confirm_succeeded',
        idempotencyKey: 'recovery-nested-negative-key-20',
        requestHash: 'recovery-nested-negative-hash-20',
        evidence: {
          staging_manifest_key: manifestKey,
          staging_manifest_checksum: manifestChecksum,
          upstream_usage: { output: { billable_count: -1 } },
          upstream_cost_credits: 0,
        },
        resultAssets: recoveryAssets(`studio/recovery/${jobId}/nested-negative.png`),
        actualCredits: 1,
      }),
    ).toMatchObject({ success: false, code: 'recovery_cost_invalid' });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'attempt_recorded_at', (
            SELECT cost_recorded_at FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({ job_status: 'running', attempt_recorded_at: null, recoveries: 0 });
  }, 30_000);

  test('rejects non-finite and out-of-window recovery timestamps without mutation', () => {
    const scope = seedProductionScope({ suffix: '18' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000018';
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:recovery-time-fence',
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: '6'.repeat(64),
    });
    clearStudioLease(jobId);
    const base = {
      projectId: scope.projectId,
      jobId,
      attemptId,
      decision: 'confirm_not_created' as const,
      evidence: {},
    };

    for (const [suffix, recoveredAtSql] of [
      ['infinity', "'infinity'::timestamptz"],
      ['negative-infinity', "'-infinity'::timestamptz"],
      ['future', "clock_timestamp() + interval '1 day'"],
      ['stale', "clock_timestamp() - interval '1 day'"],
    ] as const) {
      expect(
        recoverProductionJob({
          ...base,
          idempotencyKey: `recovery-invalid-time-key-18-${suffix}`,
          requestHash: `recovery-invalid-time-hash-18-${suffix}`,
          recoveredAtSql,
        }),
      ).toMatchObject({ success: false, code: 'recovery_time_invalid' });
    }
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'attempt_status', (
            SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
          ),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({
      job_status: 'running',
      attempt_status: 'reconciling',
      reservation_status: 'active',
      recoveries: 0,
    });
  }, 30_000);

  test('rejects an invalid reservation creation time at recovery and expiry', () => {
    const scope = seedProductionScope({ suffix: '21' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000021';
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:recovery-reservation-time',
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: '7'.repeat(64),
    });
    clearStudioLease(jobId);
    dockerPsql(`
      ALTER TABLE kortix.studio_credit_reservations
        DROP CONSTRAINT IF EXISTS studio_credit_reservations_created_at_finite_check;
      ALTER TABLE kortix.studio_credit_reservations ALTER COLUMN created_at DROP NOT NULL;
    `);
    try {
      for (const [suffix, createdAtSql] of [
        ['missing', 'NULL::timestamptz'],
        ['infinity', "'infinity'::timestamptz"],
        ['negative-infinity', "'-infinity'::timestamptz"],
        ['future', "clock_timestamp() + interval '1 year'"],
      ] as const) {
        dockerPsql(`
          UPDATE kortix.studio_credit_reservations
          SET created_at = ${createdAtSql}
          WHERE job_id = '${jobId}';
        `);
        expect(
          recoverProductionJob({
            projectId: scope.projectId,
            jobId,
            attemptId,
            decision: 'keep_unknown',
            idempotencyKey: `recovery-invalid-reservation-time-key-21-${suffix}`,
            requestHash: `recovery-invalid-reservation-time-hash-21-${suffix}`,
            keepUnknownUntilSql: "clock_timestamp() + interval '24 hours'",
          }),
        ).toMatchObject({ success: false, code: 'recovery_reservation_time_invalid' });
      }
      expect(expireUnknownHold({ jobId, attemptId })).toMatchObject({
        success: false,
        code: 'expiry_reservation_time_invalid',
      });
    } finally {
      dockerPsql(`
        UPDATE kortix.studio_credit_reservations
        SET created_at = clock_timestamp()
        WHERE job_id = '${jobId}';
        ALTER TABLE kortix.studio_credit_reservations ALTER COLUMN created_at SET NOT NULL;
        ALTER TABLE kortix.studio_credit_reservations
          ADD CONSTRAINT studio_credit_reservations_created_at_finite_check
          CHECK (created_at NOT IN ('infinity'::timestamptz, '-infinity'::timestamptz));
      `);
    }
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({ job_status: 'running', recoveries: 0 });
  }, 30_000);

  test('confirms not-created with earlier cost, zero-cost release, and current-cost rejection', () => {
    const scope = seedProductionScope({ suffix: '11' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const earlierAttemptId = '74000000-0000-4000-a000-000000001101';
    const currentAttemptId = '74000000-0000-4000-a000-000000001102';
    const earlierLease = 'studio-worker:not-created-earlier';
    prepareProductionAttempt({ jobId, attemptId: earlierAttemptId, leaseOwner: earlierLease });
    recordProductionAttemptCost({
      jobId,
      attemptId: earlierAttemptId,
      leaseOwner: earlierLease,
      usage: { request_id: 'earlier-failed-attempt' },
      cost: 1.25,
      outcome: 'failed',
    });
    dockerPsql(`
      UPDATE kortix.studio_job_attempts
      SET status = 'failed', ended_at = clock_timestamp()
      WHERE attempt_id = '${earlierAttemptId}';
    `);
    prepareRecoveryAttempt({
      jobId,
      attemptId: currentAttemptId,
      leaseOwner: 'studio-worker:not-created-current',
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: 'c'.repeat(64),
    });
    clearStudioLease(jobId);

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId: currentAttemptId,
        decision: 'confirm_not_created',
        idempotencyKey: 'recovery-not-created-cost-key-11',
        requestHash: 'recovery-not-created-cost-hash-11',
        evidence: { provider_request_id: 'confirmed-absent' },
      }),
    ).toMatchObject({
      decision: 'confirm_not_created',
      job_status: 'failed',
      attempt_status: 'failed',
      reservation_status: 'settled',
    });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object(
              'status', status, 'actual', actual_credits, 'error_code', error_code
            ) FROM kortix.studio_jobs WHERE job_id = '${jobId}'
          ),
          'attempt', (
            SELECT jsonb_build_object(
              'status', status, 'retry', retry_classification
            ) FROM kortix.studio_job_attempts WHERE attempt_id = '${currentAttemptId}'
          ),
          'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({
      job: {
        status: 'failed',
        actual: 1.25,
        error_code: 'STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED',
      },
      attempt: { status: 'failed', retry: 'unknown_outcome' },
      reservation: 'settled',
    });

    const zeroCreated = createProductionJob(scope, {
      idempotencyKey: 'production-create:not-created-zero-11',
      requestHash: 'production-hash:not-created-zero-11',
    });
    const zeroJobId = String(zeroCreated.job_id);
    const zeroAttemptId = '74000000-0000-4000-a000-000000001103';
    prepareRecoveryAttempt({
      jobId: zeroJobId,
      attemptId: zeroAttemptId,
      leaseOwner: 'studio-worker:not-created-zero',
      manifestKey: `staging/${zeroJobId}/manifest.json`,
      manifestChecksum: 'd'.repeat(64),
    });
    clearStudioLease(zeroJobId);
    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId: zeroJobId,
        attemptId: zeroAttemptId,
        decision: 'confirm_not_created',
        idempotencyKey: 'recovery-not-created-zero-key-11',
        requestHash: 'recovery-not-created-zero-hash-11',
      }),
    ).toMatchObject({ reservation_status: 'released', job_status: 'failed' });

    const rejectedCreated = createProductionJob(scope, {
      idempotencyKey: 'production-create:not-created-current-cost-11',
      requestHash: 'production-hash:not-created-current-cost-11',
    });
    const rejectedJobId = String(rejectedCreated.job_id);
    const rejectedAttemptId = '74000000-0000-4000-a000-000000001104';
    const rejectedLease = 'studio-worker:not-created-current-cost';
    prepareRecoveryAttempt({
      jobId: rejectedJobId,
      attemptId: rejectedAttemptId,
      leaseOwner: rejectedLease,
      manifestKey: `staging/${rejectedJobId}/manifest.json`,
      manifestChecksum: 'e'.repeat(64),
    });
    recordProductionAttemptCost({
      jobId: rejectedJobId,
      attemptId: rejectedAttemptId,
      leaseOwner: rejectedLease,
      usage: { request_id: 'positive-current-attempt' },
      cost: 0.5,
      outcome: 'unknown',
    });
    clearStudioLease(rejectedJobId);
    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId: rejectedJobId,
        attemptId: rejectedAttemptId,
        decision: 'confirm_not_created',
        idempotencyKey: 'recovery-not-created-rejected-key-11',
        requestHash: 'recovery-not-created-rejected-hash-11',
      }),
    ).toMatchObject({ success: false, code: 'current_attempt_cost_positive' });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${rejectedJobId}'),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${rejectedJobId}'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${rejectedJobId}'
          )
        );
      `),
    ).toEqual({ job_status: 'running', reservation_status: 'active', recoveries: 0 });
  }, 30_000);

  test('keeps an unknown hold monotonically and enforces seven-day and thirty-day caps', () => {
    const scope = seedProductionScope({ suffix: '12' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000012';
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:keep-unknown',
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: 'f'.repeat(64),
    });
    clearStudioLease(jobId);
    dockerPsql(`
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '1 day',
          expires_at = clock_timestamp() + interval '1 hour'
      WHERE job_id = '${jobId}';
    `);

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'keep_unknown',
        idempotencyKey: 'recovery-keep-unknown-key-12a',
        requestHash: 'recovery-keep-unknown-hash-12a',
        keepUnknownUntilSql: "clock_timestamp() + interval '24 hours'",
      }),
    ).toMatchObject({
      decision: 'keep_unknown',
      job_status: 'running',
      attempt_status: 'reconciling',
      reservation_status: 'active',
    });
    const firstHold = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'expires_at', expires_at,
        'available_at', (SELECT available_at FROM kortix.studio_jobs WHERE job_id = '${jobId}')
      ) FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}';
    `);

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'keep_unknown',
        idempotencyKey: 'recovery-keep-unknown-key-12b',
        requestHash: 'recovery-keep-unknown-hash-12b',
        keepUnknownUntilSql: "clock_timestamp() + interval '12 hours'",
      }),
    ).toMatchObject({ success: false, code: 'hold_not_extended' });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'expires_at', expires_at,
          'available_at', (SELECT available_at FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'progress_events', (
            SELECT count(*) FROM kortix.studio_job_events
            WHERE job_id = '${jobId}' AND event_type = 'progress'
              AND payload ->> 'phase' = 'operator-review'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          ),
          'usage_events', (
            SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'
          )
        ) FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}';
      `),
    ).toEqual({ ...firstHold, progress_events: 1, recoveries: 1, usage_events: 0 });

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'keep_unknown',
        idempotencyKey: 'recovery-keep-unknown-key-12c',
        requestHash: 'recovery-keep-unknown-hash-12c',
        keepUnknownUntilSql: "clock_timestamp() + interval '8 days'",
      }),
    ).toMatchObject({ success: false, code: 'hold_extension_too_long' });

    dockerPsql(`
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '29 days'
      WHERE job_id = '${jobId}';
    `);
    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'keep_unknown',
        idempotencyKey: 'recovery-keep-unknown-key-12d',
        requestHash: 'recovery-keep-unknown-hash-12d',
        keepUnknownUntilSql: "clock_timestamp() + interval '2 days'",
      }),
    ).toMatchObject({ success: false, code: 'hold_cumulative_cap_exceeded' });

    dockerPsql(`
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '30 days',
          expires_at = clock_timestamp()
      WHERE job_id = '${jobId}';
    `);
    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId,
        decision: 'keep_unknown',
        idempotencyKey: 'recovery-keep-unknown-key-12e',
        requestHash: 'recovery-keep-unknown-hash-12e',
        keepUnknownUntilSql: "clock_timestamp() + interval '1 hour'",
      }),
    ).toMatchObject({ success: false, code: 'hold_cap_reached' });
  }, 30_000);

  test('rejects a sub-scale negative provider maximum before unknown-hold expiry', () => {
    const scope = seedProductionScope({ suffix: '19' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000019';
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:expiry-negative-maximum',
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: '8'.repeat(64),
    });
    clearStudioLease(jobId);
    dockerPsql(`
      UPDATE kortix.studio_jobs
      SET pricing_snapshot = jsonb_set(
        pricing_snapshot,
        '{max_provider_credits}',
        '-0.00001'::jsonb
      )
      WHERE job_id = '${jobId}';
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '31 days',
          expires_at = clock_timestamp() - interval '1 day'
      WHERE job_id = '${jobId}';
    `);

    expect(expireUnknownHold({ jobId, attemptId })).toMatchObject({
      success: false,
      code: 'expiry_pricing_invalid',
    });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'incidents', (
            SELECT count(*) FROM kortix.studio_billing_incidents WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({ job_status: 'running', reservation_status: 'active', incidents: 0 });
  }, 30_000);

  test('settles a large multi-attempt recovery aggregate without numeric overflow', () => {
    const scope = seedProductionScope({ suffix: '22' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const earlierAttemptId = '74000000-0000-4000-a000-000000002201';
    const currentAttemptId = '74000000-0000-4000-a000-000000002202';
    const earlierLease = 'studio-worker:large-recovery-earlier';
    const currentLease = 'studio-worker:large-recovery-current';
    const manifestKey = `staging/${jobId}/manifest.json`;
    const manifestChecksum = '9'.repeat(64);

    prepareProductionAttempt({ jobId, attemptId: earlierAttemptId, leaseOwner: earlierLease });
    recordProductionAttemptCost({
      jobId,
      attemptId: earlierAttemptId,
      leaseOwner: earlierLease,
      usage: { request_id: 'large-recovery-earlier' },
      cost: 60_000_000,
      outcome: 'failed',
    });
    dockerPsql(`
      UPDATE kortix.studio_job_attempts
      SET status = 'failed', ended_at = clock_timestamp()
      WHERE attempt_id = '${earlierAttemptId}';
    `);
    prepareRecoveryAttempt({
      jobId,
      attemptId: currentAttemptId,
      leaseOwner: currentLease,
      manifestKey,
      manifestChecksum,
    });
    recordProductionAttemptCost({
      jobId,
      attemptId: currentAttemptId,
      leaseOwner: currentLease,
      usage: { request_id: 'large-recovery-current' },
      cost: 60_000_000,
      outcome: 'unknown',
    });
    clearStudioLease(jobId);

    expect(
      recoverProductionJob({
        projectId: scope.projectId,
        jobId,
        attemptId: currentAttemptId,
        decision: 'confirm_succeeded',
        idempotencyKey: 'recovery-large-aggregate-key-22',
        requestHash: 'recovery-large-aggregate-hash-22',
        evidence: {
          staging_manifest_key: manifestKey,
          staging_manifest_checksum: manifestChecksum,
          upstream_usage: { request_id: 'large-recovery-current' },
          upstream_cost_credits: 60_000_000,
        },
        resultAssets: recoveryAssets(`studio/recovery/${jobId}/large.png`),
        actualCredits: 120_000_001,
      }),
    ).toMatchObject({ job_status: 'succeeded', reservation_status: 'settled' });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'actual', (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'verified', (
            SELECT metadata -> 'verified_upstream_cost_credits'
            FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          ),
          'loss', (
            SELECT platform_loss_credits FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          ),
          'ledger_amount', (
            SELECT amount FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'
          )
        );
      `),
    ).toEqual({
      actual: 9,
      verified: 120_000_000,
      loss: 119_999_991,
      ledger_amount: -9,
    });
  }, 30_000);

  test('expires a large multi-attempt aggregate without leaving the hold active', () => {
    const scope = seedProductionScope({ suffix: '23' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const earlierAttemptId = '74000000-0000-4000-a000-000000002301';
    const currentAttemptId = '74000000-0000-4000-a000-000000002302';
    const earlierLease = 'studio-worker:large-expiry-earlier';
    const currentLease = 'studio-worker:large-expiry-current';

    prepareProductionAttempt({ jobId, attemptId: earlierAttemptId, leaseOwner: earlierLease });
    recordProductionAttemptCost({
      jobId,
      attemptId: earlierAttemptId,
      leaseOwner: earlierLease,
      usage: { request_id: 'large-expiry-earlier' },
      cost: 60_000_000,
      outcome: 'failed',
    });
    dockerPsql(`
      UPDATE kortix.studio_job_attempts
      SET status = 'failed', ended_at = clock_timestamp()
      WHERE attempt_id = '${earlierAttemptId}';
    `);
    prepareRecoveryAttempt({
      jobId,
      attemptId: currentAttemptId,
      leaseOwner: currentLease,
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: 'a'.repeat(64),
    });
    recordProductionAttemptCost({
      jobId,
      attemptId: currentAttemptId,
      leaseOwner: currentLease,
      usage: { request_id: 'large-expiry-current' },
      cost: 60_000_000,
      outcome: 'unknown',
    });
    clearStudioLease(jobId);
    dockerPsql(`
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '31 days',
          expires_at = clock_timestamp() - interval '1 day'
      WHERE job_id = '${jobId}';
    `);

    expect(expireUnknownHold({ jobId, attemptId: currentAttemptId })).toMatchObject({
      verified_cost_credits: 120_000_000,
      potential_liability_credits: 0,
    });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'actual', (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = '${jobId}'),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'loss', (
            SELECT platform_loss_credits FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          ),
          'incidents', (
            SELECT count(*) FROM kortix.studio_billing_incidents WHERE job_id = '${jobId}'
          )
        );
      `),
    ).toEqual({
      job_status: 'failed',
      actual: 9,
      reservation_status: 'settled',
      loss: 119_999_991,
      incidents: 1,
    });
  }, 30_000);

  test('expires unknown holds with verified-cost settlement, zero-cost release, and one incident', () => {
    const scope = seedProductionScope({ suffix: '13' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000013';
    const leaseOwner = 'studio-worker:expire-positive';
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner,
      manifestKey: `staging/${jobId}/manifest.json`,
      manifestChecksum: '1'.repeat(64),
      status: 'polling',
    });
    recordProductionAttemptCost({
      jobId,
      attemptId,
      leaseOwner,
      usage: { request_id: 'expiry-positive' },
      cost: 2,
      outcome: 'unknown',
    });
    clearStudioLease(jobId);

    expect(expireUnknownHold({ jobId, attemptId })).toMatchObject({
      success: false,
      code: 'hold_not_expired',
    });
    dockerPsql(`
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '31 days',
          expires_at = clock_timestamp() - interval '1 day'
      WHERE job_id = '${jobId}';
    `);
    expect(
      expireUnknownHold({
        jobId,
        attemptId,
        expiredAtSql: "clock_timestamp() + interval '1 hour'",
      }),
    ).toMatchObject({ success: false, code: 'expiry_in_future' });

    const expired = expireUnknownHold({ jobId, attemptId });
    expect(expired).toMatchObject({
      job_id: jobId,
      attempt_id: attemptId,
      kind: 'unknown_outcome_hold_expired',
      status: 'open',
      verified_cost_credits: 2,
      potential_liability_credits: 6,
    });
    expect(expired.incident_id).toEqual(expect.any(String));
    expect(
      expireUnknownHold({
        jobId,
        attemptId,
        expiredAtSql: "clock_timestamp() + interval '1 hour'",
      }),
    ).toEqual(expired);

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object('status', status, 'actual', actual_credits, 'code', error_code)
            FROM kortix.studio_jobs WHERE job_id = '${jobId}'
          ),
          'attempt_status', (
            SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
          ),
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'incident', (
            SELECT jsonb_build_object(
              'count', count(*),
              'resolved_at', max(resolved_at),
              'resolved_by', max(resolved_by_user_id::text),
              'resolution_count', count(*) FILTER (WHERE resolution IS NOT NULL)
            ) FROM kortix.studio_billing_incidents WHERE job_id = '${jobId}'
          ),
          'final_usage', (
            SELECT jsonb_build_object('cost', final_cost_credits, 'loss', platform_loss_credits)
            FROM kortix.studio_usage_events WHERE job_id = '${jobId}' AND attempt_id IS NULL
          )
        );
      `),
    ).toEqual({
      job: {
        status: 'failed',
        actual: 2,
        code: 'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED',
      },
      attempt_status: 'failed',
      reservation_status: 'settled',
      incident: { count: 1, resolved_at: null, resolved_by: null, resolution_count: 0 },
      final_usage: { cost: 2, loss: 0 },
    });

    const zeroScope = seedProductionScope({ suffix: '14' });
    const zeroCreated = createProductionJob(zeroScope);
    const zeroJobId = String(zeroCreated.job_id);
    const zeroAttemptId = '74000000-0000-4000-a000-000000000014';
    prepareRecoveryAttempt({
      jobId: zeroJobId,
      attemptId: zeroAttemptId,
      leaseOwner: 'studio-worker:expire-zero',
      manifestKey: `staging/${zeroJobId}/manifest.json`,
      manifestChecksum: '2'.repeat(64),
    });
    clearStudioLease(zeroJobId);
    dockerPsql(`
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '31 days',
          expires_at = clock_timestamp() - interval '1 day'
      WHERE job_id = '${zeroJobId}';
    `);
    expect(expireUnknownHold({ jobId: zeroJobId, attemptId: zeroAttemptId })).toMatchObject({
      status: 'open',
      verified_cost_credits: 0,
      potential_liability_credits: 8,
    });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'reservation_status', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${zeroJobId}'
          ),
          'ledger_count', (
            SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${zeroScope.accountId}'
          ),
          'incident_count', (
            SELECT count(*) FROM kortix.studio_billing_incidents WHERE job_id = '${zeroJobId}'
          )
        );
      `),
    ).toEqual({ reservation_status: 'released', ledger_count: 0, incident_count: 1 });
  }, 30_000);

  test('maintenance preserves 15-minute recovery decisions and expires 30-day holds idempotently', async () => {
    const database = createDb(postgresUrl('testdb'), { max: 2 });
    const client = (
      database as unknown as {
        $client: {
          unsafe(text: string, values?: never[]): Promise<Iterable<Record<string, unknown>>>;
          end(options?: unknown): Promise<void>;
        };
      }
    ).$client;
    const sqlClient: StudioSqlClient = {
      async unsafe(text, values = []) {
        return Array.from(await client.unsafe(text, values as never[]));
      },
    };
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-maintenance-recovery', ready: true });
    const stager = new StudioResultStager(store);
    const now = new Date(Date.now() - 1_000);
    const recovery = new StudioRecoveryService({
      repository: createDrizzleStudioRecoveryRepository(database),
      store,
      now: () => now,
    });
    const maintenance = new StudioMaintenanceCoordinator({
      repository: new PostgresStudioMaintenanceRepository(sqlClient),
      ownerId: 'studio-maintenance:recovery-matrix',
      lockKey: 'studio-maintenance:recovery-matrix',
      ttlMs: 60_000,
      now: () => now,
    });

    try {
    const successScope = seedProductionScope({ suffix: '24' });
    const notCreatedScope = seedProductionScope({ suffix: '25' });
    const keepUnknownScope = seedProductionScope({ suffix: '26' });
    const expiryScope = seedProductionScope({ suffix: '27' });
    const ordinaryPollingScope = seedProductionScope({ suffix: '28' });
    const successJobId = String(createProductionJob(successScope).job_id);
    const notCreatedJobId = String(createProductionJob(notCreatedScope).job_id);
    const keepUnknownJobId = String(createProductionJob(keepUnknownScope).job_id);
    const expiryJobId = String(createProductionJob(expiryScope).job_id);
    const ordinaryPollingJobId = String(createProductionJob(ordinaryPollingScope).job_id);
    const successAttemptId = '74000000-0000-4000-a000-000000000024';
    const notCreatedAttemptId = '74000000-0000-4000-a000-000000000025';
    const keepUnknownAttemptId = '74000000-0000-4000-a000-000000000026';
    const expiryAttemptId = '74000000-0000-4000-a000-000000000027';
    const ordinaryPollingAttemptId = '74000000-0000-4000-a000-000000000028';
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const staged = await stager.stage({
      accountId: successScope.accountId,
      projectId: successScope.projectId,
      jobId: successJobId,
      attemptId: successAttemptId,
      submissionKey: `submission:${successAttemptId}`,
      providerConfigId: successScope.providerId,
      providerConfigVersion: successScope.providerVersion,
      pricingCatalogId: successScope.pricingId,
      pricingVersion: 1,
      assets: [
        {
          kind: 'image',
          filename: 'maintenance-recovered.png',
          mime_type: 'image/png',
          size_bytes: png.byteLength,
          replayable_within_attempt: true,
          openBody: async () => new Blob([png]).stream(),
        },
      ],
      usage: { output_count: 1 },
    });

    prepareRecoveryAttempt({
      jobId: successJobId,
      attemptId: successAttemptId,
      leaseOwner: 'studio-worker:maintenance-success',
      manifestKey: staged.manifestKey,
      manifestChecksum: staged.manifestChecksum,
    });
    prepareRecoveryAttempt({
      jobId: notCreatedJobId,
      attemptId: notCreatedAttemptId,
      leaseOwner: 'studio-worker:maintenance-not-created',
      manifestKey: `staging/${notCreatedJobId}/manifest.json`,
      manifestChecksum: '4'.repeat(64),
    });
    prepareRecoveryAttempt({
      jobId: keepUnknownJobId,
      attemptId: keepUnknownAttemptId,
      leaseOwner: 'studio-worker:maintenance-keep-unknown',
      manifestKey: `staging/${keepUnknownJobId}/manifest.json`,
      manifestChecksum: '5'.repeat(64),
    });
    prepareRecoveryAttempt({
      jobId: expiryJobId,
      attemptId: expiryAttemptId,
      leaseOwner: 'studio-worker:maintenance-expiry',
      manifestKey: `staging/${expiryJobId}/manifest.json`,
      manifestChecksum: '6'.repeat(64),
      status: 'polling',
    });
    prepareProductionAttempt({
      jobId: ordinaryPollingJobId,
      attemptId: ordinaryPollingAttemptId,
      leaseOwner: 'studio-worker:maintenance-ordinary-polling',
      status: 'polling',
    });
    recordProductionAttemptCost({
      jobId: expiryJobId,
      attemptId: expiryAttemptId,
      leaseOwner: 'studio-worker:maintenance-expiry',
      usage: { output_count: 1 },
      cost: 2,
      outcome: 'unknown',
    });
    dockerPsql(`
      UPDATE kortix.studio_jobs
      SET available_at = clock_timestamp() - interval '16 minutes',
          lease_expires_at = clock_timestamp() - interval '1 minute'
      WHERE job_id IN (
        '${successJobId}', '${notCreatedJobId}', '${keepUnknownJobId}',
        '${expiryJobId}', '${ordinaryPollingJobId}'
      );
      UPDATE kortix.studio_job_attempts
      SET started_at = clock_timestamp() - interval '16 minutes'
      WHERE attempt_id IN (
        '${successAttemptId}', '${notCreatedAttemptId}',
        '${keepUnknownAttemptId}', '${expiryAttemptId}', '${ordinaryPollingAttemptId}'
      );
      UPDATE kortix.studio_credit_reservations
      SET created_at = clock_timestamp() - interval '31 days',
          expires_at = clock_timestamp() - interval '1 day'
      WHERE job_id IN ('${expiryJobId}', '${ordinaryPollingJobId}');
    `);
    clearStudioLease(expiryJobId);
    clearStudioLease(ordinaryPollingJobId);

    expect(await maintenance.runOnce()).toEqual({ acquired: true, tasksRun: 5 });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'recoverable_jobs', (
            SELECT count(*) FROM kortix.studio_jobs
            WHERE job_id IN ('${successJobId}', '${notCreatedJobId}', '${keepUnknownJobId}')
              AND status = 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL
          ),
          'recoverable_attempts', (
            SELECT count(*) FROM kortix.studio_job_attempts
            WHERE attempt_id IN (
              '${successAttemptId}', '${notCreatedAttemptId}', '${keepUnknownAttemptId}'
            ) AND status = 'reconciling'
          ),
          'operator_review_events', (
            SELECT count(*) FROM kortix.studio_job_events
            WHERE job_id IN (
              '${successJobId}', '${notCreatedJobId}', '${keepUnknownJobId}', '${expiryJobId}'
            )
              AND event_type = 'progress' AND payload ->> 'phase' = 'operator-review'
          ),
          'polling_unknown_review_events', (
            SELECT count(*) FROM kortix.studio_job_events
            WHERE job_id = '${expiryJobId}'
              AND event_type = 'progress' AND payload ->> 'phase' = 'operator-review'
          ),
          'ordinary_polling_review_events', (
            SELECT count(*) FROM kortix.studio_job_events
            WHERE job_id = '${ordinaryPollingJobId}'
              AND event_type = 'progress' AND payload ->> 'phase' = 'operator-review'
          )
        );
      `),
    ).toEqual({
      recoverable_jobs: 3,
      recoverable_attempts: 3,
      operator_review_events: 4,
      polling_unknown_review_events: 1,
      ordinary_polling_review_events: 0,
    });

    expect(
      await recovery.recover({
        accountId: successScope.accountId,
        projectId: successScope.projectId,
        jobId: successJobId,
        actorUserId: '60000000-0000-4000-a000-000000000001',
        actorType: 'user',
        actingTokenId: null,
        request: {
          decision: 'confirm_succeeded',
          idempotency_key: 'maintenance-success-recovery-24',
          reason: 'Operator verified the staged result after maintenance.',
          evidence: {
            staging_manifest_key: staged.manifestKey,
            staging_manifest_checksum: staged.manifestChecksum,
          },
        },
      }),
    ).toMatchObject({ decision: 'confirm_succeeded', job_status: 'succeeded' });
    expect(
      await recovery.recover({
        accountId: notCreatedScope.accountId,
        projectId: notCreatedScope.projectId,
        jobId: notCreatedJobId,
        actorUserId: '60000000-0000-4000-a000-000000000001',
        actorType: 'user',
        actingTokenId: null,
        request: {
          decision: 'confirm_not_created',
          idempotency_key: 'maintenance-not-created-recovery-25',
          reason: 'Operator verified that no provider result was created.',
          evidence: {},
        },
      }),
    ).toMatchObject({ decision: 'confirm_not_created', job_status: 'failed' });
    expect(
      await recovery.recover({
        accountId: keepUnknownScope.accountId,
        projectId: keepUnknownScope.projectId,
        jobId: keepUnknownJobId,
        actorUserId: '60000000-0000-4000-a000-000000000001',
        actorType: 'user',
        actingTokenId: null,
        request: {
          decision: 'keep_unknown',
          idempotency_key: 'maintenance-keep-unknown-recovery-26',
          reason: 'Operator needs additional time to verify the provider outcome.',
          evidence: {},
        },
      }),
    ).toMatchObject({ decision: 'keep_unknown', job_status: 'running' });

    const firstState = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'success', (
          SELECT jsonb_build_object('job', status, 'attempt', (
            SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${successAttemptId}'
          ), 'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${successJobId}'
          ), 'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${successJobId}'
          )) FROM kortix.studio_jobs WHERE job_id = '${successJobId}'
        ),
        'not_created', (
          SELECT jsonb_build_object('job', status, 'attempt', (
            SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${notCreatedAttemptId}'
          ), 'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${notCreatedJobId}'
          ), 'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${notCreatedJobId}'
          )) FROM kortix.studio_jobs WHERE job_id = '${notCreatedJobId}'
        ),
        'keep_unknown', (
          SELECT jsonb_build_object('job', status, 'attempt', (
            SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${keepUnknownAttemptId}'
          ), 'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${keepUnknownJobId}'
          ), 'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${keepUnknownJobId}'
          )) FROM kortix.studio_jobs WHERE job_id = '${keepUnknownJobId}'
        ),
        'expiry', (
          SELECT jsonb_build_object('job', status, 'actual', actual_credits, 'code', error_code,
            'attempt', (SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${expiryAttemptId}'),
            'reservation', (SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${expiryJobId}'),
            'incidents', (SELECT count(*) FROM kortix.studio_billing_incidents WHERE job_id = '${expiryJobId}'),
            'final_usage', (SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${expiryJobId}' AND attempt_id IS NULL)
          ) FROM kortix.studio_jobs WHERE job_id = '${expiryJobId}'
        ),
        'ordinary_polling', (
          SELECT jsonb_build_object(
            'job', status,
            'attempt', (
              SELECT status FROM kortix.studio_job_attempts
              WHERE attempt_id = '${ordinaryPollingAttemptId}'
            ),
            'retry', (
              SELECT retry_classification FROM kortix.studio_job_attempts
              WHERE attempt_id = '${ordinaryPollingAttemptId}'
            ),
            'reservation', (
              SELECT status FROM kortix.studio_credit_reservations
              WHERE job_id = '${ordinaryPollingJobId}'
            ),
            'incidents', (
              SELECT count(*) FROM kortix.studio_billing_incidents
              WHERE job_id = '${ordinaryPollingJobId}'
            ),
            'operator_review_events', (
              SELECT count(*) FROM kortix.studio_job_events
              WHERE job_id = '${ordinaryPollingJobId}'
                AND event_type = 'progress'
                AND payload ->> 'phase' = 'operator-review'
            )
          ) FROM kortix.studio_jobs WHERE job_id = '${ordinaryPollingJobId}'
        )
      );
    `);
    expect(firstState).toEqual({
      success: { job: 'succeeded', attempt: 'succeeded', reservation: 'settled', recoveries: 1 },
      not_created: { job: 'failed', attempt: 'failed', reservation: 'released', recoveries: 1 },
      keep_unknown: { job: 'running', attempt: 'reconciling', reservation: 'active', recoveries: 1 },
      expiry: {
        job: 'failed',
        actual: 2,
        code: 'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED',
        attempt: 'failed',
        reservation: 'settled',
        incidents: 1,
        final_usage: 1,
      },
      ordinary_polling: {
        job: 'running',
        attempt: 'polling',
        retry: null,
        reservation: 'active',
        incidents: 0,
        operator_review_events: 0,
      },
    });

    expect(await maintenance.runOnce()).toEqual({ acquired: true, tasksRun: 5 });
    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'incident_count', (SELECT count(*) FROM kortix.studio_billing_incidents WHERE job_id = '${expiryJobId}'),
          'final_usage_count', (SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${expiryJobId}' AND attempt_id IS NULL),
          'operator_review_count', (SELECT count(*) FROM kortix.studio_job_events WHERE job_id = '${keepUnknownJobId}' AND event_type = 'progress' AND payload ->> 'phase' = 'operator-review' AND NOT (payload ? 'recovery_id'))
        );
      `),
    ).toEqual({ incident_count: 1, final_usage_count: 1, operator_review_count: 1 });

    } finally {
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  test('rolls back recovery cost, billing, assets, events, and audit on finalizer event failure', () => {
    const scope = seedProductionScope({ suffix: '15' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000015';
    const manifestKey = `staging/${jobId}/manifest.json`;
    const manifestChecksum = '3'.repeat(64);
    prepareRecoveryAttempt({
      jobId,
      attemptId,
      leaseOwner: 'studio-worker:recovery-rollback',
      manifestKey,
      manifestChecksum,
    });
    clearStudioLease(jobId);
    dockerPsql(`
      CREATE OR REPLACE FUNCTION kortix.test_fail_recovery_event()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path TO ''
      AS $function$
      BEGIN
        RAISE EXCEPTION 'injected recovery event failure';
      END;
      $function$;
      CREATE TRIGGER trg_test_fail_recovery_event
      BEFORE INSERT ON kortix.studio_job_events
      FOR EACH ROW
      WHEN (NEW.job_id = '${jobId}'::uuid)
      EXECUTE FUNCTION kortix.test_fail_recovery_event();
    `);
    try {
      const failed = dockerPsql(
        recoveryCallSql({
          projectId: scope.projectId,
          jobId,
          attemptId,
          decision: 'confirm_succeeded',
          idempotencyKey: 'recovery-rollback-key-15',
          requestHash: 'recovery-rollback-hash-15',
          evidence: {
            staging_manifest_key: manifestKey,
            staging_manifest_checksum: manifestChecksum,
            upstream_usage: { output_count: 1 },
            upstream_cost_credits: 2,
          },
          resultAssets: recoveryAssets(`studio/recovery/${jobId}/must-rollback.png`),
          actualCredits: 3,
        }),
        true,
      );
      expect(failed.exitCode).not.toBe(0);
      expect(failed.output).toContain('injected recovery event failure');
    } finally {
      dockerPsql(`
        DROP TRIGGER IF EXISTS trg_test_fail_recovery_event ON kortix.studio_job_events;
        DROP FUNCTION IF EXISTS kortix.test_fail_recovery_event();
      `);
    }

    expect(
      dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object('status', status, 'lease_owner', lease_owner)
            FROM kortix.studio_jobs WHERE job_id = '${jobId}'
          ),
          'attempt', (
            SELECT jsonb_build_object('status', status, 'recorded_at', cost_recorded_at)
            FROM kortix.studio_job_attempts WHERE attempt_id = '${attemptId}'
          ),
          'reservation', (
            SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${jobId}'
          ),
          'recoveries', (
            SELECT count(*) FROM kortix.studio_job_recoveries WHERE job_id = '${jobId}'
          ),
          'usage_events', (
            SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${jobId}'
          ),
          'assets', (
            SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${jobId}'
          ),
          'events', (
            SELECT count(*) FROM kortix.studio_job_events WHERE job_id = '${jobId}'
          ),
          'ledger', (
            SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${scope.accountId}'
          )
        );
      `),
    ).toEqual({
      job: { status: 'running', lease_owner: null },
      attempt: { status: 'reconciling', recorded_at: null },
      reservation: 'active',
      recoveries: 0,
      usage_events: 0,
      assets: 0,
      events: 1,
      ledger: 0,
    });
  }, 30_000);

  test('atomically creates the queued job, reservation, and first durable event', () => {
    const created = dockerPsqlJson(`
      SET ROLE service_role;
      SELECT public.atomic_create_studio_job(
        '${SUCCESS_ACCOUNT_ID}'::uuid,
        '${SUCCESS_PROJECT_ID}'::uuid,
        '60000000-0000-4000-a000-000000000001'::uuid,
        'user',
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::uuid,
        'image.generate',
        '${SUCCESS_PROVIDER_ID}'::uuid,
        'fake',
        'fake-image-v1',
        '{"capability":"image.generate","image":{"prompt":"atomic create"}}'::jsonb,
        'integration-atomic-create',
        'integration-atomic-create-hash',
        2,
        '2026-07-16T00:00:00Z'::timestamptz
      );
    `);
    expect(created).toMatchObject({ success: true, idempotent: false, reserved: 2 });
    const createdJobId = String(created.job_id);

    const state = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${createdJobId}'),
        'reservation_status', (
          SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${createdJobId}'
        ),
        'event_types', (
          SELECT jsonb_agg(event_type ORDER BY cursor)
          FROM kortix.studio_job_events WHERE job_id = '${createdJobId}'
        )
      );
    `);
    expect(state).toEqual({
      job_status: 'queued',
      reservation_status: 'active',
      event_types: ['queued'],
    });

    dockerPsql(`
      SET ROLE service_role;
      SELECT public.atomic_release_studio_job(
        '${createdJobId}'::uuid,
        'studio:release:${createdJobId}:integration_cleanup',
        'integration_cleanup'
      );
    `);
  }, 30_000);

  test('finalizes success atomically across reservation, ledger, usage, assets, events, and job', () => {
    const leaseOwner = 'studio-worker:success-claim';
    seedRunningJob({
      accountId: SUCCESS_ACCOUNT_ID,
      projectId: SUCCESS_PROJECT_ID,
      providerId: SUCCESS_PROVIDER_ID,
      jobId: SUCCESS_JOB_ID,
      attemptId: SUCCESS_ATTEMPT_ID,
      leaseOwner,
      cancellationRequested: false,
    });

    const result = finalizeJob({
      jobId: SUCCESS_JOB_ID,
      attemptId: SUCCESS_ATTEMPT_ID,
      leaseOwner,
      objectKey: 'studio/success/result.png',
      completedAt: '2026-07-15T12:00:00Z',
    });
    expect(result).toMatchObject({ success: true, outcome: 'succeeded', idempotent: false });

    const state = dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object(
              'status', status,
              'actual_credits', actual_credits,
              'lease_owner', lease_owner,
              'lease_expires_at', lease_expires_at,
              'completed_at', completed_at
            ) FROM kortix.studio_jobs WHERE job_id = '${SUCCESS_JOB_ID}'
          ),
          'attempt_status', (
            SELECT status FROM kortix.studio_job_attempts
            WHERE attempt_id = '${SUCCESS_ATTEMPT_ID}'
          ),
          'reservation', (
            SELECT jsonb_build_object('status', status, 'settlement_key', settlement_key)
            FROM kortix.studio_credit_reservations WHERE job_id = '${SUCCESS_JOB_ID}'
          ),
          'balance', (
            SELECT balance FROM kortix.credit_accounts WHERE account_id = '${SUCCESS_ACCOUNT_ID}'
          ),
          'ledger_count', (
            SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${SUCCESS_ACCOUNT_ID}'
          ),
          'ledger_amount', (
            SELECT amount FROM kortix.credit_ledger WHERE account_id = '${SUCCESS_ACCOUNT_ID}'
          ),
          'usage_count', (
            SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${SUCCESS_JOB_ID}'
          ),
          'usage_ledger_matches', (
            SELECT usage.ledger_id = ledger.id
            FROM kortix.studio_usage_events usage
            JOIN kortix.credit_ledger ledger ON ledger.account_id = usage.account_id
            WHERE usage.job_id = '${SUCCESS_JOB_ID}'
          ),
          'asset_count', (
            SELECT count(*) FROM kortix.studio_assets WHERE source_job_id = '${SUCCESS_JOB_ID}'
          ),
          'asset_object_key', (
            SELECT object_key FROM kortix.studio_assets WHERE source_job_id = '${SUCCESS_JOB_ID}'
          ),
          'asset_link_count', (
            SELECT count(*) FROM kortix.studio_job_assets WHERE job_id = '${SUCCESS_JOB_ID}'
          ),
          'event_types', (
            SELECT jsonb_agg(event_type ORDER BY cursor)
            FROM kortix.studio_job_events WHERE job_id = '${SUCCESS_JOB_ID}'
          ),
          'distinct_cursor_count', (
            SELECT count(DISTINCT cursor)
            FROM kortix.studio_job_events WHERE job_id = '${SUCCESS_JOB_ID}'
          )
        );
      `);

    expect(state).toMatchObject({
      job: {
        status: 'succeeded',
        actual_credits: 1.25,
        lease_owner: null,
        lease_expires_at: null,
        completed_at: '2026-07-15T12:00:00+00:00',
      },
      attempt_status: 'succeeded',
      reservation: {
        status: 'settled',
        settlement_key: `studio:settle:${SUCCESS_JOB_ID}`,
      },
      balance: 18.75,
      ledger_count: 1,
      ledger_amount: -1.25,
      usage_count: 1,
      usage_ledger_matches: true,
      asset_count: 1,
      asset_object_key: 'studio/success/result.png',
      asset_link_count: 1,
      event_types: ['queued', 'asset-created', 'billing-settled', 'succeeded'],
      distinct_cursor_count: 4,
    });

    const repeated = finalizeJob({
      jobId: SUCCESS_JOB_ID,
      attemptId: SUCCESS_ATTEMPT_ID,
      leaseOwner,
      objectKey: 'studio/success/result.png',
      completedAt: '2026-07-15T12:00:00Z',
    });
    expect(repeated).toMatchObject({ success: true, outcome: 'succeeded', idempotent: true });
  }, 30_000);

  test('caps success settlement at the active reservation amount', () => {
    const leaseOwner = 'studio-worker:cap-claim';
    seedRunningJob({
      accountId: CAP_ACCOUNT_ID,
      projectId: CAP_PROJECT_ID,
      providerId: CAP_PROVIDER_ID,
      jobId: CAP_JOB_ID,
      attemptId: CAP_ATTEMPT_ID,
      leaseOwner,
      cancellationRequested: false,
      reservedCredits: 1,
    });

    const result = finalizeJob({
      jobId: CAP_JOB_ID,
      attemptId: CAP_ATTEMPT_ID,
      leaseOwner,
      objectKey: 'studio/capped/result.png',
      completedAt: '2026-07-15T12:02:00Z',
      actualCredits: 3,
    });
    expect(result).toMatchObject({ success: true, outcome: 'succeeded' });

    const state = dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job_actual_credits', (
            SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = '${CAP_JOB_ID}'
          ),
          'usage_final_cost', (
            SELECT final_cost_credits FROM kortix.studio_usage_events WHERE job_id = '${CAP_JOB_ID}'
          ),
          'ledger_amount', (
            SELECT amount FROM kortix.credit_ledger WHERE account_id = '${CAP_ACCOUNT_ID}'
          ),
          'balance', (
            SELECT balance FROM kortix.credit_accounts WHERE account_id = '${CAP_ACCOUNT_ID}'
          ),
          'billing_payload', (
            SELECT payload FROM kortix.studio_job_events
            WHERE job_id = '${CAP_JOB_ID}' AND event_type = 'billing-settled'
          )
        );
      `);

    expect(state).toMatchObject({
      job_actual_credits: 1,
      usage_final_cost: 1,
      ledger_amount: -1,
      balance: 19,
      billing_payload: { actual_credits: 1, requested_actual_credits: 3, capped: true },
    });
  }, 30_000);

  test('cancellation already requested wins finalization without charging or exposing assets', () => {
    const leaseOwner = 'studio-worker:cancel-claim';
    seedRunningJob({
      accountId: CANCEL_ACCOUNT_ID,
      projectId: CANCEL_PROJECT_ID,
      providerId: CANCEL_PROVIDER_ID,
      jobId: CANCEL_JOB_ID,
      attemptId: CANCEL_ATTEMPT_ID,
      leaseOwner,
      cancellationRequested: true,
    });

    const result = finalizeJob({
      jobId: CANCEL_JOB_ID,
      attemptId: CANCEL_ATTEMPT_ID,
      leaseOwner,
      objectKey: 'studio/cancelled/must-not-exist.png',
      completedAt: '2026-07-15T12:05:00Z',
    });
    expect(result).toMatchObject({ success: true, outcome: 'cancelled', idempotent: false });

    const state = dockerPsqlJson(`
        SELECT jsonb_build_object(
          'job', (
            SELECT jsonb_build_object(
              'status', status,
              'actual_credits', actual_credits,
              'lease_owner', lease_owner,
              'lease_expires_at', lease_expires_at,
              'completed_at', completed_at
            ) FROM kortix.studio_jobs WHERE job_id = '${CANCEL_JOB_ID}'
          ),
          'attempt_status', (
            SELECT status FROM kortix.studio_job_attempts
            WHERE attempt_id = '${CANCEL_ATTEMPT_ID}'
          ),
          'reservation', (
            SELECT jsonb_build_object('status', status, 'release_key', release_key)
            FROM kortix.studio_credit_reservations WHERE job_id = '${CANCEL_JOB_ID}'
          ),
          'balance', (
            SELECT balance FROM kortix.credit_accounts WHERE account_id = '${CANCEL_ACCOUNT_ID}'
          ),
          'ledger_count', (
            SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${CANCEL_ACCOUNT_ID}'
          ),
          'usage_count', (
            SELECT count(*) FROM kortix.studio_usage_events WHERE job_id = '${CANCEL_JOB_ID}'
          ),
          'asset_count', (
            SELECT count(*) FROM kortix.studio_assets
            WHERE source_job_id = '${CANCEL_JOB_ID}'
               OR object_key = 'studio/cancelled/must-not-exist.png'
          ),
          'asset_link_count', (
            SELECT count(*) FROM kortix.studio_job_assets WHERE job_id = '${CANCEL_JOB_ID}'
          ),
          'event_types', (
            SELECT jsonb_agg(event_type ORDER BY cursor)
            FROM kortix.studio_job_events WHERE job_id = '${CANCEL_JOB_ID}'
          )
        );
      `);

    expect(state).toMatchObject({
      job: {
        status: 'cancelled',
        actual_credits: null,
        lease_owner: null,
        lease_expires_at: null,
        completed_at: '2026-07-15T12:05:00+00:00',
      },
      attempt_status: 'cancelled',
      reservation: {
        status: 'released',
        release_key: `studio:release:${CANCEL_JOB_ID}:user_cancelled`,
      },
      balance: 20,
      ledger_count: 0,
      usage_count: 0,
      asset_count: 0,
      asset_link_count: 0,
      event_types: ['queued', 'cancelled'],
    });

    const repeated = finalizeJob({
      jobId: CANCEL_JOB_ID,
      attemptId: CANCEL_ATTEMPT_ID,
      leaseOwner,
      objectKey: 'studio/cancelled/must-not-exist.png',
      completedAt: '2026-07-15T12:05:00Z',
    });
    expect(repeated).toMatchObject({ success: true, outcome: 'cancelled', idempotent: true });
  }, 30_000);

  test('atomically fails a job and releases its reservation with the terminal event', () => {
    const leaseOwner = 'studio-worker:failed-claim';
    seedRunningJob({
      accountId: SUCCESS_ACCOUNT_ID,
      projectId: SUCCESS_PROJECT_ID,
      providerId: SUCCESS_PROVIDER_ID,
      jobId: FAILED_JOB_ID,
      attemptId: FAILED_ATTEMPT_ID,
      leaseOwner,
      cancellationRequested: false,
    });

    const result = dockerPsqlJson(`
      SET ROLE service_role;
      SELECT public.atomic_finalize_studio_job_terminal(
        '${FAILED_JOB_ID}'::uuid,
        '${FAILED_ATTEMPT_ID}'::uuid,
        '${leaseOwner}',
        'failed',
        'STUDIO_PROVIDER_REJECTED',
        'provider rejected the request',
        'terminal',
        'terminal_failure',
        '2026-07-15T12:10:00Z'::timestamptz
      );
    `);
    expect(result).toMatchObject({ success: true, outcome: 'failed', idempotent: false });

    const state = dockerPsqlJson(`
      SELECT jsonb_build_object(
        'job_status', (SELECT status FROM kortix.studio_jobs WHERE job_id = '${FAILED_JOB_ID}'),
        'attempt_status', (
          SELECT status FROM kortix.studio_job_attempts WHERE attempt_id = '${FAILED_ATTEMPT_ID}'
        ),
        'reservation_status', (
          SELECT status FROM kortix.studio_credit_reservations WHERE job_id = '${FAILED_JOB_ID}'
        ),
        'event_types', (
          SELECT jsonb_agg(event_type ORDER BY cursor)
          FROM kortix.studio_job_events WHERE job_id = '${FAILED_JOB_ID}'
        )
      );
    `);
    expect(state).toEqual({
      job_status: 'failed',
      attempt_status: 'failed',
      reservation_status: 'released',
      event_types: ['queued', 'failed'],
    });
  }, 30_000);
});
