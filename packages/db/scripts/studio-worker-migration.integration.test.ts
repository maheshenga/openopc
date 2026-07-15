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
    dockerPsql(CORE_FIXTURES);
  }, 150_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('applies the 1600 -> 1700 -> 1800 chain and installs the hardened finalizer', () => {
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
      studio_tables: 9,
      daily_precision: 12,
      daily_scale: 4,
      finalizer_exists: true,
      service_role_can_finalize: true,
      authenticated_can_finalize: false,
      terminal_finalizer_exists: true,
      service_role_can_finalize_terminal: true,
      authenticated_can_finalize_terminal: false,
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
