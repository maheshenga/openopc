import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import postgres from 'postgres';
import {
  PostgresStudioMaintenanceRepository,
  PostgresStudioWorkerRepository,
  type StudioSqlClient,
  createPostgresStudioCredentialValidator,
  createPostgresStudioServiceAccountLoader,
  createPostgresStudioTokenLoader,
} from './postgres';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-studio-worker-repository-${crypto.randomUUID().slice(0, 8)}`;
const image = 'postgres:16-alpine';

const accountId = '10000000-0000-4000-a000-000000000011';
const projectId = '20000000-0000-4000-a000-000000000011';
const providerConfigId = '30000000-0000-4000-a000-000000000011';
const jobId = '40000000-0000-4000-a000-000000000011';
const tokenId = '70000000-0000-4000-a000-000000000011';
const serviceAccountId = '80000000-0000-4000-a000-000000000011';

const preStudioSchema = `
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
    session_id text,
    service_account_id uuid,
    agent_grant jsonb
  );

  CREATE TABLE kortix.service_accounts (
    service_account_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid,
    agent_name text,
    status text NOT NULL,
    expires_at timestamptz
  );

  CREATE TABLE kortix.project_secrets (
    secret_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    identifier text NOT NULL,
    value_enc text NOT NULL,
    owner_user_id uuid,
    active boolean NOT NULL DEFAULT true
  );

  CREATE TABLE kortix.executor_connectors (
    connector_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    slug text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'active'
  );

  CREATE TABLE kortix.executor_connection_profiles (
    profile_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    connector_id uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id),
    status text NOT NULL DEFAULT 'active',
    is_default boolean NOT NULL DEFAULT false
  );

  CREATE TABLE kortix.executor_credentials (
    credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id),
    profile_id uuid REFERENCES kortix.executor_connection_profiles(profile_id),
    value_enc text NOT NULL
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

type PostgresClient = ReturnType<typeof postgres>;

let firstConnection: PostgresClient | null = null;
let secondConnection: PostgresClient | null = null;

function spawnDocker(args: string[]) {
  return Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
}

function asStudioClient(raw: Pick<postgres.TransactionSql, 'unsafe'>): StudioSqlClient {
  return {
    async unsafe(text, values = []) {
      const rows = await raw.unsafe(text, values as never[]);
      return Array.from(rows) as Record<string, unknown>[];
    },
  };
}

function getConnections(): [PostgresClient, PostgresClient] {
  if (!firstConnection || !secondConnection) {
    throw new Error('PostgreSQL integration connections are not initialized');
  }
  return [firstConnection, secondConnection];
}

async function applyMigration(sql: PostgresClient, migrationName: string): Promise<void> {
  const migration = await Bun.file(
    resolve(import.meta.dir, '..', '..', '..', 'packages', 'db', 'migrations', migrationName),
  ).text();
  await sql.begin(async (transaction) => {
    await transaction.unsafe(migration);
  });
}

async function waitForPostgres(sql: PostgresClient): Promise<void> {
  const deadline = Date.now() + 120_000;
  let diagnostics = 'No readiness probe completed';

  while (Date.now() < deadline) {
    const logs = spawnDocker(['logs', container]);
    const combinedLogs = `${logs.stdout.toString()}${logs.stderr.toString()}`;
    const initialized = combinedLogs.includes(
      'PostgreSQL init process complete; ready for start up.',
    );
    const inContainerProbe = spawnDocker([
      'exec',
      container,
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'testdb',
    ]);

    if (initialized && inContainerProbe.exitCode === 0) {
      try {
        await sql.unsafe('SELECT 1');
        return;
      } catch (error) {
        diagnostics = String(error);
      }
    } else {
      diagnostics = [
        `initialized=${initialized}`,
        `pg_isready_exit=${inContainerProbe.exitCode}`,
        inContainerProbe.stderr.toString().trim(),
      ]
        .filter(Boolean)
        .join(', ');
    }

    await Bun.sleep(250);
  }

  throw new Error(`Disposable PostgreSQL did not become ready: ${diagnostics}`);
}

