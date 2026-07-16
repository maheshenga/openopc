import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-studio-worker-migration-${crypto.randomUUID().slice(0, 8)}`;

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

function dockerPsql(sql: string, allowFailure = false) {
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
      'testdb',
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

function dockerPsqlJson(sql: string): Record<string, unknown> {
  const output = dockerPsql(sql).output;
  const jsonLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith('{') && line.endsWith('}'));
  if (!jsonLine) throw new Error(`PostgreSQL did not return a JSON object:\n${output}`);
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

async function applyMigration(name: string): Promise<void> {
  const migration = await Bun.file(resolve(import.meta.dir, '..', 'migrations', name)).text();
  dockerPsql(`BEGIN;\n${migration}\nCOMMIT;`);
}

const PRE_STUDIO_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;

  CREATE SCHEMA kortix;

  CREATE TABLE kortix.accounts (
    account_id uuid PRIMARY KEY
  );

  CREATE TABLE kortix.projects (
    project_id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id)
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
}): ProductionScope {
  const accountId = `70000000-0000-4000-a000-0000000000${input.suffix}`;
  const projectId = `71000000-0000-4000-a000-0000000000${input.suffix}`;
  const providerId = `72000000-0000-4000-a000-0000000000${input.suffix}`;
  const pricingId = `73000000-0000-4000-a000-0000000000${input.suffix}`;
  const maxProviderCredits = input.maxProviderCredits ?? 8;
  const markupCredits = input.markupCredits ?? 1;
  const balance = input.balance ?? 100;

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
      'image', jsonb_build_object('rate_credits', 2),
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
      ${input.cost},
      '${input.outcome}',
      ${input.recordedAtSql ?? 'clock_timestamp()'}
    );
  `);
}

function finalizeProductionSuccess(input: {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  actualCredits: number;
  assetCount: number;
  objectPrefix: string;
}): Record<string, unknown> {
  const assets = Array.from({ length: input.assetCount }, (_, index) => ({
    kind: 'image',
    mimeType: 'image/png',
    bucket: 'studio-integration',
    objectKey: `${input.objectPrefix}/${index + 1}.png`,
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

    dockerPsql(PRE_STUDIO_SCHEMA);
    await applyMigration('20260715160000000_studio_phase1.sql');
    await applyMigration('20260715170000000_studio_credit_reservations.sql');
    await applyMigration('20260715180000000_studio_worker_hardening.sql');
    await applyMigration('20260716120000000_studio_production_provider_storage.sql');
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
      finalizer_exists: true,
      service_role_can_finalize: true,
      authenticated_can_finalize: false,
      terminal_finalizer_exists: true,
      legacy_create_exists: true,
      production_create_exists: true,
      record_cost_exists: true,
      service_role_can_record_cost: true,
      authenticated_can_record_cost: false,
      service_role_can_finalize_terminal: true,
      authenticated_can_finalize_terminal: false,
    });
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
  }, 30_000);

  test('records one canonical attempt cost and rejects conflict, forged lease, and terminal jobs', () => {
    const scope = seedProductionScope({ suffix: '02' });
    const created = createProductionJob(scope);
    const jobId = String(created.job_id);
    const attemptId = '74000000-0000-4000-a000-000000000002';
    const secondAttemptId = '74000000-0000-4000-a000-000000000102';
    const futureAttemptId = '74000000-0000-4000-a000-000000000202';
    const leaseOwner = 'studio-worker:production-cost';
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
              'verified', metadata -> 'verified_upstream_cost_credits'
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
      final: { cost: 9, loss: 1, verified: 10 },
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
              'verified', metadata -> 'verified_upstream_cost_credits'
            ) FROM kortix.studio_usage_events
            WHERE job_id = '${jobId}' AND attempt_id IS NULL
          )
        );
      `),
    ).toEqual({
      job_actual: 0,
      reservation: { status: 'settled', settlement_key: `studio:settle:${jobId}` },
      ledger_count: 0,
      final: { cost: 0, loss: 1.25, verified: 1.25 },
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