async function resetClaimFixture(sql: PostgresClient): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`
      DELETE FROM kortix.studio_jobs;
      DELETE FROM kortix.studio_provider_configs;

      INSERT INTO kortix.studio_provider_configs(
        provider_config_id, account_id, project_id, provider, display_name,
        credential_binding, capability_map, enabled
      ) VALUES (
        '${providerConfigId}', '${accountId}', '${projectId}', 'fake',
        'Claim integration provider', '{"kind":"none"}'::jsonb,
        '{"image.generate":true}'::jsonb, true
      );

      INSERT INTO kortix.studio_jobs(
        job_id, account_id, project_id, actor_user_id, actor_type, capability,
        provider_config_id, provider, model, input, status, idempotency_key,
        request_hash, reserved_credits, available_at, created_at, updated_at
      ) VALUES (
        '${jobId}', '${accountId}', '${projectId}',
        '60000000-0000-4000-a000-000000000011', 'user', 'image.generate',
        '${providerConfigId}', 'fake', 'fake-image-v1',
        '{"capability":"image.generate","image":{"prompt":"claim integration"}}'::jsonb,
        'queued', 'claim-integration-key', 'claim-integration-hash', 1,
        '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z'
      );
    `);
  });
}

describe.skipIf(!dockerAvailable)('PostgresStudioWorkerRepository - real PostgreSQL', () => {
  beforeAll(async () => {
    const started = spawnDocker([
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
      image,
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    try {
      const publishedPort = spawnDocker(['port', container, '5432/tcp']);
      if (publishedPort.exitCode !== 0) throw new Error(publishedPort.stderr.toString());
      const port = publishedPort.stdout.toString().match(/:(\d+)\s*$/m)?.[1];
      if (!port) {
        throw new Error(`Could not parse PostgreSQL port: ${publishedPort.stdout.toString()}`);
      }

      const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/testdb`;
      const options = {
        prepare: false,
        max: 1,
        connect_timeout: 2,
        idle_timeout: 5,
        onnotice: () => {},
      } as const;
      firstConnection = postgres(databaseUrl, options);
      secondConnection = postgres(databaseUrl, options);

      await waitForPostgres(firstConnection);
      await firstConnection.unsafe(preStudioSchema);
      await applyMigration(firstConnection, '20260715160000000_studio_phase1.sql');
      await applyMigration(firstConnection, '20260715170000000_studio_credit_reservations.sql');
      await applyMigration(firstConnection, '20260715180000000_studio_worker_hardening.sql');
      await firstConnection.unsafe(`
        ALTER TABLE kortix.studio_job_attempts
          ADD COLUMN IF NOT EXISTS provider_config_version text,
          ADD COLUMN IF NOT EXISTS staging_manifest_key text,
          ADD COLUMN IF NOT EXISTS staging_manifest_checksum text;
      `);
      await firstConnection.unsafe(`
        INSERT INTO kortix.accounts(account_id) VALUES ('${accountId}');
        INSERT INTO kortix.projects(project_id, account_id)
        VALUES ('${projectId}', '${accountId}');
        INSERT INTO kortix.service_accounts(
          service_account_id, account_id, project_id, agent_name, status
        ) VALUES (
          '${serviceAccountId}', '${accountId}', '${projectId}', 'image-agent', 'active'
        );
        INSERT INTO kortix.account_tokens(
          token_id, account_id, user_id, status, project_id, session_id,
          service_account_id, agent_grant
        ) VALUES (
          '${tokenId}', '${accountId}', '60000000-0000-4000-a000-000000000011',
          'active', '${projectId}', 'session-image', '${serviceAccountId}',
          '{"agent":"image-agent","kortixCli":"all","connectors":"all","env":"all"}'::jsonb
        );
        INSERT INTO kortix.project_secrets(project_id, identifier, value_enc, active)
        VALUES
          ('${projectId}', 'IMAGE_PROVIDER', 'encrypted-provider-key', true),
          ('${projectId}', 'EMPTY_PROVIDER', '', true);
        INSERT INTO kortix.executor_connectors(
          connector_id, account_id, project_id, slug, enabled, status
        ) VALUES
          ('90000000-0000-4000-a000-000000000011', '${accountId}', '${projectId}', 'aliyun-media', true, 'active'),
          ('90000000-0000-4000-a000-000000000012', '${accountId}', '${projectId}', 'unconfigured-media', true, 'active');
        INSERT INTO kortix.executor_connection_profiles(
          profile_id, account_id, project_id, connector_id, status, is_default
        ) VALUES (
          '91000000-0000-4000-a000-000000000011', '${accountId}', '${projectId}',
          '90000000-0000-4000-a000-000000000011', 'active', true
        );
        INSERT INTO kortix.executor_credentials(connector_id, profile_id, value_enc)
        VALUES (
          '90000000-0000-4000-a000-000000000011',
          '91000000-0000-4000-a000-000000000011',
          'encrypted-connector-credential'
        );
        INSERT INTO kortix.credit_accounts(
          account_id, balance, daily_credits_balance, expiring_credits, non_expiring_credits
        ) VALUES ('${accountId}', 10, 10, 0, 0);
      `);
    } catch (error) {
      spawnDocker(['rm', '-f', container]);
      throw error;
    }
  }, 180_000);

  beforeEach(async () => {
    const [sql] = getConnections();
    await resetClaimFixture(sql);
  });

  afterAll(async () => {
    const connections = [firstConnection, secondConnection].filter(
      (connection): connection is PostgresClient => connection !== null,
    );
    await Promise.allSettled(connections.map((connection) => connection.end({ timeout: 5 })));
    spawnDocker(['rm', '-f', container]);
  }, 30_000);

  test('two concurrent connections claim a given job at most once', async () => {
    const [sqlA, sqlB] = getConnections();
    const repositoryA = new PostgresStudioWorkerRepository(asStudioClient(sqlA));
    const repositoryB = new PostgresStudioWorkerRepository(asStudioClient(sqlB));
    const now = new Date('2026-07-15T12:00:00Z');

    const claims = await Promise.all([
      repositoryA.claimNextJob({
        processRole: 'studio-worker',
        workerId: 'worker-a:claim-1',
        now,
        leaseMs: 60_000,
      }),
      repositoryB.claimNextJob({
        processRole: 'studio-worker',
        workerId: 'worker-b:claim-1',
        now,
        leaseMs: 60_000,
      }),
    ]);

    const claimed = claims.filter((claim) => claim !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.jobId).toBe(jobId);

    const state = await sqlA.unsafe(`
      SELECT
        job.lease_owner,
        (SELECT count(*)::integer FROM kortix.studio_job_events event
          WHERE event.job_id = job.job_id AND event.event_type = 'claimed') AS claimed_events
      FROM kortix.studio_jobs job
      WHERE job.job_id = '${jobId}'
    `);
    expect(state[0]?.lease_owner).toBe(claimed[0]?.leaseOwner);
    expect(state[0]?.claimed_events).toBe(1);
  });

  test('an expired lease makes the job claimable by a new owner', async () => {
    const [sqlA, sqlB] = getConnections();
    const repositoryA = new PostgresStudioWorkerRepository(asStudioClient(sqlA));
    const repositoryB = new PostgresStudioWorkerRepository(asStudioClient(sqlB));
    const initialTime = new Date('2026-07-15T12:00:00Z');

    const initialClaim = await repositoryA.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-a:expiring-claim',
      now: initialTime,
      leaseMs: 30_000,
    });
    expect(initialClaim?.jobId).toBe(jobId);

    const beforeExpiry = await repositoryB.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-b:too-early',
      now: new Date(initialTime.getTime() + 29_999),
      leaseMs: 30_000,
    });
    expect(beforeExpiry).toBeNull();

    const recovered = await repositoryB.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-b:recovered-claim',
      now: new Date(initialTime.getTime() + 30_000),
      leaseMs: 30_000,
    });
    expect(recovered?.jobId).toBe(jobId);
    expect(recovered?.leaseOwner).toBe('worker-b:recovered-claim');
  });

  test('FOR UPDATE OF j leaves the joined provider row unlocked', async () => {
    const [sqlA, sqlB] = getConnections();

    await sqlA.begin(async (jobTransaction) => {
      const repository = new PostgresStudioWorkerRepository(asStudioClient(jobTransaction));
      const claimed = await repository.claimNextJob({
        processRole: 'studio-worker',
        workerId: 'worker-a:held-job-lock',
        now: new Date('2026-07-15T12:00:00Z'),
        leaseMs: 60_000,
      });
      expect(claimed?.jobId).toBe(jobId);

      const updatedRows = await sqlB.begin(async (providerTransaction) => {
        await providerTransaction.unsafe("SET LOCAL lock_timeout = '750ms'");
        return providerTransaction.unsafe(`
          UPDATE kortix.studio_provider_configs
          SET display_name = 'Updated while job row is locked'
          WHERE provider_config_id = '${providerConfigId}'
          RETURNING display_name
        `);
      });

      expect(updatedRows[0]?.display_name).toBe('Updated while job row is locked');
    });
  });

  test('prepares against the fresh config fence and replays handle persistence idempotently', async () => {
    const [sql] = getConnections();
    const repository = new PostgresStudioWorkerRepository(asStudioClient(sql));
    const now = new Date('2026-07-15T12:00:00Z');
    const claimed = await repository.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-a:submission-claim',
      now,
      leaseMs: 60_000,
    });
    expect(claimed?.jobId).toBe(jobId);
    const config = await repository.loadProviderConfigForSubmission({
      jobId,
      workerId: 'worker-a:submission-claim',
    });
    if (!config) throw new Error('Expected a fresh provider configuration');
    const attempt = await repository.prepareAttempt({
      jobId,
      workerId: 'worker-a:submission-claim',
      submissionKey: 'submission:integration-replay',
      adapterVersion: 'integration-v1',
      providerConfigVersion: config.versionToken,
      now,
    });
    if (!attempt) throw new Error('Expected the submission attempt to be prepared');
    const handle = {
      provider: 'fake',
      id: 'provider:integration-replay',
      submission_key: attempt.submissionKey,
    };

    await repository.markSubmitted({
      jobId,
      attemptId: attempt.attemptId,
      workerId: 'worker-a:submission-claim',
      handle,
      now,
    });
    await repository.markSubmitted({
      jobId,
      attemptId: attempt.attemptId,
      workerId: 'worker-a:submission-claim',
      handle,
      now,
    });

    const rows = await sql.unsafe(`
      SELECT
        attempt.status AS attempt_status,
        job.provider_handle,
        (SELECT count(*)::integer
         FROM kortix.studio_job_events event
         WHERE event.job_id = job.job_id
           AND event.event_type = 'provider-submitted'
           AND event.payload ->> 'submission_key' = 'submission:integration-replay') AS submitted_events
      FROM kortix.studio_jobs job
      JOIN kortix.studio_job_attempts attempt ON attempt.job_id = job.job_id
      WHERE job.job_id = '${jobId}'
    `);
    expect(rows[0]).toMatchObject({
      attempt_status: 'submitted',
      submitted_events: 1,
    });
    expect(String(rows[0]?.provider_handle)).toContain('provider:integration-replay');
  });

  test('rejects attempt preparation when any provider configuration field changes', async () => {
    const [sql] = getConnections();
    const repository = new PostgresStudioWorkerRepository(asStudioClient(sql));
    const now = new Date('2026-07-15T12:00:00Z');
    const claimed = await repository.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-a:stale-config-claim',
      now,
      leaseMs: 60_000,
    });
    expect(claimed?.jobId).toBe(jobId);
    const config = await repository.loadProviderConfigForSubmission({
      jobId,
      workerId: 'worker-a:stale-config-claim',
    });
    if (!config) throw new Error('Expected a fresh provider configuration');

    await sql.unsafe(`
      UPDATE kortix.studio_provider_configs
      SET credential_binding = '{"kind":"secret","identifier":"rotated"}'::jsonb
      WHERE provider_config_id = '${providerConfigId}'
    `);
    const attempt = await repository.prepareAttempt({
      jobId,
      workerId: 'worker-a:stale-config-claim',
      submissionKey: 'submission:must-not-start',
      adapterVersion: 'integration-v1',
      providerConfigVersion: config.versionToken,
      now,
    });

    expect(attempt).toBeNull();
    const count = await sql.unsafe(`
      SELECT count(*)::integer AS attempts
      FROM kortix.studio_job_attempts
      WHERE job_id = '${jobId}'
    `);
    expect(count[0]?.attempts).toBe(0);
  });

  test('loads live token and Service Account scope and validates tenant credentials', async () => {
    const [sql] = getConnections();
    const client = asStudioClient(sql);
    const token = await createPostgresStudioTokenLoader(client)(tokenId);
    const serviceAccount = await createPostgresStudioServiceAccountLoader(client)(serviceAccountId);
    const validateCredential = createPostgresStudioCredentialValidator(client);

    expect(token).toMatchObject({
      status: 'active',
      projectId,
      sessionId: 'session-image',
      serviceAccountId,
    });
    expect(serviceAccount).toMatchObject({
      status: 'active',
      accountId,
      projectId,
      agentName: 'image-agent',
    });
    expect(
      await validateCredential({
        accountId,
        projectId,
        binding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
      }),
    ).toBe(true);
    expect(
      await validateCredential({
        accountId,
        projectId,
        binding: { kind: 'connector', slug: 'aliyun-media' },
      }),
    ).toBe(true);
    expect(
      await validateCredential({
        accountId,
        projectId,
        binding: { kind: 'secret', identifier: 'EMPTY_PROVIDER' },
      }),
    ).toBe(false);
    expect(
      await validateCredential({
        accountId,
        projectId,
        binding: { kind: 'connector', slug: 'unconfigured-media' },
      }),
    ).toBe(false);
    await sql.unsafe(`
      UPDATE kortix.executor_connection_profiles
      SET status = 'revoked'
      WHERE profile_id = '91000000-0000-4000-a000-000000000011'
    `);
    expect(
      await validateCredential({
        accountId,
        projectId,
        binding: { kind: 'connector', slug: 'aliyun-media' },
      }),
    ).toBe(false);
    expect(
      await validateCredential({
        accountId: '10000000-0000-4000-a000-000000000099',
        projectId,
        binding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
      }),
    ).toBe(false);
  });

  test('a committed cancellation wins while success finalization waits on the job lock', async () => {
    const [sqlA, sqlB] = getConnections();
    const attemptId = '50000000-0000-4000-a000-000000000011';
    const leaseOwner = 'worker-a:cancellation-race';
    await sqlA.unsafe(`
      UPDATE kortix.studio_jobs
      SET status = 'running', attempt_count = 1, lease_owner = '${leaseOwner}',
          lease_expires_at = '2026-07-15T12:05:00Z'
      WHERE job_id = '${jobId}';
      INSERT INTO kortix.studio_job_attempts(
        attempt_id, job_id, submission_key, provider_request_id,
        adapter_version, status, started_at
      ) VALUES (
        '${attemptId}', '${jobId}', 'submission:cancellation-race',
        'provider:cancellation-race', 'integration-v1', 'polling',
        '2026-07-15T12:00:00Z'
      );
      INSERT INTO kortix.studio_credit_reservations(
        account_id, job_id, amount_credits, status, expires_at
      ) VALUES ('${accountId}', '${jobId}', 1, 'active', '2026-07-16T00:00:00Z');
    `);

    let cancellationLocked!: () => void;
    const cancellationHasLock = new Promise<void>((resolveLock) => {
      cancellationLocked = resolveLock;
    });
    let commitCancellation!: () => void;
    const mayCommitCancellation = new Promise<void>((resolveCommit) => {
      commitCancellation = resolveCommit;
    });
    const cancellationTransaction = sqlA.begin(async (transaction) => {
      await transaction.unsafe(`
        UPDATE kortix.studio_jobs
        SET cancellation_requested_at = '2026-07-15T12:00:01Z'
        WHERE job_id = '${jobId}'
      `);
      cancellationLocked();
      await mayCommitCancellation;
    });
    await cancellationHasLock;

    const finalization = sqlB.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe(`
        SELECT public.atomic_finalize_studio_job_success(
          '${jobId}'::uuid,
          '${attemptId}'::uuid,
          '${leaseOwner}',
          1,
          '[{"kind":"image","mimeType":"image/png","bucket":"studio-integration","objectKey":"race/must-not-publish.png","checksumSha256":"race-checksum","sizeBytes":4,"filename":"race.png"}]'::jsonb,
          '2026-07-15T12:00:02Z'::timestamptz
        ) AS result
      `);
    });
    let finalizationFinished = false;
    void finalization.then(
      () => {
        finalizationFinished = true;
      },
      () => {
        finalizationFinished = true;
      },
    );
    await Bun.sleep(50);
    expect(finalizationFinished).toBe(false);
    commitCancellation();
    await cancellationTransaction;
    const finalized = await finalization;

    expect(finalized[0]?.result).toMatchObject({ success: true, outcome: 'cancelled' });
    const state = await sqlA.unsafe(`
      SELECT
        job.status,
        reservation.status AS reservation_status,
        (SELECT count(*)::integer FROM kortix.credit_ledger ledger
         WHERE ledger.account_id = job.account_id) AS ledger_count,
        (SELECT count(*)::integer FROM kortix.studio_usage_events usage
         WHERE usage.job_id = job.job_id) AS usage_count,
        (SELECT count(*)::integer FROM kortix.studio_assets asset
         WHERE asset.source_job_id = job.job_id) AS asset_count
      FROM kortix.studio_jobs job
      JOIN kortix.studio_credit_reservations reservation ON reservation.job_id = job.job_id
      WHERE job.job_id = '${jobId}'
    `);
    expect(state[0]).toMatchObject({
      status: 'cancelled',
      reservation_status: 'released',
      ledger_count: 0,
      usage_count: 0,
      asset_count: 0,
    });
  });

  test('orphan candidates exclude active, reconciling, and manifest-attached attempts and re-fence terminal rows', async () => {
    const [sql] = getConnections();
    const worker = new PostgresStudioWorkerRepository(asStudioClient(sql));
    const maintenance = new PostgresStudioMaintenanceRepository(asStudioClient(sql));
    const claimed = await worker.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-a:orphan-candidate',
      now: new Date('2026-07-15T10:00:00.000Z'),
      leaseMs: 60_000,
    });
    if (!claimed) throw new Error('expected orphan fixture job to be claimed');
    const config = await worker.loadProviderConfigForSubmission({
      jobId: claimed.jobId,
      workerId: claimed.leaseOwner!,
    });
    if (!config) throw new Error('expected orphan fixture provider config');
    const attempt = await worker.prepareAttempt({
      jobId: claimed.jobId,
      workerId: claimed.leaseOwner!,
      submissionKey: 'submission:orphan-candidate',
      adapterVersion: 'integration-v1',
      providerConfigVersion: config.versionToken,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    if (!attempt) throw new Error('expected orphan fixture attempt');
    await sql.unsafe(`
      UPDATE kortix.studio_job_attempts
      SET status = 'failed', ended_at = '2026-06-02T00:00:00Z'
      WHERE attempt_id = '${attempt.attemptId}';
      UPDATE kortix.studio_jobs
      SET status = 'failed', completed_at = '2026-06-02T00:00:00Z',
          lease_owner = NULL, lease_expires_at = NULL
      WHERE job_id = '${claimed.jobId}';
    `);
    const retentionBefore = new Date('2026-07-01T00:00:00.000Z');

    const terminal = await maintenance.listOrphanStagingCandidates({
      retentionBefore,
      limit: 10,
    });
    expect(terminal).toHaveLength(1);
    expect(
      await maintenance.isOrphanStagingCandidate({
        candidate: terminal[0]!,
        retentionBefore,
      }),
    ).toBe(true);

    await sql.unsafe(`
      UPDATE kortix.studio_job_attempts
      SET staging_manifest_key = 'accounts/a/manifest.json',
          staging_manifest_checksum = '${'a'.repeat(64)}'
      WHERE attempt_id = '${attempt.attemptId}';
    `);
    expect(
      await maintenance.listOrphanStagingCandidates({ retentionBefore, limit: 10 }),
    ).toEqual([]);
    expect(
      await maintenance.isOrphanStagingCandidate({
        candidate: terminal[0]!,
        retentionBefore,
      }),
    ).toBe(false);

    await sql.unsafe(`
      UPDATE kortix.studio_job_attempts
      SET status = 'reconciling', ended_at = NULL,
          staging_manifest_key = NULL, staging_manifest_checksum = NULL
      WHERE attempt_id = '${attempt.attemptId}';
      UPDATE kortix.studio_jobs
      SET status = 'running', completed_at = NULL
      WHERE job_id = '${claimed.jobId}';
    `);
    expect(
      await maintenance.listOrphanStagingCandidates({ retentionBefore, limit: 10 }),
    ).toEqual([]);
  });
});
